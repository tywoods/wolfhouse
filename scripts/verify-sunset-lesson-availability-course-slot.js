#!/usr/bin/env node
'use strict';

/**
 * verify-sunset-lesson-availability-course-slot
 *
 * Ty 2026-09-02: timed class leftover must match Horario/joinable-courses,
 * not daily_cap (24) minus all-day surf_lessons.
 *
 * Live proof shape:
 *   Matutino 10:00 = 3/25 remaining 22
 *   day-wide seats_booked = 23 / daily_cap 24 → old bug said remaining 1
 *   qty 14 at 10:00 must has_seats true with seats_available 22
 *
 * Offline only. Run: node scripts/verify-sunset-lesson-availability-course-slot.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  normalizeLessonAvailabilityTime,
  pickJoinableCourseForAvailability,
  buildCourseSlotAvailabilityResult,
  extractLessonAvailabilitySlotFromBody,
} = require('./lib/sunset-lesson-availability');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

const MATUTINO = {
  course_id: 'curso-matutino',
  pack_id: 'curso-matutino',
  label: 'Curso Matutino',
  capacity: 25,
  group_size: 25,
  seats_booked: 3,
  seats_remaining: 22,
  joinable: true,
  schedules: [{ key: '1000_1200', start_time: '10:00', end_time: '12:00' }],
  slot_time: '1000_1200',
};

const MEDIO = {
  course_id: 'curso-medio',
  label: 'Medio Dia',
  capacity: 24,
  seats_booked: 11,
  seats_remaining: 13,
  joinable: true,
  schedules: [{ key: '1200_1400', start_time: '12:00', end_time: '14:00' }],
};

const TARDE = {
  course_id: 'curso-tarde',
  label: 'Tarde',
  capacity: 24,
  seats_booked: 9,
  seats_remaining: 15,
  joinable: true,
  schedules: [{ key: '1600_1800', start_time: '16:00', end_time: '18:00' }],
};

const COURSES = [MATUTINO, MEDIO, TARDE];
// 3+11+9 = 23 daily booked; daily_cap 24 → old leftover 1 (must not win for 10:00).
const DAILY_BOOKED = 23;
const DAILY_CAP = 24;
const OLD_DAILY_REMAINING = DAILY_CAP - DAILY_BOOKED;

console.log('\nverify-sunset-lesson-availability-course-slot\n');

console.log('[A] Time normalize + body extract');
assert('10:00 stays 10:00', normalizeLessonAvailabilityTime('10:00') === '10:00');
assert('10:00-12:00 → start 10:00', normalizeLessonAvailabilityTime('10:00-12:00') === '10:00');
assert('1000 → 10:00', normalizeLessonAvailabilityTime('1000') === '10:00');
assert('1000_1200 pack key → 10:00', normalizeLessonAvailabilityTime('1000_1200') === '10:00');
assert('body.slot_time preferred', extractLessonAvailabilitySlotFromBody({ slot_time: '10:00', time: '16:00' }) === '10:00');
assert('body.time alias', extractLessonAvailabilitySlotFromBody({ time: '10:00' }) === '10:00');
assert('empty body → null', extractLessonAvailabilitySlotFromBody({}) == null);

console.log('\n[B] Ty case — 10:00 Matutino 3/25 qty 14 (daily 23/24 must not fail)');
const picked = pickJoinableCourseForAvailability(COURSES, { slotTime: '10:00' });
assert('picks Matutino for 10:00', picked.ok === true && picked.course.course_id === 'curso-matutino', JSON.stringify(picked));
const result = buildCourseSlotAvailabilityResult({
  course: picked.course,
  quantity: 14,
  dateIso: '2026-09-03',
  locationId: 'sunset-somo',
  slotTime: picked.slot_time,
});
assert('scope course_slot', result.scope === 'course_slot');
assert('has_seats true for qty 14', result.has_seats === true, JSON.stringify(result));
assert('seats_available is Horario remaining 22', result.seats_available === 22, JSON.stringify(result));
assert('seats_booked is course 3 not daily 23', result.seats_booked === 3, JSON.stringify(result));
assert('course_capacity 25', result.course_capacity === 25, JSON.stringify(result));
assert('daily_capacity null on timed path', result.daily_capacity == null, JSON.stringify(result));
assert('reason null when fits', result.reason == null, JSON.stringify(result));
assert('take_request false when fits', result.take_request === false, JSON.stringify(result));
assert('old daily leftover was 1', OLD_DAILY_REMAINING === 1);
assert('timed leftover ≠ daily leftover', result.seats_available !== OLD_DAILY_REMAINING);
assert('qty 14 would fail daily but passes course', 14 > OLD_DAILY_REMAINING && result.has_seats === true);

console.log('\n[C] Shortfall still quotes Staff remaining (no invent / no handoff invent)');
const shortCourse = {
  ...MATUTINO,
  seats_booked: 20,
  seats_remaining: 5,
};
const short = buildCourseSlotAvailabilityResult({
  course: shortCourse,
  quantity: 14,
  dateIso: '2026-09-03',
  locationId: 'sunset-somo',
  slotTime: '10:00',
});
assert('shortfall has_seats false', short.has_seats === false);
assert('shortfall seats_available 5 from Staff course math', short.seats_available === 5);
assert('shortfall reason insufficient_seats', short.reason === 'insufficient_seats');
assert('shortfall take_request true at Staff layer (plugin strips for guest shortfall)', short.take_request === true);

console.log('\n[D] Wiring — handler + plugin + SOUL use course-slot path');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
assert('handler imports resolveCourseScopedLessonAvailability',
  /resolveCourseScopedLessonAvailability/.test(apiSrc));
assert('handler branches on slotTime || courseId',
  /slotTime\s*\|\|\s*courseId/.test(apiSrc));
assert('handler still has daily fallback',
  /scope:\s*'daily'/.test(apiSrc) && /getSunsetScheduleLessonsOnDateQuery/.test(apiSrc));

const pluginSrc = fs.readFileSync(
  path.join(ROOT, 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'),
  'utf8',
);
assert('plugin forwards slot_time', /body\["slot_time"\]\s*=\s*slot/.test(pluginSrc));
assert('plugin forwards course_id', /body\["course_id"\]\s*=\s*course_id/.test(pluginSrc));
assert('tool schema documents slot_time', /"slot_time":\s*\{"type":\s*"string"/.test(pluginSrc));

const soulSrc = fs.readFileSync(path.join(ROOT, 'docker/hermes-sunset/SOUL.md'), 'utf8');
assert('SOUL requires slot_time when guest names class time',
  /pass `slot_time`/.test(soulSrc) && /Horario/.test(soulSrc));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
