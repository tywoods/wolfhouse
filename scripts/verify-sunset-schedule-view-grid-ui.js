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

console.log(`\n── verify:sunset-schedule-view-grid-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail) process.exit(1);
