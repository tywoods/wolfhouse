/**
 * Stage 8.3f — Static SQL helper: manual booking creation from Staff Portal.
 *
 * NOT WIRED — no API route calls this yet.
 * NOT RUNTIME — do not execute this SQL directly; call from within an
 *               explicit BEGIN / COMMIT transaction managed by the caller.
 * NO WhatsApp / Stripe / n8n — no confirmation send, no payment link.
 * NO STAFF_ACTIONS_ENABLED toggle — caller must gate on that flag.
 *
 * Design: buildManualBookingCreateSql() returns a parameterised SQL string
 * suitable for pg.query(sql, params) inside a transaction.
 *
 * Parameter contract ($1 … $24):
 *   $1   client_slug             TEXT      — hostel slug
 *   $2   staff_user_id           TEXT      — staff actor UUID (auth by caller)
 *   $3   staff_role              TEXT      — 'operator' | 'admin' | 'owner'
 *   $4   idempotency_key         TEXT      — caller-generated; unique per intent
 *   $5   booking_code            TEXT|NULL — provided or NULL → auto-generated
 *   $6   guest_name              TEXT
 *   $7   phone                   TEXT      — stored hashed in audit
 *   $8   email                   TEXT|NULL
 *   $9   language                TEXT|NULL — default 'en'; stored on bookings.language + metadata JSONB
 *   $10  check_in                DATE
 *   $11  check_out               DATE      — exclusive (half-open: check_in < check_out)
 *   $12  guest_count             INT
 *   $13  selected_bed_codes      TEXT[]
 *   $14  package_or_stay_type    TEXT|NULL
 *   $15  room_preference         TEXT|NULL
 *   $16  booking_status          TEXT      — e.g. 'confirmed' | 'hold'; cast to booking_status enum
 *   $17  payment_status          TEXT      — e.g. 'not_requested' | 'deposit_paid'; cast to payment_status enum
 *   $18  deposit_amount_cents    INT       — 0 if none; must be ≤ $19 unless $19=0
 *   $19  total_amount_cents      INT       — 0 if none
 *   $20  source                  TEXT      — e.g. 'walk_in' | 'phone' | 'email'
 *   $21  reason                  TEXT      — staff reason for manual create
 *   $22  notes                   TEXT|NULL — free-text staff notes
 *   $23  confirm                 BOOLEAN   — must be TRUE; hard block if FALSE
 *   $24  warnings_acknowledged   BOOLEAN   — TRUE if staff acknowledged warnings
 *
 * Idempotency design (interim — see §9 note):
 *   The schema does not yet have a dedicated idempotency_key column on bookings.
 *   Interim approach: $4 (idempotency_key) is stored in metadata JSONB and queried
 *   via metadata->>'idempotency_key'. A future migration (8.3g or 8.3h) should add:
 *     ALTER TABLE bookings ADD COLUMN idempotency_key TEXT;
 *     CREATE UNIQUE INDEX uq_bookings_idempotency_key ON bookings (client_id, idempotency_key)
 *       WHERE idempotency_key IS NOT NULL;
 *   Until then, the JSONB approach provides a best-effort duplicate guard.
 *
 * Overlap design:
 *   Half-open interval:
 *     existing.assignment_start_date < proposed_check_out ($11)
 *     existing.assignment_end_date   > proposed_check_in  ($10)
 *   Same client and bed scope. Excludes cancelled/expired bookings.
 *   Defense-in-depth: overlap guard is checked again inside the
 *   inserted_booking_beds NOT EXISTS predicate after row locks are acquired.
 *
 * Row-lock note:
 *   FOR UPDATE on selected bed rows (beds table) serialises competing requests
 *   that target the same beds. For full production safety an EXCLUDE USING gist
 *   constraint on booking_beds (same pattern as reassignment helper) is
 *   recommended as a future hardening step.
 *
 * Audit sink (interim):
 *   workflow_events table — same interim sink as bed reassignment (Stage 7.7k1).
 *   Future: migrate to dedicated booking_rooming_events table (planned in 8.3e §7).
 *   Audit is written on EVERY attempt, including blocked ones.
 */

'use strict';

// ---------------------------------------------------------------------------
// Block code registry
// ---------------------------------------------------------------------------

/**
 * Symbolic names for every blocker code returned in block_reason.
 * Exported so the future handler and verifier can reference them.
 */
const MANUAL_BOOKING_BLOCK_CODES = Object.freeze({
  CONFIRM_NOT_SET:                  'confirm_not_set',
  STAFF_ROLE_INSUFFICIENT:          'staff_role_insufficient',
  CLIENT_NOT_FOUND:                 'client_not_found',
  STAFF_ACTOR_NOT_FOUND:            'staff_actor_not_found',
  INVALID_DATES:                    'invalid_dates',
  INVALID_GUEST_COUNT:              'invalid_guest_count',
  NO_SELECTED_BEDS:                 'no_selected_beds',
  BED_NOT_FOUND:                    'bed_not_found',
  BED_INACTIVE_OR_UNSELLABLE:       'bed_inactive_or_unsellable',
  OVERLAP_CONFLICT:                 'overlap_conflict',
  GUEST_COUNT_EXCEEDS_SELECTED_BEDS:'guest_count_exceeds_selected_beds',
  INVALID_PAYMENT_AMOUNTS:          'invalid_payment_amounts',
  BOOKING_CODE_COLLISION:           'booking_code_collision',
  IDEMPOTENCY_DUPLICATE:            'idempotency_duplicate',
});

/**
 * Staff roles permitted to create a manual booking.
 * Caller-enforced; also checked inside the SQL (B2 blocker).
 */
const MANUAL_BOOKING_ALLOWED_ROLES = Object.freeze(['operator', 'admin', 'owner']);

// ---------------------------------------------------------------------------
// Main helper
// ---------------------------------------------------------------------------

/**
 * Returns a CTE-based SQL string for a safe, single-transaction manual
 * booking creation.
 *
 * The query:
 *   1.  Resolves and validates the client (ctx CTE).
 *   2.  Normalises input / validates dates, counts, amounts (input_check CTE).
 *   3.  Resolves selected beds (selected_beds CTE).
 *   4.  Acquires row-level locks on selected beds (bed_locks CTE — FOR UPDATE).
 *   5.  Checks for booking overlap on each selected bed (overlap_check CTE).
 *   6.  Checks for idempotency duplicate (duplicate_check CTE).
 *   7.  Evaluates all hard blockers (blockers CTE, blocked_summary CTE).
 *   8.  Generates or accepts the booking_code (booking_code_gen CTE).
 *   9.  Inserts the booking row (inserted_booking CTE) — only when not blocked.
 *  10.  Inserts booking_bed rows (inserted_booking_beds CTE) — with defense-in-depth
 *       overlap guard re-checked after locks are held.
 *  11.  Inserts an optional manual payment row (inserted_payment CTE) — no Stripe.
 *  12.  Builds audit_payload JSON (audit_payload_cte CTE).
 *  13.  Builds rollback_payload JSON (rollback_payload_cte CTE).
 *  14.  Writes one workflow_events audit row on every attempt (audit_written CTE).
 *  15.  Returns a structured final SELECT row.
 *
 * NOT WIRED — no API route uses this function yet.
 *
 * @returns {string} Parameterised SQL (params: see module header §Parameter contract)
 */
function buildManualBookingCreateSql() {
  return `
-- ============================================================================
-- NOT WIRED / NOT RUNTIME — staff manual booking creation (Stage 8.3f)
-- Must be executed inside an explicit BEGIN / COMMIT transaction by caller.
-- No WhatsApp. No Stripe. No n8n. No confirmation send. No auto-activation.
-- Params: $1=client_slug $2=staff_user_id $3=staff_role $4=idempotency_key
--         $5=booking_code(nullable) $6=guest_name $7=phone $8=email(nullable)
--         $9=language(nullable) $10=check_in $11=check_out $12=guest_count
--         $13=selected_bed_codes(text[]) $14=package_or_stay_type(nullable)
--         $15=room_preference(nullable) $16=booking_status $17=payment_status
--         $18=deposit_amount_cents $19=total_amount_cents $20=source
--         $21=reason $22=notes(nullable) $23=confirm::boolean
--         $24=warnings_acknowledged::boolean
-- ============================================================================

WITH

-- ── 1. Resolve client ────────────────────────────────────────────────────────
ctx AS (
  SELECT c.id   AS client_id,
         c.slug AS client_slug
  FROM   clients c
  WHERE  c.slug = $1::text
),

-- ── 2. Input normalisation / validation ──────────────────────────────────────
-- All input validation is done here; downstream CTEs reference these booleans.
input_check AS (
  SELECT
    $10::date                                              AS proposed_check_in,
    $11::date                                              AS proposed_check_out,
    ($11::date - $10::date)                                AS proposed_nights,
    ($11::date > $10::date)                                AS dates_valid,
    ($12::int >= 1)                                        AS guest_count_valid,
    (COALESCE($18::int, 0) >= 0)                           AS deposit_non_negative,
    (COALESCE($19::int, 0) >= 0)                           AS total_non_negative,
    -- deposit <= total unless total is 0/null (documented: 0-total means unpriced)
    (
      $19::int IS NULL
      OR $19::int = 0
      OR COALESCE($18::int, 0) <= $19::int
    )                                                      AS deposit_lte_total,
    ($23::boolean IS TRUE)                                 AS confirm_set,
    (trim($6) <> '')                                       AS guest_name_present,
    (trim($21) <> '')                                      AS reason_present,
    (trim($20) <> '')                                      AS source_present
),

-- ── 3. Resolve selected beds for this client ─────────────────────────────────
selected_beds AS (
  SELECT
    bd.id        AS bed_id,
    bd.bed_code,
    bd.active,
    bd.sellable,
    r.id         AS room_id,
    r.room_code,
    r.room_type
  FROM   beds     bd
  INNER JOIN rooms r ON r.id = bd.room_id
  CROSS JOIN ctx
  WHERE  bd.bed_code  = ANY($13::text[])
    AND  bd.client_id = ctx.client_id
    AND  r.client_id  = ctx.client_id
),

-- ── 4. Row-level lock on selected beds ───────────────────────────────────────
-- Serialises competing requests that target the same bed rows.
-- Full production safety requires an EXCLUDE USING gist constraint on
-- booking_beds (future hardening — see module header).
bed_locks AS (
  SELECT bed_id, bed_code, room_code
  FROM   selected_beds
  FOR    UPDATE
),

-- ── 5. Overlap detection (half-open interval) ────────────────────────────────
-- Checks ALL selected beds for any conflicting booking_beds rows.
-- Half-open rule:
--   existing.assignment_start_date < proposed_check_out  ($11)
--   existing.assignment_end_date   > proposed_check_in   ($10)
-- Scoped to: same client, same bed, excludes cancelled/expired.
overlap_check AS (
  SELECT
    COUNT(*)::int                                          AS conflict_count,
    array_agg(DISTINCT bb.bed_code ORDER BY bb.bed_code)   AS conflict_beds
  FROM   booking_beds bb
  INNER JOIN bookings  bk ON bk.id = bb.booking_id
  CROSS JOIN ctx
  WHERE  bb.bed_id    = ANY (SELECT bed_id FROM selected_beds)
    AND  bb.client_id = ctx.client_id
    AND  bb.assignment_start_date < $11::date
    AND  bb.assignment_end_date   > $10::date
    AND  bk.status::text NOT IN ('cancelled', 'expired')
),

-- ── 6. Idempotency / duplicate-request check ─────────────────────────────────
-- Interim approach: idempotency_key stored in bookings.metadata JSONB.
-- Future migration (8.3g+): dedicated idempotency_key column + unique index.
-- Returns the existing booking if a duplicate is recognised.
duplicate_check AS (
  SELECT bk.id           AS existing_booking_id,
         bk.booking_code AS existing_booking_code
  FROM   bookings bk
  CROSS JOIN ctx
  WHERE  bk.client_id = ctx.client_id
    AND  bk.metadata->>'idempotency_key' = $4::text
  LIMIT  1
),

-- ── 7. Blocker determination ─────────────────────────────────────────────────
blockers AS (
  SELECT
    -- B1. confirm not set — must be TRUE before any write
    CASE WHEN NOT (SELECT confirm_set FROM input_check)
         THEN 'confirm_not_set'::text END                  AS b_confirm,

    -- B2. Staff role insufficient (SQL-level guard; caller must also enforce)
    CASE WHEN $3::text NOT IN ('operator', 'admin', 'owner')
         THEN 'staff_role_insufficient'::text END          AS b_role,

    -- B3. Client not found
    CASE WHEN (SELECT COUNT(*) FROM ctx) = 0
         THEN 'client_not_found'::text END                 AS b_client,

    -- B4. Invalid dates (check_out must be after check_in)
    CASE WHEN NOT (SELECT dates_valid FROM input_check)
         THEN 'invalid_dates'::text END                    AS b_dates,

    -- B5. Invalid guest count (must be >= 1)
    CASE WHEN NOT (SELECT guest_count_valid FROM input_check)
         THEN 'invalid_guest_count'::text END              AS b_guest_count,

    -- B6. No selected beds provided or none found in DB
    CASE WHEN array_length($13::text[], 1) IS NULL
              OR array_length($13::text[], 1) = 0
         THEN 'no_selected_beds'::text
         WHEN (SELECT COUNT(*) FROM selected_beds) = 0
         THEN 'no_selected_beds'::text END                 AS b_no_beds,

    -- B7. Some provided bed codes not found for this client
    CASE WHEN (SELECT COUNT(*) FROM selected_beds) < array_length($13::text[], 1)
         THEN 'bed_not_found'::text END                    AS b_bed_missing,

    -- B8. A selected bed is inactive or not sellable
    CASE WHEN EXISTS (
           SELECT 1 FROM selected_beds
           WHERE NOT active OR NOT COALESCE(sellable, TRUE)
         )
         THEN 'bed_inactive_or_unsellable'::text END       AS b_bed_state,

    -- B9. Overlap conflict on one or more selected beds
    CASE WHEN (SELECT conflict_count FROM overlap_check) > 0
         THEN 'overlap_conflict'::text END                 AS b_overlap,

    -- B10. Guest count exceeds selected bed count
    CASE WHEN $12::int > (SELECT COUNT(*)::int FROM selected_beds)
         THEN 'guest_count_exceeds_selected_beds'::text END AS b_capacity,

    -- B11. Invalid payment amounts (negative or deposit > total)
    CASE WHEN NOT (
           (SELECT deposit_non_negative FROM input_check)
           AND (SELECT total_non_negative FROM input_check)
           AND (SELECT deposit_lte_total FROM input_check)
         )
         THEN 'invalid_payment_amounts'::text END          AS b_payment,

    -- B12. Booking code collision (if explicit code provided)
    CASE WHEN $5::text IS NOT NULL AND EXISTS (
           SELECT 1 FROM bookings bk
           CROSS JOIN ctx
           WHERE bk.booking_code = $5::text
             AND bk.client_id    = ctx.client_id
         )
         THEN 'booking_code_collision'::text END           AS b_code,

    -- B13. Idempotency duplicate — signals caller to return existing booking.
    -- This is a soft signal rather than a create-blocking hard error; the
    -- final SELECT returns the existing booking instead of a new one.
    CASE WHEN (SELECT existing_booking_id FROM duplicate_check) IS NOT NULL
         THEN 'idempotency_duplicate'::text END            AS b_idempotency
),

-- ── 8. Blocked summary ───────────────────────────────────────────────────────
blocked_summary AS (
  SELECT
    COALESCE(
      b_confirm, b_role, b_client, b_dates, b_guest_count,
      b_no_beds, b_bed_missing, b_bed_state, b_overlap, b_capacity,
      b_payment, b_code, b_idempotency
    )                                                      AS first_blocker,
    (
      b_confirm     IS NOT NULL OR
      b_role        IS NOT NULL OR
      b_client      IS NOT NULL OR
      b_dates       IS NOT NULL OR
      b_guest_count IS NOT NULL OR
      b_no_beds     IS NOT NULL OR
      b_bed_missing IS NOT NULL OR
      b_bed_state   IS NOT NULL OR
      b_overlap     IS NOT NULL OR
      b_capacity    IS NOT NULL OR
      b_payment     IS NOT NULL OR
      b_code        IS NOT NULL OR
      b_idempotency IS NOT NULL
    )                                                      AS is_blocked
  FROM blockers
),

-- ── 9. Booking code: accept provided or auto-generate ────────────────────────
-- Generated form: MB-{CLIENT6}-{YYYYMMDD}-{IDEMPOTENCY_HEX6}
-- Guaranteed unique within session via idempotency_key suffix.
booking_code_gen AS (
  SELECT COALESCE(
    $5::text,
    'MB-' || upper(left(replace($1::text, '-', ''), 6))
           || '-' || to_char($10::date, 'YYYYMMDD')
           || '-' || substring(md5($4::text), 1, 6)
  ) AS booking_code
),

-- ── 10. Insert booking (only when not blocked and not a duplicate) ────────────
inserted_booking AS (
  INSERT INTO bookings (
    client_id,
    booking_code,
    guest_name,
    phone,
    email,
    language,
    status,
    payment_status,
    assignment_status,
    check_in,
    check_out,
    guest_count,
    package_code,
    primary_room_code,
    booking_source,
    staff_notes,
    confirmation_sent_at,
    metadata
  )
  SELECT
    ctx.client_id,
    bcg.booking_code,
    $6::text,
    $7::text,
    $8::text,
    COALESCE(NULLIF(TRIM($9::text), ''), 'en'),
    $16::booking_status,
    $17::payment_status,
    'unassigned',
    $10::date,
    $11::date,
    $12::int,
    $14::text,
    (SELECT room_code FROM selected_beds LIMIT 1),
    'manual_staff',
    COALESCE($22::text, ''),
    NULL,                         -- confirmation_sent_at: not sent at creation
    jsonb_build_object(
      'source',                'staff_manual',
      'manual_created',        TRUE,
      'idempotency_key',       $4::text,
      'created_by_role',       $3::text,
      'reason',                $21::text,
      'staff_source',          $20::text,
      'room_preference',       $15::text,
      'language',              COALESCE($9::text, 'en'),
      'warnings_acknowledged', $24::boolean
    )
  FROM ctx
  CROSS JOIN booking_code_gen bcg
  WHERE NOT (SELECT is_blocked FROM blocked_summary)
  RETURNING id AS booking_id, booking_code, client_id
),

-- ── 11. Insert booking_beds (one per selected bed) ────────────────────────────
-- Only runs when inserted_booking produced a row.
-- Defense-in-depth: overlap guard re-checked here after bed locks are held.
-- This catches any concurrent booking that slipped through the overlap_check CTE.
inserted_booking_beds AS (
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
    guest_name
  )
  SELECT
    ib.client_id,
    ib.booking_id,
    sb.bed_id,
    sb.bed_code,
    sb.room_code,
    $10::date,
    $11::date,
    'Manual Staff',
    'Created via Staff Portal manual booking (Stage 8.3)',
    $6::text
  FROM inserted_booking ib
  CROSS JOIN selected_beds sb
  -- Defense-in-depth: re-verify overlap after locks acquired.
  -- existing.assignment_start_date < proposed_check_out ($11)
  -- existing.assignment_end_date   > proposed_check_in  ($10)
  WHERE NOT EXISTS (
    SELECT 1
    FROM   booking_beds ex
    INNER JOIN bookings exb ON exb.id = ex.booking_id
    WHERE  ex.bed_id                 = sb.bed_id
      AND  ex.assignment_start_date  < $11::date
      AND  ex.assignment_end_date    > $10::date
      AND  exb.status::text NOT IN ('cancelled', 'expired')
  )
  RETURNING id AS booking_bed_id, bed_code, room_code
),

-- ── 12. Optional manual payment row ──────────────────────────────────────────
-- Created only when: booking inserted AND deposit_amount_cents > 0.
-- Uses actual payments schema (after migration 003 + 004):
--   client_id, booking_id, status (payment_record_status), payment_kind,
--   currency, amount_due_cents, metadata
-- status = 'draft'         — no Stripe checkout created, no payment link sent.
-- payment_kind = 'deposit_only' — deposit-only; full amount tracked on booking.
-- NO provider column. NO stripe session. NO payment link. NO charge.
inserted_payment AS (
  INSERT INTO payments (
    client_id,
    booking_id,
    status,
    payment_kind,
    currency,
    amount_due_cents,
    metadata
  )
  SELECT
    ib.client_id,
    ib.booking_id,
    'draft'::payment_record_status,
    'deposit_only'::payment_kind,
    'EUR',
    COALESCE($18::int, 0),
    jsonb_build_object(
      'source',                  'staff_manual',
      'note',                    'Manual deposit recorded by staff — no Stripe charge',
      'deposit_requested_cents', $18::int,
      'total_amount_cents',      $19::int
    )
  FROM inserted_booking ib
  WHERE COALESCE($18::int, 0) > 0
  RETURNING id AS payment_id, amount_due_cents
),

-- ── 13. Audit payload ────────────────────────────────────────────────────────
-- Built on every path (blocked and unblocked). PII: phone is hashed.
audit_payload_cte AS (
  SELECT jsonb_build_object(
    'action',                'manual_booking_create',
    'staff_user_id',         $2::text,
    'staff_role',            $3::text,
    'client_slug',           $1::text,
    'idempotency_key',       $4::text,
    'guest_name',            $6::text,
    'phone_hash',            md5($7::text),
    'check_in',              $10::text,
    'check_out',             $11::text,
    'selected_bed_codes',    to_jsonb($13::text[]),
    'payment_status',        $17::text,
    'deposit_amount_cents',  $18::int,
    'total_amount_cents',    $19::int,
    'source',                $20::text,
    'reason',                $21::text,
    'warnings_acknowledged', $24::boolean,
    'first_blocker',         (SELECT first_blocker FROM blocked_summary),
    'is_blocked',            (SELECT is_blocked    FROM blocked_summary),
    'overlap_conflict_beds', (SELECT conflict_beds FROM overlap_check),
    'booking_id',            (SELECT booking_id::text  FROM inserted_booking),
    'booking_code',          (SELECT booking_code      FROM inserted_booking),
    'beds_inserted',         (SELECT COUNT(*)::int     FROM inserted_booking_beds),
    'payments_inserted',     (SELECT COUNT(*)::int     FROM inserted_payment)
  ) AS payload
),

-- ── 14. Rollback payload ─────────────────────────────────────────────────────
-- Stored with audit row. Used by future staff_manual_booking_rollback() (8.3k).
rollback_payload_cte AS (
  SELECT jsonb_build_object(
    'booking_id',       (SELECT booking_id::text FROM inserted_booking),
    'booking_code',     (SELECT booking_code     FROM inserted_booking),
    'booking_bed_ids',  (SELECT jsonb_agg(booking_bed_id::text)
                         FROM inserted_booking_beds),
    'payment_ids',      (SELECT jsonb_agg(payment_id::text)
                         FROM inserted_payment),
    'client_slug',      $1::text,
    'rollback_note',    'Use staff_manual_booking_rollback() — planned 8.3k'
  ) AS payload
),

-- ── 15. Audit event write ────────────────────────────────────────────────────
-- Written on EVERY attempt (blocked or not) so blocked attempts are visible.
-- Uses actual workflow_events schema (after migration 003):
--   client_id, workflow_name TEXT NOT NULL, node_name, event_level,
--   message TEXT NOT NULL, booking_id, payload
-- created_at has DEFAULT NOW() so it can be omitted.
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
    (SELECT client_id FROM ctx),
    'staff_manual_booking_create',
    'stage8_3j_manual_create',
    'info',
    COALESCE(
      'manual_booking_create attempt blocked=' ||
        ((SELECT is_blocked FROM blocked_summary))::text,
      'manual_booking_create attempt'
    ),
    (SELECT booking_id FROM inserted_booking),
    apc.payload
  FROM audit_payload_cte apc
  WHERE (SELECT client_id FROM ctx) IS NOT NULL
  RETURNING id AS audit_event_id
)

-- ── Final SELECT ─────────────────────────────────────────────────────────────
SELECT
  (SELECT is_blocked            FROM blocked_summary)      AS is_blocked,
  (SELECT first_blocker         FROM blocked_summary)      AS block_reason,
  (SELECT b_idempotency IS NOT NULL FROM blockers)         AS is_duplicate,
  (SELECT existing_booking_id   FROM duplicate_check)      AS duplicate_booking_id,
  (SELECT existing_booking_code FROM duplicate_check)      AS duplicate_booking_code,
  (SELECT booking_id            FROM inserted_booking)     AS booking_id,
  (SELECT booking_code          FROM inserted_booking)     AS booking_code,
  (SELECT COUNT(*)::int         FROM inserted_booking_beds)AS beds_inserted,
  (SELECT COUNT(*)::int         FROM inserted_payment)     AS payments_inserted,
  (SELECT audit_event_id        FROM audit_written)        AS audit_event_id,
  (SELECT payload               FROM rollback_payload_cte) AS rollback_payload,
  (SELECT payload               FROM audit_payload_cte)    AS audit_payload
`;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildManualBookingCreateSql,
  MANUAL_BOOKING_BLOCK_CODES,
  MANUAL_BOOKING_ALLOWED_ROLES,
};
