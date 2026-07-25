'use strict';
/* verify:sunset-booking-create-when-sessions — Kaya Slice 4 offline */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
let pass = 0, fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); pass += 1; }
  else { console.error('  FAIL  ' + label + (detail ? ' — ' + detail : '')); fail += 1; }
}
function extractModal(src) {
  const s = src.indexOf('id="ps-create-modal"');
  if (s < 0) return '';
  const o = src.lastIndexOf('<div', s);
  const e = src.indexOf('id="ps-drawer-backdrop"', o);
  const c = src.lastIndexOf('</div>', e);
  return src.slice(o, c > o ? c + 6 : e);
}
function extractFn(src, name) {
  const n = 'function ' + name + '(';
  const start = src.indexOf(n);
  if (start < 0) return null;
  const brace = src.indexOf('{', start);
  let d = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') d += 1;
    else if (src[i] === '}') { d -= 1; if (d === 0) return src.slice(start, i + 1); }
  }
  return null;
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
console.log('\nverify:sunset-booking-create-when-sessions — Kaya Slice 4\n');
const modal = extractModal(apiSrc);
const what = section(modal, 'what');
const when = section(modal, 'when');
console.log('[1] DOM + IDs');
const counts = {}; let m; const re = /\bid="(ps-create-[^"]+)"/g;
while ((m = re.exec(modal))) counts[m[1]] = (counts[m[1]] || 0) + 1;
assert('DOM When/What + ids', when.includes('id="ps-create-private-lesson-sessions"') && when.includes('id="ps-create-add-session"') && when.includes('id="ps-create-private-lesson-qty"')
  && !what.includes('id="ps-create-private-lesson-sessions"') && !what.includes('id="ps-create-add-session"')
  && what.includes('id="ps-create-private-lesson-surfers"') && what.includes('id="ps-create-private-lesson-fields"')
  && when.includes('id="ps-create-date-range"') && when.includes('id="ps-create-private-when"')
  && /el\('ps-create-private-when'\)/.test(apiSrc) && !/dateRange\.nextElementSibling/.test(apiSrc)
  && Object.keys(counts).filter((k) => counts[k] > 1).length === 0
  && ['ps-create-private-lesson-sessions', 'ps-create-add-session', 'ps-create-private-lesson-qty', 'ps-create-private-lesson-surfers', 'ps-create-date-from', 'ps-create-private-when'].every((id) => counts[id] === 1));
console.log('\n[2] EN/ES/IT keys');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const es = require('./lib/staff-portal-i18n-es-sunset');
const en = STAFF_PORTAL_STRINGS.en || {}, it = STAFF_PORTAL_STRINGS.it || {};
[
  'schedule.create.privateLesson.sessionCount', 'schedule.create.privateLesson.sessionsHelp',
  'schedule.create.privateLesson.sessionLabel', 'schedule.create.privateLesson.date',
  'schedule.create.privateLesson.start', 'schedule.create.privateLesson.end',
  'schedule.create.privateLesson.addSession', 'schedule.create.privateLesson.removeSession',
  'schedule.create.privateLesson.sessionsMismatch', 'schedule.create.privateLesson.sessionIncomplete',
  'schedule.create.privateLesson.sessionEndAfterStart', 'schedule.create.privateLesson.sessionDateInvalid',
  'schedule.create.privateLesson.sessionDatePast', 'schedule.create.privateLesson.sessionDuplicate',
  'schedule.create.privateLesson.sessionMax',
].forEach((k) => {
  assert('i18n ' + k, typeof en[k] === 'string' && en[k].trim() && typeof es[k] === 'string' && es[k].trim() && es[k] !== en[k] && es[k] !== k && typeof it[k] === 'string' && it[k].trim() && it[k] !== en[k] && it[k] !== k);
});
const CORE = [
  'schedulePrivateLessonDefaultEnd', 'scheduleReadPrivateLessonSessionsFromDom', 'scheduleWirePrivateLessonSessionRow',
  'schedulePrivateLessonSessionsRefreshDependents', 'scheduleSyncPrivateLessonSessions',
  'scheduleUpdatePrivateLessonDateRangeFromSessions', 'scheduleAddPrivateLessonSession', 'scheduleRemovePrivateLessonSession',
  'scheduleOnCreateComponentChange', 'schedulePopulateCreateComponentFields', 'scheduleReadCreatePayload',
  'scheduleRefreshCreateEmptyGuidance', 'schedulePortalMadridTodayIso', 'schedulePortalCanonicalDateIso',
  'schedulePortalValidatePrivateLessonCreate', 'schedulePortalClearQuotePreviewUi', 'schedulePortalRunPreviewQuote',
  'scheduleCreateDateSpanForRentals',
];
function build(opts) {
  opts = opts || {};
  const nodes = {};
  const quote = { n: 0, fetch: 0, create: 0, payloads: [], rentalsSpans: [], fullDayDates: [] };
  function input(id, v) {
    nodes[id] = listen({ id, value: v == null ? '' : String(v), checked: false, style: { display: '' }, dataset: {}, classList: cl(), defaultValue: v == null ? '' : String(v), options: [], selectedIndex: -1, textContent: '', innerHTML: '' });
  }
  function box(id, d) {
    nodes[id] = listen({ id, style: { display: d == null ? '' : d }, dataset: {}, classList: cl(), innerHTML: '', textContent: '', querySelectorAll() { return []; }, querySelector() { return null; } });
  }
  function radio(id, name, checked) {
    const node = listen({ id, type: 'radio', name, dataset: {}, style: {}, _checked: !!checked, classList: cl() });
    Object.defineProperty(node, 'checked', { configurable: true, enumerable: true, get() { return this._checked; }, set(v) { this._checked = !!v; if (v) Object.keys(nodes).forEach((k) => { const n = nodes[k]; if (n && n.name === name && n !== this) n._checked = false; }); } });
    nodes[id] = node;
  }
  radio('ps-create-comp-course', 'ps-create-main-activity', false);
  radio('ps-create-comp-private-lesson', 'ps-create-main-activity', false);
  radio('ps-create-comp-no-lesson', 'ps-create-main-activity', true);
  ['ps-create-course-fields', 'ps-create-course-tier-wrap', 'ps-create-course-qty-wrap', 'ps-create-private-lesson-fields', 'ps-create-addon-fullday-field', 'ps-create-fullday-card', 'ps-create-fullday-rows', 'ps-create-fullday-summary', 'ps-create-fullday-price-hint', 'ps-create-activity-empty-hint', 'ps-create-rentals', 'ps-create-msg', 'ps-create-quote-preview'].forEach((id) => box(id, id.includes('hint') || id === 'ps-create-rentals' ? '' : 'none'));
  nodes['ps-create-private-when'] = listen({ id: 'ps-create-private-when', classList: cl('portal-schedule-create-private-when'), style: { display: 'none' }, dataset: {} });
  nodes['ps-create-date-range'] = listen({ id: 'ps-create-date-range', style: { display: '' }, dataset: {}, classList: cl() });
  input('ps-create-date-from', opts.dateFrom || '2026-07-20'); input('ps-create-date-to', opts.dateTo || '2026-07-22');
  input('ps-create-private-lesson-qty', '1'); input('ps-create-private-lesson-surfers', '1'); input('ps-create-course-qty', '1');
  input('ps-create-guest', ''); input('ps-create-phone', ''); input('ps-create-notes', '');
  input('ps-create-payment', 'unpaid'); input('ps-create-course-select', ''); input('ps-create-course-tier', '');
  input('ps-create-comp-fullday', ''); nodes['ps-create-comp-fullday'].type = 'checkbox'; nodes['ps-create-comp-fullday'].checked = false;
  function parseRows(html, wrap) {
    const rows = [];
    String(html).split('portal-schedule-private-session-row').slice(1).forEach((chunk) => {
      const dateVal = (chunk.match(/ps-pl-session-date"[^>]*value="([^"]*)"/) || [])[1] || '';
      const startVal = (chunk.match(/ps-pl-session-start"[^>]*value="([^"]*)"/) || [])[1] || '10:00';
      const endVal = (chunk.match(/ps-pl-session-end"[^>]*value="([^"]*)"/) || [])[1] || '12:00';
      const hasRemove = /portal-schedule-session-remove/.test(chunk);
      const removeIdx = (chunk.match(/data-session-remove="(\d+)"/) || [])[1];
      const dateEl = listen({ classList: cl('ps-pl-session-date'), className: 'ps-pl-session-date', type: 'date', value: dateVal, dataset: {}, defaultValue: dateVal });
      const startEl = listen({ classList: cl('ps-pl-session-start'), className: 'ps-pl-session-start', type: 'time', value: startVal, dataset: {}, defaultValue: startVal });
      const endEl = listen({ classList: cl('ps-pl-session-end'), className: 'ps-pl-session-end', type: 'time', value: endVal, dataset: {}, defaultValue: endVal });
      const removeBtn = hasRemove ? listen({ classList: cl('portal-schedule-session-remove'), getAttribute(k) { if (k === 'data-session-remove') return String(removeIdx != null ? removeIdx : rows.length); const mm = chunk.match(new RegExp(k + '="([^"]*)"')); return mm ? mm[1] : null; } }) : null;
      rows.push(listen({ classList: cl('portal-schedule-private-session-row'), dataset: { wired: '' }, _date: dateEl, _start: startEl, _end: endEl, _removeBtn: removeBtn, parentNode: wrap, querySelector(sel) { return sel === '.ps-pl-session-date' ? dateEl : sel === '.ps-pl-session-start' ? startEl : sel === '.ps-pl-session-end' ? endEl : null; } }));
    });
    wrap.removeChild = function (child) { const i = this._rows.indexOf(child); if (i >= 0) this._rows.splice(i, 1); };
    return rows;
  }
  const wrap = listen({
    id: 'ps-create-private-lesson-sessions', dataset: {}, style: {}, classList: cl(), _rows: [],
    get innerHTML() { return this._html || ''; },
    set innerHTML(html) { this._html = String(html || ''); this._rows = parseRows(this._html, this); },
    querySelectorAll(sel) {
      if (sel === '.portal-schedule-private-session-row') return this._rows.slice();
      if (sel === '.portal-schedule-session-remove') return this._rows.map((r) => r._removeBtn).filter(Boolean);
      if (sel === '.ps-pl-session-date') return this._rows.map((r) => r._date);
      if (sel === '.ps-pl-session-start') return this._rows.map((r) => r._start);
      if (sel === '.ps-pl-session-end') return this._rows.map((r) => r._end);
      return [];
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  });
  nodes['ps-create-private-lesson-sessions'] = wrap;
  const sb = {
    window: { applyStaffPortalI18n() {} }, console,
    el(id) { return nodes[id] || null; },
    portalT(k) { return k; },
    escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
    scheduleTodayIso() { return opts.today || '2026-07-20'; },
    scheduleParseIso(iso) { const x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); return x ? new Date(Date.UTC(+x[1], +x[2] - 1, +x[3])) : null; },
    scheduleAddDays(d, n) { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; },
    scheduleIsoDate(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); },
    scheduleSlotMinutesFromToken(hm) { const x = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '')); return x ? (+x[1]) * 60 + (+x[2]) : null; },
    scheduleMinutesLabel(mins) { return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0'); },
    schedulePrivateLessonDurationCache: 120,
    scheduleFetchLessonTimesConfig() { return { then(fn) { if (fn) fn(); return { then(fn2) { if (fn2) fn2(); return this; } }; } }; },
    schedulePopulateCreateCourseFields() {},
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
    schedulePortalFetchQuote(payload) { quote.fetch += 1; quote.payloads.push(payload); return Promise.resolve({ ok: true, body: { success: true, total_cents: 100 } }); },
    schedulePortalSubmitCreate() { quote.create += 1; return Promise.resolve({ ok: true, data: { success: true } }); },
    schedulePortalRenderCreateQuotePreview() {},
    getClient() { return 'sunset'; },
    Intl: { DateTimeFormat() { return { format() { return opts.today || '2026-07-20'; } }; } },
    Promise, JSON, Object, Array, Number, String, Math, Date,
    _nodes: nodes, _quote: quote, _privateWhen: nodes['ps-create-private-when'], _gear: opts.rentals || [],
  };
  const code = CORE.map((n) => extractFn(portalSrc, n) || extractFn(apiSrc, n)).filter(Boolean);
  assert('fns extractable', code.length >= 16, String(code.length));
  vm.createContext(sb);
  vm.runInContext(code.join('\n'), sb);
  return sb;
}
function rows(sb) { return sb.scheduleReadPrivateLessonSessionsFromDom(); }
function setRow(sb, i, p) {
  const r = sb.el('ps-create-private-lesson-sessions').querySelectorAll('.portal-schedule-private-session-row')[i];
  if (!r) return;
  if (p.date != null) r._date.value = p.date;
  if (p.start != null) r._start.value = p.start;
  if (p.end != null) r._end.value = p.end;
}
function pick(sb, id) { sb.el(id).checked = true; sb.scheduleOnCreateComponentChange(id); }
function soft(sb, row) {
  setRow(sb, 0, row); sb._quote.fetch = 0; sb._quote.create = 0; sb.el('ps-create-msg').textContent = '';
  return sb.schedulePortalRunPreviewQuote().then((res) => {
    assert('soft zero quote/create no toast', res && res.softInvalid === true && res.ok === false && sb._quote.fetch === 0 && sb._quote.create === 0 && !sb.el('ps-create-msg').textContent, 'f=' + sb._quote.fetch);
  });
}
console.log('\n[3] Activity-aware When visibility');
{
  const sb = build();
  sb.schedulePopulateCreateComponentFields();
  assert('No lesson range on / editor off', sb.el('ps-create-date-range').style.display !== 'none' && sb._privateWhen.style.display === 'none');
  pick(sb, 'ps-create-comp-course');
  assert('Group range on / editor off', sb.el('ps-create-date-range').style.display !== 'none' && sb._privateWhen.style.display === 'none' && sb.el('ps-create-private-lesson-fields').style.display === 'none');
  pick(sb, 'ps-create-comp-private-lesson');
  assert('Private range off / editor on / one row', sb.el('ps-create-date-range').style.display === 'none' && sb._privateWhen.style.display !== 'none' && sb.el('ps-create-private-lesson-fields').style.display !== 'none' && rows(sb).length >= 1);
  pick(sb, 'ps-create-comp-no-lesson');
  assert('back No lesson', sb.el('ps-create-date-range').style.display !== 'none' && sb._privateWhen.style.display === 'none');
}
console.log('\n[4] Add/edit/remove stability');
{
  const sb = build({ dateFrom: '2026-07-20' });
  pick(sb, 'ps-create-comp-private-lesson');
  assert('init one from draft', rows(sb).length === 1 && rows(sb)[0].date === '2026-07-20');
  sb.scheduleAddPrivateLessonSession(); sb.scheduleAddPrivateLessonSession(); sb.scheduleAddPrivateLessonSession();
  assert('add 3 → 4', rows(sb).length === 4 && sb.el('ps-create-private-lesson-qty').value === '4');
  setRow(sb, 1, { date: '2026-07-25', start: '11:00', end: '13:00' }); setRow(sb, 2, { date: '2026-07-26', start: '15:00', end: '17:00' });
  const mid = rows(sb)[1]; sb.scheduleRemovePrivateLessonSession(0);
  assert('remove first keeps mid', rows(sb).length === 3 && rows(sb).some((r) => r.date === mid.date && r.start === mid.start));
  const before = rows(sb); sb.scheduleRemovePrivateLessonSession(1);
  assert('remove middle keeps ends', rows(sb).length === 2 && rows(sb)[0].date === before[0].date && rows(sb)[1].date === before[2].date);
  sb.scheduleRemovePrivateLessonSession(1); assert('remove last of two', rows(sb).length === 1);
  const one = rows(sb)[0]; sb.scheduleRemovePrivateLessonSession(0);
  assert('cannot remove last', rows(sb).length === 1 && rows(sb)[0].date === one.date);
}
console.log('\n[5] Count sync + month/year/leap rollover');
{
  const sb = build({ dateFrom: '2026-07-20' });
  pick(sb, 'ps-create-comp-private-lesson');
  setRow(sb, 0, { date: '2026-07-20', start: '09:00', end: '10:30' });
  sb.el('ps-create-private-lesson-qty').value = '3'; sb.scheduleSyncPrivateLessonSessions();
  setRow(sb, 1, { date: '2026-07-21', start: '10:00', end: '11:30' }); setRow(sb, 2, { date: '2026-07-22', start: '14:00', end: '15:30' });
  const snap = rows(sb); sb.el('ps-create-private-lesson-qty').value = '2'; sb.scheduleSyncPrivateLessonSessions();
  const after = rows(sb);
  assert('1→3→2 preserves first two', after.length === 2 && after[0].start === snap[0].start && after[1].start === snap[1].start && after[0].date === snap[0].date);
  setRow(sb, 1, { date: '2026-12-31', start: '10:00', end: '12:00' }); sb.scheduleAddPrivateLessonSession();
  assert('Dec31+1 → 2027-01-01', rows(sb).length === 3 && rows(sb)[2].date === '2027-01-01');
  setRow(sb, 2, { date: '2027-01-31', start: '10:00', end: '12:00' }); sb.scheduleAddPrivateLessonSession();
  assert('Jan31+1 → 2027-02-01', rows(sb)[3].date === '2027-02-01');
  setRow(sb, 3, { date: '2027-02-28', start: '10:00', end: '12:00' }); sb.scheduleAddPrivateLessonSession();
  assert('non-leap Feb28+1 → 2027-03-01', rows(sb)[4].date === '2027-03-01');
  setRow(sb, 4, { date: '2028-02-28', start: '10:00', end: '12:00' }); sb.scheduleAddPrivateLessonSession();
  assert('leap Feb28+1 → 2028-02-29', rows(sb)[5].date === '2028-02-29');
}
console.log('\n[6] Outer min/max + payload + impossible clear');
{
  const sb = build({ today: '2026-07-20' });
  pick(sb, 'ps-create-comp-private-lesson');
  sb.el('ps-create-private-lesson-qty').value = '3'; sb.scheduleSyncPrivateLessonSessions();
  setRow(sb, 0, { date: '2026-07-22', start: '10:00', end: '12:00' }); setRow(sb, 1, { date: '2026-07-20', start: '11:00', end: '13:00' }); setRow(sb, 2, { date: '2026-07-21', start: '09:00', end: '11:00' });
  sb.scheduleUpdatePrivateLessonDateRangeFromSessions();
  assert('min/max outer', sb.el('ps-create-date-from').value === '2026-07-20' && sb.el('ps-create-date-to').value === '2026-07-22');
  setRow(sb, 1, { date: '', start: '11:00', end: '13:00' });
  const sess = sb.scheduleReadCreatePayload().components.private_lesson.sessions;
  assert('payload keeps blank-date row in order', sess.length === 3 && sess[0].date === '2026-07-22' && sess[1].date === '' && sess[2].date === '2026-07-21' && sb.scheduleReadCreatePayload().components.private_lesson.quantity === 3);
  setRow(sb, 0, { date: '2026-02-31' }); setRow(sb, 2, { date: '2026-07-21x' }); sb.scheduleUpdatePrivateLessonDateRangeFromSessions();
  assert('impossible/junk clear outer', sb.el('ps-create-date-from').value === '' && sb.el('ps-create-date-to').value === '');
  setRow(sb, 0, { date: '2026-07-10', start: '10:00', end: '12:00' }); setRow(sb, 2, { date: '2026-07-11', start: '10:00', end: '12:00' }); sb.scheduleUpdatePrivateLessonDateRangeFromSessions();
  assert('past-only clears outer', sb.el('ps-create-date-from').value === '' && sb.el('ps-create-date-to').value === '');
}
console.log('\n[7] Shared validation owner');
{
  const sb = build({ today: '2026-07-20' });
  const V = (pl) => sb.schedulePortalValidatePrivateLessonCreate(pl);
  assert('validate helper+cases', typeof V === 'function'
    && V({ quantity: 1, sessions: [{ date: '', start: '10:00', end: '12:00' }] }).ok === false
    && V({ quantity: 1, sessions: [{ date: '2026-07-20', start: '', end: '12:00' }] }).ok === false
    && V({ quantity: 1, sessions: [{ date: '2026-07-20', start: '12:00', end: '10:00' }] }).ok === false
    && V({ quantity: 1, sessions: [{ date: '2026-07-10', start: '10:00', end: '12:00' }] }).ok === false
    && V({ quantity: 1, sessions: [{ date: '2026-02-31', start: '10:00', end: '12:00' }] }).ok === false
    && V({ quantity: 2, sessions: [{ date: '2026-07-20', start: '10:00', end: '12:00' }, { date: '2026-07-20', start: '10:00', end: '12:00' }] }).ok === false
    && V({ quantity: 31, sessions: Array.from({ length: 31 }, () => ({ date: '2026-07-20', start: '10:00', end: '12:00' })) }).ok === false
    && V({ quantity: 2, sessions: [{ date: '2026-07-20', start: '10:00', end: '12:00' }, { date: '2026-07-21', start: '10:00', end: '12:00' }] }).ok === true);
  assert('submit+preview use validate', /function submitScheduleManualBooking[\s\S]*schedulePortalValidatePrivateLessonCreate/.test(portalSrc) && /function schedulePortalRunPreviewQuote[\s\S]*schedulePortalValidatePrivateLessonCreate/.test(portalSrc));
}
console.log('\n[8] Same-open preserve + fresh open clear');
{
  const sb = build();
  sb._gear = [{ offering_key: 'board_rental', quantity: 2, duration_key: '3_days' }];
  pick(sb, 'ps-create-comp-private-lesson'); sb.scheduleAddPrivateLessonSession();
  setRow(sb, 0, { date: '2026-07-22', start: '09:00', end: '11:00' }); setRow(sb, 1, { date: '2026-07-23', start: '14:00', end: '16:00' });
  const preserved = rows(sb); pick(sb, 'ps-create-comp-course');
  assert('gear survives', sb._gear[0].offering_key === 'board_rental');
  pick(sb, 'ps-create-comp-private-lesson'); const back = rows(sb);
  assert('same-open Private→Group→Private preserves', back.length === 2 && back[0].date === preserved[0].date && back[1].start === preserved[1].start);
  assert('fresh open clears sessions', /function schedulePortalClearCreateDraftFields[\s\S]*ps-create-private-lesson-sessions[\s\S]*innerHTML\s*=\s*''/.test(portalSrc) && /set\('ps-create-private-lesson-qty',\s*'1'\)/.test(portalSrc));
}
console.log('\n[9] One field → one quote + auto-end payload');
{
  const sb = build();
  pick(sb, 'ps-create-comp-private-lesson'); sb._quote.n = 0; sb._quote.payloads.length = 0;
  const dateEl = sb.el('ps-create-private-lesson-sessions').querySelectorAll('.ps-pl-session-date')[0];
  assert('date wired', !!(dateEl && dateEl._ls && dateEl._ls.change && dateEl._ls.change.length));
  dateEl.value = '2026-07-24'; dateEl.dispatchEvent({ type: 'change', target: dateEl });
  assert('one date → one quote', sb._quote.n === 1, String(sb._quote.n));
  sb._quote.n = 0; sb._quote.payloads.length = 0;
  const startEl = sb.el('ps-create-private-lesson-sessions').querySelectorAll('.ps-pl-session-start')[0];
  startEl.value = '11:00'; startEl.dispatchEvent({ type: 'change', target: startEl });
  assert('one start → one quote', sb._quote.n === 1, String(sb._quote.n));
  const lastPay = sb._quote.payloads[sb._quote.payloads.length - 1];
  assert('start auto-end in payload', !!(lastPay && lastPay.components.private_lesson.sessions[0].start === '11:00' && lastPay.components.private_lesson.sessions[0].end === '13:00'));
}
console.log('\n[10] Accessible remove');
{
  const sb = build();
  pick(sb, 'ps-create-comp-private-lesson');
  assert('no remove on single', sb.el('ps-create-private-lesson-sessions').querySelectorAll('.portal-schedule-session-remove').length === 0);
  sb.scheduleAddPrivateLessonSession();
  const html = sb.el('ps-create-private-lesson-sessions').innerHTML;
  assert('remove each multi-row', sb.el('ps-create-private-lesson-sessions').querySelectorAll('.portal-schedule-session-remove').length === 2);
  assert('remove a11y i18n', /data-i18n="schedule\.create\.privateLesson\.removeSession"/.test(html) && /aria-label=|data-i18n-aria=/.test(html));
}
console.log('\n[11] Ownership markers');
assert('ownership markers', /components\.private_lesson\s*=\s*\{[\s\S]*sessions:\s*plSessions/.test(apiSrc)
  && /dateRange\.style\.display\s*=\s*privateOn\s*\?\s*'none'/.test(apiSrc)
  && /function scheduleSyncPrivateLessonSessions/.test(portalSrc)
  && /function schedulePrivateLessonSessionsRefreshDependents/.test(portalSrc));
console.log('\n[12] Real preview gate + add-session finals + RED');
const asyncPass = (async () => {
  const sb = build({ today: '2026-07-20', dateFrom: '2026-07-20' });
  pick(sb, 'ps-create-comp-private-lesson');
  const bad = [
    { date: '', start: '10:00', end: '12:00' }, { date: '2026-07-20', start: '', end: '12:00' },
    { date: '2026-07-20', start: '10:00', end: '' }, { date: '2026-02-31', start: '10:00', end: '12:00' },
    { date: '2026-07-10', start: '10:00', end: '12:00' }, { date: '2026-07-21x', start: '10:00', end: '12:00' },
    { date: '2026-07-20', start: '12:00', end: '10:00' }, { date: '2026', start: '1', end: 'x' },
  ];
  for (const row of bad) await soft(sb, row);
  sb.el('ps-create-private-lesson-qty').value = '2'; sb.scheduleSyncPrivateLessonSessions({ deferSideEffects: true });
  setRow(sb, 0, { date: '2026-07-20', start: '10:00', end: '12:00' }); setRow(sb, 1, { date: '2026-07-20', start: '10:00', end: '12:00' });
  sb._quote.fetch = 0; let res = await sb.schedulePortalRunPreviewQuote();
  assert('duplicate soft zero quote', res && res.softInvalid && sb._quote.fetch === 0);
  sb.el('ps-create-private-lesson-qty').value = '3'; sb._quote.fetch = 0; res = await sb.schedulePortalRunPreviewQuote();
  assert('qty mismatch soft zero quote', res && res.softInvalid && sb._quote.fetch === 0);
  sb.el('ps-create-private-lesson-qty').value = '31'; sb._quote.fetch = 0; res = await sb.schedulePortalRunPreviewQuote();
  assert('>30 soft zero quote', res && res.softInvalid && sb._quote.fetch === 0);
  sb.el('ps-create-private-lesson-qty').value = '1'; sb.scheduleSyncPrivateLessonSessions({ deferSideEffects: true });
  setRow(sb, 0, { date: '2026-07-21', start: '10:00', end: '12:00' }); sb._quote.fetch = 0; res = await sb.schedulePortalRunPreviewQuote();
  assert('valid → one quote fetch', sb._quote.fetch === 1 && res && res.ok === true, String(sb._quote.fetch));
  pick(sb, 'ps-create-comp-course');
  const realRead = sb.scheduleReadCreatePayload;
  sb.scheduleReadCreatePayload = function () { const p = realRead(); p.components = { course: { course_id: 'c1', tier_key: '1h', quantity: 1 } }; return p; };
  sb._quote.fetch = 0;
  await sb.schedulePortalRunPreviewQuote();
  assert('group quote unaffected', sb._quote.fetch === 1, String(sb._quote.fetch));
  sb.scheduleReadCreatePayload = realRead;
  pick(sb, 'ps-create-comp-private-lesson');
  setRow(sb, 0, { date: '2026-07-20', start: '09:00', end: '11:00' });
  sb._quote.n = 0; sb._quote.payloads.length = 0; sb._quote.rentalsSpans.length = 0; sb._quote.fullDayDates.length = 0;
  sb.scheduleAddPrivateLessonSession();
  assert('add one quote schedule', sb._quote.n === 1, String(sb._quote.n));
  const sess = sb._quote.payloads[0] && sb._quote.payloads[0].components.private_lesson.sessions;
  assert('add payload final next-day/last-times', !!(sess && sess[1] && sess[1].date === '2026-07-21' && sess[1].start === '09:00' && sess[1].end === '11:00'), JSON.stringify(sess && sess[1]));
  const rSpan = sb._quote.rentalsSpans[sb._quote.rentalsSpans.length - 1];
  const fd = sb._quote.fullDayDates[sb._quote.fullDayDates.length - 1];
  assert('rentals see final dates', !!(rSpan && rSpan.from === '2026-07-20' && rSpan.to === '2026-07-21'), JSON.stringify(rSpan));
  assert('full-day sees final dates', !!(fd && fd.indexOf('2026-07-21') >= 0), JSON.stringify(fd));
  sb._quote.n = 0; sb.el('ps-create-private-lesson-qty').value = '3'; sb.scheduleSyncPrivateLessonSessions();
  assert('count → one quote schedule', sb._quote.n === 1, String(sb._quote.n));
  sb._quote.n = 0; sb.scheduleRemovePrivateLessonSession(2);
  assert('remove → one quote schedule', sb._quote.n === 1, String(sb._quote.n));
  sb.el('ps-create-private-lesson-qty').value = '1'; sb.scheduleSyncPrivateLessonSessions({ deferSideEffects: true });
  setRow(sb, 0, { date: '2026-02-31', start: '10:00', end: '12:00' });
  sb._quote.rentalsSpans.length = 0; sb._quote.fullDayDates.length = 0; sb._quote.fetch = 0;
  sb.schedulePrivateLessonSessionsRefreshDependents();
  assert('impossible outer empty', sb.el('ps-create-date-from').value === '' && sb.el('ps-create-date-to').value === '', 'from=' + sb.el('ps-create-date-from').value);
  const r = sb._quote.rentalsSpans[sb._quote.rentalsSpans.length - 1], f = sb._quote.fullDayDates[sb._quote.fullDayDates.length - 1];
  assert('impossible not in rentals/full-day', !(r && (r.from === '2026-02-31' || r.to === '2026-02-31')) && !(f && f.indexOf('2026-02-31') >= 0));
  res = await sb.schedulePortalRunPreviewQuote();
  assert('impossible zero quote fetch', res && res.softInvalid && sb._quote.fetch === 0);
  setRow(sb, 0, { date: '2026-07-10', start: '10:00', end: '12:00' }); sb.scheduleUpdatePrivateLessonDateRangeFromSessions();
  assert('past outer empty', sb.el('ps-create-date-from').value === '' && sb.el('ps-create-date-to').value === '');
  setRow(sb, 0, { date: '2026-07-21junk', start: '10:00', end: '12:00' }); sb.scheduleUpdatePrivateLessonDateRangeFromSessions();
  assert('suffix junk outer empty', sb.el('ps-create-date-from').value === '' && sb.el('ps-create-date-to').value === '');
  const red1Fn = extractFn(portalSrc, 'schedulePortalRunPreviewQuote').replace('if (!plGate || plGate.ok !== true)', 'if (false && (!plGate || plGate.ok !== true))');
  assert('RED1 mutates gate away', /if \(false && \(!plGate/.test(red1Fn) && /softInvalid:\s*true/.test(extractFn(portalSrc, 'schedulePortalRunPreviewQuote') || ''));
  const sb1 = build({ today: '2026-07-20' });
  vm.runInContext((extractFn(portalSrc, 'schedulePortalClearQuotePreviewUi') || '') + '\n' + red1Fn, sb1);
  pick(sb1, 'ps-create-comp-private-lesson'); setRow(sb1, 0, { date: '', start: '10:00', end: '12:00' }); sb1._quote.fetch = 0;
  await sb1.schedulePortalRunPreviewQuote();
  assert('RED1 invalid quote >0', sb1._quote.fetch > 0, String(sb1._quote.fetch));
  const red2Fn = 'function scheduleUpdatePrivateLessonDateRangeFromSessions(){var sessions=scheduleReadPrivateLessonSessionsFromDom();var dates=[];for(var i=0;i<sessions.length;i++){var d=sessions[i]&&sessions[i].date?String(sessions[i].date):\'\';if(/^\\d{4}-\\d{2}-\\d{2}$/.test(d))dates.push(d);}if(!dates.length)return;dates.sort();var df=el(\'ps-create-date-from\');var dt=el(\'ps-create-date-to\');if(df)df.value=dates[0];if(dt)dt.value=dates[dates.length-1];}';
  const sb2 = build({ today: '2026-07-20' }); vm.runInContext(red2Fn, sb2); pick(sb2, 'ps-create-comp-private-lesson');
  setRow(sb2, 0, { date: '2026-02-31', start: '10:00', end: '12:00' }); sb2.scheduleUpdatePrivateLessonDateRangeFromSessions();
  assert('RED2 impossible contaminates outer', sb2.el('ps-create-date-from').value === '2026-02-31');
  const red3Add = extractFn(portalSrc, 'scheduleAddPrivateLessonSession').replace('scheduleSyncPrivateLessonSessions({ deferSideEffects: true });', 'scheduleSyncPrivateLessonSessions();').replace('schedulePrivateLessonSessionsRefreshDependents();', 'scheduleUpdatePrivateLessonDateRangeFromSessions();');
  const sb3 = build({ dateFrom: '2026-07-20', today: '2026-07-20' }); vm.runInContext(red3Add, sb3);
  pick(sb3, 'ps-create-comp-private-lesson'); setRow(sb3, 0, { date: '2026-07-20', start: '09:00', end: '11:00' });
  sb3._quote.payloads.length = 0; sb3._quote.n = 0; sb3._quote.rentalsSpans.length = 0; sb3.scheduleAddPrivateLessonSession();
  const firstSess = sb3._quote.payloads[0] && sb3._quote.payloads[0].components.private_lesson.sessions;
  const preFinalWrong = !firstSess || !firstSess[1] || firstSess[1].date !== '2026-07-21' || firstSess[1].start !== '09:00';
  const rentalsStale = sb3._quote.rentalsSpans[0] && sb3._quote.rentalsSpans[0].to !== '2026-07-21';
  assert('RED3 pre-final payload or rentals stale', preFinalWrong || rentalsStale || sb3._quote.n !== 1);
  assert('prior slice gates', /function schedulePortalCanonicalDateIso/.test(portalSrc) && /myOpenGen !== schedulePortalOpenGen/.test(portalSrc) && /function scheduleRefreshCreateEmptyGuidance/.test(apiSrc) && /ps-create-comp-no-lesson/.test(apiSrc));
})();

asyncPass.then(() => {
  console.log('\n' + '─'.repeat(48));
  console.log('Results: ' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) { console.error('verify:sunset-booking-create-when-sessions — FAILED'); process.exit(1); }
  console.log('verify:sunset-booking-create-when-sessions — ALL CHECKS PASSED'); process.exit(0);
}).catch((err) => { console.error(err); console.error('verify:sunset-booking-create-when-sessions — FAILED'); process.exit(1); });
