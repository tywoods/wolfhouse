#!/usr/bin/env node
'use strict';

/**
 * verify-inbox-guest-tab-pin
 *
 * Full Guest tab (#inbox-guest-restore) click must pin 4-col Full and skip
 * the overlay. Sea Dog r2: source greps are not enough — dispatch the real
 * restore-button click.
 *
 * Asserts:
 *   - setColumn('col4', 'peek') then clearPeek()
 *   - inbox-guest-drawer is removed (no overlay)
 *   - guest-panel preference becomes/persists pinned
 *   - restore path preventDefault + stopPropagation
 *   - missing-columns API is a no-throw early return
 *   - hide-button hidden/full paths still work
 *
 * Stay OFF inbox-thread.js, package.json.
 *
 * Run:
 *   node scripts/verify-inbox-guest-tab-pin.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const {
  SHELL_MODULE,
  THREAD_MODULE,
} = require('./lib/inbox-browser-source');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');

const shellSrc = fs.readFileSync(SHELL_MODULE, 'utf8');
const threadSrc = fs.readFileSync(THREAD_MODULE, 'utf8');
const apiSrc = fs.readFileSync(API_PATH, 'utf8');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

function makeHarness(opts) {
  opts = opts || {};
  const columnCalls = [];
  const peekClears = [];
  const prefs = [];
  const classes = new Set(opts.drawerOpen ? ['inbox-guest-drawer'] : []);
  const listeners = {};

  const restoreBtn = {
    id: 'inbox-guest-restore',
    closest(sel) {
      return sel === '#inbox-guest-restore' ? restoreBtn : null;
    },
  };
  const hideBtn = {
    id: 'inbox-customer-hide',
    title: '',
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    closest(sel) {
      return sel === '#inbox-customer-hide' ? hideBtn : null;
    },
  };
  const shell = {
    id: 'inbox-shell',
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
  };
  const docEl = {
    attrs: {},
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
  };
  const document = {
    documentElement: docEl,
    readyState: 'loading',
    getElementById(id) {
      if (id === 'inbox-shell') return shell;
      if (id === 'inbox-guest-restore') return restoreBtn;
      if (id === 'inbox-customer-hide') return hideBtn;
      return null;
    },
    querySelector(sel) {
      if (sel === '[data-inbox-preset="all4"][aria-pressed="true"]') return { pressed: true };
      if (sel === '#inbox-guest-restore') return restoreBtn;
      return null;
    },
    addEventListener(type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
  };

  const columns = opts.missingColumns ? null : {
    setColumn(col, val) { columnCalls.push([col, val]); },
    clearPeek() { peekClears.push('clearPeek'); },
  };

  const sandbox = {
    window: {},
    document,
    console,
    fetch(url, init) {
      prefs.push({ url: url, method: init && init.method, body: init && init.body });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
    Event: function Event() {},
  };
  sandbox.window = sandbox;
  if (columns) sandbox.window.__inboxColumns = columns;
  sandbox.window.__staffInboxGuestPanel = opts.pref || 'hidden';

  vm.createContext(sandbox);
  vm.runInContext(
    `${shellSrc}\n` +
    'this.wireInboxShellGuestHide = wireInboxShellGuestHide;\n' +
    'this.inboxShellGuestDrawerIsOpen = inboxShellGuestDrawerIsOpen;\n' +
    'this.inboxShellGuestPanelPref = inboxShellGuestPanelPref;\n',
    sandbox,
  );
  sandbox.wireInboxShellGuestHide();

  function fire(target) {
    const ev = {
      target,
      prevented: false,
      stopped: false,
      preventDefault() { ev.prevented = true; },
      stopPropagation() { ev.stopped = true; },
    };
    (listeners.click || []).forEach((fn) => fn(ev));
    return ev;
  }

  return {
    sandbox,
    restoreBtn,
    hideBtn,
    classes,
    columnCalls,
    peekClears,
    prefs,
    fire,
  };
}

console.log('\nverify-inbox-guest-tab-pin — Full Guest tab pins 4-col, skips overlay\n');

console.log('-- source --');
const restoreFn = sliceFn(shellSrc, 'wireInboxShellGuestHide');
ok('restore click pins col4 peek (not peek() hover, not drawer-open)',
  restoreFn.includes("target.closest('#inbox-guest-restore')")
  && restoreFn.includes("api.setColumn('col4', 'peek')")
  && restoreFn.includes('api.clearPeek()')
  && restoreFn.includes("inboxShellRememberGuestPanel('pinned')")
  && restoreFn.includes('inboxShellGuestDrawerClose()')
  && !/inboxShellGuestDrawerOpen\(\)/.test(restoreFn.split("closest('#inbox-guest-restore')")[1].split("closest('#inbox-customer-hide')")[0]));
ok('stay off inbox-thread.js',
  !threadSrc.includes('inbox-guest-restore')
  && !threadSrc.includes('inboxShellGuestDrawerOpen')
  && !threadSrc.includes('INBOX-GUEST-TAB-PIN'));
ok('data-portal-client attribute is Sunset-only in the HTML builder',
  /portalDefaultClient === 'sunset' \? ' data-portal-client="sunset"' : ''/.test(apiSrc)
  && apiSrc.includes('<html lang="en"${portalClientAttr}>')
  && !/data-portal-client="\$\{portalDefaultClient\}"/.test(apiSrc));
ok('Full Guest tab greener color is Sunset-only (html[data-portal-client=sunset])',
  /html\[data-portal-client="sunset"\][\s\S]{0,280}background:var\(--teal\)/.test(apiSrc)
  && shellSrc.includes('html[data-portal-client="sunset"]')
  && shellSrc.includes('background:var(--teal);color:var(--primary)'));
ok('Wolfhouse unscoped restore tab stays cream (--surface, weight 600)',
  /inbox-guest-restore\{[\s\S]{0,420}background:var\(--surface\);color:var\(--text\)/.test(apiSrc)
  && /inbox-guest-restore\{[\s\S]{0,480}font-weight:600/.test(apiSrc)
  && /inbox-guest-restore:hover\{\s*background:var\(--surface-soft\)/.test(apiSrc));

console.log('\n-- restore click execution --');
{
  const h = makeHarness({ drawerOpen: true, pref: 'hidden' });
  const ev = h.fire(h.restoreBtn);
  ok('dispatches the real #inbox-guest-restore click',
    ev.prevented === true && ev.stopped === true);
  ok('setColumn(col4, peek) then clearPeek',
    h.columnCalls.length === 1
    && h.columnCalls[0][0] === 'col4'
    && h.columnCalls[0][1] === 'peek'
    && h.peekClears.join(',') === 'clearPeek');
  ok('inbox-guest-drawer is removed (no overlay)',
    h.classes.has('inbox-guest-drawer') === false
    && h.sandbox.inboxShellGuestDrawerIsOpen() === false);
  ok('guest-panel preference becomes pinned and PATCHes prefs',
    h.sandbox.window.__staffInboxGuestPanel === 'pinned'
    && h.sandbox.inboxShellGuestPanelPref() === 'pinned'
    && h.prefs.some((p) => p.url === '/staff/auth/prefs'
      && p.method === 'PATCH'
      && String(p.body).indexOf('"inbox_guest_panel":"pinned"') >= 0));
}

console.log('\n-- persist pinned --');
{
  const h = makeHarness({ drawerOpen: false, pref: 'pinned' });
  h.fire(h.restoreBtn);
  ok('already-pinned restore click stays pinned',
    h.sandbox.window.__staffInboxGuestPanel === 'pinned'
    && h.columnCalls[0] && h.columnCalls[0][1] === 'peek'
    && h.classes.has('inbox-guest-drawer') === false);
}

console.log('\n-- missing columns / hide paths --');
{
  const h = makeHarness({ missingColumns: true, drawerOpen: true, pref: 'hidden' });
  let threw = false;
  let ev;
  try { ev = h.fire(h.restoreBtn); } catch (e) { threw = true; }
  ok('missing-columns restore click is safe (prevented, no throw, pref unchanged)',
    threw === false
    && ev.prevented === true
    && ev.stopped === true
    && h.columnCalls.length === 0
    && h.sandbox.window.__staffInboxGuestPanel === 'hidden');
}
{
  const h = makeHarness({ drawerOpen: false, pref: 'pinned' });
  const ev = h.fire(h.hideBtn);
  ok('hide button still hides (legacy hidden path)',
    ev.prevented === true
    && h.columnCalls.length === 1
    && h.columnCalls[0][0] === 'col4'
    && h.columnCalls[0][1] === 'hidden'
    && h.peekClears.join(',') === 'clearPeek'
    && h.sandbox.window.__staffInboxGuestPanel === 'hidden'
    && h.classes.has('inbox-guest-drawer') === false);
}
{
  const h = makeHarness({ drawerOpen: true, pref: 'hidden' });
  h.fire(h.hideBtn);
  ok('hide button while overlay is open still pins (legacy full path)',
    h.columnCalls[0] && h.columnCalls[0][1] === 'peek'
    && h.peekClears.join(',') === 'clearPeek'
    && h.sandbox.window.__staffInboxGuestPanel === 'pinned'
    && h.classes.has('inbox-guest-drawer') === false);
}

console.log('\n-- rendered tenant roots --');
{
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
  process.env.STAFF_AUTH_REQUIRED = 'false';
  process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
  let api;
  let loadErr = null;
  try {
    api = require('./staff-query-api');
  } catch (e) {
    loadErr = e;
  }
  ok('staff-query-api UI builder loads',
    !loadErr && api && typeof api.buildUiHtmlForOfflineTest === 'function',
    loadErr ? String(loadErr && loadErr.message) : '');
  if (!loadErr && api && typeof api.buildUiHtmlForOfflineTest === 'function') {
    const sunsetHtml = api.buildUiHtmlForOfflineTest(0, 'sunset');
    const wolfHtml = api.buildUiHtmlForOfflineTest(0, 'wolfhouse-somo');
    const sunsetRoot = (sunsetHtml.match(/<html\b[^>]*>/) || [''])[0];
    const wolfRoot = (wolfHtml.match(/<html\b[^>]*>/) || [''])[0];
    ok('Sunset root has data-portal-client=sunset and teal rule',
      sunsetRoot === '<html lang="en" data-portal-client="sunset">'
      && /html\[data-portal-client="sunset"\][\s\S]{0,280}background:var\(--teal\)/.test(sunsetHtml));
    ok('Wolfhouse root has no data-portal-client attribute and keeps cream',
      wolfRoot === '<html lang="en">'
      && !/\bdata-portal-client=/.test(wolfRoot)
      && /inbox-guest-restore\{[\s\S]{0,420}background:var\(--surface\);color:var\(--text\)/.test(wolfHtml));
  }
}

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify-inbox-guest-tab-pin — FAILED');
  process.exit(1);
}
console.log('verify-inbox-guest-tab-pin — ALL CHECKS PASSED');
process.exit(0);
