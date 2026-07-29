'use strict';
/**
 * verify:sunset-equipment-pricing-model — flat, groupless equipment list for the
 * rebuilt Admin Pricing tab (Slice 1). Pure; no DB/network.
 */
const { buildEquipmentPricingList, humanizeOfferingKey } = require('./browser/sunset-equipment-pricing-model');

let pass = 0, fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; return; }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

console.log('\nverify:sunset-equipment-pricing-model\n');

const prices = [
  { category: 'rental', offering_key: 'board_rental__full_day', amount_cents: 1500, active: true, label: 'Surfboard' },
  { category: 'rental', offering_key: 'board_rental__3_days', amount_cents: 4000, active: true },
  { category: 'rental', offering_key: 'wetsuit_rental__half_day', amount_cents: 800, active: true, label: 'Wetsuit' },
  { category: 'rental', offering_key: 'kayak_rental__3_hours', amount_cents: 1500, active: true, label: 'Kayak' },
  { category: 'rental', offering_key: 'kayak_rental__2_days', amount_cents: 4000, active: true, label: 'Kayak' },
  { category: 'rental', offering_key: 'kayak_rental__5_days', amount_cents: 9000, active: false, label: 'Kayak' }, // deleted → dropped
  { category: 'rental', offering_key: 'full_day_equipment_extension__day', amount_cents: 1000, active: true }, // excluded
  { category: 'lesson', offering_key: 'surf_pack_x__1_day', amount_cents: 9000, active: true }, // not rental
];

const items = buildEquipmentPricingList(prices);
const byKey = Object.fromEntries(items.map((i) => [i.offering_key, i]));

console.log('[flat list] every rental offering appears; add-on + lessons excluded');
assert('kayak_rental present (NOT dropped as non-canonical)', !!byKey.kayak_rental, JSON.stringify(items.map((i) => i.offering_key)));
assert('board + wetsuit folded in as items', !!byKey.board_rental && !!byKey.wetsuit_rental);
assert('full_day_equipment_extension excluded', !byKey.full_day_equipment_extension);
assert('lesson category excluded', !items.some((i) => i.offering_key.indexOf('surf_pack') >= 0));

console.log('\n[labels] hours/days duration model');
const kRows = byKey.kayak_rental.rows;
assert('kayak 3_hours → "3 hours"', kRows.some((r) => r.duration_key === '3_hours' && r.duration_label === '3 hours'), JSON.stringify(kRows));
assert('inactive kayak 5_days dropped (deleted = gone, uniform)', !kRows.some((r) => r.duration_key === '5_days'), JSON.stringify(kRows));
assert('active kayak 2_days kept', kRows.some((r) => r.duration_key === '2_days' && r.active === true));
assert('wetsuit half_day → "12 hours"', byKey.wetsuit_rental.rows.some((r) => r.duration_label === '12 hours'), JSON.stringify(byKey.wetsuit_rental.rows));
assert('board full_day → "1 day"', byKey.board_rental.rows.some((r) => r.duration_label === '1 day'));
assert('amount_cents surfaced', kRows.every((r) => typeof r.amount_cents === 'number'));

console.log('\n[order] all catalog items sort uniformly by display label; rows hours-before-days');
assert('equipment order has no legacy-key priority',
  items.map((i) => i.offering_key).join(',') === 'kayak_rental,board_rental,wetsuit_rental',
  JSON.stringify(items.map((i) => ({ key: i.offering_key, label: i.label }))));
assert('kayak rows: hours (3h) before days (2d)', kRows[0].duration_key === '3_hours' && kRows[kRows.length - 1].duration_key === '2_days', JSON.stringify(kRows.map((r) => r.duration_key)));

console.log('\n[labels fallback] humanize offering_key when no label given');
assert('board_rental → "Board"', humanizeOfferingKey('board_rental') === 'Board');
assert('kayak_rental → "Kayak"', humanizeOfferingKey('kayak_rental') === 'Kayak');
assert('board_and_suit_rental → "Board And Suit"', humanizeOfferingKey('board_and_suit_rental') === 'Board And Suit');

console.log('\n[empty] no rentals → empty list, not a crash');
assert('empty prices → []', buildEquipmentPricingList([]).length === 0);
assert('null → []', buildEquipmentPricingList(null).length === 0);

console.log(`\n── verify:sunset-equipment-pricing-model ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass}/${pass + fail}) ──\n`);
process.exit(fail > 0 ? 1 : 0);
