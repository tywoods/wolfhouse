/**
 * Staff Portal — customer (guest) history queries and manual-create helpers.
 *
 * Anchored on phone per tenant. Email is display-only — never a join key.
 * Always scoped via clients.slug = $1.
 *
 * @module staff-customer-queries
 */

'use strict';

const crypto = require('crypto');
const {
  DEFAULT_SUNSET_LOCATION_ID,
  SUNSET_CLIENT_SLUG,
  normalizeSunsetLocationId,
  sqlConversationLocationMatch,
  sqlLocationMatch,
} = require('./sunset-school-locations');
const { loadClientPortalProfile } = require('./staff-portal-clients');

/** Email-only CRM identity — never a fake +dddd WhatsApp phone. */
const EMAILCUST_IDENTITY_PREFIX = 'emailcust1:';
const EMAILCUST_IDENTITY_RE = /^emailcust1:/i;
const OPAQUE_EMAIL_PHONE_RE = /^(emailcust1|emailv1|email):/i;

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
  'lesson_today',
  'upcoming',
  'unpaid',
  'waiver_pending',
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

/** System-derived tag keys (subset may overlap editable CRM keys like hot_lead). */
const CUSTOMER_AUTO_TAG_KEYS = [
  'hot_lead',
  'warm_lead',
  'rental',
  'surf_school',
  'needs_attention',
];

/** Stable chip order for cards, detail, and client-side filters. */
const CUSTOMER_DISPLAY_TAG_ORDER = [
  'needs_attention',
  'do_not_contact',
  'hot_lead',
  'warm_lead',
  'lead',
  'rental',
  'surf_school',
  'repeat_guest',
  'vip',
  'local',
  'accommodation',
  'newsletter_ok',
];

/**
 * Normalize list-row or customer-context shapes into tag computation input.
 * @param {object} raw
 */
function resolveCustomerTagInput(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      crm_tags: null,
      booking_count: 0,
      service_count: 0,
      last_service_type: '',
      has_open_handoff: false,
      needs_human: false,
      conversation_id: null,
      last_contact_at: null,
    };
  }
  if (raw.booking_count != null || raw.is_booked != null || raw.last_service_type != null) {
    return {
      crm_tags: raw.crm_tags,
      booking_count: Number(raw.booking_count) || (raw.is_booked ? 1 : 0),
      service_count: Number(raw.service_count) || 0,
      last_service_type: String(raw.last_service_type || ''),
      has_open_handoff: !!raw.has_open_handoff,
      needs_human: !!raw.needs_human,
      conversation_id: raw.conversation_id || null,
      last_contact_at: raw.last_contact_at || null,
    };
  }
  const identity = raw.identity || raw;
  const bookings = Array.isArray(raw.bookings) ? raw.bookings : [];
  const serviceRecords = Array.isArray(raw.service_records) ? raw.service_records : [];
  const openHandoffs = Array.isArray(raw.open_handoffs) ? raw.open_handoffs : [];
  let lastServiceType = '';
  if (serviceRecords.length) {
    const sorted = serviceRecords.slice().sort((a, b) => {
      const da = a.service_date || a.created_at || '';
      const db = b.service_date || b.created_at || '';
      return String(db).localeCompare(String(da));
    });
    lastServiceType = String(sorted[0].service_type || '');
  }
  const activeBookings = bookings.filter((b) => {
    const st = String(b.booking_status || b.status || '').toLowerCase();
    return st !== 'cancelled' && st !== 'expired';
  });
  return {
    crm_tags: identity.crm_tags,
    booking_count: activeBookings.length,
    service_count: serviceRecords.length,
    last_service_type: lastServiceType,
    has_open_handoff: openHandoffs.length > 0,
    needs_human: !!identity.needs_human,
    conversation_id: identity.conversation_id || null,
    last_contact_at: identity.last_contact_at || null,
  };
}

/**
 * Compute system-derived tags from bookings, services, contact, and handoffs.
 * Does not read persisted crm_tags except indirectly via resolveCustomerTagInput.
 *
 * @param {object} input - list row, context payload, or resolved tag input
 * @returns {Record<string, boolean>}
 */
function computeCustomerAutoTags(input) {
  const resolved = (input && input.booking_count != null && input.last_service_type != null
    && input.conversation_id !== undefined && !input.identity)
    ? input
    : resolveCustomerTagInput(input);
  const auto = {};
  const bookingCount = Number(resolved.booking_count) || 0;
  const serviceCount = Number(resolved.service_count) || 0;
  const hasContact = !!(resolved.conversation_id || resolved.last_contact_at);
  if (bookingCount > 0 || serviceCount > 0) {
    auto.hot_lead = true;
  } else if (hasContact) {
    auto.warm_lead = true;
  }
  const serviceType = String(resolved.last_service_type || '');
  if (serviceType === 'wetsuit' || serviceType === 'surfboard') auto.rental = true;
  if (serviceType === 'surf_lesson') auto.surf_school = true;
  if (resolved.has_open_handoff || resolved.needs_human) auto.needs_attention = true;
  return auto;
}

/**
 * Union persisted CRM tags with computed auto tags for display/filtering.
 *
 * @param {object} input - list row or customer context payload
 * @returns {{ crm_tags: object, auto_tags: Record<string, boolean>, display_tags: string[] }}
 */
function buildCustomerDisplayTags(input) {
  const resolved = resolveCustomerTagInput(input);
  const crmTags = parseCrmTagsFromDb(resolved.crm_tags);
  const autoTags = computeCustomerAutoTags(resolved);
  const displayObj = {};
  for (const key of CRM_TAG_KEYS) {
    if (crmTags[key]) displayObj[key] = true;
  }
  for (const key of CUSTOMER_AUTO_TAG_KEYS) {
    if (autoTags[key]) displayObj[key] = true;
  }
  return {
    crm_tags: crmTags,
    auto_tags: autoTags,
    display_tags: CUSTOMER_DISPLAY_TAG_ORDER.filter((key) => displayObj[key]),
  };
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
        AND ${sqlCustomerPhoneMatch('cu.phone', '$2')}
      RETURNING cu.crm_tags, cu.phone`,
    [clientSlug, normalizedPhone, JSON.stringify(crmTags)],
  );
  if (!r.rows.length) {
    return { ok: false, status: 404, body: { success: false, error: 'customer not found' } };
  }
  const mergedTags = mergeCrmTagsFromDbRows(r.rows.map((row) => row.crm_tags));
  return {
    ok: true,
    status: 200,
    body: { success: true, crm_tags: mergedTags, rows_updated: r.rows.length },
  };
}

function isEmailcustIdentity(phone) {
  return EMAILCUST_IDENTITY_RE.test(String(phone || '').trim());
}

function isOpaqueEmailPhoneIdentity(phone) {
  return OPAQUE_EMAIL_PHONE_RE.test(String(phone || '').trim());
}

/**
 * Normalize inbound email for emailcust1 seeding (lowercase, trim).
 * @returns {string|null}
 */
function normalizeCustomerEmailAddress(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim().toLowerCase();
  if (!trimmed || !trimmed.includes('@') || trimmed.length > 320) return null;
  return trimmed;
}

/**
 * Stable email-only customer identity key: emailcust1:<sha256(email)>.
 * Never invents a +dddd phone for email threads.
 */
function buildEmailcustIdentityKey(email) {
  const normalized = normalizeCustomerEmailAddress(email);
  if (!normalized) return '';
  const digest = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  return `${EMAILCUST_IDENTITY_PREFIX}${digest}`;
}

/**
 * Canonical identity key for customer dedupe per tenant.
 * E.164-style phones for WhatsApp; preserves emailcust1: / emailv1: / email: keys.
 * Matches Hermes WhatsApp mirror normalization for real phones.
 */
function normalizeCustomerPhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  if (EMAILCUST_IDENTITY_RE.test(raw)) return raw.slice(0, 96);
  if (/^(emailv1|email):/i.test(raw)) return raw.slice(0, 200);
  if (raw.startsWith('+')) return raw.slice(0, 40);
  const digits = raw.replace(/[^\d]/g, '');
  return digits ? `+${digits}`.slice(0, 40) : '';
}

/** Digits-only phone key for tolerant tenant-scoped matching (+prefix optional). */
function customerPhoneDigits(phone) {
  if (isOpaqueEmailPhoneIdentity(phone)) return '';
  return String(phone || '').replace(/[^\d]/g, '');
}

/**
 * Match customers/conversations by identity key.
 * Opaque email namespaces use exact match only — digits-only would invent collisions.
 */
function sqlCustomerPhoneMatch(column, paramRef) {
  return `(
    ${column} = ${paramRef}::text
    OR (
      ${column} !~* '^(emailcust1|emailv1|email):'
      AND ${paramRef}::text !~* '^(emailcust1|emailv1|email):'
      AND regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g')
        = regexp_replace(COALESCE(${paramRef}::text, ''), '[^0-9]', '', 'g')
      AND regexp_replace(COALESCE(${paramRef}::text, ''), '[^0-9]', '', 'g') <> ''
    )
  )`;
}

/** Digits-only SQL expression for grouping/joining customer phones. */
function sqlCustomerPhoneDigits(column) {
  return `regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g')`;
}

function sqlCustomerPhoneDigitsJoin(leftCol, rightCol) {
  return `${sqlCustomerPhoneDigits(leftCol)} = ${sqlCustomerPhoneDigits(rightCol)}`;
}

function sqlCustomerCanonicalPhoneRank(column) {
  return `(CASE WHEN ${column} LIKE '+%' THEN 0 ELSE 1 END)`;
}

/**
 * Merge persisted CRM tag objects (OR per key — any duplicate row true wins).
 * @param {Array<object|string|null>} rawTagsList
 */
function mergeCrmTagsFromDbRows(rawTagsList) {
  const out = normalizeCrmTags({});
  const list = Array.isArray(rawTagsList) ? rawTagsList : [];
  for (const raw of list) {
    const tags = parseCrmTagsFromDb(raw);
    for (const key of CRM_TAG_KEYS) {
      if (tags[key]) out[key] = true;
    }
  }
  return out;
}

/**
 * Load merged manual CRM tags for all tenant customer rows matching a phone.
 */
async function loadCustomerCrmTagsMerged(pg, clientSlug, phone) {
  const normalizedPhone = normalizeCustomerPhone(phone);
  if (!clientSlug || !normalizedPhone) return normalizeCrmTags({});
  const r = await pg.query(
    `SELECT cu.crm_tags
       FROM customers cu
      INNER JOIN clients c ON c.id = cu.client_id
      WHERE c.slug = $1
        AND ${sqlCustomerPhoneMatch('cu.phone', '$2')}`,
    [clientSlug, normalizedPhone],
  );
  return mergeCrmTagsFromDbRows(r.rows.map((row) => row.crm_tags));
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
 * Parse POST /staff/customers body (manual add / inbox link-guest).
 * Phone-anchored create stays the default. Email-only create (no phone) seeds
 * an emailcust1: identity from the inbound email — never a fake +dddd phone.
 * @returns {{ ok: true, value: {
 *   display_name: string,
 *   phone: string,
 *   email: string|null,
 *   notes: string|null,
 *   conversation_id: string|null,
 *   email_only: boolean,
 * } } | { ok: false, error: string }}
 */
function parseManualCustomerCreateBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const displayName = trimInboundText(b.display_name || b.name || b.full_name, 120);
  const notes = trimInboundText(b.notes, 4000);
  const email = normalizeCustomerEmailAddress(b.email);
  const conversationId = trimInboundText(b.conversation_id, 64);
  const rawPhone = String(b.phone || '').trim();
  let phone = normalizeCustomerPhone(rawPhone);
  let emailOnly = false;

  if (!phone && email) {
    phone = buildEmailcustIdentityKey(email);
    emailOnly = true;
  }

  if (!displayName && !email) return { ok: false, error: 'name is required' };
  if (!phone) return { ok: false, error: emailOnly ? 'email is required' : 'phone is required' };
  if (isOpaqueEmailPhoneIdentity(rawPhone) && !isEmailcustIdentity(rawPhone)) {
    return { ok: false, error: 'invalid phone' };
  }

  const resolvedName = displayName
    || (email ? email.split('@')[0] : '')
    || 'Guest';

  return {
    ok: true,
    value: {
      display_name: resolvedName,
      phone,
      email: email || null,
      notes,
      conversation_id: conversationId || null,
      email_only: emailOnly || isEmailcustIdentity(phone),
    },
  };
}

/**
 * Link conversations.customer_id only when still unlinked.
 * Same customer already linked → ok (idempotent). Different customer → 409.
 *
 * @param {import('pg').Client|import('pg').PoolClient} pg
 * @param {string} clientSlug
 * @param {{ conversation_id: string, customer_id: string }} input
 * @returns {Promise<{ ok: boolean, status: number, body: object }>}
 */
async function linkConversationCustomer(pg, clientSlug, input) {
  const src = input || {};
  const conversationId = trimInboundText(src.conversation_id, 64);
  const customerId = trimInboundText(src.customer_id, 64);
  const slug = String(clientSlug || '').trim();
  if (!slug || !conversationId || !customerId) {
    return { ok: false, status: 400, body: { success: false, error: 'conversation_id and customer_id are required' } };
  }

  const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [slug]);
  if (!clientRes.rows.length) {
    return { ok: false, status: 404, body: { success: false, error: 'client not found' } };
  }
  const clientId = clientRes.rows[0].id;

  const cust = await pg.query(
    `SELECT id::text AS customer_id, phone, full_name, email
       FROM customers
      WHERE client_id = $1::uuid AND id = $2::uuid
      LIMIT 1`,
    [clientId, customerId],
  );
  if (!cust.rows.length) {
    return { ok: false, status: 404, body: { success: false, error: 'customer not found' } };
  }

  const conv = await pg.query(
    `SELECT id::text AS conversation_id, customer_id::text AS customer_id
       FROM conversations
      WHERE client_id = $1::uuid AND id = $2::uuid
      LIMIT 1`,
    [clientId, conversationId],
  );
  if (!conv.rows.length) {
    return { ok: false, status: 404, body: { success: false, error: 'conversation not found' } };
  }

  const existing = conv.rows[0].customer_id || null;
  if (existing && existing !== customerId) {
    return {
      ok: false,
      status: 409,
      body: {
        success: false,
        error: 'conversation already linked',
        conversation_id: conversationId,
        customer_id: existing,
      },
    };
  }

  if (!existing) {
    const upd = await pg.query(
      `UPDATE conversations
          SET customer_id = $3::uuid,
              updated_at = NOW()
        WHERE id = $2::uuid
          AND client_id = $1::uuid
          AND customer_id IS NULL
        RETURNING id::text AS conversation_id, customer_id::text AS customer_id`,
      [clientId, conversationId, customerId],
    );
    if (!upd.rows.length) {
      // Race: another writer linked between SELECT and UPDATE.
      const again = await pg.query(
        `SELECT customer_id::text AS customer_id
           FROM conversations
          WHERE client_id = $1::uuid AND id = $2::uuid
          LIMIT 1`,
        [clientId, conversationId],
      );
      const raced = again.rows[0] && again.rows[0].customer_id;
      if (raced && raced !== customerId) {
        return {
          ok: false,
          status: 409,
          body: {
            success: false,
            error: 'conversation already linked',
            conversation_id: conversationId,
            customer_id: raced,
          },
        };
      }
    }
  }

  const row = cust.rows[0];
  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      linked: true,
      conversation_id: conversationId,
      customer_id: row.customer_id,
      phone: row.phone,
      display_name: row.full_name || null,
      email: row.email || null,
    },
  };
}

/**
 * Manual staff create — tenant-scoped, deduped by normalized phone / emailcust1.
 * On duplicate: returns existing row; fills missing name/notes/email only.
 * Optional conversation_id links the thread (409 if already linked to another guest).
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
  const { display_name, phone, email, notes, conversation_id, email_only: emailOnly } = parsed.value;
  const locationId = trimInboundText(opts.location_id, 64);

  const existing = await pg.query(
    `SELECT id::text AS customer_id, full_name, notes, email
       FROM customers
      WHERE client_id = $1::uuid AND phone = $2
      LIMIT 1`,
    [clientId, phone],
  );
  const hadRow = existing.rows.length > 0;

  const ins = await pg.query(
    `INSERT INTO customers (client_id, phone, full_name, email, notes, location_id, first_seen, last_seen)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (client_id, phone) DO UPDATE SET
       full_name   = COALESCE(customers.full_name, EXCLUDED.full_name),
       email       = COALESCE(customers.email, EXCLUDED.email),
       notes       = COALESCE(customers.notes, EXCLUDED.notes),
       location_id = COALESCE(EXCLUDED.location_id, customers.location_id),
       last_seen   = NOW(),
       updated_at  = NOW()
     RETURNING id::text AS customer_id, full_name, phone, email, notes`,
    [clientId, phone, display_name, email, notes, locationId],
  );
  const row = ins.rows[0];
  if (!row) {
    return { ok: false, status: 500, body: { success: false, error: 'customer create failed' } };
  }

  const bodyOut = {
    success: true,
    customer_id: row.customer_id,
    phone: row.phone,
    display_name: row.full_name || display_name,
    email: row.email || email || null,
    notes: row.notes || notes || null,
    created: !hadRow,
    duplicate: hadRow,
    email_only: !!emailOnly,
  };

  if (conversation_id) {
    const linked = await linkConversationCustomer(pg, clientSlug, {
      conversation_id,
      customer_id: row.customer_id,
    });
    if (!linked.ok) {
      return {
        ok: false,
        status: linked.status,
        body: {
          ...linked.body,
          customer_id: row.customer_id,
          phone: row.phone,
          display_name: bodyOut.display_name,
          email: bodyOut.email,
          created: !hadRow,
          duplicate: hadRow,
        },
      };
    }
    bodyOut.linked = true;
    bodyOut.conversation_id = conversation_id;
  }

  return {
    ok: true,
    status: hadRow ? 200 : 201,
    body: bodyOut,
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

/**
 * Keyset paging replaces OFFSET with the three sort-key params, bound after the
 * page size: $limit, $is_booked, $last_contact_at, $phone.
 */
function customerListKeysetParams(opts) {
  const { limitParam, searchParam } = customerListLimitOffsetParams(opts);
  return { limitParam, searchParam, keysetParam: limitParam + 1 };
}

/** Row fields carrying the customer-list sort key, in ORDER BY order. */
const CUSTOMER_LIST_CURSOR_FIELDS = Object.freeze(['is_booked', 'last_contact_at', 'phone']);

/**
 * Owner of the CRM filter predicates behind ALLOWED_FILTERS. The saved-view
 * registry (staff-inbox-saved-views.js) delegates here instead of restating
 * the booking / payment / waiver business rules.
 *
 * @param {{ filter?: string, accommodationCrm?: boolean, surfCrm?: boolean }} opts
 * @returns {string} SQL fragment appended to the list query WHERE, '' for `all`
 */
function buildCustomerListFilterClause(opts) {
  const filter = normalizeCustomerFilter(opts && opts.filter);
  const accommodationCrm = !!(opts && opts.accommodationCrm);
  const surfCrm = !!(opts && opts.surfCrm);

  let filterClause = '';
  if (filter === 'hot_leads') {
    filterClause = `AND (
      COALESCE(ba.booking_count, 0) > 0
      OR COALESCE(sa.service_count, 0) > 0
      OR COALESCE((crm.crm_tags->>'hot_lead')::boolean, FALSE) = TRUE
    )`;
  } else if (filter === 'warm_leads') {
    filterClause = `AND (
      COALESCE((crm.crm_tags->>'warm_lead')::boolean, FALSE) = TRUE
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
    filterClause = `AND COALESCE((crm.crm_tags->>'do_not_contact')::boolean, FALSE) = TRUE`;
  } else if (filter === 'needs_attention') {
    filterClause = 'AND (lc.needs_human OR COALESCE(ho.has_open_handoff, FALSE))';
  } else if (filter === 'lesson_today') {
    filterClause = 'AND COALESCE(sa.has_service_today, FALSE) = TRUE';
  } else if (filter === 'upcoming') {
    filterClause = 'AND COALESCE(sa.has_future_service, FALSE) = TRUE';
  } else if (filter === 'unpaid') {
    filterClause = 'AND COALESCE(ba.has_balance_due, FALSE) = TRUE';
  } else if (filter === 'waiver_pending') {
    filterClause = surfCrm ? 'AND COALESCE(wp.waiver_pending, FALSE) = TRUE' : 'AND FALSE';
  }
  return filterClause;
}

/** Owner of the booked/lead split: projection, ORDER BY and keyset cursor share it. */
const CUSTOMER_LIST_IS_BOOKED_EXPR = '(COALESCE(ba.booking_count, 0) > 0 OR COALESCE(sa.service_count, 0) > 0)';

const CUSTOMER_LIST_ORDER_BY_SQL = `ORDER BY
  ${CUSTOMER_LIST_IS_BOOKED_EXPR} DESC,
  lc.last_contact_at DESC NULLS LAST,
  cu.phone ASC`;

function customerListSearchClause(opts) {
  if (!(opts && opts.hasSearch)) return '';
  const { searchParam } = customerListLimitOffsetParams(opts);
  return `AND (
      COALESCE(lc.display_name, cu.full_name, '') ILIKE $${searchParam}
      OR COALESCE(lc.email, cu.email, '') ILIKE $${searchParam}
      OR cu.phone ILIKE $${searchParam}
    )`;
}

/**
 * Rows strictly after the cursor under CUSTOMER_LIST_ORDER_BY_SQL. NULL
 * last_contact_at sorts last, so a NULL cursor value only advances on phone.
 */
function customerListCursorClause(opts) {
  const { keysetParam } = customerListKeysetParams(opts);
  const booked = `$${keysetParam}::boolean`;
  const contact = `$${keysetParam + 1}::timestamptz`;
  const phone = `$${keysetParam + 2}::text`;
  return `AND (
  ${CUSTOMER_LIST_IS_BOOKED_EXPR} < ${booked}
  OR (
    ${CUSTOMER_LIST_IS_BOOKED_EXPR} = ${booked}
    AND (
      (${contact} IS NOT NULL AND (lc.last_contact_at IS NULL OR lc.last_contact_at < ${contact}))
      OR (lc.last_contact_at IS NOT DISTINCT FROM ${contact} AND cu.phone > ${phone})
    )
  )
)`;
}

/**
 * The CTE block and FROM/JOIN block behind the customer list. Shared verbatim by
 * the row query and the one-pass counts query so a view count can never drift
 * from the rows that view lists.
 *
 * @param {{ locationScoped?: boolean, surfCrm?: boolean }} opts
 * @returns {{ cteSql: string, fromSql: string }}
 */
function customerListScanSql(opts) {
  const locationScoped = !!(opts && opts.locationScoped);
  const surfCrm = !!(opts && opts.surfCrm);

  const locParam = locationScoped ? 2 : null;
  const convLocClause = locationScoped ? `\n    AND ${sqlConversationLocationMatch('conv', locParam)}` : '';
  const bookingLocClause = locationScoped
    ? `\n    AND COALESCE(b.metadata->>'location_id', '${DEFAULT_SUNSET_LOCATION_ID}') = $${locParam}`
    : '';
  const serviceLocClause = locationScoped ? `\n    AND ${sqlLocationMatch('bsr', 'b', locParam)}` : '';
  // A customer belongs to a location's list if their (sticky, first-touched)
  // location_id matches OR they have any non-cancelled booking / service in that
  // location. This lets a guest with bookings in both schools show up in both
  // customer lists instead of only the one their identity row was first tagged to.
  const custLocClause = locationScoped
    ? `\n    AND (
      COALESCE(cu.location_id, '${DEFAULT_SUNSET_LOCATION_ID}') = $${locParam}
      OR EXISTS (
        SELECT 1 FROM bookings b_loc
        INNER JOIN clients c_loc ON c_loc.id = b_loc.client_id
        WHERE c_loc.slug = $1
          AND b_loc.status NOT IN ('cancelled', 'expired')
          AND ${sqlCustomerPhoneDigits('b_loc.phone')} = ${sqlCustomerPhoneDigits('cu.phone')}
          AND COALESCE(b_loc.metadata->>'location_id', '${DEFAULT_SUNSET_LOCATION_ID}') = $${locParam}
      )
      OR EXISTS (
        SELECT 1 FROM booking_service_records bsr_loc
        INNER JOIN bookings b_loc2 ON b_loc2.id = bsr_loc.booking_id
        WHERE bsr_loc.client_slug = $1
          AND ${sqlCustomerPhoneDigits('b_loc2.phone')} = ${sqlCustomerPhoneDigits('cu.phone')}
          AND ${sqlLocationMatch('bsr_loc', 'b_loc2', locParam)}
      )
    )`
    : '';

  // Waiver-pending aggregate is Sunset-only (needs the waiver_form_requests table).
  const waiverPendingCte = surfCrm ? `,
waiver_pending_agg AS (
  SELECT ${sqlCustomerPhoneDigits('b.phone')} AS phone_digits, TRUE AS waiver_pending
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  WHERE c.slug = $1
    AND b.phone IS NOT NULL
    AND b.status NOT IN ('cancelled', 'expired')
    AND EXISTS (
      SELECT 1 FROM booking_service_records sr
       WHERE sr.booking_id = b.id AND sr.service_type = 'surf_lesson' AND sr.status <> 'cancelled'
    )
    AND NOT EXISTS (
      SELECT 1 FROM waiver_form_requests wr
       WHERE wr.booking_id = b.id AND wr.status = 'completed'
    )${bookingLocClause}
  GROUP BY ${sqlCustomerPhoneDigits('b.phone')}
)` : '';
  const waiverPendingJoin = surfCrm
    ? '\nLEFT JOIN waiver_pending_agg wp ON wp.phone_digits = cu.phone_digits'
    : '';

  const cteSql = `WITH customer_crm_merged AS (
  SELECT DISTINCT ON (${sqlCustomerPhoneDigits('cu.phone')})
    ${sqlCustomerPhoneDigits('cu.phone')} AS phone_digits,
    COALESCE(
      (
        SELECT jsonb_object_agg(s.k, to_jsonb(s.v))
        FROM (
          SELECT e.key AS k,
            bool_or(
              CASE jsonb_typeof(e.value)
                WHEN 'boolean' THEN (e.value)::boolean
                ELSE lower(btrim(e.value::text)) IN ('true', 't', '1')
              END
            ) AS v
          FROM customers cu_inner
          INNER JOIN clients c_inner ON c_inner.id = cu_inner.client_id
          CROSS JOIN LATERAL jsonb_each(COALESCE(cu_inner.crm_tags, '{}'::jsonb)) e
          WHERE c_inner.slug = $1
            AND ${sqlCustomerPhoneDigits('cu_inner.phone')} = ${sqlCustomerPhoneDigits('cu.phone')}
          GROUP BY e.key
        ) s
      ),
      '{}'::jsonb
    ) AS crm_tags
  FROM customers cu
  INNER JOIN clients c ON c.id = cu.client_id
  WHERE c.slug = $1
    AND cu.phone IS NOT NULL
    AND TRIM(cu.phone) <> ''${custLocClause}
  ORDER BY ${sqlCustomerPhoneDigits('cu.phone')}
),
customer_base AS (
  SELECT DISTINCT ON (${sqlCustomerPhoneDigits('cu.phone')})
    ${sqlCustomerPhoneDigits('cu.phone')} AS phone_digits,
    cu.phone,
    cu.full_name,
    cu.email,
    cu.language,
    cu.notes,
    cu.location_id
  FROM customers cu
  INNER JOIN clients c ON c.id = cu.client_id
  WHERE c.slug = $1
    AND cu.phone IS NOT NULL
    AND TRIM(cu.phone) <> ''${custLocClause}
  ORDER BY ${sqlCustomerPhoneDigits('cu.phone')},
    cu.updated_at DESC NULLS LAST,
    ${sqlCustomerCanonicalPhoneRank('cu.phone')}
),
latest_conv AS (
  SELECT DISTINCT ON (${sqlCustomerPhoneDigits('conv.phone')})
    ${sqlCustomerPhoneDigits('conv.phone')} AS phone_digits,
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
  ORDER BY ${sqlCustomerPhoneDigits('conv.phone')}, conv.updated_at DESC
),
booking_agg AS (
  SELECT ${sqlCustomerPhoneDigits('b.phone')} AS phone_digits,
    COUNT(*)::int AS booking_count,
    bool_or(COALESCE(b.balance_due_cents, 0) > 0) AS has_balance_due,
    MAX(b.check_in) AS last_check_in
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  WHERE c.slug = $1
    AND b.phone IS NOT NULL
    AND b.status NOT IN ('cancelled', 'expired')${bookingLocClause}
  GROUP BY ${sqlCustomerPhoneDigits('b.phone')}
),
service_agg AS (
  SELECT ${sqlCustomerPhoneDigits('b.phone')} AS phone_digits,
    COUNT(bsr.id)::int AS service_count,
    bool_or(bsr.service_date = CURRENT_DATE AND bsr.status::text <> 'cancelled') AS has_service_today,
    bool_or(bsr.service_date > CURRENT_DATE AND bsr.status::text <> 'cancelled') AS has_future_service,
    MAX(bsr.service_date) AS last_service_date
  FROM booking_service_records bsr
  INNER JOIN bookings b ON b.id = bsr.booking_id
  INNER JOIN clients c ON c.id = b.client_id
  WHERE bsr.client_slug = $1
    AND c.slug = $1
    AND b.phone IS NOT NULL${serviceLocClause}
  GROUP BY ${sqlCustomerPhoneDigits('b.phone')}
),
handoff_open AS (
  SELECT ${sqlCustomerPhoneDigits('conv.phone')} AS phone_digits, TRUE AS has_open_handoff
  FROM staff_handoffs h
  INNER JOIN conversations conv ON conv.id = h.conversation_id
  INNER JOIN clients c ON c.id = conv.client_id
  WHERE c.slug = $1
    AND h.status IN ('open', 'assigned', 'waiting_guest')${convLocClause}
  GROUP BY ${sqlCustomerPhoneDigits('conv.phone')}
),
last_service AS (
  SELECT DISTINCT ON (${sqlCustomerPhoneDigits('b.phone')})
    ${sqlCustomerPhoneDigits('b.phone')} AS phone_digits,
    b.phone,
    bsr.service_type,
    bsr.quantity,
    bsr.service_date,
    bsr.status AS service_status
  FROM booking_service_records bsr
  INNER JOIN bookings b ON b.id = bsr.booking_id
  WHERE bsr.client_slug = $1
    AND b.phone IS NOT NULL${serviceLocClause}
  ORDER BY ${sqlCustomerPhoneDigits('b.phone')}, bsr.service_date DESC NULLS LAST, bsr.created_at DESC
),
checked_in_agg AS (
  SELECT ${sqlCustomerPhoneDigits('b.phone')} AS phone_digits, TRUE AS checked_in_now
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  WHERE c.slug = $1
    AND b.phone IS NOT NULL
    AND b.status IN ('confirmed', 'checked_in', 'payment_pending')
    AND b.check_in IS NOT NULL
    AND b.check_out IS NOT NULL
    AND b.check_in <= CURRENT_DATE
    AND b.check_out > CURRENT_DATE${bookingLocClause}
  GROUP BY ${sqlCustomerPhoneDigits('b.phone')}
)${waiverPendingCte}`;

  const fromSql = `FROM customer_base cu
INNER JOIN customer_crm_merged crm ON crm.phone_digits = cu.phone_digits
LEFT JOIN latest_conv lc ON lc.phone_digits = cu.phone_digits
LEFT JOIN booking_agg ba ON ba.phone_digits = cu.phone_digits
LEFT JOIN service_agg sa ON sa.phone_digits = cu.phone_digits
LEFT JOIN handoff_open ho ON ho.phone_digits = cu.phone_digits
LEFT JOIN last_service ls ON ls.phone_digits = cu.phone_digits
LEFT JOIN checked_in_agg cia ON cia.phone_digits = cu.phone_digits${waiverPendingJoin}`;

  return { cteSql, fromSql };
}

const CUSTOMER_LIST_PROJECTION_SQL = `SELECT
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
  ${CUSTOMER_LIST_IS_BOOKED_EXPR} AS is_booked,
  crm.crm_tags,
  COALESCE(cia.checked_in_now, FALSE) AS checked_in_now`;

/**
 * @param {object} opts
 * @param {string} [opts.filter] - one of ALLOWED_FILTERS
 * @param {boolean} [opts.hasSearch]
 * @param {boolean} [opts.locationScoped]
 * @param {boolean} [opts.accommodationCrm]
 * @param {boolean} [opts.surfCrm]
 * @param {boolean} [opts.keyset] - bound LIMIT with no OFFSET
 * @param {boolean} [opts.hasCursor] - add the keyset cursor predicate
 */
function getCustomerListQuery(opts) {
  const filter = normalizeCustomerFilter(opts && opts.filter);
  const accommodationCrm = !!(opts && opts.accommodationCrm);
  const surfCrm = !!(opts && opts.surfCrm);
  const keyset = !!(opts && opts.keyset);
  const hasCursor = keyset && !!(opts && opts.hasCursor);
  const { limitParam, offsetParam } = customerListLimitOffsetParams(opts);
  const { cteSql, fromSql } = customerListScanSql(opts);
  const filterClause = buildCustomerListFilterClause({ filter, accommodationCrm, surfCrm });
  const cursorSql = hasCursor ? `${customerListCursorClause(opts)}\n` : '';
  const pageSql = keyset
    ? `${cursorSql}${CUSTOMER_LIST_ORDER_BY_SQL}
LIMIT $${limitParam}`
    : `${CUSTOMER_LIST_ORDER_BY_SQL}
LIMIT $${limitParam} OFFSET $${offsetParam}`;

  return `
${cteSql}
${CUSTOMER_LIST_PROJECTION_SQL}
${fromSql}
WHERE 1=1
${customerListSearchClause(opts)}
${filterClause}
${pageSql}
`;
}

const COUNT_KEY_RE = /^[a-z][a-z0-9_]{0,60}$/;

/**
 * One aggregate pass covering every customer-source saved view: the CTEs and the
 * FROM/JOIN block of the list query are reused verbatim, and each view becomes a
 * `COUNT(*) FILTER (WHERE <its own list predicate>)` column. N views therefore
 * cost one query, not N.
 *
 * @param {object} opts - customerListScanSql opts plus `views`
 * @param {Array<{ key: string, filter: string }>} opts.views
 * @returns {string} SQL ($1 client slug; optional $2 location; optional search param)
 */
function getCustomerListCountsQuery(opts) {
  const views = Array.isArray(opts && opts.views) ? opts.views : [];
  if (!views.length) {
    throw new Error('getCustomerListCountsQuery: at least one view is required');
  }
  const accommodationCrm = !!(opts && opts.accommodationCrm);
  const surfCrm = !!(opts && opts.surfCrm);
  const { cteSql, fromSql } = customerListScanSql(opts);

  const seen = new Set();
  const columns = views.map((view) => {
    const key = String((view && view.key) || '');
    if (!COUNT_KEY_RE.test(key)) {
      throw new Error(`getCustomerListCountsQuery: invalid count key ${JSON.stringify(key)}`);
    }
    if (seen.has(key)) {
      throw new Error(`getCustomerListCountsQuery: duplicate count key ${JSON.stringify(key)}`);
    }
    seen.add(key);
    const predicate = buildCustomerListFilterClause({
      filter: view.filter,
      accommodationCrm,
      surfCrm,
    }).replace(/^AND\s+/, '');
    // Quoted because view ids are free to collide with reserved words ("all").
    return predicate
      ? `  COUNT(*) FILTER (WHERE ${predicate})::int AS "${key}"`
      : `  COUNT(*)::int AS "${key}"`;
  });

  return `
${cteSql}
SELECT
${columns.join(',\n')}
${fromSql}
WHERE 1=1
${customerListSearchClause(opts)}
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
  ORDER BY cu.updated_at DESC NULLS LAST, ${sqlCustomerCanonicalPhoneRank('cu.phone')}
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
  bsr.source,
  bsr.booking_id::text AS booking_id,
  bsr.metadata,
  bsr.created_at
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

function parseServiceRecordMetadata(row) {
  let meta = row && row.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch (_e) { meta = {}; }
  }
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
}

function lastSetupCourseLabel(row, meta) {
  const label = String(
    (meta && (meta.offering_label || meta.label || meta.display_name || meta.service_name)) || ''
  ).trim();
  if (label && !/^(addon_service|rental|surf_lesson)$/i.test(label)) return label;
  const comp = String((meta && (meta.component || meta.staff_ui_service_type)) || '');
  if (/private/i.test(comp)) return 'Private surf';
  if (/group|course/i.test(comp)) return 'Group surf';
  return 'Surf lesson';
}

function isCancelledServiceRecord(row) {
  const st = String((row && (row.service_status || row.status)) || '').toLowerCase();
  return st === 'cancelled' || st === 'canceled';
}

function buildLastSetupSummary(serviceRows) {
  const rows = (serviceRows || []).filter((row) => row && !isCancelledServiceRecord(row));
  if (!rows.length) return null;
  const latest = rows[0];
  const latestKey = String(latest.booking_id || latest.booking_code || '');
  const lastOrder = latestKey
    ? rows.filter((row) => String(row.booking_id || row.booking_code || '') === latestKey)
    : [latest];
  const courses = {};
  let boards = 0;
  let wetsuits = 0;
  let otherParts = [];
  for (const row of lastOrder) {
    const meta = parseServiceRecordMetadata(row);
    const type = String(row.service_type || '');
    const qty = Number(row.quantity) > 0 ? Number(row.quantity) : 1;
    const offeringKey = String(meta.offering_key || '');
    if (type === 'surfboard' || /board/i.test(offeringKey)) {
      boards += qty;
      continue;
    }
    if (type === 'wetsuit' || /wetsuit/i.test(offeringKey)) {
      wetsuits += qty;
      continue;
    }
    if (
      type === 'surf_lesson'
      || meta.component === 'course'
      || meta.component === 'lesson'
      || meta.component === 'private_lesson'
    ) {
      const name = lastSetupCourseLabel(row, meta);
      courses[name] = (courses[name] || 0) + qty;
      continue;
    }
    const leftover = type.replace(/_/g, ' ').trim();
    if (leftover) otherParts.push(`${qty} ${leftover}`);
  }
  const courseParts = Object.keys(courses).map((name) => `${courses[name]}× ${name}`);
  const gear = [];
  if (boards) gear.push(`${boards} board${boards === 1 ? '' : 's'}`);
  if (wetsuits) gear.push(`${wetsuits} wetsuit${wetsuits === 1 ? '' : 's'}`);
  const bits = [];
  if (courseParts.length) bits.push(courseParts.join(', '));
  if (gear.length) bits.push(gear.join(' · '));
  if (!bits.length && otherParts.length) bits.push(otherParts.join(', '));
  return bits.length ? bits.join(' · ') : null;
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
  const convPhoneMatch = sqlCustomerPhoneMatch('phone', '$2');

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
           full_name = $1, email = $2, notes = $3, language = $4,
           phone = $5, updated_at = NOW()
         WHERE id = $6::uuid`,
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
    return {
      ok: false,
      status: 500,
      body: { success: false, error: 'update failed', detail: err.message },
    };
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

/**
 * Tenant / location / search scope shared by the list, keyset and counts params.
 * `params` holds $1 (client slug), the optional location and the optional search
 * term — everything before the paging params.
 */
function buildCustomerListScope(clientSlug, query) {
  const src = query && typeof query === 'object' ? query : {};
  const filter = normalizeCustomerFilter(src.filter);
  const q = String(src.q || src.query || '').trim();
  const hasSearch = q.length > 0;
  const locationId = (clientSlug === SUNSET_CLIENT_SLUG && src.location)
    ? normalizeSunsetLocationId(src.location)
    : null;
  const locationScoped = !!locationId;
  const params = [clientSlug];
  if (locationScoped) params.push(locationId);
  if (hasSearch) params.push(`%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`);
  const accommodationCrm = isAccommodationCrmClient(clientSlug);
  return {
    filter,
    q,
    hasSearch,
    locationId,
    locationScoped,
    accommodationCrm,
    surfCrm: !accommodationCrm,
    params,
  };
}

function normalizeCustomerListCursor(raw) {
  const src = raw && typeof raw === 'object' ? raw : null;
  const phone = src ? String(src.phone == null ? '' : src.phone).trim() : '';
  if (!phone) return null;
  const contact = src.last_contact_at == null || src.last_contact_at === ''
    ? null
    : String(src.last_contact_at);
  return { is_booked: !!src.is_booked, last_contact_at: contact, phone };
}

/**
 * @param {string} clientSlug
 * @param {object} query - filter, q, limit, offset, location
 * @param {{ keyset?: boolean, cursor?: object|null }} [opts] - keyset paging drops
 *   OFFSET; a cursor also adds the sort-key predicate
 */
function buildCustomerListParams(clientSlug, query, opts) {
  const scope = buildCustomerListScope(clientSlug, query);
  const { filter, hasSearch, locationScoped, accommodationCrm, surfCrm } = scope;
  const limit = clampLimit(query.limit);
  const offset = clampOffset(query.offset);
  const rawCursor = opts && opts.cursor;
  const cursor = rawCursor ? normalizeCustomerListCursor(rawCursor) : null;
  if (rawCursor && !cursor) {
    throw new Error('buildCustomerListParams: invalid cursor');
  }
  const keyset = !!(cursor || (opts && opts.keyset));
  const params = scope.params.slice();
  if (keyset) {
    params.push(limit);
    if (cursor) params.push(cursor.is_booked, cursor.last_contact_at, cursor.phone);
  } else {
    params.push(limit, offset);
  }
  return {
    filter,
    limit,
    offset,
    hasSearch,
    locationScoped,
    locationId: scope.locationId,
    accommodationCrm,
    surfCrm,
    keyset,
    cursor,
    params,
    sql: getCustomerListQuery({
      filter,
      hasSearch,
      locationScoped,
      accommodationCrm,
      surfCrm,
      keyset,
      hasCursor: !!cursor,
    }),
  };
}

/**
 * @param {string} clientSlug
 * @param {object} query - location and optional q; paging is irrelevant to counts
 * @param {Array<{ key: string, filter: string }>} views
 */
function buildCustomerListCountsParams(clientSlug, query, views) {
  const scope = buildCustomerListScope(clientSlug, query);
  return {
    hasSearch: scope.hasSearch,
    locationScoped: scope.locationScoped,
    locationId: scope.locationId,
    accommodationCrm: scope.accommodationCrm,
    surfCrm: scope.surfCrm,
    params: scope.params.slice(),
    sql: getCustomerListCountsQuery({
      views,
      hasSearch: scope.hasSearch,
      locationScoped: scope.locationScoped,
      accommodationCrm: scope.accommodationCrm,
      surfCrm: scope.surfCrm,
    }),
  };
}

module.exports = {
  ALLOWED_FILTERS,
  CRM_TAG_KEYS,
  CUSTOMER_AUTO_TAG_KEYS,
  CUSTOMER_DISPLAY_TAG_ORDER,
  resolveCustomerTagInput,
  computeCustomerAutoTags,
  buildCustomerDisplayTags,
  mergeCrmTagsFromDbRows,
  loadCustomerCrmTagsMerged,
  sqlCustomerPhoneDigits,
  sqlCustomerPhoneDigitsJoin,
  normalizeCustomerPhone,
  customerPhoneDigits,
  sqlCustomerPhoneMatch,
  isEmailcustIdentity,
  isOpaqueEmailPhoneIdentity,
  normalizeCustomerEmailAddress,
  buildEmailcustIdentityKey,
  linkConversationCustomer,
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
  buildCustomerListFilterClause,
  customerListLimitOffsetParams,
  customerListKeysetParams,
  customerListScanSql,
  CUSTOMER_LIST_CURSOR_FIELDS,
  CUSTOMER_LIST_IS_BOOKED_EXPR,
  CUSTOMER_LIST_ORDER_BY_SQL,
  getCustomerListQuery,
  getCustomerListCountsQuery,
  buildCustomerListScope,
  buildCustomerListCountsParams,
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
