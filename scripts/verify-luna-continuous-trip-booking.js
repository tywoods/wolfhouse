'use strict';

const fs = require('fs');
const path = require('path');
const {
  bookingHeaderDates,
  buildScheduleBookingIntentFingerprint,
  evaluateIdempotentReplay,
} = require('./lib/sunset-schedule-booking-writes');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

console.log('\nverify:luna-continuous-trip-booking\n');

const serviceDates = [
  '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08',
  '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12',
];
const request = {
  guest_name: 'Future Continuous Trip',
  guest_phone: '+34900000000',
  guest_confirmed_booking: true,
  idempotency_key: 'future-continuous-trip-001',
  service_dates: serviceDates,
  components: {
    surfboard: { quantity: 1 },
    wetsuit: { quantity: 1 },
  },
};

const dates = bookingHeaderDates(request);
check('7+ continuous trip keeps one full booking-header span',
  dates.firstDate === serviceDates[0] && dates.lastDate === serviceDates[serviceDates.length - 1],
  JSON.stringify(dates));

const fingerprint = buildScheduleBookingIntentFingerprint(request, 'sunset-somo', {});
const retryFingerprint = buildScheduleBookingIntentFingerprint({
  ...request,
  service_dates: [...serviceDates],
}, 'sunset-somo', {});
check('exact retry has stable booking intent fingerprint',
  Boolean(fingerprint) && fingerprint === retryFingerprint,
  `${fingerprint} != ${retryFingerprint}`);

const replay = evaluateIdempotentReplay([{
  booking_id: '11111111-1111-4111-8111-111111111111',
  booking_code: 'SUNSET-CONTINUOUS-001',
  booking_status: 'payment_pending',
  payment_status: 'unpaid',
  location_id: 'sunset-somo',
  idempotency_intent_fp: fingerprint,
}], request, 'sunset-somo', { intent_fingerprint: fingerprint });
check('exact retry replays the existing booking instead of creating a second booking',
  replay && replay.replay === true && replay.body && replay.body.booking_code === 'SUNSET-CONTINUOUS-001',
  JSON.stringify(replay));

const changedFingerprint = buildScheduleBookingIntentFingerprint({
  ...request,
  service_dates: [...serviceDates, '2026-10-13'],
}, 'sunset-somo', {});
check('a changed trip is not treated as the same idempotent create',
  changedFingerprint !== fingerprint,
  `${changedFingerprint} == ${fingerprint}`);

const soul = fs.readFileSync(path.join(__dirname, '..', 'docker', 'hermes-sunset', 'SOUL.md'), 'utf8');
check('Luna is explicitly required to create one booking for one continuous 7+ trip',
  /one continuous trip, one booking/i.test(soul)
    && /7\+ days/i.test(soul)
    && /create_sunset_booking exactly once/i.test(soul));
check('the rule is future-create only and forbids historical backfill',
  /future (?:booking )?creates? only/i.test(soul)
    && /do not backfill or modify historical bookings/i.test(soul));
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
