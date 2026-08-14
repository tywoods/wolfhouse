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
assert.ok(navSrc.includes('window.scheduleOpenDayDetail = scheduleOpenDayDetail'));

const labelStart = bookingsSrc.indexOf('function adminBookingsOpenScheduleLabel');
const labelEnd = bookingsSrc.indexOf('var ADMIN_BOOKINGS_SORT_FIRST_DIR');
assert.ok(labelStart > 0 && labelEnd > labelStart);
const labelBox = { portalT(key) { return key; } };
vm.createContext(labelBox);
vm.runInContext(bookingsSrc.slice(labelStart, labelEnd) + '\nthis.adminBookingsOpenScheduleLabel = adminBookingsOpenScheduleLabel;', labelBox);
const aria = labelBox.adminBookingsOpenScheduleLabel('SUNSET-20260811-EA783E');
assert.ok(!/admin\.bookings\./.test(aria), aria);
assert.ok(aria.indexOf('SUNSET-20260811-EA783E') >= 0);
assert.ok(/Schedule|schedule|Abrir|Agenda/i.test(aria), aria);
assert.ok(bookingsSrc.includes('adminBookingsOpenScheduleLabel(code)'));

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
