/**
 * Stage 8.3h — SELECT-only query helpers for manual booking preview endpoint.
 *
 * NOT WIRED TO WRITES — all queries are SELECT only.
 * No INSERT / UPDATE / DELETE.
 * No Stripe / WhatsApp / n8n.
 * No side effects.
 *
 * Exported query builders:
 *   A. getManualBookingPreviewBedsQuery
 *      Returns bed metadata for an array of bed codes, scoped to client.
 *
 *   B. getManualBookingPreviewAssignmentsQuery
 *      Returns existing booking_beds rows (with booking status context) that
 *      overlap or are adjacent to the proposed date range, for all selected
 *      beds.  Uses the same half-open overlap rule as the availability helper:
 *        assignment_start_date < proposed_check_out
 *        assignment_end_date   > proposed_check_in
 *      Does NOT pre-filter cancelled/expired — the caller receives all statuses
 *      so the JS preview helper can apply the non-blocking exclusion logic and
 *      return a transparent result.  This keeps the query output honest.
 *
 *   C. getClientIdBySlugQuery
 *      Returns the client UUID from a slug.  Used to scope the preview.
 *
 * Parameter conventions (same as staff-bed-calendar-queries.js):
 *   All queries use $1, $2, … positional placeholders.
 *   Client slug is always $1.
 *   All user-supplied values must be passed as pg parameters — never
 *   interpolated into the SQL string.
 *
 * @module staff-manual-booking-preview-queries
 */

'use strict';

// ---------------------------------------------------------------------------
// A. Bed metadata for selected bed codes
// ---------------------------------------------------------------------------

/**
 * Returns one row per bed code found for the given client + bed codes array.
 * Includes active/sellable flags, room metadata.
 *
 * @returns {string} Parameterised SQL
 *   $1 = client slug TEXT
 *   $2 = bed_codes TEXT[] (array of bed code strings)
 */
function getManualBookingPreviewBedsQuery() {
  return `
SELECT
  bd.id::text         AS bed_id,
  bd.bed_code,
  bd.bed_label,
  bd.active           AS active,
  bd.sellable         AS sellable,
  r.id::text          AS room_id,
  r.room_code,
  r.name              AS room_name,
  r.room_type,
  r.capacity          AS room_capacity,
  r.gender_strategy
FROM beds bd
INNER JOIN rooms r    ON r.id         = bd.room_id
                     AND r.client_id  = bd.client_id
INNER JOIN clients c  ON c.id         = bd.client_id
WHERE c.slug     = $1
  AND bd.bed_code = ANY($2::text[])
ORDER BY r.room_code ASC, bd.bed_code ASC
`;
}

// ---------------------------------------------------------------------------
// B. Existing assignments overlapping the proposed date range
// ---------------------------------------------------------------------------

/**
 * Returns booking_beds rows (+ booking status context) whose assignment range
 * overlaps the proposed check_in / check_out using the half-open interval:
 *
 *   assignment_start_date < proposed_check_out   ($3)
 *   assignment_end_date   > proposed_check_in    ($2)
 *
 * Scoped to the selected bed codes AND the client.
 *
 * ALL booking statuses are returned — including cancelled/expired — so the
 * JS availability helper can apply the non-blocking exclusion transparently
 * and return a complete picture of what exists on those beds.
 *
 * @returns {string} Parameterised SQL
 *   $1 = client slug       TEXT
 *   $2 = proposed_check_in DATE   (start of proposed range, inclusive)
 *   $3 = proposed_check_out DATE  (end of proposed range, exclusive)
 *   $4 = bed_codes         TEXT[] (array of selected bed code strings)
 */
function getManualBookingPreviewAssignmentsQuery() {
  return `
SELECT
  bb.id::text                             AS booking_bed_id,
  bb.bed_code,
  bb.room_code,
  bb.assignment_start_date::text          AS assignment_start_date,
  bb.assignment_end_date::text            AS assignment_end_date,
  bb.assignment_type,
  bb.guest_name                           AS bed_guest_name,
  b.id::text                              AS booking_id,
  b.booking_code,
  b.status::text                          AS booking_status,
  b.payment_status::text                  AS payment_status,
  b.assignment_status::text               AS assignment_status,
  b.guest_name,
  b.check_in::text                        AS check_in,
  b.check_out::text                       AS check_out
FROM booking_beds bb
INNER JOIN bookings b  ON b.id       = bb.booking_id
INNER JOIN clients  c  ON c.id       = bb.client_id
WHERE c.slug                        = $1
  AND bb.assignment_start_date      < $3::date
  AND bb.assignment_end_date        > $2::date
  AND bb.bed_code                   = ANY($4::text[])
ORDER BY bb.bed_code ASC, bb.assignment_start_date ASC
`;
}

// ---------------------------------------------------------------------------
// C. Client ID lookup by slug
// ---------------------------------------------------------------------------

/**
 * Returns the client UUID and slug for a given client slug.
 * Returns zero rows if the slug is not found.
 *
 * @returns {string} Parameterised SQL
 *   $1 = client slug TEXT
 */
function getClientIdBySlugQuery() {
  return `
SELECT id::text AS client_id, slug AS client_slug
FROM clients
WHERE slug = $1
LIMIT 1
`;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getManualBookingPreviewBedsQuery,
  getManualBookingPreviewAssignmentsQuery,
  getClientIdBySlugQuery,
};
