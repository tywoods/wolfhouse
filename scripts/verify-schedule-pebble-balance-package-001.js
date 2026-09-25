#!/usr/bin/env node
'use strict';

/**
 * SCHEDULE-PEBBLE-BALANCE-PACKAGE-001
 *
 * Desktop hostel booking bar only:
 *   - balance pebble is the amount (keeps orange/red class), no "Balance due" / "Saldo pendiente"
 *   - package present on one guest → that guest's package only, no group xN
 *   - no package → render nothing (Cap plan §1 supersedes the old "no pebble" chip)
 *   - payload fields survive initial load / nav / refresh paint
 *   - clicks stay on the bar, not a new handler
 *
 * Sunset hides the hostel bed-calendar. That surface is N/A — do not treat a
 * hidden calendar as PASS.
 *
 * Run: node scripts/verify-schedule-pebble-balance-package-001.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { getBedCalendarBlocksQuery } = require('./lib/staff-bed-calendar-queries');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');

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

function between(src, startMark, endMark) {
  const start = src.indexOf(startMark);
  if (start < 0) return '';
  const end = src.indexOf(endMark, start + startMark.length);
  if (end < 0) return '';
  return src.slice(start, end);
}

console.log('\nverify-schedule-pebble-balance-package-001\n');

console.log('[1] Sunset hostel booking bar is not this surface');
const sunset = loadClientPortalProfile('sunset');
const wolf = loadClientPortalProfile('wolfhouse-somo');
ok('Sunset hides bed-calendar', (sunset.hidden_tabs || []).includes('bed-calendar'));
ok('Sunset default tab is not the hostel calendar', sunset.default_tab !== 'bed-calendar');
ok('Wolfhouse keeps the hostel booking calendar', wolf.default_tab === 'bed-calendar'
  && !(wolf.hidden_tabs || []).includes('bed-calendar'));
console.log('  NOTE  SUNSET_BOOKING_BAR=N/A (surf schedule, not the hostel bar). Not a PASS.');

console.log('\n[2] Calendar payload carries narrow package fields');
const blocksSql = getBedCalendarBlocksQuery();
ok('blocks query selects package_code', /b\.package_code/.test(blocksSql));
ok('blocks query selects guest_packages only', /metadata->'guest_packages'\s+AS\s+guest_packages/.test(blocksSql));
ok('blocks query does not select all metadata', !/b\.metadata\s+AS\s+metadata/.test(blocksSql)
  && !/,\s*b\.metadata\s*(?:,|$)/.test(blocksSql));
const buildFn = extractFunction(apiSrc, 'buildCalendarBlocks');
ok('buildCalendarBlocks copies package_code', /package_code:\s*row\.package_code/.test(buildFn));
ok('buildCalendarBlocks copies guest_packages', /guest_packages:/.test(buildFn));

console.log('\n[3] Bar HTML');
const payFn = extractFunction(apiSrc, 'bcCalendarPaymentBadgesHtml');
const tipFn = extractFunction(apiSrc, 'bcCalendarPaymentTooltipHint');
const pkgFn = extractFunction(apiSrc, 'bcCalendarPackagePebbleHtml');
const innerFn = extractFunction(apiSrc, 'bcCalendarBlockInnerHtml');
ok('package pebble helper exists', pkgFn.includes('function bcCalendarPackagePebbleHtml'));
ok('bar inner html includes the guest row pebbles', innerFn.includes('bcCalendarGuestRowPebblesHtml(blk)'));
ok('balance badge helper drops the English label', !/Balance due/.test(payFn));
ok('balance badge helper drops the Spanish label', !/Saldo pendiente/.test(payFn));
ok('bar tooltip drops Balance due', !/Balance due/.test(tipFn));
ok('bar tooltip drops Saldo pendiente', !/Saldo pendiente/.test(tipFn));

const drawerPkg = extractFunction(apiSrc, 'bcRenderPackagePebblesHtml');
ok('drawer empty package label unchanged', drawerPkg.includes('No package'));
ok('drawer balance label key still present', apiSrc.includes("'drawer.invoice.balanceDue': 'Balance due'")
  || apiSrc.includes('drawer.invoice.balanceDue'));

const sandbox = {
  escHtml: (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;'),
  window: {},
  t: (key) => key,
};
vm.createContext(sandbox);
const pieces = [
  'bcCalendarFormatEur',
  'bcCalendarBlockPaymentState',
  'bcCalendarPaymentBadgesHtml',
  'bcCalendarPaymentTooltipHint',
  'bcFieldEditPackageDisplayLabel',
  'bcGuestPackages',
  'bcPackagePebbleClass',
  'bcCalendarGuestPackageCode',
  'bcCalendarGuestRowPebblesHtml',
  'bcCalendarPackagePebbleHtml',
  'bcTransferPebbleHtml',
  'bcGroupChipHtml',
  'bcCalendarBlockInnerHtml',
].map((name) => extractFunction(apiSrc, name)).join('\n');
let ran = false;
try {
  vm.runInContext(pieces, sandbox);
  ran = typeof sandbox.bcCalendarPaymentBadgesHtml === 'function'
    && typeof sandbox.bcCalendarPackagePebbleHtml === 'function'
    && typeof sandbox.bcCalendarBlockInnerHtml === 'function';
} catch (err) {
  ok('bar helpers evaluate', false, err.message);
}
ok('bar helpers evaluate', ran);

if (ran) {
  const balanceHtml = sandbox.bcCalendarPaymentBadgesHtml({
    calendar_payment_primary: 'balance_due',
    calendar_payment_amount_cents: 99700,
    calendar_show_deposit_paid: true,
    has_active_payment_link: true,
  });
  ok('balance pebble is amount only', />€997\.00</.test(balanceHtml) && !/Balance due/.test(balanceHtml) && !/Saldo pendiente/.test(balanceHtml), balanceHtml);
  ok('balance pebble keeps orange/red class', balanceHtml.includes('bc-block-pay-balance'));
  ok('deposit and link pebbles stay', balanceHtml.includes('Deposit paid') && balanceHtml.includes('Link sent'));

  const uluwatu = sandbox.bcCalendarGuestRowPebblesHtml({
    calendar_guest_number: 1,
    calendar_group_size: 3,
    guest_packages: [
      { guest_number: 1, package_code: 'uluwatu' },
      { guest_number: 2, package_code: 'uluwatu' },
      { guest_number: 3, package_code: 'uluwatu' },
    ],
  });
  ok('package pebble is that guest only', uluwatu.includes('Uluwatu') && !/x3/.test(uluwatu) && !/×3/.test(uluwatu), uluwatu);
  ok('package pebble reuses uluwatu color', uluwatu.includes('pkg-pebble-rose') || uluwatu.includes('pkg-pebble-uluwatu'), uluwatu);
  ok('package pebble is not the drawer empty label', !uluwatu.includes('No package') && !uluwatu.includes('no package'));

  const none = sandbox.bcCalendarGuestRowPebblesHtml({
    calendar_guest_number: 1,
    calendar_group_size: 2,
    guest_packages: [{ guest_number: 1, package_code: 'no_package' }],
  });
  ok('missing package renders nothing', none === '', JSON.stringify(none));
  ok('missing package is not a chip', !/pebble/.test(none));

  const sibling = sandbox.bcCalendarPackagePebbleHtml({
    guest_count: 3,
    package_code: 'uluwatu',
    calendar_show_payment_pills: false,
  });
  ok('sibling beds do not clone the package pebble', sibling === '');

  const blocked = sandbox.bcCalendarPackagePebbleHtml({
    status: 'blocked',
    package_code: 'uluwatu',
    guest_count: 1,
  });
  ok('blocked bars skip the package pebble', blocked === '');

  const inner = sandbox.bcCalendarBlockInnerHtml({
    guest_name: 'Tom',
    calendar_guest_number: 1,
    calendar_group_size: 1,
    package_code: 'uluwatu',
    calendar_guest_share_cents: 99700,
    calendar_guest_paid_cents: 0,
    calendar_guest_deposit_cents: 10000,
    calendar_guest_link_sent: true,
    transfer_summary: { has_transfer: true },
  }, 'Tom');
  ok('bar keeps name, transfer, package, and amount together',
    inner.includes('Tom') && inner.includes('Transfer') && inner.includes('Uluwatu') && inner.includes('€997.00')
      && !/x3/.test(inner) && !/Balance due/.test(inner) && !/no pebble/i.test(inner),
    inner);
  ok('package pebble does not own the click', !/bcCalendarPackagePebbleHtml[\s\S]*addEventListener/.test(pkgFn)
    && !pkgFn.includes('stopPropagation'));
}

console.log('\n[4] Initial load / nav / refresh / clicks');
ok('initial paint uses bar inner html', apiSrc.includes('bcCalendarBlockInnerHtml(blk, label)'));
ok('turnover paint uses bar inner html', apiSrc.includes('bcCalendarBlockInnerHtml(primary.blk, bcTurnoverVisibleLabel(primary.blk))'));
ok('payment refresh repaints through bar inner html', /bcRefreshCalendarBlockPaymentPebbles[\s\S]{0,900}bcCalendarBlockInnerHtml\(blk, labelText\)/.test(apiSrc));
ok('locale/nav rerender uses the loaded calendar payload', apiSrc.includes('if (bcLastBedCalendarData) renderBedCalendar(bcLastBedCalendarData)'));
ok('clicks stay on the bar via data-bidx', /wrap\.querySelectorAll\('\.bc-block, \.bc-block-checkout-marker'\)[\s\S]{0,280}bcOpenBookingDrawerOverview\(blocks\[idx\]\)/.test(apiSrc));
ok('bar package pebble is compact under the calendar, not a drawer restyle',
  /#tab-bed-calendar \.bc-block \.bc-block-package-pebble\{/.test(apiSrc));

const drawerPill = between(apiSrc, 'function bcRenderBlockSummaryPreviewHtml', 'function bcPaymentLedgerHasActiveValidLinkClient');
if (!drawerPill) {
  ok('drawer summary still says Balance due', /pill-orange">Balance due /.test(apiSrc));
} else {
  ok('drawer summary label was not globally cleared', /Balance due /.test(drawerPill));
}

console.log('\n── verify-schedule-pebble-balance-package-001 ' + (fail ? 'FAILED' : 'PASSED') + ' (' + pass + '/' + (pass + fail) + ') ──\n');
if (fail > 0) process.exit(1);
