'use strict';

/**
 * Phase 0 gate: the surf-school-config resolver must return, for `sunset`,
 * exactly the values currently hardcoded in the sunset-* modules. This proves
 * migrating call sites onto the resolver is a no-op for Sunset (parity), and
 * that a non-surf client resolves to null.
 *
 * Run: node scripts/verify-surf-school-config.js
 */

const assert = require('assert');
const {
  resolveSurfSchoolConfig,
  isSurfSchoolClient,
  SURF_SCHOOL_BUSINESS_TYPE,
} = require('./lib/surf-school-config');
const {
  PACK_BEACHES,
  PACK_AGE_BANDS,
  PACK_GROUP_SIZES,
  PACK_WEEKLY,
} = require('./lib/sunset-admin-pack-rules');

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

const sortedArr = (a) => a.slice().sort();
const sortedSet = (s) => [...s].sort();

const sunset = resolveSurfSchoolConfig('sunset');

check('sunset resolves to a surf_school_shop config', () => {
  assert.ok(sunset, 'expected non-null config for sunset');
  assert.strictEqual(sunset.business_type, SURF_SCHOOL_BUSINESS_TYPE);
  assert.strictEqual(sunset.currency, 'EUR');
});

check('sunset locations = somo + sardinero (from clients baseline)', () => {
  const ids = sunset.locations.map((l) => l.id).sort();
  assert.deepStrictEqual(ids, ['sunset-sardinero', 'sunset-somo']);
});

check('beaches match hardcoded PACK_BEACHES', () => {
  assert.deepStrictEqual(sortedArr(sunset.catalog.beaches), sortedSet(PACK_BEACHES));
});

check('age_bands match hardcoded PACK_AGE_BANDS', () => {
  assert.deepStrictEqual(sortedArr(sunset.catalog.age_bands), sortedSet(PACK_AGE_BANDS));
});

check('group_sizes match hardcoded PACK_GROUP_SIZES', () => {
  assert.deepStrictEqual(
    sortedArr(sunset.catalog.group_sizes),
    sortedSet(PACK_GROUP_SIZES),
  );
});

check('weekly matches hardcoded PACK_WEEKLY', () => {
  assert.deepStrictEqual(sortedArr(sunset.catalog.weekly), sortedSet(PACK_WEEKLY));
});

check('rental_groups match hardcoded RENTAL_GROUP_OFFERING/DISPLAY', () => {
  // Literal expected from tenant-admin-writes.js RENTAL_GROUP_OFFERING/DISPLAY.
  const byKey = Object.fromEntries(sunset.catalog.rental_groups.map((g) => [g.key, g]));
  assert.deepStrictEqual(Object.keys(byKey).sort(), ['boards', 'bundles', 'sup', 'wetsuits']);
  assert.strictEqual(byKey.bundles.offering_key, 'board_and_suit_rental');
  assert.strictEqual(byKey.boards.offering_key, 'board_rental');
  assert.strictEqual(byKey.wetsuits.offering_key, 'wetsuit_rental');
  assert.strictEqual(byKey.sup.offering_key, 'sup_rental');
  assert.strictEqual(byKey.bundles.label, 'Surfboard + Wetsuit');
  assert.strictEqual(byKey.sup.label, 'SUP');
});

check('offering_types = group_lesson, private_lesson, rental', () => {
  assert.deepStrictEqual(
    sunset.catalog.offering_types.slice().sort(),
    ['group_lesson', 'private_lesson', 'rental'],
  );
});

check('non-surf client (wolfhouse-somo) resolves to null', () => {
  assert.strictEqual(resolveSurfSchoolConfig('wolfhouse-somo'), null);
  assert.strictEqual(isSurfSchoolClient('wolfhouse-somo'), false);
});

check('lawave (surf_school_rentals vertical) resolves as surf school', () => {
  // lawave.baseline.json vertical = surf_school_rentals → archetype applies,
  // and with no beach config it must fail-open to an empty list (not sunset's).
  const lawave = resolveSurfSchoolConfig('lawave');
  assert.ok(lawave, 'expected lawave to resolve');
  assert.strictEqual(lawave.business_type, SURF_SCHOOL_BUSINESS_TYPE);
  assert.deepStrictEqual(lawave.catalog.beaches, []);
});

check('empty / unknown slug resolves to null', () => {
  assert.strictEqual(resolveSurfSchoolConfig(''), null);
  assert.strictEqual(resolveSurfSchoolConfig('does-not-exist'), null);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nsurf-school-config parity OK');
