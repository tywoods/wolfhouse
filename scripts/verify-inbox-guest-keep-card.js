#!/usr/bin/env node
'use strict';

/**
 * verify-inbox-guest-keep-card
 *
 * INBOX-GUEST-KEEP-CARD-002
 *
 * Guest view must never paint the thread skeleton (grey panel + stray
 * "Loading…"), including the first click and slow fetches. Keep whatever
 * is already in the right pane until loadConvDetail paints.
 *
 * Owner: scripts/browser/inbox-rows.js wrap of beginConvDetailLoad.
 * Stay OFF inbox-thread.js, inbox-context.js, staff-query-api.js, package.json.
 *
 * Run:
 *   node scripts/verify-inbox-guest-keep-card.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const {
  ROWS_MODULE,
  THREAD_MODULE,
  CONTEXT_MODULE,
} = require('./lib/inbox-browser-source');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PKG_PATH = path.join(ROOT, 'package.json');

const rowsSrc = fs.readFileSync(ROWS_MODULE, 'utf8');
const threadSrc = fs.readFileSync(THREAD_MODULE, 'utf8');
const contextSrc = fs.readFileSync(CONTEXT_MODULE, 'utf8');
const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

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

function makeTarget(html) {
  let inner = html;
  const classes = new Set();
  return {
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
    querySelector(sel) {
      if (String(sel).indexOf('inbox-customer-card') >= 0
          && inner.indexOf('inbox-customer-card') >= 0) {
        return { className: 'inbox-customer-card is-full' };
      }
      return null;
    },
    get innerHTML() { return inner; },
    set innerHTML(v) { inner = String(v); },
    _classes: classes,
  };
}

function loadFns(extra) {
  const sandbox = Object.assign({
    window: {},
    document: undefined,
    console,
    Object,
    Array,
    String,
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
  }, extra || {});
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${rowsSrc}\nthis.__inboxRows = window.__inboxRows;`, sandbox);
  return sandbox;
}

console.log('\nverify-inbox-guest-keep-card — Guest switch keeps the card\n');

console.log('-- ownership --');
ok('rows wrap of beginConvDetailLoad exists',
  rowsSrc.includes('function inboxRowsWrapGuestKeepCard(')
  && rowsSrc.includes('function inboxRowsShouldKeepGuestCard(')
  && rowsSrc.includes('inboxRowsWrapGuestKeepCard()')
  && rowsSrc.includes('beginConvDetailLoad._inboxRowsGuestKeepCardWrapped'));
ok('stay off inbox-thread.js',
  !threadSrc.includes('inboxRowsShouldKeepGuestCard')
  && !threadSrc.includes('inboxRowsWrapGuestKeepCard')
  && !threadSrc.includes('INBOX-GUEST-KEEP-CARD')
  && threadSrc.includes('function beginConvDetailLoad(')
  && threadSrc.includes('buildConvDetailSkeleton()'));
ok('stay off inbox-context.js',
  !contextSrc.includes('inboxRowsShouldKeepGuestCard')
  && !contextSrc.includes('INBOX-GUEST-KEEP-CARD'));
ok('stay off staff-query-api.js owner markup',
  !apiSrc.includes('INBOX-GUEST-KEEP-CARD')
  && !apiSrc.includes('inboxRowsShouldKeepGuestCard'));
ok('do not rewrite package.json',
  !JSON.stringify(pkg).includes('verify-inbox-guest-keep-card'));
ok('Guest loading CSS disables the kept card and hides the skeleton',
  rowsSrc.includes('#detail-content.is-loading-detail .inbox-customer-card{pointer-events:none}')
  && rowsSrc.includes('[data-inbox-preset="guest"][aria-pressed="true"]) #detail-content.is-loading-detail .detail-sidebar')
  && rowsSrc.includes('INBOX-GUEST-KEEP-CARD-002')
  && rowsSrc.includes('.sidebar-card-skeleton,')
  && rowsSrc.includes('.detail-header:has(#conv-detail-load-status)'));

console.log('\n-- keep vs skeleton --');
{
  const SKELETON = '<div class="sidebar-card sidebar-card-skeleton">Loading…</div>';
  const CARD = '<div class="detail-sidebar" id="inbox-detail-sidebar">'
    + '<article class="inbox-customer-card is-full">Simulate Guest</article></div>';

  const sandbox = loadFns();
  sandbox.inboxRowsRuntime.guestView = true;
  let parked = 0;
  sandbox.inboxParkRefreshBtn = function() { parked += 1; };
  sandbox.beginConvDetailLoad = function(targetEl) {
    targetEl.innerHTML = SKELETON;
    targetEl.classList.add('is-loading-detail');
  };

  const kept = makeTarget(CARD);
  sandbox.__inboxRows.wrapGuestKeepCard();
  sandbox.beginConvDetailLoad(kept);
  ok('Guest + existing card does not wipe to the skeleton',
    kept.innerHTML === CARD
    && kept.innerHTML.indexOf('sidebar-card-skeleton') < 0
    && kept.innerHTML.indexOf('Simulate Guest') >= 0
    && kept.classList.contains('is-loading-detail')
    && parked === 1
    && sandbox.beginConvDetailLoad._inboxRowsGuestKeepCardWrapped === true);

  const firstHtml = '<div class="state-msg">Select a conversation</div>';
  const first = makeTarget(firstHtml);
  parked = 0;
  sandbox.beginConvDetailLoad(first);
  ok('Guest with no card still does not paint the skeleton (first click / slow fetch)',
    first.innerHTML === firstHtml
    && first.innerHTML.indexOf('sidebar-card-skeleton') < 0
    && first.classList.contains('is-loading-detail')
    && parked === 1);

  sandbox.inboxRowsRuntime.guestView = false;
  sandbox.inboxContextIsGuestMode = function() { return false; };
  const full = makeTarget(CARD);
  sandbox.beginConvDetailLoad(full);
  ok('Full / Chat with a card still uses the skeleton',
    full.innerHTML === SKELETON);

  ok('helper is false when Guest latch is off',
    sandbox.__inboxRows.shouldKeepGuestCard(makeTarget(CARD)) === false);
  sandbox.inboxRowsRuntime.guestView = true;
  ok('helper is true when Guest latch is on even with no card',
    sandbox.__inboxRows.shouldKeepGuestCard(makeTarget('<div></div>')) === true);
  ok('helper is true when Guest latch is on and the card is present',
    sandbox.__inboxRows.shouldKeepGuestCard(makeTarget(CARD)) === true);
}

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify-inbox-guest-keep-card — FAILED');
  process.exit(1);
}
console.log('verify-inbox-guest-keep-card — ALL CHECKS PASSED');
process.exit(0);
