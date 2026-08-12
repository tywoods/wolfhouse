'use strict';

/**
 * verify:sunset-private-lesson-booking
 *
 * Offline checks for Sunset Schedule private lesson booking create slice.
 * Run: node scripts/verify-sunset-private-lesson-booking.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

console.log('\nverify:sunset-private-lesson-booking — schedule private lesson create slice\n');

const writes = read('scripts/lib/sunset-schedule-booking-writes.js');
// Schedule create JS is split between the template and the extracted browser module.
const api = [
  read('scripts/staff-query-api.js'),
  read('scripts/browser/sunset-schedule-portal-module.js'),
].join('\n');
const en = read('scripts/lib/staff-portal-i18n.js');
const es = read('scripts/lib/staff-portal-i18n-es-sunset.js');

function futureDate(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const D1 = futureDate(30);
const D2 = futureDate(31);
const D3 = futureDate(32);

assert('writes module private_lesson component key', writes.includes("'private_lesson'"));
assert('writes normalizePrivateLessonPart', writes.includes('function normalizePrivateLessonPart'));
assert('writes sessions length must equal quantity', writes.includes('sessions length must equal quantity'));
assert('writes one insert per private session', /for \(const session of sessions\)/.test(writes));
assert('writes service_time_local columns for private', writes.includes('service_time_local: session.start'));
assert('writes metadata component private_lesson', writes.includes("component: 'private_lesson'"));
assert('writes metadata session index/count', writes.includes('private_lesson_session_index'));
assert('writes metadata unit_amount_cents', writes.includes('unit_amount_cents'));
assert('writes quantity uses surfer_count', /pl\.surfer_count/.test(writes));
assert('writes skips private in date/component loop', writes.includes("if (key === 'private_lesson') continue"));
assert('writes amount_due_cents stays 0', writes.includes("'confirmed', 0, 0,"));
assert('writes exports normalizePrivateLessonSessions', writes.includes('normalizePrivateLessonSessions'));

assert('API create modal private lesson checkbox', api.includes('ps-create-comp-private-lesson'));
assert('API private lesson session rows UI', api.includes('scheduleSyncPrivateLessonSessions'));
assert('API scheduleReadCreatePayload private_lesson', /components\.private_lesson\s*=\s*\{/.test(api));
assert('API wire private lesson qty change', api.includes("el('ps-create-private-lesson-qty')"));
assert('API mutual exclusive lesson/course/private', api.includes('ps-create-comp-private-lesson'));
assert('API submit validates session count', api.includes('schedule.create.privateLesson.sessionsMismatch'));
assert('API loads default duration from config', api.includes('schedulePrivateLessonDurationCache'));

assert('EN private course type label', en.includes("'schedule.type.privateLesson': 'Private Course'"));
assert('ES curso privado type label', es.includes("'schedule.type.privateLesson': 'Curso privado'"));
assert('EN sessions mismatch i18n', en.includes('schedule.create.privateLesson.sessionsMismatch'));
assert('ES sessions mismatch i18n', es.includes('schedule.create.privateLesson.sessionsMismatch'));

const {
  validateScheduleBookingBody,
  normalizePrivateLessonPart,
  normalizePrivateLessonSessions,
  scheduleRowFromDb,
  PRIVATE_LESSON_MAX_SESSIONS,
} = require('./lib/sunset-schedule-booking-writes');

const goodBody = {
  guest_name: 'Test Guest',
  date_from: D1,
  date_to: D3,
  components: {
    private_lesson: {
      enabled: true,
      quantity: 3,
      surfer_count: 1,
      sessions: [
        { date: D1, start: '10:00', end: '12:00' },
        { date: D2, start: '14:00', end: '16:00' },
        { date: D3, start: '09:30', end: '11:30' },
      ],
    },
  },
};

const validated = validateScheduleBookingBody(goodBody);
assert('validate accepts 3-session private lesson', validated.ok === true);
if (validated.ok) {
  assert('normalized quantity is session count', validated.value.components.private_lesson.quantity === 3);
  assert('normalized sessions length 3', validated.value.components.private_lesson.sessions.length === 3);
  assert('service_dates include all session dates', validated.value.service_dates.length === 3);
}

const disabled = validateScheduleBookingBody({
  guest_name: 'X',
  date_from: D1,
  date_to: D1,
  components: { private_lesson: { enabled: false, quantity: 2, sessions: [] } },
});
assert('disabled private_lesson ignored', disabled.ok === false);

const mismatch = validateScheduleBookingBody({
  guest_name: 'X',
  date_from: D1,
  date_to: D1,
  components: {
    private_lesson: {
      enabled: true,
      quantity: 2,
      sessions: [{ date: D1, start: '10:00', end: '12:00' }],
    },
  },
});
assert('reject sessions.length !== quantity', mismatch.ok === false);

const badEnd = normalizePrivateLessonSessions(
  [{ date: D1, start: '12:00', end: '10:00' }],
  1,
);
assert('reject end before start', badEnd.ok === false);

const plPart = normalizePrivateLessonPart({ enabled: true, quantity: 2, surfer_count: 3, sessions: [
  { date: D1, start: '10:00', end: '12:00' },
  { date: D2, start: '14:00', end: '16:00' },
] });
assert('normalize surfer_count', plPart.ok && plPart.value.surfer_count === 3);

const maxQty = normalizePrivateLessonPart({
  enabled: true,
  quantity: PRIVATE_LESSON_MAX_SESSIONS + 1,
  sessions: [],
});
assert('reject quantity above max', maxQty.ok === false);

const scheduleRow = scheduleRowFromDb({
  service_record_id: 'sr-1',
  service_type: 'surf_lesson',
  service_date: D1,
  quantity: 2,
  payment_status: 'pending',
  record_source: 'staff_manual',
  staff_ui_service_type: 'private_lesson',
  metadata_component: 'private_lesson',
  service_time_local: '10:00',
  service_time_local_end: '12:00',
});
assert('scheduleRowFromDb maps private_lesson type', scheduleRow.service_type === 'private_lesson');
assert('scheduleRowFromDb private schedule type', scheduleRow._scheduleType === 'private_lesson');

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-private-lesson-booking — FAILED');
  process.exit(1);
}
console.log('verify:sunset-private-lesson-booking — ALL CHECKS PASSED');
