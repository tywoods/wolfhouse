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
const RUNTIME_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-runtime.js');
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

console.log('[1] Module files (marker order — see verify:sunset-schedule-architecture)');
assert('data loader module exists', modExists);
assert('data loader inject marker in portal script', apiSrc.includes('/* INJECT:sunset-schedule-data-loader */'));
assert('browser source loads data loader module', browserLoader.includes('getSunsetScheduleDataLoaderBrowserSource'));
assert('browser source loads row normalizer module', browserLoader.includes('getSunsetScheduleRowNormalizerBrowserSource'));
assert('loader delegates to runtime', modSrc.includes('SunsetScheduleRuntime.load'));
assert('loader installs dual indexes from view-model', fs.readFileSync(RUNTIME_MODULE, 'utf8').includes('viewModel.canonicalRows')
  && fs.readFileSync(RUNTIME_MODULE, 'utf8').includes('viewModel.presentationOnlyRows')
  && fs.readFileSync(RUNTIME_MODULE, 'utf8').includes('replaceLoadSnapshots'));
assert('runtime owns resolveRow', fs.readFileSync(RUNTIME_MODULE, 'utf8').includes('function resolveRow('));
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
  'scheduleGetPresentationSnapshot',
  'scheduleReplaceRowsSnapshot',
  'scheduleReplaceLoadSnapshots',
  'scheduleFindCachedRowByBookingId',
  'scheduleFindRowById',
  'scheduleResolveRow',
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
  vm.runInContext(fs.readFileSync(RUNTIME_MODULE, 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(NORMALIZER_MODULE, 'utf8'), ctx);
  let injectPresentationOnBuild = false;
  ctx.scheduleBuildLoadedViewModel = function(weekData, convData, profile, rangeStart, navSnapshot) {
    const norm = ctx.scheduleNormalizeLoadedScheduleResponse(weekData, profile, { locationId: 'sunset-somo', client: 'sunset' });
    const presentationOnlyRows = injectPresentationOnBuild
      ? [{
        _scheduleId: 'demo-presentation-1',
        guest_name: 'Demo Presentation',
        service_date: '2026-07-15',
        _isDemo: true,
        record_source: 'portal_demo',
      }]
      : [];
    return {
      weekData: norm.weekData,
      canonicalRows: norm.canonicalRows,
      presentationOnlyRows,
      rows: norm.canonicalRows,
      conversations: (convData && convData.conversations) || [],
      profile,
      rangeStart,
      navSnapshot,
    };
  };
  vm.runInContext(fs.readFileSync(NAV_MODULE, 'utf8'), ctx);
  vm.runInContext(modSrc, ctx);

  function bumpAlignedLoad(mode, forwardOffset, todayIso) {
    const loadGen = ctx.scheduleNavigationBumpLoad();
    return ctx.loadSchedulePage({ mode, forwardOffset, loadGen, todayIso });
  }

  ctx.scheduleReplaceRowsSnapshot(priorRows, { mode: 'day', forwardOffset: 0, loadGen: 0, todayIso: '2026-07-15' });

  async function waitLoads(n) {
    for (let i = 0; i < 40; i += 1) {
      if (renders.length >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  (async () => {
    fetchCalls.length = 0;
    renders.length = 0;
    await bumpAlignedLoad('day', 0, '2026-07-15');
    await waitLoads(1);
    assert('day load selects week-range day endpoint', fetchCalls.some((u) => String(u).includes('date=2026-07-15')));
    assert('day load trusted tenant suffix', fetchCalls.some((u) => String(u).includes('client=sunset') && String(u).includes('location_id=sunset-somo')));
    assert('day cache installs once', ctx.scheduleGetRowsSnapshot().length === 1);
    assert('day render once', renders.length >= 1 && renders[0].mode === 'day');

    assert('booking lookup unique', ctx.scheduleFindCachedRowByBookingId('b-day-a') && ctx.scheduleFindCachedRowByBookingId('b-day-a').guest_name === 'Day A');
    assert('schedule id lookup works', ctx.scheduleFindRowById('s-a') && ctx.scheduleFindRowById('s-a').guest_name === 'Day A');
    assert('resolveRow canonical trust', (() => {
      const r = ctx.scheduleResolveRow('s-a');
      return r && r._rowIndexKind === 'canonical' && r._isDemo !== true;
    })());
    assert('unknown booking lookup null', ctx.scheduleFindCachedRowByBookingId('missing') === null);
    assert('missing resolveRow fails closed', ctx.scheduleResolveRow('nope') === null);

    renders.length = 0;
    injectPresentationOnBuild = true;
    await bumpAlignedLoad('day', 0, '2026-07-15');
    await waitLoads(1);
    assert('presentation index installed on load', ctx.scheduleGetPresentationSnapshot().length === 1);
    assert('presentation resolve read-only trust', (() => {
      const r = ctx.scheduleResolveRow('demo-presentation-1');
      return r && r._rowIndexKind === 'presentation' && r._isDemo === true && r._trustSource === 'demo';
    })());
    assert('presentation not in canonical snapshot', !ctx.scheduleGetRowsSnapshot().some((r) => r._scheduleId === 'demo-presentation-1'));
    injectPresentationOnBuild = false;
    ctx.scheduleReplaceRowsSnapshot([
      { booking_id: 'dup', _scheduleId: 'd1', guest_name: 'One', service_date: '2026-07-15' },
      { booking_id: 'dup', _scheduleId: 'd2', guest_name: 'Two', service_date: '2026-07-15' },
    ], { mode: 'day', forwardOffset: 0, loadGen: ctx.scheduleNavigationLoadGen(), todayIso: '2026-07-15' });
    assert('ambiguous booking identity fail closed', ctx.scheduleFindCachedRowByBookingId('dup') === null);

    const snap = ctx.scheduleGetRowsSnapshot();
    snap[0].guest_name = 'mutated';
    assert('cache accessor defensive copy', ctx.scheduleGetRowsSnapshot()[0].guest_name !== 'mutated');

    fetchCalls.length = 0;
    renders.length = 0;
    await bumpAlignedLoad('week', 0, '2026-07-15');
    await waitLoads(1);
    assert('week load fans out seven day requests', fetchCalls.filter((u) => String(u).includes('/staff/schedule/day')).length === 7);

    fetchCalls.length = 0;
    renders.length = 0;
    await bumpAlignedLoad('next30', 0, '2026-07-15');
    await waitLoads(1);
    assert('next30 load fans out thirty day requests', fetchCalls.filter((u) => String(u).includes('/staff/schedule/day')).length === 30);

    await bumpAlignedLoad('bogus', 0, '2026-07-15');
    await waitLoads(2);
    assert('unknown mode fail closed to day fetch', fetchCalls.some((u) => String(u).includes('date=2026-07-15')));

    jul16RowEnabled = true;
    let holdDayA;
    let holdActive = true;
    const origFetch = ctx.fetch;
    ctx.fetch = (url) => {
      if (holdActive && String(url).includes('date=2026-07-15')) {
        holdActive = false;
        return new Promise((res) => { holdDayA = () => origFetch(url).then(res); });
      }
      return origFetch(url);
    };
    injectPresentationOnBuild = true;
    const pA = bumpAlignedLoad('day', 0, '2026-07-15');
    injectPresentationOnBuild = false;
    renders.length = 0;
    await bumpAlignedLoad('day', 1, '2026-07-15');
    await waitLoads(1);
    if (holdDayA) holdDayA();
    await pA;
    await new Promise((r) => setTimeout(r, 80));
    assert('stale success cannot mutate cache', ctx.scheduleFindCachedRowByBookingId('stale') === null);
    assert('day B wins race', ctx.scheduleFindCachedRowByBookingId('b-day-b') !== null);
    assert('stale success cannot poison presentation index', ctx.scheduleResolveRow('demo-presentation-1') === null
      && ctx.scheduleGetPresentationSnapshot().length === 0);

    ctx.fetch = origFetch;
    dom['ps-state'].textContent = '';
    dom['ps-state'].className = '';
    const cachedBeforeFail = ctx.scheduleFindCachedRowByBookingId('b-day-b');
    ctx.fetch = (url) => {
      if (String(url).includes('/staff/schedule/day')) return Promise.reject(new Error('network down'));
      return origFetch(url);
    };
    await bumpAlignedLoad('day', 1, '2026-07-15');
    await new Promise((r) => setTimeout(r, 80));
    assert('network failure preserves prior cache', ctx.scheduleFindCachedRowByBookingId('b-day-b') !== null && cachedBeforeFail.guest_name === 'Day B');
    assert('network failure shows error', dom['ps-state'].className.includes('error'));

    ctx.fetch = origFetch;
    renders.length = 0;
    await bumpAlignedLoad('day', 0, '2026-07-15');
    await waitLoads(1);
    assert('retry after failure replaces cache', ctx.scheduleFindCachedRowByBookingId('b-day-a') !== null);

    assert('navigation delegates via runtime load', fs.readFileSync(NAV_MODULE, 'utf8').includes('SunsetScheduleRuntime.nav.requestPageLoad')
      && fs.readFileSync(RUNTIME_MODULE, 'utf8').includes('return load.loadPage(snap)'));
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
