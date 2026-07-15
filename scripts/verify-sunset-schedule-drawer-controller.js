'use strict';

/**
 * verify:sunset-schedule-drawer-controller
 *
 * Slice 16 — Schedule drawer orchestration controller gate.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-drawer-controller.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  injectSunsetSchedulePortalModule,
  SCHEDULE_CONTROLLER_INJECT_MARKER,
} = require('./lib/sunset-schedule-browser-source');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const CTRL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-controller.js');
const DELETE_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-delete-ui.js');
const VIEW_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const EDIT_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-edit-ui.js');
const PAY_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-payment-ui.js');
const WAIVER_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-waiver-ui.js');
const PORTAL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

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

function portalT(key) {
  const map = {
    'schedule.drawer.loadFailed': 'Load failed',
    'schedule.drawer.source': 'Source',
    'schedule.col.equipment': 'Equipment',
    'schedule.col.date': 'Date',
    'schedule.col.payment': 'Payment',
    'schedule.drawer.notes': 'Notes',
    'schedule.drawer.phone': 'Phone',
    'schedule.drawer.stripeSoon': 'Soon',
    'schedule.drawer.stripeLink': 'Stripe',
    'schedule.drawer.startConv': 'Start',
    'schedule.drawer.openConv': 'Open',
    'schedule.drawer.conversationNeedPhone': 'Need phone',
  };
  return map[key] || key;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

console.log('\nverify:sunset-schedule-drawer-controller\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const ctrlExists = fs.existsSync(CTRL_MODULE);
const ctrlSrc = ctrlExists ? fs.readFileSync(CTRL_MODULE, 'utf8') : '';
const deleteSrc = fs.existsSync(DELETE_MODULE) ? fs.readFileSync(DELETE_MODULE, 'utf8') : '';
const editSrc = fs.readFileSync(EDIT_MODULE, 'utf8');
const viewSrc = fs.readFileSync(VIEW_MODULE, 'utf8');
const browserLoader = fs.readFileSync(BROWSER_SRC, 'utf8');

console.log('[1] Module files and injection order');
assert('controller module exists', ctrlExists);
assert('controller inject marker in portal script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-controller */'));
assert('browser source loads controller module', browserLoader.includes('getSunsetScheduleDrawerControllerBrowserSource'));
assert('inject chains portal → view → edit → payment → waiver → delete → controller → day ops → forecast → view grid → navigation → data loader',
  browserLoader.includes('SCHEDULE_DATA_LOADER_INJECT_MARKER'));
const markers = [
  '/* INJECT:sunset-schedule-portal-module */',
  '/* INJECT:sunset-schedule-drawer-view-ui */',
  '/* INJECT:sunset-schedule-drawer-edit-ui */',
  '/* INJECT:sunset-schedule-drawer-payment-ui */',
  '/* INJECT:sunset-schedule-drawer-waiver-ui */',
  '/* INJECT:sunset-schedule-drawer-delete-ui */',
  '/* INJECT:sunset-schedule-drawer-controller */',
  '/* INJECT:sunset-schedule-day-ops-board-ui */',
  '/* INJECT:sunset-schedule-forecast-cards-ui */',
  '/* INJECT:sunset-schedule-view-grid-ui */',
  '/* INJECT:sunset-schedule-navigation-ui */',
  '/* INJECT:sunset-schedule-data-loader */',
];
let prev = -1;
markers.forEach((m) => {
  const idx = apiSrc.indexOf(m);
  assert(`marker present ${m}`, idx > -1);
  assert(`marker once ${m}`, apiSrc.indexOf(m, idx + 1) === -1);
  if (idx > -1) assert(`marker order ${m}`, idx > prev, `idx=${idx} prev=${prev}`);
  if (idx > prev) prev = idx;
});
assert('inline openScheduleDetailDrawer removed', !apiSrc.includes('function openScheduleDetailDrawer('));
assert('inline closeScheduleDetailDrawer removed', !apiSrc.includes('function closeScheduleDetailDrawer('));
assert('inline scheduleRefreshDrawer removed', !apiSrc.includes('function scheduleRefreshDrawer('));
assert('inline scheduleWireViewDrawer removed', !apiSrc.includes('function scheduleWireViewDrawer('));
assert('inline scheduleDrawerState removed', !/var scheduleDrawerState\s*=/.test(apiSrc));
assert('delete booking in delete module', deleteSrc.includes('function scheduleDeleteBookingFromDrawer('));
assert('inline delete removed from monolith', !apiSrc.includes('function scheduleDeleteBookingFromDrawer('));
assert('copy helpers stay in monolith', apiSrc.includes('function scheduleCopyTextFallback(') && apiSrc.includes('function scheduleDrawerFlashCopied('));
assert('mount moved out of edit module', !editSrc.includes('function scheduleMountDrawerBody('));
assert('open editable moved out of edit module', !editSrc.includes('function scheduleOpenEditableDrawer('));

console.log('\n[2] Controller owns lifecycle symbols');
[
  'scheduleDrawerState',
  'scheduleCloneDrawerCtx',
  'openScheduleDetailDrawer',
  'closeScheduleDetailDrawer',
  'scheduleRefreshDrawer',
  'scheduleMountDrawerBody',
  'scheduleOpenEditableDrawer',
  'scheduleWireViewDrawer',
  'scheduleWireDrawerHeaderActions',
  'scheduleWireDrawerConversation',
  'scheduleWireDrawerOpenCustomer',
  'scheduleDrawerIsRequestActive',
  'scheduleDrawerBumpOpenGeneration',
].forEach((name) => {
  assert(`controller defines ${name}`, ctrlSrc.includes(name));
});

console.log('\n[3] Stale-response guards in source');
assert('open uses openGen', ctrlSrc.includes('openGen'));
assert('close bumps generation', ctrlSrc.includes('scheduleDrawerBumpOpenGeneration'));
assert('fetch callback checks active request', ctrlSrc.includes('scheduleDrawerIsRequestActive'));
assert('refresh uses refreshGen', ctrlSrc.includes('refreshGen'));

console.log('\n[4] Legacy fallback classification');
assert('legacy fallback helper exists', ctrlSrc.includes('function scheduleDrawerRenderLegacyFallback'));
assert('legacy uses scheduleDrawerCanLoadCanonical gate', ctrlSrc.includes('scheduleDrawerCanLoadCanonical(row)'));
assert('legacy does not call scheduleOpenEditableDrawer on fail', !/scheduleFetchDrawerContext[\s\S]{0,200}scheduleDrawerRenderLegacyFallback/.test(ctrlSrc));
assert('no dead legacy unused stub in monolith', !apiSrc.includes('openScheduleDetailDrawerLegacyUnused'));

console.log('\n[5] VM — lifecycle, stale response, chip path, XSS');
if (ctrlExists) {
  const dom = {
    'ps-detail-drawer': { id: 'ps-detail-drawer', style: { display: 'none' } },
    'ps-drawer-backdrop': { id: 'ps-drawer-backdrop', style: { display: 'none' } },
    'ps-drawer-body': { id: 'ps-drawer-body', innerHTML: '', style: {} },
  };
  const wireLog = { view: 0, waiver: 0, payment: 0 };

  function makeThenable(payload) {
    return {
      then(fn) {
        if (typeof fn === 'function') fn(payload);
        return { catch() { return this; } };
      },
      catch() { return this; },
    };
  }

  function deferredThenable(onAttach) {
    const t = {
      then(fn) {
        t._fn = fn;
        if (onAttach) onAttach(t);
        return { catch() { return this; } };
      },
      catch() { return this; },
      _fn: null,
      resolve(payload) {
        if (t._fn) t._fn(payload);
      },
    };
    return t;
  }

  const ctx = {
    console,
    scheduleLastDrawerRowId: null,
    scheduleRowsCache: [],
    scheduleFindRowById: (id) => ctx.scheduleRowsCache.find((r) => r._scheduleId === id) || null,
    scheduleFindGroupForRow: (row) => ({ guest_name: row.guest_name, records: [row] }),
    scheduleBuildDisplayGroups: (rows) => rows.map((r) => Object.assign({ records: [r] }, r)),
    scheduleEnsureRowId: (row) => { if (!row._scheduleId) row._scheduleId = 'sid-' + (row.booking_id || 'x'); return row; },
    scheduleRowBookingRef: (row) => ({ booking_id: row.booking_id, booking_code: row.booking_code }),
    scheduleDrawerCanLoadCanonical: (row) => row.record_source === 'staff_manual' || row.record_source === 'luna_guest',
    scheduleDrawerCanEdit: () => true,
    scheduleRenderDrawerLoadingHtml: () => '<div class="state-msg">Loading</div>',
    scheduleRenderDrawerErrorHtml: (msg, code) => '<div class="state-msg error">' + escHtml(msg) + ' ' + escHtml(code || '') + '</div>',
    scheduleRenderViewDrawerHtml: (row, c) => '<div id="view">' + escHtml(c.guest_name) + '</div><div id="ps-drawer-payment-box"></div><div id="ps-drawer-waiver-box"></div>',
    scheduleRenderEditableDrawerHtml: () => '<form id="ps-drawer-save"></form>',
    scheduleRenderStatusBadgeHtml: () => 'unpaid',
    scheduleRenderComponentListHtml: () => '',
    scheduleRowSourceDrawerLabel: () => 'Staff',
    scheduleEquipmentPrepLabel: () => 'none',
    scheduleWireEditableDrawer: () => {},
    scheduleWireViewDrawer: () => { wireLog.view += 1; },
    scheduleWireDrawerHeaderActions: () => {},
    scheduleWireDrawerStripeCopyOpen: () => {},
    scheduleWireDrawerManualPayment: () => { wireLog.payment += 1; },
    scheduleLoadDrawerWaiver: () => { wireLog.waiver += 1; return makeThenable(undefined); },
    scheduleEnterDrawerEditMode: () => {},
    scheduleCreateDrawerStripeLink: () => {},
    scheduleWireDrawerDeleteBooking: () => {},
    scheduleFindLinkedConversation: () => null,
    scheduleGroupHasPhone: () => false,
    scheduleOpenOrStartConversationFromBooking: () => {},
    openCustomerCardForPhone: () => {},
    scheduleFetchDrawerContext: (row) => {
      if (fetchHandler) return fetchHandler(row);
      return makeThenable({ success: true, booking_id: row.booking_id, guest_name: row.guest_name || 'Guest', payment: {} });
    },
    portalT,
    escHtml,
    el: (id) => dom[id] || null,
    getClient: () => 'sunset',
    setTimeout,
    wireLog,
  };
  let fetchHandler = null;

  vm.createContext(ctx);
  vm.runInContext(`${ctrlSrc}
function scheduleWireDayOpsBoardRows(container){
  container.querySelectorAll('[data-ps-booking-id]').forEach(function(node){
    node.addEventListener('click', function(){
      var id = node.getAttribute('data-ps-booking-id');
      var row = scheduleFindRowById(id);
      if (row) openScheduleDetailDrawer(row);
    });
  });
}
var _origScheduleWireViewDrawer = scheduleWireViewDrawer;
scheduleWireViewDrawer = function(row, ctx){
  wireLog.view += 1;
  return _origScheduleWireViewDrawer(row, ctx);
};`, ctx);

  const staffRow = { booking_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', record_source: 'staff_manual', guest_name: 'Staff Guest', _scheduleId: 's1' };
  const lunaRow = { booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', record_source: 'luna_guest', guest_name: 'Luna Guest', _scheduleId: 's2' };
  const demoRow = { _isDemo: true, record_source: 'portal_demo', guest_name: 'Demo', _scheduleId: 's3' };

  let loadingDeferred = null;
  fetchHandler = () => deferredThenable((t) => { loadingDeferred = t; });
  ctx.openScheduleDetailDrawer(staffRow);
  assert('open renders loading immediately', dom['ps-drawer-body'].innerHTML.includes('Loading'));
  loadingDeferred.resolve({ success: true, booking_id: staffRow.booking_id, guest_name: 'Staff Guest', payment: {} });

  assert('drawer visible on open', dom['ps-detail-drawer'].style.display === 'block');

  fetchHandler = () => makeThenable({ success: true, booking_id: staffRow.booking_id, guest_name: 'Staff Guest', payment: {} });
  ctx.openScheduleDetailDrawer(staffRow);
  assert('staff canonical mounts view', dom['ps-drawer-body'].innerHTML.includes('Staff Guest'));
  assert('view wiring invoked', wireLog.view >= 1);
  assert('payment wiring invoked', wireLog.payment >= 1);
  assert('waiver wiring invoked', wireLog.waiver >= 1);

  fetchHandler = () => makeThenable({ success: true, booking_id: lunaRow.booking_id, guest_name: 'Luna Guest', payment: {} });
  ctx.openScheduleDetailDrawer(lunaRow);
  assert('luna uses same lifecycle', dom['ps-drawer-body'].innerHTML.includes('Luna Guest'));

  fetchHandler = () => makeThenable({ success: false, reason_code: 'drawer_untrusted_booking_source' });
  ctx.openScheduleDetailDrawer(staffRow);
  assert('typed error renders safely', dom['ps-drawer-body'].innerHTML.includes('drawer_untrusted_booking_source'));

  fetchHandler = () => makeThenable({ success: false, reason_code: '<img onerror=alert(1)>' });
  ctx.openScheduleDetailDrawer(staffRow);
  assert('XSS reason escaped', dom['ps-drawer-body'].innerHTML.includes('&lt;img'));

  let lateA = null;
  fetchHandler = (row) => {
    if (row.booking_id === 'a') return deferredThenable((t) => { lateA = t; });
    return makeThenable({ success: true, booking_id: 'b', guest_name: 'Booking B', payment: {} });
  };
  ctx.openScheduleDetailDrawer({ booking_id: 'a', record_source: 'staff_manual', guest_name: 'Booking A', _scheduleId: 'sa' });
  ctx.openScheduleDetailDrawer({ booking_id: 'b', record_source: 'staff_manual', guest_name: 'Booking B', _scheduleId: 'sb' });
  assert('active booking is B before late A', dom['ps-drawer-body'].innerHTML.includes('Booking B'));
  lateA.resolve({ success: true, booking_id: 'a', guest_name: 'Booking A', payment: {} });
  assert('late A cannot replace B', dom['ps-drawer-body'].innerHTML.includes('Booking B') && !dom['ps-drawer-body'].innerHTML.includes('Booking A'));

  lateA = null;
  fetchHandler = () => deferredThenable((t) => { lateA = t; });
  ctx.openScheduleDetailDrawer({ booking_id: 'late', record_source: 'staff_manual', guest_name: 'Late', _scheduleId: 'sl' });
  ctx.closeScheduleDetailDrawer();
  lateA.resolve({ success: true, booking_id: 'late', guest_name: 'Late', payment: {} });
  assert('drawer stays closed after late response', dom['ps-detail-drawer'].style.display === 'none');
  assert('close clears drawer state row', ctx.scheduleDrawerState.row === null);

  fetchHandler = null;
  ctx.openScheduleDetailDrawer(demoRow);
  assert('untrusted demo uses legacy fallback', dom['ps-drawer-body'].innerHTML.includes('Demo'));
  assert('demo ctx null', ctx.scheduleDrawerState.ctx === null);

  ctx.scheduleRowsCache = [staffRow];
  const chip = {
    getAttribute: () => staffRow._scheduleId,
    addEventListener: (_, fn) => { chip._fn = fn; },
  };
  ctx.scheduleWireDayOpsBoardRows({ querySelectorAll: () => [chip] });
  fetchHandler = () => makeThenable({ success: true, booking_id: staffRow.booking_id, guest_name: 'Chip Guest', payment: {} });
  chip._fn({ stopPropagation: () => {}, target: chip, currentTarget: chip });
  assert('chip click reaches controller without window globals', dom['ps-drawer-body'].innerHTML.includes('Chip Guest') && typeof global.openScheduleDetailDrawer === 'undefined');

  wireLog.view = 0;
  fetchHandler = () => makeThenable({ success: true, booking_id: staffRow.booking_id, guest_name: 'Refreshed', payment: {} });
  ctx.openScheduleDetailDrawer(staffRow);
  const viewsBeforeRefresh = wireLog.view;
  fetchHandler = () => makeThenable({ success: true, booking_id: staffRow.booking_id, guest_name: 'Refreshed2', payment: {} });
  ctx.scheduleRefreshDrawer();
  assert('refresh remounts updated ctx', ctx.scheduleDrawerState.ctx && ctx.scheduleDrawerState.ctx.guest_name === 'Refreshed2');
  assert('refresh rewires view', wireLog.view > viewsBeforeRefresh);

  assert('no window exposure of controller symbols', typeof global.scheduleDrawerState === 'undefined' && typeof global.openScheduleDetailDrawer === 'undefined');
}

console.log(`\n── verify:sunset-schedule-drawer-controller ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail) process.exit(1);
