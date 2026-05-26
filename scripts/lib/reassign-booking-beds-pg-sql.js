/**
 * Postgres SQL for Phase 3b.3b local Reassign fork.
 * Keep in sync with scripts/build-reassign-beds-local.js
 *
 * Step 1: DELETE all booking_beds for booking (reassign reset).
 * Step 2 (after Airtable mark Unassigned): mirror unassigned / unknown on bookings.
 * (PG enum has no not_checked; maps Airtable "Not Checked".)
 * Does NOT touch payments, payment_events, payment_status, or bookings.status.
 */
const CLIENT_SLUG = 'wolfhouse-somo';

const PG_REASSIGN_DELETE_SQL = `WITH params AS (
  SELECT
    NULLIF(trim($1), '__NULL__') AS airtable_record_id,
    NULLIF(trim($2), '__NULL__') AS booking_code
),
resolved AS (
  SELECT
    b.id,
    b.booking_code,
    b.payment_status::text AS payment_status,
    c.id AS client_id
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  CROSS JOIN params p
  WHERE c.slug = '${CLIENT_SLUG}'
    AND (
      (p.airtable_record_id IS NOT NULL AND b.airtable_record_id = p.airtable_record_id)
      OR (p.booking_code IS NOT NULL AND b.booking_code = p.booking_code)
    )
  LIMIT 2
),
resolved_count AS (
  SELECT COUNT(*)::int AS c FROM resolved
),
guard AS (
  SELECT r.*
  FROM resolved r
  WHERE (SELECT c FROM resolved_count) = 1
),
beds_before AS (
  SELECT COUNT(*)::int AS c
  FROM booking_beds bb
  INNER JOIN guard r ON bb.booking_id = r.id AND bb.client_id = r.client_id
),
deleted AS (
  DELETE FROM booking_beds bb
  USING guard r
  WHERE bb.booking_id = r.id AND bb.client_id = r.client_id
  RETURNING bb.id
)
SELECT
  rc.c AS booking_rows_resolved,
  r.booking_code,
  r.id::text AS booking_id,
  r.payment_status AS payment_status_before,
  (SELECT payment_status::text FROM bookings WHERE id = r.id) AS payment_status_after,
  (SELECT c FROM beds_before) AS beds_before_count,
  (SELECT COUNT(*)::int FROM deleted) AS pg_deleted_count,
  (SELECT COUNT(*)::int FROM payments p INNER JOIN guard g ON p.booking_id = g.id) AS payments_count
FROM resolved_count rc
LEFT JOIN guard r ON true`;

const PG_MIRROR_REASSIGN_READY_SQL = `WITH params AS (
  SELECT
    NULLIF(trim($1), '__NULL__') AS airtable_record_id,
    NULLIF(trim($2), '__NULL__') AS booking_code
),
resolved AS (
  SELECT b.id, b.booking_code, c.id AS client_id
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  CROSS JOIN params p
  WHERE c.slug = '${CLIENT_SLUG}'
    AND (
      (p.airtable_record_id IS NOT NULL AND b.airtable_record_id = p.airtable_record_id)
      OR (p.booking_code IS NOT NULL AND b.booking_code = p.booking_code)
    )
  LIMIT 2
),
resolved_count AS (
  SELECT COUNT(*)::int AS c FROM resolved
),
guard AS (
  SELECT r.*
  FROM resolved r
  WHERE (SELECT c FROM resolved_count) = 1
),
updated AS (
  UPDATE bookings b
  SET
    assignment_status = 'unassigned',
    availability_check_status = 'unknown'
  FROM guard r
  WHERE b.id = r.id AND b.client_id = r.client_id
  RETURNING b.id
)
SELECT
  rc.c AS booking_rows_resolved,
  (SELECT booking_code FROM guard LIMIT 1) AS booking_code,
  (SELECT COUNT(*)::int FROM updated) AS pg_reassign_ready_count,
  (SELECT assignment_status::text FROM bookings b INNER JOIN guard g ON b.id = g.id) AS assignment_status_after,
  (SELECT availability_check_status::text FROM bookings b INNER JOIN guard g ON b.id = g.id) AS availability_check_status_after
FROM resolved_count rc`;

const NULL_SENTINEL = '__NULL__';

function pgQueryReplacement(parseNodeName) {
  return `={{ (($('${parseNodeName}').first().json.airtable_record_id) != null && String($('${parseNodeName}').first().json.airtable_record_id).trim() !== '') ? String($('${parseNodeName}').first().json.airtable_record_id).trim() : '${NULL_SENTINEL}' }},={{ (($('${parseNodeName}').first().json.booking_code) != null && String($('${parseNodeName}').first().json.booking_code).trim() !== '') ? String($('${parseNodeName}').first().json.booking_code).trim() : '${NULL_SENTINEL}' }}`;
}

module.exports = {
  CLIENT_SLUG,
  PG_REASSIGN_DELETE_SQL,
  PG_MIRROR_REASSIGN_READY_SQL,
  NULL_SENTINEL,
  pgQueryReplacement,
};
