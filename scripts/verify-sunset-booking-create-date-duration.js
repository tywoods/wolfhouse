'use strict';
/* verify:sunset-booking-create-date-duration — catalog duration_days date-driven Group create */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
const bookable = require('./lib/sunset-bookable-offerings');
let pass = 0, fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); pass += 1; }
  else { console.error('  FAIL  ' + label + (detail ? ' — ' + detail : '')); fail += 1; }
}
function extractModal(src) {
  const s = src.indexOf('id="ps-create-modal"'); if (s < 0) return '';
  const o = src.lastIndexOf('<div', s), e = src.indexOf('id="ps-drawer-backdrop"', o), c = src.lastIndexOf('</div>', e);
  return src.slice(o, c > o ? c + 6 : e);
}
function extractFn(src, name) {
  const n = 'function ' + name + '(', start = src.indexOf(n); if (start < 0) return null;
  const brace = src.indexOf('{', start); let d = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') d += 1; else if (src[i] === '}') { d -= 1; if (d === 0) return src.slice(start, i + 1); }
  }
  return null;
}
function idOrder(html, id) { return html.indexOf('id="' + id + '"'); }
function listen(node) {
  node._ls = node._ls || {};
  node.addEventListener = function (ev, fn) { (this._ls[ev] = this._ls[ev] || []).push(fn); };
  node.dispatchEvent = function (ev) { (this._ls[ev && ev.type] || []).forEach((fn) => fn.call(this, ev)); };
  return node;
}
/** Real DEFAULT/ADMIN schema: weeks + single_class + day keys. */
function realTiers(extra) {
  const base = [
    { key: '1_week', label: '1 week', duration_days: 7, bookable: true, offering_id: 'surf_pack_c1__1_week' },
    { key: '2_weeks', label: '2 weeks', duration_days: 14, bookable: true, offering_id: 'surf_pack_c1__2_weeks' },
    { key: '3_weeks', label: '3 weeks', duration_days: 21, bookable: true, offering_id: 'surf_pack_c1__3_weeks' },
    { key: '4_weeks', label: '4 weeks', duration_days: 28, bookable: true, offering_id: 'surf_pack_c1__4_weeks' },
    { key: 'single_class', label: 'Single class', duration_days: 1, bookable: true, offering_id: 'surf_pack_c1__single_class' },
    { key: '3_days', label: '3 days', duration_days: 3, bookable: true, offering_id: 'surf_pack_c1__3_days' },
    { key: '5_days', label: '5 days', duration_days: 5, bookable: false, offering_id: 'surf_pack_c1__5_days' },
  ];
  return extra ? base.concat(extra) : base;
}
console.log('\nverify:sunset-booking-create-date-duration\n');
const modal = extractModal(apiSrc);
console.log('[1] Order + hidden duration + i18n + schema');
assert('order Name→Phone→From→To→Activity→Payment',
  idOrder(modal, 'ps-create-guest') >= 0 && idOrder(modal, 'ps-create-phone') > idOrder(modal, 'ps-create-guest')
  && idOrder(modal, 'ps-create-date-from') > idOrder(modal, 'ps-create-phone')
  && idOrder(modal, 'ps-create-date-to') > idOrder(modal, 'ps-create-date-from')
  && idOrder(modal, 'ps-create-comp-course') > idOrder(modal, 'ps-create-date-to')
  && idOrder(modal, 'ps-create-payment') > idOrder(modal, 'ps-create-comp-course'));
assert('duration select hidden once', /id="ps-create-course-tier-wrap"[^>]*(hidden|display:none)/.test(modal)
  && (modal.match(/id="ps-create-date-from"/g) || []).length === 1);
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const es = require('./lib/staff-portal-i18n-es-sunset');
const en = STAFF_PORTAL_STRINGS.en || {}, it = STAFF_PORTAL_STRINGS.it || {};
['schedule.create.courseDurationUnavailable', 'schedule.create.courseDurationAmbiguous'].forEach((K) => {
  assert('i18n ' + K, !!(en[K] && es[K] && it[K]) && es[K] !== en[K] && it[K] !== en[K]);
});
assert('durationDaysFromTierKey', typeof bookable.durationDaysFromTierKey === 'function'
  && bookable.durationDaysFromTierKey('1_day') === 1 && bookable.durationDaysFromTierKey('single_class') === 1
  && bookable.durationDaysFromTierKey('3_days') === 3 && bookable.durationDaysFromTierKey('1_week') === 7
  && bookable.durationDaysFromTierKey('2_weeks') === 14 && bookable.durationDaysFromTierKey('4_weeks') === 28
  && bookable.durationDaysFromTierKey('x') == null);
assert('owners duration_days not key-guess',
  /function schedulePortalMatchSellableCourseTiersByDurationDays/.test(portalSrc)
  && /function schedulePortalResolveDerivedCourseTier/.test(portalSrc)
  && /schedulePortalResolveDerivedCourseTier/.test(apiSrc)
  && /duration_days/.test(fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-bookable-offerings.js'), 'utf8'))
  && !/schedulePortalDerivedDurationKeyFromDates/.test(portalSrc)
  && !/selectNearest|nearestDuration|closestDuration|fallbackTier\s*=/.test(portalSrc)
  && !/tierSel\.options\[tierSel\.selectedIndex\]/.test(portalSrc));
{
  const projected = bookable.projectSunsetBookableOfferingsFromConfig({
    ok: true, source: 'config', currency: 'EUR',
    surf_packs: [{ pack_id: 'c1', label: 'Beginner', active: true, weekly: 'mon_fri', schedules: ['0930_1130'],
      price_tiers: [
        { key: '1_week', label: '1 week', hours: 10, amount_cents: 18000 },
        { key: 'single_class', label: 'Single', hours: 2, amount_cents: 4000 },
        { key: '3_days', label: '3 days', hours: 6, amount_cents: 9000 },
      ] }],
    prices: [
      { offering_key: 'surf_pack_c1__1_week', amount_cents: 18000, unit: 'day', active: true },
      { offering_key: 'surf_pack_c1__single_class', amount_cents: 4000, unit: 'session', active: true },
      { offering_key: 'surf_pack_c1__3_days', amount_cents: 9000, unit: 'day', active: true },
    ],
  }, { locationId: 'sunset-somo' });
  const tiers = ((bookable.scheduleCoursesFromBookableProjection(projected)[0] || {}).price_tiers) || [];
  assert('projection stamps duration_days',
    tiers.some((t) => t.key === '1_week' && t.duration_days === 7)
    && tiers.some((t) => t.key === 'single_class' && t.duration_days === 1)
    && tiers.some((t) => t.key === '3_days' && t.duration_days === 3));
}

function buildSandbox(opts) {
  opts = opts || {};
  const nodes = {}, net = { quote: 0 };
  function N(id, extra) {
    nodes[id] = listen(Object.assign({
      id, value: '', checked: false, style: { display: '' }, dataset: {}, options: [], selectedIndex: -1,
      textContent: '', innerHTML: '', hidden: false, setAttribute() {}, getAttribute() { return null; },
      querySelectorAll() { return []; }, querySelector() { return null; },
    }, extra || {}));
  }
  ['ps-create-guest', 'ps-create-phone', 'ps-create-notes', 'ps-create-date-from', 'ps-create-date-to',
    'ps-create-payment', 'ps-create-course-select', 'ps-create-course-tier', 'ps-create-course-qty',
    'ps-create-msg', 'ps-create-quote-preview', 'ps-create-summary', 'ps-create-submit',
    'ps-create-course-fields', 'ps-create-course-tier-wrap', 'ps-create-course-qty-wrap',
    'ps-create-private-lesson-fields', 'ps-create-date-range', 'ps-create-private-when',
    'ps-create-private-lesson-sessions', 'ps-create-rentals', 'ps-create-comp-fullday',
  ].forEach((id) => N(id));
  function radio(id, on) {
    nodes[id] = listen({ id, type: 'radio', name: 'act', _checked: !!on, style: {}, dataset: {}, setAttribute() {} });
    Object.defineProperty(nodes[id], 'checked', { get() { return this._checked; }, set(v) { this._checked = !!v; } });
  }
  radio('ps-create-comp-course', true); radio('ps-create-comp-private-lesson', false); radio('ps-create-comp-no-lesson', false);
  nodes['ps-create-date-from'].value = opts.from || '2035-06-16';
  nodes['ps-create-date-to'].value = opts.to || '2035-06-16';
  nodes['ps-create-guest'].value = 'Ada'; nodes['ps-create-course-qty'].value = '1'; nodes['ps-create-payment'].value = 'unpaid';
  nodes['ps-create-course-select'].options = [{ value: 'c1', textContent: 'Beginner', getAttribute: (k) => (k === 'data-label' ? 'Beginner' : null) }];
  nodes['ps-create-course-select'].value = 'c1'; nodes['ps-create-course-select'].selectedIndex = 0;
  nodes['ps-create-course-tier'].options = [{ value: '1_week', textContent: 'POISONED 1 week' }];
  nodes['ps-create-course-tier'].value = '1_week'; nodes['ps-create-course-tier'].selectedIndex = 0;
  const courses = opts.courses || [{ course_id: 'c1', label: 'Beginner', price_tiers: realTiers() }];
  const sb = {
    el(id) { return nodes[id] || null; }, portalT(k) { return k; }, escHtml(s) { return String(s == null ? '' : s); },
    scheduleTodayIso() { return '2035-06-16'; }, scheduleCoursesCache: courses,
    scheduleEnumerateDates(fromIso, toIso) {
      const out = [];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromIso || ''))) return out;
      const to = /^\d{4}-\d{2}-\d{2}$/.test(String(toIso || '')) ? toIso : fromIso;
      let cur = new Date(fromIso + 'T12:00:00'); const end = new Date(to + 'T12:00:00');
      if (end < cur) return out;
      for (let g = 0; cur <= end && g < 400; g += 1) { out.push(cur.toISOString().slice(0, 10)); cur.setDate(cur.getDate() + 1); }
      return out;
    },
    scheduleReadCreateRentalSelectionFromDom() { return opts.rentals || []; },
    scheduleRentalsToLegacyComponents() { return {}; },
    scheduleReadPrivateLessonSessionsFromDom() { return []; },
    scheduleReadFullDayAddonRows() { return {}; },
    schedulePortalMadridTodayIso() { return '2035-06-16'; },
    schedulePortalCanonicalDateIso(raw) {
      const s = String(raw == null ? '' : raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
      const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
      const dt0 = new Date(Date.UTC(y, m - 1, d));
      if (dt0.getUTCFullYear() !== y || dt0.getUTCMonth() + 1 !== m || dt0.getUTCDate() !== d) return null;
      return s;
    },
    schedulePortalDurationLabel(key) {
      return ({ '1_week': '1 week', '2_weeks': '2 weeks', single_class: 'Single class', '3_days': '3 days' })[String(key || '')] || '';
    },
    schedulePortalFetchQuote() { net.quote += 1; return Promise.resolve({ ok: true, body: { success: true, total_cents: 1000 } }); },
    schedulePortalRenderCreateQuotePreview() {},
    schedulePortalClearQuotePreviewUi() { nodes['ps-create-quote-preview'].innerHTML = ''; nodes['ps-create-quote-preview'].style.display = 'none'; },
    schedulePortalStrictQuoteTotalCents(b) { return b && b.total_cents; },
    schedulePortalQuoteState: { total_cents: 9999 }, schedulePortalQuoteGen: 1,
    schedulePortalQuoteAbort: null, schedulePortalQuoteTimer: null, schedulePortalSubmitInFlight: false,
    getClient() { return 'sunset'; }, getSunsetLocation() { return 'sunset-somo'; },
    Intl: { DateTimeFormat() { return { format() { return '2035-06-16'; } }; } },
    Promise, JSON, Object, Array, Number, String, Math, Date, console, _net: net, _nodes: nodes,
  };
  const names = [
    'schedulePortalInclusiveDateCount', 'schedulePortalMatchSellableCourseTiersByDurationDays',
    'schedulePortalResolveDerivedCourseTier', 'schedulePortalHasSellableIntent',
    'schedulePortalValidateCreatePayload', 'schedulePortalClearQuotePreviewUi',
    'schedulePortalRunPreviewQuote', 'scheduleReadCreatePayload', 'schedulePortalRenderCreateIntentSummary',
    'schedulePortalHumanCourseBit', 'schedulePortalDurationLabel', 'schedulePortalRentalLabel',
  ];
  vm.createContext(sb);
  vm.runInContext(names.map((n) => extractFn(portalSrc, n) || extractFn(apiSrc, n)).filter(Boolean).join('\n'), sb);
  return sb;
}

console.log('[2] Week/single/N_days match + ambiguous + fail-closed');
{
  const sb = buildSandbox();
  const r1 = sb.schedulePortalResolveDerivedCourseTier('c1', '2035-06-16', '2035-06-16');
  assert('same-day single_class', r1 && r1.ok && r1.tier_key === 'single_class' && r1.duration_days === 1);
  assert('7/14/21/28 weeks',
    sb.schedulePortalResolveDerivedCourseTier('c1', '2035-06-16', '2035-06-22').tier_key === '1_week'
    && sb.schedulePortalResolveDerivedCourseTier('c1', '2035-06-16', '2035-06-29').tier_key === '2_weeks'
    && sb.schedulePortalResolveDerivedCourseTier('c1', '2035-06-16', '2035-07-06').tier_key === '3_weeks'
    && sb.schedulePortalResolveDerivedCourseTier('c1', '2035-06-16', '2035-07-13').tier_key === '4_weeks');
  assert('3_days + no-match + nonbookable',
    sb.schedulePortalResolveDerivedCourseTier('c1', '2035-06-16', '2035-06-18').tier_key === '3_days'
    && sb.schedulePortalResolveDerivedCourseTier('c1', '2035-06-16', '2035-06-17').errorKey === 'schedule.create.courseDurationUnavailable'
    && sb.schedulePortalResolveDerivedCourseTier('c1', '2035-06-16', '2035-06-20').errorKey === 'schedule.create.courseDurationUnavailable');
  const amb = buildSandbox({
    courses: [{ course_id: 'c1', price_tiers: [
      { key: '1_week', duration_days: 7, bookable: true, offering_id: 'a' },
      { key: '7_days', duration_days: 7, bookable: true, offering_id: 'b' },
    ] }],
    from: '2035-06-16', to: '2035-06-22',
  });
  assert('ambiguous duplicate duration', amb.schedulePortalResolveDerivedCourseTier('c1', '2035-06-16', '2035-06-22').errorKey === 'schedule.create.courseDurationAmbiguous');
  assert('inverted/malformed', sb.schedulePortalResolveDerivedCourseTier('c1', '2035-06-20', '2035-06-15').errorKey === 'calendar.state.invalidDateRange'
    && sb.schedulePortalResolveDerivedCourseTier('c1', '2035-02-31', '2035-02-31').errorKey === 'calendar.state.invalidDateRange');
}

(async () => {
  console.log('[3] Payload/summary/poison/mutations/async');
  const sb = buildSandbox({ from: '2035-06-16', to: '2035-06-22' });
  const p = sb.scheduleReadCreatePayload();
  assert('payload week tier', p.components.course.tier_key === '1_week'
    && p.components.course.offering_id === 'surf_pack_c1__1_week'
    && p.components.course.tier_label === '1 week' && p.date_to === '2035-06-22');
  assert('gate ok', sb.schedulePortalValidateCreatePayload(p, { soft: false }).ok === true);
  sb.schedulePortalRenderCreateIntentSummary(p);
  assert('summary derived not poison', /1 week/.test(sb._nodes['ps-create-summary'].innerHTML)
    && !/POISONED/.test(sb._nodes['ps-create-summary'].innerHTML));
  sb._nodes['ps-create-course-tier'].value = '2_weeks';
  sb._nodes['ps-create-course-tier'].options = [{ value: '2_weeks', textContent: 'POISONED 2 weeks' }];
  assert('poison ignored', sb.scheduleReadCreatePayload().components.course.tier_key === '1_week');
  sb._nodes['ps-create-date-to'].value = '2035-06-17';
  assert('unmatched soft zero net', !sb.scheduleReadCreatePayload().components.course.tier_key
    && sb.schedulePortalValidateCreatePayload(sb.scheduleReadCreatePayload(), { soft: true }).errorKey === 'schedule.create.courseDurationUnavailable'
    && (sb._net.quote = 0, await sb.schedulePortalRunPreviewQuote(), sb._net.quote === 0));
  sb._nodes['ps-create-date-to'].value = '2035-06-22';
  assert('re-derive week', sb.scheduleReadCreatePayload().components.course.tier_key === '1_week');

  const realResolve = extractFn(portalSrc, 'schedulePortalResolveDerivedCourseTier');
  const mutResolve = realResolve.replace(
    'var matches = schedulePortalMatchSellableCourseTiersByDurationDays(course, days);',
    'var matches = []; /* mutated */'
  );
  const sbM = buildSandbox({ from: '2035-06-16', to: '2035-06-22' });
  vm.runInContext(mutResolve, sbM);
  assert('client RED', !sbM.scheduleReadCreatePayload().components.course.tier_key
    && (sbM._net.quote = 0, (await sbM.schedulePortalRunPreviewQuote()).ok === false && sbM._net.quote === 0));
  vm.runInContext(realResolve, sbM);
  assert('client GREEN', sbM.scheduleReadCreatePayload().components.course.tier_key === '1_week');

  const sbS = buildSandbox({ from: '2035-06-16', to: '2035-06-22' });
  sbS.scheduleCoursesCache[0].price_tiers = sbS.scheduleCoursesCache[0].price_tiers.map((t) => {
    const c = Object.assign({}, t); delete c.duration_days; return c;
  });
  assert('projection RED', !sbS.scheduleReadCreatePayload().components.course.tier_key);
  sbS.scheduleCoursesCache[0].price_tiers = realTiers();
  assert('projection GREEN', sbS.scheduleReadCreatePayload().components.course.tier_key === '1_week');

  const sbG = buildSandbox({ from: '2035-06-16', to: '2035-06-18' });
  sbG.scheduleCoursesCache = [];
  assert('empty catalog unavailable', !sbG.scheduleReadCreatePayload().components.course.tier_key);
  sbG.scheduleCoursesCache = [{ course_id: 'c1', label: 'Beginner', price_tiers: realTiers() }];
  sbG.scheduleReadCreateRentalSelectionFromDom = () => [{ offering_key: 'board_rental', duration_key: '3_days', quantity: 1 }];
  const pg = sbG.scheduleReadCreatePayload();
  assert('async catalog + group+gear', pg.components.course.tier_key === '3_days' && pg.rentals[0].duration_key === '3_days'
    && /function schedulePortalPrepareCreateOpen[\s\S]*ps-create-date-from/.test(portalSrc)
    && /portal-schedule-create-drawer/.test(apiSrc));

  console.log('\nResults: ' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) { console.error('verify:sunset-booking-create-date-duration — FAILED'); process.exit(1); }
  console.log('verify:sunset-booking-create-date-duration — ALL CHECKS PASSED'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
