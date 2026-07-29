'use strict';

/**
 * verify:sunset-rental-duration-model — the (unit,count) ⇄ duration_key bridge
 * for the generic Equipment Pricing tab (Slice 1). Pure; no DB/network.
 */
const m = require('./browser/sunset-rental-duration-model');

let pass = 0, fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; return; }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\nverify:sunset-rental-duration-model\n');

console.log('[parse] legacy + generic keys → {unit,count}');
assert('half_day → 12 hours', eq(m.parseRentalDurationKey('half_day'), { unit: 'hours', count: 12 }));
assert('full_day → 1 day', eq(m.parseRentalDurationKey('full_day'), { unit: 'days', count: 1 }));
assert('1_hour → 1 hour', eq(m.parseRentalDurationKey('1_hour'), { unit: 'hours', count: 1 }));
assert('2_hours → 2 hours', eq(m.parseRentalDurationKey('2_hours'), { unit: 'hours', count: 2 }));
assert('3_hours → 3 hours (generic)', eq(m.parseRentalDurationKey('3_hours'), { unit: 'hours', count: 3 }));
assert('1_day → 1 day', eq(m.parseRentalDurationKey('1_day'), { unit: 'days', count: 1 }));
assert('5_days → 5 days', eq(m.parseRentalDurationKey('5_days'), { unit: 'days', count: 5 }));
assert('garbage → null', m.parseRentalDurationKey('lolwut') === null);
assert('empty → null', m.parseRentalDurationKey('') === null);
assert('zero count → null', m.parseRentalDurationKey('0_days') === null);

console.log('\n[serialize] {unit,count} → canonical booking-compatible key');
assert('(hours,12) → half_day (stays in line)', m.rentalDurationKeyFromUnitCount('hours', 12) === 'half_day');
assert('(days,1) → 1_day (booking-compatible)', m.rentalDurationKeyFromUnitCount('days', 1) === '1_day');
assert('(hours,1) → 1_hour', m.rentalDurationKeyFromUnitCount('hours', 1) === '1_hour');
assert('(hours,2) → 2_hours', m.rentalDurationKeyFromUnitCount('hours', 2) === '2_hours');
assert('(hours,3) → 3_hours (generic)', m.rentalDurationKeyFromUnitCount('hours', 3) === '3_hours');
assert('(days,3) → 3_days', m.rentalDurationKeyFromUnitCount('days', 3) === '3_days');
assert('bad unit → ""', m.rentalDurationKeyFromUnitCount('weeks', 2) === '');
assert('bad count → ""', m.rentalDurationKeyFromUnitCount('days', 0) === '');

console.log('\n[round-trip] parse ∘ serialize is stable on canonical keys');
for (const key of ['half_day', '1_day', '2_days', '7_days', '1_hour', '2_hours', '3_hours']) {
  const uc = m.parseRentalDurationKey(key);
  const back = m.rentalDurationKeyFromUnitCount(uc.unit, uc.count);
  assert(`${key} ⇄ (${uc.unit},${uc.count}) ⇄ ${back}`, back === key, back);
}
// full_day folds into 1_day (the one intentional normalization).
const fd = m.parseRentalDurationKey('full_day');
assert('full_day folds to 1_day on serialize', m.rentalDurationKeyFromUnitCount(fd.unit, fd.count) === '1_day');

console.log('\n[format] labels');
assert('12 hours', m.formatRentalDuration('hours', 12) === '12 hours');
assert('1 day (singular)', m.formatRentalDuration('days', 1) === '1 day');
assert('3 days', m.formatRentalDuration('days', 3) === '3 days');
assert('1 hour (singular)', m.formatRentalDuration('hours', 1) === '1 hour');
assert('half_day key → "12 hours"', m.formatRentalDurationKey('half_day') === '12 hours');

console.log(`\n── verify:sunset-rental-duration-model ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass}/${pass + fail}) ──\n`);
process.exit(fail > 0 ? 1 : 0);
