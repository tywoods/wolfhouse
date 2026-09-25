#!/usr/bin/env node
'use strict';

/**
 * NEW-BOOKING-HEADER-GAP-001
 * New booking drawer: no dead band or horizontal rule between the date range
 * and Selected Stay. Block / pin / close stay on the header.
 *
 *   node scripts/verify-new-booking-header-gap-001.js
 */

const fs = require('fs');
const path = require('path');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log('ok -', label);
    return;
  }
  failed += 1;
  console.error('FAIL -', label, detail || '');
}

const createHead = '#bc-side-drawer[data-mode="create"] .bc-side-head{border-bottom:0;padding-bottom:0}';
const createBody = '#bc-side-drawer[data-mode="create"] .bc-side-body{padding-top:6px}';
const createStay = '#bc-side-drawer[data-mode="create"] #bc-sel-panel > .bk-form-section:has(> [data-i18n="calendar.create.stay"]){margin-top:0;padding-top:0;border-top:0}';

ok('create header drops the separator', api.includes(createHead));
ok('create body padding is tight', api.includes(createBody));
ok('Selected Stay section drops its top rule and gap', api.includes(createStay));
ok(
  'booking drawer header separator is unchanged',
  api.includes('.bc-side-head{\n  flex:0 0 auto;\n  padding:10px 12px 8px;\n  border-bottom:1px solid var(--border-soft);\n}')
);
ok('later guest sections still use the shared section rule', api.includes('.bk-form-section{margin-top:16px;padding-top:14px;border-top:1px solid var(--border-soft)}'));
ok('create mode is set when the panel docks', api.includes("rail.dataset.mode = 'create'"));
ok('Block still moves next to the pin', api.includes('actions.insertBefore(btn, pin)'));
ok('pin and close actions are still in the header', api.includes('id="bc-side-pin"') && api.includes('id="bc-side-close"'));
ok('Block button id is unchanged', api.includes('id="bc-sel-block"'));

console.log(failed
  ? `verify:new-booking-header-gap-001 FAILED (${failed})`
  : 'verify:new-booking-header-gap-001 passed');
process.exit(failed ? 1 : 0);
