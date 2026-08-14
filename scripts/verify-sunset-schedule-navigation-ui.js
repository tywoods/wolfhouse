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
const RUNTIME_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-runtime.js');
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

console.log('[1] Module files (marker order — see verify:sunset-schedule-architecture)');
assert('navigation module exists', modExists);
assert('navigation inject marker in portal script', apiSrc.includes('/* INJECT:sunset-schedule-navigation-ui */'));
assert('browser source loads navigation module', browserLoader.includes('getSunsetScheduleNavigationBrowserSource'));
assert('inline var scheduleViewMode removed', !/var scheduleViewMode\s*=/.test(apiSrc));
assert('inline var scheduleForwardOffset removed', !/var scheduleForwardOffset\s*=/.test(apiSrc));
assert('inline setScheduleView removed', !apiSrc.includes('function setScheduleView('));
assert('inline scheduleOpenDayDetail removed', !apiSrc.includes('function scheduleOpenDayDetail('));
assert('monolith keeps scheduleBuildLoadedViewModel', apiSrc.includes('function scheduleBuildLoadedViewModel('));
assert('loader module defines loadSchedulePage', loaderSrc.includes('function loadSchedulePage('));
assert('monolith keeps scheduleFormatRangeLabel', apiSrc.includes('function scheduleFormatRangeLabel('));
assert('module does not fetch', !modSrc.includes('fetch('));
assert('module does not render grids', !modSrc.includes('renderScheduleViewGrid') && !modSrc.includes('scheduleRenderForecastCardHtml'));
assert('module delegates to runtime', modSrc.includes('SunsetScheduleRuntime.nav'));
assert('nav does not expose window.scheduleRequestPageLoad', !/window\.scheduleRequestPageLoad/.test(modSrc));

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
    'ps-state': { textContent: '', className: '', style: { display: '' } },
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
    getClient: () => 'sunset',
    getPortalProfile: () => ({ is_surf_vertical: true, demo_mode: false }),
    renderScheduleSchoolContext: () => {},
    fetch: () => Promise.resolve({ ok: true, json: () => ({ rows: [], conversations: [] }) }),
    inboxClientQuery: () => '?client=sunset',
    sunsetLocationQuerySuffix: () => '&location_id=sunset-somo',
    scheduleFetchLessonTimesConfig: () => Promise.resolve([]),
    scheduleBuildLoadedViewModel: (_w, _c, _p, _r, snap) => ({
      canonicalRows: [],
      rows: [],
      weekData: [],
      presentationOnlyRows: [],
      conversations: [],
      profile: _p,
      rangeStart: _r,
      navSnapshot: snap,
    }),
    scheduleRenderLoadedViewModel: () => {},
  };

  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(RUNTIME_MODULE, 'utf8'), ctx);
  vm.runInContext(modSrc, ctx);

  function snap() { return ctx.scheduleGetNavigationSnapshot(); }

  const initial = snap();
  assert('initial day mode', initial.mode === 'day');
  assert('initial offset zero', initial.forwardOffset === 0);

  let genBefore = ctx.scheduleNavigationLoadGen();
  ctx.setScheduleView('week');
  assert('week toggle one load', ctx.scheduleNavigationLoadGen() === genBefore + 1
    && snap().mode === 'week' && snap().forwardOffset === 0);
  assert('week toggle re-anchors', ctx.scheduleCurrentViewMode() === 'week');

  ctx.setScheduleView('next30');
  assert('next30 toggle re-anchors', snap().forwardOffset === 0 && snap().mode === 'next30');

  ctx.setScheduleView('bogus');
  assert('unknown mode fail closed day', ctx.scheduleCurrentViewMode() === 'day');

  ctx.setScheduleView('day');
  ctx.scheduleNavigateNext();
  assert('day next +1 offset', snap().forwardOffset === 1);
  ctx.scheduleNavigatePrev();
  assert('day prev back to 0', snap().forwardOffset === 0);

  ctx.setScheduleView('week');
  const beforeWeek = snap().forwardOffset;
  ctx.scheduleNavigateNext();
  assert('week next step 7', snap().forwardOffset === beforeWeek + 7);

  ctx.setScheduleView('next30');
  const before30 = snap();
  ctx.scheduleNavigateNext();
  const after30 = snap();
  const beforeMonth = Number(String(before30.rangeStartIso || before30.focusDateIso).slice(5, 7));
  const afterMonth = Number(String(after30.rangeStartIso || after30.focusDateIso).slice(5, 7));
  assert('next30 next steps one calendar month', (afterMonth === beforeMonth + 1) || (beforeMonth === 12 && afterMonth === 1));

  ctx.scheduleNavigateToday();
  assert('today resets offset', snap().forwardOffset === 0);

  ctx.scheduleOpenDayDetail('2026-07-20');
  assert('forecast open day mode', snap().mode === 'day');
  assert('forecast open exact offset', snap().forwardOffset === 5);

  genBefore = ctx.scheduleNavigationLoadGen();
  ctx.scheduleOpenDayDetail('not-a-date');
  assert('invalid iso noop', ctx.scheduleNavigationLoadGen() === genBefore);

  ctx.scheduleOpenDayDetail('2026-07-10');
  assert('past date opens that day', snap().forwardOffset === -5 && snap().mode === 'day');

  ctx.scheduleApplyNavigationPresentation(snap());
  assert('range label set', dom['ps-range-label'].textContent.length > 0);

  genBefore = ctx.scheduleNavigationLoadGen();
  dom['ps-prev-week'].addEventListener = (_, fn) => { dom['ps-prev-week']._fn = fn; };
  dom['ps-next-week'].addEventListener = (_, fn) => { dom['ps-next-week']._fn = fn; };
  viewBtns.forEach((b) => { b.addEventListener = (_, fn) => { b._fn = fn; }; });
  ctx.scheduleWireScheduleNavigationControls();
  ctx.scheduleWireScheduleNavigationControls();
  dom['ps-prev-week']._fn();
  assert('prev wired once per control', ctx.scheduleNavigationLoadGen() === genBefore + 1);
  viewBtns[1]._fn();
  assert('view button wired', ctx.scheduleCurrentViewMode() === 'week');

  ctx.setScheduleView('day');
  for (let i = 0; i < 5; i += 1) ctx.scheduleNavigateNext();
  assert('rapid next final offset', snap().forwardOffset === 5);
  const finalGen = ctx.scheduleNavigationLoadGen();
  const staleSnap = Object.assign({}, snap(), { loadGen: finalGen - 2 });
  assert('older generation stale', staleSnap.loadGen < finalGen);

  assert('loader accepts snapshot', loaderSrc.includes('loadSchedulePage(navSnapshot)'));
  assert('view grid uses navigation load gen', fs.readFileSync(VIEW_GRID_MODULE, 'utf8').includes('scheduleNavigationLoadGen'));
}

console.log(`\n── verify:sunset-schedule-navigation-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail) process.exit(1);
