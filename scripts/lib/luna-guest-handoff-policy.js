'use strict';

/**
 * Stage 56o — Handoff is opt-in, not the default for uncertain messages.
 *
 * Implicit / low-confidence reasons must never escalate to staff on their own.
 * Only explicit escalation categories (human requested, paid-booking change, etc.)
 * may set safe_handoff_required.
 */

const { collectPriorExtractedFields } = require('./luna-guest-context-merge');

/** Never sufficient alone to require staff handoff. */
const IMPLICIT_HANDOFF_REASONS = Object.freeze(new Set([
  'low_confidence_language_or_intent',
  'outside_policy_question',
  'uncertain_package_or_pricing',
  'unclear_availability',
]));

/** May require staff handoff when present (subject to paid-booking guards). */
const EXPLICIT_HANDOFF_REASONS = Object.freeze(new Set([
  'paid_cancellation_or_reschedule',
  'date_change_different_nights',
  'payment_state_mismatch',
  'cancel_or_change_request',
  'transfer_exception',
  'bilbao_no_package_request',
  'bad_weather_lesson_refund',
  'human_requested',
  'complaint',
  'urgent_safety',
  'needs_booking_identification',
]));

const HUMAN_ESCALATION_RE = /\b(?:talk to (?:a )?(?:human|person|someone)|speak to (?:a )?(?:human|person|someone)|human(?:\s+please)?|refund|rimborso|reembolso|cancel(?:led|lation)?(?:\s+(?:paid|my)\s+booking)?|complaint|reclamaci[oó]n|reclamo|remboursement|rückerstattung|stornieren|annullare|parlare\s+con\s+qualcuno|hablar\s+con\s+alguien|parler\s+(?:à|a)\s+quelqu[\w']+|mit\s+jemandem\s+sprechen)\b/i;

const PAID_BOOKING_ONLY_REASONS = Object.freeze(new Set([
  'paid_cancellation_or_reschedule',
  'cancel_or_change_request',
]));

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function hasPaidBookingContext(guestContext) {
  const ctx = guestContext || {};
  if (ctx.payment_status === 'paid' || ctx.payment_status === 'deposit_paid' || ctx.deposit_paid === true) {
    return true;
  }
  if (ctx.payment_received === true || ctx.confirmation_sent === true) return true;
  const truth = ctx.payment_truth || (ctx.result && ctx.result.payment_truth) || null;
  const status = truth && trimStr(truth.payment_status).toLowerCase();
  if (status === 'paid' || status === 'deposit_paid' || status === 'fully_paid') return true;
  if (ctx.booking_id && (ctx.payment_link_sent === true || ctx.hold_created === true)) {
    const pc = ctx.payment_choice || (ctx.result && ctx.result.payment_choice) || {};
    if (pc.payment_choice_ready === true) return true;
  }
  return false;
}

function bookingIntakeInProgress(guestContext) {
  const ctx = guestContext || {};
  const prior = collectPriorExtractedFields(ctx);
  if (prior.check_in || prior.check_out || prior.guest_count != null || prior.package_interest) return true;
  return !!(ctx.quote && ctx.quote.quote_status === 'ready');
}

function isExplicitHumanEscalationMessage(messageText) {
  return HUMAN_ESCALATION_RE.test(trimStr(messageText));
}

function filterImplicitHandoffReasons(reasons) {
  return (reasons || []).filter((r) => !IMPLICIT_HANDOFF_REASONS.has(r));
}

/**
 * @param {object} input
 * @param {string} [input.message_lane]
 * @param {string[]} [input.handoff_reasons]
 * @param {boolean} [input.handoff_flag]
 * @param {string} [input.message_text]
 * @param {object} [input.guest_context]
 */
function shouldRequireStaffHandoff(input) {
  const inp = input || {};
  const lane = trimStr(inp.message_lane || inp.lane);
  const msg = trimStr(inp.message_text);
  const ctx = inp.guest_context || inp.prior_guest_context || {};
  const reasons = filterImplicitHandoffReasons(
    Array.isArray(inp.handoff_reasons) ? inp.handoff_reasons : (Array.isArray(inp.reasons) ? inp.reasons : []),
  );

  if (isExplicitHumanEscalationMessage(msg)) return true;
  if (lane === 'staff_handoff_required') return true;

  const explicit = reasons.filter((r) => EXPLICIT_HANDOFF_REASONS.has(r));
  if (explicit.length === 0) return false;

  if (explicit.some((r) => PAID_BOOKING_ONLY_REASONS.has(r))) {
    return hasPaidBookingContext(ctx);
  }

  return true;
}

/** Fallback when classifyMessageLane cannot confidently bucket the message. */
function resolveUnknownGuestMessage(guestContext) {
  if (bookingIntakeInProgress(guestContext)) {
    return {
      lane: 'new_booking_inquiry',
      handoff: false,
      reasons: [],
      confidence: 0.55,
    };
  }
  return {
    lane: 'general_question',
    handoff: false,
    reasons: [],
    confidence: 0.55,
    greeting_only: true,
  };
}

/**
 * Strip implicit handoff flags from a router/orchestrator result object.
 */
function applyHandoffPolicyToResult(result, guestContext, messageText) {
  const r = result || {};
  const reasons = filterImplicitHandoffReasons(r.handoff_reasons || []);
  const required = shouldRequireStaffHandoff({
    message_lane: r.message_lane,
    handoff_reasons: reasons,
    handoff_flag: r.safe_handoff_required === true,
    message_text: messageText,
    guest_context: guestContext,
  });
  return {
    ...r,
    safe_handoff_required: required,
    handoff_reasons: required ? reasons : [],
    ...(required ? {} : { readiness_state: r.readiness_state === 'staff_handoff_required' ? 'collecting_required_details' : r.readiness_state }),
  };
}

module.exports = {
  IMPLICIT_HANDOFF_REASONS,
  EXPLICIT_HANDOFF_REASONS,
  HUMAN_ESCALATION_RE,
  filterImplicitHandoffReasons,
  shouldRequireStaffHandoff,
  resolveUnknownGuestMessage,
  isExplicitHumanEscalationMessage,
  hasPaidBookingContext,
  bookingIntakeInProgress,
  applyHandoffPolicyToResult,
};
