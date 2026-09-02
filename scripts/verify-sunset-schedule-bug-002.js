'use strict';

/**
 * BUG-002 — Horario/Reservas P1: overlap hits, booking-code label+date, drawer.
 * Stay off Inbox, email, language packs, production.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const cockpitSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-day-cockpit-ui.js'), 'utf8');
const runtimeSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-runtime.js'), 'utf8');
const navSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-navigation-ui.js'), 'utf8');
const drawerSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-controller.js'), 'utf8');
const bookingsSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');

assert.ok(cockpitSrc.includes('function scheduleCockpitAssignLanes'));
assert.ok(cockpitSrc.includes('pointer-events:none'));
assert.ok(cockpitSrc.includes('.ck-block') && cockpitSrc.includes('pointer-events:auto'));

const start = cockpitSrc.indexOf('function scheduleCockpitAssignLanes');
const end = cockpitSrc.indexOf('function scheduleCockpitClassify');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(cockpitSrc.slice(start, end) + '\nthis.scheduleCockpitAssignLanes = scheduleCockpitAssignLanes;', sandbox);
const packed = sandbox.scheduleCockpitAssignLanes([
  { id: 'private', name: 'Curso privado', s: 9 * 60, e: 18 * 60 },
  { id: 'manana', name: 'Curso Mañana', s: 10 * 60, e: 13 * 60 },
]);
assert.notStrictEqual(packed.list[0].lane, packed.list[1].lane, 'overlapping courses get separate lanes');
assert.ok(packed.laneCount >= 2);

assert.ok(!/if \(offset < 0\) offset = 0;/.test(runtimeSrc), 'openDayDetail does not clamp past dates to today');
assert.ok(runtimeSrc.includes('function primeOpenDay'), 'primeOpenDay seeds service day without loading');
assert.ok(navSrc.includes('window.scheduleOpenDayDetail = scheduleOpenDayDetail'));
assert.ok(navSrc.includes('window.schedulePrimeOpenDay = schedulePrimeOpenDay'));
assert.ok(!/\bschedulePrimeOpenDay\b/.test(bookingsSrc) && !/\bprimeFn\s*\(/.test(bookingsSrc),
  'Reservas must not prime Horario — booking drawer opens over Bookings');
assert.ok(!/\bswitchToTab\s*\(\s*['"]portal-home['"]/.test(bookingsSrc),
  'Reservas booking open must not switch to Horario');
assert.ok(bookingsSrc.includes('openScheduleDetailDrawer'),
  'Reservas opens shared detail drawer in place');

const labelStart = bookingsSrc.indexOf('function adminBookingsOpenScheduleLabel');
const labelEnd = bookingsSrc.indexOf('var ADMIN_BOOKINGS_SORT_FIRST_DIR');
assert.ok(labelStart > 0 && labelEnd > labelStart);

function runLabel(sandbox) {
  const box = Object.assign({}, sandbox);
  vm.createContext(box);
  vm.runInContext(bookingsSrc.slice(labelStart, labelEnd) + '\nthis.adminBookingsOpenScheduleLabel = adminBookingsOpenScheduleLabel;', box);
  return box.adminBookingsOpenScheduleLabel('SUNSET-20260811-EA783E');
}

const ariaRaw = runLabel({ portalT(key) { return key; }, getStaffLocale() { return 'en'; } });
assert.ok(!/admin\.bookings\./.test(ariaRaw), ariaRaw);
assert.ok(ariaRaw.indexOf('SUNSET-20260811-EA783E') >= 0);
assert.strictEqual(ariaRaw, 'Open in Schedule: SUNSET-20260811-EA783E');

const ariaEs = runLabel({ portalT(key) { return key; }, getStaffLocale() { return 'es'; } });
assert.ok(!/admin\.bookings\./.test(ariaEs), ariaEs);
assert.strictEqual(ariaEs, 'Abrir en Agenda: SUNSET-20260811-EA783E');

assert.ok(bookingsSrc.includes('adminBookingsOpenScheduleLabel(code)'));
assert.ok(bookingsSrc.includes("title=\"' + escHtml(openScheduleLabel) + '\""));
assert.ok(bookingsSrc.includes("aria-label=\"' + escHtml(openScheduleLabel) + '\""));

assert.ok(drawerSrc.includes('scheduleDrawerEnsureDocumentLayer'));
assert.ok(drawerSrc.includes("drawer.style.zIndex = '9800'"));
assert.ok(drawerSrc.includes("backdrop.style.zIndex = '9700'"));
assert.ok(drawerSrc.includes('ps-create-modal'));
assert.ok(drawerSrc.includes('scheduleDrawerOnKeydown'));
assert.ok(drawerSrc.includes('scheduleDrawerUnlockPage'));

assert.ok(!cockpitSrc.includes('inbox-thread.js'));
assert.ok(!runtimeSrc.includes('inbox-thread.js'));
assert.ok(!bookingsSrc.includes('staff-email-oauth'));

console.log('PASS BUG-002 Horario/Reservas overlap + booking-code date/label + drawer');
