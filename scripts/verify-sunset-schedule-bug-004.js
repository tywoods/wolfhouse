'use strict';

/**
 * BUG-004 — Horario empty-state flash, drawer phone, Reservas guest-name stay.
 * Stay off Inbox, email, language packs, production.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const cockpitSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-day-cockpit-ui.js'), 'utf8');
const runtimeSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-runtime.js'), 'utf8');
const drawerCtrl = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-controller.js'), 'utf8');
const bookingsUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

assert.ok(runtimeSrc.includes('pageLoading: true'));
assert.ok(runtimeSrc.includes('isPageLoading:'));
assert.ok(cockpitSrc.includes('loadingHero'));
assert.ok(cockpitSrc.includes("scheduleCockpitT('daySchedule.loading'"));
assert.ok(drawerCtrl.includes('scheduleGroupHasPhone(ctx)'));
assert.ok(apiSrc.includes('group.phone || group.guest_phone || group.booking_phone'));
assert.ok(!bookingsUi.includes("from: 'admin-bookings'"));
assert.ok(bookingsUi.includes('adminBookingsState.expandedId = adminBookingsState.expandedId === guestId'));
assert.ok(!cockpitSrc.includes('inbox-thread'));
assert.ok(!bookingsUi.includes('inbox-thread.js'));

const sandbox = {
  URL, console,
  portalT: (k) => k,
  escHtml: (s) => String(s == null ? '' : s),
  SunsetScheduleRuntime: { nav: { isPageLoading: () => true } },
};
vm.runInNewContext(cockpitSrc + '\nthis.scheduleBuildDayCockpitData = scheduleBuildDayCockpitData;\nthis.scheduleRenderDayCockpit = scheduleRenderDayCockpit;', sandbox);

function fakeMount() {
  const kids = [];
  const node = {
    children: kids,
    className: '',
    innerHTML: '',
    textContent: '',
    appendChild(c) { kids.push(c); return c; },
    classList: { add() {}, toggle() {} },
    setAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    style: { setProperty() {} },
  };
  return node;
}

if (typeof sandbox.scheduleBuildDayCockpitData === 'function') {
  const data = sandbox.scheduleBuildDayCockpitData({
    date: '2026-08-15',
    navMode: 'day',
    sessions: [],
    loading: true,
    venue: 'Sunset',
  });
  assert.strictEqual(data.loading, true);
}

console.log('PASS BUG-004 loading flag + drawer phone + Reservas stay');
