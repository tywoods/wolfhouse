/**
 * Phase 3c.d.2 — SELECT-only conversation / hold state queries (Main PG path).
 */
const { resolveClientId } = require('./main-booking-hold-pg-sql');

const ACTIVE_HOLD_STATUSES = ['hold', 'payment_pending'];

/** Align with Code - Pick Active Booking / Search Active Booking - Phone */
const RESOLVER_ACTIVE_STATUSES = ['hold', 'payment_pending', 'confirmed', 'needs_review'];

function parseConversationStateInput(raw = {}) {
  return {
    client_slug: String(raw.client_slug ?? raw.clientSlug ?? 'wolfhouse-somo').trim(),
    phone: String(raw.phone ?? '').trim() || null,
    booking_code: String(raw.booking_code ?? raw.bookingCode ?? '').trim() || null,
  };
}

/**
 * @param {import('pg').Client} client
 */
async function tableHasColumn(client, tableName, columnName) {
  const { rows } = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

/**
 * @param {import('pg').Client} client
 */
async function selectConversationByPhone(client, clientId, phone) {
  const hasTable = await tableHasColumn(client, 'conversations', 'client_id');
  if (!hasTable) {
    return { table_exists: false, row: null, message_count: 0 };
  }

  const { rows } = await client.query(
    `SELECT
       c.id::text AS conversation_id,
       c.phone,
       c.airtable_record_id,
       c.display_name,
       c.email,
       c.language,
       c.session_state,
       c.conversation_summary,
       c.last_message_preview,
       c.last_bot_reply,
       c.needs_human,
       c.status::text AS status,
       c.conversation_stage,
       c.bot_mode::text AS bot_mode,
       c.current_hold_booking_id::text AS current_hold_booking_id,
       c.pending_action,
       c.created_at,
       c.updated_at,
       hb.id::text AS linked_hold_booking_id,
       hb.booking_code AS linked_hold_booking_code,
       hb.status::text AS linked_hold_status,
       hb.payment_status::text AS linked_hold_payment_status,
       hb.airtable_record_id AS linked_hold_airtable_record_id
     FROM conversations c
     LEFT JOIN bookings hb ON hb.id = c.current_hold_booking_id
     WHERE c.client_id = $1 AND c.phone = $2
     LIMIT 1`,
    [clientId, phone]
  );

  let messageCount = 0;
  if (rows.length) {
    const { rows: mc } = await client.query(
      `SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1`,
      [rows[0].conversation_id]
    );
    messageCount = mc[0]?.n ?? 0;
  }

  return {
    table_exists: true,
    row: rows[0] || null,
    message_count: messageCount,
  };
}

/**
 * @param {import('pg').Client} client
 */
async function selectBookingByCode(client, clientId, bookingCode) {
  const { rows } = await client.query(
    `SELECT
       id::text AS booking_id,
       booking_code,
       phone,
       guest_name,
       email,
       status::text AS status,
       payment_status::text AS payment_status,
       check_in::text AS check_in,
       check_out::text AS check_out,
       airtable_record_id,
       hold_expires_at,
       created_at,
       updated_at
     FROM bookings
     WHERE client_id = $1 AND booking_code = $2
     LIMIT 1`,
    [clientId, bookingCode]
  );
  return rows[0] || null;
}

/**
 * @param {import('pg').Client} client
 */
async function selectActiveHoldCandidates(client, clientId, phone) {
  const { rows } = await client.query(
    `SELECT
       id::text AS booking_id,
       booking_code,
       phone,
       status::text AS status,
       payment_status::text AS payment_status,
       check_in::text AS check_in,
       check_out::text AS check_out,
       airtable_record_id,
       hold_expires_at,
       created_at
     FROM bookings
     WHERE client_id = $1
       AND phone = $2
       AND status::text = ANY($3::text[])
       AND (check_out IS NULL OR check_out >= CURRENT_DATE)
     ORDER BY created_at DESC`,
    [clientId, phone, ACTIVE_HOLD_STATUSES]
  );
  return rows;
}

/**
 * @param {import('pg').Client} client
 */
async function selectResolverCandidatesByPhone(client, clientId, phone) {
  const { rows } = await client.query(
    `SELECT
       id::text AS booking_id,
       booking_code,
       phone,
       status::text AS status,
       payment_status::text AS payment_status,
       check_in::text AS check_in,
       check_out::text AS check_out,
       airtable_record_id,
       created_at
     FROM bookings
     WHERE client_id = $1
       AND phone = $2
       AND status::text = ANY($3::text[])
       AND (check_out IS NULL OR check_out >= CURRENT_DATE)
     ORDER BY created_at DESC`,
    [clientId, phone, RESOLVER_ACTIVE_STATUSES]
  );
  return rows;
}

function sessionHoldCode(sessionState) {
  if (!sessionState || typeof sessionState !== 'object') return null;
  const code =
    sessionState.current_hold_id ||
    sessionState.hold_booking_id ||
    sessionState.booking_id ||
    sessionState.active_booking_id ||
    null;
  const s = String(code || '').trim();
  return s.startsWith('WH-') ? s : null;
}

function buildCurrentHoldResolutionPreview(input, pgConversation, bookingByCode, holdCandidates, resolverCandidates) {
  const preview = {
    input_booking_code: input.booking_code,
    input_phone: input.phone,
    pick_by_booking_code: null,
    pick_by_current_hold_id_hint: null,
    pick_by_phone_hold_search: null,
    pick_by_phone_resolver_search: null,
    pg_would_pick: null,
    pick_source: null,
    uuid_vs_code: {
      pg_authoritative_id: 'bookings.id (UUID)',
      airtable_current_hold_id: 'booking_code (WH-…)',
      airtable_active_booking_record_id: 'Airtable rec… mirror only',
    },
  };

  if (input.booking_code) {
    preview.pick_by_booking_code = bookingByCode;
  }

  const conv = pgConversation.row;
  if (conv?.linked_hold_booking_code) {
    preview.pick_by_current_hold_id_hint = {
      from: 'conversations.current_hold_booking_id',
      booking_id: conv.linked_hold_booking_id,
      booking_code: conv.linked_hold_booking_code,
      status: conv.linked_hold_status,
    };
  } else if (conv?.session_state) {
    const code = sessionHoldCode(conv.session_state);
    if (code) {
      preview.pick_by_current_hold_id_hint = {
        from: 'conversations.session_state',
        booking_code: code,
        note: 'session JSON hold key — resolve via booking_code lookup',
      };
    }
  }

  if (holdCandidates.length) {
    preview.pick_by_phone_hold_search = holdCandidates[0];
  }
  if (resolverCandidates.length) {
    preview.pick_by_phone_resolver_search = resolverCandidates[0];
  }

  // Mirror Pick Active Booking: hold-id search first, else phone
  if (preview.pick_by_booking_code) {
    preview.pg_would_pick = preview.pick_by_booking_code;
    preview.pick_source = 'booking_code_argument';
  } else if (preview.pick_by_current_hold_id_hint?.booking_id) {
    preview.pg_would_pick = {
      booking_id: preview.pick_by_current_hold_id_hint.booking_id,
      booking_code: preview.pick_by_current_hold_id_hint.booking_code,
      status: preview.pick_by_current_hold_id_hint.status,
    };
    preview.pick_source = 'conversation.current_hold_booking_id';
  } else if (input.booking_code && !preview.pick_by_booking_code) {
    preview.pg_would_pick = null;
    preview.pick_source = 'booking_code_not_found';
  } else if (preview.pick_by_phone_resolver_search) {
    preview.pg_would_pick = preview.pick_by_phone_resolver_search;
    preview.pick_source = 'phone_resolver_candidates';
  } else {
    preview.pg_would_pick = null;
    preview.pick_source = 'none';
  }

  const sameAsResolverPhone =
    preview.pick_by_phone_resolver_search &&
    preview.pg_would_pick?.booking_id === preview.pick_by_phone_resolver_search.booking_id;

  preview.resolver_alignment = {
    note: 'Simulates Pick Active Booking priority: booking_code / Current Hold ID before phone',
    phone_latest_resolver_match: preview.pick_by_phone_resolver_search,
    likely_same_as_at_phone_search: sameAsResolverPhone,
  };

  return preview;
}

function buildExpectedAirtableMapping() {
  return {
    note: 'From workflow JSON + 3c.d.1 inventory — not live Airtable API',
    fields: [
      {
        airtable: 'Current Hold ID',
        value_type: 'booking_code (WH-…)',
        postgres: 'conversations.current_hold_booking_id → bookings.id UUID',
        mirror: 'AT stores code; PG stores UUID FK',
      },
      {
        airtable: 'Session State',
        value_type: 'JSON string',
        postgres: 'conversations.session_state JSONB',
        mirror: 'dual-write in 3c.e',
      },
      {
        airtable: 'Conversation Stage',
        postgres: 'conversations.conversation_stage',
      },
      {
        airtable: 'Pending Action',
        postgres: 'conversations.pending_action',
      },
      {
        airtable: 'active_booking_record_id (in Code nodes)',
        postgres: 'bookings.airtable_record_id after mirror only',
      },
    ],
  };
}

function buildRisks(input, pgConversation, bookingByCode, holdCandidates, resolverCandidates, preview) {
  const risks = [];
  const actionable = [];

  if (!input.phone) {
    actionable.push('missing_phone');
    risks.push({
      id: 'missing_phone',
      severity: 'high',
      detail: '--phone is required for conversation lookup and hold candidates',
    });
  }

  if (input.phone && pgConversation.table_exists && !pgConversation.row) {
    risks.push({
      id: 'missing_conversation_row',
      severity: 'medium',
      detail: 'No PG conversations row for phone — 3c.e must UPSERT on first message',
    });
    actionable.push('missing_conversation_row');
  }

  if (input.booking_code && !bookingByCode) {
    risks.push({
      id: 'no_pg_booking_for_current_hold_code',
      severity: 'high',
      detail: `booking_code ${input.booking_code} not in PG — AT Current Hold ID would be stale after PG-only hold`,
    });
    actionable.push('no_pg_booking_for_current_hold_code');
  }

  if (holdCandidates.length > 1) {
    risks.push({
      id: 'multiple_active_holds',
      severity: 'high',
      detail: `${holdCandidates.length} hold/payment_pending bookings for phone`,
      booking_codes: holdCandidates.map((b) => b.booking_code),
    });
    actionable.push('multiple_active_holds');
  }

  const conv = pgConversation.row;
  if (conv?.linked_hold_booking_id && conv.linked_hold_status) {
    const stage = conv.conversation_stage || '';
    const st = conv.linked_hold_status;
    if (stage === 'payment_pending' && st === 'hold') {
      risks.push({
        id: 'status_mismatch',
        severity: 'high',
        detail: 'conversation_stage payment_pending but linked booking still hold',
      });
      actionable.push('status_mismatch');
    }
  }

  if (conv?.linked_hold_booking_id && !conv.linked_hold_airtable_record_id) {
    risks.push({
      id: 'stale_airtable_record_id',
      severity: 'low',
      detail: 'Linked booking has no airtable_record_id — expected until AT mirror in 3c.e',
    });
  }

  if (conv?.current_hold_booking_id && !conv.linked_hold_booking_id) {
    risks.push({
      id: 'orphan_current_hold_fk',
      severity: 'high',
      detail: 'current_hold_booking_id set but join to bookings failed',
    });
    actionable.push('orphan_current_hold_fk');
  }

  if (preview.pick_source === 'booking_code_not_found') {
    actionable.push('resolver_would_miss_hold');
  }

  return { risks, actionable: [...new Set(actionable)] };
}

/**
 * @param {import('pg').Client} client
 * @param {ReturnType<typeof parseConversationStateInput>} input
 */
async function runConversationStateQueries(client, input) {
  const clientRes = await resolveClientId(client, input.client_slug);
  if (clientRes.error) {
    return { error: clientRes.error, parsed_input: input };
  }

  const clientId = clientRes.client_id;

  let pgConversation = { table_exists: false, row: null, message_count: 0 };
  if (input.phone) {
    pgConversation = await selectConversationByPhone(client, clientId, input.phone);
  }

  const bookingByCode = input.booking_code
    ? await selectBookingByCode(client, clientId, input.booking_code)
    : null;

  const holdCandidates = input.phone
    ? await selectActiveHoldCandidates(client, clientId, input.phone)
    : [];

  const resolverCandidates = input.phone
    ? await selectResolverCandidatesByPhone(client, clientId, input.phone)
    : [];

  const current_hold_resolution_preview = buildCurrentHoldResolutionPreview(
    input,
    pgConversation,
    bookingByCode,
    holdCandidates,
    resolverCandidates
  );

  const { risks, actionable } = buildRisks(
    input,
    pgConversation,
    bookingByCode,
    holdCandidates,
    resolverCandidates,
    current_hold_resolution_preview
  );

  return {
    parsed_input: input,
    client_id: clientId,
    pg_conversation_match: pgConversation,
    pg_active_hold_candidates: {
      filter: { phone: input.phone, statuses: ACTIVE_HOLD_STATUSES },
      count: holdCandidates.length,
      rows: holdCandidates,
    },
    pg_resolver_candidates: {
      filter: { phone: input.phone, statuses: RESOLVER_ACTIVE_STATUSES },
      count: resolverCandidates.length,
      rows: resolverCandidates,
    },
    pg_booking_by_code: bookingByCode,
    current_hold_resolution_preview,
    expected_airtable_mapping: buildExpectedAirtableMapping(),
    risks,
    actionable,
    read_only: true,
    no_mutations: true,
  };
}

module.exports = {
  ACTIVE_HOLD_STATUSES,
  RESOLVER_ACTIVE_STATUSES,
  parseConversationStateInput,
  runConversationStateQueries,
};
