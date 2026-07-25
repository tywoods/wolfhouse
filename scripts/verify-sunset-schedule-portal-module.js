'use strict';

/**
 * verify:sunset-schedule-portal-module
 *
 * Slice 11 — Schedule portal canonical API/data layer gate.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-portal-module.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PORTAL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');
const DRAWER_SERVER = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-drawer.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

function extractFunctionSource(src, name) {
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

console.log('\nverify:sunset-schedule-portal-module\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const modSrc = fs.readFileSync(PORTAL_MODULE, 'utf8');
const drawerSrc = fs.readFileSync(DRAWER_SERVER, 'utf8');
const browserLoader = fs.readFileSync(BROWSER_SRC, 'utf8');

console.log('[1] Module files and injection');
assert('portal module exists', fs.existsSync(PORTAL_MODULE));
assert('browser source loader exists', fs.existsSync(BROWSER_SRC));
assert('inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-portal-module */'));
assert('drawer view inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-view-ui */'));
assert('drawer edit inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-edit-ui */'));
assert('drawer actions inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-actions */'));
assert('drawer controller inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-controller */'));
assert('day ops board inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-day-ops-board-ui */'));
assert('forecast cards inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-forecast-cards-ui */'));
assert('view grid inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-view-grid-ui */'));
assert('runtime inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-runtime */'));
assert('navigation inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-navigation-ui */'));
assert('data loader inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-data-loader */'));
assert('browser source loads data loader module', browserLoader.includes('getSunsetScheduleDataLoaderBrowserSource'));
assert('browser source loads forecast cards module', browserLoader.includes('getSunsetScheduleForecastCardsBrowserSource'));
assert('browser source loads view grid module', browserLoader.includes('getSunsetScheduleViewGridBrowserSource'));
assert('browser source loads runtime module', browserLoader.includes('getSunsetScheduleRuntimeBrowserSource'));
assert('browser source loads navigation module', browserLoader.includes('getSunsetScheduleNavigationBrowserSource'));
assert('browser source loads drawer actions module', browserLoader.includes('getSunsetScheduleDrawerActionsBrowserSource'));
assert('browser source loads drawer controller module', browserLoader.includes('getSunsetScheduleDrawerControllerBrowserSource'));
assert('browser source loads drawer edit module', browserLoader.includes('getSunsetScheduleDrawerEditBrowserSource'));
assert('browser source loads drawer view module', browserLoader.includes('getSunsetScheduleDrawerViewBrowserSource'));
assert('injectSunsetSchedulePortalModule defined', browserLoader.includes('function injectSunsetSchedulePortalModule'));
assert('buildUiHtml calls inject', /injectSunsetSchedulePortalModule\(html\)/.test(apiSrc));
assert('create quote preview element', apiSrc.includes('id="ps-create-quote-preview"'));

console.log('\n[2] Canonical API endpoints in portal module');
assert('catalog fetch', modSrc.includes('/staff/schedule/bookings/catalog'));
assert('quote fetch', modSrc.includes('/staff/schedule/bookings/quote'));
assert('create fetch', modSrc.includes('/staff/schedule/bookings?'));
assert('detail fetch', modSrc.includes('/staff/schedule/bookings/detail'));
assert('payment-link fetch', modSrc.includes('/staff/schedule/bookings/payment-link'));
assert('quote provenance on create', modSrc.includes('quote_provenance'));
const submitCreateSrc = extractFunctionSource(modSrc, 'schedulePortalSubmitCreate') || '';
assert(
  'no client amount fields in create body builder',
  submitCreateSrc.length > 0
    && !submitCreateSrc.includes('amount_due_cents')
    && !/\btotal_cents\b/.test(submitCreateSrc.replace(/quote_provenance/g, ''))
);

console.log('\n[3] Luna + Staff drawer parity gates');
const rowRefSrc = extractFunctionSource(apiSrc, 'scheduleRowBookingRef');
const ctx = {
  __group: null,
  scheduleFindGroupForRow: function() { return ctx.__group; },
};
vm.createContext(ctx);
if (rowRefSrc) vm.runInContext(`${rowRefSrc}\nthis.scheduleRowBookingRef=scheduleRowBookingRef;`, ctx);
vm.createContext(ctx);
['scheduleDrawerTrustedPersistedSource', 'scheduleDrawerCanLoadCanonical', 'scheduleDrawerCanEdit'].forEach((name) => {
  const fnSrc = extractFunctionSource(modSrc, name);
  assert(`module defines ${name}`, !!fnSrc);
  if (fnSrc) vm.runInContext(`${fnSrc}\nthis.${name}=${name};`, ctx);
});

const STAFF_ROW = { _isDbManual: true, record_source: 'staff_manual', booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
const LUNA_ROW = { record_source: 'luna_guest', booking_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };
const DEMO_ROW = { _isDemo: true, record_source: 'luna_guest', booking_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' };

ctx.__group = { records: [STAFF_ROW] };
assert('staff row loads canonical drawer', ctx.scheduleDrawerCanLoadCanonical(STAFF_ROW) === true);
ctx.__group = { records: [LUNA_ROW] };
assert('luna row loads canonical drawer', ctx.scheduleDrawerCanLoadCanonical(LUNA_ROW) === true);
assert('luna row editable in drawer', ctx.scheduleDrawerCanEdit(LUNA_ROW) === true);
assert('demo row blocked', ctx.scheduleDrawerCanLoadCanonical(DEMO_ROW) === false);

console.log('\n[4] Server drawer attribution (not Luna vs staff gate)');
assert('bundleHasTrustedScheduleDrawerAttribution', drawerSrc.includes('function bundleHasTrustedScheduleDrawerAttribution'));
assert('luna metadata allowed', /LUNA_METADATA_SOURCE_TAG/.test(drawerSrc));
assert('uses payment-link getPaymentStatus', drawerSrc.includes('getPaymentStatus'));
assert('legacy drawer_edits error removed from detail gate', !drawerSrc.includes('drawer_edits_limited_to_staff_manual_schedule'));

console.log('\n[5] No browser weekday price authority in create submit');
assert('submit uses quote API not scheduleCourseEligibleOnDates', modSrc.includes('schedulePortalFetchQuote') && !modSrc.includes('scheduleCourseEligibleOnDates'));
assert('populate courses uses eligible_on_requested_dates', modSrc.includes('eligible_on_requested_dates'));
assert('staff-api submitScheduleManualBooking removed', !/function submitScheduleManualBooking\s*\(/.test(apiSrc));
assert('scheduleCourseEligibleOnDates only compatibility wrapper', apiSrc.includes('function scheduleCourseEligibleOnDates('));

console.log('\n[6] Payment link display rules');
assert('schedulePortalStripeLinkFromCtx', modSrc.includes('function schedulePortalStripeLinkFromCtx'));
assert('invalidated links not actionable', modSrc.includes('payment_link_invalidated'));
assert('stripe section uses portal resolver', (function () {
  const payPath = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-actions.js');
  const paySrc = fs.existsSync(payPath) ? fs.readFileSync(payPath, 'utf8') : '';
  return paySrc.includes('schedulePortalStripeLinkFromCtx');
})());

console.log('\n[7] Quote payload browser contract (VM)');
assert(
  'schedulePortalFetchQuote body includes guest_name',
  /function schedulePortalFetchQuote\([\s\S]*?guest_name:\s*createPayload\.guest_name/.test(modSrc)
);

const formPayload = {
  guest_name: 'Ada Lovelace', date_from: '2026-07-20', date_to: '2026-07-22',
  components: { course: { course_id: 'course-beginner', tier_key: '1_week', quantity: 1 } },
  amount_due_cents: 99999, total_cents: 99999,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sandbox(opts = {}) {
  const log = [];
  const nodes = {};
  const payload = {
    guest_name: 'Ada Lovelace', date_from: '2026-07-20', date_to: '2026-07-22', payment_status: 'unpaid',
    components: { course: { course_id: 'course-beginner', tier_key: '1_week', quantity: 1 } }, rentals: [],
  };
  let qn = 0;
  let cn = 0;
  const hold = { creates: [] };
  const ctx = {
    console, setTimeout, clearTimeout,
    AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
    crypto: typeof crypto !== 'undefined' ? crypto : undefined,
    getClient: () => 'sunset', getSunsetLocation: () => 'sunset-somo',
    sunsetLocationQuerySuffix: () => '&location_id=sunset-somo',
    scheduleEnumerateDates: (a, b) => [String(a).slice(0, 10), String(b).slice(0, 10)],
    scheduleReadCreatePayload: () => JSON.parse(JSON.stringify(payload)),
    scheduleUpdateFullDayAddonSummary() {}, portalT: (k) => k, escHtml: (s) => String(s),
    el: (id) => (nodes[id] || (nodes[id] = { textContent: '', innerHTML: '', style: { display: 'none' }, disabled: false, classList: { add() {}, remove() {} } })),
    closeScheduleCreateModal() {
      ctx._closed = true;
      if (typeof ctx.schedulePortalInvalidatePreviewWork === 'function') ctx.schedulePortalInvalidatePreviewWork();
    },
    openScheduleCreateModal() {
      if (typeof ctx.schedulePortalResetCreateFormRuntime === 'function') ctx.schedulePortalResetCreateFormRuntime();
      ctx._closed = false;
    },
    scheduleResetNavigationAfterBookingCreate() {}, scheduleRequestPageLoad() {},
    scheduleFindCachedRowByBookingCode() { return null; },
    fetch(url, reqOpts = {}) {
      const entry = { url: String(url), opts: reqOpts, body: null };
      try { if (reqOpts.body) entry.body = JSON.parse(reqOpts.body); } catch (_e) {}
      log.push(entry);
      if (String(url).includes('/bookings/quote')) {
        const n = ++qn;
        const delay = typeof opts.quoteDelay === 'function' ? opts.quoteDelay(n) : (opts.quoteDelay || 0);
        const custom = typeof opts.quoteOutcome === 'function' ? opts.quoteOutcome(n) : null;
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => {
            if (reqOpts.signal && reqOpts.signal.aborted) { const e = new Error('a'); e.name = 'AbortError'; return reject(e); }
            if (custom) {
              return resolve({ ok: custom.ok !== false, status: custom.status || 200, json: () => Promise.resolve(custom.body || custom) });
            }
            resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, total_cents: 13500, quote_provenance: { source: 't', quote_fingerprint: 'fp' + n } }) });
          }, delay);
          if (reqOpts.signal) reqOpts.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('a'); e.name = 'AbortError'; reject(e); });
        });
      }
      if (String(url).includes('/bookings?') && reqOpts.method === 'POST') {
        const n = ++cn;
        const custom = typeof opts.createOutcome === 'function' ? opts.createOutcome(n, entry) : null;
        if (opts.holdCreate) return new Promise((resolve, reject) => { hold.creates.push({ n, entry, resolve, reject, reqOpts }); });
        if (custom && custom.networkError) return Promise.reject(new Error(custom.networkError));
        return new Promise((r) => setTimeout(() => r({
          ok: !(custom && custom.ok === false), status: (custom && custom.status) || 201,
          json: () => Promise.resolve((custom && custom.body) || { success: true, booking_code: 'SUNSET-TEST-001', booking_id: 'bk-1' }),
        }), opts.createDelay || 0));
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, courses: [] }) });
    },
    _log: log, _payload: payload, _hold: hold, _nodes: nodes,
  };
  vm.createContext(ctx); vm.runInContext(modSrc, ctx);
  if (opts.debounceMs != null) ctx.schedulePortalQuoteDebounceMs = opts.debounceMs;
  return ctx;
}

const simpleLog = [];
const simpleCtx = {
  console, setTimeout, clearTimeout, getClient: () => 'sunset', getSunsetLocation: () => 'sunset-somo',
  sunsetLocationQuerySuffix: () => '&location_id=sunset-somo',
  scheduleEnumerateDates: (a, b) => [String(a).slice(0, 10), String(b).slice(0, 10)],
  el: () => null, portalT: (k) => k, escHtml: (s) => String(s),
  fetch(url, opts) {
    simpleLog.push({ url: String(url), opts: opts || {} });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, total_cents: 13500, quote_provenance: { source: 'test' } }) });
  },
};
vm.createContext(simpleCtx); vm.runInContext(modSrc, simpleCtx);
assert('schedulePortalFetchQuote exported in sandbox', typeof simpleCtx.schedulePortalFetchQuote === 'function');

(async function runQuotePayloadContract() {
  simpleLog.length = 0;
  const result = await simpleCtx.schedulePortalFetchQuote(formPayload);
  assert('quote fetch returns ok', result && result.ok === true);
  const quoteCalls = simpleLog.filter((e) => e.url.includes('/staff/schedule/bookings/quote') && e.opts && e.opts.method === 'POST');
  let body = null; try { body = JSON.parse(quoteCalls[0].opts.body); } catch (_e) {}
  assert('quote POST contract', quoteCalls.length === 1 && body
    && body.guest_name === formPayload.guest_name
    && body.date_from === formPayload.date_from && body.date_to === formPayload.date_to
    && body.components && body.components.course
    && body.components.course.course_id === formPayload.components.course.course_id
    && body.components.course.tier_key === formPayload.components.course.tier_key
    && body.location_id === 'sunset-somo'
    && Array.isArray(body.service_dates) && body.service_dates[0] === '2026-07-20' && body.service_dates[1] === '2026-07-22'
    && !Object.prototype.hasOwnProperty.call(body, 'amount_due_cents')
    && !Object.prototype.hasOwnProperty.call(body, 'total_cents'));

  console.log('\n[8] Slice A hostile quote/submit');
  assert('runtime flags', typeof simpleCtx.schedulePortalQuoteDebounceMs === 'number' && typeof simpleCtx.schedulePortalQuoteGen === 'number'
    && typeof simpleCtx.schedulePortalInvalidatePreviewWork === 'function' && typeof simpleCtx.schedulePortalSubmitInFlight === 'boolean');

  const rapid = sandbox({ debounceMs: 40, quoteDelay: 5 });
  for (let i = 0; i < 12; i++) rapid.schedulePortalRefreshCreateQuote();
  await sleep(120);
  const rq = rapid._log.filter((e) => e.url.includes('/bookings/quote')).length;
  assert('rapid edits coalesce', rq >= 1 && rq <= 3, 'got ' + rq);

  const ooo = sandbox({ debounceMs: 5, quoteDelay: (n) => (n === 1 ? 80 : 5), quoteOutcome: (n) => (n === 1
    ? { ok: false, status: 503, body: { success: false, error: 'HTTP 503' } }
    : { ok: true, body: { success: true, total_cents: 9900, quote_provenance: { source: 'newer' } } }) });
  const p1 = ooo.schedulePortalRunPreviewQuote(); await sleep(15); const p2 = ooo.schedulePortalRunPreviewQuote();
  await Promise.all([p1, p2]);
  assert('ooo keeps newer', ooo.schedulePortalQuoteState && ooo.schedulePortalQuoteState.total_cents === 9900
    && ooo.schedulePortalQuoteState.quote_provenance.source === 'newer', JSON.stringify(ooo.schedulePortalQuoteState));
  assert('ooo no stale 503 UI', ooo.el('ps-create-quote-preview').innerHTML.indexOf('503') < 0);

  const sub = sandbox({ debounceMs: 40, quoteDelay: 20, createDelay: 30 });
  sub.schedulePortalRefreshCreateQuote(); await sleep(10); sub._log.length = 0;
  sub.submitScheduleManualBooking(); sub.submitScheduleManualBooking(); sub.submitScheduleManualBooking();
  await sleep(120);
  const sq = sub._log.filter((e) => e.url.includes('/bookings/quote'));
  const sc = sub._log.filter((e) => e.url.includes('/bookings?') && e.opts && e.opts.method === 'POST');
  assert('submit 1 quote 1 create', sq.length === 1 && sc.length === 1, `q=${sq.length} c=${sc.length}`);
  assert('create has key+provenance', sc[0].body && String(sc[0].body.idempotency_key || '').length > 8 && sc[0].body.quote_provenance);
  assert('submit settled', sub._closed === true && sub.schedulePortalSubmitInFlight === false);

  const retry = sandbox();
  const k1 = retry.schedulePortalEnsureIdempotencyKey(retry._payload);
  assert('key reuse', k1 === retry.schedulePortalEnsureIdempotencyKey(retry._payload));
  retry._payload.guest_name = 'X'; assert('key rotates on intent', retry.schedulePortalEnsureIdempotencyKey(retry._payload) !== k1);

  const late = sandbox({ debounceMs: 5, quoteDelay: (n) => (n === 1 ? 60 : 5), quoteOutcome: (n) => (n === 1
    ? { ok: false, status: 503, body: { success: false, error: 'HTTP 503' } }
    : { ok: true, body: { success: true, total_cents: 5000, quote_provenance: { source: 'submit' } } }) });
  const lp = late.schedulePortalRunPreviewQuote(); await sleep(10);
  late.submitScheduleManualBooking(); await sleep(100); await lp.catch(() => null);
  assert('late 503 cannot spoil submit', late._closed === true
    && late._log.filter((e) => e.url.includes('/bookings?') && e.opts && e.opts.method === 'POST').length === 1);
  assert('staff open/close hooks', apiSrc.includes('schedulePortalResetCreateFormRuntime') && apiSrc.includes('schedulePortalInvalidatePreviewWork'));

  const mid = sandbox({ holdCreate: true, quoteDelay: 0 });
  mid.submitScheduleManualBooking(); await sleep(40);
  const heldKey = mid._hold.creates[0] && mid._hold.creates[0].entry.body && mid._hold.creates[0].entry.body.idempotency_key;
  assert('mid-submit held', mid.schedulePortalSubmitInFlight === true && typeof heldKey === 'string' && heldKey.length > 8, heldKey);
  mid.closeScheduleCreateModal(); mid.openScheduleCreateModal();
  mid.submitScheduleManualBooking(); mid.submitScheduleManualBooking(); await sleep(30);
  assert('close+reopen one create same key', mid._hold.creates.length === 1
    && mid.schedulePortalSubmitInFlight === true && mid.schedulePortalSubmitIdemKey === heldKey
    && mid.el('ps-create-submit').disabled === true, 'creates=' + mid._hold.creates.length);
  mid._hold.creates[0].resolve({ ok: true, status: 201, json: () => Promise.resolve({ success: true, booking_code: 'SUNSET-HOLD-1', booking_id: 'bk-hold' }) });
  await sleep(40);
  assert('held create settles once', mid.schedulePortalSubmitInFlight === false && mid._closed === true);

  const lost = sandbox({ createOutcome: (n) => (n === 1 ? { networkError: 'Failed to fetch' } : null) });
  lost.submitScheduleManualBooking(); await sleep(60);
  const lost1 = lost._log.filter((e) => e.url.includes('/bookings?') && e.opts && e.opts.method === 'POST');
  const lostKey = lost1[0] && lost1[0].body && lost1[0].body.idempotency_key;
  assert('response-loss retains key', lost1.length === 1 && lost.schedulePortalSubmitIdemKey === lostKey);
  lost.submitScheduleManualBooking(); await sleep(60);
  const lost2 = lost._log.filter((e) => e.url.includes('/bookings?') && e.opts && e.opts.method === 'POST');
  assert('response-loss retry reuses key', lost2.length === 2 && lost2[1].body && lost2[1].body.idempotency_key === lostKey);

  const ri = sandbox(); ri._payload.components = {};
  ri._payload.rentals = [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1, total_cents: 9999 }];
  const rk1 = ri.schedulePortalCreateIntentKey(ri._payload);
  ri._payload.rentals = [{ total_cents: 1, quantity: 1, duration_key: '1_day', offering_key: 'board_rental' }];
  assert('rental intent ignores money/order', ri.schedulePortalCreateIntentKey(ri._payload) === rk1);
  ri._payload.rentals = [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 2 }];
  assert('rental qty changes intent', ri.schedulePortalCreateIntentKey(ri._payload) !== rk1);
  ri._payload.rentals = [{ offering_key: 'board_rental', duration_key: '2_days', quantity: 1 }];
  assert('rental duration changes intent', ri.schedulePortalCreateIntentKey(ri._payload) !== rk1);
  ri._payload.rentals = [{ offering_key: 'wetsuit_rental', duration_key: '1_day', quantity: 1 }];
  assert('rental offering changes intent', ri.schedulePortalCreateIntentKey(ri._payload) !== rk1);

  console.log(`\n── verify:sunset-schedule-portal-module ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
