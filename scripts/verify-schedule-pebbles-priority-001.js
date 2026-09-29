#!/usr/bin/env node
'use strict';

/**
 * SCHEDULE-PEBBLES-PRIORITY-001
 *
 * Schedule booking bars put pebbles back after the full guest name, in order:
 *   Balance due (euro amount, omit when €0) → Paid or Deposit paid → Transfer.
 * Link sent is not a bar pebble. If the full name plus those pebbles do not
 * fit, hide the pebble group. Never ellipsis the name to keep pebbles.
 * Dense name-only remains the tight-space fallback, not a blanket hide.
 *
 * Run: node scripts/verify-schedule-pebbles-priority-001.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

function indexOfPebble(html, needle) {
  return String(html || '').indexOf(needle);
}

console.log('\nverify-schedule-pebbles-priority-001\n');

ok('job marker is in the portal source', apiSrc.includes('SCHEDULE-PEBBLES-PRIORITY-001'));

const guestFn = extractFunction(apiSrc, 'bcCalendarGuestRowPebblesHtml');
const innerFn = extractFunction(apiSrc, 'bcCalendarBlockInnerHtml');
const syncFn = extractFunction(apiSrc, 'bcSyncDenseNameOnly');
const payFn = extractFunction(apiSrc, 'bcCalendarPaymentBadgesHtml');
ok('guest row painter has no Link sent pebble', guestFn && !/>Link sent</.test(guestFn) && !/bc-block-pay-link/.test(guestFn));
ok('legacy bar badge helper has no Link sent pebble', payFn && !/Link sent/.test(payFn) && !/bc-block-pay-link/.test(payFn));
ok('fit measures the full name', /bcFullNamePx\(label\)/.test(syncFn) && !/bcEightChPx/.test(syncFn));
ok('dense metric does not blanket-stamp name-only', !/if \(dense\)/.test(syncFn));
ok('priority pebbles come before the group chip', /bcCalendarGuestRowPebblesHtml\(blk\) \+ bcGroupChipHtml\(blk\)/.test(innerFn));

const sandbox = {
  getClient: () => 'wolfhouse-somo',
  escHtml: (s) => String(s == null ? '' : s),
  t: (key) => key,
  window: {},
};
vm.createContext(sandbox);
const pieces = [
  'bcCalendarFormatEur',
  'bcCalendarBookingFullyPaid',
  'bcCalendarGuestPackageCode',
  'bcFieldEditPackageDisplayLabel',
  'bcPackagePebbleClass',
  'bcTransferPebbleHtml',
  'bcGroupChipHtml',
  'bcCalendarGuestRowPebblesHtml',
  'bcCalendarBlockInnerHtml',
  'bcBarKeepsPebbles',
].map((name) => extractFunction(apiSrc, name)).join('\n');
let ran = false;
try {
  vm.runInContext(pieces, sandbox);
  ran = typeof sandbox.bcCalendarGuestRowPebblesHtml === 'function';
} catch (err) {
  ok('helpers evaluate', false, err.message);
}
ok('helpers evaluate', ran);

if (ran) {
  const mixed = sandbox.bcCalendarGuestRowPebblesHtml({
    calendar_guest_share_cents: 40000,
    calendar_guest_paid_cents: 10000,
    calendar_guest_deposit_cents: 10000,
    calendar_guest_link_sent: true,
    has_active_payment_link: true,
    transfer_summary: { has_transfer: true },
    calendar_guest_package_code: 'uluwatu',
    calendar_guest_number: 1,
    calendar_group_size: 1,
    guest_packages: [{ guest_number: 1, package_code: 'uluwatu' }],
  });
  const balanceAt = indexOfPebble(mixed, 'bc-block-pay-balance');
  const depositAt = indexOfPebble(mixed, 'Deposit paid');
  const transferAt = indexOfPebble(mixed, 'Transfer');
  const packageAt = indexOfPebble(mixed, 'Uluwatu');
  ok('mixed bar order is balance, deposit paid, transfer, then package',
    balanceAt >= 0 && balanceAt < depositAt && depositAt < transferAt && transferAt < packageAt
      && !/Link sent/.test(mixed) && !/>Paid</.test(mixed),
    mixed);
  ok('balance due is the amount, not the words', mixed.includes('€300.00') && !/Balance due/.test(mixed));

  const zero = sandbox.bcCalendarGuestRowPebblesHtml({
    calendar_guest_share_cents: 10000,
    calendar_guest_paid_cents: 10000,
    calendar_guest_deposit_cents: 10000,
    transfer_summary: { has_transfer: true },
    calendar_guest_number: 1,
    calendar_group_size: 1,
  });
  ok('€0 balance is omitted and Paid wins over Deposit paid',
    !/€0\.00/.test(zero) && !/bc-block-pay-balance/.test(zero)
      && zero.includes('>Paid<') && !zero.includes('Deposit paid') && zero.includes('Transfer'),
    zero);

  const unpaid = sandbox.bcCalendarBlockInnerHtml({
    guest_name: 'Tyler Woods',
    calendar_guest_share_cents: 20000,
    calendar_guest_paid_cents: 0,
    calendar_guest_deposit_cents: 10000,
    calendar_guest_link_sent: true,
    has_active_payment_link: true,
    transfer_summary: { has_transfer: false },
  }, 'Tyler Woods');
  ok('name stays whole and Link sent is absent',
    unpaid.includes('Tyler Woods') && unpaid.includes('€200.00') && !/Link sent/.test(unpaid)
      && !unpaid.includes('Deposit paid') && !/>Paid</.test(unpaid),
    unpaid);

  const keep = sandbox.bcBarKeepsPebbles;
  ok('full name that does not fit hides pebbles', keep(180, 140, 70) === false);
  ok('full name that fits keeps pebbles', keep(220, 90, 70) === true);
}

console.log('\n── verify-schedule-pebbles-priority-001 ' + (fail ? 'FAILED' : 'PASSED') + ' (' + pass + '/' + (pass + fail) + ') ──\n');
if (fail > 0) process.exit(1);
