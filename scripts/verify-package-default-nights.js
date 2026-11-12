'use strict';

/**
 * Package default_nights + independent per-night price (Ty 13:21–13:29).
 * 3n / 6n / 9n with package €600 and per-night €110; min days; arrival season;
 * full_stay_only includes.
 */
const assert = require('node:assert/strict');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const {
  validatePriceRuleBody,
  validateItemBody,
} = require('./lib/wolfhouse-pricing-writes');
const {
  applyOverlayPricesToConfig,
  applyOverlayPackageItemsToConfig,
  buildAdminPricingView,
} = require('./lib/wolfhouse-pricing-resolve');

function baseConfig() {
  return {
    client_slug: 'wolfhouse-somo',
    currency: 'EUR',
    payment_options: { deposit: true, full: true },
    seasons: [
      {
        code: 'august', label: 'August', bookable: true, active: true, priority: 10,
        ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }],
      },
      {
        code: 'summer', label: 'Summer', bookable: true, active: true, priority: 0,
        ranges: [
          { start_month: 7, start_day: 1, end_month: 7, end_day: 31 },
          { start_month: 9, start_day: 1, end_month: 9, end_day: 30 },
        ],
      },
    ],
    packages: [{
      code: 'malibu',
      name: 'Malibu',
      default_nights: 6,
      min_days: 1,
      includes: [
        { text: 'Airport shuttle', full_stay_only: true },
        { text: 'Breakfast', full_stay_only: false },
        'Board storage',
      ],
      seasonal_prices: {
        august: { weekly_per_person_cents: 60000, per_night_cents: 11000 },
        summer: { weekly_per_person_cents: 50000, per_night_cents: 9000 },
      },
    }],
    deposits: { tiers: { standard_package: { amount_cents: 20000 }, custom_or_short_stay: { amount_cents: 10000 } } },
  };
}

function quote(nightsOrDates, extra) {
  const config = baseConfig();
  let check_in = '2026-08-02';
  let check_out;
  if (typeof nightsOrDates === 'number') {
    const d = new Date(Date.UTC(2026, 7, 2 + nightsOrDates));
    check_out = d.toISOString().slice(0, 10);
  } else {
    check_in = nightsOrDates.check_in;
    check_out = nightsOrDates.check_out;
  }
  return calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in,
    check_out,
    guest_count: 1,
    package_code: 'malibu',
    room_type: 'shared',
    payment_choice: 'deposit',
    ...(extra || {}),
  }, config);
}

const three = quote(3);
assert.equal(three.success, true, JSON.stringify(three.blockers || three));
assert.equal(three.nights, 3);
assert.equal(three.total_cents, 33000, `3n want €330 got ${three.total_cents}`);
assert.equal(three.season_code, 'august');

const six = quote(6);
assert.equal(six.success, true, JSON.stringify(six.blockers || six));
assert.equal(six.nights, 6);
assert.equal(six.total_cents, 60000, `6n want €600 got ${six.total_cents}`);

const nine = quote(9);
assert.equal(nine.success, true, JSON.stringify(nine.blockers || nine));
assert.equal(nine.nights, 9);
assert.equal(nine.total_cents, 93000, `9n want €930 got ${nine.total_cents}`);
console.log('PASS quote 3n €330 / 6n €600 / 9n €930');

const shortMin = calculateWolfhouseQuote({
  client_slug: 'wolfhouse-somo',
  check_in: '2026-08-02',
  check_out: '2026-08-07',
  guest_count: 1,
  package_code: 'malibu',
  room_type: 'shared',
  payment_choice: 'deposit',
}, Object.assign(baseConfig(), {
  packages: [Object.assign(baseConfig().packages[0], { min_days: 6 })],
}));
assert.equal(shortMin.nights, 5);
assert.equal(shortMin.package_eligible, false);
assert.equal(shortMin.success, false);
console.log('PASS min_days 6 refuses a 5-night stay');

const crossed = quote({ check_in: '2026-08-30', check_out: '2026-09-05' });
assert.equal(crossed.success, true, JSON.stringify(crossed.blockers || crossed));
assert.equal(crossed.nights, 6);
assert.equal(crossed.season_code, 'august');
assert.equal(crossed.total_cents, 60000, `arrival-season August package €600, got ${crossed.total_cents}`);
console.log('PASS cross-season stay uses arrival (August) prices');

assert.deepEqual(
  (quote(5).package_includes || []).map((row) => row.text),
  ['Breakfast', 'Board storage'],
  '5n must not offer full-stay-only shuttle',
);
assert.deepEqual(
  (quote(6).package_includes || []).map((row) => row.text),
  ['Airport shuttle', 'Breakfast', 'Board storage'],
);
console.log('PASS full_stay_only shuttle offered at 6n, not 5n');

const price = validatePriceRuleBody({
  item_type: 'package',
  item_code: 'malibu',
  season_code: 'august',
  unit: 'per_person_per_week',
  amount_eur: 600,
  per_night_eur: 110,
});
assert.equal(price.ok, true, price.error);
assert.equal(price.value.amount_cents, 60000);
assert.equal(price.value.per_night_cents, 11000);

const item = validateItemBody({
  item_type: 'package',
  item_code: 'malibu',
  label: 'Malibu',
  metadata: {
    default_nights: 6,
    min_days: 3,
    includes: [
      { text: 'Airport shuttle', full_stay_only: true },
      'Breakfast',
    ],
  },
});
assert.equal(item.ok, true, item.error);
assert.equal(item.value.metadata.default_nights, 6);
assert.deepEqual(item.value.metadata.includes, [
  { text: 'Airport shuttle', full_stay_only: true },
  { text: 'Breakfast', full_stay_only: false },
]);
console.log('PASS Staff API accepts default_nights, per_night_eur, include objects');

const overlay = applyOverlayPricesToConfig(baseConfig(), [{
  item_type: 'package', item_code: 'malibu', season_code: 'august',
  amount_cents: 60000, per_night_cents: 11000, active: true,
}]);
assert.equal(overlay.packages[0].seasonal_prices.august.per_night_cents, 11000);
const withItems = applyOverlayPackageItemsToConfig(overlay, [{
  item_type: 'package', item_code: 'malibu', label: 'Malibu', active: true,
  metadata: { default_nights: 6, min_days: 3, includes: [{ text: 'Airport shuttle', full_stay_only: true }] },
}]);
assert.equal(withItems.packages[0].default_nights, 6);

const view = buildAdminPricingView({
  config: baseConfig(),
  dbItems: [{
    item_type: 'package', item_code: 'malibu', label: 'Malibu', active: true,
    metadata: { default_nights: 6, min_days: 3, includes: [{ text: 'Airport shuttle', full_stay_only: true }] },
  }],
  dbRules: [{
    item_type: 'package', item_code: 'malibu', season_code: 'august',
    amount_cents: 60000, per_night_cents: 11000, unit: 'per_person_per_week',
    currency: 'EUR', active: true, source: 'db',
  }],
  dbSeasons: [],
  dbSeasonRanges: [],
});
const card = (view.packages || []).find((p) => p.code === 'malibu');
assert.equal(card.default_nights, 6);
const august = (card.prices || []).find((p) => p.season_code === 'august');
assert.equal(august.price.per_night_cents, 11000);
assert.equal(card.includes[0].full_stay_only, true);
console.log('PASS overlay + Staff Pricing GET expose default_nights and per_night_cents');

function quoteWith(config, nights) {
  const d = new Date(Date.UTC(2026, 7, 2 + nights));
  return calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-08-02',
    check_out: d.toISOString().slice(0, 10),
    guest_count: 1,
    package_code: 'malibu',
    room_type: 'shared',
    payment_choice: 'deposit',
  }, config);
}

const seedForNull = baseConfig();
delete seedForNull.packages[0].seasonal_prices.august.per_night_cents;
delete seedForNull.packages[0].seasonal_prices.summer.per_night_cents;
const nullOverlay = applyOverlayPricesToConfig(seedForNull, [{
  item_type: 'package', item_code: 'malibu', season_code: 'august',
  amount_cents: 60000, per_night_cents: null, active: true,
}]);
assert.notEqual(
  nullOverlay.packages[0].seasonal_prices.august.per_night_cents,
  0,
  'NULL DB per-night must not overlay as 0',
);
const nullThree = quoteWith(nullOverlay, 3);
assert.equal(nullThree.success, true, JSON.stringify(nullThree.blockers || nullThree));
assert.equal(nullThree.total_cents, 30000, `NULL per-night 3n want €300 (600÷6) got ${nullThree.total_cents}`);
const nullNine = quoteWith(nullOverlay, 9);
assert.equal(nullNine.success, true, JSON.stringify(nullNine.blockers || nullNine));
assert.equal(nullNine.total_cents, 90000, `NULL per-night 9n want €900 got ${nullNine.total_cents}`);
console.log('PASS DB overlay NULL per_night_cents falls back to package÷default_nights');

function quotePackage({ code, name, packageCents, perNightCents, nights }) {
  const config = baseConfig();
  config.packages[0] = {
    code,
    name,
    default_nights: 6,
    min_days: 1,
    includes: [],
    seasonal_prices: {
      august: {
        weekly_per_person_cents: packageCents,
        ...(perNightCents != null ? { per_night_cents: perNightCents } : {}),
      },
      summer: { weekly_per_person_cents: packageCents },
    },
  };
  const d = new Date(Date.UTC(2026, 7, 2 + nights));
  return calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-08-02',
    check_out: d.toISOString().slice(0, 10),
    guest_count: 1,
    package_code: code,
    room_type: 'shared',
    payment_choice: 'deposit',
  }, config);
}

const AUTO_FILL_PACKAGES = [
  { code: 'malibu', name: 'Malibu', packageCents: 34900, n3: 17450, n9: 52350, label: 'Malibu €349' },
  { code: 'uluwatu', name: 'Uluwatu', packageCents: 34900, n3: 17450, n9: 52350, label: 'Uluwatu €349' },
  { code: 'waimea', name: 'Waimea', packageCents: 49900, n3: 24950, n9: 74850, label: 'Waimea €499' },
];
for (const pkg of AUTO_FILL_PACKAGES) {
  const three = quotePackage({ ...pkg, nights: 3 });
  assert.equal(three.success, true, JSON.stringify(three.blockers || three));
  assert.equal(three.total_cents, pkg.n3, `${pkg.label} 3n want ${pkg.n3} got ${three.total_cents}`);
  const nine = quotePackage({ ...pkg, nights: 9 });
  assert.equal(nine.success, true, JSON.stringify(nine.blockers || nine));
  assert.equal(nine.total_cents, pkg.n9, `${pkg.label} 9n want ${pkg.n9} got ${nine.total_cents}`);
}
console.log('PASS auto-fill rounds once for Malibu/Uluwatu/Waimea at 3n and 9n');

assert.equal(quotePackage({ code: 'uluwatu', name: 'Uluwatu', packageCents: 34900, perNightCents: 5817, nights: 3 }).total_cents, 17451);
assert.equal(quotePackage({ code: 'uluwatu', name: 'Uluwatu', packageCents: 34900, perNightCents: 5817, nights: 9 }).total_cents, 52351);
assert.equal(quotePackage({ code: 'waimea', name: 'Waimea', packageCents: 49900, perNightCents: 8317, nights: 3 }).total_cents, 24951);
assert.equal(quotePackage({ code: 'waimea', name: 'Waimea', packageCents: 49900, perNightCents: 8317, nights: 9 }).total_cents, 74851);
console.log('PASS staff-set per-night used exactly as entered');
