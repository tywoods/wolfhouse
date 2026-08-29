'use strict';

/**
 * verify:sunset-create-booking-p2-price-pass
 *
 * Bug Finder sunset price pass (29 Aug) — create-booking P2 gates:
 *  1) Uncovered season nights shared with Create date picker / quote gate
 *  2) Private Lesson Admin € / duration shown in Create panel before submit
 *  3) Accommodation copy does not imply room inventory / occupancy capacity
 *  4) Create stays disabled while quote is checking (no double-click race)
 *
 * Run: node scripts/verify-sunset-create-booking-p2-price-pass.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const resolver = require('./lib/sunset-accommodation-price-resolver');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function extractNamedFn(src, name) {
  const needle = `function ${name}(`;
  const start = src.indexOf(needle);
  if (start < 0) return null;
  const braceStart = src.indexOf('{', start);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

const apiSrc = read('scripts/staff-query-api.js');
const portalSrc = read('scripts/browser/sunset-schedule-portal-module.js');
const adminUi = read('scripts/browser/sunset-admin-ui.js');
const i18nEn = read('scripts/lib/staff-portal-i18n.js');
const i18nEs = read('scripts/lib/staff-portal-i18n-es-sunset.js');

console.log('\nverify:sunset-create-booking-p2-price-pass\n');

// ── 1) Shared uncovered-night helpers ──────────────────────────────────────
console.log('[1] Uncovered season nights — shared set + Create gate');
ok('resolver exports enumerateUncoveredNightsFromGaps',
  typeof resolver.enumerateUncoveredNightsFromGaps === 'function');
ok('resolver exports isAccommodationNightUncovered',
  typeof resolver.isAccommodationNightUncovered === 'function');

const gapNights = resolver.enumerateUncoveredNightsFromGaps([
  { gap_start: '2026-04-30', gap_end: '2026-05-01' },
  { gap_start: '2026-05-31', gap_end: '2026-06-01' },
  { gap_start: '2026-09-30', gap_end: '2026-10-01' },
  { gap_start: '2026-10-31', gap_end: '2026-11-01' },
]);
ok('gap expand yields Admin warning nights',
  gapNights.join(',') === '2026-04-30,2026-05-31,2026-09-30,2026-10-31',
  gapNights.join(','));

const ranges = [
  { title: 'Spring', check_in: '2026-03-01', check_out: '2026-04-30', amount_cents: 5000 },
  { title: 'May', check_in: '2026-05-01', check_out: '2026-05-31', amount_cents: 6000 },
  { title: 'Summer', check_in: '2026-06-01', check_out: '2026-09-30', amount_cents: 8000 },
  { title: 'Oct', check_in: '2026-10-01', check_out: '2026-10-31', amount_cents: 5500 },
  { title: 'Late', check_in: '2026-11-01', check_out: '2026-12-01', amount_cents: 4500 },
];
const adminGaps = resolver.findAccommodationCoverageGaps(ranges);
ok('Admin gaps match Apr/May/Sep/Oct boundary nights',
  adminGaps.length === 4
  && adminGaps[0].gap_start === '2026-04-30'
  && adminGaps[1].gap_start === '2026-05-31'
  && adminGaps[2].gap_start === '2026-09-30'
  && adminGaps[3].gap_start === '2026-10-31',
  JSON.stringify(adminGaps));
ok('30 Apr uncovered', resolver.isAccommodationNightUncovered(ranges, '2026-04-30') === true);
ok('29 Apr covered', resolver.isAccommodationNightUncovered(ranges, '2026-04-29') === false);
ok('1 May covered', resolver.isAccommodationNightUncovered(ranges, '2026-05-01') === false);
ok('0-cent covering range is uncovered',
  resolver.isAccommodationNightUncovered(
    [{ title: 'Zero', check_in: '2026-03-01', check_out: '2026-04-01', amount_cents: 0 }],
    '2026-03-15',
  ) === true);

ok('Create calendar marks is-uncovered',
  /is-uncovered/.test(extractNamedFn(apiSrc, 'scheduleRenderCreateAccomDateRangeCalendar') || ''));
ok('Create Apply blocks uncovered occupied nights',
  /scheduleAccommodationUncoveredNightsInStay/.test(extractNamedFn(apiSrc, 'scheduleApplyCreateAccomDateRangeDraft') || '')
  && /scheduleSyncCreateAccomUncoveredWarning/.test(extractNamedFn(apiSrc, 'scheduleApplyCreateAccomDateRangeDraft') || ''));
ok('Create date-range UI sync keeps Apply blocked on uncovered nights',
  /scheduleAccommodationUncoveredNightsInStay/.test(extractNamedFn(apiSrc, 'scheduleSyncCreateAccomDateRangeUi') || '')
  && /uncoveredBlocked/.test(extractNamedFn(apiSrc, 'scheduleSyncCreateAccomDateRangeUi') || ''));
ok('Uncovered warning uses uncovered-warn class (not past-date danger)',
  /id="ps-create-accommodation-uncovered-warn"[^>]*portal-schedule-create-date-range-uncovered-warn/.test(apiSrc)
  && !/id="ps-create-accommodation-uncovered-warn"[^>]*portal-schedule-create-date-range-past-warn/.test(apiSrc));
ok('Create Save blocks uncovered stays',
  /scheduleAccommodationUncoveredNightsInStay/.test(extractNamedFn(apiSrc, 'scheduleSaveCreateAccommodation') || ''));
ok('Create caches Admin ranges from config',
  /scheduleSetAccommodationRangesCache/.test(apiSrc)
  && /data\.accommodation\.ranges/.test(apiSrc));
ok('Quote failure maps accommodation_uncovered_nights',
  /accommodation_uncovered_nights/.test(extractNamedFn(portalSrc, 'schedulePortalQuoteFailureMessage') || ''));
ok('Soft validate blocks uncovered accommodation',
  /schedule\.create\.accommodation\.uncoveredNights/.test(
    extractNamedFn(portalSrc, 'schedulePortalValidateCreatePayload') || '',
  ));
ok('i18n uncovered + Admin coverageGap EN/ES',
  /'schedule\.create\.accommodation\.uncoveredNights'/.test(i18nEn)
  && /'schedule\.create\.accommodation\.uncoveredNights'/.test(i18nEs)
  && /'admin\.accommodation\.coverageGap'/.test(i18nEn));

// Sandbox Create uncovered helpers against Apr gap
(function sandboxAccomGate() {
  const body = [
    extractNamedFn(apiSrc, 'scheduleAddIsoDays'),
    extractNamedFn(apiSrc, 'scheduleFindAccommodationCoverageGaps'),
    extractNamedFn(apiSrc, 'scheduleAccommodationRangeCoversNight'),
    extractNamedFn(apiSrc, 'scheduleAccommodationNightUncovered'),
    extractNamedFn(apiSrc, 'scheduleAccommodationUncoveredNightsInStay'),
    extractNamedFn(apiSrc, 'scheduleAccommodationUncoveredWarningMessage'),
  ].filter(Boolean).map((s) => String(s).replace(/\\\\/g, '\\')).join('\n');

  // eslint-disable-next-line no-new-func
  const run = new Function(
    'portalT',
    `${body}
    var scheduleAccommodationRangesCache = ${JSON.stringify(ranges)};
    var scheduleCreateDateRangeIsValidIso = function(iso){
      return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(iso || '').slice(0, 10));
    };
    var scheduleCreateDateRangeFormatShort = function(iso){
      var s = String(iso || '').slice(0, 10);
      if (s === '2026-04-30') return '30 Apr';
      if (s === '2026-04-29') return '29 Apr';
      return s;
    };
    return {
      uncovered: scheduleAccommodationUncoveredNightsInStay,
      night: scheduleAccommodationNightUncovered,
      warn: scheduleAccommodationUncoveredWarningMessage,
      gaps: scheduleFindAccommodationCoverageGaps,
    };`,
  );
  const api = run((k) => {
    if (k === 'schedule.create.accommodation.uncoveredNights'
      || k === 'admin.accommodation.coverageGap') {
      return 'Some dates have no seasonal price: {gaps}. Stays including these nights cannot be quoted.';
    }
    return k;
  });
  ok('Create stay Apr29→May1 includes uncovered Apr30',
    api.uncovered('2026-04-29', '2026-05-01').join(',') === '2026-04-30');
  ok('Create stay Apr28→Apr30 has no uncovered nights',
    api.uncovered('2026-04-28', '2026-04-30').length === 0);
  ok('Create warning uses Admin coverageGap template',
    /30 Apr/.test(api.warn(['2026-04-30']))
    && /cannot be quoted/.test(api.warn(['2026-04-30'])));
  ok('Create gap finder matches resolver',
    api.gaps(ranges).length === 4
    && api.gaps(ranges)[0].gap_start === '2026-04-30');
}());

(function sandboxApplyStaysDisabledAfterUiSync() {
  const body = [
    extractNamedFn(apiSrc, 'scheduleAddIsoDays'),
    extractNamedFn(apiSrc, 'scheduleAccommodationRangeCoversNight'),
    extractNamedFn(apiSrc, 'scheduleAccommodationNightUncovered'),
    extractNamedFn(apiSrc, 'scheduleAccommodationUncoveredNightsInStay'),
    extractNamedFn(apiSrc, 'scheduleSyncCreateAccomDateRangeUi'),
  ].filter(Boolean).map((s) => String(s).replace(/\\\\/g, '\\')).join('\n');
  const nodes = {
    'ps-create-accommodation-check-in': { value: '2026-04-29' },
    'ps-create-accommodation-check-out': { value: '2026-05-01' },
    'ps-create-accommodation-date-range-display': { textContent: '' },
    'ps-create-accommodation-date-range-apply': { disabled: false },
  };
  // eslint-disable-next-line no-new-func
  const run = new Function(
    'el',
    `var scheduleAccommodationRangesCache = ${JSON.stringify(ranges)};
    var scheduleCreateAccomDateRangeDraft = { start: '2026-04-29', end: '2026-05-01' };
    var scheduleCreateDateRangeIsValidIso = function(iso){
      return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(iso || '').slice(0, 10));
    };
    function scheduleCreateAccommodationDisplayText(from, to){ return from + ' – ' + to; }
    function scheduleCreateDateRangeDraftReady(draft){ return !!(draft && draft.start); }
    function scheduleCreateDateRangeSyncPastWarning(){}
    ${body}
    scheduleSyncCreateAccomDateRangeUi();
    return el('ps-create-accommodation-date-range-apply').disabled;`,
  );
  ok('UI sync leaves Apply disabled for Apr29→May1 uncovered stay',
    run((id) => nodes[id]) === true);
}());

// ── 2) Private Lesson catalog price in Create panel ────────────────────────
console.log('\n[2] Private Lesson € / duration in Create panel');
ok('Create HTML has private catalog meta host',
  /id="ps-create-private-catalog-meta"/.test(apiSrc)
  && /data-testid="ps-create-private-catalog-meta"/.test(apiSrc));
ok('Caches private amount_cents from Admin config',
  /scheduleSetPrivateLessonCatalogCache/.test(apiSrc)
  && /schedulePrivateLessonAmountCentsCache/.test(apiSrc));
ok('Missing private catalog clears painted meta',
  /scheduleRenderPrivateLessonCatalogMeta/.test(
    extractNamedFn(apiSrc, 'scheduleSetPrivateLessonCatalogCache') || '',
  ));
ok('Renders catalog meta from Admin cents+duration',
  /scheduleRenderPrivateLessonCatalogMeta/.test(apiSrc)
  && /catalogPrice/.test(extractNamedFn(apiSrc, 'scheduleRenderPrivateLessonCatalogMeta') || ''));
ok('Enter private drilldown paints catalog meta',
  /scheduleRenderPrivateLessonCatalogMeta/.test(
    extractNamedFn(portalSrc, 'schedulePortalEnterPrivateSessionsDrilldown') || '',
  ));
ok('Quote preview paints private catalog line',
  /private-catalog/.test(extractNamedFn(portalSrc, 'schedulePortalRenderCreateQuotePreview') || '')
  || /privateLesson\.catalogPrice/.test(
    extractNamedFn(portalSrc, 'schedulePortalRenderCreateQuotePreview') || '',
  ));
ok('Intent summary includes private catalog price',
  /schedulePrivateLessonAmountCentsCache/.test(
    extractNamedFn(portalSrc, 'schedulePortalRenderCreateIntentSummary') || '',
  ));
ok('i18n private catalogPrice EN/ES',
  /'schedule\.create\.privateLesson\.catalogPrice'/.test(i18nEn)
  && /'schedule\.create\.privateLesson\.catalogPrice'/.test(i18nEs));

(function sandboxPrivateMeta() {
  const fn = extractNamedFn(apiSrc, 'scheduleRenderPrivateLessonCatalogMeta');
  ok('extracted private meta renderer', !!fn && fn.length > 40);
  const nodes = {};
  nodes['ps-create-private-catalog-meta'] = {
    textContent: '',
    style: { display: 'none' },
    setAttribute() {},
    removeAttribute() {},
  };
  // eslint-disable-next-line no-new-func
  const run = new Function(
    'el', 'portalT', 'scheduleFormatCentsMoney',
    'schedulePrivateLessonAmountCentsCache', 'schedulePrivateLessonDurationCache',
    `${String(fn).replace(/\\\\/g, '\\')}
    scheduleRenderPrivateLessonCatalogMeta();
    return el('ps-create-private-catalog-meta');`,
  );
  const meta = run(
    (id) => nodes[id],
    (k) => (k === 'schedule.create.privateLesson.catalogPrice'
      ? '{price} / session · {duration} min' : k),
    (c) => `€${(Number(c) / 100).toFixed(2)}`,
    6000,
    120,
  );
  ok('private panel shows €60.00 / session · 120 min',
    meta.textContent === '€60.00 / session · 120 min'
    && meta.style.display !== 'none',
    meta.textContent);
}());

// ── 3) No invented room inventory / capacity implication ───────────────────
console.log('\n[3] Accommodation does not imply room capacity');
ok('Admin noRoomInventory note rendered',
  /admin-accommodation-no-room-inventory/.test(adminUi)
  && /noRoomInventory/.test(adminUi));
ok('Create serverPriced copy denies room/occupancy',
  /no room type, bed assignment, or occupancy capacity/i.test(
    i18nEn.match(/'schedule\.create\.accommodation\.serverPriced': '([^']+)'/)?.[1] || '',
  ));
ok('Admin help denies room inventory',
  /No room type, bed assignment, or occupancy capacity/i.test(
    i18nEn.match(/'admin\.accommodation\.help': '([^']+)'/)?.[1] || '',
  ));
ok('ES serverPriced updated',
  /sin tipo de habitación/i.test(
    i18nEs.match(/'schedule\.create\.accommodation\.serverPriced': '([^']+)'/)?.[1] || '',
  ));
ok('Create does not invent room_type picker',
  !/ps-create-accommodation-room/.test(apiSrc)
  && !/invent.*room/i.test(extractNamedFn(apiSrc, 'scheduleSaveCreateAccommodation') || ''));

// ── 4) Quote-idle Create gate (double-click race) ──────────────────────────
console.log('\n[4] Create disabled until quote idle');
ok('schedulePortalQuoteChecking flag present',
  /var schedulePortalQuoteChecking = false/.test(portalSrc));
ok('ShowQuoteChecking sets checking + syncs submit',
  /schedulePortalQuoteChecking = true/.test(extractNamedFn(portalSrc, 'schedulePortalShowQuoteChecking') || '')
  && /schedulePortalSyncCreateSubmitEnabled/.test(
    extractNamedFn(portalSrc, 'schedulePortalShowQuoteChecking') || '',
  ));
ok('RenderCreateQuotePreview clears checking when settled',
  /schedulePortalQuoteChecking = false/.test(
    extractNamedFn(portalSrc, 'schedulePortalRenderCreateQuotePreview') || '',
  ));
ok('SyncCreateSubmitEnabled blocks while quoteBusy',
  /schedulePortalQuoteChecking/.test(extractNamedFn(portalSrc, 'schedulePortalSyncCreateSubmitEnabled') || '')
  && /schedulePortalQuoteTimer/.test(extractNamedFn(portalSrc, 'schedulePortalSyncCreateSubmitEnabled') || ''));
ok('Submit claims lock before quote paint',
  /Claim submit lock before any quote paint/.test(portalSrc)
  || /schedulePortalSubmitInFlight = true;\n  schedulePortalQuoteChecking = false/.test(portalSrc));

(function sandboxQuoteIdle() {
  const syncFn = extractNamedFn(portalSrc, 'schedulePortalSyncCreateSubmitEnabled');
  const nodes = {
    'ps-create-submit': { disabled: false, setAttribute() {}, removeAttribute() {} },
    'ps-create-guest': { value: 'Ada' },
    'ps-create-phone': { value: '+34600111222' },
    'ps-create-comp-course': { checked: false },
    'ps-create-surfers': { value: '1' },
    'ps-create-date-from': { value: '2026-08-10' },
    'ps-create-date-to': { value: '2026-08-10' },
  };
  // eslint-disable-next-line no-new-func
  const run = new Function(
    'el',
    `var schedulePortalSubmitInFlight = false;
    var schedulePortalQuotePriceBlocked = false;
    var schedulePortalQuoteChecking = true;
    var schedulePortalQuoteTimer = null;
    var SCHEDULE_CREATE_GUEST_MAX = 24;
    function schedulePortalIsValidCreatePhone(){ return true; }
    function schedulePortalGetSelectedCreateCourseId(){ return null; }
    function schedulePortalCanonicalDateIso(v){ return String(v||'').slice(0,10); }
    function schedulePortalMadridTodayIso(){ return '2026-08-01'; }
    ${String(syncFn).replace(/\\\\/g, '\\')}
    schedulePortalSyncCreateSubmitEnabled();
    var mid = el('ps-create-submit').disabled;
    schedulePortalQuoteChecking = false;
    schedulePortalSyncCreateSubmitEnabled();
    var idle = el('ps-create-submit').disabled;
    return { mid: mid, idle: idle };`,
  );
  const r = run((id) => nodes[id]);
  ok('Create disabled while Checking price', r.mid === true);
  ok('Create enabled when quote idle + guest ok', r.idle === false);
}());

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
console.log('PASS verify-sunset-create-booking-p2-price-pass');
