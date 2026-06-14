/**
 * Stage 8.3k — Static SQL helper: manual booking rollback/undo from Staff Portal.
 *
 * NOT WIRED — no API route calls this yet.
 * NOT RUNTIME API — do not call directly from application code without the
 *                   explicit BEGIN / COMMIT transaction managed by the caller.
 * NO WhatsApp / Stripe / n8n — no refund, no confirmation send, no guest message.
 * NO STAFF_ACTIONS_ENABLED toggle — caller must gate on that flag.
 * LOCAL / TEST PROOF ONLY — this helper is proven safe by the Stage 8.3k
 *                            fixture proof; no production API wiring exists.
 *
 * Design: buildManualBookingRollbackSql() returns a parameterised SQL string
 * suitable for pg.query(sql, params) inside a transaction.
 *
 * Purpose:
 *   Undo a manual booking created by buildManualBookingCreateSql() (Stage 8.3j).
 *   Uses the rollback_payload returned by the create helper to identify and
 *   safely delete the exact rows that were created: the booking, its
 *   booking_beds, and any draft payment rows.
 *
 *   Deletion is achieved via DELETE FROM bookings; the ON DELETE CASCADE
 *   constraints on booking_beds and payments ensure dependent rows are
 *   automatically removed when the booking is deleted. Pre-capture CTEs
 *   record which rows existed before deletion for audit and reporting.
 *
 * Parameter contract ($1 … $8):
 *   $1   client_slug        TEXT      — hostel slug
 *   $2   staff_user_id      TEXT      — staff actor UUID (auth by caller)
 *   $3   staff_role         TEXT      — must be 'admin' | 'owner'
 *   $4   booking_id         UUID      — from rollback_payload.booking_id
 *   $5   booking_code       TEXT      — from rollback_payload.booking_code;
 *                                       cross-checked against actual booking
 *   $6   rollback_payload   JSONB     — full payload from create helper;
 *                                       booking_id/booking_code verified
 *   $7   reason             TEXT      — staff reason for rollback
 *   $8   confirm            BOOLEAN   — must be TRUE; hard block if FALSE
 *
 * Mutation scope (all scoped to the exact booking_id):
 *   bookings           — DELETE WHERE id = $4 AND booking_source = 'manual_staff'
 *   booking_beds       — CASCADE-deleted when booking is deleted
 *   payments           — CASCADE-deleted when booking is deleted
 *                        (blocked if any non-draft payment exists — §B8)
 *   workflow_events    — INSERT audit row on every attempt (blocked or not)
 *
 * Safety blockers (see MANUAL_BOOKING_ROLLBACK_BLOCK_CODES):
 *   B1. confirm_not_set           — $8 must be TRUE
 *   B2. staff_role_insufficient   — $3 must be 'admin' | 'owner'
 *   B3. client_not_found          — $1 slug must resolve
 *   B4. booking_not_found         — $4 UUID must exist for the client
 *   B5. not_manual_staff_booking  — booking_source must be 'manual_staff'
 *   B6. not_manual_created        — metadata.manual_created must be 'true'
 *   B7. confirmation_already_sent — confirmation_sent_at must be NULL
 *   B8. unsafe_payment_exists     — no paid/checkout_created payments
 *   B9. rollback_payload_code_mismatch  — $5 must match actual booking_code
 *   B10. rollback_payload_id_mismatch   — $6->booking_id must match $4
 *
 * Audit:
 *   workflow_events row written on EVERY attempt (blocked or not).
 *   workflow_name = 'staff_manual_booking_rollback'
 *   message = 'manual_booking_rollback attempt blocked=true|false'
 *   booking_id is NULL (the booking will be deleted; avoids FK confusion).
 *
 * @returns {string} Parameterised SQL (params: see §Parameter contract above)
 */

'use strict';

// ---------------------------------------------------------------------------
// Block code registry
// ---------------------------------------------------------------------------

const MANUAL_BOOKING_ROLLBACK_BLOCK_CODES = Object.freeze({
  CONFIRM_NOT_SET:               'confirm_not_set',
  STAFF_ROLE_INSUFFICIENT:       'staff_role_insufficient',
  CLIENT_NOT_FOUND:              'client_not_found',
  BOOKING_NOT_FOUND:             'booking_not_found',
  NOT_MANUAL_STAFF_BOOKING:      'not_manual_staff_booking',
  NOT_MANUAL_CREATED:            'not_manual_created',
  CONFIRMATION_ALREADY_SENT:     'confirmation_already_sent',
  UNSAFE_PAYMENT_EXISTS:         'unsafe_payment_exists',
  ROLLBACK_PAYLOAD_CODE_MISMATCH:'rollback_payload_code_mismatch',
  ROLLBACK_PAYLOAD_ID_MISMATCH:  'rollback_payload_id_mismatch',
});

/**
 * Staff roles permitted to perform a manual booking rollback.
 * Stricter than create (admin/owner only) because rollback is destructive.
 */
const MANUAL_BOOKING_ROLLBACK_ALLOWED_ROLES = Object.freeze(['admin', 'owner']);

// ---------------------------------------------------------------------------
// Main helper
// ---------------------------------------------------------------------------

/**
 * Returns a CTE-based SQL string for safe, single-transaction manual booking
 * rollback / undo.
 *
 * The query:
 *   1.  Resolves and validates the client (ctx CTE).
 *   2.  Resolves the target booking (booking_check CTE).
 *   3.  Checks for unsafe (non-draft) payments (payment_safety CTE).
 *   4.  Evaluates all hard blockers (blockers CTE, blocked_summary CTE).
 *   5.  Pre-captures booking_bed and payment IDs for reporting (pre_beds,
 *       pre_payments CTEs) — these rows will be cascade-deleted with the
 *       booking.
 *   6.  Deletes the booking row (deleted_booking CTE) — ON DELETE CASCADE
 *       on booking_beds and payments removes dependent rows automatically.
 *       Guarded: only runs when not blocked AND booking_source='manual_staff'.
 *   7.  Builds rollback audit payload (rollback_audit_payload_cte CTE).
 *   8.  Writes workflow_events audit row on every attempt (audit_written CTE).
 *   9.  Returns a structured final SELECT row.
 *
 * NOT WIRED — no API route uses this function yet.
 *
 * @returns {string} Parameterised SQL (params: see module header §Parameter contract)
 */
function buildManualBookingRollbackSql() {
  return `
-- ============================================================================
-- NOT WIRED / NOT RUNTIME API — staff manual booking rollback (Stage 8.3k)
-- Must be executed inside an explicit BEGIN / COMMIT transaction by caller.
-- No WhatsApp. No Stripe. No n8n. No refund. No guest message.
-- Params: $1=client_slug $2=staff_user_id $3=staff_role
--         $4=booking_id(uuid) $5=booking_code $6=rollback_payload(jsonb)
--         $7=reason $8=confirm::boolean
-- ============================================================================

WITH

-- ── 1. Resolve client ────────────────────────────────────────────────────────
ctx AS (
  SELECT c.id   AS client_id,
         c.slug AS client_slug
  FROM   clients c
  WHERE  c.slug = $1::text
),

-- ── 2. Resolve target booking ─────────────────────────────────────────────────
booking_check AS (
  SELECT bk.id,
         bk.booking_code,
         bk.booking_source,
         bk.confirmation_sent_at,
         bk.status,
         bk.metadata,
         bk.client_id
  FROM   bookings bk
  CROSS JOIN ctx
  WHERE  bk.id        = $4::uuid
    AND  bk.client_id = ctx.client_id
),

-- ── 3. Payment safety check ───────────────────────────────────────────────────
-- Block if any payment for this booking is in a non-reversible state:
-- paid, checkout_created, or pending (waiting for a Stripe callback).
-- draft, cancelled, failed, expired payments are safe to cascade-delete.
payment_safety AS (
  SELECT COUNT(*)::int AS unsafe_count
  FROM   payments p
  CROSS JOIN ctx
  WHERE  p.booking_id = $4::uuid
    AND  p.client_id  = ctx.client_id
    AND  p.status::text NOT IN ('draft', 'cancelled', 'failed', 'expired')
),

-- ── 4. Blocker determination ──────────────────────────────────────────────────
blockers AS (
  SELECT
    -- B1. confirm not set — must be TRUE before any write
    CASE WHEN NOT ($8::boolean IS TRUE)
         THEN 'confirm_not_set'::text END                         AS b_confirm,

    -- B2. Staff role insufficient (admin/owner only for destructive rollback)
    CASE WHEN $3::text NOT IN ('admin', 'owner')
         THEN 'staff_role_insufficient'::text END                 AS b_role,

    -- B3. Client not found
    CASE WHEN (SELECT COUNT(*) FROM ctx) = 0
         THEN 'client_not_found'::text END                        AS b_client,

    -- B4. Booking not found (or belongs to different client)
    CASE WHEN (SELECT COUNT(*) FROM booking_check) = 0
         THEN 'booking_not_found'::text END                       AS b_booking,

    -- B5. Not a manual_staff booking
    CASE WHEN (SELECT COUNT(*) FROM booking_check) > 0
          AND (SELECT booking_source::text FROM booking_check) <> 'manual_staff'
         THEN 'not_manual_staff_booking'::text END                AS b_source,

    -- B6. metadata.manual_created not 'true' — extra guard for non-fixture rows
    CASE WHEN (SELECT COUNT(*) FROM booking_check) > 0
          AND (SELECT metadata->>'manual_created' FROM booking_check)
              IS DISTINCT FROM 'true'
         THEN 'not_manual_created'::text END                      AS b_manual,

    -- B7. Confirmation already sent — do not rollback a confirmed/sent booking
    CASE WHEN (SELECT COUNT(*) FROM booking_check) > 0
          AND (SELECT confirmation_sent_at FROM booking_check) IS NOT NULL
         THEN 'confirmation_already_sent'::text END               AS b_confirmation,

    -- B8. Unsafe (non-draft) payment exists — cannot safely cascade-delete
    CASE WHEN (SELECT unsafe_count FROM payment_safety) > 0
         THEN 'unsafe_payment_exists'::text END                   AS b_payment,

    -- B9. Booking code mismatch between $5 and actual booking
    CASE WHEN $5::text IS NOT NULL
          AND (SELECT COUNT(*) FROM booking_check) > 0
          AND (SELECT booking_code FROM booking_check) <> $5::text
         THEN 'rollback_payload_code_mismatch'::text END          AS b_code,

    -- B10. rollback_payload.booking_id does not match $4
    CASE WHEN ($6::jsonb)->>'booking_id' IS NOT NULL
          AND ($6::jsonb)->>'booking_id' <> $4::text
         THEN 'rollback_payload_id_mismatch'::text END            AS b_payload
),

-- ── 5. Blocked summary ────────────────────────────────────────────────────────
blocked_summary AS (
  SELECT
    COALESCE(
      b_confirm, b_role, b_client, b_booking, b_source, b_manual,
      b_confirmation, b_payment, b_code, b_payload
    )                                                              AS first_blocker,
    (
      b_confirm       IS NOT NULL OR
      b_role          IS NOT NULL OR
      b_client        IS NOT NULL OR
      b_booking       IS NOT NULL OR
      b_source        IS NOT NULL OR
      b_manual        IS NOT NULL OR
      b_confirmation  IS NOT NULL OR
      b_payment       IS NOT NULL OR
      b_code          IS NOT NULL OR
      b_payload       IS NOT NULL
    )                                                              AS is_blocked
  FROM blockers
),

-- ── 6. Pre-capture IDs for audit/reporting ────────────────────────────────────
-- These CTEs run against the initial snapshot (before deletion).
-- Row counts here represent the rows that WILL be cascade-deleted
-- when the booking is deleted (if not blocked).
pre_beds AS (
  SELECT id AS booking_bed_id, bed_code, room_code
  FROM   booking_beds
  CROSS JOIN ctx
  WHERE  booking_beds.booking_id = $4::uuid
    AND  booking_beds.client_id  = ctx.client_id
),

pre_payments AS (
  SELECT id AS payment_id, amount_due_cents, status::text AS payment_status
  FROM   payments
  CROSS JOIN ctx
  WHERE  payments.booking_id = $4::uuid
    AND  payments.client_id  = ctx.client_id
),

-- ── 7. Delete the booking (CASCADE handles booking_beds and payments) ─────────
-- ON DELETE CASCADE on booking_beds.booking_id and payments.booking_id
-- ensures dependent rows are removed when the booking is deleted.
-- Scoped to: correct client + booking_source = 'manual_staff' + not blocked.
deleted_booking AS (
  DELETE FROM bookings
  WHERE  id             = $4::uuid
    AND  client_id      = (SELECT client_id FROM ctx)
    AND  booking_source = 'manual_staff'
    AND  NOT (SELECT is_blocked FROM blocked_summary)
  RETURNING id AS booking_id, booking_code, client_id
),

-- ── 8. Rollback audit payload ─────────────────────────────────────────────────
-- Built on every attempt (blocked and unblocked).
rollback_audit_payload_cte AS (
  SELECT jsonb_build_object(
    'action',                'manual_booking_rollback',
    'staff_user_id',         $2::text,
    'staff_role',            $3::text,
    'client_slug',           $1::text,
    'booking_id',            $4::text,
    'booking_code',          $5::text,
    'reason',                $7::text,
    'is_blocked',            (SELECT is_blocked    FROM blocked_summary),
    'first_blocker',         (SELECT first_blocker FROM blocked_summary),
    'booking_beds_affected', (SELECT COUNT(*)::int FROM pre_beds),
    'payments_affected',     (SELECT COUNT(*)::int FROM pre_payments),
    'beds_freed',            (SELECT jsonb_agg(bed_code ORDER BY bed_code)
                              FROM pre_beds),
    'deleted_booking_id',    (SELECT booking_id::text FROM deleted_booking),
    'rollback_payload_ref',  $6::jsonb
  ) AS payload
),

-- ── 9. Audit event write ──────────────────────────────────────────────────────
-- Written on EVERY attempt (blocked or not).
-- booking_id is NULL to avoid FK confusion (the booking is being deleted).
-- workflow_events.booking_id will be NULL rather than a dangling reference.
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
    'staff_manual_booking_rollback',
    'stage8_3k_rollback',
    'info',
    COALESCE(
      'manual_booking_rollback attempt blocked=' ||
        ((SELECT is_blocked FROM blocked_summary))::text,
      'manual_booking_rollback attempt'
    ),
    NULL::uuid,
    apc.payload
  FROM rollback_audit_payload_cte apc
  WHERE (SELECT client_id FROM ctx) IS NOT NULL
  RETURNING id AS audit_event_id
)

-- ── Final SELECT ──────────────────────────────────────────────────────────────
SELECT
  (SELECT is_blocked            FROM blocked_summary)      AS blocked,
  NOT (SELECT is_blocked        FROM blocked_summary)      AS success,
  (SELECT first_blocker         FROM blocked_summary)      AS block_reason,
  COALESCE($5::text,
           (SELECT booking_code FROM deleted_booking))     AS booking_code,
  (SELECT COUNT(*)::int         FROM deleted_booking)      AS rows_deleted,
  (SELECT COUNT(*)::int         FROM pre_beds)             AS booking_beds_affected,
  (SELECT COUNT(*)::int         FROM pre_payments)         AS payments_affected,
  (SELECT audit_event_id        FROM audit_written)        AS audit_event_id,
  (SELECT payload               FROM rollback_audit_payload_cte) AS rollback_audit_payload
`;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildManualBookingRollbackSql,
  MANUAL_BOOKING_ROLLBACK_BLOCK_CODES,
  MANUAL_BOOKING_ROLLBACK_ALLOWED_ROLES,
};
