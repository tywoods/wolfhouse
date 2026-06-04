/**
 * Phase 10.6b — Payment ledger, cash payments, drawer order.
 *
 * Usage:
 *   npm run verify:staff-payment-records-ledger
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-payment-records-ledger.js  (Phase 10.6b)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const drawerFn = (() => {
  const i = src.indexOf('function renderBookingContextDrawer(data){');
  if (i < 0) return '';
  const j = src.indexOf('\n/* ── Tour Operator forms', i);
  return j > i ? src.slice(i, j) : '';
})();

const invFn = src.match(/function bcRenderRunningInvoiceHtml[\s\S]*?\n\}/)?.[0] || '';
const cashHandler = src.match(/async function handleBookingRecordCashPayment[\s\S]*?\n\}/)?.[0] || '';
const cancelHandler = src.match(/async function handleBookingCancelPaymentLink[\s\S]*?\n\}/)?.[0] || '';
const cancelUi = src.match(/function bcInitCancelPaymentLinkShell[\s\S]*?\n\}/)?.[0] || '';
const cashUi = src.match(/function bcInitCashPaymentShell[\s\S]*?\n\}/)?.[0] || '';
const cashFormFn = src.match(/function bcRenderCashPaymentFormHtml[\s\S]*?\n\}/)?.[0] || '';
const ledgerHelpers = src.match(/\/\* Phase 10\.6b — payment ledger helpers[\s\S]*?function bcRunningInvoiceSvcLineText/)?.[0] || '';

console.log('\nA. Drawer order');

check(/bcRenderFieldEditSectionsHtml\(data\)[\s\S]*bcRenderAddServicePanelHtml\(bk\)[\s\S]*id="bc-move-bed"/.test(drawerFn),
  'field edits → Add-ons → Move bed');
check(/bcRenderAddServicePanelHtml\(bk\)[\s\S]*bcRenderRunningInvoiceHtml/.test(drawerFn),
  'Add-ons before Payment / running invoice');
check(!/id="bc-move-bed"[\s\S]*bcRenderAddServicePanelHtml/.test(drawerFn),
  'Move bed is not above Add-ons panel');
check(/bcRenderRunningInvoiceHtml[\s\S]*Conversation \/ Handoff/.test(drawerFn),
  'Payment before Conversation / Handoff');
check(/bcRenderBookingCancelFooterHtml/.test(drawerFn),
  'Cancel reservation footer preserved');

console.log('\nB. Payment history ledger UI');

check(/Payment history/.test(invFn), 'Payment history subtitle');
check(!/Payment records<\/div>/.test(invFn) || /Payment history/.test(invFn),
  'ledger uses Payment history label');
check(/bcPaymentLedgerPaidTotalCents/.test(invFn),
  'running invoice Paid uses ledger paid helper');
check(/bcPaymentLedgerIsPaidStatus/.test(ledgerHelpers),
  'paid status helper excludes non-paid rows');
check(/bcPaymentLedgerMethodLabel/.test(invFn) || /bcPaymentLedgerMethodLabel/.test(ledgerHelpers),
  'method/source label helper for ledger rows');
check(/BOOKING_PAYMENTS_LEDGER_SQL/.test(src),
  'context loads payment metadata for ledger');

console.log('\nC. Paid total rules');

check(/paymentLedgerPaidTotalCents\(paymentRows\)|bcPaymentLedgerPaidTotalCents\(paymentRows\)/.test(
  src.match(/async function handleBookingContext[\s\S]{0,3500}/)?.[0] || ''),
  'context totalPaid uses ledger paid helper');
check(/status = 'paid'::payment_record_status/.test(cashHandler),
  'cash payment inserts paid status');
check(!/checkout_created[\s\S]{0,40}bcPaymentLedgerPaidTotalCents/.test(ledgerHelpers),
  'ledger helper does not count checkout_created as paid');

console.log('\nD. Record cash payment UI');

check(/id="bc-record-cash-btn"/.test(cashFormFn), 'Record cash payment button');
check(/id="bc-cash-payment-save-btn"/.test(cashFormFn), 'Save payment button in cash form');
check(/id="bc-cash-payment-cancel-btn"/.test(cashFormFn), 'Cancel button in cash form');
check(/bcRenderCashPaymentFormHtml/.test(invFn),
  'running invoice renders cash payment form helper');
check(/bcInitCashPaymentShell/.test(src), 'cash payment shell init exists');
check(/bcInitCashPaymentShell\(res\.data\)/.test(src), 'drawer load initializes cash payment shell');
check(/record-cash-payment/.test(cashUi),
  'UI posts to record-cash-payment endpoint');
check(/loadBlockDetail\(bk\.booking_code\)/.test(cashUi),
  'cash payment success reloads drawer');

console.log('\nE. Record cash payment API');

check(/async function handleBookingRecordCashPayment/.test(src), 'cash payment handler exists');
check(/pathname === '\/staff\/bookings\/record-cash-payment'/.test(src), 'route registered');
check(/INSERT INTO payments/.test(cashHandler), 'creates payment row');
check(/'paid'::payment_record_status/.test(cashHandler), 'payment status is paid');
check(/staff_cash/.test(cashHandler), 'metadata source staff_cash');
check(/metadata->>'idempotency_key'/.test(cashHandler), 'idempotency lookup on payment metadata');
check(/idempotent:\s*true/.test(cashHandler), 'idempotent response path');
check(!/stripe\.checkout|createCheckout|checkout\.sessions\.create/.test(cashHandler),
  'no Stripe checkout in cash handler');
check(!/checkout_url/.test(cashHandler.match(/INSERT INTO payments[\s\S]{0,500}/)?.[0] || ''),
  'cash insert does not create payment link');

console.log('\nF. Phase 10.6f — Cancel unpaid payment link');

check(!/Paid total uses payment history/.test(invFn),
  'explanatory totals copy removed');
check(/btn-bc-cancel-link-icon/.test(invFn), 'icon-only cancel button in ledger');
check(/title="Cancel payment link"/.test(invFn) && /aria-label="Cancel payment link"/.test(invFn),
  'cancel button title and aria-label');
check(/bcPaymentLedgerCanCancelLinkRow/.test(invFn) || /bcPaymentLedgerCanCancelLinkRow/.test(ledgerHelpers),
  'client helper gates cancel button to cancellable rows');
check(/Cancel this payment link\?/.test(invFn), 'inline confirmation prompt');
check(/Confirm cancel/.test(invFn) && /Keep link/.test(invFn), 'confirm and keep buttons');
check(/does not refund or change paid totals/.test(invFn),
  'cancel warning about paid totals');
check(/async function handleBookingCancelPaymentLink/.test(src), 'cancel payment link handler');
check(/pathname === '\/staff\/bookings\/cancel-payment-link'/.test(src), 'cancel route registered');
check(/paymentLedgerCanCancelLinkRow/.test(src), 'server cancellable row helper');
check(/'cancelled'::payment_record_status/.test(cancelHandler),
  'sets payment status to cancelled');
check(!/DELETE FROM payments/.test(cancelHandler), 'does not delete payment rows');
check(!/amount_paid_cents\s*=/.test(cancelHandler),
  'does not mutate amount_paid_cents');
check(!/UPDATE bookings/.test(cancelHandler), 'does not update bookings table');
check(/idempotent:\s*true/.test(cancelHandler), 'idempotent when already cancelled');
check(/payment_already_paid|payment_not_cancellable/.test(cancelHandler),
  'blocks paid and non-cancellable rows');
check(/payment_booking_mismatch|payment_not_found/.test(cancelHandler),
  'verifies payment ownership');
check(/bcInitCancelPaymentLinkShell/.test(src), 'cancel link shell init');
check(/cancel-payment-link/.test(cancelUi), 'UI posts to cancel-payment-link');
check(/loadBlockDetail\(bk\.booking_code\)/.test(cancelUi),
  'cancel success reloads drawer');
check(/paymentLedgerIsCancelledLinkStatus/.test(src) || /bcPaymentLedgerIsCancelledLinkStatus/.test(src),
  'cancelled link rows excluded from active link logic');

console.log('\nG. Safety boundaries');

check(!/UPDATE booking_beds|INSERT INTO booking_beds|DELETE FROM booking_beds/.test(cashHandler + cancelHandler),
  'no booking_beds mutation in cash/cancel handlers');
check(!/booking_service_records/.test(cashHandler + cancelHandler),
  'no booking_service_records mutation in cash/cancel handlers');
check(!/graph\.facebook\.com/.test(cashHandler + cashUi + cancelHandler + cancelUi + invFn),
  'no WhatsApp in cash/cancel/ledger slice');
check(!/stripe\.checkout|checkout\.sessions\.expire/.test(cancelHandler + cancelUi),
  'no Stripe expire in cancel handler/UI');
check(!(/fetch[\s\S]{0,80}n8n|n8n\.cloud.*activate/i.test(cashHandler + cancelHandler)),
  'no n8n activation in cash/cancel handlers');
check(!/deploy-staff|az containerapp update/i.test(cashHandler + cashUi + cancelHandler),
  'no deploy scripts in slice');

console.log('\nH. Preserved features');

check(/bcRenderAddServicePanelHtml/.test(drawerFn), 'Add-ons panel preserved');
check(/id="bc-move-booking-btn"/.test(drawerFn), 'Move bed preserved');
check(/bcRenderBookingCancelFooterHtml/.test(drawerFn), 'Cancel footer preserved');

console.log('\nI. package.json script');

try {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(pkg.scripts && pkg.scripts['verify:staff-payment-records-ledger'],
    'package.json has verify:staff-payment-records-ledger script');
} catch (_) {
  fail('package.json readable');
}

console.log('\nJ. No docs / migration changes');

let docsChanged = false;
let migChanged = false;
try {
  docsChanged = execSync('git diff --name-only -- docs', { encoding: 'utf8', cwd: path.join(__dirname, '..') }).trim().length > 0;
  migChanged = execSync('git diff --name-only -- database/migrations', { encoding: 'utf8', cwd: path.join(__dirname, '..') }).trim().length > 0;
} catch (_) { /* ok */ }
check(!docsChanged, 'no docs changes in working tree');
check(!migChanged, 'no database/migrations changes in working tree');

console.log('\nResult: ' + passes + ' passed, ' + failures + ' failed\n');
if (failures > 0) process.exit(1);
