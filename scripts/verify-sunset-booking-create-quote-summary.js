'use strict';
/* verify:sunset-booking-create-quote-summary — Kaya Slice 5 offline sticky summary + quote states */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
let pass = 0, fail = 0;
function assert(l, c, d) { if (c) { console.log('  PASS  ' + l); pass += 1; } else { console.error('  FAIL  ' + l + (d ? ' — ' + d : '')); fail += 1; } }
function extractFn(src, name) {
  const n = 'function ' + name + '(', s = src.indexOf(n); if (s < 0) return null;
  const b = src.indexOf('{', s); let d = 0;
  for (let i = b; i < src.length; i += 1) { if (src[i] === '{') d += 1; else if (src[i] === '}') { d -= 1; if (!d) return src.slice(s, i + 1); } }
  return null;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
const modal = (() => {
  const s = apiSrc.indexOf('id="ps-create-modal"'); const o = apiSrc.lastIndexOf('<div', s);
  const e = apiSrc.indexOf('id="ps-drawer-backdrop"', o); const c = apiSrc.lastIndexOf('</div>', e);
  return apiSrc.slice(o, c > o ? c + 6 : e);
})();
const footer = (modal.match(/<footer class="portal-schedule-create-footer"[\s\S]*?<\/footer>/) || [])[0] || '';
console.log('\nverify:sunset-booking-create-quote-summary — Kaya Slice 5\n');
console.log('[1] Shell/CSS/i18n');
const counts = {}; let m; const re = /\bid="(ps-create-[^"]+)"/g;
while ((m = re.exec(modal))) counts[m[1]] = (counts[m[1]] || 0) + 1;
assert('footer outside body + unique IDs + hierarchy',
  modal.indexOf('portal-schedule-create-body') < modal.indexOf('portal-schedule-create-footer')
  && footer.includes('ps-create-summary') && footer.includes('ps-create-quote-preview')
  && footer.indexOf('ps-create-summary') < footer.indexOf('ps-create-quote-preview')
  && footer.indexOf('ps-create-quote-preview') < footer.indexOf('ps-create-submit')
  && counts['ps-create-summary'] === 1 && counts['ps-create-quote-preview'] === 1
  && Object.keys(counts).every((k) => counts[k] === 1));
assert('quote a11y + mobile footer bounds',
  /id="ps-create-quote-preview"[^>]*role="status"/.test(footer) && /aria-live="polite"/.test(footer)
  && /portal-schedule-create-footer\{[^}]*max-height/.test(apiSrc)
  && /portal-schedule-create-summary\{[^}]*(-webkit-line-clamp:2|line-clamp:2)/.test(apiSrc)
  && /portal-schedule-create-footer\{[^}]*overflow-x:\s*hidden/.test(apiSrc) && /min-height:\s*44px/.test(apiSrc)
  && /safe-area-inset-bottom/.test(apiSrc));
assert('single owners', /function schedulePortalRenderCreateIntentSummary/.test(portalSrc)
  && (portalSrc.match(/function schedulePortalRenderCreateQuotePreview/g) || []).length === 1
  && /function schedulePortalSyncCreateFooter/.test(portalSrc)
  && /schedulePortalSyncCreateFooter|schedulePortalRenderCreateIntentSummary/.test(extractFn(apiSrc, 'scheduleUpdateCreateTotalPreview') || ''));
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const es = require('./lib/staff-portal-i18n-es-sunset');
const en = STAFF_PORTAL_STRINGS.en || {}, it = STAFF_PORTAL_STRINGS.it || {};
[
  'schedule.create.summary.chooseLessonOrGear', 'schedule.create.summary.completeSessions',
  'schedule.create.checkingPrice', 'schedule.create.quoteTotal', 'schedule.create.quoteFailed',
  'schedule.create.quoteStale', 'schedule.create.quoteBusy',
].forEach((k) => assert('i18n ' + k, !!(en[k] && es[k] && it[k] && es[k] !== en[k] && it[k] !== en[k] && es[k] !== k && it[k] !== k)));

console.log('[2] Behavioral');
const T = {
  'schedule.create.summary.chooseLessonOrGear': 'Choose a lesson or add gear',
  'schedule.create.summary.completeSessions': 'Complete session details',
  'schedule.create.checkingPrice': 'Checking price…', 'schedule.create.quoteTotal': 'Quoted total',
  'schedule.create.quoteFailed': 'Quote unavailable', 'schedule.create.quoteStale': 'Price changed — refresh quote before creating.',
  'schedule.create.quoteBusy': 'Price check is busy — wait a moment and try again.',
  'schedule.type.course': 'Group course', 'schedule.type.privateLesson': 'Private course',
  'schedule.type.noLesson': 'No lesson', 'schedule.type.boardRental': 'Board rental',
  'schedule.type.wetsuitRental': 'Wetsuit rental', 'schedule.ops.rentalBoth': 'Surfboard + wetsuit',
  'schedule.payment.paid': 'Paid', 'schedule.payment.unpaid': 'Unpaid',
  'schedule.create.privateLesson.sessionIncomplete': 'Complete session details',
};
function sandbox(opts) {
  opts = opts || {};
  const log = [], nodes = {};
  function N(id, x) {
    nodes[id] = Object.assign({
      id, value: '', checked: false, disabled: false, textContent: '', innerHTML: '', style: { display: 'none' },
      dataset: {}, classList: { add() {}, remove() {} }, options: [], selectedIndex: -1, _ls: {},
      addEventListener(ev, fn) { (this._ls[ev] = this._ls[ev] || []).push(fn); },
      setAttribute(k, v) { this['_' + k] = v; }, getAttribute(k) { return this['_' + k] || null; },
      querySelector() { return null; }, querySelectorAll() { return []; },
    }, x || {});
    return nodes[id];
  }
  N('ps-create-summary', { innerHTML: '<span>—</span>', style: { display: '' } });
  N('ps-create-quote-preview'); N('ps-create-msg'); N('ps-create-submit');
  N('ps-create-guest'); N('ps-create-phone'); N('ps-create-notes'); N('ps-create-payment', { value: 'unpaid' });
  N('ps-create-date-from', { value: '2026-08-20' }); N('ps-create-date-to', { value: '2026-08-22' });
  N('ps-create-course-select', { value: 'c1', options: [{ value: 'c1', textContent: 'Beginner', getAttribute: () => 'Beginner' }], selectedIndex: 0 });
  N('ps-create-course-tier', { value: '1_week', options: [{ value: '1_week', textContent: '1 week' }], selectedIndex: 0 });
  N('ps-create-course-qty', { value: '1' }); N('ps-create-private-lesson-qty', { value: '1' });
  N('ps-create-private-lesson-surfers', { value: '1' }); N('ps-create-private-lesson-sessions');
  N('ps-create-comp-course'); N('ps-create-comp-private-lesson'); N('ps-create-comp-no-lesson', { checked: true });
  N('ps-create-comp-fullday'); N('ps-create-rentals', { getAttribute: () => '1_day' });
  let payload = opts.payload || { guest_name: '', guest_phone: '+34000', notes: 'secret', date_from: '2026-08-20', date_to: '2026-08-22', payment_status: 'unpaid', components: {}, rentals: [] };
  let qn = 0;
  const ctx = {
    console, setTimeout, clearTimeout, Promise, JSON, Object, Array, Number, String, Math, Date,
    AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
    getClient: () => 'sunset', getSunsetLocation: () => 'sunset-somo', sunsetLocationQuerySuffix: () => '&location_id=sunset-somo',
    scheduleEnumerateDates: (a, b) => [String(a).slice(0, 10), String(b).slice(0, 10)],
    scheduleReadCreatePayload: () => JSON.parse(JSON.stringify(payload)),
    scheduleUpdateFullDayAddonSummary() {},
    portalT: (k) => T[k] || k,
    escHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    el: (id) => nodes[id] || null,
    closeScheduleCreateModal() { ctx._closed = true; if (ctx.schedulePortalInvalidatePreviewWork) ctx.schedulePortalInvalidatePreviewWork(); },
    openScheduleCreateModal() { if (ctx.schedulePortalResetCreateFormRuntime) ctx.schedulePortalResetCreateFormRuntime(); ctx._closed = false; },
    scheduleResetNavigationAfterBookingCreate() {}, scheduleRequestPageLoad() {}, scheduleFindCachedRowByBookingCode() { return null; },
    scheduleRentalOfferingLabelKey: (k) => (k === 'wetsuit_rental' ? 'schedule.type.wetsuitRental' : k === 'board_and_suit_rental' ? 'schedule.ops.rentalBoth' : 'schedule.type.boardRental'),
    fetch(url, req) {
      const entry = { url: String(url), opts: req || {}, body: null };
      try { if (req && req.body) entry.body = JSON.parse(req.body); } catch (_e) { /* */ }
      log.push(entry);
      if (String(url).includes('/bookings/quote')) {
        const n = ++qn;
        const delay = typeof opts.quoteDelay === 'function' ? opts.quoteDelay(n) : (opts.quoteDelay || 0);
        const custom = typeof opts.quoteOutcome === 'function' ? opts.quoteOutcome(n, entry) : null;
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => {
            if (req && req.signal && req.signal.aborted) { const e = new Error('a'); e.name = 'AbortError'; return reject(e); }
            if (custom) return resolve({ ok: custom.ok !== false, status: custom.status || 200, json: () => Promise.resolve(custom.body || custom) });
            resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, total_cents: opts.total_cents != null ? opts.total_cents : 13500, quote_provenance: { source: 't', quote_fingerprint: 'fp' + n } }) });
          }, delay);
          if (req && req.signal) req.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('a'); e.name = 'AbortError'; reject(e); });
        });
      }
      if (String(url).includes('/bookings?') && req && req.method === 'POST') {
        return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ success: true, booking_code: 'BK-1', booking_id: 'id-1' }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, courses: [] }) });
    },
    _log: log, _nodes: nodes, _setPayload(p) { payload = p; }, _qn: () => qn,
  };
  vm.createContext(ctx); vm.runInContext(portalSrc, ctx);
  if (opts.debounceMs != null) ctx.schedulePortalQuoteDebounceMs = opts.debounceMs;
  return ctx;
}
function S(c) { return String(c.el('ps-create-summary').innerHTML || ''); }
function Q(c) { return String(c.el('ps-create-quote-preview').innerHTML || ''); }
function Qv(c) { return c.el('ps-create-quote-preview').style.display !== 'none'; }

(async function run() {
  const empty = sandbox(); empty.schedulePortalRenderCreateIntentSummary();
  assert('fresh empty guidance', /Choose a lesson or add gear/.test(S(empty)) && !/\+34000|secret|guest_phone/.test(S(empty)));
  const group = sandbox();
  group._setPayload({ guest_name: 'Ada', guest_phone: '+34999', notes: 'NOPE', date_from: '2026-08-20', date_to: '2026-08-22', payment_status: 'paid',
    components: { course: { course_id: 'c1', course_label: 'Beginner', tier_key: '1_week', quantity: 2 } }, rentals: [] });
  group.schedulePortalRenderCreateIntentSummary();
  assert('group summary', /Group course/.test(S(group)) && /Beginner/.test(S(group)) && /1 week|×2|2/.test(S(group))
    && /2026-08-20/.test(S(group)) && /Paid/.test(S(group)) && /Ada/.test(S(group)) && !/\+34999|NOPE|tier_key|course_id/.test(S(group)));

  const priv = sandbox();
  priv._setPayload({ guest_name: '', guest_phone: 'X', notes: 'N', date_from: '2026-08-21', date_to: '2026-08-23', payment_status: 'unpaid',
    components: { private_lesson: { enabled: true, quantity: 2, surfer_count: 2, sessions: [
      { date: '2026-08-21', start: '10:00', end: '12:00' }, { date: '2026-08-23', start: '10:00', end: '12:00' },
    ] } }, rentals: [] });
  priv.schedulePortalRenderCreateIntentSummary();
  assert('private multi', /Private course/i.test(S(priv)) && /2026-08-21/.test(S(priv)) && /2026-08-23/.test(S(priv))
    && /Unpaid/.test(S(priv)) && !/\bX\b|private_lesson|guest_phone/.test(S(priv)));

  const soft = sandbox();
  soft._setPayload({ guest_name: '', date_from: '2026-08-20', date_to: '2026-08-20', payment_status: 'unpaid',
    components: { private_lesson: { enabled: true, quantity: 1, surfer_count: 1, sessions: [{ date: '', start: '', end: '' }] } }, rentals: [] });
  soft.el('ps-create-quote-preview').innerHTML = 'Quoted total: €99.00'; soft.el('ps-create-quote-preview').style.display = 'block';
  soft.schedulePortalQuoteState = { total_cents: 9900, gen: 1 };
  const softR = await soft.schedulePortalRunPreviewQuote();
  assert('soft invalid zero net + clear', soft._qn() === 0 && softR && softR.softInvalid
    && /Complete session details/.test(S(soft) + Q(soft)) && !/€99/.test(Q(soft)) && soft.schedulePortalQuoteState == null);

  const gear = sandbox();
  gear._setPayload({ guest_name: 'Bo', date_from: '2026-08-20', date_to: '2026-08-21', payment_status: 'unpaid',
    components: {}, rentals: [{ offering_key: 'board_rental', duration_key: '2_days', quantity: 2 }] });
  gear.schedulePortalRenderCreateIntentSummary();
  assert('no-lesson+gear', /No lesson/.test(S(gear)) && /Board rental/.test(S(gear)) && /Bo/.test(S(gear)) && !/board_rental/.test(S(gear)));

  const both = sandbox();
  both._setPayload({ guest_name: '<b>X</b>', date_from: '2026-08-20', date_to: '2026-08-22', payment_status: 'paid',
    components: { course: { course_id: 'c1', course_label: '<img>Int', quantity: 1 } },
    rentals: [{ offering_key: 'wetsuit_rental', duration_key: '1_day', quantity: 1 }] });
  both.schedulePortalRenderCreateIntentSummary();
  assert('lesson+gear+esc', /Group course/.test(S(both)) && /Wetsuit rental/.test(S(both)) && /Paid/.test(S(both))
    && /&lt;b&gt;|&lt;img/.test(S(both)));

  const imm = sandbox({ debounceMs: 80, quoteDelay: 5 });
  imm._setPayload({ guest_name: 'A', date_from: '2026-08-20', date_to: '2026-08-20', payment_status: 'unpaid',
    components: { course: { course_id: 'c1', course_label: 'G', quantity: 1 } }, rentals: [] });
  imm.schedulePortalSyncCreateFooter();
  assert('imm', /Group course/.test(S(imm)) && imm._qn() === 0 && /Checking price/.test(Q(imm)) && !/€135/.test(Q(imm)));
  await sleep(140);
  assert('ready', /Quoted total/.test(Q(imm)) && /€135\.00/.test(Q(imm)));

  const race = sandbox({ debounceMs: 5, quoteDelay: (n) => (n === 1 ? 60 : 5),
    quoteOutcome: (n) => (n === 1
      ? { ok: true, body: { success: true, total_cents: 11100, quote_provenance: { source: 'A' } } }
      : { ok: true, body: { success: true, total_cents: 22200, quote_provenance: { source: 'B' } } }) });
  race._setPayload({ guest_name: 'R', date_from: '2026-08-20', date_to: '2026-08-20', payment_status: 'unpaid',
    components: { course: { course_id: 'c1', course_label: 'G', quantity: 1 } }, rentals: [] });
  const r1 = race.schedulePortalRunPreviewQuote(); await sleep(10);
  race._setPayload({ guest_name: 'R', date_from: '2026-08-20', date_to: '2026-08-20', payment_status: 'unpaid',
    components: { course: { course_id: 'c1', course_label: 'G', quantity: 2 } }, rentals: [] });
  await Promise.all([r1, race.schedulePortalRunPreviewQuote()]);
  assert('race AB', race.schedulePortalQuoteState && race.schedulePortalQuoteState.total_cents === 22200
    && /€222\.00/.test(Q(race)) && !/€111\.00/.test(Q(race)));

  // reverse order (B first finishes, slow A must not overwrite) covered by same gen guard as race AB + RED gen
  const errS = sandbox({ debounceMs: 5, quoteDelay: 5, quoteOutcome: (n) => {
    if (n === 1) return { ok: false, status: 409, body: { success: false, reason_code: 'quote_stale' } };
    if (n === 2) return { ok: false, status: 503, body: { success: false, error: 'busy' } };
    if (n === 3) return { ok: false, status: 500, body: { success: false, error: 'boom' } };
    return { ok: true, body: { success: true, total_cents: 5000, quote_provenance: { source: 'ok' } } };
  } });
  errS._setPayload({ guest_name: 'E', date_from: '2026-08-20', date_to: '2026-08-20', payment_status: 'unpaid',
    components: { course: { course_id: 'c1', course_label: 'G', quantity: 1 } }, rentals: [] });
  await errS.schedulePortalRunPreviewQuote(); assert('409', /Price changed/.test(Q(errS)));
  await errS.schedulePortalRunPreviewQuote(); assert('503', /busy|Busy|wait/i.test(Q(errS)));
  await errS.schedulePortalRunPreviewQuote(); assert('generic', /Quote unavailable/.test(Q(errS)));
  await errS.schedulePortalRunPreviewQuote(); assert('recovery', /€50\.00/.test(Q(errS)));

  const mut = sandbox({ debounceMs: 5, quoteDelay: 5, total_cents: 7700 });
  mut._setPayload({ guest_name: 'M', date_from: '2026-08-20', date_to: '2026-08-20', payment_status: 'unpaid',
    components: { course: { course_id: 'c1', course_label: '€999 pack', quantity: 1, amount_cents: 99900 } },
    rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1, total_cents: 12345 }] });
  await mut.schedulePortalRunPreviewQuote();
  assert('canon', /€77\.00/.test(Q(mut)) && !/€999|12345/.test(Q(mut)));
  mut._setPayload({ guest_name: 'M', date_from: '2026-08-20', date_to: '2026-08-20', payment_status: 'unpaid',
    components: { course: { course_id: 'c1', course_label: '€1', quantity: 9, amount_cents: 100 } }, rentals: [] });
  mut.schedulePortalRenderCreateIntentSummary();
  assert('no form $', /€77\.00/.test(Q(mut)));
  mut.schedulePortalPrepareCreateOpen(null);
  assert('fresh', (!Qv(mut) || !/€77/.test(Q(mut))) && mut.schedulePortalQuoteState == null);
  mut.schedulePortalCreateAmbiguous = true;
  const prep = mut.schedulePortalPrepareCreateOpen(null);
  assert('amb', prep && prep.preserved && prep.ambiguous && !/created|BK-/i.test(S(mut) + Q(mut)));

  const sub = sandbox({ debounceMs: 5, quoteDelay: 10 });
  sub._setPayload({ guest_name: 'S', date_from: '2026-08-20', date_to: '2026-08-20', payment_status: 'unpaid',
    components: { course: { course_id: 'c1', course_label: 'G', tier_key: '1_week', quantity: 1 } }, rentals: [] });
  sub.submitScheduleManualBooking(); sub.submitScheduleManualBooking(); await sleep(80);
  assert('submit', sub._log.filter((e) => e.url.includes('/bookings?') && e.opts && e.opts.method === 'POST').length === 1);

  const corr = sandbox({ debounceMs: 5, quoteDelay: 5, total_cents: 4200 });
  corr._setPayload({ guest_name: '', date_from: '2026-08-20', date_to: '2026-08-20', payment_status: 'unpaid',
    components: { private_lesson: { enabled: true, quantity: 1, surfer_count: 1, sessions: [{ date: '', start: '10:00', end: '12:00' }] } }, rentals: [] });
  await corr.schedulePortalRunPreviewQuote();
  corr._setPayload({ guest_name: '', date_from: '2026-08-20', date_to: '2026-08-20', payment_status: 'unpaid',
    components: { private_lesson: { enabled: true, quantity: 1, surfer_count: 1, sessions: [{ date: '2026-08-20', start: '10:00', end: '12:00' }] } }, rentals: [] });
  corr.schedulePortalSyncCreateFooter();
  assert('corr1', /Checking price/.test(Q(corr)));
  await sleep(40);
  assert('corr2', corr._qn() === 1 && /€42\.00/.test(Q(corr)));

  console.log('[3] Mutation RED');
  function sandMut(src, o) {
    const s = sandbox(o); const nodes = s._nodes;
    nodes['ps-create-quote-preview'].innerHTML = ''; nodes['ps-create-quote-preview'].style.display = 'none';
    let payload = { guest_name: 'R', date_from: '2026-08-20', date_to: '2026-08-20', payment_status: 'unpaid',
      components: { course: { course_id: 'c1', course_label: 'G', quantity: 1 } }, rentals: [] }; let qn = 0;
    const ctx = {
      console, setTimeout, clearTimeout, Promise, JSON, Object, Array, Number, String, Math, Date,
      AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
      getClient: () => 'sunset', getSunsetLocation: () => 'sunset-somo', sunsetLocationQuerySuffix: () => '&location_id=sunset-somo',
      scheduleEnumerateDates: (a) => [String(a).slice(0, 10)], scheduleReadCreatePayload: () => JSON.parse(JSON.stringify(payload)),
      scheduleUpdateFullDayAddonSummary() {}, schedulePortalValidatePrivateLessonCreate: () => ({ ok: true }),
      portalT: (k) => T[k] || k, escHtml: (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      el: (id) => nodes[id] || null, closeScheduleCreateModal() {}, scheduleResetNavigationAfterBookingCreate() {},
      scheduleRequestPageLoad() {}, scheduleFindCachedRowByBookingCode() { return null; },
      fetch(url, req) {
        if (!String(url).includes('/quote')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
        const n = ++qn, delay = typeof o.quoteDelay === 'function' ? o.quoteDelay(n) : 0;
        const custom = typeof o.quoteOutcome === 'function' ? o.quoteOutcome(n) : null;
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => {
            if (req && req.signal && req.signal.aborted) { const e = new Error('a'); e.name = 'AbortError'; return reject(e); }
            if (custom) return resolve({ ok: custom.ok !== false, status: custom.status || 200, json: () => Promise.resolve(custom.body || custom) });
            resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, total_cents: 100, quote_provenance: { source: 't' } }) });
          }, delay);
          if (req && req.signal) req.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('a'); e.name = 'AbortError'; reject(e); });
        });
      },
      _setPayload(p) { payload = p; },
    };
    vm.createContext(ctx); vm.runInContext(src, ctx); return ctx;
  }
  const stripGen = portalSrc.replace(/myGen !== schedulePortalQuoteGen \|\| schedulePortalSubmitInFlight/g, 'false')
    .replace(/myGen !== schedulePortalQuoteGen/g, 'false')
    .replace(/if \(schedulePortalQuoteAbort\) \{/g, 'if (false && schedulePortalQuoteAbort) {')
    .replace(/if \(result && result\.aborted\) return result;/g, 'if (false && result && result.aborted) return result;')
    .replace(/if \(res\.aborted\) \{/g, 'if (false && res.aborted) {')
    .replace(/applyState && myGen === schedulePortalQuoteGen/g, 'applyState');
  const rGuard = sandMut(stripGen, { quoteDelay: (n) => (n === 1 ? 50 : 5), quoteOutcome: (n) => (n === 1
    ? { ok: true, body: { success: true, total_cents: 11100, quote_provenance: { source: 'OLD' } } }
    : { ok: true, body: { success: true, total_cents: 22200, quote_provenance: { source: 'NEW' } } }) });
  const g1 = rGuard.schedulePortalRunPreviewQuote(); await sleep(10);
  rGuard._setPayload({ guest_name: 'R', date_from: '2026-08-20', date_to: '2026-08-20', payment_status: 'unpaid',
    components: { course: { course_id: 'c1', course_label: 'G', quantity: 2 } }, rentals: [] });
  await Promise.all([g1, rGuard.schedulePortalRunPreviewQuote()]);
  assert('RED gen', /€111\.00/.test(String(rGuard.el('ps-create-quote-preview').innerHTML))
    || (rGuard.schedulePortalQuoteState && rGuard.schedulePortalQuoteState.total_cents === 11100));
  const rStale = sandMut(portalSrc.replace(/function schedulePortalShowQuoteChecking\(\) \{[\s\S]*?\n\}/,
    'function schedulePortalShowQuoteChecking(){ /* stripped */ }'), { quoteDelay: 40 });
  rStale.el('ps-create-quote-preview').innerHTML = 'Quoted total: €99.00';
  rStale.el('ps-create-quote-preview').style.display = 'block';
  rStale.schedulePortalSyncCreateFooter();
  assert('RED stale', /€99\.00/.test(String(rStale.el('ps-create-quote-preview').innerHTML)) && !/Checking price/.test(String(rStale.el('ps-create-quote-preview').innerHTML)));
  const qFn = extractFn(portalSrc, 'schedulePortalRenderCreateQuotePreview') || '';
  assert('no sum', /total_cents/.test(qFn) && !/amount_cents|rentals\.reduce|sumCents/.test(qFn));

  if (fail) { console.error('\nFAILED pass=' + pass + ' fail=' + fail); process.exit(1); }
  console.log('\nverify:sunset-booking-create-quote-summary — ALL CHECKS PASSED (pass=' + pass + ')\n');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
