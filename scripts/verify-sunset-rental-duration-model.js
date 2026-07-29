'use strict';

/**
 * verify:sunset-rental-duration-model — the (unit,count) ⇄ duration_key bridge
 * for the generic Equipment Pricing tab. Pure; no DB/network.
 *
 * RED→GREEN contract:
 *   - NEW writes are fully generic (1_hour / N_hours / 1_day / N_days)
 *   - 12 hours serializes to 12_hours (never half_day)
 *   - half_day / full_day remain historical READ aliases only
 *   - count range 1..999
 */
const fs = require('fs');
const path = require('path');
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
assert('half_day → 12 hours (historical read)', eq(m.parseRentalDurationKey('half_day'), { unit: 'hours', count: 12 }));
assert('full_day → 1 day (historical read)', eq(m.parseRentalDurationKey('full_day'), { unit: 'days', count: 1 }));
assert('1_hour → 1 hour', eq(m.parseRentalDurationKey('1_hour'), { unit: 'hours', count: 1 }));
assert('2_hours → 2 hours', eq(m.parseRentalDurationKey('2_hours'), { unit: 'hours', count: 2 }));
assert('12_hours → 12 hours', eq(m.parseRentalDurationKey('12_hours'), { unit: 'hours', count: 12 }));
assert('36_hours → 36 hours', eq(m.parseRentalDurationKey('36_hours'), { unit: 'hours', count: 36 }));
assert('999_hours → 999 hours', eq(m.parseRentalDurationKey('999_hours'), { unit: 'hours', count: 999 }));
assert('3_hours → 3 hours (generic)', eq(m.parseRentalDurationKey('3_hours'), { unit: 'hours', count: 3 }));
assert('1_day → 1 day', eq(m.parseRentalDurationKey('1_day'), { unit: 'days', count: 1 }));
assert('5_days → 5 days', eq(m.parseRentalDurationKey('5_days'), { unit: 'days', count: 5 }));
assert('8_days → 8 days', eq(m.parseRentalDurationKey('8_days'), { unit: 'days', count: 8 }));
assert('garbage → null', m.parseRentalDurationKey('lolwut') === null);
assert('empty → null', m.parseRentalDurationKey('') === null);
assert('zero count → null', m.parseRentalDurationKey('0_days') === null);
assert('1000_hours over max → null', m.parseRentalDurationKey('1000_hours') === null);

console.log('\n[serialize] {unit,count} → canonical generic write keys');
assert('(hours,12) → 12_hours (NOT half_day)', m.rentalDurationKeyFromUnitCount('hours', 12) === '12_hours');
assert('(hours,36) → 36_hours', m.rentalDurationKeyFromUnitCount('hours', 36) === '36_hours');
assert('(hours,999) → 999_hours', m.rentalDurationKeyFromUnitCount('hours', 999) === '999_hours');
assert('(days,8) → 8_days', m.rentalDurationKeyFromUnitCount('days', 8) === '8_days');
assert('(days,1) → 1_day (booking-compatible)', m.rentalDurationKeyFromUnitCount('days', 1) === '1_day');
assert('(hours,1) → 1_hour', m.rentalDurationKeyFromUnitCount('hours', 1) === '1_hour');
assert('(hours,2) → 2_hours', m.rentalDurationKeyFromUnitCount('hours', 2) === '2_hours');
assert('(hours,3) → 3_hours (generic)', m.rentalDurationKeyFromUnitCount('hours', 3) === '3_hours');
assert('(days,3) → 3_days', m.rentalDurationKeyFromUnitCount('days', 3) === '3_days');
assert('bad unit → ""', m.rentalDurationKeyFromUnitCount('weeks', 2) === '');
assert('bad count 0 → ""', m.rentalDurationKeyFromUnitCount('days', 0) === '');
assert('count 1000 over max → ""', m.rentalDurationKeyFromUnitCount('hours', 1000) === '');

console.log('\n[round-trip] parse ∘ serialize stable on CANONICAL write keys');
for (const key of ['1_day', '2_days', '7_days', '8_days', '1_hour', '2_hours', '3_hours', '12_hours', '36_hours', '999_hours']) {
  const uc = m.parseRentalDurationKey(key);
  const back = m.rentalDurationKeyFromUnitCount(uc.unit, uc.count);
  assert(`${key} ⇄ (${uc.unit},${uc.count}) ⇄ ${back}`, back === key, back);
}
// Historical aliases: parseable, but serialize to canonical write form.
const hd = m.parseRentalDurationKey('half_day');
assert('half_day parse → serialize → 12_hours (rewrite canonical)', m.rentalDurationKeyFromUnitCount(hd.unit, hd.count) === '12_hours');
const fd = m.parseRentalDurationKey('full_day');
assert('full_day folds to 1_day on serialize', m.rentalDurationKeyFromUnitCount(fd.unit, fd.count) === '1_day');

console.log('\n[format] labels');
assert('12 hours', m.formatRentalDuration('hours', 12) === '12 hours');
assert('1 day (singular)', m.formatRentalDuration('days', 1) === '1 day');
assert('3 days', m.formatRentalDuration('days', 3) === '3 days');
assert('1 hour (singular)', m.formatRentalDuration('hours', 1) === '1 hour');
assert('half_day key → "12 hours" (historical label)', m.formatRentalDurationKey('half_day') === '12 hours');
assert('12_hours key → "12 hours"', m.formatRentalDurationKey('12_hours') === '12 hours');
assert('8_days key → "8 days"', m.formatRentalDurationKey('8_days') === '8 days');

console.log('\n[production writer] no 12→half_day fold in source');
const modelSrc = fs.readFileSync(path.join(__dirname, 'browser', 'sunset-rental-duration-model.js'), 'utf8');
assert("no `n === 12) return 'half_day'` in writer", !/n\s*===\s*12\s*\)\s*return\s*['"]half_day['"]/.test(modelSrc));
assert("writer docs say never half_day for 12", /never half_day/i.test(modelSrc) || /12_hours \(never half_day\)/.test(modelSrc));

console.log(`\n── verify:sunset-rental-duration-model ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass}/${pass + fail}) ──\n`);
process.exit(fail > 0 ? 1 : 0);
