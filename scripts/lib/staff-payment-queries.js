/**
 * Stage 5.3c — Staff payment query helpers.
 *
 * Six read-only SQL queries for pilot/staff payment operations:
 *   A. getDepositPaidQuery        — who paid deposit (owes balance)
 *   B. getFullyPaidQuery          — who paid in full
 *   C. getBalanceDueQuery         — who still owes a balance
 *   D. getNoPaymentRecordQuery    — payment_pending with no payments row
 *   E. getPaymentPendingQuery     — bookings in waiting_payment / payment_pending state
 *   F. getConfirmationNeededQuery — paid bookings awaiting confirmation send
 *
 * TODO (D): A "claimed paid but no record" query (e.g. guest said they paid but
 * bot/staff hasn't verified) requires a claim marker — either a `metadata` JSONB
 * field on `conversations` or a `staff_handoffs.reason = 'payment_claimed'` row.
 * Neither exists in the current schema. Query D instead covers the structurally
 * detectable proxy: bookings that are payment_pending but have no `payments` row
 * at all (i.e. the CPS workflow never ran or the link was never sent). This is the
 * closest safe approximation until Stage 5.7 staff_handoffs is implemented.
 *
 * All queries are scoped by client slug ($1) and are SELECT-only.
 *
 * @module staff-payment-queries
 */

'use strict';

const CLIENT_SLUG = 'wolfhouse-somo';

// ---------------------------------------------------------------------------
// A. Who paid deposit (deposit_paid — still owes remaining balance)
// ---------------------------------------------------------------------------

/**
 * Bookings where guest paid the deposit but the full balance has not been paid.
 * Ordered by check-in date ascending.
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getDepositPaidQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.phone,
  b.guest_name,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.payment_status::text,
  b.amount_paid_cents,
  b.balance_due_cents,
  b.total_amount_cents,
  b.deposit_required_cents,
  p.id::text                AS payment_id,
  p.amount_due_cents        AS payment_amount_due_cents,
  p.amount_paid_cents       AS payment_amount_paid_cents,
  p.paid_at
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
LEFT JOIN payments p ON p.booking_id = b.id AND p.status = 'paid'
WHERE c.slug = $1
  AND b.payment_status = 'deposit_paid'
ORDER BY b.check_in ASC
`;
}

// ---------------------------------------------------------------------------
// B. Who paid in full
// ---------------------------------------------------------------------------

/**
 * Bookings where the full payment has been received.
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getFullyPaidQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.phone,
  b.guest_name,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.status::text            AS booking_status,
  b.payment_status::text,
  b.amount_paid_cents,
  b.total_amount_cents,
  b.balance_due_cents,
  b.send_confirmation,
  b.confirmation_sent_at,
  p.id::text                AS payment_id,
  p.payment_kind::text,
  p.amount_paid_cents       AS payment_amount_paid_cents,
  p.paid_at
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
LEFT JOIN payments p ON p.booking_id = b.id AND p.status = 'paid'
WHERE c.slug = $1
  AND b.payment_status = 'paid'
ORDER BY b.check_in ASC
`;
}

// ---------------------------------------------------------------------------
// C. Who still owes a balance (deposit paid but balance_due_cents > 0)
// ---------------------------------------------------------------------------

/**
 * Bookings with an outstanding balance (deposit paid, balance not cleared).
 * balance_due_cents on bookings is set by the Stripe webhook; if NULL the
 * computed fallback is (total_amount_cents - amount_paid_cents).
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getBalanceDueQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.phone,
  b.guest_name,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.payment_status::text,
  b.amount_paid_cents,
  b.total_amount_cents,
  b.balance_due_cents,
  GREATEST(
    COALESCE(b.balance_due_cents, 0),
    GREATEST(COALESCE(b.total_amount_cents, 0) - COALESCE(b.amount_paid_cents, 0), 0)
  )                         AS computed_balance_due_cents,
  b.deposit_required_cents,
  b.deposit_paid_cents
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.payment_status = 'deposit_paid'
  AND (
    COALESCE(b.balance_due_cents, 0) > 0
    OR COALESCE(b.total_amount_cents, 0) - COALESCE(b.amount_paid_cents, 0) > 0
  )
  AND b.status NOT IN ('cancelled', 'expired')
ORDER BY b.check_in ASC
`;
}

// ---------------------------------------------------------------------------
// D. payment_pending with no payments row
// ---------------------------------------------------------------------------
// TODO (claimed-paid/no-record): A query for "guest claimed they paid but no
// record exists" requires a claim marker — e.g. conversations.metadata JSONB
// or staff_handoffs.reason = 'payment_claimed'. Neither exists yet (planned in
// Stage 5.7 staff_handoffs). This query covers the closest safe proxy: bookings
// that are payment_pending but have NO payments row whatsoever (CPS never ran).
// Update this query when staff_handoffs is available.

/**
 * Bookings with status=payment_pending that have no payments row at all.
 * Proxy for "payment link was never sent" or "CPS never ran".
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getNoPaymentRecordQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.phone,
  b.guest_name,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.status::text            AS booking_status,
  b.payment_status::text,
  b.total_amount_cents,
  b.deposit_required_cents,
  b.hold_expires_at,
  b.updated_at
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
LEFT JOIN payments p ON p.booking_id = b.id
WHERE c.slug = $1
  AND b.status = 'payment_pending'
  AND p.id IS NULL
ORDER BY b.updated_at ASC
`;
}

// ---------------------------------------------------------------------------
// E. payment_pending (waiting_payment) — payment link sent, awaiting Stripe
// ---------------------------------------------------------------------------

/**
 * Bookings in payment_pending state where payment_status is waiting_payment
 * (payment link sent, Stripe not yet confirmed).
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getWaitingPaymentQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.phone,
  b.guest_name,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.payment_status::text,
  b.total_amount_cents,
  b.deposit_required_cents,
  b.hold_expires_at,
  b.updated_at,
  p.id::text                AS payment_id,
  p.status::text            AS payment_record_status,
  p.amount_due_cents,
  p.stripe_checkout_session_id,
  p.checkout_url,
  p.expires_at              AS payment_link_expires_at
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
LEFT JOIN payments p ON p.booking_id = b.id
  AND p.status NOT IN ('paid', 'cancelled', 'expired', 'failed')
WHERE c.slug = $1
  AND b.status = 'payment_pending'
  AND b.payment_status = 'waiting_payment'
ORDER BY b.updated_at ASC
`;
}

// ---------------------------------------------------------------------------
// F. Paid — awaiting confirmation send
// ---------------------------------------------------------------------------

/**
 * Bookings that have been paid (deposit or full) and have send_confirmation=TRUE
 * but confirmation has not been sent yet (confirmation_sent_at IS NULL).
 * These are eligible for the Send Confirmation workflow.
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getConfirmationNeededQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.phone,
  b.guest_name,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.status::text            AS booking_status,
  b.payment_status::text,
  b.send_confirmation,
  b.confirmation_sent_at,
  b.amount_paid_cents,
  b.updated_at
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.send_confirmation = TRUE
  AND b.confirmation_sent_at IS NULL
  AND b.payment_status IN ('deposit_paid', 'paid')
  AND b.status = 'payment_pending'
  AND b.phone IS NOT NULL
  AND trim(b.phone) <> ''
ORDER BY b.updated_at ASC
`;
}

module.exports = {
  CLIENT_SLUG,
  getDepositPaidQuery,
  getFullyPaidQuery,
  getBalanceDueQuery,
  getNoPaymentRecordQuery,
  getWaitingPaymentQuery,
  getConfirmationNeededQuery,
};
