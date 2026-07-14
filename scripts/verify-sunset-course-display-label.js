'use strict';

/**
 * verify:sunset-course-display-label
 *
 * TDD gate — schedule UI must never show a raw course_id UUID as the course
 * title. Resolve the display label from admin surf packs (scheduleCoursesCache);
 * fall back to localized "Group course", never the UUID.
 *
 * Run:
 *   node scripts/verify-sunset-course-display-label.js
 */

const fs = require('fs');
const path = require('path');
const {
  looksLikeCourseUuid,
  resolveCourseDisplayLabel,
  sanitizeCourseLabelForStorage,
} = require('./lib/sunset-course-display-label');
const { normalizeComponents } = require('./lib/sunset-schedule-booking-writes');

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

const PACK_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_LABEL = 'Adults Mon–Fri mornings';
const GENERIC = 'Group course';

function main() {
  console.log('\nverify:sunset-course-display-label — never show course UUID as title\n');

  console.log('[A] Storage: normalize never stores UUID as course_label');
  const lunaNoLabel = normalizeComponents({
    components: { course: { quantity: 1, course_id: PACK_ID } },
  });
  assert('normalize ok without label', lunaNoLabel.ok === true, JSON.stringify(lunaNoLabel));
  assert('stored course_label is empty (not the UUID)',
    lunaNoLabel.ok && lunaNoLabel.value.course.course_label === '',
    JSON.stringify(lunaNoLabel.value && lunaNoLabel.value.course));

  const lunaUuidLabel = normalizeComponents({
    components: { course: { quantity: 1, course_id: PACK_ID, course_label: PACK_ID } },
  });
  assert('explicit course_label===course_id sanitized to empty',
    lunaUuidLabel.ok && lunaUuidLabel.value.course.course_label === '',
    JSON.stringify(lunaUuidLabel.value && lunaUuidLabel.value.course));

  const staffLabel = normalizeComponents({
    components: { course: { quantity: 1, course_id: PACK_ID, course_label: ADMIN_LABEL } },
  });
  assert('staff real label preserved',
    staffLabel.ok && staffLabel.value.course.course_label === ADMIN_LABEL,
    JSON.stringify(staffLabel.value && staffLabel.value.course));

  console.log('\n[B] Display resolver — admin wins; UUID never surfaces');
  assert('uuid detector', looksLikeCourseUuid(PACK_ID) === true);
  assert('admin name detector false', looksLikeCourseUuid(ADMIN_LABEL) === false);

  const fromAdmin = resolveCourseDisplayLabel({
    courseId: PACK_ID,
    storedLabel: PACK_ID, // legacy row
    adminCourses: [{ course_id: PACK_ID, label: ADMIN_LABEL }],
    genericLabel: GENERIC,
  });
  assert('legacy UUID stored label → admin pack name',
    fromAdmin === ADMIN_LABEL, fromAdmin);

  const fromGeneric = resolveCourseDisplayLabel({
    courseId: PACK_ID,
    storedLabel: PACK_ID,
    adminCourses: [],
    genericLabel: GENERIC,
  });
  assert('no admin pack → generic Group course (not UUID)',
    fromGeneric === GENERIC, fromGeneric);
  assert('generic path never equals course_id', fromGeneric !== PACK_ID);

  const staffKept = resolveCourseDisplayLabel({
    courseId: PACK_ID,
    storedLabel: 'Custom Staff Name',
    adminCourses: [{ course_id: PACK_ID, label: ADMIN_LABEL }],
    genericLabel: GENERIC,
  });
  // Admin label wins for display when course_id matches (authoritative); staff custom
  // that isn't UUID and has no admin... actually for staff with real label that differs
  // from admin - require staff unchanged: if stored is not UUID and not equal to id, keep
  // when no admin? Spec: "do not change Wolfhouse or staff-created course display
  // behavior (those already pass a real label)". So if stored is a real label, prefer
  // admin when available? Spec says resolve from admin at render time. Admin wins.
  assert('admin pack label preferred at display time', staffKept === ADMIN_LABEL, staffKept);

  const staffNoAdmin = resolveCourseDisplayLabel({
    courseId: PACK_ID,
    storedLabel: 'Custom Staff Name',
    adminCourses: [],
    genericLabel: GENERIC,
  });
  assert('staff real label kept when admin unavailable',
    staffNoAdmin === 'Custom Staff Name', staffNoAdmin);

  assert('sanitize strips uuid equals id',
    sanitizeCourseLabelForStorage(PACK_ID, PACK_ID) === '');
  assert('sanitize keeps real label',
    sanitizeCourseLabelForStorage(PACK_ID, ADMIN_LABEL) === ADMIN_LABEL);

  console.log('\n[C] Schedule UI calls display resolver (not raw course_label UUID)');
  const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  assert('API defines scheduleResolveCourseDisplayLabel',
    api.includes('function scheduleResolveCourseDisplayLabel('));
  assert('day session title uses display resolver',
    /scheduleResolveCourseDisplayLabel\(/.test(api)
    && api.includes('scheduleBuildDaySessions'));
  // Prove the old UUID-preferring pattern is gone from day-session label pick
  assert('day sessions no longer prefer raw g.course_label over admin',
    !/stats\.groups\.some\(function\(g\)\{\s*if \(g\.course_label\) \{ label = g\.course_label;/.test(api));
  assert('component list uses display resolver',
    /scheduleRenderComponentListHtml[\s\S]{0,400}scheduleResolveCourseDisplayLabel/.test(api));
  assert('courses today breakdown uses display resolver',
    /scheduleRenderCoursesTodayBreakdown[\s\S]{0,800}scheduleResolveCourseDisplayLabel/.test(api)
    || /todayCourses\.forEach[\s\S]{0,300}scheduleResolveCourseDisplayLabel/.test(api));
  assert('writes module no longer falls back course_label to courseId',
    !/entry\.course_label = String\(part\.course_label \|\| part\.label \|\| ''\)\.trim\(\) \|\| courseId/.test(
      fs.readFileSync(path.join(__dirname, 'lib/sunset-schedule-booking-writes.js'), 'utf8'),
    ));

  console.log(`\nTotals: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
