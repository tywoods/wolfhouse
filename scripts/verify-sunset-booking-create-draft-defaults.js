'use strict';
/**
 * verify:sunset-booking-create-draft-defaults
 * Project Kaya Slice 3 — offline hostile clean-draft / context launch checks.
 * Static source + VM DOM. No DB/Azure/network/browser/deploy.
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
  const needle = `function ${name}(`;
  const start = src.indexOf(needle);
  if (start < 0) return null;
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
function count(src, needle) {
  let n = 0; let from = 0;
  while (from < src.length) {
    const i = src.indexOf(needle, from);
    if (i < 0) break;
    n += 1; from = i + needle.length;
  }
  return n;
}
function makeNode(init) {
  const n = Object.assign({
    value: '', checked: false, disabled: false, textContent: '', innerHTML: '',
    style: { display: 'none' }, classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    dataset: {}, options: [], selectedIndex: -1, _ls: {},
  }, init || {});
  n.addEventListener = function (ev, fn) { (this._ls[ev] = this._ls[ev] || []).push(fn); };
  n.dispatchEvent = function (ev) { (this._ls[ev && ev.type] || []).forEach((fn) => fn.call(this, ev)); };
  n.querySelectorAll = function () { return []; };
  n.querySelector = function () { return null; };
  n.setAttribute = function (k, v) { this['attr_' + k] = v; };
  n.getAttribute = function (k) { return this['attr_' + k] || null; };
  return n;
}
console.log('\nverify:sunset-booking-create-draft-defaults — Kaya Slice 3 clean drafts\n');
const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const portalSrc = fs.readFileSync(PORTAL_MODULE, 'utf8');
const dayOpsSrc = fs.readFileSync(DAY_OPS, 'utf8');

console.log('[1] Launch map (real call sites only)');
assert('global Create wires openScheduleCreateModal', /\[\s*['"]ps-create-booking['"]\s*,\s*openScheduleCreateModal\s*\]/.test(apiSrc));
assert('one openScheduleCreateModal definition', count(apiSrc, 'function openScheduleCreateModal(') === 1);
assert('contact path opens schedule create', /function openCreateBookingFromContact[\s\S]*?openScheduleCreateModal\s*\(/.test(apiSrc));
assert('day-ops empty-slot button has data-ps-add-slot', dayOpsSrc.includes('data-ps-add-slot'));
assert('day-ops course attr data-ps-add-course', dayOpsSrc.includes('data-ps-add-course'));
assert('day-ops launch calls openScheduleCreateModal with context', /openScheduleCreateModal\s*\(\s*\{/.test(dayOpsSrc));
assert('no private-only create launch surface in day-ops', !/openScheduleCreateModal\s*\(\s*\{[^}]*activity\s*:\s*['"]private/.test(dayOpsSrc));
assert('no rental-only create launch surface in day-ops', !/data-ps-add-rental/.test(dayOpsSrc));
assert('close surfaces share closeScheduleCreateModal',
  /\[\s*['"]ps-create-close['"]\s*,\s*closeScheduleCreateModal\s*\]/.test(apiSrc)
  && /\[\s*['"]ps-create-cancel['"]\s*,\s*closeScheduleCreateModal\s*\]/.test(apiSrc)
  && /ps-create-backdrop[\s\S]{0,200}closeScheduleCreateModal/.test(apiSrc));

console.log('\n[2] Canonical prepare/reset owner');
assert('schedulePortalPrepareCreateOpen owner', /function schedulePortalPrepareCreateOpen\s*\(/.test(portalSrc));
assert('openScheduleCreateModal calls prepare', /schedulePortalPrepareCreateOpen\s*\(/.test(extractFn(apiSrc, 'openScheduleCreateModal') || ''));
assert('prepare uses Madrid today helper', /Europe\/Madrid/.test(portalSrc) && /schedulePortalMadridTodayIso/.test(portalSrc));
assert('in-flight prepare short-circuits', /if\s*\(\s*schedulePortalSubmitInFlight\s*\)[\s\S]{0,300}return/.test(portalSrc));
assert('fresh open clears payment/guest/notes paths',
  /ps-create-payment/.test(portalSrc) && /ps-create-guest/.test(portalSrc)
  && /ps-create-notes/.test(portalSrc) && /ps-create-comp-no-lesson/.test(portalSrc));
assert('close does not clear idempotency key',
  !/function closeScheduleCreateModal[\s\S]{0,400}schedulePortalClearSubmitIdempotency/.test(apiSrc)
  && !/function closeScheduleCreateModal[\s\S]{0,400}schedulePortalSubmitIdemKey\s*=\s*null/.test(apiSrc));

console.log('\n[3–9] Hostile DOM VM');
function buildSandbox(opts) {
  opts = opts || {};
  const nodes = {};
  [
    'ps-create-modal', 'ps-create-guest', 'ps-create-phone', 'ps-create-notes', 'ps-create-payment',
    'ps-create-date-from', 'ps-create-date-to', 'ps-create-comp-course', 'ps-create-comp-private-lesson',
    'ps-create-comp-no-lesson', 'ps-create-course-select', 'ps-create-course-tier', 'ps-create-course-qty',
    'ps-create-private-lesson-qty', 'ps-create-private-lesson-surfers', 'ps-create-private-lesson-sessions',
    'ps-create-comp-fullday', 'ps-create-rentals', 'ps-create-quote-preview', 'ps-create-summary',
    'ps-create-msg', 'ps-create-submit',
  ].forEach((id) => { nodes[id] = makeNode(); });
  nodes['ps-create-comp-no-lesson'].checked = true;
  nodes['ps-create-payment'].value = 'unpaid';
  nodes['ps-create-course-qty'].value = '1';
  nodes['ps-create-private-lesson-qty'].value = '1';
  nodes['ps-create-private-lesson-surfers'].value = '1';
  nodes['ps-create-course-select'].options = [{ value: 'course-a' }, { value: 'course-b' }];
  let activeDay = opts.activeDay || '2026-07-20';
  let madridToday = opts.madridToday || '2026-07-20';
  const ctx = {
    console, setTimeout, clearTimeout, Intl, Date,
    AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
    crypto: typeof crypto !== 'undefined' ? crypto : undefined,
    getClient: () => 'sunset', getSunsetLocation: () => 'sunset-somo',
    sunsetLocationQuerySuffix: () => '&location_id=sunset-somo',
    scheduleActiveDayIso: () => activeDay, scheduleTodayIso: () => madridToday,
    scheduleEnumerateDates: (a) => [String(a).slice(0, 10)],
    scheduleOnCreateComponentChange() {
      const c = nodes['ps-create-comp-course'], p = nodes['ps-create-comp-private-lesson'], n = nodes['ps-create-comp-no-lesson'];
      if (c && c.checked) { if (p) p.checked = false; if (n) n.checked = false; }
      if (p && p.checked) { if (c) c.checked = false; if (n) n.checked = false; }
      if (n && n.checked) { if (c) c.checked = false; if (p) p.checked = false; }
    },
    schedulePopulateCreateComponentFields() {}, schedulePopulateCreateCourseFields() {},
    scheduleRenderCreateRentals() {}, scheduleRefreshCreateFullDayAddon() {},
    renderScheduleCreateSchoolContext() {}, scheduleFetchLessonTimesConfig() { return Promise.resolve({}); },
    scheduleApplyCreatePrefill() {},
    scheduleReadCreatePayload() {
      return {
        guest_name: (nodes['ps-create-guest'].value || '').trim(),
        guest_phone: (nodes['ps-create-phone'].value || '').trim(),
        date_from: nodes['ps-create-date-from'].value || null,
        date_to: nodes['ps-create-date-to'].value || null,
        payment_status: nodes['ps-create-payment'].value || 'unpaid',
        notes: (nodes['ps-create-notes'].value || '').trim(),
        components: nodes['ps-create-comp-course'].checked
          ? { course: { course_id: nodes['ps-create-course-select'].value || 'course-a', tier_key: '1_week', quantity: 1 } }
          : (nodes['ps-create-comp-private-lesson'].checked
            ? { private_lesson: { quantity: 1, sessions: [{ date: '2026-07-21', start: '10:00', end: '12:00' }] } } : {}),
        rentals: [],
      };
    },
    portalT: (k) => k, escHtml: (s) => String(s), el: (id) => nodes[id] || null,
    closeScheduleCreateModal() {
      nodes['ps-create-modal'].style.display = 'none';
      if (typeof ctx.schedulePortalInvalidatePreviewWork === 'function') ctx.schedulePortalInvalidatePreviewWork();
    },
    openScheduleCreateModal(context) {
      const prep = typeof ctx.schedulePortalPrepareCreateOpen === 'function'
        ? ctx.schedulePortalPrepareCreateOpen(context || null) : null;
      if (!prep || !prep.preserved) {
        ctx.schedulePopulateCreateComponentFields();
        ctx.renderScheduleCreateSchoolContext();
      }
      nodes['ps-create-modal'].style.display = 'flex';
      if (prep && prep.preserved) return prep;
      ctx.scheduleApplyCreatePrefill();
      return prep;
    },
    fetch() {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, total_cents: 1000, quote_provenance: { source: 't' } }) });
    },
    _nodes: nodes,
  };
  vm.createContext(ctx);
  vm.runInContext(portalSrc, ctx);
  if (typeof ctx.schedulePortalMadridTodayIso === 'function') {
    ctx.schedulePortalMadridTodayIso = function () { return madridToday; };
  }
  return ctx;
}
function contaminate(nodes) {
  nodes['ps-create-guest'].value = 'STALE GUEST';
  nodes['ps-create-phone'].value = '+34000000000';
  nodes['ps-create-notes'].value = 'stale notes';
  nodes['ps-create-payment'].value = 'paid';
  nodes['ps-create-date-from'].value = '2026-01-01';
  nodes['ps-create-date-to'].value = '2026-01-05';
  nodes['ps-create-comp-course'].checked = true;
  nodes['ps-create-comp-private-lesson'].checked = false;
  nodes['ps-create-comp-no-lesson'].checked = false;
  nodes['ps-create-course-select'].value = 'course-b';
  nodes['ps-create-course-qty'].value = '7';
  nodes['ps-create-private-lesson-qty'].value = '4';
  nodes['ps-create-private-lesson-surfers'].value = '3';
  nodes['ps-create-private-lesson-sessions'].innerHTML = '<div class="portal-schedule-private-session-row">stale</div>';
  nodes['ps-create-comp-fullday'].checked = true;
  nodes['ps-create-rentals'].innerHTML = '<label><input checked data-offering-key="board_rental"><input type="number" value="9"></label>';
  nodes['ps-create-quote-preview'].innerHTML = 'STALE QUOTE €99';
  nodes['ps-create-quote-preview'].style.display = 'block';
  nodes['ps-create-msg'].textContent = 'previous error';
  nodes['ps-create-msg'].style.display = 'block';
  nodes['ps-create-summary'].innerHTML = 'stale summary';
}

const clean = buildSandbox({ activeDay: '2026-07-22', madridToday: '2026-07-20' });
contaminate(clean._nodes);
clean.closeScheduleCreateModal();
const prepClean = clean.openScheduleCreateModal(null);
assert('prepare not preserved on clean open', !prepClean || prepClean.preserved !== true);
assert('guest/phone/notes cleared', clean._nodes['ps-create-guest'].value === '' && clean._nodes['ps-create-phone'].value === '' && clean._nodes['ps-create-notes'].value === '');
assert('payment unpaid', clean._nodes['ps-create-payment'].value === 'unpaid');
assert('No lesson default', clean._nodes['ps-create-comp-no-lesson'].checked === true && !clean._nodes['ps-create-comp-course'].checked && !clean._nodes['ps-create-comp-private-lesson'].checked);
assert('qtys reset', clean._nodes['ps-create-course-qty'].value === '1' && clean._nodes['ps-create-private-lesson-qty'].value === '1' && clean._nodes['ps-create-private-lesson-surfers'].value === '1');
assert('private sessions + rentals + full-day cleared',
  clean._nodes['ps-create-private-lesson-sessions'].innerHTML === ''
  && clean._nodes['ps-create-rentals'].innerHTML === ''
  && clean._nodes['ps-create-comp-fullday'].checked === false);
assert('quote/error cleared',
  (clean._nodes['ps-create-quote-preview'].innerHTML === '' || clean._nodes['ps-create-quote-preview'].style.display === 'none')
  && (clean._nodes['ps-create-msg'].textContent === '' || clean._nodes['ps-create-msg'].style.display === 'none'));
assert('date from=to viewed nonpast day', clean._nodes['ps-create-date-from'].value === '2026-07-22' && clean._nodes['ps-create-date-to'].value === '2026-07-22');

const pastView = buildSandbox({ activeDay: '2026-07-10', madridToday: '2026-07-20' });
contaminate(pastView._nodes);
pastView.openScheduleCreateModal(null);
assert('past viewed day clamps to Madrid today', pastView._nodes['ps-create-date-from'].value === '2026-07-20' && pastView._nodes['ps-create-date-to'].value === '2026-07-20');
const todayView = buildSandbox({ activeDay: '2026-07-20', madridToday: '2026-07-20' });
todayView.openScheduleCreateModal(null);
assert('today viewed day accepted', todayView._nodes['ps-create-date-from'].value === '2026-07-20');
const futureView = buildSandbox({ activeDay: '2026-08-01', madridToday: '2026-07-20' });
futureView.openScheduleCreateModal(null);
assert('future viewed day accepted', futureView._nodes['ps-create-date-from'].value === '2026-08-01');

const slot = buildSandbox({ activeDay: '2026-07-25', madridToday: '2026-07-20' });
contaminate(slot._nodes);
slot.openScheduleCreateModal({ activity: 'group', course_id: 'course-a', date_from: '2026-07-25', date_to: '2026-07-25' });
assert('slot wiped PII/paid/notes', slot._nodes['ps-create-guest'].value === '' && slot._nodes['ps-create-payment'].value === 'unpaid' && slot._nodes['ps-create-notes'].value === '');
assert('slot group + dates', slot._nodes['ps-create-comp-course'].checked === true && slot._nodes['ps-create-date-from'].value === '2026-07-25' && slot._nodes['ps-create-date-to'].value === '2026-07-25');
assert('pending course id', slot.schedulePortalPendingCourseId === 'course-a' || slot._nodes['ps-create-course-select'].value === 'course-a');
if (typeof slot.schedulePortalConsumePendingCourseSelect === 'function') slot.schedulePortalConsumePendingCourseSelect();
assert('course id applied after consume', slot._nodes['ps-create-course-select'].value === 'course-a');
assert('slot cleared rental residue', slot._nodes['ps-create-rentals'].innerHTML === '');

const cycle = buildSandbox({ activeDay: '2026-07-22', madridToday: '2026-07-20' });
cycle.openScheduleCreateModal(null);
cycle._nodes['ps-create-guest'].value = 'GlobalUser';
cycle._nodes['ps-create-payment'].value = 'paid';
cycle.closeScheduleCreateModal();
cycle.openScheduleCreateModal({ activity: 'group', course_id: 'course-b', date_from: '2026-07-22', date_to: '2026-07-22' });
assert('slot after global clean+group', cycle._nodes['ps-create-guest'].value === '' && cycle._nodes['ps-create-payment'].value === 'unpaid' && cycle._nodes['ps-create-comp-course'].checked === true);
cycle._nodes['ps-create-guest'].value = 'SlotUser';
cycle._nodes['ps-create-notes'].value = 'from slot';
cycle.closeScheduleCreateModal();
cycle.openScheduleCreateModal(null);
assert('global after slot clean+No lesson', cycle._nodes['ps-create-guest'].value === '' && cycle._nodes['ps-create-notes'].value === '' && cycle._nodes['ps-create-comp-no-lesson'].checked === true && !cycle._nodes['ps-create-comp-course'].checked);

const onChange = extractFn(apiSrc, 'scheduleOnCreateComponentChange') || '';
assert('activity change does not clear rentals', !/ps-create-rentals[\s\S]{0,80}innerHTML\s*=\s*['"]['"]/.test(onChange));
const gear = buildSandbox();
gear._nodes['ps-create-rentals'].innerHTML = '<label data-gear="1">board</label>';
gear.scheduleOnCreateComponentChange('ps-create-comp-course');
assert('gear preserved same open', gear._nodes['ps-create-rentals'].innerHTML.indexOf('data-gear') >= 0);
gear.openScheduleCreateModal(null);
assert('fresh open clears gear', gear._nodes['ps-create-rentals'].innerHTML === '');

const mid = buildSandbox();
contaminate(mid._nodes);
mid.schedulePortalSubmitInFlight = true;
mid.schedulePortalSubmitIdemKey = 'held-key-abc';
mid.schedulePortalSubmitIdemIntent = 'intent-1';
mid._nodes['ps-create-submit'].disabled = true;
mid._nodes['ps-create-guest'].value = 'InFlight Guest';
mid.closeScheduleCreateModal();
const midPrep = mid.openScheduleCreateModal(null);
assert('in-flight reopen preserved', midPrep && midPrep.preserved === true);
assert('in-flight form+key+lock', mid._nodes['ps-create-guest'].value === 'InFlight Guest' && mid._nodes['ps-create-payment'].value === 'paid' && mid.schedulePortalSubmitIdemKey === 'held-key-abc' && mid._nodes['ps-create-submit'].disabled === true);
mid.submitScheduleManualBooking();
assert('duplicate submit suppressed', mid.schedulePortalSubmitInFlight === true);

const lost = buildSandbox();
lost._nodes['ps-create-guest'].value = 'Retry Guest';
lost._nodes['ps-create-comp-course'].checked = true;
lost._nodes['ps-create-comp-no-lesson'].checked = false;
lost._nodes['ps-create-date-from'].value = '2026-07-20';
lost._nodes['ps-create-date-to'].value = '2026-07-20';
const k1 = lost.schedulePortalEnsureIdempotencyKey(lost.scheduleReadCreatePayload());
assert('idem key minted', typeof k1 === 'string' && k1.length > 8);
lost.schedulePortalSubmitInFlight = false;
lost.schedulePortalSubmitIdemKey = k1;
lost.schedulePortalSubmitIdemIntent = lost.schedulePortalCreateIntentKey(lost.scheduleReadCreatePayload());
assert('response-loss retry reuses key', lost.schedulePortalEnsureIdempotencyKey(lost.scheduleReadCreatePayload()) === k1);
lost.schedulePortalClearSubmitIdempotency();
contaminate(lost._nodes);
lost.openScheduleCreateModal(null);
assert('post-success-style fresh open clean', lost._nodes['ps-create-guest'].value === '' && lost._nodes['ps-create-payment'].value === 'unpaid' && lost.schedulePortalSubmitIdemKey == null);

const q = buildSandbox();
const genBefore = q.schedulePortalQuoteGen;
q.schedulePortalInvalidatePreviewWork();
assert('invalidate bumps gen', q.schedulePortalQuoteGen > genBefore);
const staleGen = q.schedulePortalQuoteGen;
q.openScheduleCreateModal(null);
assert('fresh open bumps gen + clears quote', q.schedulePortalQuoteGen > staleGen && q.schedulePortalQuoteState == null);
q.schedulePortalQuoteState = { total_cents: 1, gen: 0 };
q.openScheduleCreateModal(null);
assert('stale quote cannot stick after prepare', q.schedulePortalQuoteState == null
  && (q._nodes['ps-create-quote-preview'].innerHTML === '' || q._nodes['ps-create-quote-preview'].style.display === 'none'));

console.log('\n[10] Close surfaces + day-ops context shape');
const closeSrc = extractFn(apiSrc, 'closeScheduleCreateModal') || '';
assert('close hides + invalidates only', /display\s*=\s*['"]none['"]/.test(closeSrc) && /schedulePortalInvalidatePreviewWork/.test(closeSrc));
assert('close does not prepare/clear draft', !/schedulePortalPrepareCreateOpen|schedulePortalClearCreateDraft|ps-create-guest/.test(closeSrc));
assert('day-ops activity group + course_id + date',
  /activity\s*:\s*['"]group['"]/.test(dayOpsSrc)
  && /course_id/.test(dayOpsSrc)
  && /getAttribute\(\s*['"]data-ps-add-course['"]\s*\)/.test(dayOpsSrc)
  && /scheduleActiveDayIso/.test(dayOpsSrc)
  && /date_from/.test(dayOpsSrc));
assert('slot_key not fabricated into time field', !/ps-create-time|slot_time|lesson_time/.test(dayOpsSrc));

console.log(`\n── verify:sunset-booking-create-draft-defaults ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
process.exit(fail ? 1 : 0);
