/**
 * Stage 7.7i — Booking detail query helpers.
 *
 * Six read-only SQL queries that assemble the full booking context card
 * for the Cami dashboard calendar block detail drawer.
 *
 *   A. getBookingDetailQuery              — full booking row
 *   B. getBookingPaymentsQuery            — payment rows for this booking
 *   C. getBookingRoomingAssignmentsQuery  — booking_beds assignments
 *   D. getBookingConversationQuery        — conversation linked by phone
 *   E. getBookingHandoffQuery             — open/latest handoff for booking
 *   F. getBookingAddOnSummaryQuery        — add-on orders + items for booking
 *   G. getBookingServiceRecordsQuery      — booking_service_records for booking
 *
 * All queries are scoped by client slug ($1) and booking_code ($2).
 * SELECT-only. No mutations.
 *
 * @module staff-booking-detail-queries
 */

'use strict';

// ---------------------------------------------------------------------------
// A. Full booking row
// ---------------------------------------------------------------------------

/**
 * All core booking fields for one booking, client-scoped.
 *
 * @returns {string} SQL ($1 = client slug, $2 = booking_code)
 */
function getBookingDetailQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.phone,
  b.email,
  b.guest_count,
  b.package_code,
  b.check_in::text          AS check_in,
  b.check_out::text         AS check_out,
  b.status::text            AS status,
  b.payment_status::text    AS payment_status,
  b.assignment_status::text AS assignment_status,
  b.requested_room_type,
  b.room_preference,
  b.primary_room_code,
  b.needs_rooming_review,
  b.rooming_notes,
  b.total_amount_cents,
  b.deposit_required_cents,
  b.amount_paid_cents,
  b.balance_due_cents,
  b.hold_expires_at,
  b.airtable_record_id,
  b.updated_at
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.booking_code = $2
LIMIT 1
`;
}

// ---------------------------------------------------------------------------
// B. Payment rows for this booking
// ---------------------------------------------------------------------------

/**
 * All payment rows linked to this booking, newest first.
 *
 * @returns {string} SQL ($1 = client slug, $2 = booking_code)
 */
function getBookingPaymentsQuery() {
  // Stage 8.4.12: added payment_kind, currency, checkout_url, stripe_checkout_session_id
  // so the booking drawer can show full Stripe payment truth after webhook fires.
  return `
SELECT
  p.id::text                    AS payment_id,
  p.status::text                AS payment_status,
  p.payment_kind::text          AS payment_kind,
  p.currency,
  p.amount_due_cents,
  p.amount_paid_cents,
  p.paid_at,
  p.checkout_url,
  p.stripe_checkout_session_id,
  p.stripe_payment_intent_id,
  p.created_at
FROM payments p
INNER JOIN bookings b ON b.id = p.booking_id
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.booking_code = $2
ORDER BY p.created_at DESC
`;
}

// ---------------------------------------------------------------------------
// C. Bed / rooming assignments for this booking
// ---------------------------------------------------------------------------

/**
 * booking_beds rows for this booking with room detail, ordered by start date.
 *
 * @returns {string} SQL ($1 = client slug, $2 = booking_code)
 */
function getBookingRoomingAssignmentsQuery() {
  return `
SELECT
  bb.id::text               AS booking_bed_id,
  bb.room_code,
  bb.bed_code,
  bb.assignment_start_date::text AS assignment_start_date,
  bb.assignment_end_date::text   AS assignment_end_date,
  bb.planning_row_label,
  bb.assignment_label,
  bb.assignment_type,
  bb.guest_name             AS bed_guest_name,
  r.name                    AS room_name,
  r.room_type,
  r.gender_strategy,
  r.capacity
FROM booking_beds bb
INNER JOIN bookings b ON b.id = bb.booking_id
INNER JOIN clients c ON c.id = b.client_id
LEFT JOIN beds bd ON bd.id = bb.bed_id
LEFT JOIN rooms r ON r.id = bd.room_id
WHERE c.slug = $1
  AND b.booking_code = $2
ORDER BY bb.assignment_start_date ASC, bb.room_code ASC
`;
}

// ---------------------------------------------------------------------------
// D. Conversation linked to this booking (via phone match)
// ---------------------------------------------------------------------------

/**
 * The most recent conversation for the same phone as this booking.
 * Linked by phone (the canonical link between bookings and conversations).
 *
 * @returns {string} SQL ($1 = client slug, $2 = booking_code)
 */
function getBookingConversationQuery() {
  return `
SELECT
  conv.id::text             AS conversation_id,
  conv.phone,
  conv.display_name,
  conv.language,
  conv.bot_mode::text,
  conv.needs_human,
  conv.status::text         AS conversation_status,
  conv.pending_action,
  conv.last_message_preview,
  conv.updated_at
FROM conversations conv
INNER JOIN clients c ON c.id = conv.client_id
INNER JOIN bookings b ON b.phone = conv.phone
  AND b.client_id = conv.client_id
WHERE c.slug = $1
  AND b.booking_code = $2
ORDER BY conv.updated_at DESC
LIMIT 1
`;
}

// ---------------------------------------------------------------------------
// E. Open / latest handoff for this booking
// ---------------------------------------------------------------------------

/**
 * The most recent open (or latest) staff handoff linked to this booking,
 * joined through the booking_code → bookings → staff_handoffs chain.
 *
 * @returns {string} SQL ($1 = client slug, $2 = booking_code)
 */
function getBookingHandoffQuery() {
  return `
SELECT
  h.id::text                AS handoff_id,
  h.reason_code,
  h.summary,
  h.priority,
  h.status,
  h.assigned_staff,
  h.phone,
  h.opened_at,
  h.resolved_at,
  h.first_response_due_at
FROM staff_handoffs h
INNER JOIN bookings b ON b.phone = h.phone
  AND b.client_id = h.client_id
INNER JOIN clients c ON c.id = h.client_id
WHERE c.slug = $1
  AND b.booking_code = $2
  AND h.status IN ('open', 'assigned', 'waiting_guest')
ORDER BY h.opened_at DESC
LIMIT 1
`;
}

// ---------------------------------------------------------------------------
// F. Add-on summary for this booking
// ---------------------------------------------------------------------------

/**
 * Add-on orders and items for this booking, ordered by requested_at.
 * Returns an empty result if no add-on rows exist (table may be empty).
 *
 * @returns {string} SQL ($1 = client slug, $2 = booking_code)
 */
function getBookingAddOnSummaryQuery() {
  return `
SELECT
  ao.id::text               AS order_id,
  ao.order_code,
  ao.status                 AS order_status,
  ao.payment_status         AS order_payment_status,
  ao.total_amount_cents,
  ao.requested_at,
  ai.item_type,
  ai.item_name,
  ai.quantity,
  ai.unit_price_cents,
  ai.service_date
FROM add_on_orders ao
INNER JOIN clients c ON c.id = ao.client_id
INNER JOIN bookings b ON b.id = ao.booking_id
LEFT JOIN add_on_items ai ON ai.order_id = ao.id
WHERE c.slug = $1
  AND b.booking_code = $2
ORDER BY ao.requested_at ASC, ai.item_type ASC
`;
}

// ---------------------------------------------------------------------------
// G. Structured service / add-on records (Stage 8.8.14)
// ---------------------------------------------------------------------------

/**
 * booking_service_records rows for this booking.
 * Matches by booking_id when set; falls back to booking_code for demo rows
 * with null booking_id. Never reads chat logs.
 *
 * @returns {string} SQL ($1 = client slug, $2 = booking_code)
 */
function getBookingServiceRecordsQuery() {
  return `
SELECT
  sr.id::text               AS service_record_id,
  sr.service_type,
  sr.service_date::text     AS service_date,
  sr.quantity,
  sr.status,
  sr.payment_status,
  sr.amount_due_cents,
  sr.amount_paid_cents,
  sr.source,
  sr.notes
FROM booking_service_records sr
INNER JOIN clients c ON c.slug = sr.client_slug
INNER JOIN bookings b ON b.client_id = c.id
  AND b.booking_code = $2
WHERE sr.client_slug = $1
  AND (
    sr.booking_id = b.id
    OR (sr.booking_id IS NULL AND sr.booking_code = b.booking_code)
  )
ORDER BY sr.service_date ASC, sr.service_type ASC
`;
}

module.exports = {
  getBookingDetailQuery,
  getBookingPaymentsQuery,
  getBookingRoomingAssignmentsQuery,
  getBookingConversationQuery,
  getBookingHandoffQuery,
  getBookingAddOnSummaryQuery,
  getBookingServiceRecordsQuery,
};
