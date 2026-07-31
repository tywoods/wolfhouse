'use strict';

/**
 * Phase 2 gate: the tenant_rental_offerings seed reproduces Sunset's current
 * 4-item rental catalog + mutual-exclusion rules exactly (parity), and produces
 * a clean catalog for a second surf school. Pure-logic, no DB.
 *
 * Run: node scripts/verify-tenant-rental-offerings-seed.js
 */

const assert = require('assert');
const { buildRentalOfferingRows } = require('./lib/tenant-rental-offerings-seed');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures += 1; console.error(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`); }
}

const sunset = buildRentalOfferingRows('sunset');
const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.offering_key, r]));

check('sunset yields exactly the 4 current rental items', () => {
  assert.ok(sunset, 'expected rows for sunset');
  const keys = sunset.map((r) => r.offering_key).sort();
  assert.deepStrictEqual(keys, ['board_and_suit_rental', 'board_rental', 'sup_rental', 'wetsuit_rental']);
});

check('labels + group_keys match the current hardcoded catalog', () => {
  const m = byKey(sunset);
  assert.strictEqual(m.board_and_suit_rental.label, 'Surfboard + Wetsuit');
  assert.strictEqual(m.board_and_suit_rental.group_key, 'bundles');
  assert.strictEqual(m.board_rental.group_key, 'boards');
  assert.strictEqual(m.wetsuit_rental.group_key, 'wetsuits');
  assert.strictEqual(m.sup_rental.group_key, 'sup');
});

check('canonical items seed as independent offerings (no auto bundle excludes)', () => {
  const m = byKey(sunset);
  // Slice A: Surfboard + Wetsuit is ordinary equipment — empty excludes for all seed rows.
  assert.deepStrictEqual(m.board_and_suit_rental.excludes, []);
  assert.deepStrictEqual(m.board_rental.excludes, []);
  assert.deepStrictEqual(m.wetsuit_rental.excludes, []);
  assert.deepStrictEqual(m.sup_rental.excludes, []);
});

check('historical BUNDLE_COMPONENTS + deriveExclusions remain for read-only adapters', () => {
  const { BUNDLE_COMPONENTS, deriveExclusions } = require('./lib/tenant-rental-offerings-seed');
  assert.ok(BUNDLE_COMPONENTS.board_and_suit_rental);
  const hist = deriveExclusions(['board_and_suit_rental', 'board_rental', 'wetsuit_rental']);
  assert.ok(hist.board_and_suit_rental.has('board_rental'));
  assert.ok(hist.board_rental.has('board_and_suit_rental'));
});

check('SUP has no exclusions (independent item)', () => {
  assert.deepStrictEqual(byKey(sunset).sup_rental.excludes, []);
});

check('every row carries client_slug and a stable sort_order', () => {
  sunset.forEach((r, i) => {
    assert.strictEqual(r.client_slug, 'sunset');
    assert.strictEqual(typeof r.sort_order, 'number');
  });
});

check('a second surf school (lawave) seeds the archetype default items', () => {
  const lawave = buildRentalOfferingRows('lawave');
  assert.ok(lawave, 'expected rows for lawave');
  assert.ok(lawave.every((r) => r.client_slug === 'lawave'));
  // Same archetype rental groups until lawave overrides them in its baseline.
  assert.deepStrictEqual(
    lawave.map((r) => r.offering_key).sort(),
    ['board_and_suit_rental', 'board_rental', 'sup_rental', 'wetsuit_rental'],
  );
});

check('non-surf client (wolfhouse-somo) yields null', () => {
  assert.strictEqual(buildRentalOfferingRows('wolfhouse-somo'), null);
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\ntenant-rental-offerings seed parity OK');
