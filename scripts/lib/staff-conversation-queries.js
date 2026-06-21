/**
 * Stage 7.7b — Staff conversation query helpers (read-only).
 *
 * Six SELECT-only SQL queries for the Cami review dashboard conversation views:
 *   A. getConversationInboxQuery        — inbox list for view A
 *   B. getConversationDetailQuery       — single conversation for view B
 *   C. getConversationMessagesQuery     — message thread for view B/H
 *   D. getConversationContextQuery      — booking/payment/rooming context for views C/D
 *   E. getConversationDraftQuery        — Luna draft + availability for view H
 *   F. getConversationStaffStateQuery   — bot_mode/handoff/takeover state for view H
 *
 * All queries are scoped by client slug ($1) and are SELECT-only.
 * Parameterised queries — no user-supplied values concatenated into SQL.
 *
 * Design reference: docs/PHASE-7.7-CAMI-REVIEW-DASHBOARD-PLAN.md §3 + §7
 *
 * Gap notes (documented here; no table changes in this slice):
 *   - No dedicated draft_history table yet: draft is read from
 *     conversations.staff_reply_draft (single field, overwritten each Luna run).
 *     Per 7.7 plan §7, a persistent draft history endpoint is deferred.
 *   - add_on_orders are NOT yet joined in context (deferred — requires
 *     a date-range param; see staff-addon-queries.js for those helpers).
 *   - Conversation messages exist in the `messages` table (migration 001 +
 *     003 rename hostel_id → client_id); messages may be sparse or absent for
 *     fixture-only conversations seeded without a WhatsApp source.
 *
 * @module staff-conversation-queries
 */

'use strict';

const {
  DEFAULT_SUNSET_LOCATION_ID,
  sqlConversationLocationExpr,
  sqlConversationLocationMatch,
} = require('./sunset-school-locations');

function inboxChannelFieldsSql() {
  return `
  COALESCE(conv.metadata->>'channel', conv.session_state->>'channel', 'whatsapp') AS channel,
  conv.email                                         AS guest_email,
  conv.metadata->>'email_subject'                    AS email_subject,
  ${sqlConversationLocationExpr('conv')}             AS location_id,`;
}

function inboxLocationWhereClause(scoped, paramIndex = 2) {
  return scoped ? `\n  AND ${sqlConversationLocationMatch('conv', paramIndex)}` : '';
}

function detailLocationWhereClause(scoped, paramIndex = 3) {
  return scoped ? `\n  AND ${sqlConversationLocationMatch('conv', paramIndex)}` : '';
}

/**
 * @param {{ locationScoped?: boolean }} [opts]
 * @returns {string} $1 = client slug; when locationScoped, $2 = location_id
 */
function getConversationInboxQuery(opts = {}) {
  const scoped = !!opts.locationScoped;
  return `
SELECT
  conv.id::text              AS conversation_id,
  conv.phone,
  conv.display_name          AS guest_name,
  conv.language,
  conv.bot_mode::text,
  conv.needs_human,
  conv.status::text          AS conversation_status,
  conv.conversation_stage,
  conv.last_message_preview,
  conv.pending_action,
  conv.updated_at            AS last_activity,
  CASE WHEN conv.metadata->>'open_phone_testing' = 'true' THEN TRUE ELSE FALSE END AS open_phone_testing,
  conv.metadata->>'guest_tester_class' AS guest_tester_class,
${inboxChannelFieldsSql()}
  h.reason_code              AS handoff_reason,
  h.priority                 AS handoff_priority,
  h.status::text             AS handoff_status,
  b.booking_code,
  COALESCE(pause.paused, FALSE) AS luna_paused
FROM conversations conv
INNER JOIN clients c ON c.id = conv.client_id
LEFT JOIN LATERAL (
  SELECT reason_code, priority, status
  FROM staff_handoffs
  WHERE conversation_id = conv.id
    AND status IN ('open', 'assigned', 'waiting_guest')
  ORDER BY
    CASE priority
      WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
      WHEN 'normal' THEN 2 ELSE 3
    END ASC,
    opened_at DESC
  LIMIT 1
) h ON TRUE
LEFT JOIN LATERAL (
  SELECT TRUE AS paused
  FROM bot_pause_states bps
  WHERE bps.conversation_id = conv.id::text
    AND bps.client_slug = c.slug
    AND bps.paused = TRUE
  ORDER BY bps.paused_at DESC
  LIMIT 1
) pause ON TRUE
LEFT JOIN bookings b ON b.id = conv.current_hold_booking_id
WHERE c.slug = $1
  AND conv.status IN ('open', 'on_hold')${inboxLocationWhereClause(scoped)}
ORDER BY
  conv.needs_human DESC,
  CASE h.priority
    WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
    WHEN 'normal' THEN 2 ELSE 4
  END ASC,
  conv.updated_at DESC
LIMIT 200
`;
}

// ---------------------------------------------------------------------------
// B. Detail — single conversation with linked booking / handoff overview
// ---------------------------------------------------------------------------

/**
 * @param {{ locationScoped?: boolean }} [opts]
 * @returns {string} $1 client; $2 conv id; when locationScoped $3 location_id
 */
function getConversationDetailQuery(opts = {}) {
  const scoped = !!opts.locationScoped;
  return `
SELECT
  conv.id::text              AS conversation_id,
  conv.phone,
  conv.display_name          AS guest_name,
  conv.email,
  conv.language,
  conv.bot_mode::text,
  conv.needs_human,
  conv.status::text          AS conversation_status,
  conv.conversation_stage,
  conv.pending_action,
  conv.last_message_preview,
  conv.last_bot_reply,
  conv.staff_reply_draft,
  conv.human_notes,
  conv.internal_staff_notes,
  conv.last_staff_reply_at,
  conv.conversation_summary,
  conv.created_at,
  conv.updated_at,
  COALESCE(conv.metadata->>'channel', conv.session_state->>'channel', 'whatsapp') AS channel,
  conv.metadata->>'email_subject' AS email_subject,
  ${sqlConversationLocationExpr('conv')} AS location_id,
  b.id::text                 AS booking_id,
  b.booking_code,
  b.status::text             AS booking_status,
  b.payment_status::text     AS booking_payment_status,
  b.check_in,
  b.check_out,
  h.id::text                 AS handoff_id,
  h.reason_code              AS handoff_reason,
  h.priority                 AS handoff_priority,
  h.status::text             AS handoff_status,
  h.summary                  AS handoff_summary,
  h.assigned_staff,
  h.opened_at                AS handoff_opened_at
FROM conversations conv
INNER JOIN clients c ON c.id = conv.client_id
LEFT JOIN bookings b ON b.id = conv.current_hold_booking_id
LEFT JOIN LATERAL (
  SELECT id, reason_code, priority, status, summary, assigned_staff, opened_at
  FROM staff_handoffs
  WHERE conversation_id = conv.id
    AND status IN ('open', 'assigned', 'waiting_guest')
  ORDER BY opened_at DESC
  LIMIT 1
) h ON TRUE
WHERE c.slug = $1
  AND conv.id = $2::uuid${detailLocationWhereClause(scoped)}
`;
}

// ---------------------------------------------------------------------------
// C. Messages — message thread for conversation view B/H
// ---------------------------------------------------------------------------

/**
 * @param {{ locationScoped?: boolean }} [opts]
 */
function getConversationMessagesQuery(opts = {}) {
  const scoped = !!opts.locationScoped;
  return `
SELECT
  m.id::text                 AS message_id,
  m.direction::text,
  m.message_text,
  m.language,
  m.route,
  m.source,
  m.conversation_stage,
  m.created_at,
  CASE WHEN m.metadata->>'open_phone_testing' = 'true' THEN TRUE ELSE FALSE END AS open_phone_testing,
  m.metadata->>'guest_tester_class' AS guest_tester_class
FROM messages m
INNER JOIN conversations conv ON conv.id = m.conversation_id
INNER JOIN clients c ON c.id = conv.client_id
WHERE c.slug = $1
  AND m.conversation_id = $2::uuid${detailLocationWhereClause(scoped)}
ORDER BY m.created_at ASC
LIMIT 500
`;
}

// ---------------------------------------------------------------------------
// D. Context — booking / payment / rooming context for views C/D
// ---------------------------------------------------------------------------

/**
 * Returns booking, payment, and rooming context for the conversation's
 * linked booking (via conversations.current_hold_booking_id).
 *
 * Returns a single row with NULLs for all booking/payment/rooming columns
 * when no booking is linked — the dashboard should show a "no booking linked"
 * state for these conversations.
 *
 * Gap note: add_on_orders are not joined here (they require a date range and
 * are served by staff-addon-queries.js); the dashboard should call the
 * appropriate addon query separately.
 *
 * @returns {string} Parameterised SQL ($1 = client slug, $2 = conversation UUID)
 */
function getConversationContextQuery(opts = {}) {
  const scoped = !!opts.locationScoped;
  return `
SELECT
  conv.id::text              AS conversation_id,
  conv.phone,
  b.id::text                 AS booking_id,
  b.booking_code,
  b.guest_name               AS booking_guest_name,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.status::text             AS booking_status,
  b.payment_status::text     AS booking_payment_status,
  b.hold_expires_at,
  b.confirmation_sent_at,
  b.requested_room_type,
  b.room_preference,
  b.guest_gender_group_type,
  b.assignment_status::text  AS assignment_status,
  b.needs_rooming_review,
  b.rooming_notes,
  b.primary_room_code,
  bb.room_code               AS assigned_room_code,
  bb.bed_code                AS assigned_bed_code,
  bb.planning_row_label,
  p.amount_due_cents         AS payment_amount_due_cents,
  p.amount_paid_cents        AS payment_amount_paid_cents,
  p.payment_record_status,
  p.stripe_payment_intent_id,
  b.booking_source::text     AS booking_source,
  b.metadata->>'source'      AS metadata_source,
  b.metadata->>'channel'     AS metadata_channel,
  b.metadata->>'bot_source'  AS bot_source,
  b.metadata->>'created_by'  AS metadata_created_by,
  b.metadata->>'staff_source' AS staff_source
FROM conversations conv
INNER JOIN clients c ON c.id = conv.client_id
LEFT JOIN bookings b ON b.id = conv.current_hold_booking_id
LEFT JOIN LATERAL (
  SELECT room_code, bed_code, planning_row_label
  FROM booking_beds
  WHERE booking_id = b.id
  ORDER BY assignment_start_date ASC
  LIMIT 1
) bb ON b.id IS NOT NULL
LEFT JOIN LATERAL (
  SELECT amount_due_cents, amount_paid_cents,
         status::text AS payment_record_status,
         stripe_payment_intent_id
  FROM payments
  WHERE booking_id = b.id
  ORDER BY created_at DESC
  LIMIT 1
) p ON b.id IS NOT NULL
WHERE c.slug = $1
  AND conv.id = $2::uuid${detailLocationWhereClause(scoped)}
`;
}

// ---------------------------------------------------------------------------
// D2. All bookings for conversation guest phone (stacked inbox sidebar)
// ---------------------------------------------------------------------------

/**
 * Returns every booking for the conversation's phone on this client, with the
 * same payment/rooming fields as getConversationContextQuery per row.
 * Linked booking (current_hold_booking_id) sorts first.
 *
 * @returns {string} Parameterised SQL ($1 = client slug, $2 = conversation UUID)
 */
function getConversationBookingsQuery(opts = {}) {
  const scoped = !!opts.locationScoped;
  return `
SELECT
  conv.id::text              AS conversation_id,
  conv.phone,
  b.id::text                 AS booking_id,
  b.booking_code,
  b.guest_name               AS booking_guest_name,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.status::text             AS booking_status,
  b.payment_status::text     AS booking_payment_status,
  b.hold_expires_at,
  b.confirmation_sent_at,
  b.requested_room_type,
  b.room_preference,
  b.guest_gender_group_type,
  b.assignment_status::text  AS assignment_status,
  b.needs_rooming_review,
  b.rooming_notes,
  b.primary_room_code,
  bb.room_code               AS assigned_room_code,
  bb.bed_code                AS assigned_bed_code,
  bb.planning_row_label,
  p.amount_due_cents         AS payment_amount_due_cents,
  p.amount_paid_cents        AS payment_amount_paid_cents,
  p.payment_record_status,
  p.stripe_payment_intent_id,
  (b.id = conv.current_hold_booking_id) AS is_linked,
  b.booking_source::text     AS booking_source,
  b.metadata->>'source'      AS metadata_source,
  b.metadata->>'channel'     AS metadata_channel,
  b.metadata->>'bot_source'  AS bot_source,
  b.metadata->>'created_by'  AS metadata_created_by,
  b.metadata->>'staff_source' AS staff_source
FROM conversations conv
INNER JOIN clients c ON c.id = conv.client_id
INNER JOIN bookings b ON b.client_id = c.id
  AND (
    (b.phone IS NOT NULL AND conv.phone IS NOT NULL AND b.phone = conv.phone)
    OR b.id = conv.current_hold_booking_id
  )
LEFT JOIN LATERAL (
  SELECT room_code, bed_code, planning_row_label
  FROM booking_beds
  WHERE booking_id = b.id
  ORDER BY assignment_start_date ASC
  LIMIT 1
) bb ON TRUE
LEFT JOIN LATERAL (
  SELECT amount_due_cents, amount_paid_cents,
         status::text AS payment_record_status,
         stripe_payment_intent_id
  FROM payments
  WHERE booking_id = b.id
  ORDER BY created_at DESC
  LIMIT 1
) p ON TRUE
WHERE c.slug = $1
  AND conv.id = $2::uuid${detailLocationWhereClause(scoped)}
  AND b.status NOT IN ('cancelled', 'expired')
ORDER BY
  (b.id = conv.current_hold_booking_id) DESC,
  b.check_in DESC NULLS LAST,
  b.created_at DESC
`;
}

// ---------------------------------------------------------------------------
// E. Draft — Luna draft availability for inline reply composer (view H)
// ---------------------------------------------------------------------------

/**
 * Returns the current Luna draft for the conversation if one exists.
 *
 * draft_available=true when staff_reply_draft is non-null and non-empty;
 * the UI pre-populates the inline reply composer with the draft text.
 *
 * draft_available=false with reason "no_draft_stored" when no draft is set;
 * the UI shows the composer empty and ready for Cami to type.
 *
 * Gap note: staff_reply_draft is a single field overwritten on each Luna run.
 * A persistent draft history table is not yet built (deferred per 7.7 plan §7).
 *
 * @returns {string} Parameterised SQL ($1 = client slug, $2 = conversation UUID)
 */
function getConversationDraftQuery(opts = {}) {
  const scoped = !!opts.locationScoped;
  return `
SELECT
  conv.id::text              AS conversation_id,
  conv.staff_reply_draft     AS draft_text,
  CASE
    WHEN conv.staff_reply_draft IS NOT NULL
     AND trim(conv.staff_reply_draft) <> ''
    THEN true
    ELSE false
  END                        AS draft_available,
  CASE
    WHEN conv.staff_reply_draft IS NULL
      OR trim(conv.staff_reply_draft) = ''
    THEN 'no_draft_stored'
    ELSE null
  END                        AS reason,
  conv.last_bot_reply,
  conv.pending_action,
  conv.updated_at            AS draft_updated_at
FROM conversations conv
INNER JOIN clients c ON c.id = conv.client_id
WHERE c.slug = $1
  AND conv.id = $2::uuid${detailLocationWhereClause(scoped)}
`;
}

// ---------------------------------------------------------------------------
// F. Staff state — bot_mode / takeover / handoff state for view H
// ---------------------------------------------------------------------------

/**
 * Returns the current staff-takeover state, bot_mode, and open handoff for
 * the conversation — used by the inline reply composer's takeover controls.
 *
 * bot_mode='bot':   Luna is handling the conversation autonomously.
 * bot_mode='human': Staff has taken over; Luna is paused for this conversation.
 *
 * The takeover write action (POST .../takeover / .../return-to-luna) is
 * DEFERRED; this read-only endpoint exposes current state only.
 *
 * @returns {string} Parameterised SQL ($1 = client slug, $2 = conversation UUID)
 */
function getConversationStaffStateQuery(opts = {}) {
  const scoped = !!opts.locationScoped;
  return `
SELECT
  conv.id::text              AS conversation_id,
  conv.needs_human,
  conv.bot_mode::text,
  conv.pending_action,
  conv.last_staff_reply_at,
  h.id::text                 AS handoff_id,
  h.reason_code              AS handoff_reason,
  h.priority                 AS handoff_priority,
  h.status::text             AS handoff_status,
  h.assigned_staff,
  h.opened_at                AS handoff_opened_at,
  h.first_response_due_at    AS handoff_due_at
FROM conversations conv
INNER JOIN clients c ON c.id = conv.client_id
LEFT JOIN LATERAL (
  SELECT id, reason_code, priority, status, assigned_staff,
         opened_at, first_response_due_at
  FROM staff_handoffs
  WHERE conversation_id = conv.id
    AND status IN ('open', 'assigned', 'waiting_guest')
  ORDER BY opened_at DESC
  LIMIT 1
) h ON TRUE
WHERE c.slug = $1
  AND conv.id = $2::uuid${detailLocationWhereClause(scoped)}
`;
}

module.exports = {
  DEFAULT_SUNSET_LOCATION_ID,
  getConversationInboxQuery,
  getConversationDetailQuery,
  getConversationMessagesQuery,
  getConversationContextQuery,
  getConversationBookingsQuery,
  getConversationDraftQuery,
  getConversationStaffStateQuery,
};
