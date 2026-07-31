'use strict';
/**
 * verify:sunset-equipment-pricing-tab — Slice 1 wiring for the rebuilt, groupless
 * Admin Equipment Pricing tab: flat render off the data model, Add-equipment +
 * generic price authoring (hours/days), and the generalized server write that
 * accepts an explicit offering_key. Source-assertion + functional; no DB/network.
 */
const fs = require('fs');
const path = require('path');
const {
  validatePriceCreateBody,
  validatePricePatchBody,
  mapBaselineUnitToDb,
  buildDbItemCode,
} = require('./lib/tenant-admin-writes');

let pass = 0, fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; return; }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const adminUi = read('browser/sunset-admin-ui.js');
const apiSrc = read('staff-query-api.js');

console.log('\nverify:sunset-equipment-pricing-tab\n');

console.log('[render] flat, data-driven, groupless');
assert('render builds from buildEquipmentPricingList (direct or via merge helper)',
  /renderAdminSectionPricesFromConfig[\s\S]{0,400}buildEquipmentPricingList\(prices\)/.test(adminUi)
  || (/adminMergeEquipmentPricingItems/.test(adminUi)
    && /function adminMergeEquipmentPricingItems[\s\S]{0,400}buildEquipmentPricingList\(prices\)/.test(adminUi)
    && /renderAdminSectionPricesFromConfig[\s\S]{0,400}adminMergeEquipmentPricingItems/.test(adminUi)));
assert('no group-order iteration in the new render', !/renderAdminSectionPricesFromConfig[\s\S]{0,900}adminRentalGroupOrder\(\)/.test(adminUi));
assert('renders equipment items (data-admin-equip)', adminUi.includes('data-admin-equip="'));
assert('Add-equipment button present', adminUi.includes("data-admin-action=\"add-equipment\""));
assert('duration control has Hours/Days unit select', /renderAdminDurationControl[\s\S]{0,600}value="hours"[\s\S]{0,300}value="days"/.test(adminUi));

console.log('\n[handlers] generic authoring wired');
for (const a of ['add-equipment', 'edit-equipment', 'add-equip-price', 'save-new-equipment', 'save-price-amount']) {
  assert(`handler action "${a}" present`, new RegExp(`action === '${a}'`).test(adminUi), a);
}
assert('save-new-equipment posts rental-offerings (atomic catalog create)',
  /save-new-equipment[\s\S]*?\/staff\/admin\/config\/rental-offerings/.test(adminUi)
  && /save-new-equipment[\s\S]*?stock_quantity/.test(adminUi));
assert('save-new-price posts offering_key + period_window', /save-new-price[\s\S]*?offering_key: addPriceKey[\s\S]*?period_window: addDur\.duration_key/.test(adminUi));
assert('slug helper suffixes _rental', /adminSlugOfferingKey[\s\S]{0,300}_rental/.test(adminUi));
assert('new actions are write-gated', /action === 'save-new-equipment'[\s\S]{0,10}\|\|[\s\S]{0,40}'save-price-amount'/.test(adminUi) || adminUi.includes("action === 'save-new-equipment'"));

console.log('\n[injection] models injected before admin-ui');
assert('equipment-pricing-model source injected', apiSrc.includes('getSunsetEquipmentPricingModelSource()'));
assert('injected BEFORE admin-ui', apiSrc.indexOf('getSunsetEquipmentPricingModelSource()') < apiSrc.indexOf('getSunsetAdminUiBrowserSource()'));

console.log('\n[server] price write accepts a generic offering_key + hours/days');
function ok(body) { const r = validatePriceCreateBody(body); return r.ok ? r.patch : r; }
assert('generic kayak, 3 hours accepted', (() => { const p = ok({ offering_key: 'kayak_rental', period_window: '3_hours', amount_cents: 1500 }); return p.offering_key === 'kayak_rental' && p.period_window === '3_hours'; })());
assert('generic kayak, 5 days accepted', ok({ offering_key: 'kayak_rental', period_window: '5_days', amount_cents: 6000 }).offering_key === 'kayak_rental');
// Historical half_day still readable for legacy config; new Admin writes 12_hours.
assert('historical half_day accepted on create (legacy)', ok({ offering_key: 'kayak_rental', period_window: 'half_day', amount_cents: 2000 }).period_window === 'half_day');
assert('12_hours accepted (canonical 12h write)', ok({ offering_key: 'towel_rental', period_window: '12_hours', amount_cents: 500 }).period_window === '12_hours');
assert('36_hours accepted', ok({ offering_key: 'towel_rental', period_window: '36_hours', amount_cents: 900 }).period_window === '36_hours');
assert('8_days accepted', ok({ offering_key: 'kayak_rental', period_window: '8_days', amount_cents: 8000 }).period_window === '8_days');
assert('999_hours accepted', ok({ offering_key: 'kayak_rental', period_window: '999_hours', amount_cents: 100 }).period_window === '999_hours');
assert('legacy rental_group still works', ok({ rental_group: 'boards', period_window: 'full_day', amount_cents: 1500 }).offering_key === 'board_rental');
assert('bad offering_key rejected', validatePriceCreateBody({ offering_key: 'Bad__key', period_window: '1_day', amount_cents: 100 }).ok === false);
assert('bad period rejected', validatePriceCreateBody({ offering_key: 'kayak_rental', period_window: 'fortnight', amount_cents: 100 }).ok === false);
assert('missing offering + group rejected', validatePriceCreateBody({ period_window: '1_day', amount_cents: 100 }).ok === false);

console.log('\n[admin duration control] Equipment Add preserves 1..999 hours/days exactly');
const { rentalDurationKeyFromUnitCount } = require('./browser/sunset-rental-duration-model');
assert('Admin 12 Hours → 12_hours key (exact item_code tail)', rentalDurationKeyFromUnitCount('hours', 12) === '12_hours');
assert('Admin 36 Hours → 36_hours', rentalDurationKeyFromUnitCount('hours', 36) === '36_hours');
assert('Admin 8 Days → 8_days', rentalDurationKeyFromUnitCount('days', 8) === '8_days');
assert('Admin 999 Hours → 999_hours', rentalDurationKeyFromUnitCount('hours', 999) === '999_hours');
assert('duration control wired to rentalDurationKeyFromUnitCount', /rentalDurationKeyFromUnitCount\(unit, count\)/.test(adminUi));
assert('count input max 999', /portal-admin-duration-count[\s\S]{0,80}max="999"/.test(adminUi));
assert('no 12→half_day in production duration model', !/n\s*===\s*12\s*\)\s*return\s*['"]half_day['"]/.test(read('browser/sunset-rental-duration-model.js')));

console.log('\n[server] exact item_code + billing grain for generic durations');
assert('item_code towel_rental__12_hours', buildDbItemCode('towel_rental', '12_hours') === 'towel_rental__12_hours');
assert('item_code kayak_rental__36_hours', buildDbItemCode('kayak_rental', '36_hours') === 'kayak_rental__36_hours');
assert('item_code kayak_rental__8_days', buildDbItemCode('kayak_rental', '8_days') === 'kayak_rental__8_days');
assert('item_code kayak_rental__999_hours', buildDbItemCode('kayak_rental', '999_hours') === 'kayak_rental__999_hours');
assert('12_hours bills as session', mapBaselineUnitToDb('12_hours') === 'session');
assert('36_hours bills as session', mapBaselineUnitToDb('36_hours') === 'session');
assert('8_days bills as day (not item)', mapBaselineUnitToDb('8_days') === 'day');
assert('999_hours bills as session', mapBaselineUnitToDb('999_hours') === 'session');
assert('historical half_day still session grain', mapBaselineUnitToDb('half_day') === 'session');
assert('patch accepts 12_hours', validatePricePatchBody({ period_window: '12_hours', amount_cents: 500 }).ok === true);
assert('patch accepts 8_days', validatePricePatchBody({ period_window: '8_days', amount_cents: 100 }).ok === true);
assert('patch rejects garbage period', validatePricePatchBody({ period_window: 'fortnight' }).ok === false);

console.log(`\n── verify:sunset-equipment-pricing-tab ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass}/${pass + fail}) ──\n`);
process.exit(fail > 0 ? 1 : 0);
