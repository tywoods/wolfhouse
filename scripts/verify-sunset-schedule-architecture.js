'use strict';

/**
 * verify:sunset-schedule-architecture
 *
 * Slice 24 — central Schedule injection order + runtime container contract.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-architecture.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const RUNTIME_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-runtime.js');
const NORMALIZER_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-row-normalizer.js');
const LOADER_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-data-loader.js');
const NAV_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-navigation-ui.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');

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

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

console.log('\nverify:sunset-schedule-architecture\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const runtimeSrc = fs.readFileSync(RUNTIME_MODULE, 'utf8');
const browserLoader = fs.readFileSync(BROWSER_SRC, 'utf8');

console.log('[1] Injection markers (central)');
assert('runtime module exists', fs.existsSync(RUNTIME_MODULE));
assert('runtime inject marker in portal script', apiSrc.includes('/* INJECT:sunset-schedule-runtime */'));
assert('browser source loads runtime module', browserLoader.includes('getSunsetScheduleRuntimeBrowserSource'));
assert('runtime injected before navigation', browserLoader.indexOf('SCHEDULE_RUNTIME_INJECT_MARKER') < browserLoader.indexOf('SCHEDULE_NAVIGATION_INJECT_MARKER'));
let prev = -1;
MARKERS.forEach((m) => {
  const idx = apiSrc.indexOf(m);
  assert(`marker present ${m}`, idx > -1);
  assert(`marker once ${m}`, apiSrc.indexOf(m, idx + 1) === -1);
  if (idx > -1) assert(`marker order ${m}`, idx > prev, `idx=${idx} prev=${prev}`);
  if (idx > prev) prev = idx;
});

console.log('\n[2] Runtime container contract');
assert('runtime defines SunsetScheduleRuntime', runtimeSrc.includes('var SunsetScheduleRuntime = (function'));
assert('runtime exposes rows API', runtimeSrc.includes('rows: rows'));
assert('runtime exposes load API', /var load = \{/.test(runtimeSrc));
assert('runtime exposes nav API', /var nav = \{/.test(runtimeSrc));
assert('runtime does not assign window', !/window\.SunsetScheduleRuntime/.test(runtimeSrc));
assert('nav state owned in closure', runtimeSrc.includes('var navState = {'));
assert('loader cache owned in closure', runtimeSrc.includes('var loaderState = {'));

console.log('\n[3] VM — runtime APIs + compatibility wrappers');
const ctx = {
  console,
  getClient: () => 'sunset',
  getSunsetLocation: () => 'sunset-somo',
  portalT: (k) => k,
  el: () => null,
  fetch: () => Promise.resolve({ ok: true, json: () => ({ rows: [] }) }),
  scheduleAddDays: (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; },
  scheduleParseIso: (s) => { const p = String(s).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); },
  scheduleIsoDate: (d) => {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  },
  scheduleTodayIso: () => '2026-07-15',
  scheduleDaysFromToday: () => 0,
  scheduleFormatRangeLabel: () => 'label',
  document: { querySelectorAll: () => [] },
  loadSchedulePage: () => {},
  getPortalProfile: () => ({ is_surf_vertical: true }),
  renderScheduleSchoolContext: () => {},
  sunsetLocationQuerySuffix: () => '&location_id=sunset-somo',
  inboxClientQuery: () => '?client=sunset',
  scheduleFetchLessonTimesConfig: () => Promise.resolve([]),
  scheduleBuildLoadedViewModel: () => ({ canonicalRows: [], rows: [] }),
  scheduleRenderLoadedViewModel: () => {},
};

vm.createContext(ctx);
vm.runInContext(runtimeSrc, ctx);
vm.runInContext(fs.readFileSync(NORMALIZER_MODULE, 'utf8'), ctx);
vm.runInContext(fs.readFileSync(NAV_MODULE, 'utf8'), ctx);
vm.runInContext(fs.readFileSync(LOADER_MODULE, 'utf8'), ctx);

assert('SunsetScheduleRuntime.rows.normalizeApiRow', typeof ctx.SunsetScheduleRuntime.rows.normalizeApiRow === 'function');
assert('SunsetScheduleRuntime.load.findRowById', typeof ctx.SunsetScheduleRuntime.load.findRowById === 'function');
assert('SunsetScheduleRuntime.nav.loadGen', typeof ctx.SunsetScheduleRuntime.nav.loadGen === 'function');
assert('compat scheduleNavigationLoadGen', ctx.scheduleNavigationLoadGen() === ctx.SunsetScheduleRuntime.nav.loadGen());
assert('compat scheduleFindRowById delegates', ctx.scheduleFindRowById('missing') === null);
assert('nav stateRef alias', ctx.scheduleNavigationState === ctx.SunsetScheduleRuntime.nav.stateRef);
assert('loader stateRef alias', ctx.scheduleDataLoaderState === ctx.SunsetScheduleRuntime.load.stateRef);

ctx.SunsetScheduleRuntime.load.replaceRowsSnapshot([
  { _scheduleId: 's1', booking_id: 'b1', guest_name: 'A', service_date: '2026-07-15' },
], { mode: 'day', loadGen: 1 });
const snap = ctx.scheduleGetRowsSnapshot();
snap[0].guest_name = 'mutated';
assert('immutable row snapshot accessor', ctx.scheduleGetRowsSnapshot()[0].guest_name === 'A');

const row = ctx.scheduleNormalizeApiRow({
  service_record_id: 'sr-1',
  booking_id: 'bk-1',
  service_date: '2026-07-15',
  record_source: 'staff_manual',
  location_id: 'sunset-somo',
  metadata: { component: 'lesson' },
}, { locationId: 'sunset-somo' });
assert('rows API normalizes frozen row', row && Object.isFrozen(row) && row._scheduleId === 'sr-1');

assert('no window runtime exposure', typeof global.SunsetScheduleRuntime === 'undefined');

console.log(`\n── verify:sunset-schedule-architecture ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail) process.exit(1);
