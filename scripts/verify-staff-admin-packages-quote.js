'use strict';

/**
 * Admin Pricing packages must appear on Create booking and price via overlay,
 * not the hardcoded Malibu/Uluwatu/Waimea list.
 *
 *   node scripts/verify-staff-admin-packages-quote.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const resolve = require('./lib/wolfhouse-pricing-resolve');
const {
  calculateWolfhouseQuote,
  loadConfig,
  catalogPackageCodes,
} = require('./lib/wolfhouse-quote-calculator');
const { normalizeGuestPackagesInput } = require('./lib/bot-booking-package-normalize');

const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

assert.match(apiSrc, /pathname === '\/staff\/packages'/);
assert.match(apiSrc, /function handleStaffPackagesList/);
assert.match(apiSrc, /function bcLoadAdminPackages/);
assert.match(apiSrc, /if \(Array\.isArray\(bcAdminPackages\) && bcAdminPackages\.length\) return bcAdminPackages/);
assert.doesNotMatch(apiSrc, /var weekly = \['malibu','uluwatu','waimea'\]/);

const config = resolve.applyAuthoritativeSeasonsToConfig(loadConfig(), [{
  code: 'august', label: 'August', priority: 10, sort_order: 1, bookable: true, active: true,
  ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }],
}]);
const listed = resolve.listManualBookingPackages({
  config,
  dbItems: [{
    item_type: 'package',
    item_code: 'rincon',
    label: 'Rincon',
    active: true,
    metadata: { min_days: 7 },
  }],
  dbRules: [{
    item_type: 'package',
    item_code: 'rincon',
    season_code: 'august',
    amount_cents: 32100,
    active: true,
    label: 'Rincon',
  }],
});
const values = listed.map((p) => p.value);
assert.ok(values.includes('rincon'), 'Rincon from Admin items');
assert.ok(values.includes('malibu'), 'legacy packages stay');
assert.equal(values[values.length - 1], 'package_none');
assert.equal(listed.find((p) => p.value === 'rincon').label, 'Rincon');

const overlaid = resolve.applyOverlayPricesToConfig(config, [{
  item_type: 'package',
  item_code: 'rincon',
  season_code: 'august',
  amount_cents: 32100,
  active: true,
  label: 'Rincon',
}]);
const withItem = resolve.applyOverlayPackageItemsToConfig(overlaid, [{
  item_type: 'package',
  item_code: 'rincon',
  label: 'Rincon',
  active: true,
}]);
const renamed = resolve.applyOverlayPackageItemsToConfig(structuredClone(config), [{
  item_type: 'package',
  item_code: 'malibu',
  label: 'Costa Brava Week',
  active: true,
}]);
assert.equal(
  renamed.packages.find((p) => p.code === 'malibu').name,
  'Costa Brava Week',
  'active Staff label overrides an existing static package name',
);
const renamedCouple = calculateWolfhouseQuote({
  client_slug: 'wolfhouse-somo', check_in: '2026-08-14', check_out: '2026-08-21',
  guest_count: 2, package_code: 'malibu',
}, renamed);
assert.equal(renamedCouple.package_label, 'Costa Brava Week');
assert.deepEqual(renamedCouple.per_person.map((row) => row.package_label),
  ['Costa Brava Week', 'Costa Brava Week']);
const roomOnly = calculateWolfhouseQuote({
  client_slug: 'wolfhouse-somo', check_in: '2026-08-14', check_out: '2026-08-21',
  guest_count: 2, package_code: 'package_none',
}, renamed);
assert.equal(roomOnly.package_label, undefined);
assert.deepEqual(roomOnly.per_person.map((row) => row.package_label), [null, null]);
assert.ok(catalogPackageCodes(withItem).includes('rincon'));
assert.equal(
  withItem.packages.find((p) => p.code === 'rincon').seasonal_prices.august.weekly_per_person_cents,
  32100,
);

const quote = calculateWolfhouseQuote({
  client_slug: 'wolfhouse-somo',
  check_in: '2026-08-14',
  check_out: '2026-08-21',
  guest_count: 1,
  package_code: 'rincon',
}, withItem);
assert.equal(quote.success, true, JSON.stringify(quote.blockers || quote));
assert.equal(quote.package_code, 'rincon');
assert.equal(quote.package_label, 'Rincon');
assert.equal(quote.total_cents, 32100, '7-night Rincon uses Admin weekly cents');

const mixed = calculateWolfhouseQuote({
  client_slug: 'wolfhouse-somo',
  check_in: '2026-08-14',
  check_out: '2026-08-21',
  guest_count: 3,
  guest_packages: [
    { guest_number: 1, package_code: 'rincon' },
    { guest_number: 2, package_code: 'malibu' },
    { guest_number: 3, package_code: 'package_none' },
  ],
}, withItem);
assert.equal(mixed.success, true, JSON.stringify(mixed.blockers || mixed));
assert.deepEqual(
  mixed.per_person.map(({ package_code, package_label }) => ({ package_code, package_label })),
  [
    { package_code: 'rincon', package_label: 'Rincon' },
    { package_code: 'malibu', package_label: 'Malibu' },
    { package_code: 'package_none', package_label: null },
  ],
  'mixed package labels remain person-bound and accommodation-only has no package label',
);

const guestNorm = normalizeGuestPackagesInput(
  [{ guest_number: 1, package_code: 'rincon' }],
  1,
  'package_none',
);
assert.ok(!guestNorm.error, guestNorm.error);
assert.equal(guestNorm.guest_packages[0].package_code, 'rincon');

const unknown = calculateWolfhouseQuote({
  client_slug: 'wolfhouse-somo',
  check_in: '2026-08-14',
  check_out: '2026-08-21',
  guest_count: 1,
  package_code: 'rincon',
}, config);
assert.notEqual(unknown.success, true, 'Rincon without overlay is not a hardcoded JSON package');

console.log('PASS staff-admin-packages-quote: Rincon from Admin Pricing, not hardcoded');
