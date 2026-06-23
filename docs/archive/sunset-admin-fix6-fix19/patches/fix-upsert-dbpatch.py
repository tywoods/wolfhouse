#!/usr/bin/env python3
from pathlib import Path
p = Path('/opt/wolfhouse/WH/scripts/lib/tenant-admin-writes.js')
s = p.read_text(encoding='utf-8')

old = """async function upsertConfigPriceRule(client, {
  clientSlug, locationId, category, offeringKey, unit, patch, actor, forceItemCode, forceDbUnit,
}) {
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_price_rules');
  const loc = normalizeSunsetLocationId(locationId);
  const itemType = mapCategoryToItemType(category);
  const itemCode = forceItemCode || buildDbItemCode(offeringKey, unit);
  const dbUnit = forceDbUnit || mapBaselineUnitToDb(unit);

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
      for (const [key, value] of Object.entries(dbPatchLesson)) {
        sets.push(`${key} = $${idx}`);
        params.push(value);
        idx += 1;
      }"""

new = """async function upsertConfigPriceRule(client, {
  clientSlug, locationId, category, offeringKey, unit, patch, actor, forceItemCode, forceDbUnit,
}) {
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_price_rules');
  const loc = normalizeSunsetLocationId(locationId);
  const itemType = mapCategoryToItemType(category);
  const effectiveUnit = patch.period_window != null ? patch.period_window : unit;
  const itemCode = forceItemCode || buildDbItemCode(offeringKey, effectiveUnit);
  const dbUnit = forceDbUnit || mapBaselineUnitToDb(effectiveUnit);
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

if old in s:
    s = s.replace(old, new, 1)
    p.write_text(s, encoding='utf-8')
    print('OK fixed upsertConfigPriceRule')
else:
    print('SKIP pattern not found')
