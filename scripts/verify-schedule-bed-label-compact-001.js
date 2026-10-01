#!/usr/bin/env node
'use strict';

/**
 * SCHEDULE-BED-LABEL-COMPACT-001
 * Schedule bed column shows B1, B2 in its own narrow column.
 * A long bed_label must not widen that column.
 */

const vm = require('vm');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');

const api = readStaffPortalUiSource();
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
// Exercise what buildUiHtml actually sends, not the enclosing template literal.
const emitted = spawnSync(process.execPath, ['-e', [
  "process.env.NODE_ENV = 'test';",
  "process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';",
  "process.env.STAFF_AUTH_REQUIRED = 'false';",
  "process.env.STAFF_AUTH_ALLOW_OPEN = 'true';",
  "process.stdout.write(require('./scripts/staff-query-api.js').buildUiHtmlForOfflineTest(0, 'wolfhouse-somo'));",
].join('')], { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
if (emitted.status !== 0) throw new Error(emitted.stderr || 'Portal emission failed');
const browserFn = extractFunction(emitted.stdout, 'bcScheduleBedColumnLabel');
ok('emitted helper exists', browserFn.startsWith('function bcScheduleBedColumnLabel'));
const label = vm.runInNewContext(browserFn + '\nbcScheduleBedColumnLabel');
ok('R2-B1 is B1', label({ bed_code: 'R2-B1', bed_label: 'Bed 1' }) === 'B1');
ok('R4-B12 is B12', label({ bed_code: 'R4-B12', bed_label: 'Window bed' }) === 'B12');
ok('leading zero collapses', label({ bed_code: 'R1-B01' }) === 'B1');
ok('long label is not the column text', label({ bed_code: 'R1-B2', bed_label: 'Ocean view extra' }) === 'B2');
ok('already compact stays compact', label({ bed_code: 'B3' }) === 'B3');
ok('trimmed lowercase bed code is normalized', label({ bed_code: ' r4-b07 ' }) === 'B7');
ok('unknown code remains unchanged', label({ bed_code: 'CUSTOM' }) === 'CUSTOM');
ok('missing bed code stays empty', label(null) === '');
const original = { bed_code: 'R4-B7', bed_label: 'Window bed', room_code: 'R4' };
label(original);
ok('presentation does not mutate bed identity', original.bed_code === 'R4-B7' && original.room_code === 'R4' && original.bed_label === 'Window bed');
ok('grid paints the compact column', api.includes("escHtml(bcScheduleBedColumnLabel(bed))") && api.includes('bc-bed-cell bc-bed-col'));
ok('column is its own nowrap slot', api.includes('#tab-bed-calendar .bc-bed-cell.bc-bed-col{white-space:nowrap'));
ok('header reserves the narrow bed column in fixed-layout tables', api.includes('#tab-bed-calendar .bc-grid thead th.bc-bed-head{min-width:44px;width:44px;box-sizing:border-box}'));
ok('corner label stays empty', /<th class="bc-bed-head"><\/th>/.test(api));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
