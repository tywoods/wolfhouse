'use strict';

/**
 * verify:sunset-schedule-data-loader
 *
 * Slice 22 — Schedule data loader + canonical row cache gate.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-data-loader.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const LOADER_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-data-loader.js');
const NORMALIZER_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-row-normalizer.js');
const NAV_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-navigation-ui.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

function portalT(key) {
  const map = {
    'daySchedule.loading': 'Loading schedule',
    'daySchedule.error': 'Schedule error',
  };
  return map[key] || key;
}

console.log('\nverify:sunset-schedule-data-loader\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const modExists = fs.existsSync(LOADER_MODULE);
const modSrc = modExists ? fs.readFileSync(LOADER_MODULE, 'utf8') : '';
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
assert('data loader module exists', modExists);
assert('data loader inject marker in portal script', apiSrc.includes('/* INJECT:sunset-schedule-data-loader */'));
assert('browser source loads data loader module', browserLoader.includes('getSunsetScheduleDataLoaderBrowserSource'));
assert('browser source loads row normalizer module', browserLoader.includes('getSunsetScheduleRowNormalizerBrowserSource'));
assert('loader caches canonical rows only', modSrc.includes('viewModel.canonicalRows'));
let prev = -1;
MARKERS.forEach((m) => {
  const idx = apiSrc.indexOf(m);
  assert(`marker present ${m}`, idx > -1);
  assert(`marker once ${m}`, apiSrc.indexOf(m, idx + 1) === -1);
  if (idx > -1) assert(`marker order ${m}`, idx > prev, `idx=${idx} prev=${prev}`);
  if (idx > prev) prev = idx;
});
assert('inline var scheduleRowsCache removed', !/var scheduleRowsCache\s*=/.test(apiSrc));
assert('inline function loadSchedulePage removed from monolith', !/function loadSchedulePage\(/.test(apiSrc));
assert('inline scheduleFetchDay removed from monolith', !/function scheduleFetchDay\(/.test(apiSrc));
assert('inline scheduleFetchWeek removed from monolith', !/function scheduleFetchWeek\(/.test(apiSrc));
assert('inline scheduleFetchNext30 removed from monolith', !/function scheduleFetchNext30\(/.test(apiSrc));
assert('inline scheduleFindRowById removed from monolith', !/function scheduleFindRowById\(/.test(apiSrc));
assert('monolith keeps scheduleBuildLoadedViewModel', apiSrc.includes('function scheduleBuildLoadedViewModel('));
assert('monolith keeps scheduleRenderLoadedViewModel', apiSrc.includes('function scheduleRenderLoadedViewModel('));
assert('module does not fetch aggregates', !modSrc.includes('scheduleDaySeatStats') && !modSrc.includes('renderScheduleSummary'));
assert('module does not expose window', !/window\.schedule/.test(modSrc));

console.log('\n[2] Module owns loader/cache symbols');
[
  'loadSchedulePage',
  'scheduleGetRowsSnapshot',
  'scheduleReplaceRowsSnapshot',
  'scheduleFindCachedRowByBookingId',
  'scheduleFindRowById',
  'scheduleCurrentLoadSnapshot',
  'scheduleIsLoadActive',
  'scheduleFetchDay',
  'scheduleFetchWeek',
  'scheduleFetchNext30',
].forEach((name) => {
  assert(`module defines ${name}`, modSrc.includes(name));
});

console.log('\n[3] VM — async loads, cache, stale, errors');
if (modExists) {
  const dom = {
    'ps-state': { textContent: '', className: '', style: { display: '' } },
  };
  let navGen = 0;
  let client = 'sunset';
  let locationSuffix = '&location_id=sunset-somo';
  const fetchCalls = [];
  const renders = [];
  let priorRows = [{ booking_id: 'keep-me', _scheduleId: 'keep', guest_name: 'Prior', service_date: '2026-07-15' }];

  function scheduleNavigationLoadGen() { return navGen; }
  function scheduleRequestPageLoad() { navGen += 1; return loadSchedulePage({ mode: 'day', forwardOffset: 0, loadGen: navGen, todayIso: '2026-07-15' }); }
  function getClient() { return client; }
  function getPortalProfile() { return { is_surf_vertical: true, demo_mode: false }; }
  function renderScheduleSchoolContext() {}
  function scheduleTodayIso() { return '2026-07-15'; }
  function scheduleParseIso(s) { const p = String(s).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  function scheduleAddDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function scheduleIsoDate(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }
  function sunsetLocationQuerySuffix() { return locationSuffix; }
  function inboxClientQuery() { return '?client=sunset'; }
  function scheduleFetchLessonTimesConfig() { return Promise.resolve([]); }
  function scheduleBuildDemoBookings() { return []; }
  function scheduleMergeRowsIntoWeekData(weekData) { return weekData || []; }
  function scheduleRenderLoadedViewModel(viewModel, loadGen, navSnapshot) {
    renders.push({ loadGen, mode: navSnapshot.mode, rowCount: (viewModel.rows || []).length });
  }

  let jul16RowEnabled = false;

  function mockFetch(url) {
    fetchCalls.push(url);
    if (String(url).includes('/staff/conversations')) {
      return Promise.resolve({ ok: true, json: () => ({ success: true, conversations: [] }) });
    }
    if (String(url).includes('date=2026-07-16') && jul16RowEnabled) {
      return Promise.resolve({ ok: true, json: () => ({ rows: [{ booking_id: 'b-day-b', service_record_id: 's-b', guest_name: 'Day B', service_date: '2026-07-16', record_source: 'staff_manual', location_id: 'sunset-somo' }] }) });
    }
    if (String(url).includes('date=2026-07-15')) {
      return Promise.resolve({ ok: true, json: () => ({ rows: [{ booking_id: 'b-day-a', service_record_id: 's-a', guest_name: 'Day A', service_date: '2026-07-15', record_source: 'staff_manual', location_id: 'sunset-somo' }] }) });
    }
    return Promise.resolve({ ok: true, json: () => ({ rows: [] }) });
  }

  const ctx = {
    console,
    portalT,
    el: (id) => dom[id] || null,
    fetch: mockFetch,
    scheduleNavigationLoadGen,
    scheduleRequestPageLoad,
    getClient,
    getPortalProfile,
    renderScheduleSchoolContext,
    scheduleTodayIso,
    scheduleParseIso,
    scheduleAddDays,
    scheduleIsoDate,
    sunsetLocationQuerySuffix,
    inboxClientQuery,
    scheduleFetchLessonTimesConfig,
    scheduleRenderLoadedViewModel,
    scheduleBuildDemoBookings,
    scheduleMergeRowsIntoWeekData,
    getSunsetLocation: () => 'sunset-somo',
  };

  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(NORMALIZER_MODULE, 'utf8'), ctx);
  ctx.scheduleBuildLoadedViewModel = function(weekData, convData, profile, rangeStart, navSnapshot) {
    const norm = ctx.scheduleNormalizeLoadedScheduleResponse(weekData, profile, { locationId: 'sunset-somo', client: 'sunset' });
    return {
      weekData: norm.weekData,
      canonicalRows: norm.canonicalRows,
      presentationOnlyRows: [],
      rows: norm.canonicalRows,
      conversations: (convData && convData.conversations) || [],
      profile,
      rangeStart,
      navSnapshot,
    };
  };
  vm.runInContext(fs.readFileSync(NAV_MODULE, 'utf8'), ctx);
  vm.runInContext(modSrc, ctx);

  function setNavGen(n) {
    navGen = n;
    ctx.scheduleNavigationState.loadGen = n;
    ctx.scheduleNavigationState.navigationGen = n;
  }

  ctx.scheduleReplaceRowsSnapshot(priorRows, { mode: 'day', forwardOffset: 0, loadGen: 0, todayIso: '2026-07-15' });

  async function waitLoads(n) {
    for (let i = 0; i < 40; i += 1) {
      if (renders.length >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  (async () => {
    setNavGen(1);
    fetchCalls.length = 0;
    renders.length = 0;
    await ctx.loadSchedulePage({ mode: 'day', forwardOffset: 0, loadGen: 1, todayIso: '2026-07-15' });
    await waitLoads(1);
    assert('day load selects week-range day endpoint', fetchCalls.some((u) => String(u).includes('date=2026-07-15')));
    assert('day load trusted tenant suffix', fetchCalls.some((u) => String(u).includes('client=sunset') && String(u).includes('location_id=sunset-somo')));
    assert('day cache installs once', ctx.scheduleGetRowsSnapshot().length === 1);
    assert('day render once', renders.length >= 1 && renders[0].mode === 'day');

    assert('booking lookup unique', ctx.scheduleFindCachedRowByBookingId('b-day-a') && ctx.scheduleFindCachedRowByBookingId('b-day-a').guest_name === 'Day A');
    assert('schedule id lookup works', ctx.scheduleFindRowById('s-a') && ctx.scheduleFindRowById('s-a').guest_name === 'Day A');
    assert('unknown booking lookup null', ctx.scheduleFindCachedRowByBookingId('missing') === null);
    ctx.scheduleReplaceRowsSnapshot([
      { booking_id: 'dup', _scheduleId: 'd1', guest_name: 'One', service_date: '2026-07-15' },
      { booking_id: 'dup', _scheduleId: 'd2', guest_name: 'Two', service_date: '2026-07-15' },
    ], { mode: 'day', forwardOffset: 0, loadGen: 1, todayIso: '2026-07-15' });
    assert('ambiguous booking identity fail closed', ctx.scheduleFindCachedRowByBookingId('dup') === null);

    const snap = ctx.scheduleGetRowsSnapshot();
    snap[0].guest_name = 'mutated';
    assert('cache accessor defensive copy', ctx.scheduleGetRowsSnapshot()[0].guest_name !== 'mutated');

    setNavGen(2);
    fetchCalls.length = 0;
    renders.length = 0;
    await ctx.loadSchedulePage({ mode: 'week', forwardOffset: 0, loadGen: 2, todayIso: '2026-07-15' });
    await waitLoads(1);
    assert('week load fans out seven day requests', fetchCalls.filter((u) => String(u).includes('/staff/schedule/day')).length === 7);

    setNavGen(3);
    fetchCalls.length = 0;
    renders.length = 0;
    await ctx.loadSchedulePage({ mode: 'next30', forwardOffset: 0, loadGen: 3, todayIso: '2026-07-15' });
    await waitLoads(1);
    assert('next30 load fans out thirty day requests', fetchCalls.filter((u) => String(u).includes('/staff/schedule/day')).length === 30);

    setNavGen(4);
    await ctx.loadSchedulePage({ mode: 'bogus', forwardOffset: 0, loadGen: 4, todayIso: '2026-07-15' });
    await waitLoads(2);
    assert('unknown mode fail closed to day fetch', fetchCalls.some((u) => String(u).includes('date=2026-07-15')));

    setNavGen(5);
    jul16RowEnabled = true;
    let holdDayA;
    const origFetch = ctx.fetch;
    ctx.fetch = (url) => {
      if (String(url).includes('date=2026-07-15') && ctx.scheduleNavigationState.loadGen === 5) {
        return new Promise((res) => { holdDayA = () => origFetch(url).then(res); });
      }
      return origFetch(url);
    };
    const pA = ctx.loadSchedulePage({ mode: 'day', forwardOffset: 0, loadGen: 5, todayIso: '2026-07-15' });
    setNavGen(6);
    renders.length = 0;
    await ctx.loadSchedulePage({ mode: 'day', forwardOffset: 1, loadGen: 6, todayIso: '2026-07-15' });
    await waitLoads(1);
    if (holdDayA) holdDayA();
    await pA;
    await new Promise((r) => setTimeout(r, 80));
    assert('stale success cannot mutate cache', ctx.scheduleFindCachedRowByBookingId('stale') === null);
    assert('day B wins race', ctx.scheduleFindCachedRowByBookingId('b-day-b') !== null);

    ctx.fetch = origFetch;
    setNavGen(7);
    dom['ps-state'].textContent = '';
    dom['ps-state'].className = '';
    const cachedBeforeFail = ctx.scheduleFindCachedRowByBookingId('b-day-b');
    ctx.fetch = (url) => {
      if (String(url).includes('/staff/schedule/day')) return Promise.reject(new Error('network down'));
      return origFetch(url);
    };
    await ctx.loadSchedulePage({ mode: 'day', forwardOffset: 1, loadGen: 7, todayIso: '2026-07-15' });
    await new Promise((r) => setTimeout(r, 80));
    assert('network failure preserves prior cache', ctx.scheduleFindCachedRowByBookingId('b-day-b') !== null && cachedBeforeFail.guest_name === 'Day B');
    assert('network failure shows error', dom['ps-state'].className.includes('error'));

    setNavGen(8);
    ctx.fetch = origFetch;
    renders.length = 0;
    await ctx.loadSchedulePage({ mode: 'day', forwardOffset: 0, loadGen: 8, todayIso: '2026-07-15' });
    await waitLoads(1);
    assert('retry after failure replaces cache', ctx.scheduleFindCachedRowByBookingId('b-day-a') !== null);

    assert('navigation delegates to loader', fs.readFileSync(NAV_MODULE, 'utf8').includes('loadSchedulePage(snap)'));
    assert('view grid still uses navigation load gen', fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-view-grid-ui.js'), 'utf8').includes('scheduleNavigationLoadGen'));

    console.log(`\n── verify:sunset-schedule-data-loader ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
    if (fail) process.exit(1);
  })().catch((e) => {
    console.error(e);
    process.exit(2);
  });
} else {
  console.log(`\n── verify:sunset-schedule-data-loader FAILED (pass=${pass} fail=${fail + 1}) ──\n`);
  process.exit(1);
}
