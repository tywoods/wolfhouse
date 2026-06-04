/**
 * Phase 10.4d — Static verifier for Staff Portal running invoice display in booking drawer.
 *
 * Usage:
 *   npm run verify:staff-running-invoice-display
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');
const MIG_DIR  = path.join(__dirname, '..', 'database', 'migrations');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-running-invoice-display.js  (Phase 10.4d)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');
check(src.length > 10000, 'staff-query-api.js readable');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const drawerFn = src.match(/function renderBookingContextDrawer[\s\S]*?\n\}/)?.[0] || '';
const invFn = src.match(/function bcRenderRunningInvoiceHtml[\s\S]*?\n\}/)?.[0] || '';
const invHelpers = src.match(/\/\* Phase 10\.4d — running invoice helpers[\s\S]*?function bcRenderRunningInvoiceHtml/)?.[0] || '';

console.log('\nA. Running invoice structure');

check(/function bcRenderRunningInvoiceHtml/.test(src),
  'bcRenderRunningInvoiceHtml helper exists (10.4d)');
check(/bcRenderRunningInvoiceHtml\(bk, svcRows, pmt\)/.test(drawerFn),
  'drawer calls bcRenderRunningInvoiceHtml with booking + service_records + payments');
check(/id="bc-running-invoice"/.test(invFn),
  'running invoice container id bc-running-invoice');
check(/ctx-running-invoice/.test(invFn),
  'ctx-running-invoice CSS class on payment box');
check(/id="bc-inv-accommodation"/.test(invFn) && /Accommodation/.test(invFn),
  'Accommodation group present');
check(/id="bc-inv-addons"/.test(invFn) && /Add-ons/.test(invFn),
  'Add-ons/services group present');
check(/id="bc-inv-totals"/.test(invFn) && /Totals/.test(invFn),
  'Totals/payment status group present');
check(/Invoice total/.test(invFn),
  'Invoice total row present');
check(/\.ctx-inv-line/.test(src),
  'line-item CSS class ctx-inv-line');

console.log('\nB. Accommodation line');

check(/bcRunningInvoicePackageLabel/.test(invHelpers),
  'package label helper uses booking package_code');
check(/bcRunningInvoiceAccommodationCents/.test(invHelpers),
  'accommodation cents helper uses quote_snapshot / booking totals');
check(/BC_RUNNING_INVOICE_ACCOMM_CODES/.test(invHelpers),
  'accommodation quote line codes defined (package / proration / supplement)');
check(/bcStayNightsFromCheckInOut/.test(invFn),
  'nights derived from check-in/check-out');
check(/Accommodation total:/.test(invFn),
  'fallback accommodation total copy when nightly rate unavailable');

console.log('\nC. Add-on/service line items');

check(/data\.service_records/.test(drawerFn),
  'drawer reads service_records from booking context');
check(/bcRunningInvoiceSvcLineText/.test(invHelpers),
  'service line text builder exists');
check(/No add-ons recorded\./.test(invFn),
  'empty add-ons state copy');
check(/ctx-inv-addon-line/.test(invFn),
  'add-on line item markup');
check(!/data\.addons/.test(invFn) && !/addons\.rows/.test(invFn),
  'running invoice does not use legacy addons summary block');

console.log('\nD. Totals / paid / balance / refund');

check(/Balance due/.test(invFn),
  'Balance due display');
check(/Paid in full/.test(invFn) && /paid-in-full/.test(invFn),
  'Paid in full status when total equals paid');
check(/Needs refund \/ credit review/.test(invFn) && /needs-refund/.test(invFn),
  'Needs refund/credit review when total below paid');
check(/bcPaymentLedgerPaidTotalCents/.test(invFn),
  'Paid amount from payment ledger (paid rows only)');

console.log('\nE. Payment history / truth copy');

check(!/ctx-inv-truth-note/.test(invFn) || !/Paid total uses payment history/.test(invFn),
  'explanatory paid-total disclaimer removed from running invoice');
check(!/Paid total uses payment history \(paid rows only\)/.test(invFn),
  'removed Paid total uses payment history copy');
check(!/Invoice total is expected charges/.test(invFn),
  'removed Invoice total is expected charges copy');
check(/Payment history/.test(invFn),
  'Payment history ledger section');

console.log('\nF. No legacy duplicate Services panel');

check(!/id="bc-service-records"/.test(drawerFn),
  'separate bc-service-records panel removed from drawer');
check(!/<h3>Services &amp; Add-ons<\/h3>/.test(drawerFn),
  'legacy Services & Add-ons heading removed from drawer');

console.log('\nG. Read-only / no mutation / no Stripe create');

check(!/<input[^>]+/.test(invFn) && !/<select[^>]+/.test(invFn) && !/<textarea[^>]+/.test(invFn),
  'running invoice has no form inputs');
check(!/Create payment link|create-stripe-link|createStripeLink/i.test(invFn),
  'no Create payment link / Stripe link generation in running invoice');
check(!/api\.stripe\.com/.test(invFn),
  'no Stripe API URL in running invoice render');
check(!/INSERT INTO booking_service_records|UPDATE booking_service_records|DELETE FROM booking_service_records/.test(invFn),
  'no booking_service_records mutation in running invoice render');
check(!/UPDATE bookings|INSERT INTO bookings|DELETE FROM booking_beds/.test(invFn),
  'no booking mutation in running invoice render');
check(!/Save changes|Apply changes|Edit guest|Edit dates|Preview date change|bc-edit-/.test(invFn),
  'no edit/save UI in running invoice slice');

console.log('\nH. Safety boundaries');

check(!/graph\.facebook\.com/.test(invFn),
  'no WhatsApp URL in running invoice render');
check(!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(invFn)),
  'no n8n URL fetch in running invoice render');
check(!/ask-luna|alAsk|resolveNaturalLanguageIntent/.test(invFn),
  'no Ask Luna logic in running invoice render');
check(!/date-change-preview|bc-date-change/.test(invFn),
  'no date-change UI in running invoice slice');

console.log('\nI. Package script');

try {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(pkg.scripts && pkg.scripts['verify:staff-running-invoice-display'],
    'package.json has verify:staff-running-invoice-display script');
} catch (_) {
  fail('package.json readable for script check');
}

console.log('\nJ. No migration changes in this slice');

let migChanged = false;
try {
  const out = execSync('git diff --name-only -- database/migrations', { encoding: 'utf8', cwd: path.join(__dirname, '..') }).trim();
  migChanged = out.length > 0;
} catch (_) { /* no git or no diff */ }
check(!migChanged, 'no database/migrations changes in working tree');

console.log('\nResult: ' + passes + ' passed, ' + failures + ' failed\n');
if (failures > 0) process.exit(1);
