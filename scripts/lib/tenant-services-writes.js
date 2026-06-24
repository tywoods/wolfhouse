'use strict';

/**
 * Wolfhouse Services admin — catalog write/read layer (tenant_services).
 * Validation is pure (no DB) and unit-tested by scripts/verify-tenant-services-writes.js.
 * DB helpers mirror the Sunset admin pattern (idempotent ensure, withPgClient-driven).
 */

const SERVICE_CATEGORIES = new Set(['experience', 'meal', 'transfer', 'rental', 'lesson', 'other']);
const PRICE_UNITS = new Set(['per_day', 'per_week', 'per_stay', 'one_off']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_MAX = 120;
const NOTES_MAX = 2000;
const KEYWORD_MAX = 60;
const SERVICE_FIELDS = new Set([
  'name', 'category', 'notes_for_luna', 'keywords', 'start_date', 'end_date',
  'price_cents', 'price_unit', 'per_guest', 'span_booking', 'luna_visible', 'active',
]);

function isValidDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function rejectUnknown(body) {
  for (const k of Object.keys(body)) {
    if (!SERVICE_FIELDS.has(k)) return { ok: false, error: `unknown field: ${k}` };
  }
  return { ok: true };
}

/** Pure validation. requireName=true for create. Returns { ok, patch } or { ok:false, error }. */
function validateServiceBody(body, { requireName = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid body' };
  }
  const unknown = rejectUnknown(body);
  if (!unknown.ok) return unknown;
  const out = {};

  if (requireName || body.name != null) {
    const name = String(body.name == null ? '' : body.name).trim();
    if (!name) return { ok: false, error: 'name required' };
    if (name.length > NAME_MAX) return { ok: false, error: 'name too long' };
    out.name = name;
  }
  if (body.category != null) {
    const c = String(body.category).trim();
    if (!SERVICE_CATEGORIES.has(c)) return { ok: false, error: 'invalid category' };
    out.category = c;
  }
  if (body.notes_for_luna != null) {
    const n = String(body.notes_for_luna);
    if (n.length > NOTES_MAX) return { ok: false, error: 'notes too long' };
    out.notes_for_luna = n;
  }
  if (body.keywords != null) {
    if (!Array.isArray(body.keywords)) return { ok: false, error: 'keywords must be array' };
    const kws = [];
    for (const raw of body.keywords) {
      const kw = String(raw == null ? '' : raw).trim().toLowerCase();
      if (!kw) continue;
      if (kw.length > KEYWORD_MAX) return { ok: false, error: 'keyword too long' };
      if (!kws.includes(kw)) kws.push(kw);
    }
    out.keywords = kws;
  }
  for (const key of ['start_date', 'end_date']) {
    if (body[key] != null && String(body[key]).trim() !== '') {
      const v = String(body[key]).trim();
      if (!isValidDate(v)) return { ok: false, error: `${key} must be YYYY-MM-DD` };
      out[key] = v;
    } else if (key in body) {
      out[key] = null; // explicit clear
    }
  }
  if (out.start_date && out.end_date && out.end_date < out.start_date) {
    return { ok: false, error: 'end_date must be on/after start_date' };
  }
  if (body.price_cents != null) {
    const n = Number(body.price_cents);
    if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'price_cents must be integer >= 0' };
    out.price_cents = n;
  }
  if (body.price_unit != null) {
    const u = String(body.price_unit).trim();
    if (!PRICE_UNITS.has(u)) return { ok: false, error: 'invalid price_unit' };
    out.price_unit = u;
  }
  for (const key of ['per_guest', 'span_booking', 'luna_visible', 'active']) {
    if (body[key] != null) {
      if (typeof body[key] !== 'boolean') return { ok: false, error: `${key} must be boolean` };
      out[key] = body[key];
    }
  }
  if (!Object.keys(out).length) return { ok: false, error: 'empty body' };
  return { ok: true, patch: out };
}

/**
 * Effective charge (cents) for a booked service. Pure — used by v3 booking integration
 * and unit-tested now so the math is locked before wiring.
 *   nights_in_window = overlap(stayNights, [start_date, end_date]) or stayNights if no window.
 */
function computeServiceChargeCents(service, { guests = 1, stayNights = 1, nightsInWindow = null } = {}) {
  const g = service.per_guest === false ? 1 : Math.max(1, guests);
  let units = 1;
  if (service.span_booking && service.price_unit === 'per_day') {
    units = nightsInWindow == null ? Math.max(0, stayNights) : Math.max(0, nightsInWindow);
  }
  return Math.max(0, Math.round((service.price_cents || 0) * g * units));
}

async function ensureServicesTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS tenant_services (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       TEXT NOT NULL DEFAULT 'wolfhouse',
      client_slug     TEXT NOT NULL,
      name            TEXT NOT NULL,
      category        TEXT,
      notes_for_luna  TEXT,
      keywords        TEXT[] NOT NULL DEFAULT '{}',
      start_date      DATE,
      end_date        DATE,
      price_cents     INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
      price_unit      TEXT NOT NULL DEFAULT 'per_day',
      per_guest       BOOLEAN NOT NULL DEFAULT true,
      span_booking    BOOLEAN NOT NULL DEFAULT false,
      luna_visible    BOOLEAN NOT NULL DEFAULT true,
      active          BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by      UUID
    )`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_tenant_services_client_active
    ON tenant_services (client_slug, active)`);
}

async function listServices(client, { clientSlug, includeInactive = true }) {
  await ensureServicesTable(client);
  const where = includeInactive ? 'client_slug = $1' : 'client_slug = $1 AND active = true';
  const res = await client.query(
    `SELECT * FROM tenant_services WHERE ${where} ORDER BY active DESC, name ASC`,
    [clientSlug],
  );
  return { ok: true, status: 200, body: { success: true, services: res.rows } };
}

async function createService(client, { clientSlug, body, actor }) {
  const v = validateServiceBody(body, { requireName: true });
  if (!v.ok) return { ok: false, status: 400, body: { success: false, error: v.error } };
  await ensureServicesTable(client);
  const p = v.patch;
  const res = await client.query(
    `INSERT INTO tenant_services
       (tenant_id, client_slug, name, category, notes_for_luna, keywords,
        start_date, end_date, price_cents, price_unit, per_guest, span_booking,
        luna_visible, active, updated_by)
     VALUES ('wolfhouse', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::uuid)
     RETURNING *`,
    [
      clientSlug, p.name, p.category || null, p.notes_for_luna || null, p.keywords || [],
      p.start_date || null, p.end_date || null, p.price_cents || 0, p.price_unit || 'per_day',
      p.per_guest != null ? p.per_guest : true, p.span_booking === true,
      p.luna_visible != null ? p.luna_visible : true, p.active != null ? p.active : true,
      (actor && actor.staff_user_id) || null,
    ],
  );
  return { ok: true, status: 201, body: { success: true, service: res.rows[0] } };
}

async function patchService(client, { id, clientSlug, patch, actor }) {
  const v = validateServiceBody(patch, { requireName: false });
  if (!v.ok) return { ok: false, status: 400, body: { success: false, error: v.error } };
  await ensureServicesTable(client);
  const sets = [];
  const params = [];
  let i = 3;
  for (const [k, val] of Object.entries(v.patch)) {
    sets.push(`${k} = $${i}`);
    params.push(val);
    i += 1;
  }
  if (!sets.length) return { ok: false, status: 400, body: { success: false, error: 'empty body' } };
  sets.push('updated_at = NOW()');
  sets.push(`updated_by = $${i}::uuid`);
  params.push((actor && actor.staff_user_id) || null);
  const res = await client.query(
    `UPDATE tenant_services SET ${sets.join(', ')}
       WHERE id = $1::uuid AND client_slug = $2 RETURNING *`,
    [id, clientSlug, ...params],
  );
  if (!res.rows[0]) return { ok: false, status: 404, body: { success: false, error: 'not_found' } };
  return { ok: true, status: 200, body: { success: true, service: res.rows[0] } };
}

async function deactivateService(client, { id, clientSlug, actor }) {
  await ensureServicesTable(client);
  const res = await client.query(
    `UPDATE tenant_services SET active = false, updated_at = NOW(), updated_by = $3::uuid
       WHERE id = $1::uuid AND client_slug = $2 RETURNING id`,
    [id, clientSlug, (actor && actor.staff_user_id) || null],
  );
  if (!res.rows[0]) return { ok: false, status: 404, body: { success: false, error: 'not_found' } };
  return { ok: true, status: 200, body: { success: true, id: res.rows[0].id, active: false } };
}

module.exports = {
  SERVICE_CATEGORIES,
  PRICE_UNITS,
  validateServiceBody,
  computeServiceChargeCents,
  ensureServicesTable,
  listServices,
  createService,
  patchService,
  deactivateService,
};
