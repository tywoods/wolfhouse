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
 *   - Customers CRM rows are upserted on inbound WhatsApp touch via
 *     staff-customer-queries.upsertCustomerFromInboundTouch (Hermes mirror path);
 *     conversation INSERT also syncs via migration 031 trigger when applied.
 *
 * @module staff-conversation-queries
 */

'use strict';

const {
  DEFAULT_SUNSET_LOCATION_ID,
  sqlConversationLocationExpr,
  sqlConversationLocationMatch,
} = require('./sunset-school-locations');

/** Channel of a conversation row; WhatsApp is the pre-email default. */
function sqlConversationChannelExpr(convAlias) {
  const conv = convAlias || 'conv';
  return `COALESCE(${conv}.metadata->>'channel', ${conv}.session_state->>'channel', 'whatsapp')`;
}

/**
 * Current email subject from persisted inbound events + outbound staff replies.
 * Does not invent placeholder subjects and does not copy conversation metadata.
 */
function sqlCurrentEmailSubjectExpr(convAlias) {
  const conv = convAlias || 'conv';
  return `(
    SELECT sub.subject
    FROM (
      SELECT ev.subject AS subject, ev.received_at AS occurred_at, ev.id::text AS tie
      FROM tenant_email_inbound_inbox_projections p
      INNER JOIN tenant_email_inbound_events ev
        ON ev.client_id = p.client_id AND ev.id = p.inbound_event_id
      WHERE p.client_id = ${conv}.client_id AND p.conversation_id = ${conv}.id
        AND ev.subject IS NOT NULL AND btrim(ev.subject) <> ''
      UNION ALL
      SELECT NULLIF(m.metadata->>'email_subject', ''), m.created_at, m.id::text
      FROM messages m
      WHERE m.client_id = ${conv}.client_id AND m.conversation_id = ${conv}.id
        AND m.direction = 'outbound'
        AND m.source = 'staff_email_reply'
        AND m.route = 'email'
        AND NULLIF(m.metadata->>'email_subject', '') IS NOT NULL
    ) sub
    WHERE sub.subject IS NOT NULL AND btrim(sub.subject) <> ''
    ORDER BY sub.occurred_at DESC NULLS LAST, sub.tie DESC
    LIMIT 1
  )`;
}

function inboxChannelFieldsSql() {
  return `
  ${sqlConversationChannelExpr('conv')} AS channel,
  conv.email                                         AS guest_email,
  ${sqlCurrentEmailSubjectExpr('conv')}              AS email_subject,
  ${sqlConversationLocationExpr('conv')}             AS location_id,`;
}

function inboxLocationWhereClause(scoped, paramIndex = 2) {
  return scoped ? `\n  AND ${sqlConversationLocationMatch('conv', paramIndex)}` : '';
}

/** $1 client slug, $2 location when location-scoped, so channel lands after both. */
function conversationInboxChannelParamIndex(locationScoped) {
  return locationScoped ? 3 : 2;
}

function inboxChannelWhereClause(scoped, paramIndex) {
  return scoped ? `\n  AND ${sqlConversationChannelExpr('conv')} = $${paramIndex}` : '';
}

function detailLocationWhereClause(scoped, paramIndex = 3) {
  return scoped ? `\n  AND ${sqlConversationLocationMatch('conv', paramIndex)}` : '';
}

/** Handoff urgency rank — owner of the inbox sort, the projection and the cursor. */
const CONVERSATION_INBOX_PRIORITY_RANK_SQL = `CASE h.priority
    WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
    WHEN 'normal' THEN 2 ELSE 4
  END`;

/** Row fields carrying the inbox sort key, in ORDER BY order. */
const CONVERSATION_INBOX_CURSOR_FIELDS = Object.freeze([
  'needs_human',
  'handoff_priority_rank',
  'last_activity',
  'conversation_id',
]);

/**
 * Tenant, status, location and channel scope of the inbox. The row query and the
 * counts query share this verbatim so a view count cannot cover a different set
 * of conversations than the view lists.
 */
function inboxNeedsHumanWhereClause(scoped) {
  return scoped ? '\n  AND conv.needs_human = TRUE' : '';
}

function conversationInboxWhereSql(scoped, channelScoped, needsHumanScoped) {
  return `WHERE c.slug = $1
  AND conv.status IN ('open', 'on_hold')${inboxLocationWhereClause(scoped)}${inboxChannelWhereClause(channelScoped, conversationInboxChannelParamIndex(scoped))}${inboxNeedsHumanWhereClause(needsHumanScoped)}`;
}

/**
 * Rows strictly after the cursor under the inbox ORDER BY. conv.id breaks ties so
 * a page boundary cannot repeat or skip a thread when a new message lands.
 */
function conversationInboxCursorClause(paramIndex) {
  const attention = `$${paramIndex}::boolean`;
  const rank = `$${paramIndex + 1}::int`;
  const activity = `$${paramIndex + 2}::timestamptz`;
  const id = `$${paramIndex + 3}::uuid`;
  return `
  AND (
    conv.needs_human < ${attention}
    OR (
      conv.needs_human = ${attention}
      AND (
        (${CONVERSATION_INBOX_PRIORITY_RANK_SQL}) > ${rank}
        OR (
          (${CONVERSATION_INBOX_PRIORITY_RANK_SQL}) = ${rank}
          AND (
            conv.updated_at < ${activity}
            OR (conv.updated_at = ${activity} AND conv.id > ${id})
          )
        )
      )
    )
  )`;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.locationScoped]
 * @param {boolean} [opts.channelScoped]
 * @param {boolean} [opts.needsHumanScoped] - Inbox "Needs human" view: only
 *   conversations.needs_human = TRUE (independent of CRM customers)
 * @param {{ limitParamIndex: number, cursorParamIndex?: number|null }} [opts.keyset]
 *   keyset page: bound LIMIT, tie-broken ORDER BY and the rank column the cursor
 *   carries, instead of the fixed LIMIT 200 of the legacy inbox list
 * @returns {string} $1 = client slug; when locationScoped, $2 = location_id;
 *   when channelScoped, the next index is the channel value
 */
function getConversationInboxQuery(opts = {}) {
  const scoped = !!opts.locationScoped;
  const channelScoped = !!opts.channelScoped;
  const needsHumanScoped = !!opts.needsHumanScoped;
  const keyset = opts.keyset && typeof opts.keyset === 'object' ? opts.keyset : null;
  const cursorParamIndex = keyset && keyset.cursorParamIndex ? keyset.cursorParamIndex : null;
  const rankProjection = keyset
    ? `\n  ${CONVERSATION_INBOX_PRIORITY_RANK_SQL} AS handoff_priority_rank,`
    : '';
  const cursorClause = cursorParamIndex ? conversationInboxCursorClause(cursorParamIndex) : '';
  const pageSql = keyset
    ? `ORDER BY
  conv.needs_human DESC,
  ${CONVERSATION_INBOX_PRIORITY_RANK_SQL} ASC,
  conv.updated_at DESC,
  conv.id ASC
LIMIT $${keyset.limitParamIndex}`
    : `ORDER BY
  conv.needs_human DESC,
  ${CONVERSATION_INBOX_PRIORITY_RANK_SQL} ASC,
  conv.updated_at DESC
LIMIT 200`;
  return `
SELECT
  conv.id::text              AS conversation_id,
  conv.phone,
  COALESCE(NULLIF(btrim(conv.display_name), ''), NULLIF(btrim(b.guest_name), ''), bphone.guest_name) AS guest_name,
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
${inboxChannelFieldsSql()}${rankProjection}
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
LEFT JOIN LATERAL (
  SELECT bk.guest_name
  FROM bookings bk
  WHERE bk.client_id = conv.client_id
    AND bk.phone = conv.phone
    AND NULLIF(btrim(bk.guest_name), '') IS NOT NULL
  ORDER BY bk.created_at DESC
  LIMIT 1
) bphone ON TRUE
${conversationInboxWhereSql(scoped, channelScoped, needsHumanScoped)}${cursorClause}
${pageSql}
`;
}

/**
 * One aggregate pass covering every conversation-source saved view. The channel
 * views become `COUNT(*) FILTER (WHERE <channel> = $n)` columns over the same
 * scan, and the Needs-human view becomes
 * `COUNT(*) FILTER (WHERE conv.needs_human = TRUE)`, so the rail costs one query
 * here no matter how many conversation views exist.
 *
 * The list query's LEFT JOIN LATERALs are omitted: each yields at most one row,
 * so they cannot change the count.
 *
 * @param {object} opts
 * @param {boolean} [opts.locationScoped]
 * @param {Array<{ key: string, channel: string|null, needsHuman?: boolean }>} opts.columns
 *   channel null + needsHuman false counts every conversation in scope;
 *   needsHuman true counts conversations.needs_human = TRUE only
 * @returns {string} SQL ($1 client slug; optional $2 location; then one param per
 *   channel column, in column order)
 */
function getConversationInboxCountsQuery(opts) {
  const scoped = !!(opts && opts.locationScoped);
  const columns = Array.isArray(opts && opts.columns) ? opts.columns : [];
  if (!columns.length) {
    throw new Error('getConversationInboxCountsQuery: at least one column is required');
  }
  let channelParam = conversationInboxChannelParamIndex(scoped);
  const seen = new Set();
  const selected = columns.map((column) => {
    const key = String((column && column.key) || '');
    if (!/^[a-z][a-z0-9_]{0,60}$/.test(key)) {
      throw new Error(`getConversationInboxCountsQuery: invalid count key ${JSON.stringify(key)}`);
    }
    if (seen.has(key)) {
      throw new Error(`getConversationInboxCountsQuery: duplicate count key ${JSON.stringify(key)}`);
    }
    seen.add(key);
    // Quoted because view ids are free to collide with reserved words ("all").
    if (column && column.needsHuman) {
      return `  COUNT(*) FILTER (WHERE conv.needs_human = TRUE)::int AS "${key}"`;
    }
    if (!column.channel) return `  COUNT(*)::int AS "${key}"`;
    const idx = channelParam;
    channelParam += 1;
    return `  COUNT(*) FILTER (WHERE ${sqlConversationChannelExpr('conv')} = $${idx})::int AS "${key}"`;
  });

  return `
SELECT
${selected.join(',\n')}
FROM conversations conv
INNER JOIN clients c ON c.id = conv.client_id
${conversationInboxWhereSql(scoped, false, false)}
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
  COALESCE(NULLIF(btrim(conv.display_name), ''), NULLIF(btrim(b.guest_name), ''), bphone.guest_name) AS guest_name,
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
  ${sqlCurrentEmailSubjectExpr('conv')} AS email_subject,
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
  SELECT bk.guest_name
  FROM bookings bk
  WHERE bk.client_id = conv.client_id
    AND bk.phone = conv.phone
    AND NULLIF(btrim(bk.guest_name), '') IS NOT NULL
  ORDER BY bk.created_at DESC
  LIMIT 1
) bphone ON TRUE
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
  // email_subject / body_text are staff-portal display projections.
  // Storage truth remains messages.message_text:
  //   - email_inbound bridge (Slice 2): message_text holds subject only
  //   - outbound staff email: message_text holds the sent body
  //   - WhatsApp: message_text is the body (email_* null)
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
  m.metadata->>'guest_tester_class' AS guest_tester_class,
  CASE
    WHEN m.source = 'email_inbound' OR m.route = 'email' OR m.metadata->>'channel' = 'email'
      THEN COALESCE(
        NULLIF(m.metadata->>'email_subject', ''),
        CASE WHEN m.source = 'email_inbound' THEN m.message_text ELSE NULL END
      )
    ELSE NULL
  END AS email_subject,
  CASE
    WHEN m.source = 'email_inbound'
      THEN COALESCE(NULLIF(m.metadata->>'body_text', ''), NULLIF(m.metadata->>'body', ''), '')
    WHEN m.route = 'email' OR m.metadata->>'channel' = 'email'
      OR m.source IN ('staff_email_reply', 'staff_inbox_reply', 'email_outbound')
      THEN m.message_text
    ELSE NULL
  END AS body_text
FROM messages m
INNER JOIN conversations conv ON conv.id = m.conversation_id
INNER JOIN clients c ON c.id = conv.client_id
WHERE c.slug = $1
  AND m.conversation_id = $2::uuid${detailLocationWhereClause(scoped)}
ORDER BY m.created_at ASC
LIMIT 500
`;
}

/**
 * Project a messages-query row into the staff portal thread DTO.
 * Field ownership:
 *   - message_text: durable messages.message_text (storage truth)
 *   - email_subject: email subject when known (inbound subject-only storage or metadata)
 *   - body_text: email body for display when known; never invents body from subject
 *
 * @param {object} row
 * @returns {object}
 */
function projectStaffInboxThreadMessage(row) {
  if (!row || typeof row !== 'object') return row;
  const messageText = row.message_text == null ? '' : String(row.message_text);
  const source = row.source == null ? '' : String(row.source);
  const route = row.route == null ? '' : String(row.route);
  const isEmail = source === 'email_inbound'
    || route === 'email'
    || source === 'staff_email_reply'
    || source === 'email_outbound'
    || (row.email_subject != null && String(row.email_subject).length > 0)
    || (row.body_text != null && String(row.body_text).length > 0);

  let emailSubject = row.email_subject == null ? null : String(row.email_subject);
  let bodyText = row.body_text == null ? null : String(row.body_text);

  if (source === 'email_inbound') {
    if (!emailSubject) emailSubject = messageText || null;
    if (bodyText == null) bodyText = '';
  } else if (isEmail) {
    if (bodyText == null || bodyText === '') bodyText = messageText;
  }

  const out = { ...row, message_text: messageText };
  if (emailSubject != null && emailSubject !== '') out.email_subject = emailSubject;
  else if ('email_subject' in out) delete out.email_subject;
  if (bodyText != null) out.body_text = bodyText;
  else if ('body_text' in out) delete out.body_text;
  return out;
}

/**
 * Staff-visible bubble body for a thread message DTO.
 * Prefers body_text when present (including empty string for subject-only inbound);
 * otherwise falls back to message_text (WhatsApp / legacy).
 *
 * @param {object} m
 * @returns {string}
 */
function staffInboxThreadMessageBody(m) {
  if (!m || typeof m !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(m, 'body_text') && m.body_text != null) {
    return String(m.body_text);
  }
  return m.message_text == null ? '' : String(m.message_text);
}

/**
 * Staff-visible subject for an email thread message (empty when not email).
 * @param {object} m
 * @returns {string}
 */
function staffInboxThreadMessageSubject(m) {
  if (!m || typeof m !== 'object') return '';
  if (m.email_subject != null && String(m.email_subject).length) return String(m.email_subject);
  if (m.subject != null && String(m.subject).length) return String(m.subject);
  return '';
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
  sqlConversationChannelExpr,
  sqlCurrentEmailSubjectExpr,
  conversationInboxChannelParamIndex,
  conversationInboxWhereSql,
  conversationInboxCursorClause,
  CONVERSATION_INBOX_CURSOR_FIELDS,
  CONVERSATION_INBOX_PRIORITY_RANK_SQL,
  getConversationInboxQuery,
  getConversationInboxCountsQuery,
  getConversationDetailQuery,
  getConversationMessagesQuery,
  projectStaffInboxThreadMessage,
  staffInboxThreadMessageBody,
  staffInboxThreadMessageSubject,
  getConversationContextQuery,
  getConversationBookingsQuery,
  getConversationDraftQuery,
  getConversationStaffStateQuery,
};
