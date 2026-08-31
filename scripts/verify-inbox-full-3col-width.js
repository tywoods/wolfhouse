#!/usr/bin/env node
'use strict';

/**
 * verify-inbox-full-3col-width
 *
 * Full 3-col and 4-col share the 1800px wrap so total width does not jump.
 * Chat fills to the Guest tab (no empty 300px track). The grepped peek
 * 1634 selector stays; Full all4 overrides it to width 100%.
 *
 * Stay OFF inbox-thread.js, package.json.
 *
 * Run:
 *   node scripts/verify-inbox-full-3col-width.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const COLUMNS = path.join(ROOT, 'scripts', 'verify-inbox-columns.js');
const SPEC = path.join(ROOT, 'docs', 'INBOX-PORTAL-REDESIGN.md');
const THREAD = path.join(ROOT, 'scripts', 'browser', 'inbox-thread.js');
const PW = path.join(ROOT, 'scripts', 'verify-inbox-full-3col-width-playwright.js');

const apiSrc = fs.readFileSync(API, 'utf8');
const columnsSrc = fs.readFileSync(COLUMNS, 'utf8');
const specSrc = fs.readFileSync(SPEC, 'utf8');
const threadSrc = fs.readFileSync(THREAD, 'utf8');
const pwSrc = fs.readFileSync(PW, 'utf8');

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

console.log('\nverify-inbox-full-3col-width — Full 3-col and 4-col same wrap\n');

ok('4-col Full peek cap selector is still 1634px (do not rewrite that selector)',
  apiSrc.includes('.inbox-two-col.inbox-shell-cols[data-col1="full"][data-col2="comfortable"][data-col4="peek"]{')
  && /\[data-col4="peek"\]\{\s*max-width:1634px;margin-left:auto;margin-right:auto;\s*\}/.test(apiSrc));

ok('Full all4 overrides peek+hidden to fill the 1800 wrap',
  /body:has\(\[data-inbox-preset="all4"\]\[aria-pressed="true"\]\) .inbox-two-col.inbox-shell-cols\[data-col1="full"\]\[data-col2="comfortable"\]\[data-col4="peek"\],\s*body:has\(\[data-inbox-preset="all4"\]\[aria-pressed="true"\]\) .inbox-two-col.inbox-shell-cols\[data-col1="full"\]\[data-col2="comfortable"\]\[data-col4="hidden"\]\{\s*max-width:none;width:100%;margin-left:0;margin-right:0;\s*\}/.test(apiSrc));

ok('no 1674 Full wrap cap (that left 3-col short of 4-col)',
  !apiSrc.includes('max-width:1674px!important'));

ok('3-col Full hidden does not pad 22px (chat goes to the tab’s right edge)',
  !/padding-right:22px/.test(apiSrc));

ok('unscoped col4 hidden still documents 0px (Chat/Guest model unchanged)',
  apiSrc.includes('.inbox-two-col.inbox-shell-cols[data-col4="hidden"]{--inbox-col4-w:0px}'));

ok('Full hidden does not reserve a 300px guest track',
  !/\[data-col1="full"\]\[data-col2="comfortable"\]\[data-col4="hidden"\]\{[^}]*--inbox-col4-w:300px/.test(apiSrc));

ok('columns gate asserts 1800 wrap fill + no 1674 cap',
  columnsSrc.includes('Full 3-col and 4-col both fill the 1800 wrap (no 1674 cap)')
  && columnsSrc.includes('Full 3-col hidden is not capped at 1634px'));

ok('spec says Full uses the 1800px wrap for guest-open and guest-hidden',
  /uses the 1800px wrap/.test(specSrc)
  && /total width does not jump/.test(specSrc));

ok('playwright gate measures wrap bounds and chat right = tab right',
  pwSrc.includes('outer Full wrap left edge is equal in 3-col and 4-col')
  && pwSrc.includes('outer Full wrap right edge is equal in 3-col and 4-col')
  && pwSrc.includes('#wrap.inbox-shell-wrap')
  && pwSrc.includes('3-col chat right edge equals Guest tab right edge'));

ok('stay off inbox-thread.js',
  !threadSrc.includes('1634px') && !threadSrc.includes('--inbox-col4-w:300px'));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify-inbox-full-3col-width — FAILED');
  process.exit(1);
}
console.log('verify-inbox-full-3col-width — ALL CHECKS PASSED');
process.exit(0);
