'use strict';

/**
 * Staff Portal booking cancel — retire unpaid collectible payment rows so the
 * bookings_reject_collectible_cancel trigger can allow status=cancelled.
 * Never refunds captured money. Never reports success that did not happen.
 */

const {
  GUEST_CANCEL_RETIRE_ZERO_PAID_PAYMENTS_SQL,
} = require('./guest-unpaid-cancellation');

const STAFF_CANCEL_CLIENT_BOOKING_SQL = `
SELECT c.id::text AS client_id
  FROM bookings b
  JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1
   AND b.id::text = $2
 LIMIT 1
`;

const STAFF_CANCEL_CAPTURED_PAYMENTS_SQL = `
SELECT COUNT(*)::int AS c
  FROM payments p
 WHERE p.client_id = $1::uuid
   AND p.booking_id = $2::uuid
   AND (
     COALESCE(p.amount_paid_cents, 0) > 0
     OR LOWER(COALESCE(p.status::text, '')) IN ('paid', 'succeeded', 'partially_paid', 'captured')
   )
`;

function explainStaffBookingCancelError(err) {
  const raw = String((err && err.message) || err || '').trim();
  if (raw === 'cancelled_booking_has_collectible_payment') {
    return 'This booking still has an open unpaid payment or payment link. Cancel cannot finish until those unpaid rows are closed.';
  }
  if (raw === 'collectible_payment_for_cancelled_booking') {
    return 'A payment row still looks collectible on a cancelled booking.';
  }
  if (raw === 'booking_has_collected_money') {
    return 'This booking has collected money. Cancel from here cannot refund it.';
  }
  if (!raw || raw === 'cancel failed') {
    return 'Could not cancel this booking.';
  }
  return 'Could not cancel this booking: ' + raw;
}

async function neutralizeUnpaidCollectiblePayments(pg, { clientSlug, bookingId }) {
  const found = await pg.query(STAFF_CANCEL_CLIENT_BOOKING_SQL, [clientSlug, bookingId]);
  const clientId = found.rows[0] && found.rows[0].client_id;
  if (!clientId) {
    return {
      ok: false,
      reason_code: 'booking_not_found',
      error: 'Booking not found.',
      captured_count: 0,
      neutralized_count: 0,
    };
  }
  const captured = await pg.query(STAFF_CANCEL_CAPTURED_PAYMENTS_SQL, [clientId, bookingId]);
  const capturedCount = Number(captured.rows[0] && captured.rows[0].c || 0);
  if (capturedCount > 0) {
    return {
      ok: false,
      reason_code: 'booking_has_collected_money',
      error: explainStaffBookingCancelError({ message: 'booking_has_collected_money' }),
      captured_count: capturedCount,
      neutralized_count: 0,
    };
  }
  const upd = await pg.query(GUEST_CANCEL_RETIRE_ZERO_PAID_PAYMENTS_SQL, [clientId, bookingId]);
  return {
    ok: true,
    captured_count: 0,
    neutralized_count: (upd.rowCount != null ? upd.rowCount : (upd.rows || []).length),
    payment_ids: (upd.rows || []).map((row) => row.id || row.payment_id),
  };
}

module.exports = {
  STAFF_CANCEL_CLIENT_BOOKING_SQL,
  STAFF_CANCEL_CAPTURED_PAYMENTS_SQL,
  explainStaffBookingCancelError,
  neutralizeUnpaidCollectiblePayments,
};
