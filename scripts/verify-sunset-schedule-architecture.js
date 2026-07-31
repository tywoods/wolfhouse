'use strict';

/**
 * verify:sunset-schedule-architecture
 *
 * Slice 24 / 24B — central Schedule injection order + runtime container contract.
 * 24B: no stateRef / mutable state aliases; public API objects frozen.
 *
 * Drawer acceptance (readiness — NOT a file-count target):
 *   Controller owns lifecycle/stale generation.
 *   View owns read presentation.
 *   Edit owns edit/save presentation.
 *   Actions owns payment/waiver/delete mutations.
 *   No duplicated mutable action state; no duplicate mutation request paths;
 *   presentation modules must not bypass canonical trust.
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
const DRAWER_CONTROLLER = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-controller.js');
const DRAWER_VIEW = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const DRAWER_EDIT = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-edit-ui.js');
const DRAWER_ACTIONS = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-actions.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');

const MARKERS = [
  '/* INJECT:sunset-schedule-portal-module */',
  '/* INJECT:sunset-schedule-drawer-view-ui */',
  '/* INJECT:sunset-schedule-drawer-edit-ui */',
  '/* INJECT:sunset-schedule-drawer-actions */',
  '/* INJECT:sunset-schedule-drawer-controller */',
  '/* INJECT:sunset-schedule-day-ops-board-ui */',
  '/* INJECT:sunset-schedule-day-cockpit */',
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
assert('runtime has no stateRef', !/\bstateRef\b/.test(runtimeSrc));
assert('navigation wrapper has no scheduleNavigationState', !/\bscheduleNavigationState\b/.test(fs.readFileSync(NAV_MODULE, 'utf8')));
assert('loader wrapper has no scheduleDataLoaderState', !/\bscheduleDataLoaderState\b/.test(fs.readFileSync(LOADER_MODULE, 'utf8')));
assert('runtime freezes public API objects', runtimeSrc.includes('Object.freeze(rows)')
  && runtimeSrc.includes('Object.freeze(load)')
  && runtimeSrc.includes('Object.freeze(nav)'));

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
assert('SunsetScheduleRuntime.load.resolveRow', typeof ctx.SunsetScheduleRuntime.load.resolveRow === 'function');
assert('SunsetScheduleRuntime.load.replaceLoadSnapshots', typeof ctx.SunsetScheduleRuntime.load.replaceLoadSnapshots === 'function');
assert('SunsetScheduleRuntime.nav.loadGen', typeof ctx.SunsetScheduleRuntime.nav.loadGen === 'function');
assert('compat scheduleNavigationLoadGen', ctx.scheduleNavigationLoadGen() === ctx.SunsetScheduleRuntime.nav.loadGen());
assert('compat scheduleFindRowById delegates', ctx.scheduleFindRowById('missing') === null);
assert('compat scheduleResolveRow delegates', typeof ctx.scheduleResolveRow === 'function' && ctx.scheduleResolveRow('missing') === null);
assert('day-ops pack ref removed', !fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-day-ops-board-ui.js'), 'utf8').includes('scheduleDayOpsBoardRowsRef'));
assert('no scheduleNavigationState global', typeof ctx.scheduleNavigationState === 'undefined');
assert('no scheduleDataLoaderState global', typeof ctx.scheduleDataLoaderState === 'undefined');
assert('no nav.stateRef', ctx.SunsetScheduleRuntime.nav.stateRef === undefined);
assert('no load.stateRef', ctx.SunsetScheduleRuntime.load.stateRef === undefined);
assert('rows API frozen', Object.isFrozen(ctx.SunsetScheduleRuntime.rows));
assert('load API frozen', Object.isFrozen(ctx.SunsetScheduleRuntime.load));
assert('nav API frozen', Object.isFrozen(ctx.SunsetScheduleRuntime.nav));
assert('runtime container frozen', Object.isFrozen(ctx.SunsetScheduleRuntime));
try {
  ctx.SunsetScheduleRuntime.nav.loadGen = () => 999;
  assert('frozen nav rejects method replace', ctx.SunsetScheduleRuntime.nav.loadGen() !== 999
    || ctx.scheduleNavigationLoadGen() === ctx.SunsetScheduleRuntime.nav.loadGen());
} catch (_) {
  assert('frozen nav rejects method replace', true);
}

ctx.SunsetScheduleRuntime.load.replaceLoadSnapshots([
  { _scheduleId: 's1', booking_id: 'b1', guest_name: 'A', service_date: '2026-07-15', record_source: 'staff_manual' },
], [
  { _scheduleId: 'demo-1', guest_name: 'Demo', service_date: '2026-07-15', _isDemo: true, record_source: 'portal_demo' },
], { mode: 'day', loadGen: 1 });
const snap = ctx.scheduleGetRowsSnapshot();
snap[0].guest_name = 'mutated';
assert('immutable row snapshot accessor', ctx.scheduleGetRowsSnapshot()[0].guest_name === 'A');
const presentationSnap = ctx.scheduleGetPresentationSnapshot();
presentationSnap[0].guest_name = 'mutated-demo';
assert('immutable presentation snapshot accessor', ctx.scheduleGetPresentationSnapshot()[0].guest_name === 'Demo');

const canonicalResolved = ctx.SunsetScheduleRuntime.load.resolveRow('s1');
assert('canonical resolve trust', !!canonicalResolved
  && canonicalResolved._rowIndexKind === 'canonical'
  && canonicalResolved._isDemo !== true);
const presentationResolved = ctx.SunsetScheduleRuntime.load.resolveRow('demo-1');
assert('presentation resolve read-only trust', !!presentationResolved
  && presentationResolved._rowIndexKind === 'presentation'
  && presentationResolved._isDemo === true
  && presentationResolved._trustSource === 'demo');
assert('missing row fails closed', ctx.SunsetScheduleRuntime.load.resolveRow('nope') === null);
assert('findRowById aliases resolveRow', ctx.scheduleFindRowById('demo-1')
  && ctx.scheduleFindRowById('demo-1')._rowIndexKind === 'presentation');

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

console.log('\n[4] Drawer ownership cohesion (not a file-count target)');
const controllerSrc = fs.readFileSync(DRAWER_CONTROLLER, 'utf8');
const viewSrc = fs.readFileSync(DRAWER_VIEW, 'utf8');
const editSrc = fs.readFileSync(DRAWER_EDIT, 'utf8');
const actionsSrc = fs.readFileSync(DRAWER_ACTIONS, 'utf8');

assert('controller module present', fs.existsSync(DRAWER_CONTROLLER));
assert('view module present', fs.existsSync(DRAWER_VIEW));
assert('edit module present', fs.existsSync(DRAWER_EDIT));
assert('actions module present', fs.existsSync(DRAWER_ACTIONS));

assert('controller owns openGen lifecycle', controllerSrc.includes('scheduleDrawerBumpOpenGeneration')
  && controllerSrc.includes('scheduleDrawerIsRequestActive')
  && /openGen/.test(controllerSrc));
assert('controller owns open/close/mount', controllerSrc.includes('function openScheduleDetailDrawer')
  && controllerSrc.includes('function closeScheduleDetailDrawer')
  && controllerSrc.includes('function scheduleMountDrawerBody'));
assert('controller does not own stripe/manual/waiver/delete mutation bodies',
  !/function scheduleCreateDrawerStripeLink\s*\(/.test(controllerSrc)
  && !/function scheduleDeleteBookingFromDrawer\s*\(/.test(controllerSrc)
  && !/record-cash-payment/.test(controllerSrc));

assert('view owns read presentation helpers', viewSrc.includes('scheduleRenderViewDrawerHtml')
  || viewSrc.includes('scheduleRenderSunsetViewDrawerHtml'));
assert('view has no booking PATCH/DELETE mutation path',
  !/method:\s*['"]PATCH['"]/.test(viewSrc) && !/method:\s*['"]DELETE['"]/.test(viewSrc));
assert('view has no stripe-link POST mutation', !/bookings\/stripe-link/.test(viewSrc));
assert('view has no cash-payment mutation', !/record-cash-payment/.test(viewSrc));

assert('edit owns save presentation + single PATCH path', editSrc.includes('function scheduleSaveDrawerBooking')
  && /method:\s*['"]PATCH['"]/.test(editSrc));
assert('edit does not own payment/waiver/delete mutation bodies',
  !/function scheduleCreateDrawerStripeLink\s*\(/.test(editSrc)
  && !/function scheduleDeleteBookingFromDrawer\s*\(/.test(editSrc)
  && !/record-cash-payment/.test(editSrc)
  && !/bookings\/stripe-link/.test(editSrc));

assert('actions owns mutation closure + shared requestJson', actionsSrc.includes('var SunsetScheduleDrawerActions')
  && actionsSrc.includes('function requestJson')
  && actionsSrc.includes('var flight = {'));
assert('actions owns stripe/manual/waiver/delete paths',
  /bookings\/stripe-link/.test(actionsSrc)
  && /record-cash-payment/.test(actionsSrc)
  && /\/waiver/.test(actionsSrc)
  && /method:\s*['"]DELETE['"]/.test(actionsSrc));
assert('actions not assigned to window', !/window\.SunsetScheduleDrawerActions/.test(actionsSrc));

assert('no duplicated flight action state outside actions',
  !/\bvar flight\s*=\s*\{/.test(controllerSrc)
  && !/\bvar flight\s*=\s*\{/.test(viewSrc)
  && !/\bvar flight\s*=\s*\{/.test(editSrc)
  && (actionsSrc.match(/\bvar flight\s*=\s*\{/g) || []).length === 1);
assert('no second requestJson helper in drawer presentation modules',
  !/function requestJson\s*\(/.test(viewSrc)
  && !/function requestJson\s*\(/.test(editSrc)
  && !/function requestJson\s*\(/.test(controllerSrc));

assert('controller requires canonical trust before detail API',
  controllerSrc.includes('scheduleDrawerCanLoadCanonical'));
assert('actions gates delete on canonical trust',
  actionsSrc.includes('scheduleDrawerCanLoadCanonical'));
assert('view/edit cannot redefine trust gate',
  !/function scheduleDrawerCanLoadCanonical\s*\(/.test(viewSrc)
  && !/function scheduleDrawerCanLoadCanonical\s*\(/.test(editSrc));

assert('behavioral gates cover lifecycle/edit/mutations',
  fs.existsSync(path.join(ROOT, 'scripts', 'verify-sunset-schedule-drawer-controller.js'))
  && fs.existsSync(path.join(ROOT, 'scripts', 'verify-sunset-schedule-drawer-edit-ui.js'))
  && fs.existsSync(path.join(ROOT, 'scripts', 'verify-sunset-schedule-drawer-actions.js')));

console.log(`\n── verify:sunset-schedule-architecture ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail) process.exit(1);
