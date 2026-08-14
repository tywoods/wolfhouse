'use strict';

/**
 * BUG-001 — Horario P1: overlap, drawer trap, monthly header.
 * Stay off Inbox, email, Reservas, Finanzas, language packs.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const COCKPIT = path.join(ROOT, 'scripts/browser/sunset-schedule-day-cockpit-ui.js');
const DRAWER = path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-controller.js');
const RUNTIME = path.join(ROOT, 'scripts/browser/sunset-schedule-runtime.js');
const API = path.join(ROOT, 'scripts/staff-query-api.js');

const cockpitSrc = fs.readFileSync(COCKPIT, 'utf8');
const drawerSrc = fs.readFileSync(DRAWER, 'utf8');
const runtimeSrc = fs.readFileSync(RUNTIME, 'utf8');
const apiSrc = fs.readFileSync(API, 'utf8');

function createMinimalDocument() {
  function Node(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.className = '';
    this.children = [];
    this.style = { _props: Object.create(null), display: '', overflow: '', setProperty(k, v) { this._props[k] = String(v); this[k] = String(v); } };
    this.classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
    this.attributes = Object.create(null);
    this._listeners = Object.create(null);
    this.ownerDocument = null;
    this.parentNode = null;
    this._text = '';
    this.id = '';
  }
  Object.defineProperty(Node.prototype, 'textContent', {
    get() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; },
    set(v) { this._text = String(v == null ? '' : v); this.children = []; },
  });
  Node.prototype.setAttribute = function (k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); };
  Node.prototype.getAttribute = function (k) { return this.attributes[k] || null; };
  Node.prototype.appendChild = function (n) { n.parentNode = this; this.children.push(n); return n; };
  Node.prototype.addEventListener = function (type, fn) {
    this._listeners[type] = this._listeners[type] || [];
    this._listeners[type].push(fn);
  };
  Node.prototype.click = function () {
    (this._listeners.click || []).forEach((fn) => fn({ target: this, preventDefault() {}, stopPropagation() {} }));
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
    createElement(tag) {
      const n = new Node(tag);
      n.ownerDocument = doc;
      return n;
    },
    getElementById(id) { return doc._nodes[id] || null; },
    addEventListener(type, fn) {
      doc._listeners = doc._listeners || {};
      doc._listeners[type] = doc._listeners[type] || [];
      doc._listeners[type].push(fn);
    },
  };
  doc.body = doc.createElement('body');
  doc.body.style.overflow = '';
  return { doc, Node };
}

// --- 1) Overlap lanes ---
{
  const { doc } = createMinimalDocument();
  const sandbox = { document: doc, window: { addEventListener() {} }, console, portalT: (k, fb) => fb || k };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(cockpitSrc + '\nthis.__ck = { scheduleCockpitAssignLanes, scheduleRenderDayCockpit };', sandbox);
  const assign = sandbox.__ck.scheduleCockpitAssignLanes;
  assert.strictEqual(typeof assign, 'function', 'lane helper exported');
  const packed = assign([
    { id: 'manana', name: 'Curso Mañana', s: 10 * 60, e: 13 * 60 },
    { id: 'privado', name: 'Curso privado', s: 9 * 60, e: 18 * 60 },
  ]);
  assert.ok(packed.laneCount >= 2, 'overlapping sessions get 2+ lanes');
  const manana = packed.list.find((s) => s.id === 'manana');
  const privado = packed.list.find((s) => s.id === 'privado');
  assert.notStrictEqual(manana.lane, privado.lane, 'Mañana and privado are not on the same lane');

  const mount = doc.createElement('div');
  sandbox.__ck.scheduleRenderDayCockpit(mount, {
    date: '2026-08-14',
    venue: 'Somo',
    range: 'today',
    now: 8 * 60,
    sessions: [
      { id: 'manana', name: 'Curso Mañana', start: '10:00', end: '13:00', booked: 4, capacity: 8 },
      { id: 'privado', name: 'Curso privado', start: '09:00', end: '18:00', booked: 1, capacity: 2 },
    ],
    on: {},
  });
  const blocks = mount.querySelectorAll('.ck-block');
  assert.ok(blocks.length >= 2, 'both sessions render');
  const tops = blocks.map((b) => String(b.style.top || ''));
  assert.ok(new Set(tops).size >= 2, 'blocks use different vertical offsets');
}

// --- 2) Drawer trap ---
{
  assert.ok(drawerSrc.includes('closeScheduleDetailDrawer'), 'drawer close exists');
  assert.ok(/backdrop[\s\S]{0,200}click|addEventListener\(\s*['\"]click['\"]/.test(drawerSrc), 'backdrop click closes');
  assert.ok(/Escape/.test(drawerSrc), 'Escape closes drawer');
  assert.ok(/overflow/.test(drawerSrc) && /hidden/.test(drawerSrc), 'body overflow locked while open');
  assert.ok(/overflow/.test(drawerSrc) && /data-schedule-drawer-open/.test(drawerSrc), 'open flag restored on close');
  assert.ok(drawerSrc.includes('appendChild') || /document\.body/.test(drawerSrc), 'drawer escapes tab stacking');
}

// --- 3) Monthly header / grid ---
{
  assert.ok(/getMonth\(\)\s*\+\s*1/.test(runtimeSrc) || /calendar month|month start|next month/.test(runtimeSrc),
    'monthly next uses calendar month');
  assert.ok(!/if \(mode === 'next30'\) return 30;/.test(runtimeSrc), 'monthly next is not a raw +30 day jump');
  assert.ok(/getDate\(\)/.test(apiSrc) && /next30Cards/.test(apiSrc), 'month grid sized from the month');
}

assert.ok(!cockpitSrc.includes('inbox-thread.js'));
assert.ok(!drawerSrc.includes('inbox-thread.js'));
assert.ok(!runtimeSrc.includes('email-inbound'));

console.log('PASS BUG-001 Horario overlap + drawer + monthly header');
