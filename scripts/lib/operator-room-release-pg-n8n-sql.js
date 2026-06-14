/**
 * Phase 3b.5c — n8n Postgres node SQL for Operator Room Release local fork.
 * Keep in sync with:
 *   scripts/lib/operator-room-release-impact-plan.js (3b.5a read-only plan)
 *   scripts/lib/operator-room-release-pg-sql.js (3b.5b execute)
 */
const CLIENT_SLUG = 'wolfhouse-somo';
const NULL_SENTINEL = '__NULL__';
const EXECUTE_NOTES = 'Mirrored via operator-room-release-pg-n8n-sql.js (local 3b.5c)';

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

const PG_OPERATOR_ROOM_RELEASE_EXECUTE_QUERY_REPLACEMENT =
  PG_OPERATOR_ROOM_RELEASE_PLAN_QUERY_REPLACEMENT;

const PG_OPERATOR_ROOM_RELEASE_COMPLETED_CHECK_QUERY_REPLACEMENT =
  PG_OPERATOR_ROOM_RELEASE_PLAN_QUERY_REPLACEMENT;

/**
 * Read-only idempotent replay gate (SELECT only).
 * Uses $5 request_code; other params ignored.
 * When status=completed, route_idempotent_response=true so n8n skips Plan.
 */
const PG_OPERATOR_ROOM_RELEASE_COMPLETED_CHECK_SQL = `WITH params AS (
  SELECT
    NULLIF(trim($1), '${NULL_SENTINEL}') AS operator_in,
    NULLIF(trim($2), '${NULL_SENTINEL}') AS room_code_in,
    NULLIF(trim($3), '${NULL_SENTINEL}') AS release_start_in,
    NULLIF(trim($4), '${NULL_SENTINEL}') AS release_end_in,
    NULLIF(trim($5), '${NULL_SENTINEL}') AS request_code,
    NULLIF(trim($6), '${NULL_SENTINEL}') AS allow_overlap_in
),
client_row AS (
  SELECT c.id AS client_id
  FROM clients c
  WHERE c.slug = '${CLIENT_SLUG}'
  LIMIT 1
),
latest_req AS (
  SELECT
    r.id AS request_id,
    r.request_code,
    r.status::text AS status,
    r.original_booking_id,
    r.new_booking_a_id,
    r.new_booking_b_id
  FROM operator_room_release_requests r
  INNER JOIN client_row c ON r.client_id = c.client_id
  CROSS JOIN params p
  WHERE p.request_code IS NOT NULL
    AND r.request_code = p.request_code
  ORDER BY r.updated_at DESC
  LIMIT 1
),
linked AS (
  SELECT
    lr.request_id,
    lr.request_code,
    lr.status,
    ob.booking_code AS original_booking_code,
    ob.id::text AS original_booking_id,
    ba.booking_code AS block_a_booking_code,
    ba.id::text AS block_a_booking_id,
    bb.booking_code AS block_b_booking_code,
    bb.id::text AS block_b_booking_id
  FROM latest_req lr
  INNER JOIN client_row c ON true
  LEFT JOIN bookings ob ON ob.id = lr.original_booking_id AND ob.client_id = c.client_id
  LEFT JOIN bookings ba ON ba.id = lr.new_booking_a_id AND ba.client_id = c.client_id
  LEFT JOIN bookings bb ON bb.id = lr.new_booking_b_id AND bb.client_id = c.client_id
)
SELECT
  (p.request_code IS NOT NULL) AS check_ran,
  (lr.request_id IS NOT NULL) AS request_found,
  (lr.status = 'completed') AS completed_request,
  (lr.status = 'processing') AS processing_request,
  (lr.status = 'failed') AS failed_request,
  (
    p.request_code IS NOT NULL
    AND lr.status = 'completed'
  ) AS route_idempotent_response,
  (
    p.request_code IS NOT NULL
    AND lr.status = 'processing'
  ) AS route_blocked_response,
  CASE
    WHEN p.request_code IS NULL THEN NULL
    WHEN lr.status = 'completed' THEN NULL
    WHEN lr.status = 'processing' THEN 'request_stuck_processing'
    WHEN lr.status = 'failed' THEN 'request_failed_retry'
    ELSE NULL
  END AS error_code,
  CASE
    WHEN p.request_code IS NULL THEN 'No request_code; continue to plan'
    WHEN lr.status = 'completed' THEN 'Operator room release completed (idempotent replay)'
    WHEN lr.status = 'processing' THEN 'Release request stuck in processing'
    WHEN lr.status = 'failed' THEN 'Prior release request failed; use a new request_code or clear failed row'
    WHEN lr.request_id IS NULL THEN 'No prior request; continue to plan'
    ELSE 'Continue to plan'
  END AS message,
  l.request_id::text AS request_id,
  l.request_code,
  l.original_booking_code,
  l.original_booking_id,
  l.block_a_booking_code,
  l.block_b_booking_code,
  true AS payments_unchanged
FROM params p
LEFT JOIN latest_req lr ON true
LEFT JOIN linked l ON l.request_id = lr.request_id`;

/**
 * Execute operator room release in one statement (single transaction).
 * Mirrors scripts/lib/operator-room-release-pg-sql.js executeOperatorRoomRelease.
 * Params: $1 operator, $2 room_code, $3 release_start, $4 release_end,
 *         $5 request_code (optional), $6 allow_overlap
 */
const PG_OPERATOR_ROOM_RELEASE_EXECUTE_SQL = `WITH params AS (
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
    request_code,
    notes_placeholder AS notes,
    lower(coalesce(allow_overlap_in, 'false')) IN ('true', '1', 'yes', 't') AS allow_overlap
  FROM params
  CROSS JOIN (SELECT NULL::text AS notes_placeholder) np
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
    b.status::text AS status,
    b.staff_notes,
    b.payment_status::text AS payment_status
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
split AS (
  SELECT
    m.booking_id,
    m.booking_code,
    m.check_in AS original_check_in,
    m.check_out AS original_check_out,
    m.status AS original_status,
    m.staff_notes,
    m.payment_status,
    (m.check_in < i.release_start) AS should_create_a,
    (i.release_end < m.check_out) AS should_create_b,
    CASE WHEN m.check_in < i.release_start THEN m.check_in ELSE NULL END AS block_a_check_in,
    CASE WHEN m.check_in < i.release_start THEN i.release_start ELSE NULL END AS block_a_check_out,
    CASE WHEN i.release_end < m.check_out THEN i.release_end ELSE NULL END AS block_b_check_in,
    CASE WHEN i.release_end < m.check_out THEN m.check_out ELSE NULL END AS block_b_check_out,
    m.booking_code || '-A' AS block_a_booking_code,
    m.booking_code || '-B' AS block_b_booking_code,
    format(
      'Operator released room from %s to %s. Original block split.',
      i.release_start::text,
      i.release_end::text
    ) AS split_note
  FROM matched m
  CROSS JOIN input_norm i
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
payments_before AS (
  SELECT COUNT(*)::int AS payments_count
  FROM payments p
  INNER JOIN matched m ON p.booking_id = m.booking_id
  INNER JOIN client_row c ON p.client_id = c.client_id
),
payment_events_before AS (
  SELECT COUNT(*)::int AS payment_events_count
  FROM payment_events pe
  INNER JOIN payments p ON p.id = pe.payment_id
  INNER JOIN matched m ON p.booking_id = m.booking_id
  INNER JOIN client_row c ON p.client_id = c.client_id
),
completed_req AS (
  SELECT
    r.id AS request_id,
    r.request_code,
    r.original_booking_id,
    r.new_booking_a_id,
    r.new_booking_b_id
  FROM operator_room_release_requests r
  INNER JOIN client_row c ON r.client_id = c.client_id
  CROSS JOIN input_norm i
  WHERE i.request_code IS NOT NULL
    AND r.request_code = i.request_code
    AND r.status = 'completed'
  ORDER BY r.updated_at DESC
  LIMIT 1
),
existing_req AS (
  SELECT r.id, r.status::text AS status
  FROM operator_room_release_requests r
  INNER JOIN client_row c ON r.client_id = c.client_id
  CROSS JOIN input_norm i
  WHERE i.request_code IS NOT NULL
    AND r.request_code = i.request_code
  ORDER BY r.updated_at DESC
  LIMIT 1
),
block_existing_a AS (
  SELECT b.id, b.check_in::date AS check_in, b.check_out::date AS check_out
  FROM bookings b
  INNER JOIN client_row c ON b.client_id = c.client_id
  INNER JOIN split s ON b.booking_code = s.block_a_booking_code
),
block_existing_b AS (
  SELECT b.id, b.check_in::date AS check_in, b.check_out::date AS check_out
  FROM bookings b
  INNER JOIN client_row c ON b.client_id = c.client_id
  INNER JOIN split s ON b.booking_code = s.block_b_booking_code
),
block_conflict AS (
  SELECT 1 AS hit
  WHERE EXISTS (
    SELECT 1 FROM split s
    INNER JOIN block_existing_a e ON true
    WHERE s.should_create_a
      AND (e.check_in IS DISTINCT FROM s.block_a_check_in OR e.check_out IS DISTINCT FROM s.block_a_check_out)
  )
  OR EXISTS (
    SELECT 1 FROM split s
    INNER JOIN block_existing_b e ON true
    WHERE s.should_create_b
      AND (e.check_in IS DISTINCT FROM s.block_b_check_in OR e.check_out IS DISTINCT FROM s.block_b_check_out)
  )
),
exec_gate AS MATERIALIZED (
  SELECT
    c.client_id,
    rm.room_id,
    s.*,
    i.operator,
    i.request_code AS input_request_code,
    i.allow_overlap,
    o.overlap_count,
    pb.payments_count,
    peb.payment_events_count
  FROM client_row c
  CROSS JOIN room_row rm
  CROSS JOIN split s
  CROSS JOIN input_norm i
  CROSS JOIN overlap o
  CROSS JOIN payments_before pb
  CROSS JOIN payment_events_before peb
  CROSS JOIN match_stats ms
  WHERE ms.match_count = 1
    AND NOT EXISTS (SELECT 1 FROM completed_req)
    AND NOT EXISTS (SELECT 1 FROM existing_req er WHERE er.status = 'processing')
    AND NOT EXISTS (SELECT 1 FROM block_conflict)
    AND pb.payments_count = 0
    AND peb.payment_events_count = 0
    AND s.original_status NOT IN ('cancelled', 'expired')
    AND (o.overlap_count = 0 OR i.allow_overlap)
),
req_updated AS (
  UPDATE operator_room_release_requests r
  SET
    status = 'processing'::operator_release_status,
    operator_name = g.operator,
    room_id = g.room_id,
    room_code = (SELECT room_code FROM input_norm),
    release_start_date = (SELECT release_start FROM input_norm),
    release_end_date = (SELECT release_end FROM input_norm),
    error_notes = NULL,
    updated_at = NOW()
  FROM exec_gate g
  INNER JOIN existing_req er ON true
  WHERE r.id = er.id
    AND er.status NOT IN ('completed', 'processing')
  RETURNING r.id AS request_id
),
deleted_beds AS (
  DELETE FROM booking_beds bb
  USING exec_gate g
  WHERE bb.client_id = g.client_id
    AND bb.booking_id = g.booking_id
  RETURNING bb.id
),
updated_original AS (
  UPDATE bookings b
  SET
    status = 'cancelled',
    assignment_status = 'needs_review',
    availability_check_status = 'needs_review',
    staff_notes = CASE
      WHEN coalesce(trim(b.staff_notes), '') = '' THEN g.split_note
      WHEN position(g.split_note in b.staff_notes) > 0 THEN b.staff_notes
      ELSE b.staff_notes || E'\\n' || g.split_note
    END,
    updated_at = NOW()
  FROM exec_gate g
  WHERE b.id = g.booking_id
    AND b.client_id = g.client_id
  RETURNING b.id
),
inserted_block_a AS (
  INSERT INTO bookings (
    client_id,
    booking_code,
    guest_name,
    operator_name,
    booking_source,
    block_type,
    status,
    payment_status,
    assignment_status,
    availability_check_status,
    check_in,
    check_out,
    guest_count,
    primary_room_code,
    room_to_block_id,
    staff_notes,
    deposit_required_cents,
    deposit_paid_cents,
    balance_due_cents,
    total_amount_cents,
    amount_paid_cents,
    metadata
  )
  SELECT
    g.client_id,
    g.block_a_booking_code,
    (SELECT operator FROM input_norm),
    (SELECT operator FROM input_norm),
    'operator',
    'whole_room',
    'confirmed',
    'not_requested',
    'unassigned',
    'unknown',
    g.block_a_check_in,
    g.block_a_check_out,
    1,
    (SELECT room_code FROM input_norm),
    g.room_id,
    g.split_note || E'\\n' || '${EXECUTE_NOTES}',
    0,
    0,
    0,
    0,
    0,
    jsonb_build_object(
      'operator_release_block', 'A',
      'operator_release_parent', g.booking_code,
      'source', 'operator-room-release-3b5c-n8n'
    )
  FROM exec_gate g
  WHERE g.should_create_a
    AND NOT EXISTS (SELECT 1 FROM block_existing_a)
  RETURNING id, booking_code
),
inserted_block_b AS (
  INSERT INTO bookings (
    client_id,
    booking_code,
    guest_name,
    operator_name,
    booking_source,
    block_type,
    status,
    payment_status,
    assignment_status,
    availability_check_status,
    check_in,
    check_out,
    guest_count,
    primary_room_code,
    room_to_block_id,
    staff_notes,
    deposit_required_cents,
    deposit_paid_cents,
    balance_due_cents,
    total_amount_cents,
    amount_paid_cents,
    metadata
  )
  SELECT
    g.client_id,
    g.block_b_booking_code,
    (SELECT operator FROM input_norm),
    (SELECT operator FROM input_norm),
    'operator',
    'whole_room',
    'confirmed',
    'not_requested',
    'unassigned',
    'unknown',
    g.block_b_check_in,
    g.block_b_check_out,
    1,
    (SELECT room_code FROM input_norm),
    g.room_id,
    g.split_note || E'\\n' || '${EXECUTE_NOTES}',
    0,
    0,
    0,
    0,
    0,
    jsonb_build_object(
      'operator_release_block', 'B',
      'operator_release_parent', g.booking_code,
      'source', 'operator-room-release-3b5c-n8n'
    )
  FROM exec_gate g
  WHERE g.should_create_b
    AND NOT EXISTS (SELECT 1 FROM block_existing_b)
  RETURNING id, booking_code
),
block_a_id AS (
  SELECT id FROM block_existing_a
  UNION ALL
  SELECT id FROM inserted_block_a
  LIMIT 1
),
block_b_id AS (
  SELECT id FROM block_existing_b
  UNION ALL
  SELECT id FROM inserted_block_b
  LIMIT 1
),
complete_existing AS (
  UPDATE operator_room_release_requests r
  SET
    status = 'completed'::operator_release_status,
    original_booking_id = g.booking_id,
    new_booking_a_id = (SELECT id FROM block_a_id LIMIT 1),
    new_booking_b_id = (SELECT id FROM block_b_id LIMIT 1),
    error_notes = NULL,
    updated_at = NOW()
  FROM req_updated ru
  CROSS JOIN exec_gate g
  WHERE r.id = ru.request_id
  RETURNING r.id
),
complete_new AS (
  INSERT INTO operator_room_release_requests (
    client_id,
    operator_name,
    room_id,
    room_code,
    release_start_date,
    release_end_date,
    request_code,
    notes,
    status,
    original_booking_id,
    new_booking_a_id,
    new_booking_b_id,
    airtable_record_id
  )
  SELECT
    g.client_id,
    g.operator,
    g.room_id,
    (SELECT room_code FROM input_norm),
    (SELECT release_start FROM input_norm),
    (SELECT release_end FROM input_norm),
    (SELECT request_code FROM input_norm),
    NULL,
    'completed'::operator_release_status,
    g.booking_id,
    (SELECT id FROM block_a_id LIMIT 1),
    (SELECT id FROM block_b_id LIMIT 1),
    NULL
  FROM exec_gate g
  WHERE NOT EXISTS (SELECT 1 FROM existing_req)
    AND EXISTS (SELECT 1 FROM updated_original)
  RETURNING id
),
request_row AS (
  SELECT request_id FROM req_updated
  UNION ALL
  SELECT id AS request_id FROM complete_new
  LIMIT 1
),
completed_request AS (
  SELECT id FROM complete_existing
  UNION ALL
  SELECT id FROM complete_new
),
payments_after AS (
  SELECT COUNT(*)::int AS payments_count
  FROM payments p
  INNER JOIN exec_gate g ON p.booking_id = g.booking_id AND p.client_id = g.client_id
),
idempotent_result AS (
  SELECT
    true AS pg_ok,
    true AS execute_ok,
    NULL::text AS error_code,
    'Operator room release completed (idempotent)'::text AS message,
    true AS idempotent,
    false AS dry_run,
    true AS found_match,
    1 AS match_count,
    cr.request_id::text AS request_id,
    cr.request_code,
    ob.booking_code AS original_booking_code,
    ob.id::text AS original_booking_id,
    ba.booking_code AS block_a_booking_code,
    bb.booking_code AS block_b_booking_code,
    0 AS deleted_beds,
    pb.payments_count,
    peb.payment_events_count AS payment_events_count,
    true AS payments_unchanged
  FROM completed_req cr
  INNER JOIN client_row c ON true
  LEFT JOIN bookings ob ON ob.id = cr.original_booking_id AND ob.client_id = c.client_id
  LEFT JOIN bookings ba ON ba.id = cr.new_booking_a_id AND ba.client_id = c.client_id
  LEFT JOIN bookings bb ON bb.id = cr.new_booking_b_id AND bb.client_id = c.client_id
  CROSS JOIN payments_before pb
  CROSS JOIN payment_events_before peb
),
success_result AS (
  SELECT
    true AS pg_ok,
    true AS execute_ok,
    NULL::text AS error_code,
    'Operator room release executed'::text AS message,
    false AS idempotent,
    false AS dry_run,
    true AS found_match,
    1 AS match_count,
    rr.request_id::text AS request_id,
    (SELECT request_code FROM input_norm) AS request_code,
    g.booking_code AS original_booking_code,
    g.booking_id::text AS original_booking_id,
    COALESCE((SELECT booking_code FROM inserted_block_a), g.block_a_booking_code) AS block_a_booking_code,
    COALESCE((SELECT booking_code FROM inserted_block_b), g.block_b_booking_code) AS block_b_booking_code,
    (SELECT COUNT(*)::int FROM deleted_beds) AS deleted_beds,
    g.payments_count,
    g.payment_events_count,
    (
      g.payments_count = (SELECT payments_count FROM payments_after)
      AND EXISTS (SELECT 1 FROM updated_original)
      AND EXISTS (SELECT 1 FROM completed_request)
    ) AS payments_unchanged
  FROM exec_gate g
  INNER JOIN request_row rr ON true
  WHERE EXISTS (SELECT 1 FROM updated_original)
    AND EXISTS (SELECT 1 FROM completed_request)
    AND EXISTS (SELECT 1 FROM request_row)
),
error_result AS (
  SELECT
    false AS pg_ok,
    false AS execute_ok,
    CASE
      WHEN cardinality(v.missing_fields) > 0 THEN 'missing_required_fields'
      WHEN v.invalid_date_range THEN 'invalid_date_range'
      WHEN c.client_id IS NULL AND cardinality(v.missing_fields) = 0 AND NOT v.invalid_date_range THEN 'client_not_found'
      WHEN c.client_id IS NOT NULL AND rm.room_id IS NULL THEN 'room_not_found'
      WHEN ms.match_count = 0 THEN 'no_match'
      WHEN ms.match_count > 1 THEN 'ambiguous_match'
      WHEN EXISTS (SELECT 1 FROM existing_req er WHERE er.status = 'processing') THEN 'request_stuck_processing'
      WHEN EXISTS (SELECT 1 FROM block_conflict) THEN 'block_booking_code_conflict'
      WHEN pb.payments_count > 0 OR peb.payment_events_count > 0 THEN 'payments_exist'
      WHEN s.original_status IN ('cancelled', 'expired') THEN 'already_cancelled_ambiguous'
      WHEN o.overlap_count > 0 AND NOT i.allow_overlap THEN 'overlap_conflicts'
      ELSE 'execute_failed'
    END AS error_code,
    CASE
      WHEN cardinality(v.missing_fields) > 0 THEN 'Missing required fields'
      WHEN ms.match_count = 0 THEN 'No matching operator room block found.'
      WHEN ms.match_count > 1 THEN 'Multiple matching operator room blocks found.'
      WHEN EXISTS (SELECT 1 FROM existing_req er WHERE er.status = 'processing') THEN 'Release request stuck in processing'
      WHEN EXISTS (SELECT 1 FROM block_conflict) THEN 'Block booking code conflict'
      WHEN pb.payments_count > 0 OR peb.payment_events_count > 0 THEN 'Payments exist on original booking'
      WHEN s.original_status IN ('cancelled', 'expired') THEN 'Original booking already cancelled or expired'
      WHEN o.overlap_count > 0 AND NOT i.allow_overlap THEN 'Overlap conflicts in release window'
      ELSE 'Execute failed'
    END AS message,
    false AS idempotent,
    false AS dry_run,
    (ms.match_count = 1) AS found_match,
    ms.match_count,
    NULL::text AS request_id,
    i.request_code,
    s.booking_code AS original_booking_code,
    s.booking_id::text AS original_booking_id,
    s.block_a_booking_code,
    s.block_b_booking_code,
    0 AS deleted_beds,
    COALESCE(pb.payments_count, 0) AS payments_count,
    COALESCE(peb.payment_events_count, 0) AS payment_events_count,
    true AS payments_unchanged
  FROM validation v
  CROSS JOIN input_norm i
  CROSS JOIN match_stats ms
  LEFT JOIN client_row c ON true
  LEFT JOIN room_row rm ON true
  LEFT JOIN split s ON true
  LEFT JOIN overlap o ON true
  LEFT JOIN payments_before pb ON true
  LEFT JOIN payment_events_before peb ON true
  WHERE NOT EXISTS (SELECT 1 FROM idempotent_result)
    AND NOT EXISTS (SELECT 1 FROM success_result)
)
SELECT * FROM idempotent_result
UNION ALL
SELECT * FROM success_result
UNION ALL
SELECT * FROM error_result
LIMIT 1`;

module.exports = {
  CLIENT_SLUG,
  NULL_SENTINEL,
  EXECUTE_NOTES,
  PG_OPERATOR_ROOM_RELEASE_PLAN_SQL,
  PG_OPERATOR_ROOM_RELEASE_PLAN_QUERY_REPLACEMENT,
  PG_OPERATOR_ROOM_RELEASE_COMPLETED_CHECK_SQL,
  PG_OPERATOR_ROOM_RELEASE_COMPLETED_CHECK_QUERY_REPLACEMENT,
  PG_OPERATOR_ROOM_RELEASE_EXECUTE_SQL,
  PG_OPERATOR_ROOM_RELEASE_EXECUTE_QUERY_REPLACEMENT,
};
