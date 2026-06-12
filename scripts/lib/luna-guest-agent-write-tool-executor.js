'use strict';

/**
 * Stage 50d/50e — Guest agent write tool executor.
 *
 * Wraps existing gated write modules. No bypass of safety gates.
 */

const {
  isGuestAgentGptPlannableWriteTool,
} = require('./luna-guest-agent-tool-plan');
const {
  runGuestHoldPaymentDraftWriteDryRunApproved,
  shouldAllowGuestHoldPaymentDraftWrite,
} = require('./luna-guest-hold-payment-draft-write');
const {
  runGuestStripeTestLinkCreateApproved,
  shouldAllowGuestStripeTestLinkCreate,
} = require('./luna-guest-stripe-test-link-create');
const { attachAllGuestAddonServices } = require('./luna-guest-addon-service-attach');
const { mergePendingServiceAttachContext } = require('./luna-guest-pending-service-attach');
const {
  runGuestAddonServicePaymentLinkCreateApproved,
  shouldAllowGuestServicePaymentLinkCreate,
} = require('./luna-guest-addon-service-payment-link-create');
const { collectPriorExtractedFields } = require('./luna-guest-context-merge');
const { isOpenDemoBookingWritesEnabled } = require('./open-demo-whatsapp-gate');

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function normalizeChainPayload(payload) {
  const p = payload || {};
  return {
    result: p.result || {},
    availability: p.availability || {},
    quote: p.quote || {},
    payment_choice: p.payment_choice || {},
    hold_payment_draft_plan: p.hold_payment_draft_plan || null,
  };
}

function hasServiceAttachIntent(fields) {
  const f = fields || {};
  if (Array.isArray(f.service_interest) && f.service_interest.length) return true;
  if (trimStr(f.yoga_request)) return true;
  if (trimStr(f.meals_request)) return true;
  if (Array.isArray(f.services_pending_manual) && f.services_pending_manual.length) return true;
  return false;
}

function resolveBookingRef(ctx, chain) {
  const c = ctx || {};
  const live = c.live_outcomes || c.prior_write_outcomes || {};
  const hold = live.hold_write || live.booking_write || c.hold_write_outcome || {};
  const prior = c.prior_guest_context || {};
  const priorHold = prior.hold_write_outcome || prior.booking_write || {};

  const bookingId = trimStr(
    c.booking_id
    || hold.booking_id
    || priorHold.booking_id
    || (prior.result && prior.result.booking_id),
  ) || null;
  const bookingCode = trimStr(
    c.booking_code
    || hold.booking_code
    || priorHold.booking_code,
  ) || null;
  const paymentDraftId = trimStr(
    c.payment_draft_id
    || hold.payment_draft_id
    || priorHold.payment_draft_id
    || live.stripe_link && live.stripe_link.payment_draft_id,
  ) || null;

  const fields = collectPriorExtractedFields({
    ...prior,
    result: chain.result,
  });

  return { bookingId, bookingCode, paymentDraftId, fields };
}

/**
 * Evaluate whether a write tool is ready (no execution).
 */
function evaluateWriteToolReadiness(toolId, chainPayload, ctx) {
  const id = trimStr(toolId);
  const chain = normalizeChainPayload(chainPayload);
  const context = ctx || {};
  const env = context.env || process.env;
  const refs = resolveBookingRef(context, chain);

  if (!isGuestAgentGptPlannableWriteTool(id)) {
    return { tool_id: id, ready: false, would_execute: false, block_reasons: ['not_plannable_write_tool'] };
  }

  if (id === 'create_booking_hold') {
    const plan = chain.hold_payment_draft_plan || {};
    const pc = chain.payment_choice || {};
    const allow = shouldAllowGuestHoldPaymentDraftWrite(chain, {
      ...context,
      confirm_write: context.confirm_write === true,
    });
    const ready = pc.payment_choice_ready === true
      && pc.next_safe_step === 'ready_for_hold_payment_draft'
      && plan.plan_status === 'ready'
      && allow.allowed === true;
    return {
      tool_id: id,
      ready,
      would_execute: ready && context.confirm_write === true && !!context.pg,
      block_reasons: ready ? [] : [
        ...(allow.allowed ? [] : allow.reasons),
        ...(plan.plan_status === 'ready' ? [] : ['hold_plan_not_ready']),
        ...(pc.payment_choice_ready ? [] : ['payment_choice_not_ready']),
      ],
      source: 'gate_eval',
    };
  }

  if (id === 'create_payment_link') {
    const allow = shouldAllowGuestStripeTestLinkCreate({
      payment_draft_id: refs.paymentDraftId,
      booking_id: refs.bookingId,
      booking_code: refs.bookingCode,
    }, {
      ...context,
      confirm_stripe_test_link: context.confirm_stripe_test_link === true,
      env: { ...env, WHATSAPP_DRY_RUN: env.WHATSAPP_DRY_RUN || 'true' },
    });
    const ready = !!refs.paymentDraftId && allow.allowed === true;
    return {
      tool_id: id,
      ready,
      would_execute: ready && context.confirm_stripe_test_link === true,
      block_reasons: ready ? [] : [
        ...(refs.paymentDraftId ? [] : ['payment_draft_id_missing']),
        ...(allow.allowed ? [] : allow.reasons),
      ],
      source: 'gate_eval',
    };
  }

  if (id === 'attach_post_booking_services') {
    const reasons = [];
    if (!refs.bookingId) reasons.push('booking_id_missing');
    if (!hasServiceAttachIntent(refs.fields)) reasons.push('no_service_attach_intent');
    if (!isOpenDemoBookingWritesEnabled(env)) reasons.push('booking_writes_disabled');
    if (!context.pg) reasons.push('pg_required_for_active');
    const ready = reasons.length === 0;
    // Stage 56c — post-booking service attaches use confirm_service_attach (distinct from
    // confirm_write which gates new booking hold creation).
    const wouldExecute = ready
      && (context.confirm_write === true || context.confirm_service_attach === true);
    return {
      tool_id: id,
      ready,
      would_execute: wouldExecute,
      block_reasons: reasons,
      source: 'gate_eval',
    };
  }

  if (id === 'create_service_payment_link') {
    const allow = shouldAllowGuestServicePaymentLinkCreate({
      booking_id: refs.bookingId,
      service_record_ids: context.service_record_ids,
    }, {
      ...context,
      confirm_service_payment_link: context.confirm_service_payment_link === true,
    });
    const ready = !!refs.bookingId && allow.allowed === true;
    return {
      tool_id: id,
      ready,
      would_execute: ready && context.confirm_service_payment_link === true,
      block_reasons: ready ? [] : [
        ...(refs.bookingId ? [] : ['booking_id_missing']),
        ...(allow.allowed ? [] : allow.reasons),
      ],
      source: 'gate_eval',
    };
  }

  return { tool_id: id, ready: false, would_execute: false, block_reasons: ['unknown_write_tool'] };
}

/**
 * Execute one gated write tool.
 * ctx: confirm_write, confirm_stripe_test_link, confirm_service_payment_link, pg, env, host_header, live_outcomes
 */
async function executeGuestAgentWriteTool(toolId, chainPayload, ctx) {
  const id = trimStr(toolId);
  const chain = normalizeChainPayload(chainPayload);
  const context = ctx || {};
  const readiness = evaluateWriteToolReadiness(id, chain, context);

  if (!readiness.ready) {
    return {
      tool_id: id,
      status: 'blocked',
      readiness,
      result: null,
      block_reasons: readiness.block_reasons,
    };
  }

  if (!readiness.would_execute) {
    return {
      tool_id: id,
      status: 'planned',
      readiness,
      result: { would_execute_now: true, dry_run_only: true },
      block_reasons: [],
    };
  }

  const refs = resolveBookingRef(context, chain);
  const env = context.env || process.env;
  const clientSlug = trimStr(context.client_slug) || 'wolfhouse-somo';

  if (id === 'create_booking_hold') {
    const extracted_fields = mergePendingServiceAttachContext(
      chain.result.extracted_fields,
      chain.result,
    );
    const writeChain = {
      ...chain,
      result: { ...chain.result, extracted_fields },
    };
    const out = await runGuestHoldPaymentDraftWriteDryRunApproved(writeChain, {
      confirm_write: true,
      client_slug: clientSlug,
      guest_phone: context.guest_phone,
      guest_name: refs.fields.guest_name || context.contact_name,
      guest_email: context.guest_email,
      env,
      host_header: context.host_header,
      pg: context.pg,
      planner: chain.hold_payment_draft_plan,
      source: context.source || 'luna_guest_gpt_write_tool_50d',
    });
    return {
      tool_id: id,
      status: out.success ? 'ok' : 'error',
      readiness,
      result: out,
      block_reasons: out.write_block_reasons || [],
    };
  }

  if (id === 'create_payment_link') {
    const out = await runGuestStripeTestLinkCreateApproved({
      payment_draft_id: refs.paymentDraftId,
      booking_id: refs.bookingId,
      booking_code: refs.bookingCode,
      staff_operator: context.staff_operator || 'luna-gpt-write-tool',
      source: context.source || 'luna_guest_gpt_write_tool_50d',
    }, {
      confirm_stripe_test_link: true,
      env: { ...env, WHATSAPP_DRY_RUN: env.WHATSAPP_DRY_RUN || 'true' },
      host_header: context.host_header,
      pg: context.pg,
    });
    return {
      tool_id: id,
      status: out.success ? 'ok' : 'error',
      readiness,
      result: out,
      block_reasons: out.stripe_link_block_reasons || [],
    };
  }

  if (id === 'attach_post_booking_services') {
    try {
      const attachOut = await attachAllGuestAddonServices(context.pg, {
        clientSlug,
        bookingId: refs.bookingId,
        bookingCode: refs.bookingCode,
        guestName: refs.fields.guest_name || context.contact_name || 'Guest',
        extractedFields: refs.fields,
        resultContext: chain.result,
        quote: chain.quote,
        writeSource: 'luna_guest_gpt_write_tool_50e',
      });
      return {
        tool_id: id,
        status: 'ok',
        readiness,
        result: attachOut,
        block_reasons: [],
      };
    } catch (err) {
      return {
        tool_id: id,
        status: 'error',
        readiness,
        result: null,
        block_reasons: [String(err.message || err).slice(0, 120)],
      };
    }
  }

  if (id === 'create_service_payment_link') {
    const out = await runGuestAddonServicePaymentLinkCreateApproved({
      booking_id: refs.bookingId,
      service_record_ids: context.service_record_ids,
      client_slug: clientSlug,
    }, {
      confirm_service_payment_link: true,
      env,
      host_header: context.host_header,
      pg: context.pg,
    });
    return {
      tool_id: id,
      status: out.success ? 'ok' : 'error',
      readiness,
      result: out,
      block_reasons: out.stripe_link_block_reasons || [],
    };
  }

  return {
    tool_id: id,
    status: 'rejected',
    readiness,
    result: null,
    block_reasons: ['unknown_write_tool'],
  };
}

/**
 * Deterministic write plan from chain state (no GPT).
 */
function buildDeterministicWriteToolPlan(chainPayload, ctx) {
  const chain = normalizeChainPayload(chainPayload);
  const context = ctx || {};
  const refs = resolveBookingRef(context, chain);
  const tools = [];
  const pc = chain.payment_choice || {};
  const plan = chain.hold_payment_draft_plan || {};

  if (pc.payment_choice_ready === true
    && pc.next_safe_step === 'ready_for_hold_payment_draft'
    && plan.plan_status === 'ready') {
    tools.push({
      tool_id: 'create_booking_hold',
      reason: 'guest_chose_deposit_or_full_and_hold_plan_ready',
      source: 'deterministic',
    });
    tools.push({
      tool_id: 'create_payment_link',
      reason: 'deposit_stripe_link_after_hold',
      source: 'deterministic',
      depends_on: 'create_booking_hold',
    });
  }

  if (refs.bookingId && hasServiceAttachIntent(refs.fields)) {
    tools.push({
      tool_id: 'attach_post_booking_services',
      reason: 'guest_requested_addons_on_existing_booking',
      source: 'deterministic',
    });
    if (context.env && context.env.LUNA_GUEST_SERVICE_PAY_NOW_ENABLED === 'true') {
      tools.push({
        tool_id: 'create_service_payment_link',
        reason: 'optional_pay_now_for_attached_services',
        source: 'deterministic',
        depends_on: 'attach_post_booking_services',
      });
    }
  } else if (refs.bookingId
    && context.env
    && context.env.LUNA_GUEST_SERVICE_PAY_NOW_ENABLED === 'true'
    && /pay|checkout|link/i.test(trimStr(context.message_text))) {
    tools.push({
      tool_id: 'create_service_payment_link',
      reason: 'guest_asked_service_payment_link',
      source: 'deterministic',
    });
  }

  return tools;
}

module.exports = {
  evaluateWriteToolReadiness,
  executeGuestAgentWriteTool,
  buildDeterministicWriteToolPlan,
  resolveBookingRef,
  hasServiceAttachIntent,
};
