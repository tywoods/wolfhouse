'use strict';

/**
 * After a Stripe checkout session exists, Staff must see the booking as
 * requested without the /payments/status overlay. bookings.payment_status
 * enum has payment_link_sent (not checkout_created).
 *
 * Never overwrites deposit_paid / paid. Never blocks a booking INSERT.
 */

async function markBookingPaymentRequestedAfterCheckout(pg, { bookingId, clientId }) {
  if (!pg || !bookingId || !clientId) return { rowCount: 0 };
  try {
    return await pg.query(
      `UPDATE bookings
          SET payment_status = 'payment_link_sent'::payment_status
        WHERE id = $1::uuid
          AND client_id = $2::uuid
          AND payment_status = 'not_requested'::payment_status`,
      [bookingId, clientId],
    );
  } catch (_) {
    return { rowCount: 0, skipped: true };
  }
}

/**
 * Split per-guest checkouts leave the create-time unscoped deposit_only
 * draft (booking_guest_id NULL, full group amount). Cancel it. Do not DELETE.
 */
async function voidUnscopedDepositDraftAfterPerGuestCheckout(pg, { bookingId, clientId }) {
  if (!pg || !bookingId || !clientId) return { rowCount: 0 };
  try {
    return await pg.query(
      `UPDATE payments
          SET status = 'cancelled'::payment_record_status,
              metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object(
                     'voided_reason', 'replaced_by_per_guest_checkout',
                     'voided_at', NOW()::text
                   )
        WHERE booking_id = $1::uuid
          AND client_id = $2::uuid
          AND booking_guest_id IS NULL
          AND payment_kind = 'deposit_only'::payment_kind
          AND status = 'draft'::payment_record_status`,
      [bookingId, clientId],
    );
  } catch (_) {
    return { rowCount: 0, skipped: true };
  }
}

module.exports = {
  markBookingPaymentRequestedAfterCheckout,
  voidUnscopedDepositDraftAfterPerGuestCheckout,
};
