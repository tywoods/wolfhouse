'use strict';

/**
 * verify:sunset-schedule-view-grid-ui
 *
 * Slice 20 — Schedule Day/Week/Next-30 view-grid orchestration gate.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-view-grid-ui.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const VIEW_GRID_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-view-grid-ui.js');
const LOADER_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-data-loader.js');
const DAY_OPS_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-day-ops-board-ui.js');
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
    'schedule.emptyDay': 'No bookings this day',
    'schedule.slot.surfers': 'surfers',
  };
  return map[key] || key;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

console.log('\nverify:sunset-schedule-view-grid-ui\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const modExists = fs.existsSync(VIEW_GRID_MODULE);
const modSrc = modExists ? fs.readFileSync(VIEW_GRID_MODULE, 'utf8') : '';
const loaderSrc = fs.existsSync(LOADER_MODULE) ? fs.readFileSync(LOADER_MODULE, 'utf8') : '';
const dayOpsSrc = fs.readFileSync(DAY_OPS_MODULE, 'utf8');
const forecastSrc = fs.readFileSync(FORECAST_MODULE, 'utf8');
const browserLoader = fs.readFileSync(BROWSER_SRC, 'utf8');

const MARKERS = [
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

console.log('[1] Module files and injection order');
assert('view grid module exists', modExists);
assert('view grid inject marker in portal script', apiSrc.includes('/* INJECT:sunset-schedule-view-grid-ui */'));
assert('browser source loads view grid module', browserLoader.includes('getSunsetScheduleViewGridBrowserSource'));
let prev = -1;
MARKERS.forEach((m) => {
  const idx = apiSrc.indexOf(m);
  assert(`marker present ${m}`, idx > -1);
  assert(`marker once ${m}`, apiSrc.indexOf(m, idx + 1) === -1);
  if (idx > -1) assert(`marker order ${m}`, idx > prev, `idx=${idx} prev=${prev}`);
  if (idx > prev) prev = idx;
});
assert('inline renderScheduleNext30Grid removed', !apiSrc.includes('function renderScheduleNext30Grid('));
assert('inline renderScheduleOpsBoard removed', !apiSrc.includes('function renderScheduleOpsBoard('));
assert('monolith keeps scheduleBuildViewGridContext', apiSrc.includes('function scheduleBuildViewGridContext('));
assert('monolith keeps scheduleFilterFutureWeekData', apiSrc.includes('function scheduleFilterFutureWeekData('));
assert('monolith keeps scheduleBuildLoadedViewModel', apiSrc.includes('function scheduleBuildLoadedViewModel('));
assert('loader module defines loadSchedulePage', loaderSrc.includes('function loadSchedulePage('));
assert('module does not fetch', !modSrc.includes('fetch('));
assert('module does not expose window', !/window\.schedule/.test(modSrc));
assert('module does not call domain aggregate helpers', !modSrc.includes('scheduleDaySeatStats')
  && !modSrc.includes('scheduleBuildForecastCardPresentation')
  && !modSrc.includes('scheduleFilterFutureWeekData'));

console.log('\n[2] Module owns orchestration symbols');
[
  'renderScheduleViewGrid',
  'scheduleNormalizeViewGridMode',
  'scheduleApplyViewGridVisibility',
  'scheduleRenderViewGridWeekHtml',
  'scheduleRenderViewGridNext30Html',
  'scheduleMountViewGridForecastCards',
].forEach((name) => {
  assert(`module defines ${name}`, modSrc.includes(name));
});

console.log('\n[3] VM — visibility, delegation, rerender, stale gen');
if (modExists) {
  function makeEl(id) {
    return {
      id,
      style: { display: '' },
      className: '',
      innerHTML: '',
      dataset: {},
      querySelectorAll(sel) {
        if (sel === '[data-ps-day-open]') {
          const cards = [];
          const re = /data-ps-day-open="([^"]+)"/g;
          let m;
          while ((m = re.exec(this.innerHTML)) !== null) {
            const iso = m[1];
            cards.push({
              iso,
              dataset: {},
              getAttribute(k) { return k === 'data-ps-day-open' ? iso : null; },
              addEventListener(type, fn) { this[`on${type}`] = fn; },
            });
          }
          return cards;
        }
        return [];
      },
    };
  }

  const dom = {
    'ps-week-grid': makeEl('ps-week-grid'),
    'ps-month-grid': makeEl('ps-month-grid'),
    'ps-ops-board': makeEl('ps-ops-board'),
  };
  const calls = { dayOps: 0, forecastHtml: 0, forecastWire: 0 };
  let activeGen = 1;

  const ctxBase = {
    console,
    portalT,
    escHtml,
    el: (id) => dom[id] || null,
    scheduleNavigationLoadGen: () => activeGen,
    renderScheduleDayOpsBoard: () => { calls.dayOps += 1; dom['ps-ops-board'].innerHTML = '<div class="portal-schedule-ops-row">row</div>'; },
    scheduleRenderForecastCardHtml: (c) => {
      calls.forecastHtml += 1;
      return `<div class="portal-schedule-week-forecast-card" data-ps-day-open="${escHtml(c.iso)}"></div>`;
    },
    scheduleWireForecastCardNavigation: () => { calls.forecastWire += 1; },
  };

  vm.createContext(ctxBase);
  vm.runInContext(modSrc, ctxBase);

  function vis(id) {
    return dom[id].style.display !== 'none';
  }

  function resetDom() {
    Object.keys(dom).forEach((k) => {
      dom[k].style.display = '';
      dom[k].innerHTML = '';
      dom[k].className = '';
    });
    calls.dayOps = 0;
    calls.forecastHtml = 0;
    calls.forecastWire = 0;
  }

  const card = { iso: '2026-07-20', dayLabel: 'Mon', isToday: false, surfers: 1, sessions: [] };
  const dayCtx = {
    renderGen: 1,
    mode: 'day',
    activeDayIso: '2026-07-20',
    emptyDayText: 'No bookings this day',
    dayPack: { rows: [] },
  };

  resetDom();
  activeGen = 1;
  ctxBase.renderScheduleViewGrid(dayCtx);
  assert('Day mode shows only ops board', vis('ps-ops-board') && !vis('ps-week-grid') && !vis('ps-month-grid'));
  assert('Day mode delegates once to day ops', calls.dayOps === 1);

  resetDom();
  ctxBase.renderScheduleViewGrid(Object.assign({}, dayCtx, {
    mode: 'week',
    weekCards: [card, Object.assign({}, card, { iso: '2026-07-21' })],
  }));
  assert('Week mode shows only week grid', vis('ps-week-grid') && !vis('ps-ops-board') && !vis('ps-month-grid'));
  assert('Week mode renders forecast cards', calls.forecastHtml === 2);
  assert('Week mode wires navigation once', calls.forecastWire === 1);
  assert('Week grid class preserved', dom['ps-week-grid'].className.includes('portal-schedule-week-forecast'));
  assert('Week seven-column grid', dom['ps-week-grid'].style.gridTemplateColumns.includes('repeat(7'));

  resetDom();
  ctxBase.renderScheduleViewGrid({
    renderGen: 1,
    mode: 'next30',
    emptyDayText: 'No bookings this day',
    next30Cards: [card],
  });
  assert('Next30 mode shows only month grid', vis('ps-month-grid') && !vis('ps-week-grid') && !vis('ps-ops-board'));
  assert('Next30 uses forecast renderer', calls.forecastHtml === 1);
  assert('Next30 wires navigation once', calls.forecastWire === 1);

  resetDom();
  ctxBase.renderScheduleViewGrid({ renderGen: 1, mode: 'week', weekCards: [], emptyDayText: 'No<script> day' });
  assert('Empty week safe state', dom['ps-week-grid'].innerHTML.includes('state-msg'));
  assert('Empty week escaped', dom['ps-week-grid'].innerHTML.includes('No&lt;script&gt; day'));

  resetDom();
  ctxBase.renderScheduleViewGrid({ renderGen: 1, mode: 'next30', next30Cards: [], emptyDayText: 'Empty<script>' });
  assert('Empty next30 safe state', dom['ps-month-grid'].innerHTML.includes('state-msg'));
  assert('Empty next30 escaped', dom['ps-month-grid'].innerHTML.includes('Empty&lt;script&gt;'));

  resetDom();
  ctxBase.renderScheduleViewGrid(Object.assign({}, dayCtx, { dayPack: null }));
  assert('Missing day pack still mounts day ops', calls.dayOps === 1);

  resetDom();
  ctxBase.renderScheduleViewGrid({ renderGen: 1, mode: 'bogus', dayPack: { rows: [] }, activeDayIso: '2026-07-20', emptyDayText: 'x', weekCards: [card], next30Cards: [card] });
  assert('Unknown mode fail closed to day', vis('ps-ops-board') && !vis('ps-week-grid') && !vis('ps-month-grid'));

  resetDom();
  delete dom['ps-week-grid'];
  ctxBase.renderScheduleViewGrid({ renderGen: 1, mode: 'week', weekCards: [card], emptyDayText: 'x' });
  assert('Missing week container no throw', true);
  dom['ps-week-grid'] = makeEl('ps-week-grid');

  resetDom();
  activeGen = 1;
  ctxBase.renderScheduleViewGrid({ renderGen: 1, mode: 'week', weekCards: [card], emptyDayText: 'x' });
  ctxBase.renderScheduleViewGrid({ renderGen: 1, mode: 'week', weekCards: [card], emptyDayText: 'x' });
  assert('Repeated week mount wires once per render', calls.forecastWire === 2);

  resetDom();
  activeGen = 1;
  ctxBase.renderScheduleViewGrid(Object.assign({}, dayCtx));
  ctxBase.renderScheduleViewGrid(Object.assign({}, dayCtx));
  assert('Repeated day render delegates each mount', calls.dayOps === 2);

  resetDom();
  activeGen = 1;
  ctxBase.renderScheduleViewGrid({ renderGen: 1, mode: 'week', weekCards: [card], emptyDayText: 'x' });
  activeGen = 2;
  ctxBase.renderScheduleViewGrid(Object.assign({}, dayCtx, { renderGen: 2 }));
  assert('Day after Week preserves day visibility', vis('ps-ops-board') && !vis('ps-week-grid'));

  resetDom();
  activeGen = 1;
  ctxBase.renderScheduleViewGrid({ renderGen: 1, mode: 'next30', next30Cards: [card], emptyDayText: 'x' });
  activeGen = 2;
  ctxBase.renderScheduleViewGrid({ renderGen: 2, mode: 'week', weekCards: [card], emptyDayText: 'x' });
  assert('Week after Next30 preserves week visibility', vis('ps-week-grid') && !vis('ps-month-grid'));

  resetDom();
  activeGen = 2;
  ctxBase.renderScheduleViewGrid({ renderGen: 1, mode: 'week', weekCards: [card], emptyDayText: 'x' });
  assert('Stale week gen cannot mount week grid', !vis('ps-week-grid') || dom['ps-week-grid'].innerHTML === '');

  resetDom();
  activeGen = 3;
  ctxBase.renderScheduleViewGrid({ renderGen: 2, mode: 'next30', next30Cards: [card], emptyDayText: 'x' });
  ctxBase.renderScheduleViewGrid({ renderGen: 3, mode: 'day', dayPack: { rows: [] }, activeDayIso: '2026-07-20', emptyDayText: 'x' });
  assert('Stale next30 gen cannot overwrite day', vis('ps-ops-board') && !vis('ps-month-grid'));

  assert('monolith wrapper calls extracted renderer', apiSrc.includes('renderScheduleViewGrid('));
  assert('wrapper builds explicit context', apiSrc.includes('scheduleBuildViewGridContext('));
}

console.log('\n[4] Behavioral — historical Day keeps real pack; Week/Next30 stay future-only');
(function historicalDayRegression() {
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

  const filterSrc = extractFunctionSource(apiSrc, 'scheduleFilterFutureWeekData');
  const buildSrc = extractFunctionSource(apiSrc, 'scheduleBuildViewGridContext');
  assert('extract scheduleFilterFutureWeekData', !!filterSrc);
  assert('extract scheduleBuildViewGridContext', !!buildSrc);
  if (!filterSrc || !buildSrc) return;

  const todayIso = '2026-07-30';
  const pastIso = '2026-07-29';
  const futureIso = '2026-07-31';
  const pastRow = {
    _scheduleId: 'sid-hist-1',
    guest_name: 'Historical Guest',
    service_date: pastIso,
    booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  };
  const todayRow = {
    _scheduleId: 'sid-today-1',
    guest_name: 'Today Guest',
    service_date: todayIso,
  };
  const futureRow = {
    _scheduleId: 'sid-future-1',
    guest_name: 'Future Guest',
    service_date: futureIso,
  };
  const weekData = [
    { dateIso: pastIso, lessons: [], gear: [], rows: [pastRow] },
    { dateIso: todayIso, lessons: [], gear: [], rows: [todayRow] },
    { dateIso: futureIso, lessons: [], gear: [], rows: [futureRow] },
  ];

  function scheduleIsoDate(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function scheduleAddDays(d, n) {
    const x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }

  const vmCtx = {
    scheduleTodayIso: () => todayIso,
    scheduleGetNavigationSnapshot: () => ({ mode: 'day', todayIso }),
    scheduleIsoDate,
    scheduleAddDays,
    scheduleLessonTimesCache: [],
    portalT,
    scheduleBuildForecastCardPresentation(pack, iso) {
      return {
        iso,
        dayLabel: iso,
        isToday: iso === todayIso,
        surfers: (pack.rows || []).length,
        sessions: (pack.rows || []).length
          ? [{ label: 'Slot', countLabel: String((pack.rows || []).length), staffPct: 50, lunaPct: 0 }]
          : [],
        _packRows: (pack.rows || []).slice(),
      };
    },
  };
  vm.createContext(vmCtx);
  vm.runInContext(filterSrc + '\n' + buildSrc, vmCtx);

  const pastRangeStart = new Date(2026, 6, 29); // 2026-07-29 local
  const dayCtx = vmCtx.scheduleBuildViewGridContext(
    {},
    weekData,
    pastRangeStart,
    1,
    { mode: 'day', todayIso },
  );
  assert('Day mode activeDayIso is selected historical date', dayCtx.activeDayIso === pastIso);
  const dayRows = (dayCtx.dayPack && dayCtx.dayPack.rows) || [];
  assert('Day mode dayPack retains historical rows',
    Array.isArray(dayRows)
      && dayRows.length === 1
      && dayRows[0] && dayRows[0].guest_name === 'Historical Guest',
    `rows=${JSON.stringify(dayRows)}`);
  assert('Day mode dayPack is not empty default',
    dayRows[0] && dayRows[0]._scheduleId === 'sid-hist-1');

  // Selected-day metrics/context: board render receives the real historical pack.
  if (modExists) {
    const histDom = {
      'ps-ops-board': { style: { display: '' }, className: '', innerHTML: '', dataset: {} },
      'ps-week-grid': { style: { display: '' }, className: '', innerHTML: '', dataset: {} },
      'ps-month-grid': { style: { display: '' }, className: '', innerHTML: '', dataset: {} },
    };
    let receivedPack = null;
    let receivedIso = null;
    let activeGen = 1;
    const renderCtx = {
      console,
      portalT,
      escHtml,
      el: (id) => histDom[id] || null,
      scheduleNavigationLoadGen: () => activeGen,
      renderScheduleDayOpsBoard(pack, iso) {
        receivedPack = pack;
        receivedIso = iso;
        histDom['ps-ops-board'].innerHTML =
          '<div class="portal-schedule-ops-row" data-ps-booking-id="sid-hist-1">Historical Guest</div>'
          + '<div class="metric">rows=' + String((pack.rows || []).length) + '</div>';
      },
      scheduleRenderForecastCardHtml: () => '',
      scheduleWireForecastCardNavigation: () => {},
    };
    vm.createContext(renderCtx);
    vm.runInContext(modSrc, renderCtx);
    renderCtx.renderScheduleViewGrid({
      renderGen: 1,
      mode: 'day',
      activeDayIso: dayCtx.activeDayIso,
      dayPack: dayCtx.dayPack,
      emptyDayText: 'No bookings this day',
    });
    assert('Day board receives historical pack rows',
      receivedPack
        && receivedPack.rows
        && receivedPack.rows.length === 1
        && receivedPack.rows[0].guest_name === 'Historical Guest');
    assert('Day board receives historical active iso', receivedIso === pastIso);
    assert('Day board markup includes historical guest',
      histDom['ps-ops-board'].innerHTML.includes('Historical Guest')
        && histDom['ps-ops-board'].innerHTML.includes('sid-hist-1'));
    assert('Day selected-day metric context non-zero',
      histDom['ps-ops-board'].innerHTML.includes('rows=1'));
  }

  const weekRangeStart = new Date(2026, 6, 27); // Mon before today
  const weekCtx = vmCtx.scheduleBuildViewGridContext(
    {},
    weekData,
    weekRangeStart,
    2,
    { mode: 'week', todayIso },
  );
  const weekIsos = (weekCtx.weekCards || []).map((c) => c.iso);
  assert('Week cards exclude past dates',
    weekIsos.every((iso) => iso >= todayIso),
    `isos=${weekIsos.join(',')}`);
  assert('Week cards do not include historical past day', !weekIsos.includes(pastIso));
  assert('Week cards include today or future when present',
    weekIsos.includes(todayIso) || weekIsos.includes(futureIso),
    `isos=${weekIsos.join(',')}`);
  // Past pack content must not leak into week cards as booked slots.
  const weekHasPastGuest = (weekCtx.weekCards || []).some((c) =>
    (c._packRows || []).some((r) => r.guest_name === 'Historical Guest')
    || (c.sessions || []).some((s) => String(s.label || '').includes('Historical')));
  assert('Week cards never carry past-day guest rows', !weekHasPastGuest);

  const nextCtx = vmCtx.scheduleBuildViewGridContext(
    {},
    weekData,
    weekRangeStart,
    3,
    { mode: 'next30', todayIso },
  );
  const nextIsos = (nextCtx.next30Cards || []).map((c) => c.iso);
  const nextMonths = new Set(nextIsos.map((iso) => String(iso).slice(0, 7)));
  assert('Next30 cards stay in one calendar month', nextMonths.size === 1, `isos=${nextIsos.join(',')}`);
  assert('Next30 cards start on the first of that month', nextIsos[0] && nextIsos[0].slice(8, 10) === '01');
  assert('Next30 month includes in-month days (past or future)', nextIsos.length >= 28);

  // Future filter helper itself still drops past packs (Week/Next30 pipeline).
  const filtered = vmCtx.scheduleFilterFutureWeekData(weekData);
  assert('scheduleFilterFutureWeekData drops past packs',
    filtered.every((p) => p.dateIso >= todayIso)
      && !filtered.some((p) => p.dateIso === pastIso));
})();

console.log(`\n── verify:sunset-schedule-view-grid-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail) process.exit(1);
