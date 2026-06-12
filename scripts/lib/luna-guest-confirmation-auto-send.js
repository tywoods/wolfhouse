'use strict';

/**
 * Stage 54 — Auto-send booking confirmation WhatsApp after payment truth.
 * No per-phone allowlist — gated only by LUNA_AUTO_SEND_ENABLED + WHATSAPP_DRY_RUN.
 */

const { runGuestConfirmationPreviewDryRun } = require('./luna-guest-confirmation-preview-dry-run');
const { runGuestConfirmationSendGoNoGo, isWhatsappDryRun } = require('./luna-guest-confirmation-send-go-no-go');

const PAID_BOOKING_STATUSES = new Set(['deposit_paid', 'paid']);

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function isAutoConfirmationSendEnabled(env) {
  const e = env || process.env;
  return String(e.LUNA_AUTO_SEND_ENABLED || '').trim().toLowerCase() === 'true';
}

async function loadBookingSendState(pg, { bookingId, bookingCode }) {
  const id = trimStr(bookingId);
  const code = trimStr(bookingCode);
  if (!id && !code) return null;
  const q = id
    ? `SELECT id, booking_code, payment_status::text AS payment_status,
              confirmation_sent_at,
              metadata->'guest'->>'phone' AS guest_phone_meta,
              metadata->'guest'->>'name' AS guest_name_meta
         FROM bookings WHERE id = $1::uuid LIMIT 1`
    : `SELECT id, booking_code, payment_status::text AS payment_status,
              confirmation_sent_at,
              metadata->'guest'->>'phone' AS guest_phone_meta,
              metadata->'guest'->>'name' AS guest_name_meta
         FROM bookings WHERE booking_code = $1 LIMIT 1`;
  const r = await pg.query(q, [id || code]);
  return r.rows[0] || null;
}

/**
 * Attempt confirmation preview + live send when booking is paid and not yet confirmed.
 */
async function tryAutoSendBookingConfirmation(input, context) {
  const src = input || {};
  const ctx = context || {};
  const env = ctx.env || process.env;
  const pg = ctx.pg;

  const base = {
    attempted: false,
    skipped: true,
    skip_reason: null,
    preview: null,
    send: null,
    confirmation_sent: false,
  };

  if (!isAutoConfirmationSendEnabled(env)) {
    return { ...base, skip_reason: 'luna_auto_send_not_enabled' };
  }
  if (!pg) {
    return { ...base, skip_reason: 'missing_pg' };
  }

  const bookingId = trimStr(src.booking_id);
  const bookingCode = trimStr(src.booking_code);
  let to = trimStr(src.to);
  const clientSlug = trimStr(src.client_slug) || 'wolfhouse-somo';

  let row;
  try {
    row = await loadBookingSendState(pg, { bookingId, bookingCode });
  } catch (err) {
    return { ...base, skip_reason: `db_error:${String(err.message || err).slice(0, 80)}` };
  }

  if (!row) return { ...base, skip_reason: 'booking_not_found' };
  if (row.confirmation_sent_at) {
    return { ...base, skip_reason: 'confirmation_already_sent', booking_code: row.booking_code };
  }
  if (!PAID_BOOKING_STATUSES.has(trimStr(row.payment_status))) {
    return {
      ...base,
      skip_reason: 'booking_not_paid_yet',
      payment_status: row.payment_status,
      booking_code: row.booking_code,
    };
  }

  if (!to) to = trimStr(row.guest_phone_meta);
  if (!to) return { ...base, skip_reason: 'missing_guest_phone', booking_code: row.booking_code };

  const preview = await runGuestConfirmationPreviewDryRun({
    client_slug: clientSlug,
    booking_id: row.id,
    booking_code: row.booking_code,
    payment_status: row.payment_status,
    guest_name: trimStr(src.guest_name) || trimStr(row.guest_name_meta) || null,
    language_hint: trimStr(src.language_hint) || 'en',
  }, { pg, env });

  if (!preview || preview.confirmation_preview_ready !== true) {
    return {
      ...base,
      attempted: true,
      skip_reason: 'preview_not_ready',
      preview,
      booking_code: row.booking_code,
      block_reasons: preview && preview.block_reasons,
    };
  }

  const idempotencyKey = trimStr(src.idempotency_key)
    || `confirmation:auto:${row.booking_code}:${row.id}`;

  const send = await runGuestConfirmationSendGoNoGo({
    confirmation_preview_result: preview,
    confirm_send: true,
    to,
    idempotency_key: idempotencyKey,
    client_slug: clientSlug,
    booking_id: row.id,
    booking_code: row.booking_code,
  }, {
    pg,
    env,
    sendLunaBookingConfirmation: ctx.sendLunaBookingConfirmation,
    evaluateGuestReplySendRouteWithPause: ctx.evaluateGuestReplySendRouteWithPause,
    sendMessage: ctx.sendMessage,
    fetch: ctx.fetch,
    loadClientConfirmationConfig: ctx.loadClientConfirmationConfig,
  });

  const sent = send && (send.confirmation_sent === true || send.send_status === 'sent');
  return {
    attempted: true,
    skipped: !sent,
    skip_reason: sent ? null : (send && send.send_status) || 'send_blocked',
    preview,
    send,
    confirmation_sent: sent,
    booking_code: row.booking_code,
    whatsapp_dry_run: isWhatsappDryRun(env),
  };
}

module.exports = {
  PAID_BOOKING_STATUSES,
  isAutoConfirmationSendEnabled,
  tryAutoSendBookingConfirmation,
  loadBookingSendState,
};
