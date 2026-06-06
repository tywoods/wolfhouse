'use strict';

/**
 * Phase 22d — Persist booking-create-from-plan outcome on guest_message_events.normalized.
 */

const {
  isMissingGuestMessageEventsTable,
} = require('./luna-guest-message-events-sql');

const RESULT_SOURCE = 'booking_create_from_plan';

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * Parse luna-booking idempotency keys: luna-booking:<client>:<wa_message_id>:v1
 */
function parseLunaBookingIdempotencyKey(key) {
  const raw = trimStr(key);
  const m = raw.match(/^luna-booking:([^:]+):(.+):v\d+$/);
  if (!m) return null;
  return { client_slug: m[1], wa_message_id: m[2] };
}

/**
 * Resolve guest_message_events lookup from create-from-plan request body.
 *
 * @param {object} body
 * @returns {{ client_slug: string, wa_message_id?: string, guest_message_event_id?: string }|null}
 */
function resolveInboundEventRef(body) {
  const src = body || {};
  const clientSlug = trimStr(src.client_slug) || 'wolfhouse-somo';

  const sourceWa = trimStr(src.source_wa_message_id);
  if (sourceWa) return { client_slug: clientSlug, wa_message_id: sourceWa };

  const wa = trimStr(src.wa_message_id);
  if (wa) return { client_slug: clientSlug, wa_message_id: wa };

  const eventId = trimStr(src.guest_message_event_id);
  if (eventId) return { client_slug: clientSlug, guest_message_event_id: eventId };

  const parsed = parseLunaBookingIdempotencyKey(src.idempotency_key);
  if (parsed) {
    return { client_slug: parsed.client_slug || clientSlug, wa_message_id: parsed.wa_message_id };
  }

  return null;
}

/**
 * Build booking_write_result object from bridge outcome (write or idempotent replay).
 *
 * @param {object} body
 * @param {object} bridgeResult
 * @returns {object|null}
 */
function buildBookingWriteResult(body, bridgeResult) {
  const bridge = bridgeResult || {};
  if (bridge.success !== true) return null;

  const writePerformed = bridge.write_performed === true;
  const idempotentReplay = bridge.idempotent_replay === true
    || bridge.duplicate === true
    || bridge.idempotent === true;

  if (!writePerformed && !idempotentReplay) return null;

  const createResponse = bridge.create_outcome && bridge.create_outcome.create_response
    ? bridge.create_outcome.create_response
    : null;

  const bookingId = trimStr(bridge.booking_id)
    || (createResponse && trimStr(createResponse.booking_id));
  if (!bookingId) return null;

  const bookingCode = trimStr(bridge.booking_code)
    || (createResponse && trimStr(createResponse.booking_code))
    || null;
  const paymentId = trimStr(bridge.payment_id)
    || (createResponse && trimStr(createResponse.payment_id))
    || (bridge.payment_summary && trimStr(bridge.payment_summary.payment_id))
    || null;

  return {
    created: true,
    booking_id: bookingId,
    booking_code: bookingCode,
    payment_id: paymentId,
    idempotency_key: trimStr((body || {}).idempotency_key) || null,
    created_at: new Date().toISOString(),
    source: RESULT_SOURCE,
    idempotent_replay: idempotentReplay && !writePerformed,
    creates_stripe_link: false,
    sends_whatsapp: false,
  };
}

/**
 * Merge booking_write_result into guest_message_events.normalized (preserves other keys).
 *
 * @param {object} pg
 * @param {object} ref - from resolveInboundEventRef
 * @param {object} bookingWriteResult
 * @returns {Promise<object>}
 */
async function mergeBookingWriteResultIntoEvent(pg, ref, bookingWriteResult) {
  if (!pg || typeof pg.query !== 'function' || !ref || !bookingWriteResult) {
    return { persisted: false, reason: 'missing_input' };
  }

  const mergePatch = { booking_write_result: bookingWriteResult };
  const mergeJson = JSON.stringify(mergePatch);

  try {
    if (ref.guest_message_event_id) {
      const r = await pg.query(
        `UPDATE guest_message_events
            SET normalized = COALESCE(normalized, '{}'::jsonb) || $3::jsonb,
                updated_at = NOW()
          WHERE client_slug = $1
            AND id = $2::uuid
          RETURNING wa_message_id, normalized`,
        [ref.client_slug, ref.guest_message_event_id, mergeJson],
      );
      if (!r.rows.length) return { persisted: false, reason: 'event_not_found' };
      return {
        persisted: true,
        wa_message_id: r.rows[0].wa_message_id,
        booking_write_result: bookingWriteResult,
      };
    }

    if (!ref.wa_message_id) return { persisted: false, reason: 'no_wa_message_id' };

    const r = await pg.query(
      `UPDATE guest_message_events
          SET normalized = COALESCE(normalized, '{}'::jsonb) || $3::jsonb,
              updated_at = NOW()
        WHERE client_slug = $1
          AND wa_message_id = $2
        RETURNING wa_message_id, normalized`,
      [ref.client_slug, ref.wa_message_id, mergeJson],
    );
    if (!r.rows.length) return { persisted: false, reason: 'event_not_found' };
    return {
      persisted: true,
      wa_message_id: r.rows[0].wa_message_id,
      booking_write_result: bookingWriteResult,
    };
  } catch (err) {
    if (isMissingGuestMessageEventsTable(err)) {
      return { persisted: false, reason: 'table_missing' };
    }
    throw err;
  }
}

/**
 * Persist inbound booking write result when create-from-plan succeeds or idempotently replays.
 *
 * @param {object} pg
 * @param {object} body - original create-from-plan request
 * @param {object} bridgeResult - runLunaGuestBookingWriteBridge output
 * @returns {Promise<object>}
 */
async function persistInboundBookingWriteResult(pg, body, bridgeResult) {
  const ref = resolveInboundEventRef(body);
  if (!ref) return { persisted: false, reason: 'no_event_ref' };

  const bookingWriteResult = buildBookingWriteResult(body, bridgeResult);
  if (!bookingWriteResult) return { persisted: false, reason: 'no_write_result' };

  return mergeBookingWriteResultIntoEvent(pg, ref, bookingWriteResult);
}

module.exports = {
  persistInboundBookingWriteResult,
  resolveInboundEventRef,
  buildBookingWriteResult,
  mergeBookingWriteResultIntoEvent,
  parseLunaBookingIdempotencyKey,
  RESULT_SOURCE,
};
