'use strict';

/**
 * verify:sunset-booking-activity-model
 *
 * Project Kaya Slice 2 — offline hostile checks for create-drawer main activity
 * (Group / Private / No lesson). Static source + executed event/UI behavior.
 * No Staff API, DB, network, browser, or deploy.
 *
 * Guidance wiring is proven through real production callers:
 * schedulePopulateCreateComponentFields → scheduleRefreshCreateFullDayAddon
 *   finally → scheduleRefreshCreateEmptyGuidance
 * scheduleWireCreateRentals / wireScheduleControls event paths → fullDay finally
 *
 * Run: node scripts/verify-sunset-booking-activity-model.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PORTAL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');
const RENTAL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-rental-availability.js');

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

function makeListenable(node) {
  node._ls = node._ls || {};
  node.addEventListener = function addEventListener(ev, fn) {
    (this._ls[ev] = this._ls[ev] || []).push(fn);
  };
  node.dispatchEvent = function dispatchEvent(ev) {
    const type = ev && ev.type;
    (this._ls[type] || []).forEach((fn) => fn.call(this, ev));
  };
  return node;
}

function classListApi(initial) {
  const set = new Set(initial || []);
  return {
    contains(c) { return set.has(c); },
    add(c) { set.add(c); },
    remove(c) { set.delete(c); },
    toggle(c, force) {
      if (force === true) set.add(c);
      else if (force === false) set.delete(c);
      else if (set.has(c)) set.delete(c);
      else set.add(c);
      return set.has(c);
    },
  };
}

console.log('\nverify:sunset-booking-activity-model — Kaya Slice 2 main activity\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const portalSrc = fs.existsSync(PORTAL_MODULE) ? fs.readFileSync(PORTAL_MODULE, 'utf8') : '';
const rentalSrc = fs.existsSync(RENTAL_MODULE) ? fs.readFileSync(RENTAL_MODULE, 'utf8') : '';
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

console.log('\n[3] Hostile event/UI behavior (executed real production wiring)');
const onChangeSrc = extractFn(apiSrc, 'scheduleOnCreateComponentChange');
const populateSrc = extractFn(apiSrc, 'schedulePopulateCreateComponentFields');
const payloadSrc = extractFn(apiSrc, 'scheduleReadCreatePayload');
const guidanceSrc = extractFn(apiSrc, 'scheduleRefreshCreateEmptyGuidance');
const fullDaySrc = extractFn(apiSrc, 'scheduleRefreshCreateFullDayAddon');
const wireRentalsSrc = extractFn(apiSrc, 'scheduleWireCreateRentals');
const exclusionUiSrc = extractFn(apiSrc, 'scheduleApplyCreateRentalExclusionUi');
const readRentalsSrc = extractFn(apiSrc, 'scheduleReadCreateRentalSelectionFromDom');
const createDateSpanSrc = extractFn(apiSrc, 'scheduleCreateDateSpanForRentals');
const renderRentalsSrc = extractFn(apiSrc, 'scheduleRenderCreateRentals');
const wireControlsSrc = extractFn(apiSrc, 'wireScheduleControls');
const enumerateSrc = extractFn(apiSrc, 'scheduleEnumerateDates');
const addonEurSrc = extractFn(apiSrc, 'scheduleAddonEur');

assert('onChange extractable', !!onChangeSrc);
assert('populate extractable', !!populateSrc);
assert('payload extractable', !!payloadSrc);
assert('guidance extractable', !!guidanceSrc);
assert('fullDayAddon extractable', !!fullDaySrc);
assert('wireCreateRentals extractable', !!wireRentalsSrc);
assert('wireScheduleControls extractable', !!wireControlsSrc);
assert('renderCreateRentals extractable', !!renderRentalsSrc);
assert('wire includes no-lesson',
  apiSrc.includes("'ps-create-comp-no-lesson'") && apiSrc.includes('scheduleOnCreateComponentChange'));
assert('fullDay finally refreshes empty guidance',
  /finally\s*\{\s*scheduleRefreshCreateEmptyGuidance\s*\(\s*\)\s*;?\s*\}/.test(fullDaySrc || ''));
assert('populate calls fullDay (not direct empty guidance)',
  populateSrc
  && populateSrc.includes('scheduleRefreshCreateFullDayAddon')
  && !populateSrc.includes('scheduleRefreshCreateEmptyGuidance'));
assert('rental wire calls fullDay (not direct empty guidance)',
  wireRentalsSrc
  && count(wireRentalsSrc, 'scheduleRefreshCreateFullDayAddon') >= 2
  && !wireRentalsSrc.includes('scheduleRefreshCreateEmptyGuidance'));

function buildRentalRow(key, checked, qty) {
  const qtyInput = makeListenable({
    type: 'number',
    value: String(qty == null ? 1 : qty),
    classList: classListApi(['ps-create-rental-qty-input']),
    className: 'ps-create-rental-qty-input',
  });
  const check = makeListenable({
    type: 'checkbox',
    checked: !!checked,
    classList: classListApi(['ps-create-rental-check']),
    className: 'ps-create-rental-check',
    getAttribute(n) { return n === 'data-offering-key' ? key : null; },
    setAttribute() {},
    disabled: false,
  });
  const qtyWrap = {
    className: 'portal-schedule-create-rental-qty',
    style: { display: checked ? '' : 'none' },
    querySelector(sel) {
      if (sel === 'input.ps-create-rental-qty-input' || sel === '.ps-create-rental-qty-input') return qtyInput;
      return null;
    },
  };
  const label = {
    className: 'portal-schedule-create-check',
    classList: classListApi(['portal-schedule-create-check']),
  };
  const row = {
    key,
    getAttribute(n) { return n === 'data-rental-offering' ? key : null; },
    querySelector(sel) {
      if (sel === '.ps-create-rental-check') return check;
      if (sel === 'input.ps-create-rental-qty-input' || sel === '.ps-create-rental-qty-input') return qtyInput;
      if (sel === '.portal-schedule-create-rental-qty') return qtyWrap;
      if (sel === '.portal-schedule-create-check') return label;
      return null;
    },
    _check: check,
    _qty: qtyInput,
    _qtyWrap: qtyWrap,
  };
  return row;
}

function buildRentalsWrap(initialRows) {
  const attrs = { 'data-duration-key': '3_days', 'data-rental-mode': 'separate_only' };
  let rows = (initialRows || []).slice();
  const wrap = makeListenable({
    dataset: { rentalWired: '' },
    style: { display: '' },
    _html: '',
    getAttribute(k) { return attrs[k] == null ? '' : attrs[k]; },
    setAttribute(k, v) { attrs[k] = String(v); },
    querySelectorAll(sel) {
      if (sel === '[data-rental-offering]') return rows.slice();
      if (sel === '.ps-create-rental-check') return rows.map((r) => r._check);
      return [];
    },
    querySelector() { return null; },
  });
  Object.defineProperty(wrap, 'innerHTML', {
    configurable: true,
    enumerable: true,
    get() { return wrap._html; },
    set(html) {
      wrap._html = String(html || '');
      // Production re-renders rows as HTML; rebuild listenable DOM from that markup so
      // subsequent render/read/wire paths exercise restore, not a synthetic flag.
      const next = [];
      const re = /data-rental-offering="([^"]+)"[\s\S]*?class="ps-create-rental-check"([^>]*)>[\s\S]*?class="ps-create-rental-qty-input"[^>]*value="([^"]*)"/g;
      let mm;
      while ((mm = re.exec(wrap._html))) {
        const key = mm[1];
        const checked = /\bchecked\b/.test(mm[2]);
        const qty = parseInt(mm[3], 10) || 1;
        next.push(buildRentalRow(key, checked, qty));
      }
      rows = next;
      wrap.dataset.rentalWired = '';
    },
  });
  wrap._rows = () => rows;
  wrap._setRows = (r) => { rows = r; };
  return wrap;
}

function buildDom() {
  const nodes = {};
  const byName = {};
  function radio(id, name, value, checked) {
    const node = makeListenable({
      id, type: 'radio', name, value, dataset: {}, style: { display: '' },
      _checked: !!checked,
    });
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
    nodes[id] = makeListenable({
      id, style: { display: display == null ? '' : display }, dataset: {},
      classList: classListApi(),
      querySelectorAll() { return []; }, querySelector() { return null; },
      innerHTML: '', setAttribute() {}, getAttribute() { return ''; },
      textContent: '',
    });
  }
  function input(id, value, type) {
    nodes[id] = makeListenable({
      id,
      type: type || 'text',
      value: value == null ? '' : value,
      checked: false,
      style: { display: '' },
      dataset: {},
      options: [],
      selectedIndex: -1,
      classList: classListApi(),
      textContent: '',
    });
  }
  radio('ps-create-comp-course', 'ps-create-main-activity', 'group', false);
  radio('ps-create-comp-private-lesson', 'ps-create-main-activity', 'private', false);
  radio('ps-create-comp-no-lesson', 'ps-create-main-activity', 'none', true);
  ['ps-create-course-fields', 'ps-create-course-tier-wrap', 'ps-create-course-qty-wrap',
    'ps-create-private-lesson-fields', 'ps-create-addon-fullday-field', 'ps-create-fullday-card',
    'ps-create-fullday-rows', 'ps-create-fullday-summary', 'ps-create-fullday-price-hint'].forEach((id) => box(id, 'none'));
  box('ps-create-date-range', '');
  box('ps-create-activity-empty-hint', '');
  const rentals = buildRentalsWrap([
    buildRentalRow('board_rental', false, 1),
    buildRentalRow('wetsuit_rental', false, 1),
  ]);
  nodes['ps-create-rentals'] = rentals;
  ['ps-create-comp-fullday', 'ps-create-guest', 'ps-create-phone', 'ps-create-notes',
    'ps-create-course-select', 'ps-create-course-tier'].forEach((id) => input(id, ''));
  nodes['ps-create-comp-fullday'].type = 'checkbox';
  input('ps-create-date-from', '2026-07-20');
  input('ps-create-date-to', '2026-07-22');
  input('ps-create-payment', 'unpaid');
  input('ps-create-course-qty', '1');
  input('ps-create-private-lesson-qty', '1');
  input('ps-create-private-lesson-surfers', '1');
  // Wire targets referenced by wireScheduleControls (stubs only)
  ['ps-drawer-close', 'ps-drawer-refresh', 'ps-create-booking', 'ps-create-close',
    'ps-create-cancel', 'ps-create-submit', 'ps-drawer-backdrop', 'ps-create-backdrop',
    'ps-create-type', 'ps-create-add-session', 'ps-create-modal'].forEach((id) => {
    if (!nodes[id]) {
      nodes[id] = makeListenable({ id, dataset: {}, style: { display: '' }, value: '', setAttribute() {} });
    }
  });
  return { nodes, rentals };
}

function hintVisible(sandbox) {
  const h = sandbox.el('ps-create-activity-empty-hint');
  return !!(h && h.style.display !== 'none');
}

function boardChecked(dom) {
  const rows = dom.rentals._rows();
  const board = rows.find((r) => r.key === 'board_rental');
  return !!(board && board._check.checked);
}

function setBoardChecked(dom, checked) {
  const rows = dom.rentals._rows();
  const board = rows.find((r) => r.key === 'board_rental');
  if (board) board._check.checked = !!checked;
}

function setSuitChecked(dom, checked) {
  const rows = dom.rentals._rows();
  const suit = rows.find((r) => r.key === 'wetsuit_rental');
  if (suit) suit._check.checked = !!checked;
}

function buildSandbox(dom, opts) {
  opts = opts || {};
  const counters = {
    guidance: 0,
    fullDay: 0,
    preview: 0,
    renderRentals: 0,
  };
  const sandbox = {
    window: { applyStaffPortalI18n() {} },
    document: {
      querySelectorAll() { return []; },
    },
    console,
    el(id) { return dom.nodes[id] || null; },
    schedulePopulateCreateCourseFields() {},
    scheduleFetchLessonTimesConfig() {
      return { then(fn) { if (fn) fn(); return { then(fn2) { if (fn2) fn2(); return this; } }; } };
    },
    scheduleSyncPrivateLessonSessions() {},
    scheduleReadPrivateLessonSessionsFromDom() { return []; },
    scheduleRentalsToLegacyComponents(rentals) {
      const c = {};
      (rentals || []).forEach((r) => {
        if (r.offering_key === 'board_rental') c.surfboard = { quantity: r.quantity };
        if (r.offering_key === 'wetsuit_rental') c.wetsuit = { quantity: r.quantity };
        if (r.offering_key === 'board_and_suit_rental') {
          c.surfboard = { quantity: r.quantity };
          c.wetsuit = { quantity: r.quantity };
        }
      });
      return c;
    },
    scheduleTodayIso() { return '2026-07-20'; },
    getClient() { return 'sunset'; },
    getSunsetLocation() { return 'mirleft'; },
    // Sellable catalog rows for the create date span (3 days → duration 3_days).
    scheduleAdminPricesCache: [
      { offering_key: 'board_rental', unit: '3_days', active: true, amount_cents: 1500, location_id: 'mirleft', category: 'rental' },
      { offering_key: 'wetsuit_rental', unit: '3_days', active: true, amount_cents: 1200, location_id: 'mirleft', category: 'rental' },
    ],
    scheduleFullDayAddonEnabled: true,
    scheduleFullDayAddonUnitCents: 2500,
    scheduleUpdateCreateTotalPreview() { counters.preview += 1; },
    scheduleReadFullDayAddonRows() { return {}; },
    portalT(k) { return k; },
    escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    // Navigation / drawer stubs for wireScheduleControls
    closeScheduleDetailDrawer() {},
    scheduleRefreshDrawer() {},
    openScheduleCreateModal() {},
    closeScheduleCreateModal() {},
    submitScheduleManualBooking() {},
    scheduleWireScheduleNavigationControls() {},
    scheduleUpdateCreateLessonExtras() {},
    setScheduleFilter() {},
    scheduleAddPrivateLessonSession() {},
    _counters: counters,
  };

  if (opts.wrapGuidance) {
    const rawGuidanceInstall = () => {
      const real = sandbox.scheduleRefreshCreateEmptyGuidance;
      sandbox.scheduleRefreshCreateEmptyGuidance = function wrappedGuidance() {
        counters.guidance += 1;
        return real.apply(this, arguments);
      };
    };
    sandbox._wrapGuidance = rawGuidanceInstall;
  }
  if (opts.wrapFullDay) {
    sandbox._wrapFullDay = () => {
      const real = sandbox.scheduleRefreshCreateFullDayAddon;
      sandbox.scheduleRefreshCreateFullDayAddon = function wrappedFullDay() {
        counters.fullDay += 1;
        return real.apply(this, arguments);
      };
    };
  }
  if (opts.wrapRender) {
    sandbox._wrapRender = () => {
      const real = sandbox.scheduleRenderCreateRentals;
      sandbox.scheduleRenderCreateRentals = function wrappedRender() {
        counters.renderRentals += 1;
        return real.apply(this, arguments);
      };
    };
  }

  return sandbox;
}

function installProductionFns(sandbox, sources) {
  const bundle = sources.join('\n');
  vm.createContext(sandbox);
  // Rental helpers (mutual exclusion / duration / offerings) from browser module.
  if (rentalSrc) {
    vm.runInContext(rentalSrc, sandbox);
  }
  vm.runInContext(bundle, sandbox);
  if (sandbox._wrapGuidance) sandbox._wrapGuidance();
  if (sandbox._wrapFullDay) sandbox._wrapFullDay();
  if (sandbox._wrapRender) sandbox._wrapRender();
}

const productionBundle = [
  guidanceSrc,
  addonEurSrc,
  enumerateSrc,
  // Full-day *row* DOM is out of scope; guidance/finally wiring only needs a safe no-op.
  'function scheduleRenderFullDayAddonRows(){ return; }',
  createDateSpanSrc,
  readRentalsSrc,
  exclusionUiSrc,
  wireRentalsSrc,
  renderRentalsSrc,
  fullDaySrc,
  onChangeSrc,
  populateSrc,
  payloadSrc,
  wireControlsSrc,
].filter(Boolean);

function selectViaListeners(sandbox, id) {
  const node = sandbox.el(id);
  node.checked = true;
  node.dispatchEvent({ type: 'change', target: node });
}

try {
  const dom = buildDom();
  const sandbox = buildSandbox(dom, { wrapGuidance: true, wrapFullDay: true, wrapRender: true });
  installProductionFns(sandbox, productionBundle);

  // Install listeners the same way production does (wireScheduleControls).
  sandbox.wireScheduleControls();
  // Rentals are re-wired by scheduleRenderCreateRentals after each populate.
  sandbox.scheduleRenderCreateRentals();

  assert('initial course false', sandbox.el('ps-create-comp-course').checked === false);
  assert('initial private false', sandbox.el('ps-create-comp-private-lesson').checked === false);
  assert('initial no-lesson true', sandbox.el('ps-create-comp-no-lesson').checked === true);

  // populate → real fullDay → finally guidance (no direct guidance call in test).
  const g0 = sandbox._counters.guidance;
  sandbox.schedulePopulateCreateComponentFields();
  assert('No lesson hides course', sandbox.el('ps-create-course-fields').style.display === 'none');
  assert('No lesson hides private', sandbox.el('ps-create-private-lesson-fields').style.display === 'none');
  assert('No lesson shows date range', sandbox.el('ps-create-date-range').style.display !== 'none');
  assert('populate path refreshes guidance via fullDay finally',
    sandbox._counters.guidance > g0 && sandbox._counters.fullDay > 0);
  assert('empty guidance when no lesson+gear', hintVisible(sandbox) === true);
  let payload = sandbox.scheduleReadCreatePayload();
  assert('initial no course component', !payload.components.course);
  assert('initial no private component', !payload.components.private_lesson);

  // Rentals survive transitions through real render/restore (not a synthetic flag).
  setBoardChecked(dom, true);
  setSuitChecked(dom, false);
  // Reflect checked into row markup path by forcing one render after DOM check flip:
  // set checks then re-render should restore board checked from prev DOM read.
  sandbox.scheduleRenderCreateRentals();
  assert('render restores board checked', boardChecked(dom) === true);

  let exclusive = true; let rentalsOk = true;
  [
    'ps-create-comp-course', 'ps-create-comp-private-lesson', 'ps-create-comp-no-lesson',
    'ps-create-comp-course', 'ps-create-comp-private-lesson', 'ps-create-comp-no-lesson',
  ].forEach((id) => {
    selectViaListeners(sandbox, id);
    // populate is invoked by onChange listener installed by wireScheduleControls
    const c = sandbox.el('ps-create-comp-course').checked;
    const p = sandbox.el('ps-create-comp-private-lesson').checked;
    const n = sandbox.el('ps-create-comp-no-lesson').checked;
    if ((c ? 1 : 0) + (p ? 1 : 0) + (n ? 1 : 0) !== 1) exclusive = false;
    if (id === 'ps-create-comp-course' && !(c && !p && !n)) exclusive = false;
    if (id === 'ps-create-comp-private-lesson' && !(!c && p && !n)) exclusive = false;
    if (id === 'ps-create-comp-no-lesson' && !(!c && !p && n)) exclusive = false;
    if (!boardChecked(dom)) rentalsOk = false;
  });
  assert('mutual exclusivity across transitions', exclusive);
  assert('rentals survive transitions', rentalsOk);
  assert('populate re-render path exercised', sandbox._counters.renderRentals >= 1);

  selectViaListeners(sandbox, 'ps-create-comp-course');
  assert('Group shows course', sandbox.el('ps-create-course-fields').style.display !== 'none');
  assert('Group hides private', sandbox.el('ps-create-private-lesson-fields').style.display === 'none');
  assert('Group shows date range', sandbox.el('ps-create-date-range').style.display !== 'none');
  payload = sandbox.scheduleReadCreatePayload();
  assert('Group payload course only', !!payload.components.course && !payload.components.private_lesson);
  assert('empty guidance hidden on Group', hintVisible(sandbox) === false);

  selectViaListeners(sandbox, 'ps-create-comp-private-lesson');
  assert('Private hides course', sandbox.el('ps-create-course-fields').style.display === 'none');
  assert('Private shows private fields', sandbox.el('ps-create-private-lesson-fields').style.display !== 'none');
  assert('Private hides date range', sandbox.el('ps-create-date-range').style.display === 'none');
  payload = sandbox.scheduleReadCreatePayload();
  assert('Private payload private only', !payload.components.course && !!payload.components.private_lesson);

  selectViaListeners(sandbox, 'ps-create-comp-no-lesson');
  payload = sandbox.scheduleReadCreatePayload();
  assert('No lesson lesson flags false', !payload.components.course && !payload.components.private_lesson);
  assert('No lesson keeps rentals',
    !!(payload.components.surfboard || (payload.rentals && payload.rentals.length)));

  // Empty guidance hide/show through production funnel only (no direct guidance calls).
  // Uncheck gear via rental wire change event.
  const boardRow = dom.rentals._rows().find((r) => r.key === 'board_rental');
  boardRow._check.checked = false;
  const gBeforeUncheck = sandbox._counters.guidance;
  dom.rentals.dispatchEvent({
    type: 'change',
    target: boardRow._check,
  });
  assert('rental uncheck refreshes guidance via wire→fullDay finally',
    sandbox._counters.guidance > gBeforeUncheck);
  assert('empty guidance when no lesson+gear', hintVisible(sandbox) === true);

  // Check gear via rental wire — hides hint through finally, not a direct helper call.
  boardRow._check.checked = true;
  const gBeforeCheck = sandbox._counters.guidance;
  dom.rentals.dispatchEvent({
    type: 'change',
    target: boardRow._check,
  });
  assert('rental checkbox refreshes guidance via wire→fullDay finally',
    sandbox._counters.guidance > gBeforeCheck);
  assert('empty guidance hidden with gear', hintVisible(sandbox) === false);
  assert('rental checkbox triggers total preview', sandbox._counters.preview >= 1);

  // Rental qty change/input → fullDay finally (hint stays hidden with gear).
  const gBeforeQty = sandbox._counters.guidance;
  boardRow._qty.value = '2';
  dom.rentals.dispatchEvent({ type: 'change', target: boardRow._qty });
  dom.rentals.dispatchEvent({ type: 'input', target: boardRow._qty });
  assert('rental qty change/input refreshes via fullDay finally',
    sandbox._counters.guidance > gBeforeQty);
  assert('empty guidance still hidden after qty', hintVisible(sandbox) === false);

  // Full-day toggle via wireScheduleControls listener → fullDay finally.
  // Make eligible (board+suit), show field, then toggle.
  setSuitChecked(dom, true);
  sandbox.scheduleRefreshCreateFullDayAddon();
  assert('eligible fullday field shown', sandbox.el('ps-create-addon-fullday-field').style.display !== 'none');
  const fullday = sandbox.el('ps-create-comp-fullday');
  fullday.checked = true;
  const gBeforeFd = sandbox._counters.guidance;
  fullday.dispatchEvent({ type: 'change', target: fullday });
  assert('fullday toggle refreshes guidance via wired listener',
    sandbox._counters.guidance > gBeforeFd);
  assert('empty guidance hidden with fullday', hintVisible(sandbox) === false);

  // Early-return path still runs finally (no field).
  const savedField = dom.nodes['ps-create-addon-fullday-field'];
  dom.nodes['ps-create-addon-fullday-field'] = null;
  const gBeforeEarly = sandbox._counters.guidance;
  sandbox.scheduleRefreshCreateFullDayAddon();
  assert('early-return path still runs finally guidance',
    sandbox._counters.guidance === gBeforeEarly + 1);
  dom.nodes['ps-create-addon-fullday-field'] = savedField;

  // Normal show=false early-return (ineligible base) still runs finally.
  setBoardChecked(dom, false);
  setSuitChecked(dom, false);
  selectViaListeners(sandbox, 'ps-create-comp-no-lesson');
  const gBeforeInelig = sandbox._counters.guidance;
  sandbox.scheduleRefreshCreateFullDayAddon();
  assert('ineligible early-return runs finally guidance',
    sandbox._counters.guidance === gBeforeInelig + 1);
  assert('empty guidance after ineligible fullDay', hintVisible(sandbox) === true);

  // Thrown errors still propagate while finally refreshes guidance.
  const realRead = sandbox.scheduleReadCreateRentalSelectionFromDom;
  sandbox.scheduleReadCreateRentalSelectionFromDom = function boom() {
    throw new Error('hostile-fullDay-throw');
  };
  const gBeforeThrow = sandbox._counters.guidance;
  let threw = false;
  try {
    sandbox.scheduleRefreshCreateFullDayAddon();
  } catch (err) {
    threw = /hostile-fullDay-throw/.test(String(err && err.message));
  }
  sandbox.scheduleReadCreateRentalSelectionFromDom = realRead;
  assert('throw still propagates from fullDay', threw);
  assert('throw path still ran finally guidance',
    sandbox._counters.guidance === gBeforeThrow + 1);

  // Activity change via wired listeners updates single hint without direct guidance call.
  setBoardChecked(dom, false);
  setSuitChecked(dom, false);
  selectViaListeners(sandbox, 'ps-create-comp-no-lesson');
  assert('wired No lesson shows empty hint', hintVisible(sandbox) === true);
  selectViaListeners(sandbox, 'ps-create-comp-course');
  assert('wired Group hides empty hint', hintVisible(sandbox) === false);
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

console.log('\n[5] Mutation hostility — removing finally / wiring must go RED');
function runHintThroughPopulate(fullDaySource, wireSource) {
  const dom = buildDom();
  const sandbox = buildSandbox(dom, { wrapGuidance: true, wrapFullDay: true });
  const bundle = [
    guidanceSrc,
    addonEurSrc,
    enumerateSrc,
    'function scheduleRenderFullDayAddonRows(){}',
    createDateSpanSrc,
    readRentalsSrc,
    exclusionUiSrc,
    wireSource,
    // Lightweight render: keep rows and (re)wire so exclusion path stays available.
    `function scheduleRenderCreateRentals(){
      var wrap = el('ps-create-rentals');
      if (!wrap) return;
      wrap.dataset.rentalWired = '';
      scheduleWireCreateRentals(wrap);
    }`,
    fullDaySource,
    onChangeSrc,
    populateSrc,
  ].filter(Boolean);
  installProductionFns(sandbox, bundle);
  sandbox.wireScheduleControls = function installActivityAndRentalsOnly() {
    ['ps-create-comp-course', 'ps-create-comp-private-lesson', 'ps-create-comp-no-lesson'].forEach((id) => {
      const node = sandbox.el(id);
      if (node && !node.dataset.wired) {
        node.dataset.wired = '1';
        node.addEventListener('change', function onCh() { sandbox.scheduleOnCreateComponentChange(id); });
      }
    });
    const fulldayToggle = sandbox.el('ps-create-comp-fullday');
    if (fulldayToggle && !fulldayToggle.dataset.wired) {
      fulldayToggle.dataset.wired = '1';
      fulldayToggle.addEventListener('change', sandbox.scheduleRefreshCreateFullDayAddon);
    }
    sandbox.scheduleRenderCreateRentals();
  };
  sandbox.wireScheduleControls();
  sandbox.schedulePopulateCreateComponentFields();
  const emptyShows = hintVisible(sandbox) === true;
  const board = dom.rentals._rows().find((r) => r.key === 'board_rental');
  board._check.checked = true;
  const g0 = sandbox._counters.guidance;
  dom.rentals.dispatchEvent({ type: 'change', target: board._check });
  const gearHides = hintVisible(sandbox) === false && sandbox._counters.guidance > g0;
  return { emptyShows, gearHides, guidance: sandbox._counters.guidance, fullDay: sandbox._counters.fullDay };
}

// GREEN control with real finally + real wire.
const green = runHintThroughPopulate(fullDaySrc, wireRentalsSrc);
assert('mutation control: empty shows via finally', green.emptyShows);
assert('mutation control: gear hides via wire→fullDay finally', green.gearHides);

// RED: keep valid try/finally syntax but strip guidance call (laundering-proof).
const noFinallySrc = String(fullDaySrc)
  .replace(/finally \{ scheduleRefreshCreateEmptyGuidance\(\); \}/, 'finally { /* mutated: guidance stripped */ }');
assert('mutated fullDay has no finally guidance call',
  !/scheduleRefreshCreateEmptyGuidance/.test(noFinallySrc)
  && /function scheduleRefreshCreateFullDayAddon/.test(noFinallySrc)
  && /finally \{/.test(noFinallySrc));
const redFinally = runHintThroughPopulate(noFinallySrc, wireRentalsSrc);
assert('mutation RED: removing finally guidance breaks empty guidance path',
  !(redFinally.emptyShows && redFinally.gearHides),
  JSON.stringify(redFinally));

// RED: drop fullDay calls from rental wire extract.
const noWireFullDaySrc = String(wireRentalsSrc)
  .replace(/scheduleRefreshCreateFullDayAddon\(\);\s*/g, '');
assert('mutated wire has no fullDay calls',
  !noWireFullDaySrc.includes('scheduleRefreshCreateFullDayAddon')
  && /function scheduleWireCreateRentals/.test(noWireFullDaySrc));
const redWire = runHintThroughPopulate(fullDaySrc, noWireFullDaySrc);
assert('mutation RED: dropping wire→fullDay breaks gear hint update',
  redWire.gearHides === false,
  JSON.stringify(redWire));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-booking-activity-model — FAILED');
  process.exit(1);
}
console.log('verify:sunset-booking-activity-model — ALL CHECKS PASSED');
process.exit(0);
