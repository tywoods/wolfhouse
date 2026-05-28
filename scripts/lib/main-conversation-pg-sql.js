/**
 * Phase 3c.d.4 — PG conversation upsert for current_hold_booking_id (conversations only).
 */
const { resolveClientId, NULL_SENTINEL } = require('./main-booking-hold-pg-sql');

const CLIENT_SLUG = 'wolfhouse-somo';

const ALLOWED_BOOKING_STATUSES = ['hold', 'payment_pending'];

const BLOCKED_BOOKING_STATUSES = ['confirmed', 'checked_in', 'cancelled', 'expired'];

function parseConversationUpsertInput(raw = {}) {
  let sessionStateJson = null;
  if (raw.session_state_json != null) {
    sessionStateJson =
      typeof raw.session_state_json === 'object'
        ? raw.session_state_json
        : JSON.parse(String(raw.session_state_json));
  } else if (raw.session_state != null) {
    sessionStateJson =
      typeof raw.session_state === 'object'
        ? raw.session_state
        : JSON.parse(String(raw.session_state));
  }

  const needsHumanRaw = raw.needs_human ?? raw.needsHuman;
  const botModeRaw = raw.bot_mode ?? raw.botMode;

  return {
    client_slug: String(raw.client_slug ?? raw.clientSlug ?? CLIENT_SLUG).trim(),
    phone: String(raw.phone ?? '').trim(),
    booking_code: String(raw.booking_code ?? raw.bookingCode ?? '').trim(),
    conversation_stage: String(raw.conversation_stage ?? raw.conversationStage ?? '').trim() || null,
    pending_action: String(raw.pending_action ?? raw.pendingAction ?? '').trim() || null,
    language: String(raw.language ?? '').trim() || null,
    airtable_record_id: String(raw.airtable_record_id ?? raw.airtableRecordId ?? '').trim() || null,
    session_state_json: sessionStateJson,
    needs_human:
      needsHumanRaw === true || needsHumanRaw === 'true' || needsHumanRaw === '1'
        ? true
        : undefined,
    bot_mode:
      botModeRaw != null && String(botModeRaw).trim() !== '' ? String(botModeRaw).trim() : undefined,
  };
}

function defaultStageForBooking(bookingStatus) {
  if (bookingStatus === 'payment_pending') return 'payment_pending';
  return 'booking_flow';
}

function shallowMergeSessionState(existing, incoming, bookingCode) {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
    for (const [key, value] of Object.entries(incoming)) {
      if (value === null || value === undefined) continue;
      if (value === '') continue;
      if (Array.isArray(value) && value.length === 0) continue;
      base[key] = value;
    }
  }
  if (bookingCode) {
    base.current_hold_id = bookingCode;
    base.hold_booking_id = bookingCode;
    base.active_booking_id = bookingCode;
  }
  return base;
}

/**
 * @param {import('pg').Client} client
 * @param {ReturnType<typeof parseConversationUpsertInput>} input
 */
async function selectBookingForUpsert(client, clientId, bookingCode) {
  const { rows } = await client.query(
    `SELECT
       id::text AS booking_id,
       booking_code,
       phone,
       status::text AS status,
       payment_status::text AS payment_status
     FROM bookings
     WHERE client_id = $1 AND booking_code = $2
     LIMIT 1`,
    [clientId, bookingCode]
  );
  return rows[0] || null;
}

/**
 * @param {import('pg').Client} client
 * @param {string} clientId
 * @param {string} phone
 */
async function selectConversationRow(client, clientId, phone) {
  const { rows } = await client.query(
    `SELECT
       id::text AS conversation_id,
       session_state,
       needs_human,
       bot_mode::text AS bot_mode,
       airtable_record_id
     FROM conversations
     WHERE client_id = $1 AND phone = $2
     LIMIT 1`,
    [clientId, phone]
  );
  return rows[0] || null;
}

/**
 * @param {import('pg').Client} client
 * @param {ReturnType<typeof parseConversationUpsertInput>} input
 * @param {{ execute: boolean }} opts
 */
async function buildConversationUpsertPlan(client, input, opts = { execute: false }) {
  if (!input.phone) {
    return { error: 'missing_phone', parsed_input: input };
  }
  if (!input.booking_code) {
    return { error: 'missing_booking_code', parsed_input: input };
  }

  const clientRes = await resolveClientId(client, input.client_slug);
  if (clientRes.error) {
    return { error: clientRes.error, parsed_input: input };
  }

  const booking = await selectBookingForUpsert(client, clientRes.client_id, input.booking_code);
  if (!booking) {
    return {
      error: 'booking_not_found',
      parsed_input: input,
      booking_code: input.booking_code,
      actionable: ['booking_not_found'],
      plan_allowed: false,
    };
  }

  if (BLOCKED_BOOKING_STATUSES.includes(booking.status)) {
    return {
      error: 'blocked_booking_status',
      parsed_input: input,
      booking,
      blocked_statuses: BLOCKED_BOOKING_STATUSES,
      actionable: ['blocked_booking_status'],
      plan_allowed: false,
    };
  }

  if (!ALLOWED_BOOKING_STATUSES.includes(booking.status)) {
    return {
      error: 'booking_status_not_allowed',
      parsed_input: input,
      booking,
      allowed_statuses: ALLOWED_BOOKING_STATUSES,
      actionable: ['booking_status_not_allowed'],
      plan_allowed: false,
    };
  }

  if (booking.phone && booking.phone !== input.phone) {
    return {
      error: 'phone_mismatch',
      parsed_input: input,
      booking,
      actionable: ['phone_mismatch'],
      plan_allowed: false,
    };
  }

  const existing = await selectConversationRow(client, clientRes.client_id, input.phone);
  const stage = input.conversation_stage || defaultStageForBooking(booking.status);
  const mergedSession = shallowMergeSessionState(
    existing?.session_state,
    input.session_state_json,
    input.booking_code
  );

  const would_write = {
    client_id: clientRes.client_id,
    phone: input.phone,
    current_hold_booking_id: booking.booking_id,
    current_hold_booking_code: booking.booking_code,
    conversation_stage: stage,
    session_state: mergedSession,
    pending_action: input.pending_action,
    language: input.language,
    airtable_record_id:
      input.airtable_record_id && !existing?.airtable_record_id ? input.airtable_record_id : null,
    needs_human: input.needs_human,
    bot_mode: input.bot_mode,
  };

  return {
    parsed_input: input,
    client_id: clientRes.client_id,
    booking,
    existing_conversation: existing,
    would_create: !existing,
    would_update: !!existing,
    would_write,
    plan_allowed: true,
    execute: opts.execute,
    read_only: !opts.execute,
    no_mutations: !opts.execute,
  };
}

/**
 * @param {import('pg').Client} client
 * @param {ReturnType<typeof parseConversationUpsertInput>} input
 */
async function upsertConversationForHold(client, input) {
  const plan = await buildConversationUpsertPlan(client, input, { execute: true });
  if (plan.error) return plan;
  if (!plan.plan_allowed) return plan;

  const w = plan.would_write;
  const existing = plan.existing_conversation;

  const needsHumanSet = input.needs_human === true;
  const botModeSet = !!input.bot_mode;

  const sql = `INSERT INTO conversations (
      client_id,
      phone,
      current_hold_booking_id,
      conversation_stage,
      session_state,
      pending_action,
      language,
      airtable_record_id,
      needs_human,
      bot_mode
    )
    VALUES (
      $1, $2, $3::uuid, $4, $5::jsonb, $6, $7, $8,
      COALESCE($9::boolean, FALSE),
      COALESCE($10::bot_mode, 'bot'::bot_mode)
    )
    ON CONFLICT (client_id, phone) DO UPDATE SET
      current_hold_booking_id = EXCLUDED.current_hold_booking_id,
      conversation_stage = EXCLUDED.conversation_stage,
      session_state = EXCLUDED.session_state,
      pending_action = COALESCE(EXCLUDED.pending_action, conversations.pending_action),
      language = COALESCE(EXCLUDED.language, conversations.language),
      airtable_record_id = COALESCE(conversations.airtable_record_id, EXCLUDED.airtable_record_id),
      needs_human = CASE WHEN $11 THEN TRUE ELSE conversations.needs_human END,
      bot_mode = CASE WHEN $12 THEN EXCLUDED.bot_mode ELSE conversations.bot_mode END,
      updated_at = NOW()
    RETURNING
      id::text AS conversation_id,
      phone,
      current_hold_booking_id::text AS current_hold_booking_id,
      conversation_stage,
      session_state`;

  const params = [
    plan.client_id,
    input.phone,
    w.current_hold_booking_id,
    w.conversation_stage,
    JSON.stringify(w.session_state),
    w.pending_action,
    w.language,
    w.airtable_record_id,
    needsHumanSet ? true : null,
    input.bot_mode || null,
    needsHumanSet,
    botModeSet,
  ];

  const { rows } = await client.query(sql, params);

  return {
    ...plan,
    created: !existing,
    updated: !!existing,
    conversation_id: rows[0]?.conversation_id,
    conversation: rows[0],
    read_only: false,
    no_mutations: false,
  };
}

/**
 * n8n conversation upsert gate for hold success path.
 * Parameters:
 *   $1 phone, $2 booking_code, $3 conversation_stage, $4 pending_action,
 *   $5 language, $6 session_state_json, $7 needs_human, $8 bot_mode
 * Writes conversations only. No messages, payments, booking_beds.
 * Returns one row with pg_ok=true/false and actionable errors.
 */
function buildConversationHoldUpsertN8nSql() {
  return `WITH params AS (
  SELECT
    NULLIF($1, '${NULL_SENTINEL}') AS phone,
    NULLIF($2, '${NULL_SENTINEL}') AS booking_code,
    COALESCE(NULLIF($3, '${NULL_SENTINEL}'), 'booking_flow') AS conversation_stage,
    NULLIF($4, '${NULL_SENTINEL}') AS pending_action,
    NULLIF($5, '${NULL_SENTINEL}') AS language,
    COALESCE(NULLIF($6, '${NULL_SENTINEL}')::jsonb, '{}'::jsonb) AS session_state_json,
    CASE
      WHEN lower(COALESCE(NULLIF($7, '${NULL_SENTINEL}'), '')) IN ('true', '1', 'yes') THEN TRUE
      ELSE NULL
    END AS needs_human_value,
    NULLIF($8, '${NULL_SENTINEL}') AS bot_mode_value
),
client AS (
  SELECT id FROM clients WHERE slug = '${CLIENT_SLUG}' LIMIT 1
),
booking AS (
  SELECT
    b.id::text AS booking_id,
    b.id AS booking_uuid,
    b.booking_code,
    b.phone,
    b.status::text AS status
  FROM bookings b
  INNER JOIN client c ON b.client_id = c.id
  CROSS JOIN params p
  WHERE b.booking_code = p.booking_code
  LIMIT 1
),
guard AS (
  SELECT
    p.*,
    b.booking_id,
    b.booking_uuid,
    b.booking_code AS found_booking_code,
    b.phone AS booking_phone,
    b.status AS booking_status,
    (p.phone IS NULL OR p.booking_code IS NULL) AS missing_required,
    (b.booking_id IS NULL) AS booking_missing,
    (b.status IN ('confirmed', 'checked_in', 'cancelled', 'expired')) AS blocked_booking_status,
    (b.status IS NOT NULL AND b.status NOT IN ('hold', 'payment_pending')) AS status_not_allowed,
    (b.phone IS NOT NULL AND p.phone IS NOT NULL AND b.phone <> p.phone) AS phone_mismatch
  FROM params p
  LEFT JOIN booking b ON TRUE
),
upserted AS (
  INSERT INTO conversations (
    client_id,
    phone,
    current_hold_booking_id,
    conversation_stage,
    session_state,
    pending_action,
    language,
    needs_human,
    bot_mode
  )
  SELECT
    c.id,
    g.phone,
    g.booking_uuid,
    g.conversation_stage,
    g.session_state_json || jsonb_build_object('current_hold_booking_code', g.found_booking_code),
    g.pending_action,
    g.language,
    COALESCE(g.needs_human_value, FALSE),
    COALESCE(g.bot_mode_value::bot_mode, 'bot'::bot_mode)
  FROM guard g
  INNER JOIN client c ON TRUE
  WHERE NOT g.missing_required
    AND NOT g.booking_missing
    AND NOT g.blocked_booking_status
    AND NOT g.status_not_allowed
    AND NOT g.phone_mismatch
  ON CONFLICT (client_id, phone) DO UPDATE SET
    current_hold_booking_id = EXCLUDED.current_hold_booking_id,
    conversation_stage = EXCLUDED.conversation_stage,
    session_state = COALESCE(conversations.session_state, '{}'::jsonb) || EXCLUDED.session_state,
    pending_action = COALESCE(EXCLUDED.pending_action, conversations.pending_action),
    language = COALESCE(EXCLUDED.language, conversations.language),
    needs_human = COALESCE(EXCLUDED.needs_human, conversations.needs_human),
    bot_mode = COALESCE(EXCLUDED.bot_mode, conversations.bot_mode),
    updated_at = NOW()
  RETURNING
    id::text AS conversation_id,
    current_hold_booking_id::text AS current_hold_booking_id,
    conversation_stage,
    (xmax = 0) AS created,
    (xmax <> 0) AS updated
)
SELECT
  CASE
    WHEN g.missing_required THEN FALSE
    WHEN g.booking_missing THEN FALSE
    WHEN g.blocked_booking_status THEN FALSE
    WHEN g.status_not_allowed THEN FALSE
    WHEN g.phone_mismatch THEN FALSE
    WHEN u.conversation_id IS NULL THEN FALSE
    ELSE TRUE
  END AS pg_ok,
  u.conversation_id,
  g.booking_id,
  g.found_booking_code AS booking_code,
  u.current_hold_booking_id,
  u.conversation_stage,
  COALESCE(u.created, FALSE) AS created,
  COALESCE(u.updated, FALSE) AS updated,
  CASE
    WHEN g.missing_required THEN '["missing_phone_or_booking_code"]'::jsonb
    WHEN g.booking_missing THEN '["booking_not_found"]'::jsonb
    WHEN g.blocked_booking_status THEN '["blocked_booking_status"]'::jsonb
    WHEN g.status_not_allowed THEN '["booking_status_not_allowed"]'::jsonb
    WHEN g.phone_mismatch THEN '["phone_mismatch"]'::jsonb
    WHEN u.conversation_id IS NULL THEN '["conversation_upsert_failed"]'::jsonb
    ELSE '[]'::jsonb
  END AS actionable,
  CASE
    WHEN g.missing_required THEN ARRAY['missing_phone_or_booking_code']::text[]
    WHEN g.booking_missing THEN ARRAY['booking_not_found']::text[]
    WHEN g.blocked_booking_status THEN ARRAY['blocked_booking_status']::text[]
    WHEN g.status_not_allowed THEN ARRAY['booking_status_not_allowed']::text[]
    WHEN g.phone_mismatch THEN ARRAY['phone_mismatch']::text[]
    WHEN u.conversation_id IS NULL THEN ARRAY['conversation_upsert_failed']::text[]
    ELSE ARRAY[]::text[]
  END AS pg_errors
FROM guard g
LEFT JOIN upserted u ON TRUE;`;
}

module.exports = {
  CLIENT_SLUG,
  ALLOWED_BOOKING_STATUSES,
  BLOCKED_BOOKING_STATUSES,
  NULL_SENTINEL,
  parseConversationUpsertInput,
  buildConversationUpsertPlan,
  buildConversationHoldUpsertN8nSql,
  upsertConversationForHold,
};
