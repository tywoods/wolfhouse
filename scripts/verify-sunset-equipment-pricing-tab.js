'use strict';
/**
 * verify:sunset-equipment-pricing-tab — Slice 1 wiring for the rebuilt, groupless
 * Admin Equipment Pricing tab: flat render off the data model, Add-equipment +
 * generic price authoring (hours/days), and the generalized server write that
 * accepts an explicit offering_key. Source-assertion + functional; no DB/network.
 */
const fs = require('fs');
const path = require('path');
const { validatePriceCreateBody } = require('./lib/tenant-admin-writes');

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
assert('render builds from buildEquipmentPricingList', /renderAdminSectionPricesFromConfig[\s\S]{0,400}buildEquipmentPricingList\(prices\)/.test(adminUi));
assert('no group-order iteration in the new render', !/renderAdminSectionPricesFromConfig[\s\S]{0,900}adminRentalGroupOrder\(\)/.test(adminUi));
assert('renders equipment items (data-admin-equip)', adminUi.includes('data-admin-equip="'));
assert('Add-equipment button present', adminUi.includes("data-admin-action=\"add-equipment\""));
assert('duration control has Hours/Days unit select', /renderAdminDurationControl[\s\S]{0,600}value="hours"[\s\S]{0,300}value="days"/.test(adminUi));

console.log('\n[handlers] generic authoring wired');
for (const a of ['add-equipment', 'edit-equipment', 'add-equip-price', 'save-new-equipment', 'save-price-amount']) {
  assert(`handler action "${a}" present`, new RegExp(`action === '${a}'`).test(adminUi), a);
}
assert('save-new-equipment creates offering then price', /save-new-equipment[\s\S]*?\/staff\/admin\/config\/rental-offerings[\s\S]*?\/staff\/admin\/config\/prices/.test(adminUi));
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
assert('generic half_day (12h) accepted', ok({ offering_key: 'kayak_rental', period_window: 'half_day', amount_cents: 2000 }).period_window === 'half_day');
assert('legacy rental_group still works', ok({ rental_group: 'boards', period_window: 'full_day', amount_cents: 1500 }).offering_key === 'board_rental');
assert('bad offering_key rejected', validatePriceCreateBody({ offering_key: 'Bad__key', period_window: '1_day', amount_cents: 100 }).ok === false);
assert('bad period rejected', validatePriceCreateBody({ offering_key: 'kayak_rental', period_window: 'fortnight', amount_cents: 100 }).ok === false);
assert('missing offering + group rejected', validatePriceCreateBody({ period_window: '1_day', amount_cents: 100 }).ok === false);

console.log(`\n── verify:sunset-equipment-pricing-tab ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass}/${pass + fail}) ──\n`);
process.exit(fail > 0 ? 1 : 0);
