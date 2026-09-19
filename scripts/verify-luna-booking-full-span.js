'use strict';

const fs = require('fs');
const path = require('path');
const writes = require('./lib/sunset-schedule-booking-writes');

let passed = 0;
let failed = 0;
function assert(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

console.log('\nverify:luna-booking-full-span\n');

assert('bookingHeaderDates is exported for direct regression proof',
  typeof writes.bookingHeaderDates === 'function');

if (typeof writes.bookingHeaderDates === 'function') {
  const contiguous = writes.bookingHeaderDates({
    service_dates: ['2026-10-04', '2026-10-05', '2026-10-06'],
    components: {},
  });
  assert('multi-day component span keeps first confirmed date', contiguous.firstDate === '2026-10-04', JSON.stringify(contiguous));
  assert('multi-day component span keeps last confirmed date', contiguous.lastDate === '2026-10-06', JSON.stringify(contiguous));

  const sparse = writes.bookingHeaderDates({
    service_dates: ['2026-10-04', '2026-10-07', '2026-10-11'],
    components: {},
  });
  assert('sparse sessions preserve their actual first date', sparse.firstDate === '2026-10-04', JSON.stringify(sparse));
  assert('sparse sessions preserve their actual last date without filling gaps', sparse.lastDate === '2026-10-11', JSON.stringify(sparse));

  const privateSessions = writes.bookingHeaderDates({
    service_dates: ['2026-10-05'],
    components: {
      private_lesson: {
        sessions: [{ date: '2026-10-04' }, { date: '2026-10-09' }],
      },
    },
  });
  assert('private lesson session dates extend the booking header span',
    privateSessions.firstDate === '2026-10-04' && privateSessions.lastDate === '2026-10-09',
    JSON.stringify(privateSessions));
}

const source = fs.readFileSync(path.join(__dirname, 'lib', 'sunset-schedule-booking-writes.js'), 'utf8');
const insert = source.match(/INSERT INTO bookings \([\s\S]{0,900}?RETURNING id::text AS id, booking_code/);
assert('booking insert exists', !!insert);
if (insert) {
  assert('booking insert persists checkout from last confirmed date plus one day',
    /\$8::date\s*\+\s*INTERVAL '1 day'/.test(insert[0]), insert[0]);
  assert('booking insert no longer derives checkout from first date',
    !/\$7::date\s*\+\s*INTERVAL '1 day'/.test(insert[0]), insert[0]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
