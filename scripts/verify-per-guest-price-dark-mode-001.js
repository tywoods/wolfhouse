#!/usr/bin/env node
'use strict';

/** PER-GUEST-PRICE-DARK-MODE-001 — dark Price is white and bold, no white chip. */

const fs = require('fs');
const path = require('path');
const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) { console.log('  PASS  ' + label); pass += 1; return; }
  console.error('  FAIL  ' + label);
  fail += 1;
}

console.log('\nverify-per-guest-price-dark-mode-001\n');
ok('light price chip stays', api.includes('.bc-guest-pay-price{color:#000;background:#fff;border-radius:3px;font-weight:400'));
ok('dark price is white bold with no chip', api.includes('[data-theme="dark"] .bc-guest-pay-price{color:#fff;background:transparent;border-radius:0;font-weight:700}'));
ok('Paid and Owe stay bold', api.includes('.bc-guest-pay-paid,.bc-guest-pay-owed{flex:0 0 auto;font-weight:700'));
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
