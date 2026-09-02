'use strict';

/**
 * BUG-021 — Horario Monthly keeps selected day + month-scoped hero/prep.
 *
 * Repro (Bug Finder, sunset-staging, EN):
 *   Daily → Next (Wed Sep 2) → Monthly silently jumps back to today.
 *   Hero still says “First up: Curso Matutino …” even though that session is DONE
 *   (Daily correctly showed Curso Tarde). Monthly keeps day-scoped subtitle +
 *   “TODAY'S PREP”.
 *
 * Outcomes:
 *   1) setView(Monthly) preserves forwardOffset (no snap to today)
 *   2) Monthly First up = next upcoming (wall clock), not a completed session
 *   3) Monthly prep title / session counts are month-scoped
 *
 * Stay off inbox-thread.js, email-settings, Skipper inbound, Hermes/SOUL, WhatsApp.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const runtimeSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-runtime.js'), 'utf8');
const cockpitSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-day-cockpit-ui.js'), 'utf8');
const navSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-navigation-ui.js'), 'utf8');

assert.ok(!/navState\.forwardOffset\s*=\s*0;\s*\n\s*return requestPageLoad\(\);/.test(runtimeSrc)
  || runtimeSrc.includes('Preserve forwardOffset'),
  'setView must not blindly re-anchor offset to 0');
assert.ok(runtimeSrc.includes('Preserve forwardOffset'), 'setView documents offset preserve');
assert.ok(cockpitSrc.includes('function scheduleCockpitClassifyMonth'), 'month classify helper');
assert.ok(cockpitSrc.includes('prepTitleMonth') || cockpitSrc.includes("THIS MONTH'S PREP"), 'month prep title');
assert.ok(cockpitSrc.includes('isMonthly'), 'collect month-scopes rows');
assert.ok(!cockpitSrc.includes('inbox-thread.js'));
assert.ok(!runtimeSrc.includes('staff-email-settings'));
assert.ok(navSrc.includes('SunsetScheduleRuntime.nav.setView'));

function createMinimalDocument() {
  function Node(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.className = '';
    this.children = [];
    this.style = { display: '', setProperty() {} };
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
    createTextNode(t) { const n = new Node('#text'); n.textContent = t; return n; },
  };
  doc.body = doc.createElement('body');
  doc.head = doc.createElement('head');
  return doc;
}

// --- 1) Daily → Next → Monthly keeps selected day (no snap to today) ---
{
  const todayIso = '2026-09-01';
  const dom = {
    'ps-range-label': { textContent: '' },
    'ps-today': { classList: { toggle() {} } },
    'ps-state': { textContent: '', className: '', style: { display: '' } },
    'ps-prev-week': { dataset: {}, addEventListener() {} },
    'ps-next-week': { dataset: {}, addEventListener() {} },
    'ps-refresh-schedule': { dataset: {}, addEventListener() {} },
  };
  const sandbox = {
    document: createMinimalDocument(),
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
    scheduleFetchLessonTimesConfig: () => Promise.resolve(null),
    scheduleBuildLoadedViewModel: () => ({ canonicalRows: [], presentationOnlyRows: [], rows: [] }),
    scheduleRenderLoadedViewModel() {},
    scheduleAnnounceSchedulePageLoading() {},
    fetch: () => Promise.resolve({ ok: true, json: async () => ({ rows: [] }) }),
  };
  vm.createContext(sandbox);
  vm.runInContext(runtimeSrc + '\nthis.SunsetScheduleRuntime = SunsetScheduleRuntime;', sandbox);
  vm.runInContext(navSrc, sandbox);

  sandbox.setScheduleView('day');
  sandbox.scheduleNavigateNext(); // Wed Sep 2
  const afterNext = sandbox.scheduleGetNavigationSnapshot();
  assert.strictEqual(afterNext.forwardOffset, 1, 'Next advances one day');
  assert.strictEqual(afterNext.focusDateIso || afterNext.rangeStartIso, '2026-09-02');

  sandbox.setScheduleView('next30');
  const afterMonthly = sandbox.scheduleGetNavigationSnapshot();
  assert.strictEqual(afterMonthly.mode, 'next30');
  assert.strictEqual(afterMonthly.forwardOffset, 1, 'Monthly must keep selected-day offset (not 0/today)');
  assert.strictEqual(String(afterMonthly.rangeStartIso).slice(0, 7), '2026-09', 'month stays September');
  assert.notStrictEqual(afterMonthly.forwardOffset, 0, 'must not snap to today');
}

// --- 2 + 3) Monthly First up skips DONE + month prep title ---
{
  const cockpit = require(path.join(ROOT, 'scripts/browser/sunset-schedule-day-cockpit-ui.js'));
  const doc = createMinimalDocument();
  const mount = doc.createElement('div');
  mount.ownerDocument = doc;
  const todayIso = cockpit.scheduleCockpitLocalIsoDate(new Date());

  // Repro shape: morning DONE, afternoon still upcoming (Daily would pick Tarde).
  const sessions = [
    { id: 'mat', name: 'Curso Matutino', start: '10:00', end: '12:00', booked: 3, capacity: 24, date: todayIso },
    { id: 'tar', name: 'Curso Tarde', start: '16:00', end: '18:00', booked: 4, capacity: 24, date: todayIso },
  ];
  // Also a later-month session so month counts ≠ day counts.
  const nextMonthDay = (() => {
    const [y, m] = todayIso.split('-').map(Number);
    const nm = m === 12 ? 1 : m + 1;
    const ny = m === 12 ? y + 1 : y;
    return `${ny}-${String(nm).padStart(2, '0')}-10`;
  })();
  // Keep extra session in same month so month scope can include it.
  const laterSameMonth = todayIso.slice(0, 8) + '28';
  const monthSessions = sessions.concat([
    { id: 'later', name: 'Curso Extra', start: '10:00', end: '12:00', booked: 2, capacity: 24, date: laterSameMonth },
  ]);

  const classified = cockpit.scheduleCockpitClassifyMonth(
    { sessions, date: todayIso },
    todayIso,
    13 * 60 + 30 // 13:30 — Matutino DONE, Tarde upcoming
  );
  assert.ok(!classified.live, 'nothing live at 13:30');
  assert.ok(classified.next && classified.next.name === 'Curso Tarde', 'next upcoming is Tarde');
  assert.ok(classified.next.name !== 'Curso Matutino', 'must not pick completed Matutino');

  const data = cockpit.scheduleBuildDayCockpitData({
    venue: 'Sunset',
    date: todayIso.slice(0, 8) + '01',
    range: 'next30',
    now: 13 * 60 + 30,
    sessions: monthSessions,
    prep: { items: [{ offering_key: 'board', label: 'Board', quantity: 5 }], unpaid: 1, needReply: 0 },
    on: {},
  });
  cockpit.scheduleRenderDayCockpit(mount, data);
  const text = mount.textContent || '';

  assert.ok(/First up:/.test(text), 'Monthly shows First up');
  assert.ok(/Curso Tarde/.test(text), 'First up names Tarde');
  assert.ok(!/First up:\s*Curso Matutino/.test(text), 'First up must not be completed Matutino');
  assert.ok(!/starts in/.test(text) && !/ends in/.test(text), 'Monthly keeps countdown frozen');
  assert.ok(/THIS MONTH'S PREP|PREP ·/.test(text), 'prep title is month-scoped');
  assert.ok(!/TODAY'S PREP/.test(text), 'must not keep TODAY\'S PREP leftover');

  // Month-scoped subtitle counts all month sessions (3), not day leftover (2).
  assert.ok(/3\s+sessions/.test(text), 'subtitle uses month session count');
  const guestsMatch = text.match(/(\d+)\s+guests/);
  assert.ok(guestsMatch && Number(guestsMatch[1]) === 9, 'subtitle guests sum month bookings (3+4+2)');

  // Prep title helper direct
  const monthTitle = cockpit.scheduleCockpitPrepTitle(true, todayIso, 'next30');
  assert.ok(/THIS MONTH'S PREP|PREP ·/.test(monthTitle), monthTitle);
  assert.ok(monthTitle.indexOf("TODAY'S PREP") < 0, monthTitle);
}

// --- prep items accept YYYY-MM month token ---
{
  const cockpit = require(path.join(ROOT, 'scripts/browser/sunset-schedule-day-cockpit-ui.js'));
  const rows = [
    {
      service_date: '2026-09-02',
      booking_status: 'confirmed',
      quantity: 2,
      metadata: { course_equipment: true, offering_key: 'softboard', catalog_label: 'Softboard' },
    },
    {
      service_date: '2026-09-15',
      booking_status: 'confirmed',
      quantity: 3,
      metadata: { course_equipment: true, offering_key: 'softboard', catalog_label: 'Softboard' },
    },
    {
      service_date: '2026-08-15',
      booking_status: 'confirmed',
      quantity: 9,
      metadata: { course_equipment: true, offering_key: 'softboard', catalog_label: 'Softboard' },
    },
  ];
  const monthItems = cockpit.scheduleBuildDayPrepItems(rows, '2026-09');
  assert.strictEqual(monthItems.length, 1);
  assert.strictEqual(monthItems[0].quantity, 5, 'month prep aggregates Sep days only');
  const dayItems = cockpit.scheduleBuildDayPrepItems(rows, '2026-09-02');
  assert.strictEqual(dayItems[0].quantity, 2, 'day prep still day-exact');
}

console.log('PASS BUG-021 Horario Monthly keep date + month-scoped First up/prep');
