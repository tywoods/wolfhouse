'use strict';

/**
 * Stage 28i/28j — Luna conversation brain (smart LLM understanding + deterministic fallback).
 *
 * Stage 28j puts the LLM understanding layer in the live staging hot path:
 *   - When LUNA_CONVERSATION_BRAIN_ENABLED=true + LUNA_CONVERSATION_BRAIN_LLM_ENABLED=true
 *     and NODE_ENV is not production, every guest message is classified by the configured
 *     OpenAI model (LUNA_CONVERSATION_BRAIN_MODEL, graceful fallback to the repo's
 *     configured provider default model on model errors).
 *   - The deterministic first-slice rules remain the fallback when the LLM fails, times
 *     out (LUNA_CONVERSATION_BRAIN_TIMEOUT_MS, default 4000ms), or is disabled.
 *
 * The brain decides "what the guest means" ONLY. It never performs DB actions,
 * availability, pricing, payment, Stripe, or confirmation — deterministic Staff API
 * rules own all actions. LLM output is strictly sanitized; price/availability/payment
 * "truth" from the LLM is ignored.
 *
 * Priority model (high → low):
 *   1. urgent/safety/human-needed              (allowed handoff categories only)
 *   2. paid booking cancel/refund/date-change  (deferred to existing router/handoff logic)
 *   3. reset / start over / new booking
 *   4. guest correction
 *   5. modify current quote/details (via sanitized patch)
 *   6. side question while preserving active flow
 *   7. answer last missing-field question
 *   8. payment choice                          (deferred to payment-choice module)
 *   9. booking intake                          (deferred to router)
 *  10. general/package/service/transfer question
 *  11. greeting
 *  12. clarify unknown
 *
 * @module luna-conversation-brain
 */

const { detectPackageExplainerIntent } = require('./luna-guest-package-explainer');
const { KNOWN_ADDON_TYPES } = require('./luna-guest-message-intake');
const { callLunaAiJsonChat, resolveLunaAiModel } = require('./luna-ai-provider');

const PACKAGE_NAMES_RE = /\b(?:malibu|uluwatu|waimea)\b/i;

const WORD_COUNTS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** Hard safety boundary — the brain may never authorize these. */
const BRAIN_SAFETY_FLAGS = Object.freeze({
  confirms_availability: false,
  invents_pricing: false,
  creates_booking: false,
  creates_payment_draft: false,
  creates_stripe_link: false,
  marks_payment: false,
  sends_confirmation: false,
  overrides_paid_booking_safety: false,
});

const ALLOWED_INTENTS = new Set([
  'urgent_handoff', 'paid_booking_change', 'reset_new_booking', 'guest_correction',
  'modify_details', 'side_question', 'package_choice', 'package_undecided',
  'accommodation_only_choice', 'add_service_request', 'answer_missing_field',
  'payment_choice', 'booking_intake', 'general_question', 'greeting', 'clarify',
  'passthrough',
]);

const ALLOWED_REPLY_TYPES = new Set([
  'greeting_menu', 'ask_dates', 'ask_guests', 'ask_package', 'ask_stay_type',
  'package_explainer', 'package_recommendation', 'short_stay_guidance',
  'continue_booking', 'correction_ack', 'accommodation_only_ack',
  'reset_prompt', 'clarify', 'handoff', 'passthrough',
]);

const ALLOWED_ACTIVE_FLOWS = new Set([
  'new_booking', 'short_stay_accommodation', 'weekly_package', 'payment_choice',
  'general_question', 'unknown',
]);

const ALLOWED_NEXT_BEST_ACTIONS = new Set([
  'ask_dates', 'ask_guests', 'ask_package', 'ask_stay_type', 'answer_side_question',
  'explain_packages', 'continue_intake', 'collect_payment_choice', 'check_availability',
  'clarify', 'reset', 'handoff', 'none',
]);

/** should_handoff=true is only honored for these categories. */
const ALLOWED_HANDOFF_REASONS = new Set([
  'urgent_safety', 'human_requested', 'paid_booking_change', 'cancel_refund', 'complaint',
]);

const ALLOWED_SIDE_QUESTION_TYPES = new Set([
  'overview', 'malibu', 'uluwatu', 'waimea', 'compare', 'recommend',
  'what_to_bring', 'choice_beginner', 'choice_experienced',
  'services', 'transfer', 'general',
]);

/** Extracted fields the brain (and LLM) are allowed to patch. */
const ALLOWED_PATCH_FIELDS = new Set([
  'check_in', 'check_out', 'guest_count', 'package_interest', 'room_preference',
  'payment_choice', 'add_ons', 'accommodation_only',
]);

const DEFAULT_LLM_TIMEOUT_MS = 4000;

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function isProductionEnv(env) {
  return String((env || {}).NODE_ENV || '').trim().toLowerCase() === 'production';
}

/** Brain enabled in staging/local by default flag; disabled in production unless opted in. */
function isConversationBrainEnabled(env) {
  const e = env || process.env;
  if (isProductionEnv(e)) {
    return String(e.LUNA_CONVERSATION_BRAIN_ENABLED_PROD || '').trim().toLowerCase() === 'true';
  }
  const flag = String(e.LUNA_CONVERSATION_BRAIN_ENABLED || '').trim().toLowerCase();
  // Deterministic brain is safe; default ON outside production unless explicitly disabled.
  return flag !== 'false';
}

/** Smart LLM gate — requires explicit enable, never in production. */
function isConversationBrainLlmEnabled(env) {
  const e = env || process.env;
  if (!isConversationBrainEnabled(e)) return false;
  if (isProductionEnv(e)) return false;
  return String(e.LUNA_CONVERSATION_BRAIN_LLM_ENABLED || '').trim().toLowerCase() === 'true';
}

function conversationBrainModel(env) {
  const e = env || process.env;
  return trimStr(e.LUNA_CONVERSATION_BRAIN_MODEL) || 'gpt-5.5';
}

function conversationBrainReasoningEffort(env) {
  const e = env || process.env;
  const v = trimStr(e.LUNA_CONVERSATION_BRAIN_REASONING_EFFORT).toLowerCase();
  return ['low', 'medium', 'high'].includes(v) ? v : 'low';
}

function conversationBrainTimeoutMs(env) {
  const e = env || process.env;
  const v = Number(e.LUNA_CONVERSATION_BRAIN_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 30000) : DEFAULT_LLM_TIMEOUT_MS;
}

function baseDecision(activeMissingField) {
  return {
    intent: 'passthrough',
    reply_type: 'passthrough',
    preserve_context: false,
    reset_context: false,
    guest_is_correcting_luna: false,
    extracted_fields_patch: {},
    side_question_answer_needed: false,
    side_question_type: null,
    side_question_topic: null,
    active_flow: 'unknown',
    next_best_action: 'none',
    next_missing_field: activeMissingField || null,
    should_handoff: null, // null = defer to existing router/handoff logic
    handoff_reason: null,
    confidence: 0,
    reply_guidance: null,
    clarification_question: null,
    safety_flags: { ...BRAIN_SAFETY_FLAGS },
    source: 'deterministic',
  };
}

function detectResetSignal(text) {
  const t = trimStr(text).toLowerCase();
  if (!t) return false;
  if (/\b(?:start\s+over|start\s+again|let'?s\s+start\s+again|forget\s+(?:that|the)\s+booking|new\s+booking|another\s+booking|different\s+booking|create\s+another\s+booking|want\s+(?:to\s+)?(?:create|make)\s+another|not\s+that\s+one)\b/i.test(t)) {
    return true;
  }
  if (/\bno\b[\s,!.?-]*(?:no\b[\s,!.?-]*)?(?:i\s+)?(?:want|wanna)\s+(?:to\s+)?(?:create|make)\s+(?:another|a\s+new|a\s+different)\s+booking\b/i.test(t)) {
    return true;
  }
  return false;
}

/** Greeting-only (bare). */
function detectGreetingOnly(text) {
  const t = trimStr(text);
  if (!t) return false;
  return /^(?:hi|hey|hello|hiya|howdy|yo|good\s+(?:morning|afternoon|evening)|ciao|hola|bonjour|hallo|salut|servus)(?:\s*[!?.…]*)?$/i.test(t);
}

/** Guest is correcting something Luna said (priority 4 — never handoff for this alone). */
function detectGuestCorrection(text) {
  const t = trimStr(text).toLowerCase();
  if (!t) return false;
  return /\b(?:you (?:told|said)|you'?re wrong|you got (?:it|that) wrong|that'?s (?:wrong|not right|not what i)|no,?\s*i (?:said|told you|meant)|i already (?:told|said)|that is not what i)\b/i.test(t);
}

/**
 * Accommodation-only / no-add-ons answer (e.g. "no add nothing", "just accommodation").
 * Only meaningful inside an active booking when stay type / package / add-ons are in play.
 */
function detectAccommodationOnlyAnswer(text) {
  const t = trimStr(text).toLowerCase();
  if (!t) return false;
  if (/\b(?:accommodation|room|bed|stay)\s+only\b/i.test(t)) return true;
  if (/\bjust\s+(?:the\s+)?(?:accommodation|room|bed|stay)\b/i.test(t)) return true;
  if (/^no,?\s*(?:add\s*)?(?:nothing|extras?|add[\s-]?ons?)\b/i.test(t)) return true;
  if (/\bno\s+(?:add[\s-]?ons?|extras?|lessons?|gear)\b/i.test(t) && !/\byes\b/i.test(t)) return true;
  if (/^(?:nothing|nothing else|no nothing|nope nothing)[\s.!]*$/i.test(t)) return true;
  if (/\bdon'?t\s+(?:want|need)\s+(?:any\s+)?(?:add[\s-]?ons?|extras?|lessons?|gear|a\s+package)\b/i.test(t)) return true;
  return false;
}

/** Guest can't decide on a package — explain + recommend instead of stalling. */
function detectPackageUndecided(text) {
  const t = trimStr(text).toLowerCase();
  if (!t) return false;
  const undecided = /\b(?:don'?t know|not sure|no idea|can'?t decide|unsure|undecided|help me (?:choose|decide|pick)|what (?:do you|would you) (?:recommend|suggest)|which (?:one|package)? ?(?:do you )?(?:recommend|suggest)|hard to (?:choose|decide))\b/i.test(t);
  if (!undecided) return false;
  return /\b(?:package|packages|which|one|malibu|uluwatu|waimea|choose|decide|pick|recommend|suggest)\b/i.test(t);
}

/**
 * Detect a package side-question (overview or specific). Reuses the proven explainer
 * detector and adds compact "explain the packages" / "tell me about the packages" phrasings.
 *
 * @returns {string|null} 'overview' | 'malibu' | 'uluwatu' | 'waimea' | 'compare' | 'recommend' | ...
 */
function detectPackageSideQuestion(text) {
  const explicit = detectPackageExplainerIntent(text);
  if (explicit) return explicit;
  const t = trimStr(text);
  if (!t) return null;
  if (/\b(?:explain|tell me about|describe|more about|info on|information about|what about|talk me through|walk me through|run me through)\b[^.?!]*\bpackages?\b/i.test(t)) {
    return 'overview';
  }
  if (/\bpackages?\b[^.?!]*\b(?:explain|options|guide|overview|details)\b/i.test(t)) {
    return 'overview';
  }
  // Specific package name with a bare question ("uluwatu?", "what about waimea")
  const nameMatch = t.match(/\b(malibu|uluwatu|waimea)\b/i);
  if (nameMatch && /\?\s*$/.test(t) && t.split(/\s+/).length <= 4) {
    return nameMatch[1].toLowerCase();
  }
  return null;
}

/** Short package-choice answer (e.g. "Malibu", "I'll take Uluwatu"). */
function detectPackageChoice(text) {
  const t = trimStr(text).toLowerCase();
  if (!t) return null;
  if (detectPackageSideQuestion(text)) return null; // a question, not a choice
  const m = t.match(PACKAGE_NAMES_RE);
  if (!m) return null;
  // Treat as a choice when it's a short answer or an explicit pick.
  if (t.split(/\s+/).length <= 5
    || /\b(?:i'?ll take|we'?ll take|let'?s do|go with|i want|we want|i choose|pick|the)\b/i.test(t)) {
    return m[0].toLowerCase();
  }
  return null;
}

/** Parse a short numeric/word guest-count answer to an active "how many guests" question. */
function parseGuestCountAnswer(text) {
  const t = trimStr(text).toLowerCase();
  if (!t) return null;
  const bare = t.match(/^(\d{1,2})$/);
  if (bare) {
    const n = Number(bare[1]);
    if (n >= 1 && n <= 24) return n;
  }
  const word = t.match(/^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/i);
  if (word) return WORD_COUNTS[word[1].toLowerCase()] || null;
  if (/^(?:just me|only me|solo)$/i.test(t)) return 1;
  const we = t.match(/^(?:we are|we're)\s+(\d{1,2})$/i);
  if (we) return Number(we[1]);
  return null;
}

/** Low-signal unknown — short, no booking keywords, not a recognized answer. */
function looksLikeLowSignalUnknown(text) {
  const t = trimStr(text);
  if (!t) return true;
  if (PACKAGE_NAMES_RE.test(t)) return false;
  if (/\d/.test(t)) return false;
  if (/\b(?:book|stay|date|guest|package|deposit|pay|cancel|refund|transfer|wetsuit|surf|yoga|lesson)\b/i.test(t)) {
    return false;
  }
  return t.split(/\s+/).length <= 5;
}

/**
 * Deterministic conversation decision (synchronous; safe for the hot path).
 *
 * @param {object} input
 * @param {string} input.message_text
 * @param {object} [input.guest_context]
 * @param {object} [input.prior_extracted_fields]
 * @param {string|null} [input.active_missing_field]  'dates'|'guest_count'|'package_interest'|'stay_type'
 * @param {boolean} [input.in_active_booking]
 * @param {boolean} [input.in_short_stay_flow]
 * @param {string} [input.last_luna_reply]
 * @param {string} [input.message_lane]
 * @param {object} [input.env]
 * @returns {object} decision
 */
function decideConversationAction(input) {
  const inp = input || {};
  const message = trimStr(inp.message_text);
  const prior = inp.prior_extracted_fields || {};
  const activeMissing = inp.active_missing_field || null;
  const inActiveBooking = !!inp.in_active_booking;
  const inShortStayFlow = !!inp.in_short_stay_flow;
  const decision = baseDecision(activeMissing);

  if (!message) return decision;

  // ── P3 reset / new booking ────────────────────────────────────────────────
  if (detectResetSignal(message)) {
    return {
      ...decision,
      intent: 'reset_new_booking',
      reply_type: 'reset_prompt',
      reset_context: true,
      preserve_context: false,
      next_best_action: 'reset',
      should_handoff: false,
      confidence: 0.9,
    };
  }

  // ── P4 guest correction — acknowledge + continue, never handoff for this ───
  if (inActiveBooking && detectGuestCorrection(message)) {
    return {
      ...decision,
      intent: 'guest_correction',
      reply_type: 'correction_ack',
      guest_is_correcting_luna: true,
      preserve_context: true,
      active_flow: inShortStayFlow ? 'short_stay_accommodation' : 'new_booking',
      next_best_action: 'continue_intake',
      next_missing_field: activeMissing,
      should_handoff: false,
      confidence: 0.8,
    };
  }

  // ── P5/P6 accommodation-only answer in short-stay / stay-type context ──────
  if (inActiveBooking
    && (inShortStayFlow || activeMissing === 'stay_type' || activeMissing === 'package_interest')
    && detectAccommodationOnlyAnswer(message)) {
    return {
      ...decision,
      intent: 'accommodation_only_choice',
      reply_type: 'accommodation_only_ack',
      extracted_fields_patch: { accommodation_only: true, package_interest: 'accommodation_only' },
      preserve_context: true,
      active_flow: 'short_stay_accommodation',
      next_best_action: 'continue_intake',
      should_handoff: false,
      confidence: 0.9,
    };
  }

  // ── P6 side question (package explainer), preserve active flow ─────────────
  const sideType = detectPackageSideQuestion(message);
  if (sideType) {
    return {
      ...decision,
      intent: 'side_question',
      reply_type: 'package_explainer',
      side_question_answer_needed: true,
      side_question_type: sideType,
      preserve_context: inActiveBooking,
      active_flow: inActiveBooking ? 'new_booking' : 'general_question',
      next_best_action: 'answer_side_question',
      next_missing_field: inActiveBooking ? activeMissing : null,
      should_handoff: false,
      confidence: 0.85,
    };
  }

  // ── Package undecided → explain + recommend (reuses explainer preserve path)
  if (detectPackageUndecided(message)
    && (activeMissing === 'package_interest' || /\bpackage/i.test(message))) {
    return {
      ...decision,
      intent: 'package_undecided',
      reply_type: 'package_recommendation',
      side_question_answer_needed: true,
      side_question_type: 'recommend',
      preserve_context: inActiveBooking,
      next_best_action: 'explain_packages',
      next_missing_field: inActiveBooking ? activeMissing : null,
      should_handoff: false,
      confidence: 0.85,
    };
  }

  // ── P4 package choice while package is the active/missing field ────────────
  const pkgChoice = detectPackageChoice(message);
  if (pkgChoice && (activeMissing === 'package_interest' || (inActiveBooking && !prior.package_interest))) {
    return {
      ...decision,
      intent: 'package_choice',
      reply_type: 'continue_booking',
      extracted_fields_patch: { package_interest: pkgChoice },
      preserve_context: true,
      next_best_action: 'continue_intake',
      next_missing_field: 'package_interest',
      should_handoff: false,
      confidence: 0.85,
    };
  }

  // ── P7 answer the last missing-field question ──────────────────────────────
  if (activeMissing === 'guest_count') {
    const n = parseGuestCountAnswer(message);
    if (n != null) {
      return {
        ...decision,
        intent: 'answer_missing_field',
        reply_type: 'continue_booking',
        extracted_fields_patch: { guest_count: n },
        preserve_context: true,
        next_best_action: 'continue_intake',
        next_missing_field: 'package_interest',
        should_handoff: false,
        confidence: 0.9,
      };
    }
  }

  // ── P11 greeting ───────────────────────────────────────────────────────────
  if (detectGreetingOnly(message)) {
    return {
      ...decision,
      intent: 'greeting',
      reply_type: 'greeting_menu',
      next_best_action: 'none',
      should_handoff: false,
      confidence: 0.95,
    };
  }

  // ── P12 clarify unknown inside an active booking (don't handoff) ───────────
  if (inActiveBooking && looksLikeLowSignalUnknown(message)) {
    return {
      ...decision,
      intent: 'clarify',
      reply_type: 'clarify',
      preserve_context: true,
      next_best_action: 'clarify',
      next_missing_field: activeMissing,
      should_handoff: false,
      confidence: 0.5,
      clarification_question: activeMissing,
    };
  }

  // Defer everything else to the existing router/handoff logic.
  return decision;
}

function isValidIsoDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime());
}

function normalizeConfidence(raw) {
  if (typeof raw === 'number') return Math.max(0, Math.min(1, raw));
  const s = trimStr(raw).toLowerCase();
  if (s === 'high') return 0.9;
  if (s === 'medium') return 0.6;
  if (s === 'low') return 0.3;
  return 0;
}

function normalizePackagePatch(v) {
  const p = trimStr(v).toLowerCase();
  if (['malibu', 'uluwatu', 'waimea'].includes(p)) return p;
  if (p === 'package_none' || p === 'no_package') return 'no_package';
  if (p === 'accommodation_only') return 'accommodation_only';
  return null;
}

/**
 * Strict sanitization of LLM output per the Stage 28j contract.
 * Whitelist-only: any attempt to create bookings/payments/Stripe/confirmations or to
 * assert price/availability/payment truth is dropped. Safety flags are never trusted.
 */
function sanitizeLlmDecision(raw, activeMissingField) {
  if (!raw || typeof raw !== 'object') return null;
  const safe = baseDecision(activeMissingField);

  if (ALLOWED_INTENTS.has(raw.intent)) safe.intent = raw.intent;
  if (ALLOWED_REPLY_TYPES.has(raw.reply_type)) safe.reply_type = raw.reply_type;
  safe.preserve_context = raw.preserve_context === true;
  safe.reset_context = raw.reset_context === true;
  safe.guest_is_correcting_luna = raw.guest_is_correcting_luna === true;
  if (safe.guest_is_correcting_luna && safe.intent === 'passthrough') safe.intent = 'guest_correction';

  if (ALLOWED_ACTIVE_FLOWS.has(raw.active_flow)) safe.active_flow = raw.active_flow;
  if (ALLOWED_NEXT_BEST_ACTIONS.has(raw.next_best_action)) safe.next_best_action = raw.next_best_action;

  // should_handoff=true only for allowed handoff categories.
  const reason = trimStr(raw.handoff_reason).toLowerCase() || null;
  if (raw.should_handoff === false) {
    safe.should_handoff = false;
  } else if (raw.should_handoff === true && reason && ALLOWED_HANDOFF_REASONS.has(reason)) {
    safe.should_handoff = true;
    safe.handoff_reason = reason;
  } else {
    safe.should_handoff = null; // defer to deterministic router rules
  }

  // side question
  const sq = raw.side_question;
  if (sq && typeof sq === 'object') {
    const t = trimStr(sq.type).toLowerCase();
    if (ALLOWED_SIDE_QUESTION_TYPES.has(t)) {
      safe.side_question_type = t;
      safe.side_question_topic = trimStr(sq.topic).slice(0, 120) || null;
      safe.side_question_answer_needed = true;
    }
  } else if (typeof raw.side_question_type === 'string'
    && ALLOWED_SIDE_QUESTION_TYPES.has(raw.side_question_type)) {
    safe.side_question_type = raw.side_question_type;
    safe.side_question_answer_needed = raw.side_question_answer_needed === true;
  }
  if (safe.intent === 'package_undecided' && !safe.side_question_type) {
    safe.side_question_type = 'recommend';
    safe.side_question_answer_needed = true;
  }

  if (typeof raw.next_missing_field === 'string') {
    const f = raw.next_missing_field;
    if (['dates', 'guest_count', 'package_interest', 'stay_type'].includes(f)) {
      safe.next_missing_field = f;
    }
  }

  safe.confidence = normalizeConfidence(raw.confidence);
  safe.reply_guidance = trimStr(raw.reply_guidance).slice(0, 400) || null;
  safe.clarification_question = trimStr(raw.clarifying_question || raw.clarification_question).slice(0, 300) || null;

  // ── extracted_fields_patch — strict field-level validation ─────────────────
  const patch = {};
  const rawPatch = (raw.extracted_fields_patch && typeof raw.extracted_fields_patch === 'object')
    ? raw.extracted_fields_patch
    : {};
  for (const [k, v] of Object.entries(rawPatch)) {
    if (!ALLOWED_PATCH_FIELDS.has(k) || v == null) continue;
    if (k === 'check_in' || k === 'check_out') {
      if (isValidIsoDate(v)) patch[k] = v;
    } else if (k === 'guest_count') {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 1 && n <= 24) patch.guest_count = n;
    } else if (k === 'package_interest') {
      const p = normalizePackagePatch(v);
      if (p) patch.package_interest = p;
    } else if (k === 'payment_choice') {
      const p = trimStr(v).toLowerCase();
      if (p === 'deposit' || p === 'full') patch.payment_choice = p;
    } else if (k === 'add_ons') {
      if (Array.isArray(v)) {
        const filtered = v.map((a) => trimStr(a).toLowerCase()).filter((a) => KNOWN_ADDON_TYPES.has(a));
        if (filtered.length) patch.add_ons = filtered;
      }
    } else if (k === 'accommodation_only') {
      if (v === true) {
        patch.accommodation_only = true;
        if (!patch.package_interest) patch.package_interest = 'accommodation_only';
      }
    } else if (k === 'room_preference') {
      const r = trimStr(v).slice(0, 100);
      if (r) patch.room_preference = r;
    }
  }
  // Both dates required to patch a range; never accept a reversed range.
  if (patch.check_in && patch.check_out && patch.check_out <= patch.check_in) {
    delete patch.check_in;
    delete patch.check_out;
  }
  safe.extracted_fields_patch = patch;

  safe.safety_flags = { ...BRAIN_SAFETY_FLAGS }; // never trust LLM safety flags
  safe.source = 'llm';
  return safe;
}

const BRAIN_SYSTEM_PROMPT = [
  "You are Luna's conversation manager for Wolfhouse, a surf house front desk in Somo, Spain.",
  'Classify the guest message and plan reply handling ONLY. Return STRICT JSON, no prose.',
  'You MUST NOT confirm availability, state prices as truth, create bookings/payments/Stripe links, mark payments, or send confirmations. Deterministic backend rules execute all actions.',
  '',
  'Business rules you must respect (backend enforces them):',
  '- Weekly surf packages Malibu (from EUR 249), Uluwatu (from EUR 349, +gear rental), Waimea (from EUR 499, +lessons+gear) require 7-night stays.',
  '- Under 7 nights: no weekly package; guide to accommodation-only plus add-ons (wetsuit, surfboard, surf_lesson, yoga, meal). "no add-ons"/"just accommodation"/"no add nothing" means accommodation_only=true.',
  '- 7+ nights without a chosen package: explain packages before asking choice.',
  '- Direct package choice on 7+ nights: proceed (no forced explanation).',
  '- Side questions: answer, preserve booking context, return to next missing field.',
  '- Guest corrections: acknowledge, update flow, never handoff for a correction alone.',
  '- Unknown messages: ask a clarifying question; handoff only for true risk.',
  '',
  'Output JSON schema (all keys required):',
  '{"intent":"urgent_handoff|paid_booking_change|reset_new_booking|guest_correction|modify_details|side_question|package_choice|package_undecided|accommodation_only_choice|add_service_request|answer_missing_field|payment_choice|booking_intake|general_question|greeting|clarify",',
  '"confidence":"high|medium|low",',
  '"should_handoff":false,',
  '"handoff_reason":null,',
  '"preserve_context":true,',
  '"reset_context":false,',
  '"guest_is_correcting_luna":false,',
  '"reply_type":"greeting_menu|ask_dates|ask_guests|ask_package|ask_stay_type|package_explainer|package_recommendation|short_stay_guidance|continue_booking|correction_ack|accommodation_only_ack|reset_prompt|clarify|handoff",',
  '"extracted_fields_patch":{"check_in":null,"check_out":null,"guest_count":null,"package_interest":null,"room_preference":null,"payment_choice":null,"add_ons":[],"accommodation_only":null},',
  '"active_flow":"new_booking|short_stay_accommodation|weekly_package|payment_choice|general_question|unknown",',
  '"side_question":{"type":null,"topic":null},',
  '"next_best_action":"ask_dates|ask_guests|ask_package|ask_stay_type|answer_side_question|explain_packages|continue_intake|collect_payment_choice|check_availability|clarify|reset|handoff|none",',
  '"reply_guidance":"short instruction for reply composition",',
  '"clarifying_question":null}',
  '',
  'Field rules: dates are YYYY-MM-DD; guest_count is a positive integer; package_interest is malibu|uluwatu|waimea|package_none; payment_choice deposit|full only when explicit; add_ons from [wetsuit,surfboard,surf_lesson,yoga,meal]; should_handoff true only for handoff_reason in [urgent_safety,human_requested,paid_booking_change,cancel_refund,complaint].',
].join('\n');

/**
 * Build the structured-understanding prompt payload (no network here).
 */
function buildConversationBrainPrompt(input) {
  const inp = input || {};
  return {
    model: conversationBrainModel(inp.env),
    reasoning_effort: conversationBrainReasoningEffort(inp.env),
    system: BRAIN_SYSTEM_PROMPT,
    user: JSON.stringify({
      guest_message: trimStr(inp.message_text),
      last_luna_reply: trimStr(inp.last_luna_reply).slice(0, 600) || null,
      active_missing_field: inp.active_missing_field || null,
      in_active_booking: !!inp.in_active_booking,
      in_short_stay_flow: !!inp.in_short_stay_flow,
      package_night_rule: inp.package_night_rule || null,
      message_lane: inp.message_lane || null,
      current_extracted_fields: inp.prior_extracted_fields || {},
      recent_history: Array.isArray(inp.recent_history) ? inp.recent_history.slice(-6) : [],
      known_packages: ['malibu', 'uluwatu', 'waimea'],
      known_add_ons: [...KNOWN_ADDON_TYPES],
    }),
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    // No unref: the timer must keep the event loop alive so the race always settles.
    timer = setTimeout(() => reject(new Error(`conversation brain LLM timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseLlmJson(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (_) {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (_) { return null; }
    }
    return null;
  }
}

/**
 * Default real LLM client. Uses the shared Luna AI provider (OpenAI preferred) with the
 * conversation-brain model override; on a model-level error it gracefully retries once
 * with the repo's configured default model.
 *
 * @param {object} prompt  output of buildConversationBrainPrompt
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<object|null>} parsed raw decision JSON
 */
async function defaultConversationBrainLlmClient(prompt, env) {
  const e = env || process.env;
  const callOpts = {
    system: prompt.system,
    user: prompt.user,
    maxTokens: 600,
    temperature: 0,
    jsonObject: true,
    call_label: 'luna_conversation_brain',
  };
  try {
    const text = await callLunaAiJsonChat({
      ...callOpts,
      env: { ...e, LUNA_AI_MODEL: prompt.model },
    });
    if (text == null) return null; // provider not configured
    const parsed = parseLlmJson(text);
    if (parsed && typeof parsed === 'object') parsed.__model_used = prompt.model;
    return parsed;
  } catch (err) {
    // Graceful model fallback: retry once with the repo-configured default model.
    const fallbackModel = resolveLunaAiModel(e, 'openai');
    const text = await callLunaAiJsonChat({ ...callOpts, env: e });
    if (text == null) return null;
    const parsed = parseLlmJson(text);
    if (parsed && typeof parsed === 'object') {
      parsed.__model_used = fallbackModel;
      parsed.__model_fallback_from = prompt.model;
      parsed.__llm_error = String((err && err.message) || err).slice(0, 200);
    }
    return parsed;
  }
}

/**
 * Stage 28j hot-path decision: smart LLM first (when enabled, never in production),
 * deterministic rules as fallback on disable/failure/timeout/low-signal output.
 *
 * @param {object} input  same shape as decideConversationAction input (+ recent_history, last_luna_reply, package_night_rule, in_short_stay_flow)
 * @param {object} [options]
 * @param {function} [options.llmClient]  async (promptPayload) => raw decision object (injectable for tests)
 * @returns {Promise<object>} decision
 */
async function decideConversationActionAsync(input, options = {}) {
  const inp = input || {};
  const env = inp.env || process.env;
  const modelRequested = conversationBrainModel(env);
  const deterministic = decideConversationAction(inp);
  deterministic.brain_enabled = isConversationBrainEnabled(env);
  deterministic.llm_enabled = isConversationBrainLlmEnabled(env);
  deterministic.model_requested = modelRequested;
  deterministic.model_used = null;
  deterministic.llm_error = null;

  if (!deterministic.llm_enabled) {
    deterministic.source = 'deterministic';
    return deterministic;
  }

  const client = typeof options.llmClient === 'function'
    ? options.llmClient
    : (prompt) => defaultConversationBrainLlmClient(prompt, env);

  try {
    const prompt = buildConversationBrainPrompt(inp);
    const raw = await withTimeout(
      Promise.resolve(client(prompt)),
      conversationBrainTimeoutMs(env),
    );
    if (raw == null) {
      // Provider not configured / returned nothing → safe deterministic fallback.
      deterministic.source = 'fallback';
      deterministic.llm_error = 'llm_returned_null';
      return deterministic;
    }
    const modelUsed = (raw && raw.__model_used) || modelRequested;
    const llmError = (raw && raw.__llm_error) || null;
    const sanitized = sanitizeLlmDecision(raw, inp.active_missing_field || null);
    if (!sanitized) {
      deterministic.source = 'fallback';
      deterministic.llm_error = 'llm_unparseable';
      return deterministic;
    }
    sanitized.brain_enabled = true;
    sanitized.llm_enabled = true;
    sanitized.model_requested = modelRequested;
    sanitized.model_used = modelUsed;
    sanitized.llm_error = llmError;
    // If the LLM punts (passthrough/no signal) but deterministic rules are confident,
    // prefer the deterministic decision (but keep LLM observability).
    if (sanitized.intent === 'passthrough' && deterministic.intent !== 'passthrough') {
      deterministic.source = 'deterministic';
      deterministic.deterministic_over_llm = 'passthrough';
      deterministic.model_used = modelUsed;
      deterministic.llm_error = llmError;
      return deterministic;
    }
    if (sanitized.intent === 'clarify' && deterministic.intent !== 'passthrough'
      && deterministic.intent !== 'clarify' && deterministic.confidence >= 0.8) {
      deterministic.source = 'deterministic';
      deterministic.deterministic_over_llm = 'clarify';
      deterministic.model_used = modelUsed;
      deterministic.llm_error = llmError;
      return deterministic;
    }
    return sanitized;
  } catch (err) {
    // Never fail the conversation on LLM error/timeout: fall back to deterministic,
    // and if that is unsure, prefer a clarify over a dumb handoff.
    const msg = String((err && err.message) || err);
    deterministic.source = /timeout/i.test(msg) ? 'timeout' : 'error';
    deterministic.llm_error = msg.slice(0, 200);
    if (deterministic.intent === 'passthrough') {
      deterministic.intent = inp.in_active_booking ? 'clarify' : 'passthrough';
      if (deterministic.intent === 'clarify') {
        deterministic.reply_type = 'clarify';
        deterministic.should_handoff = false;
        deterministic.preserve_context = true;
        deterministic.next_missing_field = inp.active_missing_field || null;
      }
    }
    return deterministic;
  }
}

module.exports = {
  decideConversationAction,
  decideConversationActionAsync,
  defaultConversationBrainLlmClient,
  buildConversationBrainPrompt,
  sanitizeLlmDecision,
  parseLlmJson,
  isConversationBrainEnabled,
  isConversationBrainLlmEnabled,
  conversationBrainModel,
  conversationBrainReasoningEffort,
  conversationBrainTimeoutMs,
  detectPackageSideQuestion,
  detectPackageChoice,
  detectGuestCorrection,
  detectAccommodationOnlyAnswer,
  detectPackageUndecided,
  parseGuestCountAnswer,
  detectResetSignal,
  BRAIN_SAFETY_FLAGS,
  BRAIN_SYSTEM_PROMPT,
  ALLOWED_PATCH_FIELDS,
  ALLOWED_HANDOFF_REASONS,
  ALLOWED_INTENTS,
  DEFAULT_LLM_TIMEOUT_MS,
};
