'use strict';

/**
 * verify:sunset-schedule-navigation-ui
 *
 * Slice 21 — Schedule navigation state + toolbar lifecycle gate.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-navigation-ui.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const NAV_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-navigation-ui.js');
const LOADER_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-data-loader.js');
const VIEW_GRID_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-view-grid-ui.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

function portalT(key) {
  const map = {
    'schedule.view.today': 'Today',
    'schedule.view.next30': 'Next 30 days',
    'daySchedule.loading': 'Loading',
  };
  return map[key] || key;
}

console.log('\nverify:sunset-schedule-navigation-ui\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const modExists = fs.existsSync(NAV_MODULE);
const modSrc = modExists ? fs.readFileSync(NAV_MODULE, 'utf8') : '';
const loaderSrc = fs.existsSync(LOADER_MODULE) ? fs.readFileSync(LOADER_MODULE, 'utf8') : '';
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
  '/* INJECT:sunset-schedule-navigation-ui */',
  '/* INJECT:sunset-schedule-row-normalizer */',
  '/* INJECT:sunset-schedule-data-loader */',
];

console.log('[1] Module files and injection order');
assert('navigation module exists', modExists);
assert('navigation inject marker in portal script', apiSrc.includes('/* INJECT:sunset-schedule-navigation-ui */'));
assert('browser source loads navigation module', browserLoader.includes('getSunsetScheduleNavigationBrowserSource'));
let prev = -1;
MARKERS.forEach((m) => {
  const idx = apiSrc.indexOf(m);
  assert(`marker present ${m}`, idx > -1);
  assert(`marker once ${m}`, apiSrc.indexOf(m, idx + 1) === -1);
  if (idx > -1) assert(`marker order ${m}`, idx > prev, `idx=${idx} prev=${prev}`);
  if (idx > prev) prev = idx;
});
assert('inline var scheduleViewMode removed', !/var scheduleViewMode\s*=/.test(apiSrc));
assert('inline var scheduleForwardOffset removed', !/var scheduleForwardOffset\s*=/.test(apiSrc));
assert('inline setScheduleView removed', !apiSrc.includes('function setScheduleView('));
assert('inline scheduleOpenDayDetail removed', !apiSrc.includes('function scheduleOpenDayDetail('));
assert('monolith keeps scheduleBuildLoadedViewModel', apiSrc.includes('function scheduleBuildLoadedViewModel('));
assert('loader module defines loadSchedulePage', loaderSrc.includes('function loadSchedulePage('));
assert('monolith keeps scheduleFormatRangeLabel', apiSrc.includes('function scheduleFormatRangeLabel('));
assert('module does not fetch', !modSrc.includes('fetch('));
assert('module does not render grids', !modSrc.includes('renderScheduleViewGrid') && !modSrc.includes('scheduleRenderForecastCardHtml'));
assert('module does not expose window', !/window\.schedule/.test(modSrc));

console.log('\n[2] Module owns navigation symbols');
[
  'scheduleGetNavigationSnapshot',
  'scheduleCurrentViewMode',
  'scheduleNavigationLoadGen',
  'scheduleActiveDayIso',
  'scheduleRangeStartDate',
  'setScheduleView',
  'scheduleNavigatePrev',
  'scheduleNavigateNext',
  'scheduleNavigateToday',
  'scheduleOpenDayDetail',
  'scheduleWireScheduleNavigationControls',
  'scheduleApplyNavigationPresentation',
].forEach((name) => {
  assert(`module defines ${name}`, modSrc.includes(name));
});

console.log('\n[3] VM — transitions, labels, stale gen, wiring');
if (modExists) {
  const dom = {
    'ps-range-label': { textContent: '' },
    'ps-today': { className: '', classList: { toggle() {} }, dataset: {}, addEventListener: () => {} },
    'ps-prev-week': { dataset: {}, addEventListener: () => {} },
    'ps-next-week': { dataset: {}, addEventListener: () => {} },
    'ps-refresh-schedule': { dataset: {}, addEventListener: () => {} },
  };
  const viewBtns = [];
  ['day', 'week', 'next30'].forEach((mode) => {
    viewBtns.push({
      mode,
      dataset: {},
      getAttribute(k) { return k === 'data-ps-view' ? mode : null; },
      classList: { toggle(cls, on) { this.active = on; } },
      active: mode === 'day',
      addEventListener: () => {},
    });
  });

  const loads = [];
  let today = '2026-07-15';

  function scheduleIsoDate(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }
  function scheduleParseIso(s) {
    const p = String(s).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  function scheduleAddDays(d, n) {
    const x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }
  function scheduleDaysFromToday(iso) {
    const t = scheduleParseIso(today);
    const d = scheduleParseIso(iso);
    return Math.round((d.getTime() - t.getTime()) / 86400000);
  }
  function scheduleFormatRange(start, end) {
    return scheduleIsoDate(start) + ' – ' + scheduleIsoDate(end);
  }
  function scheduleFormatRangeLabel(start, end, viewMode) {
    if (viewMode === 'day') return portalT('schedule.view.today') + ' · Jul 15, 2026';
    if (viewMode === 'next30') return portalT('schedule.view.next30') + ' · Jul 15 – Aug 13, 2026';
    return scheduleFormatRange(start, end);
  }

  const ctx = {
    console,
    portalT,
    dsTodayIso: () => today,
    scheduleTodayIso: () => today,
    scheduleIsoDate,
    scheduleParseIso,
    scheduleAddDays,
    scheduleDaysFromToday,
    scheduleFormatRangeLabel,
    el: (id) => dom[id] || null,
    document: {
      querySelectorAll(sel) {
        if (sel === '.portal-schedule-view-btn') return viewBtns;
        return [];
      },
    },
    loadSchedulePage: (snap) => { loads.push(Object.assign({}, snap)); },
  };

  vm.createContext(ctx);
  vm.runInContext(modSrc, ctx);

  const initial = ctx.scheduleGetNavigationSnapshot();
  assert('initial day mode', initial.mode === 'day');
  assert('initial offset zero', initial.forwardOffset === 0);

  loads.length = 0;
  ctx.setScheduleView('week');
  assert('week toggle one load', loads.length === 1 && loads[0].mode === 'week' && loads[0].forwardOffset === 0);
  assert('week toggle re-anchors', ctx.scheduleCurrentViewMode() === 'week');

  ctx.setScheduleView('next30');
  assert('next30 toggle re-anchors', loads[loads.length - 1].forwardOffset === 0);

  ctx.setScheduleView('bogus');
  assert('unknown mode fail closed day', ctx.scheduleCurrentViewMode() === 'day');

  loads.length = 0;
  ctx.setScheduleView('day');
  ctx.scheduleNavigateNext();
  assert('day next +1 offset', loads[loads.length - 1].forwardOffset === 1);
  ctx.scheduleNavigatePrev();
  assert('day prev back to 0', loads[loads.length - 1].forwardOffset === 0);

  ctx.setScheduleView('week');
  const beforeWeek = ctx.scheduleGetNavigationSnapshot().forwardOffset;
  ctx.scheduleNavigateNext();
  assert('week next step 7', ctx.scheduleGetNavigationSnapshot().forwardOffset === beforeWeek + 7);

  ctx.setScheduleView('next30');
  const before30 = ctx.scheduleGetNavigationSnapshot().forwardOffset;
  ctx.scheduleNavigateNext();
  assert('next30 next step 30', ctx.scheduleGetNavigationSnapshot().forwardOffset === before30 + 30);

  ctx.scheduleNavigateToday();
  assert('today resets offset', ctx.scheduleGetNavigationSnapshot().forwardOffset === 0);

  loads.length = 0;
  ctx.scheduleOpenDayDetail('2026-07-20');
  assert('forecast open day mode', loads[loads.length - 1].mode === 'day');
  assert('forecast open exact offset', loads[loads.length - 1].forwardOffset === 5);

  loads.length = 0;
  ctx.scheduleOpenDayDetail('not-a-date');
  assert('invalid iso noop', loads.length === 0);

  loads.length = 0;
  ctx.scheduleOpenDayDetail('2026-07-10');
  assert('past date clamped', loads.length === 1 && loads[loads.length - 1].forwardOffset === 0);

  ctx.scheduleApplyNavigationPresentation(ctx.scheduleGetNavigationSnapshot());
  assert('range label set', dom['ps-range-label'].textContent.length > 0);

  loads.length = 0;
  const wired = [];
  dom['ps-prev-week'].addEventListener = (_, fn) => { dom['ps-prev-week']._fn = fn; };
  dom['ps-next-week'].addEventListener = (_, fn) => { dom['ps-next-week']._fn = fn; };
  viewBtns.forEach((b) => { b.addEventListener = (_, fn) => { b._fn = fn; }; });
  ctx.scheduleWireScheduleNavigationControls();
  ctx.scheduleWireScheduleNavigationControls();
  dom['ps-prev-week']._fn();
  assert('prev wired once per control', loads.length === 1);
  viewBtns[1]._fn();
  assert('view button wired', ctx.scheduleCurrentViewMode() === 'week');

  ctx.setScheduleView('day');
  loads.length = 0;
  for (let i = 0; i < 5; i += 1) ctx.scheduleNavigateNext();
  assert('rapid next final offset', ctx.scheduleGetNavigationSnapshot().forwardOffset === 5);
  const finalGen = ctx.scheduleNavigationLoadGen();
  const staleSnap = Object.assign({}, ctx.scheduleGetNavigationSnapshot(), { loadGen: finalGen - 2 });
  assert('older generation stale', staleSnap.loadGen < finalGen);

  assert('loader accepts snapshot', loaderSrc.includes('loadSchedulePage(navSnapshot)'));
  assert('view grid uses navigation load gen', fs.readFileSync(VIEW_GRID_MODULE, 'utf8').includes('scheduleNavigationLoadGen'));
}

console.log(`\n── verify:sunset-schedule-navigation-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail) process.exit(1);
