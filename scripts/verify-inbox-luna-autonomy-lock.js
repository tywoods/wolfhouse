#!/usr/bin/env node
'use strict';

/**
 * verify-inbox-luna-autonomy-lock
 *
 * Inbox Channel Autonomy → Luna Autonomy:
 *   - Title LUNA AUTONOMY + grey Lucide lock (top right)
 *   - Lock click toggles locked/unlocked (icon + is-locked)
 *   - Locked: Draft/Auto and Luna Off/On do not change
 *   - Luna row on top; On = Luna on (pause off); Off = Luna off (pause on)
 *   - Template still greps Global Pause in staff-query-api.js
 *
 * Stay OFF inbox-thread.js.
 * Run: node scripts/verify-inbox-luna-autonomy-lock.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { SHELL_MODULE, THREAD_MODULE } = require('./lib/inbox-browser-source');

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

console.log('\nverify-inbox-luna-autonomy-lock — Luna Autonomy lock + On/Off flip\n');

ok('title fallback is LUNA AUTONOMY',
  /inboxShellT\('inbox\.channelControl\.title', 'LUNA AUTONOMY'\)/.test(shellSrc));
ok('lock button is painted top-right',
  /channelAutonomyHead/.test(shellSrc)
    && /id="inbox-autonomy-lock"/.test(shellSrc)
    && /channelAutonomyLock/.test(shellSrc)
    && /inboxShellLockClosedSvg/.test(shellSrc)
    && /inboxShellLockOpenSvg/.test(shellSrc)
    && /M7 11V7a5 5 0 0 1 10 0v4/.test(shellSrc)
    && /M7 11V7a5 5 0 0 1 9\.9-1/.test(shellSrc));
ok('Luna row is inserted before WhatsApp',
  /querySelector\('\[data-inbox-autonomy-row="whatsapp"\]'\)/.test(shellSrc)
    && /insertBefore\(pause, wa\)/.test(shellSrc)
    && /inboxShellT\('inbox\.channelControl\.luna', 'Luna'\)/.test(shellSrc));
ok('On means Luna on (pause off); Off means paused',
  /var wantLunaOn = btn\.getAttribute\('data-inbox-pause'\) === 'on'/.test(shellSrc)
    && /var wantPaused = !wantLunaOn/.test(shellSrc)
    && /var selected = isOnBtn \? !on : on/.test(shellSrc)
    && /isAuto', isOnBtn && !on/.test(shellSrc));
ok('locked card ignores autonomy and pause clicks',
  /if \(inboxShellAutonomyIsLocked\(\)\) return/.test(sliceFn(shellSrc, 'wireInboxShellChannelDefaults'))
    && /if \(inboxShellAutonomyIsLocked\(\)\) return/.test(sliceFn(shellSrc, 'inboxShellAdoptGlobalPause')));
ok('lock click is wired on the card (not grepped-only)',
  /closest\('#inbox-autonomy-lock'\)/.test(sliceFn(shellSrc, 'wireInboxShellChannelDefaults'))
    && /inboxShellStoreAutonomyLock\(!inboxShellAutonomyIsLocked\(\)\)/.test(shellSrc)
    && /inboxShellSyncAutonomyLock\(/.test(shellSrc));
ok('grey lock CSS exists',
  /color:#8a9690/.test(shellSrc)
    && /\.channelAutonomy\.is-locked \.channelModeSegmented\{pointer-events:none/.test(shellSrc));
ok('staff-query-api still has Global Pause template (gates)',
  apiSrc.includes('Global Pause') && !apiSrc.includes('Global Pause Luna:'));
ok('shell does not invent luna-global-pause-switch or clip:rect',
  !/luna-global-pause-switch/.test(shellSrc) && !/clip:rect/.test(shellSrc));
ok('inbox-thread.js untouched',
  !/inbox-autonomy-lock/.test(threadSrc)
    && !/LUNA AUTONOMY/.test(threadSrc)
    && !/inboxShellAutonomyIsLocked/.test(threadSrc));

function makeClassList(initial) {
  const set = new Set(initial || []);
  return {
    add(c) { set.add(c); },
    remove(c) { set.delete(c); },
    contains(c) { return set.has(c); },
    toggle(c, force) {
      if (typeof force === 'boolean') {
        if (force) set.add(c); else set.delete(c);
        return force;
      }
      if (set.has(c)) { set.delete(c); return false; }
      set.add(c); return true;
    },
    _has: (c) => set.has(c),
  };
}

function makeHarness() {
  const store = {};
  const attrs = {};
  const lockBtn = {
    id: 'inbox-autonomy-lock',
    title: '',
    innerHTML: '',
    closest(sel) { return sel === '#inbox-autonomy-lock' ? lockBtn : null; },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
  };
  const card = {
    id: 'inbox-shell-channel-defaults',
    classList: makeClassList([]),
    dataset: {},
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(fn);
    },
    querySelector() { return null; },
  };
  const pause = {
    querySelector() { return null; },
    querySelectorAll() { return []; },
    classList: makeClassList([]),
  };
  const byId = {
    'inbox-shell-channel-defaults': card,
    'inbox-autonomy-lock': lockBtn,
    'cc-luna-global-pause': pause,
  };
  const sandbox = {
    t: (key) => key,
    el: (id) => byId[id] || null,
    escHtml: (s) => String(s),
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    document: {
      readyState: 'loading',
      documentElement: { appendChild() {}, getAttribute() { return null; }, setAttribute() {} },
      head: { appendChild() {} },
      getElementById: (id) => byId[id] || null,
      createElement() { return { className: '', setAttribute() {}, innerHTML: '', addEventListener() {} }; },
      addEventListener() {},
    },
    window: {},
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${shellSrc}\n` +
    'this.inboxShellChannelDefaultsHtml = inboxShellChannelDefaultsHtml;\n' +
    'this.wireInboxShellChannelDefaults = wireInboxShellChannelDefaults;\n' +
    'this.inboxShellAutonomyIsLocked = inboxShellAutonomyIsLocked;\n' +
    'this.inboxShellSyncAutonomyLock = inboxShellSyncAutonomyLock;\n' +
    'this.inboxShellStoreAutonomyLock = inboxShellStoreAutonomyLock;\n',
    sandbox,
  );
  return { sandbox, card, lockBtn, attrs, store };
}

console.log('\n[click] lock toggle + freeze switches');
{
  const { sandbox, card, lockBtn, attrs } = makeHarness();
  const html = sandbox.inboxShellChannelDefaultsHtml({ whatsapp: 'draft', email: 'draft' });
  ok('html title is LUNA AUTONOMY', /LUNA AUTONOMY/.test(html));
  ok('html has lock button', /id="inbox-autonomy-lock"/.test(html));
  sandbox.wireInboxShellChannelDefaults();
  const clickFns = card.listeners.click || [];
  ok('card click listener attached', clickFns.length >= 1);
  ok('starts unlocked', sandbox.inboxShellAutonomyIsLocked() === false && !card.classList.contains('is-locked'));

  clickFns[0]({
    target: lockBtn,
    preventDefault() {},
    closest: (sel) => lockBtn.closest(sel),
  });
  ok('lock click adds is-locked', card.classList.contains('is-locked') === true);
  ok('lock click sets aria-pressed true', attrs['aria-pressed'] === 'true');
  ok('locked icon is the closed padlock', /M7 11V7a5 5 0 0 1 10 0v4/.test(lockBtn.innerHTML));

  let autoClicks = 0;
  clickFns[0]({
    target: {
      closest(sel) {
        if (sel === '#inbox-autonomy-lock') return null;
        if (sel === '[data-inbox-autonomy]') {
          autoClicks += 1;
          return {
            disabled: false,
            getAttribute(k) {
              if (k === 'data-inbox-autonomy-channel') return 'whatsapp';
              if (k === 'data-inbox-autonomy') return 'auto';
              return null;
            },
          };
        }
        return null;
      },
    },
    preventDefault() {},
  });
  ok('locked Auto click is ignored', autoClicks === 0);

  clickFns[0]({
    target: lockBtn,
    preventDefault() {},
    closest: (sel) => lockBtn.closest(sel),
  });
  ok('second lock click unlocks', card.classList.contains('is-locked') === false);
  ok('unlocked icon is the open padlock', /M7 11V7a5 5 0 0 1 9\.9-1/.test(lockBtn.innerHTML));
}

if (fail) {
  console.error(`\nverify-inbox-luna-autonomy-lock: ${pass} passed, ${fail} failed\n`);
  process.exit(1);
}
console.log(`\nverify-inbox-luna-autonomy-lock: ${pass} passed, ${fail} failed\n`);
