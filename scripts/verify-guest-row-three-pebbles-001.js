#!/usr/bin/env node
'use strict';

/** GUEST-ROW-THREE-PEBBLES-001 — name, then package → blue bed → Paid/Unpaid. */

const fs = require('fs');
const path = require('path');
const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const invoice = fs.readFileSync(path.join(__dirname, 'browser/booking-invoice.js'), 'utf8');
let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) { console.log('  PASS  ' + label); pass += 1; return; }
  console.error('  FAIL  ' + label);
  fail += 1;
}

console.log('\nverify-guest-row-three-pebbles-001\n');
ok('name line then pebble line', api.includes("escHtml(name) + '</span>';\n    html += '<span class=\"bc-guest-pebble-line\">'"));
ok('row is a column, not a three-column grid', api.includes('#bc-drawer-card-booking .bc-guest-name-row{display:flex;flex-direction:column'));
ok('bed uses move-beds blue', api.includes('#bc-drawer-card-booking .bc-guest-bed{display:inline-flex;align-items:center;background:#e8f4fd;color:#2474a1;border:1px solid #90c8e8'));
ok('dark bed stays blue', api.includes('[data-theme="dark"] #bc-drawer-card-booking .bc-guest-bed{background:#16384a;color:#d6eef8;border-color:#4da3d4}'));
ok('bottom package list is not painted', !api.includes('booking-body-package-assignments'));
ok('bottom package selects stay hidden', api.includes('#bc-drawer-card-booking #bc-field-package-edit .bc-field-package-guest-row{display:none!important}'));
ok('invoice styles no longer force a side-by-side grid', invoice.includes('#bc-guest-names{display:block}') && !invoice.includes('grid-template-columns:subgrid'));
ok('selected name underline remains', api.includes('#bc-drawer-card-booking .bc-guest-name-line.is-active'));
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
