'use strict';

/**
 * verify:sunset-schedule-day-cockpit-p3-states
 *
 * P3: state/edge matrix + 60s timer teardown + a11y.
 * Also re-runs the P2 below-band byte-identical hard gate.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-day-cockpit-p3-states.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const COCKPIT_MOD = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-day-cockpit-ui.js');
function resolveCockpitBelowBandBaseSha() {
  if (process.env.COCKPIT_P2_BASE_SHA) return String(process.env.COCKPIT_P2_BASE_SHA).trim();
  try {
    return execSync('git merge-base HEAD origin/master', {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch (_e) {
    try {
      return execSync('git rev-parse origin/master', { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch (_e2) {
      return 'bfe878dd';
    }
  }
}
const BASE_SHA = resolveCockpitBelowBandBaseSha();

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

/* ── minimal DOM ─────────────────────────────────────────────────────────── */
function makeDoc() {
  function Node(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.className = '';
    this.children = [];
    this.attributes = Object.create(null);
    this._text = '';
    this._html = '';
    this.style = {
      _props: Object.create(null),
      setProperty(k, v) { this._props[k] = String(v); this[k] = String(v); },
    };
    this._listeners = {};
    this.ownerDocument = null;
    this.parentNode = null;
    this.type = '';
    this.title = '';
    this._classList = new Set();
  }
  Object.defineProperty(Node.prototype, 'textContent', {
    get() {
      if (!this.children.length) return this._text;
      return this.children.map((c) => c.textContent).join('');
    },
    set(v) { this.children.length = 0; this._html = ''; this._text = v == null ? '' : String(v); },
  });
  Object.defineProperty(Node.prototype, 'innerHTML', {
    get() {
      if (this._html) return this._html;
      return this.children.map((c) => c.textContent).join('');
    },
    set(v) {
      this.children.length = 0; this._text = ''; this._html = v == null ? '' : String(v);
      const classRe = /class=["']([^"']+)["']/gi;
      let cm;
      while ((cm = classRe.exec(this._html)) !== null) {
        const fake = new Node('i');
        fake.ownerDocument = this.ownerDocument;
        fake.className = cm[1];
        cm[1].split(/\s+/).forEach((c) => c && fake._classList.add(c));
        this.children.push(fake);
      }
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
  Node.prototype.appendChild = function (c) {
    if (!c) return c;
    c.parentNode = this; c.ownerDocument = this.ownerDocument;
    this.children.push(c); this._html = '';
    return c;
  };
  Node.prototype.append = function () {
    for (let i = 0; i < arguments.length; i++) {
      const a = arguments[i];
      if (a == null) continue;
      if (typeof a === 'string' || typeof a === 'number') {
        this.appendChild(this.ownerDocument.createTextNode(String(a)));
      } else this.appendChild(a);
    }
  };
  Node.prototype.addEventListener = function (t, fn) {
    (this._listeners[t] = this._listeners[t] || []).push(fn);
  };
  Node.prototype.querySelectorAll = function (sel) {
    const out = [];
    const walk = (n) => {
      if (!n || !n.tagName) return;
      if (match(n, sel)) out.push(n);
      (n.children || []).forEach(walk);
    };
    (this.children || []).forEach(walk);
    return out;
  };
  Node.prototype.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };
  function match(n, sel) {
    if (sel === 'button') return n.tagName === 'BUTTON';
    if (sel.startsWith('.')) {
      const cls = sel.slice(1).split(/[\s\[]/)[0];
      return String(n.className || '').split(/\s+/).includes(cls);
    }
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const body = sel.slice(1, -1);
      const eq = body.indexOf('=');
      if (eq === -1) return n.getAttribute(body) != null;
      const key = body.slice(0, eq);
      const val = body.slice(eq + 1).replace(/^["']|["']$/g, '');
      return n.getAttribute(key) === val;
    }
    return n.tagName === sel.toUpperCase();
  }
  const doc = {
    head: null,
    createElement(tag) { const n = new Node(tag); n.ownerDocument = doc; return n; },
    createTextNode(text) {
      const n = new Node('#text'); n.nodeType = 3; n.tagName = ''; n._text = String(text); n.ownerDocument = doc; return n;
    },
    getElementById() { return null; },
  };
  doc.head = doc.createElement('head');
  return doc;
}

function extractBelowBand(html) {
  const startToken = '<div id="ps-state"';
  const start = html.indexOf(startToken);
  if (start < 0) return null;
  const create = html.indexOf('<div id="ps-create-modal"', start);
  if (create < 0) return null;
  const cut = html.lastIndexOf('\n', create);
  return html.slice(start, cut > start ? cut : create);
}

const producerSessions = [
  { kind: 'course', course_id: 'manana', label: 'Curso Mañana', slot_key: 'manana', start: 600, end: 720, capacity: 24, surfers: 3, boardsNeeded: 3, wetsuitsNeeded: 3 },
  { kind: 'course', course_id: 'medio', label: 'Curso Medio Día', slot_key: 'medio', start: 720, end: 840, capacity: 24, surfers: 2, boardsNeeded: 2, wetsuitsNeeded: 2 },
  { kind: 'course', course_id: 'tarde', label: 'Curso Tarde', slot_key: 'tarde', start: 960, end: 1080, capacity: 24, surfers: 0, boardsNeeded: 0, wetsuitsNeeded: 0 },
];

const backToBackSessions = [
  { id: 'a', name: 'Curso A', start: '10:00', end: '12:00', booked: 3, capacity: 24, boards: 3, wetsuits: 3 },
  { id: 'b', name: 'Curso B', start: '12:00', end: '14:00', booked: 2, capacity: 24, boards: 2, wetsuits: 2 },
];

console.log('\nverify:sunset-schedule-day-cockpit-p3-states\n');

const cockpit = require(COCKPIT_MOD);
const apiSrc = fs.readFileSync(STAFF_API, 'utf8');

console.log('[1] Below-band still byte-identical (P2 hard gate)');
let beforeApi = '';
try {
  beforeApi = execSync(`git show ${BASE_SHA}:scripts/staff-query-api.js`, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
} catch (e) {
  assert('load base api', false, String(e.message || e));
}
const beforeBelow = beforeApi ? extractBelowBand(beforeApi) : null;
const afterBelow = extractBelowBand(apiSrc);
assert('below extractable', !!(beforeBelow && afterBelow));
assert('below-band BYTE-IDENTICAL vs ' + BASE_SHA, beforeBelow === afterBelow,
  beforeBelow && afterBelow ? `len ${beforeBelow.length}/${afterBelow.length}` : 'missing');

console.log('\n[2] Legacy controls a11y (hidden + inert)');
assert('legacy has inert', /id="ps-schedule-legacy-controls"[^>]*\binert\b/.test(apiSrc));
assert('legacy aria-hidden', /id="ps-schedule-legacy-controls"[^>]*aria-hidden="true"/.test(apiSrc));
assert('legacy hidden attr', /id="ps-schedule-legacy-controls"[^>]*\bhidden\b/.test(apiSrc));
assert('legacy nav buttons tabindex -1', apiSrc.includes('id="ps-prev-week" tabindex="-1"'));
assert('legacy create tabindex -1', apiSrc.includes('id="ps-create-booking" tabindex="-1"'));

console.log('\n[3] State matrix');
const doc = makeDoc();
global.document = doc;
const host = doc.createElement('div');
host.id = 'ps-day-cockpit';
host.ownerDocument = doc;
doc.getElementById = (id) => (id === 'ps-day-cockpit' ? host : null);

function paint(src) {
  host.innerHTML = '';
  host.className = '';
  host.__ckTimer = null;
  host.__ckSrc = null;
  const data = cockpit.schedulePaintDayCockpit(Object.assign({
    venue: 'Sunset',
    prep: { boards: { total: 8, lesson: 4, rental: 4 }, wetsuits: { total: 8, lesson: 4, rental: 4 }, unpaid: 2, needReply: 0 },
    on: {},
  }, src));
  const text = host.textContent;
  const needle = host.querySelectorAll('.ck-needle').length;
  const blocksN = host.querySelectorAll('.ck-block').length;
  const ringN = host.querySelectorAll('.ck-ring').length;
  const idleN = host.querySelectorAll('.ck-now--idle').length;
  // Snapshot counts now — host is reused across paints.
  return {
    data,
    text,
    mount: host,
    needle,
    blocks: blocksN,
    rings: ringN,
    idle: idleN,
  };
}

function heroOf(text) {
  if (/ON NOW/.test(text)) return 'ON_NOW';
  if (/NOTHING IN THE WATER/.test(text)) return 'BEFORE';
  if (/DAY COMPLETE/.test(text)) return 'AFTER';
  if (/No sessions scheduled/.test(text)) return 'EMPTY';
  if (/First up:/.test(text)) return 'FIRST_UP';
  return '?';
}


function localIso(d) {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}
const TODAY_ISO = localIso(new Date());
const _nt = new Date();
_nt.setFullYear(_nt.getFullYear() + 1);
_nt.setMonth(0, 15); // Jan 15 next year — never "today" in normal runs
const NON_TODAY_ISO = localIso(_nt);

// mid / before / after (keep P1/P2)
const mid = paint({ date: TODAY_ISO, range: 'today', now: 757, sessions: producerSessions });
assert('mid ON NOW', heroOf(mid.text) === 'ON_NOW');
assert('mid needle', mid.needle === 1);
assert('mid countdown', /ends in/.test(mid.text));

const before = paint({ date: TODAY_ISO, range: 'today', now: 560, sessions: producerSessions });
assert('before NOTHING', heroOf(before.text) === 'BEFORE' || /NOTHING IN THE WATER/.test(before.text));
assert('before starts in', /starts in/.test(before.text));

const after = paint({ date: TODAY_ISO, range: 'today', now: 1140, sessions: producerSessions });
assert('after DAY COMPLETE', /DAY COMPLETE/.test(after.text));

// no-sessions
const empty = paint({ date: TODAY_ISO, range: 'today', now: 720, sessions: [] });
assert('empty No sessions', /No sessions scheduled/.test(empty.text));
assert('empty idle', empty.idle >= 1);

// capacity 0
const cap0 = paint({
  date: TODAY_ISO, range: 'today', now: 750,
  sessions: [{ id: 'x', name: 'Open', start: '12:00', end: '14:00', booked: 2, capacity: 0, boards: 0, wetsuits: 0 }],
});
assert('cap0 booked-only', /is-booked-only/.test(cap0.mount.querySelector('.ck-ring') && cap0.mount.querySelector('.ck-ring').className || '') || cap0.rings >= 1);
// re-check class from last paint host
assert('cap0 booked-only class', String(cap0.mount.querySelector('.ck-ring') && cap0.mount.querySelector('.ck-ring').className || '').includes('is-booked-only'));

// non-today: needle hidden, no countdown, hero first session
const nonToday = paint({
  date: NON_TODAY_ISO,
  range: 'today',
  sessions: producerSessions,
});
assert('non-today nowMinutes null', cockpit.scheduleCockpitNowMinutes(nonToday.data) == null);
assert('non-today no needle', nonToday.needle === 0);
assert('non-today no ends in / starts in countdown', !/ends in/.test(nonToday.text) && !/starts in/.test(nonToday.text));
assert('non-today hero relative + summary', !/First up:/.test(nonToday.text) && !/NOTHING IN THE WATER/.test(nonToday.text) && !/starts in/.test(nonToday.text) && (/session/i.test(nonToday.text) || /Curso Mañana/.test(nonToday.text) || /YESTERDAY|DAYS AGO|LAST WEEK|TOMORROW|IN \d+ DAYS/i.test(nonToday.text)));

// Week / Next-30 — README: no needle, no countdown.
// Monthly First up must be the next upcoming session (wall clock), not a completed one.
const week = paint({
  date: TODAY_ISO,
  range: 'week',
  now: 757, // must be ignored for week
  sessions: producerSessions,
});
assert('week range freezes clock', cockpit.scheduleCockpitNowMinutes({ range: 'week', date: TODAY_ISO, now: 757 }) == null);
assert('week no needle', week.needle === 0);
assert('week no countdown', !/ends in/.test(week.text) && !/starts in/.test(week.text));
assert('week not ON NOW live hero', !/ON NOW/.test(week.text));
assert('week hero first session', /First up:/.test(week.text));
assert('week pill pressed', week.mount.querySelectorAll('[aria-pressed="true"]').length >= 1);

const next30 = paint({
  date: TODAY_ISO,
  range: 'next30',
  now: 757, // 12:37 — Mañana DONE; Medio live → First up Medio (not Mañana)
  sessions: producerSessions,
});
assert('next30 no needle', next30.needle === 0);
assert('next30 no countdown', !/ends in/.test(next30.text) && !/starts in/.test(next30.text));
assert('next30 hero First up', /First up:/.test(next30.text));
{
  const h2 = next30.mount.querySelector('h2');
  const title = h2 ? String(h2.textContent || '') : '';
  assert('next30 First up skips completed Mañana',
    /Medio|Tarde/.test(title) && !/Ma[nñ]ana/.test(title),
    title);
}
assert('next30 month prep title', /THIS MONTH'S PREP|PREP ·/.test(next30.text));
assert('next30 not TODAY\'S PREP', !/TODAY'S PREP/.test(next30.text));

// Seadog BLOCK cases — freeze gates beat now / forceNow overrides
assert('week+forceNow still null', cockpit.scheduleCockpitNowMinutes({
  range: 'week', forceNow: true, now: 757, date: TODAY_ISO,
}) == null);
const weekForce = paint({
  range: 'week', forceNow: true, now: 757, date: TODAY_ISO, sessions: producerSessions,
});
assert('week+forceNow no needle', weekForce.needle === 0);
assert('week+forceNow no countdown', !/ends in/.test(weekForce.text) && !/starts in/.test(weekForce.text));
assert('week+forceNow hero first', /First up:/.test(weekForce.text));
assert('week+forceNow not ON NOW', !/ON NOW/.test(weekForce.text));

assert('next30+now still null', cockpit.scheduleCockpitNowMinutes({
  range: 'next30', now: 757, date: TODAY_ISO,
}) == null);

assert('non-today+now still null', cockpit.scheduleCockpitNowMinutes({
  range: 'today', date: NON_TODAY_ISO, now: 757,
}) == null);
const nonTodayNow = paint({
  range: 'today', date: NON_TODAY_ISO, now: 757, sessions: producerSessions,
});
assert('non-today+now no needle', nonTodayNow.needle === 0);
assert('non-today+now no ON NOW', !/ON NOW/.test(nonTodayNow.text));
assert('non-today+now no countdown', !/ends in/.test(nonTodayNow.text) && !/starts in/.test(nonTodayNow.text));
assert('non-today+now no First up framing', !/First up:/.test(nonTodayNow.text) && !/NOTHING IN THE WATER/.test(nonTodayNow.text));

assert('today+now still live 757', cockpit.scheduleCockpitNowMinutes({
  range: 'today', date: TODAY_ISO, now: 757,
}) === 757);


// back-to-back: at 12:00 later session is live; blocks touch (no gap/overlap)
const b2bClass = cockpit.scheduleCockpitClassify({
  sessions: backToBackSessions,
}, 12 * 60);
assert('b2b at 12:00 live = B', b2bClass.live && b2bClass.live.id === 'b');
assert('b2b at 11:59 live = A', cockpit.scheduleCockpitClassify({ sessions: backToBackSessions }, 12 * 60 - 1).live.id === 'a');

const b2b = paint({
  date: TODAY_ISO, range: 'today', now: 12 * 60 + 15,
  sessions: backToBackSessions,
});
assert('b2b two blocks', b2b.blocks === 2);
if (b2b.blocks === 2) {
  const blocks = b2b.mount.querySelectorAll('.ck-block');
  const left0 = parseFloat(blocks[0].style.left);
  const width0 = parseFloat(blocks[0].style.width);
  const left1 = parseFloat(blocks[1].style.left);
  const edge = left0 + width0;
  assert('b2b blocks adjacent (no gap/overlap)', Math.abs(edge - left1) < 0.05,
    `edge=${edge} left1=${left1}`);
}
assert('b2b live is B', /Curso B|ON NOW/.test(b2b.text) && /ON NOW/.test(b2b.text));

console.log('\n[4] a11y assertions');
const a11y = paint({ date: TODAY_ISO, range: 'today', now: 757, sessions: producerSessions });
const allBtns = a11y.mount.querySelectorAll('button');
assert('has buttons', allBtns.length >= 6);
let pressedTrue = 0;
let pressedFalse = 0;
let refreshOk = false;
let ribbonBtns = 0;
allBtns.forEach((b) => {
  const ap = b.getAttribute('aria-pressed');
  if (ap === 'true') pressedTrue += 1;
  if (ap === 'false') pressedFalse += 1;
  if (b.getAttribute('aria-label') === 'Refresh') refreshOk = true;
  if (String(b.className || '').includes('ck-block')) {
    ribbonBtns += 1;
    assert('ribbon block is BUTTON', b.tagName === 'BUTTON');
    assert('ribbon block has title', !!(b.title && b.title.length));
  }
});
assert('aria-pressed true present', pressedTrue >= 1);
assert('aria-pressed false present on inactive segs', pressedFalse >= 2);
assert('refresh aria-label', refreshOk);
assert('ribbon blocks are buttons with titles', ribbonBtns === 3);

console.log('\n[5] 60s timer — start, no data-loader, destroy no leak');
// Fake timers
const timers = new Map();
let nextId = 1;
const cleared = [];
const origSet = global.setInterval;
const origClear = global.clearInterval;
let loadCalls = 0;
global.scheduleRequestPageLoad = function () { loadCalls += 1; };
global.setInterval = function (fn, ms) {
  const id = nextId++;
  timers.set(id, { fn, ms });
  return id;
};
global.clearInterval = function (id) {
  cleared.push(id);
  timers.delete(id);
};

// Live today paint without frozen now → should tick
// Monkeypatch nowMinutes path: use forceNow false and date=today string matching Date
const realDate = Date;
const fixedNow = new realDate('2026-07-31T12:37:00');
// Use ISO date that matches mocked "today"
const todayIso = [
  fixedNow.getFullYear(),
  String(fixedNow.getMonth() + 1).padStart(2, '0'),
  String(fixedNow.getDate()).padStart(2, '0'),
].join('-');

// For shouldTick with wall clock: range today, no data.now, same day as system now.
// System "today" may not be 2026-07-31 — so test timer API via scheduleMountDayCockpit
// with forceNow and shouldTick override path:
// scheduleDayCockpitShouldTick returns false when data.now is set.
// Instead call mount with data without now but spy shouldTick...
// Direct unit: start timer via mount when shouldTick true by patching.

const shouldTickReal = cockpit.scheduleDayCockpitShouldTick;
// Force shouldTick true once for mount test
const mountHost = doc.createElement('div');
mountHost.ownerDocument = doc;
const dataLive = cockpit.scheduleBuildDayCockpitData({
  venue: 'Sunset',
  date: todayIso,
  range: 'today',
  sessions: producerSessions,
  // no now
});
// Patch Date temporarily so sameDay is true for dataLive.date
const RealDate = Date;
function MockDate(...args) {
  if (args.length === 0) return new RealDate(fixedNow.getTime());
  return new RealDate(...args);
}
MockDate.now = () => fixedNow.getTime();
MockDate.parse = RealDate.parse;
MockDate.UTC = RealDate.UTC;
global.Date = MockDate;

const tickHost = doc.createElement('div');
tickHost.ownerDocument = doc;
const api = cockpit.scheduleMountDayCockpit(tickHost, Object.assign({}, dataLive, {
  date: [
    fixedNow.getFullYear(),
    String(fixedNow.getMonth() + 1).padStart(2, '0'),
    String(fixedNow.getDate()).padStart(2, '0'),
  ].join('-'),
}));
assert('timer started (one interval)', timers.size === 1, `size=${timers.size}`);
const timerId = [...timers.keys()][0];
assert('interval is 60000ms', timers.get(timerId).ms === 60000);

// Fire tick manually — must not call requestPageLoad
const beforeLoad = loadCalls;
timers.get(timerId).fn();
assert('tick did not call scheduleRequestPageLoad', loadCalls === beforeLoad);

// destroy clears timer
api.destroy();
assert('destroy cleared interval', cleared.includes(timerId));
assert('no timers left after destroy', timers.size === 0);
assert('__ckTimer null after destroy', tickHost.__ckTimer == null);

// re-paint clears previous timer (no leak on re-nav)
const h2 = doc.createElement('div');
h2.ownerDocument = doc;
doc.getElementById = (id) => (id === 'ps-day-cockpit' ? h2 : null);
// Paint with frozen now — should NOT start timer
cockpit.schedulePaintDayCockpit({
  venue: 'Sunset', date: TODAY_ISO, range: 'today', now: 757, sessions: producerSessions, on: {},
});
assert('frozen now paint starts no timer', timers.size === 0);

// Mount twice without destroy — second mount clears first
const h3 = doc.createElement('div');
h3.ownerDocument = doc;
const m1 = cockpit.scheduleMountDayCockpit(h3, Object.assign({}, dataLive, {
  date: [
    fixedNow.getFullYear(),
    String(fixedNow.getMonth() + 1).padStart(2, '0'),
    String(fixedNow.getDate()).padStart(2, '0'),
  ].join('-'),
}));
const id1 = h3.__ckTimer;
const m2 = cockpit.scheduleMountDayCockpit(h3, Object.assign({}, dataLive, {
  date: [
    fixedNow.getFullYear(),
    String(fixedNow.getMonth() + 1).padStart(2, '0'),
    String(fixedNow.getDate()).padStart(2, '0'),
  ].join('-'),
}));
assert('remount cleared prior timer', cleared.includes(id1));
assert('only one active timer after remount', timers.size === 1);
m2.destroy();
assert('final destroy empty timers', timers.size === 0);

global.Date = RealDate;
global.setInterval = origSet;
global.clearInterval = origClear;
delete global.scheduleRequestPageLoad;

console.log('\n[5b] Cancelled/ghost leakage — prep rail excludes cancelled gear + unpaid');
// Predicate parity with scheduleBuildDaySessions filter.
assert('active row ok', cockpit.scheduleCockpitRowIsActive({ booking_status: 'confirmed', service_date: TODAY_ISO }) === true);
assert('drop _isCancelled', cockpit.scheduleCockpitRowIsActive({ _isCancelled: true }) === false);
assert('drop schedule_ghost', cockpit.scheduleCockpitRowIsActive({ schedule_ghost: true }) === false);
assert('drop booking_status cancelled', cockpit.scheduleCockpitRowIsActive({ booking_status: 'cancelled' }) === false);
assert('drop booking_status canceled', cockpit.scheduleCockpitRowIsActive({ booking_status: 'canceled' }) === false);
assert('drop status cancelled', cockpit.scheduleCockpitRowIsActive({ status: 'cancelled' }) === false);
assert('drop service_status cancelled', cockpit.scheduleCockpitRowIsActive({ service_status: 'cancelled' }) === false);

const ghostIso = TODAY_ISO;
const activeRow = {
  service_date: ghostIso,
  booking_status: 'confirmed',
  payment_status: 'paid',
  service_type: 'course',
  boards: 2,
  wetsuits: 2,
  guest_count: 2,
  _groupKey: 'active-1',
};
const cancelledGearRow = {
  service_date: ghostIso,
  booking_status: 'cancelled',
  payment_status: 'unpaid',
  service_type: 'course',
  boards: 5,
  wetsuits: 5,
  guest_count: 5,
  _groupKey: 'cancel-1',
  _isCancelled: true,
};
const ghostUnpaidRow = {
  service_date: ghostIso,
  schedule_ghost: true,
  payment_status: 'pending',
  service_type: 'course',
  boards: 3,
  wetsuits: 3,
  guest_count: 3,
  _groupKey: 'ghost-1',
};
const mixedRows = [activeRow, cancelledGearRow, ghostUnpaidRow];
const activeOnly = cockpit.scheduleCockpitFilterActiveRows(mixedRows);
assert('filter keeps only active', activeOnly.length === 1 && activeOnly[0]._groupKey === 'active-1');

// Stubs mirror staff helpers: DATE FILTER ONLY (the bug surface).
function stubEquipTotals(rows, dateIso) {
  const day = (rows || []).filter((r) => String(r.service_date || '').slice(0, 10) === dateIso);
  let boards = 0;
  let wetsuits = 0;
  day.forEach((r) => {
    boards += Number(r.boards) || 0;
    wetsuits += Number(r.wetsuits) || 0;
  });
  return {
    boards: { total: boards, lesson: boards, rental: 0 },
    wetsuits: { total: wetsuits, lesson: wetsuits, rental: 0 },
  };
}
function stubUnpaidCount(rows, dateIso) {
  const seen = {};
  let count = 0;
  (rows || []).filter((r) => String(r.service_date || '').slice(0, 10) === dateIso).forEach((r) => {
    const key = r._groupKey || r.id;
    if (seen[key]) return;
    seen[key] = true;
    const ps = String(r.payment_status || '').toLowerCase();
    if (ps === 'unpaid' || ps === 'pending') count += 1;
  });
  return count;
}

// Bug proof: unfiltered helpers WOULD count cancelled gear/unpaid.
const leakEquip = stubEquipTotals(mixedRows, ghostIso);
const leakUnpaid = stubUnpaidCount(mixedRows, ghostIso);
assert('unfiltered would leak gear boards', leakEquip.boards.total === 2 + 5 + 3);
assert('unfiltered would leak unpaid', leakUnpaid === 2); // cancel unpaid + ghost pending

// Fixed path: filter first, then same helpers.
const fixedEquip = stubEquipTotals(activeOnly, ghostIso);
const fixedUnpaid = stubUnpaidCount(activeOnly, ghostIso);
assert('filtered prep boards exclude cancelled', fixedEquip.boards.total === 2);
assert('filtered prep wetsuits exclude cancelled', fixedEquip.wetsuits.total === 2);
assert('filtered unpaid excludes cancelled/ghost', fixedUnpaid === 0);

// Collect path uses the filter before helpers.
global.scheduleActiveDayIso = () => ghostIso;
global.scheduleCurrentViewMode = () => 'day';
global.getSunsetLocationLabel = () => 'Sunset';
global.scheduleGetRowsSnapshot = () => mixedRows;
global.scheduleBuildDaySessions = (dayRows) => {
  // sessions only from active (already filtered by collect, plus helper re-filter)
  return (dayRows || []).filter((r) => !r._isCancelled && !r.schedule_ghost).map((r) => ({
    kind: 'course',
    course_id: r._groupKey,
    label: 'Session',
    start: 600,
    end: 720,
    capacity: 24,
    surfers: Number(r.guest_count) || 0,
    boardsNeeded: Number(r.boards) || 0,
    wetsuitsNeeded: Number(r.wetsuits) || 0,
  }));
};
global.scheduleDayEquipmentTotals = stubEquipTotals;
global.scheduleUnpaidPendingCount = stubUnpaidCount;
global.scheduleConversationsCache = [];
global.scheduleNeedReplyEmailCount = () => 0;
global.scheduleNeedReplyWhatsAppCount = () => 0;

const collected = cockpit.scheduleCollectDayCockpitSource();
assert('collect prep boards = active only', collected.equip.boards.total === 2);
assert('collect prep wetsuits = active only', collected.equip.wetsuits.total === 2);
assert('collect unpaid = 0 (ghost/cancel dropped)', collected.unpaidCount === 0);
assert('collect sessions exclude cancelled', (collected.sessions || []).length === 1);
// Consistency: prep gear matches session gear totals for the active booking.
const sessionBoards = (collected.sessions || []).reduce((n, s) => n + (Number(s.boardsNeeded) || 0), 0);
assert('prep boards consistent with session boards', collected.equip.boards.total === sessionBoards);

// Build path: equip → prep (no paint() default prep override).
const built = cockpit.scheduleBuildDayCockpitData({
  venue: 'Sunset',
  date: TODAY_ISO,
  range: 'today',
  now: 650,
  sessions: collected.sessions,
  equip: collected.equip,
  unpaidCount: collected.unpaidCount,
  needReplyCount: 0,
});
assert('build prep boards = 2 (not leaked 10)', built.prep.boards.total === 2);
assert('build prep wetsuits = 2 (not leaked 10)', built.prep.wetsuits.total === 2);
assert('build unpaid = 0', built.prep.unpaid === 0);
// Render without default prep merge
host.innerHTML = '';
host.className = '';
cockpit.scheduleRenderDayCockpit(host, built);
const ghostText = host.textContent || '';
assert('render shows prep 2 boards', /\b2\b/.test(ghostText));
assert('render unpaid zero', built.prep.unpaid === 0);

[
  'scheduleActiveDayIso', 'scheduleCurrentViewMode', 'getSunsetLocationLabel',
  'scheduleGetRowsSnapshot', 'scheduleBuildDaySessions', 'scheduleDayEquipmentTotals',
  'scheduleUnpaidPendingCount', 'scheduleConversationsCache',
  'scheduleNeedReplyEmailCount', 'scheduleNeedReplyWhatsAppCount',
].forEach((k) => { try { delete global[k]; } catch (_e) { /* ignore */ } });

console.log('\n[6] State snapshot table');
const snapshots = [
  ['mid-session', mid],
  ['before-first', before],
  ['after-last', after],
  ['no-sessions', empty],
  ['capacity-0', cap0],
  ['non-today', nonToday],
  ['week', week],
  ['next30', next30],
  ['back-to-back', b2b],
];
snapshots.forEach(([name, s]) => {
  console.log(`  STATE  ${name.padEnd(14)} hero=${heroOf(s.text).padEnd(10)} needle=${s.needle} blocks=${s.blocks}`);
});

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
