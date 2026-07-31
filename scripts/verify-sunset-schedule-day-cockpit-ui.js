'use strict';

/**
 * verify:sunset-schedule-day-cockpit-ui
 *
 * P1 RED proof — isolated Day Cockpit module (not mounted in buildUiHtml).
 * Renders all 3 time-of-day states via the reference `now` override:
 *   mid-session / before-first / after-last
 *
 * Capacity is proven on the REAL session-VM path (producer-shaped objects with
 * session.capacity from course.capacity / courses cache) — not via ops helpers.
 * capacity: 0 degrades the seats ring to booked-only.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-day-cockpit-ui.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-day-cockpit-ui.js');
const OPS_PATH = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-ops.js');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

/* ── Minimal DOM for offline render (no jsdom) ─────────────────────────── */

function createMinimalDocument() {
  function Node(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.className = '';
    this._classList = new Set();
    this.children = [];
    this.childNodes = this.children;
    this.attributes = Object.create(null);
    this._text = '';
    this._html = '';
    this.style = {
      _props: Object.create(null),
      setProperty(k, v) {
        this._props[k] = String(v);
        this[k] = String(v);
      },
    };
    this._listeners = Object.create(null);
    this.ownerDocument = null;
    this.parentNode = null;
    this.type = '';
    this.title = '';
  }

  Object.defineProperty(Node.prototype, 'textContent', {
    get() {
      if (this.children.length === 0) return this._text;
      return this.children.map((c) => c.textContent).join('');
    },
    set(v) {
      this.children.length = 0;
      this._html = '';
      this._text = v == null ? '' : String(v);
    },
  });

  Object.defineProperty(Node.prototype, 'innerHTML', {
    get() {
      if (this._html) return this._html;
      return this.children.map((c) => serialize(c)).join('');
    },
    set(v) {
      this.children.length = 0;
      this._text = '';
      this._html = v == null ? '' : String(v);
      // parse a tiny subset used by cockpit: span/i/strong/br with class
      if (!this._html) return;
      const re = /<(\w+)([^>]*)>([\s\S]*?)<\/\1>|<(\w+)([^>]*)\/>|<br\s*\/?>/gi;
      let m;
      const html = this._html;
      // Keep _html for includes(); also seed simple child markers for class queries
      const classRe = /class=["']([^"']+)["']/gi;
      let cm;
      while ((cm = classRe.exec(html)) !== null) {
        const fake = new Node('i');
        fake.ownerDocument = this.ownerDocument;
        fake.className = cm[1];
        cm[1].split(/\s+/).forEach((c) => c && fake._classList.add(c));
        this.children.push(fake);
      }
      void m;
      void re;
    },
  });

  Object.defineProperty(Node.prototype, 'classList', {
    get() {
      const self = this;
      return {
        add(c) {
          self._classList.add(c);
          const parts = new Set(String(self.className || '').split(/\s+/).filter(Boolean));
          parts.add(c);
          self.className = Array.from(parts).join(' ');
        },
        contains(c) {
          return self._classList.has(c) || String(self.className || '').split(/\s+/).includes(c);
        },
        remove(c) {
          self._classList.delete(c);
          self.className = String(self.className || '')
            .split(/\s+/)
            .filter((x) => x && x !== c)
            .join(' ');
        },
      };
    },
  });

  Node.prototype.setAttribute = function (k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this.className = String(v);
  };
  Node.prototype.getAttribute = function (k) {
    if (k === 'class') return this.className || null;
    return this.attributes[k] != null ? this.attributes[k] : null;
  };
  Node.prototype.appendChild = function (child) {
    if (!child) return child;
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    this._html = '';
    return child;
  };
  Node.prototype.append = function () {
    for (let i = 0; i < arguments.length; i++) {
      const a = arguments[i];
      if (a == null) continue;
      if (typeof a === 'string' || typeof a === 'number') {
        this.appendChild(this.ownerDocument.createTextNode(String(a)));
      } else {
        this.appendChild(a);
      }
    }
  };
  Node.prototype.addEventListener = function (type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  };
  Node.prototype.querySelector = function (sel) {
    const all = this.querySelectorAll(sel);
    return all[0] || null;
  };
  Node.prototype.querySelectorAll = function (sel) {
    const out = [];
    const walk = (n) => {
      if (!n || !n.tagName) return;
      if (matchSel(n, sel)) out.push(n);
      (n.children || []).forEach(walk);
    };
    (this.children || []).forEach(walk);
    return out;
  };

  function matchSel(n, sel) {
    if (!sel) return false;
    if (sel.startsWith('.')) {
      const cls = sel.slice(1).split('.')[0];
      return n.classList.contains(cls) || String(n.className || '').split(/\s+/).includes(cls);
    }
    if (sel.includes('.')) {
      const [tag, cls] = sel.split('.');
      return n.tagName === tag.toUpperCase() && n.classList.contains(cls);
    }
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const body = sel.slice(1, -1);
      const eq = body.indexOf('=');
      if (eq === -1) return n.getAttribute(body) != null;
      const key = body.slice(0, eq);
      let val = body.slice(eq + 1).replace(/^["']|["']$/g, '');
      return n.getAttribute(key) === val;
    }
    return n.tagName === sel.toUpperCase();
  }

  function serialize(n) {
    if (n.nodeType === 3) return escapeHtml(n.textContent);
    const tag = n.tagName.toLowerCase();
    const attrs = [];
    if (n.className) attrs.push(`class="${escapeHtml(n.className)}"`);
    Object.keys(n.attributes || {}).forEach((k) => {
      if (k === 'class') return;
      attrs.push(`${k}="${escapeHtml(n.attributes[k])}"`);
    });
    if (n.style && n.style.left) attrs.push(`style="left:${escapeHtml(n.style.left)};width:${escapeHtml(n.style.width || '')}"`);
    const open = `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
    if (n._html && n.children.length === 0) return open + n._html + `</${tag}>`;
    const inner = n.children.length
      ? n.children.map(serialize).join('')
      : escapeHtml(n._text || '');
    return open + inner + `</${tag}>`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const doc = {
    createElement(tag) {
      const n = new Node(tag);
      n.ownerDocument = doc;
      return n;
    },
    createTextNode(text) {
      const n = new Node('#text');
      n.nodeType = 3;
      n.tagName = '';
      n._text = String(text);
      n.ownerDocument = doc;
      return n;
    },
  };

  function outerHTML(mount) {
    return serialize(mount);
  }

  function textOf(mount) {
    return mount.textContent;
  }

  return { doc, outerHTML, textOf, serialize };
}

/* ── Sample day (matches design handoff sample shape) ──────────────────── */

function sampleSessions() {
  return [
    {
      id: 'manana',
      name: 'Curso Mañana',
      start: '10:00',
      end: '12:00',
      booked: 3,
      capacity: 24,
      boards: 3,
      wetsuits: 3,
    },
    {
      id: 'medio',
      name: 'Curso Medio Día',
      start: '12:00',
      end: '14:00',
      booked: 2,
      capacity: 24,
      boards: 2,
      wetsuits: 2,
    },
    {
      id: 'tarde',
      name: 'Curso Tarde',
      start: '16:00',
      end: '18:00',
      booked: 0,
      capacity: 24,
      boards: 0,
      wetsuits: 0,
    },
  ];
}

function samplePrep() {
  return {
    boards: { total: 8, lesson: 4, rental: 4 },
    wetsuits: { total: 8, lesson: 4, rental: 4 },
    unpaid: 9,
    needReply: 0,
  };
}

function baseData(now) {
  return {
    venue: 'Sunset',
    date: '2026-07-31',
    range: 'today',
    now: now,
    sessions: sampleSessions(),
    prep: samplePrep(),
    on: {},
  };
}

console.log('\nverify:sunset-schedule-day-cockpit-ui\n');

console.log('[1] Module files present (P1 isolated — not mounted)');
assert('cockpit module exists', fs.existsSync(MODULE_PATH));
const modSrc = fs.readFileSync(MODULE_PATH, 'utf8');
assert('ops lib exists', fs.existsSync(OPS_PATH));
const opsSrc = fs.readFileSync(OPS_PATH, 'utf8');
const staffSrc = fs.readFileSync(STAFF_API, 'utf8');
const browserSrc = fs.readFileSync(BROWSER_SRC, 'utf8');
assert('P1 does not inject cockpit marker into staff-query-api', !staffSrc.includes('INJECT:sunset-schedule-day-cockpit'));
assert('P1 does not register cockpit in browser-source', !browserSrc.includes('DayCockpit') && !browserSrc.includes('day-cockpit-ui'));
assert('module keeps classify/fmtDur/pct helpers', /scheduleCockpitClassify/.test(modSrc) && /scheduleCockpitFmtDur/.test(modSrc) && /scheduleCockpitPct/.test(modSrc));
assert('module ports render', /function scheduleRenderDayCockpit/.test(modSrc));
assert('module has data mapper', /function scheduleBuildDayCockpitData/.test(modSrc));
assert('module does not fetch', !modSrc.includes('fetch('));
assert('module does not call deleted ops capacity helpers', !modSrc.includes('capacityFromOfferingPack') && !modSrc.includes('attachSessionCapacity'));
assert('ops has no capacityFromOfferingPack', !opsSrc.includes('capacityFromOfferingPack'));
assert('ops has no attachSessionCapacity', !opsSrc.includes('attachSessionCapacity'));
assert('CSS uses exact --ck-surface #f7f5ef', modSrc.includes('--ck-surface:#f7f5ef') || modSrc.includes('--ck-surface: #f7f5ef'));
assert('CSS uses exact --ck-olive #6b7a5e', modSrc.includes('--ck-olive:#6b7a5e') || modSrc.includes('--ck-olive: #6b7a5e'));
assert('CSS uses exact --ck-now-bg #22301f', modSrc.includes('--ck-now-bg:#22301f') || modSrc.includes('--ck-now-bg: #22301f'));
assert('CSS uses exact --ck-alert #a8563a', modSrc.includes('--ck-alert:#a8563a') || modSrc.includes('--ck-alert: #a8563a'));
assert('token mapping report present', modSrc.includes('TOKEN MAPPING REPORT'));
// Producer already surfaces capacity on day sessions (read-only proof, no edits).
assert('producer scheduleBuildDaySessions sets session.capacity', staffSrc.includes('function scheduleBuildDaySessions') && /capacity:\s*course\.capacity/.test(staffSrc));

console.log('\n[2] Pure helpers (verbatim formulas)');
const cockpit = require(MODULE_PATH);
assert('fmtDur 40 → 40 min', cockpit.scheduleCockpitFmtDur(40) === '40 min');
assert('fmtDur 83 → 1 h 23 m', cockpit.scheduleCockpitFmtDur(83) === '1 h 23 m');
assert('fmtDur 120 → 2 h', cockpit.scheduleCockpitFmtDur(120) === '2 h');
assert('pct midpoint', Math.abs(cockpit.scheduleCockpitPct(12 * 60, 8, 12 * 60) - (4 / 12) * 100) < 0.001);

const mid = cockpit.scheduleCockpitClassify(baseData(12 * 60 + 37), 12 * 60 + 37);
assert('classify mid live = medio', mid.live && mid.live.id === 'medio');
assert('classify mid next = tarde', mid.next && mid.next.id === 'tarde');

const before = cockpit.scheduleCockpitClassify(baseData(9 * 60 + 20), 9 * 60 + 20);
assert('classify before live null', before.live == null);
assert('classify before next = manana', before.next && before.next.id === 'manana');

const after = cockpit.scheduleCockpitClassify(baseData(19 * 60), 19 * 60);
assert('classify after live null', after.live == null);
assert('classify after next null', after.next == null);

console.log('\n[3] Data mapping from producer-shaped day-session VM');
// Shape matches scheduleBuildDaySessions output (staff-query-api): minutes start/end,
// surfers, capacity from course.capacity (← pack.group_size via courses cache).
const producerSessions = [
  {
    kind: 'course',
    course_id: 'manana',
    label: 'Curso Mañana',
    slot_key: 'manana',
    timeLabel: '10:00 – 12:00',
    start: 10 * 60,
    end: 12 * 60,
    capacity: 24, // course.capacity already on VM
    surfers: 3,
    bookings: 2,
    groups: [],
    boardsNeeded: 3,
    wetsuitsNeeded: 3,
  },
  {
    kind: 'course',
    course_id: 'medio',
    label: 'Curso Medio Día',
    slot_key: 'medio',
    timeLabel: '12:00 – 14:00',
    start: 12 * 60,
    end: 14 * 60,
    capacity: 24,
    surfers: 2,
    bookings: 1,
    groups: [],
    boardsNeeded: 2,
    wetsuitsNeeded: 2,
  },
  {
    kind: 'course',
    course_id: 'tarde',
    label: 'Curso Tarde',
    slot_key: 'tarde',
    timeLabel: '16:00 – 18:00',
    start: 16 * 60,
    end: 18 * 60,
    capacity: 24,
    surfers: 0,
    bookings: 0,
    groups: [],
    boardsNeeded: 0,
    wetsuitsNeeded: 0,
  },
];

const mapped = cockpit.scheduleBuildDayCockpitData({
  venue: 'Sunset',
  date: '2026-07-31',
  navMode: 'day',
  now: 757,
  sessions: producerSessions,
  boardsTotal: 8,
  boardsLesson: 4,
  boardsRental: 4,
  wetsuitsTotal: 8,
  wetsuitsLesson: 4,
  wetsuitsRental: 4,
  unpaidCount: 9,
  needReplyCount: 0,
});
assert('nav day → range today', mapped.range === 'today');
assert('session start HH:MM from minutes', mapped.sessions[0].start === '10:00');
assert('session end HH:MM from minutes', mapped.sessions[0].end === '12:00');
assert('session booked from surfers', mapped.sessions[0].booked === 3);
assert('session boards from boardsNeeded', mapped.sessions[0].boards === 3);
assert('session capacity from producer VM', mapped.sessions[0].capacity === 24);
assert('prep boards total from ops flat keys', mapped.prep.boards.total === 8);
assert('prep unpaid from unpaidCount', mapped.prep.unpaid === 9);

const zeroCapMapped = cockpit.scheduleMapDaySessionToCockpit({
  kind: 'course',
  course_id: 'open',
  label: 'Open session',
  slot_key: 'open',
  start: 12 * 60,
  end: 14 * 60,
  surfers: 2,
  capacity: 0, // literal capacity 0 from producer
  boardsNeeded: 0,
  wetsuitsNeeded: 0,
});
assert('capacity 0 → null (degrade)', zeroCapMapped.capacity === null);

const nullCapMapped = cockpit.scheduleMapDaySessionToCockpit({
  label: 'Private',
  start: 600,
  end: 660,
  surfers: 1,
  capacity: null,
});
assert('missing capacity → null', nullCapMapped.capacity === null);

console.log('\n[4] RED render — 3 states via now override (producer VM → mapper → paint)');
const { doc, textOf } = createMinimalDocument();
const states = [];

function renderFromProducer(name, nowMin) {
  const mount = doc.createElement('div');
  mount.ownerDocument = doc;
  const data = cockpit.scheduleBuildDayCockpitData({
    venue: 'Sunset',
    date: '2026-07-31',
    navMode: 'day',
    now: nowMin,
    sessions: producerSessions,
    boardsTotal: 8,
    boardsLesson: 4,
    boardsRental: 4,
    wetsuitsTotal: 8,
    wetsuitsLesson: 4,
    wetsuitsRental: 4,
    unpaidCount: 9,
    needReplyCount: 0,
  });
  cockpit.scheduleRenderDayCockpit(mount, data);
  const text = textOf(mount);
  const html = mount.innerHTML;
  const className = mount.className;
  states.push({ name, nowMin, text, html, className, mount });
  return { text, html, className, mount, data };
}

const midR = renderFromProducer('mid-session', 12 * 60 + 37);
assert('mid: mount class cockpit', midR.className === 'cockpit');
assert('mid: ON NOW', /ON NOW/.test(midR.text), midR.text.slice(0, 200));
assert('mid: live session name', /Curso Medio D[ií]a|Medio/.test(midR.text), midR.text.slice(0, 240));
assert('mid: ends in countdown', /ends in/.test(midR.text));
assert('mid: boards out chip', /board/.test(midR.text) && /out/.test(midR.text));
assert('mid: seats ring present', midR.mount.querySelectorAll('.ck-ring').length >= 1);
assert('mid: needle present', midR.mount.querySelectorAll('.ck-needle').length >= 1);
assert('mid: prep unpaid badge', /9/.test(midR.text) && /Unpaid/.test(midR.text));
assert('mid: ribbon blocks', midR.mount.querySelectorAll('.ck-block').length === 3);
assert('mid: not idle hero', midR.mount.querySelectorAll('.ck-now--idle').length === 0);
// REAL capacity path: producer capacity:24 → ring shows booked/capacity (2/24 for medio)
const midRing = midR.mount.querySelector('.ck-ring');
const midRingText = midRing ? midRing.textContent : '';
assert('mid: ring shows booked/capacity 2/24', /2\s*\/\s*24/.test(midRingText) || /2\/24/.test(midRingText), midRingText);
assert('mid: ring not booked-only', midRing && !String(midRing.className).includes('is-booked-only'));
assert('mid: ring deg set from capacity', midRing && midRing.style && midRing.style._props && midRing.style._props['--ck-ring-deg'] === Math.round((2 / 24) * 360) + 'deg',
  midRing && midRing.style && midRing.style._props ? midRing.style._props['--ck-ring-deg'] : 'missing');

const beforeR = renderFromProducer('before-first', 9 * 60 + 20);
assert('before: NOTHING IN THE WATER', /NOTHING IN THE WATER/.test(beforeR.text), beforeR.text.slice(0, 200));
assert('before: First up', /First up:/.test(beforeR.text));
assert('before: starts in', /starts in/.test(beforeR.text));
assert('before: idle hero', beforeR.mount.querySelectorAll('.ck-now--idle').length >= 1);
assert('before: to prep chip', /to prep/.test(beforeR.text));
assert('before: needle still (now in window)', beforeR.mount.querySelectorAll('.ck-needle').length >= 1);

const afterR = renderFromProducer('after-last', 19 * 60);
assert('after: DAY COMPLETE', /DAY COMPLETE/.test(afterR.text), afterR.text.slice(0, 200));
assert('after: sessions run', /session/.test(afterR.text) && /run/.test(afterR.text));
assert('after: gear used', /used/.test(afterR.text));
assert('after: idle hero', afterR.mount.querySelectorAll('.ck-now--idle').length >= 1);
assert('after: closed copy', /closed out/.test(afterR.text));

console.log('\n[5] Capacity edges — producer capacity:0 → booked-only ring');
// Literal capacity: 0 on a producer-shaped live session (README edge case).
const zeroVm = cockpit.scheduleBuildDayCockpitData({
  venue: 'Sunset',
  date: '2026-07-31',
  range: 'today',
  now: 12 * 60 + 30,
  sessions: [{
    kind: 'course',
    course_id: 'open',
    label: 'Open session',
    slot_key: 'open',
    start: 12 * 60,
    end: 14 * 60,
    capacity: 0,
    surfers: 2,
    boardsNeeded: 0,
    wetsuitsNeeded: 0,
  }],
  unpaidCount: 0,
  needReplyCount: 0,
});
assert('mapper: capacity 0 not kept as 0', zeroVm.sessions[0].capacity === null);
const mountZero = doc.createElement('div');
mountZero.ownerDocument = doc;
cockpit.scheduleRenderDayCockpit(mountZero, zeroVm);
assert('cap0: still ON NOW', /ON NOW/.test(textOf(mountZero)));
assert('cap0: booked-only ring class', mountZero.querySelectorAll('.is-booked-only').length >= 1);
const zeroRing = mountZero.querySelector('.ck-ring');
const zeroRingText = zeroRing ? zeroRing.textContent : '';
assert('cap0: ring shows booked without /denom', /2/.test(zeroRingText) && !/\//.test(zeroRingText), zeroRingText);

const mountNull = doc.createElement('div');
mountNull.ownerDocument = doc;
cockpit.scheduleRenderDayCockpit(mountNull, cockpit.scheduleBuildDayCockpitData({
  venue: 'Sunset',
  date: '2026-07-31',
  range: 'today',
  now: 12 * 60 + 30,
  sessions: [{
    kind: 'course',
    course_id: 'x',
    label: 'Open session',
    start: 12 * 60,
    end: 14 * 60,
    capacity: null,
    surfers: 2,
    boardsNeeded: 0,
    wetsuitsNeeded: 0,
  }],
}));
assert('null-cap: booked-only ring', mountNull.querySelectorAll('.is-booked-only').length >= 1);

const mountEmpty = doc.createElement('div');
mountEmpty.ownerDocument = doc;
cockpit.scheduleRenderDayCockpit(mountEmpty, {
  venue: 'Sunset',
  date: '2026-07-31',
  range: 'today',
  now: 12 * 60,
  sessions: [],
  prep: samplePrep(),
});
assert('empty: No sessions scheduled', /No sessions scheduled/.test(textOf(mountEmpty)));
assert('empty: idle', mountEmpty.querySelectorAll('.ck-now--idle').length >= 1);

console.log('\n[6] State snapshot (fixture output)');
states.forEach((s) => {
  const heroBits = [];
  if (/ON NOW/.test(s.text)) heroBits.push('ON_NOW');
  if (/NOTHING IN THE WATER/.test(s.text)) heroBits.push('BEFORE');
  if (/DAY COMPLETE/.test(s.text)) heroBits.push('AFTER');
  const needle = s.mount.querySelectorAll('.ck-needle').length;
  const blocks = s.mount.querySelectorAll('.ck-block').length;
  const ring = s.mount.querySelector('.ck-ring');
  const ringInfo = ring
    ? `ring="${ring.textContent}" cls=${ring.className} deg=${ring.style && ring.style._props ? ring.style._props['--ck-ring-deg'] : '-'}`
    : 'ring=none';
  console.log(`  STATE  ${s.name} now=${s.nowMin} hero=${heroBits.join('|') || '?'} blocks=${blocks} needle=${needle} ${ringInfo}`);
  console.log(`         excerpt: ${s.text.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
});

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
