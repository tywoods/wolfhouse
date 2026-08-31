#!/usr/bin/env node
'use strict';

/**
 * verify-inbox-full-3col-width
 *
 * Full 3-col and 4-col must share the same outer wrap (1674px = 1634
 * content + 20px pad) so total width does not jump when the guest card
 * opens or closes. Chat still fills to the Guest tab (no empty 300px
 * track, no 1634 cap on the hidden SHELL).
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

const apiSrc = fs.readFileSync(API, 'utf8');
const columnsSrc = fs.readFileSync(COLUMNS, 'utf8');
const specSrc = fs.readFileSync(SPEC, 'utf8');
const threadSrc = fs.readFileSync(THREAD, 'utf8');

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

ok('4-col Full peek cap is still 1634px (do not rewrite that selector)',
  apiSrc.includes('.inbox-two-col.inbox-shell-cols[data-col1="full"][data-col2="comfortable"][data-col4="peek"]{')
  && /\[data-col4="peek"\]\{\s*max-width:1634px;margin-left:auto;margin-right:auto;\s*\}/.test(apiSrc));

ok('3-col Full hidden SHELL is not capped at 1634px (chat fills to the tab)',
  !apiSrc.includes('.inbox-two-col.inbox-shell-cols[data-col1="full"][data-col2="comfortable"][data-col4="hidden"]{'));

ok('Full wrap is 1674px for all4 (3-col and 4-col share total width)',
  /body:has\(#tab-conversations.active\):has\(\[data-inbox-preset="all4"\]\[aria-pressed="true"\]\) #wrap.inbox-shell-wrap\{\s*max-width:1674px!important;\s*\}/.test(apiSrc));

ok('3-col Full hidden shells pads 22px so chat meets the Guest tab',
  /body:has\(\[data-inbox-preset="all4"\]\[aria-pressed="true"\]\) #inbox-shell\.inbox-two-col\.inbox-shell-cols\[data-col4="hidden"\]\{\s*box-sizing:border-box;padding-right:22px;\s*\}/.test(apiSrc));

ok('unscoped col4 hidden still documents 0px (Chat/Guest model unchanged)',
  apiSrc.includes('.inbox-two-col.inbox-shell-cols[data-col4="hidden"]{--inbox-col4-w:0px}'));

ok('Full hidden does not reserve a 300px guest track',
  !/\[data-col1="full"\]\[data-col2="comfortable"\]\[data-col4="hidden"\]\{[^}]*--inbox-col4-w:300px/.test(apiSrc));

ok('columns gate asserts shared wrap + no hidden shell cap',
  columnsSrc.includes('Full wrap is 1674px (1634 content + pad) in 3-col and 4-col')
  && columnsSrc.includes('Full 3-col has no 1634px shell cap so chat fills to the Guest tab'));

ok('spec says Full wrap is the same for guest-open and guest-hidden',
  /Full wrap is 1674px/.test(specSrc)
  && /total width does not jump/.test(specSrc));

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
