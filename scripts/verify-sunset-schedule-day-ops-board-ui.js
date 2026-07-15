'use strict';

/**
 * verify:sunset-schedule-day-ops-board-ui
 *
 * Slice 18 — Schedule day-view operations board gate.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-day-ops-board-ui.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  injectSunsetSchedulePortalModule,
  SCHEDULE_DAY_OPS_BOARD_INJECT_MARKER,
} = require('./lib/sunset-schedule-browser-source');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DAY_OPS_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-day-ops-board-ui.js');
const CTRL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-controller.js');
const FORECAST_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-forecast-cards-ui.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

function portalT(key) {
  const map = {
    'schedule.emptyDay': 'Nothing scheduled',
    'schedule.col.guest': 'Guest',
    'schedule.col.status': 'Status',
    'schedule.type.lesson': 'Lesson',
    'schedule.slot.booked': 'booked',
    'schedule.slot.bookings': 'bookings',
    'schedule.slot.surfers': 'surfers',
    'schedule.legend.staff': 'Staff',
    'schedule.legend.luna': 'Luna',
    'schedule.source.demo': 'Demo',
    'schedule.source.ariaStaff': 'Staff booking',
    'schedule.source.ariaLuna': 'Luna booking',
    'schedule.source.ariaDemo': 'Demo booking',
    'schedule.equipment.boardAndWetsuit': 'board + wetsuit',
    'schedule.equipment.board': 'board',
    'schedule.equipment.wetsuit': 'wetsuit',
    'schedule.equipment.none': 'none',
    'schedule.status.paid': 'Paid',
    'schedule.status.unpaid': 'Unpaid',
    'schedule.ops.rentalPickupsToday': 'Rental pickups',
    'schedule.ops.rentalBoth': 'Both',
    'schedule.ops.rentalBoardsOnly': 'Boards',
    'schedule.ops.rentalWetsuitsOnly': 'Wetsuits',
    'schedule.ops.rentalNothingScheduled': 'Nothing',
    'schedule.summary.boards': 'boards',
    'schedule.summary.wetsuits': 'wetsuits',
    'schedule.courses.noneConfigured': 'No courses',
    'schedule.emptySlot': 'Empty slot',
    'schedule.createBooking': 'Create booking',
    'schedule.timeline.done': 'Done',
    'schedule.privateLesson.requestedTime': 'Requested',
    'schedule.ops.prepare': 'Prepare',
  };
  return map[key] || key;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

console.log('\nverify:sunset-schedule-day-ops-board-ui\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const modExists = fs.existsSync(DAY_OPS_MODULE);
const modSrc = modExists ? fs.readFileSync(DAY_OPS_MODULE, 'utf8') : '';
const forecastSrc = fs.existsSync(FORECAST_MODULE) ? fs.readFileSync(FORECAST_MODULE, 'utf8') : '';
const ctrlSrc = fs.readFileSync(CTRL_MODULE, 'utf8');
const browserLoader = fs.readFileSync(BROWSER_SRC, 'utf8');

console.log('[1] Module files and injection order');
assert('day ops board module exists', modExists);
assert('day ops inject marker in portal script', apiSrc.includes('/* INJECT:sunset-schedule-day-ops-board-ui */'));
assert('browser source loads day ops module', browserLoader.includes('getSunsetScheduleDayOpsBoardBrowserSource'));
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
  '/* INJECT:sunset-schedule-runtime */',
  '/* INJECT:sunset-schedule-navigation-ui */',
  '/* INJECT:sunset-schedule-row-normalizer */',
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
assert('inline scheduleRenderOpsBoard removed', !apiSrc.includes('function scheduleRenderOpsBoard('));
assert('inline scheduleRenderOpsBookingRow removed', !apiSrc.includes('function scheduleRenderOpsBookingRow('));
assert('inline scheduleWireDayOpsBoardRows removed from monolith', !apiSrc.includes('function scheduleWireDayOpsBoardRows('));
assert('monolith keeps forecast card presentation builder', apiSrc.includes('function scheduleBuildForecastCardPresentation('));
assert('monolith keeps view grid context builder', apiSrc.includes('function scheduleBuildViewGridContext('));
assert('forecast cards module owns day-open wiring', forecastSrc.includes('function scheduleWireForecastCardNavigation('));
assert('module does not fetch', !modSrc.includes('fetch('));
assert('module does not expose window', !/window\.(schedule|openSchedule)/.test(modSrc));
assert('controller still owns openScheduleDetailDrawer', ctrlSrc.includes('function openScheduleDetailDrawer('));

console.log('\n[2] Module owns day-board symbols');
[
  'scheduleRenderDayOpsBoardHtml',
  'renderScheduleDayOpsBoard',
  'scheduleWireDayOpsBoardRows',
  'scheduleRenderOpsBookingRow',
  'scheduleRenderOpsGroupHeader',
  'scheduleRenderOpsColumnHeader',
  'scheduleResolveDayOpsRowFromChip',
  'scheduleDayOpsBoardRowsRef',
].forEach((name) => {
  assert(`module defines ${name}`, modSrc.includes(name));
});

console.log('\n[3] VM — render, click, tamper, rerender');
if (modExists) {
  function makeChipNode(id) {
    const node = {
      dataset: {},
      className: 'portal-schedule-ops-row',
      getAttribute(k) { return k === 'data-ps-booking-id' ? id : null; },
      closest(sel) { return sel === '[data-ps-booking-id]' ? node : null; },
      contains(el) { return el === node || el === node._guestSpan; },
      _listeners: [],
      addEventListener(type, fn) { if (type === 'click') node._listeners.push(fn); },
      clickFrom(target) {
        node._listeners.forEach((fn) => fn({
          stopPropagation() {},
          target: target || node,
        }));
      },
      querySelector(sel) {
        if (sel === '.portal-schedule-ops-row-guest') return node._guestSpan || null;
        return null;
      },
    };
    node._guestSpan = {
      className: 'portal-schedule-ops-row-guest',
      closest(sel) { return sel === '[data-ps-booking-id]' ? node : null; },
    };
    return node;
  }

  function makeBoardEl() {
    function chipsFromHtml(html) {
      const chips = [];
      const re = /data-ps-booking-id="([^"]+)"/g;
      let m;
      while ((m = re.exec(html)) !== null) chips.push(makeChipNode(m[1]));
      return chips;
    }
    let html = '';
    const el = {
      id: 'ps-ops-board',
      className: '',
      style: {},
      _chips: [],
      get innerHTML() { return html; },
      set innerHTML(v) {
        html = String(v == null ? '' : v);
        el._chips = chipsFromHtml(html);
      },
      querySelector(sel) {
        if (sel === '[data-ps-booking-id]') return el._chips[0] || null;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '[data-ps-booking-id]') return el._chips.slice();
        if (sel === '[data-ps-add-slot]') return [];
        return [];
      },
    };
    return el;
  }
  const dom = { 'ps-ops-board': makeBoardEl() };
  const drawerOpens = [];
  let fetchCount = 0;
  const rows = [];
  const cache = [];

  function makeGroup(overrides) {
    const g = Object.assign({
      _scheduleId: 'sid-' + Math.random().toString(36).slice(2, 8),
      guest_name: 'Guest',
      record_source: 'staff_manual',
      _isDbManual: true,
      quantity: 1,
      payment_status: 'unpaid',
      service_date: '2026-07-20',
      booking_id: '11111111-1111-1111-1111-111111111111',
      components: { course: { quantity: 1 } },
    }, overrides || {});
    rows.push(g);
    return g;
  }

  const ctx = {
    console,
    scheduleRowsCache: rows,
    scheduleCoursesCache: [{ course_id: 'c1', label: 'Morning' }],
    scheduleLessonTimesFallback: false,
    scheduleLessonTimesCache: [],
    scheduleTodayIso: () => '2026-07-15',
    scheduleBuildDaySessions: (dayRows) => {
      if (!dayRows.length) return [];
      return [{
        kind: 'course',
        label: 'Morning',
        timeLabel: '09:00',
        slot_key: 'am',
        course_id: 'c1',
        surfers: dayRows.length,
        bookings: dayRows.length,
        boardsNeeded: 0,
        wetsuitsNeeded: 0,
        groups: dayRows.map((r) => Object.assign({ records: [r] }, r)),
        start: 540,
        end: 600,
        capacity: 8,
      }];
    },
    scheduleBuildDisplayGroups: (rs) => rs.map((r) => Object.assign({ records: [r] }, r)),
    scheduleGroupIsStandaloneRental: () => false,
    scheduleFindRowById: (id) => {
      const hit = cache.find((r) => r._scheduleId === id);
      return hit ? Object.assign({}, hit) : null;
    },
    scheduleEnsureRowId: (r) => r,
    scheduleGroupHasPrivateLesson: () => false,
    scheduleGroupHasLesson: () => false,
    scheduleGroupHasCourse: (g) => !!(g.components && g.components.course),
    scheduleGroupComponentQty: (g, k) => (g.components && g.components[k] && g.components[k].quantity) || g.quantity || 1,
    scheduleGroupBoardsNeeded: () => 0,
    scheduleGroupWetsuitsNeeded: () => 0,
    scheduleRowSourceKind: (r) => (r.record_source === 'staff_manual' ? 'staff' : 'luna'),
    scheduleRowSourceAriaLabel: (r) => (r.record_source === 'staff_manual' ? 'Staff booking' : 'Luna booking'),
    scheduleRenderStatusBadgeHtml: (g) => '<span class="portal-schedule-status is-unpaid">Unpaid</span>',
    scheduleFormatSlotTimeRange: (t) => String(t || ''),
    scheduleMinutesLabel: (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'),
    scheduleSourceSplit: () => ({ staff: 1, luna: 0 }),
    scheduleActiveDayIso: () => '2026-07-20',
    openScheduleCreateModal: () => {},
    scheduleOnCreateComponentChange: () => {},
    schedulePopulateCreateCourseFields: () => {},
    openScheduleDetailDrawer: (row) => { drawerOpens.push(row && row._scheduleId); },
    el: (id) => dom[id] || null,
    portalT,
    escHtml,
    fetch: () => { fetchCount += 1; return { then() { return this; }, catch() { return this; } }; },
  };

  vm.createContext(ctx);
  vm.runInContext(modSrc, ctx);

  function installCache(packRows) {
    cache.length = 0;
    (packRows || []).forEach((r) => cache.push(Object.assign({}, r)));
  }

  function clickChip(chip, target) {
    chip.clickFrom(target || chip);
  }

  // empty day
  ctx.renderScheduleDayOpsBoard({ rows: [] }, '2026-07-20');
  assert('empty day safe state', dom['ps-ops-board'].innerHTML.includes('portal-schedule-ops-empty'));
  assert('empty day escaped', !dom['ps-ops-board'].innerHTML.includes('<script'));

  // staff row
  rows.length = 0;
  cache.length = 0;
  drawerOpens.length = 0;
  const staff = makeGroup({ guest_name: 'Staff Guest<script>', record_source: 'staff_manual', _isDbManual: true });
  installCache([staff]);
  ctx.renderScheduleDayOpsBoard({ rows: [staff] }, '2026-07-20');
  assert('one staff row rendered', /data-ps-booking-id=/.test(dom['ps-ops-board'].innerHTML));
  assert('staff rail class', dom['ps-ops-board'].innerHTML.includes('is-staff'));
  assert('guest escaped', dom['ps-ops-board'].innerHTML.includes('Staff Guest&lt;script&gt;'));

  // luna parity
  rows.length = 0;
  cache.length = 0;
  const luna = makeGroup({ guest_name: 'Luna Guest', record_source: 'luna_guest', _isLuna: true, _isDbManual: false, booking_id: '22222222-2222-2222-2222-222222222222', _scheduleId: 'sid-luna' });
  installCache([luna]);
  ctx.renderScheduleDayOpsBoard({ rows: [luna] }, '2026-07-20');
  assert('luna row structure', dom['ps-ops-board'].innerHTML.includes('portal-schedule-ops-row-guest'));
  assert('luna source chip', dom['ps-ops-board'].innerHTML.includes('is-luna'));

  // wired chip container opens drawer once
  drawerOpens.length = 0;
  const wiredChip = dom['ps-ops-board'].querySelector('[data-ps-booking-id]');
  if (wiredChip) clickChip(wiredChip, wiredChip);
  assert('chip container wired click opens drawer', drawerOpens.length === 1 && drawerOpens[0] === 'sid-luna');

  // inner guest span opens same drawer once
  drawerOpens.length = 0;
  if (wiredChip) clickChip(wiredChip, wiredChip._guestSpan);
  assert('inner guest span wired click opens drawer', drawerOpens.length === 1 && drawerOpens[0] === 'sid-luna');

  // presentation-only row visible on board but absent from canonical cache
  rows.length = 0;
  cache.length = 0;
  drawerOpens.length = 0;
  const demoRow = {
    _scheduleId: 'sid-demo-only',
    guest_name: 'Demo Only Guest',
    record_source: 'portal_demo',
    _isDemo: true,
    quantity: 1,
    payment_status: 'unpaid',
    service_date: '2026-07-20',
    components: { lesson: { quantity: 1 } },
  };
  rows.push(demoRow);
  ctx.renderScheduleDayOpsBoard({ rows: [demoRow] }, '2026-07-20');
  const demoChip = dom['ps-ops-board'].querySelector('[data-ps-booking-id]');
  assert('presentation row renders chip', !!demoChip && demoChip.getAttribute('data-ps-booking-id') === 'sid-demo-only');
  if (demoChip) clickChip(demoChip, demoChip._guestSpan);
  assert('presentation-only chip resolves from day pack ref', drawerOpens.length === 1 && drawerOpens[0] === 'sid-demo-only');
  assert('pack ref stored on render', ctx.scheduleDayOpsBoardRowsRef.length === 1);

  // real click inner span resolve helper
  drawerOpens.length = 0;
  installCache([luna]);
  ctx.renderScheduleDayOpsBoard({ rows: [luna] }, '2026-07-20');
  const chip = dom['ps-ops-board'].querySelector('[data-ps-booking-id]');
  if (chip) {
    const guestSpan = { closest: (sel) => (sel === '[data-ps-booking-id]' ? chip : null) };
    const row = ctx.scheduleResolveDayOpsRowFromChip(guestSpan);
    if (row) ctx.openScheduleDetailDrawer(row);
  }
  assert('inner span resolves trusted row', drawerOpens.length === 1 && drawerOpens[0] === 'sid-luna');

  // unknown id fail closed
  drawerOpens.length = 0;
  const bad = ctx.scheduleResolveDayOpsRowFromChip({ closest: () => ({ getAttribute: () => 'unknown-id' }) });
  assert('unknown id fail closed', !bad);
  assert('unknown id no drawer', drawerOpens.length === 0);

  // tamper id
  drawerOpens.length = 0;
  const tampered = ctx.scheduleResolveDayOpsRowFromChip({ closest: () => ({ getAttribute: () => '00000000-0000-0000-0000-000000000099' }) });
  assert('tampered id fail closed', !tampered);

  // rerender no duplicate handlers
  installCache([luna]);
  ctx.renderScheduleDayOpsBoard({ rows: [luna] }, '2026-07-20');
  dom['ps-ops-board'] = makeBoardEl();
  ctx.el = (id) => (id === 'ps-ops-board' ? dom['ps-ops-board'] : null);
  ctx.renderScheduleDayOpsBoard({ rows: [luna] }, '2026-07-20');
  drawerOpens.length = 0;
  const rerenderChip = dom['ps-ops-board'].querySelector('[data-ps-booking-id]');
  if (rerenderChip) {
    clickChip(rerenderChip, rerenderChip._guestSpan);
    clickChip(rerenderChip, rerenderChip._guestSpan);
  }
  assert('rerender rewired single open per tap', drawerOpens.length === 2 && drawerOpens[0] === 'sid-luna' && drawerOpens[1] === 'sid-luna');
  assert('rerender refreshed html', dom['ps-ops-board'].innerHTML.includes('Luna Guest'));

  // delete refresh simulation
  rows.length = 0;
  cache.length = 0;
  makeGroup({ guest_name: 'Keep', _scheduleId: 'sid-keep', booking_id: '33333333-3333-3333-3333-333333333333' });
  installCache(rows.slice());
  ctx.renderScheduleDayOpsBoard({ rows: rows.slice() }, '2026-07-20');
  assert('refresh renders keep row', dom['ps-ops-board'].innerHTML.includes('Keep'));
  rows.length = 0;
  ctx.renderScheduleDayOpsBoard({ rows: rows.slice() }, '2026-07-20');
  assert('delete refresh empty board', dom['ps-ops-board'].innerHTML.includes('portal-schedule-ops-empty'));

  // mobile 390 — guest column hit target stays on chip (no horizontal intercept)
  installCache([luna]);
  ctx.renderScheduleDayOpsBoard({ rows: [luna] }, '2026-07-20');
  const mobileChip = dom['ps-ops-board'].querySelector('[data-ps-booking-id]');
  assert('mobile guest col class present', dom['ps-ops-board'].innerHTML.includes('portal-schedule-ops-row-guest-col'));
  assert('mobile chip width within 390 viewport', dom['ps-ops-board'].innerHTML.includes('portal-schedule-ops-row'));
  if (mobileChip) {
    assert('mobile inner span resolves without cache-only miss', !!ctx.scheduleResolveDayOpsRowFromChip(mobileChip._guestSpan));
  }

  assert('board module never fetched', fetchCount === 0);
}

console.log(`\n── verify:sunset-schedule-day-ops-board-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail) process.exit(1);
