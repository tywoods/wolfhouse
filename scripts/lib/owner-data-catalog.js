'use strict';

/**
 * Phase 25e — Owner Command Center data catalog and approved query templates.
 *
 * Curated table/column policies and safe SQL patterns for future AI planning (25f+).
 * No AI planner or execution here — templates are data for validators and 25f.
 *
 * @module owner-data-catalog
 */

const SCOPE_MODES = Object.freeze([
  'direct_client_slug',
  'join_required',
  'global_reference',
  'blocked',
]);

const GLOBAL_SENSITIVE_COLUMNS = Object.freeze([
  'raw_payload',
  'session_state',
  'stripe_checkout_session_id',
  'stripe_payment_intent_id',
  'stripe_event_id',
  'whatsapp_message_id',
  'wa_message_id',
  'password_hash',
  'api_key',
  'secret',
  'token',
]);

const BLOCKED_TABLES = Object.freeze([
  'auth_sessions',
  'staff_users',
  'staff_refresh_tokens',
  'clients',
  'guests',
  'packages',
  'payment_events',
  'guest_message_sends',
  'bot_pause_states',
  'staff_handoffs',
  'staff_tasks',
  'add_on_orders',
  'workflow_events',
  'automation_errors',
]);

/** Approved join anchor: booking_service_records has client_slug on staging. */
const BSR_SCOPE_SUBQUERY =
  'booking_id IN (SELECT DISTINCT booking_id FROM booking_service_records WHERE client_slug = $1 AND booking_id IS NOT NULL)';

const TABLE_CATALOG = Object.freeze({
  bookings: {
    table: 'bookings',
    label: 'Bookings',
    purpose: 'Guest reservations, dates, package, payment summary, and assignment status.',
    client_scope_mode: 'join_required',
    client_scope_expression: BSR_SCOPE_SUBQUERY,
    client_scope_notes:
      'Staging/production Postgres uses client_id (FK to clients), not client_slug. '
      + 'Owner SQL must scope via booking_service_records.client_slug = $1 or equivalent approved subquery. '
      + 'Do not filter bookings.client_slug — column absent on staging.',
    recommended_joins: [
      {
        table: 'booking_service_records',
        on: 'booking_service_records.booking_id = bookings.id AND booking_service_records.client_slug = $1',
        purpose: 'Primary tenant scope anchor (has client_slug).',
      },
      {
        table: 'payments',
        on: 'payments.booking_id = bookings.id',
        purpose: 'Payment ledger rows for a booking.',
      },
      {
        table: 'booking_beds',
        on: 'booking_beds.booking_id = bookings.id',
        purpose: 'Room/bed assignments.',
      },
    ],
    allowed_columns: [
      'id', 'client_id', 'guest_id', 'package_id', 'booking_code', 'guest_name', 'phone', 'email',
      'status', 'payment_status', 'assignment_status', 'availability_check_status',
      'check_in', 'check_out', 'guest_count', 'package_code', 'hold_expires_at',
      'guest_gender_group_type', 'requested_room_type', 'room_preference', 'rooming_notes',
      'booking_source', 'staff_notes', 'conflict_notes', 'operator_name', 'block_type',
      'payment_option', 'payment_notes', 'deposit_required_cents', 'deposit_paid_cents',
      'balance_due_cents', 'total_amount_cents', 'amount_paid_cents', 'primary_room_code',
      'created_at', 'updated_at',
    ],
    sensitive_columns: ['metadata', 'airtable_record_id', 'room_to_block_id'],
    notes: 'metadata JSONB hidden by default; use structured money/status columns for BI.',
  },

  payments: {
    table: 'payments',
    label: 'Payments',
    purpose: 'Stripe checkout sessions and payment ledger per booking.',
    client_scope_mode: 'join_required',
    client_scope_expression:
      'booking_id IN (SELECT DISTINCT booking_id FROM booking_service_records WHERE client_slug = $1 AND booking_id IS NOT NULL)',
    client_scope_notes:
      'payments.client_id exists but clients table is not owner-allowlisted. '
      + 'Scope via booking_service_records join or subquery with client_slug = $1.',
    recommended_joins: [
      {
        table: 'booking_service_records',
        on: 'booking_service_records.booking_id = payments.booking_id AND booking_service_records.client_slug = $1',
        purpose: 'Tenant scope anchor.',
      },
      {
        table: 'bookings',
        on: 'bookings.id = payments.booking_id',
        purpose: 'Guest/booking context.',
      },
    ],
    allowed_columns: [
      'id', 'client_id', 'booking_id', 'status', 'payment_kind', 'currency',
      'amount_due_cents', 'amount_paid_cents', 'checkout_url', 'paid_at', 'expires_at',
      'created_at', 'updated_at',
    ],
    sensitive_columns: [
      'metadata', 'stripe_checkout_session_id', 'stripe_payment_intent_id', 'airtable_record_id',
    ],
    notes: 'Provider IDs and raw metadata blocked from owner SELECT projections.',
  },

  booking_beds: {
    table: 'booking_beds',
    label: 'Booking bed assignments',
    purpose: 'Which bed/room a booking occupies and assignment date range.',
    client_scope_mode: 'join_required',
    client_scope_expression: BSR_SCOPE_SUBQUERY.replace('booking_id', 'booking_beds.booking_id'),
    client_scope_notes: 'Scope via booking_service_records subquery on booking_id.',
    recommended_joins: [
      {
        table: 'bookings',
        on: 'bookings.id = booking_beds.booking_id',
        purpose: 'Booking dates and guest context.',
      },
      {
        table: 'beds',
        on: 'beds.id = booking_beds.bed_id',
        purpose: 'Bed metadata.',
      },
      {
        table: 'rooms',
        on: 'rooms.id = beds.room_id',
        purpose: 'Room metadata (via beds).',
      },
    ],
    allowed_columns: [
      'id', 'client_id', 'booking_id', 'bed_id', 'assignment_label', 'assignment_type',
      'assignment_notes', 'assignment_start_date', 'assignment_end_date', 'planning_row_label',
      'guest_name', 'room_code', 'bed_code', 'created_at', 'updated_at',
    ],
    sensitive_columns: ['airtable_record_id'],
    notes: 'Use for occupancy and rooming BI; always pair with tenant scope anchor.',
  },

  booking_service_records: {
    table: 'booking_service_records',
    label: 'Service / add-on records',
    purpose: 'Flat add-on rows (yoga, meals, lessons, wetsuits, surfboards) with payment status.',
    client_scope_mode: 'direct_client_slug',
    client_scope_expression: 'client_slug = $1',
    client_scope_notes: 'Primary tenant scope anchor — has client_slug column on staging.',
    recommended_joins: [
      {
        table: 'bookings',
        on: 'bookings.id = booking_service_records.booking_id',
        purpose: 'Optional booking context when booking_id is set.',
      },
    ],
    allowed_columns: [
      'id', 'client_slug', 'booking_id', 'booking_code', 'guest_name', 'service_type',
      'service_date', 'quantity', 'status', 'amount_due_cents', 'amount_paid_cents',
      'payment_status', 'source', 'notes', 'created_at', 'updated_at',
    ],
    sensitive_columns: ['metadata'],
    notes: 'Preferred anchor for scoping bookings/payments when client_slug filter required in SQL text.',
  },

  rooms: {
    table: 'rooms',
    label: 'Rooms',
    purpose: 'Room inventory (codes, capacity, house, gender strategy).',
    client_scope_mode: 'global_reference',
    client_scope_expression:
      'Scoped indirectly via booking_beds → bookings path with booking_service_records.client_slug = $1',
    client_scope_notes:
      'rooms.client_id exists but clients table is not allowlisted. '
      + 'Owner queries should reach rooms through booking_beds/bookings scoped via BSR anchor.',
    recommended_joins: [
      {
        table: 'beds',
        on: 'beds.room_id = rooms.id',
        purpose: 'Beds in room.',
      },
      {
        table: 'booking_beds',
        on: 'booking_beds.bed_id = beds.id',
        purpose: 'Active assignments.',
      },
    ],
    allowed_columns: [
      'id', 'client_id', 'room_code', 'name', 'house', 'room_type', 'capacity',
      'fill_priority', 'private_priority', 'gender_strategy', 'can_be_matrimonial',
      'often_used_by_operator', 'sort_order', 'avoid_until_needed', 'active', 'notes',
      'created_at', 'updated_at',
    ],
    sensitive_columns: ['airtable_record_id'],
    notes: 'Reference data; do not expose cross-tenant room lists without BSR-scoped assignment join.',
  },

  beds: {
    table: 'beds',
    label: 'Beds',
    purpose: 'Sellable bed inventory within rooms.',
    client_scope_mode: 'global_reference',
    client_scope_expression:
      'Scoped indirectly via booking_beds → bookings path with booking_service_records.client_slug = $1',
    client_scope_notes: 'Same as rooms — scope through assignment/booking anchor.',
    recommended_joins: [
      {
        table: 'rooms',
        on: 'rooms.id = beds.room_id',
        purpose: 'Room context.',
      },
      {
        table: 'booking_beds',
        on: 'booking_beds.bed_id = beds.id',
        purpose: 'Occupancy assignments.',
      },
    ],
    allowed_columns: [
      'id', 'client_id', 'room_id', 'bed_code', 'bed_number', 'bed_label',
      'planning_row_label', 'active', 'sellable', 'notes', 'created_at', 'updated_at',
    ],
    sensitive_columns: ['airtable_record_id'],
    notes: 'Reference data tied to client_id; use assignment joins for tenant-safe occupancy.',
  },

  conversations: {
    table: 'conversations',
    label: 'Guest conversations',
    purpose: 'WhatsApp conversation state, status, and staff handoff flags.',
    client_scope_mode: 'join_required',
    client_scope_expression:
      'phone IN (SELECT DISTINCT from_phone FROM guest_message_events WHERE client_slug = $1 AND from_phone IS NOT NULL)',
    client_scope_notes:
      'conversations.client_id exists; scope via guest_message_events.client_slug = $1 phone match '
      + 'or future approved join when conversation-level client_slug exists.',
    recommended_joins: [
      {
        table: 'guest_message_events',
        on: 'guest_message_events.from_phone = conversations.phone AND guest_message_events.client_slug = $1',
        purpose: 'Tenant scope via inbound event phone.',
      },
      {
        table: 'messages',
        on: 'messages.conversation_id = conversations.id',
        purpose: 'Message history (allowed columns only).',
      },
    ],
    allowed_columns: [
      'id', 'client_id', 'guest_id', 'display_name', 'phone', 'email', 'language',
      'conversation_summary', 'last_message_preview', 'last_bot_reply', 'needs_human',
      'status', 'conversation_stage', 'bot_mode', 'current_hold_booking_id', 'pending_action',
      'staff_reply_draft', 'human_notes', 'internal_staff_notes', 'last_staff_reply_at',
      'created_at', 'updated_at',
    ],
    sensitive_columns: ['session_state', 'metadata', 'airtable_record_id'],
    notes: 'session_state and metadata hidden; use summary/preview fields for owner BI.',
  },

  messages: {
    table: 'messages',
    label: 'Conversation messages',
    purpose: 'Individual inbound/outbound message rows (text summaries for owner).',
    client_scope_mode: 'join_required',
    client_scope_expression:
      'conversation_id IN (SELECT c.id FROM conversations c WHERE c.phone IN '
      + '(SELECT DISTINCT from_phone FROM guest_message_events WHERE client_slug = $1 AND from_phone IS NOT NULL))',
    client_scope_notes: 'Scope through conversations + guest_message_events phone anchor.',
    recommended_joins: [
      {
        table: 'conversations',
        on: 'conversations.id = messages.conversation_id',
        purpose: 'Conversation and phone context.',
      },
    ],
    allowed_columns: [
      'id', 'client_id', 'conversation_id', 'direction', 'message_text', 'message_type',
      'language', 'route', 'source', 'conversation_stage', 'chat_line', 'chat_display',
      'created_at', 'updated_at',
    ],
    sensitive_columns: ['metadata', 'whatsapp_message_id', 'airtable_record_id'],
    notes: 'Full message metadata and provider message IDs blocked by default.',
  },

  guest_message_events: {
    table: 'guest_message_events',
    label: 'Guest message events',
    purpose: 'Inbound WhatsApp webhook events and Luna draft/send-gate metadata (summaries).',
    client_scope_mode: 'direct_client_slug',
    client_scope_expression: 'client_slug = $1',
    client_scope_notes: 'Has client_slug column; safe direct filter for event-level BI.',
    recommended_joins: [],
    allowed_columns: [
      'id', 'client_slug', 'channel', 'direction', 'from_phone', 'to_phone_number_id',
      'message_type', 'message_text', 'profile_name', 'draft_called', 'next_action',
      'suggested_reply', 'handoff_required', 'send_attempted', 'send_status',
      'created_at', 'updated_at',
    ],
    sensitive_columns: [
      'raw_payload', 'normalized', 'wa_message_id', 'send_idempotency_key', 'send_blocked_reasons',
    ],
    notes: 'raw_payload and normalized JSON blocked; use message_text and gate flags only.',
  },

  staff_phone_access: {
    table: 'staff_phone_access',
    label: 'Staff phone allowlist',
    purpose: 'Owner/staff phone routing allowlist (diagnostics only).',
    client_scope_mode: 'direct_client_slug',
    client_scope_expression: 'client_slug = $1',
    client_scope_notes: 'Diagnostics/low priority; not in owner SQL validator allowlist (25d/25e).',
    recommended_joins: [],
    allowed_columns: [
      'id', 'client_slug', 'phone_normalized', 'display_name', 'role', 'channel',
      'is_active', 'notes', 'created_at', 'updated_at',
    ],
    sensitive_columns: [],
    diagnostics_only: true,
    sql_allowlisted: false,
    notes: 'Catalogued for documentation; excluded from getOwnerAllowedTables().',
  },
});

const APPROVED_QUERY_TEMPLATES = Object.freeze([
  {
    id: 'outstanding_balances',
    description: 'Bookings with a positive balance due, scoped via booking_service_records anchor.',
    required_params: ['client_slug'],
    param_types: { client_slug: 'text' },
    sql: `SELECT b.booking_code, b.guest_name, b.phone, b.check_in, b.check_out,
       b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents, b.payment_status, b.status
FROM bookings b
WHERE b.id IN (
  SELECT DISTINCT booking_id FROM booking_service_records
  WHERE client_slug = $1 AND booking_id IS NOT NULL
)
AND b.status NOT IN ('cancelled', 'canceled', 'expired', 'hold')
AND COALESCE(b.balance_due_cents, 0) > 0
ORDER BY b.check_in ASC
LIMIT 100`,
    expected_row_shape: {
      booking_code: 'text', guest_name: 'text', phone: 'text', check_in: 'date', check_out: 'date',
      total_amount_cents: 'integer', amount_paid_cents: 'integer', balance_due_cents: 'integer',
      payment_status: 'text', status: 'text',
    },
    allowed_role: 'owner',
    validation_status: 'approved',
    notes: 'Bookings without service records may be omitted until broader scope pattern is added in 25f.',
  },
  {
    id: 'revenue_summary_by_month',
    description: 'Paid payment totals grouped by calendar month.',
    required_params: ['client_slug'],
    param_types: { client_slug: 'text' },
    sql: `SELECT date_trunc('month', p.paid_at)::date AS revenue_month,
       SUM(COALESCE(p.amount_paid_cents, 0)) AS paid_cents,
       COUNT(*) AS payment_count
FROM payments p
INNER JOIN booking_service_records bsr
  ON bsr.booking_id = p.booking_id AND bsr.client_slug = $1
WHERE p.paid_at IS NOT NULL
  AND p.status IN ('paid', 'succeeded')
GROUP BY 1
ORDER BY 1 DESC
LIMIT 100`,
    expected_row_shape: {
      revenue_month: 'date', paid_cents: 'integer', payment_count: 'integer',
    },
    allowed_role: 'owner',
    validation_status: 'approved',
    notes: 'Aggregation safe; LIMIT caps month buckets returned.',
  },
  {
    id: 'arrivals_on_date',
    description: 'Bookings checking in on a specific date ($2).',
    required_params: ['client_slug', 'arrival_date'],
    param_types: { client_slug: 'text', arrival_date: 'date' },
    sql: `SELECT b.booking_code, b.guest_name, b.check_in, b.check_out, b.package_code,
       b.guest_count, b.status, b.primary_room_code
FROM bookings b
WHERE b.id IN (
  SELECT DISTINCT booking_id FROM booking_service_records
  WHERE client_slug = $1 AND booking_id IS NOT NULL
)
AND b.check_in = $2::date
AND b.status NOT IN ('cancelled', 'canceled', 'expired')
ORDER BY b.booking_code
LIMIT 100`,
    expected_row_shape: {
      booking_code: 'text', guest_name: 'text', check_in: 'date', check_out: 'date',
      package_code: 'text', guest_count: 'integer', status: 'text', primary_room_code: 'text',
    },
    allowed_role: 'owner',
    validation_status: 'approved',
    notes: 'Pass arrival_date as params[1] ($2).',
  },
  {
    id: 'arrivals_tomorrow',
    description: 'Bookings checking in tomorrow (server date).',
    required_params: ['client_slug'],
    param_types: { client_slug: 'text' },
    sql: `SELECT b.booking_code, b.guest_name, b.check_in, b.check_out, b.package_code,
       b.guest_count, b.status
FROM bookings b
WHERE b.id IN (
  SELECT DISTINCT booking_id FROM booking_service_records
  WHERE client_slug = $1 AND booking_id IS NOT NULL
)
AND b.check_in = CURRENT_DATE + INTERVAL '1 day'
AND b.status NOT IN ('cancelled', 'canceled', 'expired')
ORDER BY b.booking_code
LIMIT 100`,
    expected_row_shape: {
      booking_code: 'text', guest_name: 'text', check_in: 'date', check_out: 'date',
      package_code: 'text', guest_count: 'integer', status: 'text',
    },
    allowed_role: 'owner',
    validation_status: 'approved',
    notes: 'Uses CURRENT_DATE; suitable for daily owner digest.',
  },
  {
    id: 'checkouts_on_date',
    description: 'Bookings checking out on a specific date ($2).',
    required_params: ['client_slug', 'checkout_date'],
    param_types: { client_slug: 'text', checkout_date: 'date' },
    sql: `SELECT b.booking_code, b.guest_name, b.check_in, b.check_out, b.status
FROM bookings b
WHERE b.id IN (
  SELECT DISTINCT booking_id FROM booking_service_records
  WHERE client_slug = $1 AND booking_id IS NOT NULL
)
AND b.check_out = $2::date
AND b.status NOT IN ('cancelled', 'canceled', 'expired')
ORDER BY b.booking_code
LIMIT 100`,
    expected_row_shape: {
      booking_code: 'text', guest_name: 'text', check_in: 'date', check_out: 'date', status: 'text',
    },
    allowed_role: 'owner',
    validation_status: 'approved',
    notes: 'Pass checkout_date as params[1] ($2).',
  },
  {
    id: 'occupancy_by_date',
    description: 'Bed assignments active on a given date ($2).',
    required_params: ['client_slug', 'occupancy_date'],
    param_types: { client_slug: 'text', occupancy_date: 'date' },
    sql: `SELECT bb.room_code, bb.bed_code, bb.guest_name, bb.assignment_start_date,
       bb.assignment_end_date, b.booking_code, b.check_in, b.check_out
FROM booking_beds bb
INNER JOIN bookings b ON b.id = bb.booking_id
WHERE bb.booking_id IN (
  SELECT DISTINCT booking_id FROM booking_service_records
  WHERE client_slug = $1 AND booking_id IS NOT NULL
)
AND bb.assignment_start_date <= $2::date
AND bb.assignment_end_date > $2::date
ORDER BY bb.room_code, bb.bed_code
LIMIT 100`,
    expected_row_shape: {
      room_code: 'text', bed_code: 'text', guest_name: 'text',
      assignment_start_date: 'date', assignment_end_date: 'date',
      booking_code: 'text', check_in: 'date', check_out: 'date',
    },
    allowed_role: 'owner',
    validation_status: 'approved',
    notes: 'Pass occupancy_date as params[1] ($2).',
  },
  {
    id: 'package_popularity',
    description: 'Booking counts by package_code for active bookings.',
    required_params: ['client_slug'],
    param_types: { client_slug: 'text' },
    sql: `SELECT b.package_code, COUNT(*) AS booking_count
FROM bookings b
WHERE b.id IN (
  SELECT DISTINCT booking_id FROM booking_service_records
  WHERE client_slug = $1 AND booking_id IS NOT NULL
)
AND b.status NOT IN ('cancelled', 'canceled', 'expired', 'hold')
AND b.package_code IS NOT NULL
GROUP BY b.package_code
ORDER BY booking_count DESC
LIMIT 100`,
    expected_row_shape: { package_code: 'text', booking_count: 'integer' },
    allowed_role: 'owner',
    validation_status: 'approved',
    notes: 'Grouped aggregation with LIMIT on result rows.',
  },
  {
    id: 'addon_revenue',
    description: 'Add-on/service revenue and counts by service_type.',
    required_params: ['client_slug'],
    param_types: { client_slug: 'text' },
    sql: `SELECT bsr.service_type,
       SUM(bsr.amount_paid_cents) AS paid_cents,
       SUM(bsr.amount_due_cents) AS due_cents,
       COUNT(*) AS record_count
FROM booking_service_records bsr
WHERE bsr.client_slug = $1
  AND bsr.status NOT IN ('cancelled')
GROUP BY bsr.service_type
ORDER BY paid_cents DESC
LIMIT 100`,
    expected_row_shape: {
      service_type: 'text', paid_cents: 'integer', due_cents: 'integer', record_count: 'integer',
    },
    allowed_role: 'owner',
    validation_status: 'approved',
    notes: 'Direct client_slug filter on booking_service_records.',
  },
  {
    id: 'bookings_by_source',
    description: 'Booking counts grouped by booking_source.',
    required_params: ['client_slug'],
    param_types: { client_slug: 'text' },
    sql: `SELECT b.booking_source, COUNT(*) AS booking_count
FROM bookings b
WHERE b.id IN (
  SELECT DISTINCT booking_id FROM booking_service_records
  WHERE client_slug = $1 AND booking_id IS NOT NULL
)
AND b.status NOT IN ('cancelled', 'canceled', 'expired', 'hold')
GROUP BY b.booking_source
ORDER BY booking_count DESC
LIMIT 100`,
    expected_row_shape: { booking_source: 'text', booking_count: 'integer' },
    allowed_role: 'owner',
    validation_status: 'approved',
    notes: 'Marketing/channel mix for owner BI.',
  },
  {
    id: 'underbooked_dates_basic',
    description: 'Dates in the next 30 days with fewer than N active assignments (default N=5).',
    required_params: ['client_slug'],
    param_types: { client_slug: 'text' },
    sql: `SELECT d.occupancy_date, COUNT(DISTINCT bb.id) AS assignment_count
FROM generate_series(CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days', INTERVAL '1 day') AS d(occupancy_date)
LEFT JOIN booking_beds bb
  ON bb.assignment_start_date <= d.occupancy_date
 AND bb.assignment_end_date > d.occupancy_date
 AND bb.booking_id IN (
   SELECT DISTINCT booking_id FROM booking_service_records
   WHERE client_slug = $1 AND booking_id IS NOT NULL
 )
GROUP BY d.occupancy_date
HAVING COUNT(DISTINCT bb.id) < 5
ORDER BY d.occupancy_date
LIMIT 100`,
    expected_row_shape: { occupancy_date: 'date', assignment_count: 'integer' },
    allowed_role: 'owner',
    validation_status: 'pending',
    notes: 'Pending: threshold is heuristic; total bed capacity not in allowlist. Safe aggregation shape.',
  },
]);

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * @param {{ client_slug?: string }} [opts]
 * @returns {{ client_slug: string|null, tables: object[], templates: object[], blocked_tables: string[], sensitive_policy: object }}
 */
function getOwnerDataCatalog(opts = {}) {
  const clientSlug = trimStr(opts.client_slug) || null;
  const tables = Object.values(TABLE_CATALOG).map((entry) => ({
    ...entry,
    allowed_columns: [...entry.allowed_columns],
    sensitive_columns: [...entry.sensitive_columns],
    recommended_joins: (entry.recommended_joins || []).map((j) => ({ ...j })),
  }));

  return {
    client_slug: clientSlug,
    version: '25e',
    tables,
    templates: getOwnerApprovedQueryTemplates(),
    blocked_tables: [...BLOCKED_TABLES],
    sensitive_policy: {
      hidden_by_default: [...GLOBAL_SENSITIVE_COLUMNS],
      rules: [
        'raw_payload, normalized JSON blobs, and metadata columns are blocked unless explicitly allowlisted.',
        'Provider tokens/IDs (Stripe, WhatsApp message IDs) blocked from owner projections.',
        'Auth/session/secret tables are not in the owner SQL allowlist.',
        'guest phone/email allowed for owner business context.',
      ],
    },
  };
}

/** @returns {string[]} Tables owner read-only SQL may reference (excludes diagnostics-only). */
function getOwnerAllowedTables() {
  return Object.values(TABLE_CATALOG)
    .filter((t) => t.sql_allowlisted !== false)
    .map((t) => t.table);
}

/** @returns {string[]} Same as allowed tables — validator requires at least one referenced. */
function getOwnerClientScopedTables() {
  return getOwnerAllowedTables();
}

/**
 * @param {string} table
 * @returns {string[]|null}
 */
function getOwnerAllowedColumns(table) {
  const key = trimStr(table).toLowerCase();
  const entry = TABLE_CATALOG[key];
  if (!entry) return null;
  return [...entry.allowed_columns];
}

/**
 * @param {string} table
 * @returns {object|null}
 */
function getOwnerTablePolicy(table) {
  const key = trimStr(table).toLowerCase();
  const entry = TABLE_CATALOG[key];
  if (!entry) return null;
  return {
    table: entry.table,
    label: entry.label,
    purpose: entry.purpose,
    client_scope_mode: entry.client_scope_mode,
    client_scope_expression: entry.client_scope_expression,
    client_scope_notes: entry.client_scope_notes,
    recommended_joins: (entry.recommended_joins || []).map((j) => ({ ...j })),
    allowed_columns: [...entry.allowed_columns],
    sensitive_columns: [...entry.sensitive_columns],
    diagnostics_only: entry.diagnostics_only === true,
    sql_allowlisted: entry.sql_allowlisted !== false,
    notes: entry.notes,
  };
}

/** @returns {object[]} */
function getOwnerApprovedQueryTemplates() {
  return APPROVED_QUERY_TEMPLATES.map((t) => ({ ...t }));
}

/**
 * Plain-text catalog summary for future AI SQL planner (25f).
 *
 * @param {{ client_slug?: string }} [opts]
 * @returns {string}
 */
function describeOwnerCatalogForAi(opts = {}) {
  const slug = trimStr(opts.client_slug) || '<client_slug>';
  const lines = [
    'Owner Command Center data catalog (Phase 25e).',
    'All SQL must pass validateOwnerReadOnlySql: SELECT-only, client_slug = $1 in text, allowlisted tables, LIMIT <= 100.',
    '',
    'Table scoping:',
  ];

  for (const t of Object.values(TABLE_CATALOG)) {
    if (t.sql_allowlisted === false) continue;
    lines.push(`- ${t.table} (${t.client_scope_mode}): ${t.client_scope_expression}`);
    if (t.sensitive_columns.length) {
      lines.push(`  sensitive/hidden: ${t.sensitive_columns.join(', ')}`);
    }
  }

  lines.push('', 'Approved query template ids:');
  for (const tmpl of APPROVED_QUERY_TEMPLATES) {
    lines.push(`- ${tmpl.id} [${tmpl.validation_status}]: ${tmpl.description}`);
  }

  lines.push('', `Current client_slug param: ${slug}`);
  lines.push('Do not query blocked tables:', BLOCKED_TABLES.join(', '));
  return lines.join('\n');
}

module.exports = {
  SCOPE_MODES,
  GLOBAL_SENSITIVE_COLUMNS,
  BLOCKED_TABLES,
  getOwnerDataCatalog,
  getOwnerAllowedTables,
  getOwnerClientScopedTables,
  getOwnerAllowedColumns,
  getOwnerTablePolicy,
  getOwnerApprovedQueryTemplates,
  describeOwnerCatalogForAi,
};
