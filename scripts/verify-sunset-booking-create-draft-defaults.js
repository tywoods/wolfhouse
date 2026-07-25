'use strict';
/**
 * verify:sunset-booking-create-draft-defaults — Kaya Slice 3 offline clean-draft checks.
 * Real open/close/prepare/submit + delayed quote/create. No network.
 * Run: node scripts/verify-sunset-booking-create-draft-defaults.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PORTAL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');
const DAY_OPS = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-day-ops-board-ui.js');
let pass = 0; let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}
function extractFn(src, name) {
  const needle = `function ${name}(`; const start = src.indexOf(needle);
  if (start < 0) return null;
  const brace = src.indexOf('{', start); let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
function wireNode(n) {
  n.addEventListener = function (ev, fn) { (this._ls[ev] = this._ls[ev] || []).push(fn); };
  n.dispatchEvent = function (ev) { (this._ls[ev && ev.type] || []).forEach((fn) => fn.call(this, ev)); };
  n.querySelectorAll = function () { return []; }; n.querySelector = function () { return null; };
  n.setAttribute = function (k, v) { this['attr_' + k] = v; };
  n.getAttribute = function (k) { return this['attr_' + k] || null; };
  return n;
}
function makeSelect() {
  const n = wireNode({ options: [], style: {}, classList: { add() {}, remove() {} }, dataset: {}, _ls: {}, textContent: '', disabled: false });
  let _val = '';
  Object.defineProperty(n, 'value', {
    get() { return _val; },
    set(v) {
      const s = String(v == null ? '' : v); if (s === '') { _val = ''; return; }
      const opts = n.options || []; if (!opts.length) { _val = ''; return; }
      _val = opts.some((o) => String(o.value) === s) ? s : String(opts[0].value);
    },
  });
  Object.defineProperty(n, 'innerHTML', {
    get() { return n._html || ''; },
    set(html) {
      n._html = String(html || ''); const opts = []; const re = /<option[^>]*value="([^"]*)"[^>]*>/g; let m;
      while ((m = re.exec(n._html))) opts.push({ value: m[1] });
      n.options = opts; if (_val && !opts.some((o) => o.value === _val)) _val = '';
    },
  });
  return n;
}
function makeNode(init) {
  return wireNode(Object.assign({
    value: '', checked: false, disabled: false, textContent: '', innerHTML: '',
    style: { display: 'none' }, classList: { add() {}, remove() {}, contains() { return false; } },
    dataset: {}, options: [], _ls: {},
  }, init || {}));
}

console.log('\nverify:sunset-booking-create-draft-defaults — Kaya Slice 3\n');
const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const portalSrc = fs.readFileSync(PORTAL_MODULE, 'utf8');
const dayOpsSrc = fs.readFileSync(DAY_OPS, 'utf8');

console.log('[1] Launch map + owners');
const openSrc = extractFn(apiSrc, 'openScheduleCreateModal') || '';
const closeSrc = extractFn(apiSrc, 'closeScheduleCreateModal') || '';
assert('global wrapper + one open + contact + day-ops',
  /\[\s*['"]ps-create-booking['"]\s*,\s*function\s*\(\s*\)\s*\{\s*openScheduleCreateModal\s*\(\s*null\s*\)\s*;\s*\}\s*\]/.test(apiSrc)
  && (apiSrc.split('function openScheduleCreateModal(').length - 1) === 1
  && /function openCreateBookingFromContact[\s\S]*?openScheduleCreateModal\s*\(/.test(apiSrc)
  && dayOpsSrc.includes('data-ps-add-slot') && dayOpsSrc.includes('data-ps-add-course') && /openScheduleCreateModal\s*\(\s*\{/.test(dayOpsSrc)
  && !/openScheduleCreateModal\s*\(\s*\{[^}]*activity\s*:\s*['"]private/.test(dayOpsSrc) && !/data-ps-add-rental/.test(dayOpsSrc));
assert('close surfaces + prepare/sanitize/ambiguous/desired',
  /\[\s*['"]ps-create-close['"]\s*,\s*closeScheduleCreateModal\s*\]/.test(apiSrc)
  && /\[\s*['"]ps-create-cancel['"]\s*,\s*closeScheduleCreateModal\s*\]/.test(apiSrc)
  && /ps-create-backdrop[\s\S]{0,200}closeScheduleCreateModal/.test(apiSrc)
  && /schedulePortalPrepareCreateOpen/.test(openSrc) && /schedulePortalSanitizeCreateLaunchContext/.test(portalSrc)
  && /schedulePortalCanonicalDateIso/.test(portalSrc) && /schedulePortalCreateAmbiguous/.test(portalSrc)
  && /schedulePortalApplyDesiredCourseSelect/.test(portalSrc) && /Europe\/Madrid/.test(portalSrc)
  && /schedulePortalSubmitInFlight\s*\|\|\s*schedulePortalCreateAmbiguous/.test(portalSrc)
  && /function schedulePortalPopulateCreateCourseFields[\s\S]*schedulePortalApplyDesiredCourseSelect/.test(portalSrc)
  && !/schedulePortalClearSubmitIdempotency|schedulePortalSubmitIdemKey\s*=\s*null/.test(closeSrc));

console.log('\n[2] Hostile DOM — real open/close/submit');
function buildSandbox(opts) {
  opts = opts || {};
  const nodes = {};
  ['ps-create-modal', 'ps-create-guest', 'ps-create-phone', 'ps-create-notes', 'ps-create-payment',
    'ps-create-date-from', 'ps-create-date-to', 'ps-create-comp-course', 'ps-create-comp-private-lesson',
    'ps-create-comp-no-lesson', 'ps-create-course-tier', 'ps-create-course-qty', 'ps-create-private-lesson-qty',
    'ps-create-private-lesson-surfers', 'ps-create-private-lesson-sessions', 'ps-create-comp-fullday',
    'ps-create-rentals', 'ps-create-quote-preview', 'ps-create-summary', 'ps-create-msg', 'ps-create-submit',
    'ps-create-booking'].forEach((id) => { nodes[id] = makeNode(); });
  nodes['ps-create-course-select'] = makeSelect();
  nodes['ps-create-comp-no-lesson'].checked = true;
  nodes['ps-create-payment'].value = 'unpaid';
  nodes['ps-create-course-qty'].value = '1';
  nodes['ps-create-private-lesson-qty'].value = '1';
  nodes['ps-create-private-lesson-surfers'].value = '1';
  let activeDay = opts.activeDay || '2026-07-20';
  let madridToday = opts.madridToday || '2026-07-20';
  const ctx = {
    console, setTimeout, clearTimeout, Intl, Date, Promise,
    AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
    crypto: { randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2, 10) },
    Event: function Event(type) { this.type = type; this.preventDefault = function () {}; this.stopPropagation = function () {}; },
    getClient: () => 'sunset', getSunsetLocation: () => 'sunset-somo',
    sunsetLocationQuerySuffix: () => '&location_id=sunset-somo',
    scheduleActiveDayIso: () => activeDay, scheduleTodayIso: () => madridToday,
    scheduleEnumerateDates: (a) => [String(a).slice(0, 10)],
    scheduleCreateSelectedDates: () => [String(nodes['ps-create-date-from'].value || madridToday).slice(0, 10)],
    scheduleOnCreateComponentChange(id) {
      const c = nodes['ps-create-comp-course'], p = nodes['ps-create-comp-private-lesson'], n = nodes['ps-create-comp-no-lesson'];
      if (id === 'ps-create-comp-course' && c && c.checked) { if (p) p.checked = false; if (n) n.checked = false; }
      if (id === 'ps-create-comp-private-lesson' && p && p.checked) { if (c) c.checked = false; if (n) n.checked = false; }
      if (id === 'ps-create-comp-no-lesson' && n && n.checked) { if (c) c.checked = false; if (p) p.checked = false; }
      if (c && c.checked && typeof ctx.schedulePopulateCreateCourseFields === 'function') ctx.schedulePopulateCreateCourseFields();
    },
    schedulePopulateCreateComponentFields() {
      if (nodes['ps-create-comp-course'] && nodes['ps-create-comp-course'].checked) ctx.schedulePopulateCreateCourseFields();
    },
    schedulePopulateCreateCourseFields() {
      return typeof ctx.schedulePortalPopulateCreateCourseFields === 'function' ? ctx.schedulePortalPopulateCreateCourseFields() : Promise.resolve();
    },
    schedulePopulateCreateCourseTierFields() {}, scheduleRenderCreateRentals() {}, scheduleRefreshCreateFullDayAddon() {},
    renderScheduleCreateSchoolContext() {}, scheduleFetchLessonTimesConfig() { return Promise.resolve({}); },
    scheduleApplyCreatePrefill() {
      const pf = ctx.psPendingCreatePrefill; if (!pf) return;
      nodes['ps-create-guest'].value = pf.name || ''; nodes['ps-create-phone'].value = pf.phone || '';
      if (pf.staff_notes) nodes['ps-create-notes'].value = pf.staff_notes; ctx.psPendingCreatePrefill = null;
    },
    scheduleReadCreatePayload() {
      const course = nodes['ps-create-comp-course'].checked;
      return {
        guest_name: (nodes['ps-create-guest'].value || '').trim(), guest_phone: (nodes['ps-create-phone'].value || '').trim(),
        date_from: nodes['ps-create-date-from'].value || null, date_to: nodes['ps-create-date-to'].value || null,
        payment_status: nodes['ps-create-payment'].value || 'unpaid', notes: (nodes['ps-create-notes'].value || '').trim(),
        components: course ? { course: { course_id: nodes['ps-create-course-select'].value || 'course-a', tier_key: '1_week', quantity: 1 } } : {},
        rentals: [],
      };
    },
    scheduleResetNavigationAfterBookingCreate() {}, scheduleRequestPageLoad() {}, scheduleFindCachedRowByBookingCode() { return null; },
    portalT: (k) => k, escHtml: (s) => String(s), el: (id) => nodes[id] || null, psPendingCreatePrefill: null,
    fetch(url, init) {
      const u = String(url || ''); const method = (init && init.method) || 'GET';
      if (opts.fetchPlan) return opts.fetchPlan({ url: u, method, init });
      const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      if (u.indexOf('/catalog') >= 0) return ok({ success: true, courses: [{ course_id: 'course-a', label: 'A' }, { course_id: 'course-b', label: 'B' }] });
      if (u.indexOf('/quote') >= 0) return ok({ success: true, total_cents: 1000, quote_provenance: { source: 't' } });
      if (method === 'POST' && u.indexOf('/bookings') >= 0) return ok({ success: true, booking_code: 'BK-1' });
      return ok({ success: true });
    },
    _nodes: nodes,
  };
  vm.createContext(ctx); vm.runInContext(portalSrc, ctx);
  if (openSrc) vm.runInContext(openSrc + '\nthis.openScheduleCreateModal=openScheduleCreateModal;', ctx);
  if (closeSrc) vm.runInContext(closeSrc + '\nthis.closeScheduleCreateModal=closeScheduleCreateModal;', ctx);
  if (typeof ctx.schedulePortalMadridTodayIso === 'function') ctx.schedulePortalMadridTodayIso = function () { return madridToday; };
  nodes['ps-create-booking'].addEventListener('click', function () { ctx.openScheduleCreateModal(null); });
  return ctx;
}
function contaminate(nodes) {
  Object.assign(nodes['ps-create-guest'], { value: 'STALE GUEST' });
  nodes['ps-create-phone'].value = '+34000000000'; nodes['ps-create-notes'].value = 'stale notes';
  nodes['ps-create-payment'].value = 'paid'; nodes['ps-create-date-from'].value = '2026-01-01';
  nodes['ps-create-date-to'].value = '2026-01-05'; nodes['ps-create-comp-course'].checked = true;
  nodes['ps-create-comp-private-lesson'].checked = false; nodes['ps-create-comp-no-lesson'].checked = false;
  nodes['ps-create-course-select'].options = [{ value: 'course-a' }, { value: 'course-b' }];
  nodes['ps-create-course-select'].value = 'course-b'; nodes['ps-create-course-qty'].value = '7';
  nodes['ps-create-private-lesson-qty'].value = '4'; nodes['ps-create-private-lesson-surfers'].value = '3';
  nodes['ps-create-private-lesson-sessions'].innerHTML = '<div>stale</div>';
  nodes['ps-create-comp-fullday'].checked = true; nodes['ps-create-rentals'].innerHTML = '<label data-gear="1">board</label>';
  nodes['ps-create-quote-preview'].innerHTML = 'STALE'; nodes['ps-create-quote-preview'].style.display = 'block';
  nodes['ps-create-msg'].textContent = 'err'; nodes['ps-create-msg'].style.display = 'block';
  nodes['ps-create-summary'].innerHTML = 'stale';
}
const flush = (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : ms));

async function run() {
  const clean = buildSandbox({ activeDay: '2026-07-22', madridToday: '2026-07-20' });
  contaminate(clean._nodes); clean.closeScheduleCreateModal(); clean.openScheduleCreateModal(null); await flush();
  assert('clean open clears PII/paid/No lesson/gear/quote + viewed date',
    clean._nodes['ps-create-guest'].value === '' && clean._nodes['ps-create-payment'].value === 'unpaid'
    && clean._nodes['ps-create-comp-no-lesson'].checked && !clean._nodes['ps-create-comp-course'].checked
    && clean._nodes['ps-create-rentals'].innerHTML === '' && clean._nodes['ps-create-date-from'].value === '2026-07-22'
    && (clean._nodes['ps-create-quote-preview'].innerHTML === '' || clean._nodes['ps-create-quote-preview'].style.display === 'none'));

  const evSb = buildSandbox({ activeDay: '2026-07-22', madridToday: '2026-07-20' });
  contaminate(evSb._nodes);
  const fakeEv = new evSb.Event('click'); fakeEv.date_from = '2026-07-25'; fakeEv.activity = 'group'; fakeEv.course_id = 'course-a';
  evSb.openScheduleCreateModal(fakeEv); await flush();
  assert('Event props never applied as context', evSb._nodes['ps-create-comp-no-lesson'].checked && evSb._nodes['ps-create-date-from'].value === '2026-07-22');
  contaminate(evSb._nodes); evSb._nodes['ps-create-booking'].dispatchEvent({ type: 'click' }); await flush();
  assert('global click wrapper clean defaults', evSb._nodes['ps-create-guest'].value === '' && evSb._nodes['ps-create-comp-no-lesson'].checked);

  for (const [day, want, lab] of [
    ['2026-07-10', '2026-07-20', 'past viewed clamps'],
    ['2026-07-20', '2026-07-20', 'today viewed'],
    ['2026-08-01', '2026-08-01', 'future viewed'],
  ]) {
    const s = buildSandbox({ activeDay: day, madridToday: '2026-07-20' });
    s.openScheduleCreateModal(null); await flush();
    assert(lab, s._nodes['ps-create-date-from'].value === want);
  }

  const d = buildSandbox({ activeDay: '2026-07-22', madridToday: '2026-07-20' });
  async function discarded(ctx) {
    d.openScheduleCreateModal(ctx); await flush();
    return !d._nodes['ps-create-comp-course'].checked && d._nodes['ps-create-date-from'].value === '2026-07-22';
  }
  assert('impossible month discards', await discarded({ activity: 'group', course_id: 'course-a', date_from: '2026-13-99', date_to: '2026-13-99' }));
  assert('impossible day discards', await discarded({ activity: 'group', course_id: 'course-a', date_from: '2026-02-31', date_to: '2026-02-31' }));
  assert('past explicit discards', await discarded({ activity: 'group', course_id: 'course-a', date_from: '2026-07-10', date_to: '2026-07-10' }));
  assert('inverted discards', await discarded({ activity: 'group', course_id: 'course-a', date_from: '2026-07-25', date_to: '2026-07-20' }));
  assert('malformed discards', await discarded({ activity: 'group', course_id: 'course-a', date_from: 'bad', date_to: 'x' }));
  d.openScheduleCreateModal({ activity: 'group', course_id: 'course-a', date_from: '2026-07-20', date_to: '2026-07-20' }); await flush();
  assert('valid today accepted', d._nodes['ps-create-comp-course'].checked && d._nodes['ps-create-date-from'].value === '2026-07-20');
  d.openScheduleCreateModal({ activity: 'group', course_id: 'course-a', date_from: '2026-07-25', date_to: '2026-07-25' }); await flush();
  assert('valid future accepted', d._nodes['ps-create-comp-course'].checked && d._nodes['ps-create-date-from'].value === '2026-07-25');

  let releaseCold; let releaseWarm; let catN = 0;
  const coldP = new Promise((r) => { releaseCold = r; });
  const warmP = new Promise((r) => { releaseWarm = r; });
  const race = buildSandbox({
    activeDay: '2026-07-25', madridToday: '2026-07-20',
    fetchPlan({ url }) {
      if (String(url).indexOf('/catalog') >= 0) {
        catN += 1; const n = catN; const gate = n === 1 ? coldP : warmP;
        const courses = n === 1 ? [] : [{ course_id: 'course-a', label: 'A' }, { course_id: 'course-b', label: 'B' }];
        return gate.then(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, courses }) }));
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
    },
  });
  race.openScheduleCreateModal({ activity: 'group', course_id: 'course-a', date_from: '2026-07-25', date_to: '2026-07-25' });
  assert('desired course before catalog', race.schedulePortalPendingCourseId === 'course-a');
  releaseCold(); await flush(5);
  assert('cold keeps pending, no false select', race.schedulePortalPendingCourseId === 'course-a' && race._nodes['ps-create-course-select'].value !== 'course-a');
  releaseWarm(); await flush(10);
  assert('warm selects clicked course', race._nodes['ps-create-course-select'].value === 'course-a');
  const staleGen = race.schedulePortalOpenGen;
  race.openScheduleCreateModal(null); await flush(5);
  assert('fresh open invalidates desired', race.schedulePortalOpenGen > staleGen && !race.schedulePortalPendingCourseId && !race._nodes['ps-create-comp-course'].checked);

  const slot = buildSandbox({ activeDay: '2026-07-25', madridToday: '2026-07-20' });
  contaminate(slot._nodes);
  slot.openScheduleCreateModal({ activity: 'group', course_id: 'course-a', date_from: '2026-07-25', date_to: '2026-07-25' }); await flush(5);
  assert('slot clean+group+course', slot._nodes['ps-create-guest'].value === '' && slot._nodes['ps-create-payment'].value === 'unpaid'
    && slot._nodes['ps-create-comp-course'].checked && slot._nodes['ps-create-course-select'].value === 'course-a');

  const contact = buildSandbox({ activeDay: '2026-07-22', madridToday: '2026-07-20' });
  contaminate(contact._nodes);
  contact.psPendingCreatePrefill = { name: 'Contact Name', phone: '+34999', staff_notes: 'crm' };
  contact.openScheduleCreateModal(null); await flush(5);
  assert('contact prefill survives async', contact._nodes['ps-create-guest'].value === 'Contact Name' && contact._nodes['ps-create-phone'].value === '+34999');

  const gear = buildSandbox();
  gear._nodes['ps-create-rentals'].innerHTML = '<label data-gear="1">board</label>';
  gear.scheduleOnCreateComponentChange('ps-create-comp-course');
  assert('gear same-open preserved', gear._nodes['ps-create-rentals'].innerHTML.indexOf('data-gear') >= 0);
  gear.openScheduleCreateModal(null); await flush();
  assert('fresh open clears gear', gear._nodes['ps-create-rentals'].innerHTML === '');

  const mid = buildSandbox(); contaminate(mid._nodes);
  mid.schedulePortalSubmitInFlight = true; mid.schedulePortalSubmitIdemKey = 'held-key-abc';
  mid.schedulePortalSubmitIdemIntent = 'intent-1'; mid._nodes['ps-create-submit'].disabled = true;
  mid._nodes['ps-create-guest'].value = 'InFlight Guest';
  mid.closeScheduleCreateModal(); mid.openScheduleCreateModal(null); await flush();
  assert('in-flight preserve + no second POST', mid._nodes['ps-create-guest'].value === 'InFlight Guest'
    && mid.schedulePortalSubmitIdemKey === 'held-key-abc' && mid._nodes['ps-create-submit'].disabled === true);
  mid.submitScheduleManualBooking();
  let createCalls = 0; let stage = 'fail'; let releaseCreateFail; let releaseCreateOk;
  const createFailP = new Promise((_, rej) => { releaseCreateFail = () => rej(new Error('network lost')); });
  const createOkP = new Promise((res) => { releaseCreateOk = res; });
  const amb = buildSandbox({
    madridToday: '2026-07-20', activeDay: '2026-07-20',
    fetchPlan({ url, method, init }) {
      const u = String(url || '');
      if (u.indexOf('/catalog') >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, courses: [{ course_id: 'course-a', label: 'A' }] }) });
      if (u.indexOf('/quote') >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, total_cents: 1000, quote_provenance: { source: 't' } }) });
      if (method === 'POST' && u.indexOf('/bookings') >= 0 && u.indexOf('/quote') < 0) {
        createCalls += 1; const body = init && init.body ? JSON.parse(init.body) : {};
        if (stage === 'fail') return createFailP;
        return createOkP.then(() => { amb._lastCreateBody = body; return { ok: true, status: 200, json: () => Promise.resolve({ success: true, booking_code: 'BK-RETRY' }) }; });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
    },
  });
  amb.openScheduleCreateModal(null); await flush(5);
  amb._nodes['ps-create-guest'].value = 'Retry Guest'; amb._nodes['ps-create-comp-course'].checked = true;
  amb._nodes['ps-create-comp-no-lesson'].checked = false;
  amb._nodes['ps-create-date-from'].value = '2026-07-20'; amb._nodes['ps-create-date-to'].value = '2026-07-20';
  amb._nodes['ps-create-course-select'].options = [{ value: 'course-a' }]; amb._nodes['ps-create-course-select'].value = 'course-a';
  amb._nodes['ps-create-payment'].value = 'paid';
  const kAmb = amb.schedulePortalEnsureIdempotencyKey(amb.scheduleReadCreatePayload());
  amb.submitScheduleManualBooking(); await flush(5); releaseCreateFail(); await flush(15);
  assert('ambiguous after create reject', amb.schedulePortalCreateAmbiguous === true && amb.schedulePortalSubmitIdemKey === kAmb && !amb._nodes['ps-create-submit'].disabled);
  amb.closeScheduleCreateModal();
  amb.openScheduleCreateModal({ activity: 'group', course_id: 'course-b', date_from: '2026-07-25', date_to: '2026-07-25' }); await flush();
  assert('ambiguous reopen exact draft+key', amb.schedulePortalCreateAmbiguous === true && amb._nodes['ps-create-guest'].value === 'Retry Guest'
    && amb._nodes['ps-create-payment'].value === 'paid' && amb.schedulePortalSubmitIdemKey === kAmb
    && amb._nodes['ps-create-date-from'].value === '2026-07-20' && amb._nodes['ps-create-course-select'].value === 'course-a');
  stage = 'ok'; createCalls = 0;
  amb.submitScheduleManualBooking(); await flush(5); releaseCreateOk(); await flush(20);
  assert('retry same key then clean open', createCalls === 1 && amb._lastCreateBody && amb._lastCreateBody.idempotency_key === kAmb
    && !amb.schedulePortalCreateAmbiguous && amb.schedulePortalSubmitIdemKey == null);
  contaminate(amb._nodes); amb.openScheduleCreateModal(null); await flush();
  assert('post-success fresh open clean', amb._nodes['ps-create-guest'].value === '' && amb._nodes['ps-create-payment'].value === 'unpaid');

  const qf = buildSandbox({
    madridToday: '2026-07-20',
    fetchPlan({ url }) {
      if (String(url).indexOf('/quote') >= 0) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ success: false, error: 'quote down' }) });
      if (String(url).indexOf('/catalog') >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, courses: [{ course_id: 'course-a', label: 'A' }] }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
    },
  });
  qf.openScheduleCreateModal(null); await flush();
  qf._nodes['ps-create-guest'].value = 'QuoteFail Guest'; qf._nodes['ps-create-comp-course'].checked = true;
  qf._nodes['ps-create-comp-no-lesson'].checked = false;
  qf._nodes['ps-create-date-from'].value = '2026-07-20'; qf._nodes['ps-create-date-to'].value = '2026-07-20';
  qf._nodes['ps-create-course-select'].options = [{ value: 'course-a' }]; qf._nodes['ps-create-course-select'].value = 'course-a';
  qf.submitScheduleManualBooking(); await flush(20);
  assert('quote failure not ambiguous', qf.schedulePortalCreateAmbiguous !== true);
  qf.closeScheduleCreateModal(); qf.openScheduleCreateModal(null); await flush();
  assert('quote-fail reopen may clean', qf._nodes['ps-create-guest'].value === '');

  let releaseStaleQuote; let quoteN = 0;
  const staleQuoteP = new Promise((res) => { releaseStaleQuote = res; });
  const q = buildSandbox({
    madridToday: '2026-07-20',
    fetchPlan({ url }) {
      if (String(url).indexOf('/quote') >= 0) {
        quoteN += 1;
        if (quoteN === 1) {
          return staleQuoteP.then(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, total_cents: 99999, quote_provenance: { source: 'STALE' } }) }));
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, total_cents: 1000, quote_provenance: { source: 'fresh' } }) });
      }
      if (String(url).indexOf('/catalog') >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, courses: [] }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
    },
  });
  q.openScheduleCreateModal(null); await flush();
  q._nodes['ps-create-guest'].value = 'Q'; q._nodes['ps-create-comp-course'].checked = true; q._nodes['ps-create-comp-no-lesson'].checked = false;
  q._nodes['ps-create-date-from'].value = '2026-07-20'; q._nodes['ps-create-date-to'].value = '2026-07-20';
  const genAtStart = q.schedulePortalQuoteGen;
  const delayed = q.schedulePortalFetchQuote(q.scheduleReadCreatePayload(), { gen: genAtStart, applyState: true });
  q.closeScheduleCreateModal(); q.openScheduleCreateModal(null); await flush();
  releaseStaleQuote(); await delayed.catch(() => null); await flush(5);
  assert('stale delayed quote cannot render after fresh open',
    (q.schedulePortalQuoteState == null || (q.schedulePortalQuoteState && q.schedulePortalQuoteState.gen === q.schedulePortalQuoteGen))
    && (q._nodes['ps-create-quote-preview'].innerHTML === '' || q._nodes['ps-create-quote-preview'].style.display === 'none'
      || String(q._nodes['ps-create-quote-preview'].innerHTML).indexOf('99999') < 0));

  console.log('\n[3] Close + day-ops');
  assert('close hides+invalidates only', /display\s*=\s*['"]none['"]/.test(closeSrc) && /schedulePortalInvalidatePreviewWork/.test(closeSrc)
    && !/schedulePortalPrepareCreateOpen|schedulePortalClearCreateDraft|ps-create-guest/.test(closeSrc));
  assert('day-ops group+course+date no time field', /activity\s*:\s*['"]group['"]/.test(dayOpsSrc) && /course_id/.test(dayOpsSrc)
    && /getAttribute\(\s*['"]data-ps-add-course['"]\s*\)/.test(dayOpsSrc) && /scheduleActiveDayIso/.test(dayOpsSrc)
    && /date_from/.test(dayOpsSrc) && !/ps-create-time|slot_time|lesson_time/.test(dayOpsSrc));

  console.log(`\n── verify:sunset-booking-create-draft-defaults ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
}
run().catch((err) => { console.error(err); process.exit(1); });
