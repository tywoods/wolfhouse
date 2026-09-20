#!/usr/bin/env node
'use strict';

/**
 * SUNSET-INBOX-GUESTS-SWITCH-CLEANER-002
 *
 * Live #1098 still stepped Chats ↔ Guests (tab, then list, then filter, then
 * card). Hide must actually cover the wrap (opacity, not only visibility —
 * peek CSS uses visibility:visible and punches through), and unhide only
 * after list + rail + card, or the 500ms stall net.
 *
 * KEEP from #1098: 14px Guests list→card gap, shared 1520 wrap, 500ms fallback.
 * Sunset only. Stay off Crow's Nest, Wolfhouse unprefixed tracks,
 * inbox-thread.js, inbox-columns.js WIDTHS, package.json.
 *
 * Run: node scripts/verify-sunset-inbox-guests-switch-cleaner-002.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const {
  ROWS_MODULE,
  THREAD_MODULE,
  COLUMNS_MODULE,
} = require('./lib/inbox-browser-source');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const CROWSNEST_PAGE = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-page.js');
const PKG_PATH = path.join(ROOT, 'package.json');

const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const rowsSrc = fs.readFileSync(ROWS_MODULE, 'utf8');
const threadSrc = fs.readFileSync(THREAD_MODULE, 'utf8');
const columnsSrc = fs.readFileSync(COLUMNS_MODULE, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

/* GMAIL-HOLD-001 supersedes this gate's hide-first contract. Keep the old
 * command useful by delegating to the replacement contract once present. */
if (rowsSrc.includes('SUNSET-INBOX-CHATS-GUESTS-GMAIL-HOLD-001')
    || apiSrc.includes('SUNSET-INBOX-CHATS-GUESTS-GMAIL-HOLD-001')) {
  execSync('node scripts/verify-sunset-inbox-chats-guests-gmail-hold-001.js', {
    cwd: ROOT,
    stdio: 'inherit',
  });
  console.log('\nOK superseded by SUNSET-INBOX-CHATS-GUESTS-GMAIL-HOLD-001');
  process.exit(0);
}

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

function sliceRule(src, selector) {
  const needle = selector + '{';
  const i = src.indexOf(needle);
  if (i < 0) return '';
  const start = i + needle.length;
  const end = src.indexOf('}', start);
  return end < 0 ? '' : src.slice(start, end);
}

function gitDiff(rel) {
  try {
    return execSync(`git diff HEAD -- ${rel}`, { cwd: ROOT, encoding: 'utf8' });
  } catch (_e) {
    return 'git-error';
  }
}

function classListFor(el) {
  const set = el._classes;
  return {
    add(c) { set.add(c); },
    remove(c) { set.delete(c); },
    contains(c) { return set.has(c); },
  };
}

function makeEl(id, className) {
  const el = {
    id,
    className: className || '',
    _classes: new Set(String(className || '').split(/\s+/).filter(Boolean)),
    attrs: {},
    children: [],
    innerHTML: '',
    offsetWidth: 240,
    getAttribute(k) { return this.attrs[k]; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    querySelector(sel) {
      if (String(sel).indexOf('conv-card') >= 0 && this.innerHTML.indexOf('conv-card') >= 0) {
        return { className: 'conv-card' };
      }
      if (String(sel).indexOf('inbox-customer-card') >= 0 && this.innerHTML.indexOf('inbox-customer-card') >= 0) {
        return { className: 'inbox-customer-card is-full' };
      }
      return null;
    },
  };
  el.classList = classListFor(el);
  return el;
}

function loadHarness(opts) {
  opts = opts || {};
  const rAF = [];
  const timeouts = [];
  const shell = makeEl('inbox-shell', 'inbox-two-col inbox-shell-cols');
  const wrap = makeEl('wrap', 'inbox-shell-wrap');
  const list = makeEl('conv-list', 'conv-list');
  list.innerHTML = opts.emptyList ? '' : '<div class="conv-card inbox-row">Ada</div>';
  const guestBtn = makeEl('folder-guest', 'inbox-folder-tab');
  guestBtn.setAttribute('data-inbox-preset', 'guest');
  guestBtn.setAttribute('aria-pressed', opts.startGuest ? 'true' : 'false');
  const chatsBtn = makeEl('folder-chats', 'inbox-folder-tab');
  chatsBtn.setAttribute('data-inbox-preset', 'all4');
  chatsBtn.setAttribute('aria-pressed', opts.startGuest ? 'false' : 'true');
  const events = [];

  const document = {
    documentElement: { getAttribute(k) { return k === 'data-portal-client' ? 'sunset' : null; } },
    head: { appendChild() {} },
    createElement() { return { id: '', textContent: '' }; },
    getElementsByTagName() { return [this.head]; },
    getElementById(id) {
      if (id === 'inbox-shell') return shell;
      if (id === 'wrap') return wrap;
      if (id === 'conv-list') return list;
      return null;
    },
    querySelector(sel) {
      if (sel === '[data-inbox-preset="guest"][aria-pressed="true"]') {
        return guestBtn.getAttribute('aria-pressed') === 'true' ? guestBtn : null;
      }
      if (String(sel).indexOf('inbox-customer-card.is-full') >= 0) {
        return opts.fullCard ? { className: 'inbox-customer-card is-full' } : null;
      }
      return null;
    },
  };

  let preset = opts.startGuest ? 'guest' : 'all4';
  function applyPreset(name) {
    preset = name;
    guestBtn.setAttribute('aria-pressed', name === 'guest' ? 'true' : 'false');
    chatsBtn.setAttribute('aria-pressed', name === 'all4' ? 'true' : 'false');
    shell.attrs['data-col4'] = name === 'guest' ? 'wide' : 'hidden';
    events.push({
      type: 'preset',
      name,
      hidden: shell.classList.contains('inbox-folder-switching')
        && wrap.classList.contains('inbox-folder-switching'),
    });
  }

  const sandbox = {
    window: {},
    document,
    console,
    Object,
    Array,
    String,
    Set,
    requestAnimationFrame(cb) { rAF.push(cb); return rAF.length; },
    setTimeout(cb, ms) {
      timeouts.push({ cb, ms });
      return timeouts.length;
    },
    clearTimeout() {},
    inboxColumnsSetPreset: applyPreset,
    inboxColumnsRuntime: { record: { preset } },
    inboxContextIsGuestMode() {
      return guestBtn.getAttribute('aria-pressed') === 'true';
    },
    inboxCustomerPaint() { events.push({ type: 'card-paint' }); },
    inboxViewsSwitchSurface() { events.push({ type: 'surface' }); },
    renderInbox() {},
    renderInboxViewsRail() {},
    events,
    shell,
    wrap,
    list,
    rAF,
    timeouts,
    flushRAF() {
      const q = rAF.splice(0);
      q.forEach((cb) => cb());
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${rowsSrc}\nthis.__inboxRows = window.__inboxRows;`, sandbox);
  return sandbox;
}

const SUNSET = 'html[data-portal-client="sunset"]';

console.log('\n── keep #1098 layout ──');
ok('Guests list→card gap stays 14px (Sunset 3-col, card col 3)',
  /grid-column:3/.test(sliceRule(apiSrc, `${SUNSET} body:has([data-inbox-preset="guest"][aria-pressed="true"]) .inbox-two-col.inbox-shell-cols .detail-sidebar`))
  && /--inbox-col-gap:14px/.test(apiSrc));
ok('Sunset wrap stays 1520px for Chats and Guests',
  sliceRule(apiSrc, `${SUNSET} #tab-conversations.active #wrap.inbox-shell-wrap`).includes('max-width:1520px!important')
  && sliceRule(apiSrc, `${SUNSET} body:has(#tab-conversations.active):has([data-inbox-preset="guest"][aria-pressed="true"]) #wrap.inbox-shell-wrap`).includes('max-width:1520px!important'));
ok('Wolfhouse unprefixed wrap/tracks untouched',
  /#tab-conversations\.active #wrap\.inbox-shell-wrap\{[\s\S]{0,80}max-width:1800px!important/.test(apiSrc)
  && sliceRule(apiSrc, '.inbox-two-col.inbox-shell-cols[data-col1="full"]') === '--inbox-col1-w:240px'
  && sliceRule(apiSrc, '.inbox-two-col.inbox-shell-cols[data-col2="comfortable"]') === '--inbox-col2-w:252px');

console.log('\n── hide actually covers the switch ──');
const shellHide = sliceRule(apiSrc, `${SUNSET} #inbox-shell.inbox-folder-switching`);
const wrapHide = sliceRule(apiSrc, `${SUNSET} #wrap.inbox-shell-wrap.inbox-folder-switching`);
ok('shell hide keeps visibility:hidden (001 gate) and adds opacity:0',
  /visibility:hidden/.test(shellHide) && /opacity:0!important/.test(shellHide)
  && /pointer-events:none!important/.test(shellHide),
  shellHide);
ok('wrap also opacity-hides so peek visibility:visible cannot punch through',
  /opacity:0!important/.test(wrapHide) && /pointer-events:none!important/.test(wrapHide),
  wrapHide);
ok('rows stamps the class on wrap + shell and force-reflows before setPreset',
  rowsSrc.includes('function inboxRowsFolderSwitchSetHidden(')
  && rowsSrc.includes("classList.contains('inbox-shell-wrap')")
  && rowsSrc.includes('offsetWidth')
  && /if \(crossing\) inboxRowsBeginFolderSwitch\(\);\s*var result = _inboxRowsLegacySetPreset\(name\)/.test(rowsSrc));

console.log('\n── wait for list + rail + card; 500ms is only the net ──');
ok('card is a third release part (Guest paint / empty list)',
  rowsSrc.includes("inboxRowsNoteFolderSwitchPart('card')")
  && rowsSrc.includes('folderSwitchCard')
  && rowsSrc.includes('function inboxRowsWrapFolderSwitchCard(')
  && rowsSrc.includes('inboxCustomerPaint._inboxRowsFolderSwitchWrapped'));
ok('failed/slow fetch still unhides at 500ms',
  /setTimeout\(function\(\) \{\s*inboxRowsEndFolderSwitch\(gen\);\s*\}, 500\)/.test(rowsSrc));
ok('rows owns the switch (stay off columns body / thread)',
  rowsSrc.includes('function inboxRowsBeginFolderSwitch(')
  && !columnsSrc.includes('inbox-folder-switching')
  && !threadSrc.includes('inbox-folder-switching')
  && !threadSrc.includes('SUNSET-INBOX-GUESTS-SWITCH-CLEANER-002'));

console.log('\n── click path: one paint ──');
{
  const s = loadHarness({ startGuest: false, emptyList: false });
  s.__inboxRows.wrapGuestViewPreset();
  s.__inboxRows.wrapFolderSwitchCard();
  s.inboxColumnsSetPreset('guest');
  ok('Guests click hides wrap+shell BEFORE the tab preset writes',
    s.events[0] && s.events[0].type === 'preset' && s.events[0].name === 'guest' && s.events[0].hidden === true);
  ok('still hidden after tab + card paint (list/rail not in yet)',
    s.shell.classList.contains('inbox-folder-switching')
    && s.wrap.classList.contains('inbox-folder-switching')
    && s.inboxRowsRuntime.folderSwitching > 0);

  s.__inboxRows.noteFolderSwitchPart('list');
  s.__inboxRows.noteFolderSwitchPart('rail');
  ok('list+rail without counted card stay hidden (no stepped reveal)',
    s.shell.classList.contains('inbox-folder-switching')
    && s.inboxRowsRuntime.folderSwitching > 0);

  s.__inboxRows.noteFolderSwitchPart('card');
  s.flushRAF();
  s.flushRAF();
  ok('reveals in one beat after list + rail + card',
    !s.shell.classList.contains('inbox-folder-switching')
    && !s.wrap.classList.contains('inbox-folder-switching')
    && s.inboxRowsRuntime.folderSwitching === 0);
}

{
  const s = loadHarness({ startGuest: true, emptyList: false });
  s.__inboxRows.wrapGuestViewPreset();
  s.inboxColumnsSetPreset('all4');
  s.__inboxRows.noteFolderSwitchPart('list');
  s.__inboxRows.noteFolderSwitchPart('rail');
  s.flushRAF();
  s.flushRAF();
  ok('Guests → Chats reveals after list+rail (thread leftover is the card)',
    !s.shell.classList.contains('inbox-folder-switching')
    && s.inboxRowsRuntime.folderSwitching === 0
    && s.events[0] && s.events[0].hidden === true);
}

{
  const s = loadHarness({ startGuest: false, emptyList: false });
  s.__inboxRows.wrapGuestViewPreset();
  s.inboxColumnsSetPreset('guest');
  const t = s.timeouts.find((x) => x.ms === 500);
  ok('stall net is 500ms (not 800)', t && t.ms === 500);
  t.cb();
  s.flushRAF();
  s.flushRAF();
  ok('500ms fallback unhides if list/rail/card never arrive',
    !s.shell.classList.contains('inbox-folder-switching')
    && s.inboxRowsRuntime.folderSwitching === 0);
}

console.log('\n── stay off ──');
ok('inbox-thread.js not modified', gitDiff('scripts/browser/inbox-thread.js') === '');
ok('inbox-columns.js WIDTHS not modified', gitDiff('scripts/browser/inbox-columns.js') === '');
ok("Crow's Nest page not modified", gitDiff('scripts/lib/crowsnest/crowsnest-page.js') === '');
ok('package.json not modified', gitDiff('package.json') === '');
ok('do not register this gate in package.json',
  !JSON.stringify(pkg).includes('verify-sunset-inbox-guests-switch-cleaner-002'));
ok('stay-off files still exist',
  fs.existsSync(THREAD_MODULE) && fs.existsSync(CROWSNEST_PAGE));

if (fail) {
  console.error(`\nFAILED ${fail}  passed ${pass}`);
  process.exit(1);
}
console.log(`\nOK ${pass} checks`);
