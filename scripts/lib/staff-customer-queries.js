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
const { loadClientPortalProfile } = require('./staff-portal-clients');

const CRM_TAG_KEYS = [
  'lead',
  'warm_lead',
  'hot_lead',
  'repeat_guest',
  'vip',
  'local',
  'surf_school',
  'accommodation',
  'do_not_contact',
  'newsletter_ok',
];

const ALLOWED_FILTERS = new Set([
  'all',
  'needs_attention',
  'warm_leads',
  'hot_leads',
  'checked_in_now',
  'do_not_contact',
]);

function isAccommodationCrmClient(clientSlug) {
  const profile = loadClientPortalProfile(String(clientSlug || '').trim());
  return !!(profile && !profile.is_surf_vertical);
}

function normalizeCrmTags(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const key of CRM_TAG_KEYS) {
    out[key] = !!src[key];
  }
  return out;
}

function parseCrmTagsFromDb(raw) {
  if (!raw) return normalizeCrmTags({});
  if (typeof raw === 'object') return normalizeCrmTags(raw);
  try {
    return normalizeCrmTags(JSON.parse(raw));
  } catch (_) {
    return normalizeCrmTags({});
  }
}

/**
 * Parse PATCH /staff/customers/:phone/tags body.
 * @returns {{ ok: true, tags: object } | { ok: false, error: string }}
 */
function parseCustomerTagsUpdateBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const tags = normalizeCrmTags(b.tags || b.crm_tags || b);
  return { ok: true, tags };
}

/**
 * Update CRM tags for a tenant-scoped customer (by normalized phone).
 *
 * @param {import('pg').Client|import('pg').PoolClient} pg
 * @param {string} clientSlug
 * @param {string} phone
 * @param {object} tags
 */
async function updateCustomerCrmTags(pg, clientSlug, phone, tags) {
  const normalizedPhone = normalizeCustomerPhone(phone);
  if (!clientSlug || !normalizedPhone) {
    return { ok: false, status: 400, body: { success: false, error: 'invalid client or phone' } };
  }
  const crmTags = normalizeCrmTags(tags);
  const r = await pg.query(
    `UPDATE customers cu
        SET crm_tags = $3::jsonb,
            updated_at = NOW()
       FROM clients c
      WHERE cu.client_id = c.id
        AND c.slug = $1
        AND cu.phone = $2
      RETURNING cu.crm_tags`,
    [clientSlug, normalizedPhone, JSON.stringify(crmTags)],
  );
  if (!r.rows.length) {
    return { ok: false, status: 404, body: { success: false, error: 'customer not found' } };
  }
  return {
    ok: true,
    status: 200,
    body: { success: true, crm_tags: parseCrmTagsFromDb(r.rows[0].crm_tags) },
  };
}

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

/** Digits-only phone key for tolerant tenant-scoped matching (+prefix optional). */
function customerPhoneDigits(phone) {
  return String(phone || '').replace(/[^\d]/g, '');
}

function sqlCustomerPhoneMatch(column, paramRef) {
  return `regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g') = regexp_replace(COALESCE(${paramRef}::text, ''), '[^0-9]', '', 'g')`;
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
  let f = String(filter || 'all').trim().toLowerCase();
  if (f === 'booked') f = 'hot_leads';
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
 * @param {string} opts.filter - all | warm_leads | hot_leads | checked_in_now | do_not_contact | needs_attention
 * @param {boolean} opts.hasSearch - when true, adds ILIKE param $2
 * @param {boolean} [opts.accommodationCrm] - when false, checked_in_now returns no rows
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
  const accommodationCrm = !!(opts && opts.accommodationCrm);
  const { limitParam, offsetParam, searchParam } = customerListLimitOffsetParams(opts);

  let filterClause = '';
  if (filter === 'hot_leads') {
    filterClause = `AND (
      COALESCE(ba.booking_count, 0) > 0
      OR COALESCE(sa.service_count, 0) > 0
      OR COALESCE((cu.crm_tags->>'hot_lead')::boolean, FALSE) = TRUE
    )`;
  } else if (filter === 'warm_leads') {
    filterClause = `AND (
      COALESCE((cu.crm_tags->>'warm_lead')::boolean, FALSE) = TRUE
      OR (
        (lc.conversation_id IS NOT NULL OR lc.last_contact_at IS NOT NULL)
        AND COALESCE(ba.booking_count, 0) = 0
        AND COALESCE(sa.service_count, 0) = 0
      )
    )`;
  } else if (filter === 'checked_in_now') {
    filterClause = accommodationCrm
      ? 'AND COALESCE(cia.checked_in_now, FALSE) = TRUE'
      : 'AND FALSE';
  } else if (filter === 'do_not_contact') {
    filterClause = `AND COALESCE((cu.crm_tags->>'do_not_contact')::boolean, FALSE) = TRUE`;
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
  SELECT cu.phone, cu.full_name, cu.email, cu.language, cu.notes, cu.location_id, cu.crm_tags
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
),
checked_in_agg AS (
  SELECT b.phone, TRUE AS checked_in_now
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  WHERE c.slug = $1
    AND b.phone IS NOT NULL
    AND b.status IN ('confirmed', 'checked_in', 'payment_pending')
    AND b.check_in IS NOT NULL
    AND b.check_out IS NOT NULL
    AND b.check_in <= CURRENT_DATE
    AND b.check_out > CURRENT_DATE${bookingLocClause}
  GROUP BY b.phone
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
  (COALESCE(ba.booking_count, 0) > 0 OR COALESCE(sa.service_count, 0) > 0) AS is_booked,
  cu.crm_tags,
  COALESCE(cia.checked_in_now, FALSE) AS checked_in_now
FROM customer_base cu
LEFT JOIN latest_conv lc ON lc.phone = cu.phone
LEFT JOIN booking_agg ba ON ba.phone = cu.phone
LEFT JOIN service_agg sa ON sa.phone = cu.phone
LEFT JOIN handoff_open ho ON ho.phone = cu.phone
LEFT JOIN last_service ls ON ls.phone = cu.phone
LEFT JOIN checked_in_agg cia ON cia.phone = cu.phone
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
  WHERE c.slug = $1 AND ${sqlCustomerPhoneMatch('cu.phone', '$2')}
  LIMIT 1
),
conv AS (
  SELECT conv.*
  FROM conversations conv
  INNER JOIN clients c ON c.id = conv.client_id
  WHERE c.slug = $1 AND ${sqlCustomerPhoneMatch('conv.phone', '$2')}
  ORDER BY conv.updated_at DESC
  LIMIT 1
)
SELECT
  conv.id::text AS conversation_id,
  COALESCE(cust.phone, conv.phone) AS phone,
  COALESCE(conv.display_name, cust.full_name) AS display_name,
  COALESCE(conv.email, cust.email) AS email,
  COALESCE(conv.language, cust.language) AS language,
  conv.needs_human,
  conv.conversation_stage,
  conv.last_message_preview,
  GREATEST(cust.last_seen, conv.updated_at) AS last_contact_at,
  conv.human_notes,
  COALESCE(cust.notes, conv.internal_staff_notes) AS internal_staff_notes,
  conv.metadata,
  cust.crm_tags
FROM cust
FULL OUTER JOIN conv ON TRUE
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
  b.payment_status::text AS payment_status,
  b.guest_count,
  b.created_at
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND ${sqlCustomerPhoneMatch('b.phone', '$2')}
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
  AND ${sqlCustomerPhoneMatch('b.phone', '$2')}
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
  AND ${sqlCustomerPhoneMatch('conv.phone', '$2')}
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
  AND ${sqlCustomerPhoneMatch('conv.phone', '$2')}
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

function parseCustomerProfileUpdateBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const display_name = String(b.display_name != null ? b.display_name : b.name || '').trim().slice(0, 120);
  const email = String(b.email || '').trim().slice(0, 160);
  const notes = String(b.notes || '').trim().slice(0, 4000);
  const phone = normalizeCustomerPhone(b.phone);
  const language = String(b.language || '').trim().slice(0, 32) || null;
  if (!display_name) return { ok: false, error: 'display_name is required' };
  if (!phone) return { ok: false, error: 'phone is required' };
  return {
    ok: true,
    value: {
      display_name,
      email: email || null,
      notes,
      phone,
      language,
    },
  };
}

/**
 * Update customer profile fields for any tenant (name, phone, email, language, notes).
 * No outbound messaging.
 */
async function updateCustomerProfile(pg, clientSlug, oldPhone, body) {
  const parsed = parseCustomerProfileUpdateBody(body);
  if (!parsed.ok) {
    return { ok: false, status: 400, body: { success: false, error: parsed.error } };
  }
  const input = parsed.value;
  const phoneFrom = normalizeCustomerPhone(oldPhone);
  const phoneDigits = customerPhoneDigits(phoneFrom || input.phone);
  if (!phoneFrom || !clientSlug || !phoneDigits) {
    return { ok: false, status: 400, body: { success: false, error: 'invalid client or phone' } };
  }

  const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
  if (!clientRes.rows.length) {
    return { ok: false, status: 404, body: { success: false, error: 'client not found' } };
  }
  const clientId = clientRes.rows[0].id;
  const phoneMatch = sqlCustomerPhoneMatch('phone', '$2');
  const convPhoneMatch = sqlCustomerPhoneMatch('conv.phone', '$2');

  await pg.query('BEGIN');
  try {
    const keeperRes = await pg.query(
      `SELECT id::text AS id FROM customers
       WHERE client_id = $1::uuid AND ${phoneMatch}
       ORDER BY (phone = $3) DESC, updated_at DESC NULLS LAST, id
       LIMIT 1`,
      [clientId, phoneDigits, input.phone],
    );
    const keeperId = keeperRes.rows[0] && keeperRes.rows[0].id;

    if (keeperId) {
      await pg.query(
        `DELETE FROM customers
         WHERE client_id = $1::uuid AND ${phoneMatch} AND id <> $3::uuid`,
        [clientId, phoneDigits, keeperId],
      );
      await pg.query(
        `UPDATE customers SET
           full_name = $2, email = $3, notes = $4, language = $5,
           phone = $6, updated_at = NOW()
         WHERE id = $7::uuid`,
        [input.display_name, input.email, input.notes || null, input.language, input.phone, keeperId],
      );
    } else {
      await pg.query(
        `INSERT INTO customers (client_id, phone, full_name, email, notes, language)
         VALUES ($1::uuid, $2, $3, $4, $5, $6)
         ON CONFLICT (client_id, phone) DO UPDATE SET
           full_name = EXCLUDED.full_name,
           email = EXCLUDED.email,
           notes = EXCLUDED.notes,
           language = COALESCE(EXCLUDED.language, customers.language),
           updated_at = NOW()`,
        [clientId, input.phone, input.display_name, input.email, input.notes || null, input.language],
      );
    }

    const convRes = await pg.query(
      `UPDATE conversations SET
         display_name = $3,
         email = $4,
         internal_staff_notes = $5,
         language = COALESCE($6, language),
         updated_at = NOW()
       WHERE client_id = $1::uuid AND ${convPhoneMatch}
       RETURNING id::text AS conversation_id, phone`,
      [clientId, phoneDigits, input.display_name, input.email, input.notes || null, input.language],
    );

    await pg.query(
      `UPDATE bookings SET guest_name = $3, phone = $4
       WHERE client_id = $1::uuid AND ${phoneMatch}
         AND status NOT IN ('cancelled', 'expired')`,
      [clientId, phoneDigits, input.display_name, input.phone],
    );

    await pg.query('COMMIT');
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        phone: input.phone,
        previous_phone: phoneFrom,
        conversation_updated: convRes.rows.length > 0,
        display_name: input.display_name,
        email: input.email,
        language: input.language,
        notes: input.notes || null,
      },
    };
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }
}

/**
 * Create or return existing staff conversation for a customer phone (no message send).
 */
async function createCustomerConversation(pg, clientSlug, phone, opts = {}) {
  const normalizedPhone = normalizeCustomerPhone(phone);
  if (!clientSlug || !normalizedPhone) {
    return { ok: false, status: 400, body: { success: false, error: 'invalid client or phone' } };
  }

  const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
  if (!clientRes.rows.length) {
    return { ok: false, status: 404, body: { success: false, error: 'client not found' } };
  }
  const clientId = clientRes.rows[0].id;

  const existing = await pg.query(
    `SELECT conv.id::text AS conversation_id
       FROM conversations conv
      WHERE conv.client_id = $1::uuid AND conv.phone = $2
      ORDER BY conv.updated_at DESC
      LIMIT 1`,
    [clientId, normalizedPhone],
  );
  if (existing.rows.length) {
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        conversation_id: existing.rows[0].conversation_id,
        idempotent: true,
        created: false,
        no_message_sent: true,
        no_whatsapp: true,
      },
    };
  }

  const custRes = await pg.query(
    `SELECT full_name FROM customers WHERE client_id = $1::uuid AND phone = $2 LIMIT 1`,
    [clientId, normalizedPhone],
  );
  const displayName = (custRes.rows[0] && custRes.rows[0].full_name) || null;
  const metadata = opts.metadata && typeof opts.metadata === 'object' ? opts.metadata : {
    source: 'staff_manual',
    channel: 'manual',
    idempotency_key: opts.idempotency_key || `customer-profile-${normalizedPhone}`,
    reason: opts.reason || 'Created from customer profile',
    created_from: 'customer_profile',
  };
  const sessionState = opts.session_state && typeof opts.session_state === 'object'
    ? opts.session_state
    : { source: 'staff_manual', channel: 'manual' };

  const ins = await pg.query(
    `INSERT INTO conversations (
       client_id, phone, display_name, status, bot_mode, conversation_stage, metadata, session_state
     ) VALUES (
       $1, $2, $3, 'open'::conversation_status, 'staff'::bot_mode, 'staff_manual', $4::jsonb, $5::jsonb
     )
     ON CONFLICT (client_id, phone) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, conversations.display_name),
       metadata = conversations.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id::text AS conversation_id`,
    [clientId, normalizedPhone, displayName, JSON.stringify(metadata), JSON.stringify(sessionState)],
  );

  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      conversation_id: ins.rows[0].conversation_id,
      idempotent: false,
      created: true,
      no_message_sent: true,
      no_whatsapp: true,
    },
  };
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
  const accommodationCrm = isAccommodationCrmClient(clientSlug);
  return {
    filter,
    limit,
    offset,
    hasSearch,
    locationScoped,
    locationId,
    accommodationCrm,
    params,
    sql: getCustomerListQuery({ filter, hasSearch, locationScoped, accommodationCrm }),
  };
}

module.exports = {
  ALLOWED_FILTERS,
  CRM_TAG_KEYS,
  normalizeCustomerPhone,
  customerPhoneDigits,
  sqlCustomerPhoneMatch,
  upsertCustomerFromInboundTouch,
  parseManualCustomerCreateBody,
  createOrMergeManualCustomer,
  normalizeCustomerFilter,
  normalizeCrmTags,
  parseCrmTagsFromDb,
  parseCustomerTagsUpdateBody,
  updateCustomerCrmTags,
  isAccommodationCrmClient,
  clampLimit,
  clampOffset,
  getCustomerListQuery,
  getCustomerContextQuery,
  getCustomerBookingsQuery,
  getCustomerServiceRecordsQuery,
  getCustomerHandoffsQuery,
  getCustomerMessagesQuery,
  buildLastSetupSummary,
  parseCustomerProfileUpdateBody,
  updateCustomerProfile,
  createCustomerConversation,
  buildCustomerListParams,
};
