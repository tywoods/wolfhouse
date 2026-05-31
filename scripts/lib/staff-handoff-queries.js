/**
 * Stage 5.7 — Staff handoff query helpers.
 *
 * Eight read-only SQL queries for human-handoff / staff-task operations:
 *   A. getOpenHandoffsQuery          — handoffs still needing attention
 *   B. getHighPriorityHandoffsQuery  — open handoffs with high/urgent priority
 *   C. getHandoffsByReasonQuery      — open handoffs filtered by reason_code ($2)
 *   D. getPaymentClaimedHandoffsQuery — payment_claimed / payment_claimed_no_record
 *   E. getCancellationRefundHandoffsQuery — cancellation/refund/date-change reviews
 *   F. getHandoffsByStaffQuery       — handoffs assigned to a staff member ($2)
 *   G. getStaleHandoffsQuery         — unresolved handoffs older than N hours ($2)
 *   H. getBookingHandoffsQuery       — handoffs linked to a booking_code ($2)
 *
 * All queries are scoped by client slug ($1) and are SELECT-only.
 * Requires migration 008_add_staff_handoffs.sql to be applied before runtime use.
 *
 * @module staff-handoff-queries
 */

'use strict';

const CLIENT_SLUG = 'wolfhouse-somo';

// Reason codes that represent an unverified "guest says they paid" claim.
const PAYMENT_CLAIM_REASONS = ['payment_claimed', 'payment_claimed_no_record'];

// Reason codes that represent cancellation / refund / paid-date-change reviews.
const CANCELLATION_REFUND_REASONS = [
  'cancellation_request',
  'refund_request',
  'date_change_paid_booking',
];

// Statuses considered "still needs attention".
const ACTIVE_STATUSES = "('open', 'assigned', 'waiting_guest')";

// Shared SELECT projection for handoff rows with booking context.
const HANDOFF_SELECT = `
  h.id::text                AS handoff_id,
  h.reason_code,
  h.summary,
  h.priority,
  h.status,
  h.assigned_staff,
  h.phone,
  h.language,
  h.source_channel,
  h.opened_at,
  h.first_response_due_at,
  h.resolved_at,
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.check_in,
  b.check_out,
  b.payment_status::text    AS booking_payment_status,
  b.status::text            AS booking_status,
  conv.id::text             AS conversation_id,
  conv.needs_human          AS conversation_needs_human
`;

const HANDOFF_FROM = `
FROM staff_handoffs h
INNER JOIN clients c ON c.id = h.client_id
LEFT JOIN bookings b ON b.id = h.booking_id
LEFT JOIN conversations conv ON conv.id = h.conversation_id
`;

// ---------------------------------------------------------------------------
// A. Open handoffs
// ---------------------------------------------------------------------------

/**
 * Handoffs that still need attention (open / assigned / waiting_guest).
 * Ordered by priority weight (urgent first), then opened_at ascending.
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getOpenHandoffsQuery() {
  return `
SELECT
${HANDOFF_SELECT}
${HANDOFF_FROM}
WHERE c.slug = $1
  AND h.status IN ${ACTIVE_STATUSES}
ORDER BY
  CASE h.priority
    WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
    WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4
  END ASC,
  h.opened_at ASC
`;
}

// ---------------------------------------------------------------------------
// B. High / urgent priority handoffs
// ---------------------------------------------------------------------------

/**
 * Open handoffs with high or urgent priority — escalation queue.
 * Ordered by priority weight, then opened_at ascending.
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getHighPriorityHandoffsQuery() {
  return `
SELECT
${HANDOFF_SELECT}
${HANDOFF_FROM}
WHERE c.slug = $1
  AND h.status IN ${ACTIVE_STATUSES}
  AND h.priority IN ('high', 'urgent')
ORDER BY
  CASE h.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END ASC,
  h.opened_at ASC
`;
}

// ---------------------------------------------------------------------------
// C. Handoffs by reason
// ---------------------------------------------------------------------------

/**
 * Open handoffs filtered by a specific reason_code.
 * Ordered by opened_at ascending.
 *
 * @returns {string} Parameterised SQL ($1 = client slug, $2 = reason_code TEXT)
 */
function getHandoffsByReasonQuery() {
  return `
SELECT
${HANDOFF_SELECT}
${HANDOFF_FROM}
WHERE c.slug = $1
  AND h.reason_code = $2
  AND h.status IN ${ACTIVE_STATUSES}
ORDER BY h.opened_at ASC
`;
}

// ---------------------------------------------------------------------------
// D. Payment-claimed handoffs
// ---------------------------------------------------------------------------

/**
 * Handoffs where the guest claims they paid but staff must verify
 * (reason_code IN payment_claimed / payment_claimed_no_record).
 * This is the Stage 5.3 deferred upgrade for the "claimed-paid/no-record" case.
 * Ordered by opened_at ascending.
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getPaymentClaimedHandoffsQuery() {
  const reasons = PAYMENT_CLAIM_REASONS.map((r) => `'${r}'`).join(', ');
  return `
SELECT
${HANDOFF_SELECT}
${HANDOFF_FROM}
WHERE c.slug = $1
  AND h.reason_code IN (${reasons})
  AND h.status IN ${ACTIVE_STATUSES}
ORDER BY h.opened_at ASC
`;
}

// ---------------------------------------------------------------------------
// E. Cancellation / refund handoffs
// ---------------------------------------------------------------------------

/**
 * Handoffs for cancellation, refund, or paid-booking date-change reviews —
 * dangerous actions that always require staff approval.
 * Ordered by opened_at ascending.
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getCancellationRefundHandoffsQuery() {
  const reasons = CANCELLATION_REFUND_REASONS.map((r) => `'${r}'`).join(', ');
  return `
SELECT
${HANDOFF_SELECT}
${HANDOFF_FROM}
WHERE c.slug = $1
  AND h.reason_code IN (${reasons})
  AND h.status IN ${ACTIVE_STATUSES}
ORDER BY h.opened_at ASC
`;
}

// ---------------------------------------------------------------------------
// F. Handoffs by assigned staff
// ---------------------------------------------------------------------------

/**
 * Active handoffs assigned to a specific staff member.
 * Ordered by priority weight, then opened_at ascending.
 *
 * @returns {string} Parameterised SQL ($1 = client slug, $2 = assigned_staff TEXT)
 */
function getHandoffsByStaffQuery() {
  return `
SELECT
${HANDOFF_SELECT}
${HANDOFF_FROM}
WHERE c.slug = $1
  AND h.assigned_staff = $2
  AND h.status IN ${ACTIVE_STATUSES}
ORDER BY
  CASE h.priority
    WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
    WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4
  END ASC,
  h.opened_at ASC
`;
}

// ---------------------------------------------------------------------------
// G. Stale handoffs (older than N hours, still unresolved)
// ---------------------------------------------------------------------------

/**
 * Unresolved handoffs opened more than $2 hours ago — SLA / stuck detection.
 * Ordered by opened_at ascending (oldest first).
 *
 * @returns {string} Parameterised SQL ($1 = client slug, $2 = hours INTEGER)
 */
function getStaleHandoffsQuery() {
  return `
SELECT
${HANDOFF_SELECT}
${HANDOFF_FROM}
WHERE c.slug = $1
  AND h.status IN ${ACTIVE_STATUSES}
  AND h.opened_at < NOW() - ($2 || ' hours')::interval
ORDER BY h.opened_at ASC
`;
}

// ---------------------------------------------------------------------------
// H. Booking-linked handoffs
// ---------------------------------------------------------------------------

/**
 * All handoffs (any status) linked to a given booking_code.
 * Ordered by opened_at descending (most recent first).
 *
 * @returns {string} Parameterised SQL ($1 = client slug, $2 = booking_code TEXT)
 */
function getBookingHandoffsQuery() {
  return `
SELECT
${HANDOFF_SELECT}
${HANDOFF_FROM}
WHERE c.slug = $1
  AND b.booking_code = $2
ORDER BY h.opened_at DESC
`;
}

// ---------------------------------------------------------------------------
// I. conversations.needs_human reconciliation (Stage 5.8)
// ---------------------------------------------------------------------------

/**
 * Conversations marked needs_human=true but with no open staff_handoff row.
 * This is the reconciliation gap: the flag exists in conversations but no
 * structured handoff record has been written yet (bot pre-dates migration 008,
 * or the handoff row was created before migration 008 was applied).
 *
 * Use this query to find the conversations that need a staff_handoffs row
 * created when the write path is activated in Stage 5.8+.
 * After the write path is live, this query should return 0 rows if all
 * handoff events are being written correctly.
 *
 * Ordered by last updated_at ascending (oldest unresolved first).
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getNeedsHumanWithoutOpenHandoffQuery() {
  return `
SELECT
  conv.id::text             AS conversation_id,
  conv.phone,
  conv.language,
  conv.conversation_stage,
  conv.pending_action,
  conv.bot_mode::text,
  conv.needs_human,
  conv.updated_at,
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.check_in,
  b.check_out,
  b.payment_status::text    AS booking_payment_status
FROM conversations conv
INNER JOIN clients c ON c.id = conv.hostel_id
LEFT JOIN bookings b ON b.id = conv.current_hold_booking_id
WHERE c.slug = $1
  AND conv.needs_human = TRUE
  AND NOT EXISTS (
    SELECT 1
    FROM staff_handoffs h
    WHERE h.conversation_id = conv.id
      AND h.status IN ('open', 'assigned', 'waiting_guest')
  )
ORDER BY conv.updated_at ASC
`;
}

module.exports = {
  CLIENT_SLUG,
  PAYMENT_CLAIM_REASONS,
  CANCELLATION_REFUND_REASONS,
  getOpenHandoffsQuery,
  getHighPriorityHandoffsQuery,
  getHandoffsByReasonQuery,
  getPaymentClaimedHandoffsQuery,
  getCancellationRefundHandoffsQuery,
  getHandoffsByStaffQuery,
  getStaleHandoffsQuery,
  getBookingHandoffsQuery,
  getNeedsHumanWithoutOpenHandoffQuery,
};
