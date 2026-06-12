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
const {
  evaluateOpenDemoWhatsAppLiveReplyGate,
  validateOpenDemoInboundBody,
  wantsSendLiveReplyConfirmed,
  wantsCreateDemoHoldDraftConfirmed,
  wantsAssignDemoBedConfirmed,
  wantsCreateStripeTestLinkConfirmed,
  wantsSendPaymentLinkWhatsAppConfirmed,
  buildOpenDemoPaymentLinkSendBody,
  buildOpenDemoPaymentLinkSendBlockedResponse,
  buildOpenDemoLiveReplySendBody,
  buildOpenDemoLiveReplyBlockedResponse,
  shouldDeferOpenDemoPaymentChoiceReviewReply,
} = require('./open-demo-whatsapp-gate');
const { composeLunaGuestReply } = require('./luna-guest-reply-composer');
const { applyGuestReplyPipeline } = require('./luna-guest-reply-pipeline');
const { runGuestWritePipeline } = require('./luna-guest-write-pipeline');
const { sendLunaWhatsAppTypingIndicator } = require('./luna-whatsapp-provider');
const {
  tryAutoSendBookingConfirmation,
  isAutoConfirmationSendEnabled,
} = require('./luna-guest-confirmation-auto-send');
const {
  mergeLiveStagingGuestContext,
  persistConversationGuestContext,
} = require('./luna-guest-live-context-persist');
const {
  detectBalancePaymentLinkRequest,
  runGuestBalancePaymentLinkCreateApproved,
} = require('./luna-guest-balance-payment-link-create');
const {
  isGenuineLunaHandoffReply,
  markConversationNeedsHuman,
} = require('./luna-guest-handoff-persist');

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

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

  let typingIndicator = null;
  const inboundWamid = inboundBody.inbound_message_id || rawBody.wamid || rawBody.inbound_message_id;
  const willAttemptLiveReply = wantsSendLiveReplyConfirmed(rawBody)
    || evaluateOpenDemoWhatsAppLiveReplyGate(rawBody, env).ok;
  if (willAttemptLiveReply && inboundWamid) {
    typingIndicator = await sendLunaWhatsAppTypingIndicator({
      message_id: inboundWamid,
      phone_number_id: inboundBody.phone_number_id || rawBody.phone_number_id,
    }, env);
  }

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
        open_phone_testing: reviewOutcome.body && reviewOutcome.body.open_phone_testing === true,
        guest_tester_class: reviewOutcome.body && reviewOutcome.body.guest_tester_class
          ? String(reviewOutcome.body.guest_tester_class)
          : (inboundBody.automation_gate_context
            && inboundBody.automation_gate_context.guest_tester_class),
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
  let balanceStripeLink = null;
  let paymentLinkSend = null;
  let serviceAttach = null;
  let serviceStripeLink = null;
  let transferTimesUpdate = null;
  let serviceSchedule = null;
  let lunaNotes = null;
  let confirmationSend = null;
  let threadOutbound = null;
  let handoffPersist = null;

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

  const slimCtx = reviewOutcome.body && reviewOutcome.body.slim_guest_context_for_next_turn;
  const chainCtx = reviewForFlags.guest_context_chain || slimCtx || {};
  const contextBookingId = trimStr(
    chainCtx.booking_id
    || (chainCtx.payment_truth && chainCtx.payment_truth.booking_id)
    || (reviewForFlags.result && reviewForFlags.result.booking_id)
    || (inboundBody.guest_context && inboundBody.guest_context.booking_id)
    || (rawBody.guest_context && rawBody.guest_context.booking_id),
  ) || null;

  const writePipelineFlags = {
    createHoldDraft: createHoldDraftConfirmed,
    assignBed: assignDemoBedConfirmed,
    createStripeLink: createStripeTestLinkConfirmed,
  };
  const needsHoldWritePipeline = createHoldDraftConfirmed
    || assignDemoBedConfirmed
    || createStripeTestLinkConfirmed;
  const needsPostBookingPipeline = pg && contextBookingId;

  if (needsHoldWritePipeline || needsPostBookingPipeline) {
    const writeOut = await runGuestWritePipeline({
      review: reviewForFlags,
      inboundBody,
      rawBody,
      env,
      pg,
      hostHeader,
      actorId,
      flags: writePipelineFlags,
    });
    if (needsHoldWritePipeline) {
      bookingWrite = writeOut.bookingWrite;
      bedAssignment = writeOut.bedAssignment;
      stripeLink = writeOut.stripeLink;
      balanceStripeLink = writeOut.balanceStripeLink || balanceStripeLink;
      serviceAttach = writeOut.serviceAttach;
      serviceStripeLink = writeOut.serviceStripeLink;
    } else {
      serviceAttach = writeOut.serviceAttach;
      serviceStripeLink = writeOut.serviceStripeLink;
    }
    transferTimesUpdate = writeOut.transferTimesUpdate;
    serviceSchedule = writeOut.serviceSchedule;
    lunaNotes = writeOut.lunaNotes;
  }
  if (pg && contextBookingId && detectBalancePaymentLinkRequest(inboundBody.message_text)) {
    balanceStripeLink = await runGuestBalancePaymentLinkCreateApproved({
      booking_id: contextBookingId,
      client_slug: inboundBody.client_slug,
      inbound_message_id: inboundBody.inbound_message_id,
    }, {
      confirm_balance_payment_link: true,
      env,
      pg,
      host_header: hostHeader,
    });
  }

  if (balanceStripeLink && balanceStripeLink.stripe_checkout_url) {
    const liveGate = evaluateOpenDemoWhatsAppLiveReplyGate(rawBody, env);
    const payUrl = balanceStripeLink.guest_payment_url || balanceStripeLink.stripe_checkout_url;
    if (!liveGate.ok) {
      paymentLinkSend = {
        ...buildOpenDemoPaymentLinkSendBlockedResponse([], liveGate),
        balance_payment_link: true,
      };
    } else {
      const sendBody = buildOpenDemoPaymentLinkSendBody(inboundBody, payUrl, {
        kind: 'balance',
        amount_due_cents: balanceStripeLink.balance_due_cents,
      });
      const evaluated = await evaluateGuestReplySendRouteWithPause(sendBody, { pg, env });
      const sendResult = evaluated.result || {};
      const sent = sendResult.send_performed === true && sendResult.sends_whatsapp === true;
      paymentLinkSend = {
        send_payment_link_whatsapp_confirmed: true,
        payment_link_send_attempted: true,
        payment_link_sent: sent,
        balance_payment_link: true,
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
      if (sent) {
        sendLiveReplyConfirmed = false;
        liveReply = {
          send_live_reply_confirmed: false,
          live_reply_attempted: false,
          live_send_blocked: true,
          sends_whatsapp: false,
          whatsapp_sent: false,
          send_performed: false,
          skipped_for_payment_link_send: true,
        };
      }
    }
  } else if (sendPaymentLinkWhatsAppConfirmed) {
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

  const balanceLinkWhatsAppSent = !!(paymentLinkSend
    && paymentLinkSend.balance_payment_link === true
    && paymentLinkSend.payment_link_sent === true);
  const isBalanceLinkRequest = detectBalancePaymentLinkRequest(inboundBody.message_text);

  if (isBalanceLinkRequest && !balanceLinkWhatsAppSent) {
    const priorGuestContext = reviewOutcome.body.slim_guest_context_for_next_turn
      || inboundBody.guest_context
      || null;
    const composed = composeLunaGuestReply({
      payload: reviewForFlags,
      message_text: inboundBody.message_text,
      prior_guest_context: priorGuestContext,
      client_slug: inboundBody.client_slug,
      guest_phone: inboundBody.guest_phone,
      conversation_id: conversationId,
      mode: 'live_staging',
      live_outcomes: {
        bookingWrite,
        bedAssignment,
        stripeLink,
        balanceStripeLink,
        paymentLinkSend,
        serviceAttach,
        serviceStripeLink,
        transferTimesUpdate,
        serviceSchedule,
        lunaNotes,
      },
      env,
    });
    if (composed && composed.covered && composed.reply) {
      proposedReplyForSend = composed.reply;
    }
  }

  if (sendLiveReplyConfirmed && !deferPaymentChoiceReviewReply && !balanceLinkWhatsAppSent) {
    liveReply = await sendOpenDemoLiveReplyMessage(
      pg,
      inboundBody,
      rawBody,
      env,
      proposedReplyForSend,
    );
  }

  if (deferPaymentChoiceReviewReply && sendLiveReplyConfirmed && !balanceLinkWhatsAppSent) {
    const priorGuestContext = reviewOutcome.body.slim_guest_context_for_next_turn
      || inboundBody.guest_context
      || null;
    const composed = composeLunaGuestReply({
      payload: reviewForFlags,
      message_text: inboundBody.message_text,
      prior_guest_context: priorGuestContext,
      client_slug: inboundBody.client_slug,
      guest_phone: inboundBody.guest_phone,
      conversation_id: conversationId,
      mode: 'live_staging',
      live_outcomes: {
        bookingWrite,
        bedAssignment,
        stripeLink,
        balanceStripeLink,
        paymentLinkSend,
        serviceAttach,
        serviceStripeLink,
        transferTimesUpdate,
        serviceSchedule,
        lunaNotes,
      },
      env,
    });
    const bridgeReply = composed && composed.covered ? composed.reply : null;
    if (bridgeReply) {
      const piped = await applyGuestReplyPipeline({
        client_slug: inboundBody.client_slug,
        conversation_id: conversationId,
        guest_phone: inboundBody.guest_phone,
        message_text: inboundBody.message_text,
        prior_guest_context: priorGuestContext,
        composed: {
          ...composed,
          cami_author_required: composed.cami_author_required !== false,
        },
        candidate_reply: bridgeReply,
        candidate_source: composed.reply_source || 'luna_reply_composer',
        allowed_next_action: reviewForFlags.proposed_next_action,
        payload: reviewForFlags,
        channel_mode: 'open_demo_whatsapp',
        env,
      });
      proposedReplyForSend = piped.reply || bridgeReply;
      liveReply = await sendOpenDemoLiveReplyMessage(
        pg,
        inboundBody,
        rawBody,
        env,
        proposedReplyForSend,
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

  const handoffIntent = reviewForFlags.proposed_next_action === 'staff_handoff_required'
    || (reviewForFlags.result && reviewForFlags.result.safe_handoff_required === true);
  const handoffReplySent = liveReply && liveReply.send_performed === true
    && (isGenuineLunaHandoffReply(proposedReplyForSend) || handoffIntent);
  if (pg && conversationId && handoffReplySent) {
    try {
      handoffPersist = await markConversationNeedsHuman(pg, {
        conversation_id: conversationId,
        client_slug: inboundBody.client_slug,
        handoff_reasons: reviewForFlags.result && reviewForFlags.result.handoff_reasons,
      });
    } catch (_) {
      handoffPersist = { ok: false, needs_human: false, reason: 'persist_error' };
    }
  }

  const bookingCodeForConfirm = (bookingWrite && bookingWrite.booking_code)
    || (reviewOutcome.body && reviewOutcome.body.slim_guest_context_for_next_turn
      && reviewOutcome.body.slim_guest_context_for_next_turn.booking_code);
  const skipAutoConfirmThisTurn = deferPaymentChoiceReviewReply
    || createHoldDraftConfirmed
    || createStripeTestLinkConfirmed
    || (stripeLink && stripeLink.stripe_link_created === true);
  if (pg && isAutoConfirmationSendEnabled(env) && bookingCodeForConfirm && !skipAutoConfirmThisTurn) {
    try {
      confirmationSend = await tryAutoSendBookingConfirmation({
        booking_code: bookingCodeForConfirm,
        booking_id: bookingWrite && bookingWrite.booking_id,
        to: inboundBody.guest_phone,
        client_slug: inboundBody.client_slug,
        guest_name: inboundBody.contact_name,
        language_hint: reviewForFlags.detected_language || 'en',
        idempotency_key: `confirmation:auto:inbound:${inboundBody.idempotency_key || inboundBody.inbound_message_id}`,
      }, { pg, env });
    } catch (_) {
      confirmationSend = { attempted: true, skipped: true, skip_reason: 'auto_send_error' };
    }
  }

  if (pg && conversationId && reviewOutcome.body) {
    try {
      const priorSlim = reviewOutcome.body.slim_guest_context_for_next_turn || {};
      const enriched = mergeLiveStagingGuestContext(priorSlim, {
        bookingWrite,
        stripeLink,
        balanceStripeLink,
        paymentLinkSend,
        confirmationSend,
        proposedReply: proposedReplyForSend,
      });
      await persistConversationGuestContext(pg, conversationId, enriched);
      reviewOutcome.body.slim_guest_context_for_next_turn = enriched;
    } catch (_) {
      /* non-fatal */
    }
  }

  return {
    reviewOutcome,
    typingIndicator,
    liveReply,
    bookingWrite,
    bedAssignment,
    stripeLink,
    balanceStripeLink,
    paymentLinkSend,
    serviceAttach,
    serviceStripeLink,
    transferTimesUpdate,
    serviceSchedule,
    lunaNotes,
    confirmationSend,
    threadInbound,
    threadOutbound,
    handoffPersist,
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
