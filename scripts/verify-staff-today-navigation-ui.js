'use strict';

/**
 * verify:staff-today-navigation-ui
 *
 * Today screen: multi-day booking day-progress pill + Previous date navigation.
 *
 * Run:
 *   node scripts/verify-staff-today-navigation-ui.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DAY_OPS = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-day-ops-board-ui.js');
const RUNTIME = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-runtime.js');
const NAV = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-navigation-ui.js');
const I18N = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');
const I18N_ES = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es-sunset.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

console.log('\nverify:staff-today-navigation-ui\n');

const dayOpsSrc = fs.readFileSync(DAY_OPS, 'utf8');
const runtimeSrc = fs.readFileSync(RUNTIME, 'utf8');
const navSrc = fs.readFileSync(NAV, 'utf8');
const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const i18nSrc = fs.readFileSync(I18N, 'utf8');
const i18nEsSrc = fs.readFileSync(I18N_ES, 'utf8');

console.log('[1] Source + catalog gates');
assert('day progress helper present', dayOpsSrc.includes('function scheduleBookingDayProgress('));
assert('canonical service dates helper present', dayOpsSrc.includes('function scheduleCanonicalBookedServiceDates('));
assert('ops row renders day progress meta', dayOpsSrc.includes('scheduleRenderDayProgressMetaHtml'));
assert('prev does not clamp to zero', !/navigatePrev[\s\S]{0,180}Math\.max\(\s*0/.test(runtimeSrc));
assert('snapshot allows negative offset', !/getNavigationSnapshot[\s\S]{0,220}off\s*<\s*0/.test(runtimeSrc));
assert('loadPage allows negative offset', !/loadPage[\s\S]{0,260}forwardOffset\s*<\s*0/.test(runtimeSrc));
assert('day-progress CSS present', apiSrc.includes('.portal-schedule-day-progress'));
assert('EN catalog key', i18nSrc.includes("'schedule.card.dayProgress': 'Day {day} of {total}'"));
assert('ES catalog key', i18nEsSrc.includes("'schedule.card.dayProgress': 'Día {day} de {total}'"));
assert('IT catalog key', i18nSrc.includes("'schedule.card.dayProgress': 'Giorno {day} di {total}'"));
assert('no raw EN fallback in helper output path', dayOpsSrc.includes("label === 'schedule.card.dayProgress'"));

console.log('\n[2] VM — multi-day progress + Previous navigation');

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
function scheduleEnumerateDates(fromIso, toIso) {
  const out = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromIso || ''))) return out;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(toIso || '')) ? toIso : fromIso;
  let cur = scheduleParseIso(fromIso);
  const end = scheduleParseIso(to);
  let guard = 0;
  while (cur.getTime() <= end.getTime() && guard < 400) {
    out.push(scheduleIsoDate(cur));
    cur = scheduleAddDays(cur, 1);
    guard += 1;
  }
  return out;
}

const STRINGS = {
  en: { 'schedule.card.dayProgress': 'Day {day} of {total}' },
  es: { 'schedule.card.dayProgress': 'Día {day} de {total}' },
  it: { 'schedule.card.dayProgress': 'Giorno {day} di {total}' },
};
let locale = 'en';
function t(key, vars) {
  const pack = STRINGS[locale] || STRINGS.en;
  let text = (pack && pack[key]) || (STRINGS.en && STRINGS.en[key]) || key;
  if (vars && typeof vars === 'object') {
    Object.keys(vars).forEach((k) => {
      text = String(text).split('{' + k + '}').join(String(vars[k]));
    });
  }
  return text;
}
function portalT(key) { return t(key); }
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Day progress unit cases ──────────────────────────────────────────────
const dayCtx = {
  console,
  t,
  portalT,
  escHtml,
  scheduleActiveDayIso: () => '2026-07-16',
  scheduleEnumerateDates,
  scheduleParseIso,
  scheduleAddDays,
  scheduleIsoDate,
  scheduleGroupBoardsNeeded: () => 0,
  scheduleGroupWetsuitsNeeded: () => 0,
  scheduleGroupHasPrivateLesson: () => false,
  scheduleGroupHasLesson: () => true,
  scheduleGroupHasCourse: () => false,
  scheduleGroupComponentQty: () => 1,
  scheduleRowSourceKind: () => 'staff',
  scheduleRowSourceAriaLabel: () => 'Staff booking',
  scheduleRenderStatusBadgeHtml: () => '<span class="portal-schedule-status is-paid">Paid</span>',
  scheduleEnsureRowId: (g) => { if (g && !g._scheduleId) g._scheduleId = 'row-1'; return g; },
};
vm.createContext(dayCtx);
vm.runInContext(dayOpsSrc, dayCtx);

const multi12 = {
  guest_name: 'Ada',
  service_date: '2026-07-15',
  service_dates: ['2026-07-15', '2026-07-16'],
  payment_status: 'paid',
  _scheduleId: 'bk-a',
};
assert('day 1 of 2', (() => {
  const p = dayCtx.scheduleBookingDayProgress('2026-07-15', multi12);
  return p && p.day === 1 && p.total === 2;
})());
assert('day 2 of 2', (() => {
  const p = dayCtx.scheduleBookingDayProgress('2026-07-16', multi12);
  return p && p.day === 2 && p.total === 2;
})());

const multi34 = {
  guest_name: 'Bea',
  service_date: '2026-07-17',
  date_from: '2026-07-15',
  date_to: '2026-07-18',
  duration_days: 99, // must not override inclusive span
  _scheduleId: 'bk-b',
};
assert('day 3 of 4 inclusive', (() => {
  const p = dayCtx.scheduleBookingDayProgress('2026-07-17', multi34);
  return p && p.day === 3 && p.total === 4;
})());
assert('day 4 of 4 inclusive', (() => {
  const p = dayCtx.scheduleBookingDayProgress('2026-07-18', multi34);
  return p && p.day === 4 && p.total === 4;
})());

const single = {
  guest_name: 'Cara',
  service_date: '2026-07-15',
  service_dates: ['2026-07-15'],
  _scheduleId: 'bk-c',
};
assert('single-day hidden', dayCtx.scheduleBookingDayProgress('2026-07-15', single) == null);

const outOfSpan = {
  guest_name: 'Deb',
  service_date: '2026-07-15',
  service_dates: ['2026-07-15', '2026-07-16'],
  _scheduleId: 'bk-d',
};
assert('out-of-span hidden', dayCtx.scheduleBookingDayProgress('2026-07-20', outOfSpan) == null);

const sparse = {
  guest_name: 'Eve',
  service_date: '2026-07-20',
  // explicit sparse dates authoritative over wider from/to + duration
  service_dates: ['2026-07-15', '2026-07-17', '2026-07-20'],
  date_from: '2026-07-15',
  date_to: '2026-07-20',
  duration_days: 6,
  records: [{
    service_date: '2026-07-20',
    metadata: { duration_days: 6, tier_key: '6_days' },
  }],
  _scheduleId: 'bk-e',
};
assert('explicit sparse authoritative total 3', (() => {
  const dates = dayCtx.scheduleCanonicalBookedServiceDates(sparse);
  return Array.isArray(dates) && dates.join(',') === '2026-07-15,2026-07-17,2026-07-20';
})());
assert('explicit sparse day 3 of 3', (() => {
  const p = dayCtx.scheduleBookingDayProgress('2026-07-20', sparse);
  return p && p.day === 3 && p.total === 3;
})());
assert('duration alone does not invent span', (() => {
  const onlyDur = {
    service_date: '2026-07-15',
    duration_days: 4,
    metadata: { tier_key: '4_days', duration_days: 4 },
  };
  const dates = dayCtx.scheduleCanonicalBookedServiceDates(onlyDur);
  return dates.length === 1 && dates[0] === '2026-07-15'
    && dayCtx.scheduleBookingDayProgress('2026-07-15', onlyDur) == null;
})());

const inclusiveOnly = {
  guest_name: 'Fay',
  date_from: '2026-03-01',
  date_to: '2026-03-02',
  service_date: '2026-03-01',
};
assert('inclusive fallback day 1 of 2', (() => {
  const p = dayCtx.scheduleBookingDayProgress('2026-03-01', inclusiveOnly);
  return p && p.day === 1 && p.total === 2;
})());

locale = 'en';
assert('EN label', dayCtx.scheduleBookingDayProgressLabel({ day: 1, total: 2 }) === 'Day 1 of 2');
locale = 'es';
assert('ES label', dayCtx.scheduleBookingDayProgressLabel({ day: 3, total: 4 }) === 'Día 3 de 4');
locale = 'it';
assert('IT label', dayCtx.scheduleBookingDayProgressLabel({ day: 2, total: 2 }) === 'Giorno 2 di 2');
locale = 'en';

// Active Today date is 2026-07-16 → Day 2 of 2 for multi12 span.
const rowHtml = dayCtx.scheduleRenderOpsBookingRow(Object.assign({}, multi12, {
  service_date: '2026-07-16',
  quantity: 1,
  components: { lesson: true },
}));
assert('DOM includes day progress pill', /data-ps-day-progress="1"/.test(rowHtml) && /Day 2 of 2/.test(rowHtml), rowHtml.slice(0, 280));
assert('DOM aria-label set', /aria-label="Day 2 of 2"/.test(rowHtml));

const singleHtml = dayCtx.scheduleRenderOpsBookingRow(Object.assign({}, single, {
  quantity: 1,
  components: { lesson: true },
}));
assert('DOM omits pill for single-day', !/data-ps-day-progress/.test(singleHtml));

// ── Previous navigation + refresh + stale guard ──────────────────────────
let today = '2026-03-01'; // month boundary + year-ish neighborhood
const dom = {
  'ps-range-label': { textContent: '' },
  'ps-state': { textContent: '', className: '', style: { display: '' } },
  'ps-today': {
    className: '',
    classList: { toggle() {} },
    dataset: {},
    addEventListener() {},
  },
  'ps-prev-week': { dataset: {}, addEventListener() {}, _fn: null },
  'ps-next-week': { dataset: {}, addEventListener() {}, _fn: null },
  'ps-refresh-schedule': { dataset: {}, addEventListener() {}, _fn: null },
};
const viewBtns = [];
let renderCalls = 0;
const renderSnaps = [];

const navCtx = {
  console,
  portalT: (k) => ({
    'schedule.view.today': 'Today',
    'schedule.view.next30': 'Next 30 days',
    'daySchedule.loading': 'Loading',
  }[k] || k),
  dsTodayIso: () => today,
  scheduleTodayIso: () => today,
  scheduleIsoDate,
  scheduleParseIso,
  scheduleAddDays,
  scheduleDaysFromToday(iso) {
    const t0 = scheduleParseIso(today);
    const d = scheduleParseIso(iso);
    return Math.round((d.getTime() - t0.getTime()) / 86400000);
  },
  scheduleFormatRangeLabel(start) {
    return scheduleIsoDate(start);
  },
  el: (id) => dom[id] || null,
  document: {
    querySelectorAll(sel) {
      if (sel === '.portal-schedule-view-btn') return viewBtns;
      return [];
    },
  },
  getClient: () => 'sunset',
  getPortalProfile: () => ({ is_surf_vertical: true, demo_mode: false }),
  renderScheduleSchoolContext() {},
  fetch: () => Promise.resolve({ ok: true, json: () => ({ rows: [], conversations: [] }) }),
  inboxClientQuery: () => '?client=sunset',
  sunsetLocationQuerySuffix: () => '&location_id=sunset-somo',
  scheduleFetchLessonTimesConfig: () => Promise.resolve([]),
  scheduleBuildLoadedViewModel: (_w, _c, _p, rangeStart, snap) => ({
    canonicalRows: [],
    rows: [],
    weekData: [],
    presentationOnlyRows: [],
    conversations: [],
    profile: _p,
    rangeStart,
    navSnapshot: snap,
  }),
  scheduleRenderLoadedViewModel(_vm, loadGen, snap) {
    renderCalls += 1;
    renderSnaps.push({
      loadGen,
      forwardOffset: snap && snap.forwardOffset,
      focusDateIso: snap && snap.focusDateIso,
      rangeLabel: dom['ps-range-label'].textContent,
    });
  },
};
vm.createContext(navCtx);
vm.runInContext(runtimeSrc, navCtx);
vm.runInContext(navSrc, navCtx);

function snap() { return navCtx.scheduleGetNavigationSnapshot(); }

assert('initial focus is today', snap().focusDateIso === '2026-03-01' && snap().forwardOffset === 0);

renderCalls = 0;
const genBeforePrev = navCtx.scheduleNavigationLoadGen();
const prevPromise = navCtx.scheduleNavigatePrev();
assert('prev moves exactly one local day', snap().forwardOffset === -1 && snap().focusDateIso === '2026-02-28');
assert('prev bumps load gen once', navCtx.scheduleNavigationLoadGen() === genBeforePrev + 1);
assert('prev applies header range once', dom['ps-range-label'].textContent === '2026-02-28');

// Month → previous month
today = '2026-03-01';
navCtx.scheduleNavigateToday();
navCtx.scheduleNavigatePrev();
assert('prev across month boundary', snap().focusDateIso === '2026-02-28');

// Year boundary
today = '2026-01-01';
navCtx.scheduleNavigateToday();
assert('year base today', snap().focusDateIso === '2026-01-01');
navCtx.scheduleNavigatePrev();
assert('prev across year boundary', snap().focusDateIso === '2025-12-31' && snap().forwardOffset === -1);

// DST-ish local calendar boundary (spring forward weekend neighborhood)
today = '2026-03-29'; // EU DST often last Sunday of March
navCtx.scheduleNavigateToday();
navCtx.scheduleNavigatePrev();
assert('prev across DST-ish boundary', snap().focusDateIso === '2026-03-28' && snap().forwardOffset === -1);
navCtx.scheduleNavigateNext();
assert('next unchanged back to today', snap().focusDateIso === '2026-03-29' && snap().forwardOffset === 0);
navCtx.scheduleNavigateNext();
assert('next still +1 day', snap().focusDateIso === '2026-03-30' && snap().forwardOffset === 1);
navCtx.scheduleNavigateToday();
assert('today reset unchanged', snap().forwardOffset === 0 && snap().focusDateIso === '2026-03-29');

// Wire once; double-wire must not duplicate listeners
today = '2026-07-15';
navCtx.scheduleNavigateToday();
dom['ps-prev-week'].dataset = {};
dom['ps-next-week'].dataset = {};
dom['ps-today'].dataset = {};
dom['ps-refresh-schedule'].dataset = {};
dom['ps-prev-week'].addEventListener = (_, fn) => { dom['ps-prev-week']._fn = fn; };
dom['ps-next-week'].addEventListener = (_, fn) => { dom['ps-next-week']._fn = fn; };
dom['ps-today'].addEventListener = (_, fn) => { dom['ps-today']._fn = fn; };
dom['ps-refresh-schedule'].addEventListener = (_, fn) => { dom['ps-refresh-schedule']._fn = fn; };
navCtx.scheduleWireScheduleNavigationControls();
navCtx.scheduleWireScheduleNavigationControls();
const genBeforeClick = navCtx.scheduleNavigationLoadGen();
dom['ps-prev-week']._fn();
assert('prev wired once (no duplicate listeners)', navCtx.scheduleNavigationLoadGen() === genBeforeClick + 1);
assert('wired prev focus yesterday', snap().focusDateIso === '2026-07-14');

// Stale request guard: older loadGen must not be active after a newer bump
const finalGen = navCtx.scheduleNavigationLoadGen();
assert('stale loadGen not active', navCtx.SunsetScheduleRuntime.load.isLoadActive(finalGen - 1) === false);
assert('current loadGen active', navCtx.SunsetScheduleRuntime.load.isLoadActive(finalGen) === true);

// Keep Next/Today semantics intact after prev
navCtx.scheduleNavigateToday();
const g0 = navCtx.scheduleNavigationLoadGen();
navCtx.scheduleNavigateNext();
assert('next still +1 after prev fix', snap().forwardOffset === 1 && navCtx.scheduleNavigationLoadGen() === g0 + 1);
navCtx.scheduleNavigateToday();
assert('today still resets', snap().forwardOffset === 0);

// One refresh path: await latest prev load and confirm single render for that gen
Promise.resolve(prevPromise).then(async () => {
  today = '2026-07-20';
  navCtx.scheduleNavigateToday();
  // drain prior load
  await Promise.resolve();
  renderCalls = 0;
  renderSnaps.length = 0;
  const before = navCtx.scheduleNavigationLoadGen();
  await navCtx.scheduleNavigatePrev();
  const after = navCtx.scheduleNavigationLoadGen();
  assert('prev one refresh gen step', after === before + 1);
  const forGen = renderSnaps.filter((r) => r.loadGen === after);
  assert('prev one card/header render for active gen', forGen.length === 1 && forGen[0].focusDateIso === '2026-07-19');
  // Stale: a superseded gen is rejected by isLoadActive
  assert('stale request guard after refresh', navCtx.SunsetScheduleRuntime.load.isLoadActive(before) === false);
}).then(() => {
  console.log(`\n── verify:staff-today-navigation-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  if (fail) process.exit(1);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
