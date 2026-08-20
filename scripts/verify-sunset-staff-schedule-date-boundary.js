'use strict';

/**
 * verify:sunset-staff-schedule-date-boundary
 *
 * Staff create must reject invalid/past/horizon dates before DB mutation.
 * Staff edit of an existing booking may keep past service dates (allowPast).
 * Run: node scripts/verify-sunset-staff-schedule-date-boundary.js
 */

const fs = require('fs');
const path = require('path');
const {
  validateScheduleBookingBody,
  createSunsetScheduleBooking,
} = require('./lib/sunset-schedule-booking-writes');
const { updateSunsetScheduleBooking } = require('./lib/sunset-schedule-booking-drawer');
const { normalizeSunsetBookingDatesInBody } = require('./lib/sunset-guest-date-intake');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

const REF = new Date('2026-07-13T12:00:00Z');
const HORIZON = 730;
const baseBody = {
  guest_name: 'Boundary Guest',
  payment_status: 'unpaid',
  components: { lesson: { quantity: 1 } },
};

function explodingPg() {
  let begins = 0;
  return {
    begins,
    query(sql) {
      const q = String(sql);
      if (/BEGIN/i.test(q)) { begins += 1; throw new Error('DB mutation must not begin'); }
      if (/SELECT id FROM clients/i.test(q)) return { rows: [{ id: 'client-1' }] };
      throw new Error(`unexpected query: ${q.slice(0, 80)}`);
    },
  };
}

console.log('\nverify:sunset-staff-schedule-date-boundary\n');

console.log('[1] Staff routes normalize dates before create/update');
const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const writesSrc = fs.readFileSync(path.join(__dirname, 'lib', 'sunset-schedule-booking-writes.js'), 'utf8');
assert('create path still date-validates',
  /validateScheduleBookingBody/.test(writesSrc));
assert('PATCH /staff/schedule/bookings normalizes dates with allowPast',
  /handleSunsetScheduleBookingUpdate[\s\S]{0,2500}normalizeSunsetBookingDatesInBody\(body,\s*new Date\(\),\s*\{\s*allowPast:\s*true\s*\}\)/.test(apiSrc));

console.log('\n[2] Shared write boundary rejects invalid dates (ref 2026-07-13)');
const cases = [
  ['2026-02-30 invalid Gregorian', { service_date: '2026-02-30' }, 'invalid_calendar_date'],
  ['2026-07-12 past', { service_date: '2026-07-12' }, 'explicit_past_date'],
  ['2099-12-31 beyond horizon', { service_date: '2099-12-31' }, 'booking_horizon_exceeded'],
  ['range end before start', { date_from: '2026-08-02', date_to: '2026-08-01' }, 'date_range_invalid'],
  ['service_dates one invalid', { service_dates: ['2026-08-02', '2026-02-30'] }, 'invalid_calendar_date'],
  ['private lesson past', {
    components: {
      private_lesson: {
        enabled: true,
        quantity: 1,
        surfer_count: 1,
        sessions: [{ date: '2026-07-01', start: '10:00', end: '12:00' }],
      },
    },
  }, 'explicit_past_date'],
];
for (const [label, extra, reason] of cases) {
  const v = validateScheduleBookingBody({ ...baseBody, ...extra }, { refDate: REF, horizonDays: HORIZON });
  assert(`validate rejects ${label}`, v.ok === false && v.error === reason, JSON.stringify(v));
}

console.log('\n[3] Accept today and exact horizon');
assert('2026-07-13 accepted', validateScheduleBookingBody({ ...baseBody, service_date: '2026-07-13' }, { refDate: REF, horizonDays: HORIZON }).ok);
const { madridHorizonIso } = require('./lib/sunset-guest-date-intake');
const horizonIso = madridHorizonIso(REF, HORIZON);
assert('exact horizon accepted',
  validateScheduleBookingBody({ ...baseBody, service_date: horizonIso }, { refDate: REF, horizonDays: HORIZON }).ok);

console.log('\n[4] Staff edit allowPast — past dates OK for existing booking edits');
const pastOk = validateScheduleBookingBody(
  { ...baseBody, service_date: '2026-07-12' },
  { refDate: REF, horizonDays: HORIZON, allowPast: true },
);
assert('validate accepts past with allowPast', pastOk.ok === true, JSON.stringify(pastOk));
const pastNorm = normalizeSunsetBookingDatesInBody(
  { date_from: '2026-07-12', date_to: '2026-07-14' },
  REF,
  { allowPast: true },
);
assert('normalize accepts past range with allowPast', pastNorm.ok === true, JSON.stringify(pastNorm));
const pastBlocked = normalizeSunsetBookingDatesInBody(
  { date_from: '2026-07-12', date_to: '2026-07-14' },
  REF,
  {},
);
assert('normalize still rejects past without allowPast',
  pastBlocked.ok === false && pastBlocked.reason === 'explicit_past_date',
  JSON.stringify(pastBlocked));

console.log('\n[5] create rejects past before BEGIN; update no longer fails closed on past alone');
(async () => {
  const pg = explodingPg();
  const create = await createSunsetScheduleBooking(pg, {
    clientSlug: 'sunset',
    body: { ...baseBody, service_date: '2026-02-30' },
    locationId: 'sunset-somo',
  });
  assert('create rejects invalid date before DB', create.ok === false && pg.begins === 0);

  const createPast = await createSunsetScheduleBooking(explodingPg(), {
    clientSlug: 'sunset',
    body: { ...baseBody, service_date: '2026-07-12' },
    locationId: 'sunset-somo',
    now: REF,
  });
  assert('create still rejects past date',
    createPast.ok === false
      && String((createPast.body && createPast.body.error) || createPast.error || '') === 'explicit_past_date',
    JSON.stringify(createPast));

  const drawerSrc = fs.readFileSync(
    path.join(__dirname, 'lib', 'sunset-schedule-booking-drawer.js'), 'utf8',
  );
  assert('edit validateScheduleBookingBody passes allowPast: true',
    /validateScheduleBookingBody\(\{[\s\S]*?allowPast:\s*true/.test(drawerSrc));
  assert('edit authoritative pricing passes allowPastDates: true',
    /applyAuthoritativeSchedulePricingInTxn\(pg, \{[\s\S]*?allowPastDates:\s*true/.test(drawerSrc));

  // Smoke: update past-date body is not rejected at the date-boundary layer.
  // Incomplete PG double may fail later — only assert we did not get explicit_past_date.
  const pg2 = {
    begins: 0,
    query(sql) {
      const q = String(sql);
      if (/BEGIN/i.test(q)) { pg2.begins += 1; throw new Error('stop-after-begin'); }
      if (/FROM bookings b[\s\S]*INNER JOIN clients/i.test(q)) {
        return {
          rows: [{
            booking_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            booking_code: 'SUNSET-TEST',
            guest_name: 'Boundary Guest',
            phone: null,
            status: 'payment_pending',
            payment_status: 'waiting_payment',
            metadata: { source: 'staff_manual_schedule', staff_manual_schedule: true, location_id: 'sunset-somo' },
          }],
        };
      }
      if (/FROM booking_service_records/i.test(q)) return { rows: [] };
      if (/FROM payments/i.test(q)) return { rows: [] };
      throw new Error(`unexpected query: ${q.slice(0, 80)}`);
    },
  };
  let update;
  try {
    update = await updateSunsetScheduleBooking(pg2, {
      clientSlug: 'sunset',
      bookingId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      body: { ...baseBody, service_date: '2026-07-12' },
      locationId: 'sunset-somo',
      now: REF,
    });
  } catch (err) {
    update = { ok: false, status: 500, body: { success: false, error: String(err && err.message || err) } };
  }
  const updErr = String((update && update.body && (update.body.error || update.body.reason_code)) || '');
  assert('update does not fail-closed as explicit_past_date',
    updErr !== 'explicit_past_date',
    JSON.stringify(update));

  console.log(`\n── verify:sunset-staff-schedule-date-boundary ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  if (fail > 0) process.exit(1);
})().catch((err) => {
  console.error('UNCAUGHT', err && err.stack || err);
  process.exit(1);
});
