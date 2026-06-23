#!/usr/bin/env python3
"""Fix cfg/upsert price patch to map period_window to item_code."""
from pathlib import Path

ROOT = Path('/opt/wolfhouse/WH')
p = ROOT / 'scripts/lib/tenant-admin-writes.js'
s = p.read_text(encoding='utf-8')

HELPER = """
function preparePriceDbPatch(patch, offeringKey, currentUnit) {
  const out = { ...patch };
  const nextPeriod = out.period_window != null ? out.period_window : currentUnit;
  delete out.period_window;
  if (nextPeriod) {
    out.item_code = buildDbItemCode(offeringKey, nextPeriod);
    out.unit = mapBaselineUnitToDb(nextPeriod);
  }
  return out;
}
"""

if 'function preparePriceDbPatch' not in s:
    s = s.replace('async function upsertConfigPriceRule(client, {', HELPER + '\nasync function upsertConfigPriceRule(client, {', 1)

OLD_UPSERT = """async function upsertConfigPriceRule(client, {
  clientSlug, locationId, category, offeringKey, unit, patch, actor,
}) {
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_price_rules');
  const loc = normalizeSunsetLocationId(locationId);
  const itemType = mapCategoryToItemType(category);
  const itemCode = buildDbItemCode(offeringKey, unit);
  const dbUnit = mapBaselineUnitToDb(unit);

  await client.query('BEGIN');
  try {
    const existing = await findPriceRuleRow(client, {
      clientSlug, locationId: loc, itemType, itemCode, hasLoc,
    });
    let before = existing.rows[0] || null;
    let after;

    if (before) {
      const sets = [];
      const params = [];
      let idx = 3;
      for (const [key, value] of Object.entries(patch)) {
        sets.push(`${key} = $${idx}`);
        params.push(value);
        idx += 1;
      }"""

NEW_UPSERT = """async function upsertConfigPriceRule(client, {
  clientSlug, locationId, category, offeringKey, unit, patch, actor,
}) {
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_price_rules');
  const loc = normalizeSunsetLocationId(locationId);
  const itemType = mapCategoryToItemType(category);
  const effectiveUnit = patch.period_window != null ? patch.period_window : unit;
  const itemCode = buildDbItemCode(offeringKey, effectiveUnit);
  const dbUnit = mapBaselineUnitToDb(effectiveUnit);
  const dbPatch = preparePriceDbPatch(patch, offeringKey, effectiveUnit);

  await client.query('BEGIN');
  try {
    const existing = await findPriceRuleRow(client, {
      clientSlug, locationId: loc, itemType, itemCode, hasLoc,
    });
    let before = existing.rows[0] || null;
    let after;

    if (before) {
      const sets = [];
      const params = [];
      let idx = 3;
      for (const [key, value] of Object.entries(dbPatch)) {
        sets.push(`${key} = $${idx}`);
        params.push(value);
        idx += 1;
      }"""

if OLD_UPSERT in s:
    s = s.replace(OLD_UPSERT, NEW_UPSERT, 1)
    print('OK upsertConfigPriceRule')
else:
    print('SKIP upsertConfigPriceRule')

OLD_INSERT = """      const displayName = patch.display_name || `${offeringKey} (${unit})`;
      const amountCents = patch.amount_cents != null ? patch.amount_cents : 0;
      const currency = patch.currency || 'EUR';"""

NEW_INSERT = """      const displayName = dbPatch.display_name || `${offeringKey} (${effectiveUnit})`;
      const amountCents = dbPatch.amount_cents != null ? dbPatch.amount_cents : 0;
      const currency = dbPatch.currency || 'EUR';"""

if OLD_INSERT in s:
    s = s.replace(OLD_INSERT, NEW_INSERT, 1)
    print('OK insert vars')

p.write_text(s, encoding='utf-8')
print('DONE')
