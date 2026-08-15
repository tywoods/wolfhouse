'use strict';

/**
 * BUG-004 — Horario empty-state flash, drawer phone, Reservas guest-name stay.
 * Stay off Inbox, email, language packs, production.
 *
 * Empty-flash contract:
 *  1) While pageLoading, an empty board renders Loading — never schedule.emptyDay.
 *  2) After load settles (pageLoading false), a truly empty day renders emptyDay.
 *  3) At load start, scheduleAnnounceSchedulePageLoading swaps a stale empty
 *     message for Loading so a booked day never flashes empty while fetching.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const cockpitSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-day-cockpit-ui.js'), 'utf8');
const runtimeSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-runtime.js'), 'utf8');
const opsSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-day-ops-board-ui.js'), 'utf8');
const drawerCtrl = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-controller.js'), 'utf8');
const bookingsUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

assert.ok(runtimeSrc.includes('pageLoading: true'));
assert.ok(runtimeSrc.includes('isPageLoading:'));
assert.ok(runtimeSrc.includes('scheduleAnnounceSchedulePageLoading'));
assert.ok(runtimeSrc.includes('navState.pageLoading = false;\n      scheduleRenderLoadedViewModel')
  || /pageLoading = false;\s*scheduleRenderLoadedViewModel/.test(runtimeSrc),
  'pageLoading clears before final paint so true empty days are not stuck on Loading');
assert.ok(opsSrc.includes('function scheduleAnnounceSchedulePageLoading'));
assert.ok(opsSrc.includes('portal-schedule-ops-empty'));
assert.ok(cockpitSrc.includes('loadingHero'));
assert.ok(cockpitSrc.includes("scheduleCockpitT('daySchedule.loading'"));
assert.ok(drawerCtrl.includes('scheduleGroupHasPhone(ctx)'));
assert.ok(apiSrc.includes('group.phone || group.guest_phone || group.booking_phone'));
assert.ok(!bookingsUi.includes("from: 'admin-bookings'"));
assert.ok(bookingsUi.includes('function adminBookingsOpenGuestPeek'));
assert.ok(bookingsUi.includes('adminBookingsOpenGuestPeek(phone'));
assert.ok(!/openCustomerCardForPhone\s*\(/.test(bookingsUi));
assert.ok(!cockpitSrc.includes('inbox-thread'));
assert.ok(!bookingsUi.includes('inbox-thread.js'));
assert.ok(!opsSrc.includes('inbox-thread'));

// ── behavioral: empty board html respects pageLoading ─────────────────────
{
  let pageLoading = true;
  const i18n = {
    'daySchedule.loading': 'Loading schedule…',
    'schedule.emptyDay': 'Nothing scheduled',
  };
  const sandbox = {
    console,
    portalT: (k) => i18n[k] || k,
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    SunsetScheduleRuntime: {
      nav: { isPageLoading: () => pageLoading === true },
    },
    scheduleCoursesCache: [],
    scheduleLessonTimesFallback: false,
    scheduleTodayIso: () => '2026-08-15',
    scheduleBuildDaySessions: () => [],
    scheduleAttachCancelledCourseGroups() {},
    scheduleGetDayOpsLayoutMode: () => 'timeline',
    scheduleSelectRentalPickupGroups: () => [],
    scheduleBuildDisplayGroups: () => [],
    scheduleGroupHasRentalPickups: () => false,
    scheduleMinutesLabel: (m) => String(m),
  };
  const renderStart = opsSrc.indexOf('function scheduleRenderDayOpsBoardHtml');
  const renderEnd = opsSrc.indexOf('function scheduleResolveDayOpsRowFromChip');
  assert.ok(renderStart >= 0 && renderEnd > renderStart, 'production board renderer is extractable');
  vm.createContext(sandbox);
  vm.runInContext(
    opsSrc.slice(renderStart, renderEnd) +
      '\nthis.scheduleRenderDayOpsBoardHtml = scheduleRenderDayOpsBoardHtml;',
    sandbox
  );

  pageLoading = true;
  let html = sandbox.scheduleRenderDayOpsBoardHtml({ rows: [] }, '2026-08-15', []);
  assert.ok(html.includes('Loading schedule…'), 'loading day must not show emptyDay');
  assert.ok(!html.includes('Nothing scheduled'), 'no empty flash while loading');

  pageLoading = false;
  html = sandbox.scheduleRenderDayOpsBoardHtml({ rows: [] }, '2026-08-15', []);
  assert.ok(html.includes('Nothing scheduled'), 'settled empty day shows emptyDay');
  assert.ok(!html.includes('Loading schedule…'), 'settled empty day is not stuck on Loading');
}

// ── behavioral: announce swaps stale empty → loading, leaves booked html ──
{
  const i18n = { 'daySchedule.loading': 'Loading schedule…' };
  let painted = 0;
  const emptyBoard = {
    className: '',
    innerHTML: '<div class="portal-schedule-ops-empty">Nothing scheduled</div>',
    querySelector(sel) {
      if (sel === '.portal-schedule-ops-empty' && /portal-schedule-ops-empty/.test(this.innerHTML)) {
        return { className: 'portal-schedule-ops-empty' };
      }
      return null;
    },
  };
  const bookedBoard = {
    className: 'portal-schedule-ops-board',
    innerHTML: '<div class="portal-schedule-timeline"><section data-ps-booking-id="b1">Guest</section></div>',
    querySelector(sel) {
      if (sel === '.portal-schedule-ops-empty') return null;
      return null;
    },
  };
  let current = emptyBoard;
  const box = {
    get className() { return current.className; },
    set className(v) { current.className = v; },
    get innerHTML() { return current.innerHTML; },
    set innerHTML(v) { current.innerHTML = v; },
    querySelector(sel) { return current.querySelector(sel); },
  };
  const announceSandbox = {
    console,
    portalT: (k) => i18n[k] || k,
    escHtml: (s) => String(s == null ? '' : s),
    el: (id) => (id === 'ps-ops-board' ? box : null),
    schedulePaintDayCockpit() { painted += 1; },
  };
  const announceStart = opsSrc.indexOf('function scheduleAnnounceSchedulePageLoading');
  const announceEnd = opsSrc.indexOf('function renderScheduleDayOpsBoard');
  assert.ok(announceStart >= 0 && announceEnd > announceStart);
  vm.createContext(announceSandbox);
  vm.runInContext(
    opsSrc.slice(announceStart, announceEnd) +
      '\nthis.scheduleAnnounceSchedulePageLoading = scheduleAnnounceSchedulePageLoading;',
    announceSandbox
  );

  current = emptyBoard;
  announceSandbox.scheduleAnnounceSchedulePageLoading();
  assert.ok(emptyBoard.innerHTML.includes('Loading schedule…'), 'stale empty → loading');
  assert.ok(!emptyBoard.innerHTML.includes('Nothing scheduled'), 'empty copy cleared at load start');
  assert.strictEqual(painted, 1, 'cockpit re-paints on announce');

  current = bookedBoard;
  const before = bookedBoard.innerHTML;
  announceSandbox.scheduleAnnounceSchedulePageLoading();
  assert.strictEqual(bookedBoard.innerHTML, before, 'booked board left intact during load');
  assert.strictEqual(painted, 2, 'cockpit still re-paints when board has bookings');
}

// ── cockpit loading flag still wired ──────────────────────────────────────
{
  const sandbox = {
    URL, console,
    portalT: (k) => k,
    escHtml: (s) => String(s == null ? '' : s),
    SunsetScheduleRuntime: { nav: { isPageLoading: () => true } },
  };
  vm.runInNewContext(
    cockpitSrc +
      '\nthis.scheduleBuildDayCockpitData = scheduleBuildDayCockpitData;' +
      '\nthis.scheduleRenderDayCockpit = scheduleRenderDayCockpit;',
    sandbox
  );
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
}

console.log('PASS BUG-004 empty-flash loading gate + announce + drawer phone + Reservas guest peek stay');
