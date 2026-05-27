/**
 * Phase 3b.5c — n8n Postgres node SQL for Operator Room Release local fork.
 * Keep in sync with:
 *   scripts/lib/operator-room-release-impact-plan.js (3b.5a read-only plan)
 *   scripts/lib/operator-room-release-pg-sql.js (3b.5b execute — not yet ported here)
 *
 * Step 2: read-only plan SQL only. No execute / mark-failed SQL in this file yet.
 */
const CLIENT_SLUG = 'wolfhouse-somo';
const NULL_SENTINEL = '__NULL__';

const PARSE_NODE = 'Code - Parse Release Payload';

function planParamExpr(field) {
  return `(($('${PARSE_NODE}').first().json.${field}) != null && String($('${PARSE_NODE}').first().json.${field}).trim() !== '') ? String($('${PARSE_NODE}').first().json.${field}).trim() : '${NULL_SENTINEL}'`;
}

/**
 * Read-only impact plan for n8n Postgres node (SELECT only).
 * Params: $1 operator, $2 room_code, $3 release_start, $4 release_end,
 *         $5 request_code (optional), $6 allow_overlap ('true'/'false' or __NULL__)
 */
const PG_OPERATOR_ROOM_RELEASE_PLAN_SQL = `WITH params AS (
  SELECT
    NULLIF(trim($1), '${NULL_SENTINEL}') AS operator_in,
    NULLIF(trim($2), '${NULL_SENTINEL}') AS room_code_in,
    NULLIF(trim($3), '${NULL_SENTINEL}') AS release_start_in,
    NULLIF(trim($4), '${NULL_SENTINEL}') AS release_end_in,
    NULLIF(trim($5), '${NULL_SENTINEL}') AS request_code,
    NULLIF(trim($6), '${NULL_SENTINEL}') AS allow_overlap_in
),
input_norm AS (
  SELECT
    operator_in,
    room_code_in,
    release_start_in,
    release_end_in,
    request_code,
    allow_overlap_in,
    CASE
      WHEN operator_in IS NOT NULL AND trim(operator_in) <> '' THEN trim(operator_in)
      ELSE NULL
    END AS operator,
    CASE
      WHEN room_code_in IS NOT NULL AND trim(room_code_in) <> '' THEN upper(trim(room_code_in))
      ELSE NULL
    END AS room_code,
    CASE
      WHEN release_start_in IS NOT NULL AND trim(release_start_in) <> '' THEN release_start_in::date
      ELSE NULL
    END AS release_start,
    CASE
      WHEN release_end_in IS NOT NULL AND trim(release_end_in) <> '' THEN release_end_in::date
      ELSE NULL
    END AS release_end,
    lower(coalesce(allow_overlap_in, 'false')) IN ('true', '1', 'yes', 't') AS allow_overlap
  FROM params
),
validation AS (
  SELECT
    i.*,
    array_remove(
      ARRAY[
        CASE WHEN i.operator IS NULL THEN 'operator' END,
        CASE WHEN i.room_code IS NULL THEN 'room_code' END,
        CASE WHEN i.release_start IS NULL THEN 'release_start' END,
        CASE WHEN i.release_end IS NULL THEN 'release_end' END
      ],
      NULL
    ) AS missing_fields,
  (
      i.release_start IS NOT NULL
      AND i.release_end IS NOT NULL
      AND i.release_start >= i.release_end
    ) AS invalid_date_range
  FROM input_norm i
),
client_row AS (
  SELECT c.id AS client_id
  FROM clients c
  CROSS JOIN validation v
  WHERE c.slug = '${CLIENT_SLUG}'
    AND cardinality(v.missing_fields) = 0
    AND NOT v.invalid_date_range
  LIMIT 1
),
room_row AS (
  SELECT r.id AS room_id, r.room_code
  FROM rooms r
  INNER JOIN client_row c ON r.client_id = c.client_id
  CROSS JOIN input_norm i
  WHERE upper(trim(r.room_code)) = i.room_code
  LIMIT 1
),
candidates AS (
  SELECT DISTINCT ON (b.id)
    b.id AS booking_id,
    b.booking_code,
    b.check_in::date AS check_in,
    b.check_out::date AS check_out,
    b.status::text AS status
  FROM bookings b
  INNER JOIN client_row c ON b.client_id = c.client_id
  CROSS JOIN input_norm i
  LEFT JOIN rooms r ON r.id = b.room_to_block_id AND r.client_id = b.client_id
  CROSS JOIN validation v
  WHERE cardinality(v.missing_fields) = 0
    AND NOT v.invalid_date_range
    AND EXISTS (SELECT 1 FROM room_row)
    AND b.booking_source = 'operator'
    AND b.block_type = 'whole_room'
    AND b.status NOT IN ('cancelled', 'expired')
    AND trim(coalesce(b.operator_name, '')) = i.operator
    AND (
      upper(trim(coalesce(b.primary_room_code, ''))) = i.room_code
      OR upper(trim(coalesce(r.room_code, ''))) = i.room_code
      OR EXISTS (
        SELECT 1 FROM booking_beds bb
        WHERE bb.booking_id = b.id
          AND bb.client_id = b.client_id
          AND upper(trim(bb.room_code)) = i.room_code
      )
    )
    AND b.check_in < i.release_end
    AND i.release_start < b.check_out
  ORDER BY b.id, b.check_in
),
match_stats AS (
  SELECT COUNT(*)::int AS match_count FROM candidates
),
matched AS (
  SELECT c.*
  FROM candidates c
  CROSS JOIN match_stats m
  WHERE m.match_count = 1
),
beds AS (
  SELECT COUNT(*)::int AS beds_count
  FROM booking_beds bb
  INNER JOIN matched m ON bb.booking_id = m.booking_id
  INNER JOIN client_row c ON bb.client_id = c.client_id
),
overlap AS (
  SELECT COUNT(*)::int AS overlap_count
  FROM booking_beds bb
  INNER JOIN bookings b ON b.id = bb.booking_id AND b.client_id = bb.client_id
  INNER JOIN client_row c ON bb.client_id = c.client_id
  CROSS JOIN input_norm i
  LEFT JOIN matched m ON true
  WHERE upper(trim(bb.room_code)) = i.room_code
    AND (m.booking_id IS NULL OR bb.booking_id <> m.booking_id)
    AND bb.assignment_start_date < i.release_end
    AND bb.assignment_end_date > i.release_start
    AND b.status NOT IN ('cancelled', 'expired')
),
payments_stats AS (
  SELECT COUNT(*)::int AS payments_count
  FROM payments p
  INNER JOIN matched m ON p.booking_id = m.booking_id
  INNER JOIN client_row c ON p.client_id = c.client_id
),
payment_events_stats AS (
  SELECT COUNT(*)::int AS payment_events_count
  FROM payment_events pe
  INNER JOIN payments p ON p.id = pe.payment_id
  INNER JOIN matched m ON p.booking_id = m.booking_id
  INNER JOIN client_row c ON p.client_id = c.client_id
),
split AS (
  SELECT
    m.booking_id,
    m.booking_code,
    m.check_in AS original_check_in,
    m.check_out AS original_check_out,
    (m.check_in < i.release_start) AS should_create_a,
    (i.release_end < m.check_out) AS should_create_b,
    CASE WHEN m.check_in < i.release_start THEN m.check_in ELSE NULL END AS block_a_check_in,
    CASE WHEN m.check_in < i.release_start THEN i.release_start ELSE NULL END AS block_a_check_out,
    CASE WHEN i.release_end < m.check_out THEN i.release_end ELSE NULL END AS block_b_check_in,
    CASE WHEN i.release_end < m.check_out THEN m.check_out ELSE NULL END AS block_b_check_out,
    m.booking_code || '-A' AS block_a_booking_code,
    m.booking_code || '-B' AS block_b_booking_code
  FROM matched m
  CROSS JOIN input_norm i
),
context AS (
  SELECT
    v.missing_fields,
    v.invalid_date_range,
    c.client_id,
    r.room_id,
    r.room_code AS resolved_room_code,
    m.match_count,
    (m.match_count = 1) AS found_match,
    i.operator,
    i.room_code,
    i.release_start,
    i.release_end,
    i.request_code,
    i.allow_overlap,
    s.booking_id AS original_booking_id,
    s.booking_code AS original_booking_code,
    s.original_check_in,
    s.original_check_out,
    s.should_create_a,
    s.should_create_b,
    s.block_a_check_in,
    s.block_a_check_out,
    s.block_b_check_in,
    s.block_b_check_out,
    s.block_a_booking_code,
    s.block_b_booking_code,
    COALESCE(b.beds_count, 0) AS beds_count,
    COALESCE(o.overlap_count, 0) AS overlap_count,
    COALESCE(pay.payments_count, 0) AS payments_count,
    COALESCE(pes.payment_events_count, 0) AS payment_events_count,
    (
      s.original_check_in IS NOT NULL
      AND s.original_check_out IS NOT NULL
      AND NOT (s.original_check_in < i.release_end AND i.release_start < s.original_check_out)
    ) AS release_window_no_overlap
  FROM validation v
  CROSS JOIN input_norm i
  CROSS JOIN match_stats m
  LEFT JOIN client_row c ON true
  LEFT JOIN room_row r ON true
  LEFT JOIN split s ON true
  LEFT JOIN beds b ON true
  LEFT JOIN overlap o ON true
  LEFT JOIN payments_stats pay ON true
  LEFT JOIN payment_events_stats pes ON true
),
actionable_build AS (
  SELECT
    ctx.*,
    array_remove(
      ARRAY[
        CASE WHEN cardinality(ctx.missing_fields) > 0 THEN 'missing_required_fields' END,
        CASE WHEN ctx.invalid_date_range THEN 'invalid_date_range' END,
        CASE WHEN ctx.client_id IS NULL AND cardinality(ctx.missing_fields) = 0 AND NOT ctx.invalid_date_range
          THEN 'client_not_found' END,
        CASE WHEN ctx.client_id IS NOT NULL AND ctx.room_id IS NULL THEN 'room_not_found' END,
        CASE WHEN ctx.match_count = 0 THEN 'no_matching_operator_booking' END,
        CASE WHEN ctx.match_count > 1 THEN 'ambiguous_operator_booking_match' END,
        CASE WHEN ctx.release_window_no_overlap THEN 'release_window_does_not_overlap_original_block' END,
        CASE WHEN ctx.found_match AND ctx.beds_count = 0 THEN NULL END,
        CASE
          WHEN ctx.overlap_count > 0 AND NOT ctx.allow_overlap
          THEN 'postgres_overlap_conflicts_in_release_window'
        END
      ],
      NULL
    ) AS actionable,
    array_remove(
      ARRAY[
        CASE
          WHEN ctx.found_match AND ctx.beds_count = 0
          THEN 'original_booking_has_no_booking_beds_in_pg'
        END,
        CASE
          WHEN ctx.release_window_no_overlap
          THEN 'Release dates do not overlap original booking check_in/check_out'
        END
      ],
      NULL
    ) AS warnings
  FROM context ctx
)
SELECT
  (
    cardinality(missing_fields) = 0
    AND NOT invalid_date_range
    AND client_id IS NOT NULL
    AND room_id IS NOT NULL
  ) AS pg_ok,
  (
    cardinality(missing_fields) = 0
    AND NOT invalid_date_range
    AND client_id IS NOT NULL
    AND room_id IS NOT NULL
    AND found_match
    AND NOT release_window_no_overlap
    AND (
      overlap_count = 0
      OR allow_overlap
    )
  ) AS plan_ok,
  CASE
    WHEN cardinality(missing_fields) > 0 THEN 'missing_required_fields'
    WHEN invalid_date_range THEN 'invalid_date_range'
    WHEN client_id IS NULL AND cardinality(missing_fields) = 0 AND NOT invalid_date_range THEN 'client_not_found'
    WHEN client_id IS NOT NULL AND room_id IS NULL THEN 'room_not_found'
    WHEN match_count = 0 THEN 'no_match'
    WHEN match_count > 1 THEN 'ambiguous_match'
    WHEN found_match AND release_window_no_overlap THEN 'release_window_no_overlap'
    WHEN found_match AND overlap_count > 0 AND NOT allow_overlap THEN 'overlap_conflicts'
    WHEN found_match THEN NULL
    ELSE NULL
  END AS error_code,
  CASE
    WHEN cardinality(missing_fields) > 0 THEN 'Missing required fields: ' || array_to_string(missing_fields, ', ')
    WHEN invalid_date_range THEN 'release_end must be after release_start'
    WHEN client_id IS NULL AND cardinality(missing_fields) = 0 AND NOT invalid_date_range
      THEN 'Client not found for slug ${CLIENT_SLUG}'
    WHEN client_id IS NOT NULL AND room_id IS NULL THEN 'Room not found: ' || room_code
    WHEN match_count = 0 THEN 'No matching operator room block found.'
    WHEN match_count > 1 THEN 'Multiple matching operator room blocks found.'
    WHEN found_match AND release_window_no_overlap
      THEN 'Release window does not overlap original block dates'
    WHEN found_match AND overlap_count > 0 AND NOT allow_overlap
      THEN 'Postgres overlap conflicts in release window (use allow_overlap to proceed)'
    WHEN found_match THEN 'Operator room release plan ready'
    ELSE 'Plan computed'
  END AS message,
  found_match,
  match_count,
  operator,
  room_code,
  release_start::text AS release_start,
  release_end::text AS release_end,
  original_booking_id::text AS original_booking_id,
  original_booking_code,
  original_check_in::text AS original_check_in,
  original_check_out::text AS original_check_out,
  COALESCE(should_create_a, false) AS should_create_a,
  COALESCE(should_create_b, false) AS should_create_b,
  block_a_check_in::text AS block_a_check_in,
  block_a_check_out::text AS block_a_check_out,
  block_b_check_in::text AS block_b_check_in,
  block_b_check_out::text AS block_b_check_out,
  block_a_booking_code,
  block_b_booking_code,
  beds_count,
  overlap_count,
  payments_count,
  payment_events_count,
  actionable,
  warnings,
  request_code,
  allow_overlap,
  true AS dry_run
FROM actionable_build`;

const PG_OPERATOR_ROOM_RELEASE_PLAN_QUERY_REPLACEMENT = [
  `={{ ${planParamExpr('operator')} }}`,
  `={{ ${planParamExpr('room_code')} }}`,
  `={{ ${planParamExpr('release_start')} }}`,
  `={{ ${planParamExpr('release_end')} }}`,
  `={{ ${planParamExpr('request_code')} }}`,
  `={{ (() => { const v = $('${PARSE_NODE}').first().json.allow_overlap; if (v === true || v === 'true' || v === 1 || v === '1') return 'true'; return '${NULL_SENTINEL}'; })() }}`,
].join(',');

module.exports = {
  CLIENT_SLUG,
  NULL_SENTINEL,
  PG_OPERATOR_ROOM_RELEASE_PLAN_SQL,
  PG_OPERATOR_ROOM_RELEASE_PLAN_QUERY_REPLACEMENT,
};
