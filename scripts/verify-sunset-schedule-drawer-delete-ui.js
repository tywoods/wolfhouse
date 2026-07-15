'use strict';

/**
 * verify:sunset-schedule-drawer-delete-ui
 *
 * Slice 17 — Schedule drawer booking-delete controller gate.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-drawer-delete-ui.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  injectSunsetSchedulePortalModule,
  SCHEDULE_DELETE_INJECT_MARKER,
} = require('./lib/sunset-schedule-browser-source');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DELETE_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-delete-ui.js');
const CTRL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-controller.js');
const VIEW_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const EDIT_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-edit-ui.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');
const DRAWER_SERVER = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-drawer.js');

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
    'schedule.drawer.deleteBooking': 'Delete booking',
    'schedule.drawer.deleteBookingConfirm': 'Delete this booking?',
    'schedule.drawer.deleteBookingFailed': 'Could not delete booking:',
  };
  return map[key] || key;
}

console.log('\nverify:sunset-schedule-drawer-delete-ui\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const deleteExists = fs.existsSync(DELETE_MODULE);
const deleteSrc = deleteExists ? fs.readFileSync(DELETE_MODULE, 'utf8') : '';
const ctrlSrc = fs.existsSync(CTRL_MODULE) ? fs.readFileSync(CTRL_MODULE, 'utf8') : '';
const editSrc = fs.readFileSync(EDIT_MODULE, 'utf8');
const viewSrc = fs.readFileSync(VIEW_MODULE, 'utf8');
const browserLoader = fs.readFileSync(BROWSER_SRC, 'utf8');
const drawerServerSrc = fs.readFileSync(DRAWER_SERVER, 'utf8');

console.log('[1] Module files and injection order');
assert('delete module exists', deleteExists);
assert('delete inject marker in portal script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-delete-ui */'));
assert('browser source loads delete module', browserLoader.includes('getSunsetScheduleDrawerDeleteBrowserSource'));
assert('inject chains delete before controller',
  browserLoader.includes('SCHEDULE_DELETE_INJECT_MARKER') && browserLoader.indexOf('SCHEDULE_DELETE_INJECT_MARKER') < browserLoader.indexOf('SCHEDULE_CONTROLLER_INJECT_MARKER'));
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
];
let prev = -1;
markers.forEach((m) => {
  const idx = apiSrc.indexOf(m);
  assert(`marker present ${m}`, idx > -1);
  assert(`marker once ${m}`, apiSrc.indexOf(m, idx + 1) === -1);
  if (idx > -1) assert(`marker order ${m}`, idx > prev, `idx=${idx} prev=${prev}`);
  if (idx > prev) prev = idx;
});
assert('inline scheduleDeleteBookingFromDrawer removed', !apiSrc.includes('function scheduleDeleteBookingFromDrawer('));
assert('delete wiring removed from edit module', !editSrc.includes('scheduleDeleteBookingFromDrawer'));
assert('delete wiring removed from controller module', !ctrlSrc.includes('scheduleDeleteBookingFromDrawer'));
assert('server cancelSunsetScheduleBooking unchanged route', drawerServerSrc.includes('cancelSunsetScheduleBooking'));

console.log('\n[2] Delete module owns lifecycle symbols');
[
  'scheduleDeleteBookingFromDrawer',
  'scheduleWireDrawerDeleteBooking',
  'scheduleDrawerCanDeleteBooking',
  'scheduleDrawerDeleteActionIsActive',
  'scheduleExecuteDrawerBookingDelete',
  'scheduleDrawerDeleteInFlight',
].forEach((name) => {
  assert(`delete module defines ${name}`, deleteSrc.includes(name));
});
assert('delete uses openGen guard', deleteSrc.includes('openGen'));
assert('delete uses in-flight guard', deleteSrc.includes('scheduleDrawerDeleteInFlight'));
assert('delete uses trusted canonical identity', deleteSrc.includes('scheduleDrawerCanDeleteBooking'));
assert('DELETE route unchanged', deleteSrc.includes("method: 'DELETE'") && deleteSrc.includes('/staff/schedule/bookings'));

console.log('\n[3] VM — delete lifecycle, stale action, XSS');
if (deleteExists) {
  const fetchLog = [];
  let confirmResult = true;
  let confirmMsg = '';
  let scheduleRefreshed = 0;
  let drawerClosed = 0;

  function makeThenable(payload) {
    const rejected = payload && payload._throw;
    return {
      then(onFulfilled, onRejected) {
        if (rejected) {
          if (typeof onRejected === 'function') {
            try {
              const next = onRejected(payload._throw);
              if (next && typeof next.then === 'function') return next;
              return makeThenable(next);
            } catch (err) {
              return makeThenable({ _throw: err });
            }
          }
          return makeThenable(payload);
        }
        try {
          if (typeof onFulfilled === 'function') {
            const next = onFulfilled(payload);
            if (next && typeof next.then === 'function') return next;
            return makeThenable(next);
          }
        } catch (err) {
          return makeThenable({ _throw: err });
        }
        return makeThenable(payload);
      },
      catch(onRejected) {
        if (payload && payload._throw && typeof onRejected === 'function') {
          try {
            const next = onRejected(payload._throw);
            if (next && typeof next.then === 'function') return next;
            return makeThenable(next);
          } catch (err) {
            return makeThenable({ _throw: err });
          }
        }
        return makeThenable(payload);
      },
    };
  }

  const dom = {
    'ps-drawer-delete-booking': { disabled: false, style: {}, onclick: null },
    'ps-drawer-save-msg': { className: '', textContent: '', innerHTML: '', style: { display: 'none' } },
    'ps-detail-drawer': { style: { display: 'block' } },
    'ps-drawer-backdrop': { style: { display: 'block' } },
  };
  dom['ps-drawer-delete-booking'].addEventListener = (_, fn) => { dom['ps-drawer-delete-booking']._fn = fn; };

  const ctx = {
    console,
    portalT,
    scheduleDrawerDeleteInFlight: false,
    scheduleDrawerState: {
      row: { booking_id: '11111111-1111-1111-1111-111111111111', record_source: 'staff_manual', _scheduleId: 's1' },
      ctx: {
        booking_id: '11111111-1111-1111-1111-111111111111',
        booking_code: 'SUNSET-TEST-001',
        guest_name: '<img onerror=alert(1)>',
      },
      editing: false,
      openGen: 1,
      activeBookingKey: 'id:11111111-1111-1111-1111-111111111111',
    },
    scheduleDrawerCanLoadCanonical: (row) => row && row.record_source === 'staff_manual' && !row._isDemo,
    scheduleDrawerCanDeleteBooking: null,
    scheduleDrawerBookingKey: (row) => (row && row.booking_id ? 'id:' + row.booking_id : null),
    scheduleDrawerIsRequestActive: (openGen, bookingKey) => {
      const st = ctx.scheduleDrawerState;
      if (openGen !== st.openGen) return false;
      if (bookingKey && st.activeBookingKey !== bookingKey) return false;
      const drawer = ctx.el('ps-detail-drawer');
      return !!(drawer && drawer.style.display !== 'none');
    },
    closeScheduleDetailDrawer: () => {
      drawerClosed += 1;
      ctx.scheduleDrawerState.row = null;
      ctx.scheduleDrawerState.ctx = null;
      ctx.scheduleDrawerState.activeBookingKey = null;
      ctx.scheduleDrawerState.openGen += 1;
      dom['ps-detail-drawer'].style.display = 'none';
    },
    loadSchedulePage: () => { scheduleRefreshed += 1; },
    getClient: () => 'sunset',
    sunsetLocationQuerySuffix: () => '',
    el: (id) => dom[id] || null,
    window: { confirm: (msg) => { confirmMsg = msg; return confirmResult; } },
    fetch: (url, opts) => {
      fetchLog.push({ url, opts });
      if (opts && opts.method === 'DELETE') {
        const body = JSON.parse(opts.body);
        if (body.booking_id === 'fail-id') {
          return makeThenable({
            ok: false,
            json: () => makeThenable({ success: false, error: '<script>alert(1)</script>' }),
          });
        }
        return makeThenable({
          ok: true,
          json: () => makeThenable({ success: true, deleted: true, booking_id: body.booking_id }),
        });
      }
      return makeThenable({ ok: true, json: () => makeThenable({ success: true }) });
    },
  };
  Object.defineProperty(dom['ps-drawer-save-msg'], 'textContent', {
    get() { return this._text || ''; },
    set(v) { this._text = String(v); this.innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  });
  ctx.window = { confirm: (msg) => { confirmMsg = msg; return confirmResult; } };

  vm.createContext(ctx);
  vm.runInContext('var scheduleDrawerDeleteInFlight = false;', ctx);
  vm.runInContext('function scheduleDrawerCanLoadCanonical(row){return row&&(row.record_source==="staff_manual"||row.record_source==="luna_guest")&&!row._isDemo;}', ctx);
  vm.runInContext(deleteSrc, ctx);

  // cancel confirmation
  confirmResult = false;
  fetchLog.length = 0;
  ctx.scheduleDeleteBookingFromDrawer();
  assert('cancel confirmation sends no DELETE', fetchLog.filter((f) => f.opts && f.opts.method === 'DELETE').length === 0);
  assert('cancel leaves drawer open', dom['ps-detail-drawer'].style.display === 'block');

  // successful delete
  confirmResult = true;
  fetchLog.length = 0;
  drawerClosed = 0;
  scheduleRefreshed = 0;
  ctx.scheduleDrawerState = {
    row: { booking_id: '11111111-1111-1111-1111-111111111111', record_source: 'staff_manual' },
    ctx: { booking_id: '11111111-1111-1111-1111-111111111111', booking_code: 'SUNSET-TEST-001' },
    openGen: 2,
    activeBookingKey: 'id:11111111-1111-1111-1111-111111111111',
  };
  ctx.scheduleDrawerDeleteInFlight = false;
  ctx.scheduleDeleteBookingFromDrawer();
  assert('successful delete sends one DELETE', fetchLog.filter((f) => f.opts && f.opts.method === 'DELETE').length === 1);
  assert('DELETE body uses trusted booking_id only', fetchLog[0] && JSON.parse(fetchLog[0].opts.body).booking_id === '11111111-1111-1111-1111-111111111111');
  assert('successful delete closes drawer', drawerClosed === 1);
  assert('successful delete refreshes schedule', scheduleRefreshed === 1);
  assert('confirm includes booking code', confirmMsg.includes('SUNSET-TEST-001'));

  // failed delete
  ctx.scheduleDrawerState = {
    row: { booking_id: 'fail-id', record_source: 'staff_manual' },
    ctx: { booking_id: 'fail-id', booking_code: 'FAIL-001' },
    openGen: 3,
    activeBookingKey: 'id:fail-id',
  };
  dom['ps-detail-drawer'].style.display = 'block';
  ctx.scheduleDrawerDeleteInFlight = false;
  dom['ps-drawer-delete-booking'].disabled = false;
  fetchLog.length = 0;
  confirmResult = true;
  ctx.scheduleDeleteBookingFromDrawer();
  assert('failed delete keeps drawer open', dom['ps-detail-drawer'].style.display === 'block');
  assert('failed delete releases in-flight', ctx.scheduleDrawerDeleteInFlight === false);
  assert('failed delete re-enables button', dom['ps-drawer-delete-booking'].disabled === false);
  assert('failed delete shows safe error text', dom['ps-drawer-save-msg'].textContent.includes('Could not delete booking'));
  assert('failed delete error uses textContent not HTML injection', !dom['ps-drawer-save-msg'].innerHTML.includes('<script'));

  // duplicate click guard
  ctx.scheduleDrawerDeleteInFlight = true;
  fetchLog.length = 0;
  ctx.scheduleDeleteBookingFromDrawer();
  assert('in-flight blocks duplicate delete', fetchLog.length === 0);

  // stale confirmation — switch drawer inside confirm callback
  ctx.scheduleDrawerDeleteInFlight = false;
  ctx.scheduleDrawerState = {
    row: { booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', record_source: 'staff_manual' },
    ctx: { booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', booking_code: 'BOOK-A' },
    openGen: 10,
    activeBookingKey: 'id:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  };
  dom['ps-detail-drawer'].style.display = 'block';
  fetchLog.length = 0;
  ctx.window.confirm = function (msg) {
    ctx.scheduleDrawerState = {
      row: { booking_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', record_source: 'staff_manual' },
      ctx: { booking_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', booking_code: 'BOOK-B' },
      openGen: 11,
      activeBookingKey: 'id:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    };
    return true;
  };
  ctx.scheduleDeleteBookingFromDrawer();
  assert('stale confirm sends no DELETE', fetchLog.filter((f) => f.opts && f.opts.method === 'DELETE').length === 0);

  // untrusted row guard
  assert('untrusted demo cannot delete', ctx.scheduleDrawerCanDeleteBooking({ _isDemo: true, record_source: 'staff_manual' }, { booking_id: 'x' }) === false);
  assert('trusted staff can delete', ctx.scheduleDrawerCanDeleteBooking({ record_source: 'staff_manual' }, { booking_id: '11111111-1111-1111-1111-111111111111' }) === true);
  assert('trusted luna follows same gate', ctx.scheduleDrawerCanDeleteBooking({ record_source: 'luna_guest' }, { booking_id: '11111111-1111-1111-1111-111111111111' }) === true);

  // missing identity
  fetchLog.length = 0;
  ctx.scheduleDrawerState = { row: {}, ctx: {}, openGen: 20, activeBookingKey: null };
  ctx.scheduleDeleteBookingFromDrawer();
  assert('missing booking_id fails closed', fetchLog.length === 0);

  assert('no window exposure', typeof global.scheduleDeleteBookingFromDrawer === 'undefined');
}

console.log(`\n── verify:sunset-schedule-drawer-delete-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail) process.exit(1);
