'use strict';

/**
 * Confirmation owed — one record per saved booking.
 * Clears only when a real provider delivery id exists. Dry-run / blocked never clear.
 */

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

const RECORD_SQL = `
INSERT INTO booking_confirmation_owed (booking_id, client_id, owed_at)
VALUES ($1::uuid, $2::uuid, NOW())
ON CONFLICT (booking_id) DO NOTHING
RETURNING booking_id::text AS booking_id, owed_at, cleared_at`;

const CLEAR_SQL = `
UPDATE booking_confirmation_owed
   SET cleared_at = NOW(),
       clear_reason = 'delivered',
       provider_message_id = $2
 WHERE booking_id = $1::uuid
   AND cleared_at IS NULL
   AND $2 <> ''
RETURNING booking_id::text AS booking_id, cleared_at, clear_reason`;

async function recordConfirmationOwed(pg, fields) {
  const bookingId = trimStr(fields && fields.booking_id);
  const clientId = trimStr(fields && fields.client_id);
  if (!pg || !bookingId || !clientId) {
    return { ok: false, owed: false, reason: 'missing_booking_or_client' };
  }
  try {
    const r = await pg.query(RECORD_SQL, [bookingId, clientId]);
    return { ok: true, owed: true, inserted: !!(r.rows && r.rows[0]) };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (/booking_confirmation_owed/i.test(msg) && /does not exist|relation/i.test(msg)) {
      return { ok: false, owed: false, reason: 'table_missing' };
    }
    throw err;
  }
}

async function clearConfirmationOwedOnDelivery(pg, fields) {
  const bookingId = trimStr(fields && fields.booking_id);
  const providerId = trimStr(fields && fields.provider_message_id);
  if (!pg || !bookingId) {
    return { ok: false, cleared: false, reason: 'missing_booking' };
  }
  if (!providerId) {
    return { ok: true, cleared: false, reason: 'no_provider_message_id' };
  }
  try {
    const r = await pg.query(CLEAR_SQL, [bookingId, providerId]);
    return {
      ok: true,
      cleared: !!(r.rows && r.rows[0]),
      clear_reason: r.rows && r.rows[0] ? r.rows[0].clear_reason : null,
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (/booking_confirmation_owed/i.test(msg) && /does not exist|relation/i.test(msg)) {
      return { ok: false, cleared: false, reason: 'table_missing' };
    }
    throw err;
  }
}

module.exports = {
  recordConfirmationOwed,
  clearConfirmationOwedOnDelivery,
};
