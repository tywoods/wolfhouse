'use strict';

/**
 * verify:sunset-schedule-forecast-cards-ui
 *
 * Slice 19 — Schedule forecast-card presentation + day navigation gate.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-forecast-cards-ui.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { injectSunsetSchedulePortalModule } = require('./lib/sunset-schedule-browser-source');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
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
    'schedule.slot.surfers': 'surfers',
    'schedule.glance.seats': 'seats',
    'schedule.summary.boards': 'boards',
    'schedule.summary.wetsuits': 'wetsuits',
    'schedule.status.unpaid': 'Unpaid',
    'schedule.filter.needsReply': 'Needs reply',
  };
  return map[key] || key;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

console.log('\nverify:sunset-schedule-forecast-cards-ui\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const modExists = fs.existsSync(FORECAST_MODULE);
const modSrc = modExists ? fs.readFileSync(FORECAST_MODULE, 'utf8') : '';
const browserLoader = fs.readFileSync(BROWSER_SRC, 'utf8');

console.log('[1] Module files and injection order');
assert('forecast module exists', modExists);
assert('forecast inject marker in portal script', apiSrc.includes('/* INJECT:sunset-schedule-forecast-cards-ui */'));
assert('browser source loads forecast module', browserLoader.includes('getSunsetScheduleForecastCardsBrowserSource'));
const markers = [
  '/* INJECT:sunset-schedule-portal-module */',
  '/* INJECT:sunset-schedule-drawer-view-ui */',
  '/* INJECT:sunset-schedule-drawer-edit-ui */',
  '/* INJECT:sunset-schedule-drawer-payment-ui */',
  '/* INJECT:sunset-schedule-drawer-waiver-ui */',
  '/* INJECT:sunset-schedule-drawer-delete-ui */',
  '/* INJECT:sunset-schedule-drawer-controller */',
  '/* INJECT:sunset-schedule-day-ops-board-ui */',
  '/* INJECT:sunset-schedule-forecast-cards-ui */',
];
let prev = -1;
markers.forEach((m) => {
  const idx = apiSrc.indexOf(m);
  assert(`marker present ${m}`, idx > -1);
  assert(`marker once ${m}`, apiSrc.indexOf(m, idx + 1) === -1);
  if (idx > -1) assert(`marker order ${m}`, idx > prev, `idx=${idx} prev=${prev}`);
  if (idx > prev) prev = idx;
});
assert('inline scheduleRenderWeekForecastCard removed', !apiSrc.includes('function scheduleRenderWeekForecastCard('));
assert('inline scheduleWireOpsBoardClicks removed', !apiSrc.includes('function scheduleWireOpsBoardClicks('));
assert('monolith keeps scheduleBuildForecastCardPresentation', apiSrc.includes('function scheduleBuildForecastCardPresentation('));
assert('monolith keeps scheduleOpenDayDetail', apiSrc.includes('function scheduleOpenDayDetail('));
assert('module does not fetch', !modSrc.includes('fetch('));
assert('module does not expose window', !/window\.schedule/.test(modSrc));

console.log('\n[2] Module owns forecast symbols');
[
  'scheduleRenderForecastCardHtml',
  'scheduleWireForecastCardNavigation',
  'scheduleValidateForecastCardIso',
  'scheduleResolveForecastCardFromTarget',
  'scheduleClampForecastPct',
].forEach((name) => {
  assert(`module defines ${name}`, modSrc.includes(name));
});

console.log('\n[3] VM — render, keyboard, tamper, rerender');
if (modExists) {
  const navCalls = [];
  const prevented = [];
  const dom = { innerHTML: '', querySelectorAll() { return []; } };

  function makeContainer(html) {
    const cards = [];
    const re = /data-ps-day-open="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const iso = m[1];
      const card = {
        iso,
        dataset: {},
        getAttribute(k) { return k === 'data-ps-day-open' ? iso : null; },
        addEventListener(type, fn) {
          card[`on${type}`] = fn;
        },
      };
      cards.push(card);
    }
    return {
      innerHTML: html,
      querySelectorAll(sel) {
        if (sel === '[data-ps-day-open]') return cards;
        return [];
      },
    };
  }

  const ctx = {
    console,
    portalT,
    escHtml,
    scheduleOpenDayDetail: (iso) => { navCalls.push(iso); },
    scheduleTodayIso: () => '2026-07-15',
  };
  vm.createContext(ctx);
  vm.runInContext(modSrc, ctx);

  const minimal = {
    iso: '2026-07-20',
    dayLabel: 'Mon, Jul 20',
    isToday: false,
    surfers: 0,
    seats: 0,
    seatPct: null,
    equipBoardsTotal: 0,
    equipWetsuitsTotal: 0,
    unpaidCount: 0,
    needReplyCount: 0,
    sessions: [],
  };
  const htmlMin = ctx.scheduleRenderForecastCardHtml(minimal);
  assert('minimal card renders', htmlMin.includes('portal-schedule-week-forecast-card'));
  assert('minimal date attribute', htmlMin.includes('data-ps-day-open="2026-07-20"'));

  const populated = {
    iso: '2026-07-15',
    dayLabel: 'Tue<script>, Jul 15',
    isToday: true,
    surfers: 4,
    seats: 8,
    seatPct: 50,
    equipBoardsTotal: 2,
    equipWetsuitsTotal: 1,
    unpaidCount: 1,
    needReplyCount: 2,
    sessions: [{
      label: 'Morning<script>',
      timeShort: '09:00',
      countLabel: '4/8',
      staffPct: 75,
      lunaPct: 25,
    }],
  };
  const htmlPop = ctx.scheduleRenderForecastCardHtml(populated);
  assert('populated surfers', htmlPop.includes('4'));
  assert('today class', htmlPop.includes('is-today'));
  assert('label escaped', htmlPop.includes('Tue&lt;script&gt;, Jul 15'));
  assert('session escaped', htmlPop.includes('Morning&lt;script&gt;'));
  assert('unpaid flag from count', htmlPop.includes('portal-schedule-wk-flag is-unpaid'));
  assert('needs-reply flag from count', htmlPop.includes('portal-schedule-wk-flag is-reply'));
  assert('equipment fallback meta', htmlPop.includes('boards') || htmlPop.includes('seats'));

  assert('clamp NaN', ctx.scheduleClampForecastPct(NaN) === 0);
  assert('clamp Infinity', ctx.scheduleClampForecastPct(Infinity) === 0);
  assert('clamp negative', ctx.scheduleClampForecastPct(-5) === 0);
  assert('clamp over 100', ctx.scheduleClampForecastPct(150) === 100);

  const badWidth = ctx.scheduleRenderForecastCardHtml(Object.assign({}, populated, {
    sessions: [{ label: 'X', timeShort: '', countLabel: '1', staffPct: NaN, lunaPct: Infinity }],
  }));
  assert('bad widths clamped in markup', !badWidth.includes('width:NaN') && !badWidth.includes('width:Infinity'));

  navCalls.length = 0;
  const box = makeContainer(htmlPop);
  ctx.scheduleWireForecastCardNavigation(box);
  const card = box.querySelectorAll('[data-ps-day-open]')[0];
  card.onclick({ type: 'click', target: { closest: (s) => (s === '[data-ps-day-open]' ? card : null) }, stopPropagation() {} });
  assert('pointer activation once', navCalls.length === 1 && navCalls[0] === '2026-07-15');

  navCalls.length = 0;
  card.onkeydown({ type: 'keydown', key: 'Enter', target: { closest: (s) => (s === '[data-ps-day-open]' ? card : null) }, stopPropagation() {}, preventDefault() {} });
  assert('Enter activation once', navCalls.length === 1);

  navCalls.length = 0;
  prevented.length = 0;
  card.onkeydown({
    type: 'keydown', key: ' ', target: { closest: (s) => (s === '[data-ps-day-open]' ? card : null) },
    stopPropagation() {}, preventDefault() { prevented.push(1); },
  });
  assert('Space activation once', navCalls.length === 1);
  assert('Space preventDefault', prevented.length === 1);

  navCalls.length = 0;
  card.onkeydown({ type: 'keydown', key: 'Tab', target: { closest: (s) => (s === '[data-ps-day-open]' ? card : null) }, stopPropagation() {}, preventDefault() {} });
  assert('other keys noop', navCalls.length === 0);

  assert('invalid iso fail closed', ctx.scheduleValidateForecastCardIso('not-a-date') === null);
  assert('valid iso accepted', ctx.scheduleValidateForecastCardIso('2026-07-20') === '2026-07-20');
  navCalls.length = 0;
  const origGetAttribute = card.getAttribute;
  card.iso = 'bad-date';
  card.getAttribute = (k) => (k === 'data-ps-day-open' ? 'bad-date' : null);
  card.onclick({ type: 'click', target: { closest: (s) => (s === '[data-ps-day-open]' ? card : null) }, stopPropagation() {} });
  assert('tampered malformed date fail closed', navCalls.length === 0);
  card.getAttribute = origGetAttribute;
  card.iso = '2026-07-15';

  navCalls.length = 0;
  ctx.scheduleWireForecastCardNavigation(box);
  ctx.scheduleWireForecastCardNavigation(box);
  card.onclick({ type: 'click', target: { closest: (s) => (s === '[data-ps-day-open]' ? card : null) }, stopPropagation() {} });
  assert('rerender single handler', navCalls.length === 1);

  assert('week wrapper uses shared renderer', apiSrc.includes('scheduleRenderForecastCardHtml'));
  assert('next30 uses shared renderer', apiSrc.includes('scheduleRenderWeekForecastCard(') || apiSrc.includes('scheduleRenderForecastCardHtml('));
}

console.log(`\n── verify:sunset-schedule-forecast-cards-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail) process.exit(1);
