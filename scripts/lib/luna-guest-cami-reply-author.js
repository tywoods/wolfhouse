'use strict';

/**
 * Stage 50b — GPT Cami Reply Author (read-only final reply layer).
 *
 * Runs AFTER the deterministic chain (router, availability, quote, payment, composer,
 * agent brain). GPT rewrites the guest-facing reply using only structured facts.
 * No tool execution, no writes, no invented prices/availability/payment state.
 */

const { callLunaAiJsonChat } = require('./luna-ai-provider');
const { resolveActivePersonality } = require('./luna-guest-personality-config');
const {
  FORBIDDEN_GUEST_COPY_RE,
  isForbiddenGuestCopy,
  isFormDevCopy,
  sanitizeGuestReply,
  MAX_REPLY_CHARS,
} = require('./luna-guest-reply-style-contract');
const { buildWhatsAppPackageLines } = require('./luna-guest-package-explainer');
const { collectPriorExtractedFields } = require('./luna-guest-context-merge');

const FLAG = 'LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED';
const FLAG_PROD = 'LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED_PROD';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 8000;

const INTERNAL_WORDS_RE = /\b(?:\bAI\b|\bmodel\b|\bprompt\b|\btool\b|\bbackend\b|\bdatabase\b|\brouter\b|\bcomposer\b|\borchestrator\b|\bdry[\s-]?run\b|\bstripe\s+link\b)\b/i;
const CONFIRMED_RE = /\b(?:booking\s+is\s+confirmed|you(?:'re| are)\s+confirmed|reservation\s+is\s+confirmed|fully\s+confirmed)\b/i;
const PAID_RE = /\b(?:payment\s+(?:went\s+through|received|completed)|you(?:'ve| have)\s+paid|already\s+paid|deposit\s+paid)\b/i;
const AVAIL_CLAIM_RE = /\b(?:i\s+checked\s+it|beds?\s+available|we\s+have\s+(?:space|availability)|availability\s+looks\s+good)\b/i;
const EXPLAIN_ASK_RE = /\bwant\s+me\s+to\s+explain\b/i;
const PUSHY_CLOSER_RE = /looking forward to hearing from you|can't wait to hear from you/i;
const EURO_RE = /€\s*(\d+(?:[.,]\d{1,2})?)/g;

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function isProductionEnv(env) {
  return String((env || {}).NODE_ENV || '').trim().toLowerCase() === 'production';
}

function isCamiReplyAuthorEnabled(env) {
  const e = env || process.env;
  if (isProductionEnv(e)) {
    return String(e[FLAG_PROD] || '').toLowerCase() === 'true';
  }
  return String(e[FLAG] || '').toLowerCase() === 'true';
}

function authorModel(env) {
  const e = env || process.env;
  return trimStr(e.LUNA_GUEST_CAMI_REPLY_AUTHOR_MODEL) || DEFAULT_MODEL;
}

function authorTimeoutMs(env) {
  const e = env || process.env;
  const v = Number(e.LUNA_GUEST_CAMI_REPLY_AUTHOR_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 30000) : DEFAULT_TIMEOUT_MS;
}

function euroToCents(str) {
  const n = parseFloat(String(str).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function formatEuro(cents) {
  if (cents == null || !Number.isFinite(cents)) return null;
  const eur = cents / 100;
  return eur % 1 === 0 ? String(Math.round(eur)) : eur.toFixed(2).replace(/\.00$/, '');
}

function buildPackageFacts(clientSlug, lang) {
  const lines = buildWhatsAppPackageLines(lang || 'en');
  return {
    packages: [
      { code: 'malibu', label: 'Malibu', from_eur: 249, line: lines.malibu || '' },
      { code: 'uluwatu', label: 'Uluwatu', from_eur: 349, line: lines.uluwatu || '' },
      { code: 'waimea', label: 'Waimea', from_eur: 499, line: lines.waimea || '' },
    ],
    formatted_lines: [lines.malibu, lines.uluwatu, lines.waimea].filter(Boolean),
  };
}

function buildBookingState(payload, priorGuestContext) {
  const result = (payload && payload.result) || {};
  const fields = { ...collectPriorExtractedFields(priorGuestContext || {}), ...(result.extracted_fields || {}) };
  const missing = [];
  if (!fields.check_in || !fields.check_out) missing.push('dates');
  if (!fields.guest_count) missing.push('guest_count');
  if (!fields.package_interest && fields.accommodation_only !== true) missing.push('package_or_accommodation');
  if (!fields.guest_name) missing.push('guest_name');
  return {
    check_in: fields.check_in || null,
    check_out: fields.check_out || null,
    guest_count: fields.guest_count != null ? fields.guest_count : null,
    package_interest: fields.package_interest || null,
    guest_name: fields.guest_name || null,
    accommodation_only: fields.accommodation_only === true,
    missing_fields: missing,
    intake_state: result.intake_state || null,
    message_lane: result.message_lane || null,
    greeting_only: result.greeting_only === true,
    safe_handoff_required: result.safe_handoff_required === true,
    handoff_reasons: Array.isArray(result.handoff_reasons) ? result.handoff_reasons : [],
    detected_language: result.detected_language || 'en',
  };
}

function buildQuoteFacts(quote) {
  const q = quote || {};
  return {
    quote_status: q.quote_status || 'not_ready',
    quote_total_cents: q.quote_total_cents != null ? q.quote_total_cents : null,
    quote_total_eur: q.quote_total_cents != null ? formatEuro(q.quote_total_cents) : null,
    deposit_required_cents: q.deposit_required_cents != null ? q.deposit_required_cents : null,
    deposit_eur: q.deposit_required_cents != null ? formatEuro(q.deposit_required_cents) : null,
    package_code: q.package_code || null,
    nights: q.nights != null ? q.nights : null,
  };
}

function buildAvailabilityFacts(availability) {
  const a = availability || {};
  return {
    availability_status: a.availability_status || 'not_ready',
    has_enough_beds: a.has_enough_beds === true,
    selected_bed_codes: Array.isArray(a.selected_bed_codes) ? a.selected_bed_codes : [],
  };
}

function buildPaymentFacts(paymentChoice, holdPlan, priorGuestContext) {
  const pc = paymentChoice || {};
  const plan = holdPlan || {};
  const prior = priorGuestContext || {};
  const paymentTruth = prior.payment_truth || null;
  const paymentStatus = paymentTruth && trimStr(paymentTruth.payment_status).toLowerCase();
  const paid = paymentStatus === 'paid' || paymentStatus === 'deposit_paid' || paymentStatus === 'fully_paid';
  return {
    payment_choice_ready: pc.payment_choice_ready === true,
    payment_preference: pc.payment_preference || null,
    hold_plan_status: plan.plan_status || 'not_run',
    payment_link_url: trimStr(plan.payment_link_url || plan.stripe_checkout_url) || null,
    booking_hold_ready: plan.ready_for_hold_draft === true,
    payment_status_known: paid,
    payment_status: paid ? paymentStatus : null,
  };
}

function buildHandoffFacts(payload) {
  const result = (payload && payload.result) || {};
  return {
    handoff_required: result.safe_handoff_required === true,
    handoff_reasons: Array.isArray(result.handoff_reasons) ? result.handoff_reasons : [],
  };
}

function buildPersonalityGuidance(clientSlug) {
  const resolved = resolveActivePersonality(clientSlug);
  const p = resolved.personality;
  if (!p) {
    return {
      personality_id: resolved.active_personality_id || 'luna_safe',
      voice_summary: 'Warm surf-house front desk — casual, human, not corporate.',
      traits: ['warm', 'casual', 'helpful'],
      dont: ['sound corporate', 'repeat Perfect every turn', 'giant paragraphs'],
    };
  }
  return {
    personality_id: p.personality_id || resolved.active_personality_id,
    voice_summary: p.voice_summary || p.description || '',
    traits: (p.voice && p.voice.traits) || [],
    do: (p.voice && p.voice.do) || [],
    dont: (p.voice && p.voice.dont) || [],
    tone_rules: p.tone_rules || [],
    emoji_rules: p.emoji_rules || null,
  };
}

function buildRecentMessages(latestGuestMessage, priorGuestContext, deterministicReply) {
  const msgs = [];
  const lastOut = priorGuestContext && priorGuestContext.result
    && trimStr(priorGuestContext.result.proposed_luna_reply);
  if (lastOut) msgs.push({ role: 'assistant', text: lastOut.slice(0, 500) });
  if (trimStr(latestGuestMessage)) msgs.push({ role: 'guest', text: trimStr(latestGuestMessage) });
  if (trimStr(deterministicReply) && !msgs.some((m) => m.role === 'assistant' && m.text === deterministicReply)) {
    msgs.push({ role: 'deterministic_draft', text: trimStr(deterministicReply).slice(0, 800) });
  }
  return msgs;
}

function buildAuthorInput(args) {
  const a = args || {};
  const payload = a.payload || {};
  const clientSlug = trimStr(a.client_slug) || 'wolfhouse-somo';
  const bookingState = buildBookingState(payload, a.prior_guest_context);
  const lang = bookingState.detected_language || 'en';
  return {
    client_slug: clientSlug,
    latest_guest_message: trimStr(a.latest_guest_message || a.message_text),
    recent_messages: a.recent_messages || buildRecentMessages(
      a.latest_guest_message || a.message_text,
      a.prior_guest_context,
      a.deterministic_reply,
    ),
    booking_state: bookingState,
    package_facts: a.package_facts || buildPackageFacts(clientSlug, lang),
    availability_result: buildAvailabilityFacts(payload.availability),
    quote_result: buildQuoteFacts(payload.quote),
    payment_choice_result: buildPaymentFacts(payload.payment_choice, payload.hold_payment_draft_plan, a.prior_guest_context),
    hold_payment_plan_result: {
      plan_status: (payload.hold_payment_draft_plan && payload.hold_payment_draft_plan.plan_status) || 'not_run',
      payment_link_url: trimStr(payload.hold_payment_draft_plan && payload.hold_payment_draft_plan.payment_link_url) || null,
      ready_for_hold_draft: payload.hold_payment_draft_plan && payload.hold_payment_draft_plan.ready_for_hold_draft === true,
    },
    handoff_result: buildHandoffFacts(payload),
    deterministic_reply: trimStr(a.deterministic_reply),
    allowed_next_action: trimStr(a.allowed_next_action) || null,
    personality_config: buildPersonalityGuidance(clientSlug),
    channel_mode: trimStr(a.channel_mode) || 'orchestrator_dry_run',
    composer_state: a.composer_state || null,
  };
}

function buildAuthorSystemPrompt() {
  return [
    'You are Luna, the Wolfhouse surf-house front desk host (Cami personality).',
    'Rewrite ONE WhatsApp reply for the guest using ONLY the JSON facts provided.',
    'You must NOT invent prices, availability, payment status, booking confirmation, or URLs.',
    'You must NOT mention AI, models, prompts, tools, backend, database, router, composer, or Stripe link.',
    'Use warm casual surf-house tone — human, cute but not childish, tasteful emojis, readable spacing.',
    'Be helpful, not pushy: one clear next step, no sales pressure, no repeated sign-offs.',
    'Do NOT repeat the guest name every message. Do NOT say "Looking forward to hearing from you" every turn.',
    'On greeting-only turns: welcome warmly and ask if they want to book a stay or need info — NO package names, NO prices.',
    'Only explain Malibu/Uluwatu/Waimea when booking intake needs package choice or guest asked about packages.',
    'Use blank lines between package bullets or sections. Avoid starting with "Perfect" if the draft already used it.',
    'Preserve exact dates, guest count, package name, quote total, and deposit from facts.',
    'Include exactly ONE clear next step or question.',
    'If a payment URL is in facts, include it naturally — never call it a Stripe link.',
    'If handoff is required in facts, be warm but do not promise instant confirmation.',
    'Return ONLY valid JSON: {"reply":"your message"}',
  ].join('\n');
}

function buildAuthorUserPrompt(input) {
  return JSON.stringify({
    task: 'rewrite_guest_reply',
    latest_guest_message: input.latest_guest_message,
    recent_messages: input.recent_messages,
    booking_state: input.booking_state,
    package_facts: input.package_facts,
    availability_result: input.availability_result,
    quote_result: input.quote_result,
    payment_choice_result: input.payment_choice_result,
    hold_payment_plan_result: input.hold_payment_plan_result,
    handoff_result: input.handoff_result,
    allowed_next_action: input.allowed_next_action,
    personality: input.personality_config,
    deterministic_draft_reply: input.deterministic_reply,
    composer_state: input.composer_state,
  }, null, 2);
}

function parseAuthorJson(text) {
  const raw = trimStr(text);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.reply === 'string') return trimStr(parsed.reply);
  } catch { /* fall through */ }
  const m = raw.match(/\{[\s\S]*"reply"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
  }
  if (!raw.startsWith('{')) return raw;
  return null;
}

function allowedEuroCentsSet(input) {
  const allowed = new Set();
  const q = input.quote_result || {};
  const pay = input.payment_choice_result || {};
  const pf = input.package_facts || {};
  const bs = input.booking_state || {};
  if (q.quote_total_cents != null) allowed.add(q.quote_total_cents);
  if (q.deposit_required_cents != null) allowed.add(q.deposit_required_cents);
  if (pay.deposit_required_cents != null) allowed.add(pay.deposit_required_cents);
  // Quote-ready replies may cite deposit even when only total is in quote payload.
  if (q.quote_status === 'ready' && q.deposit_required_cents == null) allowed.add(10000);
  const packageExplainTurn = bs.guest_count && bs.check_in && !bs.package_interest
    || /explain_packages|ask_package/i.test(String(input.composer_state || ''));
  if (packageExplainTurn) {
    for (const pkg of (pf.packages || [])) {
      if (pkg.from_eur != null) allowed.add(pkg.from_eur * 100);
    }
  }
  return allowed;
}

function replyMentionsDate(reply, isoDate) {
  if (!isoDate) return false;
  const d = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const day = d.getUTCDate();
  const shortMonth = month.slice(0, 3);
  const patterns = [
    isoDate,
    `${month} ${day}`,
    `${shortMonth} ${day}`,
    `${day} ${month}`,
  ];
  const lower = reply.toLowerCase();
  return patterns.some((p) => lower.includes(String(p).toLowerCase()));
}

/**
 * Validate GPT-authored reply against structured facts.
 * @returns {string[]} rejection reasons (empty = pass)
 */
function validateCamiAuthoredReply(reply, input) {
  const text = trimStr(reply);
  const reasons = [];
  if (!text) return ['empty_reply'];

  if (isForbiddenGuestCopy(text) || INTERNAL_WORDS_RE.test(text)) {
    reasons.push('forbidden_internal_copy');
  }
  if (isFormDevCopy(text)) reasons.push('form_dev_copy');
  if (text.length > MAX_REPLY_CHARS) reasons.push('reply_too_long');

  const bs = input.booking_state || {};
  const qr = input.quote_result || {};
  const av = input.availability_result || {};
  const pay = input.payment_choice_result || {};
  const allowedCents = allowedEuroCentsSet(input);

  let euroMatch;
  const euroRe = new RegExp(EURO_RE.source, EURO_RE.flags);
  while ((euroMatch = euroRe.exec(text)) !== null) {
    const cents = euroToCents(euroMatch[1]);
    if (cents != null && allowedCents.size > 0 && !allowedCents.has(cents)) {
      reasons.push(`invented_price_eur_${euroMatch[1]}`);
    }
  }

  if (AVAIL_CLAIM_RE.test(text) && av.availability_status !== 'ready' && av.has_enough_beds !== true
    && qr.quote_status !== 'ready') {
    reasons.push('availability_claim_without_result');
  }

  if (CONFIRMED_RE.test(text) && pay.hold_plan_status !== 'ready' && !pay.payment_status_known) {
    reasons.push('confirmation_claim_without_truth');
  }

  if (PAID_RE.test(text) && !pay.payment_status_known) {
    reasons.push('paid_claim_without_truth');
  }

  if (EXPLAIN_ASK_RE.test(text) && /\bpackages?\b/i.test(input.latest_guest_message || '')) {
    reasons.push('redundant_explain_offer');
  }

  if (bs.greeting_only === true || input.composer_state === 'greeting') {
    if (/malibu/i.test(text) && /uluwatu/i.test(text)) reasons.push('greeting_unsolicited_packages');
    if (/€\s*\d+/i.test(text)) reasons.push('greeting_unsolicited_prices');
  }

  if (PUSHY_CLOSER_RE.test(text) && bs.greeting_only !== true) {
    reasons.push('pushy_repeated_closer');
  }

  const needsPackageExplain = (bs.missing_fields || []).includes('package_or_accommodation')
    || input.allowed_next_action === 'ask_missing_details'
    || /ask_package|explain_packages|package_quote/i.test(String(input.composer_state || ''));
  const hasAllPackages = /malibu/i.test(text) && /uluwatu/i.test(text) && /waimea/i.test(text);
  if (needsPackageExplain && bs.guest_count && bs.check_in && !bs.package_interest && !hasAllPackages) {
    reasons.push('package_choice_without_explain');
  }

  if (hasAllPackages && !/\n/.test(text) && text.length > 280) {
    reasons.push('package_explanation_giant_paragraph');
  }

  const qCount = (text.match(/\?/g) || []).length;
  if (qCount > 2) reasons.push('too_many_questions');

  if (bs.check_in && bs.check_out) {
    const mentionsWrongRange = /\b(?:june|july|august|september|october|november|december|january|february|march|april|may)\b/i.test(text)
      && !replyMentionsDate(text, bs.check_in) && !replyMentionsDate(text, bs.check_out)
      && /\b\d{1,2}\b/.test(text);
    if (mentionsWrongRange && text.length > 60) {
      reasons.push('dates_may_have_changed');
    }
  }

  if (bs.guest_count != null) {
    const countMatches = text.match(/\b(\d{1,2})\s+guests?\b/i);
    if (countMatches && Number(countMatches[1]) !== Number(bs.guest_count)) {
      reasons.push('guest_count_changed');
    }
  }

  if (bs.package_interest && qr.quote_status === 'ready') {
    const pkg = String(bs.package_interest).toLowerCase();
    if (!new RegExp(`\\b${pkg}\\b`, 'i').test(text)) {
      reasons.push('package_name_dropped');
    }
  }

  const paymentLinkStage = !!pay.payment_link_url;
  if (qr.quote_status === 'ready' && qr.quote_total_eur && !paymentLinkStage) {
    if (!text.includes(`€${qr.quote_total_eur}`) && !text.includes(`€${qr.quote_total_eur}.`)) {
      const alt = formatEuro(qr.quote_total_cents);
      if (alt && !text.includes(`€${alt}`)) reasons.push('quote_total_missing');
    }
  }

  if (input.allowed_next_action === 'collect_payment_choice' && qr.quote_status === 'ready') {
    if (!/\b(?:deposit|full(?:\s+payment)?|pay\s+in\s+full)\b/i.test(text)) {
      reasons.push('payment_choice_question_missing');
    }
  }

  if (pay.payment_link_url) {
    if (!text.includes(pay.payment_link_url)) reasons.push('payment_link_url_missing');
  }

  return reasons;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('cami_reply_author_timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * @param {object} input — see buildAuthorInput fields + deterministic_reply
 * @param {object} [options]
 * @param {function} [options.authorCaller] async ({system,user,model,env}) => string|null
 * @param {NodeJS.ProcessEnv} [options.env]
 */
async function runCamiGuestReplyAuthor(input, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const deterministic = trimStr(input && input.deterministic_reply);
  const base = {
    authored_reply: deterministic || null,
    author_used: false,
    rejection_reason: null,
    fallback_used: true,
    safety_notes: [],
  };

  if (!deterministic) {
    base.rejection_reason = 'no_deterministic_reply';
    base.safety_notes.push('skipped_no_candidate');
    return base;
  }

  if (!isCamiReplyAuthorEnabled(env)) {
    base.rejection_reason = 'author_disabled';
    base.safety_notes.push('flag_off');
    return base;
  }

  if (input && input.handoff_result && input.handoff_result.handoff_required) {
    base.rejection_reason = 'handoff_skip';
    base.safety_notes.push('skipped_handoff_lane');
    return base;
  }

  const authorInput = input.booking_state ? input : buildAuthorInput(input);

  if (authorInput.booking_state && authorInput.booking_state.greeting_only === true) {
    base.rejection_reason = 'greeting_skip';
    base.safety_notes.push('skipped_greeting_use_composer_welcome');
    return base;
  }
  if (authorInput.composer_state === 'greeting') {
    base.rejection_reason = 'greeting_skip';
    base.safety_notes.push('skipped_greeting_composer_state');
    return base;
  }
  const caller = opts.authorCaller || defaultAuthorCaller;

  let rawText = null;
  try {
    rawText = await withTimeout(
      caller({
        system: buildAuthorSystemPrompt(),
        user: buildAuthorUserPrompt(authorInput),
        model: authorModel(env),
        env,
      }),
      authorTimeoutMs(env),
    );
  } catch (err) {
    base.rejection_reason = String((err && err.message) || err).slice(0, 120);
    base.safety_notes.push('author_call_failed');
    return base;
  }

  const parsed = parseAuthorJson(rawText);
  const sanitized = sanitizeGuestReply(parsed);
  if (!sanitized) {
    base.rejection_reason = 'unparseable_or_unsafe_reply';
    base.safety_notes.push('parse_or_sanitize_failed');
    return base;
  }

  const rejections = validateCamiAuthoredReply(sanitized, authorInput);
  if (rejections.length) {
    base.rejection_reason = rejections.join(';');
    base.safety_notes.push('validator_rejected');
    base.safety_notes.push(...rejections.slice(0, 5));
    return base;
  }

  return {
    authored_reply: sanitized,
    author_used: true,
    rejection_reason: null,
    fallback_used: false,
    safety_notes: ['gpt_cami_author_accepted'],
  };
}

async function defaultAuthorCaller({ system, user, model, env }) {
  const text = await callLunaAiJsonChat({
    system,
    user,
    env: { ...env, LUNA_AI_MODEL: model },
    maxTokens: 512,
    temperature: 0.4,
    jsonObject: true,
    call_label: 'luna_guest_cami_reply_author',
  });
  return text;
}

function buildCamiReplyAuthorObservability(output) {
  const o = output || {};
  return {
    cami_reply_author_enabled: isCamiReplyAuthorEnabled(process.env),
    cami_author_used: o.author_used === true,
    cami_author_fallback_used: o.fallback_used === true,
    cami_author_rejection_reason: o.rejection_reason || null,
    cami_author_safety_notes: Array.isArray(o.safety_notes) ? o.safety_notes : [],
  };
}

/**
 * Orchestrator hook — runs after agent brain, before final response.
 */
async function applyCamiReplyAuthorStage(args) {
  const a = args || {};
  const deterministic = trimStr(a.deterministic_reply);
  const authorOut = await runCamiGuestReplyAuthor({
    client_slug: a.client_slug,
    latest_guest_message: a.message_text,
    prior_guest_context: a.prior_guest_context,
    payload: a.payload,
    deterministic_reply: deterministic,
    allowed_next_action: a.allowed_next_action,
    composer_state: a.composed && a.composed.composer_state,
    channel_mode: a.channel_mode || 'orchestrator_dry_run',
  }, {
    env: a.env,
    authorCaller: a.authorCaller,
  });

  const used = authorOut.author_used === true && trimStr(authorOut.authored_reply);
  return {
    reply: used ? authorOut.authored_reply : deterministic,
    reply_source: used ? 'cami_reply_author' : a.deterministic_reply_source,
    author: authorOut,
    observability: buildCamiReplyAuthorObservability(authorOut),
  };
}

module.exports = {
  FLAG,
  FLAG_PROD,
  isCamiReplyAuthorEnabled,
  buildAuthorInput,
  buildAuthorSystemPrompt,
  buildAuthorUserPrompt,
  validateCamiAuthoredReply,
  runCamiGuestReplyAuthor,
  applyCamiReplyAuthorStage,
  buildCamiReplyAuthorObservability,
};
