'use strict';

/**
 * Per-guest payment_status for Wolfhouse booking-level links.
 *
 * Guest rows are inserted as not_requested. A booking-scoped checkout
 * (no booking_guest_id) used to update only the payment row, so the guest
 * stayed not_requested after the link went out and again after it was paid.
 * These writes follow the link and the paid receipt. A failure here must not
 * abort the checkout or the payment receipt: the savepoint is rolled back
 * and the caller continues.
 */

async function withGuestStatusSavepoint(pg, work) {
  let savepoint = false;
  try {
    await pg.query('SAVEPOINT guest_payment_status');
    savepoint = true;
  } catch (_err) {
    savepoint = false;
  }
  try {
    const result = await work();
    if (savepoint) {
      try { await pg.query('RELEASE SAVEPOINT guest_payment_status'); } catch (_err) { /* already released */ }
    }
    return result;
  } catch (_err) {
    if (savepoint) {
      try { await pg.query('ROLLBACK TO SAVEPOINT guest_payment_status'); } catch (_rollbackErr) { /* leave the caller's transaction */ }
    }
    return 0;
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
  return withGuestStatusSavepoint(pg, async () => {
    const updated = await pg.query(
      `UPDATE booking_guests bg
          SET payment_status = 'payment_link_sent'::payment_status,
              payment_id = COALESCE(bg.payment_id, $4::uuid),
              updated_at = NOW()
        WHERE bg.client_id = $1
          AND bg.booking_id = $2::uuid
          AND bg.payment_status IN ('not_requested'::payment_status, 'draft'::payment_status)
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
          AND payment_status = 'not_requested'::payment_status`,
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
  return withGuestStatusSavepoint(pg, async () => {
    const updated = await pg.query(
      `UPDATE booking_guests bg
          SET payment_status = $3::payment_status,
              payment_id = COALESCE(bg.payment_id, $4::uuid),
              updated_at = NOW()
        WHERE bg.client_id = $1
          AND bg.booking_id = $2::uuid
          AND (
            bg.payment_status IS NULL
            OR bg.payment_status NOT IN ('paid'::payment_status, 'deposit_paid'::payment_status)
            OR ($3::payment_status = 'paid'::payment_status AND bg.payment_status = 'deposit_paid'::payment_status)
          )
          AND (bg.payment_id IS NULL OR bg.payment_id = $4::uuid)`,
      [src.clientId, src.bookingId, status, src.paymentId || null],
    );
    return updated && updated.rowCount ? updated.rowCount : 0;
  });
}

module.exports = {
  markGuestsPaymentLinkRequested,
  markGuestsPaidForBookingPayment,
};
