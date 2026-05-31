/**
 * Stage 5.6 — Staff add-on query helpers.
 *
 * Six read-only SQL queries for pilot/staff add-on service operations:
 *   A. getUnpaidAddOnsQuery          — add-on orders that are not yet paid
 *   B. getLessonsByDateQuery         — surf lesson requests for a given date ($2)
 *   C. getYogaByDateQuery            — yoga class requests for a given date ($2)
 *   D. getActiveRentalsByDateQuery   — gear rentals active on a given date ($2)
 *   E. getAddonsByBookingQuery       — all add-on orders for a booking_code ($2)
 *   F. getStaffRequiredAddOnsQuery   — lessons awaiting staff scheduling
 *
 * All queries are scoped by client slug ($1) and are SELECT-only.
 * Requires migration 007_add_addon_orders.sql to be applied before runtime use.
 *
 * @module staff-addon-queries
 */

'use strict';

const CLIENT_SLUG = 'wolfhouse-somo';

// ---------------------------------------------------------------------------
// A. Unpaid add-ons
// ---------------------------------------------------------------------------

/**
 * Add-on orders where payment has not been confirmed (not paid, not cancelled).
 * Useful for staff to identify outstanding balances on add-on services.
 * Ordered by requested_at ascending.
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getUnpaidAddOnsQuery() {
  return `
SELECT
  ao.id::text               AS order_id,
  ao.order_code,
  ao.phone,
  ao.source_channel,
  ao.status,
  ao.payment_status,
  ao.total_amount_cents,
  ao.currency,
  ao.requested_at,
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.check_in,
  b.check_out,
  b.payment_status::text    AS booking_payment_status,
  b.status::text            AS booking_status
FROM add_on_orders ao
INNER JOIN clients c ON c.id = ao.client_id
LEFT JOIN bookings b ON b.id = ao.booking_id
WHERE c.slug = $1
  AND ao.payment_status NOT IN ('paid', 'waived')
  AND ao.status NOT IN ('cancelled')
ORDER BY ao.requested_at ASC
`;
}

// ---------------------------------------------------------------------------
// B. Lessons by date
// ---------------------------------------------------------------------------

/**
 * Surf lesson requests for a specific date.
 * Joins add_on_items and add_on_orders for full context.
 * Ordered by preferred_time (nulls last), then guest_name.
 *
 * @returns {string} Parameterised SQL ($1 = client slug, $2 = lesson_date DATE)
 */
function getLessonsByDateQuery() {
  return `
SELECT
  lr.id::text               AS lesson_request_id,
  lr.lesson_date,
  lr.guest_count,
  lr.preferred_time,
  lr.assigned_slot,
  lr.instructor,
  lr.scheduling_status,
  lr.weather_notes,
  ai.item_type,
  ai.quantity,
  ai.unit_price_cents,
  ai.total_price_cents,
  ao.order_code,
  ao.phone,
  ao.status                 AS order_status,
  ao.payment_status         AS order_payment_status,
  b.booking_code,
  b.guest_name,
  b.check_in,
  b.check_out
FROM lesson_requests lr
INNER JOIN add_on_items ai ON ai.id = lr.add_on_item_id
INNER JOIN add_on_orders ao ON ao.id = ai.order_id
INNER JOIN clients c ON c.id = ao.client_id
LEFT JOIN bookings b ON b.id = lr.booking_id
WHERE c.slug = $1
  AND lr.lesson_date = $2::date
  AND lr.scheduling_status NOT IN ('cancelled')
ORDER BY lr.preferred_time ASC NULLS LAST, b.guest_name ASC
`;
}

// ---------------------------------------------------------------------------
// C. Yoga by date
// ---------------------------------------------------------------------------

/**
 * Yoga class requests for a specific date.
 * Includes payment and redemption status for staff check-in.
 * Ordered by booking check_in, then guest_name.
 *
 * @returns {string} Parameterised SQL ($1 = client slug, $2 = class_date DATE)
 */
function getYogaByDateQuery() {
  return `
SELECT
  yr.id::text               AS yoga_request_id,
  yr.class_date,
  yr.quantity,
  yr.payment_status         AS yoga_payment_status,
  yr.fulfillment_status,
  yr.redeemed,
  yr.booked_onsite,
  ai.item_type,
  ai.unit_price_cents,
  ai.total_price_cents,
  ao.order_code,
  ao.phone,
  ao.status                 AS order_status,
  ao.payment_status         AS order_payment_status,
  b.booking_code,
  b.guest_name,
  b.check_in,
  b.check_out
FROM yoga_requests yr
INNER JOIN add_on_items ai ON ai.id = yr.add_on_item_id
INNER JOIN add_on_orders ao ON ao.id = ai.order_id
INNER JOIN clients c ON c.id = ao.client_id
LEFT JOIN bookings b ON b.id = yr.booking_id
WHERE c.slug = $1
  AND yr.class_date = $2::date
  AND yr.fulfillment_status NOT IN ('cancelled')
ORDER BY b.check_in ASC NULLS LAST, b.guest_name ASC
`;
}

// ---------------------------------------------------------------------------
// D. Active rentals by date
// ---------------------------------------------------------------------------

/**
 * Gear rental requests active on a given date (start_date <= $2 <= end_date).
 * Covers wetsuits, surfboards, and any other rental items.
 * Ordered by rental_type, then guest_name.
 *
 * @returns {string} Parameterised SQL ($1 = client slug, $2 = on_date DATE)
 */
function getActiveRentalsByDateQuery() {
  return `
SELECT
  rr.id::text               AS rental_request_id,
  rr.rental_type,
  rr.start_date,
  rr.end_date,
  rr.quantity,
  rr.pickup_status,
  rr.deposit_required,
  ai.item_type,
  ai.unit_price_cents,
  ai.total_price_cents,
  ao.order_code,
  ao.phone,
  ao.status                 AS order_status,
  ao.payment_status         AS order_payment_status,
  b.booking_code,
  b.guest_name,
  b.check_in,
  b.check_out
FROM rental_requests rr
INNER JOIN add_on_items ai ON ai.id = rr.add_on_item_id
INNER JOIN add_on_orders ao ON ao.id = ai.order_id
INNER JOIN clients c ON c.id = ao.client_id
LEFT JOIN bookings b ON b.id = rr.booking_id
WHERE c.slug = $1
  AND rr.start_date <= $2::date
  AND rr.end_date   >= $2::date
  AND rr.pickup_status NOT IN ('cancelled', 'returned')
ORDER BY rr.rental_type ASC, b.guest_name ASC
`;
}

// ---------------------------------------------------------------------------
// E. Add-ons by booking
// ---------------------------------------------------------------------------

/**
 * All add-on orders and their line items for a given booking_code.
 * Useful for per-guest add-on summary (staff lookup or confirmation email).
 * Ordered by requested_at, then item_type.
 *
 * @returns {string} Parameterised SQL ($1 = client slug, $2 = booking_code TEXT)
 */
function getAddonsByBookingQuery() {
  return `
SELECT
  ao.id::text               AS order_id,
  ao.order_code,
  ao.status                 AS order_status,
  ao.payment_status         AS order_payment_status,
  ao.total_amount_cents,
  ao.requested_at,
  ai.id::text               AS item_id,
  ai.item_type,
  ai.item_name,
  ai.quantity,
  ai.unit_price_cents,
  ai.total_price_cents,
  ai.service_date,
  ai.start_date,
  ai.end_date,
  ai.fulfillment_status,
  b.booking_code,
  b.guest_name,
  b.check_in,
  b.check_out
FROM add_on_orders ao
INNER JOIN clients c ON c.id = ao.client_id
INNER JOIN add_on_items ai ON ai.order_id = ao.id
INNER JOIN bookings b ON b.id = ao.booking_id
WHERE c.slug = $1
  AND b.booking_code = $2
ORDER BY ao.requested_at ASC, ai.item_type ASC
`;
}

// ---------------------------------------------------------------------------
// F. Staff-required add-ons (scheduling needed)
// ---------------------------------------------------------------------------

/**
 * Surf lesson requests that require staff to assign a slot/instructor.
 * Excludes cancelled and already-scheduled lessons.
 * Ordered by lesson_date (nulls last), then preferred_time.
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getStaffRequiredAddOnsQuery() {
  return `
SELECT
  lr.id::text               AS lesson_request_id,
  lr.lesson_date,
  lr.guest_count,
  lr.preferred_time,
  lr.scheduling_status,
  lr.weather_notes,
  ai.item_type,
  ai.quantity,
  ai.total_price_cents,
  ao.order_code,
  ao.phone,
  ao.status                 AS order_status,
  ao.payment_status         AS order_payment_status,
  ao.requested_at,
  b.booking_code,
  b.guest_name,
  b.check_in,
  b.check_out
FROM lesson_requests lr
INNER JOIN add_on_items ai ON ai.id = lr.add_on_item_id
INNER JOIN add_on_orders ao ON ao.id = ai.order_id
INNER JOIN clients c ON c.id = ao.client_id
LEFT JOIN bookings b ON b.id = lr.booking_id
WHERE c.slug = $1
  AND lr.scheduling_status = 'staff_required'
ORDER BY lr.lesson_date ASC NULLS LAST, lr.preferred_time ASC NULLS LAST
`;
}

module.exports = {
  CLIENT_SLUG,
  getUnpaidAddOnsQuery,
  getLessonsByDateQuery,
  getYogaByDateQuery,
  getActiveRentalsByDateQuery,
  getAddonsByBookingQuery,
  getStaffRequiredAddOnsQuery,
};
