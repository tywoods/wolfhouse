'use strict';

/**
 * PRICING-RENTAL-DURATION-ROW-BUG-001
 *
 * Add Equipment multi-duration: + / × must change row count by exactly one.
 *
 * Bug class (PR #1037): adminReadNewEquipDurations used
 *   wrap.querySelectorAll('[data-new-equip-dur-idx]')
 * while both the row container AND the × button carried that attribute.
 * With N rows (N>1) the reader returned ~2N entries; + then pushed one more
 * (~2N+1 rows); × spliced one from the inflated list and still re-rendered
 * many rows — looking like × "adds" rows.
 *
 * Run: node scripts/verify-pricing-rental-duration-row-bug-001.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');

let pass = 0;
function check(label, cond, detail) {
  assert.ok(cond, `${label}${detail ? `: ${detail}` : ''}`);
  pass += 1;
  console.log(`  PASS  ${label}`);
}

function sliceFn(name) {
  const re = new RegExp(`function ${name}\\([\\s\\S]*?(?=\\nfunction |\\n/\\*\\*|$)`);
  const m = src.match(re);
  assert.ok(m, `missing function ${name}`);
  return m[0];
}

console.log('\nverify:pricing-rental-duration-row-bug-001\n');

const readFn = sliceFn('adminReadNewEquipDurations');
const renderRowFn = sliceFn('renderAdminNewEquipDurationRow');
const wireSlice = (src.match(/function wireAdminTab\([\s\S]*?function /) || [])[0] || '';

check(
  'reader selects .portal-admin-new-equip-dur-row only',
  /var rows = wrap\.querySelectorAll\(['"]\.portal-admin-new-equip-dur-row['"]\)/.test(readFn),
);
check(
  'reader does not use bare [data-new-equip-dur-idx] (double-counts ×)',
  !/var rows = wrap\.querySelectorAll\(['"]\[data-new-equip-dur-idx\]['"]\)/.test(readFn),
);
check(
  '× button uses data-new-equip-remove-idx (not data-new-equip-dur-idx)',
  /data-new-equip-remove-idx=/.test(renderRowFn)
    && !/remove-new-equip-duration" data-new-equip-dur-idx=/.test(renderRowFn),
);
check(
  'remove handler reads data-new-equip-remove-idx',
  /remove-new-equip-duration[\s\S]{0,200}data-new-equip-remove-idx/.test(src),
);
check(
  'remove splices and never pushes a new duration',
  /action === 'remove-new-equip-duration'[\s\S]{0,400}curDurs\.splice\(removeIdx,\s*1\)/.test(src)
    && !/action === 'remove-new-equip-duration'[\s\S]{0,500}\.push\(/.test(src),
);
check(
  'add pushes exactly one blank duration row',
  /action === 'add-new-equip-duration'[\s\S]{0,200}\.push\(\{\s*unit:\s*'days'/.test(src),
);
check(
  'click wiring is once-guarded (no listener stacking)',
  /dataset\.adminWired === ['"]1['"]/.test(wireSlice)
    && /dataset\.adminWired = ['"]1['"]/.test(wireSlice),
);

// ── Bug-class simulation (no browser): count attr collisions in rendered HTML ──
function renderRowHtml(idx, canRemove) {
  let html = `<div class="portal-admin-new-equip-dur-row" data-new-equip-dur-idx="${idx}">`;
  html += `<input id="admin-new-equip-dur-${idx}-count" value="1">`;
  if (canRemove) {
    // Fixed markup: remove idx on a distinct attribute
    html += `<button data-admin-action="remove-new-equip-duration" data-new-equip-remove-idx="${idx}">×</button>`;
  }
  html += '</div>';
  return html;
}

function buggyRenderRowHtml(idx, canRemove) {
  let html = `<div class="portal-admin-new-equip-dur-row" data-new-equip-dur-idx="${idx}">`;
  if (canRemove) {
    html += `<button data-admin-action="remove-new-equip-duration" data-new-equip-dur-idx="${idx}">×</button>`;
  }
  html += '</div>';
  return html;
}

function countMatches(html, re) {
  return (html.match(re) || []).length;
}

const twoRowsFixed = renderRowHtml(0, true) + renderRowHtml(1, true);
const twoRowsBuggy = buggyRenderRowHtml(0, true) + buggyRenderRowHtml(1, true);

check(
  'buggy markup: [data-new-equip-dur-idx] matches 4 nodes for 2 rows',
  countMatches(twoRowsBuggy, /data-new-equip-dur-idx="/g) === 4,
);
check(
  'fixed markup: row selector matches 2; remove attr is separate',
  countMatches(twoRowsFixed, /class="portal-admin-new-equip-dur-row"/g) === 2
    && countMatches(twoRowsFixed, /data-new-equip-remove-idx="/g) === 2
    && countMatches(twoRowsFixed, /data-new-equip-dur-idx="/g) === 2,
);

// Draft-array math that handlers must preserve after a correct read
function addOnce(durs) {
  return durs.concat([{ unit: 'days', count: 1, amount: '' }]);
}
function removeAt(durs, idx) {
  if (durs.length <= 1) return durs.slice();
  if (idx < 0 || idx >= durs.length) return durs.slice();
  return durs.slice(0, idx).concat(durs.slice(idx + 1));
}

let draft = [{ unit: 'days', count: 1, amount: '10' }];
draft = addOnce(draft);
draft = addOnce(draft);
check('two + clicks → exactly 3 rows', draft.length === 3, String(draft.length));
draft = removeAt(draft, 1);
check('one × → exactly 2 rows', draft.length === 2, String(draft.length));
const beforeLast = draft.length;
draft = removeAt(draft, 0);
draft = removeAt(draft, 0);
check('cannot remove last remaining row', draft.length === 1 && beforeLast >= 1, String(draft.length));

console.log(`\nPASS: ${pass} assertions\n`);
