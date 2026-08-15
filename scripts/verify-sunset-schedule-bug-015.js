'use strict';

/**
 * BUG-015 — Horario P1: timeline privado block must bind to its session id.
 *
 * Repro shape (Bug Finder, ES, 15 Aug 2026): Horario → day → Línea → click
 * "privado · N" opened Gary / Curso Mañana in the same time window instead of
 * that private session.
 *
 * Root cause: scheduleCockpitFocusSession fuzzy-matched guest-panel ids
 * (hyphen-sanitized) against raw private slot_keys (`private_lesson::…`),
 * missed the privado section, and could not open that session's booking.
 *
 * Fix: stamp data-ps-session-id on ops sections + cockpit blocks; focus by
 * exact session id and open that section's first booking — never a time-slot peer.
 *
 * Stay off inbox-thread.js, Admin Email, email-settings, Graph poller, Google OAuth,
 * Skipper inbound, production.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const cockpitSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-day-cockpit-ui.js'), 'utf8');
const opsSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-day-ops-board-ui.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

assert.ok(opsSrc.includes('function scheduleDaySessionFocusId'), 'focus-id helper on ops board');
assert.ok(opsSrc.includes('data-ps-session-id="'), 'ops sections stamp data-ps-session-id');
assert.ok(cockpitSrc.includes("setAttribute('data-ps-session-id'"), 'cockpit blocks stamp data-ps-session-id');
assert.ok(cockpitSrc.includes('[data-ps-session-id="'), 'FocusSession queries data-ps-session-id');
assert.ok(!/nid\.indexOf\(id\)/.test(cockpitSrc), 'no fuzzy guest-panel id substring match');
assert.ok(apiSrc.includes("slot_key: 'private_lesson::'"), 'private sessions still keyed per service record');
assert.ok(!cockpitSrc.includes('inbox-thread.js'));
assert.ok(!opsSrc.includes('inbox-thread.js'));
assert.ok(!cockpitSrc.includes('staff-email-oauth'));
assert.ok(!opsSrc.includes('email-inbound'));

function createMinimalDocument() {
  function Node(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.className = '';
    this.children = [];
    this.style = {};
    this.attributes = Object.create(null);
    this._listeners = Object.create(null);
    this.parentNode = null;
    this.id = '';
    this.dataset = {};
    this._scrolled = false;
    this._clicked = false;
  }
  Node.prototype.setAttribute = function (k, v) {
    this.attributes[k] = String(v);
    if (k === 'id') this.id = String(v);
  };
  Node.prototype.getAttribute = function (k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
  };
  Node.prototype.appendChild = function (n) {
    n.parentNode = this;
    this.children.push(n);
    return n;
  };
  Node.prototype.addEventListener = function (type, fn) {
    this._listeners[type] = this._listeners[type] || [];
    this._listeners[type].push(fn);
  };
  Node.prototype.click = function () {
    this._clicked = true;
    (this._listeners.click || []).forEach((fn) => fn({
      target: this,
      preventDefault() {},
      stopPropagation() {},
    }));
  };
  Node.prototype.closest = function (sel) {
    let n = this;
    while (n) {
      if (sel === 'section' && n.tagName === 'SECTION') return n;
      if (sel.startsWith('.') && String(n.className || '').split(/\s+/).includes(sel.slice(1))) return n;
      n = n.parentNode;
    }
    return null;
  };
  Node.prototype.scrollIntoView = function () { this._scrolled = true; };
  Node.prototype.querySelectorAll = function (sel) {
    const out = [];
    const walk = (n) => {
      if (matchSel(n, sel)) out.push(n);
      (n.children || []).forEach(walk);
    };
    walk(this);
    return out;
  };
  Node.prototype.querySelector = function (sel) {
    return this.querySelectorAll(sel)[0] || null;
  };

  function matchSel(n, sel) {
    if (!sel) return false;
    if (sel.startsWith('[data-ps-session-id="') && sel.endsWith('"]')) {
      const want = sel.slice('[data-ps-session-id="'.length, -2);
      return n.getAttribute('data-ps-session-id') === want;
    }
    if (sel === '[data-ps-booking-id]') return !!n.getAttribute('data-ps-booking-id');
    if (sel === '[data-ps-add-course], [data-ps-add-slot]') {
      return n.getAttribute('data-ps-add-course') != null || n.getAttribute('data-ps-add-slot') != null;
    }
    if (sel.startsWith('[data-ps-add-course="') || sel.startsWith('[data-ps-add-slot="')) {
      const attr = sel.includes('add-course') ? 'data-ps-add-course' : 'data-ps-add-slot';
      const m = sel.match(/"([^"]*)"/);
      return m ? n.getAttribute(attr) === m[1] : false;
    }
    if (sel.startsWith('[id*="') && sel.endsWith('"]')) {
      return String(n.id || '').includes(sel.slice(6, -2));
    }
    if (sel.startsWith('.') && String(n.className || '').split(/\s+/).includes(sel.slice(1))) return true;
    return false;
  }

  const byId = Object.create(null);
  const doc = {
    body: null,
    createElement(tag) {
      const n = new Node(tag);
      n.ownerDocument = doc;
      return n;
    },
    getElementById(id) { return byId[id] || null; },
    _register(id, n) {
      byId[id] = n;
      n.id = id;
      n.setAttribute('id', id);
    },
  };
  doc.body = doc.createElement('body');
  return { doc, byId };
}

{
  const { doc } = createMinimalDocument();
  const board = doc.createElement('div');
  doc._register('ps-ops-board', board);

  const opened = [];
  function openScheduleDetailDrawer(row) {
    opened.push(row);
  }

  const sandbox = {
    document: doc,
    window: { addEventListener() {} },
    console,
    el(id) { return doc.getElementById(id); },
    openScheduleDetailDrawer,
    portalT(k, fb) { return fb || k; },
    escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // Ops board helpers first (inject order), then cockpit FocusSession.
  const focusHelperStart = opsSrc.indexOf('function scheduleDaySessionFocusId');
  const focusHelperEnd = opsSrc.indexOf('function scheduleRenderOpsGuestToggle');
  assert.ok(focusHelperStart > 0 && focusHelperEnd > focusHelperStart);
  vm.runInContext(opsSrc.slice(focusHelperStart, focusHelperEnd), sandbox);

  const focusStart = cockpitSrc.indexOf('function scheduleCockpitFocusSession');
  const focusEnd = cockpitSrc.indexOf('function scheduleCockpitRowIsActive');
  assert.ok(focusStart > 0 && focusEnd > focusStart);
  vm.runInContext(
    cockpitSrc.slice(focusStart, focusEnd) +
      '\nthis.scheduleCockpitFocusSession = scheduleCockpitFocusSession;',
    sandbox,
  );

  const privadoId = 'private_lesson::2026-08-15::09:00::pl-sr-999';
  const mananaId = 'manana';

  assert.strictEqual(
    sandbox.scheduleDaySessionFocusId({
      kind: 'private_lesson',
      slot_key: privadoId,
      label: 'Curso privado',
      start: 540,
    }),
    privadoId,
    'private focus id is slot_key (service-record scoped)',
  );
  assert.strictEqual(
    sandbox.scheduleDaySessionFocusId({
      kind: 'course',
      course_id: 'manana',
      slot_key: 'manana',
      label: 'Curso Mañana',
      start: 600,
    }),
    'manana',
    'course focus id is course/slot key',
  );

  function addSessionSection(focusId, bookingId, guestName) {
    const section = doc.createElement('section');
    section.className = 'portal-schedule-ops-lesson-group';
    section.setAttribute('data-ps-session-id', focusId);
    const row = doc.createElement('div');
    row.setAttribute('data-ps-booking-id', bookingId);
    row.addEventListener('click', function () {
      openScheduleDetailDrawer({
        _scheduleId: bookingId,
        guest_name: guestName,
        booking_code: bookingId === 'gary-row' ? 'SUNSET-20260811-EA783E' : 'SUNSET-PRIVATE-1',
      });
    });
    section.appendChild(row);
    board.appendChild(section);
    return { section, row };
  }

  const manana = addSessionSection(mananaId, 'gary-row', 'Gary');
  const privado = addSessionSection(privadoId, 'priv-row', 'Private Guest');

  // Overlapping window: privado 09–18, Mañana 10–13 — click must still hit privado.
  sandbox.scheduleCockpitFocusSession(privadoId);

  assert.strictEqual(opened.length, 1, 'opens exactly one booking');
  assert.strictEqual(opened[0].guest_name, 'Private Guest', 'opens privado session guest, not Gary');
  assert.strictEqual(opened[0]._scheduleId, 'priv-row');
  assert.ok(!manana.row._clicked, 'does not click Mañana booking in the same time window');
  assert.ok(privado.row._clicked, 'clicks the privado session booking row');

  opened.length = 0;
  manana.row._clicked = false;
  privado.row._clicked = false;
  sandbox.scheduleCockpitFocusSession(mananaId);
  assert.strictEqual(opened[0].guest_name, 'Gary', 'Mañana block still opens Mañana booking');
  assert.ok(manana.row._clicked);
  assert.ok(!privado.row._clicked);
}

{
  // Map day session → cockpit id stays aligned with focus helper for private keys.
  const sandbox = {
    console,
    scheduleDaySessionFocusId(session) {
      if (session.slot_key) return String(session.slot_key);
      if (session.course_id) return String(session.course_id);
      return String(session.label || '');
    },
    scheduleCockpitHasCapacity() { return false; },
    scheduleCockpitMinToHhmm(m) {
      const h = Math.floor(m / 60);
      const mm = m % 60;
      return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    },
    scheduleCockpitNormalizePrepItems(x) { return Array.isArray(x) ? x : []; },
    scheduleBuildSessionPrepItems() { return []; },
  };
  vm.createContext(sandbox);
  const mapStart = cockpitSrc.indexOf('function scheduleMapDaySessionToCockpit');
  const mapEnd = cockpitSrc.indexOf('function scheduleBuildDayCockpitData');
  vm.runInContext(
    cockpitSrc.slice(mapStart, mapEnd) +
      '\nthis.scheduleMapDaySessionToCockpit = scheduleMapDaySessionToCockpit;',
    sandbox,
  );
  const mapped = sandbox.scheduleMapDaySessionToCockpit({
    kind: 'private_lesson',
    slot_key: 'private_lesson::2026-08-15::09:00::pl-sr-999',
    label: 'Curso privado',
    start: 540,
    end: 1080,
    surfers: 4,
    groups: [{ _scheduleId: 'priv-row' }],
  });
  assert.strictEqual(mapped.id, 'private_lesson::2026-08-15::09:00::pl-sr-999');
  assert.strictEqual(mapped.booked, 4);
  assert.ok(mapped.name.indexOf('privado') >= 0 || mapped.name.indexOf('Private') >= 0 || mapped.name === 'Curso privado');
}

console.log('PASS BUG-015 Horario privado timeline binds to session id');
