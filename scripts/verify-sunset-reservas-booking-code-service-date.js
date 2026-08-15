'use strict';

/**
 * Reservas booking-code → Horario must land on the booking's service date.
 *
 * Bug: clicking a Reservas code opened Horario on today (forwardOffset 0 /
 * loadPortalHome before day nav; historically also clamped past offsets to 0).
 *
 * Stay off Inbox, email, language packs, production. No deploy.
 *
 * Run:
 *   node scripts/verify-sunset-reservas-booking-code-service-date.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const runtimeSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-runtime.js'), 'utf8');
const navSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-navigation-ui.js'), 'utf8');
const bookingsSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');

assert.ok(!/if \(offset < 0\) offset = 0;/.test(runtimeSrc), 'openDayDetail must not clamp past dates to today');
assert.ok(runtimeSrc.includes('function primeOpenDay'), 'runtime exposes primeOpenDay');
assert.ok(navSrc.includes('window.schedulePrimeOpenDay = schedulePrimeOpenDay'), 'primeOpenDay on window');
assert.ok(bookingsSrc.includes('schedulePrimeOpenDay'), 'Reservas primes service day before portal-home load');
assert.ok(bookingsSrc.includes('adminBookingsServiceDayIso'), 'Reservas normalizes service-day ISO');
assert.ok(!bookingsSrc.includes('inbox-thread.js'), 'stay off inbox-thread');

const TODAY = '2026-08-15';
const SERVICE = '2026-08-11'; // past — the clamp regression case
const BOOKING_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOOKING_CODE = 'SUNSET-20260811-EA783E';

function scheduleIsoDate(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function scheduleParseIso(s) {
  const p = String(s).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}
function scheduleAddDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}
function scheduleDaysFromToday(iso) {
  return Math.round((scheduleParseIso(iso) - scheduleParseIso(TODAY)) / 86400000);
}

const renders = [];
const dayFetches = [];
const dom = {
  'tab-portal-home': { classList: { contains() { return this._active; }, _active: false }, _active: false },
  'tab-bookings': { classList: { contains() { return this._active; }, _active: true }, _active: true },
};

const ctx = {
  console,
  portalT(k) { return k; },
  escHtml(s) { return String(s == null ? '' : s); },
  scheduleTodayIso: () => TODAY,
  scheduleIsoDate,
  scheduleParseIso,
  scheduleAddDays,
  scheduleDaysFromToday,
  scheduleFormatRangeLabel(s) { return scheduleIsoDate(s); },
  el(id) { return dom[id] || null; },
  document: { querySelectorAll() { return []; } },
  getClient: () => 'sunset',
  getPortalProfile: () => ({ is_surf_vertical: true }),
  renderScheduleSchoolContext() {},
  fetch(url) {
    const u = String(url);
    const m = /date=([^&]+)/.exec(u);
    if (m) dayFetches.push(decodeURIComponent(m[1]));
    return Promise.resolve({ ok: true, json: () => ({ rows: [], conversations: [] }) });
  },
  inboxClientQuery: () => '?client=sunset',
  sunsetLocationQuerySuffix: () => '&location_id=sunset-somo',
  scheduleFetchLessonTimesConfig: () => Promise.resolve([]),
  scheduleBuildLoadedViewModel(_w, _c, _p, rangeStart, snap) {
    return {
      canonicalRows: [], rows: [], weekData: [], presentationOnlyRows: [],
      conversations: [], profile: _p, rangeStart, navSnapshot: snap,
    };
  },
  scheduleRenderLoadedViewModel(_vm, gen, snap) {
    renders.push({ gen, iso: snap && snap.rangeStartIso, mode: snap && snap.mode });
  },
  window: {},
};

vm.createContext(ctx);
ctx.window = ctx;
vm.runInContext(runtimeSrc, ctx);
vm.runInContext(navSrc, ctx);

// Production-shaped openBookingInSchedule (tab then day) — mirrors inbox-thread
// without loading that file (stay off inbox-thread).
ctx.openBookingInSchedule = function openBookingInSchedule(booking) {
  booking = booking || {};
  const tabFn = typeof ctx.window.switchToTab === 'function' ? ctx.window.switchToTab : null;
  if (tabFn) tabFn('portal-home', null);
  let start = booking.service_date_start || booking.service_date || booking.check_in || '';
  start = start ? String(start).slice(0, 10) : '';
  const dayFn = typeof ctx.window.scheduleOpenDayDetail === 'function'
    ? ctx.window.scheduleOpenDayDetail
    : null;
  const drawerFn = typeof ctx.window.openScheduleDetailDrawer === 'function'
    ? ctx.window.openScheduleDetailDrawer
    : null;
  function openDrawer() {
    if (!drawerFn) return;
    drawerFn({
      booking_id: booking.booking_id || null,
      booking_code: booking.booking_code || null,
      guest_name: booking.guest_name || '',
      service_date: start || null,
      _drawerFromCustomer: true,
    });
  }
  if (start && dayFn) {
    const navResult = dayFn(start);
    if (navResult && typeof navResult.then === 'function') {
      navResult.then(openDrawer).catch(openDrawer);
      return;
    }
  }
  openDrawer();
};
ctx.window.openBookingInSchedule = ctx.openBookingInSchedule;

ctx.window.switchToTab = function switchToTab(tab) {
  Object.keys(dom).forEach((id) => { dom[id]._active = false; });
  if (tab === 'portal-home') {
    dom['tab-portal-home']._active = true;
    // Production switchToTab always loadPortalHome()'s current offset.
    ctx.SunsetScheduleRuntime.load.loadPage();
  } else if (tab === 'bookings') {
    dom['tab-bookings']._active = true;
  }
};
ctx.switchToTab = ctx.window.switchToTab;

const drawers = [];
ctx.window.openScheduleDetailDrawer = function (row) { drawers.push(row); };
ctx.openScheduleDetailDrawer = ctx.window.openScheduleDetailDrawer;

// Extract adminBookings helpers from the bookings UI module.
const isoStart = bookingsSrc.indexOf('function adminBookingsServiceDayIso');
const openStart = bookingsSrc.indexOf('function adminBookingsOpenInSchedule');
assert.ok(isoStart > 0 && openStart > isoStart);
const openEnd = bookingsSrc.indexOf('\nfunction adminBookingsTypeChipsHtml', openStart);
assert.ok(openEnd > openStart);
const helperSrc = bookingsSrc.slice(isoStart, openEnd)
  + '\nthis.adminBookingsServiceDayIso = adminBookingsServiceDayIso;'
  + '\nthis.adminBookingsOpenInSchedule = adminBookingsOpenInSchedule;';

ctx.adminBookingsState = {
  data: {
    rows: [{
      booking_id: BOOKING_ID,
      booking_code: BOOKING_CODE,
      guest_name: 'Gary',
      service_date_start: SERVICE,
      service_date_end: SERVICE,
      items: [{ service_date: SERVICE }],
    }],
  },
};

vm.runInContext(helperSrc, ctx);

assert.strictEqual(ctx.adminBookingsServiceDayIso(SERVICE), SERVICE);
assert.strictEqual(ctx.adminBookingsServiceDayIso('2026-08-11T00:00:00.000Z'), SERVICE);
assert.strictEqual(ctx.adminBookingsServiceDayIso('not-a-date'), '');
assert.strictEqual(ctx.adminBookingsServiceDayIso(new Date(2026, 7, 11)), SERVICE);

(async function main() {
  renders.length = 0;
  dayFetches.length = 0;
  drawers.length = 0;
  // Start as if staff were on Reservas with Horario parked on today.
  ctx.scheduleNavigateToday();
  await new Promise((r) => setTimeout(r, 10));
  renders.length = 0;
  dayFetches.length = 0;

  ctx.adminBookingsOpenInSchedule(BOOKING_ID, {
    booking_code: BOOKING_CODE,
    service_date_start: SERVICE,
  });
  await new Promise((r) => setTimeout(r, 40));

  const snap = ctx.scheduleGetNavigationSnapshot();
  assert.strictEqual(snap.mode, 'day', 'Horario is in day mode');
  assert.strictEqual(snap.forwardOffset, -4, 'forwardOffset is service day relative to today');
  assert.strictEqual(snap.rangeStartIso, SERVICE, 'range starts on booking service date');
  assert.strictEqual(ctx.scheduleActiveDayIso(), SERVICE, 'active day is booking service date, not today');

  assert.ok(renders.length >= 1, 'at least one schedule render');
  const last = renders[renders.length - 1];
  assert.strictEqual(last.iso, SERVICE, 'final render is service date, not today');
  assert.ok(!renders.some((r) => r.iso === TODAY), 'today must never win the final render race');

  assert.ok(drawers.length >= 1, 'detail drawer opened');
  assert.strictEqual(drawers[0].booking_id, BOOKING_ID);
  assert.strictEqual(drawers[0].booking_code, BOOKING_CODE);
  assert.strictEqual(drawers[0].service_date, SERVICE);

  // Button-hint path when row state is missing the date.
  ctx.adminBookingsState.data.rows = [{ booking_id: BOOKING_ID, booking_code: BOOKING_CODE, guest_name: 'Gary' }];
  renders.length = 0;
  ctx.scheduleNavigateToday();
  await new Promise((r) => setTimeout(r, 10));
  renders.length = 0;
  ctx.adminBookingsOpenInSchedule(BOOKING_ID, { service_date_start: SERVICE, booking_code: BOOKING_CODE });
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(ctx.scheduleActiveDayIso(), SERVICE, 'button data-service-date-start still lands on service day');

  // Negative seam: disabled production owner must not navigate.
  ctx.scheduleNavigateToday();
  await new Promise((r) => setTimeout(r, 10));
  const todayAfter = ctx.scheduleActiveDayIso();
  assert.strictEqual(todayAfter, TODAY);
  dom['tab-portal-home']._active = false;
  dom['tab-bookings']._active = true;
  ctx.window.openBookingInSchedule = function disabled() { /* noop */ };
  const fetchesBefore = dayFetches.length;
  const drawersBefore = drawers.length;
  ctx.adminBookingsOpenInSchedule(BOOKING_ID, { service_date_start: '2026-08-20' });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(ctx.scheduleActiveDayIso(), TODAY,
    'disabled openBookingInSchedule does not jump to another service day');
  assert.strictEqual(dayFetches.length, fetchesBefore, 'disabled owner starts no new day fetches');
  assert.strictEqual(drawers.length, drawersBefore, 'disabled owner opens no drawer');

  console.log('PASS Reservas booking-code opens Horario on service date (not today)');
  console.log(JSON.stringify({
    service_date: SERVICE,
    today: TODAY,
    final_active_on_happy_path: SERVICE,
  }));
})().catch((err) => {
  console.error('FAIL', err && err.stack ? err.stack : err);
  process.exit(1);
});
