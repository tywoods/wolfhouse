/**
 * Stage 7.7g — Bed calendar query helpers.
 *
 * Two SELECT-only SQL queries for the Cami dashboard bed calendar:
 *   A. getBedCalendarRoomsQuery   — rooms + their beds, ordered for grid rows
 *   B. getBedCalendarBlocksQuery  — booking_beds blocks overlapping a date range
 *
 * Both queries are scoped by client slug ($1) and are SELECT-only.
 * The blocks query also takes $2 (start_date DATE) and $3 (end_date DATE)
 * using the standard half-open overlap:
 *   assignment_start_date < end_date AND assignment_end_date > start_date
 *
 * Schema note: hostel_id was renamed to client_id in migration 003.
 *
 * @module staff-bed-calendar-queries
 */

'use strict';

const {
  wolfhouseExcludeDemoRoomsSql,
  wolfhouseExcludeDemoBookingsSql,
} = require('./wolfhouse-inventory-source');

// ---------------------------------------------------------------------------
// A. Room + bed hierarchy (grid rows)
// ---------------------------------------------------------------------------

/**
 * Returns all active rooms and their active beds for a client.
 * SQL ORDER BY fill_priority supports Luna assignment; Staff Portal UI re-sorts
 * rows by natural room_code (R1–R10) for display only.
 * One row per bed. Rooms with no beds still appear (with NULL bed columns).
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getBedCalendarRoomsQuery() {
  return `
SELECT
  r.id::text                AS room_id,
  r.room_code,
  r.name                    AS room_name,
  r.house,
  r.room_type,
  r.capacity,
  r.fill_priority,
  COALESCE(r.sort_order, r.fill_priority, 999) AS room_sort_order,
  r.gender_strategy,
  r.can_be_matrimonial,
  bd.id::text               AS bed_id,
  bd.bed_code,
  bd.bed_label,
  bd.bed_number,
  bd.planning_row_label     AS bed_planning_label,
  bd.active                 AS bed_active,
  bd.sellable               AS bed_sellable
FROM rooms r
INNER JOIN clients c ON c.id = r.client_id
LEFT JOIN beds bd ON bd.room_id = r.id AND bd.client_id = r.client_id AND bd.active = TRUE
WHERE c.slug = $1
  AND r.active = TRUE
  ${wolfhouseExcludeDemoRoomsSql('r')}
ORDER BY
  COALESCE(r.fill_priority, r.sort_order, 999) ASC,
  r.room_code ASC,
  COALESCE(bd.bed_number, 999) ASC,
  bd.bed_code ASC
`;
}

// ---------------------------------------------------------------------------
// B. Booking-bed blocks overlapping a date range
// ---------------------------------------------------------------------------

/**
 * booking_beds rows (with booking context) whose date range overlaps
 * [start_date, end_date) — standard half-open interval overlap:
 *   assignment_start_date < end_date AND assignment_end_date > start_date
 *
 * Ordered by room_code, bed_code, assignment_start_date for deterministic
 * rendering in the calendar grid.
 *
 * @returns {string} Parameterised SQL
 *   $1 = client slug TEXT
 *   $2 = start_date DATE (inclusive)
 *   $3 = end_date DATE   (exclusive — first day NOT shown)
 */
function getBedCalendarBlocksQuery() {
  return `
SELECT
  bb.id::text               AS booking_bed_id,
  COALESCE(NULLIF(bb.room_code, ''), r.room_code) AS room_code,
  bb.bed_code,
  bb.assignment_start_date::text  AS assignment_start_date,
  bb.assignment_end_date::text    AS assignment_end_date,
  bb.planning_row_label,
  bb.assignment_label,
  bb.assignment_type,
  bb.guest_name             AS bed_guest_name,
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.phone,
  b.guest_count,
  b.check_in::text          AS check_in,
  b.check_out::text         AS check_out,
  b.status::text            AS booking_status,
  b.payment_status::text    AS payment_status,
  b.assignment_status::text AS assignment_status,
  b.needs_rooming_review,
  b.primary_room_code,
  r.room_type,
  r.name                    AS room_name
FROM booking_beds bb
INNER JOIN bookings b ON b.id = bb.booking_id
INNER JOIN clients c ON c.id = b.client_id
LEFT JOIN beds bd ON bd.id = bb.bed_id
LEFT JOIN rooms r ON r.id = bd.room_id
WHERE c.slug = $1
  AND bb.assignment_start_date < $3::date
  AND bb.assignment_end_date   > $2::date
  AND b.status NOT IN ('cancelled', 'expired')
  ${wolfhouseExcludeDemoBookingsSql('b', 'bb')}
ORDER BY bb.room_code ASC, bb.bed_code ASC, bb.assignment_start_date ASC
`;
}

// ---------------------------------------------------------------------------
// C. Summary counts (optional — nice-to-have for badge/header)
// ---------------------------------------------------------------------------

/**
 * Aggregate counts of blocks within the date range, grouped by color_type
 * proxy fields so the UI can show a quick summary without iterating blocks.
 *
 * @returns {string} Parameterised SQL ($1 = client slug, $2 = start, $3 = end)
 */
function getBedCalendarSummaryQuery() {
  return `
SELECT
  b.status::text            AS booking_status,
  b.payment_status::text    AS payment_status,
  b.assignment_status::text AS assignment_status,
  COUNT(*)                  AS block_count
FROM booking_beds bb
INNER JOIN bookings b ON b.id = bb.booking_id
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND bb.assignment_start_date < $3::date
  AND bb.assignment_end_date   > $2::date
  AND b.status NOT IN ('cancelled', 'expired')
  ${wolfhouseExcludeDemoBookingsSql('b', 'bb', 'c')}
GROUP BY b.status, b.payment_status, b.assignment_status
ORDER BY b.status, b.payment_status
`;
}

module.exports = {
  getBedCalendarRoomsQuery,
  getBedCalendarBlocksQuery,
  getBedCalendarSummaryQuery,
};
