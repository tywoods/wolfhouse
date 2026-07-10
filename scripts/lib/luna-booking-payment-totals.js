'use strict';

/**
 * Stage 29c.1 — derive booking paid totals from completed payment rows only.
 * checkout_created / pending / draft rows must not count as paid.
 */

const COMPLETED_PAYMENT_ROW_STATUSES = Object.freeze(['paid']);

async function sumCompletedPaymentCentsForBooking(pg, bookingId, excludePaymentId = null) {
  if (!pg || typeof pg.query !== 'function') {
    throw new Error('pg client required');
  }
  if (!bookingId) return 0;
  const r = await pg.query(
    `SELECT COALESCE(SUM(amount_paid_cents), 0)::int AS total
       FROM payments
      WHERE booking_id = $1::uuid
        AND status = 'paid'::payment_record_status
        AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [bookingId, excludePaymentId || null],
  );
  return Number(r.rows[0]?.total || 0);
}

/**
 * @param {{ bkTotal: number, prevCompletedPaidCents: number, stripePaidCents: number, paymentKind?: string }} input
 */
function deriveBookingPaymentState(input) {
  const src = input || {};
  const stripePaid = Number(src.stripePaidCents || 0);
  const total = Number(src.bkTotal || 0);
  const prevPaid = Number(src.prevCompletedPaidCents || 0);
  const paymentKind = String(src.paymentKind || '').trim();

  const newBkPaid = total > 0
    ? Math.min(prevPaid + stripePaid, total)
    : prevPaid + stripePaid;
  const newBkBalance = total > 0 ? Math.max(total - newBkPaid, 0) : 0;

  let newBkPayStatus;
  // Sunset schedule bookings may have total_amount_cents = 0 until priced; a completed
  // full_amount Stripe checkout still means the booking is paid when balance is zero.
  if (newBkBalance === 0 && (total > 0 || (newBkPaid > 0 && paymentKind === 'full_amount'))) {
    newBkPayStatus = 'paid';
  } else if (paymentKind === 'deposit_only') {
    newBkPayStatus = 'deposit_paid';
  } else {
    newBkPayStatus = 'waiting_payment';
  }

  return {
    newPmPaidCents: stripePaid,
    newBkPaid,
    newBkBalance,
    newBkPayStatus,
  };
}

module.exports = {
  COMPLETED_PAYMENT_ROW_STATUSES,
  sumCompletedPaymentCentsForBooking,
  deriveBookingPaymentState,
};
