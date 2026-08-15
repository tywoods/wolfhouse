'use strict';

/**
 * BUG-013 — leftover Horario P2s after BUG-012:
 *  1) Monthly Next/Prev: cockpit header month matches grid rangeStartIso
 *  2) Guest chip Pagado ↔ drawer paid cents (Gary / €0 of €960)
 * Stay off Inbox, email-settings, inbox-thread.js, Skipper inbound, production.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const runtimeSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-runtime.js'), 'utf8');
const cockpitSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-day-cockpit-ui.js'), 'utf8');
const normalizerSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-row-normalizer.js'), 'utf8');
const drawerViewSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-view-ui.js'), 'utf8');
const navSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-navigation-ui.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

// --- structural gates ---
assert.ok(runtimeSrc.includes('function rowPaidCents'), 'paid cents helper exists');
assert.ok(runtimeSrc.includes('Nullish only'), 'paid cents refuses 0||otherCents');
assert.ok(runtimeSrc.includes('snap.rangeStartIso'), 'loadPage prefers snapshot rangeStartIso');
assert.ok(cockpitSrc.includes('liveNavMode || data.navMode'), 'header prefers live nav mode');
assert.ok(cockpitSrc.includes('Recompute range from live nav'), 'clock tick refreshes range');
assert.ok(apiSrc.includes('Chip Pagado must match drawer paid cents'));
assert.ok(apiSrc.includes('booking_balance_due_cents: (function()'));
assert.ok(drawerViewSrc.includes("Number(pay.paid_cents || 0) > 0 ? pay.payment_status : 'unpaid'"));
assert.ok(!runtimeSrc.includes('inbox-thread.js'));
assert.ok(!cockpitSrc.includes('staff-email-settings'));

// --- behavioral: rowEffectivePaid / Gary €0 ---
{
  const paidStart = runtimeSrc.indexOf('function rowPaidCents');
  const paidEnd = runtimeSrc.indexOf('function deriveStableRowId');
  assert.ok(paidStart >= 0 && paidEnd > paidStart);
  const box = {};
  vm.createContext(box);
  vm.runInContext(
    runtimeSrc.slice(paidStart, paidEnd) +
      '\nthis.rowPaidCents = rowPaidCents;\nthis.rowEffectivePaid = rowEffectivePaid;',
    box
  );

  // Gary / SUNSET-20260811-EA783E shape: status enums say paid, cash is €0 of €960.
  assert.strictEqual(box.rowEffectivePaid({
    payment_status: 'paid',
    booking_payment_status: 'paid',
    booking_amount_paid_cents: 0,
    booking_balance_due_cents: 96000,
  }), false, 'Gary €0 cash is not Pagado');

  assert.strictEqual(box.rowEffectivePaid({
    payment_status: 'paid',
    booking_amount_paid_cents: 0,
    amount_paid_cents: 96000, // must NOT win over explicit booking 0
  }), false, 'explicit booking €0 beats stray amount_paid_cents');

  assert.strictEqual(box.rowPaidCents({
    booking_amount_paid_cents: 0,
    amount_paid_cents: 96000,
  }), 0, 'paid cents uses nullish booking field');

  assert.strictEqual(box.rowEffectivePaid({
    booking_amount_paid_cents: 4500,
    booking_balance_due_cents: 0,
  }), true, 'cash paid + zero balance is Pagado');

  assert.strictEqual(box.rowEffectivePaid({
    booking_amount_paid_cents: 4500,
    booking_balance_due_cents: 100,
  }), false, 'cash paid with balance owing is not Pagado');
}

// --- behavioral: normalizer coerces SR paid + €0 → unpaid ---
{
  const box = { console, Object, JSON, Number, String, Array, Math, Date, isFinite, parseInt };
  vm.createContext(box);
  vm.runInContext(runtimeSrc + '\nthis.SunsetScheduleRuntime = SunsetScheduleRuntime;', box);
  vm.runInContext(normalizerSrc, box);
  const row = box.scheduleNormalizeApiRow({
    booking_id: 'g',
    service_record_id: 'sr-gary',
    service_date: '2026-08-11',
    service_type: 'surf_lesson',
    payment_status: 'paid',
    booking_payment_status: 'paid',
    booking_amount_paid_cents: 0,
    booking_balance_due_cents: 96000,
    guest_name: 'Gary',
    booking_code: 'SUNSET-20260811-EA783E',
  }, { locationId: null }, { freeze: false });
  assert.strictEqual(row.payment_status, 'unpaid', 'normalizer clears SR paid when cash is €0');
  assert.strictEqual(box.scheduleRowEffectivePaid(row), false);
}

// --- behavioral: Monthly Next header month === grid rangeStartIso ---
function createMinimalDocument() {
  function Node(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.className = '';
    this.children = [];
    this.style = { display: '', overflow: '', setProperty() {} };
    this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
    this.attributes = Object.create(null);
    this._listeners = Object.create(null);
    this.ownerDocument = null;
    this.parentNode = null;
    this._text = '';
    this.id = '';
    this.dataset = {};
    this._innerHTML = '';
  }
  Object.defineProperty(Node.prototype, 'innerHTML', {
    get() { return this._innerHTML; },
    set(v) { this._innerHTML = String(v == null ? '' : v); this.children = []; this._text = ''; },
  });
  Object.defineProperty(Node.prototype, 'textContent', {
    get() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; },
    set(v) { this._text = String(v == null ? '' : v); this.children = []; },
  });
  Node.prototype.setAttribute = function (k, v) {
    this.attributes[k] = String(v);
    if (k === 'id') this.id = String(v);
  };
  Node.prototype.getAttribute = function (k) { return this.attributes[k] || null; };
  Node.prototype.appendChild = function (n) { n.parentNode = this; this.children.push(n); return n; };
  Node.prototype.addEventListener = function (type, fn) {
    this._listeners[type] = this._listeners[type] || [];
    this._listeners[type].push(fn);
  };
  Node.prototype.querySelectorAll = function (sel) {
    const out = [];
    const walk = (n) => {
      if (sel.startsWith('.') && String(n.className || '').split(/\s+/).includes(sel.slice(1))) out.push(n);
      (n.children || []).forEach(walk);
    };
    walk(this);
    return out;
  };
  Node.prototype.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };
  const doc = {
    _nodes: Object.create(null),
    body: null,
    head: null,
    createElement(tag) {
      const n = new Node(tag);
      n.ownerDocument = doc;
      return n;
    },
    getElementById(id) { return doc._nodes[id] || null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  doc.body = doc.createElement('body');
  doc.head = doc.createElement('head');
  return doc;
}

async function verifyMonthlyHeaderGridSync() {
  const doc = createMinimalDocument();
  const todayIso = '2026-08-15';
  const dom = {
    'ps-range-label': { textContent: '' },
    'ps-today': { classList: { toggle() {} } },
    'ps-state': { textContent: '', className: '', style: { display: '' } },
    'ps-prev-week': { dataset: {}, addEventListener() {} },
    'ps-next-week': { dataset: {}, addEventListener() {} },
    'ps-refresh-schedule': { dataset: {}, addEventListener() {} },
  };
  const loadCalls = [];
  const sandbox = {
    document: doc,
    window: { addEventListener() {} },
    console,
    portalT: (k, fb) => fb || k,
    portalLang: 'en',
    el: (id) => dom[id] || null,
    scheduleTodayIso: () => todayIso,
    scheduleParseIso: (iso) => {
      const [y, m, d] = String(iso).split('-').map(Number);
      return new Date(y, m - 1, d);
    },
    scheduleIsoDate: (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    },
    scheduleAddDays: (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n),
    scheduleDaysFromToday: (iso) => {
      const t = sandbox.scheduleParseIso(todayIso);
      const d = sandbox.scheduleParseIso(iso);
      return Math.round((d - t) / 86400000);
    },
    scheduleFormatRangeLabel: (start) => start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    getClient: () => 'sunset-somo',
    getPortalProfile: () => ({ is_surf_vertical: true }),
    renderScheduleSchoolContext() {},
    inboxClientQuery: () => '',
    fetch: () => Promise.resolve({ ok: true, json: async () => null }),
    scheduleFetchLessonTimesConfig: () => Promise.resolve(null),
    scheduleBuildLoadedViewModel: (_w, _c, _p, rangeStart, snap) => {
      loadCalls.push({
        rangeStartIso: sandbox.scheduleIsoDate(rangeStart),
        snapRangeStartIso: snap.rangeStartIso,
        mode: snap.mode,
      });
      return { canonicalRows: [], presentationOnlyRows: [], rows: [] };
    },
    scheduleRenderLoadedViewModel() {},
    Promise,
    Object,
    JSON,
    Number,
    String,
    Math,
    Date,
    isFinite,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(runtimeSrc, sandbox);
  vm.runInContext(navSrc, sandbox);
  vm.runInContext(cockpitSrc + '\nthis.__ck = { scheduleRenderDayCockpit, scheduleCockpitRangeFromNavMode };', sandbox);

  sandbox.setScheduleView('next30');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const before = sandbox.scheduleGetNavigationSnapshot();
  assert.strictEqual(before.mode, 'next30');
  assert.strictEqual(before.rangeStartIso, '2026-08-01', 'monthly anchors on month start');

  const mount = doc.createElement('div');
  sandbox.__ck.scheduleRenderDayCockpit(mount, {
    date: before.rangeStartIso,
    rangeStartIso: before.rangeStartIso,
    venue: 'Somo',
    range: 'next30',
    navMode: 'next30',
    sessions: [],
    on: {},
  });
  let header = mount.querySelector('.ck-date');
  assert.ok(header, 'cockpit date header renders');
  assert.ok(/August/i.test(header.textContent), 'header shows August before Next: ' + header.textContent);

  sandbox.scheduleNavigateNext();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const after = sandbox.scheduleGetNavigationSnapshot();
  assert.strictEqual(after.rangeStartIso, '2026-09-01', 'Next advances to September 1');
  const lastLoad = loadCalls[loadCalls.length - 1];
  assert.ok(lastLoad, 'loadPage ran after Next');
  assert.strictEqual(lastLoad.rangeStartIso, after.rangeStartIso, 'grid rangeStart matches nav snapshot');
  assert.strictEqual(lastLoad.snapRangeStartIso, after.rangeStartIso, 'load snap rangeStartIso matches');

  sandbox.__ck.scheduleRenderDayCockpit(mount, {
    date: after.rangeStartIso,
    rangeStartIso: after.rangeStartIso,
    venue: 'Somo',
    range: 'next30',
    navMode: 'next30',
    sessions: [],
    on: {},
  });
  header = mount.querySelector('.ck-date');
  assert.ok(/September/i.test(header.textContent), 'header follows grid to September: ' + header.textContent);

  // Stale src.range='today' must not pin header while live nav is monthly.
  sandbox.scheduleGetNavigationSnapshot = () => after;
  sandbox.scheduleCurrentViewMode = () => 'next30';
  sandbox.__ck.scheduleRenderDayCockpit(mount, {
    date: after.rangeStartIso,
    venue: 'Somo',
    range: 'today', // stale
    navMode: 'day', // stale
    sessions: [],
    on: {},
  });
  header = mount.querySelector('.ck-date');
  assert.ok(/September/i.test(header.textContent), 'live nav wins over stale range pin: ' + header.textContent);
}

verifyMonthlyHeaderGridSync().then(() => {
  console.log('PASS BUG-013 monthly header↔grid sync + chip↔drawer Pagado cash');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
