'use strict';

/**
 * Luna guest write pipeline — single path for hold, Stripe, bed assign, service add-ons.
 *
 * Used by open-demo WhatsApp execute and orchestrator active write planner.
 */

const { runGuestHoldPaymentDraftWriteDryRunApproved } = require('./luna-guest-hold-payment-draft-write');
const { runGuestStripeTestLinkCreateApproved } = require('./luna-guest-stripe-test-link-create');
const { runOpenDemoBookingBedAssignApproved } = require('./open-demo-booking-bed-assign');
const {
  evaluateOpenDemoBookingWriteGate,
  evaluateOpenDemoHoldDraftWriteReady,
  evaluateOpenDemoBedAssignmentWriteReady,
  evaluateOpenDemoStripeTestLinkGate,
  evaluateOpenDemoStripeLinkWriteReady,
  resolveOpenDemoPaymentDraftRef,
  buildOpenDemoWriteChainFromReview,
  buildOpenDemoBookingWriteBlockedResponse,
  buildOpenDemoBedAssignmentBlockedResponse,
  buildOpenDemoStripeLinkBlockedResponse,
  formatOpenDemoStripeLinkResponse,
} = require('./open-demo-whatsapp-gate');
const {
  isGptWriteToolPlannerActive,
  isGuestServicePayNowEnabled,
} = require('./luna-guest-gpt-write-tool-planner');
const {
  executeGuestAgentWriteTool,
  hasServiceAttachIntent,
} = require('./luna-guest-agent-write-tool-executor');
const { collectPriorExtractedFields } = require('./luna-guest-context-merge');
const { syntheticGuestEmailFromPhone } = require('./luna-guest-hold-payment-draft-write');
const {
  detectBalancePaymentLinkRequest,
  runGuestBalancePaymentLinkCreateApproved,
} = require('./luna-guest-balance-payment-link-create');
const {
  guestProvidedTransferTimes,
  runGuestBookingTransferTimesUpdate,
} = require('./luna-guest-transfer-times-update');
const {
  resolveGuestServiceScheduleIntent,
  runGuestServiceScheduleWrite,
} = require('./luna-guest-service-schedule-write');
const { appendBookingLunaNotes } = require('./luna-guest-booking-notes');

const STRIPE_LINK_READY_DELAYS_MS = [0, 150, 400, 800];

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveStripeLinkWriteReady(bookingWrite, rawBody, pg, inboundBody) {
  for (const delay of STRIPE_LINK_READY_DELAYS_MS) {
    if (delay > 0) await sleepMs(delay);
    const linkReady = evaluateOpenDemoStripeLinkWriteReady(bookingWrite, rawBody);
    if (linkReady.ok) return linkReady;
    if (!pg) continue;
    const resolved = await resolveOpenDemoPaymentDraftRef(
      pg,
      inboundBody.client_slug,
      inboundBody.guest_phone,
    );
    if (resolved && resolved.payment_draft_id) {
      return {
        ok: true,
        payment_draft_id: resolved.payment_draft_id,
        booking_id: resolved.booking_id,
        booking_code: resolved.booking_code,
        next_safe_step: 'ready_for_stripe_test_link',
      };
    }
  }
  return { ok: false, missing: ['payment_draft_not_ready'] };
}

/**
 * @param {object} opts
 * @param {object} opts.review — open-demo review payload
 * @param {object} opts.inboundBody — normalized inbound
 * @param {object} opts.rawBody — original request body (gates)
 * @param {object} opts.env
 * @param {import('pg').Client} opts.pg
 * @param {string} [opts.hostHeader]
 * @param {string} [opts.actorId]
 * @param {object} opts.flags — booleans for each write step
 */
async function runGuestWritePipeline(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const pg = o.pg;
  const hostHeader = o.hostHeader || '';
  const review = o.review || {};
  const inboundBody = o.inboundBody || {};
  const rawBody = o.rawBody || {};
  const flags = o.flags || {};
  const actorId = o.actorId || 'guest-write-pipeline';

  const out = {
    bookingWrite: null,
    bedAssignment: null,
    stripeLink: null,
    balanceStripeLink: null,
    serviceAttach: null,
    serviceStripeLink: null,
    transferTimesUpdate: null,
    serviceSchedule: null,
    lunaNotes: null,
  };

  if (flags.createHoldDraft) {
    const writeGate = evaluateOpenDemoBookingWriteGate(rawBody, env);
    if (!writeGate.ok) {
      out.bookingWrite = {
        create_demo_hold_draft_confirmed: true,
        ...buildOpenDemoBookingWriteBlockedResponse(writeGate),
      };
    } else {
      const ready = evaluateOpenDemoHoldDraftWriteReady(review);
      if (!ready.ok) {
        out.bookingWrite = {
          create_demo_hold_draft_confirmed: true,
          demo_booking_write: true,
          write_attempted: false,
          write_status: 'not_ready',
          write_block_reasons: ready.missing,
          stripe_link_created: false,
          payment_link_sent: false,
          sends_whatsapp: false,
          live_send_blocked: true,
        };
      } else {
        const chain = buildOpenDemoWriteChainFromReview(review);
        const writeOut = await runGuestHoldPaymentDraftWriteDryRunApproved(chain, {
          confirm_write: true,
          client_slug: inboundBody.client_slug,
          guest_phone: inboundBody.guest_phone,
          guest_name: (chain.result && chain.result.extracted_fields && chain.result.extracted_fields.guest_name)
            || rawBody.guest_name || inboundBody.contact_name || null,
          guest_email: rawBody.guest_email
            || inboundBody.guest_email
            || syntheticGuestEmailFromPhone(inboundBody.guest_phone || rawBody.guest_phone),
          env,
          host_header: hostHeader,
          source: rawBody.source || 'luna_guest_write_pipeline',
          pg,
          planner: review.hold_payment_draft_plan,
        });
        out.bookingWrite = {
          create_demo_hold_draft_confirmed: true,
          demo_booking_write: true,
          reused_write_path: 'runGuestHoldPaymentDraftWriteDryRunApproved',
          ...writeOut,
          stripe_link_created: false,
          payment_link_sent: false,
          sends_whatsapp: false,
          live_send_blocked: true,
        };
      }
    }
  }

  if (flags.assignBed) {
    if (!flags.createHoldDraft) {
      out.bedAssignment = {
        assign_demo_bed_confirmed: true,
        ...buildOpenDemoBedAssignmentBlockedResponse(['create_demo_hold_draft_confirmed_required']),
      };
    } else if (!out.bookingWrite) {
      out.bedAssignment = {
        assign_demo_bed_confirmed: true,
        assignment_write_attempted: false,
        assignment_write_status: 'blocked',
        assignment_block_reasons: ['booking_write_not_attempted'],
        calendar_visible_expected: false,
      };
    } else {
      const assignGate = evaluateOpenDemoBookingWriteGate(rawBody, env);
      if (!assignGate.ok) {
        out.bedAssignment = {
          assign_demo_bed_confirmed: true,
          ...buildOpenDemoBedAssignmentBlockedResponse([], assignGate),
        };
      } else {
        const assignReady = evaluateOpenDemoBedAssignmentWriteReady(out.bookingWrite);
        if (!assignReady.ok) {
          out.bedAssignment = {
            assign_demo_bed_confirmed: true,
            assignment_write_attempted: false,
            assignment_write_status: 'blocked',
            assignment_block_reasons: assignReady.missing,
            calendar_visible_expected: false,
          };
        } else {
          const assignOut = await runOpenDemoBookingBedAssignApproved(pg, {
            client_slug: inboundBody.client_slug,
            booking_id: out.bookingWrite.booking_id,
            booking_code: out.bookingWrite.booking_code,
            review,
            env,
            host_header: hostHeader,
          });
          out.bedAssignment = {
            assign_demo_bed_confirmed: true,
            demo_bed_assignment: true,
            reused_assignment_path: 'runOpenDemoBookingBedAssignApproved',
            ...assignOut,
          };
        }
      }
    }
  }

  if (flags.createStripeLink) {
    const stripeGate = evaluateOpenDemoStripeTestLinkGate(rawBody, env);
    if (!stripeGate.ok) {
      out.stripeLink = buildOpenDemoStripeLinkBlockedResponse(stripeGate);
    } else {
      const linkReady = await resolveStripeLinkWriteReady(
        out.bookingWrite,
        rawBody,
        pg,
        inboundBody,
      );
      if (!linkReady.ok) {
        out.stripeLink = {
          create_stripe_test_link_confirmed: true,
          stripe_link_attempted: false,
          stripe_link_created: false,
          stripe_link_status: 'not_ready',
          stripe_link_block_reasons: linkReady.missing,
          stripe_checkout_url: null,
          payment_link_sent: false,
          sends_whatsapp: false,
          live_send_blocked: true,
        };
      } else {
        let linkOut = await runGuestStripeTestLinkCreateApproved({
          payment_draft_id: linkReady.payment_draft_id,
          booking_id: linkReady.booking_id,
          booking_code: linkReady.booking_code,
          staff_operator: actorId,
          source: 'luna_guest_write_pipeline',
        }, {
          confirm_stripe_test_link: true,
          env,
          host_header: hostHeader,
          pg,
        });
        const retryableStripe = !linkOut.success
          && Array.isArray(linkOut.block_reasons)
          && linkOut.block_reasons.some((r) => /payment_not_found|payment_draft/.test(String(r)));
        if (retryableStripe) {
          await sleepMs(500);
          linkOut = await runGuestStripeTestLinkCreateApproved({
            payment_draft_id: linkReady.payment_draft_id,
            booking_id: linkReady.booking_id,
            booking_code: linkReady.booking_code,
            staff_operator: actorId,
            source: 'luna_guest_write_pipeline_retry',
          }, {
            confirm_stripe_test_link: true,
            env,
            host_header: hostHeader,
            pg,
          });
        }
        out.stripeLink = {
          create_stripe_test_link_confirmed: true,
          demo_stripe_test_link: true,
          reused_stripe_path: 'runGuestStripeTestLinkCreateApproved',
          ...formatOpenDemoStripeLinkResponse(linkOut),
          payment_link_sent: false,
        };
      }
    }
  }

  if (isGptWriteToolPlannerActive(env)) {
    const chain = buildOpenDemoWriteChainFromReview(review);
    const fields = collectPriorExtractedFields({ result: review.result, quote: review.quote });
    // Stage 56c — also resolve booking_id from the context chain snapshot (post-booking service turns).
    const bookingId = trimStr(
      (out.bookingWrite && out.bookingWrite.booking_id)
      || (review.gpt_write_outcomes && review.gpt_write_outcomes.create_booking_hold
        && review.gpt_write_outcomes.create_booking_hold.booking_id)
      || (review.guest_context_chain && review.guest_context_chain.booking_id)
      || (inboundBody.guest_context && inboundBody.guest_context.booking_id)
      || inboundBody.booking_id,
    ) || null;
    const writeCtx = {
      env,
      pg,
      host_header: hostHeader,
      client_slug: inboundBody.client_slug,
      guest_phone: inboundBody.guest_phone,
      contact_name: inboundBody.contact_name,
      message_text: inboundBody.message_text,
      confirm_write: flags.createHoldDraft === true,
      confirm_stripe_test_link: flags.createStripeLink === true,
      confirm_service_payment_link: isGuestServicePayNowEnabled(env),
      // Stage 56c — post-booking service attaches are always confirmed when a booking_id is known.
      confirm_service_attach: !!bookingId,
      booking_id: bookingId,
      hold_write_outcome: out.bookingWrite,
    };
    if (bookingId && hasServiceAttachIntent(fields)) {
      out.serviceAttach = await executeGuestAgentWriteTool(
        'attach_post_booking_services',
        chain,
        writeCtx,
      );
    }
    // Stage 56c — only generate a service payment link when the guest explicitly requests it,
    // or when they are mid-stay. Do NOT send automatically after every service attach.
    const guestExplicitlyAskedForPayLink = /(?:pay|checkout|link).*(?:yoga|meal|surf|gear|addon|service)/i.test(inboundBody.message_text || '');
    if (bookingId && isGuestServicePayNowEnabled(env) && guestExplicitlyAskedForPayLink) {
      out.serviceStripeLink = await executeGuestAgentWriteTool(
        'create_service_payment_link',
        chain,
        writeCtx,
      );
    }
  }

  const chainBookingId = trimStr(
    (out.bookingWrite && out.bookingWrite.booking_id)
    || (review.guest_context_chain && review.guest_context_chain.booking_id)
    || (review.result && review.result.booking_id)
    || (inboundBody.guest_context && inboundBody.guest_context.booking_id)
    || inboundBody.booking_id,
  );
  if (pg && chainBookingId && detectBalancePaymentLinkRequest(inboundBody.message_text)) {
    out.balanceStripeLink = await runGuestBalancePaymentLinkCreateApproved({
      booking_id: chainBookingId,
      client_slug: inboundBody.client_slug,
      inbound_message_id: inboundBody.inbound_message_id,
    }, {
      confirm_balance_payment_link: true,
      env,
      pg,
      host_header: hostHeader,
    });
  }

  if (pg && chainBookingId) {
    const fields = collectPriorExtractedFields({ result: review.result, quote: review.quote });
    const gc = inboundBody.guest_context || {};
    const schedFields = { ...fields };
    if (gc.check_in && !schedFields.check_in) schedFields.check_in = gc.check_in;
    if (gc.check_out && !schedFields.check_out) schedFields.check_out = gc.check_out;
    if (gc.meals_request && !schedFields.meals_request) schedFields.meals_request = gc.meals_request;
    if (gc.yoga_request && !schedFields.yoga_request) schedFields.yoga_request = gc.yoga_request;
    const maintCtx = {
      client_slug: inboundBody.client_slug,
      booking_id: chainBookingId,
      message_text: inboundBody.message_text,
      extracted_fields: schedFields,
    };
    if (guestProvidedTransferTimes(fields, inboundBody.message_text)) {
      out.transferTimesUpdate = await runGuestBookingTransferTimesUpdate(pg, maintCtx);
    }
    const schedIntent = resolveGuestServiceScheduleIntent(
      inboundBody.message_text,
      schedFields,
      { check_in: schedFields.check_in, check_out: schedFields.check_out },
    );
    if (schedIntent && !schedIntent.needs_date) {
      out.serviceSchedule = await runGuestServiceScheduleWrite(pg, maintCtx);
    } else if (schedIntent && schedIntent.needs_date) {
      out.serviceSchedule = { attempted: false, skipped: 'needs_date', service_type: schedIntent.service_type };
    }
    out.lunaNotes = await appendBookingLunaNotes(pg, maintCtx);
  }

  return out;
}

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

module.exports = {
  runGuestWritePipeline,
};
