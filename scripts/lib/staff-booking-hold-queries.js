/**
 * Stage 5.2e — Staff booking/hold query helpers.
 *
 * Read-only SQL queries for pilot/staff operations. Covers four query categories:
 *   A. Active holds
 *   B. Expired/stuck holds
 *   C. payment_pending bookings
 *   D. Holds/payment_pending with no payment record
 *
 * All queries are scoped by client slug and are SELECT-only.
 * Do NOT execute these against production without staff approval.
 *
 * @module staff-booking-hold-queries
 */

const CLIENT_SLUG = 'wolfhouse-somo';

// ---------------------------------------------------------------------------
// A. Active holds: status='hold', hold_expires_at > NOW(), scoped to client
// ---------------------------------------------------------------------------

/**
 * Returns bookings currently in hold state that have not expired.
 * Ordered by hold_expires_at ascending (soonest to expire first).
 *
 * @param {string} [clientSlug=CLIENT_SLUG]
 * @returns {string} SQL query string (parameterised: $1 = client slug)
 */
function getActiveHoldsQuery(clientSlug = CLIENT_SLUG) {
  void clientSlug;
  return `
SELECT
  b.id::text          AS booking_id,
  b.booking_code,
  b.phone,
  b.guest_name,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.hold_expires_at,
  b.payment_status::text,
  b.created_at
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.status = 'hold'
  AND b.hold_expires_at > NOW()
ORDER BY b.hold_expires_at ASC
`;
}

// ---------------------------------------------------------------------------
// B. Expired/stuck holds: status='hold', hold_expires_at < NOW()
// ---------------------------------------------------------------------------

/**
 * Returns holds that have passed their expiry without being promoted or cancelled.
 * Includes age in minutes for triage.
 *
 * @returns {string} SQL query string (parameterised: $1 = client slug)
 */
function getExpiredHoldsQuery() {
  return `
SELECT
  b.id::text          AS booking_id,
  b.booking_code,
  b.phone,
  b.guest_name,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.hold_expires_at,
  b.payment_status::text,
  EXTRACT(EPOCH FROM (NOW() - b.hold_expires_at)) / 60 AS expired_minutes_ago,
  b.created_at
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.status = 'hold'
  AND b.hold_expires_at < NOW()
ORDER BY b.hold_expires_at DESC
`;
}

// ---------------------------------------------------------------------------
// C. payment_pending bookings (not yet fully paid)
// ---------------------------------------------------------------------------

/**
 * Returns bookings promoted to payment_pending where payment is not complete.
 * Excludes deposit_paid, paid, refunded to show only actionable rows.
 *
 * @returns {string} SQL query string (parameterised: $1 = client slug)
 */
function getPaymentPendingQuery() {
  return `
SELECT
  b.id::text          AS booking_id,
  b.booking_code,
  b.phone,
  b.guest_name,
  b.email,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.payment_status::text,
  b.hold_expires_at,
  b.created_at,
  b.updated_at
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.status = 'payment_pending'
  AND b.payment_status NOT IN ('deposit_paid', 'paid', 'refunded')
ORDER BY b.updated_at ASC
`;
}

// ---------------------------------------------------------------------------
// D. Holds/payment_pending with no successful payment record
// ---------------------------------------------------------------------------

/**
 * Returns bookings in hold or payment_pending state that have no paid payment row.
 * Uses LEFT JOIN to catch both: no payment row at all, and payment rows in non-paid states.
 *
 * @returns {string} SQL query string (parameterised: $1 = client slug)
 */
function getNoPaymentRecordQuery() {
  return `
SELECT
  b.id::text          AS booking_id,
  b.booking_code,
  b.phone,
  b.guest_name,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.status::text,
  b.payment_status::text,
  b.deposit_required_cents,
  b.total_amount_cents,
  b.hold_expires_at,
  b.created_at,
  p.id::text          AS payment_id,
  p.status::text      AS payment_record_status,
  p.amount_cents,
  p.checkout_url
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
LEFT JOIN payments p ON p.booking_id = b.id
  AND p.status = 'paid'
WHERE c.slug = $1
  AND b.status IN ('hold', 'payment_pending')
  AND p.id IS NULL
ORDER BY b.created_at ASC
`;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = {
  CLIENT_SLUG,
  getActiveHoldsQuery,
  getExpiredHoldsQuery,
  getPaymentPendingQuery,
  getNoPaymentRecordQuery,
};
