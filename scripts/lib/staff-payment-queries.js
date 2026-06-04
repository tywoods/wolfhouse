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
 * bot/staff hasn't verified) requires a claim marker. As of Stage 5.7 this marker
 * exists: staff_handoffs.reason_code IN ('payment_claimed','payment_claimed_no_record')
 * (migration 008, not yet applied). getPaymentClaimedNoRecordQuery() below uses it.
 * getNoPaymentRecordQuery() is retained as the structural proxy (payment_pending with
 * no payments row) and works without migration 008.
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
  return require('./staff-ask-luna-balance-due').getBalanceDueQuery();
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

// ---------------------------------------------------------------------------
// D2. Payment claimed but no record (Stage 5.7 — uses staff_handoffs)
// ---------------------------------------------------------------------------

/**
 * Bookings/conversations where the guest claims they paid but staff must verify.
 * Uses staff_handoffs.reason_code IN ('payment_claimed','payment_claimed_no_record').
 * Requires migration 008_add_staff_handoffs.sql to be applied.
 * This is the Stage 5.7 upgrade of the Stage 5.3 structural proxy
 * (getNoPaymentRecordQuery), and is additive — it does not replace it.
 * Ordered by handoff opened_at ascending.
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getPaymentClaimedNoRecordQuery() {
  return `
SELECT
  h.id::text                AS handoff_id,
  h.reason_code,
  h.summary,
  h.priority,
  h.status                  AS handoff_status,
  h.phone,
  h.opened_at,
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.check_in,
  b.check_out,
  b.payment_status::text,
  b.status::text            AS booking_status,
  p.id::text                AS payment_id,
  p.status::text            AS payment_record_status
FROM staff_handoffs h
INNER JOIN clients c ON c.id = h.client_id
LEFT JOIN bookings b ON b.id = h.booking_id
LEFT JOIN payments p ON p.booking_id = b.id AND p.status = 'paid'
WHERE c.slug = $1
  AND h.reason_code IN ('payment_claimed', 'payment_claimed_no_record')
  AND h.status IN ('open', 'assigned', 'waiting_guest')
ORDER BY h.opened_at ASC
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
  getPaymentClaimedNoRecordQuery,
};
