#!/usr/bin/env python3
"""Add Sunset Admin rental price category CRUD (add/edit/remove by rental type)."""
from pathlib import Path

ROOT = Path('/opt/wolfhouse/WH')
WRITES = ROOT / 'scripts/lib/tenant-admin-writes.js'
API = ROOT / 'scripts/staff-query-api.js'
I18N = ROOT / 'scripts/lib/staff-portal-i18n.js'
I18N_ES = ROOT / 'scripts/lib/staff-portal-i18n-es-sunset.js'

# ── tenant-admin-writes.js ────────────────────────────────────────────────────

writes = WRITES.read_text()

if 'function validatePriceCreateBody' not in writes:
    insert_after = "const LESSON_TIME_PATCH_FIELDS = new Set(["
    rental_constants = """const RENTAL_GROUP_KEYS = new Set(['bundles', 'boards', 'wetsuits', 'sup']);
const RENTAL_GROUP_OFFERING = {
  bundles: 'board_and_suit_rental',
  boards: 'board_rental',
  wetsuits: 'wetsuit_rental',
  sup: 'sup_rental',
};
const RENTAL_GROUP_DISPLAY = {
  bundles: 'Surfboard + Wetsuit',
  boards: 'Surfboard',
  wetsuits: 'Wetsuit',
  sup: 'SUP',
};
const RENTAL_PERIOD_WINDOWS = new Set(['1_hour', 'half_day', '1_day', '2_days', '5_days', '7_days']);

"""
    if insert_after not in writes:
        raise SystemExit('LESSON_TIME_PATCH_FIELDS anchor missing in tenant-admin-writes.js')
    writes = writes.replace(insert_after, rental_constants + insert_after, 1)

    price_patch_old = "const PRICE_PATCH_FIELDS = new Set([\n  'display_name',\n  'amount_cents',\n  'currency',\n  'unit',\n  'active',\n  'effective_from',\n  'effective_to',\n]);"
    price_patch_new = "const PRICE_PATCH_FIELDS = new Set([\n  'display_name',\n  'amount_cents',\n  'currency',\n  'unit',\n  'period_window',\n  'active',\n  'effective_from',\n  'effective_to',\n]);"
    if price_patch_old not in writes:
        raise SystemExit('PRICE_PATCH_FIELDS block missing')
    writes = writes.replace(price_patch_old, price_patch_new, 1)

    validate_create_fn = """
function parseItemCodeParts(itemCode) {
  const text = String(itemCode || '').trim();
  const parts = text.split('__');
  if (parts.length >= 2) {
    return { offering_key: parts[0], period_window: parts.slice(1).join('__') };
  }
  return { offering_key: text, period_window: null };
}

function resolveRentalGroupOffering(rentalGroup) {
  const key = String(rentalGroup || '').trim();
  if (!RENTAL_GROUP_KEYS.has(key)) return { ok: false, error: 'invalid rental_group' };
  return { ok: true, rental_group: key, offering_key: RENTAL_GROUP_OFFERING[key] };
}

function validatePriceCreateBody(body) {
  const allowed = new Set(['rental_group', 'period_window', 'amount_cents', 'currency']);
  const unknown = rejectUnknownFields(body, allowed);
  if (!unknown.ok) return unknown;
  const group = resolveRentalGroupOffering(body.rental_group);
  if (!group.ok) return group;
  const period = String(body.period_window || '').trim();
  if (!RENTAL_PERIOD_WINDOWS.has(period)) return { ok: false, error: 'invalid period_window' };
  const n = Number(body.amount_cents);
  if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'amount_cents must be integer >= 0' };
  const currency = body.currency != null ? String(body.currency).trim().toUpperCase() : 'EUR';
  if (body.currency != null && !CURRENCY_RE.test(currency)) return { ok: false, error: 'currency must be 3-letter code' };
  return {
    ok: true,
    patch: {
      rental_group: group.rental_group,
      offering_key: group.offering_key,
      period_window: period,
      amount_cents: n,
      currency,
    },
  };
}

"""
    anchor = "function validatePricePatchBody(body) {"
    if anchor not in writes:
        raise SystemExit('validatePricePatchBody anchor missing')
    writes = writes.replace(anchor, validate_create_fn + anchor, 1)

    period_patch = """  if (body.period_window != null) {
    const period = String(body.period_window).trim();
    if (!RENTAL_PERIOD_WINDOWS.has(period)) return { ok: false, error: 'invalid period_window' };
    out.period_window = period;
  }
"""
    unit_patch_anchor = "  if (body.unit != null) {\n    const unit = String(body.unit).trim().toLowerCase();\n    if (!UNIT_VALUES.has(unit)) return { ok: false, error: 'invalid unit' };\n    out.unit = unit;\n  }"
    if unit_patch_anchor not in writes:
        raise SystemExit('unit patch anchor missing')
    writes = writes.replace(unit_patch_anchor, period_patch + unit_patch_anchor, 1)

    patch_price_extend = """
async function applyPricePatchFields(client, before, patch, actor) {
  const parsed = parseItemCodeParts(before.item_code);
  const offeringKey = parsed.offering_key;
  const nextPeriod = patch.period_window != null ? patch.period_window : parsed.period_window;
  const nextItemCode = nextPeriod ? buildDbItemCode(offeringKey, nextPeriod) : before.item_code;
  const nextUnit = nextPeriod ? mapBaselineUnitToDb(nextPeriod) : before.unit;
  const nextDisplay = patch.display_name != null
    ? patch.display_name
    : (Object.values(RENTAL_GROUP_OFFERING).includes(offeringKey)
      ? (RENTAL_GROUP_DISPLAY[Object.keys(RENTAL_GROUP_OFFERING).find((k) => RENTAL_GROUP_OFFERING[k] === offeringKey)] || before.display_name)
      : before.display_name);

  const dbPatch = { ...patch };
  delete dbPatch.period_window;
  dbPatch.item_code = nextItemCode;
  dbPatch.unit = nextUnit;
  dbPatch.display_name = nextDisplay;
  return dbPatch;
}

async function createRentalPriceRule(client, { clientSlug, locationId, patch, actor }) {
  const tablesExist = await adminConfigTablesExist(client);
  if (!tablesExist) {
    return { ok: false, status: 503, body: { success: false, error: 'admin_db_tables_missing' } };
  }
  const loc = normalizeSunsetLocationId(locationId);
  const itemType = 'rental';
  const itemCode = buildDbItemCode(patch.offering_key, patch.period_window);
  const dbUnit = mapBaselineUnitToDb(patch.period_window);
  const displayName = RENTAL_GROUP_DISPLAY[patch.rental_group] || patch.offering_key;
  return upsertConfigPriceRule(client, {
    clientSlug,
    locationId: loc,
    category: 'rental',
    offeringKey: patch.offering_key,
    unit: patch.period_window,
    patch: {
      display_name: displayName,
      amount_cents: patch.amount_cents,
      currency: patch.currency || 'EUR',
      unit: dbUnit,
      item_code: itemCode,
    },
    actor,
    forceItemCode: itemCode,
    forceDbUnit: dbUnit,
  });
}

async function deactivatePriceRule(client, { ruleId, clientSlug, locationId, actor }) {
  const tablesExist = await adminConfigTablesExist(client);
  const loc = normalizeSunsetLocationId(locationId);
  if (!tablesExist) {
    return { ok: false, status: 503, body: { success: false, error: 'admin_db_tables_missing' } };
  }
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_price_rules');
  await client.query('BEGIN');
  try {
    const existing = await client.query(
      hasLoc
        ? `SELECT * FROM tenant_price_rules WHERE id = $1::uuid AND client_slug = $2 AND location_id = $3 AND active = true FOR UPDATE`
        : `SELECT * FROM tenant_price_rules WHERE id = $1::uuid AND client_slug = $2 AND active = true FOR UPDATE`,
      hasLoc ? [ruleId, clientSlug, loc] : [ruleId, clientSlug],
    );
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, body: { success: false, error: 'not_found' } };
    }
    const before = existing.rows[0];
    const updated = await client.query(
      `UPDATE tenant_price_rules SET active = false, updated_at = NOW(), updated_by = $3::uuid
         WHERE id = $1::uuid AND client_slug = $2 RETURNING *`,
      [ruleId, clientSlug, actor.staff_user_id || null],
    );
    const after = updated.rows[0];
    await insertConfigAudit(client, {
      tenantId: before.tenant_id,
      clientSlug,
      actor,
      action: 'deactivate',
      entityType: 'price_rule',
      entityId: ruleId,
      beforeJson: rowToAuditJson(before),
      afterJson: rowToAuditJson(after),
    });
    await client.query('COMMIT');
    return { ok: true, status: 200, body: { success: true, price_rule: after, storage: 'db' } };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

"""
    upsert_anchor = "async function upsertConfigPriceRule(client, {"
    if upsert_anchor not in writes:
        raise SystemExit('upsertConfigPriceRule anchor missing')
    writes = writes.replace(upsert_anchor, patch_price_extend + upsert_anchor, 1)

    # Extend upsertConfigPriceRule signature to accept forceItemCode
    old_upsert_sig = "async function upsertConfigPriceRule(client, {\n  clientSlug, locationId, category, offeringKey, unit, patch, actor,\n}) {"
    new_upsert_sig = "async function upsertConfigPriceRule(client, {\n  clientSlug, locationId, category, offeringKey, unit, patch, actor, forceItemCode, forceDbUnit,\n}) {"
    if old_upsert_sig not in writes:
        raise SystemExit('upsertConfigPriceRule signature missing')
    writes = writes.replace(old_upsert_sig, new_upsert_sig, 1)

    old_item_code = "  const itemCode = buildDbItemCode(offeringKey, unit);\n  const dbUnit = mapBaselineUnitToDb(unit);"
    new_item_code = "  const itemCode = forceItemCode || buildDbItemCode(offeringKey, unit);\n  const dbUnit = forceDbUnit || mapBaselineUnitToDb(unit);"
    if old_item_code not in writes:
        raise SystemExit('itemCode lines missing in upsert')
    writes = writes.replace(old_item_code, new_item_code, 1)

    # patchPriceRule DB branch: apply period_window via applyPricePatchFields
    old_patch_loop = """    for (const [key, value] of Object.entries(patch)) {
      sets.push(`${key} = $${idx}`);
      params.push(value);
      idx += 1;
    }
    sets.push('updated_at = NOW()');
    sets.push(`updated_by = $${idx}::uuid`);
    params.push(actor.staff_user_id || null);

    const updated = await client.query(
      `UPDATE tenant_price_rules SET ${sets.join(', ')}
        WHERE id = $1::uuid AND client_slug = $2
        RETURNING *`,
      [ruleId, clientSlug, ...params],
    );
    const after = updated.rows[0];"""
    new_patch_loop = """    const dbPatch = await applyPricePatchFields(client, before, patch, actor);
    for (const [key, value] of Object.entries(dbPatch)) {
      sets.push(`${key} = $${idx}`);
      params.push(value);
      idx += 1;
    }
    sets.push('updated_at = NOW()');
    sets.push(`updated_by = $${idx}::uuid`);
    params.push(actor.staff_user_id || null);

    const updated = await client.query(
      `UPDATE tenant_price_rules SET ${sets.join(', ')}
        WHERE id = $1::uuid AND client_slug = $2
        RETURNING *`,
      [ruleId, clientSlug, ...params],
    );
    const after = updated.rows[0];"""
    if old_patch_loop not in writes:
        raise SystemExit('patchPriceRule update loop missing')
    writes = writes.replace(old_patch_loop, new_patch_loop, 1)

    exports_old = """  patchPriceRule,
  putLessonCapacityDefault,
  createLessonTimeRule,"""
    exports_new = """  validatePriceCreateBody,
  createRentalPriceRule,
  deactivatePriceRule,
  parseItemCodeParts,
  patchPriceRule,
  putLessonCapacityDefault,
  createLessonTimeRule,"""
    if exports_old not in writes:
        raise SystemExit('module.exports block missing')
    writes = writes.replace(exports_old, exports_new, 1)

    WRITES.write_text(writes)
    print('OK tenant-admin-writes.js')
else:
    print('SKIP tenant-admin-writes.js (already patched)')

# Fix createRentalPriceRule - upsertConfigPriceRule doesn't accept item_code in patch for insert
writes = WRITES.read_text()
create_old = """    patch: {
      display_name: displayName,
      amount_cents: patch.amount_cents,
      currency: patch.currency || 'EUR',
      unit: dbUnit,
      item_code: itemCode,
    },"""
create_new = """    patch: {
      display_name: displayName,
      amount_cents: patch.amount_cents,
      currency: patch.currency || 'EUR',
    },"""
if create_old in writes:
    writes = writes.replace(create_old, create_new, 1)
    WRITES.write_text(writes)

print('tenant-admin-writes.js done')
