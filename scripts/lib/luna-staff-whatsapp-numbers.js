/**
 * Luna staff WhatsApp numbers — DB-backed allowlist for /staff/ask-luna
 * source=staff_whatsapp recognition.
 *
 * TWO permission groups:
 *   - 'staff'  → operations access only (no owner insights)
 *   - 'owner'  → operations access + owner insights
 *
 * Tenant-scoped: every query is filtered by client_slug so a write/read for
 * one tenant (e.g. wolfhouse-somo) can never touch another (e.g. sunset).
 *
 * Degrades gracefully if the migration (027) has not been applied yet:
 * a missing relation is caught and treated as "no rows" so the caller can
 * fall back to the static JSON allowlist.
 *
 * @module luna-staff-whatsapp-numbers
 */

'use strict';

const TABLE = 'wolfhouse_staff_whatsapp_numbers';

/** Operations categories every recognized staff/owner number can use. */
const STAFF_OPERATIONS_CATEGORIES = ['bookings', 'payments', 'rooming', 'handoffs', 'addons'];

/** Detect "relation does not exist" so we degrade before migration 027 runs. */
function isMissingStaffWhatsappNumbersTable(err) {
  if (!err) return false;
  if (err.code === '42P01') return true;
  const msg = String(err.message || '');
  return new RegExp(TABLE).test(msg) && /does not exist|undefined table/i.test(msg);
}

/**
 * Runtime twin of migration 027 — lunabox cannot reach Postgres to run migrations,
 * so create the table lazily (idempotent) before the first write. Same shape as the
 * migration. Safe to call repeatedly.
 *
 * @param {import('pg').ClientBase} pg
 */
async function ensureStaffWhatsappNumbersTable(pg) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_slug       TEXT NOT NULL,
      phone             TEXT NOT NULL,
      permission_group  TEXT NOT NULL CHECK (permission_group IN ('staff', 'owner')),
      display_name      TEXT NULL,
      active            BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (client_slug, phone)
    )`);
  await pg.query(
    `CREATE INDEX IF NOT EXISTS idx_wolfhouse_staff_whatsapp_numbers_client_active
       ON ${TABLE} (client_slug, active)`,
  );
}

/**
 * Normalize a raw phone string to an E.164-ish form.
 * Strips spaces, dashes, parens, dots; ensures a single leading '+'.
 * Returns null when the input cannot be a plausible E.164 number.
 *
 * @param {*} raw
 * @returns {string|null}
 */
function normalizeStaffPhone(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Drop everything except digits and a leading +.
  const hadPlus = s.charAt(0) === '+';
  s = s.replace(/[\s\-().]/g, '');
  // Remove any remaining non-digit/non-plus chars.
  s = s.replace(/[^\d+]/g, '');
  // Collapse internal '+' (only a leading one is valid).
  s = (hadPlus ? '+' : '') + s.replace(/\+/g, '');
  if (!hadPlus) s = '+' + s;
  // Basic E.164 validation: + followed by 8..15 digits, first digit 1..9.
  if (!/^\+[1-9]\d{7,14}$/.test(s)) return null;
  return s;
}

/**
 * Map a permission group to the access shape carried into ask-luna execution.
 * 'owner' → owner insights enabled; anything else (incl. 'staff') → operations only.
 *
 * @param {string} group
 * @returns {{role:string, allowed_categories:string[], owner_insights:boolean}}
 */
function mapGroupToAccess(group) {
  if (group === 'owner') {
    return {
      role: 'owner',
      allowed_categories: STAFF_OPERATIONS_CATEGORIES.slice(),
      owner_insights: true,
    };
  }
  return {
    role: 'operator',
    allowed_categories: STAFF_OPERATIONS_CATEGORIES.slice(),
    owner_insights: false,
  };
}

function rowToPublic(row) {
  return {
    id: row.id,
    client_slug: row.client_slug,
    phone: row.phone,
    permission_group: row.permission_group,
    display_name: row.display_name,
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * List all staff/owner numbers for a tenant, oldest first.
 * Returns [] if the table does not exist yet.
 *
 * @param {import('pg').ClientBase} pg
 * @param {string} clientSlug
 * @returns {Promise<object[]>}
 */
async function listStaffWhatsappNumbers(pg, clientSlug) {
  const slug = String(clientSlug || '').trim();
  if (!slug) return [];
  try {
    const res = await pg.query(
      `SELECT id, client_slug, phone, permission_group, display_name, active, created_at, updated_at
         FROM ${TABLE}
        WHERE client_slug = $1
        ORDER BY created_at ASC`,
      [slug],
    );
    return res.rows.map(rowToPublic);
  } catch (err) {
    if (isMissingStaffWhatsappNumbersTable(err)) return [];
    throw err;
  }
}

/**
 * Upsert a number for a tenant (unique on client_slug + phone).
 *
 * @param {import('pg').ClientBase} pg
 * @param {{clientSlug:string, phone:string, permissionGroup:string, displayName?:string|null, active?:boolean}} opts
 * @returns {Promise<{ok:boolean, row?:object, error?:string}>}
 */
async function upsertStaffWhatsappNumber(pg, opts) {
  const o = opts || {};
  const slug = String(o.clientSlug || '').trim();
  if (!slug) return { ok: false, error: 'client_slug_required' };

  const group = String(o.permissionGroup || '').trim();
  if (group !== 'staff' && group !== 'owner') {
    return { ok: false, error: 'invalid_permission_group' };
  }

  const phone = normalizeStaffPhone(o.phone);
  if (!phone) return { ok: false, error: 'invalid_phone' };

  const displayName = o.displayName == null || String(o.displayName).trim() === ''
    ? null
    : String(o.displayName).trim();
  const active = o.active === undefined ? true : o.active === true;

  try {
    const res = await pg.query(
      `INSERT INTO ${TABLE} (client_slug, phone, permission_group, display_name, active)
            VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (client_slug, phone) DO UPDATE
            SET permission_group = EXCLUDED.permission_group,
                display_name     = EXCLUDED.display_name,
                active           = EXCLUDED.active,
                updated_at       = NOW()
        RETURNING id, client_slug, phone, permission_group, display_name, active, created_at, updated_at`,
      [slug, phone, group, displayName, active],
    );
    return { ok: true, row: rowToPublic(res.rows[0]) };
  } catch (err) {
    if (isMissingStaffWhatsappNumbersTable(err)) {
      return { ok: false, error: 'table_missing' };
    }
    throw err;
  }
}

/**
 * Delete a number by id within a tenant.
 *
 * @param {import('pg').ClientBase} pg
 * @param {{clientSlug:string, id:string}} opts
 * @returns {Promise<{ok:boolean, deleted:boolean, error?:string}>}
 */
async function deleteStaffWhatsappNumber(pg, opts) {
  const o = opts || {};
  const slug = String(o.clientSlug || '').trim();
  const id = String(o.id || '').trim();
  if (!slug) return { ok: false, deleted: false, error: 'client_slug_required' };
  if (!id) return { ok: false, deleted: false, error: 'id_required' };

  try {
    const res = await pg.query(
      `DELETE FROM ${TABLE} WHERE client_slug = $1 AND id = $2::uuid RETURNING phone`,
      [slug, id],
    );
    return { ok: true, deleted: res.rowCount > 0, phone: res.rows[0] ? res.rows[0].phone : null };
  } catch (err) {
    if (isMissingStaffWhatsappNumbersTable(err)) {
      return { ok: false, deleted: false, error: 'table_missing' };
    }
    throw err;
  }
}

/**
 * Resolve the active recognition entry for a phone within a tenant.
 * Returns the access shape (role / allowed_categories / owner_insights) so
 * callers can carry it into ask-luna execution.
 *
 * @param {import('pg').ClientBase} pg
 * @param {string} clientSlug
 * @param {string} phone
 * @returns {Promise<{found:boolean, group?:string, display_name?:string|null, role?:string, allowed_categories?:string[], owner_insights?:boolean}>}
 */
async function resolveStaffWhatsappEntry(pg, clientSlug, phone) {
  const slug = String(clientSlug || '').trim();
  const norm = normalizeStaffPhone(phone);
  if (!slug || !norm) return { found: false };

  try {
    const res = await pg.query(
      `SELECT permission_group, display_name
         FROM ${TABLE}
        WHERE client_slug = $1 AND phone = $2 AND active = TRUE
        LIMIT 1`,
      [slug, norm],
    );
    if (!res.rows.length) return { found: false };
    const row = res.rows[0];
    return {
      found: true,
      group: row.permission_group,
      display_name: row.display_name,
      ...mapGroupToAccess(row.permission_group),
    };
  } catch (err) {
    if (isMissingStaffWhatsappNumbersTable(err)) return { found: false };
    throw err;
  }
}

module.exports = {
  STAFF_OPERATIONS_CATEGORIES,
  isMissingStaffWhatsappNumbersTable,
  ensureStaffWhatsappNumbersTable,
  normalizeStaffPhone,
  mapGroupToAccess,
  listStaffWhatsappNumbers,
  upsertStaffWhatsappNumber,
  deleteStaffWhatsappNumber,
  resolveStaffWhatsappEntry,
};
