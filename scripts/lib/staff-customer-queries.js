/**
 * Staff Portal — read-only customer (guest) history queries.
 *
 * Anchored on phone per tenant. Email is display-only — never a join key.
 * Always scoped via clients.slug = $1.
 *
 * @module staff-customer-queries
 */

'use strict';

const ALLOWED_FILTERS = new Set(['all', 'booked', 'needs_attention']);

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
function getCustomerListQuery(opts) {
  const filter = normalizeCustomerFilter(opts && opts.filter);
  const hasSearch = !!(opts && opts.hasSearch);

  let filterClause = '';
  if (filter === 'booked') {
    filterClause = 'AND (COALESCE(ba.booking_count, 0) > 0 OR COALESCE(sa.service_count, 0) > 0)';
  } else if (filter === 'needs_attention') {
    filterClause = 'AND (lc.needs_human OR COALESCE(ho.has_open_handoff, FALSE))';
  }

  const searchClause = hasSearch
    ? `AND (
      COALESCE(lc.display_name, '') ILIKE $2
      OR COALESCE(lc.email, '') ILIKE $2
      OR lc.phone ILIKE $2
    )`
    : '';

  return `
WITH phone_universe AS (
  SELECT DISTINCT conv.phone AS phone
  FROM conversations conv
  INNER JOIN clients c ON c.id = conv.client_id
  WHERE c.slug = $1
    AND conv.phone IS NOT NULL
    AND TRIM(conv.phone) <> ''
  UNION
  SELECT DISTINCT b.phone AS phone
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  WHERE c.slug = $1
    AND b.phone IS NOT NULL
    AND TRIM(b.phone) <> ''
    AND b.status NOT IN ('cancelled', 'expired')
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
    AND conv.phone IS NOT NULL
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
    AND b.status NOT IN ('cancelled', 'expired')
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
    AND b.phone IS NOT NULL
  GROUP BY b.phone
),
handoff_open AS (
  SELECT DISTINCT conv.phone, TRUE AS has_open_handoff
  FROM staff_handoffs h
  INNER JOIN conversations conv ON conv.id = h.conversation_id
  INNER JOIN clients c ON c.id = conv.client_id
  WHERE c.slug = $1
    AND h.status IN ('open', 'assigned', 'waiting_guest')
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
    AND b.phone IS NOT NULL
  ORDER BY b.phone, bsr.service_date DESC NULLS LAST, bsr.created_at DESC
)
SELECT
  pu.phone,
  lc.conversation_id,
  lc.display_name,
  lc.email,
  lc.language,
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
FROM phone_universe pu
LEFT JOIN latest_conv lc ON lc.phone = pu.phone
LEFT JOIN booking_agg ba ON ba.phone = pu.phone
LEFT JOIN service_agg sa ON sa.phone = pu.phone
LEFT JOIN handoff_open ho ON ho.phone = pu.phone
LEFT JOIN last_service ls ON ls.phone = pu.phone
WHERE 1=1
${searchClause}
${filterClause}
ORDER BY
  (COALESCE(ba.booking_count, 0) > 0 OR COALESCE(sa.service_count, 0) > 0) DESC,
  lc.last_contact_at DESC NULLS LAST,
  pu.phone ASC
LIMIT $${hasSearch ? 3 : 2} OFFSET $${hasSearch ? 4 : 3}
`;
}

/**
 * Detail context for one phone on a tenant.
 * @returns {string} SQL ($1 client slug, $2 phone)
 */
function getCustomerContextQuery() {
  return `
WITH conv AS (
  SELECT conv.*
  FROM conversations conv
  INNER JOIN clients c ON c.id = conv.client_id
  WHERE c.slug = $1 AND conv.phone = $2
  ORDER BY conv.updated_at DESC
  LIMIT 1
)
SELECT
  conv.id::text AS conversation_id,
  conv.phone,
  conv.display_name,
  conv.email,
  conv.language,
  conv.needs_human,
  conv.conversation_stage,
  conv.last_message_preview,
  conv.updated_at AS last_contact_at,
  conv.human_notes,
  conv.internal_staff_notes,
  conv.metadata
FROM conv
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
  const params = [clientSlug];
  if (hasSearch) params.push(`%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`);
  params.push(limit, offset);
  return {
    filter,
    limit,
    offset,
    hasSearch,
    params,
    sql: getCustomerListQuery({ filter, hasSearch }),
  };
}

module.exports = {
  ALLOWED_FILTERS,
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
