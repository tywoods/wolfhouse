'use strict';

/**
 * verify:wolfhouse-admin-pricing — Wolfhouse Admin Pricing data layer.
 *
 * Offline. No DB, no network, no API key. Proves:
 *   - recurring season windows, including year-wrap and priority overlap
 *   - a date in no season blocks instead of falling back to a price
 *   - the JSON seed flattens to the same rule shape the DB overlay uses
 *   - DB rows win over config, config-only rows survive a partial overlay
 *   - write validation and the fail-closed Wolfhouse write gate
 *   - the Wolfhouse pricing modules never reach into Sunset's admin modules
 */

const fs = require('fs');
const path = require('path');

const resolve = require('./lib/wolfhouse-pricing-resolve');
const writes = require('./lib/wolfhouse-pricing-writes');
const { getClientTransferConfig } = require('./lib/client-transfer-config');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function ok(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

const config = resolve.loadPricingConfig();
const seasons = resolve.configSeasons(config);
const rules = resolve.configPricingRules(config).concat(
  resolve.listConfigPackageSeeds(config).flatMap((s) => (s.prices || []).map((pr) => ({
    item_type: 'package',
    item_code: s.code,
    season_code: pr.season_code,
    unit: pr.unit,
    amount_cents: pr.amount_cents,
    currency: 'EUR',
    source: 'config',
    label: s.label,
  }))),
);

// ── Season windows ──────────────────────────────────────────────────────────
console.log('\n── Season windows ──');

ok('daysInMonth knows February has 29 slots and April 30',
  resolve.daysInMonth(2) === 29 && resolve.daysInMonth(4) === 30 && resolve.daysInMonth(13) === 0);

const wrapRange = { start_month: 11, start_day: 1, end_month: 2, end_day: 28 };
ok('year-wrap range covers December',
  resolve.seasonRangeCoversMonthDay(wrapRange, 12, 25));
ok('year-wrap range covers January',
  resolve.seasonRangeCoversMonthDay(wrapRange, 1, 5));
ok('year-wrap range excludes a date outside the window',
  !resolve.seasonRangeCoversMonthDay(wrapRange, 6, 15));

const plainRange = { start_month: 4, start_day: 1, end_month: 6, end_day: 30 };
ok('plain range covers its interior', resolve.seasonRangeCoversMonthDay(plainRange, 5, 10));
ok('plain range is inclusive on both ends',
  resolve.seasonRangeCoversMonthDay(plainRange, 4, 1)
  && resolve.seasonRangeCoversMonthDay(plainRange, 6, 30));
ok('plain range excludes the day after it ends',
  !resolve.seasonRangeCoversMonthDay(plainRange, 7, 1));

ok('rejects a malformed date', resolve.parseIsoDateParts('2026-13-01') === null
  && resolve.parseIsoDateParts('not-a-date') === null);

// ── Season resolution from the shipped config ───────────────────────────────
console.log('\n── Season resolution ──');

const august = resolve.resolveSeasonForDate(seasons, '2026-08-15');
ok('August resolves to the august season, not summer',
  august && august.code === 'august', august ? `got ${august.code}` : 'got null');
ok('august wins on priority', august && august.priority === 10);

const july = resolve.resolveSeasonForDate(seasons, '2026-07-15');
ok('July resolves to summer', july && july.code === 'summer');

const april = resolve.resolveSeasonForDate(seasons, '2026-04-01');
ok('April resolves to spring_autumn', april && april.code === 'spring_autumn');

const december = resolve.resolveSeasonForDate(seasons, '2026-12-25');
ok('December resolves to the closed season', december && december.code === 'closed');
ok('closed season is marked not bookable', december && december.bookable === false);

ok('March resolves to no season at all',
  resolve.resolveSeasonForDate(seasons, '2026-03-15') === null);

ok('season resolution is deterministic across repeated calls',
  resolve.resolveSeasonForDate(seasons, '2026-08-15').code
  === resolve.resolveSeasonForDate(seasons, '2026-08-15').code);

// ── Blocking beats guessing ─────────────────────────────────────────────────
console.log('\n── Unpriced dates block ──');

const marchQuote = resolve.resolvePackagePriceForDate({
  seasons, rules, packageCode: 'malibu', checkInDate: '2026-03-15',
});
ok('March check-in is blocked, not priced',
  marchQuote.ok === false && marchQuote.reason === 'no_season_for_date');

const decemberQuote = resolve.resolvePackagePriceForDate({
  seasons, rules, packageCode: 'malibu', checkInDate: '2026-12-25',
});
ok('closed-season check-in is blocked',
  decemberQuote.ok === false && decemberQuote.reason === 'season_not_bookable');

const augustQuote = resolve.resolvePackagePriceForDate({
  seasons, rules, packageCode: 'malibu', checkInDate: '2026-08-15',
});
ok('August Malibu prices at the august rate of 34900',
  augustQuote.ok === true && augustQuote.amount_cents === 34900,
  JSON.stringify(augustQuote));

const missingPkgQuote = resolve.resolvePackagePriceForDate({
  seasons, rules, packageCode: 'nonexistent_package', checkInDate: '2026-08-15',
});
ok('unknown package is blocked rather than defaulted',
  missingPkgQuote.ok === false && missingPkgQuote.reason === 'no_price_for_season');

// ── Config seed flattening ──────────────────────────────────────────────────
console.log('\n── Config seed flattening ──');

function find(itemType, itemCode, seasonCode) {
  return rules.find((r) => r.item_type === itemType
    && r.item_code === itemCode
    && (seasonCode === undefined ? true : r.season_code === seasonCode)) || null;
}

ok('every package season price is flattened',
  find('package', 'malibu', 'spring_autumn').amount_cents === 24900
  && find('package', 'uluwatu', 'summer').amount_cents === 39900
  && find('package', 'waimea', 'august').amount_cents === 59900);

ok('package unit is per person per week',
  find('package', 'malibu', 'august').unit === 'per_person_per_week');

ok('private room supplement seeds as a staff extra',
  resolve.listConfigExtraSeeds(config).some((s) => s.code === 'private' && s.amount_cents === 1000 && s.unit === 'per_room_per_night'));

ok('the free shared room stays in the extra seeds at zero',
  resolve.listConfigExtraSeeds(config).some((s) => s.code === 'shared' && s.amount_cents === 0 && s.unit === 'per_person_per_night'));

ok('a zero supplement is writable but a zero rental is not',
  writes.validatePriceRuleBody({
    item_type: 'supplement', item_code: 'shared', unit: 'per_room_per_night', amount_cents: 0,
  }).ok === true
  && writes.validatePriceRuleBody({
    item_type: 'rental', item_code: 'wetsuit_rental__1_day', unit: 'per_day', amount_cents: 0,
  }).ok === false);

ok('deposit tiers become staff extra seeds',
  resolve.listConfigExtraSeeds(config).filter((s) => s.item_type === 'deposit').length === 2
  && resolve.listConfigExtraSeeds(config).some((s) => s.code === 'standard_package' && s.amount_cents === 20000));

ok('gear add-ons are not flattened as built-in rental rules',
  !find('rental', 'wetsuit_rental__1_day', null)
  && !find('rental', 'hard_board_rental__1_day', null));
ok('gear add-ons become staff rental seeds with titles',
  resolve.listConfigRentalSeeds(config).some((s) => s.code === 'wetsuit_rental' && s.amount_cents === 500 && s.label === 'Wetsuit rental'));

ok('non-gear add-ons become staff service seeds',
  resolve.listConfigServiceSeeds(config).some((s) => s.code === 'yoga_class' && s.amount_cents === 1500 && s.unit === 'per_class'));

ok('the multi-lesson bundle seed uses its price_cents_each',
  resolve.listConfigServiceSeeds(config).some((s) => s.code === 'surf_lesson_multi' && s.amount_cents === 3000));

ok('duplicated meal/meals config entries collapse to one service seed',
  resolve.listConfigServiceSeeds(config).filter((s) => s.code === 'meal').length === 1
  && !resolve.listConfigServiceSeeds(config).some((s) => s.code === 'meals'));

ok('no config rule carries a negative or non-integer amount',
  rules.every((r) => Number.isInteger(r.amount_cents) && r.amount_cents >= 0));

ok('every config rule is tagged as config-sourced',
  rules.every((r) => r.source === 'config'));

// ── Transfers seeded from the hardcoded config ──────────────────────────────
console.log('\n── Transfer seed ──');

const transfers = resolve.configTransferRules(getClientTransferConfig('wolfhouse-somo'));
const sdr = transfers.rules.find((r) => r.item_code === 'SDR');
const bio = transfers.rules.find((r) => r.item_code === 'BIO');

ok('Santander seeds as a flat 2500', sdr && sdr.unit === 'flat' && sdr.amount_cents === 2500);
ok('Bilbao seeds as 1500 per person', bio && bio.unit === 'per_person' && bio.amount_cents === 1500);

const bioRule = transfers.eligibility.find((r) => r.airport_code === 'BIO');
ok('Bilbao eligibility keeps requires_package and the group minimum',
  bioRule && bioRule.requires_package === true && bioRule.min_guest_count === 4);
ok('Bilbao keeps both guest-facing refusal messages',
  bioRule && !!bioRule.unavailable_no_package_message
  && !!bioRule.unavailable_below_min_group_message);

const sdrRule = transfers.eligibility.find((r) => r.airport_code === 'SDR');
ok('Santander is included when a package is booked',
  sdrRule && sdrRule.included_when_package === true && sdrRule.requires_package === false);

// ── DB over config precedence ───────────────────────────────────────────────
console.log('\n── DB over config precedence ──');

const dbRules = [
  {
    item_type: 'package', item_code: 'malibu', season_code: 'august',
    unit: 'per_person_per_week', amount_cents: 37500, currency: 'EUR', active: true,
  },
  {
    item_type: 'rental', item_code: 'wetsuit_rental__1_day', season_code: null,
    unit: 'per_day', amount_cents: 700, currency: 'EUR', active: true,
  },
];
const merged = resolve.mergePricingRules(rules, dbRules);

ok('a DB row overrides the config price for the same key',
  resolve.lookupRule(merged, { item_type: 'package', item_code: 'malibu', season_code: 'august' })
    .amount_cents === 37500);
ok('the overriding row is tagged as db-sourced',
  resolve.lookupRule(merged, { item_type: 'rental', item_code: 'wetsuit_rental__1_day' })
    .source === 'db');
ok('config rows with no DB counterpart survive a partial overlay',
  resolve.lookupRule(merged, { item_type: 'package', item_code: 'waimea', season_code: 'august' })
    .amount_cents === 59900);
ok('an empty overlay leaves the config catalog untouched',
  resolve.mergePricingRules(rules, []).length === rules.length);

const withDeactivation = resolve.mergePricingRules(rules, [
  { item_type: 'service', item_code: 'yoga_class', season_code: null, active: false },
]);
ok('a deactivated DB row removes the item rather than reverting to config',
  resolve.lookupRule(withDeactivation, { item_type: 'service', item_code: 'yoga_class' }) === null);

const mergedSeasons = resolve.mergeSeasons(seasons, [
  { code: 'august', label: 'High summer', priority: 20, bookable: true, active: true,
    ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }] },
]);
const augustAfter = resolve.resolveSeasonForDate(mergedSeasons, '2026-08-15');
ok('a DB season replaces the config season of the same code',
  augustAfter && augustAfter.label === 'High summer' && augustAfter.source === 'db');
ok('untouched config seasons still resolve after a season override',
  resolve.resolveSeasonForDate(mergedSeasons, '2026-07-15').code === 'summer');

// ── Rule lookup precedence ──────────────────────────────────────────────────
console.log('\n── Rule lookup ──');

const mixed = [
  { item_type: 'package', item_code: 'x', season_code: null, unit: 'per_person_per_week', amount_cents: 100, active: true },
  { item_type: 'package', item_code: 'x', season_code: 'august', unit: 'per_person_per_week', amount_cents: 200, active: true },
];
ok('a season-specific price beats a season-agnostic one',
  resolve.lookupRule(mixed, { item_type: 'package', item_code: 'x', season_code: 'august' })
    .amount_cents === 200);
ok('an unpriced season falls back to the season-agnostic row',
  resolve.lookupRule(mixed, { item_type: 'package', item_code: 'x', season_code: 'summer' })
    .amount_cents === 100);
ok('an unknown item resolves to null',
  resolve.lookupRule(mixed, { item_type: 'package', item_code: 'nope' }) === null);

// ── Euro parsing ────────────────────────────────────────────────────────────
console.log('\n── Euro parsing ──');

ok('parses a plain amount', writes.parseEurosToCents('35').value === 3500);
ok('parses two decimals', writes.parseEurosToCents('35.50').value === 3550);
ok('parses a euro symbol and comma decimal', writes.parseEurosToCents('€35,50').value === 3550);
ok('rejects three decimals', writes.parseEurosToCents('35.999').ok === false);
ok('rejects a negative', writes.parseEurosToCents('-5').ok === false);
ok('rejects text', writes.parseEurosToCents('abc').ok === false);
ok('rejects empty', writes.parseEurosToCents('').ok === false);
ok('rejects an absurd amount', writes.parseEurosToCents('99999999').ok === false);
ok('never produces a float', Number.isInteger(writes.parseEurosToCents('0.07').value)
  && writes.parseEurosToCents('0.07').value === 7);

// ── Write validation ────────────────────────────────────────────────────────
console.log('\n── Write validation ──');

ok('accepts a valid package price',
  writes.validatePriceRuleBody({
    item_type: 'package', item_code: 'malibu', season_code: 'august',
    unit: 'per_person_per_week', amount_cents: 34900,
  }).ok === true);

ok('rejects an active price of zero',
  writes.validatePriceRuleBody({
    item_type: 'rental', item_code: 'wetsuit_rental__1_day', unit: 'per_day', amount_cents: 0,
  }).ok === false);

ok('allows zero on an inactive row',
  writes.validatePriceRuleBody({
    item_type: 'rental', item_code: 'wetsuit_rental__1_day', unit: 'per_day',
    amount_cents: 0, active: false,
  }).ok === true);

ok('rejects a unit that does not fit the item type',
  writes.validatePriceRuleBody({
    item_type: 'deposit', item_code: 'standard_package', unit: 'per_class', amount_cents: 20000,
  }).ok === false);

ok('rejects season scoping on a non-package price',
  writes.validatePriceRuleBody({
    item_type: 'rental', item_code: 'wetsuit_rental__1_day', season_code: 'august',
    unit: 'per_day', amount_cents: 500,
  }).ok === false);

ok('rejects an unknown item_type',
  writes.validatePriceRuleBody({
    item_type: 'sunset_pack', item_code: 'x', unit: 'per_day', amount_cents: 100,
  }).ok === false);

ok('requires a 3-letter IATA code for transfers',
  writes.validatePriceRuleBody({
    item_type: 'transfer', item_code: 'santander', unit: 'flat', amount_cents: 2500,
  }).ok === false
  && writes.validatePriceRuleBody({
    item_type: 'transfer', item_code: 'SDR', unit: 'flat', amount_cents: 2500,
  }).ok === true);

ok('accepts amount_eur from the browser and stores cents',
  writes.validatePriceRuleBody({
    item_type: 'service', item_code: 'yoga_class', unit: 'per_class', amount_eur: '15,00',
  }).value.amount_cents === 1500);

// Seasons
ok('accepts a season with one range',
  writes.validateSeasonBody({
    code: 'august', label: 'August',
    ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }],
  }).ok === true);

ok('rejects a season with no ranges',
  writes.validateSeasonBody({ code: 'august', label: 'August', ranges: [] }).ok === false);

ok('rejects duplicate ranges',
  writes.validateSeasonBody({
    code: 'august', label: 'August',
    ranges: [
      { start_month: 8, start_day: 1, end_month: 8, end_day: 31 },
      { start_month: 8, start_day: 1, end_month: 8, end_day: 31 },
    ],
  }).ok === false);

ok('rejects February 30th',
  writes.validateSeasonBody({
    code: 'x', label: 'X',
    ranges: [{ start_month: 2, start_day: 30, end_month: 3, end_day: 1 }],
  }).ok === false);

ok('accepts a year-wrapping season',
  writes.validateSeasonBody({
    code: 'closed', label: 'Closed', bookable: false,
    ranges: [{ start_month: 11, start_day: 1, end_month: 2, end_day: 28 }],
  }).value.bookable === false);

ok('rejects an uppercase or spaced season code',
  writes.validateSeasonBody({
    code: 'High Summer', label: 'x',
    ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }],
  }).ok === false);

// Transfers
ok('accepts a simple transfer rule',
  writes.validateTransferRuleBody({ airport_code: 'SDR', label: 'Santander' }).ok === true);

ok('requires refusal copy when a package is required',
  writes.validateTransferRuleBody({
    airport_code: 'BIO', label: 'Bilbao', requires_package: true,
  }).ok === false);

ok('requires refusal copy when a group minimum is set',
  writes.validateTransferRuleBody({
    airport_code: 'BIO', label: 'Bilbao', min_guest_count: 4,
  }).ok === false);

ok('accepts a fully specified Bilbao rule',
  writes.validateTransferRuleBody({
    airport_code: 'BIO', label: 'Bilbao', requires_package: true, min_guest_count: 4,
    unavailable_no_package_message: 'Package bookings only.',
    unavailable_below_min_group_message: 'Groups of 4 or more.',
  }).ok === true);

// Items
ok('accepts a new staff-created rental item',
  writes.validateItemBody({ item_type: 'rental', item_code: 'longboard_rental', label: 'Longboard' })
    .ok === true);
ok('rejects an item type outside the catalog',
  writes.validateItemBody({ item_type: 'transfer', item_code: 'sdr', label: 'x' }).ok === false);

// ── Write gate ──────────────────────────────────────────────────────────────
console.log('\n── Write gate ──');

const adminUser = { email: 'a@b.test', role: 'admin' };
const enabledEnv = { WOLFHOUSE_ADMIN_WRITES_ENABLED: 'true' };

ok('writes are disabled when the flag is unset',
  writes.evaluateWolfhousePricingWriteGate({
    env: {}, clientSlug: 'wolfhouse-somo', user: adminUser,
  }).ok === false);

ok('sunset cannot write through the Wolfhouse gate',
  writes.evaluateWolfhousePricingWriteGate({
    env: enabledEnv, clientSlug: 'sunset', user: adminUser,
  }).body.error === 'unsupported_client');

ok('an anonymous request is rejected with 401',
  writes.evaluateWolfhousePricingWriteGate({
    env: enabledEnv, clientSlug: 'wolfhouse-somo', user: null,
  }).status === 401);

ok('an operator is below the write role',
  writes.evaluateWolfhousePricingWriteGate({
    env: enabledEnv, clientSlug: 'wolfhouse-somo', user: { email: 'o@b.test', role: 'operator' },
  }).body.error === 'forbidden_role');

ok('an admin passes the gate',
  writes.evaluateWolfhousePricingWriteGate({
    env: enabledEnv, clientSlug: 'wolfhouse-somo', user: adminUser,
  }).ok === true);

ok('an owner passes the gate',
  writes.evaluateWolfhousePricingWriteGate({
    env: enabledEnv, clientSlug: 'wolfhouse-somo', user: { email: 'o@b.test', role: 'owner' },
  }).ok === true);

ok('a disabled flag is reported before the client slug',
  writes.evaluateWolfhousePricingWriteGate({
    env: {}, clientSlug: 'sunset', user: adminUser,
  }).body.error === 'writes_disabled');

// ── Admin view payload ──────────────────────────────────────────────────────
console.log('\n── Admin view payload ──');

const transferConfig = getClientTransferConfig('wolfhouse-somo');

const view = resolve.buildAdminPricingView({
  config, transferConfig, dbSeasons: [], dbRules: [], dbItems: [], dbTransferRules: [],
  writesEnabled: false,
});

ok('view is scoped to Wolfhouse', view.client_slug === 'wolfhouse-somo');
ok('view reports the write flag so the UI can render read-only',
  view.writes_enabled === false);
ok('view lists every season', view.seasons.length === seasons.length);
ok('view keeps the closed season flagged unbookable',
  view.seasons.find((s) => s.code === 'closed').bookable === false);
ok('empty overlay has no built-in packages', view.packages.length === 0);

const packageSeeds = resolve.listConfigPackageSeeds(config);
const viewPromotedPackages = resolve.buildAdminPricingView({
  config,
  transferConfig,
  dbSeasons: [],
  dbRules: packageSeeds.flatMap((s) => (s.prices || []).map((pr) => ({
    item_type: 'package', item_code: s.code, season_code: pr.season_code,
    unit: pr.unit, amount_cents: pr.amount_cents, currency: 'EUR', active: true, label: s.label,
  }))),
  dbItems: packageSeeds.map((s) => ({
    item_type: 'package', item_code: s.code, label: s.label,
    metadata: { pebble: s.pebble }, active: true,
  })),
  dbTransferRules: [],
  writesEnabled: true,
});
const malibuView = viewPromotedPackages.packages.find((p) => p.code === 'malibu');
ok('promoted packages are staff-owned',
  viewPromotedPackages.packages.length === 3
  && viewPromotedPackages.packages.every((p) => p.source === 'db'));
ok('every package carries one slot per season',
  malibuView.prices.length === view.seasons.length);
ok('a package price is filled from the promoted seed',
  malibuView.prices.find((p) => p.season_code === 'august').price.amount_cents === 34900);
ok('a season with no package price surfaces as null, not zero',
  malibuView.prices.find((p) => p.season_code === 'closed').price === null);
ok('promoted packages keep pebble tokens without underscores',
  viewPromotedPackages.packages.every((p) => p.pebble && !/_/.test(p.pebble)));

ok('config rentals are no longer listed as built-in catalog rows',
  !view.rentals.some((r) => r.code === 'wetsuit_rental'));
ok('empty overlay has no built-in rentals',
  view.rentals.every((r) => r.source === 'db'));

const rentalSeeds = resolve.listConfigRentalSeeds(config);
ok('config rental seeds keep human titles without underscores',
  rentalSeeds.length === 5
  && rentalSeeds.every((s) => s.label && !/_/.test(s.label)));

const viewPromoted = resolve.buildAdminPricingView({
  config,
  transferConfig,
  dbSeasons: [],
  dbRules: rentalSeeds.map((s) => ({
    item_type: 'rental',
    item_code: `${s.code}__${s.duration}`,
    season_code: null,
    unit: s.unit,
    amount_cents: s.amount_cents,
    currency: 'EUR',
    active: true,
    label: s.label,
  })),
  dbItems: rentalSeeds.map((s) => ({
    item_type: 'rental', item_code: s.code, label: s.label, metadata: {}, active: true,
  })),
  dbTransferRules: [],
  writesEnabled: true,
});
ok('promoted rentals are staff-owned',
  viewPromoted.rentals.length === 5
  && viewPromoted.rentals.every((r) => r.source === 'db'));
ok('promoted rental titles have no underscores',
  viewPromoted.rentals.every((r) => r.label && !/_/.test(r.label)));
ok('promoted wetsuit still prices per day at the live amount',
  viewPromoted.rentals.find((r) => r.code === 'wetsuit_rental').durations[0].amount_cents === 500);

const overlayCfg = resolve.applyOverlayPricesToConfig(config, [{
  item_type: 'rental', item_code: 'wetsuit_rental__1_day', amount_cents: 777, active: true,
}]);
ok('overlay rental prices win over JSON add-on cents',
  overlayCfg.add_ons.wetsuit_rental.price_cents === 777
  && config.add_ons.wetsuit_rental.price_cents === 500);

const overlayAll = resolve.applyOverlayPricesToConfig(config, [
  { item_type: 'package', item_code: 'malibu', season_code: 'august', amount_cents: 11100, active: true },
  { item_type: 'service', item_code: 'yoga_class', amount_cents: 1800, unit: 'per_class', active: true },
  { item_type: 'deposit', item_code: 'standard_package', amount_cents: 25000, unit: 'per_person', active: true },
  { item_type: 'supplement', item_code: 'private', amount_cents: 1500, unit: 'per_room_per_night', active: true },
]);
ok('overlay package prices win over JSON seasonal cents',
  overlayAll.packages.find((p) => p.code === 'malibu').seasonal_prices.august.weekly_per_person_cents === 11100);
ok('overlay service prices win over JSON add-on cents',
  overlayAll.add_ons.yoga_class.price_cents === 1800);
ok('overlay deposit prices and scope win over JSON',
  overlayAll.deposits.tiers.standard_package.amount_cents === 25000
  && overlayAll.deposits.scope === 'per_person');
ok('overlay room supplement prices win over JSON',
  overlayAll.room_supplements.private.per_room_per_night_cents === 1500);

ok('empty overlay has no built-in services or extras',
  view.services.length === 0
  && view.extras.deposits.length === 0
  && view.extras.supplements.length === 0);

const serviceSeeds = resolve.listConfigServiceSeeds(config);
const extraSeeds = resolve.listConfigExtraSeeds(config);
const viewPromotedCatalog = resolve.buildAdminPricingView({
  config,
  transferConfig,
  dbSeasons: [],
  dbRules: serviceSeeds.concat(extraSeeds).map((s) => ({
    item_type: s.item_type,
    item_code: s.rule_code || s.code,
    season_code: null,
    unit: s.unit,
    amount_cents: s.amount_cents,
    currency: 'EUR',
    active: true,
    label: s.label,
  })),
  dbItems: serviceSeeds.concat(extraSeeds).map((s) => ({
    item_type: s.item_type, item_code: s.code, label: s.label, metadata: {}, active: true,
  })),
  dbTransferRules: [],
  writesEnabled: true,
});
ok('promoted services are staff-owned',
  viewPromotedCatalog.services.length === serviceSeeds.length
  && viewPromotedCatalog.services.every((s) => s.source === 'db'));
ok('promoted extras are staff-owned and titled',
  viewPromotedCatalog.extras.deposits.length === 2
  && viewPromotedCatalog.extras.supplements.length === extraSeeds.filter((s) => s.item_type === 'supplement').length
  && viewPromotedCatalog.extras.deposits.every((d) => d.source === 'db' && d.label && !/_/.test(d.label)));
ok('promoted yoga still prices per class',
  viewPromotedCatalog.services.find((s) => s.code === 'yoga_class').price.unit === 'per_class');

const sdrView = view.transfers.find((t) => t.airport_code === 'SDR');
ok('transfers merge eligibility with price',
  sdrView && sdrView.included_when_package === true && sdrView.price.amount_cents === 2500);

ok('every config-sourced price is tagged config',
  view.packages.every((p) => p.prices.every((s) => !s.price || s.price.source === 'config')));

const viewWithDb = resolve.buildAdminPricingView({
  config,
  transferConfig,
  dbSeasons: [],
  dbRules: [{
    item_type: 'package', item_code: 'malibu', season_code: 'august',
    unit: 'per_person_per_week', amount_cents: 37500, currency: 'EUR', active: true,
  }],
  dbItems: [{
    item_type: 'rental', item_code: 'longboard_rental', label: 'Longboard', metadata: {},
    active: true,
  }],
  dbTransferRules: [],
  writesEnabled: true,
});

ok('an edited price shows the DB value tagged as db',
  viewWithDb.packages.find((p) => p.code === 'malibu').prices
    .find((s) => s.season_code === 'august').price.amount_cents === 37500);

ok('a price-only overlay package without a catalog item stays config-owned',
  viewWithDb.packages.find((p) => p.code === 'malibu').source === 'config');
ok('a staff-created rental is marked staff-owned',
  viewWithDb.rentals.find((r) => r.code === 'longboard_rental').source === 'db');
ok('editing a config item price does not make staff the owner of the item',
  viewWithDb.packages.find((p) => p.code === 'malibu').source === 'config');
ok('an edited price is distinguishable from a shipped default',
  viewWithDb.packages.find((p) => p.code === 'malibu').prices
    .find((s) => s.season_code === 'august').price.source === 'db');
ok('a staff-created rental appears even with no price yet',
  viewWithDb.rentals.some((r) => r.code === 'longboard_rental' && r.durations.length === 0));
ok('a staff-created item uses its own label',
  viewWithDb.rentals.find((r) => r.code === 'longboard_rental').label === 'Longboard');

// ── Store scoping (recording fake, no database) ─────────────────────────────
console.log('\n── Store scoping ──');

const store = require('./lib/wolfhouse-pricing-store');

function fakePg(rowsByCall) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params: params || [] });
      const rows = Array.isArray(rowsByCall) ? (rowsByCall[i] || []) : [];
      i += 1;
      return { rows, rowCount: rows.length };
    },
  };
}

function threw(fn) {
  try { fn(); return null; } catch (err) { return err.message; }
}

ok('scope guard accepts Wolfhouse',
  store.assertWolfhouseScope('wolfhouse-somo') === 'wolfhouse-somo');
ok('scope guard rejects Sunset with tenant_scope_violation',
  threw(() => store.assertWolfhouseScope('sunset')) === 'tenant_scope_violation');
ok('scope guard rejects an empty slug',
  threw(() => store.assertWolfhouseScope('')) === 'tenant_scope_violation');

async function runStoreChecks() {
  for (const [name, fn] of [
    ['loadSeasons', store.loadSeasons],
    ['loadRules', store.loadRules],
    ['loadItems', store.loadItems],
    ['loadTransferRules', store.loadTransferRules],
  ]) {
    const pg = fakePg();
    await fn(pg, 'wolfhouse-somo');
    const call = pg.calls[0];
    ok(`${name} filters on client_slug`,
      /client_slug\s*=\s*\$1/.test(call.text) && call.params[0] === 'wolfhouse-somo');
    ok(`${name} reads only active rows`, /active\s*=\s*true/.test(call.text));

    let rejected = false;
    try { await fn(fakePg(), 'sunset'); } catch (err) {
      rejected = err.message === 'tenant_scope_violation';
    }
    ok(`${name} refuses a Sunset slug`, rejected);
  }

  const delPg = fakePg([[{ id: 'i1' }], []]);
  await store.deactivateItem(delPg, 'wolfhouse-somo', 'rental', 'longboard_rental', null);
  ok('retiring an item also retires its prices',
    delPg.calls.length === 2
    && /UPDATE wh_pricing_items/.test(delPg.calls[0].text)
    && /UPDATE wh_pricing_rules/.test(delPg.calls[1].text));
  ok('retiring an item catches its duration variants',
    /item_code LIKE/.test(delPg.calls[1].text));

  const seasonPg = fakePg([[], [{ id: 's1' }]]);
  await store.saveSeason(seasonPg, 'wolfhouse-somo', {
    code: 'august', label: 'August', priority: 10, bookable: true,
    ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }],
  }, null);
  ok('saving a new season inserts the season then its ranges',
    /INSERT INTO wh_pricing_seasons/.test(seasonPg.calls[1].text)
    && /INSERT INTO wh_pricing_season_ranges/.test(seasonPg.calls[2].text));

  const editPg = fakePg([[{ id: 's1' }]]);
  await store.saveSeason(editPg, 'wolfhouse-somo', {
    code: 'august', label: 'August', priority: 10, bookable: true,
    ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }],
  }, null);
  ok('editing a season rewrites its ranges wholesale',
    /UPDATE wh_pricing_seasons/.test(editPg.calls[1].text)
    && /DELETE FROM wh_pricing_season_ranges/.test(editPg.calls[2].text)
    && /INSERT INTO wh_pricing_season_ranges/.test(editPg.calls[3].text));

  const rulePg = fakePg([[]]);
  await store.savePriceRule(rulePg, 'wolfhouse-somo', {
    item_type: 'package', item_code: 'malibu', season_code: 'august',
    unit: 'per_person_per_week', amount_cents: 34900, currency: 'EUR', active: true,
  }, null);
  ok('every price write is parameterised, never interpolated',
    rulePg.calls.every((c) => !/\$\{/.test(c.text) && c.params.length > 0));
  ok('a new price row carries the client slug',
    rulePg.calls[1].params[0] === 'wolfhouse-somo');
}

// ── Routes (fake deps, no server, no database) ───────────────────────────────

const { createWolfhousePricingRoutes } = require('./lib/wolfhouse-pricing-routes');

/** Fake pg that answers by statement shape so store writes can run offline. */
function routeFakePg() {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params: params || [] });
      if (/information_schema/i.test(text)) return { rows: [{ n: 4 }], rowCount: 1 };
      if (/^\s*SELECT id FROM/i.test(text)) return { rows: [], rowCount: 0 };
      if (/RETURNING/i.test(text)) return { rows: [{ id: 'new-id' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

function harness(options) {
  const opts = options || {};
  const sent = [];
  const pg = opts.pg || routeFakePg();
  const routes = createWolfhousePricingRoutes({
    sendJSON: (res, status, body) => { sent.push({ status, body }); return body; },
    send400: (res, message) => {
      sent.push({ status: 400, body: { success: false, error: message } });
    },
    readBody: async () => JSON.stringify(opts.body == null ? {} : opts.body),
    assertStaffClientAccess: opts.accessAllowed === false
      ? (u, slug, res) => { sent.push({ status: 403, body: { error: 'client_access_denied' } }); return false; }
      : () => true,
    appendAuditLog: () => {},
    withPgClient: async (fn) => fn(pg),
    DEFAULT_CLIENT: 'wolfhouse-somo',
    SQL_INJECT_RE: /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i,
    STAFF_AUTH_REQUIRED: true,
    resolveStaffRole: (u) => String((u && u.role) || '').toLowerCase(),
  });
  return { routes, sent, pg };
}

async function withWriteFlag(value, fn) {
  const prev = process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED;
  if (value == null) delete process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED;
  else process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = value;
  try { return await fn(); } finally {
    if (prev == null) delete process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED;
    else process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = prev;
  }
}

async function runRouteChecks() {
  console.log('\n── Routes ──');

  const { routes } = harness();

  ok('GET base path resolves a handler',
    typeof routes.match('/staff/admin/wh/pricing', 'GET') === 'function');
  ok('PUT seasons resolves a handler',
    typeof routes.match('/staff/admin/wh/pricing/seasons', 'PUT') === 'function');
  ok('DELETE season by code resolves a handler',
    typeof routes.match('/staff/admin/wh/pricing/seasons/august', 'DELETE') === 'function');
  ok('DELETE item by type and code resolves a handler',
    typeof routes.match('/staff/admin/wh/pricing/items/rental/longboard_rental', 'DELETE') === 'function');
  ok('PUT prices and transfers resolve handlers',
    typeof routes.match('/staff/admin/wh/pricing/prices', 'PUT') === 'function'
    && typeof routes.match('/staff/admin/wh/pricing/transfers', 'PUT') === 'function');
  ok('an unrelated path is not claimed',
    routes.match('/staff/admin/config', 'GET') === null
    && routes.match('/staff/admin/wh/pricing', 'PATCH') === null);

  // Regression guard: the Wolfhouse dispatch sits ahead of Sunset's admin routes
  // in the monolith router, so it must never claim one of them.
  const SUNSET_ADMIN_PATHS = [
    '/staff/admin/config',
    '/staff/admin/config/prices',
    '/staff/admin/config/prices/group-availability',
    '/staff/admin/config/rental-offerings',
    '/staff/admin/config/lesson-capacity',
    '/staff/admin/config/course-equipment',
    '/staff/admin/config/private-lesson',
    '/staff/admin/config/full-day-equipment-addon',
    '/staff/admin/config/accommodation',
    '/staff/admin/config/surf-packs',
    '/staff/admin/config/lesson-times',
    '/staff/admin/services',
    '/staff/admin/services/abc',
    '/staff/admin/house-notes',
    '/staff/admin/bookings',
    '/staff/admin/finance/summary',
    '/staff/whatsapp-numbers',
  ];
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  let claimed = null;
  for (const p of SUNSET_ADMIN_PATHS) {
    for (const m of METHODS) {
      if (routes.match(p, m)) claimed = `${m} ${p}`;
    }
  }
  ok('no Sunset admin route is ever claimed by the Wolfhouse dispatch',
    claimed === null, claimed ? `claimed ${claimed}` : '');

  // Reads
  const readHarness = harness();
  await withWriteFlag(null, () => readHarness.routes.handleWhPricingGet(
    { client: 'wolfhouse-somo' }, {}, {}, { role: 'admin', staff_user_id: 'u1' },
  ));
  const read = readHarness.sent[0];
  ok('a read succeeds with the write flag off', read.status === 200 && read.body.success === true);
  ok('a read reports writes as disabled', read.body.writes_enabled === false);
  ok('a read returns seasons even without a catalog overlay',
    Array.isArray(read.body.packages)
    && Array.isArray(read.body.seasons) && read.body.seasons.length > 0);

  const wrongClient = harness();
  await wrongClient.routes.handleWhPricingGet(
    { client: 'sunset' }, {}, {}, { role: 'admin' },
  );
  ok('a Sunset slug gets 404 unsupported_client',
    wrongClient.sent[0].status === 404
    && wrongClient.sent[0].body.error === 'unsupported_client');

  const injected = harness();
  await injected.routes.handleWhPricingGet({ client: "wolf';DROP" }, {}, {}, { role: 'admin' });
  ok('an injection attempt in the client slug is rejected', injected.sent[0].status === 400);

  const denied = harness({ accessAllowed: false });
  await denied.routes.handleWhPricingGet(
    { client: 'wolfhouse-somo' }, {}, {}, { role: 'admin' },
  );
  ok('a staff user without Wolfhouse access is refused',
    denied.sent[0].status === 403);

  // Reads survive a broken overlay
  const brokenPg = { async query() { throw new Error('relation does not exist'); } };
  const brokenHarness = harness({ pg: brokenPg });
  await brokenHarness.routes.handleWhPricingGet(
    { client: 'wolfhouse-somo' }, {}, {}, { role: 'admin' },
  );
  const broken = brokenHarness.sent[0];
  ok('a read still succeeds when the overlay is unreadable', broken.status === 200);
  ok('a degraded read says so instead of pretending',
    broken.body.overlay_available === false && !!broken.body.overlay_error);
  ok('a degraded read still serves seasons from config',
    Array.isArray(broken.body.seasons) && broken.body.seasons.length > 0
    && Array.isArray(broken.body.packages) && broken.body.packages.length === 0);

  // Writes are gated
  const flagOff = harness({ body: { code: 'x', label: 'X', ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }] } });
  await withWriteFlag(null, () => flagOff.routes.handleWhPricingSeasonPut(
    { client: 'wolfhouse-somo' }, {}, {}, { role: 'admin' },
  ));
  ok('a write with the flag off is refused',
    flagOff.sent[0].status === 403 && flagOff.sent[0].body.error === 'writes_disabled');

  const lowRole = harness({ body: { code: 'x', label: 'X', ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }] } });
  await withWriteFlag('true', () => lowRole.routes.handleWhPricingSeasonPut(
    { client: 'wolfhouse-somo' }, {}, {}, { role: 'operator' },
  ));
  ok('an operator cannot write prices',
    lowRole.sent[0].status === 403 && lowRole.sent[0].body.error === 'forbidden_role');

  const badBody = harness({ body: { code: 'x', label: 'X', ranges: [] } });
  await withWriteFlag('true', () => badBody.routes.handleWhPricingSeasonPut(
    { client: 'wolfhouse-somo' }, {}, {}, { role: 'admin' },
  ));
  ok('a season with no ranges is rejected at the route',
    badBody.sent[0].status === 400);

  const goodSeason = harness({
    body: {
      code: 'shoulder', label: 'Shoulder', priority: 5,
      ranges: [{ start_month: 3, start_day: 1, end_month: 3, end_day: 31 }],
    },
  });
  await withWriteFlag('true', () => goodSeason.routes.handleWhPricingSeasonPut(
    { client: 'wolfhouse-somo' }, {}, {}, { role: 'admin', staff_user_id: 'u1' },
  ));
  ok('a valid season save returns 200 with the fresh view',
    goodSeason.sent[0].status === 200 && goodSeason.sent[0].body.success === true
    && Array.isArray(goodSeason.sent[0].body.seasons));
  ok('a season save writes the season and its ranges',
    goodSeason.pg.calls.some((c) => /INSERT INTO wh_pricing_seasons/.test(c.text))
    && goodSeason.pg.calls.some((c) => /INSERT INTO wh_pricing_season_ranges/.test(c.text)));

  const goodPrice = harness({
    body: {
      item_type: 'package', item_code: 'malibu', season_code: 'august',
      unit: 'per_person_per_week', amount_eur: '375,00',
    },
  });
  await withWriteFlag('1', () => goodPrice.routes.handleWhPricingPricePut(
    { client: 'wolfhouse-somo' }, {}, {}, { role: 'owner', staff_user_id: 'u1' },
  ));
  ok('a price save accepts euros and stores cents',
    goodPrice.sent[0].status === 200
    && goodPrice.pg.calls.some((c) => c.params.includes(37500)));

  const badPrice = harness({
    body: { item_type: 'rental', item_code: 'x', unit: 'per_day', amount_cents: 0 },
  });
  await withWriteFlag('true', () => badPrice.routes.handleWhPricingPricePut(
    { client: 'wolfhouse-somo' }, {}, {}, { role: 'admin' },
  ));
  ok('a zero rental price is rejected at the route', badPrice.sent[0].status === 400);

  const transferSave = harness({
    body: {
      airport_code: 'OVD', label: 'Asturias', requires_package: true,
      unavailable_no_package_message: 'Package bookings only.',
    },
  });
  await withWriteFlag('true', () => transferSave.routes.handleWhPricingTransferPut(
    { client: 'wolfhouse-somo' }, {}, {}, { role: 'admin', staff_user_id: 'u1' },
  ));
  ok('a new airport can be added', transferSave.sent[0].status === 200);

  const transferNoCopy = harness({
    body: { airport_code: 'OVD', label: 'Asturias', min_guest_count: 4 },
  });
  await withWriteFlag('true', () => transferNoCopy.routes.handleWhPricingTransferPut(
    { client: 'wolfhouse-somo' }, {}, {}, { role: 'admin' },
  ));
  ok('an airport with a group minimum needs refusal copy',
    transferNoCopy.sent[0].status === 400);

  const itemDelete = harness();
  await withWriteFlag('true', () => itemDelete.routes.handleWhPricingItemDelete(
    'rental', 'longboard_rental', { client: 'wolfhouse-somo' }, {}, {}, { role: 'admin' },
  ));
  ok('retiring an item returns 200 and the refreshed view',
    itemDelete.sent[0].status === 200);

  const badItemDelete = harness();
  await withWriteFlag('true', () => badItemDelete.routes.handleWhPricingItemDelete(
    'transfer', 'sdr', { client: 'wolfhouse-somo' }, {}, {}, { role: 'admin' },
  ));
  ok('item delete refuses a type outside the catalog',
    badItemDelete.sent[0].status === 400);

  const badJsonSent = [];
  const badJsonRoutes = createWolfhousePricingRoutes({
    sendJSON: () => {},
    send400: (res, message) => { badJsonSent.push(message); },
    readBody: async () => '{not json',
    assertStaffClientAccess: () => true,
    appendAuditLog: () => {},
    withPgClient: async (fn) => fn(routeFakePg()),
    DEFAULT_CLIENT: 'wolfhouse-somo',
    SQL_INJECT_RE: /['";\\]|--/i,
    STAFF_AUTH_REQUIRED: true,
    resolveStaffRole: () => 'admin',
  });
  await withWriteFlag('true', () => badJsonRoutes.handleWhPricingSeasonPut(
    { client: 'wolfhouse-somo' }, {}, {}, { role: 'admin' },
  ));
  ok('a malformed JSON body is rejected, not thrown',
    badJsonSent.length === 1 && /invalid JSON body/.test(badJsonSent[0]));
}

// ── Browser UI (real module in a vm, minimal DOM shim) ──────────────────────

const vm = require('vm');

/**
 * Smallest DOM the pricing module touches. Renders are string assembly, so an
 * innerHTML sink plus getElementById is enough to assert real output without
 * pulling in a browser or jsdom (neither is installable in this gate).
 */
function fakeDom() {
  const elements = new Map();
  function makeEl(id) {
    return {
      id,
      innerHTML: '',
      value: '',
      checked: false,
      readOnly: false,
      dataset: {},
      addEventListener() {},
      contains() { return true; },
      querySelectorAll() { return []; },
      querySelector() { return null; },
    };
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    },
  };
  return { document, elements };
}

function runPricingUi(viewPayload, editing) {
  const dom = fakeDom();
  const sandbox = {
    window: {},
    document: dom.document,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    console,
    Promise,
    Number,
    encodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  const src = fs.readFileSync(
    path.join(ROOT, 'scripts/browser/wolfhouse-admin-pricing-ui.js'), 'utf8',
  );
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  sandbox.window.__whPricingStateForTest.view = viewPayload;
  if (editing) sandbox.window.__whPricingStateForTest.editing = editing;
  sandbox.window.__whPricingRenderForTest();
  return {
    html: dom.document.getElementById('wh-admin-pricing-body').innerHTML,
    window: sandbox.window,
  };
}

function uiChecks() {
  console.log('\n── Browser UI ──');

  const writable = Object.assign({}, view, {
    writes_enabled: true,
    packages: viewPromotedPackages.packages,
  });
  const { html, window: win } = runPricingUi(writable);

  ok('the module exposes its entry point',
    typeof win.loadWolfhouseAdminPricing === 'function');
  ok('rendering produces markup', html.length > 500);

  for (const [label, needle] of [
    ['Seasons', 'Seasons'],
    ['Packages', 'Packages'],
    ['Rentals', 'Rentals'],
    ['Services', 'Services'],
    ['Transfers', 'Transfers'],
    ['Extras', 'Extras'],
  ]) {
    ok(`the ${label} section renders`, html.includes(`>${needle}<`));
  }

  ok('the full-day extension gets its own section',
    html.includes('Full day') && html.includes('Full-day extension'));

  ok('a package price renders as euros, not cents',
    html.includes('€349.00') && !html.includes('34900'));
  ok('the August season is shown by name', html.includes('August'));
  ok('the closed season is marked closed', html.includes('closed'));
  ok('a season with no price shows Not set, never €0.00',
    html.includes('Not set'));
  ok('recurring ranges render as month and day', /Aug 1\s*–\s*Aug 31/.test(html));
  ok('a transfer shows its airport code', html.includes('(SDR)'));
  ok('Bilbao surfaces its group minimum', html.includes('min group') && html.includes('4'));
  ok('deposits render in euros',
    runPricingUi(Object.assign({}, viewPromotedCatalog, { writes_enabled: true })).html.includes('€200.00'));
  ok('the private room supplement renders',
    runPricingUi(Object.assign({}, viewPromotedCatalog, { writes_enabled: true })).html.includes('€10.00'));
  ok('promoted extras offer Delete inside the edit panel',
    runPricingUi(Object.assign({}, viewPromotedCatalog, { writes_enabled: true }), 'price:deposit:standard_package').html
      .includes('data-wh-item-type="deposit"')
    && !runPricingUi(Object.assign({}, viewPromotedCatalog, { writes_enabled: true })).html
      .includes('data-wh-price-action="delete-item"'));
  ok('deposit edit offers per-booking and per-person radios',
    runPricingUi(Object.assign({}, viewPromotedCatalog, { writes_enabled: true }), 'price:deposit:standard_package').html
      .includes('name="wh-deposit-scope"')
    && runPricingUi(Object.assign({}, viewPromotedCatalog, { writes_enabled: true }), 'price:deposit:standard_package').html
      .includes('Per booking')
    && runPricingUi(Object.assign({}, viewPromotedCatalog, { writes_enabled: true }), 'price:deposit:standard_package').html
      .includes('Per person'));
  ok('editable mode offers Add extras',
    html.includes('data-wh-price-action="new-extra"'));
  ok('the new-extra form asks for type, amount, and deposit scope',
    runPricingUi(writable, 'item:extra:__new__').html.includes('wh-price-extra-kind')
    && runPricingUi(writable, 'item:extra:__new__').html.includes('wh-price-item-amount')
    && runPricingUi(writable, 'item:extra:__new__').html.includes('name="wh-deposit-scope"')
    && runPricingUi(writable, 'item:extra:__new__').html.includes('save-new-extra'));

  ok('editable mode offers Edit controls',
    html.includes('data-wh-price-action="edit-package-price"'));
  ok('editable mode offers Add season and Add airport',
    html.includes('data-wh-price-action="new-season"')
    && html.includes('data-wh-price-action="new-transfer"'));
  ok('editable mode offers Add rental and Add service',
    html.includes('data-wh-item-type="rental"') && html.includes('data-wh-item-type="service"'));
  ok('editable mode offers Add package',
    html.includes('data-wh-price-action="new-item" data-wh-item-type="package"'));
  ok('no read-only banner when writes are on',
    !html.includes('Read-only'));

  // A config-seeded item cannot be deleted — the JSON seed re-adds it — so the
  // portal must not show a Delete that quietly does nothing.
  ok('a promoted package can be deleted from its edit panel',
    runPricingUi(writable, 'item:package:malibu').html
      .includes('data-wh-item-type="package" data-wh-item-code="malibu"')
    && !html.includes('data-wh-price-action="delete-item"'));
  ok('closed packages show a pencil, not Delete',
    html.includes('data-wh-price-action="edit-package"')
    && html.includes('aria-label="Edit"'));
  ok('the new-package form offers pebble colors in a dropdown',
    runPricingUi(writable, 'item:package:__new__').html.includes('id="wh-price-item-pebble"')
    && runPricingUi(writable, 'item:package:__new__').html.includes('wh-price-pebble-dd')
    && runPricingUi(writable, 'item:package:__new__').html.includes('pkg-pebble-sage')
    && runPricingUi(writable, 'item:package:__new__').html.includes('pick-pebble')
    && !runPricingUi(writable, 'item:package:__new__').html.includes('<select id="wh-price-item-pebble"'));
  ok('each package offers a pencil to open edit',
    html.includes('data-wh-price-action="edit-package"')
    && html.includes('data-wh-item-code="malibu"'));
  ok('package edit can change pebble color',
    runPricingUi(writable, 'item:package:malibu').html.includes('id="wh-price-item-pebble"')
    && runPricingUi(writable, 'item:package:malibu').html.includes('save-package-item'));
  ok('create package asks for minimum days and daily proration',
    runPricingUi(writable, 'item:package:__new__').html.includes('wh-price-item-min-days')
    && runPricingUi(writable, 'item:package:__new__').html.includes('wh-price-item-prorate'));
  ok('edit package asks for minimum days and daily proration',
    runPricingUi(writable, 'item:package:malibu').html.includes('wh-price-item-min-days')
    && runPricingUi(writable, 'item:package:malibu').html.includes('Allow daily proration'));
  ok('a config-sourced transfer is labelled default',
    html.includes('default'));

  const newPackageForm = runPricingUi(writable, 'item:package:__new__').html;
  ok('the new-package form asks for a name and a code',
    newPackageForm.includes('wh-price-item-label')
    && newPackageForm.includes('wh-price-item-code'));
  ok('the new-package form asks for no single amount',
    !newPackageForm.includes('wh-price-item-amount')
    && newPackageForm.includes('data-wh-price-action="save-new-item"'));
  ok('the new-rental form still asks for a unit and an amount',
    runPricingUi(writable, 'item:rental:__new__').html.includes('wh-price-item-amount'));

  // Read-only mode
  const readOnly = runPricingUi(Object.assign({}, view, {
    writes_enabled: false,
    packages: viewPromotedPackages.packages,
  })).html;
  ok('read-only mode explains itself', readOnly.includes('Read-only'));
  ok('read-only mode hides every write control',
    !readOnly.includes('data-wh-price-action="edit-package-price"')
    && !readOnly.includes('data-wh-price-action="new-season"')
    && !readOnly.includes('data-wh-price-action="delete-season"'));
  ok('read-only mode still shows the prices', readOnly.includes('€349.00'));

  // Degraded overlay
  const degraded = runPricingUi(Object.assign({}, view, {
    writes_enabled: true, overlay_available: false, overlay_error: 'relation does not exist',
  })).html;
  ok('a degraded overlay warns the operator',
    degraded.includes('built-in prices only'));

  // Edited vs default provenance
  const edited = runPricingUi(Object.assign({}, viewWithDb, { writes_enabled: true })).html;
  ok('an edited price is labelled edited', edited.includes('>edited<'));
  ok('a shipped default is labelled default', edited.includes('>default<'));
  ok('the edited August price shows the new amount', edited.includes('€375.00'));
  ok('a staff-created rental can be deleted',
    edited.includes('data-wh-item-type="rental" data-wh-item-code="longboard_rental"'));

  // Escaping
  const hostile = JSON.parse(JSON.stringify(view));
  hostile.writes_enabled = true;
  hostile.seasons[0].label = '<img src=x onerror=alert(1)>';
  const escaped = runPricingUi(hostile).html;
  ok('a hostile season label is escaped, not injected',
    !escaped.includes('<img src=x') && escaped.includes('&lt;img src=x'));

  // Comments mention Sunset's namespace to explain the separation, so compare
  // against code only.
  const uiCode = fs.readFileSync(
    path.join(ROOT, 'scripts/browser/wolfhouse-admin-pricing-ui.js'), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('the UI never targets Sunset admin ids or actions',
    !/data-admin-action|admin-sunset-shell|#admin-tab-/.test(uiCode));
  ok('the UI only calls its own Wolfhouse endpoints',
    (uiCode.match(/'\/staff\/[a-z/-]*'/g) || []).every((p) => p === "'/staff/admin/wh/pricing'"));
}

// ── Tenant isolation ────────────────────────────────────────────────────────
function tenantIsolationChecks() {
console.log('\n── Tenant isolation ──');

const resolveSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/wolfhouse-pricing-resolve.js'), 'utf8');
const writesSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/wolfhouse-pricing-writes.js'), 'utf8');
const storeSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/wolfhouse-pricing-store.js'), 'utf8');
const SUNSET_MODULES = /require\(['"]\.\/(tenant-admin-writes|tenant-business-config|sunset-admin-[a-z-]+)['"]\)/;

ok('the resolver does not require any Sunset admin module',
  !SUNSET_MODULES.test(resolveSrc));
ok('the write layer does not require any Sunset admin module',
  !SUNSET_MODULES.test(writesSrc));
const routesSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/wolfhouse-pricing-routes.js'), 'utf8');
ok('the store does not require any Sunset admin module',
  !SUNSET_MODULES.test(storeSrc));
ok('the routes do not require any Sunset admin module',
  !SUNSET_MODULES.test(routesSrc));
ok('the routes never call Sunset\'s admin write gate',
  !/evaluateAdminWriteGate/.test(routesSrc));
ok('every Wolfhouse route lives under /staff/admin/wh/',
  (routesSrc.match(/'\/staff\/[a-z/-]*'/g) || [])
    .every((p) => p.startsWith("'/staff/admin/wh/")));
ok('no Wolfhouse pricing rule can be written against a Sunset table',
  !/tenant_price_rules|tenant_surf_pack_rules|tenant_rental_offerings/.test(
    resolveSrc + writesSrc + storeSrc));
ok('every store table is wh_pricing-prefixed',
  (storeSrc.match(/(?:INTO|UPDATE|FROM|TABLE IF NOT EXISTS)\s+([a-z_]+)/g) || [])
    .map((m) => m.split(/\s+/).pop())
    .filter((t) => t !== 'information_schema')
    .every((t) => t.startsWith('wh_pricing_')));

// The repo-wide tenant-scope scanner only watches a fixed list of shared
// tables, so it will never notice a client_slug filter dropped from one of
// these new ones. This gate is the only thing standing between a future edit
// and a cross-tenant read, so it checks every statement individually.
const storeStatements = (storeSrc.match(/`[^`]*`|'[^']*'/g) || [])
  .filter((s) => /wh_pricing_/.test(s))
  .filter((s) => /\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(s))
  .filter((s) => !/CREATE TABLE/i.test(s))
  // Reads catalog metadata, not tenant rows, so it carries no client filter.
  .filter((s) => !/information_schema/i.test(s));
ok('the store exposes statements to check', storeStatements.length >= 15);
const unscopedStatements = storeStatements.filter((s) => !/client_slug/.test(s));
ok('every store statement filters on client_slug',
  unscopedStatements.length === 0,
  unscopedStatements[0]);

// ── Migration ───────────────────────────────────────────────────────────────
console.log('\n── Migration ──');

const migrationPath = path.join(ROOT, 'database/migrations/076_wolfhouse_pricing_admin.sql');
const downPath = path.join(ROOT, 'database/migrations/076_wolfhouse_pricing_admin_down.sql');
ok('migration 076 exists', fs.existsSync(migrationPath));
ok('migration 076 has a down companion', fs.existsSync(downPath));

const migrationSql = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8') : '';
const migrationDdl = migrationSql.replace(/^--.*$/gm, '');
for (const table of [
  'wh_pricing_seasons', 'wh_pricing_season_ranges', 'wh_pricing_items',
  'wh_pricing_rules', 'wh_pricing_transfer_rules',
]) {
  ok(`migration creates ${table}`,
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`).test(migrationSql));
}
ok('migration is idempotent (no bare CREATE TABLE)',
  !/CREATE TABLE (?!IF NOT EXISTS)/.test(migrationDdl));
ok('migration ships no data writes',
  !/^\s*(INSERT|UPDATE|DELETE)\s/im.test(migrationDdl));
ok('migration never touches a Sunset pricing table',
  !/tenant_price_rules|tenant_surf_pack_rules|tenant_rental_offerings/.test(migrationDdl));

const downSql = fs.existsSync(downPath) ? fs.readFileSync(downPath, 'utf8') : '';
ok('down migration refuses to drop non-empty pricing tables',
  /RAISE EXCEPTION/.test(downSql) && /wh_pricing_rules/.test(downSql));

ok('the runtime twin creates the same tables as the migration',
  ['wh_pricing_seasons', 'wh_pricing_season_ranges', 'wh_pricing_items',
    'wh_pricing_rules', 'wh_pricing_transfer_rules']
    .every((t) => new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`).test(store.CREATE_SQL)));
}

runStoreChecks()
  .then(runRouteChecks)
  .then(() => {
    uiChecks();
    tenantIsolationChecks();
    console.log(`\n── wolfhouse-admin-pricing: ${passed} passed, ${failed} failed ──\n`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error('\nverify crashed:', err);
    process.exit(1);
  });
