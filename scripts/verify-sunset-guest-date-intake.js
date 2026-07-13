'use strict';

/**
 * verify:sunset-guest-date-intake
 *
 * Omitted-year date resolution + strict Gregorian / past / horizon bounds.
 *
 * Run: node scripts/verify-sunset-guest-date-intake.js
 */

const {
  inferSunsetGuestYear,
  normalizeSunsetGuestDateField,
  normalizeSunsetBookingDatesInBody,
  madridCalendarParts,
  isValidGregorianDate,
  resolveSunsetMaxBookingHorizonDays,
  madridHorizonIso,
  DEFAULT_MAX_BOOKING_HORIZON_DAYS,
} = require('./lib/sunset-guest-date-intake');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

const REF = new Date('2026-07-13T12:00:00Z');
const HORIZON = 730;

console.log('\nverify:sunset-guest-date-intake\n');

console.log('[1] Madrid reference + inferYear');
const ref = madridCalendarParts(REF);
assert('reference 2026-07-13 Madrid', ref.year === 2026 && ref.month === 7 && ref.day === 13, JSON.stringify(ref));
assert('August 2 → 2026', normalizeSunsetGuestDateField('August 2', REF).iso === '2026-08-02');
assert('July 13 → 2026', normalizeSunsetGuestDateField('July 13', REF).iso === '2026-07-13');
assert('July 12 omitted year → 2027', normalizeSunsetGuestDateField('July 12', REF).iso === '2027-07-12');
assert('explicit August 2, 2027', normalizeSunsetGuestDateField('August 2, 2027', REF).iso === '2027-08-02');

console.log('\n[2] Explicit past dates rejected (Madrid today 2026-07-13)');
const pastNamed = normalizeSunsetGuestDateField('July 12, 2026', REF);
assert('July 12, 2026 rejected', pastNamed.ok === false && pastNamed.reason === 'explicit_past_date');
const pastIso = normalizeSunsetGuestDateField('2026-07-12', REF);
assert('2026-07-12 rejected', pastIso.ok === false && pastIso.reason === 'explicit_past_date');
assert('2026-07-13 accepted', normalizeSunsetGuestDateField('2026-07-13', REF).ok === true);
assert('July 13, 2026 accepted', normalizeSunsetGuestDateField('July 13, 2026', REF).ok === true);

console.log('\n[3] Invalid Gregorian ISO');
assert('2026-02-30 invalid', normalizeSunsetGuestDateField('2026-02-30', REF).reason === 'invalid_calendar_date');
assert('2027-02-29 invalid', normalizeSunsetGuestDateField('2027-02-29', REF).reason === 'invalid_calendar_date');
assert('2028-02-29 valid leap', normalizeSunsetGuestDateField('2028-02-29', REF).ok === true);

console.log('\n[4] Booking body normalization (all aliases)');
const bodyNorm = normalizeSunsetBookingDatesInBody({
  guest_name: 'Frankie',
  service_date: 'August 2',
  components: { lesson: { quantity: 1 } },
}, REF);
assert('body service_date → 2026-08-02', bodyNorm.ok && bodyNorm.body.service_date === '2026-08-02');
assert('canonical ISO preserved + validated', normalizeSunsetBookingDatesInBody({ service_dates: ['2026-08-02'] }, REF).body.service_dates[0] === '2026-08-02');
const rangeReject = normalizeSunsetBookingDatesInBody({
  date_from: '2026-08-02',
  date_to: '2026-07-12',
  components: { lesson: { quantity: 1 } },
}, REF);
assert('range end before start rejected', rangeReject.ok === false);

console.log('\n[5] Booking horizon');
assert('default horizon 730', resolveSunsetMaxBookingHorizonDays() === DEFAULT_MAX_BOOKING_HORIZON_DAYS);
assert('invalid env falls back to default', resolveSunsetMaxBookingHorizonDays('not-a-number') === DEFAULT_MAX_BOOKING_HORIZON_DAYS);
const maxIso = madridHorizonIso(REF, HORIZON);
assert('exactly at horizon accepted', normalizeSunsetGuestDateField(maxIso, REF, { horizonDays: HORIZON }).ok === true);
const beyondIso = madridHorizonIso(REF, HORIZON + 1);
assert('one day beyond rejected', normalizeSunsetGuestDateField(beyondIso, REF, { horizonDays: HORIZON }).reason === 'booking_horizon_exceeded');
assert('2099-12-31 rejected', normalizeSunsetGuestDateField('2099-12-31', REF, { horizonDays: HORIZON }).reason === 'booking_horizon_exceeded');
const rangeHorizon = normalizeSunsetBookingDatesInBody({
  date_from: '2026-08-02',
  date_to: beyondIso,
  components: { lesson: { quantity: 1 } },
}, REF, { horizonDays: HORIZON });
assert('range end beyond horizon rejected', rangeHorizon.ok === false && rangeHorizon.reason === 'booking_horizon_exceeded');

console.log('\n[6] inferSunsetGuestYear unit');
assert('infer year same month future day', inferSunsetGuestYear(8, 2, REF) === 2026);
assert('infer year rolled next year', inferSunsetGuestYear(7, 12, REF) === 2027);
assert('isValidGregorianDate strict', isValidGregorianDate(2026, 2, 29) === false);

console.log(`\n── verify:sunset-guest-date-intake ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail > 0) process.exit(1);
