/**
 * Phase 18c — Luna guest reply send eligibility (read-only classifier).
 *
 * Decides whether a built draft is safe for future automatic sending.
 * Does not send WhatsApp or perform any writes.
 */

'use strict';

const ELIGIBILITY_SAFETY_FLAGS = {
  would_send_whatsapp:              false,
  sends_whatsapp:                   false,
  no_write_performed:               true,
  creates_booking:                  false,
  creates_payment:                  false,
  creates_stripe_link:              false,
  calls_n8n:                        false,
  updates_confirmation_sent_at:     false,
};

const RISKY_MESSAGE_RE = /\b(?:refund|rimborso|reembolso|reembolsar|cancel(?:led|lation|ar|led)?(?:\s+(?:paid|my)\s+booking)?|complaint|reclamaci[oó]n|reclamo|chargeback|dispute|lawyer|sue|stolen|fraud|parlare\s+con\s+qualcuno|hablar\s+con\s+alguien|talk to (?:a )?(?:human|person|someone)|speak to (?:a )?(?:human|person|someone))\b/i;

const PAYMENT_LINK_RE = /\b(?:payment link|checkout link|stripe link|pay.?now link|link de pago|lien de paiement)\b/i;

const CONFIRMATION_SEND_RE = /\b(?:confirmation send|send confirmation|check.?in instructions|enviar confirmaci[oó]n)\b/i;

const STAFF_INTENTS = new Set(['human_request', 'cancel_request', 'complaint']);

function isTruthyEnv(env, key) {
  return String((env || {})[key] || '').trim().toLowerCase() === 'true';
}

function isWhatsappDryRun(env) {
  const v = String((env || {}).WHATSAPP_DRY_RUN ?? 'true').trim().toLowerCase();
  return v !== 'false';
}

function isLiveSendEnvApproved(env) {
  return isTruthyEnv(env, 'WHATSAPP_LIVE_SENDS_ENABLED');
}

function isOwnerApproved(env) {
  return isTruthyEnv(env, 'LUNA_GUEST_LIVE_SEND_OWNER_APPROVED')
    || isTruthyEnv(env, 'STAGE_7_8_OWNER_APPROVED');
}

function dryRunHasWriteFlags(dry) {
  return !!(dry && (dry.creates_booking || dry.creates_payment || dry.creates_stripe_link));
}

function dryRunRequiresHandoff(dry) {
  if (!dry) return false;
  const dryNext = dry.next_action || (dry.booking_preview && dry.booking_preview.next_action);
  if (dryNext === 'handoff_to_staff') return true;
  if (Array.isArray(dry.planned_actions) && dry.planned_actions.includes('handoff_to_staff')) return true;
  const avail = dry.availability;
  if (avail && !avail.skipped && avail.has_enough_beds === false) return true;
  return false;
}

function isDryRunQuoteSafe(dry) {
  if (!dry || dryRunHasWriteFlags(dry) || dryRunRequiresHandoff(dry)) return false;
  return !!(dry.reply_draft || (dry.booking_preview && dry.booking_preview.reply_draft));
}

function collectStaffBlockReasons(draft, input) {
  const reasons = [];
  const d = draft || {};
  const ex = d.extraction || {};
  const dry = d.dry_run_plan;
  const msgText = String(d.message_text || input.message_text || '');
  const reply = String(d.suggested_reply || '').trim();
  const nextAction = d.next_action;

  if (ex.handoff_required) reasons.push('handoff_required');
  if (nextAction === 'handoff_to_staff') reasons.push('next_action_handoff_to_staff');
  if (nextAction === 'unsupported') reasons.push('unsupported_or_low_confidence');
  if (ex.handoff_reason === 'low_confidence') reasons.push('low_confidence');

  if (STAFF_INTENTS.has(ex.intent)) reasons.push(`risky_intent_${ex.intent}`);
  if (RISKY_MESSAGE_RE.test(msgText)) reasons.push('risky_message_keywords');
  if (PAYMENT_LINK_RE.test(msgText)) reasons.push('payment_link_request');
  if (CONFIRMATION_SEND_RE.test(msgText)) reasons.push('confirmation_send_request');

  if (!reply) reasons.push('missing_suggested_reply');

  if (d.creates_booking) reasons.push('draft_creates_booking');
  if (d.creates_payment) reasons.push('draft_creates_payment');
  if (d.creates_stripe_link) reasons.push('draft_creates_stripe_link');

  if (dry) {
    if (dry.creates_booking) reasons.push('dry_run_creates_booking');
    if (dry.creates_payment) reasons.push('dry_run_creates_payment');
    if (dry.creates_stripe_link) reasons.push('dry_run_creates_stripe_link');
    if (dryRunRequiresHandoff(dry)) reasons.push('dry_run_handoff_or_insufficient_availability');
  }

  return reasons;
}

function isContentEligibleForLaterSend(draft, staffBlockReasons) {
  if (staffBlockReasons.length > 0) return { eligible: false, kind: null };

  const d = draft || {};
  const ex = d.extraction || {};
  const reply = String(d.suggested_reply || '').trim();
  const nextAction = d.next_action;

  if (nextAction === 'ask_missing_field' && reply && !ex.handoff_required) {
    const dry = d.dry_run_plan;
    if (dry && (dryRunHasWriteFlags(dry) || dryRunRequiresHandoff(dry))) {
      return { eligible: false, kind: null };
    }
    return { eligible: true, kind: 'ask_missing_field' };
  }

  if (nextAction === 'show_quote' && reply && !ex.handoff_required && d.dry_run_plan && isDryRunQuoteSafe(d.dry_run_plan)) {
    return { eligible: true, kind: 'show_quote' };
  }

  return { eligible: false, kind: null };
}

function collectLiveSendGateReasons(env) {
  const reasons = [];
  if (isWhatsappDryRun(env)) reasons.push('whatsapp_dry_run_active');
  if (!isLiveSendEnvApproved(env)) reasons.push('live_send_env_not_enabled');
  if (!isOwnerApproved(env)) reasons.push('stage_7_8_owner_approval_missing');
  return reasons;
}

/**
 * @param {object} draft - result from buildLunaGuestReplyDraft
 * @param {object} [input] - original guest message payload
 * @param {object} [env] - env gates (defaults to process.env)
 */
function evaluateLunaGuestReplySendEligibility(draft, input = {}, env = process.env) {
  const staffBlockReasons = collectStaffBlockReasons(draft, input);
  const uniqueStaffBlocks = [...new Set(staffBlockReasons)];
  const { eligible, kind } = isContentEligibleForLaterSend(draft, uniqueStaffBlocks);
  const gateReasons = collectLiveSendGateReasons(env);

  const send_allowed_later = eligible;
  const auto_send_ready = send_allowed_later && gateReasons.length === 0;
  const requires_staff = !send_allowed_later;

  const blocked_reasons = auto_send_ready
    ? []
    : [...uniqueStaffBlocks, ...(send_allowed_later ? gateReasons : [])];

  return {
    auto_send_ready,
    send_allowed_later,
    requires_staff,
    blocked_reasons: [...new Set(blocked_reasons)],
    allowed_send_kind: send_allowed_later ? kind : null,
    ...ELIGIBILITY_SAFETY_FLAGS,
  };
}

module.exports = {
  evaluateLunaGuestReplySendEligibility,
  ELIGIBILITY_SAFETY_FLAGS,
  isWhatsappDryRun,
  isLiveSendEnvApproved,
  isOwnerApproved,
  isDryRunQuoteSafe,
};
