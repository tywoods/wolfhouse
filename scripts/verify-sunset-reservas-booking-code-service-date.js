'use strict';

/**
 * Reservas booking-code → drawer must stay on Bookings (not Horario).
 *
 * Bug: clicking a Reservas code called openBookingInSchedule → switchToTab
 * ('portal-home'), so the page behind the drawer became Schedule. Close
 * (X / Escape / backdrop) dumped staff on Horario and lost the filtered list.
 *
 * Contract: openScheduleDetailDrawer over Reservas; never switchToTab /
 * schedule day nav. Filters in adminBookingsState stay intact.
 *
 * Stay off Inbox, email, Hermes/SOUL, production. No deploy.
 *
 * Run:
 *   node scripts/verify-sunset-reservas-booking-code-service-date.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const bookingsSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');

assert.ok(bookingsSrc.includes('function adminBookingsOpenInSchedule'), 'open helper present');
assert.ok(bookingsSrc.includes('function adminBookingsServiceDayIso'), 'service-day ISO helper present');
assert.ok(bookingsSrc.includes('openScheduleDetailDrawer'), 'opens shared detail drawer');
assert.ok(bookingsSrc.includes('_drawerFromCustomer: true'), 'uses customer/drawer fetch shape');
assert.ok(
  /Do not deep-link into Horario|Bookings stays active/.test(bookingsSrc),
  'documents stay-on-Reservas contract'
);
// Call-sites only — comments may mention the forbidden Horario deep-link.
assert.ok(!/\bopenBookingInSchedule\s*\(/.test(bookingsSrc), 'must not call openBookingInSchedule');
assert.ok(!/\bswitchToTab\s*\(\s*['"]portal-home['"]/.test(bookingsSrc), 'must not switch to Horario');
assert.ok(!/\bschedulePrimeOpenDay\b/.test(bookingsSrc), 'must not prime Horario day nav');
assert.ok(!/\bscheduleOpenDayDetail\b/.test(bookingsSrc), 'must not navigate Horario day');
assert.ok(!bookingsSrc.includes('inbox-thread.js'), 'stay off inbox-thread');

const SERVICE = '2026-08-11';
const BOOKING_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOOKING_CODE = 'SUNSET-20260811-EA783E';

const tabs = { bookings: true, 'portal-home': false };
const drawers = [];
const tabCalls = [];
const dayCalls = [];
const primeCalls = [];

const ctx = {
  console,
  portalT(k) { return k; },
  escHtml(s) { return String(s == null ? '' : s); },
  el() { return null; },
  document: {
    body: {
      appendChild() {},
    },
    getElementById() { return null; },
  },
  window: {},
  adminBookingsState: {
    filters: { q: 'gary', status: 'paid', date_from: '2026-08-01', date_to: '2026-08-31' },
    data: {
      rows: [{
        booking_id: BOOKING_ID,
        booking_code: BOOKING_CODE,
        guest_name: 'Gary',
        phone: '+34600111222',
        service_date_start: SERVICE,
        service_date_end: SERVICE,
        items: [{ service_date: SERVICE }],
      }],
    },
  },
};

ctx.window = ctx;
ctx.switchToTab = function switchToTab(tab) {
  tabCalls.push(String(tab || ''));
  tabs.bookings = tab === 'bookings';
  tabs['portal-home'] = tab === 'portal-home';
};
ctx.window.switchToTab = ctx.switchToTab;
ctx.window.scheduleOpenDayDetail = function (iso) {
  dayCalls.push(String(iso || ''));
  return Promise.resolve({ ok: true, iso: String(iso || '') });
};
ctx.scheduleOpenDayDetail = ctx.window.scheduleOpenDayDetail;
ctx.window.schedulePrimeOpenDay = function (iso) {
  primeCalls.push(String(iso || ''));
  return { mode: 'day', rangeStartIso: String(iso || '') };
};
ctx.schedulePrimeOpenDay = ctx.window.schedulePrimeOpenDay;
ctx.window.openBookingInSchedule = function openBookingInSchedule() {
  // Production owner still exists on the portal for Inbox/Customers deep-links,
  // but Reservas must not invoke it (that path switches to Horario).
  tabCalls.push('openBookingInSchedule-called');
  ctx.switchToTab('portal-home');
};
ctx.openBookingInSchedule = ctx.window.openBookingInSchedule;
ctx.window.openScheduleDetailDrawer = function (row) {
  drawers.push(row);
};
ctx.openScheduleDetailDrawer = ctx.window.openScheduleDetailDrawer;
ctx.window.scheduleDrawerEnsureDocumentLayer = function () {
  ctx._layerEnsured = true;
};
ctx.scheduleDrawerEnsureDocumentLayer = ctx.window.scheduleDrawerEnsureDocumentLayer;

const isoStart = bookingsSrc.indexOf('function adminBookingsServiceDayIso');
const openStart = bookingsSrc.indexOf('function adminBookingsOpenInSchedule');
assert.ok(isoStart > 0 && openStart > isoStart);
const openEnd = bookingsSrc.indexOf('\nfunction adminBookingsTypeChipsHtml', openStart);
assert.ok(openEnd > openStart);
const helperSrc = bookingsSrc.slice(isoStart, openEnd)
  + '\nthis.adminBookingsServiceDayIso = adminBookingsServiceDayIso;'
  + '\nthis.adminBookingsOpenInSchedule = adminBookingsOpenInSchedule;';

vm.createContext(ctx);
vm.runInContext(helperSrc, ctx);

assert.strictEqual(ctx.adminBookingsServiceDayIso(SERVICE), SERVICE);
assert.strictEqual(ctx.adminBookingsServiceDayIso('2026-08-11T00:00:00.000Z'), SERVICE);
assert.strictEqual(ctx.adminBookingsServiceDayIso('not-a-date'), '');
assert.strictEqual(ctx.adminBookingsServiceDayIso(new Date(2026, 7, 11)), SERVICE);

const filtersBefore = JSON.stringify(ctx.adminBookingsState.filters);

ctx.adminBookingsOpenInSchedule(BOOKING_ID, {
  booking_code: BOOKING_CODE,
  service_date_start: SERVICE,
});

assert.strictEqual(tabs.bookings, true, 'Bookings tab stays active');
assert.strictEqual(tabs['portal-home'], false, 'Horario tab stays inactive');
assert.deepStrictEqual(tabCalls, [], 'never switchToTab / openBookingInSchedule');
assert.deepStrictEqual(dayCalls, [], 'never scheduleOpenDayDetail');
assert.deepStrictEqual(primeCalls, [], 'never schedulePrimeOpenDay');
assert.ok(ctx._layerEnsured, 'ports drawer shell onto document.body');
assert.strictEqual(drawers.length, 1, 'detail drawer opened once');
assert.strictEqual(drawers[0].booking_id, BOOKING_ID);
assert.strictEqual(drawers[0].booking_code, BOOKING_CODE);
assert.strictEqual(drawers[0].service_date, SERVICE);
assert.strictEqual(drawers[0]._drawerFromCustomer, true);
assert.strictEqual(JSON.stringify(ctx.adminBookingsState.filters), filtersBefore,
  'filters unchanged while drawer is open');

// Hint path when row state lacks the service date.
ctx.adminBookingsState.data.rows = [{ booking_id: BOOKING_ID, booking_code: BOOKING_CODE, guest_name: 'Gary' }];
drawers.length = 0;
ctx.adminBookingsOpenInSchedule(BOOKING_ID, { service_date_start: SERVICE, booking_code: BOOKING_CODE });
assert.strictEqual(drawers.length, 1, 'hint path still opens drawer');
assert.strictEqual(drawers[0].service_date, SERVICE, 'hint service_date reaches drawer');
assert.deepStrictEqual(tabCalls, [], 'hint path still never switches tab');

// Close simulation: hide drawer without touching tabs/filters (matches closeScheduleDetailDrawer).
drawers.length = 0;
assert.strictEqual(tabs.bookings, true, 'after close, still on Bookings');
assert.strictEqual(JSON.stringify(ctx.adminBookingsState.filters), filtersBefore,
  'after close, filtered Reservas state intact');

// Negative seam: missing drawer owner → no tab jump, no drawer.
ctx.window.openScheduleDetailDrawer = null;
ctx.openScheduleDetailDrawer = null;
ctx.adminBookingsOpenInSchedule(BOOKING_ID, { service_date_start: '2026-08-20' });
assert.strictEqual(drawers.length, 0, 'no drawer when owner missing');
assert.deepStrictEqual(tabCalls, [], 'missing drawer owner must not fall back to Horario');

console.log('PASS Reservas booking-code opens drawer over Bookings (filters intact)');
console.log(JSON.stringify({
  booking_id: BOOKING_ID,
  service_date: SERVICE,
  tab_calls: tabCalls.length,
  day_calls: dayCalls.length,
  filters: ctx.adminBookingsState.filters,
}));
