'use strict';

/**
 * verify:sunset-bookings-side-panel-match-schedule-001
 *
 * Bookings (Reservas) opener must paint the same Schedule booking drawer
 * structure/actions — not a thinner Reservas-only panel.
 *
 * Audit (this job): clicking a Bookings code already called
 * openScheduleDetailDrawer({ _drawerFromCustomer: true }) but stripped
 * record_source. scheduleDrawerCanLoadCanonical / canEdit / canCancel then
 * returned false, so Horario showed Edit + Cancel/Restore/Hide and Reservas
 * omitted them (also weaker phone → Open customer / conversation).
 *
 * Stay off Crow's Nest, Inbox Chats/Guests, Email, production, Wolfhouse.
 *
 * Run:
 *   node scripts/verify-sunset-bookings-side-panel-match-schedule-001.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const BOOKINGS = path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js');
const PORTAL = path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js');
const CTRL = path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-controller.js');
const VIEW = path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-view-ui.js');
const ACTIONS = path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-actions.js');

const bookingsSrc = fs.readFileSync(BOOKINGS, 'utf8');
const portalSrc = fs.readFileSync(PORTAL, 'utf8');
const ctrlSrc = fs.readFileSync(CTRL, 'utf8');
const viewSrc = fs.readFileSync(VIEW, 'utf8');
const actionsSrc = fs.readFileSync(ACTIONS, 'utf8');

function extractFunctionSource(src, name) {
  const needle = `function ${name}(`;
  const start = src.indexOf(needle);
  if (start < 0) return null;
  const braceStart = src.indexOf('{', start);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function idsFromHtml(html) {
  const out = [];
  String(html || '').replace(/\bid="([^"]+)"/g, (_, id) => { out.push(id); return _; });
  return out.slice().sort();
}

console.log('\nverify:sunset-bookings-side-panel-match-schedule-001\n');

// ── Source contracts ────────────────────────────────────────────────────────
assert.ok(bookingsSrc.includes('function adminBookingsOpenInSchedule'), 'Bookings opener exists');
assert.ok(bookingsSrc.includes('openScheduleDetailDrawer'), 'Bookings reuses Schedule drawer opener');
assert.ok(bookingsSrc.includes('_drawerFromCustomer: true'), 'Bookings uses canonical customer/drawer fetch');
assert.ok(!/\bopenBookingInSchedule\s*\(/.test(bookingsSrc), 'must not deep-link Horario via openBookingInSchedule');
assert.ok(!bookingsSrc.includes('function scheduleRenderSunsetViewDrawerHtml'), 'must not copy-paste Schedule view renderer');
assert.ok(!bookingsSrc.includes('id="ps-drawer-edit"'), 'must not invent a Bookings-only Edit control');
assert.ok(portalSrc.includes('row._drawerFromCustomer') && portalSrc.includes('scheduleDrawerCanLoadCanonical'),
  'canonical load gate honors Reservas opener shape');
assert.ok(ctrlSrc.includes('function scheduleHydrateDrawerRowFromCtx'), 'controller hydrates opener row from detail ctx');
assert.ok(ctrlSrc.includes('window.scheduleDrawerEnsureDocumentLayer'), 'document-layer helper is exported for Reservas pre-port');
assert.ok(actionsSrc.includes('scheduleDrawerCanLoadCanonical(row || scheduleDrawerState.row)'),
  'Cancel/Restore/Hide share the canonical load gate');
assert.ok(/if \(canEdit\) html \+= .*ps-drawer-edit/.test(viewSrc.replace(/\n/g, ' ')),
  'Edit button is the shared view renderer, gated on canEdit');
assert.ok(viewSrc.includes('id="ps-drawer-waiver-box"'), 'shared waiver slot');
assert.ok(viewSrc.includes('scheduleRenderSunsetViewNotesSectionHtml'), 'shared notes slot');
assert.ok(viewSrc.includes('scheduleRenderSunsetMoneyActionsHtml'), 'shared pay-link slot');
assert.ok(viewSrc.includes('id="ps-drawer-conversation-btn"'), 'shared conversation action');
assert.ok(viewSrc.includes('scheduleRenderDrawerOpenCustomerBtnHtml'), 'shared open-customer action');
assert.ok(viewSrc.includes('id="ps-drawer-cancel-booking"'), 'shared cancel action');

assert.ok(/guest\.phone/.test(bookingsSrc), 'Bookings opener passes nested guest.phone');

// ── Real canLoadCanonical / canEdit ─────────────────────────────────────────
const gate = {
  __group: null,
  scheduleFindGroupForRow() { return gate.__group; },
  scheduleRowBookingRef(row, group) {
    const r = row || {};
    const g = group || {};
    return {
      booking_id: r.booking_id || g.booking_id || null,
      booking_code: r.booking_code || g.booking_code || null,
    };
  },
};
vm.createContext(gate);
['scheduleDrawerTrustedPersistedSource', 'scheduleDrawerGroupHasTrustedPersistedSource',
  'scheduleDrawerCanLoadCanonical', 'scheduleDrawerCanEdit'].forEach((name) => {
  const fnSrc = extractFunctionSource(portalSrc, name);
  assert.ok(fnSrc, `portal defines ${name}`);
  vm.runInContext(`${fnSrc}\nthis.${name}=${name};`, gate);
});

const UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STAFF_ROW = { record_source: 'staff_manual', booking_id: UUID, booking_code: 'SUNSET-STAFF-1', guest_name: 'Ada' };
const BOOKINGS_ROW = {
  _drawerFromCustomer: true,
  booking_id: UUID,
  booking_code: 'SUNSET-STAFF-1',
  guest_name: 'Ada',
  phone: '+34611111111',
};
const DEMO_ROW = {
  _isDemo: true,
  _drawerFromCustomer: true,
  booking_id: UUID,
  booking_code: 'SUNSET-DEMO-1',
};
const UNKNOWN_ROW = { record_source: 'mystery', booking_id: UUID };

gate.__group = { records: [STAFF_ROW], booking_id: UUID };
assert.strictEqual(gate.scheduleDrawerCanLoadCanonical(STAFF_ROW), true, 'Schedule staff row is canonical');
assert.strictEqual(gate.scheduleDrawerCanEdit(STAFF_ROW), true, 'Schedule staff row is editable');

gate.__group = null;
assert.strictEqual(gate.scheduleDrawerCanLoadCanonical(BOOKINGS_ROW), true, 'Bookings opener shape is canonical');
assert.strictEqual(gate.scheduleDrawerCanEdit(BOOKINGS_ROW), true, 'Bookings opener shape is editable (Edit must paint)');
assert.strictEqual(gate.scheduleDrawerCanLoadCanonical(DEMO_ROW), false, 'demo + _drawerFromCustomer stays blocked');
assert.strictEqual(gate.scheduleDrawerCanLoadCanonical(UNKNOWN_ROW), false, 'unknown source without flag stays blocked');
assert.strictEqual(
  gate.scheduleDrawerCanLoadCanonical({ _drawerFromCustomer: true, guest_name: 'No id' }),
  false,
  'flag without booking_id/code is not canonical',
);

// ── Shared danger-row HTML (Cancel) ─────────────────────────────────────────
const dangerVm = {
  portalT(k) { return k; },
  escHtml(s) { return String(s == null ? '' : s); },
  scheduleDrawerCanLoadCanonical: gate.scheduleDrawerCanLoadCanonical,
  scheduleDrawerBookingIsCancelled: null,
  scheduleDrawerCanCancelBooking(row, ctx) {
    if (!ctx || !ctx.booking_id) return false;
    if (dangerVm.scheduleDrawerBookingIsCancelled(ctx, row)) return false;
    return dangerVm.scheduleDrawerCanLoadCanonical(row);
  },
  scheduleDrawerCanRestoreBooking(row, ctx) {
    if (!ctx || !ctx.booking_id) return false;
    if (!dangerVm.scheduleDrawerBookingIsCancelled(ctx, row)) return false;
    return dangerVm.scheduleDrawerCanLoadCanonical(row);
  },
  scheduleDrawerCanDeleteBooking(row, ctx) {
    return dangerVm.scheduleDrawerCanRestoreBooking(row, ctx);
  },
};
vm.createContext(dangerVm);
['scheduleDrawerBookingIsCancelled', 'scheduleRenderDeleteBookingRowHtml'].forEach((name) => {
  const fnSrc = extractFunctionSource(viewSrc, name);
  assert.ok(fnSrc, `view defines ${name}`);
  vm.runInContext(`${fnSrc}\nthis.${name}=${name};`, dangerVm);
});

const liveCtx = { booking_id: UUID, booking_status: 'confirmed', guest_name: 'Ada' };
const cancelledCtx = { booking_id: UUID, booking_status: 'cancelled', guest_name: 'Ada' };
const staffCancel = dangerVm.scheduleRenderDeleteBookingRowHtml(liveCtx, STAFF_ROW);
const bookingsCancel = dangerVm.scheduleRenderDeleteBookingRowHtml(liveCtx, BOOKINGS_ROW);
assert.ok(staffCancel.includes('ps-drawer-cancel-booking'), 'Schedule paints Cancel');
assert.ok(bookingsCancel.includes('ps-drawer-cancel-booking'), 'Bookings paints Cancel (was missing)');
assert.strictEqual(idsFromHtml(staffCancel).join(','), idsFromHtml(bookingsCancel).join(','),
  'Cancel/danger-row IDs match Schedule vs Bookings');

const staffRestore = dangerVm.scheduleRenderDeleteBookingRowHtml(cancelledCtx, STAFF_ROW);
const bookingsRestore = dangerVm.scheduleRenderDeleteBookingRowHtml(cancelledCtx, BOOKINGS_ROW);
assert.ok(staffRestore.includes('ps-drawer-restore-booking'), 'Schedule paints Restore when cancelled');
assert.ok(bookingsRestore.includes('ps-drawer-restore-booking'), 'Bookings paints Restore when cancelled');
assert.ok(staffRestore.includes('ps-drawer-delete-booking'), 'Schedule paints Hide when cancelled');
assert.ok(bookingsRestore.includes('ps-drawer-delete-booking'), 'Bookings paints Hide when cancelled');
assert.strictEqual(idsFromHtml(staffRestore).join(','), idsFromHtml(bookingsRestore).join(','),
  'Restore/Hide IDs match Schedule vs Bookings');

// ── Bookings opener payload ─────────────────────────────────────────────────
const drawers = [];
const openerVm = {
  el() { return null; },
  document: { body: { appendChild() {} }, getElementById() { return null; } },
  window: {
    scheduleDrawerEnsureDocumentLayer() { openerVm._ported = true; },
    openScheduleDetailDrawer(row) { drawers.push(row); },
  },
  getClient() { return 'sunset'; },
  getSunsetLocation() { return 'sunset-somo'; },
  adminBookingsState: {
    data: {
      rows: [{
        booking_id: UUID,
        booking_code: 'SUNSET-STAFF-1',
        guest_name: '',
        guest: { name: 'Ada Lovelace', phone: '+34699990000', email: 'ada@example.com' },
        service_date_start: '2026-08-11',
        items: [{ service_date: '2026-08-11' }],
      }],
    },
  },
};
openerVm.window = Object.assign(openerVm, openerVm.window);
vm.createContext(openerVm);
const openSrc = extractFunctionSource(bookingsSrc, 'adminBookingsOpenInSchedule');
const isoSrc = extractFunctionSource(bookingsSrc, 'adminBookingsServiceDayIso');
assert.ok(openSrc && isoSrc, 'can extract Bookings opener helpers');
vm.runInContext(
  `${isoSrc}\n${openSrc}\nthis.adminBookingsOpenInSchedule=adminBookingsOpenInSchedule;\nthis.adminBookingsServiceDayIso=adminBookingsServiceDayIso;`,
  openerVm,
);
openerVm.adminBookingsOpenInSchedule(UUID);
assert.strictEqual(drawers.length, 1, 'opener calls shared drawer once');
assert.strictEqual(drawers[0]._drawerFromCustomer, true, 'opener marks customer/drawer fetch');
assert.strictEqual(drawers[0].booking_id, UUID, 'opener passes booking_id');
assert.strictEqual(drawers[0].booking_code, 'SUNSET-STAFF-1', 'opener passes booking_code');
assert.strictEqual(drawers[0].phone, '+34699990000', 'opener passes nested guest.phone');
assert.strictEqual(drawers[0].guest_name, 'Ada Lovelace', 'opener passes nested guest.name');
assert.ok(openerVm._ported, 'opener body-ports drawer via exported ensureLayer');

console.log('PASS sunset-bookings-side-panel-match-schedule-001');
