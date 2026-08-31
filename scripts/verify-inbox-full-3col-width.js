#!/usr/bin/env node
'use strict';

/**
 * verify-inbox-full-3col-width
 *
 * Full 3-col (guest hidden): chat must fill to the Guest restore tab.
 * Do not cap 3-col at 1634px and do not reserve an empty 300px track.
 * 4-col peek keeps the 1634px readable-chat ceiling.
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

console.log('\nverify-inbox-full-3col-width — Full 3-col chat fills to Guest tab\n');

ok('4-col Full peek cap is still 1634px (do not rewrite that selector)',
  apiSrc.includes('.inbox-two-col.inbox-shell-cols[data-col1="full"][data-col2="comfortable"][data-col4="peek"]{')
  && /\[data-col4="peek"\]\{\s*max-width:1634px;margin-left:auto;margin-right:auto;\s*\}/.test(apiSrc));

ok('3-col Full hidden is not capped at 1634px',
  !apiSrc.includes('.inbox-two-col.inbox-shell-cols[data-col1="full"][data-col2="comfortable"][data-col4="hidden"]{'));

ok('unscoped col4 hidden still documents 0px (Chat/Guest model unchanged)',
  apiSrc.includes('.inbox-two-col.inbox-shell-cols[data-col4="hidden"]{--inbox-col4-w:0px}'));

ok('Full hidden does not reserve a 300px guest track',
  !/\[data-col1="full"\]\[data-col2="comfortable"\]\[data-col4="hidden"\]\{[^}]*--inbox-col4-w:300px/.test(apiSrc));

ok('columns gate asserts 3-col is uncapped so chat fills to the tab',
  columnsSrc.includes('Full 3-col has no 1634px cap so chat fills to the Guest tab')
  && !columnsSrc.includes('Full 3-col (guest hidden) keeps the same 1634px workspace as 4-col'));

ok('spec says Full hidden chat fills to the Guest restore tab',
  /chat fills to the Guest restore tab/.test(specSrc)
  && !/Full with column 4 hidden keeps that same 1634px cap/.test(specSrc));

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
