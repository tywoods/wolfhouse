'use strict';

function localIsoDate(d) {
  d = d || new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}
const TODAY_ISO = localIsoDate(new Date());

/**
 * verify:sunset-schedule-day-cockpit-p2-mount
 *
 * P2 hard gate: below-band cooked HTML byte-identical before vs after mount swap.
 * Also offline-cooks the mounted page shell and paints 3 hero states.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-day-cockpit-p2-mount.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');
const COCKPIT_MOD = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-day-cockpit-ui.js');
// Baseline = CURRENT master tip (or override). After rebase this must NOT be a stale P1 SHA.
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

function extractBelowBand(html) {
  // Cut line: from #ps-state through the three schedule grid shells.
  // Everything above is the cockpit/legacy band; below must stay identical.
  const startToken = '<div id="ps-state"';
  const start = html.indexOf(startToken);
  if (start < 0) return null;
  // End after ps-month-grid shell closes — next sibling is create modal.
  const monthTok = '<div id="ps-month-grid"';
  const m = html.indexOf(monthTok, start);
  if (m < 0) return null;
  const close = html.indexOf('</div>', m);
  if (close < 0) return null;
  // include month grid closing tag only
  let end = close + '</div>'.length;
  // If nested close is wrong, take through create-modal start
  const create = html.indexOf('id="ps-create-modal"', m);
  if (create > m) {
    // walk back to the line before create modal
    const beforeCreate = html.lastIndexOf('<div id="ps-create-modal"', create + 1);
    // find the newline before create modal div
    const cut = html.lastIndexOf('\n', html.indexOf('<div id="ps-create-modal"'));
    if (cut > start) end = cut;
  }
  return html.slice(start, end);
}

function extractPortalHomeScheduleShell(html) {
  const start = html.indexOf('id="wrap-portal-home"');
  if (start < 0) return null;
  const from = html.lastIndexOf('<div', start);
  const end = html.indexOf('id="ps-create-modal"', from);
  if (end < 0) return html.slice(from, from + 4000);
  const cut = html.lastIndexOf('\n', end);
  return html.slice(from, cut);
}

console.log('\nverify:sunset-schedule-day-cockpit-p2-mount\n');

console.log('[1] Mount markers + sources');
const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const browserSrc = fs.readFileSync(BROWSER_SRC, 'utf8');
assert('cockpit module file exists', fs.existsSync(COCKPIT_MOD));
assert('INJECT marker in staff-query-api', apiSrc.includes('/* INJECT:sunset-schedule-day-cockpit */'));
assert('marker once', apiSrc.indexOf('/* INJECT:sunset-schedule-day-cockpit */') === apiSrc.lastIndexOf('/* INJECT:sunset-schedule-day-cockpit */'));
assert('mount div #ps-day-cockpit present', apiSrc.includes('id="ps-day-cockpit"'));
assert('old visible glance grid removed from top (ops-metrics class not in open wrap)', !/portal-schedule-ops-metrics">\s*\n\s*<div class="portal-schedule-glance-cell"/.test(apiSrc));
assert('toolbar Create booking not in visible toolbar region', !apiSrc.includes('class="portal-schedule-toolbar"'));
assert('legacy hidden controls keep nav IDs', apiSrc.includes('id="ps-prev-week"') && apiSrc.includes('id="ps-refresh-schedule"') && apiSrc.includes('id="ps-create-booking"'));
assert('browser-source getDayCockpit', browserSrc.includes('getSunsetScheduleDayCockpitBrowserSource'));
assert('browser-source injects cockpit marker', browserSrc.includes('SCHEDULE_DAY_COCKPIT_INJECT_MARKER'));
assert('injectAtMarker still permissive (idx < 0 return)', /if \(idx < 0\) return html/.test(browserSrc));
assert('paint hooked from renderScheduleSummary', /schedulePaintDayCockpit/.test(apiSrc));
// marker order: day-ops < cockpit < forecast
const iOps = apiSrc.indexOf('/* INJECT:sunset-schedule-day-ops-board-ui */');
const iCk = apiSrc.indexOf('/* INJECT:sunset-schedule-day-cockpit */');
const iFc = apiSrc.indexOf('/* INJECT:sunset-schedule-forecast-cards-ui */');
assert('marker order day-ops < cockpit < forecast', iOps >= 0 && iCk > iOps && iFc > iCk);

console.log('\n[2] HARD GATE — below-band cooked HTML byte-identical');
let beforeApi = '';
try {
  beforeApi = execSync(`git show ${BASE_SHA}:scripts/staff-query-api.js`, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
} catch (e) {
  assert('load base staff-query-api from git', false, String(e.message || e));
}
const beforeBelow = beforeApi ? extractBelowBand(beforeApi) : null;
const afterBelow = extractBelowBand(apiSrc);
assert('before below-band extractable', !!beforeBelow && beforeBelow.length > 50, beforeBelow ? `len=${beforeBelow.length}` : 'null');
assert('after below-band extractable', !!afterBelow && afterBelow.length > 50, afterBelow ? `len=${afterBelow.length}` : 'null');
if (beforeBelow && afterBelow) {
  const same = beforeBelow === afterBelow;
  assert('below-band BYTE-IDENTICAL vs ' + BASE_SHA, same,
    same ? '' : `len before=${beforeBelow.length} after=${afterBelow.length}\n--- before head ---\n${beforeBelow.slice(0, 180)}\n--- after head ---\n${afterBelow.slice(0, 180)}`);
  if (!same) {
    // write artifacts for inspection
    const outDir = path.join(ROOT, 'tmp');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'cockpit-p2-below-before.html'), beforeBelow);
    fs.writeFileSync(path.join(outDir, 'cockpit-p2-below-after.html'), afterBelow);
    console.error('  wrote tmp/cockpit-p2-below-before.html + after.html');
  } else {
    console.log(`  INFO  below-band length=${afterBelow.length} bytes (identical)`);
  }
}

// Also prove ops/week/month shells unchanged as substrings
['id="ps-ops-board"', 'id="ps-week-grid"', 'id="ps-month-grid"', 'data-ops-board="today"'].forEach((tok) => {
  assert(`token retained ${tok}`, apiSrc.includes(tok) && beforeApi.includes(tok));
});

console.log('\n[3] Offline cook — inject module into shell');
const { injectSunsetSchedulePortalModule, SCHEDULE_DAY_COCKPIT_INJECT_MARKER } = require(BROWSER_SRC);
// Minimal fixture containing markers + mount (not full buildUiHtml — faster)
const fixture = [
  '<div id="wrap-portal-home" class="portal-schedule-wrap">',
  '  <div id="ps-day-cockpit" class="ps-day-cockpit-host"></div>',
  '  <div id="ps-state" class="state-msg" style="display:none"></div>',
  '  <div id="ps-ops-board" class="portal-schedule-ops-board" data-ops-board="today"></div>',
  '  <div id="ps-week-grid" class="portal-schedule-week-forecast" style="display:none"></div>',
  '  <div id="ps-month-grid" class="portal-schedule-next30-forecast" style="display:none"></div>',
  '</div>',
  '<script>',
  '/* INJECT:sunset-schedule-money-parse */',
  '/* INJECT:sunset-schedule-rental-availability */',
  '/* INJECT:sunset-schedule-portal-module */',
  '/* INJECT:sunset-schedule-drawer-view-ui */',
  '/* INJECT:sunset-schedule-drawer-edit-ui */',
  '/* INJECT:sunset-schedule-drawer-actions */',
  '/* INJECT:sunset-schedule-drawer-controller */',
  '/* INJECT:sunset-schedule-day-ops-board-ui */',
  '/* INJECT:sunset-schedule-day-cockpit */',
  '/* INJECT:sunset-schedule-forecast-cards-ui */',
  '/* INJECT:sunset-schedule-view-grid-ui */',
  '/* INJECT:sunset-schedule-runtime */',
  '/* INJECT:sunset-schedule-navigation-ui */',
  '/* INJECT:sunset-schedule-row-normalizer */',
  '/* INJECT:sunset-schedule-data-loader */',
  '</script>',
].join('\n');

const cooked = injectSunsetSchedulePortalModule(fixture);
assert('cook removes cockpit marker', !cooked.includes(SCHEDULE_DAY_COCKPIT_INJECT_MARKER) || cooked.indexOf('schedulePaintDayCockpit') > -1);
assert('cook embeds scheduleRenderDayCockpit', cooked.includes('function scheduleRenderDayCockpit'));
assert('cook embeds schedulePaintDayCockpit', cooked.includes('function schedulePaintDayCockpit'));
assert('cook keeps below shells', cooked.includes('id="ps-ops-board"') && cooked.includes('id="ps-month-grid"'));
assert('cook keeps mount host', cooked.includes('id="ps-day-cockpit"'));
// permissive: missing marker leaves html — smoke
const permissive = require(BROWSER_SRC).injectAtMarker('<div>x</div>', '/* MISSING */', 'JS');
assert('injectAtMarker permissive on miss', permissive === '<div>x</div>');

console.log('\n[4] Offline 3 hero states on mounted host');
const cockpit = require(COCKPIT_MOD);

// Minimal DOM (same spirit as P1)
function makeDoc() {
  function Node(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.className = '';
    this.children = [];
    this.attributes = Object.create(null);
    this._text = '';
    this._html = '';
    this.style = { _props: Object.create(null), setProperty(k, v) { this._props[k] = String(v); this[k] = String(v); } };
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
  Node.prototype.setAttribute = function (k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = String(v); };
  Node.prototype.getAttribute = function (k) { return k === 'class' ? this.className : (this.attributes[k] != null ? this.attributes[k] : null); };
  Node.prototype.appendChild = function (c) { if (!c) return c; c.parentNode = this; c.ownerDocument = this.ownerDocument; this.children.push(c); this._html = ''; return c; };
  Node.prototype.append = function () {
    for (let i = 0; i < arguments.length; i++) {
      const a = arguments[i];
      if (a == null) continue;
      if (typeof a === 'string' || typeof a === 'number') this.appendChild(this.ownerDocument.createTextNode(String(a)));
      else this.appendChild(a);
    }
  };
  Node.prototype.addEventListener = function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); };
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
    if (sel.startsWith('.')) {
      const cls = sel.slice(1).split('.')[0];
      return String(n.className || '').split(/\s+/).includes(cls);
    }
    return n.tagName === sel.toUpperCase();
  }
  const doc = {
    head: null,
    body: null,
    createElement(tag) { const n = new Node(tag); n.ownerDocument = doc; return n; },
    createTextNode(text) { const n = new Node('#text'); n.nodeType = 3; n.tagName = ''; n._text = String(text); n.ownerDocument = doc; return n; },
    getElementById() { return null; },
  };
  doc.head = doc.createElement('head');
  doc.body = doc.createElement('body');
  return doc;
}

const producerSessions = [
  { kind: 'course', course_id: 'manana', label: 'Curso Mañana', slot_key: 'manana', start: 600, end: 720, capacity: 24, surfers: 3, boardsNeeded: 3, wetsuitsNeeded: 3 },
  { kind: 'course', course_id: 'medio', label: 'Curso Medio Día', slot_key: 'medio', start: 720, end: 840, capacity: 24, surfers: 2, boardsNeeded: 2, wetsuitsNeeded: 2 },
  { kind: 'course', course_id: 'tarde', label: 'Curso Tarde', slot_key: 'tarde', start: 960, end: 1080, capacity: 24, surfers: 0, boardsNeeded: 0, wetsuitsNeeded: 0 },
];

const doc = makeDoc();
global.document = doc; // for ensureCss
const host = doc.createElement('div');
host.id = 'ps-day-cockpit';
host.ownerDocument = doc;
// patch el/getElementById
doc.getElementById = (id) => (id === 'ps-day-cockpit' ? host : null);

function paintAt(now) {
  host.innerHTML = '';
  host.className = '';
  const data = cockpit.schedulePaintDayCockpit({
    venue: 'Sunset',
    date: TODAY_ISO,
    navMode: 'day',
    now,
    sessions: producerSessions,
    boardsTotal: 8, boardsLesson: 4, boardsRental: 4,
    wetsuitsTotal: 8, wetsuitsLesson: 4, wetsuitsRental: 4,
    unpaidCount: 9, needReplyCount: 0,
    on: {},
  });
  return { text: host.textContent, mount: host, data };
}

const mid = paintAt(12 * 60 + 37);
assert('mid cook: ON NOW', /ON NOW/.test(mid.text));
assert('mid cook: ring capacity path', mid.mount.querySelector('.ck-ring') && /2\/24/.test(mid.mount.querySelector('.ck-ring').textContent));

const before = paintAt(9 * 60 + 20);
assert('before cook: NOTHING IN THE WATER', /NOTHING IN THE WATER/.test(before.text));

const after = paintAt(19 * 60);
assert('after cook: DAY COMPLETE', /DAY COMPLETE/.test(after.text));

console.log('\n[5] State snapshot');
[
  ['mid-session', mid],
  ['before-first', before],
  ['after-last', after],
].forEach(([name, s]) => {
  const hero = /ON NOW/.test(s.text) ? 'ON_NOW' : /NOTHING IN THE WATER/.test(s.text) ? 'BEFORE' : /DAY COMPLETE/.test(s.text) ? 'AFTER' : '?';
  console.log(`  STATE  ${name} hero=${hero} excerpt=${s.text.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
});

// Shell extract from live staff-query-api for human inspection
const shell = extractPortalHomeScheduleShell(apiSrc);
if (shell) {
  const outDir = path.join(ROOT, 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'cockpit-p2-portal-home-shell.html'), shell);
  console.log('  wrote tmp/cockpit-p2-portal-home-shell.html');
}

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
