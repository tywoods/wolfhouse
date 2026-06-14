/**
 * Postgres assign SQL for 3b.2b CLI and 3b.2c n8n build.
 * Keep in sync with scripts/assign-booking-beds-postgres.js execute path.
 */
const CLIENT_SLUG = 'wolfhouse-somo';
const ASSIGN_NOTES = 'Assigned via Wolfhouse local assign (3b.2b/3b.2c)';

const PG_ASSIGN_SQL = `WITH params AS (
  SELECT
    NULLIF(trim($1), '__NULL__') AS airtable_record_id,
    NULLIF(trim($2), '__NULL__') AS booking_code,
    COALESCE($3::jsonb, '[]'::jsonb) AS beds_json
),
resolved AS (
  SELECT
    b.id,
    b.booking_code,
    b.client_id,
    b.guest_name,
    b.status::text AS status,
    b.payment_status::text AS payment_status
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
beds_input AS (
  SELECT
    upper(trim(elem->>'bed_code')) AS bed_code,
    (elem->>'assignment_start_date')::date AS start_d,
    (elem->>'assignment_end_date')::date AS end_d,
    COALESCE(NULLIF(trim(elem->>'assignment_type'), ''), 'Auto Assigned') AS assignment_type
  FROM params p
  CROSS JOIN jsonb_array_elements(p.beds_json) elem
  WHERE upper(trim(COALESCE(elem->>'bed_code', ''))) <> ''
),
beds_input_count AS (
  SELECT COUNT(*)::int AS c FROM beds_input
),
unknown_beds AS (
  SELECT bi.bed_code
  FROM beds_input bi
  CROSS JOIN guard g
  LEFT JOIN beds bd ON bd.client_id = g.client_id AND upper(bd.bed_code) = bi.bed_code
  WHERE bd.id IS NULL
),
unknown_count AS (
  SELECT COUNT(*)::int AS c FROM unknown_beds
),
overlap_beds AS (
  SELECT DISTINCT bi.bed_code
  FROM beds_input bi
  CROSS JOIN guard g
  INNER JOIN beds bd ON bd.client_id = g.client_id AND upper(bd.bed_code) = bi.bed_code
  INNER JOIN booking_beds bb ON bb.bed_id = bd.id AND bb.client_id = bd.client_id
  INNER JOIN bookings ob ON ob.id = bb.booking_id AND ob.client_id = bb.client_id
  WHERE bb.booking_id <> g.id
    AND ob.status NOT IN ('cancelled', 'expired')
    AND bb.assignment_start_date < bi.end_d
    AND bb.assignment_end_date > bi.start_d
),
overlap_count AS (
  SELECT COUNT(*)::int AS c FROM overlap_beds
),
existing_skip AS (
  SELECT bi.bed_code
  FROM beds_input bi
  CROSS JOIN guard g
  INNER JOIN booking_beds bb ON bb.booking_id = g.id AND bb.client_id = g.client_id
  WHERE upper(bb.bed_code) = bi.bed_code
    AND bb.assignment_start_date = bi.start_d
    AND bb.assignment_end_date = bi.end_d
),
skip_count AS (
  SELECT COUNT(*)::int AS c FROM existing_skip
),
can_mutate AS (
  SELECT
    (SELECT c FROM resolved_count) = 1
    AND (SELECT c FROM unknown_count) = 0
    AND (SELECT c FROM overlap_count) = 0
    AND EXISTS (SELECT 1 FROM guard g WHERE g.status NOT IN ('cancelled', 'expired')) AS ok
),
payments_before AS (
  SELECT COUNT(*)::int AS c
  FROM payments p
  INNER JOIN guard g ON p.booking_id = g.id AND p.client_id = g.client_id
),
to_insert AS (
  SELECT
    bi.bed_code,
    bi.start_d,
    bi.end_d,
    bi.assignment_type,
    bd.id AS bed_id,
    CASE
      WHEN bi.bed_code ~ '^(R[0-9]+)-' THEN upper(substring(bi.bed_code from '^(R[0-9]+)'))
      ELSE NULL
    END AS room_code
  FROM beds_input bi
  CROSS JOIN guard g
  INNER JOIN beds bd ON bd.client_id = g.client_id AND upper(bd.bed_code) = bi.bed_code
  WHERE (SELECT ok FROM can_mutate)
    AND NOT EXISTS (
      SELECT 1 FROM existing_skip es WHERE es.bed_code = bi.bed_code
    )
),
inserted AS (
  INSERT INTO booking_beds (
    client_id,
    booking_id,
    bed_id,
    bed_code,
    room_code,
    assignment_start_date,
    assignment_end_date,
    assignment_type,
    assignment_notes,
    guest_name,
    airtable_record_id
  )
  SELECT
    g.client_id,
    g.id,
    ti.bed_id,
    ti.bed_code,
    ti.room_code,
    ti.start_d,
    ti.end_d,
    ti.assignment_type,
    '${ASSIGN_NOTES.replace(/'/g, "''")}',
    g.guest_name,
    NULL
  FROM to_insert ti
  CROSS JOIN guard g
  RETURNING id
),
updated AS (
  UPDATE bookings b
  SET
    assignment_status = 'assigned'::assignment_status,
    availability_check_status = 'available'::availability_check_status
  FROM guard g
  WHERE b.id = g.id
    AND b.client_id = g.client_id
    AND (SELECT ok FROM can_mutate)
  RETURNING b.id
),
payments_after AS (
  SELECT COUNT(*)::int AS c
  FROM payments p
  INNER JOIN guard g ON p.booking_id = g.id AND p.client_id = g.client_id
)
SELECT
  rc.c AS booking_rows_resolved,
  g.booking_code,
  g.id::text AS booking_id,
  g.status AS booking_status,
  (SELECT c FROM beds_input_count) AS beds_requested_count,
  (SELECT COUNT(*)::int FROM inserted) AS pg_inserted_count,
  (SELECT c FROM skip_count) AS pg_skipped_count,
  (SELECT c FROM overlap_count) AS pg_conflict_count,
  (SELECT c FROM unknown_count) AS pg_unknown_count,
  COALESCE((SELECT jsonb_agg(ub.bed_code ORDER BY ub.bed_code) FROM unknown_beds ub), '[]'::jsonb) AS unknown_bed_codes,
  (SELECT ok FROM can_mutate) AS can_mutate,
  (
    (SELECT c FROM resolved_count) = 1
    AND (SELECT c FROM unknown_count) = 0
    AND (SELECT c FROM overlap_count) = 0
    AND EXISTS (SELECT 1 FROM guard gg WHERE gg.status NOT IN ('cancelled', 'expired'))
  ) AS pg_ok,
  g.payment_status AS payment_status_before,
  (SELECT payment_status::text FROM bookings WHERE id = g.id) AS payment_status_after,
  (SELECT c FROM payments_before) AS payments_count_before,
  (SELECT c FROM payments_after) AS payments_count_after,
  (SELECT COUNT(*)::int FROM updated) AS pg_booking_updated_count
FROM resolved_count rc
LEFT JOIN guard g ON true`;

const PG_CONFLICT_MIRROR_SQL = `WITH params AS (
  SELECT
    NULLIF(trim($1), '__NULL__') AS airtable_record_id,
    NULLIF(trim($2), '__NULL__') AS booking_code
),
resolved AS (
  SELECT b.id, b.client_id, b.booking_code, b.payment_status::text AS payment_status
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
guard AS (
  SELECT r.* FROM resolved r WHERE (SELECT COUNT(*) FROM resolved) = 1
),
updated AS (
  UPDATE bookings b
  SET
    assignment_status = 'needs_review'::assignment_status,
    availability_check_status = 'conflict'::availability_check_status
  FROM guard g
  WHERE b.id = g.id AND b.client_id = g.client_id
  RETURNING b.id
)
SELECT
  (SELECT COUNT(*)::int FROM resolved) AS booking_rows_resolved,
  g.booking_code,
  (SELECT COUNT(*)::int FROM updated) AS pg_booking_updated_count,
  g.payment_status AS payment_status_before,
  (SELECT payment_status::text FROM bookings WHERE id = g.id) AS payment_status_after
FROM guard g`;

const PG_BACKFILL_AIRTABLE_IDS_SQL = `WITH params AS (
  SELECT
    NULLIF(trim($1), '__NULL__') AS airtable_record_id,
    NULLIF(trim($2), '__NULL__') AS booking_code,
    COALESCE($3::jsonb, '[]'::jsonb) AS pairs_json
),
guard AS (
  SELECT b.id, b.client_id, b.booking_code
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  CROSS JOIN params p
  WHERE c.slug = '${CLIENT_SLUG}'
    AND (
      (p.airtable_record_id IS NOT NULL AND b.airtable_record_id = p.airtable_record_id)
      OR (p.booking_code IS NOT NULL AND b.booking_code = p.booking_code)
    )
  LIMIT 1
),
pairs AS (
  SELECT
    upper(trim(elem->>'bed_code')) AS bed_code,
    NULLIF(trim(elem->>'airtable_record_id'), '') AS at_id
  FROM params p
  CROSS JOIN jsonb_array_elements(p.pairs_json) elem
  WHERE upper(trim(COALESCE(elem->>'bed_code', ''))) <> ''
    AND NULLIF(trim(elem->>'airtable_record_id'), '') IS NOT NULL
),
updated AS (
  UPDATE booking_beds bb
  SET airtable_record_id = pr.at_id
  FROM pairs pr
  CROSS JOIN guard g
  WHERE bb.booking_id = g.id
    AND bb.client_id = g.client_id
    AND upper(bb.bed_code) = pr.bed_code
    AND (bb.airtable_record_id IS NULL OR bb.airtable_record_id = '')
  RETURNING bb.id, bb.bed_code, bb.airtable_record_id
)
SELECT
  (SELECT COUNT(*)::int FROM updated) AS pg_backfill_count,
  COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('bed_code', u.bed_code, 'airtable_record_id', u.airtable_record_id) ORDER BY u.bed_code)
     FROM updated u),
    '[]'::jsonb
  ) AS backfilled`;

const PG_MIRROR_ASSIGNED_SQL = `WITH params AS (
  SELECT
    NULLIF(trim($1), '__NULL__') AS airtable_record_id,
    NULLIF(trim($2), '__NULL__') AS booking_code
),
guard AS (
  SELECT b.id, b.client_id, b.booking_code
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  CROSS JOIN params p
  WHERE c.slug = '${CLIENT_SLUG}'
    AND (
      (p.airtable_record_id IS NOT NULL AND b.airtable_record_id = p.airtable_record_id)
      OR (p.booking_code IS NOT NULL AND b.booking_code = p.booking_code)
    )
  LIMIT 1
),
updated AS (
  UPDATE bookings b
  SET
    assignment_status = 'assigned'::assignment_status,
    availability_check_status = 'available'::availability_check_status
  FROM guard g
  WHERE b.id = g.id AND b.client_id = g.client_id
  RETURNING b.id
)
SELECT
  (SELECT COUNT(*)::int FROM updated) AS pg_booking_updated_count,
  g.booking_code
FROM guard g`;

module.exports = {
  CLIENT_SLUG,
  ASSIGN_NOTES,
  PG_ASSIGN_SQL,
  PG_CONFLICT_MIRROR_SQL,
  PG_BACKFILL_AIRTABLE_IDS_SQL,
  PG_MIRROR_ASSIGNED_SQL,
};
