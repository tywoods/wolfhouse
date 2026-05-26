/**
 * Phase 3b.4c — n8n Postgres node SQL for Manual Entries local fork.
 * Keep in sync with scripts/lib/manual-entry-pg-sql.js (deleteBedsAndCancelBooking).
 */
const CLIENT_SLUG = 'wolfhouse-somo';

/** Mirrors manual-entry-pg-sql.js deleteBedsAndCancelBooking + impact-plan booking lookup. */
const PG_MANUAL_ENTRY_DELETE_SQL = `WITH params AS (
  SELECT
    NULLIF(trim($1), '__NULL__') AS airtable_record_id,
    NULLIF(trim($2), '__NULL__') AS booking_code,
    NULLIF(trim($3), '__NULL__') AS manual_entry_id
),
resolved AS (
  SELECT
    b.id,
    b.booking_code,
    b.status::text AS status,
    b.payment_status::text AS payment_status,
    c.id AS client_id
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  CROSS JOIN params p
  WHERE c.slug = '${CLIENT_SLUG}'
    AND (
      (p.airtable_record_id IS NOT NULL AND b.airtable_record_id = p.airtable_record_id)
      OR (p.booking_code IS NOT NULL AND b.booking_code = p.booking_code)
      OR (p.manual_entry_id IS NOT NULL AND b.metadata->>'manual_entry_id' = p.manual_entry_id)
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
payments_before AS (
  SELECT COUNT(*)::int AS c
  FROM payments p
  INNER JOIN guard g ON p.booking_id = g.id AND p.client_id = g.client_id
),
beds_before AS (
  SELECT COUNT(*)::int AS c
  FROM booking_beds bb
  INNER JOIN guard g ON bb.booking_id = g.id AND bb.client_id = g.client_id
),
deleted AS (
  DELETE FROM booking_beds bb
  USING guard g
  WHERE bb.booking_id = g.id AND bb.client_id = g.client_id
  RETURNING bb.id
),
updated AS (
  UPDATE bookings b
  SET
    status = 'cancelled'::booking_status,
    assignment_status = 'needs_review'::assignment_status,
    availability_check_status = 'needs_review'::availability_check_status
  FROM guard g
  WHERE b.id = g.id AND b.client_id = g.client_id
  RETURNING b.id, b.status::text AS status_after
)
SELECT
  rc.c AS booking_rows_resolved,
  g.booking_code,
  g.id::text AS booking_id,
  g.status AS status_before,
  COALESCE((SELECT status_after FROM updated LIMIT 1), g.status) AS status_after,
  g.payment_status AS payment_status_before,
  (SELECT payment_status::text FROM bookings WHERE id = g.id) AS payment_status_after,
  (SELECT c FROM beds_before) AS beds_before_count,
  (SELECT COUNT(*)::int FROM deleted) AS pg_deleted_count,
  (SELECT COUNT(*)::int FROM updated) AS pg_booking_updated_count,
  (SELECT c FROM payments_before) AS payments_count
FROM resolved_count rc
LEFT JOIN guard g ON true`;

module.exports = {
  CLIENT_SLUG,
  PG_MANUAL_ENTRY_DELETE_SQL,
};
