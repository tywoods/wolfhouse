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
    'schedule.courseEquipment.during': 'During Course',
    'schedule.courseEquipment.allDay': 'All Day',
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
    'schedule.ops.hideGuests': 'Hide guests',
    'schedule.ops.showGuests': 'Show guests',
    'schedule.ops.occupancy': 'Occupancy {booked} of {capacity}',
    'schedule.ops.occupancyBooked': 'Occupancy {booked} booked',
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
  '/* INJECT:sunset-schedule-drawer-actions */',
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
].forEach((name) => {
  assert(`module defines ${name}`, modSrc.includes(name));
});
assert('pack row ref removed', !modSrc.includes('scheduleDayOpsBoardRowsRef'));
assert('resolves via scheduleResolveRow', modSrc.includes('scheduleResolveRow'));

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
    function togglesFromHtml(html) {
      const toggles = [];
      const re = /<button\b([^>]*data-ps-ops-guest-toggle[^>]*)>([\s\S]*?)<\/button>/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const attrs = m[1];
        const body = m[2];
        const getAttr = (name) => {
          const am = attrs.match(new RegExp(name + '="([^"]*)"'));
          return am ? am[1] : null;
        };
        const node = {
          tagName: 'BUTTON',
          type: 'button',
          dataset: {},
          className: (getAttr('class') || ''),
          _attrs: {
            'aria-expanded': getAttr('aria-expanded'),
            'aria-controls': getAttr('aria-controls'),
            type: getAttr('type') || 'button',
            id: getAttr('id'),
            'data-ps-ops-guest-toggle': getAttr('data-ps-ops-guest-toggle') || '1',
          },
          _labelText: (() => {
            const lm = body.match(/portal-schedule-ops-guest-toggle-label[^>]*>([^<]*)</);
            return lm ? lm[1] : body.replace(/<[^>]+>/g, '').trim();
          })(),
          _listeners: [],
          getAttribute(k) { return this._attrs[k] != null ? this._attrs[k] : null; },
          setAttribute(k, v) { this._attrs[k] = String(v); },
          querySelector(sel) {
            if (sel === '.portal-schedule-ops-guest-toggle-label') {
              const btn = this;
              return {
                get textContent() { return btn._labelText; },
                set textContent(v) { btn._labelText = String(v == null ? '' : v); },
              };
            }
            return null;
          },
          classList: {
            _owner: null,
            toggle(cls, force) {
              const n = this._owner;
              const parts = String(n.className || '').split(/\s+/).filter(Boolean);
              const has = parts.indexOf(cls) >= 0;
              const on = force == null ? !has : !!force;
              n.className = (on
                ? (has ? parts : parts.concat([cls]))
                : parts.filter((p) => p !== cls)).join(' ');
            },
          },
          addEventListener(type, fn) { if (type === 'click') this._listeners.push(fn); },
          click() {
            this._listeners.forEach((fn) => fn({
              stopPropagation() {},
              preventDefault() {},
              target: this,
              type: 'click',
            }));
          },
        };
        node.classList._owner = node;
        toggles.push(node);
      }
      return toggles;
    }
    function panelsFromHtml(html) {
      const panels = {};
      const re = /id="(ps-ops-guests-[^"]+)"/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const id = m[1];
        panels[id] = {
          id,
          className: 'portal-schedule-ops-lesson-rows',
          hidden: false,
          style: { display: '' },
          classList: {
            _owner: null,
            contains(cls) {
              return String(this._owner.className || '').split(/\s+/).indexOf(cls) >= 0;
            },
            toggle(cls, force) {
              const n = this._owner;
              const parts = String(n.className || '').split(/\s+/).filter(Boolean);
              const has = parts.indexOf(cls) >= 0;
              const on = force == null ? !has : !!force;
              n.className = (on
                ? (has ? parts : parts.concat([cls]))
                : parts.filter((p) => p !== cls)).join(' ');
            },
          },
        };
        panels[id].classList._owner = panels[id];
      }
      // Detect initial collapsed state from class on matching panel open tag.
      Object.keys(panels).forEach((id) => {
        const openRe = new RegExp('id="' + id + '"[^>]*class="([^"]*)"');
        const openRe2 = new RegExp('class="([^"]*)"[^>]*id="' + id + '"');
        const mm = html.match(openRe) || html.match(openRe2);
        if (mm) panels[id].className = mm[1];
        if (/\bis-collapsed\b/.test(panels[id].className) || /\bhidden\b/.test(panels[id].className)) {
          panels[id].hidden = true;
        }
      });
      return panels;
    }
    let html = '';
    const el = {
      id: 'ps-ops-board',
      className: '',
      style: {},
      _chips: [],
      _toggles: [],
      _panels: {},
      get innerHTML() { return html; },
      set innerHTML(v) {
        html = String(v == null ? '' : v);
        el._chips = chipsFromHtml(html);
        el._toggles = togglesFromHtml(html);
        el._panels = panelsFromHtml(html);
      },
      querySelector(sel) {
        if (sel === '[data-ps-booking-id]') return el._chips[0] || null;
        if (sel && sel.charAt(0) === '#') return el._panels[sel.slice(1)] || null;
        if (sel === '[data-ps-ops-guest-toggle]') return el._toggles[0] || null;
        if (sel && sel.indexOf('[aria-controls=') === 0) {
          const id = (sel.match(/aria-controls=["']?([^"'\]]+)/) || [])[1];
          return el._toggles.find((t) => t.getAttribute('aria-controls') === id) || null;
        }
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '[data-ps-booking-id]') return el._chips.slice();
        if (sel === '[data-ps-add-slot]') return [];
        if (sel === '[data-ps-ops-guest-toggle]' || sel === 'button[data-ps-ops-guest-toggle]') {
          return el._toggles.slice();
        }
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
  const presentation = [];

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
    scheduleResolveRow: (id) => {
      const key = String(id || '');
      const canonical = cache.find((r) => r._scheduleId === key);
      if (canonical) {
        return Object.assign({}, canonical, { _rowIndexKind: 'canonical' });
      }
      const demo = presentation.find((r) => r._scheduleId === key);
      if (demo) {
        return Object.assign({}, demo, {
          _isDemo: true,
          _trustSource: 'demo',
          _rowIndexKind: 'presentation',
        });
      }
      return null;
    },
    scheduleFindRowById: (id) => ctx.scheduleResolveRow(id),
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

  function installPresentation(packRows) {
    presentation.length = 0;
    (packRows || []).forEach((r) => presentation.push(Object.assign({}, r)));
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

  // presentation-only row visible on board; resolves from presentation index (not pack ref)
  rows.length = 0;
  cache.length = 0;
  presentation.length = 0;
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
  installPresentation([demoRow]);
  ctx.renderScheduleDayOpsBoard({ rows: [demoRow] }, '2026-07-20');
  const demoChip = dom['ps-ops-board'].querySelector('[data-ps-booking-id]');
  assert('presentation row renders chip', !!demoChip && demoChip.getAttribute('data-ps-booking-id') === 'sid-demo-only');
  if (demoChip) clickChip(demoChip, demoChip._guestSpan);
  assert('presentation-only chip resolves via resolveRow', drawerOpens.length === 1 && drawerOpens[0] === 'sid-demo-only');
  const resolvedDemo = ctx.scheduleResolveRow('sid-demo-only');
  assert('presentation resolve preserves demo trust', !!resolvedDemo && resolvedDemo._isDemo === true
    && resolvedDemo._rowIndexKind === 'presentation' && resolvedDemo._trustSource === 'demo');
  assert('presentation absent from canonical cache', !cache.some((r) => r._scheduleId === 'sid-demo-only'));
  assert('pack row ref not present', typeof ctx.scheduleDayOpsBoardRowsRef === 'undefined');

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

  // rental-only board+wetsuit bundle → openable day-board chip (no course/lesson)
  rows.length = 0;
  cache.length = 0;
  drawerOpens.length = 0;
  const boardRow = {
    _scheduleId: 'sr-rental-board',
    service_record_id: 'sr-rental-board',
    booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    booking_code: 'SUNSET-RENT-ONLY',
    guest_name: 'Rental Only Bundle',
    service_date: '2026-07-20',
    service_type: 'board_rental',
    _scheduleType: 'rental',
    record_source: 'staff_manual',
    _isDbManual: true,
    quantity: 1,
    payment_status: 'unpaid',
    metadata: { component: 'surfboard' },
    _meta: { component: 'surfboard' },
  };
  const wetsuitRow = {
    _scheduleId: 'sr-rental-wetsuit',
    service_record_id: 'sr-rental-wetsuit',
    booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    booking_code: 'SUNSET-RENT-ONLY',
    guest_name: 'Rental Only Bundle',
    service_date: '2026-07-20',
    service_type: 'wetsuit_rental',
    _scheduleType: 'rental',
    record_source: 'staff_manual',
    _isDbManual: true,
    quantity: 1,
    payment_status: 'unpaid',
    metadata: { component: 'wetsuit' },
    _meta: { component: 'wetsuit' },
  };
  const prevBuildSessions = ctx.scheduleBuildDaySessions;
  const prevBuildGroups = ctx.scheduleBuildDisplayGroups;
  const prevStandalone = ctx.scheduleGroupIsStandaloneRental;
  const prevPickupKind = ctx.scheduleRentalPickupKind;
  const prevBoards = ctx.scheduleGroupBoardsNeeded;
  const prevWets = ctx.scheduleGroupWetsuitsNeeded;
  ctx.scheduleBuildDaySessions = () => [];
  ctx.scheduleBuildDisplayGroups = (rs) => [{
    _scheduleId: 'sr-rental-board',
    booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    guest_name: 'Rental Only Bundle',
    service_date: '2026-07-20',
    record_source: 'staff_manual',
    _isDbManual: true,
    payment_status: 'unpaid',
    quantity: 1,
    components: { surfboard: true, wetsuit: true },
    records: rs || [boardRow, wetsuitRow],
  }];
  ctx.scheduleGroupIsStandaloneRental = (g) => !!(g && g.components && (g.components.surfboard || g.components.wetsuit)
    && !g.components.lesson && !g.components.course && !g.components.private_lesson);
  ctx.scheduleRentalPickupKind = () => 'both';
  ctx.scheduleGroupBoardsNeeded = () => 1;
  ctx.scheduleGroupWetsuitsNeeded = () => 1;
  installCache([boardRow, wetsuitRow]);
  ctx.renderScheduleDayOpsBoard({ rows: [boardRow, wetsuitRow], gear: [boardRow, wetsuitRow], lessons: [] }, '2026-07-20');
  const rentalHtml = dom['ps-ops-board'].innerHTML;
  assert('rental-only section rendered', rentalHtml.includes('portal-schedule-ops-rental-pickups'));
  assert('rental-only guest chip visible', rentalHtml.includes('Rental Only Bundle'));
  const rentalChip = dom['ps-ops-board'].querySelector('[data-ps-booking-id]');
  assert('rental-only chip carries booking identity', !!rentalChip
    && rentalChip.getAttribute('data-ps-booking-id') === 'sr-rental-board');
  drawerOpens.length = 0;
  if (rentalChip) clickChip(rentalChip, rentalChip._guestSpan || rentalChip);
  assert('rental-only chip opens drawer via existing wiring', drawerOpens.length === 1 && drawerOpens[0] === 'sr-rental-board');
  // generic Admin-catalog rental → own pickup block with trusted label + quantity
  const genericRow = {
    _scheduleId: 'sr-rental-towel',
    service_record_id: 'sr-rental-towel',
    booking_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    booking_code: 'SUNSET-RENT-TOWEL',
    guest_name: 'Generic Towel Guest',
    service_date: '2026-07-20',
    service_type: 'rental',
    staff_ui_service_type: 'rental',
    _scheduleType: 'rental',
    record_source: 'staff_manual',
    _isDbManual: true,
    quantity: 2,
    payment_status: 'unpaid',
    metadata: {
      rental_offering: true,
      offering_key: 'towel_rental', offering_label: 'Towel',
      duration_key: '4_hours',
    },
    _meta: {
      rental_offering: true,
      offering_key: 'towel_rental', offering_label: 'Towel',
      duration_key: '4_hours',
    },
  };
  const genericRow2 = {
    ...genericRow,
    _scheduleId: 'sr-rental-poncho', service_record_id: 'sr-rental-poncho',
    metadata: { ...genericRow.metadata, offering_key: 'poncho_rental' },
    _meta: { ...genericRow._meta, offering_key: 'poncho_rental' },
  };
  const genericGroup = {
    _scheduleId: 'sr-rental-towel', booking_id: genericRow.booking_id,
    guest_name: genericRow.guest_name, service_date: genericRow.service_date,
    record_source: 'staff_manual', _isDbManual: true,
    payment_status: 'unpaid', quantity: 0,
    components: { 'rental:towel_rental': true, 'rental:poncho_rental': true }, records: [genericRow, genericRow2],
  };
  const descriptors = ctx.scheduleGenericRentalDescriptors(genericGroup);
  assert('generic rental descriptors preserve stable offering identities even when labels collide',
    descriptors.length === 2 && descriptors.map((d) => d.offering_key).sort().join(',') === 'poncho_rental,towel_rental');
  ctx.scheduleBuildDisplayGroups = () => [genericGroup];
  ctx.scheduleGroupIsStandaloneRental = () => true;
  ctx.scheduleRentalPickupKind = () => null;
  ctx.scheduleGroupBoardsNeeded = () => 0;
  ctx.scheduleGroupWetsuitsNeeded = () => 0;
  installCache([genericRow]);
  ctx.renderScheduleDayOpsBoard({ rows: [genericRow], gear: [genericRow], lessons: [] }, '2026-07-20');
  const genericHtml = dom['ps-ops-board'].innerHTML;
  assert('generic rental descriptor uses Admin label and exact quantity',
    typeof ctx.scheduleGenericRentalDescriptor === 'function'
      && ctx.scheduleGenericRentalDescriptor(genericGroup).label === 'Towel'
      && ctx.scheduleGenericRentalDescriptor(genericGroup).quantity === 2);
  assert('generic Admin rental renders under Rental pickups today',
    genericHtml.includes('portal-schedule-ops-rental-pickups')
      && genericHtml.includes('Towel')
      && genericHtml.includes('Generic Towel Guest')
      && genericHtml.includes('2×'));
  assert('same-label offerings render as separate stable pickup sections',
    (genericHtml.match(/data-rental-offering=/g) || []).length === 2
      && genericHtml.includes('data-rental-offering="towel_rental"')
      && genericHtml.includes('data-rental-offering="poncho_rental"'));

  ctx.scheduleBuildDaySessions = prevBuildSessions;
  ctx.scheduleBuildDisplayGroups = prevBuildGroups;
  ctx.scheduleGroupIsStandaloneRental = prevStandalone;
  ctx.scheduleRentalPickupKind = prevPickupKind;
  ctx.scheduleGroupBoardsNeeded = prevBoards;
  ctx.scheduleGroupWetsuitsNeeded = prevWets;

  assert('board module never fetched', fetchCount === 0);

  // ── Collapsible guest list (two course groups; real click wiring) ──
  console.log('\n[4] Collapsible guest list per course/session group');
  rows.length = 0;
  cache.length = 0;
  drawerOpens.length = 0;
  const g1 = makeGroup({
    guest_name: 'Guest One',
    _scheduleId: 'sid-g1',
    booking_id: '11111111-1111-1111-1111-111111111111',
  });
  const g2 = makeGroup({
    guest_name: 'Guest Two',
    _scheduleId: 'sid-g2',
    booking_id: '22222222-2222-2222-2222-222222222222',
  });
  const prevSessionsCollapse = ctx.scheduleBuildDaySessions;
  ctx.scheduleBuildDaySessions = () => ([
    {
      kind: 'course',
      label: 'Morning',
      timeLabel: '09:00',
      slot_key: 'am',
      course_id: 'c-morning',
      surfers: 1,
      bookings: 1,
      boardsNeeded: 1,
      wetsuitsNeeded: 0,
      groups: [Object.assign({ records: [g1] }, g1)],
      start: 540,
      end: 600,
      capacity: 8,
    },
    {
      kind: 'course',
      label: 'Afternoon',
      timeLabel: '15:00',
      slot_key: 'pm',
      course_id: 'c-afternoon',
      surfers: 1,
      bookings: 1,
      boardsNeeded: 0,
      wetsuitsNeeded: 1,
      groups: [Object.assign({ records: [g2] }, g2)],
      start: 900,
      end: 960,
      capacity: 6,
    },
  ]);
  installCache([g1, g2]);
  ctx.renderScheduleDayOpsBoard({ rows: [g1, g2] }, '2026-07-20');
  const collapseHtml = dom['ps-ops-board'].innerHTML;
  const toggles = dom['ps-ops-board'].querySelectorAll('[data-ps-ops-guest-toggle]');
  assert('two guest-list toggles rendered', toggles.length === 2, `count=${toggles.length}`);
  assert('toggle is real button type=button',
    toggles.every((t) => t.getAttribute('type') === 'button'));
  assert('toggles start expanded (default)',
    toggles.every((t) => t.getAttribute('aria-expanded') === 'true'));
  assert('each toggle has aria-controls panel id',
    toggles.every((t) => {
      const id = t.getAttribute('aria-controls');
      return id && id.indexOf('ps-ops-guests-') === 0 && !!dom['ps-ops-board'].querySelector('#' + id);
    }));
  assert('toggle panel ids are unique',
    new Set(toggles.map((t) => t.getAttribute('aria-controls'))).size === 2);
  assert('toggle labels use hide-guests i18n by default',
    toggles.every((t) => (t._labelText || '').indexOf('Hide guests') >= 0
      || collapseHtml.includes('Hide guests')));
  assert('no internal jargon in toggle label',
    toggles.every((t) => !/collapse|expand|toggle panel|guestlist|ops-guest/i.test(t._labelText || '')));

  const panel1Id = toggles[0] && toggles[0].getAttribute('aria-controls');
  const panel2Id = toggles[1] && toggles[1].getAttribute('aria-controls');
  const panel1 = panel1Id ? dom['ps-ops-board'].querySelector('#' + panel1Id) : null;
  const panel2 = panel2Id ? dom['ps-ops-board'].querySelector('#' + panel2Id) : null;
  assert('both guest panels start visible', panel1 && panel2 && !panel1.hidden && !panel2.hidden);

  // Collapse first only
  if (toggles[0]) toggles[0].click();
  assert('collapse first → aria-expanded false on first',
    toggles[0] && toggles[0].getAttribute('aria-expanded') === 'false');
  assert('collapse first → first panel hidden', panel1 && panel1.hidden === true);
  assert('collapse first → second stays expanded',
    toggles[1] && toggles[1].getAttribute('aria-expanded') === 'true'
      && panel2 && panel2.hidden === false);
  assert('collapse first → show-guests label on first',
    toggles[0] && (toggles[0]._labelText || '').indexOf('Show guests') >= 0);

  // Expand first again
  if (toggles[0]) toggles[0].click();
  assert('expand first restores aria-expanded true',
    toggles[0] && toggles[0].getAttribute('aria-expanded') === 'true');
  assert('expand first restores panel visible', panel1 && panel1.hidden === false);
  assert('expand first restores hide-guests label',
    toggles[0] && (toggles[0]._labelText || '').indexOf('Hide guests') >= 0);

  // Booking-row click still opens drawer after toggles
  drawerOpens.length = 0;
  const afterToggleChip = dom['ps-ops-board'].querySelector('[data-ps-booking-id]');
  if (afterToggleChip) clickChip(afterToggleChip, afterToggleChip._guestSpan || afterToggleChip);
  assert('booking-row click still opens drawer after guest toggles',
    drawerOpens.length === 1 && (drawerOpens[0] === 'sid-g1' || drawerOpens[0] === 'sid-g2'));

  // Prep counts + private lesson path still present in module (not broken by collapse)
  assert('equipment prep counts still rendered for groups',
    collapseHtml.includes('Prepare') || collapseHtml.includes('portal-schedule-ops-lesson-hdr-prep'));
  ctx.scheduleBuildDaySessions = prevSessionsCollapse;

  // ── Circular occupancy indicator ──
  console.log('\n[5] Circular course occupancy indicator');
  assert('module defines scheduleRenderOccupancyHtml',
    typeof ctx.scheduleRenderOccupancyHtml === 'function');

  function occHtml(session) {
    return ctx.scheduleRenderOccupancyHtml(session);
  }

  const occ0 = occHtml({ surfers: 0, capacity: 8, groups: [] });
  assert('occupancy 0% ring present',
    occ0.includes('portal-schedule-occ') && occ0.includes('portal-schedule-occ-ring'));
  assert('occupancy 0% text truthful 0/8',
    /0\s*\/\s*8|0<small>\/8<\/small>/.test(occ0));
  assert('occupancy 0% progress clamped',
    /--ps-occ-pct:\s*0\b|data-ps-occ-pct="0"|stroke-dasharray="0[\s,]/.test(occ0)
      || /ps-occ-pct["':=\s]+0\b/.test(occ0));
  assert('occupancy accessible label states occupancy',
    /aria-label="[^"]*Occupancy 0 of 8/.test(occ0) || /aria-label="[^"]*0 of 8/.test(occ0));
  assert('no old horizontal occ-track in occupancy html', !occ0.includes('portal-schedule-occ-track'));

  const occPartial = occHtml({ surfers: 4, capacity: 8, groups: [] });
  assert('occupancy partial text 4/8',
    /4\s*\/\s*8|4<small>\/8<\/small>/.test(occPartial));
  assert('occupancy partial ~50%',
    /--ps-occ-pct:\s*50\b|data-ps-occ-pct="50"|ps-occ-pct["':=\s]+50\b/.test(occPartial));

  const occFull = occHtml({ surfers: 8, capacity: 8, groups: [] });
  assert('occupancy full text 8/8',
    /8\s*\/\s*8|8<small>\/8<\/small>/.test(occFull));
  assert('occupancy full 100%',
    /--ps-occ-pct:\s*100\b|data-ps-occ-pct="100"|ps-occ-pct["':=\s]+100\b/.test(occFull));

  const occOver = occHtml({ surfers: 10, capacity: 8, groups: [] });
  assert('occupancy over-capacity text remains truthful 10/8',
    /10\s*\/\s*8|10<small>\/8<\/small>/.test(occOver));
  assert('occupancy over-capacity visual clamped to 100',
    /--ps-occ-pct:\s*100\b|data-ps-occ-pct="100"|ps-occ-pct["':=\s]+100\b/.test(occOver));
  assert('occupancy over-capacity not clamped text to 8/8', !/>8<small>\/8</.test(occOver) || /10/.test(occOver));

  const occUnknown = occHtml({ surfers: 3, capacity: 0, groups: [] });
  const occMissing = occHtml({ surfers: 2, groups: [] });
  assert('unknown capacity neutral state class or no false denom',
    occUnknown.includes('is-unknown') || occUnknown.includes('portal-schedule-occ-ring')
      && !/\/\s*0</.test(occUnknown.replace(/aria-label="[^"]*"/g, '')));
  assert('missing capacity shows booked without invented denom',
    (occMissing.includes('is-unknown') || !/\/\s*\d/.test(occMissing.replace(/aria-label="[^"]*"/g, '')))
      && /[> ]2[<]/.test(occMissing));
  assert('unknown capacity aria not misleading full',
    !/of 0/.test(occUnknown) || occUnknown.includes('booked'));

  // Rendered lesson header uses ring, not horizontal bar
  rows.length = 0;
  cache.length = 0;
  const gOcc = makeGroup({ guest_name: 'Occ Guest', _scheduleId: 'sid-occ', quantity: 4 });
  ctx.scheduleBuildDaySessions = () => ([{
    kind: 'course',
    label: 'Full Course',
    timeLabel: '10:00',
    slot_key: 'mid',
    course_id: 'c-occ',
    surfers: 4,
    bookings: 1,
    boardsNeeded: 0,
    wetsuitsNeeded: 0,
    groups: [Object.assign({ records: [gOcc] }, gOcc)],
    start: 600,
    end: 660,
    capacity: 8,
  }]);
  installCache([gOcc]);
  ctx.renderScheduleDayOpsBoard({ rows: [gOcc] }, '2026-07-20');
  const boardOccHtml = dom['ps-ops-board'].innerHTML;
  assert('day board ships circular occ ring', boardOccHtml.includes('portal-schedule-occ-ring'));
  assert('day board has no horizontal occ-track', !boardOccHtml.includes('portal-schedule-occ-track'));
  assert('day board occ text 4/8', /4\s*\/\s*8|4<small>\/8<\/small>/.test(boardOccHtml));
  ctx.scheduleBuildDaySessions = prevSessionsCollapse;
}

// Generated /staff/ui artifact: no old horizontal occupancy bar from course-group owner
console.log('\n[6] Generated /staff/ui occupancy CSS/markup');
(function generatedStaffUiOccupancy() {
  try {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    process.env.STAFF_AUTH_REQUIRED = 'false';
    process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
    process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
    // Lazy require so module-load cost only hits this section.
    const api = require('./staff-query-api');
    if (typeof api.buildUiHtmlForOfflineTest !== 'function') {
      assert('buildUiHtmlForOfflineTest available', false);
      return;
    }
    const html = api.buildUiHtmlForOfflineTest(3041, { headers: {} });
    assert('generated /staff/ui is HTML', typeof html === 'string' && html.includes('<!DOCTYPE'));
    assert('generated /staff/ui includes circular occ ring CSS/class',
      html.includes('portal-schedule-occ-ring'));
    assert('generated /staff/ui removes horizontal course occ-track',
      !html.includes('portal-schedule-occ-track'));
    assert('generated /staff/ui keeps unrelated week slot tracks',
      html.includes('portal-schedule-wk-slot-track'));
    assert('generated /staff/ui injects day-ops occupancy renderer',
      html.includes('function scheduleRenderOccupancyHtml('));
    assert('generated /staff/ui has no spinner/animation occupancy jargon',
      !/portal-schedule-occ[^"]*spinner|occ-loading|keyframes\s+ps-occ/i.test(html));
  } catch (err) {
    assert('generated /staff/ui occupancy check', false, String(err && err.message || err));
  }
})();

console.log(`\n── verify:sunset-schedule-day-ops-board-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail) process.exit(1);
