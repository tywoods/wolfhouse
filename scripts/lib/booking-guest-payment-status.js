'use strict';

/**
 * Optional payment-status projections, not authoritative payment/receipt writes.
 * The caller owns the transaction. To preserve primary facts on projection
 * failure, establish a savepoint AFTER those facts and BEFORE calling a writer;
 * on GuestPaymentStatusProjectionError roll back to it, then release it. Only
 * continue/commit after successful recovery. Never swallow recovery failures.
 *
 * These helpers do not BEGIN, SAVEPOINT, ROLLBACK or COMMIT. A thrown error does
 * not mean the transaction is usable: PostgreSQL statement failures abort it
 * until caller recovery. In autocommit, earlier statements may already persist.
 * No booking existence prerequisite is imposed on guest updates.
 */
class GuestPaymentStatusProjectionError extends Error {
  constructor(operation, cause) {
    super(`Guest payment status projection failed: ${operation}`, { cause });
    this.name = 'GuestPaymentStatusProjectionError';
    this.code = 'GUEST_PAYMENT_STATUS_PROJECTION_FAILED';
    this.operation = operation;
  }
}

async function projectGuestStatus(operation, work) {
  try {
    return await work();
  } catch (cause) {
    throw new GuestPaymentStatusProjectionError(operation, cause);
  }
}

/**
 * A link was requested. Move covered guests off not_requested.
 * A guest-scoped payment covers that guest. A booking-scoped payment covers
 * guests that are not already on their own payment. Paid guests are left alone.
 * The booking column moves not_requested → payment_link_sent and is not downgraded.
 */
async function markGuestsPaymentLinkRequested(pg, input) {
  const src = input || {};
  if (!pg || !src.clientId || !src.bookingId) return 0;
  return projectGuestStatus('payment_link_requested', async () => {
    const updated = await pg.query(
      `UPDATE booking_guests bg
          SET payment_status = 'payment_link_sent'::payment_status,
              payment_id = COALESCE(bg.payment_id, $4::uuid),
              updated_at = NOW()
        WHERE bg.client_id = $1
          AND bg.booking_id = $2::uuid
          AND bg.payment_status = 'not_requested'
          AND ($3::uuid IS NULL OR bg.id = $3::uuid)
          AND (
            $3::uuid IS NOT NULL
            OR bg.payment_id IS NULL
            OR bg.payment_id = $4::uuid
          )`,
      [src.clientId, src.bookingId, src.bookingGuestId || null, src.paymentId || null],
    );
    await pg.query(
      `UPDATE bookings
          SET payment_status = 'payment_link_sent'::payment_status
        WHERE id = $2::uuid
          AND client_id = $1
          AND payment_status = 'not_requested'`,
      [src.clientId, src.bookingId],
    );
    return updated && updated.rowCount ? updated.rowCount : 0;
  });
}

/**
 * A booking-scoped receipt was paid. Guests still on the booking link (or with
 * no payment of their own) take the booking status: deposit_paid or paid.
 * Guests on a different payment are left alone. Does nothing for unpaid states.
 */
async function markGuestsPaidForBookingPayment(pg, input) {
  const src = input || {};
  const status = src.paymentStatus === 'deposit_paid' || src.paymentStatus === 'paid'
    ? src.paymentStatus
    : null;
  if (!pg || !src.clientId || !src.bookingId || !status) return 0;
  return projectGuestStatus('booking_payment_paid', async () => {
    const updated = await pg.query(
      `UPDATE booking_guests bg
          SET payment_status = $3::payment_status,
              payment_id = COALESCE(bg.payment_id, $4::uuid),
              updated_at = NOW()
        WHERE bg.client_id = $1
          AND bg.booking_id = $2::uuid
          AND (
            bg.payment_status IS NULL
            OR bg.payment_status NOT IN ('paid', 'deposit_paid')
            OR ($3::payment_status = 'paid'::payment_status AND bg.payment_status = 'deposit_paid')
          )
          AND (bg.payment_id IS NULL OR bg.payment_id = $4::uuid)`,
      [src.clientId, src.bookingId, status, src.paymentId || null],
    );
    return updated && updated.rowCount ? updated.rowCount : 0;
  });
}

module.exports = {
  GuestPaymentStatusProjectionError,
  markGuestsPaymentLinkRequested,
  markGuestsPaidForBookingPayment,
};
