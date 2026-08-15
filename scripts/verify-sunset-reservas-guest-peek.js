'use strict';

/**
 * P2 — Reservas guest name opens in-place peek; never jumps to Inbox/Clientes.
 * Stay off inbox-thread.js, email inbound/poller/Graph, Admin Email backend, production.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const bookingsUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const i18n = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');

assert.ok(bookingsUi.includes('function adminBookingsOpenGuestPeek'), 'open guest peek helper');
assert.ok(bookingsUi.includes('function adminBookingsCloseGuestPeek'), 'close guest peek helper');
assert.ok(bookingsUi.includes('function adminBookingsRenderGuestPeek'), 'render guest peek');
assert.ok(bookingsUi.includes('adminBookingsOpenGuestPeek(phone'), 'click path opens peek');
assert.ok(bookingsUi.includes('adminBookingsOpenGuestPeek(phoneKey'), 'keyboard path opens peek');
assert.ok(!bookingsUi.includes("from: 'admin-bookings'"), 'no legacy Customers jump opts');
assert.ok(!/openCustomerCardForPhone\s*\(/.test(bookingsUi), 'never calls openCustomerCardForPhone');
assert.ok(!/switchToTab\s*\(\s*['"]customers['"]/.test(bookingsUi), 'never switchToTab customers from bookings UI');
assert.ok(!bookingsUi.includes('inbox-thread'), 'stay off inbox-thread');
assert.ok(apiSrc.includes('.portal-admin-bookings-guest-peek-panel'), 'peek panel CSS present');
assert.ok(i18n.includes("'admin.bookings.guestPeek.title'"), 'i18n title key');
assert.ok(i18n.includes("'admin.bookings.guestPeek.stayHint'"), 'i18n stay hint key');

// Smoke: guest peek opens without tab switch; closes on Escape path.
const calls = { switchToTab: [], openCustomer: [] };
const sandbox = {
  console,
  document: {
    body: { dataset: {}, addEventListener() {} },
    createElement(tag) {
      return {
        tagName: String(tag || '').toUpperCase(),
        className: '',
        dataset: {},
        style: {},
        innerHTML: '',
        setAttribute() {},
        addEventListener() {},
        querySelector() { return null; },
        appendChild() {},
        parentNode: null,
      };
    },
    querySelector() { return null; },
    addEventListener() {},
  },
  window: {},
  el(id) {
    if (id === 'admin-bookings-body') {
      return {
        dataset: {},
        querySelector() { return null; },
        appendChild(node) { this._child = node; return node; },
      };
    }
    return null;
  },
  portalT(k) { return k; },
  escHtml(s) { return String(s == null ? '' : s).replace(/</g, '&lt;'); },
  getClient() { return 'sunset'; },
  getSunsetLocation() { return 'sunset-somo'; },
  fetch() {
    return Promise.resolve({
      ok: true,
      json() {
        return Promise.resolve({
          identity: { display_name: 'Ada', phone: '+34600111222', email: 'ada@example.com' },
        });
      },
    });
  },
  switchToTab() { calls.switchToTab.push([].slice.call(arguments)); },
  openCustomerCardForPhone() { calls.openCustomer.push([].slice.call(arguments)); },
  openBookingInSchedule() {},
  scheduleOpenDayDetail() {},
  openScheduleDetailDrawer() {},
  adminBookingsState: null,
};
sandbox.window = sandbox;

const start = bookingsUi.indexOf('var adminBookingsState = {');
const end = bookingsUi.indexOf('/* ── Bookings date-range picker');
assert.ok(start >= 0 && end > start, 'extract bookings guest peek source');
const slice = bookingsUi.slice(start, end) +
  '\nthis.adminBookingsState = adminBookingsState;' +
  '\nthis.adminBookingsOpenGuestPeek = adminBookingsOpenGuestPeek;' +
  '\nthis.adminBookingsCloseGuestPeek = adminBookingsCloseGuestPeek;' +
  '\nthis.adminBookingsRenderGuestPeek = adminBookingsRenderGuestPeek;';
vm.createContext(sandbox);
vm.runInContext(slice, sandbox);

sandbox.adminBookingsState.data = {
  rows: [{
    booking_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    booking_code: 'SUNSET-20260815-TEST',
    guest_name: 'Ada',
    phone: '+34600111222',
    waiver: { status: 'completed' },
  }],
};

sandbox.adminBookingsOpenGuestPeek('+34600111222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
assert.ok(sandbox.adminBookingsState.guestPeek, 'peek state set');
assert.strictEqual(calls.switchToTab.length, 0, 'no switchToTab on open');
assert.strictEqual(calls.openCustomer.length, 0, 'no openCustomerCardForPhone on open');

return Promise.resolve().then(function () {
  return new Promise(function (resolve) { setTimeout(resolve, 20); });
}).then(function () {
  assert.ok(sandbox.adminBookingsState.guestPeek, 'peek still open after fetch');
  assert.strictEqual(calls.switchToTab.length, 0, 'no switchToTab after fetch');
  assert.strictEqual(calls.openCustomer.length, 0, 'no Customers jump after fetch');
  sandbox.adminBookingsCloseGuestPeek();
  assert.strictEqual(sandbox.adminBookingsState.guestPeek, null, 'peek closed');
  console.log('PASS Reservas guest peek stays on Bookings (no Inbox/Clientes jump)');
}).catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
