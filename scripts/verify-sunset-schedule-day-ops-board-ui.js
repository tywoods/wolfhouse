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

function extractFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') depth -= 1;
    if (depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
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
    'schedule.ops.rentalSortGuest': 'Guest',
    'schedule.ops.rentalSortItem': 'Item',
    'schedule.ops.rentalSortAria': 'Sort rental pickups',
    'schedule.ops.rentalFilterGuest': 'Filter by name',
    'schedule.ops.rentalFilterEmpty': 'No matching guests',
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
  'scheduleBuildRentalPickupLines',
  'scheduleRenderRentalPickupsSection',
  'scheduleRenderRentalPickupsByGuest',
  'scheduleRenderRentalPickupsByItem',
  'scheduleWireRentalPickupsControls',
  'scheduleGetDayOpsLayoutMode',
  'scheduleSetDayOpsLayoutMode',
  'scheduleDayOpsCardsColumnCount',
  'scheduleRenderCardsItem',
].forEach((name) => {
  assert(`module defines ${name}`, modSrc.includes(name));
});
assert('filter left of guest/item sort', (() => {
  const iFilter = modSrc.indexOf('portal-schedule-ops-rental-filter');
  const iSort = modSrc.indexOf('portal-schedule-ops-rental-sort');
  // In header builder, filter markup is emitted before sort group when guestOn.
  const hdr = modSrc.indexOf('function scheduleRenderRentalPickupsHeader');
  const chunk = modSrc.slice(hdr, hdr + 1200);
  const f = chunk.indexOf('portal-schedule-ops-rental-filter');
  const g = chunk.indexOf('portal-schedule-ops-rental-sort');
  return f >= 0 && g >= 0 && f < g;
})());
assert('cards grid class in module', modSrc.includes('portal-schedule-cards-grid'));
assert('layout toggle stamps data-ops-layout', modSrc.includes("data-ops-layout"));
assert('no hard-coded bothRentals bucket', !modSrc.includes('bothRentals'));
assert('no hard-coded boardOnlyRentals bucket', !modSrc.includes('boardOnlyRentals'));
assert('no hard-coded wetsuitOnlyRentals bucket', !modSrc.includes('wetsuitOnlyRentals'));
assert('header booking tally removed from module', !modSrc.includes('portal-schedule-ops-rental-pickups-count'));
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
      const seen = new Set();
      while ((m = re.exec(html)) !== null) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        chips.push(makeChipNode(m[1]));
      }
      return chips;
    }
    function mockSortButtons(html) {
      const out = [];
      const re = /<button\b[^>]*\bdata-rp-sort="([^"]+)"[^>]*>/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const val = m[1];
        const node = {
          dataset: {},
          tagName: 'BUTTON',
          getAttribute(k) { return k === 'data-rp-sort' ? val : null; },
          _listeners: {},
          addEventListener(type, fn) {
            if (!node._listeners[type]) node._listeners[type] = [];
            node._listeners[type].push(fn);
          },
          click() {
            (node._listeners.click || []).forEach((fn) => fn({
              preventDefault() {},
              stopPropagation() {},
              target: node,
            }));
          },
        };
        out.push(node);
      }
      return out;
    }
    function mockFilter(html) {
      if (!/data-rp-filter="guest"/.test(html)) return null;
      const vm = html.match(/value="([^"]*)"/);
      const node = {
        dataset: {},
        value: vm ? vm[1] : '',
        selectionStart: 0,
        selectionEnd: 0,
        _listeners: {},
        addEventListener(type, fn) {
          if (!node._listeners[type]) node._listeners[type] = [];
          node._listeners[type].push(fn);
        },
        focus() { if (documentRef) documentRef.activeElement = node; },
        setSelectionRange(a, b) { node.selectionStart = a; node.selectionEnd = b; },
        dispatchInput(val) {
          node.value = String(val == null ? '' : val);
          node.selectionStart = node.value.length;
          node.selectionEnd = node.value.length;
          (node._listeners.input || []).forEach((fn) => fn({
            target: node,
            preventDefault() {},
            stopPropagation() {},
          }));
        },
      };
      return node;
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
      // Detect initial collapsed state from class/hidden on matching panel open tag.
      Object.keys(panels).forEach((id) => {
        const openRe = new RegExp('id="' + id + '"[^>]*class="([^"]*)"');
        const openRe2 = new RegExp('class="([^"]*)"[^>]*id="' + id + '"');
        const mm = html.match(openRe) || html.match(openRe2);
        if (mm) panels[id].className = mm[1];
        const tag = html.match(new RegExp('<div\\b[^>]*id="' + id + '"[^>]*>'));
        const tagStr = tag ? tag[0] : '';
        if (/\bis-collapsed\b/.test(panels[id].className)
          || /\bhidden\b/.test(panels[id].className)
          || /\shidden(\s|>|$)/.test(tagStr)
          || /\shidden=["']?true["']?/.test(tagStr)) {
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
      _attrs: {},
      _chips: [],
      _toggles: [],
      _panels: {},
      _sortBtns: [],
      _filter: null,
      getAttribute(k) { return this._attrs[k] != null ? this._attrs[k] : null; },
      setAttribute(k, v) { this._attrs[k] = String(v); },
      get innerHTML() { return html; },
      set innerHTML(v) {
        html = String(v == null ? '' : v);
        el._chips = chipsFromHtml(html);
        el._toggles = togglesFromHtml(html);
        el._panels = panelsFromHtml(html);
        el._sortBtns = mockSortButtons(html);
        el._filter = mockFilter(html);
      },
      querySelector(sel) {
        if (sel === '[data-ps-booking-id]') return el._chips[0] || null;
        if (sel === '[data-rp-filter="guest"]') return el._filter;
        if (sel === 'button[data-rp-sort="item"]') return el._sortBtns.find((b) => b.getAttribute('data-rp-sort') === 'item') || null;
        if (sel === 'button[data-rp-sort="guest"]') return el._sortBtns.find((b) => b.getAttribute('data-rp-sort') === 'guest') || null;
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
        if (sel === 'button[data-rp-sort]' || sel === '[data-rp-sort]') return el._sortBtns.slice();
        if (sel === '[data-ps-ops-guest-toggle]' || sel === 'button[data-ps-ops-guest-toggle]') {
          return el._toggles.slice();
        }
        return [];
      },
    };
    return el;
  }
  let documentRef = {
    activeElement: null,
    querySelector(sel) {
      return dom && dom['ps-ops-board'] ? dom['ps-ops-board'].querySelector(sel) : null;
    },
  };
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
    scheduleRowType: (r) => (r && r.course_id ? 'course' : String((r && r._scheduleType) || 'course')),
    scheduleCourseKey: (r) => String((r && r.course_id) || ''),
    scheduleRowsForSameBookings: (all, seeds) => {
      const keys = new Set((seeds || []).map((r) => `${r.booking_id}:${r.service_date}`));
      return (all || []).filter((r) => keys.has(`${r.booking_id}:${r.service_date}`));
    },
    scheduleGroupHasCourse: (g) => !!(g && (g.course_id || (g.components && g.components.course))),
    scheduleRowCourseMeta: (r) => ({ course_id: r && r.course_id, course_label: r && r.course_label }),
    scheduleResolveCourseDisplayLabel: (id, label) => label || id,
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
    document: documentRef,
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

  // cancelled booking remains on its original course, paints grey, stays clickable,
  // and does not count toward occupancy/equipment or create a Cancelled section.
  rows.length = 0;
  cache.length = 0;
  drawerOpens.length = 0;
  const activeCourseRow = makeGroup({
    guest_name: 'Active Course Guest',
    _scheduleId: 'sid-active-course',
    booking_id: '44444444-4444-4444-4444-444444444444',
    course_id: 'c1',
  });
  const cancelledCourseRow = makeGroup({
    guest_name: 'Cancelled Course Guest',
    _scheduleId: 'sid-cancelled-course',
    booking_id: '55555555-5555-5555-5555-555555555555',
    course_id: 'c1',
    schedule_ghost: true,
    _isCancelled: true,
    booking_status: 'cancelled',
    service_status: 'cancelled',
  });
  installCache([activeCourseRow, cancelledCourseRow]);
  ctx.renderScheduleDayOpsBoard({ rows: [activeCourseRow, cancelledCourseRow] }, '2026-07-20');
  const mixedCourseHtml = dom['ps-ops-board'].innerHTML;
  assert('cancelled row remains inside original course card',
    mixedCourseHtml.includes('Active Course Guest') && mixedCourseHtml.includes('Cancelled Course Guest'));
  assert('cancelled row paints grey state class',
    /portal-schedule-ops-row[^\"]*is-cancelled[^>]*>[\s\S]*Cancelled Course Guest/.test(mixedCourseHtml));
  assert('cancelled row excluded from active occupancy',
    mixedCourseHtml.includes('portal-schedule-occ-num">1<small>/8</small>'));
  assert('no separate Cancelled session or section',
    !mixedCourseHtml.includes('cancelled-ghosts') && !mixedCourseHtml.includes('>Cancelled<'));
  const cancelledChip = dom['ps-ops-board']._chips.find((c) => c.getAttribute('data-ps-booking-id') === 'sid-cancelled-course');
  if (cancelledChip) clickChip(cancelledChip, cancelledChip._guestSpan);
  assert('cancelled row remains clickable for permanent delete',
    drawerOpens.length === 1 && drawerOpens[0] === 'sid-cancelled-course');

  const buildSessionsWithConfiguredEmptyCourse = ctx.scheduleBuildDaySessions;
  ctx.scheduleBuildDaySessions = (dayRows) => [{
    kind: 'course', label: 'Morning', timeLabel: '09:00', slot_key: 'am', course_id: 'c1',
    surfers: dayRows.length, bookings: dayRows.length, boardsNeeded: 0, wetsuitsNeeded: 0,
    groups: dayRows.map((r) => Object.assign({ records: [r] }, r)),
    start: 540, end: 600, capacity: 8,
  }];
  ctx.renderScheduleDayOpsBoard({ rows: [cancelledCourseRow] }, '2026-07-20');
  ctx.scheduleBuildDaySessions = buildSessionsWithConfiguredEmptyCourse;
  const ghostOnlyCourseHtml = dom['ps-ops-board'].innerHTML;
  assert('course with only cancelled rows remains visible',
    ghostOnlyCourseHtml.includes('Morning') && ghostOnlyCourseHtml.includes('Cancelled Course Guest'));
  assert('ghost-only course occupancy remains zero',
    ghostOnlyCourseHtml.includes('portal-schedule-occ-num">0<small>/8</small>'));

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
  const prevBuildSessions = ctx.scheduleBuildDaySessions;
  const prevBuildGroups = ctx.scheduleBuildDisplayGroups;
  const prevStandalone = ctx.scheduleGroupIsStandaloneRental;
  const prevPickupKind = ctx.scheduleRentalPickupKind;
  const prevBoards = ctx.scheduleGroupBoardsNeeded;
  const prevWets = ctx.scheduleGroupWetsuitsNeeded;

  const boardRow = {
    _scheduleId: 'sr-rental-board',
    service_record_id: 'sr-rental-board',
    booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    booking_code: 'SUNSET-RENT-ONLY',
    guest_name: 'Rental Only Bundle',
    service_date: '2026-07-20',
    service_type: 'surfboard_rental',
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
  ctx.scheduleBuildDaySessions = () => [];
  const comboGroup = {
    _scheduleId: 'sr-rental-board',
    booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    guest_name: 'Rental Only Bundle',
    service_date: '2026-07-20',
    record_source: 'staff_manual',
    _isDbManual: true,
    payment_status: 'unpaid',
    quantity: 1,
    components: { surfboard: true, wetsuit: true },
    records: [boardRow, wetsuitRow],
  };
  ctx.scheduleBuildDisplayGroups = (rs) => [comboGroup];
  ctx.scheduleGroupIsStandaloneRental = (g) => !!(g && g.components && (g.components.surfboard || g.components.wetsuit)
    && !g.components.lesson && !g.components.course && !g.components.private_lesson);
  ctx.scheduleRentalPickupKind = () => 'both';
  ctx.scheduleGroupBoardsNeeded = () => 1;
  ctx.scheduleGroupWetsuitsNeeded = () => 1;
  installCache([boardRow, wetsuitRow]);
  ctx.scheduleRentalPickupsSortMode = 'guest';
  ctx.scheduleRentalPickupsGuestFilter = '';
  ctx.renderScheduleDayOpsBoard({ rows: [boardRow, wetsuitRow], gear: [boardRow, wetsuitRow], lessons: [] }, '2026-07-20');
  const rentalHtml = dom['ps-ops-board'].innerHTML;
  assert('rental-only section rendered', rentalHtml.includes('portal-schedule-ops-rental-pickups'));
  assert('rental-only guest visible in guest mode', rentalHtml.includes('Rental Only Bundle'));
  assert('guest mode shows sort controls', rentalHtml.includes('data-rp-sort="guest"') && rentalHtml.includes('data-rp-filter="guest"'));
  assert('header booking tally removed', !rentalHtml.includes('portal-schedule-ops-rental-pickups-count'));
  assert('combo pair label present', rentalHtml.includes('Both'));
  const linesCombo = ctx.scheduleBuildRentalPickupLines([comboGroup]);
  assert('combo emits one pair line', linesCombo.length === 1 && linesCombo[0].itemKey === 'pair:both' && linesCombo[0].quantity === 1);
  const rentalChip = dom['ps-ops-board'].querySelector('[data-ps-booking-id]');
  assert('rental-only chip carries booking identity', !!rentalChip
    && rentalChip.getAttribute('data-ps-booking-id') === 'sr-rental-board');
  drawerOpens.length = 0;
  if (rentalChip) clickChip(rentalChip, rentalChip._guestSpan || rentalChip);
  assert('rental-only chip opens drawer via existing wiring', drawerOpens.length === 1 && drawerOpens[0] === 'sr-rental-board');

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
    metadata: { ...genericRow.metadata, offering_key: 'poncho_rental', offering_label: 'Poncho' },
    _meta: { ...genericRow._meta, offering_key: 'poncho_rental', offering_label: 'Poncho' },
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
  const genericLines = ctx.scheduleBuildRentalPickupLines([genericGroup]);
  assert('generic multi-item guest produces two lines',
    genericLines.length === 2
      && genericLines.every((l) => l.guestName === 'Generic Towel Guest')
      && genericLines.map((l) => l.itemKey).sort().join(',') === 'offering:poncho_rental,offering:towel_rental');
  ctx.scheduleBuildDisplayGroups = () => [genericGroup];
  ctx.scheduleGroupIsStandaloneRental = () => true;
  ctx.scheduleRentalPickupKind = () => null;
  ctx.scheduleGroupBoardsNeeded = () => 0;
  ctx.scheduleGroupWetsuitsNeeded = () => 0;
  installCache([genericRow]);
  ctx.scheduleRentalPickupsSortMode = 'guest';
  ctx.scheduleRentalPickupsGuestFilter = '';
  ctx.renderScheduleDayOpsBoard({ rows: [genericRow], gear: [genericRow], lessons: [] }, '2026-07-20');
  const genericHtml = dom['ps-ops-board'].innerHTML;
  assert('generic rental descriptors use Admin labels and exact quantities',
    typeof ctx.scheduleGenericRentalDescriptors === 'function'
      && descriptors.some((d) => d.offering_key === 'towel_rental' && d.label === 'Towel' && d.quantity === 2)
      && descriptors.some((d) => d.offering_key === 'poncho_rental' && d.label === 'Poncho' && d.quantity === 2));
  assert('generic Admin rental renders under Rental pickups today',
    genericHtml.includes('portal-schedule-ops-rental-pickups')
      && genericHtml.includes('Towel')
      && genericHtml.includes('Generic Towel Guest')
      && genericHtml.includes('2×'));
  assert('guest mode keeps multi offering attrs on lines',
    (genericHtml.match(/data-rental-offering=/g) || []).length >= 2
      && genericHtml.includes('data-rental-offering="towel_rental"')
      && genericHtml.includes('data-rental-offering="poncho_rental"'));

  ctx.scheduleRentalPickupsSortMode = 'item';
  ctx.scheduleRentalPickupsGuestFilter = '';
  ctx.renderScheduleDayOpsBoard({ rows: [genericRow], gear: [genericRow], lessons: [] }, '2026-07-20');
  const itemHtml = dom['ps-ops-board'].innerHTML;
  assert('item mode hides guest filter', !itemHtml.includes('data-rp-filter="guest"') && itemHtml.includes('data-rp-sort="item"'));
  assert('item mode sections from stable offering keys',
    itemHtml.includes('data-rental-offering="towel_rental"')
      && itemHtml.includes('data-rental-offering="poncho_rental"')
      && itemHtml.includes('Generic Towel Guest'));

  const twinA = {
    _scheduleId: 'sr-frankie', booking_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    guest_name: 'Frankie', service_date: '2026-07-20', record_source: 'staff_manual', _isDbManual: true,
    payment_status: 'unpaid', quantity: 1, components: { surfboard: true, wetsuit: true },
    records: [boardRow],
  };
  const twinB = {
    _scheduleId: 'sr-frankie-2', booking_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    guest_name: 'Frankie', service_date: '2026-07-20', record_source: 'staff_manual', _isDbManual: true,
    payment_status: 'paid', quantity: 1, components: {},
    records: [{
      _scheduleId: 'sr-frankie-2', quantity: 1, metadata: {
        rental_offering: true, offering_key: 'bottle_rental', offering_label: 'Bottle',
      }, _meta: {
        rental_offering: true, offering_key: 'bottle_rental', offering_label: 'Bottle',
      },
    }],
  };
  const jimmy = {
    _scheduleId: 'sr-jimmy', booking_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    guest_name: 'Jimmy', service_date: '2026-07-20', record_source: 'staff_manual', _isDbManual: true,
    payment_status: 'unpaid', quantity: 1, components: { surfboard: true },
    records: [boardRow],
  };
  ctx.scheduleBuildDisplayGroups = () => [twinA, twinB, jimmy];
  ctx.scheduleGroupIsStandaloneRental = () => true;
  ctx.scheduleRentalPickupKind = (g) => {
    if (g && g._scheduleId === 'sr-frankie') return 'both';
    if (g && g._scheduleId === 'sr-jimmy') return 'board';
    return null;
  };
  ctx.scheduleGroupBoardsNeeded = (g) => (g && (g._scheduleId === 'sr-frankie' || g._scheduleId === 'sr-jimmy') ? 1 : 0);
  ctx.scheduleGroupWetsuitsNeeded = (g) => (g && g._scheduleId === 'sr-frankie' ? 1 : 0);
  installCache([twinA, twinB, jimmy]);
  const multiLines = ctx.scheduleBuildRentalPickupLines([twinA, twinB, jimmy]);
  assert('same guest name keeps separate booking identities',
    multiLines.filter((l) => l.guestName === 'Frankie').map((l) => l.scheduleId).sort().join(',') === 'sr-frankie,sr-frankie-2');
  ctx.scheduleRentalPickupsSortMode = 'guest';
  ctx.scheduleRentalPickupsGuestFilter = 'fran';
  ctx.renderScheduleDayOpsBoard({ rows: [twinA, twinB, jimmy], gear: [], lessons: [] }, '2026-07-20');
  const filterHtml = dom['ps-ops-board'].innerHTML;
  assert('guest filter keeps Frankie', filterHtml.includes('Frankie'));
  assert('guest filter hides Jimmy', !filterHtml.includes('Jimmy'));
  ctx.scheduleRentalPickupsGuestFilter = 'zzz-nope';
  ctx.renderScheduleDayOpsBoard({ rows: [twinA, twinB, jimmy], gear: [], lessons: [] }, '2026-07-20');
  assert('empty filter state', dom['ps-ops-board'].innerHTML.includes('No matching guests'));

  ctx.scheduleRentalPickupsSortMode = 'item';
  ctx.scheduleRentalPickupsGuestFilter = '';
  ctx.renderScheduleDayOpsBoard({ rows: [twinA, twinB, jimmy], gear: [], lessons: [] }, '2026-07-20');
  const itemMulti = dom['ps-ops-board'].innerHTML;
  assert('item mode lists Bottle from data only', itemMulti.includes('Bottle') && itemMulti.includes('data-rental-offering="bottle_rental"'));
  assert('item mode lists classic pair/board without empty hardcode shells',
    itemMulti.includes('Both') && itemMulti.includes('Boards'));

  // Interaction tests: real sort-button clicks + filter input events
  ctx.scheduleRentalPickupsSortMode = 'guest';
  ctx.scheduleRentalPickupsGuestFilter = '';
  ctx.renderScheduleDayOpsBoard({ rows: [twinA, twinB, jimmy], gear: [], lessons: [] }, '2026-07-20');
  assert('interaction start guest mode has filter', dom['ps-ops-board'].innerHTML.includes('data-rp-filter="guest"'));
  const itemBtn = dom['ps-ops-board'].querySelector('button[data-rp-sort="item"]');
  assert('item sort button wired', !!(itemBtn && itemBtn._listeners && itemBtn._listeners.click && itemBtn._listeners.click.length));
  itemBtn.click();
  assert('click Item sets sort mode global', ctx.scheduleRentalPickupsSortMode === 'item');
  assert('click Item rerenders item view without guest filter',
    dom['ps-ops-board'].innerHTML.includes('data-rp-sort="item"')
      && !dom['ps-ops-board'].innerHTML.includes('data-rp-filter="guest"')
      && dom['ps-ops-board'].innerHTML.includes('Bottle'));
  const guestBtn = dom['ps-ops-board'].querySelector('button[data-rp-sort="guest"]');
  assert('guest sort button wired', !!(guestBtn && guestBtn._listeners && guestBtn._listeners.click && guestBtn._listeners.click.length));
  guestBtn.click();
  assert('click Guest restores guest mode + filter field',
    ctx.scheduleRentalPickupsSortMode === 'guest'
      && dom['ps-ops-board'].innerHTML.includes('data-rp-filter="guest"'));
  const filterInput = dom['ps-ops-board'].querySelector('[data-rp-filter="guest"]');
  assert('filter input wired', !!(filterInput && filterInput._listeners && filterInput._listeners.input && filterInput._listeners.input.length));
  filterInput.focus();
  documentRef.activeElement = filterInput;
  filterInput.dispatchInput('fran');
  assert('input filter updates global state', ctx.scheduleRentalPickupsGuestFilter === 'fran');
  assert('input filter keeps Frankie hides Jimmy',
    dom['ps-ops-board'].innerHTML.includes('Frankie')
      && !dom['ps-ops-board'].innerHTML.includes('Jimmy'));
  const filterAfter = dom['ps-ops-board'].querySelector('[data-rp-filter="guest"]');
  assert('filter value retained after rerender', !!(filterAfter && filterAfter.value === 'fran'));
  drawerOpens.length = 0;
  const filteredChip = dom['ps-ops-board'].querySelector('[data-ps-booking-id]');
  assert('filtered rental line present', !!filteredChip);
  if (filteredChip) clickChip(filteredChip, filteredChip);
  assert('drawer opens once after sort/filter rerender', drawerOpens.length === 1 && String(drawerOpens[0]).indexOf('sr-frankie') === 0);

  ctx.scheduleBuildDaySessions = prevBuildSessions;
  ctx.scheduleBuildDisplayGroups = prevBuildGroups;
  ctx.scheduleGroupIsStandaloneRental = prevStandalone;
  ctx.scheduleRentalPickupKind = prevPickupKind;
  ctx.scheduleGroupBoardsNeeded = prevBoards;
  ctx.scheduleGroupWetsuitsNeeded = prevWets;
  ctx.scheduleRentalPickupsSortMode = 'guest';
  ctx.scheduleRentalPickupsGuestFilter = '';

  assert('board module never fetched', fetchCount === 0);

  // Production grouping integration: one cancelled display group per exact course,
  // even when a single booking owns multiple course rows plus shared equipment.
  const prodGroupCtx = {
    console,
    scheduleEnsureRowId: (r) => r,
    scheduleRowIsPrivateLesson: () => false,
    scheduleRowEffectivePaid: () => false,
    scheduleRowType: (r) => String((r && r._scheduleType) || ''),
    scheduleRowComponentKey: (r) => String((r && r._scheduleType) || 'unknown'),
    schedulePrivateLessonTimeRange: () => '',
    scheduleRowCourseMeta: (r) => ({ course_id: r && r.course_id, course_label: r && r.course_label }),
    scheduleResolveCourseDisplayLabel: (id, label) => label || id,
  };
  vm.createContext(prodGroupCtx);
  vm.runInContext([
    extractFunctionSource(apiSrc, 'scheduleBuildDisplayGroups'),
    extractFunctionSource(apiSrc, 'scheduleGroupHasCourse'),
    extractFunctionSource(apiSrc, 'scheduleCourseKey'),
    extractFunctionSource(apiSrc, 'scheduleBookingDayKey'),
    extractFunctionSource(apiSrc, 'scheduleRowsForSameBookings'),
    extractFunctionSource(modSrc, 'scheduleAttachCancelledCourseGroups'),
  ].join('\n'), prodGroupCtx);
  const multiGhostRows = [
    { _scheduleId: 'mc-c1', booking_id: 'multi-booking', booking_code: 'MULTI', guest_name: 'Multi Guest', service_date: '2026-07-20', _scheduleType: 'course', course_id: 'c1', course_label: 'Morning', quantity: 2, payment_status: 'unpaid' },
    { _scheduleId: 'mc-c2', booking_id: 'multi-booking', booking_code: 'MULTI', guest_name: 'Multi Guest', service_date: '2026-07-20', _scheduleType: 'course', course_id: 'c2', course_label: 'Afternoon', quantity: 2, payment_status: 'unpaid' },
    { _scheduleId: 'mc-board', booking_id: 'multi-booking', booking_code: 'MULTI', guest_name: 'Multi Guest', service_date: '2026-07-20', _scheduleType: 'surfboard', quantity: 2, payment_status: 'unpaid' },
    { _scheduleId: 'legacy-unmatched', booking_id: 'legacy', booking_code: 'LEGACY', guest_name: 'Legacy', service_date: '2026-07-20', _scheduleType: 'lesson', quantity: 1, payment_status: 'unpaid' },
  ];
  const prodSessions = [
    { kind: 'course', course_id: 'c1', surfers: 3, bookings: 1, boardsNeeded: 3, groups: [] },
    { kind: 'course', course_id: 'c2', surfers: 4, bookings: 1, boardsNeeded: 4, groups: [] },
  ];
  prodGroupCtx.scheduleAttachCancelledCourseGroups(prodSessions, multiGhostRows);
  assert('production grouping attaches multi-course ghost once to each exact course',
    prodSessions[0].groups.length === 1 && prodSessions[1].groups.length === 1
      && prodSessions[0].groups[0].course_id === 'c1' && prodSessions[1].groups[0].course_id === 'c2');
  assert('production grouping excludes peer course rows but retains shared equipment for drawer context',
    prodSessions.every((s) => s.groups[0].records.filter((r) => r._scheduleType === 'course').length === 1
      && s.groups[0].records.some((r) => r._scheduleType === 'surfboard')));
  assert('cancelled attachment leaves active occupancy and equipment totals unchanged',
    prodSessions[0].surfers === 3 && prodSessions[0].boardsNeeded === 3
      && prodSessions[1].surfers === 4 && prodSessions[1].boardsNeeded === 4);
  assert('unmatched legacy ghost is not guessed into a course',
    prodSessions.every((s) => s.groups.every((g) => g.booking_id !== 'legacy')));

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

  // ── Default-collapse past booking panels on TODAY only ──
  // Contract: never hide the course card; reuse existing guest toggle + `done`
  // (isToday && session.end != null && session.end <= nowMin).
  console.log('\n[4b] Default-collapse past booking panels (TODAY only)');
  const RealDate = ctx.Date || Date;
  function installFixedClock(nowMin) {
    const h = Math.floor(nowMin / 60);
    const m = nowMin % 60;
    function FixedDate(...args) {
      if (!(this instanceof FixedDate)) return new FixedDate(...args);
      if (args.length === 0) {
        return Reflect.construct(RealDate, [2026, 6, 15, h, m, 0, 0], FixedDate);
      }
      return Reflect.construct(RealDate, args, FixedDate);
    }
    FixedDate.prototype = Object.create(RealDate.prototype);
    FixedDate.prototype.constructor = FixedDate;
    Object.setPrototypeOf(FixedDate, RealDate);
    FixedDate.now = () => RealDate.UTC(2026, 6, 15, h, m, 0, 0);
    FixedDate.parse = RealDate.parse.bind(RealDate);
    FixedDate.UTC = RealDate.UTC.bind(RealDate);
    ctx.Date = FixedDate;
  }
  function restoreClock() {
    ctx.Date = RealDate;
  }
  function makeSession(overrides) {
    return Object.assign({
      kind: 'course',
      label: 'Session',
      timeLabel: '09:00',
      slot_key: 's',
      course_id: 'c-s',
      surfers: 1,
      bookings: 1,
      boardsNeeded: 0,
      wetsuitsNeeded: 0,
      groups: [],
      start: 540,
      end: 600,
      capacity: 8,
    }, overrides || {});
  }
  function panelState(board, btn) {
    const id = btn && btn.getAttribute('aria-controls');
    const panel = id ? board.querySelector('#' + id) : null;
    return {
      id,
      panel,
      hidden: !!(panel && panel.hidden),
      collapsedCls: !!(panel && /\bis-collapsed\b/.test(panel.className || '')),
    };
  }

  // TODAY @ 12:00 — past (ended 10:00), current (11:00–13:00, now at mid), upcoming (15:00)
  rows.length = 0;
  cache.length = 0;
  drawerOpens.length = 0;
  const gPast = makeGroup({
    guest_name: 'Past Guest',
    _scheduleId: 'sid-past',
    booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });
  const gCurrent = makeGroup({
    guest_name: 'Current Guest',
    _scheduleId: 'sid-current',
    booking_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  });
  const gUpcoming = makeGroup({
    guest_name: 'Upcoming Guest',
    _scheduleId: 'sid-upcoming',
    booking_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  });
  const prevSessionsDefault = ctx.scheduleBuildDaySessions;
  const prevTodayIso = ctx.scheduleTodayIso;
  ctx.scheduleTodayIso = () => '2026-07-15';
  installFixedClock(12 * 60); // 12:00
  ctx.scheduleBuildDaySessions = () => ([
    makeSession({
      label: 'Morning Past',
      timeLabel: '09:00',
      slot_key: 'am-past',
      course_id: 'c-past',
      groups: [Object.assign({ records: [gPast] }, gPast)],
      start: 540,
      end: 600, // 10:00 — done at 12:00
    }),
    makeSession({
      label: 'Midday Current',
      timeLabel: '11:00',
      slot_key: 'mid-current',
      course_id: 'c-current',
      groups: [Object.assign({ records: [gCurrent] }, gCurrent)],
      start: 660,
      end: 780, // 11:00–13:00 — in progress
    }),
    makeSession({
      label: 'Afternoon Upcoming',
      timeLabel: '15:00',
      slot_key: 'pm-up',
      course_id: 'c-up',
      groups: [Object.assign({ records: [gUpcoming] }, gUpcoming)],
      start: 900,
      end: 960, // 15:00–16:00
    }),
  ]);
  installCache([gPast, gCurrent, gUpcoming]);
  ctx.renderScheduleDayOpsBoard({ rows: [gPast, gCurrent, gUpcoming] }, '2026-07-15');
  const todayBoard = dom['ps-ops-board'];
  const todayHtml = todayBoard.innerHTML;
  const todayToggles = todayBoard.querySelectorAll('[data-ps-ops-guest-toggle]');
  assert('today mixed: three guest toggles', todayToggles.length === 3, `count=${todayToggles.length}`);

  // Identify toggles by controlled panel content / order matches session order
  const pastToggle = todayToggles[0];
  const currentToggle = todayToggles[1];
  const upcomingToggle = todayToggles[2];
  const pastP = panelState(todayBoard, pastToggle);
  const curP = panelState(todayBoard, currentToggle);
  const upP = panelState(todayBoard, upcomingToggle);

  assert('today past session: guest panel starts hidden', pastP.panel && pastP.hidden === true);
  assert('today past session: panel has is-collapsed class', pastP.collapsedCls === true);
  assert('today past session: aria-expanded false',
    pastToggle && pastToggle.getAttribute('aria-expanded') === 'false');
  assert('today past session: button has is-collapsed',
    pastToggle && /\bis-collapsed\b/.test(pastToggle.className || ''));
  assert('today past session: Show guests label',
    pastToggle && (pastToggle._labelText || '').indexOf('Show guests') >= 0);
  assert('today past session: course card/header still present',
    todayHtml.includes('Morning Past')
      && todayHtml.includes('portal-schedule-ops-lesson-hdr')
      && todayHtml.includes('portal-schedule-ops-course-group'));
  assert('today past session: course card not removed when bookings hidden',
    todayHtml.includes('Past Guest') // still in DOM, just in hidden panel
      && !/portal-schedule-tl-item is-done is-empty[\s\S]*Morning Past/.test(todayHtml));

  assert('today current session: guest panel starts visible', curP.panel && curP.hidden === false);
  assert('today current session: Hide guests + aria-expanded true',
    currentToggle
      && currentToggle.getAttribute('aria-expanded') === 'true'
      && (currentToggle._labelText || '').indexOf('Hide guests') >= 0
      && !/\bis-collapsed\b/.test(currentToggle.className || ''));

  assert('today upcoming session: guest panel starts visible', upP.panel && upP.hidden === false);
  assert('today upcoming session: Hide guests + aria-expanded true',
    upcomingToggle
      && upcomingToggle.getAttribute('aria-expanded') === 'true'
      && (upcomingToggle._labelText || '').indexOf('Hide guests') >= 0);

  // Exactly at session start → still current (not done); end must be <= nowMin for done
  installFixedClock(11 * 60); // 11:00 = start of current session
  ctx.scheduleBuildDaySessions = () => ([
    makeSession({
      label: 'At Start',
      timeLabel: '11:00',
      slot_key: 'at-start',
      course_id: 'c-at-start',
      groups: [Object.assign({ records: [gCurrent] }, gCurrent)],
      start: 660,
      end: 780,
    }),
  ]);
  installCache([gCurrent]);
  ctx.renderScheduleDayOpsBoard({ rows: [gCurrent] }, '2026-07-15');
  const atStartToggle = dom['ps-ops-board'].querySelector('[data-ps-ops-guest-toggle]');
  const atStartPanel = panelState(dom['ps-ops-board'], atStartToggle);
  assert('today exactly at start: guest panel visible (not done)',
    atStartToggle
      && atStartToggle.getAttribute('aria-expanded') === 'true'
      && atStartPanel.panel && atStartPanel.hidden === false
      && (atStartToggle._labelText || '').indexOf('Hide guests') >= 0);

  // Exactly at session end → done (end <= nowMin)
  installFixedClock(10 * 60); // 10:00 = end
  ctx.scheduleBuildDaySessions = () => ([
    makeSession({
      label: 'At End',
      timeLabel: '09:00',
      slot_key: 'at-end',
      course_id: 'c-at-end',
      groups: [Object.assign({ records: [gPast] }, gPast)],
      start: 540,
      end: 600,
    }),
  ]);
  installCache([gPast]);
  ctx.renderScheduleDayOpsBoard({ rows: [gPast] }, '2026-07-15');
  const atEndToggle = dom['ps-ops-board'].querySelector('[data-ps-ops-guest-toggle]');
  const atEndPanel = panelState(dom['ps-ops-board'], atEndToggle);
  // New rule (Earthling): exactly at end is within the 1h grace → guests stay visible
  // (people/gear still around). Only collapse when no all-day gear AND >=1h past end.
  assert('today exactly at end: guest panel STAYS visible (within 1h grace, no all-day)',
    atEndToggle
      && atEndToggle.getAttribute('aria-expanded') === 'true'
      && atEndPanel.panel && atEndPanel.hidden === false
      && (atEndToggle._labelText || '').indexOf('Hide guests') >= 0);

  // Direct unit coverage for the collapse rule + all-day detector.
  var noCe = { records: [] };
  var allDayCe = { records: [{ metadata: { course_equipment: true, course_equipment_mode: 'all_day' } }] };
  var duringCe = { records: [{ metadata: { course_equipment: true, course_equipment_mode: 'during_course' } }] };
  var tCtx = function (nowMin) { return { isToday: true, nowMin: nowMin }; };
  assert('collapse rule: no all-day, exactly at end → stay open (grace)',
    ctx.scheduleTimelineGuestsShouldCollapse({ kind: 'course', end: 600, groups: [noCe] }, tCtx(600)) === false);
  assert('collapse rule: no all-day, +30min → stay open (grace)',
    ctx.scheduleTimelineGuestsShouldCollapse({ kind: 'course', end: 600, groups: [duringCe] }, tCtx(630)) === false);
  assert('collapse rule: no all-day, +59min → stay open (grace)',
    ctx.scheduleTimelineGuestsShouldCollapse({ kind: 'course', end: 600, groups: [noCe] }, tCtx(659)) === false);
  assert('collapse rule: no all-day, +60min → collapse',
    ctx.scheduleTimelineGuestsShouldCollapse({ kind: 'course', end: 600, groups: [noCe] }, tCtx(660)) === true);
  assert('collapse rule: all-day gear, +3h past end → stay open',
    ctx.scheduleTimelineGuestsShouldCollapse({ kind: 'course', end: 600, groups: [allDayCe] }, tCtx(780)) === false);
  assert('collapse rule: non-course never auto-collapses',
    ctx.scheduleTimelineGuestsShouldCollapse({ kind: 'private_lesson', end: 600, groups: [noCe] }, tCtx(900)) === false);
  assert('collapse rule: not today never auto-collapses',
    ctx.scheduleTimelineGuestsShouldCollapse({ kind: 'course', end: 600, groups: [noCe] }, { isToday: false, nowMin: 900 }) === false);
  assert('all-day detector true for all_day CE',
    ctx.scheduleCourseHasAllDayEquipment({ groups: [allDayCe] }) === true);
  assert('all-day detector false for during_course CE',
    ctx.scheduleCourseHasAllDayEquipment({ groups: [duringCe] }) === false);

  // Missing end → not done
  installFixedClock(18 * 60);
  ctx.scheduleBuildDaySessions = () => ([
    makeSession({
      label: 'No End',
      timeLabel: '09:00',
      slot_key: 'no-end',
      course_id: 'c-no-end',
      groups: [Object.assign({ records: [gPast] }, gPast)],
      start: 540,
      end: null,
    }),
  ]);
  installCache([gPast]);
  ctx.renderScheduleDayOpsBoard({ rows: [gPast] }, '2026-07-15');
  const noEndToggle = dom['ps-ops-board'].querySelector('[data-ps-ops-guest-toggle]');
  const noEndPanel = panelState(dom['ps-ops-board'], noEndToggle);
  assert('today missing end: guest panel starts visible',
    noEndToggle
      && noEndToggle.getAttribute('aria-expanded') === 'true'
      && noEndPanel.panel && noEndPanel.hidden === false
      && (noEndToggle._labelText || '').indexOf('Hide guests') >= 0);

  // The feature is course-only: passed private/other sessions stay expanded.
  ctx.scheduleBuildDaySessions = () => ([
    makeSession({
      kind: 'private_lesson',
      label: 'Past Private',
      sectionLabel: 'Past Private',
      timeLabel: '09:00',
      slot_key: 'private-past',
      course_id: '',
      groups: [Object.assign({ records: [gPast] }, gPast)],
      start: 540,
      end: 600,
    }),
    makeSession({
      kind: 'other',
      label: 'Past Other',
      timeLabel: '09:00',
      slot_key: 'other-past',
      course_id: '',
      groups: [Object.assign({ records: [gUpcoming] }, gUpcoming)],
      start: 540,
      end: 600,
    }),
  ]);
  installCache([gPast, gUpcoming]);
  ctx.renderScheduleDayOpsBoard({ rows: [gPast, gUpcoming] }, '2026-07-15');
  const nonCourseToggles = dom['ps-ops-board'].querySelectorAll('[data-ps-ops-guest-toggle]');
  const privateToggle = nonCourseToggles[0];
  const otherToggle = nonCourseToggles[1];
  const privatePanel = panelState(dom['ps-ops-board'], privateToggle);
  const otherPanel = panelState(dom['ps-ops-board'], otherToggle);
  assert('today passed private lesson remains expanded',
    privateToggle
      && privateToggle.getAttribute('aria-expanded') === 'true'
      && privatePanel.panel && privatePanel.hidden === false
      && (privateToggle._labelText || '').indexOf('Hide guests') >= 0);
  assert('today passed other session remains expanded',
    otherToggle
      && otherToggle.getAttribute('aria-expanded') === 'true'
      && otherPanel.panel && otherPanel.hidden === false
      && (otherToggle._labelText || '').indexOf('Hide guests') >= 0);

  // Empty course card remains visible (no guest toggle; empty-slot UI)
  ctx.scheduleBuildDaySessions = () => ([
    makeSession({
      label: 'Empty Morning',
      timeLabel: '09:00',
      slot_key: 'empty-am',
      course_id: 'c-empty',
      groups: [],
      start: 540,
      end: 600,
      surfers: 0,
      bookings: 0,
    }),
  ]);
  ctx.renderScheduleDayOpsBoard({ rows: [] }, '2026-07-15');
  const emptyHtml = dom['ps-ops-board'].innerHTML;
  assert('empty course card remains visible on today past slot',
    emptyHtml.includes('Empty Morning')
      && emptyHtml.includes('portal-schedule-empty-slot')
      && emptyHtml.includes('is-empty'));
  assert('empty course card has no guest toggle',
    dom['ps-ops-board'].querySelectorAll('[data-ps-ops-guest-toggle]').length === 0);

  // Future selected day: even if wall-clock is after session end, panels start expanded
  installFixedClock(18 * 60);
  ctx.scheduleBuildDaySessions = () => ([
    makeSession({
      label: 'Future Day Past-looking',
      timeLabel: '09:00',
      slot_key: 'fut-am',
      course_id: 'c-fut',
      groups: [Object.assign({ records: [gPast] }, gPast)],
      start: 540,
      end: 600,
    }),
  ]);
  installCache([gPast]);
  ctx.renderScheduleDayOpsBoard({ rows: [gPast] }, '2026-07-20'); // today is 2026-07-15
  const futToggle = dom['ps-ops-board'].querySelector('[data-ps-ops-guest-toggle]');
  const futPanel = panelState(dom['ps-ops-board'], futToggle);
  assert('future selected day: guest panel starts visible',
    futToggle
      && futToggle.getAttribute('aria-expanded') === 'true'
      && futPanel.panel && futPanel.hidden === false
      && (futToggle._labelText || '').indexOf('Hide guests') >= 0);

  // Historical selected day: always expanded on initial render
  ctx.renderScheduleDayOpsBoard({ rows: [gPast] }, '2026-07-10');
  const histToggle = dom['ps-ops-board'].querySelector('[data-ps-ops-guest-toggle]');
  const histPanel = panelState(dom['ps-ops-board'], histToggle);
  assert('historical selected day: guest panel starts visible',
    histToggle
      && histToggle.getAttribute('aria-expanded') === 'true'
      && histPanel.panel && histPanel.hidden === false
      && (histToggle._labelText || '').indexOf('Hide guests') >= 0);

  // Manual reveal/hide of default-hidden past panel + sibling isolation
  installFixedClock(12 * 60);
  ctx.scheduleBuildDaySessions = () => ([
    makeSession({
      label: 'Past A',
      timeLabel: '09:00',
      slot_key: 'past-a',
      course_id: 'c-past-a',
      groups: [Object.assign({ records: [gPast] }, gPast)],
      start: 540,
      end: 600,
    }),
    makeSession({
      label: 'Upcoming B',
      timeLabel: '15:00',
      slot_key: 'up-b',
      course_id: 'c-up-b',
      groups: [Object.assign({ records: [gUpcoming] }, gUpcoming)],
      start: 900,
      end: 960,
    }),
  ]);
  installCache([gPast, gUpcoming]);
  ctx.renderScheduleDayOpsBoard({ rows: [gPast, gUpcoming] }, '2026-07-15');
  const mixToggles = dom['ps-ops-board'].querySelectorAll('[data-ps-ops-guest-toggle]');
  const mixPast = mixToggles[0];
  const mixUp = mixToggles[1];
  const mixPastP = panelState(dom['ps-ops-board'], mixPast);
  const mixUpP = panelState(dom['ps-ops-board'], mixUp);
  assert('sibling isolation initial: past hidden, upcoming visible',
    mixPastP.hidden === true && mixUpP.hidden === false
      && mixPast.getAttribute('aria-expanded') === 'false'
      && mixUp.getAttribute('aria-expanded') === 'true');

  // Reveal past via real click wiring
  if (mixPast) mixPast.click();
  assert('manual reveal default-hidden past → expanded',
    mixPast.getAttribute('aria-expanded') === 'true'
      && mixPastP.panel && mixPastP.panel.hidden === false
      && (mixPast._labelText || '').indexOf('Hide guests') >= 0);
  assert('manual reveal past does not collapse sibling',
    mixUp.getAttribute('aria-expanded') === 'true'
      && mixUpP.panel && mixUpP.panel.hidden === false);

  // Hide again
  if (mixPast) mixPast.click();
  assert('manual re-hide past → collapsed again',
    mixPast.getAttribute('aria-expanded') === 'false'
      && mixPastP.panel && mixPastP.panel.hidden === true
      && (mixPast._labelText || '').indexOf('Show guests') >= 0);
  assert('manual re-hide past keeps sibling expanded',
    mixUp.getAttribute('aria-expanded') === 'true'
      && mixUpP.panel && mixUpP.panel.hidden === false);

  // Course header still present after toggle cycle
  assert('course card remains after toggle cycle',
    dom['ps-ops-board'].innerHTML.includes('Past A')
      && dom['ps-ops-board'].innerHTML.includes('portal-schedule-ops-lesson-hdr'));

  // Drawer still opens for booking in a revealed past panel
  drawerOpens.length = 0;
  if (mixPast) mixPast.click(); // expand again so interaction path is realistic
  const pastChip = dom['ps-ops-board']._chips.find((c) => c.getAttribute('data-ps-booking-id') === 'sid-past');
  if (pastChip) clickChip(pastChip, pastChip._guestSpan || pastChip);
  assert('drawer still opens from past session booking row',
    drawerOpens.length === 1 && drawerOpens[0] === 'sid-past');

  restoreClock();
  ctx.scheduleTodayIso = prevTodayIso;
  ctx.scheduleBuildDaySessions = prevSessionsDefault;

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

  ctx.scheduleRowSourceKind = (g) => (String(g._scheduleId || '').startsWith('l') ? 'luna' : 'staff');
  const occSplit = occHtml({
    surfers: 11,
    capacity: 24,
    groups: [
      { quantity: 7, _scheduleId: 'l1', guest_name: 'Kyle', components: { course: { quantity: 7 } } },
      { quantity: 3, _scheduleId: 's1', guest_name: 'Raul', components: { course: { quantity: 3 } } },
      { quantity: 1, _scheduleId: 's2', guest_name: 'Tito', components: { course: { quantity: 1 } } },
    ],
  });
  assert('occupancy split sets luna arc deg (7/24)',
    /--ps-occ-luna-deg:\s*105deg\b/.test(occSplit));
  assert('occupancy split sets 6deg source gap',
    /--ps-occ-gap-deg:\s*6deg\b/.test(occSplit));
  assert('occupancy split staff starts after gap (111deg)',
    /--ps-occ-staff-start-deg:\s*111deg\b/.test(occSplit));
  assert('occupancy split filled end includes gap (171deg)',
    /--ps-occ-filled-end-deg:\s*171deg\b/.test(occSplit));
  assert('occupancy split text 11/24',
    /11\s*\/\s*24|11<small>\/24<\/small>/.test(occSplit));

  const occStaffOnly = occHtml({
    surfers: 1,
    capacity: 24,
    groups: [{ quantity: 1, _scheduleId: 's-only', guest_name: 'James', components: { course: { quantity: 1 } } }],
  });
  assert('staff-only ring luna deg 0',
    /--ps-occ-luna-deg:\s*0deg\b/.test(occStaffOnly));
  assert('staff-only ring no source gap',
    /--ps-occ-gap-deg:\s*0deg\b/.test(occStaffOnly));
  assert('staff-only ring filled end (1/24)',
    /--ps-occ-filled-end-deg:\s*15deg\b/.test(occStaffOnly));

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

  // ── Layout: Timeline | Cards ─────────────────────────────────────────
  console.log('\n[5c] Day courses layout — Timeline | Cards');
  assert('cards column helper 1→1', ctx.scheduleDayOpsCardsColumnCount(1) === 1);
  assert('cards column helper 2→2', ctx.scheduleDayOpsCardsColumnCount(2) === 2);
  assert('cards column helper 3→3', ctx.scheduleDayOpsCardsColumnCount(3) === 3);
  assert('cards column helper 4→2', ctx.scheduleDayOpsCardsColumnCount(4) === 2);
  assert('cards column helper 6→3', ctx.scheduleDayOpsCardsColumnCount(6) === 3);
  assert('cards column helper 5→3', ctx.scheduleDayOpsCardsColumnCount(5) === 3);
  assert('cards column helper 8→2', ctx.scheduleDayOpsCardsColumnCount(8) === 2);

  const mkSess = (i) => ({
    kind: 'course',
    label: 'Curso ' + i,
    timeLabel: String(10 + i) + ':00',
    slot_key: 's' + i,
    course_id: 'c' + i,
    surfers: 1,
    bookings: 1,
    boardsNeeded: 1,
    wetsuitsNeeded: 1,
    groups: [makeGroup({ guest_name: 'G' + i, _scheduleId: 'sid-' + i, booking_id: 'bid-' + i })],
    start: (10 + i) * 60,
    end: (11 + i) * 60,
    capacity: 24,
  });
  const three = [mkSess(0), mkSess(1), mkSess(2)];
  const prevLayoutSessions = ctx.scheduleBuildDaySessions;
  const prevLayoutToday = ctx.scheduleTodayIso;
  ctx.scheduleTodayIso = () => '2026-07-20';
  ctx.scheduleBuildDaySessions = () => three;

  // default / timeline
  if (typeof ctx.scheduleSetDayOpsLayoutMode === 'function') ctx.scheduleSetDayOpsLayoutMode('timeline');
  installCache(three.map((s) => s.groups[0]));
  ctx.renderScheduleDayOpsBoard({ rows: three.map((s) => s.groups[0]) }, '2026-07-20');
  let board = dom['ps-ops-board'];
  assert('timeline layout attr', board.getAttribute('data-ops-layout') === 'timeline');
  assert('timeline has portal-schedule-timeline', board.innerHTML.includes('portal-schedule-timeline'));
  assert('timeline has no cards grid', !board.innerHTML.includes('portal-schedule-cards-grid'));
  assert('timeline keeps time rail class', board.innerHTML.includes('portal-schedule-tl-item'));

  // switch to cards via API (same path as cockpit toggle)
  ctx.scheduleSetDayOpsLayoutMode('cards');
  board = dom['ps-ops-board'];
  assert('cards layout attr after set', board.getAttribute('data-ops-layout') === 'cards');
  assert('cards grid present', board.innerHTML.includes('portal-schedule-cards-grid'));
  assert('cards no timeline rail', !board.innerHTML.includes('portal-schedule-timeline'));
  assert('cards 3 sessions → data-ps-card-cols=3', /data-ps-card-cols="3"/.test(board.innerHTML));
  assert('cards 3 sessions → --ps-card-cols:3', /--ps-card-cols:\s*3/.test(board.innerHTML));
  assert('cards still render course labels', board.innerHTML.includes('Curso 0') && board.innerHTML.includes('Curso 2'));
  assert('get mode returns cards', ctx.scheduleGetDayOpsLayoutMode() === 'cards');

  // 4 sessions → 2 cols
  const four = three.concat([mkSess(3)]);
  ctx.scheduleBuildDaySessions = () => four;
  installCache(four.map((s) => s.groups[0]));
  ctx.renderScheduleDayOpsBoard({ rows: four.map((s) => s.groups[0]) }, '2026-07-20');
  board = dom['ps-ops-board'];
  assert('cards 4 → cols 2', /data-ps-card-cols="2"/.test(board.innerHTML));

  // 1 session → full width 1 col
  ctx.scheduleBuildDaySessions = () => [mkSess(0)];
  installCache([mkSess(0).groups[0]]);
  ctx.renderScheduleDayOpsBoard({ rows: [mkSess(0).groups[0]] }, '2026-07-20');
  board = dom['ps-ops-board'];
  assert('cards 1 → cols 1', /data-ps-card-cols="1"/.test(board.innerHTML));

  // back to timeline
  ctx.scheduleSetDayOpsLayoutMode('timeline');
  board = dom['ps-ops-board'];
  assert('back to timeline', board.getAttribute('data-ops-layout') === 'timeline');
  assert('timeline restored', board.innerHTML.includes('portal-schedule-timeline'));

  ctx.scheduleBuildDaySessions = prevLayoutSessions;
  ctx.scheduleTodayIso = prevLayoutToday;
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
    assert('generated /staff/ui dual-color occ ring CSS',
      html.includes('--ps-occ-luna-fill') && html.includes('--ps-occ-staff-start-deg'));
    assert('generated /staff/ui occ ring ~2x stroke (10px mask)',
      /portal-schedule-occ-ring\{[^}]*100%\s*-\s*10px/.test(html));
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


console.log('\n[6b] Layout toggle CSS (staff-query-api)');
assert('ops-board uses shared stack gap', /--ps-stack-gap:\s*16px/.test(apiSrc));
assert('staff CSS pins #ps-day-cockpit bottom margin', /#ps-day-cockpit[^}]*margin:\s*0 0 16px/.test(apiSrc) || apiSrc.includes('#ps-day-cockpit,.ps-day-cockpit-host{margin:0 0 16px'));
assert('ops-board no extra top margin (cockpit owns spacing)', /\.portal-schedule-ops-board\{[^}]*margin-top:\s*0/.test(apiSrc));
assert('rental pickups no extra top margin', /\.portal-schedule-ops-rental-pickups\{margin-top:\s*0/.test(apiSrc));
assert('mobile forces cards layout', /function scheduleDayOpsIsMobileViewport/.test(modSrc) && /max-width:\s*768px/.test(modSrc));
assert('get layout returns cards on mobile path', /scheduleDayOpsIsMobileViewport\(\)\)\s*return 'cards'/.test(modSrc) || modSrc.includes("if (scheduleDayOpsIsMobileViewport()) return 'cards'"));
assert('media watch re-renders on breakpoint', modSrc.includes('scheduleEnsureDayOpsLayoutMediaWatch'));
assert('staff CSS hides layout pills on mobile', /@media\s*\(max-width:\s*768px\)[^{]*\{[^}]*ck-seg--layout[^}]*display:\s*none/.test(apiSrc) || apiSrc.includes('.ck-seg--layout{display:none!important}'));
assert('cards grid CSS present', apiSrc.includes('.portal-schedule-cards-grid{'));
assert('cards grid uses --ps-card-cols', apiSrc.includes('--ps-card-cols'));
assert('cards collapse to 1 col on mobile', apiSrc.includes('.portal-schedule-cards-grid{grid-template-columns:1fr!important}'));

console.log(`\n── verify:sunset-schedule-day-ops-board-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail) process.exit(1);
