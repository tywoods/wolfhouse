'use strict';

/**
 * STAFF-CHROME-POLISH-001
 * A night-only pin/bed + Clear/Delete chrome, B neutral Unlock + title row,
 * C display-only identical SERVICES grouping.
 *
 * Run: node scripts/verify-staff-chrome-polish-001.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const SHELL = path.join(ROOT, 'scripts', 'browser', 'inbox-shell.js');

let pass = 0;
let fail = 0;
function check(id, cond, detail) {
  if (cond) {
    console.log('  PASS  ' + id);
    pass += 1;
  } else {
    console.error('  FAIL  ' + id + (detail ? ' — ' + detail : ''));
    fail += 1;
  }
}

function extractFunctionSource(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('Missing function ' + name);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') depth -= 1;
    if (depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('Unclosed function ' + name);
}

const api = fs.readFileSync(API, 'utf8');
const shell = fs.readFileSync(SHELL, 'utf8');

console.log('\nverify-staff-chrome-polish-001\n');

check('A1', api.includes('.bc-sel-bed-tag{display:inline-block;background:#e8f4fd;color:#2474a1;border:1px solid #90c8e8'), 'day bed pill unchanged');
check('A2', /\[data-theme="dark"\] \.bc-sel-bed-tag\{background:#1a2830;color:#c5d4de;border-color:#3a5566\}/.test(api), 'night bed pill muted');
check('A3', api.includes('.bc-side-pin.is-on{background:#E7EEE9;color:#2c5f56;border-color:#8AA396}'), 'day pin unchanged');
check('A4', /\[data-theme="dark"\] \.bc-side-pin\.is-on\{background:#1e3328;color:#c5d9cc;border-color:#3d5c48\}/.test(api), 'night pin muted');
check('A5', api.includes('background:#F8E8E8;color:#9C3D3D;border:1px solid #E8B4B4'), 'day Clear pill unchanged');
check('A6', /\[data-theme="dark"\] \.inbox-clear-thread-btn,\[data-theme="dark"\] #btn-inbox-clear-thread\{background:#3a2424;color:#e7c4c0;border-color:#6a4540\}/.test(api), 'night Clear muted in monolith');
check('A7', shell.includes("background:#F8E5E1;color:#8D3E34;border:1px solid #E6B8AF"), 'day Delete pill unchanged');
check('A8', shell.includes('[data-theme="dark"] #inbox-shell #btn-inbox-conv-delete{background:#3a2422;color:#e8c2ba;border-color:#6a4840}'), 'night Delete muted');
check('A9', shell.includes('[data-theme="dark"] #inbox-shell #btn-inbox-clear-thread{background:#3a2424;color:#e7c4c0;border-color:#6a4540}'), 'night Clear muted in shell');

check('B1', !/\.channelAutonomy\.is-locked \.channelAutonomyLock\{background:#E8C4C4/.test(shell), 'Unlock is not the pause red');
check('B2', shell.includes('.channelAutonomy.is-locked .channelAutonomyLock{background:var(--surface-soft,#ECEFF1);color:#8a9690;border-color:var(--border-soft,#D5DADD)}'), 'Unlock matches Lock chrome');
check('B3', shell.includes('.channelAutonomy{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center'), 'title and lock share a desktop row');
check('B4', shell.includes('.channelAutonomy > .channelAutonomyHead{grid-column:1;grid-row:1') && shell.includes('.channelAutonomy > .channelAutonomyToolbar{grid-column:2;grid-row:1'), 'title left, control right');
const htmlFn = shell.slice(shell.indexOf('function inboxShellChannelDefaultsHtml'), shell.indexOf('function inboxShellChannelDefaultsHtml') + 1400);
check('B5', htmlFn.indexOf('channelAutonomyHead') >= 0 && htmlFn.indexOf('channelAutonomyToolbar') > htmlFn.indexOf('channelAutonomyHead') && htmlFn.indexOf('id="inbox-autonomy-lock"') > htmlFn.indexOf('channelAutonomyToolbar'), 'lock stays in the toolbar, not the phone dock title');

const names = [
  'bcServiceRecordBillableCents',
  'bcParseServiceRecordMeta',
  'bcPluralUnit',
  'bcResolveRentalInvoiceDisplayQty',
  'bcResolveRentalInvoiceUnitCents',
  'bcResolveBoardRentalRateCents',
  'staffAddonUiTypeLabel',
  'bcRunningInvoiceSvcTypeLabel',
  'bcRunningInvoiceSvcUnitLabel',
  'bcInvoiceSvcQtyUnitWord',
  'bcRunningInvoiceSvcLineText',
  'bcInvoiceIdenticalServiceGroupKey',
  'bcInvoiceGroupedIdenticalServiceLineText',
  'bcInvoiceServiceRollupKey',
  'bcInvoiceRolledServiceLineText',
  'bcResolveRentalPeopleFromMeta',
  'bcFormatRentalPeopleDaysLine',
  'bcRollupInvoiceServiceDisplay',
  'bcComputeBookingInvoiceTotals',
];

const extracted = names.map((name) => extractFunctionSource(api, name));
const sandbox = {
  BC_RENTAL_DAY_RATES: {
    hard_board_rental: 2000,
    soft_top_rental: 1500,
    wetsuit_rental: 500,
    wetsuit_hard_board_combo: 2000,
    wetsuit_soft_top_combo: 1500,
  },
};
vm.createContext(sandbox);
vm.runInContext(extracted.join('\n'), sandbox);

function lesson(cents, qty, name) {
  const row = {
    service_type: 'surf_lesson',
    quantity: qty == null ? 1 : qty,
    amount_due_cents: cents,
    metadata: {},
  };
  if (name) row.metadata = { staff_ui_service_type: name };
  return row;
}

const three = [lesson(3000, 1), lesson(3000, 1), lesson(3000, 1)];
const grouped = sandbox.bcRollupInvoiceServiceDisplay(three);
check('C1', grouped && grouped.lines.length === 1, 'three identical lessons become one line (' + (grouped && grouped.lines.length) + ')');
check('C2', grouped && grouped.lines[0].text === 'Surf lesson — 3 lessons × €30.00 = €90.00', grouped && grouped.lines[0].text);
check('C3', grouped && grouped.moneyChanged === false && grouped.displayCents === 9000 && grouped.inputCents === 9000 && !grouped.conflict, 'display sum matches stored cents');
check('C4', sandbox.bcRunningInvoiceSvcLineText(lesson(3000, 1)) === 'Surf lesson — 1 lesson × €30.00 = €30.00', sandbox.bcRunningInvoiceSvcLineText(lesson(3000, 1)));

const mixedPrice = sandbox.bcRollupInvoiceServiceDisplay([lesson(3000, 1), lesson(3000, 1), lesson(4500, 1)]);
const mixedText = (mixedPrice.lines || []).map((line) => line.text).join(' | ');
check('C5', mixedPrice.lines.length === 2 && mixedText.includes('2 lessons × €30.00 = €60.00') && mixedText.includes('1 lesson × €45.00 = €45.00'), mixedText);

const yoga = {
  service_type: 'yoga',
  quantity: 1,
  amount_due_cents: 3000,
  metadata: {},
};
const mixedName = sandbox.bcRollupInvoiceServiceDisplay([lesson(3000, 1), lesson(3000, 1), yoga]);
const nameText = (mixedName.lines || []).map((line) => line.text).join(' | ');
check('C6', mixedName.lines.length === 2 && nameText.includes('Surf lesson — 2 lessons') && nameText.includes('Yoga — 1 class'), nameText);

const totalsSrc = extractFunctionSource(api, 'bcComputeBookingInvoiceTotals');
check('C7', /svcRows\.reduce\(function\(s, r\)\{ return s \+ bcServiceRecordBillableCents\(r\); \}, 0\)/.test(totalsSrc), 'invoice total still sums every service row');
check('C8', api.includes('var rollup = bcRollupInvoiceServiceDisplay(svcRows);') && api.includes('if (rollup.conflict || rollup.moneyChanged)'), 'renderer still falls back when money would change');

const dup = [];
for (let i = 0; i < 3; i += 1) {
  dup.push({
    service_type: 'surfboard',
    quantity: 1,
    amount_due_cents: 37500,
    service_date: '2026-09-23',
    metadata: { rental_days: 5, rental_people: 3, staff_ui_service_type: 'hard_board', board_variant: 'hard' },
  });
}
const dupRoll = sandbox.bcRollupInvoiceServiceDisplay(dup);
check('C9', dupRoll && dupRoll.conflict && dupRoll.conflict.reason === 'duplicate_full_span_charges', 'rental duplicate conflict unchanged');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
if (fail) process.exit(1);
