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
const rules = resolve.configPricingRules(config);

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

ok('private room supplement is 1000 per room per night',
  find('supplement', 'private', null).amount_cents === 1000
  && find('supplement', 'private', null).unit === 'per_room_per_night');

ok('the free shared room stays in the catalog at zero',
  find('supplement', 'shared', null).amount_cents === 0
  && find('supplement', 'shared', null).unit === 'per_person_per_night');

ok('a zero supplement is writable but a zero rental is not',
  writes.validatePriceRuleBody({
    item_type: 'supplement', item_code: 'shared', unit: 'per_room_per_night', amount_cents: 0,
  }).ok === true
  && writes.validatePriceRuleBody({
    item_type: 'rental', item_code: 'wetsuit_rental__1_day', unit: 'per_day', amount_cents: 0,
  }).ok === false);

ok('both deposit tiers are flattened',
  find('deposit', 'standard_package', null).amount_cents === 20000
  && find('deposit', 'custom_or_short_stay', null).amount_cents === 10000);

ok('gear add-ons flatten to rentals with a duration suffix',
  find('rental', 'wetsuit_rental__1_day', null).amount_cents === 500
  && find('rental', 'hard_board_rental__1_day', null).amount_cents === 2000
  && find('rental', 'wetsuit_soft_top_combo__1_day', null).amount_cents === 1500);

ok('non-gear add-ons flatten to services',
  find('service', 'yoga_class', null).amount_cents === 1500
  && find('service', 'yoga_class', null).unit === 'per_class');

ok('the multi-lesson bundle uses its price_cents_each',
  find('service', 'surf_lesson_multi', null).amount_cents === 3000);

ok('duplicated meal/meals fixture entries collapse to one service',
  rules.filter((r) => r.item_type === 'service' && r.item_code === 'meal').length === 1
  && find('service', 'meals', null) === null);

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
ok('the store does not require any Sunset admin module',
  !SUNSET_MODULES.test(storeSrc));
ok('no Wolfhouse pricing rule can be written against a Sunset table',
  !/tenant_price_rules|tenant_surf_pack_rules|tenant_rental_offerings/.test(
    resolveSrc + writesSrc + storeSrc));
ok('every store table is wh_pricing-prefixed',
  (storeSrc.match(/(?:INTO|UPDATE|FROM|TABLE IF NOT EXISTS)\s+([a-z_]+)/g) || [])
    .map((m) => m.split(/\s+/).pop())
    .filter((t) => t !== 'information_schema')
    .every((t) => t.startsWith('wh_pricing_')));

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
  .then(() => {
    tenantIsolationChecks();
    console.log(`\n── wolfhouse-admin-pricing: ${passed} passed, ${failed} failed ──\n`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error('\nverify crashed:', err);
    process.exit(1);
  });
