'use strict';

/**
 * verify:sunset-booking-activity-model
 *
 * Project Kaya Slice 2 — offline hostile checks for create-drawer main activity
 * (Group / Private / No lesson). Static source + executed event/UI behavior.
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

let pass = 0;
let fail = 0;
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
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
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
assert('activity empty-hint', /id="ps-create-activity-empty-hint"/.test(modalHtml));
assert('gear empty-hint', /id="ps-create-gear-empty-hint"/.test(modalHtml));
assert('empty key on both hints', count(modalHtml, 'data-i18n="schedule.create.emptyNoLessonNoGear"') >= 2);
assert('courseSelect key present', /data-i18n=["']schedule\.create\.courseSelect["']/.test(modalHtml));
const courseSelectLabel = (modalHtml.match(/for="ps-create-course-select"[^>]*>[\s\S]{0,120}?<\/label>/) || [''])[0];
assert('no duplicate Group course select label',
  !/>\s*Group course\s*</i.test(courseSelectLabel) && !/>\s*Group Course\s*</i.test(courseSelectLabel),
  courseSelectLabel.slice(0, 120));
assert('shell Guest→What→When→Payment',
  ['guest', 'what', 'when', 'payment'].every((s) => modalHtml.includes('data-create-section="' + s + '"')));
assert('sticky header/body/footer',
  /portal-schedule-create-header/.test(modalHtml)
  && /portal-schedule-create-body/.test(modalHtml)
  && /portal-schedule-create-footer/.test(modalHtml));
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
const I18N = [
  { key: 'schedule.create.mainActivity', en: 'Main activity' },
  { key: 'schedule.type.noLesson', en: 'No lesson' },
  { key: 'schedule.create.emptyNoLessonNoGear', enRe: /lesson|gear|rental|booking/i },
  { key: 'schedule.create.courseSelect', enNot: /^Group\s*course$/i },
  { key: 'schedule.type.course' },
  { key: 'schedule.type.privateLesson' },
];
I18N.forEach((row) => {
  const en = enPack[row.key]; const es = esPack[row.key]; const it = itPack[row.key];
  assert('EN ' + row.key, typeof en === 'string' && en.trim());
  assert('ES ' + row.key, typeof es === 'string' && es.trim() && es !== en && es !== row.key);
  assert('IT ' + row.key, typeof it === 'string' && it.trim() && it !== en && it !== row.key);
  if (row.en) assert('EN exact ' + row.key, en === row.en);
  if (row.enRe) assert('EN meaning ' + row.key, row.enRe.test(en));
  if (row.enNot) assert('EN not dup ' + row.key, !row.enNot.test(String(en).trim()));
});

console.log('\n[3] Hostile event/UI behavior (executed)');
const onChangeSrc = extractFn(apiSrc, 'scheduleOnCreateComponentChange');
const populateSrc = extractFn(apiSrc, 'schedulePopulateCreateComponentFields');
const payloadSrc = extractFn(apiSrc, 'scheduleReadCreatePayload');
const guidanceSrc = extractFn(apiSrc, 'scheduleRefreshCreateEmptyGuidance');
assert('onChange extractable', !!onChangeSrc);
assert('populate extractable', !!populateSrc);
assert('payload extractable', !!payloadSrc);
assert('guidance extractable', !!guidanceSrc);
assert('wire includes no-lesson',
  apiSrc.includes("'ps-create-comp-no-lesson'") && apiSrc.includes('scheduleOnCreateComponentChange'));

function buildDom() {
  const nodes = {};
  const byName = {};
  function radio(id, name, value, checked) {
    const node = {
      id, type: 'radio', name, value, dataset: {}, style: { display: '' },
      _checked: !!checked, _ls: {},
      addEventListener(ev, fn) { (this._ls[ev] = this._ls[ev] || []).push(fn); },
      dispatchEvent(ev) { (this._ls[ev.type] || []).forEach((fn) => fn.call(this, ev)); },
    };
    Object.defineProperty(node, 'checked', {
      configurable: true, enumerable: true,
      get() { return this._checked; },
      set(v) {
        this._checked = !!v;
        if (v && this.name) (byName[this.name] || []).forEach((p) => { if (p !== this) p._checked = false; });
      },
    });
    (byName[name] = byName[name] || []).push(node);
    nodes[id] = node;
  }
  function box(id, display) {
    nodes[id] = {
      id, style: { display: display == null ? '' : display }, dataset: {},
      querySelectorAll() { return []; }, querySelector() { return null; },
      innerHTML: '', setAttribute() {}, getAttribute() { return ''; }, addEventListener() {},
    };
  }
  function input(id, value) {
    nodes[id] = { id, value: value == null ? '' : value, checked: false, style: { display: '' }, dataset: {}, options: [], selectedIndex: -1, addEventListener() {} };
  }
  radio('ps-create-comp-course', 'ps-create-main-activity', 'group', false);
  radio('ps-create-comp-private-lesson', 'ps-create-main-activity', 'private', false);
  radio('ps-create-comp-no-lesson', 'ps-create-main-activity', 'none', true);
  ['ps-create-course-fields', 'ps-create-course-tier-wrap', 'ps-create-course-qty-wrap',
    'ps-create-private-lesson-fields', 'ps-create-addon-fullday-field', 'ps-create-fullday-card',
    'ps-create-fullday-rows', 'ps-create-fullday-summary'].forEach((id) => box(id, 'none'));
  box('ps-create-date-range', '');
  box('ps-create-activity-empty-hint', '');
  box('ps-create-gear-empty-hint', '');
  box('ps-create-rentals', '');
  ['ps-create-comp-fullday', 'ps-create-guest', 'ps-create-phone', 'ps-create-notes',
    'ps-create-course-select', 'ps-create-course-tier'].forEach((id) => input(id, ''));
  input('ps-create-date-from', '2026-07-20');
  input('ps-create-date-to', '2026-07-22');
  input('ps-create-payment', 'unpaid');
  input('ps-create-course-qty', '1');
  input('ps-create-private-lesson-qty', '1');
  input('ps-create-private-lesson-surfers', '1');
  const rentalState = { board: false, suit: false };
  nodes['ps-create-rentals'].querySelectorAll = function qs(sel) {
    if (sel === '[data-rental-offering]') {
      return [
        { getAttribute(a) { return a === 'data-rental-offering' ? 'board_rental' : ''; },
          querySelector(s) {
            if (s === '.ps-create-rental-check') return { checked: rentalState.board };
            if (s === 'input.ps-create-rental-qty-input') return { value: '1' };
            return null;
          } },
        { getAttribute(a) { return a === 'data-rental-offering' ? 'wetsuit_rental' : ''; },
          querySelector(s) {
            if (s === '.ps-create-rental-check') return { checked: rentalState.suit };
            if (s === 'input.ps-create-rental-qty-input') return { value: '1' };
            return null;
          } },
      ];
    }
    return [];
  };
  nodes['ps-create-rentals'].getAttribute = function ga(k) { return k === 'data-duration-key' ? '3_days' : ''; };
  return { nodes, rentalState };
}

const dom = buildDom();
const sandbox = {
  el(id) { return dom.nodes[id] || null; },
  scheduleReadCreateRentalSelectionFromDom() {
    const out = [];
    if (dom.rentalState.board) out.push({ offering_key: 'board_rental', duration_key: '3_days', quantity: 1 });
    if (dom.rentalState.suit) out.push({ offering_key: 'wetsuit_rental', duration_key: '3_days', quantity: 1 });
    return out;
  },
  schedulePopulateCreateCourseFields() {},
  scheduleFetchLessonTimesConfig() { return { then(fn) { if (fn) fn(); return { then() { return this; } }; } }; },
  scheduleSyncPrivateLessonSessions() {},
  scheduleRenderCreateRentals() {},
  scheduleRefreshCreateFullDayAddon() {},
  scheduleReadPrivateLessonSessionsFromDom() { return []; },
  scheduleRentalsToLegacyComponents(rentals) {
    const c = {};
    (rentals || []).forEach((r) => {
      if (r.offering_key === 'board_rental') c.surfboard = { quantity: r.quantity };
      if (r.offering_key === 'wetsuit_rental') c.wetsuit = { quantity: r.quantity };
    });
    return c;
  },
  scheduleTodayIso() { return '2026-07-20'; },
  getClient() { return 'sunset'; },
  console,
};

function select(id) {
  const node = sandbox.el(id);
  node.checked = true;
  node.dispatchEvent({ type: 'change', target: node });
}

try {
  vm.createContext(sandbox);
  vm.runInContext([onChangeSrc, populateSrc, payloadSrc, guidanceSrc].join('\n'), sandbox);
  ['ps-create-comp-course', 'ps-create-comp-private-lesson', 'ps-create-comp-no-lesson'].forEach((id) => {
    sandbox.el(id).addEventListener('change', function onCh() { sandbox.scheduleOnCreateComponentChange(id); });
  });

  assert('initial course false', sandbox.el('ps-create-comp-course').checked === false);
  assert('initial private false', sandbox.el('ps-create-comp-private-lesson').checked === false);
  assert('initial no-lesson true', sandbox.el('ps-create-comp-no-lesson').checked === true);
  sandbox.schedulePopulateCreateComponentFields();
  assert('No lesson hides course', sandbox.el('ps-create-course-fields').style.display === 'none');
  assert('No lesson hides private', sandbox.el('ps-create-private-lesson-fields').style.display === 'none');
  assert('No lesson shows date range', sandbox.el('ps-create-date-range').style.display !== 'none');
  let payload = sandbox.scheduleReadCreatePayload();
  assert('initial no course component', !payload.components.course);
  assert('initial no private component', !payload.components.private_lesson);

  dom.rentalState.board = true;
  let exclusive = true; let rentalsOk = true;
  [
    'ps-create-comp-course', 'ps-create-comp-private-lesson', 'ps-create-comp-no-lesson',
    'ps-create-comp-course', 'ps-create-comp-private-lesson', 'ps-create-comp-no-lesson',
  ].forEach((id) => {
    select(id);
    const c = sandbox.el('ps-create-comp-course').checked;
    const p = sandbox.el('ps-create-comp-private-lesson').checked;
    const n = sandbox.el('ps-create-comp-no-lesson').checked;
    if ((c ? 1 : 0) + (p ? 1 : 0) + (n ? 1 : 0) !== 1) exclusive = false;
    if (id === 'ps-create-comp-course' && !(c && !p && !n)) exclusive = false;
    if (id === 'ps-create-comp-private-lesson' && !(!c && p && !n)) exclusive = false;
    if (id === 'ps-create-comp-no-lesson' && !(!c && !p && n)) exclusive = false;
    if (!dom.rentalState.board) rentalsOk = false;
  });
  assert('mutual exclusivity across transitions', exclusive);
  assert('rentals survive transitions', rentalsOk);

  select('ps-create-comp-course');
  sandbox.schedulePopulateCreateComponentFields();
  assert('Group shows course', sandbox.el('ps-create-course-fields').style.display !== 'none');
  assert('Group hides private', sandbox.el('ps-create-private-lesson-fields').style.display === 'none');
  assert('Group shows date range', sandbox.el('ps-create-date-range').style.display !== 'none');
  payload = sandbox.scheduleReadCreatePayload();
  assert('Group payload course only', !!payload.components.course && !payload.components.private_lesson);

  select('ps-create-comp-private-lesson');
  sandbox.schedulePopulateCreateComponentFields();
  assert('Private hides course', sandbox.el('ps-create-course-fields').style.display === 'none');
  assert('Private shows private fields', sandbox.el('ps-create-private-lesson-fields').style.display !== 'none');
  assert('Private hides date range', sandbox.el('ps-create-date-range').style.display === 'none');
  payload = sandbox.scheduleReadCreatePayload();
  assert('Private payload private only', !payload.components.course && !!payload.components.private_lesson);

  select('ps-create-comp-no-lesson');
  sandbox.schedulePopulateCreateComponentFields();
  payload = sandbox.scheduleReadCreatePayload();
  assert('No lesson lesson flags false', !payload.components.course && !payload.components.private_lesson);
  assert('No lesson keeps rentals',
    !!(payload.components.surfboard || (payload.rentals && payload.rentals.length)));

  dom.rentalState.board = false;
  select('ps-create-comp-no-lesson');
  sandbox.schedulePopulateCreateComponentFields();
  sandbox.scheduleRefreshCreateEmptyGuidance();
  assert('empty guidance when no lesson+gear',
    sandbox.el('ps-create-activity-empty-hint').style.display !== 'none'
    && sandbox.el('ps-create-gear-empty-hint').style.display !== 'none');
  dom.rentalState.board = true;
  sandbox.scheduleRefreshCreateEmptyGuidance();
  assert('empty guidance hidden with gear',
    sandbox.el('ps-create-activity-empty-hint').style.display === 'none'
    && sandbox.el('ps-create-gear-empty-hint').style.display === 'none');
  select('ps-create-comp-course');
  sandbox.schedulePopulateCreateComponentFields();
  sandbox.scheduleRefreshCreateEmptyGuidance();
  assert('empty guidance hidden on Group', sandbox.el('ps-create-activity-empty-hint').style.display === 'none');
} catch (err) {
  assert('behavioral sandbox no throw', false, err && (err.stack || err.message));
}

console.log('\n[4] Quote path + payload keys');
assert('change still via scheduleOnCreateComponentChange', apiSrc.includes('scheduleOnCreateComponentChange'));
assert('populate re-renders rentals', populateSrc && populateSrc.includes('scheduleRenderCreateRentals'));
assert('quote debounce path preserved',
  portalSrc.includes('schedulePortalRefreshCreateQuote') && portalSrc.includes('schedulePortalQuoteDebounceMs'));
assert('one submitScheduleManualBooking', count(portalSrc, 'function submitScheduleManualBooking') === 1);
assert('create submit wired once', /\[\s*['"]ps-create-submit['"]\s*,\s*submitScheduleManualBooking\s*\]/.test(apiSrc));
assert('full-day board+suit', /hasEligibleBase\s*=\s*boardOn\s*&&\s*wetsuitOn/.test(apiSrc) || apiSrc.includes('boardOn && wetsuitOn'));
assert('payload course key', payloadSrc && payloadSrc.includes('components.course'));
assert('payload private_lesson key', payloadSrc && payloadSrc.includes('components.private_lesson'));
assert('no no_lesson component key', payloadSrc && !/components\.no_lesson|components\.none/.test(payloadSrc));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-booking-activity-model — FAILED');
  process.exit(1);
}
console.log('verify:sunset-booking-activity-model — ALL CHECKS PASSED');
process.exit(0);
