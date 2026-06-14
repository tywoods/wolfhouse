'use strict';

/**
 * Stage 30c — Luna confirmation preview/send guest copy style contract.
 *
 * Reuses luna-guest-reply-style-contract sanitization on existing preview facts.
 * Does not regenerate confirmation content or alter payment truth.
 */

const {
  sanitizeGuestReply,
  isForbiddenGuestCopy,
  isFormDevCopy,
  FORBIDDEN_GUEST_PHRASES,
  MAX_REPLY_CHARS,
} = require('./luna-guest-reply-style-contract');

const MAX_CONFIRMATION_CHARS = 900;

const CONFIRMATION_INTERNAL_PHRASES = Object.freeze([
  'staff review',
  'staff notice',
  'preview only',
  'preview ready',
  'dry run',
  'dry-run',
  'confirmation_sent_at',
  'send gate',
  'go/no-go',
  'go no-go',
  'automation gate',
  'no_write_performed',
  'await explicit',
  'handoff notice',
  'not sent to guest',
  'blocked_dry_run',
  'staff_review_confirmation',
]);

const CONFIRMATION_INTERNAL_LINE_RE = new RegExp(
  CONFIRMATION_INTERNAL_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i',
);

const GATE_CODE_REQUIRED = '2684#';
const BED_CODE_RE = /(?:DEMO-R\d+-B\d+|\bB[1-9]\b)/i;
const BED_NUMBER_RE = /\bbed\s*(?:number|#|no\.?)?\s*:?\s*\d/i;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function stripConfirmationInternalCopy(text) {
  let s = trimStr(text);
  if (!s) return s;

  s = s.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !CONFIRMATION_INTERNAL_LINE_RE.test(line))
    .join('\n\n');

  for (const phrase of CONFIRMATION_INTERNAL_PHRASES) {
    s = s.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  }

  return s.replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Apply Luna style contract to existing confirmation preview/send copy.
 * @param {string} message
 * @returns {string}
 */
function polishConfirmationGuestCopy(message) {
  const stripped = stripConfirmationInternalCopy(message);
  if (!stripped) return stripped;
  return sanitizeGuestReply(stripped) || stripped;
}

function messageHasBedLeak(message) {
  if (!message) return false;
  return BED_CODE_RE.test(message) || BED_NUMBER_RE.test(message);
}

/**
 * Validate confirmation guest copy against style + grounding rules.
 * @param {string} message
 * @param {{ booking_code?: string, amount_paid_cents?: number, balance_due_cents?: number }} context
 */
function passesConfirmationStyleContract(message, context) {
  const ctx = context || {};
  const reasons = [];
  const msg = trimStr(message);

  if (!msg) {
    reasons.push('empty_message');
    return { ok: false, reasons };
  }
  if (isForbiddenGuestCopy(msg)) reasons.push('forbidden_guest_copy');
  if (isFormDevCopy(msg)) reasons.push('form_dev_copy');
  for (const phrase of CONFIRMATION_INTERNAL_PHRASES) {
    if (new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(msg)) {
      reasons.push(`internal_phrase:${phrase}`);
    }
  }
  if (msg.length > MAX_CONFIRMATION_CHARS) reasons.push('too_long');
  if (!/\b(?:luna|wolfhouse)\b/i.test(msg.slice(0, 160))) reasons.push('missing_luna_identity');
  if (messageHasBedLeak(msg)) reasons.push('bed_number_leak');
  if (!msg.includes(GATE_CODE_REQUIRED)) reasons.push('missing_gate_code');
  if (ctx.booking_code && !msg.includes(trimStr(ctx.booking_code))) {
    reasons.push('missing_booking_code');
  }
  if (ctx.amount_paid_cents != null) {
    const euros = `€${(Number(ctx.amount_paid_cents) / 100).toFixed(0)}`;
    if (!msg.includes(euros) && !msg.includes(String(ctx.amount_paid_cents))) {
      reasons.push('missing_paid_amount');
    }
  }
  if (ctx.balance_due_cents != null && Number(ctx.balance_due_cents) > 0) {
    const euros = `€${(Number(ctx.balance_due_cents) / 100).toFixed(0)}`;
    if (!/balance|saldo|remaining/i.test(msg) && !msg.includes(euros)) {
      reasons.push('missing_balance_due');
    }
  }

  return { ok: reasons.length === 0, reasons };
}

module.exports = {
  CONFIRMATION_INTERNAL_PHRASES,
  FORBIDDEN_GUEST_PHRASES,
  GATE_CODE_REQUIRED,
  MAX_CONFIRMATION_CHARS,
  polishConfirmationGuestCopy,
  stripConfirmationInternalCopy,
  passesConfirmationStyleContract,
  messageHasBedLeak,
};
