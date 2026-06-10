'use strict';

/**
 * Stage 28c.3 — Shared open-demo WhatsApp inbound execution (review + optional gated writes).
 * Used by POST /staff/bot/open-demo-whatsapp-inbound-dry-run and Meta Staff API webhook.
 */

const { runGuestInboundReviewDryRun } = require('./luna-guest-inbound-review-dry-run');
const { evaluateGuestReplySendRouteWithPause } = require('./luna-guest-reply-send-route');
const {
  persistOpenDemoInboundThreadMessage,
  persistOpenDemoLiveReplyThreadMessage,
} = require('./luna-staff-inbox-thread-message');
const { runGuestHoldPaymentDraftWriteDryRunApproved } = require('./luna-guest-hold-payment-draft-write');
const { runOpenDemoBookingBedAssignApproved } = require('./open-demo-booking-bed-assign');
const { runGuestStripeTestLinkCreateApproved } = require('./luna-guest-stripe-test-link-create');
const {
  evaluateOpenDemoWhatsAppGate,
  evaluateOpenDemoWhatsAppLiveReplyGate,
  evaluateOpenDemoBookingWriteGate,
  evaluateOpenDemoHoldDraftWriteReady,
  evaluateOpenDemoBedAssignmentWriteReady,
  buildOpenDemoWriteChainFromReview,
  validateOpenDemoInboundBody,
  wantsSendLiveReplyConfirmed,
  wantsCreateDemoHoldDraftConfirmed,
  wantsAssignDemoBedConfirmed,
  wantsCreateStripeTestLinkConfirmed,
  wantsSendPaymentLinkWhatsAppConfirmed,
  evaluateOpenDemoStripeTestLinkGate,
  evaluateOpenDemoStripeLinkWriteReady,
  resolveOpenDemoPaymentDraftRef,
  buildOpenDemoPaymentLinkSendBody,
  formatOpenDemoStripeLinkResponse,
  buildOpenDemoStripeLinkBlockedResponse,
  buildOpenDemoPaymentLinkSendBlockedResponse,
  buildOpenDemoLiveReplySendBody,
  buildOpenDemoLiveReplyBlockedResponse,
  buildOpenDemoBookingWriteBlockedResponse,
  buildOpenDemoBedAssignmentBlockedResponse,
  shouldDeferOpenDemoPaymentChoiceReviewReply,
} = require('./open-demo-whatsapp-gate');
const { composeLunaGuestReply } = require('./luna-guest-reply-composer');

/**
 * @param {import('pg').Client} pg
 * @param {object} body — open-demo inbound request (n8n or Meta-shaped)
 * @param {object} env
 * @param {{
 *   hostHeader?: string,
 *   actorId?: string,
 *   resolveWriteFlagsAfterReview?: (review: object) => {
 *     create_demo_hold_draft_confirmed?: boolean,
 *     assign_demo_bed_confirmed?: boolean,
 *     create_stripe_test_link_confirmed?: boolean,
 *     send_payment_link_whatsapp_confirmed?: boolean,
 *   },
 * }} [options]
 */
async function sendOpenDemoLiveReplyMessage(pg, inboundBody, rawBody, env, proposedReply) {
  const reply = proposedReply != null ? String(proposedReply).trim() : '';
  if (!reply) {
    return {
      send_live_reply_confirmed: true,
      live_reply_attempted: true,
      live_send_blocked: true,
      sends_whatsapp: false,
      whatsapp_sent: false,
      send_performed: false,
      live_reply_gate_blocked: true,
      live_reply_gate_code: 'missing_proposed_reply',
      live_reply_error: 'proposed_luna_reply is required for live send',
    };
  }
  const liveGate = evaluateOpenDemoWhatsAppLiveReplyGate(rawBody, env);
  if (!liveGate.ok) {
    return {
      send_live_reply_confirmed: true,
      live_reply_attempted: true,
      ...buildOpenDemoLiveReplyBlockedResponse(liveGate),
    };
  }
  const sendBody = buildOpenDemoLiveReplySendBody(inboundBody, reply);
  const evaluated = await evaluateGuestReplySendRouteWithPause(sendBody, { pg, env });
  const sendResult = evaluated.result || {};
  const sent = sendResult.send_performed === true && sendResult.sends_whatsapp === true;
  return {
    send_live_reply_confirmed: true,
    live_reply_attempted: true,
    live_send_blocked: !sent,
    sends_whatsapp: sent,
    whatsapp_sent: sent,
    send_performed: sent,
    live_reply_gate_blocked: !sent,
    live_reply_gate_code: sent ? null : ((sendResult.blocked_reasons || [])[0] || 'send_blocked'),
    live_reply_error: sent ? null : (sendResult.provider_error || null),
    reused_send_path: 'evaluateGuestReplySendRouteWithPause',
    guest_message_send_id: sendResult.guest_message_send_id || null,
    guest_message_send_status: sendResult.guest_message_send_status || null,
    whatsapp_message_id: sendResult.whatsapp_message_id || null,
    idempotency_key: sendBody.idempotency_key,
    send_result: sendResult,
  };
}

async function executeOpenDemoWhatsAppInbound(pg, body, env, options = {}) {
  const hostHeader = options.hostHeader || '';
  const actorId = options.actorId || 'open-demo-inbound';
  const rawBody = body || {};

  const validation = validateOpenDemoInboundBody(rawBody);
  if (!validation.ok) {
    return {
      reviewOutcome: {
        ok: false,
        status: 400,
        error: `${validation.missing.join(', ')} ${validation.missing.length === 1 ? 'is' : 'are'} required`,
        dry_run: true,
        sends_whatsapp: false,
        live_send_blocked: true,
      },
      liveReply: null,
      bookingWrite: null,
      bedAssignment: null,
      stripeLink: null,
      paymentLinkSend: null,
    };
  }
  const inboundBody = validation.normalized;

  let sendLiveReplyConfirmed = wantsSendLiveReplyConfirmed(rawBody);
  let createHoldDraftConfirmed = wantsCreateDemoHoldDraftConfirmed(rawBody);
  let assignDemoBedConfirmed = wantsAssignDemoBedConfirmed(rawBody);
  let createStripeTestLinkConfirmed = wantsCreateStripeTestLinkConfirmed(rawBody);
  let sendPaymentLinkWhatsAppConfirmed = wantsSendPaymentLinkWhatsAppConfirmed(rawBody);

  const reviewOutcome = await runGuestInboundReviewDryRun(inboundBody, { pg });
  if (!reviewOutcome.ok) {
    return {
      reviewOutcome,
      liveReply: null,
      bookingWrite: null,
      bedAssignment: null,
      stripeLink: null,
      paymentLinkSend: null,
      threadInbound: null,
      threadOutbound: null,
    };
  }

  let threadInbound = null;
  const conversationId = reviewOutcome.body && reviewOutcome.body.conversation_id
    ? String(reviewOutcome.body.conversation_id)
    : null;
  if (pg && conversationId) {
    try {
      threadInbound = await persistOpenDemoInboundThreadMessage(pg, {
        client_slug: inboundBody.client_slug,
        conversation_id: conversationId,
        message_text: inboundBody.message_text,
        whatsapp_message_id: inboundBody.inbound_message_id,
        wamid: rawBody.wamid || inboundBody.inbound_message_id,
        inbound_message_id: inboundBody.inbound_message_id,
      });
    } catch (_) {
      threadInbound = { ok: false, persisted: false, reason: 'persist_error' };
    }
  }

  const reviewForFlags = reviewOutcome.body.review || {};
  if (typeof options.resolveWriteFlagsAfterReview === 'function') {
    const autoFlags = options.resolveWriteFlagsAfterReview(reviewForFlags) || {};
    if (autoFlags.create_demo_hold_draft_confirmed === true) createHoldDraftConfirmed = true;
    if (autoFlags.assign_demo_bed_confirmed === true) assignDemoBedConfirmed = true;
    if (autoFlags.create_stripe_test_link_confirmed === true) createStripeTestLinkConfirmed = true;
    if (autoFlags.send_payment_link_whatsapp_confirmed === true) {
      sendPaymentLinkWhatsAppConfirmed = true;
    }
  }

  let liveReply = null;
  let bookingWrite = null;
  let bedAssignment = null;
  let stripeLink = null;
  let paymentLinkSend = null;
  let threadOutbound = null;

  let proposedReplyForSend = reviewForFlags.proposed_luna_reply != null
    ? String(reviewForFlags.proposed_luna_reply).trim()
    : '';

  const deferPaymentChoiceReviewReply = shouldDeferOpenDemoPaymentChoiceReviewReply(
    rawBody,
    env,
    reviewForFlags,
    {
      send_live_reply_confirmed: sendLiveReplyConfirmed,
      create_demo_hold_draft_confirmed: createHoldDraftConfirmed,
    },
  );

  if (sendLiveReplyConfirmed && !deferPaymentChoiceReviewReply) {
    liveReply = await sendOpenDemoLiveReplyMessage(
      pg,
      inboundBody,
      rawBody,
      env,
      proposedReplyForSend,
    );
  }

  if (createHoldDraftConfirmed) {
    const writeGate = evaluateOpenDemoBookingWriteGate(rawBody, env);
    if (!writeGate.ok) {
      bookingWrite = {
        create_demo_hold_draft_confirmed: true,
        ...buildOpenDemoBookingWriteBlockedResponse(writeGate),
      };
    } else {
      const review = reviewOutcome.body.review || {};
      const ready = evaluateOpenDemoHoldDraftWriteReady(review);
      if (!ready.ok) {
        bookingWrite = {
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
          source: rawBody.source || 'open_demo_whatsapp_booking_write',
          pg,
          planner: review.hold_payment_draft_plan,
        });
        bookingWrite = {
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

  if (assignDemoBedConfirmed) {
    if (!createHoldDraftConfirmed) {
      bedAssignment = {
        assign_demo_bed_confirmed: true,
        ...buildOpenDemoBedAssignmentBlockedResponse(['create_demo_hold_draft_confirmed_required']),
      };
    } else {
      const assignGate = evaluateOpenDemoBookingWriteGate(rawBody, env);
      if (!assignGate.ok) {
        bedAssignment = {
          assign_demo_bed_confirmed: true,
          ...buildOpenDemoBedAssignmentBlockedResponse([], assignGate),
        };
      } else if (!bookingWrite) {
        bedAssignment = {
          assign_demo_bed_confirmed: true,
          assignment_write_attempted: false,
          assignment_write_status: 'blocked',
          assignment_block_reasons: ['booking_write_not_attempted'],
          calendar_visible_expected: false,
        };
      } else {
        const assignReady = evaluateOpenDemoBedAssignmentWriteReady(bookingWrite);
        if (!assignReady.ok) {
          bedAssignment = {
            assign_demo_bed_confirmed: true,
            assignment_write_attempted: false,
            assignment_write_status: 'blocked',
            assignment_block_reasons: assignReady.missing,
            calendar_visible_expected: false,
            stripe_link_created: false,
            payment_link_sent: false,
            sends_whatsapp: false,
            live_send_blocked: true,
          };
        } else {
          const assignOut = await runOpenDemoBookingBedAssignApproved(pg, {
            client_slug: inboundBody.client_slug,
            booking_id: bookingWrite.booking_id,
            booking_code: bookingWrite.booking_code,
            review: reviewOutcome.body.review || {},
            env,
            host_header: hostHeader,
          });
          bedAssignment = {
            assign_demo_bed_confirmed: true,
            demo_bed_assignment: true,
            reused_assignment_path: 'runOpenDemoBookingBedAssignApproved',
            ...assignOut,
          };
        }
      }
    }
  }

  if (createStripeTestLinkConfirmed) {
    const stripeGate = evaluateOpenDemoStripeTestLinkGate(rawBody, env);
    if (!stripeGate.ok) {
      stripeLink = buildOpenDemoStripeLinkBlockedResponse(stripeGate);
    } else {
      let linkReady = evaluateOpenDemoStripeLinkWriteReady(bookingWrite, rawBody);
      if (!linkReady.ok) {
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
        stripeLink = {
          create_stripe_test_link_confirmed: true,
          stripe_link_attempted: false,
          stripe_link_created: false,
          stripe_link_reused: false,
          stripe_link_status: 'not_ready',
          stripe_link_block_reasons: linkReady.missing,
          stripe_checkout_url: null,
          payment_link_sent: false,
          sends_whatsapp: false,
          live_send_blocked: true,
          confirmation_sent: false,
        };
      } else {
        const linkOut = await runGuestStripeTestLinkCreateApproved({
          payment_draft_id: linkReady.payment_draft_id,
          booking_id: linkReady.booking_id,
          booking_code: linkReady.booking_code,
          staff_operator: actorId,
          source: 'open_demo_whatsapp_stripe_test_link',
        }, {
          confirm_stripe_test_link: true,
          env: { ...env, WHATSAPP_DRY_RUN: 'true' },
          host_header: hostHeader,
          pg,
        });
        stripeLink = {
          create_stripe_test_link_confirmed: true,
          demo_stripe_test_link: true,
          reused_stripe_path: 'runGuestStripeTestLinkCreateApproved',
          ...formatOpenDemoStripeLinkResponse(linkOut),
          payment_link_sent: false,
          confirmation_sent: false,
        };
      }
    }
  }

  if (sendPaymentLinkWhatsAppConfirmed) {
    if (!createStripeTestLinkConfirmed) {
      paymentLinkSend = buildOpenDemoPaymentLinkSendBlockedResponse(
        ['create_stripe_test_link_confirmed_required'],
      );
    } else if (!stripeLink || stripeLink.demo_stripe_link_blocked || stripeLink.stripe_link_status === 'not_ready') {
      paymentLinkSend = buildOpenDemoPaymentLinkSendBlockedResponse(['stripe_test_link_not_ready']);
    } else {
      const checkoutUrl = stripeLink.stripe_checkout_url || null;
      if (!checkoutUrl) {
        paymentLinkSend = buildOpenDemoPaymentLinkSendBlockedResponse(['missing_stripe_checkout_url']);
      } else {
        const sendGate = evaluateOpenDemoWhatsAppLiveReplyGate(rawBody, env);
        if (!sendGate.ok) {
          paymentLinkSend = {
            send_payment_link_whatsapp_confirmed: true,
            ...buildOpenDemoPaymentLinkSendBlockedResponse([], sendGate),
          };
        } else {
          const sendBody = buildOpenDemoPaymentLinkSendBody(inboundBody, checkoutUrl);
          const evaluated = await evaluateGuestReplySendRouteWithPause(sendBody, { pg, env });
          const sendResult = evaluated.result || {};
          const sent = sendResult.send_performed === true && sendResult.sends_whatsapp === true;
          paymentLinkSend = {
            send_payment_link_whatsapp_confirmed: true,
            payment_link_send_attempted: true,
            payment_link_sent: sent,
            sends_whatsapp: sent,
            whatsapp_sent: sent,
            live_send_blocked: !sent,
            payment_link_send_gate_blocked: !sent,
            payment_link_send_gate_code: sent ? null : ((sendResult.blocked_reasons || [])[0] || 'send_blocked'),
            payment_link_send_error: sent ? null : (sendResult.provider_error || null),
            reused_send_path: 'evaluateGuestReplySendRouteWithPause',
            guest_message_send_id: sendResult.guest_message_send_id || null,
            guest_message_send_status: sendResult.guest_message_send_status || null,
            whatsapp_message_id: sendResult.whatsapp_message_id || null,
            idempotency_key: sendBody.idempotency_key,
            confirmation_sent: false,
          };
        }
      }
    }
  }

  if (deferPaymentChoiceReviewReply && sendLiveReplyConfirmed) {
    const composed = composeLunaGuestReply({
      payload: reviewForFlags,
      mode: 'live_staging',
      live_outcomes: {
        bookingWrite,
        bedAssignment,
        stripeLink,
        paymentLinkSend,
      },
    });
    const bridgeReply = composed && composed.covered ? composed.reply : null;
    if (bridgeReply) {
      proposedReplyForSend = bridgeReply;
      liveReply = await sendOpenDemoLiveReplyMessage(
        pg,
        inboundBody,
        rawBody,
        env,
        bridgeReply,
      );
    }
  }

  if (pg && conversationId && proposedReplyForSend && liveReply && liveReply.send_performed === true) {
    try {
      threadOutbound = await persistOpenDemoLiveReplyThreadMessage(pg, {
        client_slug: inboundBody.client_slug,
        conversation_id: conversationId,
        message_text: proposedReplyForSend,
        idempotency_key: liveReply.idempotency_key || null,
      }, liveReply.send_result || liveReply);
    } catch (_) {
      threadOutbound = { ok: false, persisted: false, reason: 'persist_error' };
    }
  }

  return {
    reviewOutcome,
    liveReply,
    bookingWrite,
    bedAssignment,
    stripeLink,
    paymentLinkSend,
    threadInbound,
    threadOutbound,
    effectiveFlags: {
      send_live_reply_confirmed: sendLiveReplyConfirmed,
      create_demo_hold_draft_confirmed: createHoldDraftConfirmed,
      assign_demo_bed_confirmed: assignDemoBedConfirmed,
      create_stripe_test_link_confirmed: createStripeTestLinkConfirmed,
      send_payment_link_whatsapp_confirmed: sendPaymentLinkWhatsAppConfirmed,
    },
  };
}

module.exports = {
  executeOpenDemoWhatsAppInbound,
  sendOpenDemoLiveReplyMessage,
};
