'use strict';

/**
 * EDIT-BOOKING-SURFERS-UNDER-DATES-001
 *
 * Edit booking: Number of surfers sits under Dates for every activity,
 * matching Create (Date(s) → Number of surfers → Activity).
 *
 * Run: node scripts/verify-edit-booking-surfers-under-dates-001.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EDIT = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-edit-ui.js');
const src = fs.readFileSync(EDIT, 'utf8');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

function fnBody(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const rest = src.slice(start);
  const after = rest.indexOf('\nfunction ', 1);
  return after > 0 ? rest.slice(0, after) : rest.slice(0, 12000);
}

console.log('verify:edit-booking-surfers-under-dates-001\n');

const renderFn = fnBody('scheduleRenderEditableDrawerHtml');
const readFn = fnBody('scheduleDrawerReadSurferCount');
const populateFn = fnBody('scheduleDrawerPopulateComponentFields');

const dateAt = renderFn.indexOf('ps-drawer-date-range');
const surfersAt = renderFn.indexOf('ps-drawer-surfers-field');
const whatAt = renderFn.indexOf('data-edit-section="what"');
const courseQtyAt = renderFn.indexOf('ps-drawer-course-qty-wrap');
const activityAt = renderFn.indexOf('ps-drawer-main-activity-field');

ok('edit render owns dates + surfers + activity', dateAt >= 0 && surfersAt >= 0 && activityAt >= 0);
ok('surfers field after dates', surfersAt > dateAt);
ok('surfers field before What/activity section', surfersAt < whatAt && surfersAt < activityAt);
ok('surfers field is not mode-hidden in HTML',
  !/id="ps-drawer-surfers-field"[^>]*display:\s*none/.test(renderFn)
    && !/ps-drawer-surfers-field"[^>]*hidden/.test(renderFn));
ok('course qty wrap stays a hidden mirror',
  /id="ps-drawer-course-qty-wrap"[^>]*display:\s*none/.test(renderFn)
    && /id="ps-drawer-course-qty-wrap"[^>]*hidden/.test(renderFn));
ok('private surfers wrap stays a hidden mirror',
  /id="ps-drawer-private-lesson-fields"[^>]*display:\s*none/.test(renderFn));
ok('read authority is always #ps-drawer-surfers',
  readFn.includes("el('ps-drawer-surfers')")
    && !readFn.includes("mode === 'group'")
    && !readFn.includes("el('ps-drawer-course-qty')"));
ok('populate keeps surfers visible',
  populateFn.includes("surfersField.style.display = ''")
    && !populateFn.includes('noLesson ?'));
ok('populate keeps course-qty wrap hidden',
  /scheduleDrawerSetVisible\(cq,\s*false\)/.test(populateFn));
ok('mirrors sync from booking-level surfers',
  src.includes('function scheduleDrawerSyncSurferMirrors(')
    && populateFn.includes('scheduleDrawerSyncSurferMirrors'));

console.log('\n────────────────────────────────────────────────');
if (fail === 0) {
  console.log(`Results: ${pass} passed, ${fail} failed`);
  console.log('verify:edit-booking-surfers-under-dates-001 — ALL CHECKS PASSED\n');
  process.exit(0);
}
console.error(`Results: ${pass} passed, ${fail} failed`);
console.error('verify:edit-booking-surfers-under-dates-001 — FAILED\n');
process.exit(1);
