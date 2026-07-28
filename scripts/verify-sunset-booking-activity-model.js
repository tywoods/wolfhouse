'use strict';
/**
 * verify:sunset-booking-activity-model
 *
 * Project Kaya Slice 2 — offline hostile checks for create-drawer main activity
 * (Group / Private / No lesson). Static source + real production wiring for
 * empty guidance (fullDay finally, rental wire, activity listeners).
 * No Staff API, DB, network, browser, or deploy.
 *
 * Run: node scripts/verify-sunset-booking-activity-model.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PORTAL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');
let pass = 0; let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}
function extractCreateModalHtml(src) {
  const start = src.indexOf('id="ps-create-modal"');
  if (start < 0) return '';
  const open = src.lastIndexOf('<div', start);
  const end = src.indexOf('id="ps-drawer-backdrop"', open);
  if (end < 0) return src.slice(open, open + 14000);
  const close = src.lastIndexOf('</div>', end);
  return src.slice(open, close > open ? close + 6 : end);
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
function inputSnip(html, id) {
  const m = html.match(new RegExp('<input[^>]*\\bid="' + id + '"[^>]*>', 'i'));
  return m ? m[0] : '';
}
function labelFor(html, id) {
  const wrap = html.match(new RegExp('<label[^>]*>[\\s\\S]{0,400}?\\bid="' + id + '"[\\s\\S]{0,400}?</label>', 'i'));
  if (wrap) return wrap[0];
  const byFor = html.match(new RegExp('<label[^>]*\\bfor="' + id + '"[^>]*>[\\s\\S]{0,300}?</label>', 'i'));
  return byFor ? byFor[0] : '';
}
function listen(node) {
  node._ls = node._ls || {};
  node.addEventListener = function (ev, fn) { (this._ls[ev] = this._ls[ev] || []).push(fn); };
  node.dispatchEvent = function (ev) { (this._ls[ev && ev.type] || []).forEach((fn) => fn.call(this, ev)); };
  return node;
}
function cl(...init) {
  const set = new Set(init);
  return {
    contains(c) { return set.has(c); }, add(c) { set.add(c); }, remove(c) { set.delete(c); },
    toggle(c, force) {
      if (force === true) set.add(c); else if (force === false) set.delete(c);
      else if (set.has(c)) set.delete(c); else set.add(c);
      return set.has(c);
    },
  };
}
console.log('\nverify:sunset-booking-activity-model — Kaya Slice 2 main activity\n');
const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const portalSrc = fs.existsSync(PORTAL_MODULE) ? fs.readFileSync(PORTAL_MODULE, 'utf8') : '';
const modalHtml = extractCreateModalHtml(apiSrc);
console.log('[1] Radio markup + stable IDs + shell');
const courseSnip = inputSnip(modalHtml, 'ps-create-comp-course');
const privateSnip = inputSnip(modalHtml, 'ps-create-comp-private-lesson');
const noneSnip = inputSnip(modalHtml, 'ps-create-comp-no-lesson');
assert('course id once', count(modalHtml, 'id="ps-create-comp-course"') === 1);
assert('private id once', count(modalHtml, 'id="ps-create-comp-private-lesson"') === 1);
assert('no-lesson id once', count(modalHtml, 'id="ps-create-comp-no-lesson"') === 1);
assert('course radio', /\btype=["']radio["']/.test(courseSnip) && !/\btype=["']checkbox["']/.test(courseSnip));
assert('private radio', /\btype=["']radio["']/.test(privateSnip) && !/\btype=["']checkbox["']/.test(privateSnip));
assert('no-lesson radio', /\btype=["']radio["']/.test(noneSnip));
const radioName = (courseSnip.match(/\bname=["']([^"']+)["']/) || [])[1];
assert('shared radio name', !!radioName
  && (privateSnip.includes('name="' + radioName + '"') || privateSnip.includes("name='" + radioName + "'"))
  && (noneSnip.includes('name="' + radioName + '"') || noneSnip.includes("name='" + radioName + "'")));
assert('radiogroup role', /role=["']radiogroup["']/.test(modalHtml));
assert('initial No lesson checked', /\bchecked\b/.test(noneSnip));
assert('course not default-on', !/\bchecked\b/.test(courseSnip));
assert('private not default-on', !/\bchecked\b/.test(privateSnip));
assert('unpaid default', /value=["']unpaid["']/.test(modalHtml));
assert('course labeled', /data-i18n=["']schedule\.type\.course["']/.test(labelFor(modalHtml, 'ps-create-comp-course')));
assert('private labeled', /data-i18n=["']schedule\.type\.privateLesson["']/.test(labelFor(modalHtml, 'ps-create-comp-private-lesson')));
assert('no-lesson labeled', /data-i18n=["']schedule\.type\.noLesson["']/.test(labelFor(modalHtml, 'ps-create-comp-no-lesson')));
assert('no div click simulation', !/data-main-activity-click|onclick=["'][^"']*ps-create-comp-course/.test(modalHtml));
assert('activity empty-hint once', count(modalHtml, 'id="ps-create-activity-empty-hint"') === 1);
assert('no gear empty-hint duplicate', !/id="ps-create-gear-empty-hint"/.test(modalHtml));
assert('empty key single hint', count(modalHtml, 'data-i18n="schedule.create.emptyNoLessonNoGear"') === 1);
assert('courseSelect key present', /data-i18n=["']schedule\.create\.courseSelect["']/.test(modalHtml));
const courseSelectLabel = (modalHtml.match(/for="ps-create-course-select"[^>]*>[\s\S]{0,120}?<\/label>/) || [''])[0];
assert('no duplicate Group course select label', !/>\s*Group course\s*</i.test(courseSelectLabel) && !/>\s*Group Course\s*</i.test(courseSelectLabel));
assert('shell Guest→What→When→Payment', ['guest', 'what', 'when', 'payment'].every((s) => modalHtml.includes('data-create-section="' + s + '"')));
assert('sticky header/body/footer', /portal-schedule-create-header/.test(modalHtml) && /portal-schedule-create-body/.test(modalHtml) && /portal-schedule-create-footer/.test(modalHtml));
const idCounts = {};
let m; const idRe = /\bid="(ps-create-[^"]+)"/g;
while ((m = idRe.exec(modalHtml))) idCounts[m[1]] = (idCounts[m[1]] || 0) + 1;
assert('no duplicate ps-create ids', Object.keys(idCounts).filter((k) => idCounts[k] > 1).length === 0);
assert('no-lesson id once in API', count(apiSrc, 'id="ps-create-comp-no-lesson"') === 1);
console.log('\n[2] EN/ES/IT keys');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const esPack = require('./lib/staff-portal-i18n-es-sunset');
const enPack = STAFF_PORTAL_STRINGS.en || {};
const itPack = STAFF_PORTAL_STRINGS.it || {};
[
  { key: 'schedule.create.mainActivity', en: 'Main activity' },
  { key: 'schedule.type.noLesson', en: 'Equipment only' },
  { key: 'schedule.create.emptyNoLessonNoGear', enRe: /lesson|gear|rental|booking/i },
  { key: 'schedule.create.courseSelect', enNot: /^Group\s*course$/i },
  { key: 'schedule.type.course' },
  { key: 'schedule.type.privateLesson' },
].forEach((row) => {
  const en = enPack[row.key]; const es = esPack[row.key]; const it = itPack[row.key];
  assert('EN ' + row.key, typeof en === 'string' && en.trim());
  assert('ES ' + row.key, typeof es === 'string' && es.trim() && es !== en && es !== row.key);
  assert('IT ' + row.key, typeof it === 'string' && it.trim() && it !== en && it !== row.key);
  if (row.en) assert('EN exact ' + row.key, en === row.en);
  if (row.enRe) assert('EN meaning ' + row.key, row.enRe.test(en));
  if (row.enNot) assert('EN not dup ' + row.key, !row.enNot.test(String(en).trim()));
});
console.log('\n[3] Hostile event/UI — real fullDay finally + rental wire + activity listeners');
const onChangeSrc = extractFn(apiSrc, 'scheduleOnCreateComponentChange');
const populateSrc = extractFn(apiSrc, 'schedulePopulateCreateComponentFields');
const payloadSrc = extractFn(apiSrc, 'scheduleReadCreatePayload');
const guidanceSrc = extractFn(apiSrc, 'scheduleRefreshCreateEmptyGuidance');
const fullDaySrc = extractFn(apiSrc, 'scheduleRefreshCreateFullDayAddon');
const wireRentalsSrc = extractFn(apiSrc, 'scheduleWireCreateRentals');
const exclusionUiSrc = extractFn(apiSrc, 'scheduleApplyCreateRentalExclusionUi');
const readRentalsSrc = extractFn(apiSrc, 'scheduleReadCreateRentalSelectionFromDom');
const activityLoopSrc = (apiSrc.match(
  /\['ps-create-comp-course','ps-create-comp-private-lesson','ps-create-comp-no-lesson'\]\.forEach\(function\(id\)\{[\s\S]*?node\.addEventListener\('change', function\(\)\{ scheduleOnCreateComponentChange\(id\); \}\);[\s\S]*?\}\);/
) || [null])[0];
assert('onChange extractable', !!onChangeSrc);
assert('populate extractable', !!populateSrc);
assert('payload extractable', !!payloadSrc);
assert('guidance extractable', !!guidanceSrc);
assert('fullDayAddon extractable', !!fullDaySrc);
assert('wireCreateRentals extractable', !!wireRentalsSrc);
assert('activity listener loop extractable', !!activityLoopSrc);
assert('wire includes no-lesson', apiSrc.includes("'ps-create-comp-no-lesson'") && apiSrc.includes('scheduleOnCreateComponentChange'));
assert('fullDay finally refreshes empty guidance', /finally\s*\{\s*scheduleRefreshCreateEmptyGuidance\s*\(\s*\)\s*;?\s*\}/.test(fullDaySrc || ''));
assert('populate calls fullDay (not direct empty guidance)', populateSrc && populateSrc.includes('scheduleRefreshCreateFullDayAddon') && !populateSrc.includes('scheduleRefreshCreateEmptyGuidance'));
assert('rental wire calls fullDay (not direct empty guidance)', wireRentalsSrc && count(wireRentalsSrc, 'scheduleRefreshCreateFullDayAddon') >= 2 && !wireRentalsSrc.includes('scheduleRefreshCreateEmptyGuidance'));
function buildHarness(fullDaySource, wireSource) {
  const nodes = {}; const byName = {};
  const rentalState = { board: false, qty: 1 };
  function radio(id, name, checked) {
    const node = listen({ id, type: 'radio', name, dataset: {}, style: { display: '' }, _checked: !!checked });
    Object.defineProperty(node, 'checked', {
      configurable: true, enumerable: true,
      get() { return this._checked; },
      set(v) {
        this._checked = !!v;
        if (v && this.name) (byName[this.name] || []).forEach((p) => { if (p !== this) p._checked = false; });
      },
    });
    (byName[name] = byName[name] || []).push(node); nodes[id] = node;
  }
  function box(id, display) {
    nodes[id] = listen({
      id, style: { display: display == null ? '' : display }, dataset: {}, classList: cl(),
      querySelectorAll() { return []; }, querySelector() { return null; },
      innerHTML: '', setAttribute() {}, getAttribute() { return ''; }, textContent: '',
    });
  }
  function input(id, value) {
    nodes[id] = listen({
      id, value: value == null ? '' : value, checked: false, style: { display: '' },
      dataset: {}, options: [], selectedIndex: -1, classList: cl(),
    });
  }
  radio('ps-create-comp-course', 'ps-create-main-activity', false);
  radio('ps-create-comp-private-lesson', 'ps-create-main-activity', false);
  radio('ps-create-comp-no-lesson', 'ps-create-main-activity', true);
  ['ps-create-course-fields', 'ps-create-course-tier-wrap', 'ps-create-course-qty-wrap',
    'ps-create-private-lesson-fields', 'ps-create-addon-fullday-field', 'ps-create-fullday-card',
    'ps-create-fullday-rows', 'ps-create-fullday-summary', 'ps-create-fullday-price-hint']
    .forEach((id) => box(id, 'none'));
  box('ps-create-date-range', ''); box('ps-create-activity-empty-hint', '');
  const check = listen({
    type: 'checkbox', classList: cl('ps-create-rental-check'), className: 'ps-create-rental-check', disabled: false,
    getAttribute(n) { return n === 'data-offering-key' ? 'board_rental' : null; }, setAttribute() {},
  });
  Object.defineProperty(check, 'checked', {
    configurable: true, enumerable: true,
    get() { return !!rentalState.board; }, set(v) { rentalState.board = !!v; },
  });
  const qty = listen({
    type: 'number', classList: cl('ps-create-rental-qty-input'), className: 'ps-create-rental-qty-input',
    get value() { return String(rentalState.qty); },
    set value(v) { rentalState.qty = parseInt(v, 10) || 1; },
  });
  const qtyWrap = { style: { display: '' } }; const label = { classList: cl() };
  const row = {
    getAttribute(n) { return n === 'data-rental-offering' ? 'board_rental' : null; },
    querySelector(sel) {
      if (sel === '.ps-create-rental-check') return check;
      if (sel === 'input.ps-create-rental-qty-input' || sel === '.ps-create-rental-qty-input') return qty;
      if (sel === '.portal-schedule-create-rental-qty') return qtyWrap;
      if (sel === '.portal-schedule-create-check') return label;
      return null;
    },
  };
  const rentals = listen({
    dataset: { rentalWired: '' },
    getAttribute(k) { return k === 'data-duration-key' ? '3_days' : ''; }, setAttribute() {},
    querySelectorAll(sel) {
      if (sel === '[data-rental-offering]') return [row];
      if (sel === '.ps-create-rental-check') return [check];
      return [];
    },
    querySelector() { return null; },
  });
  nodes['ps-create-rentals'] = rentals;
  ['ps-create-comp-fullday', 'ps-create-guest', 'ps-create-phone', 'ps-create-notes',
    'ps-create-course-select', 'ps-create-course-tier'].forEach((id) => input(id, ''));
  nodes['ps-create-comp-fullday'].type = 'checkbox';
  input('ps-create-date-from', '2026-07-20'); input('ps-create-date-to', '2026-07-22');
  input('ps-create-payment', 'unpaid'); input('ps-create-course-qty', '1');
  input('ps-create-private-lesson-qty', '1'); input('ps-create-private-lesson-surfers', '1');
  const counters = { guidance: 0, fullDay: 0, preview: 0 };
  const sb = {
    window: { applyStaffPortalI18n() {} }, console,
    el(id) { return nodes[id] || null; },
    schedulePopulateCreateCourseFields() {},
    scheduleFetchLessonTimesConfig() {
      return { then(fn) { if (fn) fn(); return { then(fn2) { if (fn2) fn2(); return this; } }; } };
    },
    scheduleSyncPrivateLessonSessions() {}, scheduleRenderCreateRentals() {},
    scheduleReadPrivateLessonSessionsFromDom() { return []; },
    scheduleRenderFullDayAddonRows() {}, scheduleReadFullDayAddonRows() { return {}; },
    scheduleUpdateCreateTotalPreview() { counters.preview += 1; },
    scheduleEnumerateDates(from) { return from ? [from] : []; },
    scheduleAddonEur(c) { return c == null ? '—' : '€' + (Number(c) / 100).toFixed(2); },
    scheduleApplyRentalMutualExclusion(selectedKeys, toggledKey, checked) {
      const next = {}; (selectedKeys || []).forEach((k) => { next[k] = true; });
      const key = String(toggledKey || '');
      if (checked) next[key] = true; else delete next[key];
      return Object.keys(next);
    },
    scheduleRentalsToLegacyComponents(rentalsList) {
      const c = {};
      (rentalsList || []).forEach((r) => {
        if (r.offering_key === 'board_rental') c.surfboard = { quantity: r.quantity };
      });
      return c;
    },
    scheduleTodayIso() { return '2026-07-20'; }, getClient() { return 'sunset'; },
    scheduleFullDayAddonEnabled: true, scheduleFullDayAddonUnitCents: 2500,
    portalT(k) { return k; }, escHtml(s) { return String(s == null ? '' : s); },
    _counters: counters,
  };
  vm.createContext(sb);
  vm.runInContext([
    guidanceSrc, readRentalsSrc, exclusionUiSrc, wireSource || wireRentalsSrc,
    fullDaySource || fullDaySrc, onChangeSrc, populateSrc, payloadSrc,
  ].filter(Boolean).join('\n'), sb);
  const realG = sb.scheduleRefreshCreateEmptyGuidance;
  const realF = sb.scheduleRefreshCreateFullDayAddon;
  sb.scheduleRefreshCreateEmptyGuidance = function () {
    counters.guidance += 1; return realG.apply(this, arguments);
  };
  sb.scheduleRefreshCreateFullDayAddon = function () {
    counters.fullDay += 1; return realF.apply(this, arguments);
  };
  vm.runInContext(activityLoopSrc, sb);
  sb.scheduleWireCreateRentals(rentals);
  return { sb, nodes, rentals, rentalState, check, qty, counters };
}
function hintVisible(sb) {
  const h = sb.el('ps-create-activity-empty-hint');
  return !!(h && h.style.display !== 'none');
}
function select(sb, id) {
  const node = sb.el(id); node.checked = true;
  node.dispatchEvent({ type: 'change', target: node });
}
try {
  const { sb, nodes, rentals, rentalState, check, qty, counters } = buildHarness();
  assert('initial course false', sb.el('ps-create-comp-course').checked === false);
  assert('initial private false', sb.el('ps-create-comp-private-lesson').checked === false);
  assert('initial no-lesson true', sb.el('ps-create-comp-no-lesson').checked === true);
  let g = counters.guidance;
  sb.schedulePopulateCreateComponentFields();
  assert('No lesson hides course', sb.el('ps-create-course-fields').style.display === 'none');
  assert('No lesson hides private', sb.el('ps-create-private-lesson-fields').style.display === 'none');
  assert('No lesson shows date range', sb.el('ps-create-date-range').style.display !== 'none');
  assert('populate path refreshes guidance via fullDay finally', counters.guidance > g && counters.fullDay > 0);
  assert('empty guidance when no lesson+gear', hintVisible(sb) === true);
  let payload = sb.scheduleReadCreatePayload();
  assert('initial no course component', !payload.components.course);
  assert('initial no private component', !payload.components.private_lesson);
  rentalState.board = true;
  let exclusive = true; let rentalsOk = true;
  [
    'ps-create-comp-course', 'ps-create-comp-private-lesson', 'ps-create-comp-no-lesson',
    'ps-create-comp-course', 'ps-create-comp-private-lesson', 'ps-create-comp-no-lesson',
  ].forEach((id) => {
    select(sb, id);
    const c = sb.el('ps-create-comp-course').checked;
    const p = sb.el('ps-create-comp-private-lesson').checked;
    const n = sb.el('ps-create-comp-no-lesson').checked;
    if ((c ? 1 : 0) + (p ? 1 : 0) + (n ? 1 : 0) !== 1) exclusive = false;
    if (id === 'ps-create-comp-course' && !(c && !p && !n)) exclusive = false;
    if (id === 'ps-create-comp-private-lesson' && !(!c && p && !n)) exclusive = false;
    if (id === 'ps-create-comp-no-lesson' && !(!c && !p && n)) exclusive = false;
    if (!rentalState.board) rentalsOk = false;
  });
  assert('mutual exclusivity across transitions', exclusive);
  assert('rentals survive transitions', rentalsOk);
  select(sb, 'ps-create-comp-course');
  assert('Group shows course', sb.el('ps-create-course-fields').style.display !== 'none');
  assert('Group hides private', sb.el('ps-create-private-lesson-fields').style.display === 'none');
  assert('Group shows date range', sb.el('ps-create-date-range').style.display !== 'none');
  payload = sb.scheduleReadCreatePayload();
  assert('Group payload course only', !!payload.components.course && !payload.components.private_lesson);
  assert('empty guidance hidden on Group', hintVisible(sb) === false);
  select(sb, 'ps-create-comp-private-lesson');
  assert('Private hides course', sb.el('ps-create-course-fields').style.display === 'none');
  assert('Private shows private fields', sb.el('ps-create-private-lesson-fields').style.display !== 'none');
  assert('Private keeps date range (authoritative top dates)', sb.el('ps-create-date-range').style.display !== 'none');
  payload = sb.scheduleReadCreatePayload();
  assert('Private payload private only', !payload.components.course && !!payload.components.private_lesson);
  select(sb, 'ps-create-comp-no-lesson');
  payload = sb.scheduleReadCreatePayload();
  assert('No lesson lesson flags false', !payload.components.course && !payload.components.private_lesson);
  assert('No lesson keeps rentals', !!(payload.components.surfboard || (payload.rentals && payload.rentals.length)));
  // Real scheduleWireCreateRentals → fullDay finally (no direct guidance calls).
  rentalState.board = false; select(sb, 'ps-create-comp-no-lesson');
  assert('empty guidance when no lesson+gear (post reset)', hintVisible(sb) === true);
  g = counters.guidance; check.checked = true;
  rentals.dispatchEvent({ type: 'change', target: check });
  assert('rental checkbox refreshes via wire→fullDay finally', counters.guidance > g);
  assert('empty guidance hidden with gear', hintVisible(sb) === false);
  assert('rental checkbox triggers total preview', counters.preview >= 1);
  g = counters.guidance; qty.value = '2';
  rentals.dispatchEvent({ type: 'change', target: qty });
  rentals.dispatchEvent({ type: 'input', target: qty });
  assert('rental qty change/input refreshes via fullDay finally', counters.guidance > g);
  assert('empty guidance still hidden after qty', hintVisible(sb) === false);
  g = counters.guidance; check.checked = false;
  rentals.dispatchEvent({ type: 'change', target: check });
  assert('rental uncheck refreshes via wire→fullDay finally', counters.guidance > g);
  assert('empty guidance after uncheck', hintVisible(sb) === true);
  // normal / !field / throw — all run finally and count guidance.
  g = counters.guidance; sb.scheduleRefreshCreateFullDayAddon();
  assert('normal fullDay runs finally guidance', counters.guidance === g + 1);
  const savedField = nodes['ps-create-addon-fullday-field'];
  nodes['ps-create-addon-fullday-field'] = null; g = counters.guidance;
  sb.scheduleRefreshCreateFullDayAddon();
  assert('!field early-return still runs finally guidance', counters.guidance === g + 1);
  nodes['ps-create-addon-fullday-field'] = savedField;
  const realRead = sb.scheduleReadCreateRentalSelectionFromDom;
  sb.scheduleReadCreateRentalSelectionFromDom = function boom() { throw new Error('hostile-fullDay-throw'); };
  g = counters.guidance;
  let threw = false;
  try { sb.scheduleRefreshCreateFullDayAddon(); } catch (err) {
    threw = /hostile-fullDay-throw/.test(String(err && err.message));
  }
  sb.scheduleReadCreateRentalSelectionFromDom = realRead;
  assert('throw still propagates from fullDay', threw);
  assert('throw path still ran finally guidance', counters.guidance === g + 1);
  // Production activity path: No lesson → Group changes single hint.
  rentalState.board = false; select(sb, 'ps-create-comp-no-lesson');
  assert('wired No lesson shows empty hint', hintVisible(sb) === true);
  select(sb, 'ps-create-comp-course');
  assert('wired Group hides empty hint', hintVisible(sb) === false);
} catch (err) {
  assert('behavioral sandbox no throw', false, err && (err.stack || err.message));
}
console.log('\n[4] Quote path + payload keys');
assert('change still via scheduleOnCreateComponentChange', apiSrc.includes('scheduleOnCreateComponentChange'));
assert('populate re-renders rentals', populateSrc && populateSrc.includes('scheduleRenderCreateRentals'));
assert('quote debounce path preserved', portalSrc.includes('schedulePortalRefreshCreateQuote') && portalSrc.includes('schedulePortalQuoteDebounceMs'));
assert('one submitScheduleManualBooking', count(portalSrc, 'function submitScheduleManualBooking') === 1);
assert('create submit wired once', /\[\s*['"]ps-create-submit['"]\s*,\s*submitScheduleManualBooking\s*\]/.test(apiSrc));
assert('full-day board+suit', /hasEligibleBase\s*=\s*boardOn\s*&&\s*wetsuitOn/.test(apiSrc) || apiSrc.includes('boardOn && wetsuitOn'));
assert('payload course key', payloadSrc && payloadSrc.includes('components.course'));
assert('payload private_lesson key', payloadSrc && payloadSrc.includes('components.private_lesson'));
assert('no no_lesson component key', payloadSrc && !/components\.no_lesson|components\.none/.test(payloadSrc));
console.log('\n[5] Mutation hostility — strip finally / wire→fullDay → RED');
function runMutation(fullDaySource, wireSource) {
  const { sb, rentals, check, counters } = buildHarness(fullDaySource, wireSource);
  sb.schedulePopulateCreateComponentFields();
  const emptyShows = hintVisible(sb) === true;
  const g0 = counters.guidance;
  check.checked = true; rentals.dispatchEvent({ type: 'change', target: check });
  return { emptyShows, gearHides: hintVisible(sb) === false && counters.guidance > g0 };
}
const green = runMutation(fullDaySrc, wireRentalsSrc);
assert('mutation control GREEN: empty shows via finally', green.emptyShows);
assert('mutation control GREEN: gear hides via wire→fullDay finally', green.gearHides);
const noFinallySrc = String(fullDaySrc)
  .replace(/finally \{ scheduleRefreshCreateEmptyGuidance\(\); \}/, 'finally { /* mutated */ }');
assert('mutated fullDay has no finally guidance call', !/scheduleRefreshCreateEmptyGuidance/.test(noFinallySrc) && /function scheduleRefreshCreateFullDayAddon/.test(noFinallySrc) && /finally \{/.test(noFinallySrc));
const redFinally = runMutation(noFinallySrc, wireRentalsSrc);
assert('mutation RED: strip finally guidance breaks empty guidance path', !(redFinally.emptyShows && redFinally.gearHides), JSON.stringify(redFinally));
const noWireFullDaySrc = String(wireRentalsSrc).replace(/scheduleRefreshCreateFullDayAddon\(\);\s*/g, '');
assert('mutated wire has no fullDay calls', !noWireFullDaySrc.includes('scheduleRefreshCreateFullDayAddon') && /function scheduleWireCreateRentals/.test(noWireFullDaySrc));
const redWire = runMutation(fullDaySrc, noWireFullDaySrc);
assert('mutation RED: strip wire→fullDay breaks gear hint update', redWire.gearHides === false, JSON.stringify(redWire));
console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-booking-activity-model — FAILED');
  process.exit(1);
}
console.log('verify:sunset-booking-activity-model — ALL CHECKS PASSED');
process.exit(0);
