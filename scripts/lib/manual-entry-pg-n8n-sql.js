/**
 * Phase 3b.4c — n8n Postgres node SQL for Manual Entries local fork.
 * Keep in sync with scripts/lib/manual-entry-pg-sql.js
 * (deleteBedsAndCancelBooking, updateBookingFields / buildBookingFieldDiff).
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

/**
 * Mirrors manual-entry-pg-sql.js updateBookingFields + impact-plan buildBookingFieldDiff.
 * Booking fields only; no booking_beds. Params $1–$3 resolve; $4–$13 are proposed values (__NULL__ = skip).
 */
const PG_MANUAL_ENTRY_UPDATE_SQL = `WITH params AS (
  SELECT
    NULLIF(trim($1), '__NULL__') AS airtable_record_id,
    NULLIF(trim($2), '__NULL__') AS booking_code,
    NULLIF(trim($3), '__NULL__') AS manual_entry_id,
    NULLIF(trim($4), '__NULL__') AS guest_name,
    NULLIF(trim($5), '__NULL__')::date AS check_in,
    NULLIF(trim($6), '__NULL__')::date AS check_out,
    NULLIF(NULLIF(trim($7), '__NULL__'), '')::int AS guest_count,
    NULLIF(trim($8), '__NULL__') AS status,
    NULLIF(trim($9), '__NULL__') AS payment_status,
    NULLIF(trim($10), '__NULL__') AS package_code,
    NULLIF(trim($11), '__NULL__') AS phone,
    NULLIF(trim($12), '__NULL__') AS email,
    NULLIF(trim($13), '__NULL__') AS notes
),
resolved AS (
  SELECT
    b.id,
    b.booking_code,
    b.guest_name,
    b.check_in,
    b.check_out,
    b.guest_count,
    b.status::text AS status,
    b.payment_status::text AS payment_status,
    b.package_code,
    b.phone,
    b.email,
    b.staff_notes,
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
  SELECT r.*, p.manual_entry_id AS p_manual_entry_id
  FROM resolved r
  CROSS JOIN params p
  WHERE (SELECT c FROM resolved_count) = 1
),
payments_before AS (
  SELECT COUNT(*)::int AS c
  FROM payments pay
  INNER JOIN guard g ON pay.booking_id = g.id AND pay.client_id = g.client_id
),
diff AS (
  SELECT
    g.id AS booking_id,
    g.client_id,
    g.booking_code,
    g.p_manual_entry_id,
    g.payment_status AS payment_status_before,
    (p.guest_name IS NOT NULL AND p.guest_name IS DISTINCT FROM g.guest_name) AS ch_guest_name,
    (p.check_in IS NOT NULL AND p.check_in IS DISTINCT FROM g.check_in) AS ch_check_in,
    (p.check_out IS NOT NULL AND p.check_out IS DISTINCT FROM g.check_out) AS ch_check_out,
    (p.guest_count IS NOT NULL AND p.guest_count IS DISTINCT FROM g.guest_count) AS ch_guest_count,
    (p.status IS NOT NULL AND p.status IS DISTINCT FROM g.status) AS ch_status,
    (p.payment_status IS NOT NULL AND p.payment_status IS DISTINCT FROM g.payment_status) AS ch_payment_status,
    (p.package_code IS NOT NULL AND p.package_code IS DISTINCT FROM g.package_code) AS ch_package_code,
    (p.phone IS NOT NULL AND p.phone IS DISTINCT FROM COALESCE(g.phone, '')) AS ch_phone,
    (p.email IS NOT NULL AND p.email IS DISTINCT FROM COALESCE(g.email, '')) AS ch_email,
    (p.notes IS NOT NULL AND trim(p.notes) <> '') AS ch_notes
  FROM guard g
  CROSS JOIN params p
),
has_change AS (
  SELECT
    d.*,
    (
      d.ch_guest_name OR d.ch_check_in OR d.ch_check_out OR d.ch_guest_count
      OR d.ch_status OR d.ch_payment_status OR d.ch_package_code
      OR d.ch_phone OR d.ch_email OR d.ch_notes
    ) AS any_change
  FROM diff d
),
updated AS (
  UPDATE bookings b
  SET
    guest_name = CASE WHEN h.ch_guest_name THEN p.guest_name ELSE b.guest_name END,
    check_in = CASE WHEN h.ch_check_in THEN p.check_in ELSE b.check_in END,
    check_out = CASE WHEN h.ch_check_out THEN p.check_out ELSE b.check_out END,
    guest_count = CASE WHEN h.ch_guest_count THEN p.guest_count ELSE b.guest_count END,
    status = CASE WHEN h.ch_status THEN p.status::booking_status ELSE b.status END,
    payment_status = CASE WHEN h.ch_payment_status THEN p.payment_status::payment_status ELSE b.payment_status END,
    package_code = CASE WHEN h.ch_package_code THEN p.package_code ELSE b.package_code END,
    phone = CASE WHEN h.ch_phone THEN p.phone ELSE b.phone END,
    email = CASE WHEN h.ch_email THEN p.email ELSE b.email END,
    staff_notes = CASE
      WHEN h.ch_notes THEN
        trim(
          both E'\\n' from (
            COALESCE(b.staff_notes, '')
            || CASE
              WHEN COALESCE(b.staff_notes, '') LIKE '%' || COALESCE(h.p_manual_entry_id, '') || '%' THEN ''
              ELSE E'\\nManual Entry ID: ' || COALESCE(h.p_manual_entry_id, '')
            END
            || E'\\n'
            || p.notes
          )
        )
      ELSE b.staff_notes
    END
  FROM has_change h
  CROSS JOIN params p
  WHERE b.id = h.booking_id AND b.client_id = h.client_id AND h.any_change
  RETURNING b.id, b.booking_code, b.payment_status::text AS payment_status_after
)
SELECT
  rc.c AS booking_rows_resolved,
  h.booking_code,
  h.booking_id::text AS booking_id,
  h.payment_status_before,
  COALESCE((SELECT payment_status_after FROM updated LIMIT 1), h.payment_status_before) AS payment_status_after,
  (SELECT COUNT(*)::int FROM updated) AS pg_booking_updated_count,
  CASE
    WHEN h.booking_id IS NOT NULL AND NOT COALESCE(h.any_change, false) THEN true
    ELSE false
  END AS idempotent,
  (SELECT c FROM payments_before) AS payments_count,
  (SELECT COUNT(*)::int FROM payments pay INNER JOIN guard g ON pay.booking_id = g.id) AS payments_count_after
FROM resolved_count rc
LEFT JOIN has_change h ON true`;

const CREATE_ASSIGN_NOTES = 'Mirrored via manual-entry-postgres (3b.4c local fork)';
const PENDING_BOOKING_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Mirrors manual-entry-pg-sql.js upsertBookingForCreate + loadCreateBedPlan +
 * partitionBedsForInsert + insertBookingBeds (strict overlap; no payments writes).
 * Params $1–$11 fields; $12 beds_json [{ bed_code, assignment_start_date, assignment_end_date }].
 */
const PG_MANUAL_ENTRY_CREATE_SQL = `WITH params AS (
  SELECT
    NULLIF(trim($1), '__NULL__') AS manual_entry_id,
    NULLIF(trim($2), '__NULL__') AS guest_name,
    NULLIF(trim($3), '__NULL__')::date AS check_in,
    NULLIF(trim($4), '__NULL__')::date AS check_out,
    COALESCE(NULLIF(NULLIF(trim($5), '__NULL__'), '')::int, 1) AS guest_count,
    NULLIF(trim($6), '__NULL__') AS status,
    NULLIF(trim($7), '__NULL__') AS payment_status,
    NULLIF(trim($8), '__NULL__') AS package_code,
    NULLIF(trim($9), '__NULL__') AS phone,
    NULLIF(trim($10), '__NULL__') AS email,
    NULLIF(trim($11), '__NULL__') AS notes,
    COALESCE($12::jsonb, '[]'::jsonb) AS beds_json,
    (
      'WH-pending-'
      || regexp_replace(
        substring(COALESCE(NULLIF(trim($1), '__NULL__'), 'unknown') from 1 for 80),
        '[^[:alnum:]_-]',
        '_',
        'g'
      )
    ) AS provisional_booking_code
),
client AS (
  SELECT id AS client_id FROM clients WHERE slug = '${CLIENT_SLUG}' LIMIT 1
),
client_count AS (
  SELECT COUNT(*)::int AS c FROM client
),
dup_meta AS (
  SELECT b.id, b.booking_code, b.status::text AS status, b.payment_status::text AS payment_status
  FROM bookings b
  INNER JOIN client c ON c.client_id = b.client_id
  CROSS JOIN params p
  WHERE p.manual_entry_id IS NOT NULL
    AND b.metadata->>'manual_entry_id' = p.manual_entry_id
),
dup_meta_count AS (
  SELECT COUNT(*)::int AS c FROM dup_meta
),
existing_booking AS (
  SELECT b.id, b.client_id, b.booking_code, b.status::text AS status, b.payment_status::text AS payment_status,
         b.staff_notes
  FROM bookings b
  INNER JOIN client c ON c.client_id = b.client_id
  CROSS JOIN params p
  WHERE (
    (p.manual_entry_id IS NOT NULL AND b.metadata->>'manual_entry_id' = p.manual_entry_id)
    OR b.booking_code = p.provisional_booking_code
  )
  LIMIT 2
),
existing_count AS (
  SELECT COUNT(*)::int AS c FROM existing_booking
),
overlap_booking_id AS (
  SELECT COALESCE(
    (SELECT id FROM dup_meta LIMIT 1),
    (SELECT id FROM existing_booking LIMIT 1),
    '${PENDING_BOOKING_ID}'::uuid
  ) AS id
),
beds_input AS (
  SELECT
    upper(trim(elem->>'bed_code')) AS bed_code,
    (elem->>'assignment_start_date')::date AS start_d,
    (elem->>'assignment_end_date')::date AS end_d
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
  CROSS JOIN client c
  LEFT JOIN beds bd ON bd.client_id = c.client_id AND upper(bd.bed_code) = bi.bed_code
  WHERE bd.id IS NULL
),
unknown_count AS (
  SELECT COUNT(*)::int AS c FROM unknown_beds
),
overlap_beds AS (
  SELECT DISTINCT bi.bed_code
  FROM beds_input bi
  CROSS JOIN client c
  CROSS JOIN overlap_booking_id ob
  INNER JOIN beds bd ON bd.client_id = c.client_id AND upper(bd.bed_code) = bi.bed_code
  INNER JOIN booking_beds bb ON bb.bed_id = bd.id AND bb.client_id = bd.client_id
  INNER JOIN bookings otb ON otb.id = bb.booking_id AND otb.client_id = bb.client_id
  WHERE bb.booking_id <> ob.id
    AND otb.status NOT IN ('cancelled', 'expired')
    AND bb.assignment_start_date < bi.end_d
    AND bb.assignment_end_date > bi.start_d
),
overlap_count AS (
  SELECT COUNT(*)::int AS c FROM overlap_beds
),
precheck_ok AS (
  SELECT
    (SELECT c FROM client_count) = 1
    AND (SELECT c FROM dup_meta_count) <= 1
    AND (SELECT c FROM existing_count) <= 1
    AND (SELECT c FROM unknown_count) = 0
    AND (SELECT c FROM overlap_count) = 0
    AND (SELECT c FROM beds_input_count) > 0
    AND p.manual_entry_id IS NOT NULL
    AND p.guest_name IS NOT NULL
    AND p.check_in IS NOT NULL
    AND p.check_out IS NOT NULL AS ok
  FROM params p
),
booking_updated AS (
  UPDATE bookings b
  SET
    guest_name = COALESCE(p.guest_name, b.guest_name),
    check_in = COALESCE(p.check_in, b.check_in),
    check_out = COALESCE(p.check_out, b.check_out),
    guest_count = COALESCE(p.guest_count, b.guest_count),
    status = COALESCE(p.status::booking_status, b.status),
    payment_status = COALESCE(p.payment_status::payment_status, b.payment_status),
    package_code = COALESCE(p.package_code, b.package_code),
    phone = COALESCE(p.phone, b.phone),
    email = COALESCE(p.email, b.email),
    staff_notes = trim(
      both E'\\n' from (
        COALESCE(b.staff_notes, '')
        || CASE
          WHEN COALESCE(b.staff_notes, '') LIKE '%' || p.manual_entry_id || '%' THEN ''
          ELSE E'\\nManual Entry ID: ' || p.manual_entry_id
        END
        || CASE WHEN p.notes IS NOT NULL AND trim(p.notes) <> '' THEN E'\\n' || p.notes ELSE '' END
      )
    ),
    booking_source = 'manual_staff',
    metadata = COALESCE(b.metadata, '{}'::jsonb) || jsonb_build_object('manual_entry_id', p.manual_entry_id),
    assignment_status = 'assigned'::assignment_status,
    availability_check_status = 'available'::availability_check_status
  FROM existing_booking eb
  CROSS JOIN params p
  WHERE (SELECT ok FROM precheck_ok)
    AND (SELECT c FROM existing_count) = 1
    AND eb.status NOT IN ('cancelled', 'expired')
    AND b.id = eb.id
    AND b.client_id = eb.client_id
  RETURNING b.id, b.client_id, b.booking_code, b.status::text AS status, b.payment_status::text AS payment_status,
    false AS created
),
booking_inserted AS (
  INSERT INTO bookings (
    client_id,
    booking_code,
    guest_name,
    phone,
    email,
    status,
    payment_status,
    assignment_status,
    availability_check_status,
    check_in,
    check_out,
    guest_count,
    package_code,
    booking_source,
    staff_notes,
    metadata
  )
  SELECT
    c.client_id,
    p.provisional_booking_code,
    p.guest_name,
    p.phone,
    p.email,
    COALESCE(p.status, 'confirmed')::booking_status,
    COALESCE(p.payment_status, 'waiting_payment')::payment_status,
    'assigned'::assignment_status,
    'available'::availability_check_status,
    p.check_in,
    p.check_out,
    p.guest_count,
    p.package_code,
    'manual_staff',
    trim(
      both E'\\n' from (
        'Manual Entry ID: ' || p.manual_entry_id
        || CASE WHEN p.notes IS NOT NULL AND trim(p.notes) <> '' THEN E'\\n' || p.notes ELSE '' END
      )
    ),
    jsonb_build_object('manual_entry_id', p.manual_entry_id)
  FROM params p
  CROSS JOIN client c
  WHERE (SELECT ok FROM precheck_ok)
    AND (SELECT c FROM existing_count) = 0
  RETURNING id, client_id, booking_code, status::text AS status, payment_status::text AS payment_status,
    true AS created
),
booking_final AS (
  SELECT * FROM booking_updated
  UNION ALL
  SELECT * FROM booking_inserted
),
guard AS (
  SELECT bf.* FROM booking_final bf LIMIT 1
),
payments_before AS (
  SELECT COUNT(*)::int AS c
  FROM payments pay
  INNER JOIN guard g ON pay.booking_id = g.id AND pay.client_id = g.client_id
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
to_insert AS (
  SELECT
    bi.bed_code,
    bi.start_d,
    bi.end_d,
    bd.id AS bed_id,
    CASE
      WHEN bi.bed_code ~ '^(R[0-9]+)-' THEN upper(substring(bi.bed_code from '^(R[0-9]+)'))
      ELSE NULL
    END AS room_code
  FROM beds_input bi
  CROSS JOIN guard g
  INNER JOIN beds bd ON bd.client_id = g.client_id AND upper(bd.bed_code) = bi.bed_code
  WHERE (SELECT ok FROM precheck_ok)
    AND NOT EXISTS (SELECT 1 FROM existing_skip es WHERE es.bed_code = bi.bed_code)
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
    'Manual Staff',
    '${CREATE_ASSIGN_NOTES.replace(/'/g, "''")}',
    p.guest_name,
    NULL
  FROM to_insert ti
  CROSS JOIN guard g
  CROSS JOIN params p
  RETURNING id
),
payments_after AS (
  SELECT COUNT(*)::int AS c
  FROM payments pay
  INNER JOIN guard g ON pay.booking_id = g.id AND pay.client_id = g.client_id
)
SELECT
  (SELECT c FROM dup_meta_count) AS duplicate_manual_entry_count,
  (SELECT c FROM existing_count) AS existing_booking_count,
  (SELECT c FROM beds_input_count) AS beds_requested_count,
  (SELECT COUNT(*)::int FROM inserted) AS pg_inserted_count,
  (SELECT c FROM skip_count) AS pg_skipped_count,
  (SELECT c FROM overlap_count) AS pg_conflict_count,
  (SELECT c FROM unknown_count) AS pg_unknown_count,
  COALESCE((SELECT jsonb_agg(ub.bed_code ORDER BY ub.bed_code) FROM unknown_beds ub), '[]'::jsonb) AS unknown_bed_codes,
  g.booking_code,
  g.id::text AS booking_id,
  g.status AS booking_status,
  COALESCE(g.created, false) AS pg_booking_created,
  CASE WHEN g.id IS NOT NULL AND NOT COALESCE(g.created, false) THEN true ELSE false END AS pg_booking_updated,
  (
    (SELECT ok FROM precheck_ok)
    AND (SELECT c FROM dup_meta_count) <= 1
    AND (SELECT c FROM existing_count) <= 1
    AND g.id IS NOT NULL
    AND g.status NOT IN ('cancelled', 'expired')
  ) AS pg_ok,
  CASE
    WHEN g.id IS NOT NULL AND (SELECT COUNT(*)::int FROM inserted) = 0 AND (SELECT c FROM skip_count) > 0 THEN true
    ELSE false
  END AS idempotent,
  (SELECT c FROM payments_before) AS payments_count,
  (SELECT c FROM payments_after) AS payments_count_after
FROM params p
LEFT JOIN guard g ON true`;

/**
 * After Airtable booking create — set bookings.airtable_record_id; booking_code only when WH-rec present.
 * Params: $1 airtable_record_id (rec…), $2 manual_entry_id, $3 booking_code candidate (or __NULL__).
 */
const PG_MANUAL_ENTRY_BACKFILL_BOOKING_AT_ID_SQL = `WITH params AS (
  SELECT
    NULLIF(trim($1), '__NULL__') AS airtable_record_id,
    NULLIF(trim($2), '__NULL__') AS manual_entry_id,
    NULLIF(trim($3), '__NULL__') AS booking_code_candidate
),
guard AS (
  SELECT b.id, b.client_id, b.booking_code, b.airtable_record_id
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  CROSS JOIN params p
  WHERE c.slug = '${CLIENT_SLUG}'
    AND p.manual_entry_id IS NOT NULL
    AND b.metadata->>'manual_entry_id' = p.manual_entry_id
  LIMIT 1
),
payments_before AS (
  SELECT COUNT(*)::int AS c
  FROM payments pay
  INNER JOIN guard g ON pay.booking_id = g.id AND pay.client_id = g.client_id
),
updated AS (
  UPDATE bookings b
  SET
    airtable_record_id = p.airtable_record_id,
    booking_code = CASE
      WHEN p.booking_code_candidate IS NOT NULL
        AND p.booking_code_candidate ~ '^WH-rec'
      THEN p.booking_code_candidate
      ELSE b.booking_code
    END
  FROM guard g
  CROSS JOIN params p
  WHERE b.id = g.id
    AND b.client_id = g.client_id
    AND p.airtable_record_id IS NOT NULL
  RETURNING b.id, b.booking_code, b.airtable_record_id
),
payments_after AS (
  SELECT COUNT(*)::int AS c
  FROM payments pay
  INNER JOIN guard g ON pay.booking_id = g.id AND pay.client_id = g.client_id
)
SELECT
  (SELECT COUNT(*)::int FROM guard) AS booking_rows_matched,
  (SELECT COUNT(*)::int FROM updated) AS pg_booking_backfill_count,
  (SELECT booking_code FROM guard LIMIT 1) AS booking_code_before,
  (SELECT booking_code FROM updated LIMIT 1) AS booking_code_after,
  (SELECT airtable_record_id FROM updated LIMIT 1) AS airtable_record_id,
  CASE
    WHEN (SELECT COUNT(*)::int FROM guard) <> 1 THEN false
    WHEN (SELECT COUNT(*)::int FROM updated) <> 1 THEN false
    ELSE true
  END AS pg_backfill_ok,
  CASE
    WHEN p.booking_code_candidate IS NULL OR p.booking_code_candidate !~ '^WH-rec' THEN true
    ELSE false
  END AS booking_code_left_pending,
  (SELECT c FROM payments_before) AS payments_count_before,
  (SELECT c FROM payments_after) AS payments_count_after
FROM params p`;

/** Same pattern as assign-booking-beds-pg-sql.js PG_BACKFILL_AIRTABLE_IDS_SQL. */
const PG_MANUAL_ENTRY_BACKFILL_BED_AT_IDS_SQL = `WITH params AS (
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
  (SELECT COUNT(*)::int FROM guard) AS booking_rows_matched,
  (SELECT COUNT(*)::int FROM updated) AS pg_backfill_count,
  COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('bed_code', u.bed_code, 'airtable_record_id', u.airtable_record_id) ORDER BY u.bed_code)
     FROM updated u),
    '[]'::jsonb
  ) AS backfilled,
  CASE
    WHEN (SELECT COUNT(*)::int FROM guard) <> 1 THEN false
    WHEN (SELECT COUNT(*)::int FROM pairs) = 0 THEN false
    ELSE true
  END AS pg_backfill_ok`;

module.exports = {
  CLIENT_SLUG,
  PG_MANUAL_ENTRY_DELETE_SQL,
  PG_MANUAL_ENTRY_UPDATE_SQL,
  PG_MANUAL_ENTRY_CREATE_SQL,
  PG_MANUAL_ENTRY_BACKFILL_BOOKING_AT_ID_SQL,
  PG_MANUAL_ENTRY_BACKFILL_BED_AT_IDS_SQL,
};
