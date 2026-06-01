/**
 * Stage 7.7k1 — Safe bed reassignment SQL helper.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  NOT WIRED / NOT RUNTIME — STATIC DESIGN ONLY                       ║
 * ║  This SQL string documents the intended single-transaction write     ║
 * ║  path for the Cami staff bed reassignment action.                    ║
 * ║  Do NOT execute directly. Do NOT call from any n8n node.             ║
 * ║  Do NOT import or call scripts/lib/reassign-booking-beds-pg-sql.js  ║
 * ║  (that is the bot reset path; this is a surgical staff move).        ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Allowed v1 action (§5a.2 of PHASE-7.7-CAMI-REVIEW-DASHBOARD-PLAN.md):
 *   Move exactly one booking_beds assignment from bed A to bed B
 *   for the SAME date range. No date, guest-count, payment, status,
 *   or guest-notification change. Staff must confirm ($8 = true).
 *
 * Parameters:
 *   $1  client_slug TEXT          — scopes every table lookup
 *   $2  booking_code TEXT         — identifies the booking
 *   $3  booking_bed_id UUID       — precise id of the booking_beds row to move
 *   $4  target_bed_code TEXT      — destination bed (same client)
 *   $5  staff_user_id TEXT        — audit actor
 *   $6  staff_role TEXT           — must be 'operator'|'admin'|'owner'
 *   $7  reason_note TEXT          — required staff explanation (caller validates non-empty)
 *   $8  confirm BOOLEAN           — must be TRUE; FALSE returns blocked=true, no write
 *
 * Transaction requirement:
 *   This SQL must be executed inside an explicit BEGIN / COMMIT block.
 *   The caller is responsible for wrapping it in a transaction so that
 *   the FOR UPDATE locks held in the CTEs remain active until the UPDATE
 *   commits. Running this outside a transaction undermines the overlap guard.
 *
 * Audit:
 *   On success, one row is inserted into workflow_events (interim audit sink;
 *   a dedicated booking_rooming_events table is a future hardening item).
 *   On failure / block, no audit row is written — the caller's own log
 *   (action:api:reassign_bed intent) carries the blocked attempt.
 *
 * Overlap rule (half-open interval — §5a.5):
 *   A target bed is occupied if there exists a booking_beds row where:
 *     existing.bed_id              = target_bed_id
 *     existing.id                 != current_booking_bed_id
 *     existing.assignment_start_date < current.assignment_end_date
 *     existing.assignment_end_date   > current.assignment_start_date
 *     existing booking NOT IN ('cancelled', 'expired')
 *
 * No DB-level EXCLUDE constraint today; the transaction lock is the sole guard.
 * Future hardening: add EXCLUDE USING gist on booking_beds (see §5a.5 notes).
 *
 * @module staff-bed-reassignment-sql
 */

'use strict';

// ---------------------------------------------------------------------------
// Safety notes exported for verifier readability
// ---------------------------------------------------------------------------

/**
 * Symbolic names for every blocker code returned in block_reason.
 * Exported so the future handler and the verifier can reference them.
 */
const REASSIGN_BLOCK_CODES = Object.freeze({
  CLIENT_NOT_FOUND:         'client_not_found',
  ASSIGNMENT_NOT_FOUND:     'assignment_not_found',
  TARGET_BED_NOT_FOUND:     'target_bed_not_found',
  TARGET_BED_INACTIVE:      'target_bed_inactive',
  TARGET_BED_NOT_SELLABLE:  'target_bed_not_sellable',
  BOOKING_CANCELLED:        'booking_cancelled_or_expired',
  ASSIGNMENT_NEEDS_REVIEW:  'assignment_needs_review',
  MANUAL_OPERATOR_LOCK:     'manual_operator_lock',
  INSUFFICIENT_ROLE:        'insufficient_role',
  TARGET_BED_OVERLAP:       'target_bed_overlap',
  CONFIRM_NOT_SET:          'confirm_not_set',
});

/**
 * Staff roles permitted to perform a reassignment.
 * Caller-enforced; also checked inside the SQL (§5a.3 blocker 12).
 */
const REASSIGN_ALLOWED_ROLES = Object.freeze(['operator', 'admin', 'owner']);

// ---------------------------------------------------------------------------
// Main helper
// ---------------------------------------------------------------------------

/**
 * Returns a CTE-based SQL string that performs a safe, single-assignment
 * bed-to-bed move within one PostgreSQL transaction.
 *
 * The query:
 *   1. Resolves and locks the current booking_beds row (FOR UPDATE).
 *   2. Resolves the target bed (validates active + sellable).
 *   3. Checks for overlap on the target bed (half-open interval, excludes
 *      the current row, excludes cancelled/expired bookings).
 *   4. Evaluates all blockers (see REASSIGN_BLOCK_CODES above).
 *   5. Builds audit_payload and rollback_payload in every path (blocked or not).
 *   6. Conditionally performs the UPDATE (only when is_blocked = FALSE).
 *   7. Writes one workflow_events audit row on success (interim audit sink).
 *   8. Returns a structured result row.
 *
 * NOT WIRED — static design only.
 *
 * @returns {string} Parameterised SQL (params: see module header)
 */
function reassignBookingBedSql() {
  return `
-- ============================================================================
-- NOT WIRED / NOT RUNTIME — safe bed reassignment (Stage 7.7k1)
-- Must be executed inside an explicit BEGIN / COMMIT transaction by caller.
-- Never call the bot reset path (reassign-booking-beds-pg-sql.js) from here.
-- Params: $1=client_slug $2=booking_code $3=booking_bed_id $4=target_bed_code
--         $5=staff_user_id $6=staff_role $7=reason_note $8=confirm::boolean
-- ============================================================================

WITH

-- ── 1. Resolve client ──────────────────────────────────────────────────────
ctx AS (
  SELECT c.id AS client_id, c.slug AS client_slug
  FROM clients c
  WHERE c.slug = $1
),

-- ── 2. Resolve current assignment (FOR UPDATE locks the row) ───────────────
-- Requires booking_code AND booking_bed_id to match, both scoped to client.
-- FOR UPDATE prevents concurrent staff moves on the same booking_beds row.
current_assignment AS (
  SELECT
    bb.id                       AS booking_bed_id,
    bb.booking_id,
    bb.bed_id                   AS old_bed_id,
    bb.room_code                AS old_room_code,
    bb.bed_code                 AS old_bed_code,
    bb.assignment_start_date,
    bb.assignment_end_date,
    bb.assignment_type,
    bb.updated_at               AS current_updated_at,
    b.booking_code,
    b.status::text              AS booking_status,
    b.assignment_status::text   AS assignment_status,
    b.payment_status::text      AS payment_status,
    b.primary_room_code
  FROM booking_beds bb
  INNER JOIN bookings b ON b.id = bb.booking_id
  CROSS JOIN ctx
  WHERE bb.id = $3::uuid
    AND b.booking_code = $2
    AND bb.client_id = ctx.client_id
    AND b.client_id  = ctx.client_id
  FOR UPDATE OF bb
),

-- ── 3. Resolve target bed ──────────────────────────────────────────────────
target_bed AS (
  SELECT
    bd.id                       AS bed_id,
    bd.bed_code,
    bd.active,
    bd.sellable,
    r.id                        AS room_id,
    r.room_code,
    r.room_type,
    r.gender_strategy,
    r.can_be_matrimonial,
    r.avoid_until_needed
  FROM beds bd
  INNER JOIN rooms r ON r.id = bd.room_id
  CROSS JOIN ctx
  WHERE bd.bed_code   = $4
    AND bd.client_id  = ctx.client_id
    AND r.client_id   = ctx.client_id
    AND bd.active     = TRUE
),

-- ── 4. Overlap detection on target bed (half-open interval) ───────────────
-- Uses: existing.start < proposed_end AND existing.end > proposed_start
-- Excludes: the current booking_beds row, cancelled/expired bookings.
-- Proposed dates = current assignment dates (unchanged in v1).
overlap_check AS (
  SELECT COUNT(*)::int AS conflict_count
  FROM booking_beds conflict_bb
  INNER JOIN bookings conflict_b ON conflict_b.id = conflict_bb.booking_id
  CROSS JOIN current_assignment ca
  CROSS JOIN target_bed tb
  WHERE conflict_bb.bed_id                 = tb.bed_id
    AND conflict_bb.id                    != ca.booking_bed_id
    AND conflict_bb.assignment_start_date  < ca.assignment_end_date
    AND conflict_bb.assignment_end_date    > ca.assignment_start_date
    AND conflict_b.status::text NOT IN ('cancelled', 'expired')
),

-- ── 5. Blocker determination ───────────────────────────────────────────────
blockers AS (
  SELECT
    -- B1. Client not found
    CASE WHEN (SELECT COUNT(*) FROM ctx) = 0
         THEN 'client_not_found'::text END                        AS b_client,

    -- B2. Assignment not found / client mismatch
    CASE WHEN (SELECT COUNT(*) FROM current_assignment) = 0
         THEN 'assignment_not_found'::text END                    AS b_assignment,

    -- B3. Target bed not found, inactive, or not sellable
    CASE WHEN (SELECT COUNT(*) FROM target_bed) = 0
         THEN 'target_bed_not_found'::text
         WHEN NOT (SELECT bd.active   FROM beds bd
                   CROSS JOIN ctx
                   WHERE bd.bed_code = $4 AND bd.client_id = ctx.client_id
                   LIMIT 1)
         THEN 'target_bed_inactive'::text
         WHEN NOT COALESCE(
               (SELECT bd.sellable FROM beds bd
                CROSS JOIN ctx
                WHERE bd.bed_code = $4 AND bd.client_id = ctx.client_id
                LIMIT 1), TRUE)
         THEN 'target_bed_not_sellable'::text
         END                                                       AS b_target_bed,

    -- B4. Booking is cancelled or expired
    CASE WHEN (SELECT booking_status FROM current_assignment)
              IN ('cancelled', 'expired')
         THEN 'booking_cancelled_or_expired'::text END            AS b_booking_status,

    -- B5. Assignment status is needs_review
    CASE WHEN (SELECT assignment_status FROM current_assignment) = 'needs_review'
         THEN 'assignment_needs_review'::text END                  AS b_assignment_status,

    -- B6. Manual / operator assignment lock
    -- TODO: if assignment_type = 'manual' or 'operator', block unless caller passes
    --       an explicit override flag (not yet in v1 params). Hard block for now.
    CASE WHEN (SELECT assignment_type FROM current_assignment)
              IN ('manual', 'operator')
         THEN 'manual_operator_lock'::text END                    AS b_lock,

    -- B7. Staff role insufficient (SQL-level guard; caller must also enforce)
    CASE WHEN $6 NOT IN ('operator', 'admin', 'owner')
         THEN 'insufficient_role'::text END                        AS b_role,

    -- B8. Target bed overlap
    CASE WHEN (SELECT conflict_count FROM overlap_check) > 0
         THEN 'target_bed_overlap'::text END                       AS b_overlap,

    -- B9. Confirm not set (caller-level safety — staff must explicitly confirm)
    CASE WHEN NOT $8::boolean
         THEN 'confirm_not_set'::text END                          AS b_confirm
),
blocked_summary AS (
  SELECT
    COALESCE(
      b.b_client, b.b_assignment, b.b_target_bed, b.b_booking_status,
      b.b_assignment_status, b.b_lock, b.b_role, b.b_overlap, b.b_confirm
    ) AS first_blocker,
    (
      b.b_client IS NOT NULL OR b.b_assignment IS NOT NULL OR
      b.b_target_bed IS NOT NULL OR b.b_booking_status IS NOT NULL OR
      b.b_assignment_status IS NOT NULL OR b.b_lock IS NOT NULL OR
      b.b_role IS NOT NULL OR b.b_overlap IS NOT NULL OR b.b_confirm IS NOT NULL
    ) AS is_blocked
  FROM blockers b
),

-- ── 6. Build audit and rollback payloads (always, even if blocked) ─────────
audit_payload_cte AS (
  SELECT jsonb_build_object(
    'action',                'staff_reassign_bed',
    'staff_user_id',         $5::text,
    'staff_role',            $6::text,
    'client_slug',           $1::text,
    'booking_code',          COALESCE((SELECT booking_code           FROM current_assignment), 'unknown'),
    'old_room_code',         COALESCE((SELECT old_room_code          FROM current_assignment), 'unknown'),
    'old_bed_code',          COALESCE((SELECT old_bed_code           FROM current_assignment), 'unknown'),
    'new_room_code',         COALESCE((SELECT room_code              FROM target_bed),         'unknown'),
    'new_bed_code',          COALESCE((SELECT bed_code               FROM target_bed),         'unknown'),
    'assignment_start_date', COALESCE((SELECT assignment_start_date::text FROM current_assignment), 'unknown'),
    'assignment_end_date',   COALESCE((SELECT assignment_end_date::text   FROM current_assignment), 'unknown'),
    'reason',                $7::text,
    'is_blocked',            (SELECT is_blocked    FROM blocked_summary),
    'block_reason',          (SELECT first_blocker FROM blocked_summary),
    'conflict_count',        (SELECT conflict_count FROM overlap_check)
  ) AS payload
),
rollback_payload_cte AS (
  SELECT jsonb_build_object(
    'booking_bed_id',        COALESCE((SELECT booking_bed_id::text       FROM current_assignment), null),
    'old_bed_id',            COALESCE((SELECT old_bed_id::text           FROM current_assignment), null),
    'old_room_code',         COALESCE((SELECT old_room_code              FROM current_assignment), null),
    'old_bed_code',          COALESCE((SELECT old_bed_code               FROM current_assignment), null),
    'assignment_start_date', COALESCE((SELECT assignment_start_date::text FROM current_assignment), null),
    'assignment_end_date',   COALESCE((SELECT assignment_end_date::text   FROM current_assignment), null),
    'assignment_type',       COALESCE((SELECT assignment_type             FROM current_assignment), null),
    'snapshot_ts',           NOW()::text
  ) AS payload
),

-- ── 7. Conditional UPDATE — only when not blocked ──────────────────────────
-- Safety invariants:
--   • Exactly one booking_beds row updated (guarded by booking_bed_id PK match).
--   • Date range UNCHANGED: start/end come from current_assignment (not params).
--   • No payment tables touched.
--   • No booking status, payment_status, or conversations touched here.
--   • No DELETE from booking_beds.
--   • No INSERT INTO booking_beds.
--   • No DROP / TRUNCATE / ALTER.
--   • assignment_type set to 'manual' (records that a human performed this move).
updated AS (
  UPDATE booking_beds bb
  SET
    bed_id           = (SELECT bed_id   FROM target_bed),
    room_code        = (SELECT room_code FROM target_bed),
    bed_code         = (SELECT bed_code  FROM target_bed),
    assignment_type  = 'manual',
    assignment_label = COALESCE($7::text, 'Staff reassignment'),
    updated_at       = NOW()
  FROM current_assignment ca
  CROSS JOIN ctx
  WHERE bb.id         = ca.booking_bed_id
    AND bb.client_id  = ctx.client_id
    -- Conditional write guard: skip UPDATE if any blocker is set
    AND NOT (SELECT is_blocked FROM blocked_summary)
    -- Re-verify overlap is still zero at write time (defence-in-depth under the lock)
    AND (SELECT conflict_count FROM overlap_check) = 0
  RETURNING bb.id, bb.room_code, bb.bed_code, bb.updated_at
),

-- ── 8. Audit write to workflow_events (interim sink; fires only on success) ─
-- workflow_events is the current audit table (migration 001_init.sql).
-- Future: replace/supplement with a dedicated booking_rooming_events table.
-- Columns used: client_id, workflow_name, node_name, event_level, message,
--               booking_id, payload.
-- NOTE: execution_id is NULL (no n8n context); hostel_id renamed to client_id
--       in migration 003.
audit_written AS (
  INSERT INTO workflow_events (
    client_id,
    workflow_name,
    node_name,
    event_level,
    message,
    booking_id,
    payload
  )
  SELECT
    ctx.client_id,
    'staff_reassign_bed',
    'staff_api:reassign_bed',
    'info',
    'Staff bed reassignment: '
      || COALESCE(ca.old_bed_code, '?')
      || ' -> '
      || COALESCE(tb.bed_code, '?')
      || ' (booking: '
      || COALESCE(ca.booking_code, '?') || ')',
    ca.booking_id,
    (SELECT payload FROM audit_payload_cte)
  FROM ctx
  CROSS JOIN current_assignment ca
  CROSS JOIN target_bed tb
  WHERE EXISTS (SELECT 1 FROM updated)
  RETURNING id::text AS audit_event_id
),

-- ── 9. Final result row ────────────────────────────────────────────────────
result AS (
  SELECT
    'staff_reassign_bed'::text                                        AS action,
    COALESCE(ca.booking_code, 'unknown')                              AS booking_code,
    COALESCE(ca.old_room_code, 'unknown')                             AS old_room_code,
    COALESCE(ca.old_bed_code, 'unknown')                              AS old_bed_code,
    COALESCE(tb.room_code, 'unknown')                                 AS new_room_code,
    COALESCE(tb.bed_code, 'unknown')                                  AS new_bed_code,
    COALESCE(ca.assignment_start_date::text, 'unknown')               AS assignment_start_date,
    COALESCE(ca.assignment_end_date::text, 'unknown')                 AS assignment_end_date,
    bs.is_blocked                                                     AS blocked,
    bs.first_blocker                                                  AS block_reason,
    (SELECT conflict_count FROM overlap_check)                        AS conflict_count,
    (SELECT COUNT(*)::int FROM updated)                               AS rows_updated,
    (SELECT payload FROM audit_payload_cte)                           AS audit_payload,
    (SELECT payload FROM rollback_payload_cte)                        AS rollback_payload,
    (SELECT audit_event_id FROM audit_written)                        AS audit_event_id
  FROM blocked_summary bs
  LEFT JOIN current_assignment ca ON TRUE
  LEFT JOIN target_bed tb ON TRUE
)
SELECT * FROM result;
`;
}

// ---------------------------------------------------------------------------
// Future migration note (not a migration file — documents the requirement)
// ---------------------------------------------------------------------------

/**
 * Reminder: no DB-level EXCLUDE constraint exists on booking_beds today.
 * Overlap prevention is purely transactional (row lock + re-check in UPDATE WHERE).
 * Future hardening: add btree_gist extension and an EXCLUDE constraint:
 *
 *   ALTER TABLE booking_beds
 *     ADD CONSTRAINT booking_beds_no_overlap
 *     EXCLUDE USING gist (
 *       bed_id WITH =,
 *       daterange(assignment_start_date, assignment_end_date) WITH &&
 *     );
 *
 * This requires: CREATE EXTENSION IF NOT EXISTS btree_gist;
 * Plan this as a future migration (010+) before multi-staff high-volume use.
 *
 * NOT WIRED — documentation only.
 */
const FUTURE_EXCLUDE_CONSTRAINT_NOTE = `
-- Future: booking_beds overlap exclusion constraint
-- Requires btree_gist extension. Plan as migration 010+.
-- CREATE EXTENSION IF NOT EXISTS btree_gist;
-- ALTER TABLE booking_beds
--   ADD CONSTRAINT booking_beds_no_overlap
--   EXCLUDE USING gist (
--     bed_id WITH =,
--     daterange(assignment_start_date, assignment_end_date) WITH &&
--   );
`;

module.exports = {
  reassignBookingBedSql,
  REASSIGN_BLOCK_CODES,
  REASSIGN_ALLOWED_ROLES,
  FUTURE_EXCLUDE_CONSTRAINT_NOTE,
};
