/**
 * Stage 5.8 — Staff handoff write-path SQL helpers.
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NOT WIRED / NOT RUNTIME — STATIC DESIGN ONLY                   ║
 * ║  These SQL strings document the intended INSERT/UPSERT logic     ║
 * ║  for when migration 008_add_staff_handoffs.sql is applied and    ║
 * ║  the handoff write path is activated (Stage 5.8+/pilot).         ║
 * ║  Do NOT execute these directly. Do NOT call from any n8n node.   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Design principles:
 *   1. Idempotent — ON CONFLICT prevents duplicate open handoffs for
 *      the same (client_id, conversation_id, reason_code) while any
 *      prior handoff with that key is still open/assigned/waiting.
 *   2. Client-scoped — client_id resolved from clients.slug.
 *   3. Never writes to protected tables (bookings, payments, booking_beds).
 *   4. No Airtable writes triggered.
 *   5. conversation_id / booking_id may be NULL when not yet available.
 *   6. Source channel defaults to 'whatsapp'; bot_mode/stage carried in metadata.
 *
 * Parameters for all write helpers follow this convention:
 *   $1  client_slug TEXT
 *   $2  phone TEXT
 *   $3  reason_code TEXT
 *   $4  summary TEXT
 *   $5  guest_message TEXT
 *   $6  language TEXT  (default 'en')
 *   $7  priority TEXT  (default 'normal')
 *   $8  conversation_id UUID or NULL
 *   $9  booking_id UUID or NULL
 *   $10 metadata JSONB (e.g. { "resolved_route": "...", "bot_version": "..." })
 *
 * @module staff-handoff-write-sql
 */

'use strict';

// ---------------------------------------------------------------------------
// Upsert: open a new handoff, or re-open/escalate an existing open one
// ---------------------------------------------------------------------------

/**
 * Insert a new staff_handoffs row for an inbound handoff event.
 * If an open handoff already exists for (client, conversation, reason_code),
 * updates the summary/guest_message/priority and bumps updated_at instead of
 * creating a duplicate.
 *
 * Idempotency key: (client_id, conversation_id, reason_code) WHERE status IN active set.
 * Booking_id-only idempotency (when conversation_id is NULL) is handled by the
 * separate upsertHandoffByBookingAndReasonSql helper below.
 *
 * NOT WIRED — static design only.
 *
 * @returns {string} Parameterised SQL (params: see module header)
 */
function upsertHandoffByConversationAndReasonSql() {
  return `
-- NOT WIRED / NOT RUNTIME
-- Upsert: open a staff handoff for a conversation + reason_code.
-- On conflict (same open handoff exists), refresh summary/priority/updated_at.
INSERT INTO staff_handoffs (
  client_id,
  conversation_id,
  booking_id,
  phone,
  source_channel,
  reason_code,
  summary,
  guest_message,
  language,
  priority,
  status,
  metadata
)
SELECT
  c.id,
  $8::uuid,
  $9::uuid,
  $2,
  'whatsapp',
  $3,
  $4,
  $5,
  COALESCE($6, 'en'),
  COALESCE($7, 'normal'),
  'open',
  COALESCE($10, '{}')::jsonb
FROM clients c
WHERE c.slug = $1
ON CONFLICT ON CONSTRAINT uq_staff_handoffs_conv_reason_open
DO UPDATE SET
  summary        = EXCLUDED.summary,
  guest_message  = EXCLUDED.guest_message,
  priority       = CASE
                     WHEN EXCLUDED.priority = 'urgent' THEN 'urgent'
                     WHEN EXCLUDED.priority = 'high' AND staff_handoffs.priority NOT IN ('urgent') THEN 'high'
                     ELSE staff_handoffs.priority
                   END,
  metadata       = staff_handoffs.metadata || EXCLUDED.metadata,
  updated_at     = NOW()
RETURNING id::text, reason_code, status, phone, opened_at
`;
}

/**
 * Partial unique index needed in migration 008 for the ON CONFLICT above.
 * Documents the index definition that supports idempotency.
 *
 * This index is NOT yet in migration 008; adding it is the Stage 5.8 migration amendment.
 * The constraint name must match the ON CONFLICT clause above.
 *
 * NOT WIRED — static design only.
 */
const IDEMPOTENCY_INDEX_DDL = `
-- NOT WIRED / NOT RUNTIME
-- Partial unique index for handoff idempotency (add to migration 008 before applying).
CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_handoffs_conv_reason_open
  ON staff_handoffs (client_id, conversation_id, reason_code)
  WHERE conversation_id IS NOT NULL
    AND status IN ('open', 'assigned', 'waiting_guest');
`;

/**
 * Fallback upsert when conversation_id is NULL (early-pipeline handoff,
 * before conversation row is written). Uses booking_id + reason_code.
 * Note: deduplication is weaker here — guards against same booking + reason.
 *
 * NOT WIRED — static design only.
 */
function upsertHandoffByBookingAndReasonSql() {
  return `
-- NOT WIRED / NOT RUNTIME
-- Fallback upsert for handoffs where conversation_id is not yet available.
INSERT INTO staff_handoffs (
  client_id,
  conversation_id,
  booking_id,
  phone,
  source_channel,
  reason_code,
  summary,
  guest_message,
  language,
  priority,
  status,
  metadata
)
SELECT
  c.id,
  NULL,
  $9::uuid,
  $2,
  'whatsapp',
  $3,
  $4,
  $5,
  COALESCE($6, 'en'),
  COALESCE($7, 'normal'),
  'open',
  COALESCE($10, '{}')::jsonb
FROM clients c
WHERE c.slug = $1
ON CONFLICT ON CONSTRAINT uq_staff_handoffs_booking_reason_open
DO UPDATE SET
  summary       = EXCLUDED.summary,
  guest_message = EXCLUDED.guest_message,
  updated_at    = NOW()
RETURNING id::text, reason_code, status, phone, opened_at
`;
}

/**
 * Partial unique index for booking-only idempotency (add to migration 008).
 *
 * NOT WIRED — static design only.
 */
const IDEMPOTENCY_INDEX_BOOKING_DDL = `
-- NOT WIRED / NOT RUNTIME
CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_handoffs_booking_reason_open
  ON staff_handoffs (client_id, booking_id, reason_code)
  WHERE booking_id IS NOT NULL
    AND conversation_id IS NULL
    AND status IN ('open', 'assigned', 'waiting_guest');
`;

// ---------------------------------------------------------------------------
// Resolve/close a handoff
// ---------------------------------------------------------------------------

/**
 * Mark a handoff resolved when staff have handled it (or the bot detects
 * the issue was resolved — e.g. payment confirmed after payment_claimed handoff).
 *
 * Parameters:
 *   $1  client_slug TEXT
 *   $2  handoff_id UUID
 *   $3  resolution_summary TEXT
 *
 * NOT WIRED — static design only.
 */
function resolveHandoffSql() {
  return `
-- NOT WIRED / NOT RUNTIME
UPDATE staff_handoffs h
SET
  status             = 'resolved',
  resolved_at        = NOW(),
  resolution_summary = $3,
  updated_at         = NOW()
FROM clients c
WHERE c.slug = $1
  AND h.id = $2::uuid
  AND h.client_id = c.id
  AND h.status NOT IN ('resolved', 'cancelled')
RETURNING h.id::text, h.reason_code, h.resolved_at
`;
}

// ---------------------------------------------------------------------------
// Handoff reason → reason_code mapping table (static reference)
// ---------------------------------------------------------------------------

/**
 * Maps the BSR/router resolved_route and trigger signals to the appropriate
 * staff_handoffs.reason_code.
 *
 * This is the runtime routing table that the write-path code node will use.
 * NOT WIRED — documents the intent for Stage 5.8+ implementation.
 */
const HANDOFF_REASON_MAP = Object.freeze({
  // resolved_route → reason_code (primary mapping)
  existing_booking_cancel:          'cancellation_request',
  existing_booking_modify:          'date_change_paid_booking',
  existing_booking:                 'staff_required',

  // router_route (pre-BSR) → reason_code (secondary, when BSR doesn't re-route)
  payment_completed_claim:          'payment_claimed',
  human_handoff:                    'unclear_request',

  // signal-based overrides (checked before route mapping)
  // signals: has_escalation_signals=true → escalate reason to guest_angry
  // signals: has_explicit_rooming_or_reassign_signals=true → manual_rooming_review
  // pending_action: add_on_staff_required → add_on_staff_required
});

/**
 * Priority defaults by reason_code.
 * These are the starting priorities; the bot/staff can escalate.
 */
const HANDOFF_PRIORITY_DEFAULTS = Object.freeze({
  cancellation_request:             'high',
  refund_request:                   'high',
  date_change_paid_booking:         'high',
  payment_claimed:                  'high',
  payment_claimed_no_record:        'urgent',
  guest_angry:                      'urgent',
  unclear_request:                  'normal',
  staff_required:                   'normal',
  manual_rooming_review:            'normal',
  add_on_staff_required:            'normal',
});

module.exports = {
  // NOT WIRED helpers
  upsertHandoffByConversationAndReasonSql,
  upsertHandoffByBookingAndReasonSql,
  resolveHandoffSql,
  // Static reference data
  IDEMPOTENCY_INDEX_DDL,
  IDEMPOTENCY_INDEX_BOOKING_DDL,
  HANDOFF_REASON_MAP,
  HANDOFF_PRIORITY_DEFAULTS,
};
