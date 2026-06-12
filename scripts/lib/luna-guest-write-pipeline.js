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
    serviceAttach: null,
    serviceStripeLink: null,
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
          guest_email: rawBody.guest_email || null,
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
      let linkReady = evaluateOpenDemoStripeLinkWriteReady(out.bookingWrite, rawBody);
      if (!linkReady.ok && pg) {
        const resolved = await resolveOpenDemoPaymentDraftRef(pg, inboundBody.client_slug, inboundBody.guest_phone);
        if (resolved && resolved.payment_draft_id) {
          linkReady = {
            ok: true,
            payment_draft_id: resolved.payment_draft_id,
            booking_id: resolved.booking_id,
            booking_code: resolved.booking_code,
            next_safe_step: 'ready_for_stripe_test_link',
          };
        }
      }
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
        const linkOut = await runGuestStripeTestLinkCreateApproved({
          payment_draft_id: linkReady.payment_draft_id,
          booking_id: linkReady.booking_id,
          booking_code: linkReady.booking_code,
          staff_operator: actorId,
          source: 'luna_guest_write_pipeline',
        }, {
          confirm_stripe_test_link: true,
          env: { ...env, WHATSAPP_DRY_RUN: 'true' },
          host_header: hostHeader,
          pg,
        });
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
    const bookingId = (out.bookingWrite && out.bookingWrite.booking_id)
      || (review.gpt_write_outcomes && review.gpt_write_outcomes.create_booking_hold
        && review.gpt_write_outcomes.create_booking_hold.booking_id)
      || null;
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
    if (bookingId && isGuestServicePayNowEnabled(env)
      && (out.serviceAttach && out.serviceAttach.status === 'ok'
        || /(?:pay|checkout|link).*(?:yoga|meal|surf|gear|addon|service)/i.test(inboundBody.message_text || ''))) {
      out.serviceStripeLink = await executeGuestAgentWriteTool(
        'create_service_payment_link',
        chain,
        writeCtx,
      );
    }
  }

  return out;
}

module.exports = {
  runGuestWritePipeline,
};
