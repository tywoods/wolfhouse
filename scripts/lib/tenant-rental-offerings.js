'use strict';

/**
 * Phase 2: data-access + CRUD for tenant_rental_offerings (migration 051) — the
 * single owner of rentable-item IDENTITY (offering_key), display (label), UI
 * grouping (group_key). Every Admin-created offering is independent by exact
 * offering_key — no future mutual-exclusion / bundle inference.
 *
 * Money is NOT here: price-per-period lives in tenant_price_rules keyed by the
 * `offering_key__period_window` item_code (see tenant-admin-writes price CRUD).
 * A "rental item" the staff panel creates = one row here + one price row per
 * rentable period.
 *
 * `excludes` column remains for historical read compatibility only. Future
 * create/update reject nonempty excludes (`rental_excludes_not_supported`).
 * Existing DB excludes must not affect selection/quote/write.
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
// Physical stock (migration 055): integer units 0..999; null = unconfigured.
const STOCK_MIN = 0;
const STOCK_MAX = 999;

function isValidStockQuantity(value) {
  return Number.isInteger(value) && value >= STOCK_MIN && value <= STOCK_MAX;
}

function isValidOfferingKey(key) {
  const k = String(key || '').trim();
  return k.length > 0 && k.length <= MAX_OFFERING_KEY && !k.includes('__') && OFFERING_KEY_RE.test(k);
}

function normLoc(locationId) {
  return locationId == null ? null : String(locationId).trim() || null;
}

/**
 * Normalize a rental display name for uniqueness comparison.
 * Unicode-safe trim, collapse internal whitespace, locale-independent lower case.
 * " Surfboard  + Wetsuit " → "surfboard + wetsuit"
 */
function normalizeRentalDisplayName(label) {
  return String(label == null ? '' : label)
    .replace(/^\s+|\s+$/gu, '')
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

/** Collapse whitespace for storage (preserve case). */
function collapseRentalLabelWhitespace(label) {
  return String(label == null ? '' : label)
    .replace(/^\s+|\s+$/gu, '')
    .replace(/\s+/gu, ' ');
}

/**
 * Transaction-scoped advisory lock + existence check for normalized display names.
 * Locks exact client + location + normalized label so concurrent creates cannot race.
 * Includes inactive rows (disabled identities still reserve the name).
 * @returns {{ ok:true } | { ok:false, error:'rental_name_already_exists' }}
 */
async function assertRentalDisplayNameAvailable(pg, {
  clientSlug, locationId, label, excludeOfferingKey = null,
} = {}) {
  const slug = String(clientSlug || '').trim();
  const loc = normLoc(locationId);
  const normalized = normalizeRentalDisplayName(label);
  if (!slug || !normalized) return { ok: true };

  const lockKey = `rental-name:${slug}:${loc == null ? '' : loc}:${normalized}`;
  // MULTICLIENT_SCOPE_OK: advisory lock keyed by client slug + scoped name
  await pg.query(
    'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    [slug, lockKey],
  );

  const params = [slug];
  let locClause = 'location_id IS NULL';
  if (loc != null) {
    params.push(loc);
    locClause = `location_id = $${params.length}`;
  }
  params.push(normalized);
  const normIdx = params.length;
  let excludeClause = '';
  if (excludeOfferingKey) {
    params.push(String(excludeOfferingKey).trim());
    excludeClause = ` AND offering_key <> $${params.length}`;
  }

  // PostgreSQL lower + regexp_replace mirrors normalizeRentalDisplayName.
  // Active and inactive both reserve the name; hard-deleted rows are gone.
  const res = await pg.query(
    // MULTICLIENT_SCOPE_OK: client_slug + exact location + normalized label
    `SELECT id, offering_key, label, active
       FROM tenant_rental_offerings
      WHERE client_slug = $1
        AND ${locClause}
        AND lower(regexp_replace(btrim(label), '[[:space:]]+', ' ', 'g')) = $${normIdx}
        ${excludeClause}
      LIMIT 1`,
    params,
  );
  if (res.rows.length) {
    return { ok: false, error: 'rental_name_already_exists' };
  }
  return { ok: true };
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

  const label = collapseRentalLabelWhitespace(b.label == null ? '' : b.label);
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
    // Future contract: excludes are not supported. Omit/empty → []. Nonempty fail-closed.
    const raw = b.excludes === undefined ? [] : b.excludes;
    if (!Array.isArray(raw)) {
      return { ok: false, error: 'rental_excludes_not_supported', reason: 'rental_excludes_not_supported' };
    }
    if (raw.length > 0) {
      return {
        ok: false,
        error: 'rental_excludes_not_supported',
        reason: 'rental_excludes_not_supported',
      };
    }
    excludes = [];
  }

  let sortOrder;
  if (b.sort_order !== undefined) {
    sortOrder = Number(b.sort_order);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      return { ok: false, error: 'sort_order must be a non-negative integer' };
    }
  }

  // stock_quantity: optional on create; patchable on rename/update.
  // null/omitted on create → unconfigured. Explicit null on patch clears config.
  let stockQuantity;
  let hasStock = false;
  if (Object.prototype.hasOwnProperty.call(b, 'stock_quantity')) {
    hasStock = true;
    if (b.stock_quantity === null) {
      stockQuantity = null;
    } else if (!isValidStockQuantity(b.stock_quantity)) {
      return {
        ok: false,
        error: `stock_quantity must be an integer ${STOCK_MIN}..${STOCK_MAX} or null`,
      };
    } else {
      stockQuantity = b.stock_quantity;
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
      ...(hasStock ? { stock_quantity: stockQuantity } : {}),
    },
  };
}

function rowToOffering(row) {
  if (!row) return null;
  let excludes = row.excludes;
  if (typeof excludes === 'string') {
    try { excludes = JSON.parse(excludes); } catch (_) { excludes = []; }
  }
  let stockQuantity = null;
  if (row.stock_quantity !== undefined && row.stock_quantity !== null) {
    const n = Number(row.stock_quantity);
    stockQuantity = Number.isInteger(n) ? n : null;
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
    stock_quantity: stockQuantity,
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
    `SELECT id, client_slug, location_id, offering_key, label, group_key, excludes, sort_order, stock_quantity, active
       FROM tenant_rental_offerings
      WHERE ${where.join(' AND ')}
      ORDER BY sort_order ASC, offering_key ASC`,
    params,
  );
  return res.rows.map(rowToOffering);
}

/**
 * Create a rental item.
 * Owns BEGIN/COMMIT/ROLLBACK so pg_advisory_xact_lock is race-safe.
 * Callers (API, seed/reconcile) must NOT wrap this in an outer transaction.
 * Fails on duplicate active offering_key (unique index) or normalized display name.
 */
async function createRentalOffering(pg, params = {}) {
  const slug = String(params.clientSlug || '').trim();
  if (!slug) return { ok: false, error: 'clientSlug is required' };
  const v = validateRentalOfferingBody(params, 'create');
  if (!v.ok) return v;
  const loc = normLoc(params.locationId);

  await pg.query('BEGIN');
  try {
    const nameOk = await assertRentalDisplayNameAvailable(pg, {
      clientSlug: slug,
      locationId: loc,
      label: v.value.label,
    });
    if (!nameOk.ok) {
      await pg.query('ROLLBACK');
      return nameOk;
    }

    const stockQty = Object.prototype.hasOwnProperty.call(v.value, 'stock_quantity')
      ? v.value.stock_quantity
      : null;
    const res = await pg.query(
      // MULTICLIENT_SCOPE_OK: explicit client_slug column on insert
      `INSERT INTO tenant_rental_offerings
         (client_slug, location_id, offering_key, label, group_key, excludes, sort_order, stock_quantity, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       RETURNING id, client_slug, location_id, offering_key, label, group_key, excludes, sort_order, stock_quantity, active`,
      [slug, loc, v.value.offering_key, v.value.label, v.value.group_key,
        JSON.stringify(v.value.excludes || []), v.value.sort_order || 0, stockQty, params.actorId || null],
    );
    await pg.query('COMMIT');
    return { ok: true, offering: rowToOffering(res.rows[0]) };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
    if (/duplicate key|uq_tenant_rental_offerings_active/i.test(String(err && err.message))) {
      return { ok: false, error: 'a rental item with this offering_key already exists' };
    }
    throw err;
  }
}

/**
 * Patch label / group_key / excludes / sort_order of an active item.
 * Owns BEGIN/COMMIT/ROLLBACK when label changes so name uniqueness is race-safe.
 * Callers must NOT wrap this in an outer transaction.
 */
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
  if (Object.prototype.hasOwnProperty.call(v.value, 'stock_quantity')) {
    push('stock_quantity = $$', v.value.stock_quantity);
  }
  if (params.actorId !== undefined) push('updated_by = $$', params.actorId || null);
  if (!sets.length) return { ok: false, error: 'nothing to update' };

  const needsNameLock = v.value.label !== undefined;
  if (needsNameLock) await pg.query('BEGIN');
  try {
    if (needsNameLock) {
      const nameOk = await assertRentalDisplayNameAvailable(pg, {
        clientSlug: slug,
        locationId: loc,
        label: v.value.label,
        excludeOfferingKey: key,
      });
      if (!nameOk.ok) {
        await pg.query('ROLLBACK');
        return nameOk;
      }
    }

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
        RETURNING id, client_slug, location_id, offering_key, label, group_key, excludes, sort_order, stock_quantity, active`,
      vals,
    );
    if (!res.rows.length) {
      if (needsNameLock) await pg.query('ROLLBACK');
      return { ok: false, error: 'rental item not found' };
    }
    if (needsNameLock) await pg.query('COMMIT');
    return { ok: true, offering: rowToOffering(res.rows[0]) };
  } catch (err) {
    if (needsNameLock) {
      try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
    }
    throw err;
  }
}

/**
 * Fail closed when hard-delete cannot be authoritative (required tables absent).
 * Does not fall back to config-memory soft-disable.
 */
async function assertHardDeleteTablesReady(pg) {
  const needed = [
    'tenant_rental_offerings',
    'tenant_price_rules',
    'tenant_surf_pack_rules',
    'tenant_private_lesson_rules',
  ];
  for (const table of needed) {
    // MULTICLIENT_SCOPE_OK: catalog existence probe, no tenant data
    const reg = await pg.query('SELECT to_regclass($1) AS reg', [`public.${table}`]);
    if (!reg.rows[0] || !reg.rows[0].reg) {
      return { ok: false, error: 'admin_db_tables_missing', message: `required table missing: ${table}` };
    }
  }
  return { ok: true };
}

async function tableHasLocationColumn(pg, tableName) {
  // MULTICLIENT_SCOPE_OK: schema probe only
  const res = await pg.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'location_id'
      LIMIT 1`,
    [tableName],
  );
  return res.rows.length > 0;
}

function locPredicateSql(hasLocCol, loc, paramStart) {
  if (!hasLocCol) return { clause: 'TRUE', params: [] };
  if (loc == null) return { clause: 'location_id IS NULL', params: [] };
  return { clause: `location_id = $${paramStart}`, params: [loc] };
}

function stripEquipmentOptionKey(configJson, offeringKey) {
  let cfg = configJson;
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg); } catch (_) { cfg = {}; }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  const before = Array.isArray(cfg.equipment_options) ? cfg.equipment_options : [];
  const after = before.filter((row) => {
    if (!row || typeof row !== 'object') return true;
    return String(row.offering_key || '').trim() !== offeringKey;
  });
  if (after.length === before.length) return { changed: false, config: cfg };
  return { changed: true, config: { ...cfg, equipment_options: after } };
}

/**
 * TRUE transactional hard delete for one client+location+offering identity.
 *
 * In ONE transaction: lock scoped offering row(s) → hard-delete matching rental
 * price rows (active+inactive, exact split_part ownership, never LIKE) → strip
 * the key from Group (surf pack) + Private course equipment_options → delete
 * all exact scoped offering identities (active or inactive) → audit price
 * removals. Booking rows / historical booking snapshots are never touched.
 *
 * Idempotent: when the identity is already gone, returns success with noop
 * zero counts rather than 404.
 *
 * Fail closed when required tables are missing — never soft-disable as a fallback.
 */
async function deleteRentalOffering(pg, params = {}) {
  const slug = String(params.clientSlug || '').trim();
  const key = String(params.offering_key || params.offeringKey || '').trim();
  if (!slug || !key) return { ok: false, error: 'clientSlug and offering_key are required' };
  if (!isValidOfferingKey(key)) return { ok: false, error: 'invalid offering_key' };
  const loc = normLoc(params.locationId);
  const actor = params.actor || {
    staff_user_id: params.actorId || null,
    email: params.actorEmail || 'unknown',
  };

  const ready = await assertHardDeleteTablesReady(pg);
  if (!ready.ok) return ready;

  const priceHasLoc = await tableHasLocationColumn(pg, 'tenant_price_rules');
  const offeringHasLoc = await tableHasLocationColumn(pg, 'tenant_rental_offerings');
  const packHasLoc = await tableHasLocationColumn(pg, 'tenant_surf_pack_rules');
  const privateHasLoc = await tableHasLocationColumn(pg, 'tenant_private_lesson_rules');
  const auditExists = await (async () => {
    const reg = await pg.query("SELECT to_regclass('public.tenant_config_audit_log') AS reg");
    return !!(reg.rows[0] && reg.rows[0].reg);
  })();

  const emptyCounts = {
    offerings_deleted: 0,
    prices_deleted: 0,
    surf_packs_updated: 0,
    private_lessons_updated: 0,
  };

  await pg.query('BEGIN');
  try {
    // 1) Lock + verify exact scoped identity (active or inactive; all historical dups).
    const offLoc = locPredicateSql(offeringHasLoc, loc, 3);
    const lockParams = [slug, key, ...offLoc.params];
    const locked = await pg.query(
      // MULTICLIENT_SCOPE_OK: client_slug + offering_key + exact location
      `SELECT * FROM tenant_rental_offerings
        WHERE client_slug = $1 AND offering_key = $2 AND ${offLoc.clause}
        FOR UPDATE`,
      lockParams,
    );

    if (!locked.rows.length) {
      await pg.query('COMMIT');
      return {
        ok: true,
        deleted: false,
        noop: true,
        offering_key: key,
        ...emptyCounts,
      };
    }

    const tenantId = locked.rows[0].tenant_id || 'sunset';
    const offeringSnapshot = locked.rows.map((r) => rowToOffering(r));

    // 2) Hard-delete all rental price rows owned by this exact key (active+inactive).
    // Exact ownership: split_part(item_code,'__',1) = key (legacy bare key included).
    // NEVER unescaped LIKE — `_` is a one-char wildcard (soft_board vs softxboard).
    const priceLoc = locPredicateSql(priceHasLoc, loc, 3);
    const priceParams = [slug, key, ...priceLoc.params];
    const priceDel = await pg.query(
      // MULTICLIENT_SCOPE_OK: client + location + item_type + exact offering ownership
      `DELETE FROM tenant_price_rules
        WHERE client_slug = $1
          AND item_type = 'rental'
          AND split_part(item_code, '__', 1) = $2
          AND ${priceLoc.clause}
        RETURNING *`,
      priceParams,
    );
    const deletedPrices = priceDel.rows || [];

    // 3) Strip offering_key from every scoped surf-pack equipment_options (active+inactive).
    const packLoc = locPredicateSql(packHasLoc, loc, 2);
    const packs = await pg.query(
      // MULTICLIENT_SCOPE_OK: client + exact location, any active state
      `SELECT id, tenant_id, client_slug, location_id, config_json, active
         FROM tenant_surf_pack_rules
        WHERE client_slug = $1 AND ${packLoc.clause}
        FOR UPDATE`,
      [slug, ...packLoc.params],
    );
    let surfPacksUpdated = 0;
    for (const pack of packs.rows) {
      const stripped = stripEquipmentOptionKey(pack.config_json, key);
      if (!stripped.changed) continue;
      await pg.query(
        // MULTICLIENT_SCOPE_OK: id-targeted after scoped lock
        `UPDATE tenant_surf_pack_rules
            SET config_json = $2::jsonb, updated_by = $3::uuid
          WHERE id = $1::uuid`,
        [pack.id, JSON.stringify(stripped.config), actor.staff_user_id || null],
      );
      surfPacksUpdated += 1;
    }

    // 4) Strip from private-lesson equipment_options (active+inactive).
    const privLoc = locPredicateSql(privateHasLoc, loc, 2);
    const privRows = await pg.query(
      // MULTICLIENT_SCOPE_OK: client + exact location, any active state
      `SELECT id, tenant_id, client_slug, location_id, config_json, active
         FROM tenant_private_lesson_rules
        WHERE client_slug = $1 AND ${privLoc.clause}
        FOR UPDATE`,
      [slug, ...privLoc.params],
    );
    let privateLessonsUpdated = 0;
    for (const pl of privRows.rows) {
      const stripped = stripEquipmentOptionKey(pl.config_json, key);
      if (!stripped.changed) continue;
      await pg.query(
        // MULTICLIENT_SCOPE_OK: id-targeted after scoped lock
        `UPDATE tenant_private_lesson_rules
            SET config_json = $2::jsonb, updated_by = $3::uuid
          WHERE id = $1::uuid`,
        [pl.id, JSON.stringify(stripped.config), actor.staff_user_id || null],
      );
      privateLessonsUpdated += 1;
    }

    // 5) Delete exact scoped offering identity rows (all active/inactive dups).
    const delOff = await pg.query(
      // MULTICLIENT_SCOPE_OK: client_slug + offering_key + exact location
      `DELETE FROM tenant_rental_offerings
        WHERE client_slug = $1 AND offering_key = $2 AND ${offLoc.clause}
        RETURNING id, offering_key, active`,
      lockParams,
    );
    const offeringsDeleted = (delOff.rows || []).length;

    // 6) Audit deleted prices (entity_type constrained to price_rule; offering summary
    // is returned to the API layer for appendAuditLog accountability).
    if (auditExists) {
      for (const price of deletedPrices) {
        await pg.query(
          `INSERT INTO tenant_config_audit_log (
             tenant_id, client_slug, actor_user_id, actor_email, action,
             entity_type, entity_id, before_json, after_json
           ) VALUES ($1, $2, $3::uuid, $4, 'deactivate', 'price_rule', $5::uuid, $6::jsonb, $7::jsonb)`,
          [
            price.tenant_id || tenantId,
            slug,
            actor.staff_user_id || null,
            actor.email || 'unknown',
            price.id,
            JSON.stringify(price),
            JSON.stringify({
              hard_deleted: true,
              reason: 'rental_offering_hard_delete',
              offering_key: key,
            }),
          ],
        );
      }
    }

    await pg.query('COMMIT');
    return {
      ok: true,
      deleted: true,
      noop: false,
      offering_key: key,
      offerings_deleted: offeringsDeleted,
      prices_deleted: deletedPrices.length,
      surf_packs_updated: surfPacksUpdated,
      private_lessons_updated: privateLessonsUpdated,
      // Sanitized identity snapshot for operator audit (not full row dumps in response).
      audit_summary: {
        offering_key: key,
        client_slug: slug,
        location_id: loc,
        offerings: offeringSnapshot.map((o) => ({
          id: o.id,
          offering_key: o.offering_key,
          label: o.label,
          active: o.active,
        })),
        prices_deleted: deletedPrices.length,
        price_ids: deletedPrices.map((p) => p.id).filter(Boolean),
        surf_packs_updated: surfPacksUpdated,
        private_lessons_updated: privateLessonsUpdated,
      },
    };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }
}

/**
 * Server-authoritative enable/disable for a rental offering identity.
 * Soft-disables preserve the exact row (key/label/prices/history). Re-enable
 * updates that same inactive row — never inserts a duplicate.
 * `active` must be a strict boolean (not "true"/1/null).
 * Idempotent: already-desired state returns ok with the current row.
 */
async function setRentalOfferingActive(pg, params = {}) {
  const slug = String(params.clientSlug || '').trim();
  const key = String(params.offering_key || params.offeringKey || '').trim();
  if (!slug || !key) return { ok: false, error: 'clientSlug and offering_key are required' };
  if (params.active !== true && params.active !== false) {
    return { ok: false, error: 'active must be a boolean' };
  }
  const wantActive = params.active;
  const loc = normLoc(params.locationId);
  const findVals = [slug, key];
  let locClause = 'location_id IS NULL';
  if (loc != null) {
    findVals.push(loc);
    locClause = `location_id = $${findVals.length}`;
  }

  const found = await pg.query(
    // MULTICLIENT_SCOPE_OK: client_slug + offering_key + location (any active state)
    `SELECT id, client_slug, location_id, offering_key, label, group_key, excludes, sort_order, stock_quantity, active
       FROM tenant_rental_offerings
      WHERE client_slug = $1 AND offering_key = $2 AND ${locClause}
      ORDER BY active DESC, updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1`,
    findVals,
  );
  if (!found.rows.length) return { ok: false, error: 'rental item not found' };
  const current = found.rows[0];
  if (current.active === wantActive) {
    return { ok: true, offering: rowToOffering(current), unchanged: true };
  }

  const res = await pg.query(
    // MULTICLIENT_SCOPE_OK: id-targeted flip after scoped lookup
    `UPDATE tenant_rental_offerings
        SET active = $1, updated_by = $2
      WHERE id = $3
      RETURNING id, client_slug, location_id, offering_key, label, group_key, excludes, sort_order, stock_quantity, active`,
    [wantActive, params.actorId || null, current.id],
  );
  if (!res.rows.length) return { ok: false, error: 'rental item not found' };
  return { ok: true, offering: rowToOffering(res.rows[0]), unchanged: false };
}

/**
 * Idempotent seed/reconcile: bring the catalog for a client(+location) in line
 * with `rows` (from buildRentalOfferingRows). Creates missing items, updates
 * label/group/sort_order, and clears legacy excludes to [] prospectively.
 * Never rewrites booking history. Never deletes — a school that removed an
 * item keeps that decision. Reuses the tested CRUD paths so it needs no
 * separate SQL. Returns a summary.
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
    // Prospective seed always writes empty excludes (independent offerings).
    const seedExcludes = [];
    const cur = byKey.get(key);
    if (!cur || cur.active === false) {
      // Recreate if it never existed. If a soft-deleted row exists, respect the
      // deletion (do not resurrect) unless it was never created at all.
      if (cur && cur.active === false) continue;
      const res = await createRentalOffering(pg, {
        clientSlug: slug, locationId, offering_key: key,
        label: row.label, group_key: row.group_key, excludes: seedExcludes,
        sort_order: row.sort_order || 0, actorId,
      });
      if (res.ok) created += 1;
      continue;
    }
    const legacyExcludes = Array.isArray(cur.excludes) ? cur.excludes : [];
    const drift = cur.label !== row.label || cur.group_key !== row.group_key
      || legacyExcludes.length > 0
      || cur.sort_order !== (row.sort_order || 0);
    if (drift) {
      const res = await updateRentalOffering(pg, {
        clientSlug: slug, locationId, offering_key: key,
        label: row.label, group_key: row.group_key, excludes: seedExcludes,
        sort_order: row.sort_order || 0, actorId,
      });
      if (res.ok) updated += 1;
    }
  }
  return { ok: true, created, updated, total: rows.length };
}

/**
 * Historical compatibility shim. Future selection never applies excludes —
 * every offering is independent. Existing DB excludes are ignored so they
 * cannot affect quote/create/write.
 *
 * @returns {{ allowed:string[], blocked:Array }}
 */
function applyRentalMutualExclusion(selectedKeys, _offerings) {
  const selected = Array.isArray(selectedKeys)
    ? selectedKeys.map((k) => String(k || '').trim()).filter(Boolean)
    : [];
  return { allowed: selected, blocked: [] };
}

module.exports = {
  OFFERING_KEY_RE,
  STOCK_MIN,
  STOCK_MAX,
  isValidOfferingKey,
  isValidStockQuantity,
  normalizeRentalDisplayName,
  collapseRentalLabelWhitespace,
  validateRentalOfferingBody,
  rowToOffering,
  listRentalOfferings,
  createRentalOffering,
  updateRentalOffering,
  deleteRentalOffering,
  setRentalOfferingActive,
  seedRentalOfferings,
  applyRentalMutualExclusion,
  assertRentalDisplayNameAvailable,
};
