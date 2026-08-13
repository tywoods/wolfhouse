'use strict';
/* verify:sunset-booking-create-when-sessions — date-range-derived private sessions */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const { collectPortalFunctions, slicePortalFunction } = require('./lib/portal-fn-slice');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
const portalUiSrc = readStaffPortalUiSource();
let pass = 0, fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); pass += 1; }
  else { console.error('  FAIL  ' + label + (detail ? ' — ' + detail : '')); fail += 1; }
}
function isoDaysFromNow(offset) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
function addDaysIso(iso, n) {
  const [y, m, day] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day + n));
  return dt.toISOString().slice(0, 10);
}
const TODAY = isoDaysFromNow(30);
const D1 = addDaysIso(TODAY, 1);
const D2 = addDaysIso(TODAY, 2);
const D3 = addDaysIso(TODAY, 3);
const D29 = addDaysIso(TODAY, 29);
const D30 = addDaysIso(TODAY, 30);
const PAST = addDaysIso(TODAY, -10);
function extractModal(src) {
  const s = src.indexOf('id="ps-create-modal"');
  if (s < 0) return '';
  const o = src.lastIndexOf('<div', s);
  const e = src.indexOf('id="ps-drawer-backdrop"', o);
  const c = src.lastIndexOf('</div>', e);
  return src.slice(o, c > o ? c + 6 : e);
}
function extractFn(src, name) {
  return slicePortalFunction(src, name);
}
function section(html, name) {
  const m = html.match(new RegExp('data-create-section="' + name + '"[\\s\\S]*?(?=data-create-section="|id="ps-create-summary"|</div>\\s*<footer|$)', 'i'));
  return m ? m[0] : '';
}
function listen(node) {
  node._ls = node._ls || {};
  node.addEventListener = function (ev, fn) { (this._ls[ev] = this._ls[ev] || []).push(fn); };
  node.dispatchEvent = function (ev) { (this._ls[ev && ev.type] || []).forEach((fn) => fn.call(this, ev)); };
  return node;
}
function cl(...init) {
  const set = new Set(init);
  return { contains: (c) => set.has(c), add: (c) => set.add(c), remove: (c) => set.delete(c), toggle(c, f) { if (f === true) set.add(c); else if (f === false) set.delete(c); else if (set.has(c)) set.delete(c); else set.add(c); return set.has(c); } };
}
console.log('\nverify:sunset-booking-create-when-sessions — date-range private sessions\n');
const modal = extractModal(portalUiSrc);
const guest = section(modal, 'guest');
const what = section(modal, 'what');
const when = section(modal, 'when');
console.log('[1] DOM + IDs (dates in Guest; private times in Main activity; no Add/Remove exposed)');
const counts = {}; let m; const re = /\bid="(ps-create-[^"]+)"/g;
while ((m = re.exec(modal))) counts[m[1]] = (counts[m[1]] || 0) + 1;
assert('DOM placement', guest.includes('id="ps-create-date-from"') && guest.includes('id="ps-create-date-to"')
  && guest.includes('id="ps-create-guest"') && guest.includes('id="ps-create-phone"')
  // Private sessions live in Main activity drill-down (What), not the lower When shell.
  && what.includes('id="ps-create-private-lesson-sessions"')
  && !when.includes('id="ps-create-private-lesson-sessions"')
  && !when.includes('id="ps-create-date-from"')
  && !what.includes('id="ps-create-date-from"')
  // Surfers authority lives above Activity (Guest); legacy private-surfers mirror may be hidden.
  && (guest.includes('id="ps-create-surfers"') || guest.includes('id="ps-create-private-lesson-surfers"')
    || what.includes('id="ps-create-private-lesson-surfers"') || modal.includes('id="ps-create-private-lesson-surfers"'))
  && Object.keys(counts).filter((k) => counts[k] > 1).length === 0
  && ['ps-create-private-lesson-sessions', 'ps-create-add-session', 'ps-create-private-lesson-qty', 'ps-create-date-from', 'ps-create-private-when'].every((id) => counts[id] === 1));
assert('Add session hidden in markup', /id="ps-create-add-session"[^>]*\b(hidden|style="display:none")/.test(modal)
  || /id="ps-create-add-session"[^>]*style="display:none"/.test(modal));
assert('ownership: range never hidden for private', !/dateRange\.style\.display\s*=\s*privateOn\s*\?\s*'none'/.test(apiSrc)
  && /Top-level From\/To always authoritative/.test(apiSrc));
console.log('\n[2] EN/ES/IT keys');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const es = require('./lib/staff-portal-i18n-es-sunset');
const en = STAFF_PORTAL_STRINGS.en || {}, it = STAFF_PORTAL_STRINGS.it || {};
[
  'schedule.create.privateLesson.sessionsHelp', 'schedule.create.privateLesson.sessionLabel',
  'schedule.create.privateLesson.start', 'schedule.create.privateLesson.end',
  'schedule.create.privateLesson.sessionsMismatch', 'schedule.create.privateLesson.sessionIncomplete',
  'schedule.create.privateLesson.sessionEndAfterStart', 'schedule.create.privateLesson.sessionDateInvalid',
  'schedule.create.privateLesson.sessionDatePast', 'schedule.create.privateLesson.sessionDuplicate',
  'schedule.create.privateLesson.sessionMax', 'schedule.create.privateLesson.rangeTooLong',
].forEach((k) => {
  assert('i18n ' + k, typeof en[k] === 'string' && en[k].trim() && typeof es[k] === 'string' && es[k].trim() && es[k] !== en[k] && typeof it[k] === 'string' && it[k].trim() && it[k] !== en[k]);
});
const CORE = [
  'schedulePrivateLessonDefaultStartHm', 'schedulePrivateLessonApplyBlankTimeDefaults',
  'schedulePrivateLessonDefaultEnd', 'scheduleReadPrivateLessonSessionsFromDom', 'scheduleWirePrivateLessonSessionRow',
  'schedulePrivateLessonSessionsRefreshDependents', 'scheduleSyncPrivateLessonSessions',
  'scheduleUpdatePrivateLessonDateRangeFromSessions', 'scheduleAddPrivateLessonSession', 'scheduleRemovePrivateLessonSession',
  'scheduleOnCreateComponentChange', 'schedulePopulateCreateComponentFields', 'scheduleReadCreatePayload',
  'scheduleReadCreateSurferCount', 'scheduleSyncCreateSurferMirrors',
  'scheduleRefreshCreateEmptyGuidance', 'schedulePortalMadridTodayIso', 'schedulePortalCanonicalDateIso',
  'schedulePortalInclusiveDateCount',
  'schedulePortalValidatePrivateLessonCreate', 'schedulePortalHasSellableIntent', 'schedulePortalValidateCreatePayload',
  'schedulePortalClearQuotePreviewUi', 'schedulePortalRunPreviewQuote', 'scheduleCreateDateSpanForRentals',
  'scheduleEnumerateDates',
];
function build(opts) {
  opts = opts || {};
  const nodes = {};
  const quote = { n: 0, fetch: 0, create: 0, payloads: [], rentalsSpans: [], fullDayDates: [] };
  function input(id, v) {
    nodes[id] = listen({ id, value: v == null ? '' : String(v), checked: false, style: { display: '' }, dataset: {}, classList: cl(), defaultValue: v == null ? '' : String(v), options: [], selectedIndex: -1, textContent: '', innerHTML: '', hidden: false, setAttribute() {} });
  }
  function box(id, d) {
    nodes[id] = listen({ id, style: { display: d == null ? '' : d }, dataset: {}, classList: cl(), innerHTML: '', textContent: '', hidden: false, setAttribute() {}, querySelectorAll() { return []; }, querySelector() { return null; } });
  }
  function radio(id, name, checked) {
    const node = listen({ id, type: 'radio', name, dataset: {}, style: {}, _checked: !!checked, classList: cl(), setAttribute() {} });
    Object.defineProperty(node, 'checked', { configurable: true, enumerable: true, get() { return this._checked; }, set(v) { this._checked = !!v; if (v) Object.keys(nodes).forEach((k) => { const n = nodes[k]; if (n && n.name === name && n !== this) n._checked = false; }); } });
    nodes[id] = node;
  }
  radio('ps-create-comp-course', 'ps-create-main-activity', false);
  radio('ps-create-comp-private-lesson', 'ps-create-main-activity', false);
  radio('ps-create-comp-no-lesson', 'ps-create-main-activity', true);
  ['ps-create-course-fields', 'ps-create-course-tier-wrap', 'ps-create-course-qty-wrap', 'ps-create-private-lesson-fields', 'ps-create-private-lesson-qty-wrap', 'ps-create-addon-fullday-field', 'ps-create-fullday-card', 'ps-create-fullday-rows', 'ps-create-fullday-summary', 'ps-create-fullday-price-hint', 'ps-create-activity-empty-hint', 'ps-create-rentals', 'ps-create-msg', 'ps-create-quote-preview', 'ps-create-add-session'].forEach((id) => box(id, id.includes('hint') || id === 'ps-create-rentals' ? '' : 'none'));
  // Real When section (production toggles via document.querySelector).
  const whenSection = listen({
    id: 'ps-create-when-section',
    dataset: { createSection: 'when' },
    style: { display: 'none' },
    hidden: true,
    classList: cl('is-when-hidden'),
    setAttribute(k, v) { if (k === 'hidden') this.hidden = v !== 'false' && v != null; },
    removeAttribute(k) { if (k === 'hidden') this.hidden = false; },
  });
  nodes['ps-create-private-when'] = listen({ id: 'ps-create-private-when', classList: cl('portal-schedule-create-private-when'), style: { display: 'none' }, dataset: {}, setAttribute() {} });
  nodes['ps-create-date-range'] = listen({ id: 'ps-create-date-range', style: { display: '' }, dataset: {}, classList: cl(), setAttribute() {} });
  input('ps-create-date-from', opts.dateFrom || TODAY); input('ps-create-date-to', opts.dateTo || D2);
  input('ps-create-surfers', opts.surfers != null ? String(opts.surfers) : '1');
  input('ps-create-private-lesson-qty', '1'); input('ps-create-private-lesson-surfers', '1'); input('ps-create-course-qty', '1');
  input('ps-create-guest', ''); input('ps-create-phone', ''); input('ps-create-notes', '');
  input('ps-create-payment', 'unpaid'); input('ps-create-course-select', ''); input('ps-create-course-tier', '');
  input('ps-create-comp-fullday', ''); nodes['ps-create-comp-fullday'].type = 'checkbox'; nodes['ps-create-comp-fullday'].checked = false;
  function parseRows(html, wrap) {
    const rows = [];
    String(html).split('portal-schedule-private-session-row').slice(1).forEach((chunk) => {
      const dateAttr = (chunk.match(/data-session-date="([^"]*)"/) || [])[1] || '';
      const startVal = (chunk.match(/ps-pl-session-start"[^>]*value="([^"]*)"/) || [])[1] || '';
      const endVal = (chunk.match(/ps-pl-session-end"[^>]*value="([^"]*)"/) || [])[1] || '';
      const startEl = listen({ classList: cl('ps-pl-session-start'), className: 'ps-pl-session-start', type: 'time', value: startVal, dataset: {}, defaultValue: startVal });
      const endEl = listen({ classList: cl('ps-pl-session-end'), className: 'ps-pl-session-end', type: 'time', value: endVal, dataset: {}, defaultValue: endVal });
      const row = listen({
        classList: cl('portal-schedule-private-session-row'), dataset: { wired: '' }, _start: startEl, _end: endEl, parentNode: wrap,
        getAttribute(k) { return k === 'data-session-date' ? dateAttr : null; },
        querySelector(sel) { return sel === '.ps-pl-session-start' ? startEl : sel === '.ps-pl-session-end' ? endEl : sel === '.ps-pl-session-date' ? null : null; },
      });
      rows.push(row);
    });
    return rows;
  }
  const wrap = listen({
    id: 'ps-create-private-lesson-sessions', dataset: {}, style: {}, classList: cl(), _rows: [],
    get innerHTML() { return this._html || ''; },
    set innerHTML(html) { this._html = String(html || ''); this._rows = parseRows(this._html, this); },
    querySelectorAll(sel) {
      if (sel === '.portal-schedule-private-session-row') return this._rows.slice();
      if (sel === '.portal-schedule-session-remove') return [];
      if (sel === '.ps-pl-session-start') return this._rows.map((r) => r._start);
      if (sel === '.ps-pl-session-end') return this._rows.map((r) => r._end);
      return [];
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    setAttribute(k, v) { this.dataset[k] = v; },
    removeAttribute(k) { delete this.dataset[k]; },
  });
  nodes['ps-create-private-lesson-sessions'] = wrap;
  const todayIso = opts.today || TODAY;
  const sb = {
    window: { applyStaffPortalI18n() {} }, console,
    el(id) { return nodes[id] || null; },
    portalT(k) { return k; },
    escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
    scheduleTodayIso() { return todayIso; },
    scheduleParseIso(iso) { const x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); return x ? new Date(Date.UTC(+x[1], +x[2] - 1, +x[3])) : null; },
    scheduleAddDays(d, n) { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; },
    scheduleIsoDate(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); },
    scheduleSlotMinutesFromToken(hm) { const x = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '')); return x ? (+x[1]) * 60 + (+x[2]) : null; },
    scheduleMinutesLabel(mins) { return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0'); },
    schedulePrivateLessonDurationCache: 120,
    scheduleFetchLessonTimesConfig() { return { then(fn) { if (fn) fn(); return { then(fn2) { if (fn2) fn2(); return this; } }; } }; },
    schedulePopulateCreateCourseFields() {},
    // Real When-section transition (same selector production uses).
    document: {
      querySelector(sel) {
        if (sel === '#ps-create-modal [data-create-section="when"]') return whenSection;
        return null;
      },
      // scheduleReadCreatePayload walks course-equipment rows; this gate is sessions-only.
      querySelectorAll() { return []; },
    },
    scheduleReadCreateCustomLineItems() { return []; },
    scheduleReadCreateAccommodation() { return null; },
    adminHumanizeText(value) {
      const text = String(value == null ? '' : value).trim();
      return text || '—';
    },
    scheduleRenderCreateRentals() {
      quote.rentalsSpans.push(typeof sb.scheduleCreateDateSpanForRentals === 'function' ? sb.scheduleCreateDateSpanForRentals() : { from: sb.el('ps-create-date-from').value, to: sb.el('ps-create-date-to').value });
    },
    scheduleRefreshCreateFullDayAddon() {
      const today = sb.schedulePortalMadridTodayIso(), dates = [], seen = {};
      sb.scheduleReadPrivateLessonSessionsFromDom().forEach((s) => { const c = sb.schedulePortalCanonicalDateIso(s.date); if (c && c >= today && !seen[c]) { seen[c] = 1; dates.push(c); } });
      dates.sort(); quote.fullDayDates.push(dates.slice());
    },
    scheduleUpdateCreateTotalPreview() {
      quote.n += 1;
      try { quote.payloads.push(JSON.parse(JSON.stringify(sb.scheduleReadCreatePayload()))); } catch (_e) { quote.payloads.push(null); }
    },
    scheduleReadCreateRentalSelectionFromDom() { return opts.rentals || sb._gear || []; },
    scheduleRentalsToLegacyComponents(r) { const c = {}; (r || []).forEach((x) => { if (x.offering_key === 'board_rental') c.surfboard = { quantity: x.quantity || 1 }; }); return c; },
    scheduleReadFullDayAddonRows() { return {}; }, scheduleRenderFullDayAddonRows() {},
    scheduleFullDayAddonEnabled: true, scheduleFullDayAddonUnitCents: 2500,
    schedulePortalSubmitInFlight: false, schedulePortalQuoteGen: 0, schedulePortalQuoteAbort: null, schedulePortalQuoteState: null, schedulePortalQuoteTimer: null,
    scheduleCreateCustomLines: [],
    schedulePortalFetchQuote(payload) { quote.fetch += 1; quote.payloads.push(payload); return Promise.resolve({ ok: true, body: { success: true, total_cents: 100 } }); },
    schedulePortalSubmitCreate() { quote.create += 1; return Promise.resolve({ ok: true, data: { success: true } }); },
    schedulePortalRenderCreateQuotePreview() {},
    getClient() { return 'sunset'; },
    Intl: { DateTimeFormat() { return { format() { return todayIso; } }; } },
    Promise, JSON, Object, Array, Number, String, Math, Date, parseInt, isNaN,
    _nodes: nodes, _quote: quote, _privateWhen: nodes['ps-create-private-when'],
    _whenSection: whenSection, _gear: opts.rentals || [],
  };
  const sliced = collectPortalFunctions(portalUiSrc, CORE, { provided: Object.keys(sb) });
  assert('fns extractable', sliced.resolved.length >= 18, String(sliced.resolved.length));
  assert('slice has no dangling callees', sliced.missing.length === 0, sliced.missing.join(','));
  vm.createContext(sb);
  vm.runInContext(sliced.code, sb);
  return sb;
}
function privatePanelVisible(sb) {
  const panel = (sb._nodes && sb._nodes['ps-create-private-panel']) || sb._privateWhen;
  if (!panel) return false;
  return !(panel.hidden === true || panel.style.display === 'none'
    || (panel.getAttribute && panel.getAttribute('aria-hidden') === 'true'));
}
function whenVisible(sb) {
  // Name kept: private session panel visible (Main activity drill-down).
  return privatePanelVisible(sb);
}
function whenHidden(sb) {
  const w = sb._whenSection;
  const whenShellHidden = !!(w && (w.hidden === true || w.style.display === 'none' || w.classList.contains('is-when-hidden')));
  return whenShellHidden && !privatePanelVisible(sb);
}
function rows(sb) { return sb.scheduleReadPrivateLessonSessionsFromDom(); }
function setTimes(sb, i, p) {
  const r = sb.el('ps-create-private-lesson-sessions').querySelectorAll('.portal-schedule-private-session-row')[i];
  if (!r) return;
  if (p.start != null) r._start.value = p.start;
  if (p.end != null) r._end.value = p.end;
}
function setRange(sb, from, to) {
  sb.el('ps-create-date-from').value = from;
  sb.el('ps-create-date-to').value = to;
  sb.scheduleSyncPrivateLessonSessions();
}
function pick(sb, id) { sb.el(id).checked = true; sb.scheduleOnCreateComponentChange(id); }
function soft(sb, times) {
  setTimes(sb, 0, times); sb._quote.fetch = 0; sb._quote.create = 0; sb.el('ps-create-msg').textContent = '';
  return sb.schedulePortalRunPreviewQuote().then((res) => {
    assert('soft zero quote/create no toast', res && res.softInvalid === true && res.ok === false && sb._quote.fetch === 0 && sb._quote.create === 0 && !sb.el('ps-create-msg').textContent, 'f=' + sb._quote.fetch);
  });
}
console.log('\n[3] Activity-aware visibility (top dates always on; private panel only Private)');
{
  const sb = build();
  // Simulate real transition: populate before any activity pick (panel starts hidden).
  sb.schedulePopulateCreateComponentFields();
  assert('No lesson range on / private panel hidden', sb.el('ps-create-date-range').style.display !== 'none' && whenHidden(sb));
  pick(sb, 'ps-create-comp-course');
  assert('Group range on / private panel hidden / tier wrap hidden', sb.el('ps-create-date-range').style.display !== 'none'
    && whenHidden(sb)
    && sb.el('ps-create-course-tier-wrap').style.display === 'none'
    && sb.el('ps-create-private-lesson-fields').style.display === 'none');
  // Real Private transition: private panel unhides, then session rows initialize.
  pick(sb, 'ps-create-comp-private-lesson');
  assert('Private panel visible before field assert', whenVisible(sb)
    && sb.el('ps-create-date-range').style.display !== 'none'
    // Legacy private-lesson-fields stay hidden; times live in Main activity panel.
    && sb.el('ps-create-private-lesson-fields').style.display === 'none');
  assert('Private rows from range default 10:00–12:00', rows(sb).length === 3
    && rows(sb)[0].date === TODAY && rows(sb)[2].date === D2
    && rows(sb).every((r) => r.start === '10:00' && r.end === '12:00'));
  assert('no Add/Remove UI', sb.el('ps-create-add-session').style.display === 'none'
    && sb.el('ps-create-private-lesson-sessions').querySelectorAll('.portal-schedule-session-remove').length === 0);
  pick(sb, 'ps-create-comp-no-lesson');
  assert('back No lesson private panel hidden', sb.el('ps-create-date-range').style.display !== 'none' && whenHidden(sb));
}
console.log('\n[4] Range grow/shrink/shift preserves overlapping times');
{
  const sb = build({ dateFrom: TODAY, dateTo: D2 });
  pick(sb, 'ps-create-comp-private-lesson');
  assert('init 3 default 10:00–12:00 rows', rows(sb).length === 3
    && rows(sb).every((r) => r.start === '10:00' && r.end === '12:00'));
  setTimes(sb, 0, { start: '09:00', end: '11:00' });
  setTimes(sb, 1, { start: '10:00', end: '12:00' });
  setTimes(sb, 2, { start: '14:00', end: '16:00' });
  setRange(sb, D1, D3); // shrink left, grow right
  const after = rows(sb);
  assert('reconcile shift', after.length === 3
    && after[0].date === D1 && after[0].start === '10:00' && after[0].end === '12:00'
    && after[1].date === D2 && after[1].start === '14:00'
    && after[2].date === D3 && after[2].start === '10:00' && after[2].end === '12:00');
  setRange(sb, D1, D1);
  assert('shrink to one keeps time', rows(sb).length === 1 && rows(sb)[0].date === D1 && rows(sb)[0].start === '10:00');
  setRange(sb, '2026-12-31', '2027-01-02');
  assert('month/year boundary', rows(sb).map((r) => r.date).join(',') === '2026-12-31,2027-01-01,2027-01-02');
  assert('month/year boundary defaults 10–12', rows(sb).every((r) => r.start === '10:00' && r.end === '12:00'));
  setRange(sb, '2028-02-28', '2028-03-01');
  assert('leap + DST-safe enumerate', rows(sb).map((r) => r.date).join(',') === '2028-02-28,2028-02-29,2028-03-01');
}
console.log('\n[5] Outer dates authoritative + payload qty + >30 fail closed');
{
  const sb = build({ today: TODAY, dateFrom: TODAY, dateTo: D2 });
  pick(sb, 'ps-create-comp-private-lesson');
  setTimes(sb, 0, { start: '10:00', end: '12:00' });
  setTimes(sb, 1, { start: '10:00', end: '12:00' });
  setTimes(sb, 2, { start: '10:00', end: '12:00' });
  const p = sb.scheduleReadCreatePayload();
  assert('outer unchanged by sessions', p.date_from === TODAY && p.date_to === D2
    && p.components.private_lesson.quantity === 3
    && p.components.private_lesson.sessions.length === 3
    && p.components.private_lesson.sessions[1].date === D1);
  sb.scheduleUpdatePrivateLessonDateRangeFromSessions();
  assert('outer rewrite is no-op', sb.el('ps-create-date-from').value === TODAY && sb.el('ps-create-date-to').value === D2);
  setRange(sb, '2026-02-31', '2026-02-31');
  assert('impossible range → zero rows', rows(sb).length === 0 && sb.scheduleReadCreatePayload().components.private_lesson.quantity === 0);
  // 30 inclusive days valid rows; 31 fails closed (no partial set, outer preserved)
  setRange(sb, TODAY, D29);
  assert('30 days → 30 rows', rows(sb).length === 30
    && sb.el('ps-create-date-from').value === TODAY
    && sb.el('ps-create-date-to').value === D29);
  setRange(sb, TODAY, D30);
  assert('31 days → zero rows, outer kept', rows(sb).length === 0
    && sb.el('ps-create-date-from').value === TODAY
    && sb.el('ps-create-date-to').value === D30
    && sb.scheduleReadCreatePayload().date_from === TODAY
    && sb.scheduleReadCreatePayload().date_to === D30);
  const gate31 = sb.schedulePortalValidateCreatePayload(sb.scheduleReadCreatePayload(), { soft: true });
  assert('31 soft rangeTooLong', gate31 && gate31.ok === false
    && gate31.errorKey === 'schedule.create.privateLesson.rangeTooLong'
    && gate31.softInvalid === true);
}
console.log('\n[6] Shared validation owner');
{
  const sb = build({ today: TODAY });
  const V = (pl) => sb.schedulePortalValidatePrivateLessonCreate(pl);
  assert('validate helper+cases', typeof V === 'function'
    && V({ quantity: 1, sessions: [{ date: TODAY, start: '', end: '12:00' }] }).ok === false
    && V({ quantity: 1, sessions: [{ date: TODAY, start: '12:00', end: '10:00' }] }).ok === false
    && V({ quantity: 1, sessions: [{ date: PAST, start: '10:00', end: '12:00' }] }).ok === false
    && V({ quantity: 1, sessions: [{ date: '2026-02-31', start: '10:00', end: '12:00' }] }).ok === false
    && V({ quantity: 2, sessions: [{ date: TODAY, start: '10:00', end: '12:00' }, { date: TODAY, start: '10:00', end: '12:00' }] }).ok === false
    && V({ quantity: 2, sessions: [{ date: TODAY, start: '10:00', end: '12:00' }, { date: D1, start: '10:00', end: '12:00' }] }).ok === true);
  assert('submit+preview use validate', /function submitScheduleManualBooking[\s\S]*schedulePortalValidatePrivateLessonCreate/.test(portalSrc)
    && /function schedulePortalRunPreviewQuote[\s\S]*schedulePortalValidatePrivateLessonCreate/.test(portalSrc));
}
console.log('\n[7] Same-open preserve + fresh open clear');
{
  const sb = build({ dateFrom: TODAY, dateTo: D1 });
  sb._gear = [{ offering_key: 'board_rental', quantity: 2, duration_key: '2_days' }];
  pick(sb, 'ps-create-comp-private-lesson');
  setTimes(sb, 0, { start: '09:00', end: '11:00' }); setTimes(sb, 1, { start: '14:00', end: '16:00' });
  pick(sb, 'ps-create-comp-course');
  assert('gear survives', sb._gear[0].offering_key === 'board_rental');
  assert('Private→Group drops session draft', rows(sb).length === 0);
  pick(sb, 'ps-create-comp-private-lesson'); const back = rows(sb);
  assert('re-entry after Group uses range defaults, not abandoned times',
    back.length === 2 && back.every((r) => r.start === '10:00' && r.end === '12:00'));
  assert('fresh open clears sessions', /function schedulePortalClearCreateDraftFields[\s\S]*ps-create-private-lesson-sessions[\s\S]*innerHTML\s*=\s*''/.test(portalSrc));
}
console.log('\n[8] One field → one quote + auto-end');
{
  const sb = build({ dateFrom: TODAY, dateTo: TODAY });
  pick(sb, 'ps-create-comp-private-lesson'); sb._quote.n = 0; sb._quote.payloads.length = 0;
  const startEl = sb.el('ps-create-private-lesson-sessions').querySelectorAll('.ps-pl-session-start')[0];
  startEl.value = '11:00'; startEl.dispatchEvent({ type: 'change', target: startEl });
  assert('one start → one quote', sb._quote.n === 1, String(sb._quote.n));
  const lastPay = sb._quote.payloads[sb._quote.payloads.length - 1];
  assert('start auto-end in payload', !!(lastPay && lastPay.components.private_lesson.sessions[0].start === '11:00'
    && lastPay.components.private_lesson.sessions[0].end === '13:00'));
}
console.log('\n[9] Ownership markers');
assert('ownership markers', /components\.private_lesson\s*=\s*\{[\s\S]*sessions:\s*plSessions/.test(apiSrc)
  && /function scheduleSyncPrivateLessonSessions/.test(portalSrc)
  && /data-session-date/.test(portalSrc)
  && /function schedulePortalResolveDerivedCourseTier/.test(portalSrc));
console.log('\n[10] Real preview gate + RED mutation of reconcile owner');
const asyncPass = (async () => {
  const sb = build({ today: TODAY, dateFrom: TODAY, dateTo: TODAY });
  pick(sb, 'ps-create-comp-private-lesson');
  for (const times of [
    { start: '', end: '12:00' }, { start: '10:00', end: '' },
    { start: '12:00', end: '10:00' }, { start: '1', end: 'x' },
  ]) await soft(sb, times);
  setTimes(sb, 0, { start: '10:00', end: '12:00' }); sb._quote.fetch = 0;
  let res = await sb.schedulePortalRunPreviewQuote();
  assert('valid → one quote fetch', sb._quote.fetch === 1 && res && res.ok === true, String(sb._quote.fetch));
  setRange(sb, TODAY, D1);
  // Force incomplete after defaults applied (user cleared end) — soft quote must not fetch.
  setTimes(sb, 1, { start: '10:00', end: '' });
  sb._quote.fetch = 0; res = await sb.schedulePortalRunPreviewQuote();
  assert('incomplete new date zero quote', res && res.softInvalid && sb._quote.fetch === 0);
  setRange(sb, TODAY, D30);
  sb._quote.fetch = 0; res = await sb.schedulePortalRunPreviewQuote();
  assert('>30 zero quote/create', res && res.softInvalid && sb._quote.fetch === 0 && rows(sb).length === 0);
  // Mutation: disable date-reconciliation owner → no rows from range
  const redFn = extractFn(portalSrc, 'scheduleSyncPrivateLessonSessions')
    .replace('dates = scheduleEnumerateDates(from, to) || [];', 'dates = []; /* mutated */');
  assert('RED mutates reconcile', /dates = \[\]; \/\* mutated \*\//.test(redFn));
  const sbRed = build({ dateFrom: TODAY, dateTo: D2 });
  vm.runInContext(redFn, sbRed);
  pick(sbRed, 'ps-create-comp-private-lesson');
  assert('RED no rows from range', rows(sbRed).length === 0);
  sbRed._quote.fetch = 0; res = await sbRed.schedulePortalRunPreviewQuote();
  assert('RED invalid zero/wrong path', rows(sbRed).length === 0 && (res && res.ok !== true));
  // Control GREEN: restore real owner
  const greenFn = extractFn(portalSrc, 'scheduleSyncPrivateLessonSessions');
  vm.runInContext(greenFn, sbRed);
  sbRed.scheduleSyncPrivateLessonSessions();
  assert('GREEN rows restored', rows(sbRed).length === 3);
  setRange(sb, TODAY, D1);
  assert('add/remove are no-ops', typeof sb.scheduleAddPrivateLessonSession === 'function'
    && rows(sb).length === 2
    && (sb.scheduleAddPrivateLessonSession(), rows(sb).length === 2)
    && (sb.scheduleRemovePrivateLessonSession(0), rows(sb).length === 2));
})();

asyncPass.then(() => {
  console.log('\n' + '─'.repeat(48));
  console.log('Results: ' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) { console.error('verify:sunset-booking-create-when-sessions — FAILED'); process.exit(1); }
  console.log('verify:sunset-booking-create-when-sessions — ALL CHECKS PASSED'); process.exit(0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
