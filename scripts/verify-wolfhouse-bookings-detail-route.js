'use strict';

/**
 * Wolfhouse Bookings must reuse the visible canonical lodging side drawer
 * instead of the Sunset-only /staff/schedule/bookings/detail route (403).
 * The drawer must be body-ported and initialized so direct Bookings entry and
 * mobile widths remain visible and closable.
 *
 * Run: node scripts/verify-wolfhouse-bookings-detail-route.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
const isoStart = src.indexOf('function adminBookingsServiceDayIso');
const openStart = src.indexOf('function adminBookingsOpenInSchedule');
const openEnd = src.indexOf('\nfunction adminBookingsTypeChipsHtml', openStart);
assert.ok(isoStart > 0 && openStart > isoStart && openEnd > openStart, 'helper bounds');
const helperSrc = src.slice(isoStart, openEnd)
  + '\nthis.adminBookingsServiceDayIso = adminBookingsServiceDayIso;'
  + '\nthis.adminBookingsOpenInSchedule = adminBookingsOpenInSchedule;';

const BOOKING_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOOKING_CODE = 'MB-WOLFHO-20260923-56cb82';

function runAtWidth(width) {
  const lodgingCalls = [];
  const sunsetCalls = [];
  const initCalls = [];
  const scheduleTab = { id: 'tab-bed-calendar', children: [] };
  const sideDrawer = { id: 'bc-side-drawer', parentNode: scheduleTab };
  scheduleTab.children.push(sideDrawer);
  const body = {
    appendChild(node) {
      if (node.parentNode && Array.isArray(node.parentNode.children)) {
        node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
      }
      node.parentNode = body;
    },
  };
  const ctx = {
    console,
    getClient() { return 'wolfhouse-somo'; },
    adminBookingsIsLodging() { return true; },
    adminBookingsState: {
      filters: { q: 'gina', status: 'confirmed' },
      data: { rows: [{
        booking_id: BOOKING_ID,
        booking_code: BOOKING_CODE,
        guest_name: 'Gina',
        check_in: '2026-09-23',
      }] },
    },
    el(id) { return id === 'bc-side-drawer' ? sideDrawer : null; },
    document: { body, getElementById(id) { return id === 'bc-side-drawer' ? sideDrawer : null; } },
    window: { innerWidth: width },
  };
  ctx.window.window = ctx.window;
  ctx.window.document = ctx.document;
  ctx.window.el = ctx.el;
  ctx.window.adminBookingsIsLodging = ctx.adminBookingsIsLodging;
  ctx.window.bcInitSideDrawer = () => initCalls.push('init');
  ctx.bcInitSideDrawer = ctx.window.bcInitSideDrawer;
  ctx.window.bcOpenSideBooking = (row, opts) => lodgingCalls.push({ row, opts });
  ctx.bcOpenSideBooking = ctx.window.bcOpenSideBooking;
  ctx.window.openScheduleDetailDrawer = (row) => sunsetCalls.push(row);
  ctx.openScheduleDetailDrawer = ctx.window.openScheduleDetailDrawer;
  ctx.window.scheduleDrawerEnsureDocumentLayer = () => { ctx._sunsetLayerEnsured = true; };
  ctx.scheduleDrawerEnsureDocumentLayer = ctx.window.scheduleDrawerEnsureDocumentLayer;

  vm.createContext(ctx);
  vm.runInContext(helperSrc, ctx);
  const filtersBefore = JSON.stringify(ctx.adminBookingsState.filters);
  ctx.adminBookingsOpenInSchedule(BOOKING_ID, { booking_code: BOOKING_CODE });

  assert.strictEqual(sideDrawer.parentNode, body, `width ${width}: drawer is body-ported and visible outside hidden Schedule tab`);
  assert.strictEqual(initCalls.length, 1, `width ${width}: close/pin/Escape handlers initialized`);
  assert.strictEqual(lodgingCalls.length, 1, `width ${width}: Wolfhouse opens canonical lodging drawer once`);
  assert.strictEqual(lodgingCalls[0].row.booking_id, BOOKING_ID);
  assert.strictEqual(lodgingCalls[0].row.booking_code, BOOKING_CODE);
  assert.strictEqual(lodgingCalls[0].row.guest_name, 'Gina');
  assert.strictEqual(lodgingCalls[0].opts.pin, true, `width ${width}: drawer is pinned like Schedule click`);
  assert.strictEqual(sunsetCalls.length, 0, `width ${width}: never calls Sunset-only schedule detail drawer`);
  assert.strictEqual(ctx._sunsetLayerEnsured, undefined, `width ${width}: does not prepare Sunset drawer shell`);
  assert.strictEqual(JSON.stringify(ctx.adminBookingsState.filters), filtersBefore, `width ${width}: Bookings filters stay intact`);
}

runAtWidth(1280);
runAtWidth(390);
console.log('verify:wolfhouse-bookings-detail-route PASSED (desktop + mobile)');
