/**
 * Phase 19b — Luna guest automation action planner (compute-only, no send/write).
 *
 * Normal booking path → plan automatic action when gates pass.
 * Exceptions → staff handoff.
 */

'use strict';

const { buildLunaGuestReplyDraft } = require('./luna-guest-reply-draft');
const {
  evaluateLunaGuestReplySendEligibility,
  isWhatsappDryRun,
  isLiveSendEnvApproved,
  isOwnerApproved,
  isDryRunQuoteSafe,
} = require('./luna-guest-reply-send-eligibility');
const { evaluateLunaBookingWriteEligibility } = require('./luna-guest-booking-write-eligibility');

const PLANNER_SAFETY_FLAGS = Object.freeze({
  automation_planner:         true,
  no_write_performed:         true,
  sends_whatsapp:             false,
  creates_booking:            false,
  creates_payment:            false,
  creates_stripe_link:        false,
  calls_n8n:                  false,
  updates_confirmation_sent_at: false,
});

const FORBIDDEN_ACTIONS = Object.freeze([
  'whatsapp_send',
  'booking_create',
  'payment_create',
  'stripe_link_create',
  'stripe_webhook',
  'confirmation_sent_at_update',
  'n8n_activation',
]);

const SEND_ACTIONS = new Set(['ask_missing_field', 'send_quote']);
const WRITE_ACTIONS = new Set(['create_booking_and_payment_draft', 'create_payment_link', 'send_confirmation']);

function isTruthyEnv(env, key) {
  return String((env || {})[key] || '').trim().toLowerCase() === 'true';
}

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function dryRunRequiresHandoff(dry) {
  if (!dry) return false;
  if (dry.next_action === 'handoff_to_staff') return true;
  if (Array.isArray(dry.planned_actions) && dry.planned_actions.includes('handoff_to_staff')) return true;
  const avail = dry.availability;
  if (avail && !avail.skipped && avail.has_enough_beds === false) return true;
  return false;
}

function hasExistingBookingPayment(input, context) {
  const src = input || {};
  const ctx = context || {};
  const bookingId = trimStr(src.booking_id) || trimStr(ctx.booking_id);
  const paymentId = trimStr(src.payment_id) || trimStr(ctx.payment_id);
  return !!(bookingId && paymentId);
}

function hasPaidBookingContext(input, context) {
  const src = input || {};
  const ctx = context || {};
  const status = trimStr(src.booking_status || ctx.booking_status).toLowerCase();
  const paymentStatus = trimStr(src.payment_status || ctx.payment_status).toLowerCase();
  return status === 'confirmed' || paymentStatus === 'deposit_paid' || paymentStatus === 'paid';
}

function hasConfirmationPreviewReady(input, context) {
  const src = input || {};
  const ctx = context || {};
  return src.confirmation_preview_ready === true || ctx.confirmation_preview_ready === true;
}

function isBookingCreateReady(draft, input) {
  const dry = draft.dry_run_plan;
  const ex = draft.extraction || {};
  if (!dry || ex.handoff_required) return false;
  if (dryRunRequiresHandoff(dry)) return false;
  if (draft.next_action === 'handoff_to_staff' || draft.next_action === 'unsupported') return false;

  const planned = Array.isArray(dry.planned_actions) ? dry.planned_actions : [];
  if (!planned.includes('would_create_booking_after_approval')) return false;

  const preview = dry.booking_preview || {};
  if (preview.has_missing_fields) return false;

  const paymentChoice = trimStr(input.payment_choice).toLowerCase()
    || trimStr(ex.payment_choice).toLowerCase()
    || trimStr((preview.fields || {}).payment_choice).toLowerCase();
  if (!paymentChoice) return false;

  const avail = dry.availability || {};
  if (!avail.skipped && avail.has_enough_beds === false) return false;

  return true;
}

function collectAutomationBlockedGates(draft, input, context, env, nextAction) {
  const gates = [];
  const e = env || process.env;
  const se = draft.send_eligibility || {};

  if (SEND_ACTIONS.has(nextAction)) {
    if (isWhatsappDryRun(e)) gates.push('whatsapp_dry_run_active');
    if (!isLiveSendEnvApproved(e)) gates.push('live_send_env_not_enabled');
    if (!isOwnerApproved(e)) gates.push('stage_7_8_owner_approval_missing');
    if (!isTruthyEnv(e, 'LUNA_AUTO_SEND_ENABLED')) gates.push('luna_auto_send_not_enabled');
    if (se.requires_staff) gates.push('requires_staff');
    if (!se.send_allowed_later) gates.push('send_not_allowed_later');
  }

  if (WRITE_ACTIONS.has(nextAction) || nextAction === 'create_booking_and_payment_draft') {
    const dry = draft.dry_run_plan;
    if (dry) {
      const writeElig = evaluateLunaBookingWriteEligibility(dry, input, e);
      for (const r of writeElig.blocked_reasons || []) gates.push(r);
      for (const r of writeElig.required_approvals || []) gates.push(r);
    }
    if (!isTruthyEnv(e, 'LUNA_AUTO_SEND_ENABLED')) gates.push('luna_auto_send_not_enabled');
    if (e.BOT_BOOKING_ENABLED !== 'true') gates.push('BOT_BOOKING_ENABLED');
    if (input.confirm !== true) gates.push('confirm_true');
    if (!trimStr(input.idempotency_key)) gates.push('idempotency_key');
  }

  if (nextAction === 'create_payment_link') {
    if (!isTruthyEnv(e, 'STRIPE_LINKS_ENABLED')) gates.push('STRIPE_LINKS_ENABLED');
    if (!hasExistingBookingPayment(input, context)) gates.push('booking_payment_context_missing');
  }

  if (nextAction === 'send_confirmation') {
    gates.push('confirmation_send_not_enabled_in_19b');
  }

  const gate = draft.dry_run_plan && draft.dry_run_plan.gate;
  if (gate && gate.bot_paused === true) gates.push('gate_bot_paused');
  if (gate && gate.can_continue_guest_automation !== true) gates.push('gate_automation_blocked');

  return [...new Set(gates)];
}

function buildPlannedActions(nextAction, draft) {
  const dry = draft.dry_run_plan;
  const dryPlanned = dry && Array.isArray(dry.planned_actions) ? dry.planned_actions : [];
  const actions = [];

  if (nextAction === 'ask_missing_field') actions.push('send_reply');
  if (nextAction === 'send_quote') actions.push('send_reply', 'show_quote');
  if (nextAction === 'create_booking_and_payment_draft') {
    actions.push('send_reply', 'create_booking_draft', 'create_payment_draft');
  }
  if (nextAction === 'create_payment_link') actions.push('send_reply', 'create_stripe_link');
  if (nextAction === 'send_confirmation') actions.push('send_reply', 'send_confirmation');
  if (nextAction === 'handoff_to_staff') actions.push('handoff_to_staff');
  if (nextAction === 'unsupported') actions.push('handoff_to_staff');
  if (nextAction === 'wait_for_payment') actions.push('wait_for_payment');

  for (const a of dryPlanned) {
    if (!actions.includes(a)) actions.push(a);
  }

  return actions;
}

function resolvePlannerAction(draft, input, context) {
  const ex = draft.extraction || {};
  const dry = draft.dry_run_plan;
  const draftNext = draft.next_action;

  if (
    ex.handoff_required
    || draftNext === 'handoff_to_staff'
    || draftNext === 'unsupported'
    || ex.handoff_reason === 'low_confidence'
  ) {
    return draftNext === 'unsupported' ? 'unsupported' : 'handoff_to_staff';
  }

  if (dryRunRequiresHandoff(dry)) return 'handoff_to_staff';

  if (hasPaidBookingContext(input, context) && hasConfirmationPreviewReady(input, context)) {
    return 'send_confirmation';
  }

  if (hasExistingBookingPayment(input, context) && (input.payment_link_requested === true || trimStr(input.payment_link_requested))) {
    return 'create_payment_link';
  }

  if (isBookingCreateReady(draft, input)) {
    return 'create_booking_and_payment_draft';
  }

  if (draftNext === 'ask_missing_field') return 'ask_missing_field';

  if (
    draftNext === 'show_quote'
    && dry
    && isDryRunQuoteSafe(dry)
    && dry.reply_draft
  ) {
    return 'send_quote';
  }

  if (draftNext === 'ask_missing_field') return 'ask_missing_field';

  return draftNext === 'unsupported' ? 'unsupported' : 'handoff_to_staff';
}

/**
 * @param {object} input - guest message payload (+ optional booking/payment context)
 * @param {object} [context] - { pg, reference_date, env, booking_id, payment_id, ... }
 * @param {object} [env] - env gates (defaults to process.env)
 */
async function planLunaGuestAutomationAction(input, context = {}, env = process.env) {
  const body = input || {};
  const ctx = context || {};
  const e = env || process.env;

  const draft = await buildLunaGuestReplyDraft(body, {
    ...ctx,
    env: e,
    reference_date: ctx.reference_date || body.reference_date,
  });

  const sendEligibility = draft.send_eligibility
    || evaluateLunaGuestReplySendEligibility(draft, body, e);

  const nextAction = resolvePlannerAction(draft, body, ctx);
  const requiresStaff = nextAction === 'handoff_to_staff'
    || nextAction === 'unsupported'
    || sendEligibility.requires_staff === true;

  const blockedGates = requiresStaff
    ? (sendEligibility.blocked_reasons || [])
    : collectAutomationBlockedGates(draft, body, ctx, e, nextAction);

  const actionReadyLater = !requiresStaff
    && nextAction !== 'unsupported'
    && nextAction !== 'wait_for_payment';

  return {
    success: true,
    ...PLANNER_SAFETY_FLAGS,
    client_slug: body.client_slug || draft.client_slug || 'wolfhouse-somo',
    next_action: nextAction,
    action_ready_later: actionReadyLater,
    action_ready_now: false,
    blocked_gates: blockedGates,
    requires_staff: requiresStaff,
    suggested_reply: draft.suggested_reply || null,
    draft,
    send_eligibility: sendEligibility,
    planned_actions: buildPlannedActions(nextAction, draft),
    forbidden_actions: [...FORBIDDEN_ACTIONS],
  };
}

module.exports = {
  planLunaGuestAutomationAction,
  PLANNER_SAFETY_FLAGS,
  FORBIDDEN_ACTIONS,
  isBookingCreateReady,
  resolvePlannerAction,
  collectAutomationBlockedGates,
};
