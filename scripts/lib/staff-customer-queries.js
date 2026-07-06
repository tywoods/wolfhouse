/**
 * Staff Portal — customer (guest) history queries and manual-create helpers.
 *
 * Anchored on phone per tenant. Email is display-only — never a join key.
 * Always scoped via clients.slug = $1.
 *
 * @module staff-customer-queries
 */

'use strict';

const {
  DEFAULT_SUNSET_LOCATION_ID,
  SUNSET_CLIENT_SLUG,
  normalizeSunsetLocationId,
  sqlConversationLocationMatch,
  sqlLocationMatch,
} = require('./sunset-school-locations');

const ALLOWED_FILTERS = new Set(['all', 'booked', 'needs_attention']);

/**
 * Canonical E.164-style phone key for customer dedupe per tenant.
 * Matches Hermes WhatsApp mirror normalization.
 */
function normalizeCustomerPhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  if (raw.startsWith('+')) return raw.slice(0, 40);
  const digits = raw.replace(/[^\d]/g, '');
  return digits ? `+${digits}`.slice(0, 40) : '';
}

function trimInboundText(value, maxLen) {
  const s = String(value || '').trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

/**
 * Upsert a tenant-scoped customer row when an inbound WhatsApp/Luna contact touches
 * the inbox. Deduped by (client_id, normalized phone). Display name is only filled
 * when missing — never overwritten with null/blank on repeat inbound.
 *
 * @param {import('pg').Client|import('pg').PoolClient} pg
 * @param {{
 *   client_slug: string,
 *   client_id?: string,
 *   phone: string,
 *   display_name?: string|null,
 *   email?: string|null,
 *   location_id?: string|null,
 *   conversation_id?: string|null,
 * }} input
 * @returns {Promise<{ ok: boolean, reason?: string, customer_id?: string, phone?: string, client_id?: string }>}
 */
async function upsertCustomerFromInboundTouch(pg, input) {
  const src = input || {};
  const clientSlug = String(src.client_slug || '').trim();
  const phone = normalizeCustomerPhone(src.phone);
  if (!clientSlug || !phone) {
    return { ok: false, reason: 'missing_client_or_phone' };
  }

  let clientId = src.client_id || null;
  if (!clientId) {
    const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
    clientId = clientRes.rows[0] && clientRes.rows[0].id;
  }
  if (!clientId) {
    return { ok: false, reason: 'client_not_found' };
  }

  const displayName = trimInboundText(src.display_name, 120);
  const email = trimInboundText(src.email, 160);
  const locationId = trimInboundText(src.location_id, 64);

  const ins = await pg.query(
    `INSERT INTO customers (client_id, phone, full_name, email, location_id, first_seen, last_seen)
     VALUES ($1::uuid, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (client_id, phone) DO UPDATE SET
       full_name   = COALESCE(EXCLUDED.full_name, customers.full_name),
       email       = COALESCE(EXCLUDED.email, customers.email),
       location_id = COALESCE(EXCLUDED.location_id, customers.location_id),
       last_seen   = NOW(),
       updated_at  = NOW()
     RETURNING id::text AS customer_id`,
    [clientId, phone, displayName, email, locationId],
  );
  const customerId = ins.rows[0] && ins.rows[0].customer_id;
  if (!customerId) {
    return { ok: false, reason: 'customer_upsert_failed' };
  }

  const conversationId = trimInboundText(src.conversation_id, 64);
  if (conversationId) {
    await pg.query(
      `UPDATE conversations
          SET customer_id = $3::uuid,
              updated_at = NOW()
        WHERE id = $2::uuid
          AND client_id = $1::uuid
          AND (customer_id IS NULL OR customer_id = $3::uuid)`,
      [clientId, conversationId, customerId],
    );
  }

  return { ok: true, customer_id: customerId, phone, client_id: clientId };
}

/**
 * Parse POST /staff/customers body (manual add).
 * @returns {{ ok: true, value: { display_name: string, phone: string, notes: string|null } } | { ok: false, error: string }}
 */
function parseManualCustomerCreateBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const displayName = trimInboundText(b.display_name || b.name || b.full_name, 120);
  const phone = normalizeCustomerPhone(b.phone);
  const notes = trimInboundText(b.notes, 4000);
  if (!displayName) return { ok: false, error: 'name is required' };
  if (!phone) return { ok: false, error: 'phone is required' };
  return { ok: true, value: { display_name: displayName, phone, notes } };
}

/**
 * Manual staff create — tenant-scoped, deduped by normalized phone.
 * On duplicate: returns existing row; fills missing name/notes only.
 *
 * @param {import('pg').Client|import('pg').PoolClient} pg
 * @param {string} clientSlug
 * @param {object} body
 * @param {{ location_id?: string|null }} [opts]
 */
async function createOrMergeManualCustomer(pg, clientSlug, body, opts = {}) {
  const parsed = parseManualCustomerCreateBody(body);
  if (!parsed.ok) {
    return { ok: false, status: 400, body: { success: false, error: parsed.error } };
  }

  const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
  if (!clientRes.rows.length) {
    return { ok: false, status: 404, body: { success: false, error: 'client not found' } };
  }
  const clientId = clientRes.rows[0].id;
  const { display_name, phone, notes } = parsed.value;
  const locationId = trimInboundText(opts.location_id, 64);

  const existing = await pg.query(
    `SELECT id::text AS customer_id, full_name, notes
       FROM customers
      WHERE client_id = $1::uuid AND phone = $2
      LIMIT 1`,
    [clientId, phone],
  );
  const hadRow = existing.rows.length > 0;

  const ins = await pg.query(
    `INSERT INTO customers (client_id, phone, full_name, notes, location_id, first_seen, last_seen)
     VALUES ($1::uuid, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (client_id, phone) DO UPDATE SET
       full_name   = COALESCE(customers.full_name, EXCLUDED.full_name),
       notes       = COALESCE(customers.notes, EXCLUDED.notes),
       location_id = COALESCE(EXCLUDED.location_id, customers.location_id),
       last_seen   = NOW(),
       updated_at  = NOW()
     RETURNING id::text AS customer_id, full_name, phone, notes`,
    [clientId, phone, display_name, notes, locationId],
  );
  const row = ins.rows[0];
  if (!row) {
    return { ok: false, status: 500, body: { success: false, error: 'customer create failed' } };
  }

  return {
    ok: true,
    status: hadRow ? 200 : 201,
    body: {
      success: true,
      customer_id: row.customer_id,
      phone: row.phone,
      display_name: row.full_name || display_name,
      notes: row.notes || notes || null,
      created: !hadRow,
      duplicate: hadRow,
    },
  };
}

function normalizeCustomerFilter(filter) {
  const f = String(filter || 'all').trim().toLowerCase();
  return ALLOWED_FILTERS.has(f) ? f : 'all';
}

function clampLimit(limit) {
  const n = parseInt(limit, 10);
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(n, 100);
}

function clampOffset(offset) {
  const n = parseInt(offset, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * List customers for a tenant. One row per phone.
 *
 * @param {object} opts
 * @param {string} opts.filter - all | booked | needs_attention
 * @param {boolean} opts.hasSearch - when true, adds ILIKE param $2
 * @returns {string} SQL ($1 client slug; optional $2 search; $3 limit; $4 offset)
 */
function customerListLimitOffsetParams(opts) {
  const hasSearch = !!(opts && opts.hasSearch);
  const locationScoped = !!(opts && opts.locationScoped);
  let idx = 2;
  if (locationScoped) idx += 1;
  const searchParam = hasSearch ? idx : null;
  if (hasSearch) idx += 1;
  return { limitParam: idx, offsetParam: idx + 1, searchParam };
}

function getCustomerListQuery(opts) {
  const filter = normalizeCustomerFilter(opts && opts.filter);
  const hasSearch = !!(opts && opts.hasSearch);
  const locationScoped = !!(opts && opts.locationScoped);
  const { limitParam, offsetParam, searchParam } = customerListLimitOffsetParams(opts);

  let filterClause = '';
  if (filter === 'booked') {
    filterClause = 'AND (COALESCE(ba.booking_count, 0) > 0 OR COALESCE(sa.service_count, 0) > 0)';
  } else if (filter === 'needs_attention') {
    filterClause = 'AND (lc.needs_human OR COALESCE(ho.has_open_handoff, FALSE))';
  }

  const searchClause = hasSearch
    ? `AND (
      COALESCE(lc.display_name, cu.full_name, '') ILIKE $${searchParam}
      OR COALESCE(lc.email, cu.email, '') ILIKE $${searchParam}
      OR cu.phone ILIKE $${searchParam}
    )`
    : '';

  const locParam = locationScoped ? 2 : null;
  const convLocClause = locationScoped ? `\n    AND ${sqlConversationLocationMatch('conv', locParam)}` : '';
  const bookingLocClause = locationScoped
    ? `\n    AND COALESCE(b.metadata->>'location_id', '${DEFAULT_SUNSET_LOCATION_ID}') = $${locParam}`
    : '';
  const serviceLocClause = locationScoped ? `\n    AND ${sqlLocationMatch('bsr', 'b', locParam)}` : '';
  const custLocClause = locationScoped
    ? `\n    AND COALESCE(cu.location_id, '${DEFAULT_SUNSET_LOCATION_ID}') = $${locParam}`
    : '';

  return `
WITH customer_base AS (
  SELECT cu.phone, cu.full_name, cu.email, cu.language, cu.notes, cu.location_id
  FROM customers cu
  INNER JOIN clients c ON c.id = cu.client_id
  WHERE c.slug = $1
    AND cu.phone IS NOT NULL
    AND TRIM(cu.phone) <> ''${custLocClause}
),
latest_conv AS (
  SELECT DISTINCT ON (conv.phone)
    conv.phone,
    conv.id::text AS conversation_id,
    conv.display_name,
    conv.email,
    conv.language,
    conv.needs_human,
    conv.conversation_stage,
    conv.last_message_preview,
    conv.updated_at AS last_contact_at
  FROM conversations conv
  INNER JOIN clients c ON c.id = conv.client_id
  WHERE c.slug = $1
    AND conv.phone IS NOT NULL${convLocClause}
  ORDER BY conv.phone, conv.updated_at DESC
),
booking_agg AS (
  SELECT b.phone,
    COUNT(*)::int AS booking_count,
    MAX(b.check_in) AS last_check_in
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  WHERE c.slug = $1
    AND b.phone IS NOT NULL
    AND b.status NOT IN ('cancelled', 'expired')${bookingLocClause}
  GROUP BY b.phone
),
service_agg AS (
  SELECT b.phone,
    COUNT(bsr.id)::int AS service_count,
    MAX(bsr.service_date) AS last_service_date
  FROM booking_service_records bsr
  INNER JOIN bookings b ON b.id = bsr.booking_id
  INNER JOIN clients c ON c.id = b.client_id
  WHERE bsr.client_slug = $1
    AND c.slug = $1
    AND b.phone IS NOT NULL${serviceLocClause}
  GROUP BY b.phone
),
handoff_open AS (
  SELECT DISTINCT conv.phone, TRUE AS has_open_handoff
  FROM staff_handoffs h
  INNER JOIN conversations conv ON conv.id = h.conversation_id
  INNER JOIN clients c ON c.id = conv.client_id
  WHERE c.slug = $1
    AND h.status IN ('open', 'assigned', 'waiting_guest')${convLocClause}
),
last_service AS (
  SELECT DISTINCT ON (b.phone)
    b.phone,
    bsr.service_type,
    bsr.quantity,
    bsr.service_date,
    bsr.status AS service_status
  FROM booking_service_records bsr
  INNER JOIN bookings b ON b.id = bsr.booking_id
  WHERE bsr.client_slug = $1
    AND b.phone IS NOT NULL${serviceLocClause}
  ORDER BY b.phone, bsr.service_date DESC NULLS LAST, bsr.created_at DESC
)
SELECT
  cu.phone,
  lc.conversation_id,
  COALESCE(lc.display_name, cu.full_name) AS display_name,
  COALESCE(lc.email, cu.email) AS email,
  COALESCE(lc.language, cu.language) AS language,
  COALESCE(lc.needs_human, FALSE) AS needs_human,
  lc.conversation_stage,
  lc.last_message_preview,
  lc.last_contact_at,
  COALESCE(ba.booking_count, 0) AS booking_count,
  COALESCE(sa.service_count, 0) AS service_count,
  ba.last_check_in,
  sa.last_service_date,
  ls.service_type AS last_service_type,
  ls.quantity AS last_service_quantity,
  ls.service_date AS last_service_date_detail,
  COALESCE(ho.has_open_handoff, FALSE) AS has_open_handoff,
  (COALESCE(ba.booking_count, 0) > 0 OR COALESCE(sa.service_count, 0) > 0) AS is_booked
FROM customer_base cu
LEFT JOIN latest_conv lc ON lc.phone = cu.phone
LEFT JOIN booking_agg ba ON ba.phone = cu.phone
LEFT JOIN service_agg sa ON sa.phone = cu.phone
LEFT JOIN handoff_open ho ON ho.phone = cu.phone
LEFT JOIN last_service ls ON ls.phone = cu.phone
WHERE 1=1
${searchClause}
${filterClause}
ORDER BY
  (COALESCE(ba.booking_count, 0) > 0 OR COALESCE(sa.service_count, 0) > 0) DESC,
  lc.last_contact_at DESC NULLS LAST,
  cu.phone ASC
LIMIT $${limitParam} OFFSET $${offsetParam}
`;
}

/**
 * Detail context for one phone on a tenant.
 * @returns {string} SQL ($1 client slug, $2 phone)
 */
function getCustomerContextQuery() {
  return `
WITH cust AS (
  SELECT cu.*
  FROM customers cu
  INNER JOIN clients c ON c.id = cu.client_id
  WHERE c.slug = $1 AND cu.phone = $2
  LIMIT 1
),
conv AS (
  SELECT conv.*
  FROM conversations conv
  INNER JOIN clients c ON c.id = conv.client_id
  WHERE c.slug = $1 AND conv.phone = $2
  ORDER BY conv.updated_at DESC
  LIMIT 1
)
SELECT
  conv.id::text AS conversation_id,
  cust.phone,
  COALESCE(conv.display_name, cust.full_name) AS display_name,
  COALESCE(conv.email, cust.email) AS email,
  COALESCE(conv.language, cust.language) AS language,
  conv.needs_human,
  conv.conversation_stage,
  conv.last_message_preview,
  GREATEST(cust.last_seen, conv.updated_at) AS last_contact_at,
  conv.human_notes,
  COALESCE(cust.notes, conv.internal_staff_notes) AS internal_staff_notes,
  conv.metadata
FROM cust
LEFT JOIN conv ON TRUE
`;
}

function getCustomerBookingsQuery() {
  return `
SELECT
  b.id::text AS booking_id,
  b.booking_code,
  b.guest_name,
  b.check_in,
  b.check_out,
  b.status::text AS booking_status,
  b.payment_status::text AS payment_payment_status,
  b.guest_count,
  b.created_at
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.phone = $2
  AND b.status NOT IN ('cancelled', 'expired')
ORDER BY b.check_in DESC NULLS LAST, b.created_at DESC
LIMIT 20
`;
}

function getCustomerServiceRecordsQuery() {
  return `
SELECT
  bsr.id::text AS service_record_id,
  bsr.booking_code,
  bsr.guest_name,
  bsr.service_type,
  bsr.service_date,
  bsr.quantity,
  bsr.status AS service_status,
  bsr.payment_status,
  bsr.notes,
  bsr.source
FROM booking_service_records bsr
INNER JOIN bookings b ON b.id = bsr.booking_id
INNER JOIN clients c ON c.id = b.client_id
WHERE bsr.client_slug = $1
  AND c.slug = $1
  AND b.phone = $2
ORDER BY bsr.service_date DESC NULLS LAST, bsr.created_at DESC
LIMIT 30
`;
}

function getCustomerHandoffsQuery() {
  return `
SELECT
  h.id::text AS handoff_id,
  h.reason_code,
  h.summary,
  h.priority,
  h.status::text AS handoff_status,
  h.opened_at,
  h.source_channel
FROM staff_handoffs h
INNER JOIN conversations conv ON conv.id = h.conversation_id
INNER JOIN clients c ON c.id = conv.client_id
WHERE c.slug = $1
  AND conv.phone = $2
ORDER BY h.opened_at DESC
LIMIT 10
`;
}

function getCustomerMessagesQuery() {
  return `
SELECT
  m.id::text AS message_id,
  m.direction::text AS direction,
  m.message_text,
  m.source,
  m.created_at
FROM messages m
INNER JOIN conversations conv ON conv.id = m.conversation_id
INNER JOIN clients c ON c.id = conv.client_id
WHERE c.slug = $1
  AND conv.phone = $2
ORDER BY m.created_at DESC
LIMIT 15
`;
}

function buildLastSetupSummary(serviceRows) {
  if (!serviceRows || !serviceRows.length) return null;
  const parts = [];
  const byType = {};
  for (const row of serviceRows) {
    const t = row.service_type || 'service';
    byType[t] = (byType[t] || 0) + (row.quantity || 1);
  }
  if (byType.surfboard) parts.push(`${byType.surfboard} surfboard${byType.surfboard > 1 ? 's' : ''}`);
  if (byType.wetsuit) parts.push(`${byType.wetsuit} wetsuit${byType.wetsuit > 1 ? 's' : ''}`);
  if (byType.surf_lesson) parts.push(`${byType.surf_lesson} lesson${byType.surf_lesson > 1 ? 's' : ''}`);
  for (const [k, v] of Object.entries(byType)) {
    if (['surfboard', 'wetsuit', 'surf_lesson'].includes(k)) continue;
    parts.push(`${v} ${k.replace(/_/g, ' ')}`);
  }
  return parts.length ? parts.join(', ') : null;
}

function buildCustomerListParams(clientSlug, query) {
  const filter = normalizeCustomerFilter(query.filter);
  const limit = clampLimit(query.limit);
  const offset = clampOffset(query.offset);
  const q = String(query.q || query.query || '').trim();
  const hasSearch = q.length > 0;
  const locationId = (clientSlug === SUNSET_CLIENT_SLUG && query && query.location)
    ? normalizeSunsetLocationId(query.location)
    : null;
  const locationScoped = !!locationId;
  const params = [clientSlug];
  if (locationScoped) params.push(locationId);
  if (hasSearch) params.push(`%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`);
  params.push(limit, offset);
  return {
    filter,
    limit,
    offset,
    hasSearch,
    locationScoped,
    locationId,
    params,
    sql: getCustomerListQuery({ filter, hasSearch, locationScoped }),
  };
}

module.exports = {
  ALLOWED_FILTERS,
  normalizeCustomerPhone,
  upsertCustomerFromInboundTouch,
  parseManualCustomerCreateBody,
  createOrMergeManualCustomer,
  normalizeCustomerFilter,
  clampLimit,
  clampOffset,
  getCustomerListQuery,
  getCustomerContextQuery,
  getCustomerBookingsQuery,
  getCustomerServiceRecordsQuery,
  getCustomerHandoffsQuery,
  getCustomerMessagesQuery,
  buildLastSetupSummary,
  buildCustomerListParams,
};
