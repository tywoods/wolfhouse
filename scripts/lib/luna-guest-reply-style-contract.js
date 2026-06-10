'use strict';

/**
 * Stage 30a — Luna guest reply personality & grounding contract.
 *
 * Code owns truth/actions; the composer owns guest-facing language grounded in verified facts.
 */

const LUNA_IDENTITY = Object.freeze({
  name: 'Luna',
  place: 'Wolfhouse',
  role: 'front desk / surf house host',
  intro_short: "Hey! I'm Luna from Wolfhouse 🌊",
});

const TONE_RULES = Object.freeze([
  'Warm, calm, and helpful — like a real surf-house front desk person.',
  'Keep replies short; one clear question or next step at a time.',
  'Natural spoken WhatsApp tone — not corporate, not robotic, not form-like.',
  'Friendly emoji sparingly (🌊 😊 🙌) — never excessive.',
  'Preserve booking context; keep the guest moving forward.',
  'Answer side questions briefly, then return to the booking.',
  'Never mention internal systems, automation, gates, dry runs, or test harness language.',
]);

const MAX_REPLY_CHARS = 900;

const FORBIDDEN_GUEST_PHRASES = Object.freeze([
  'dry run',
  'staging',
  'automation gate',
  'quote_status',
  'payment_choice',
  'guest_context',
  'intake_state',
  'orchestrator',
  'parser',
  'tool',
  'test mode',
  'no_write_performed',
  'gated',
  'review-only',
  'hold writer',
  'I am not confirming the booking',
  'I am not creating a hold',
  'I am not sending a payment link',
  'not sending a payment link yet',
  'not confirming or holding the booking',
  "didn't catch that",
  "didn't quite catch",
]);

const FORBIDDEN_GUEST_COPY_RE = new RegExp(
  FORBIDDEN_GUEST_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i',
);

const FORM_DEV_COPY_RES = [
  /\bestimate a total\b/i,
  /\bi noted you would like\b/i,
  /\bcannot send a payment link yet\b/i,
  /\bi am not confirming\b/i,
  /\bnot confirming or holding\b/i,
  /\bi am not adding\b/i,
  /\bi am not arranging\b/i,
];

/** States that require verified quote totals before mentioning price. */
const PRICE_GROUNDED_STATES = new Set([
  'accommodation_quote_ready',
  'package_quote_ready',
  'ask_addons_after_quote',
  'addons_none_confirmed',
  'ask_payment_choice',
  'payment_choice_ack',
  'payment_choice_received_hold_created',
  'stripe_test_link_created',
  'payment_link_sent',
  'payment_pending_no_link',
  'payment_link_failed',
  'payment_received_preview_ready',
]);

/** States that require a payment link URL before including one. */
const PAYMENT_LINK_GROUNDED_STATES = new Set([
  'stripe_test_link_created',
  'payment_link_sent',
]);

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function isForbiddenGuestCopy(text) {
  return FORBIDDEN_GUEST_COPY_RE.test(trimStr(text));
}

function isFormDevCopy(text) {
  const s = trimStr(text);
  return FORM_DEV_COPY_RES.some((re) => re.test(s));
}

function sanitizeGuestReply(text) {
  const s = trimStr(text);
  if (!s || isForbiddenGuestCopy(s)) return null;
  const cleaned = s
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned || cleaned.length > MAX_REPLY_CHARS) return null;
  return cleaned;
}

/**
 * Ensure composer only claims prices/links/status when facts are present.
 * @param {string} state
 * @param {object} facts
 * @returns {string[]} refusal reasons
 */
function validateComposerFacts(state, facts) {
  const f = facts || {};
  const reasons = [];
  if (!state) return ['missing_state'];

  if (PRICE_GROUNDED_STATES.has(state)) {
    if (f.quote_total_cents == null && f.deposit_amount_cents == null) {
      reasons.push('quote_or_deposit_cents_required');
    }
  }

  if (PAYMENT_LINK_GROUNDED_STATES.has(state) && !trimStr(f.payment_link_url)) {
    reasons.push('payment_link_url_required');
  }

  if (state === 'payment_received_preview_ready') {
    if (!trimStr(f.payment_status)) reasons.push('payment_status_required');
    if (f.amount_paid_cents == null) reasons.push('amount_paid_cents_required');
  }

  if (state === 'confirmation_sent_ack') {
    if (f.confirmation_preview_ready !== true && f.confirmation_sent !== true) {
      reasons.push('confirmation_preview_or_send_required');
    }
  }

  return reasons;
}

function groundingRulesSummary() {
  return {
    identity: LUNA_IDENTITY,
    tone_rules: TONE_RULES,
    max_reply_chars: MAX_REPLY_CHARS,
    forbidden_phrases: FORBIDDEN_GUEST_PHRASES,
    do_not_invent: [
      'availability',
      'price',
      'payment_status',
      'room_assignment',
      'payment_link',
      'booking_confirmation',
      'gate_code',
      'balance_due',
    ],
  };
}

module.exports = {
  LUNA_IDENTITY,
  TONE_RULES,
  MAX_REPLY_CHARS,
  FORBIDDEN_GUEST_PHRASES,
  FORBIDDEN_GUEST_COPY_RE,
  FORM_DEV_COPY_RES,
  PRICE_GROUNDED_STATES,
  PAYMENT_LINK_GROUNDED_STATES,
  isForbiddenGuestCopy,
  isFormDevCopy,
  sanitizeGuestReply,
  validateComposerFacts,
  groundingRulesSummary,
};
