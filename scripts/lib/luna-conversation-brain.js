'use strict';

/**
 * Stage 28i — Luna conversation brain (deterministic-first conversation manager).
 *
 * Decides "what the guest means" before the router/booking chain finalizes a reply.
 * It does NOT perform DB actions, availability, pricing, payment, Stripe, or confirmation.
 * It only classifies intent, decides reply type, preserves/resets context, and proposes
 * a small extracted-field patch the downstream chain may apply.
 *
 * Priority model (high → low):
 *   1. urgent / safety / human-needed         (deferred to existing router/handoff logic)
 *   2. paid booking cancel/refund/date-change  (deferred to existing router/handoff logic)
 *   3. reset / start over / new booking
 *   4. modify current quote (dates/package/guests)   (partially via patch)
 *   5. answer a side question while preserving active flow
 *   6. answer the last missing-field question
 *   7. payment choice                          (deferred to payment-choice module)
 *   8. booking intake                          (deferred to router)
 *   9. general / package / service / transfer question
 *  10. greeting
 *  11. clarify unknown
 *
 * GPT-5.5 fallback is scaffolded + config-gated but OFF by default and never runs in
 * production. The live router consumes the synchronous deterministic decision; the async
 * LLM path is callable (with an injected client) for the next slice.
 *
 * @module luna-conversation-brain
 */

const { detectPackageExplainerIntent } = require('./luna-guest-package-explainer');

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

/** Extracted fields the brain (and LLM) are allowed to patch. */
const ALLOWED_PATCH_FIELDS = new Set([
  'check_in', 'check_out', 'guest_count', 'package_interest', 'payment_choice',
]);

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

/** GPT-5.5 fallback gate — requires explicit enable, never in production for first slice. */
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

function baseDecision(activeMissingField) {
  return {
    intent: 'passthrough',
    reply_type: 'passthrough',
    preserve_context: false,
    reset_context: false,
    extracted_fields_patch: {},
    side_question_answer_needed: false,
    side_question_type: null,
    next_missing_field: activeMissingField || null,
    should_handoff: null, // null = defer to existing router/handoff logic
    confidence: 0,
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
 * @param {string|null} [input.active_missing_field]   'dates' | 'guest_count' | 'package_interest'
 * @param {boolean} [input.in_active_booking]
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
      should_handoff: false,
      confidence: 0.9,
    };
  }

  // ── P5 side question (package explainer), preserve active flow ─────────────
  const sideType = detectPackageSideQuestion(message);
  if (sideType) {
    return {
      ...decision,
      intent: 'side_question',
      reply_type: 'package_explainer',
      side_question_answer_needed: true,
      side_question_type: sideType,
      preserve_context: inActiveBooking,
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
      next_missing_field: 'package_interest',
      should_handoff: false,
      confidence: 0.85,
    };
  }

  // ── P6 answer the last missing-field question ──────────────────────────────
  if (activeMissing === 'guest_count') {
    const n = parseGuestCountAnswer(message);
    if (n != null) {
      return {
        ...decision,
        intent: 'answer_missing_field',
        reply_type: 'continue_booking',
        extracted_fields_patch: { guest_count: n },
        preserve_context: true,
        next_missing_field: 'package_interest',
        should_handoff: false,
        confidence: 0.9,
      };
    }
  }

  // ── P10 greeting ───────────────────────────────────────────────────────────
  if (detectGreetingOnly(message)) {
    return {
      ...decision,
      intent: 'greeting',
      reply_type: 'greeting_menu',
      should_handoff: false,
      confidence: 0.95,
    };
  }

  // ── P11 clarify unknown inside an active booking (don't handoff) ───────────
  if (inActiveBooking && looksLikeLowSignalUnknown(message)) {
    return {
      ...decision,
      intent: 'clarify',
      reply_type: 'clarify',
      preserve_context: true,
      next_missing_field: activeMissing,
      should_handoff: false,
      confidence: 0.5,
      clarification_question: activeMissing,
    };
  }

  // Defer everything else to the existing router/handoff logic.
  return decision;
}

/** Strip any field the LLM is not allowed to set; force safety flags. */
function sanitizeLlmDecision(raw, activeMissingField) {
  const safe = baseDecision(activeMissingField);
  if (!raw || typeof raw !== 'object') return null;

  const allowedIntents = new Set([
    'reset_new_booking', 'side_question', 'package_choice', 'answer_missing_field',
    'modify_quote', 'payment_choice', 'booking_intake', 'general_question',
    'greeting', 'clarify', 'passthrough',
  ]);
  const allowedReplyTypes = new Set([
    'greeting_menu', 'ask_dates', 'ask_guests', 'ask_package', 'package_explainer',
    'continue_booking', 'reset_prompt', 'clarify', 'passthrough',
  ]);

  if (allowedIntents.has(raw.intent)) safe.intent = raw.intent;
  if (allowedReplyTypes.has(raw.reply_type)) safe.reply_type = raw.reply_type;
  safe.preserve_context = raw.preserve_context === true;
  safe.reset_context = raw.reset_context === true;
  safe.side_question_answer_needed = raw.side_question_answer_needed === true;
  if (typeof raw.side_question_type === 'string') safe.side_question_type = raw.side_question_type;
  if (typeof raw.next_missing_field === 'string') safe.next_missing_field = raw.next_missing_field;
  if (raw.should_handoff === true || raw.should_handoff === false) safe.should_handoff = raw.should_handoff;
  if (typeof raw.confidence === 'number') safe.confidence = Math.max(0, Math.min(1, raw.confidence));
  if (typeof raw.clarification_question === 'string') safe.clarification_question = raw.clarification_question;

  const patch = {};
  if (raw.extracted_fields_patch && typeof raw.extracted_fields_patch === 'object') {
    for (const [k, v] of Object.entries(raw.extracted_fields_patch)) {
      if (ALLOWED_PATCH_FIELDS.has(k) && v != null) patch[k] = v;
    }
  }
  safe.extracted_fields_patch = patch;
  safe.safety_flags = { ...BRAIN_SAFETY_FLAGS }; // never trust LLM safety flags
  safe.source = 'llm';
  return safe;
}

/**
 * Build the structured-understanding prompt payload for GPT-5.5 (no network here).
 * Exposed for the next slice / testing.
 */
function buildConversationBrainPrompt(input) {
  const inp = input || {};
  return {
    model: conversationBrainModel(inp.env),
    reasoning_effort: conversationBrainReasoningEffort(inp.env),
    instructions: [
      'You are Luna\'s conversation manager for a surf-house front desk.',
      'Classify the guest message and decide reply handling ONLY.',
      'You MUST NOT confirm availability, invent pricing or rooms, create bookings/payments/Stripe links, mark payments, or send confirmations.',
      'You may extract only: check_in, check_out, guest_count, package_interest, payment_choice (only if explicit).',
      'Return strict JSON for the decision contract.',
    ].join(' '),
    context: {
      message_text: trimStr(inp.message_text),
      active_missing_field: inp.active_missing_field || null,
      in_active_booking: !!inp.in_active_booking,
      message_lane: inp.message_lane || null,
      prior_extracted_fields: inp.prior_extracted_fields || {},
      known_package_facts: inp.known_package_facts || null,
    },
  };
}

/**
 * Async decision: deterministic first, GPT-5.5 fallback only when deterministic defers
 * (passthrough) or is low-confidence, and only when explicitly enabled (never production).
 * The LLM call is performed by an injected `options.llmClient(promptPayload) => rawDecision`.
 */
async function decideConversationActionAsync(input, options = {}) {
  const deterministic = decideConversationAction(input);
  const env = (input && input.env) || process.env;

  const deterministicConfident = deterministic.intent !== 'passthrough' && deterministic.confidence >= 0.6;
  if (deterministicConfident) return deterministic;

  if (!isConversationBrainLlmEnabled(env)) return deterministic;
  const client = options.llmClient;
  if (typeof client !== 'function') return deterministic; // scaffold: requires injected client

  try {
    const prompt = buildConversationBrainPrompt(input);
    const raw = await client(prompt);
    const sanitized = sanitizeLlmDecision(raw, (input || {}).active_missing_field || null);
    if (!sanitized) return deterministic;
    return sanitized;
  } catch (_) {
    return deterministic; // never fail the conversation on LLM error
  }
}

module.exports = {
  decideConversationAction,
  decideConversationActionAsync,
  buildConversationBrainPrompt,
  sanitizeLlmDecision,
  isConversationBrainEnabled,
  isConversationBrainLlmEnabled,
  conversationBrainModel,
  conversationBrainReasoningEffort,
  detectPackageSideQuestion,
  detectPackageChoice,
  parseGuestCountAnswer,
  detectResetSignal,
  BRAIN_SAFETY_FLAGS,
  ALLOWED_PATCH_FIELDS,
};
