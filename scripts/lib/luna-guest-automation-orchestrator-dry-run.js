'use strict';

/**
 * Stage 27u — Guest automation orchestrator (dry-run only).
 *
 * Applies Stage 27t automation gate, then routes through existing 27b–27m helpers.
 * No public inbound WhatsApp, no live send, no writes, Stripe, Meta, or n8n.
 *
 * Does NOT call: 27n write, 27o Stripe link, 27p payment truth, 27q preview, 27r/27s send.
 */

const { runLunaGuestMessageRouterDryRun } = require('./luna-guest-message-router');
const { runGuestAvailabilityDryRun, buildGuestAvailabilitySkippedResponse, shouldAttemptGuestAvailability } = require('./luna-guest-availability-dry-run');
const { runGuestQuoteProposalDryRun } = require('./luna-guest-quote-proposal-dry-run');
const {
  runGuestPaymentChoiceDryRun,
  shouldAttemptGuestPaymentChoiceWire,
  buildPaymentChoiceWireContext,
  buildGuestPaymentChoiceSkippedResponse,
} = require('./luna-guest-payment-choice-dry-run');
const {
  runGuestHoldPaymentDraftPlannerDryRun,
} = require('./luna-guest-hold-payment-draft-planner');

const DEFAULT_CLIENT = 'wolfhouse-somo';

const SUPPORTED_CLIENT_SLUGS = new Set([DEFAULT_CLIENT]);
const SUPPORTED_CHANNELS = new Set(['whatsapp', 'dry_run', 'harness', 'staff_review']);

const REUSED_CHAIN_HELPERS = Object.freeze([
  'runLunaGuestMessageRouterDryRun (27b/27e)',
  'runGuestAvailabilityDryRun (27g)',
  'runGuestQuoteProposalDryRun (27i)',
  'runGuestPaymentChoiceDryRun (27k)',
  'runGuestHoldPaymentDraftPlannerDryRun (27m)',
]);

const VALID_PROPOSED_NEXT_ACTIONS = Object.freeze([
  'ask_missing_details',
  'show_availability_quote',
  'collect_payment_choice',
  'prepare_hold_payment_draft_plan',
  'staff_handoff_required',
  'automation_blocked',
]);

const ORCHESTRATOR_SAFETY = Object.freeze({
  dry_run: true,
  preview_only: true,
  no_write_performed: true,
  sends_whatsapp: false,
  live_send_blocked: true,
  whatsapp_sent: false,
  calls_n8n: false,
  creates_booking: false,
  creates_payment: false,
  creates_stripe_link: false,
  payment_link_sent: false,
  creates_hold: false,
  confirmation_send_allowed: false,
});

const NON_BOOKING_LANES = new Set([
  'existing_booking_question',
  'add_service_request',
  'transfer_request',
  'payment_question',
  'checkin_house_info_question',
  'cancel_or_change_request',
  'general_question',
  'staff_handoff_required',
]);

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function mergeGateContext(input, context) {
  const inpGate = (input && input.automation_gate_context) || {};
  const ctxGate = (context && context.automation_gate_context) || {};
  return { ...ctxGate, ...inpGate };
}

function isDryRunEvaluationRequested(input, context) {
  if (input && input.dry_run === true) return true;
  if (context && context.dry_run === true) return true;
  return true;
}

/**
 * Stage 27t gate evaluation for orchestrator dry-run.
 */
function evaluateAutomationGate(input, context) {
  const gateCtx = mergeGateContext(input, context);
  const reasons = [];
  const clientSlug = trimStr(input && input.client_slug) || DEFAULT_CLIENT;
  const channel = trimStr(input && input.channel).toLowerCase() || 'whatsapp';
  const dryRunEval = isDryRunEvaluationRequested(input, context);
  const publicEnabled = gateCtx.public_guest_automation_enabled === true;
  const requestLiveSend = gateCtx.request_live_send === true
    || (input && input.request_live_send === true);

  if (!trimStr(input && input.client_slug)) {
    reasons.push('missing_client_slug');
  } else if (!SUPPORTED_CLIENT_SLUGS.has(clientSlug)) {
    reasons.push('unsupported_client_slug');
  }

  if (!SUPPORTED_CHANNELS.has(channel)) {
    reasons.push('unsupported_channel');
  }

  if (gateCtx.is_owner_or_staff === true) {
    reasons.push('owner_or_staff_route');
  }

  if (gateCtx.bot_paused === true) {
    reasons.push('bot_paused');
  }

  if (gateCtx.human_takeover === true) {
    reasons.push('human_takeover');
  }

  if (!publicEnabled && !dryRunEval) {
    reasons.push('public_guest_automation_disabled');
  }

  if (requestLiveSend && gateCtx.live_send_allowed !== true) {
    reasons.push('live_send_not_explicitly_allowed');
  }

  if (requestLiveSend && gateCtx.whatsapp_dry_run !== false && gateCtx.live_send_allowed === true) {
    if (gateCtx.allowlisted_phone == null || trimStr(gateCtx.allowlisted_phone) === '') {
      reasons.push('live_send_allowlist_missing');
    }
  }

  if (gateCtx.unsafe_gate_context === true) {
    reasons.push('unsafe_gate_context');
  }

  if (reasons.length === 0) {
    return {
      gate_status: 'allowed_dry_run',
      gate_reasons: [],
      dry_run_evaluation: dryRunEval,
      public_guest_automation_enabled: publicEnabled,
    };
  }

  const staffHandoff = reasons.some((r) => r === 'bot_paused' || r === 'human_takeover');
  return {
    gate_status: staffHandoff ? 'staff_handoff_required' : 'blocked',
    gate_reasons: reasons,
    dry_run_evaluation: dryRunEval,
    public_guest_automation_enabled: publicEnabled,
  };
}

function buildGateBlockedReply(gate) {
  if (gate.gate_status === 'staff_handoff_required') {
    return "Thanks for your message — Luna is paused or our team is helping on this thread. Someone from Wolfhouse will follow up soon.";
  }
  if (gate.gate_reasons.includes('owner_or_staff_route')) {
    return 'This number is routed to staff tools — guest automation is not applied here.';
  }
  return 'Guest automation is not available for this request right now. Our team can help if needed.';
}

function resolveProposedNextAction(payload) {
  const {
    gate,
    result,
    availability,
    quote,
    payment_choice: pc,
    hold_payment_draft_plan: plan,
  } = payload;

  if (gate && gate.gate_status !== 'allowed_dry_run') {
    return gate.gate_status === 'staff_handoff_required'
      ? 'staff_handoff_required'
      : 'automation_blocked';
  }

  if (!result) return 'automation_blocked';

  if (plan && plan.plan_status === 'ready') {
    return 'prepare_hold_payment_draft_plan';
  }

  if (pc && pc.payment_choice_ready) {
    return 'prepare_hold_payment_draft_plan';
  }

  if (quote && quote.quote_status === 'ready' && pc && !pc.payment_choice_ready) {
    return 'collect_payment_choice';
  }

  const chainProgress = (pc && pc.payment_choice_ready)
    || (quote && quote.quote_status === 'ready')
    || (plan && plan.plan_status === 'ready');

  if (!chainProgress && (
    result.safe_handoff_required
    || result.message_lane === 'staff_handoff_required'
    || (availability && availability.availability_handoff_required)
    || (quote && quote.quote_handoff_required)
    || (plan && plan.plan_handoff_required)
  )) {
    return 'staff_handoff_required';
  }

  if (quote && quote.quote_proposal_attempted) {
    return 'show_availability_quote';
  }

  if (availability && availability.availability_check_attempted) {
    return 'show_availability_quote';
  }

  if (result.message_lane === 'new_booking_inquiry'
    && (result.readiness_state === 'collecting_required_details'
      || (result.missing_required_fields && result.missing_required_fields.length > 0))) {
    return 'ask_missing_details';
  }

  if (NON_BOOKING_LANES.has(result.message_lane)) {
    return result.safe_handoff_required ? 'staff_handoff_required' : 'ask_missing_details';
  }

  return 'ask_missing_details';
}

function resolveProposedReply(payload) {
  const {
    hold_payment_draft_plan: plan,
    payment_choice: pc,
    quote,
    availability,
    result,
    gate,
  } = payload;

  if (gate && gate.gate_status !== 'allowed_dry_run') {
    return buildGateBlockedReply(gate);
  }

  if (plan && plan.proposed_luna_reply) return plan.proposed_luna_reply;
  if (pc && pc.proposed_luna_reply) return pc.proposed_luna_reply;
  if (quote && quote.proposed_luna_reply) return quote.proposed_luna_reply;
  if (availability && availability.proposed_luna_reply) return availability.proposed_luna_reply;
  if (result && result.proposed_luna_reply) return result.proposed_luna_reply;
  return "Hi! I'm Luna from Wolfhouse 🌊 — thanks for your message.";
}

function buildOrchestratorResponse(parts) {
  const gate = parts.automation_gate;
  const publicEnabled = gate.public_guest_automation_enabled === true;

  return {
    success: true,
    ...ORCHESTRATOR_SAFETY,
    dry_run: true,
    public_guest_automation_enabled: publicEnabled,
    automation_gate: {
      gate_status: gate.gate_status,
      gate_reasons: gate.gate_reasons,
    },
    result: parts.result ?? null,
    availability: parts.availability ?? null,
    quote: parts.quote ?? null,
    payment_choice: parts.payment_choice ?? null,
    hold_payment_draft_plan: parts.hold_payment_draft_plan ?? null,
    proposed_next_action: parts.proposed_next_action,
    proposed_luna_reply: parts.proposed_luna_reply,
    reused_chain_helpers: [...REUSED_CHAIN_HELPERS],
  };
}

function buildNonBookingLaneResponse(result, gate) {
  const payload = {
    gate,
    result,
    availability: null,
    quote: null,
    payment_choice: null,
    hold_payment_draft_plan: null,
  };
  return buildOrchestratorResponse({
    automation_gate: gate,
    result,
    availability: null,
    quote: null,
    payment_choice: null,
    hold_payment_draft_plan: null,
    proposed_next_action: resolveProposedNextAction(payload),
    proposed_luna_reply: resolveProposedReply(payload),
  });
}

/**
 * Run guest automation orchestrator dry-run.
 *
 * @param {object} input
 * @param {object} [context]
 */
async function runGuestAutomationOrchestratorDryRun(input, context) {
  const inp = input || {};
  const ctx = context || {};
  const gate = evaluateAutomationGate(inp, ctx);

  if (gate.gate_status !== 'allowed_dry_run') {
    return buildOrchestratorResponse({
      automation_gate: gate,
      result: null,
      availability: null,
      quote: null,
      payment_choice: null,
      hold_payment_draft_plan: null,
      proposed_next_action: resolveProposedNextAction({ gate }),
      proposed_luna_reply: buildGateBlockedReply(gate),
    });
  }

  const routerContext = {
    reference_date: inp.reference_date || ctx.reference_date,
    language_hint: inp.language_hint,
    prior_fields: (inp.guest_context && inp.guest_context.prior_fields) || undefined,
    client_slug: trimStr(inp.client_slug) || DEFAULT_CLIENT,
  };

  const result = runLunaGuestMessageRouterDryRun(
    {
      message_text: trimStr(inp.message_text),
      language_hint: inp.language_hint,
    },
    routerContext,
  );

  const bookingContinuation = shouldAttemptGuestPaymentChoiceWire(inp.guest_context);

  if (result.message_lane !== 'new_booking_inquiry' && !bookingContinuation) {
    return buildNonBookingLaneResponse(result, gate);
  }

  const chainCtx = {
    client_slug: trimStr(inp.client_slug) || DEFAULT_CLIENT,
    pg: ctx.pg || null,
  };

  let availability;
  if (shouldAttemptGuestAvailability(result)) {
    availability = await runGuestAvailabilityDryRun(result, chainCtx);
  } else {
    availability = buildGuestAvailabilitySkippedResponse(result);
  }

  const quote = runGuestQuoteProposalDryRun(result, availability, chainCtx);

  const wireCtx = buildPaymentChoiceWireContext(
    inp.guest_context,
    result,
    availability,
    quote,
  );

  let payment_choice;
  if (shouldAttemptGuestPaymentChoiceWire(inp.guest_context)) {
    payment_choice = runGuestPaymentChoiceDryRun(
      { message_text: trimStr(inp.message_text), language_hint: inp.language_hint },
      wireCtx,
    );
  } else {
    payment_choice = buildGuestPaymentChoiceSkippedResponse(wireCtx);
  }

  let hold_payment_draft_plan = null;
  if (payment_choice && payment_choice.payment_choice_ready === true) {
    hold_payment_draft_plan = runGuestHoldPaymentDraftPlannerDryRun(
      { result, availability, quote, payment_choice },
      {
        client_slug: chainCtx.client_slug,
        guest_phone: inp.guest_phone || null,
        conversation_id: inp.conversation_id || null,
      },
    );
  }

  const payload = {
    gate,
    result,
    availability,
    quote,
    payment_choice,
    hold_payment_draft_plan,
  };

  return buildOrchestratorResponse({
    automation_gate: gate,
    result,
    availability,
    quote,
    payment_choice,
    hold_payment_draft_plan,
    proposed_next_action: resolveProposedNextAction(payload),
    proposed_luna_reply: resolveProposedReply(payload),
  });
}

module.exports = {
  runGuestAutomationOrchestratorDryRun,
  evaluateAutomationGate,
  resolveProposedNextAction,
  resolveProposedReply,
  SUPPORTED_CLIENT_SLUGS,
  SUPPORTED_CHANNELS,
  VALID_PROPOSED_NEXT_ACTIONS,
  REUSED_CHAIN_HELPERS,
  ORCHESTRATOR_SAFETY,
};
