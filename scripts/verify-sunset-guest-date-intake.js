'use strict';

/**
 * verify:sunset-guest-date-intake
 *
 * Omitted-year date resolution for Sunset (Europe/Madrid).
 *
 * Run: node scripts/verify-sunset-guest-date-intake.js
 */

const {
  inferSunsetGuestYear,
  normalizeSunsetGuestDateField,
  normalizeSunsetBookingDatesInBody,
  madridCalendarParts,
  isValidGregorianDate,
} = require('./lib/sunset-guest-date-intake');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

const REF = new Date('2026-07-13T12:00:00Z');

console.log('\nverify:sunset-guest-date-intake\n');

console.log('[1] Madrid reference + inferYear');
const ref = madridCalendarParts(REF);
assert('reference 2026-07-13 Madrid', ref.year === 2026 && ref.month === 7 && ref.day === 13, JSON.stringify(ref));
assert('August 2 → 2026', normalizeSunsetGuestDateField('August 2', REF).iso === '2026-08-02');
assert('July 13 → 2026', normalizeSunsetGuestDateField('July 13', REF).iso === '2026-07-13');
assert('July 12 → 2027', normalizeSunsetGuestDateField('July 12', REF).iso === '2027-07-12');
assert('explicit August 2, 2027', normalizeSunsetGuestDateField('August 2, 2027', REF).iso === '2027-08-02');

console.log('\n[2] Invalid calendar dates need clarification');
assert('February 30 invalid', normalizeSunsetGuestDateField('February 30', REF).needs_clarification === true);
assert('April 31 invalid', normalizeSunsetGuestDateField('April 31', REF).needs_clarification === true);
assert('Feb 29 2028 valid leap', normalizeSunsetGuestDateField('February 29, 2028', REF).ok === true);
assert('Feb 29 2027 invalid', normalizeSunsetGuestDateField('February 29, 2027', REF).needs_clarification === true);

console.log('\n[3] Explicit past year fails safely');
const past = normalizeSunsetGuestDateField('August 2, 2024', REF);
assert('explicit past year rejected', past.ok === false && past.reason === 'explicit_past_year');

console.log('\n[4] Booking body normalization');
const bodyNorm = normalizeSunsetBookingDatesInBody({
  guest_name: 'Frankie',
  service_date: 'August 2',
  components: { lesson: { quantity: 1 } },
}, REF);
assert('body service_date → 2026-08-02', bodyNorm.ok && bodyNorm.body.service_date === '2026-08-02');
assert('canonical ISO preserved', normalizeSunsetBookingDatesInBody({ service_dates: ['2026-08-02'] }, REF).body.service_dates[0] === '2026-08-02');

console.log('\n[5] inferSunsetGuestYear unit');
assert('infer year same month future day', inferSunsetGuestYear(8, 2, REF) === 2026);
assert('infer year rolled next year', inferSunsetGuestYear(7, 12, REF) === 2027);
assert('isValidGregorianDate strict', isValidGregorianDate(2026, 2, 29) === false);

console.log(`\n── verify:sunset-guest-date-intake ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail > 0) process.exit(1);
