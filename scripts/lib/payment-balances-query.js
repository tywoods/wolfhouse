/**
 * Stage 5.3b — Payment balances SQL helper.
 *
 * Read-only query combining bookings + payments to give staff a unified
 * balance view: who paid, who owes, confirmation state. Equivalent to a
 * `payment_balances` view but kept as a parameterised SQL helper so no
 * DB migration is required (promote to a VIEW in Stage 6 if needed).
 *
 * Usage:
 *   const { getPaymentBalancesQuery, CLIENT_SLUG } = require('./payment-balances-query');
 *   const sql = getPaymentBalancesQuery();
 *   // Execute with: [CLIENT_SLUG] as $1
 *
 * @module payment-balances-query
 */

'use strict';

const CLIENT_SLUG = 'wolfhouse-somo';

/**
 * Returns a read-only SQL query joining bookings + payments for all
 * payment_pending and confirmed bookings scoped to the given client.
 *
 * Parameterised: $1 = client slug
 *
 * Columns returned:
 *   booking_id, booking_code, phone, guest_name, guest_count,
 *   package_code, check_in, check_out,
 *   booking_status, booking_payment_status,
 *   total_amount_cents, deposit_required_cents,
 *   deposit_paid_cents, amount_paid_cents, balance_due_cents,
 *   send_confirmation, confirmation_sent_at,
 *   payment_id, payment_record_status, payment_kind,
 *   payment_amount_due_cents, payment_amount_paid_cents,
 *   stripe_checkout_session_id, paid_at,
 *   payment_event_count,
 *   booking_created_at, booking_updated_at
 *
 * @param {string} [clientSlug=CLIENT_SLUG]
 * @returns {string} Parameterised SQL (SELECT-only)
 */
function getPaymentBalancesQuery(clientSlug = CLIENT_SLUG) {
  void clientSlug;
  return `
SELECT
  b.id::text                    AS booking_id,
  b.booking_code,
  b.phone,
  b.guest_name,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.status::text                AS booking_status,
  b.payment_status::text        AS booking_payment_status,
  b.total_amount_cents,
  b.deposit_required_cents,
  b.deposit_paid_cents,
  b.amount_paid_cents,
  b.balance_due_cents,
  b.send_confirmation,
  b.confirmation_sent_at,
  p.id::text                    AS payment_id,
  p.status::text                AS payment_record_status,
  p.payment_kind::text,
  p.amount_due_cents            AS payment_amount_due_cents,
  p.amount_paid_cents           AS payment_amount_paid_cents,
  p.stripe_checkout_session_id,
  p.paid_at,
  (
    SELECT COUNT(*)
    FROM payment_events pe
    WHERE pe.booking_id = b.id
  )                             AS payment_event_count,
  b.created_at                  AS booking_created_at,
  b.updated_at                  AS booking_updated_at
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
LEFT JOIN payments p ON p.booking_id = b.id
WHERE c.slug = $1
  AND b.status IN ('payment_pending', 'confirmed')
ORDER BY b.updated_at DESC
`;
}

module.exports = {
  CLIENT_SLUG,
  getPaymentBalancesQuery,
};
