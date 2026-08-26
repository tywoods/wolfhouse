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

const config = loadConfig();
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
assert.equal(quote.total_cents, 32100, '7-night Rincon uses Admin weekly cents');

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
