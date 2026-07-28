'use strict';

/**
 * GUARD: the tenant_price_rules item_code convention.
 *
 * Canonical rule (see docs/SURF-SCHOOL-TEMPLATE-PLAN.md + the price-identity
 * module): the duration/tier is baked INTO item_code as `offering__duration`;
 * the `unit` column is billing GRAIN only (person | day | session | item), never
 * the guest duration window.
 *
 * The footgun this guard exists to prevent (it already broke one branch —
 * skipper/sunset-portal-pricing-and-luna-repair): querying a BARE item_code
 * (`board_and_suit_rental`) with unit set to the DURATION (`half_day`) returns 0
 * rows, because the real row is item_code=`board_and_suit_rental__half_day`,
 * unit=`session`. Mock-only DB tests can't catch it; this locks the builders.
 *
 * Pure-logic, no DB. Run: node scripts/verify-item-code-convention-guard.js
 */

const assert = require('assert');
const {
  packPriceItemCode,
  courseTierIdentity,
  rentalIdentity,
  resolveSunsetPriceIdentity,
} = require('./lib/sunset-admin-price-identity');

/** The only legal values of tenant_price_rules.unit. */
const BILLING_GRAINS = new Set(['person', 'day', 'session', 'item']);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`);
  }
}

check('packPriceItemCode bakes tier into item_code (offering__tier)', () => {
  assert.strictEqual(packPriceItemCode('abc', '3_days'), 'surf_pack_abc__3_days');
  assert.ok(packPriceItemCode('abc', '3_days').includes('__'));
});

check('courseTierIdentity: duration in item_code, unit is a billing grain', () => {
  const id = courseTierIdentity('abc', '3_days', 'sunset-somo');
  assert.ok(id, 'expected identity');
  assert.strictEqual(id.item_code, 'surf_pack_abc__3_days');
  assert.ok(id.item_code.endsWith('__3_days'), 'duration must live in item_code');
  assert.ok(BILLING_GRAINS.has(id.billing_unit), `unit must be a grain, got ${id.billing_unit}`);
  // The duration token must NOT leak into the unit column.
  assert.notStrictEqual(id.billing_unit, '3_days');
});

check('rentalIdentity(half_day): item_code carries duration, unit is grain (THE footgun)', () => {
  const id = rentalIdentity('board_and_suit_rental', 'half_day', 'sunset-somo');
  assert.ok(id, 'expected identity');
  assert.strictEqual(id.item_code, 'board_and_suit_rental__half_day');
  // The exact break that shipped once: unit must never be the duration window.
  assert.ok(BILLING_GRAINS.has(id.billing_unit), `unit must be a grain, got ${id.billing_unit}`);
  assert.notStrictEqual(id.billing_unit, 'half_day');
  // And the bare code alone must not be the resolvable identity.
  assert.notStrictEqual(id.item_code, 'board_and_suit_rental');
});

check('rentalIdentity multi-day maps to day grain', () => {
  const id = rentalIdentity('board_rental', '4_days', 'sunset-somo');
  assert.strictEqual(id.item_code, 'board_rental__4_days');
  assert.strictEqual(id.billing_unit, 'day');
});

check('rentalIdentity: compound offering + disagreeing explicit duration => null', () => {
  // Independent claims that disagree must never be silently priced.
  const id = rentalIdentity('board_rental__4_days', '2_days', 'sunset-somo');
  assert.strictEqual(id, null);
});

check('rentalIdentity: compound offering + agreeing duration is accepted once', () => {
  const id = rentalIdentity('board_rental__4_days', '4_days', 'sunset-somo');
  assert.ok(id);
  assert.strictEqual(id.item_code, 'board_rental__4_days');
});

check('resolveSunsetPriceIdentity round-trips a compound course item_code', () => {
  const id = resolveSunsetPriceIdentity({
    offering_id: 'surf_pack_xyz__2_days',
    location_id: 'sunset-somo',
  });
  assert.ok(id, 'expected identity');
  assert.strictEqual(id.item_code, 'surf_pack_xyz__2_days');
  assert.ok(BILLING_GRAINS.has(id.billing_unit));
  assert.notStrictEqual(id.billing_unit, '2_days');
});

check('every builder keeps unit within the billing-grain set', () => {
  const ids = [
    courseTierIdentity('p', 'single_class', 'sunset-somo'),
    courseTierIdentity('p', '1_day', 'sunset-somo'),
    rentalIdentity('wetsuit_rental', '1_hour', 'sunset-somo'),
    rentalIdentity('board_and_suit_rental', '1_day', 'sunset-somo'),
    rentalIdentity('board_rental', '7_days', 'sunset-somo'),
  ].filter(Boolean);
  assert.ok(ids.length >= 5, 'expected all identities to build');
  for (const id of ids) {
    assert.ok(BILLING_GRAINS.has(id.billing_unit), `bad unit ${id.billing_unit} for ${id.item_code}`);
  }
});

if (failures) {
  console.error(`\n${failures} guard check(s) failed`);
  process.exit(1);
}
console.log('\nitem_code convention guard OK');
