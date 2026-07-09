'use strict';

/**
 * verify:sunset-private-lesson-schedule-display
 *
 * Offline checks for Sunset Schedule private lesson display grouping.
 * Run: node scripts/verify-sunset-private-lesson-schedule-display.js
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

console.log('\nverify:sunset-private-lesson-schedule-display — schedule display slice\n');

const api = read('scripts/staff-query-api.js');
const queries = read('scripts/lib/sunset-schedule-queries.js');
const en = read('scripts/lib/staff-portal-i18n.js');
const es = read('scripts/lib/staff-portal-i18n-es-sunset.js');

assert('queries select service_time_local', queries.includes('sr.service_time_local'));
assert('queries select service_time_local_end', queries.includes('sr.service_time_local_end'));
assert('queries select metadata component', queries.includes("metadata->>'component'"));

assert('API scheduleRowIsPrivateLesson helper', api.includes('function scheduleRowIsPrivateLesson('));
assert('API scheduleRowType returns private_lesson', /scheduleRowIsPrivateLesson\(row\)\) return 'private_lesson'/.test(api));
assert('API scheduleBuildPrivateLessonSessions', api.includes('function scheduleBuildPrivateLessonSessions('));
assert('API private sessions in scheduleBuildDaySessions', /scheduleBuildPrivateLessonSessions\(dayRows, dateIso\)/.test(api));
assert('API slot aggregates exclude private', /scheduleRowIsPrivateLesson\(l\)/.test(api));
assert('API other-lessons bucket excludes private', api.includes('if (scheduleRowIsPrivateLesson(l)) return false;'));
assert('API private lesson display section', api.includes('schedule.section.privateLessons'));
assert('API private timeline group class', api.includes('portal-schedule-ops-private-group'));
assert('API private capacity null (no slot cap)', /kind: 'private_lesson'[\s\S]*capacity: null/.test(api));
assert('API equipment totals include private', /scheduleGroupHasPrivateLesson\(g\)/.test(api));
assert('API normalize sets private _scheduleType', /r\._scheduleType = 'private_lesson'/.test(api));
assert('API display group key per private record', /'pl:' \+ String\(r\.service_record_id/.test(api));
assert('API requested time badge', api.includes('schedule.privateLesson.requestedTime'));

assert('EN private courses section', en.includes("'schedule.section.privateLessons': 'Private Courses'"));
assert('ES cursos privados section', es.includes("'schedule.section.privateLessons': 'Cursos privados'"));
assert('EN requested time', en.includes("'schedule.privateLesson.requestedTime': 'Requested time'"));
assert('ES hora solicitada', es.includes("'schedule.privateLesson.requestedTime': 'Hora solicitada'"));

// Simulated grouping behavior (mirrors detection rules in staff-query-api.js)
function rowIsPrivate(row) {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return meta.component === 'private_lesson' || meta.staff_ui_service_type === 'private_lesson';
}

function rowType(row) {
  if (rowIsPrivate(row)) return 'private_lesson';
  if (/lesson/.test(String(row.service_type || ''))) return 'lesson';
  return 'rental';
}

const groupLesson = {
  service_type: 'surf_lesson',
  slot_time: '11:00',
  metadata: { component: 'lesson', staff_ui_service_type: 'lesson' },
};
const privateLesson = {
  service_type: 'surf_lesson',
  service_time_local: '10:00',
  service_time_local_end: '12:00',
  metadata: { component: 'private_lesson', staff_ui_service_type: 'private_lesson' },
};

assert('sim: group lesson type lesson', rowType(groupLesson) === 'lesson');
assert('sim: private lesson type private_lesson', rowType(privateLesson) === 'private_lesson');
assert('sim: private not matched as group slot', rowType(privateLesson) !== 'lesson');

const unmatched = [groupLesson, privateLesson].filter((l) => {
  if (rowIsPrivate(l)) return false;
  return rowType(l) === 'lesson' && l.slot_time !== '11:00';
});
assert('sim: private excluded from other-lessons bucket', unmatched.length === 0);

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-private-lesson-schedule-display — FAILED');
  process.exit(1);
}
console.log('verify:sunset-private-lesson-schedule-display — ALL CHECKS PASSED');
