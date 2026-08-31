#!/usr/bin/env node
'use strict';

/**
 * verify-inbox-full-3col-width
 *
 * Full 3-col (guest hidden) must keep the 4-col 1634px workspace so the
 * chat column does not jump when the Guest tab is toggled.
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

console.log('\nverify-inbox-full-3col-width — Full 3-col keeps 4-col width\n');

ok('4-col Full peek cap is still 1634px (do not rewrite that selector)',
  apiSrc.includes('.inbox-two-col.inbox-shell-cols[data-col1="full"][data-col2="comfortable"][data-col4="peek"]{')
  && /\[data-col4="peek"\]\{\s*max-width:1634px;margin-left:auto;margin-right:auto;\s*\}/.test(apiSrc));

ok('3-col Full hidden uses the same 1634px cap and does not reserve 300px',
  apiSrc.includes('.inbox-two-col.inbox-shell-cols[data-col1="full"][data-col2="comfortable"][data-col4="hidden"]{')
  && /\[data-col4="hidden"\]\{\s*max-width:1634px;margin-left:auto;margin-right:auto;\s*\}/.test(apiSrc)
  && !/\[data-col1="full"\]\[data-col2="comfortable"\]\[data-col4="hidden"\]\{[^}]*--inbox-col4-w:300px/.test(apiSrc));

ok('unscoped col4 hidden still documents 0px (Chat/Guest model unchanged)',
  apiSrc.includes('.inbox-two-col.inbox-shell-cols[data-col4="hidden"]{--inbox-col4-w:0px}'));

ok('Full hidden does not leave a dead guest gap (no Full margin-right:0 override)',
  !/body:has\(\[data-inbox-preset="all4"\]\[aria-pressed="true"\]\) #inbox-shell\.inbox-two-col\.inbox-shell-cols\[data-col4="hidden"\] \.detail-main[\s\S]{0,220}margin-right:0/.test(apiSrc));

ok('columns gate asserts the 3-col cap without an empty 300px track',
  columnsSrc.includes('Full 3-col (guest hidden) keeps the same 1634px workspace as 4-col')
  && columnsSrc.includes('Full 3-col does not reserve an empty 300px guest track')
  && !columnsSrc.includes('Full 3-col keeps the 300px guest track so chat does not absorb it'));

ok('spec says Full hidden keeps 1634 without an empty hole',
  /Full with column 4 hidden keeps that same 1634px cap/.test(specSrc)
  && /no empty hole/.test(specSrc));

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
