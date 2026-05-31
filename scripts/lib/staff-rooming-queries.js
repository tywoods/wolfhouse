/**
 * Stage 5.5 — Staff rooming query helpers.
 *
 * Six read-only SQL queries for pilot/staff rooming and bed assignment operations:
 *   A. getRoomingRosterQuery       — who is assigned where (bed+room per booking)
 *   B. getUnassignedBookingsQuery  — bookings with no bed assignment yet
 *   C. getRoomingReviewQuery       — bookings flagged for rooming review
 *   D. getRoomingPreferencesQuery  — bookings with rooming preferences set
 *   E. getOccupiedBedsQuery        — occupied beds overlapping a date range ($2/$3)
 *   F. getArrivalsNeedingAssignmentQuery — check-ins on/before a cutoff date with no assignment ($2)
 *
 * All queries are scoped by client slug ($1) and are SELECT-only.
 * Schema note: `hostels` was renamed to `clients`, `hostel_id` → `client_id` in migration 003.
 *
 * @module staff-rooming-queries
 */

'use strict';

const CLIENT_SLUG = 'wolfhouse-somo';

// ---------------------------------------------------------------------------
// A. Rooming roster — who is assigned where
// ---------------------------------------------------------------------------

/**
 * All active bed assignments with room/bed detail and booking context.
 * Ordered by assignment_start_date, then room_code, then bed_code.
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getRoomingRosterQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.phone,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.status::text            AS booking_status,
  b.payment_status::text,
  b.assignment_status::text,
  bb.id::text               AS booking_bed_id,
  bb.room_code,
  bb.bed_code,
  bb.assignment_start_date,
  bb.assignment_end_date,
  bb.assignment_label,
  bb.assignment_type,
  bb.planning_row_label,
  bb.guest_name             AS bed_guest_name,
  r.room_type,
  r.gender_strategy,
  r.can_be_matrimonial
FROM booking_beds bb
INNER JOIN bookings b ON b.id = bb.booking_id
INNER JOIN clients c ON c.id = b.client_id
LEFT JOIN beds bd ON bd.id = bb.bed_id
LEFT JOIN rooms r ON r.id = bd.room_id
WHERE c.slug = $1
  AND b.status NOT IN ('cancelled', 'expired')
ORDER BY bb.assignment_start_date ASC, bb.room_code ASC, bb.bed_code ASC
`;
}

// ---------------------------------------------------------------------------
// B. Unassigned bookings
// ---------------------------------------------------------------------------

/**
 * Bookings that are not yet assigned to any bed.
 * Excludes holds, cancellations, and expired bookings.
 * Ordered by check_in date ascending.
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getUnassignedBookingsQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.phone,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.status::text            AS booking_status,
  b.payment_status::text,
  b.assignment_status::text,
  b.requested_room_type,
  b.room_preference,
  b.guest_gender_group_type,
  b.needs_rooming_review,
  b.rooming_notes,
  b.hold_expires_at,
  b.updated_at
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.assignment_status = 'unassigned'
  AND b.status NOT IN ('hold', 'cancelled', 'expired')
ORDER BY b.check_in ASC
`;
}

// ---------------------------------------------------------------------------
// C. Rooming review needed
// ---------------------------------------------------------------------------

/**
 * Bookings explicitly flagged for rooming review (needs_rooming_review=TRUE
 * or assignment_status='needs_review'). May also have low rooming_confidence.
 * Ordered by check_in date ascending.
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getRoomingReviewQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.phone,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.status::text            AS booking_status,
  b.payment_status::text,
  b.assignment_status::text,
  b.needs_rooming_review,
  b.rooming_confidence,
  b.rooming_notes,
  b.conflict_notes,
  b.requested_room_type,
  b.room_preference,
  b.guest_gender_group_type,
  b.primary_room_code,
  b.updated_at
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND (
    b.needs_rooming_review = TRUE
    OR b.assignment_status = 'needs_review'
  )
  AND b.status NOT IN ('cancelled', 'expired')
ORDER BY b.check_in ASC
`;
}

// ---------------------------------------------------------------------------
// D. Rooming preferences
// ---------------------------------------------------------------------------

/**
 * Bookings that have any rooming preference set:
 * requested_room_type, room_preference, guest_gender_group_type, rooming_notes.
 * Ordered by check_in date ascending.
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getRoomingPreferencesQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.phone,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.status::text            AS booking_status,
  b.payment_status::text,
  b.assignment_status::text,
  b.requested_room_type,
  b.room_preference,
  b.guest_gender_group_type,
  b.rooming_notes,
  b.rooming_confidence,
  b.needs_rooming_review,
  b.primary_room_code
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND (
    b.requested_room_type IS NOT NULL
    OR b.room_preference IS NOT NULL
    OR b.guest_gender_group_type IS NOT NULL
    OR (b.rooming_notes IS NOT NULL AND trim(b.rooming_notes) <> '')
  )
  AND b.status NOT IN ('cancelled', 'expired')
ORDER BY b.check_in ASC
`;
}

// ---------------------------------------------------------------------------
// E. Occupied beds for date range
// ---------------------------------------------------------------------------

/**
 * Beds occupied during a given date range (standard half-open overlap:
 * assignment_start_date < to_date AND assignment_end_date > from_date).
 * Ordered by assignment_start_date, room_code, bed_code.
 *
 * @returns {string} Parameterised SQL ($1 = client slug, $2 = from_date DATE, $3 = to_date DATE)
 */
function getOccupiedBedsQuery() {
  return `
SELECT
  bb.id::text               AS booking_bed_id,
  bb.room_code,
  bb.bed_code,
  bb.assignment_start_date,
  bb.assignment_end_date,
  bb.planning_row_label,
  bb.assignment_label,
  bb.guest_name             AS bed_guest_name,
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.phone,
  b.guest_count,
  b.check_in,
  b.check_out,
  b.status::text            AS booking_status,
  b.payment_status::text,
  r.room_type,
  r.gender_strategy
FROM booking_beds bb
INNER JOIN bookings b ON b.id = bb.booking_id
INNER JOIN clients c ON c.id = b.client_id
LEFT JOIN beds bd ON bd.id = bb.bed_id
LEFT JOIN rooms r ON r.id = bd.room_id
WHERE c.slug = $1
  AND bb.assignment_start_date < $3::date
  AND bb.assignment_end_date   > $2::date
  AND b.status NOT IN ('cancelled', 'expired')
ORDER BY bb.assignment_start_date ASC, bb.room_code ASC, bb.bed_code ASC
`;
}

// ---------------------------------------------------------------------------
// F. Arrivals needing assignment
// ---------------------------------------------------------------------------

/**
 * Bookings with check_in on or before a cutoff date that are not yet assigned.
 * Useful for "who arrives today/tomorrow and has no bed?".
 * Excludes cancelled, expired, and hold status bookings.
 * Ordered by check_in ascending.
 *
 * @returns {string} Parameterised SQL ($1 = client slug, $2 = cutoff_date DATE)
 */
function getArrivalsNeedingAssignmentQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.phone,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.status::text            AS booking_status,
  b.payment_status::text,
  b.assignment_status::text,
  b.requested_room_type,
  b.room_preference,
  b.guest_gender_group_type,
  b.rooming_notes,
  b.needs_rooming_review,
  b.hold_expires_at
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.check_in <= $2::date
  AND b.assignment_status = 'unassigned'
  AND b.status NOT IN ('hold', 'cancelled', 'expired')
ORDER BY b.check_in ASC
`;
}

module.exports = {
  CLIENT_SLUG,
  getRoomingRosterQuery,
  getUnassignedBookingsQuery,
  getRoomingReviewQuery,
  getRoomingPreferencesQuery,
  getOccupiedBedsQuery,
  getArrivalsNeedingAssignmentQuery,
};
