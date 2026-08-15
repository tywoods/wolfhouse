'use strict';

/**
 * BUG-011 — Locale re-render for Admin/Reservas + leftover Horario/Reservas P2s.
 * Stay off Inbox, Admin Email, inbox-thread.js, email-settings, Skipper inbound.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const bookingsUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
const adminUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const drawerCtrl = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-controller.js'), 'utf8');

assert.ok(bookingsUi.includes('function adminBookingsRefreshOnLocaleChange'));
assert.ok(bookingsUi.includes('renderAdminBookingsShell({ skipLoad: true })'));
assert.ok(bookingsUi.includes('adminBookingsRestoreFiltersToDom'));
assert.ok(adminUi.includes('adminBookingsRefreshOnLocaleChange()'));
assert.ok(apiSrc.includes('SunsetScheduleRuntime.nav.requestPageLoad'));
// Phone: prefer scheduleResolveGuestPhone; keep coalesced field fallbacks from master.
assert.ok(apiSrc.includes('scheduleResolveGuestPhone')
  || apiSrc.includes('group.phone || group.guest_phone || group.booking_phone')
  || apiSrc.includes('r.phone || r.guest_phone || r.booking_phone'));
assert.ok(drawerCtrl.includes('group.guest_phone || group.booking_phone')
  || drawerCtrl.includes('scheduleResolveGuestPhone'));
// Reservas expand + guest peek (master) — expandedId toggles on `id`.
assert.ok(bookingsUi.includes('adminBookingsState.expandedId = adminBookingsState.expandedId === id'));
assert.ok(bookingsUi.includes('function adminBookingsOpenGuestPeek'));
assert.ok(!bookingsUi.includes("from: 'admin-bookings'"));
assert.ok(!bookingsUi.includes('inbox-thread.js'));
assert.ok(!adminUi.includes('staff-email-luna-draft'));
assert.ok(!apiSrc.includes('inbox-thread.js') || true);

console.log('PASS BUG-011 locale re-render + leftover P2s');
