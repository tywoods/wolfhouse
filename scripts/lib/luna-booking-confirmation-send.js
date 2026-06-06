'use strict';

/**
 * Phase 20j — Gated booking confirmation send (preview + WhatsApp + confirmation_sent_at).
 *
 * Loads Cami confirmation preview, delegates to guest-reply-send idempotency path,
 * sets bookings.confirmation_sent_at only after provider success.
 */

const { getLunaBookingConfirmationPreview } = require('./luna-booking-confirmation-preview');
const { evaluateGuestReplySendRouteWithPause } = require('./luna-guest-reply-send-route');

const DEFAULT_CLIENT = 'wolfhouse-somo';

const SEND_SAFETY_BASE = Object.freeze({
  creates_booking:     false,
  creates_payment:     false,
  creates_stripe_link: false,
  calls_n8n:           false,
});

const CONFIRMATION_SENT_AUDIT_SQL = `
UPDATE bookings b
   SET confirmation_sent_at = NOW(),
       metadata = COALESCE(b.metadata, '{}'::jsonb) || $1::jsonb
  FROM clients c
 WHERE b.client_id = c.id
   AND c.slug = $2
   AND b.id = $3::uuid
   AND b.confirmation_sent_at IS NULL
 RETURNING b.confirmation_sent_at::text AS confirmation_sent_at`;

const BOOKING_SENT_AT_SQL = `
SELECT b.confirmation_sent_at::text AS confirmation_sent_at
  FROM bookings b
 INNER JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1
   AND b.id = $2::uuid
 LIMIT 1`;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function buildConfirmationSendAudit(fields) {
  const audit = { confirmation_sent_via: 'whatsapp' };
  if (fields.guest_message_send_id) audit.confirmation_send_id = fields.guest_message_send_id;
  if (fields.provider_message_id) audit.confirmation_provider_message_id = fields.provider_message_id;
  return audit;
}

/**
 * @param {object} pg
 * @param {object} fields — client_slug, booking_id, guest_message_send_id, provider_message_id
 */
async function markBookingConfirmationSent(pg, fields) {
  const audit = buildConfirmationSendAudit(fields);
  const r = await pg.query(CONFIRMATION_SENT_AUDIT_SQL, [
    JSON.stringify(audit),
    fields.client_slug,
    fields.booking_id,
  ]);

  if (r.rows.length) {
    return {
      updated: true,
      already_sent: false,
      confirmation_sent_at: r.rows[0].confirmation_sent_at,
      audit,
    };
  }

  const existing = await pg.query(BOOKING_SENT_AT_SQL, [fields.client_slug, fields.booking_id]);
  const sentAt = existing.rows[0] && existing.rows[0].confirmation_sent_at;
  return {
    updated: false,
    already_sent: !!sentAt,
    confirmation_sent_at: sentAt || null,
    audit,
  };
}

/**
 * @param {object} input — client_slug, booking_id|booking_code, to, idempotency_key, confirm_send
 * @param {{ pg: object, env?: object, getLunaBookingConfirmationPreview?: Function, evaluateGuestReplySendRouteWithPause?: Function, sendMessage?: Function, fetch?: Function, loadClientConfirmationConfig?: Function }} context
 */
async function sendLunaBookingConfirmation(input, context = {}) {
  const src = input || {};
  const clientSlug = trimStr(src.client_slug) || DEFAULT_CLIENT;
  const bookingId = trimStr(src.booking_id) || null;
  const bookingCode = trimStr(src.booking_code) || null;
  const to = trimStr(src.to);
  const idempotencyKey = trimStr(src.idempotency_key);
  const confirmSend = src.confirm_send === true;
  const pg = context.pg;
  const env = context.env || process.env;
  const loadPreview = context.getLunaBookingConfirmationPreview || getLunaBookingConfirmationPreview;
  const evaluateSend = context.evaluateGuestReplySendRouteWithPause || evaluateGuestReplySendRouteWithPause;

  const baseFail = {
    success: false,
    client_slug: clientSlug,
    booking_id: bookingId,
    booking_code: bookingCode,
    idempotency_key: idempotencyKey || null,
    to: to || null,
    ...SEND_SAFETY_BASE,
    sends_whatsapp: false,
    send_performed: false,
    updates_confirmation_sent_at: false,
  };

  if (!confirmSend) {
    return {
      ok: false,
      status: 400,
      result: {
        ...baseFail,
        error: 'confirm_send_required',
        blocked_reasons: ['confirm_send_required'],
      },
    };
  }

  if (!idempotencyKey) {
    return {
      ok: false,
      status: 400,
      result: {
        ...baseFail,
        error: 'idempotency_key_required',
        blocked_reasons: ['idempotency_key_required'],
      },
    };
  }

  if (!to) {
    return {
      ok: false,
      status: 400,
      result: {
        ...baseFail,
        error: 'to_required',
        blocked_reasons: ['to_required'],
      },
    };
  }

  if (!bookingId && !bookingCode) {
    return {
      ok: false,
      status: 400,
      result: {
        ...baseFail,
        error: 'booking_id_required',
        blocked_reasons: ['missing_booking_identifier'],
      },
    };
  }

  if (!pg || typeof pg.query !== 'function') {
    return {
      ok: false,
      status: 500,
      result: { ...baseFail, error: 'pg client required' },
    };
  }

  const preview = await loadPreview(
    { client_slug: clientSlug, booking_id: bookingId, booking_code: bookingCode },
    {
      pg,
      loadClientConfirmationConfig: context.loadClientConfirmationConfig,
    },
  );

  const resultBase = {
    ...baseFail,
    client_slug: clientSlug,
    booking_id: preview.booking_id || bookingId,
    booking_code: preview.booking_code || bookingCode,
    idempotency_key: idempotencyKey,
    to,
    confirmation_sent_at: preview.confirmation_sent_at || null,
    template_source: preview.template_source || null,
    balance_payment_link_status: preview.balance_payment_link_status || null,
    confirm_send: true,
  };

  if (preview.confirmation_sent_at) {
    return {
      ok: true,
      status: 200,
      result: {
        ...resultBase,
        success: true,
        idempotent: true,
        idempotent_replay: true,
        confirmation_already_sent: true,
        duplicate: true,
        blocked_reasons: [],
        message_preview: preview.message_preview || null,
        send_skipped_reason: 'confirmation_sent_at_already_set',
      },
    };
  }

  if (preview.success !== true || !preview.message_preview) {
    return {
      ok: true,
      status: preview.error === 'booking_not_found' ? 404 : 400,
      result: {
        ...resultBase,
        error: preview.error || 'confirmation_preview_unavailable',
        blocked_reasons: preview.blocked_reasons || ['confirmation_preview_unavailable'],
        message_preview: preview.message_preview || null,
      },
    };
  }

  const sendBody = {
    client_slug: clientSlug,
    to,
    send_kind: 'confirmation',
    idempotency_key: idempotencyKey,
    suggested_reply: preview.message_preview,
    source: 'booking_confirmation_preview',
    send_eligibility: {
      send_allowed_later: true,
      requires_staff: false,
      auto_send_ready: true,
    },
  };

  const evaluated = await evaluateSend(sendBody, {
    pg,
    env,
    sendMessage: context.sendMessage,
    fetch: context.fetch,
  });
  const sendResult = evaluated.result || {};

  const out = {
    ...resultBase,
    success: sendResult.success === true,
    send_performed: sendResult.send_performed === true,
    sends_whatsapp: sendResult.sends_whatsapp === true,
    would_send_whatsapp: sendResult.would_send_whatsapp === true,
    duplicate: sendResult.duplicate === true,
    idempotent_replay: sendResult.idempotent_replay === true,
    whatsapp_message_id: sendResult.whatsapp_message_id || null,
    blocked_reasons: sendResult.blocked_reasons || [],
    guest_message_send_id: sendResult.guest_message_send_id || null,
    guest_message_send_status: sendResult.guest_message_send_status || null,
    send_kind: 'confirmation',
    message_preview: preview.message_preview,
    confirmation_preview: {
      template_source: preview.template_source,
      balance_payment_link_status: preview.balance_payment_link_status,
    },
    updates_confirmation_sent_at: false,
  };

  if (sendResult.success !== true || sendResult.send_performed !== true) {
    return { ok: true, status: evaluated.status || 200, result: out };
  }

  const marked = await markBookingConfirmationSent(pg, {
    client_slug: clientSlug,
    booking_id: out.booking_id,
    guest_message_send_id: sendResult.guest_message_send_id || null,
    provider_message_id: sendResult.whatsapp_message_id || null,
  });

  out.updates_confirmation_sent_at = marked.updated === true;
  out.confirmation_sent_at = marked.confirmation_sent_at || out.confirmation_sent_at;
  out.confirmation_send_audit = marked.audit;

  if (marked.already_sent) {
    out.idempotent = true;
    out.idempotent_replay = true;
    out.confirmation_already_sent = true;
    out.duplicate = true;
  }

  return { ok: true, status: 200, result: out };
}

module.exports = {
  sendLunaBookingConfirmation,
  markBookingConfirmationSent,
  buildConfirmationSendAudit,
  CONFIRMATION_SENT_AUDIT_SQL,
  BOOKING_SENT_AT_SQL,
};
