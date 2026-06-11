'use strict';

/**
 * Stage 49b — Luna guest Agent Brain v1 tool plan layer.
 *
 * Planner/mapper only: it maps an agent intent + the orchestrator's already-computed
 * chain results (router / availability / quote / payment choice / hold plan) onto a
 * declarative tool plan. It NEVER executes tools itself — pricing, availability,
 * booking writes, bed assignment, and Stripe stay in their existing gated modules.
 */

const GUEST_AGENT_TOOLS = Object.freeze({
  explain_packages: {
    read_or_write: 'read',
    safety_gate_required: false,
    backing: 'luna-guest-package-explainer.buildPackageExplainerReply (config truth)',
  },
  collect_missing_booking_fields: {
    read_or_write: 'read',
    safety_gate_required: false,
    backing: 'luna-guest-message-router.runLunaGuestMessageRouterDryRun (extraction)',
  },
  check_availability: {
    read_or_write: 'read',
    safety_gate_required: false,
    backing: 'luna-guest-availability-dry-run.runGuestAvailabilityDryRun',
  },
  quote_booking: {
    read_or_write: 'read',
    safety_gate_required: false,
    backing: 'luna-guest-quote-proposal-dry-run.runGuestQuoteProposalDryRun',
  },
  create_booking_hold: {
    read_or_write: 'write',
    safety_gate_required: true,
    backing: 'luna-guest-hold-payment-draft-write (env-gated booking write path)',
  },
  assign_beds: {
    read_or_write: 'write',
    safety_gate_required: true,
    backing: 'existing bed assignment path on hold write (env-gated)',
  },
  create_payment_link: {
    read_or_write: 'write',
    safety_gate_required: true,
    backing: 'existing Stripe TEST link path (env-gated)',
  },
  check_payment_status: {
    read_or_write: 'read',
    safety_gate_required: false,
    backing: 'payment truth from conversation/booking context (Stripe webhook truth)',
  },
  get_conversation_context: {
    read_or_write: 'read',
    safety_gate_required: false,
    backing: 'orchestrator prior guest_context + conversation history',
  },
  mark_handoff: {
    read_or_write: 'write',
    safety_gate_required: true,
    backing: 'router safe_handoff_required + existing staff handoff path',
  },
  summarize_for_staff: {
    read_or_write: 'read',
    safety_gate_required: false,
    backing: 'agent brain handoff summary (observability only)',
  },
  compose_cami_reply: {
    read_or_write: 'read',
    safety_gate_required: false,
    backing: 'luna-guest-reply-composer + Cami personality config',
  },
});

function planItem(toolId, reason, currentStatus, wouldExecuteNow) {
  const def = GUEST_AGENT_TOOLS[toolId] || {};
  return {
    tool_id: toolId,
    reason,
    read_or_write: def.read_or_write || 'read',
    safety_gate_required: def.safety_gate_required === true,
    current_status: currentStatus || 'not_run',
    would_execute_now: wouldExecuteNow === true,
    dry_run_only: def.safety_gate_required === true,
  };
}

function chainStatus(payload) {
  const p = payload || {};
  const availability = p.availability || {};
  const quote = p.quote || {};
  const paymentChoice = p.payment_choice || {};
  const holdPlan = p.hold_payment_draft_plan || {};
  return {
    availability_status: availability.availability_status || 'not_ready',
    quote_status: quote.quote_status || 'not_ready',
    payment_choice_ready: paymentChoice.payment_choice_ready === true,
    hold_plan_status: holdPlan.plan_status || 'not_run',
  };
}

/**
 * Map an agent intent + chain results onto a declarative tool plan.
 * input: { intent, payload, missing_fields, handoff_required }
 */
function planGuestAgentToolSteps(input) {
  const inp = input || {};
  const intent = inp.intent || 'general_question';
  const status = chainStatus(inp.payload);
  const missing = Array.isArray(inp.missing_fields) ? inp.missing_fields : [];
  const steps = [];

  steps.push(planItem(
    'get_conversation_context',
    'read prior booking facts and conversation state',
    'done',
    false,
  ));

  if (intent === 'package_info') {
    steps.push(planItem('explain_packages', 'guest asked for package information', 'done', false));
    steps.push(planItem('compose_cami_reply', 'answer directly in Cami voice with a next step', 'done', false));
    return steps;
  }

  if (intent === 'payment_status_question') {
    steps.push(planItem(
      'check_payment_status',
      'guest claims payment vs unpaid mismatch — use payment truth, never invent',
      status.payment_choice_ready ? 'context_available' : 'no_payment_truth_in_context',
      false,
    ));
    steps.push(planItem('summarize_for_staff', 'specific summary so staff can match the payment', 'done', false));
    steps.push(planItem('mark_handoff', 'team verifies payment records', 'planned', false));
    steps.push(planItem('compose_cami_reply', 'reassure guest while team checks', 'done', false));
    return steps;
  }

  if (intent === 'paid_booking_change') {
    steps.push(planItem('summarize_for_staff', 'refund/change on paid booking needs humans', 'done', false));
    steps.push(planItem('mark_handoff', 'paid cancellation/refund is staff-only', 'planned', false));
    steps.push(planItem('compose_cami_reply', 'warm handoff without fake promises', 'done', false));
    return steps;
  }

  // Booking-progress intents share the deterministic chain.
  if (missing.length > 0) {
    steps.push(planItem(
      'collect_missing_booking_fields',
      `still missing: ${missing.join(', ')}`,
      'in_progress',
      false,
    ));
  }
  steps.push(planItem(
    'check_availability',
    'availability truth from inventory',
    status.availability_status,
    false,
  ));
  steps.push(planItem(
    'quote_booking',
    'pricing truth from existing quote engine',
    status.quote_status,
    false,
  ));
  if (status.payment_choice_ready) {
    steps.push(planItem(
      'create_booking_hold',
      'guest picked deposit/full — existing gated write path executes',
      status.hold_plan_status,
      false,
    ));
    steps.push(planItem('assign_beds', 'bed assignment via existing hold write path', 'pending_gates', false));
    steps.push(planItem('create_payment_link', 'Stripe TEST link via existing gated path', 'pending_gates', false));
  }
  steps.push(planItem('compose_cami_reply', 'final guest copy in Cami voice', 'done', false));
  return steps;
}

module.exports = {
  GUEST_AGENT_TOOLS,
  planGuestAgentToolSteps,
};
