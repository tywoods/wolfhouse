#!/usr/bin/env node
'use strict';

/**
 * SCHEDULE-PER-GUEST-PEBBLES-001
 *
 * One booking is N people. Each Schedule name row (desktop and phone share
 * bcCalendarBlockInnerHtml) shows that guest's pebbles left to right, and
 * skips anything missing. Never a gray "no pebble" chip. Never a group "x3".
 * Balance is that guest's stored share, not the booking total.
 *
 * Bounded money: booking_guests.metadata.subtotal_cents, deposit_amount_cents,
 * amount_paid_cents, and existing payment-link rows. No new ledger.
 *
 * Run: node scripts/verify-schedule-per-guest-pebbles-001.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { annotateCalendarBlocks } = require('./lib/staff-calendar-group-paint');

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

function textOf(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function indexOfPebble(html, needle) {
  return String(html || '').indexOf(needle);
}

console.log('\nverify-schedule-per-guest-pebbles-001\n');

console.log('[1] Missing package renders nothing');
const pkgFn = extractFunction(apiSrc, 'bcCalendarPackagePebbleHtml');
const guestFn = extractFunction(apiSrc, 'bcCalendarGuestRowPebblesHtml');
const innerFn = extractFunction(apiSrc, 'bcCalendarBlockInnerHtml');
ok('guest row pebble helper exists', guestFn.includes('function bcCalendarGuestRowPebblesHtml'));
ok('bar inner html uses the guest row helper', innerFn.includes('bcCalendarGuestRowPebblesHtml(blk)'));
ok('bar package helper does not emit no pebble', !/>no pebble</.test(pkgFn) && !/>No pebble</.test(pkgFn));
ok('guest row helper does not emit no pebble', !/no pebble/i.test(guestFn) && !/no-pebble/i.test(guestFn));
ok('schedule bar source has no no-pebble chip', !/>no pebble</.test(apiSrc) && !/>No pebble</.test(apiSrc) && !/no-pebble/.test(apiSrc));
ok('booking-level sibling skip remains for cloned money', apiSrc.includes('calendar_show_payment_pills === false'));
ok('phone and desktop share the bar painter', apiSrc.includes('bcCalendarBlockInnerHtml(blk, label)')
  && apiSrc.includes('bcCalendarBlockInnerHtml(primary.blk, bcTurnoverVisibleLabel(primary.blk))'));

console.log('\n[2] Guest rows carry that guest only');
const sandbox = {
  escHtml: (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;'),
  t: (key) => key,
  window: {},
};
vm.createContext(sandbox);
const pieces = [
  'bcCalendarFormatEur',
  'bcFieldEditPackageDisplayLabel',
  'bcPackagePebbleClass',
  'bcCalendarGuestPackageCode',
  'bcTransferPebbleHtml',
  'bcGroupChipHtml',
  'bcCalendarGuestRowPebblesHtml',
  'bcCalendarBlockInnerHtml',
].map((name) => extractFunction(apiSrc, name)).join('\n');
let ran = false;
try {
  vm.runInContext(pieces, sandbox);
  ran = typeof sandbox.bcCalendarGuestRowPebblesHtml === 'function';
} catch (err) {
  ok('guest row helper evaluates', false, err.message);
}
ok('guest row helper evaluates', ran);

const packages = [
  { guest_number: 1, package_code: 'no_package' },
  { guest_number: 2, package_code: 'uluwatu' },
  { guest_number: 3, package_code: 'malibu' },
];

function row(partial) {
  return Object.assign({
    calendar_group_size: 4,
    guest_packages: packages,
    balance_due_cents: 130000,
    invoice_total_cents: 160000,
    has_active_payment_link: true,
    transfer_summary: { has_transfer: false },
  }, partial);
}

if (ran) {
  const tom = sandbox.bcCalendarBlockInnerHtml(row({
    guest_name: 'Tom',
    calendar_guest_number: 1,
    calendar_guest_share_cents: 32500,
    calendar_guest_paid_cents: 0,
    calendar_guest_deposit_cents: 10000,
    calendar_guest_link_sent: true,
    calendar_show_payment_pills: true,
  }), 'Tom');
  const tomText = textOf(tom);
  ok('missing package is name plus real pebbles only', !/no pebble/i.test(tomText) && !/pkg-pebble/.test(tom), tom);
  ok('Tom does not show the booking total', !tom.includes('€1300.00') && !tom.includes('€1600.00'), tom);
  ok('Tom balance is his share', tom.includes('€325.00'), tom);
  ok('Tom shows link sent', tom.includes('Link sent'));
  ok('Tom has no deposit or paid pebble', !tom.includes('Deposit paid') && !/>Paid</.test(tom), tom);

  const tim = sandbox.bcCalendarGuestRowPebblesHtml(row({
    calendar_guest_number: 2,
    calendar_guest_share_cents: 40000,
    calendar_guest_paid_cents: 10000,
    calendar_guest_deposit_cents: 10000,
    calendar_guest_link_sent: false,
    calendar_show_payment_pills: false,
    transfer_summary: { has_transfer: true },
  }));
  const timText = textOf(tim);
  ok('Tim package is his alone', tim.includes('Uluwatu') && !/x\d/.test(timText) && !/×/.test(timText), tim);
  ok('Tim does not clone Tom package or a group count', !/Malibu/.test(tim) && !/x3/.test(timText));
  ok('Tim balance is remaining share', tim.includes('€300.00') && !tim.includes('€1300.00'), tim);
  ok('Tim deposit paid is his', tim.includes('Deposit paid'));
  ok('Tim link is not cloned from the booking', !tim.includes('Link sent'));
  ok('Tim transfer stays when the booking has one', tim.includes('Transfer'));
  ok('sibling pills flag does not hide Tim pebbles', tim.includes('Uluwatu') && tim.includes('€300.00'));

  const tyler = sandbox.bcCalendarGuestRowPebblesHtml(row({
    calendar_guest_number: 3,
    guest_packages: [{ guest_number: 3, package_code: 'no_package' }],
    calendar_guest_share_cents: 40000,
    calendar_guest_paid_cents: 40000,
    calendar_guest_deposit_cents: 10000,
    calendar_guest_link_sent: false,
    calendar_show_payment_pills: false,
  }));
  ok('Tyler full share shows Paid', tyler.includes('>Paid<') || tyler.includes('bc-block-pay-paid'), tyler);
  ok('Tyler paid does not invent a zero balance chip', !/€0\.00/.test(tyler) && !/€1300/.test(tyler), tyler);
  ok('Tyler deposit stays separate from Paid', tyler.includes('Deposit paid') && /Paid/.test(tyler));
  ok('Tyler missing package is absent', !/pkg-pebble/.test(tyler) && !/no pebble/i.test(tyler));

  const orderHtml = sandbox.bcCalendarGuestRowPebblesHtml(row({
    calendar_guest_number: 2,
    calendar_guest_share_cents: 40000,
    calendar_guest_paid_cents: 40000,
    calendar_guest_deposit_cents: 10000,
    calendar_guest_link_sent: true,
    transfer_summary: { has_transfer: true },
  }));
  const packageAt = indexOfPebble(orderHtml, 'Uluwatu');
  const linkAt = indexOfPebble(orderHtml, 'Link sent');
  const transferAt = indexOfPebble(orderHtml, 'Transfer');
  const depositAt = indexOfPebble(orderHtml, 'Deposit paid');
  const paidAt = indexOfPebble(orderHtml, 'bc-block-pay-paid');
  ok('pebble order is package, link, transfer, deposit, paid',
    packageAt >= 0 && packageAt < linkAt && linkAt < transferAt && transferAt < depositAt && depositAt < paidAt,
    orderHtml);

  const unknownShare = sandbox.bcCalendarGuestRowPebblesHtml(row({
    calendar_guest_number: 4,
    calendar_guest_share_cents: null,
    calendar_guest_paid_cents: 0,
    calendar_guest_deposit_cents: 0,
    calendar_guest_link_sent: false,
    calendar_show_payment_pills: false,
    guest_packages: [{ guest_number: 4, package_code: 'no_package' }],
  }));
  ok('unknown share does not fall back to the booking total', unknownShare === '' || (!/€/.test(unknownShare) && !/no pebble/i.test(unknownShare)), unknownShare);
}

console.log('\n[3] Annotation copies stored guest share, not a new ledger');
const blocks = [
  {
    booking_id: 'b-tom',
    guest_name: 'Tom',
    room_code: 'R3',
    bed_code: 'R3-B1',
    balance_due_cents: 130000,
    active_link_guest_ids: ['g2'],
    has_booking_level_active_link: true,
  },
  {
    booking_id: 'b-tom',
    guest_name: 'Tom',
    room_code: 'R3',
    bed_code: 'R3-B2',
    balance_due_cents: 130000,
    active_link_guest_ids: ['g2'],
    has_booking_level_active_link: true,
  },
];
const annotated = annotateCalendarBlocks(blocks, [
  {
    booking_id: 'b-tom',
    booking_guest_id: 'g1',
    guest_number: 1,
    guest_name: 'Tom',
    assigned_bed_code: 'R3-B1',
    assigned_room_code: 'R3',
    deposit_amount_cents: 10000,
    amount_paid_cents: 0,
    metadata: { subtotal_cents: 32500, package_code: 'no_package' },
  },
  {
    booking_id: 'b-tom',
    booking_guest_id: 'g2',
    guest_number: 2,
    guest_name: 'Tim',
    assigned_bed_code: 'R3-B2',
    assigned_room_code: 'R3',
    deposit_amount_cents: 10000,
    amount_paid_cents: 10000,
    metadata: { subtotal_cents: 40000, package_code: 'uluwatu' },
  },
]);
const byBed = Object.fromEntries(annotated.map((row) => [row.bed_code, row]));
ok('Tom share is stored subtotal', byBed['R3-B1'] && byBed['R3-B1'].calendar_guest_share_cents === 32500);
ok('Tim share is stored subtotal', byBed['R3-B2'] && byBed['R3-B2'].calendar_guest_share_cents === 40000);
ok('unscoped link stays on the primary row', byBed['R3-B1'] && byBed['R3-B1'].calendar_guest_link_sent === true);
ok('Tim link is his payment row', byBed['R3-B2'] && byBed['R3-B2'].calendar_guest_link_sent === true);
ok('guest query selects stored share columns', /bg\.deposit_amount_cents[\s\S]{0,240}bg\.amount_paid_cents[\s\S]{0,240}bg\.metadata/.test(apiSrc));
ok('guest query stays tenant scoped', /FROM booking_guests bg[\s\S]{0,400}c\.slug = \$2/.test(apiSrc));

console.log('\n── verify-schedule-per-guest-pebbles-001 ' + (fail ? 'FAILED' : 'PASSED') + ' (' + pass + '/' + (pass + fail) + ') ──\n');
if (fail > 0) process.exit(1);
