#!/usr/bin/env node
'use strict';

/**
 * SCHEDULE-DENSE-NAME-ONLY-001
 *
 * Narrow day columns (~>30 days / zoomed-out / measured column under 40px):
 * the booking bar is the guest name only, one line, ellipsis. No pebbles.
 * Wide columns keep pebbles only when the name still has about 8 characters
 * of room; otherwise pebbles drop first. A 3px payment stripe is absolute
 * and must not add padding or width. Click still opens the drawer.
 *
 * Run: node scripts/verify-schedule-dense-name-only-001.js
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

console.log('\nverify-schedule-dense-name-only-001\n');

const markerAt = apiSrc.indexOf('SCHEDULE-DENSE-NAME-ONLY-001');
ok('job marker is in the portal source', markerAt > 0);

const cssStart = apiSrc.indexOf('/* SCHEDULE-DENSE-NAME-ONLY-001');
const cssEnd = apiSrc.indexOf('/* ===== END book-ui ===== */', cssStart);
const css = cssStart > 0 && cssEnd > cssStart ? apiSrc.slice(cssStart, cssEnd) : '';
ok('dense CSS block is present', css.length > 200);
ok('dense month does not blanket-hide pebbles', !/#tab-bed-calendar\.bc-cols-dense \.bc-block \.bc-block-pebbles\{\s*display:none!important/.test(css));
ok('tight bar hides the pebble group', /#tab-bed-calendar \.bc-block\.bc-name-only \.bc-block-pebbles/.test(css) && /display:none!important/.test(css));
ok('name-only fallback keeps one-line ellipsis', /#tab-bed-calendar \.bc-block\.bc-name-only \.bc-block-label[\s\S]{0,220}text-overflow:ellipsis/.test(css)
  && /white-space:nowrap/.test(css));
ok('shown pebbles do not shorten the guest name', /:not\(\.bc-name-only\):has\(\.bc-block-pebbles:not\(:empty\)\) \.bc-block-label[\s\S]{0,240}min-width:max-content/.test(css)
  && /text-overflow:clip/.test(css));
ok('pebbles do not ellipsis-crush when shown', /min-width:max-content/.test(css) && /text-overflow:clip/.test(css));
ok('payment stripe is absolute and 3px', /position:absolute/.test(css) && /width:3px/.test(css));
ok('stripe does not add padding or width', !/padding-left/.test(css) && !/margin-left/.test(css));
ok('stripe colors unpaid deposit paid', /bc-pay-stripe-unpaid\{--bc-pay-stripe:#C4783A/.test(css)
  && /bc-pay-stripe-deposit\{--bc-pay-stripe:#1B4D3E/.test(css)
  && /bc-pay-stripe-paid\{--bc-pay-stripe:#3E7A52/.test(css));
ok('new CSS adds no font-weight 800', !/font-weight:\s*800/.test(css));

ok('pebbles still composed into the bar', /bc-block-pebbles/.test(apiSrc)
  && /bcGroupChipHtml\(blk\)/.test(apiSrc)
  && /bcCalendarGuestRowPebblesHtml\(blk\)/.test(apiSrc));
ok('click still opens the drawer', /bcOpenBookingDrawerOverview\(blocks\[idx\]\)/.test(apiSrc));
ok('thin last-day class is unchanged', /spanDays === 1 \? ' bc-block-thin'/.test(apiSrc));
ok('zoom and paint schedule a refit', /bcApplyCalendarZoom[\s\S]{0,500}bcScheduleDenseNameRefit/.test(apiSrc)
  && /bcMarkDenseNameRoot/.test(apiSrc));

const sandbox = { getClient: function () { return 'wolfhouse-somo'; } };
vm.createContext(sandbox);
const pieces = [
  'bcCalendarFormatEur',
  'bcCalendarBlockPaymentState',
  'bcCalendarBookingFullyPaid',
  'bcScheduleDenseFromMetrics',
  'bcBarKeepsPebbles',
  'bcPayStripeKind',
  'bcPayStripeClass',
].map((name) => extractFunction(apiSrc, name)).join('\n');
let ran = false;
try {
  vm.runInContext(pieces, sandbox);
  ran = typeof sandbox.bcScheduleDenseFromMetrics === 'function';
} catch (err) {
  ok('helpers evaluate', false, err.message);
}
ok('helpers evaluate', ran);

if (ran) {
  const dense = sandbox.bcScheduleDenseFromMetrics;
  const keep = sandbox.bcBarKeepsPebbles;
  const kind = sandbox.bcPayStripeKind;
  ok('more than 30 days is a dense column metric', dense(31, 100, 44) === true);
  ok('exactly 30 days at 100% is not forced dense', dense(30, 100, 44) === false);
  ok('zoomed-out at 80% is a dense column metric', dense(14, 80, 50) === true);
  ok('measured column under 40px is a dense column metric', dense(14, 100, 28) === true);
  ok('unknown column width does not force dense', dense(14, 100, 0) === false);
  ok('wide bar keeps pebbles when the full name still fits', keep(220, 64, 90) === true);
  ok('crushed bar drops pebbles first', keep(120, 64, 90) === false);
  ok('long name drops pebbles even when 8 characters would have fit', keep(200, 150, 80) === false);
  ok('no pebbles means nothing to drop', keep(80, 64, 0) === true);
  ok('paid stripe', kind({
    invoice_total_cents: 10000,
    ledger_paid_cents: 10000,
    balance_due_cents: 0,
    calendar_payment_primary: 'paid',
  }) === 'paid');
  ok('deposit stripe when deposit is in and balance remains', kind({
    calendar_guest_share_cents: 20000,
    calendar_guest_paid_cents: 10000,
    calendar_guest_deposit_cents: 10000,
    calendar_payment_primary: 'balance_due',
    calendar_show_deposit_paid: true,
  }) === 'deposit');
  ok('unpaid stripe when nothing is paid', kind({
    invoice_total_cents: 20000,
    ledger_paid_cents: 0,
    balance_due_cents: 20000,
    calendar_payment_primary: 'balance_due',
  }) === 'unpaid');
  ok('blocked bar has no stripe', kind({ status: 'blocked', color_type: 'blocked' }) === '');
  ok('stripe class is the kind, not text', sandbox.bcPayStripeClass({
    calendar_payment_primary: 'paid',
    invoice_total_cents: 10000,
    ledger_paid_cents: 10000,
  }) === ' bc-pay-stripe bc-pay-stripe-paid');
}

console.log('\n── verify-schedule-dense-name-only-001 ' + (fail ? 'FAILED' : 'PASSED') + ' (' + pass + '/' + (pass + fail) + ') ──\n');
if (fail > 0) process.exit(1);
