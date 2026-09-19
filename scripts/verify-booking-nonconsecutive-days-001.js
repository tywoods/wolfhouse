'use strict';

/**
 * BOOKING-NONCONSECUTIVE-DAYS-001
 *
 * Create + Edit service calendars: consecutive range, then tap days off.
 * Remaining selected days own quote / invoice / schedule / rental duration.
 * Accommodation stays on the consecutive range picker.
 *
 * Run: node scripts/verify-booking-nonconsecutive-days-001.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
const editSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-edit-ui.js'), 'utf8');
const writes = require('./lib/sunset-schedule-booking-writes');
const { collectPortalFunctions } = require('./lib/portal-fn-slice');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log('  PASS  ' + label);
    pass += 1;
  } else {
    console.error('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
    fail += 1;
  }
}

function extractFn(src, name) {
  const n = 'function ' + name + '(';
  const start = src.indexOf(n);
  if (start < 0) return null;
  const brace = src.indexOf('{', start);
  let d = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') d += 1;
    else if (src[i] === '}') {
      d -= 1;
      if (d === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

console.log('\nverify:booking-nonconsecutive-days-001\n');

console.log('[1] Owners present (Create helpers + Edit + portal + server)');
[
  'scheduleCreateServiceDatesSelectDay',
  'scheduleCreateServiceDatesFillRange',
  'scheduleCreateServiceDatesNormalizeSelected',
  'scheduleCreateServiceDatesDraftReady',
  'scheduleCreateServiceDatesCommittedBounds',
  'scheduleCreateServiceDatesParseHidden',
  'scheduleCreateServiceDatesWriteHidden',
].forEach((name) => {
  assert('api owns ' + name, !!extractFn(apiSrc, name));
});
assert('Create wire uses ServiceDatesSelectDay',
  /scheduleCreateServiceDatesSelectDay\(scheduleCreateDateRangeDraft/.test(apiSrc));
assert('Create hidden service_dates field',
  /id="ps-create-service-dates"/.test(apiSrc));
assert('Create payload includes service_dates',
  /service_dates:\s*selectedDates/.test(extractFn(apiSrc, 'scheduleReadCreatePayload') || ''));
assert('Edit hidden service_dates field',
  /id="ps-drawer-service-dates"/.test(editSrc));
assert('Edit wire uses ServiceDatesSelectDay',
  /scheduleCreateServiceDatesSelectDay/.test(editSrc));
assert('Edit payload includes service_dates',
  /service_dates:\s*selectedDates/.test(extractFn(editSrc, 'scheduleReadDrawerEditPayload') || ''));
assert('Accommodation still uses consecutive SelectDay',
  /ps-drawer-accommodation-date-range[\s\S]*scheduleCreateDateRangeSelectDay/.test(editSrc)
  || /scheduleCreateDateRangeSelectDay\s*\?\s*scheduleCreateDateRangeSelectDay\s*:\s*null/.test(editSrc));
assert('portal ServiceDatesFromPayload prefers exact array',
  /payload\.service_dates/.test(extractFn(portalSrc, 'schedulePortalServiceDatesFromPayload') || ''));
assert('portal quote fingerprint includes service_dates',
  /service_dates:\s*schedulePortalServiceDatesFromPayload/.test(
    extractFn(portalSrc, 'schedulePortalQuotePricingIntentKey') || '',
  ));
assert('course tier accepts dayCount override',
  /opts\.dayCount/.test(extractFn(portalSrc, 'schedulePortalResolveDerivedCourseTier') || ''));
assert('server duration from selected count',
  typeof writes.rentalDurationKeyFromSelectedDayCount === 'function'
  && writes.rentalDurationKeyFromSelectedDayCount(3) === '3_days'
  && writes.rentalDurationKeyFromSelectedDayCount(1) === '1_day');
assert('deselected CSS present',
  /\.is-deselected/.test(apiSrc));

console.log('[2] Pure select: range then toggle off');
{
  const names = [
    'scheduleCreateServiceDatesFillRange',
    'scheduleCreateServiceDatesNormalizeSelected',
    'scheduleCreateServiceDatesSelectDay',
    'scheduleCreateServiceDatesDraftReady',
    'scheduleCreateServiceDatesCommittedBounds',
  ];
  const sandbox = {
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    RegExp,
    JSON,
    scheduleTodayIso: () => '2026-09-01',
    scheduleCreateDateRangeIsValidIso(iso) {
      iso = String(iso || '').slice(0, 10);
      return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(iso);
    },
    scheduleCreateDateRangeIsPastIso() { return false; },
    scheduleCreateDateRangeMinIso() { return '2026-01-01'; },
    scheduleCreateDateRangeDraftHasPast() { return false; },
    scheduleEnumerateDates(from, to) {
      const out = [];
      let cur = String(from).slice(0, 10);
      const endIso = String(to).slice(0, 10);
      let g = 0;
      while (cur <= endIso && g < 40) {
        out.push(cur);
        const d = new Date(cur + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() + 1);
        cur = d.toISOString().slice(0, 10);
        g += 1;
      }
      return out;
    },
    scheduleParseIso(iso) {
      const s = String(iso).slice(0, 10);
      const [y, m, d] = s.split('-').map(Number);
      return new Date(y, m - 1, d);
    },
    scheduleIsoDate(d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + day;
    },
    scheduleAddDays(d, n) {
      const x = new Date(d.getTime());
      x.setDate(x.getDate() + n);
      return x;
    },
  };
  const sliced = collectPortalFunctions(apiSrc, names, { provided: Object.keys(sandbox) });
  assert('service-date helpers slice clean',
    sliced.missing.length === 0 && sliced.unparsable.length === 0,
    `missing=${(sliced.missing || []).join(',')} unparsable=${(sliced.unparsable || []).join(',')}`);
  const expose = sliced.resolved.map((n) => `this.${n}=${n};`).join('\n');
  vm.createContext(sandbox);
  vm.runInContext(`${sliced.code}\n${expose}`, sandbox);

  let st = sandbox.scheduleCreateServiceDatesSelectDay({}, '2026-09-10');
  assert('first tap starts range', st.start === '2026-09-10' && !st.end
    && st.selected.join(',') === '2026-09-10');
  st = sandbox.scheduleCreateServiceDatesSelectDay(st, '2026-09-14');
  assert('second tap fills Mon–Fri',
    st.start === '2026-09-10' && st.end === '2026-09-14'
    && st.selected.join(',') === '2026-09-10,2026-09-11,2026-09-12,2026-09-13,2026-09-14');
  st = sandbox.scheduleCreateServiceDatesSelectDay(st, '2026-09-12');
  assert('tap middle day off leaves gap',
    st.selected.join(',') === '2026-09-10,2026-09-11,2026-09-13,2026-09-14'
    && st.start === '2026-09-10' && st.end === '2026-09-14');
  st = sandbox.scheduleCreateServiceDatesSelectDay(st, '2026-09-12');
  assert('tap gap day back on restores it',
    st.selected.join(',') === '2026-09-10,2026-09-11,2026-09-12,2026-09-13,2026-09-14');
  st = sandbox.scheduleCreateServiceDatesSelectDay(st, '2026-09-12');
  st = sandbox.scheduleCreateServiceDatesSelectDay(st, '2026-09-11');
  st = sandbox.scheduleCreateServiceDatesSelectDay(st, '2026-09-13');
  assert('multiple days off leave sparse set',
    st.selected.join(',') === '2026-09-10,2026-09-14');
  st = sandbox.scheduleCreateServiceDatesSelectDay(st, '2026-09-10');
  assert('can remove down to one selected day',
    st.selected.join(',') === '2026-09-14');
  const lastOnly = st.selected.slice();
  st = sandbox.scheduleCreateServiceDatesSelectDay(st, '2026-09-14');
  assert('cannot remove last selected day',
    st.selected.join(',') === lastOnly.join(','));
  st = sandbox.scheduleCreateServiceDatesSelectDay(st, '2026-09-20');
  assert('tap outside span restarts',
    st.start === '2026-09-20' && !st.end && st.selected.join(',') === '2026-09-20');
  assert('draft ready with selected',
    sandbox.scheduleCreateServiceDatesDraftReady({
      start: '2026-09-10', end: '2026-09-14', selected: ['2026-09-10', '2026-09-14'],
    }));
  const bounds = sandbox.scheduleCreateServiceDatesCommittedBounds(
    ['2026-09-14', '2026-09-10', '2026-09-12'],
  );
  assert('committed bounds = min/max selected',
    bounds.from === '2026-09-10' && bounds.to === '2026-09-14'
    && bounds.selected.join(',') === '2026-09-10,2026-09-12,2026-09-14');
}

console.log('[3] Consecutive SelectDay unchanged (accommodation / finance)');
{
  const fn = extractFn(apiSrc, 'scheduleCreateDateRangeSelectDay');
  assert('SelectDay still restarts after complete range',
    /if\s*\(\s*!start\s*\|\|\s*\(start\s*&&\s*end\)\s*\)\s*return\s*\{\s*start:\s*iso,\s*end:\s*null\s*\}/.test(fn)
    || /Restart after a complete range/.test(fn));
  assert('SelectDay has no selected array', !/selected/.test(fn));
}

console.log('[4] Rental duration = selected count, not span');
assert('3 selected days → 3_days (not 5-day span)',
  writes.rentalDurationKeyFromSelectedDayCount(3) === '3_days');
assert('span helper still contiguous for accom-style ranges',
  writes.rentalDurationKeyFromDateRange('2026-09-10', '2026-09-14') === '5_days');
{
  const prep = writes.prepareCanonicalRentalsForCreate({
    date_from: '2026-09-10',
    date_to: '2026-09-14',
    service_dates: ['2026-09-10', '2026-09-12', '2026-09-14'],
    rentals: [{ offering_key: 'board_rental', duration_key: '3_days', quantity: 1 }],
    components: { course: { course_id: 'c1', quantity: 1, tier_key: '3_days' } },
    surfer_count: 1,
  });
  assert('canonical prep accepts sparse service_dates', prep.ok === true, prep.error || prep.reason);
  assert('canonical prep keeps exact sparse dates',
    prep.ok && prep.body.service_dates.join(',') === '2026-09-10,2026-09-12,2026-09-14');
  assert('canonical prep rejects wrong duration for count',
    writes.prepareCanonicalRentalsForCreate({
      date_from: '2026-09-10',
      date_to: '2026-09-14',
      service_dates: ['2026-09-10', '2026-09-12', '2026-09-14'],
      rentals: [{ offering_key: 'board_rental', duration_key: '5_days', quantity: 1 }],
      components: { course: { course_id: 'c1', quantity: 1, tier_key: '3_days' } },
      surfer_count: 1,
    }).ok === false);
}

console.log('[5] Quote fingerprint changes on same-count date swap');
{
  const names = [
    'schedulePortalNormalizeLessonsIntent',
    'schedulePortalNormalizeRentalsIntent',
    'schedulePortalNormalizeCourseEquipmentIntent',
    'schedulePortalNormalizeAccommodationIntent',
    'schedulePortalServiceDatesFromPayload',
    'schedulePortalQuotePricingIntentKey',
  ];
  const sandbox = {
    console,
    JSON,
    String,
    Number,
    Array,
    Object,
    Math,
    getSunsetLocation: () => 'sunset-somo',
    scheduleEnumerateDates: (a, b) => {
      const out = [];
      let cur = String(a).slice(0, 10);
      const endIso = String(b).slice(0, 10);
      let g = 0;
      while (cur <= endIso && g < 40) {
        out.push(cur);
        const d = new Date(cur + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() + 1);
        cur = d.toISOString().slice(0, 10);
        g += 1;
      }
      return out;
    },
  };
  const sliced = collectPortalFunctions(portalSrc, names, { provided: Object.keys(sandbox) });
  assert('quote intent helpers slice clean',
    sliced.missing.length === 0 && sliced.unparsable.length === 0,
    `missing=${(sliced.missing || []).join(',')}`);
  const expose = sliced.resolved.map((n) => `this.${n}=${n};`).join('\n');
  vm.createContext(sandbox);
  vm.runInContext(`${sliced.code}\n${expose}`, sandbox);
  const a = sandbox.schedulePortalQuotePricingIntentKey({
    date_from: '2026-09-10',
    date_to: '2026-09-14',
    service_dates: ['2026-09-10', '2026-09-12'],
    components: {},
    rentals: [],
  });
  const b = sandbox.schedulePortalQuotePricingIntentKey({
    date_from: '2026-09-10',
    date_to: '2026-09-14',
    service_dates: ['2026-09-11', '2026-09-13'],
    components: {},
    rentals: [],
  });
  const c = sandbox.schedulePortalQuotePricingIntentKey({
    date_from: '2026-09-10',
    date_to: '2026-09-14',
    service_dates: ['2026-09-10', '2026-09-12'],
    components: {},
    rentals: [],
  });
  assert('same-count different dates → different intent key', a !== b);
  assert('identical selected dates → same intent key', a === c);
  assert('ServiceDatesFromPayload returns sparse exact list',
    sandbox.schedulePortalServiceDatesFromPayload({
      date_from: '2026-09-10',
      date_to: '2026-09-14',
      service_dates: ['2026-09-14', '2026-09-10'],
    }).join(',') === '2026-09-10,2026-09-14');
}

console.log('[6] Create selectedDates prefers hidden sparse list');
{
  const fn = extractFn(apiSrc, 'scheduleCreateSelectedDates');
  assert('CreateSelectedDates reads ps-create-service-dates',
    /ps-create-service-dates/.test(fn) && /scheduleCreateServiceDatesParseHidden/.test(fn));
  assert('Apply writes hidden service dates',
    /scheduleCreateServiceDatesWriteHidden/.test(extractFn(apiSrc, 'scheduleApplyCreateDateRangeDraft') || ''));
  assert('Edit Apply writes hidden service dates',
    /ps-drawer-service-dates/.test(extractFn(editSrc, 'scheduleApplyDrawerDateRangeDraft') || ''));
  assert('Edit seed restores selected from hidden',
    /scheduleCreateServiceDatesParseHidden/.test(extractFn(editSrc, 'scheduleDrawerDateRangeSeedDraft') || ''));
}

console.log('\n────────────────────────────────────────────────');
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:booking-nonconsecutive-days-001 — FAILED\n');
  process.exit(1);
}
console.log('verify:booking-nonconsecutive-days-001 — ALL CHECKS PASSED\n');
process.exit(0);
