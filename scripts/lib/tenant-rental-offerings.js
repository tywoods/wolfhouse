'use strict';

/**
 * Phase 2: data-access + CRUD for tenant_rental_offerings (migration 051) — the
 * single owner of rentable-item IDENTITY (offering_key), display (label), UI
 * grouping (group_key) and mutual-exclusion (excludes[]). This replaces the
 * closed RENTAL_GROUP_* code enums in tenant-admin-writes.js.
 *
 * Money is NOT here: price-per-period lives in tenant_price_rules keyed by the
 * `offering_key__period_window` item_code (see tenant-admin-writes price CRUD).
 * A "rental item" the staff panel creates = one row here + one price row per
 * rentable period.
 *
 * Every query is client+location scoped. `excludes` is symmetric data that
 * replaces the hardcoded `if (key === 'board_and_suit_rental')` bundle logic.
 *
 * Refs: docs/SURF-SCHOOL-TEMPLATE-PLAN.md Phase 2; database/migrations/051.
 */

// offering_key doubles as the head of the price item_code (offering_key__period).
// `__` is the reserved period separator, so it must not appear in the key.
const OFFERING_KEY_RE = /^[a-z][a-z0-9_]*$/;
const GROUP_KEY_RE = /^[a-z][a-z0-9_]*$/;
const MAX_OFFERING_KEY = 64;
const MAX_LABEL = 120;
const MAX_GROUP_KEY = 40;

function isValidOfferingKey(key) {
  const k = String(key || '').trim();
  return k.length > 0 && k.length <= MAX_OFFERING_KEY && !k.includes('__') && OFFERING_KEY_RE.test(k);
}

function normLoc(locationId) {
  return locationId == null ? null : String(locationId).trim() || null;
}

/**
 * Validate a create/patch body. Pure — no DB. Returns {ok, value} | {ok:false,error}.
 * `mode` = 'create' requires the full identity; 'rename' allows label only.
 */
function validateRentalOfferingBody(body, mode = 'create') {
  const b = body && typeof body === 'object' ? body : {};

  if (mode === 'create' && !isValidOfferingKey(b.offering_key)) {
    return { ok: false, error: 'invalid offering_key (lowercase, no "__", <=64 chars)' };
  }

  const label = String(b.label == null ? '' : b.label).trim();
  if (mode !== 'rename' || b.label !== undefined) {
    if (!label || label.length > MAX_LABEL) {
      return { ok: false, error: `label is required (1-${MAX_LABEL} chars)` };
    }
  }

  let groupKey;
  if (mode === 'create' || b.group_key !== undefined) {
    groupKey = String(b.group_key == null ? '' : b.group_key).trim();
    if (!groupKey || groupKey.length > MAX_GROUP_KEY || !GROUP_KEY_RE.test(groupKey)) {
      return { ok: false, error: 'invalid group_key (lowercase, <=40 chars)' };
    }
  }

  let excludes;
  if (mode === 'create' || b.excludes !== undefined) {
    const raw = b.excludes === undefined ? [] : b.excludes;
    if (!Array.isArray(raw)) return { ok: false, error: 'excludes must be an array' };
    const selfKey = String(b.offering_key || '').trim();
    const seen = new Set();
    for (const item of raw) {
      const k = String(item || '').trim();
      if (!isValidOfferingKey(k)) return { ok: false, error: `invalid excludes entry: ${item}` };
      if (k === selfKey) return { ok: false, error: 'offering cannot exclude itself' };
      seen.add(k);
    }
    excludes = [...seen].sort();
  }

  let sortOrder;
  if (b.sort_order !== undefined) {
    sortOrder = Number(b.sort_order);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      return { ok: false, error: 'sort_order must be a non-negative integer' };
    }
  }

  return {
    ok: true,
    value: {
      offering_key: mode === 'create' ? String(b.offering_key).trim() : undefined,
      label: label || undefined,
      group_key: groupKey,
      excludes,
      sort_order: sortOrder,
    },
  };
}

function rowToOffering(row) {
  if (!row) return null;
  let excludes = row.excludes;
  if (typeof excludes === 'string') {
    try { excludes = JSON.parse(excludes); } catch (_) { excludes = []; }
  }
  return {
    id: row.id,
    client_slug: row.client_slug,
    location_id: row.location_id,
    offering_key: row.offering_key,
    label: row.label,
    group_key: row.group_key,
    excludes: Array.isArray(excludes) ? excludes : [],
    sort_order: row.sort_order,
    active: row.active,
  };
}

/**
 * List active rental offerings for a client+location, ordered for stable render.
 * @returns {Promise<Array>}
 */
async function listRentalOfferings(pg, { clientSlug, locationId, includeInactive = false } = {}) {
  const slug = String(clientSlug || '').trim();
  if (!slug) return [];
  const loc = normLoc(locationId);
  const where = ['client_slug = $1'];
  const params = [slug];
  // location match: exact, OR client-wide rows (NULL location) always apply.
  if (loc != null) {
    params.push(loc);
    where.push(`(location_id = $${params.length} OR location_id IS NULL)`);
  }
  if (!includeInactive) where.push('active = true');
  const res = await pg.query(
    // MULTICLIENT_SCOPE_OK: client_slug predicate first, location-scoped
    `SELECT id, client_slug, location_id, offering_key, label, group_key, excludes, sort_order, active
       FROM tenant_rental_offerings
      WHERE ${where.join(' AND ')}
      ORDER BY sort_order ASC, offering_key ASC`,
    params,
  );
  return res.rows.map(rowToOffering);
}

/** Create a rental item. Fails on duplicate active offering_key (unique index). */
async function createRentalOffering(pg, params = {}) {
  const slug = String(params.clientSlug || '').trim();
  if (!slug) return { ok: false, error: 'clientSlug is required' };
  const v = validateRentalOfferingBody(params, 'create');
  if (!v.ok) return v;
  const loc = normLoc(params.locationId);
  try {
    const res = await pg.query(
      // MULTICLIENT_SCOPE_OK: explicit client_slug column on insert
      `INSERT INTO tenant_rental_offerings
         (client_slug, location_id, offering_key, label, group_key, excludes, sort_order, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id, client_slug, location_id, offering_key, label, group_key, excludes, sort_order, active`,
      [slug, loc, v.value.offering_key, v.value.label, v.value.group_key,
        JSON.stringify(v.value.excludes || []), v.value.sort_order || 0, params.actorId || null],
    );
    return { ok: true, offering: rowToOffering(res.rows[0]) };
  } catch (err) {
    if (/duplicate key|uq_tenant_rental_offerings_active/i.test(String(err && err.message))) {
      return { ok: false, error: 'a rental item with this offering_key already exists' };
    }
    throw err;
  }
}

/** Patch label / group_key / excludes / sort_order of an active item. */
async function updateRentalOffering(pg, params = {}) {
  const slug = String(params.clientSlug || '').trim();
  const key = String(params.offering_key || '').trim();
  if (!slug || !key) return { ok: false, error: 'clientSlug and offering_key are required' };
  const v = validateRentalOfferingBody(params, 'rename');
  if (!v.ok) return v;
  const loc = normLoc(params.locationId);

  const sets = [];
  const vals = [];
  const push = (frag, val) => { vals.push(val); sets.push(frag.replace('$$', `$${vals.length}`)); };
  if (v.value.label !== undefined) push('label = $$', v.value.label);
  if (v.value.group_key !== undefined) push('group_key = $$', v.value.group_key);
  if (v.value.excludes !== undefined) push('excludes = $$::jsonb', JSON.stringify(v.value.excludes));
  if (v.value.sort_order !== undefined) push('sort_order = $$', v.value.sort_order);
  if (params.actorId !== undefined) push('updated_by = $$', params.actorId || null);
  if (!sets.length) return { ok: false, error: 'nothing to update' };

  vals.push(slug);
  const slugIdx = vals.length;
  vals.push(key);
  const keyIdx = vals.length;
  let locClause = 'location_id IS NULL';
  if (loc != null) { vals.push(loc); locClause = `location_id = $${vals.length}`; }

  const res = await pg.query(
    // MULTICLIENT_SCOPE_OK: client_slug + offering_key + location predicate
    `UPDATE tenant_rental_offerings
        SET ${sets.join(', ')}
      WHERE client_slug = $${slugIdx} AND offering_key = $${keyIdx} AND ${locClause} AND active = true
      RETURNING id, client_slug, location_id, offering_key, label, group_key, excludes, sort_order, active`,
    vals,
  );
  if (!res.rows.length) return { ok: false, error: 'rental item not found' };
  return { ok: true, offering: rowToOffering(res.rows[0]) };
}

/** Soft-delete (active=false) so history + prices are preserved. */
async function deleteRentalOffering(pg, params = {}) {
  const slug = String(params.clientSlug || '').trim();
  const key = String(params.offering_key || '').trim();
  if (!slug || !key) return { ok: false, error: 'clientSlug and offering_key are required' };
  const loc = normLoc(params.locationId);
  const vals = [slug, key, params.actorId || null];
  let locClause = 'location_id IS NULL';
  if (loc != null) { vals.push(loc); locClause = `location_id = $${vals.length}`; }
  const res = await pg.query(
    // MULTICLIENT_SCOPE_OK: client_slug + offering_key + location predicate
    `UPDATE tenant_rental_offerings
        SET active = false, updated_by = $3
      WHERE client_slug = $1 AND offering_key = $2 AND ${locClause} AND active = true
      RETURNING offering_key`,
    vals,
  );
  return { ok: res.rows.length > 0, deleted: res.rows.length > 0 };
}

/**
 * Idempotent seed/reconcile: bring the catalog for a client(+location) in line
 * with `rows` (from buildRentalOfferingRows). Creates missing items, updates
 * label/group/excludes/sort_order on existing ones. Never deletes — a school
 * that removed an item keeps that decision. Reuses the tested CRUD paths so it
 * needs no separate SQL. Returns a summary.
 */
async function seedRentalOfferings(pg, { clientSlug, locationId, rows, actorId = null } = {}) {
  const slug = String(clientSlug || '').trim();
  if (!slug) return { ok: false, error: 'clientSlug is required' };
  if (!Array.isArray(rows)) return { ok: false, error: 'rows must be an array' };
  const existing = await listRentalOfferings(pg, { clientSlug: slug, locationId, includeInactive: true });
  const byKey = new Map(existing.map((r) => [r.offering_key, r]));
  let created = 0;
  let updated = 0;
  for (const row of rows) {
    const key = String(row.offering_key || '').trim();
    if (!key) continue;
    const cur = byKey.get(key);
    if (!cur || cur.active === false) {
      // Recreate if it never existed. If a soft-deleted row exists, respect the
      // deletion (do not resurrect) unless it was never created at all.
      if (cur && cur.active === false) continue;
      const res = await createRentalOffering(pg, {
        clientSlug: slug, locationId, offering_key: key,
        label: row.label, group_key: row.group_key, excludes: row.excludes || [],
        sort_order: row.sort_order || 0, actorId,
      });
      if (res.ok) created += 1;
      continue;
    }
    const drift = cur.label !== row.label || cur.group_key !== row.group_key
      || JSON.stringify(cur.excludes || []) !== JSON.stringify((row.excludes || []).slice().sort())
      || cur.sort_order !== (row.sort_order || 0);
    if (drift) {
      const res = await updateRentalOffering(pg, {
        clientSlug: slug, locationId, offering_key: key,
        label: row.label, group_key: row.group_key, excludes: row.excludes || [],
        sort_order: row.sort_order || 0, actorId,
      });
      if (res.ok) updated += 1;
    }
  }
  return { ok: true, created, updated, total: rows.length };
}

/**
 * Pure mutual-exclusion resolver for the booking drawer. Given the offering_keys
 * a staff member has selected and the catalog rows, return which selections are
 * blocked by another selection's `excludes[]` (symmetric). Data replacement for
 * the hardcoded `if (key === 'board_and_suit_rental')` bundle logic.
 *
 * @returns {{ allowed:string[], blocked:Array<{key:string, excludedBy:string}> }}
 */
function applyRentalMutualExclusion(selectedKeys, offerings) {
  const selected = Array.isArray(selectedKeys) ? selectedKeys.map((k) => String(k || '').trim()).filter(Boolean) : [];
  const catalog = new Map((Array.isArray(offerings) ? offerings : []).map((o) => [o.offering_key, o]));
  const selectedSet = new Set(selected);
  const blocked = [];
  const blockedKeys = new Set();
  for (const key of selected) {
    const row = catalog.get(key);
    const excludes = row && Array.isArray(row.excludes) ? row.excludes : [];
    for (const ex of excludes) {
      if (selectedSet.has(ex)) {
        // Deterministic: the later-sorted key is the one reported blocked.
        const loser = [key, ex].sort()[1];
        if (!blockedKeys.has(loser)) { blocked.push({ key: loser, excludedBy: [key, ex].sort()[0] }); blockedKeys.add(loser); }
      }
    }
  }
  return { allowed: selected.filter((k) => !blockedKeys.has(k)), blocked };
}

module.exports = {
  OFFERING_KEY_RE,
  isValidOfferingKey,
  validateRentalOfferingBody,
  rowToOffering,
  listRentalOfferings,
  createRentalOffering,
  updateRentalOffering,
  deleteRentalOffering,
  seedRentalOfferings,
  applyRentalMutualExclusion,
};
