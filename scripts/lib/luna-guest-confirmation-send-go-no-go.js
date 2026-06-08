'use strict';

/**
 * Stage 27r — Confirmation send go/no-go after Stage 27q preview.
 *
 * Reuses sendLunaBookingConfirmation (Phase 20j) with injected 27q preview —
 * no message regeneration.
 *
 * No automatic send · explicit confirm_send required · respects WHATSAPP_DRY_RUN.
 * Stage 27s: live send requires LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST match when dry-run off.
 */

const { sendLunaBookingConfirmation } = require('./luna-booking-confirmation-send');
const { messageHasBedLeak } = require('./luna-guest-confirmation-preview-dry-run');
const {
  evaluateConfirmationLiveSendAllowlist,
  isConfirmationLiveSendRecipientAllowlisted,
  parseConfirmationLiveSendAllowlist,
  ALLOWLIST_ENV_KEY,
} = require('./luna-guest-confirmation-live-send-allowlist');

const REUSED_SEND_PATH = 'sendLunaBookingConfirmation (Phase 20j)';

const STAFF_REVIEW_REASONS = new Set([
  'missing_room_number_or_label',
  'missing_gate_code',
  'missing_address',
  'message_preview_bed_leak',
  'hold_expiry_mention_blocked',
  'full_paid_should_not_ask_balance',
  'confirmation_preview_unavailable',
]);

const SEND_SAFETY = Object.freeze({
  creates_booking: false,
  creates_payment: false,
  creates_stripe_link: false,
  calls_n8n: false,
  payment_truth_mutated: false,
});

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function readEnv(env) {
  return env || process.env;
}

function isWhatsappDryRun(env) {
  return String(readEnv(env).WHATSAPP_DRY_RUN ?? 'true').trim().toLowerCase() !== 'false';
}

function buildPreviewLoaderFrom27q(previewResult) {
  const preview = previewResult || {};
  const message = trimStr(preview.proposed_confirmation_message || preview.message_preview);
  return async function loadInjected27qPreview() {
    return {
      success: preview.confirmation_preview_ready === true && !!message,
      message_preview: message,
      booking_id: preview.booking_id || null,
      booking_code: preview.booking_code || null,
      confirmation_sent_at: preview.confirmation_sent_at || null,
      template_source: preview.template_source || 'luna_guest_stage27q_injected',
      balance_payment_link_status: preview.balance_payment_link_status || null,
      blocked_reasons: preview.block_reasons || [],
      payment_status: preview.payment_status || null,
      preview_source: 'luna_guest_stage27q',
    };
  };
}

function classifyPreviewBlock(preview) {
  if (!preview || typeof preview !== 'object') {
    return { send_status: 'not_ready', block_reasons: ['missing_preview_result'] };
  }

  if (preview.confirmation_preview_ready === true) {
    return null;
  }

  const reasons = [...(preview.block_reasons || [])];
  if (preview.next_safe_step === 'staff_review_confirmation') {
    reasons.push('staff_review_required');
  }

  const needsStaffReview = reasons.some((r) => STAFF_REVIEW_REASONS.has(r))
    || preview.next_safe_step === 'staff_review_confirmation';

  if (needsStaffReview) {
    return { send_status: 'staff_review_required', block_reasons: reasons };
  }

  return { send_status: 'not_ready', block_reasons: reasons.length ? reasons : ['preview_not_ready'] };
}

function buildBlockedSendResponse(partial) {
  return {
    success: false,
    ...SEND_SAFETY,
    send_attempted: false,
    sends_whatsapp: false,
    live_send_blocked: true,
    confirmation_sent: false,
    reused_send_path: REUSED_SEND_PATH,
    message_source: 'luna_guest_stage27q',
    ...partial,
  };
}

function normalizeSendStatus(sendResult, env) {
  const reasons = sendResult.blocked_reasons || [];
  if (sendResult.send_performed === true && sendResult.sends_whatsapp === true) {
    return 'sent';
  }
  if (reasons.includes('whatsapp_dry_run_active') || sendResult.dry_run === true) {
    return 'blocked_dry_run';
  }
  if (reasons.includes('recipient_not_allowlisted')) {
    return 'recipient_not_allowlisted';
  }
  if (sendResult.error) return 'send_error';
  if (reasons.length) return 'send_gate_blocked';
  return 'send_error';
}

function resolveNextSafeStep(sendStatus, previewReady) {
  if (sendStatus === 'sent') return 'confirmation_sent';
  if (sendStatus === 'blocked_dry_run') return 'confirmation_send_audit_only';
  if (sendStatus === 'recipient_not_allowlisted') return 'awaiting_confirmation_send_go_no_go';
  if (sendStatus === 'not_approved') return 'awaiting_confirmation_send_go_no_go';
  if (sendStatus === 'staff_review_required') return 'staff_review_confirmation';
  if (sendStatus === 'not_ready') return previewReady ? 'awaiting_confirmation_send_go_no_go' : 'staff_review_confirmation';
  return 'awaiting_confirmation_send_go_no_go';
}

/**
 * Stage 27r — explicit confirmation send go/no-go.
 *
 * @param {{ confirmation_preview_result: object, confirm_send?: boolean, to?: string, idempotency_key?: string, client_slug?: string, booking_id?: string, booking_code?: string }} input
 * @param {{ pg?: object, env?: object, sendLunaBookingConfirmation?: Function }} context
 */
async function runGuestConfirmationSendGoNoGo(input, context) {
  const ctx = context || {};
  const src = input || {};
  const env = readEnv(ctx.env);
  const preview = src.confirmation_preview_result;
  const confirmSend = src.confirm_send === true;
  const dryRun = isWhatsappDryRun(env);

  const baseOut = {
    booking_id: preview && preview.booking_id ? preview.booking_id : trimStr(src.booking_id) || null,
    booking_code: preview && preview.booking_code ? preview.booking_code : trimStr(src.booking_code) || null,
    payment_status: preview && preview.payment_status ? preview.payment_status : null,
    proposed_confirmation_message: preview && preview.proposed_confirmation_message
      ? preview.proposed_confirmation_message
      : null,
    reused_send_path: REUSED_SEND_PATH,
    message_source: 'luna_guest_stage27q',
    preview_regenerated: false,
  };

  if (!confirmSend) {
    return buildBlockedSendResponse({
      ...baseOut,
      send_status: 'not_approved',
      next_safe_step: 'awaiting_confirmation_send_go_no_go',
      block_reasons: ['confirm_send_required'],
      staff_notice: 'Confirmation send not approved — pass confirm_send:true explicitly.',
    });
  }

  const previewBlock = classifyPreviewBlock(preview);
  if (previewBlock) {
    return buildBlockedSendResponse({
      ...baseOut,
      send_status: previewBlock.send_status,
      next_safe_step: previewBlock.send_status === 'staff_review_required'
        ? 'staff_review_confirmation'
        : 'staff_review_confirmation',
      block_reasons: previewBlock.block_reasons,
      handoff_reasons: previewBlock.block_reasons,
      staff_notice: 'Confirmation preview not send-ready — staff review required.',
    });
  }

  const message = trimStr(preview.proposed_confirmation_message);
  if (!message) {
    return buildBlockedSendResponse({
      ...baseOut,
      send_status: 'not_ready',
      next_safe_step: 'staff_review_confirmation',
      block_reasons: ['missing_proposed_confirmation_message'],
    });
  }

  if (messageHasBedLeak(message)) {
    return buildBlockedSendResponse({
      ...baseOut,
      send_status: 'staff_review_required',
      next_safe_step: 'staff_review_confirmation',
      block_reasons: ['message_preview_bed_leak'],
    });
  }

  if (preview.confirmation_send_allowed === true) {
    return buildBlockedSendResponse({
      ...baseOut,
      send_status: 'staff_review_required',
      next_safe_step: 'staff_review_confirmation',
      block_reasons: ['confirmation_send_not_allowed_by_preview'],
    });
  }

  const to = trimStr(src.to);
  const idempotencyKey = trimStr(src.idempotency_key);
  const clientSlug = trimStr(src.client_slug) || 'wolfhouse-somo';
  const bookingId = trimStr(src.booking_id) || trimStr(preview.booking_id) || null;
  const bookingCode = trimStr(src.booking_code) || trimStr(preview.booking_code) || null;

  if (!to || !idempotencyKey) {
    return buildBlockedSendResponse({
      ...baseOut,
      send_attempted: true,
      send_status: 'send_error',
      next_safe_step: 'awaiting_confirmation_send_go_no_go',
      block_reasons: [
        ...(to ? [] : ['to_required']),
        ...(idempotencyKey ? [] : ['idempotency_key_required']),
      ],
      staff_notice: 'Send channel context incomplete — to and idempotency_key required.',
    });
  }

  if (!dryRun) {
    const allowEval = evaluateConfirmationLiveSendAllowlist(to, env);
    if (!allowEval.allowed) {
      const notListed = allowEval.reasons.includes('recipient_not_allowlisted');
      return buildBlockedSendResponse({
        ...baseOut,
        send_attempted: true,
        send_status: notListed ? 'recipient_not_allowlisted' : 'send_gate_blocked',
        next_safe_step: 'awaiting_confirmation_send_go_no_go',
        block_reasons: allowEval.reasons,
        live_send_allowlist: allowEval.allowlist,
        recipient_normalized: allowEval.normalized_to,
        whatsapp_dry_run: false,
        staff_notice: notListed
          ? 'Live confirmation send blocked — recipient not on staging allowlist.'
          : 'Live confirmation send blocked — allowlist not configured for staging proof.',
      });
    }
  }

  const sendFn = ctx.sendLunaBookingConfirmation || sendLunaBookingConfirmation;
  const injectedPreview = buildPreviewLoaderFrom27q(preview);

  let evaluated;
  try {
    evaluated = await sendFn({
      client_slug: clientSlug,
      booking_id: bookingId,
      booking_code: bookingCode,
      to,
      idempotency_key: idempotencyKey,
      confirm_send: true,
    }, {
      pg: ctx.pg,
      env,
      getLunaBookingConfirmationPreview: injectedPreview,
      evaluateGuestReplySendRouteWithPause: ctx.evaluateGuestReplySendRouteWithPause,
      sendMessage: ctx.sendMessage,
      fetch: ctx.fetch,
      loadClientConfirmationConfig: ctx.loadClientConfirmationConfig,
    });
  } catch (err) {
    return {
      success: false,
      ...SEND_SAFETY,
      ...baseOut,
      send_attempted: true,
      send_status: 'send_error',
      sends_whatsapp: false,
      live_send_blocked: true,
      confirmation_sent: false,
      next_safe_step: 'awaiting_confirmation_send_go_no_go',
      block_reasons: [`send_error:${err.message}`],
      staff_notice: 'Confirmation send path error — no live guest automation triggered.',
    };
  }

  const sendResult = (evaluated && evaluated.result) || {};
  const sendStatus = normalizeSendStatus(sendResult, env);
  const sendsWhatsapp = sendResult.sends_whatsapp === true;
  const liveSendBlocked = dryRun || !sendsWhatsapp;
  const recipientAllowlisted = dryRun ? null : isConfirmationLiveSendRecipientAllowlisted(to, env);

  return {
    success: sendStatus === 'sent' || sendStatus === 'blocked_dry_run',
    ...SEND_SAFETY,
    ...baseOut,
    send_attempted: true,
    send_status: sendStatus,
    sends_whatsapp: sendsWhatsapp,
    live_send_blocked: liveSendBlocked,
    whatsapp_dry_run: dryRun,
    live_send_allowlist_checked: !dryRun,
    recipient_allowlisted: recipientAllowlisted,
    live_send_allowlist: dryRun ? null : parseConfirmationLiveSendAllowlist(env),
    confirmation_sent: sendStatus === 'sent',
    send_performed: sendResult.send_performed === true,
    would_send_whatsapp: sendResult.would_send_whatsapp === true,
    guest_message_send_id: sendResult.guest_message_send_id || null,
    guest_message_send_status: sendResult.guest_message_send_status || null,
    whatsapp_message_id: sendResult.whatsapp_message_id || null,
    updates_confirmation_sent_at: sendResult.updates_confirmation_sent_at === true,
    blocked_reasons: sendResult.blocked_reasons || [],
    next_safe_step: resolveNextSafeStep(sendStatus, true),
    message_sent: sendResult.message_preview || message,
    staff_notice: sendStatus === 'blocked_dry_run'
      ? 'Send gate exercised under WHATSAPP_DRY_RUN — audit only, no live WhatsApp.'
      : (sendStatus === 'sent'
        ? 'Confirmation sent via gated allowlisted path.'
        : (sendStatus === 'recipient_not_allowlisted'
          ? 'Live send blocked — recipient not on staging allowlist.'
          : 'Confirmation send blocked by gate — review blocked_reasons.')),
  };
}

/** Stage 27s alias — same path with live-send allowlist enforced when dry-run off. */
async function runGuestConfirmationLiveSendAllowlisted(input, context) {
  return runGuestConfirmationSendGoNoGo(input, context);
}

module.exports = {
  runGuestConfirmationSendGoNoGo,
  runGuestConfirmationLiveSendAllowlisted,
  buildPreviewLoaderFrom27q,
  classifyPreviewBlock,
  normalizeSendStatus,
  isWhatsappDryRun,
  REUSED_SEND_PATH,
  SEND_SAFETY,
  STAFF_REVIEW_REASONS,
  ALLOWLIST_ENV_KEY,
};
