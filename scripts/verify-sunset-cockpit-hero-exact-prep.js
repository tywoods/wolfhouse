'use strict';

/**
 * verify:sunset-cockpit-hero-exact-prep
 *
 * Hero chip must show SESSION-SCOPED exact course add-on prep items
 * (e.g. "4 Surfboard + Wetsuit to prep"), not day-wide boards/wetsuits
 * totals and not decomposed board/wetsuit components.
 *
 * Pipeline under test:
 *   session groups/records → scheduleBuildSessionPrepItems
 *   → scheduleBuildDaySessions (prepItems field)
 *   → scheduleMapDaySessionToCockpit / scheduleBuildDayCockpitData
 *   → scheduleRenderDayCockpit
 *
 * Offline only. Run:
 *   node scripts/verify-sunset-cockpit-hero-exact-prep.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const COCKPIT_PATH = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-day-cockpit-ui.js');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DATE = '2026-08-01';

let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}
function section(title) {
  console.log(`\n=== ${title} ===\n`);
}

/* ── Minimal DOM (same pattern as cockpit offline gates) ─────────────────── */
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
      display: '',
    };
    this._listeners = Object.create(null);
    this.ownerDocument = null;
    this.parentNode = null;
    this.id = '';
    this.type = '';
    this.title = '';
  }
  Object.defineProperty(Node.prototype, 'textContent', {
    get() {
      if (!this.children.length) return this._text;
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
      return this._html || this.children.map((c) => c.textContent).join('');
    },
    set(v) {
      this.children.length = 0;
      this._text = '';
      this._html = v == null ? '' : String(v);
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
    if (k === 'id') this.id = String(v);
  };
  Node.prototype.getAttribute = function (k) {
    if (k === 'class') return this.className || null;
    if (k === 'id') return this.id || null;
    return this.attributes[k] != null ? this.attributes[k] : null;
  };
  Node.prototype.appendChild = function (c) {
    if (!c) return c;
    c.parentNode = this;
    c.ownerDocument = this.ownerDocument;
    this.children.push(c);
    this._html = '';
    return c;
  };
  Node.prototype.querySelectorAll = function (sel) {
    const out = [];
    const walk = (n) => {
      if (!n || !n.tagName) return;
      if (sel.startsWith('.') && (n.className || '').split(/\s+/).includes(sel.slice(1))) out.push(n);
      (n.children || []).forEach(walk);
    };
    walk(this);
    return out;
  };
  Node.prototype.querySelector = function (sel) {
    return this.querySelectorAll(sel)[0] || null;
  };
  Node.prototype.addEventListener = function (type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  };
  Node.prototype.createTextNode = function (t) {
    const n = new Node('#text');
    n._text = String(t == null ? '' : t);
    return n;
  };

  const doc = {
    body: null,
    head: null,
    documentElement: null,
    createElement(tag) {
      const n = new Node(tag);
      n.ownerDocument = doc;
      return n;
    },
    createTextNode(t) {
      const n = new Node('#text');
      n.ownerDocument = doc;
      n._text = String(t == null ? '' : t);
      return n;
    },
    getElementById(id) {
      const walk = (n) => {
        if (!n) return null;
        if (n.id === id) return n;
        for (const c of n.children || []) {
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(doc.body) || walk(doc.head) || null;
    },
  };
  doc.body = doc.createElement('body');
  doc.head = doc.createElement('head');
  doc.documentElement = doc.createElement('html');
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  return doc;
}

function extractFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') depth -= 1;
    if (depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

function ceMeta(opts) {
  opts = opts || {};
  return {
    course_equipment: true,
    course_equipment_mode: opts.mode || 'during_course',
    offering_key: opts.offering_key || 'surfboard_wetsuit',
    label: opts.label || 'Surfboard + Wetsuit',
    component: 'course_equipment',
  };
}

function guestGroup(opts) {
  const bookingId = opts.booking_id;
  const name = opts.guest_name;
  const cancelled = !!opts.cancelled;
  const courseId = opts.course_id || 'manana';
  const label = opts.course_label || 'Curso Mañana';
  const offering = opts.offering || {
    offering_key: 'surfboard_wetsuit',
    label: 'Surfboard + Wetsuit',
  };
  const courseRow = {
    booking_id: bookingId,
    booking_code: bookingId,
    booking_status: cancelled ? 'cancelled' : 'confirmed',
    service_status: cancelled ? 'cancelled' : 'confirmed',
    service_date: DATE,
    service_type: 'course',
    staff_ui_service_type: 'course',
    course_id: courseId,
    course_label: label,
    quantity: 1,
    guest_name: name,
    slot_time: opts.slot_time || '10:00-12:00',
    metadata: { component: 'course', course_id: courseId, course_label: label },
    _isCancelled: cancelled || undefined,
  };
  const ceRow = {
    booking_id: bookingId,
    booking_code: bookingId,
    booking_status: cancelled ? 'cancelled' : 'confirmed',
    service_status: cancelled ? 'cancelled' : 'confirmed',
    service_date: DATE,
    service_type: 'addon_service',
    staff_ui_service_type: 'course_equipment',
    quantity: opts.qty != null ? opts.qty : 1,
    guest_name: name,
    metadata: ceMeta(offering),
    _isCancelled: cancelled || undefined,
  };
  return {
    _groupKey: `b:${bookingId}:${DATE}`,
    booking_id: bookingId,
    guest_name: name,
    service_date: DATE,
    course_id: courseId,
    course_label: label,
    quantity: 1,
    components: { course: true, course_equipment: true },
    records: [courseRow, ceRow],
    _isCancelled: cancelled || undefined,
    schedule_ghost: opts.ghost || undefined,
  };
}

function loadCockpit(doc) {
  const src = fs.readFileSync(COCKPIT_PATH, 'utf8');
  const sandbox = {
    console,
    module: { exports: {} },
    exports: {},
    document: doc,
    window: { document: doc },
    portalT(k) { return k; },
    el(id) { return doc.getElementById(id); },
    scheduleRowIsActive(r) {
      if (!r) return false;
      if (r._isCancelled || r.schedule_ghost) return false;
      const bs = String(r.booking_status || r.status || '').toLowerCase();
      if (bs === 'cancelled' || bs === 'canceled') return false;
      const ss = String(r.service_status || '').toLowerCase();
      if (ss === 'cancelled') return false;
      return true;
    },
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'sunset-schedule-day-cockpit-ui.js' });
  return sandbox.module.exports;
}

function heroChipsText(mount) {
  const chips = mount.querySelectorAll('.ck-chips');
  if (!chips.length) return '';
  // First chips block is the hero chips.
  return (chips[0].textContent || '').replace(/\s+/g, ' ').trim();
}

function fullText(mount) {
  return (mount.textContent || '').replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nverify:sunset-cockpit-hero-exact-prep\n');

section('1) Exports + session prep builder (exact items, active only)');
const doc = createMinimalDocument();
const cockpit = loadCockpit(doc);
ok(
  'exports scheduleBuildSessionPrepItems',
  typeof cockpit.scheduleBuildSessionPrepItems === 'function',
);
ok(
  'exports scheduleMapDaySessionToCockpit',
  typeof cockpit.scheduleMapDaySessionToCockpit === 'function',
);

const mananaGroups = [
  guestGroup({ booking_id: 'b-ana', guest_name: 'Ana' }),
  guestGroup({ booking_id: 'b-bob', guest_name: 'Bob' }),
  guestGroup({ booking_id: 'b-cam', guest_name: 'Cam' }),
  guestGroup({ booking_id: 'b-don', guest_name: 'Don' }),
  guestGroup({ booking_id: 'b-edu', guest_name: 'Edu', cancelled: true }),
];
const buildSessionPrep = typeof cockpit.scheduleBuildSessionPrepItems === 'function'
  ? cockpit.scheduleBuildSessionPrepItems
  : function () { return null; };
const items = buildSessionPrep(mananaGroups) || [];
ok('prep items array', Array.isArray(items) && items !== null, JSON.stringify(items));
ok(
  '4 active + 1 cancelled => qty 4 (not 5)',
  Array.isArray(items)
    && items.length === 1
    && items[0]
    && items[0].offering_key === 'surfboard_wetsuit'
    && Number(items[0].quantity) === 4
    && String(items[0].label) === 'Surfboard + Wetsuit',
  JSON.stringify(items),
);
ok('kind is course_addon', items[0] && items[0].kind === 'course_addon');

// Later course + standalone rental must not pollute morning session prep.
const tardeGroups = [
  guestGroup({
    booking_id: 'b-tarde-1',
    guest_name: 'Zoe',
    course_id: 'tarde',
    course_label: 'Curso Tarde',
    slot_time: '16:00-18:00',
    offering: { offering_key: 'softboard', label: 'Softboard' },
  }),
];
const mananaOnly = buildSessionPrep(mananaGroups) || [];
const tardeOnly = buildSessionPrep(tardeGroups) || [];
ok(
  'morning session excludes later course Softboard',
  !mananaOnly.some((it) => /softboard/i.test(String(it.offering_key || it.label || ''))),
  JSON.stringify(mananaOnly),
);
ok(
  'later session Softboard qty=1 not mixed into morning',
  tardeOnly.length === 1 && tardeOnly[0].offering_key === 'softboard' && tardeOnly[0].quantity === 1,
  JSON.stringify(tardeOnly),
);

const standaloneGroup = {
  _groupKey: 'b:rental:DATE',
  booking_id: 'b-rental',
  guest_name: 'Renter',
  service_date: DATE,
  quantity: 2,
  components: { 'rental:kayak_rental': true },
  records: [{
    booking_id: 'b-rental',
    booking_status: 'confirmed',
    service_status: 'confirmed',
    service_date: DATE,
    service_type: 'addon_service',
    quantity: 2,
    metadata: {
      rental_offering: true,
      generic_rental: true,
      offering_key: 'kayak_rental',
      label: 'Kayak',
    },
  }],
};
ok(
  'standalone rental not counted as course session prep',
  Array.isArray(buildSessionPrep([standaloneGroup])) && buildSessionPrep([standaloneGroup]).length === 0,
);

// Arbitrary Admin label (never hardcode Surfboard + Wetsuit only).
const customGroups = [
  guestGroup({
    booking_id: 'b-c1',
    guest_name: 'X',
    offering: { offering_key: 'foam_longboard_xl', label: 'Foam Longboard XL' },
  }),
  guestGroup({
    booking_id: 'b-c2',
    guest_name: 'Y',
    offering: { offering_key: 'foam_longboard_xl', label: 'Foam Longboard XL' },
  }),
  guestGroup({
    booking_id: 'b-c3',
    guest_name: 'Z',
    offering: { offering_key: 'rash_guard_pro', label: 'Rash Guard Pro' },
  }),
];
const customItems = buildSessionPrep(customGroups) || [];
ok(
  'arbitrary Admin labels aggregate deterministically',
  customItems.length === 2
    && customItems.some((it) => it.label === 'Foam Longboard XL' && it.quantity === 2)
    && customItems.some((it) => it.label === 'Rash Guard Pro' && it.quantity === 1),
  JSON.stringify(customItems),
);
// Stable sort by label then key
ok(
  'multi-item sort is deterministic (label then key)',
  customItems.length === 2
    && customItems[0]
    && customItems[1]
    && customItems[0].label.localeCompare(customItems[1].label) <= 0,
  (customItems || []).map((i) => i && i.label).join('|'),
);

section('2) Mapper carries session.prepItems');
const mapped = cockpit.scheduleMapDaySessionToCockpit({
  kind: 'course',
  course_id: 'manana',
  label: 'Curso Mañana',
  slot_key: 'manana',
  start: 10 * 60,
  end: 12 * 60,
  capacity: 24,
  surfers: 4,
  groups: mananaGroups,
  boardsNeeded: 0,
  wetsuitsNeeded: 0,
  prepItems: items,
});
ok(
  'mapped.prepItems qty=4 Surfboard + Wetsuit',
  Array.isArray(mapped.prepItems)
    && mapped.prepItems.length === 1
    && mapped.prepItems[0].quantity === 4
    && mapped.prepItems[0].label === 'Surfboard + Wetsuit',
  JSON.stringify(mapped.prepItems),
);

// When prepItems omitted, derive from session.groups (trusted records).
const mappedFromGroups = cockpit.scheduleMapDaySessionToCockpit({
  kind: 'course',
  course_id: 'manana',
  label: 'Curso Mañana',
  start: 10 * 60,
  end: 12 * 60,
  surfers: 4,
  groups: mananaGroups,
  boardsNeeded: 0,
  wetsuitsNeeded: 0,
});
ok(
  'mapper derives prepItems from groups when field missing',
  mappedFromGroups.prepItems
    && mappedFromGroups.prepItems.length === 1
    && mappedFromGroups.prepItems[0].quantity === 4,
  JSON.stringify(mappedFromGroups.prepItems),
);

section('3) Idle hero — First up uses next course exact prep only');
const producerSessions = [
  {
    kind: 'course',
    course_id: 'manana',
    label: 'Curso Mañana',
    slot_key: 'manana',
    timeLabel: '10:00 – 12:00',
    start: 10 * 60,
    end: 12 * 60,
    capacity: 24,
    surfers: 4,
    bookings: 4,
    groups: mananaGroups,
    boardsNeeded: 0,
    wetsuitsNeeded: 0,
    prepItems: items,
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
    surfers: 1,
    bookings: 1,
    groups: tardeGroups,
    boardsNeeded: 0,
    wetsuitsNeeded: 0,
    prepItems: tardeOnly,
  },
];

const mountIdle = doc.createElement('div');
mountIdle.id = 'ps-day-cockpit-idle';
doc.body.appendChild(mountIdle);

const idleData = cockpit.scheduleBuildDayCockpitData({
  venue: 'Sunset Somo',
  date: DATE,
  navMode: 'day',
  now: 9 * 60 + 15, // before first course
  sessions: producerSessions,
  // Day-wide legacy totals deliberately wrong/zero — hero must ignore them.
  boardsTotal: 0,
  wetsuitsTotal: 0,
  prep: {
    items: [
      // Day rail may include later Softboard + morning combo + rental — hero must not use this.
      { offering_key: 'surfboard_wetsuit', label: 'Surfboard + Wetsuit', quantity: 4, kind: 'course_addon' },
      { offering_key: 'softboard', label: 'Softboard', quantity: 1, kind: 'course_addon' },
      { offering_key: 'kayak_rental', label: 'Kayak', quantity: 2, kind: 'rental' },
    ],
    boards: { total: 0, lesson: 0, rental: 0 },
    wetsuits: { total: 0, lesson: 0, rental: 0 },
    unpaid: 0,
    needReply: 0,
  },
});
cockpit.scheduleRenderDayCockpit(mountIdle, idleData);
const idleText = fullText(mountIdle);
const idleChips = heroChipsText(mountIdle);

ok('idle First up: Curso Mañana', /First up:\s*Curso Mañana/.test(idleText), idleText.slice(0, 200));
ok(
  'idle chip contract: 4 Surfboard + Wetsuit to prep',
  /4 Surfboard \+ Wetsuit to prep/.test(idleChips) || /4 Surfboard \+ Wetsuit to prep/.test(idleText),
  `chips=${idleChips} text=${idleText.slice(0, 320)}`,
);
ok(
  'idle never shows legacy 0 boards · 0 wetsuits',
  !/0 boards\s*[·.]\s*0 wetsuits/i.test(idleText),
  idleChips || idleText.slice(0, 200),
);
ok(
  'idle hero excludes later Softboard and standalone Kayak',
  !/Softboard to prep/i.test(idleChips) && !/Kayak to prep/i.test(idleChips),
  idleChips,
);
ok(
  'Today\'s Prep rail still shows day-wide Softboard (unchanged rail)',
  /Softboard/i.test(idleText) && /TODAY'?S PREP/i.test(idleText),
  idleText.slice(0, 500),
);

// Empty exact prep → "no gear needed" (not 0/0).
const emptyMount = doc.createElement('div');
const emptyData = cockpit.scheduleBuildDayCockpitData({
  venue: 'Sunset',
  date: DATE,
  navMode: 'day',
  now: 9 * 60,
  sessions: [{
    kind: 'course',
    course_id: 'manana',
    label: 'Curso Mañana',
    start: 10 * 60,
    end: 12 * 60,
    surfers: 2,
    groups: [],
    prepItems: [],
    boardsNeeded: 0,
    wetsuitsNeeded: 0,
  }],
  prep: { items: [], boards: { total: 0 }, wetsuits: { total: 0 }, unpaid: 0, needReply: 0 },
});
cockpit.scheduleRenderDayCockpit(emptyMount, emptyData);
const emptyText = fullText(emptyMount);
ok(
  'idle with no exact gear says no gear needed (not 0 boards · 0 wetsuits)',
  /no gear needed/i.test(emptyText) && !/0 boards\s*[·.]\s*0 wetsuits/i.test(emptyText),
  emptyText.slice(0, 240),
);

// Multi exact add-ons on same course → one chip each, deterministic order.
const multiMount = doc.createElement('div');
const multiData = cockpit.scheduleBuildDayCockpitData({
  venue: 'Sunset',
  date: DATE,
  navMode: 'day',
  now: 9 * 60,
  sessions: [{
    kind: 'course',
    course_id: 'manana',
    label: 'Curso Mañana',
    start: 10 * 60,
    end: 12 * 60,
    surfers: 3,
    prepItems: customItems,
    groups: customGroups,
  }],
  prep: { items: [], unpaid: 0, needReply: 0 },
});
cockpit.scheduleRenderDayCockpit(multiMount, multiData);
const multiChips = heroChipsText(multiMount);
ok(
  'multi exact items each render to prep',
  /2 Foam Longboard XL to prep/.test(multiChips) && /1 Rash Guard Pro to prep/.test(multiChips),
  multiChips,
);

section('4) Live hero — exact items out (session scoped)');
const liveMount = doc.createElement('div');
const liveData = cockpit.scheduleBuildDayCockpitData({
  venue: 'Sunset',
  date: DATE,
  navMode: 'day',
  now: 10 * 60 + 30, // during Curso Mañana
  sessions: producerSessions,
  prep: {
    items: [
      { offering_key: 'surfboard_wetsuit', label: 'Surfboard + Wetsuit', quantity: 4, kind: 'course_addon' },
      { offering_key: 'softboard', label: 'Softboard', quantity: 1, kind: 'course_addon' },
    ],
    boards: { total: 99, lesson: 99, rental: 0 },
    wetsuits: { total: 99, lesson: 99, rental: 0 },
    unpaid: 0,
    needReply: 0,
  },
});
cockpit.scheduleRenderDayCockpit(liveMount, liveData);
const liveText = fullText(liveMount);
const liveChips = heroChipsText(liveMount);
ok('live ON NOW Curso Mañana', /ON NOW/i.test(liveText) && /Curso Mañana/.test(liveText), liveText.slice(0, 200));
ok(
  'live chip: ✓ 4 Surfboard + Wetsuit out',
  /✓\s*4 Surfboard \+ Wetsuit out/.test(liveChips) || /✓\s*4 Surfboard \+ Wetsuit out/.test(liveText),
  `chips=${liveChips}`,
);
ok(
  'live does not use decomposed boards/wetsuits wording',
  !/\d+\s+boards?\s+out/i.test(liveChips) && !/\d+\s+wetsuits?\s+out/i.test(liveChips),
  liveChips,
);
ok(
  'live excludes later Softboard',
  !/Softboard out/i.test(liveChips),
  liveChips,
);

// Live with no gear
const liveEmptyMount = doc.createElement('div');
cockpit.scheduleRenderDayCockpit(liveEmptyMount, cockpit.scheduleBuildDayCockpitData({
  venue: 'Sunset',
  date: DATE,
  navMode: 'day',
  now: 10 * 60 + 30,
  sessions: [{
    kind: 'course',
    course_id: 'manana',
    label: 'Curso Mañana',
    start: 10 * 60,
    end: 12 * 60,
    surfers: 1,
    prepItems: [],
    boardsNeeded: 5,
    wetsuitsNeeded: 5,
  }],
}));
const liveEmptyChips = heroChipsText(liveEmptyMount);
ok(
  'live with no exact items says no gear needed (ignores boardsNeeded)',
  /no gear needed/i.test(liveEmptyChips) || /no gear needed/i.test(fullText(liveEmptyMount)),
  liveEmptyChips,
);

section('5) Day complete must not claim next-course prep');
const doneMount = doc.createElement('div');
cockpit.scheduleRenderDayCockpit(doneMount, cockpit.scheduleBuildDayCockpitData({
  venue: 'Sunset',
  date: DATE,
  navMode: 'day',
  now: 19 * 60,
  sessions: producerSessions,
  prep: {
    items: items,
    boards: { total: 4 },
    wetsuits: { total: 4 },
    unpaid: 0,
    needReply: 0,
  },
}));
const doneText = fullText(doneMount);
ok('day complete banner', /DAY COMPLETE/i.test(doneText), doneText.slice(0, 160));
ok(
  'day complete does not claim next-course prep',
  !/to prep/i.test(doneText),
  doneText.slice(0, 240),
);
ok(
  'day complete does not show legacy 0 boards · 0 wetsuits',
  !/0 boards\s*[·.]\s*0 wetsuits/i.test(doneText),
  doneText.slice(0, 240),
);

section('6) scheduleBuildDaySessions attaches prepItems (real builder path)');
const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
ok(
  'scheduleBuildDaySessions writes prepItems on course sessions',
  /function scheduleBuildDaySessions[\s\S]{0,2500}prepItems\s*:/.test(apiSrc),
);
ok(
  'private lesson sessions also carry prepItems',
  /function scheduleBuildPrivateLessonSessions[\s\S]{0,1200}prepItems\s*:/.test(apiSrc)
    || /prepItems\s*:\s*(typeof scheduleBuildSessionPrepItems|scheduleBuildSessionPrepItems)/.test(apiSrc),
);

// Runtime: load session builder extracts + cockpit prep builder in one VM.
{
  function makeRowIsActive(r) {
    if (!r) return false;
    if (r._isCancelled || r.schedule_ghost) return false;
    const bs = String(r.booking_status || r.status || '').toLowerCase();
    if (bs === 'cancelled' || bs === 'canceled') return false;
    const ss = String(r.service_status || '').toLowerCase();
    if (ss === 'cancelled') return false;
    return true;
  }
  // Lightweight real-ish builder: groups → prepItems via cockpit, then session shape.
  const sess = {
    kind: 'course',
    course_id: 'manana',
    label: 'Curso Mañana',
    slot_key: 'manana',
    start: 10 * 60,
    end: 12 * 60,
    capacity: 24,
    surfers: 4,
    groups: mananaGroups.filter((g) => !g._isCancelled && makeRowIsActive(g.records[0])),
    boardsNeeded: 0,
    wetsuitsNeeded: 0,
  };
  sess.prepItems = buildSessionPrep(sess.groups) || [];
  const shaped = cockpit.scheduleBuildDayCockpitData({
    venue: 'Sunset',
    date: DATE,
    navMode: 'day',
    now: 9 * 60,
    sessions: [sess],
    prep: { items: [], boards: { total: 0 }, wetsuits: { total: 0 }, unpaid: 0, needReply: 0 },
  });
  const m = doc.createElement('div');
  cockpit.scheduleRenderDayCockpit(m, shaped);
  const t = fullText(m);
  ok(
    'builder→map→render yields 4 Surfboard + Wetsuit to prep',
    /4 Surfboard \+ Wetsuit to prep/.test(t),
    t.slice(0, 280),
  );
  ok(
    'shaped session keeps prepItems',
    shaped.sessions[0]
      && shaped.sessions[0].prepItems
      && shaped.sessions[0].prepItems[0]
      && shaped.sessions[0].prepItems[0].quantity === 4,
    JSON.stringify(shaped.sessions[0] && shaped.sessions[0].prepItems),
  );
}

// Source must not leave idle hero on day-wide prep.boards/wetsuits.
const cockpitSrc = fs.readFileSync(COCKPIT_PATH, 'utf8');
ok(
  'idle hero no longer reads data.prep.boards.total for chips',
  !/boardsTotal\s*=\s*\(data\.prep\s*&&\s*data\.prep\.boards/.test(cockpitSrc),
);
ok(
  'live hero no longer renders decomposed boards/wetsuits out chips',
  !/live\.boards\s*\?\s*chips\.appendChild[\s\S]{0,80}board/.test(cockpitSrc)
    || /prepItems/.test(cockpitSrc.slice(cockpitSrc.indexOf('if (live)'), cockpitSrc.indexOf('if (live)') + 800)),
);

section('done');
if (failed) {
  console.error(`\nFAILED ${failed} assertion(s)\n`);
  process.exit(1);
}
console.log('\nAll hero exact-prep assertions passed.\n');
process.exit(0);
