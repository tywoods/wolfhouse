#!/usr/bin/env node
'use strict';

/**
 * SCHEDULE-BED-LABEL-COMPACT-001
 * Schedule bed column shows B1, B2 in its own narrow column.
 * A long bed_label must not widen that column.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); pass += 1; return; }
  console.error('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
  fail += 1;
}

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

console.log('\nverify-schedule-bed-label-compact-001\n');

const fn = extractFunction(api, 'bcScheduleBedColumnLabel');
ok('helper exists', fn.startsWith('function bcScheduleBedColumnLabel'));
const label = vm.runInNewContext(fn + '\nbcScheduleBedColumnLabel');
ok('R2-B1 is B1', label({ bed_code: 'R2-B1', bed_label: 'Bed 1' }) === 'B1');
ok('R4-B12 is B12', label({ bed_code: 'R4-B12', bed_label: 'Window bed' }) === 'B12');
ok('leading zero collapses', label({ bed_code: 'R1-B01' }) === 'B1');
ok('long label is not the column text', label({ bed_code: 'R1-B2', bed_label: 'Ocean view extra' }) === 'B2');
ok('grid paints the compact column', api.includes("escHtml(bcScheduleBedColumnLabel(bed))") && api.includes('bc-bed-cell bc-bed-col'));
ok('column is its own nowrap slot', api.includes('#tab-bed-calendar .bc-bed-cell.bc-bed-col{white-space:nowrap'));
ok('header does not force a wide bed column', api.includes('#tab-bed-calendar .bc-grid thead th.bc-bed-head{min-width:44px;width:1%}'));
ok('corner label stays empty', /<th class="bc-bed-head"><\/th>/.test(api));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
