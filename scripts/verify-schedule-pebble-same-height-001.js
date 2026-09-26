#!/usr/bin/env node
'use strict';

/**
 * SCHEDULE-PEBBLE-SAME-HEIGHT-001
 *
 * Desktop Schedule booking bars were painting package pebbles with the drawer
 * .pkg-pebble size (the compact override sits inside @media max-width 768px).
 * Those chips were taller and wider than Link sent / Transfer / € / Deposit
 * paid / Paid, and the extra size grew the bar.
 *
 * Every Schedule bar pebble (package, link, transfer, balance, deposit, paid)
 * must share one height and one horizontal padding, outside the phone query,
 * without a new outline and without restyling drawer pebbles.
 *
 * Run: node scripts/verify-schedule-pebble-same-height-001.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    console.log('  PASS  ' + label);
    pass += 1;
    return;
  }
  console.error('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
  fail += 1;
}

function mediaDepthAt(src, index) {
  let depth = 0;
  let mediaDepth = 0;
  const mediaAt = [];
  for (let i = 0; i < index; i += 1) {
    const ch = src[i];
    if (ch === '{') {
      const before = src.slice(Math.max(0, i - 80), i);
      if (/@media[^{]*$/.test(before)) mediaAt.push(depth);
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      while (mediaAt.length && mediaAt[mediaAt.length - 1] >= depth) mediaAt.pop();
    }
  }
  mediaDepth = mediaAt.length;
  return mediaDepth;
}

console.log('\nverify-schedule-pebble-same-height-001\n');

const marker = 'SCHEDULE-PEBBLE-SAME-HEIGHT-001';
const markerAt = apiSrc.indexOf(marker);
ok('marker is in the staff portal source', markerAt > 0);

const ruleStart = apiSrc.indexOf('#tab-bed-calendar .bc-block .bc-block-pay-badge,\n#tab-bed-calendar .bc-block .transfer-pebble,\n#tab-bed-calendar .bc-block .bc-block-package-pebble{');
ok('shared bar pebble rule exists', ruleStart > markerAt);
ok('shared rule is outside the phone media query', ruleStart > 0 && mediaDepthAt(apiSrc, ruleStart) === 0);

const ruleEnd = apiSrc.indexOf('}', ruleStart);
const rule = ruleStart > 0 ? apiSrc.slice(ruleStart, ruleEnd + 1) : '';
ok('shared height is 19px scaled by zoom', /height:calc\(19px \* var\(--bc-zoom, 1\)\)/.test(rule));
ok('shared max-height matches', /max-height:calc\(19px \* var\(--bc-zoom, 1\)\)/.test(rule));
ok('horizontal padding is one value', /padding:0 calc\(5px \* var\(--bc-zoom, 1\)\)/.test(rule));
ok('vertical padding is the shared 0 (height owns the box)', /padding:0 calc\(5px \* var\(--bc-zoom, 1\)\)/.test(rule));
ok('chips can shrink instead of widening the bar', /min-width:0/.test(rule) && /max-width:100%/.test(rule) && /text-overflow:ellipsis/.test(rule));
ok('package margin from .pkg-pebble is cleared', /margin:0/.test(rule));
ok('no new outline', !/outline\s*:/.test(rule) && !/box-shadow\s*:/.test(rule));
ok('does not add font-weight 800', !/font-weight:\s*800/.test(rule));
ok('keeps a border-box so the 1px pay/transfer border stays inside the height', /box-sizing:border-box/.test(rule));

const barRuleStart = apiSrc.indexOf('/* ' + marker);
const barRule = apiSrc.slice(barRuleStart, ruleStart);
ok('booking bar does not wrap a tall chip onto a second line', /#tab-bed-calendar \.bc-block\{[^}]*flex-wrap:nowrap/.test(barRule));

const pkgDecl = apiSrc.match(/\.pkg-pebble\{[^}]*\}/);
ok('global drawer .pkg-pebble declaration is unchanged', pkgDecl && /padding:2px 10px/.test(pkgDecl[0]) && /margin:2px/.test(pkgDecl[0]));
ok('drawer transfer pebble size is not the bar rule', !/#tab-bed-calendar \.bc-block \.transfer-pebble-drawer/.test(rule));

const payBorder = apiSrc.match(/\.bc-block-pay-balance\{[^}]*\}/);
ok('balance fill border stays (no outline strip)', payBorder && /border:1px solid var\(--chip-balance-border\)/.test(payBorder[0]));

console.log('\n── verify-schedule-pebble-same-height-001 ' + (fail ? 'FAILED' : 'PASSED') + ' (' + pass + '/' + (pass + fail) + ') ──\n');
if (fail > 0) process.exit(1);
