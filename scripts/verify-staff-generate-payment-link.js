/**
 * Phase 10.6c / 10.6g.4 — Generate payment link (no duplicate URL under button).
 *
 * Usage:
 *   npm run verify:staff-generate-payment-link
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

console.log('\nverify-staff-generate-payment-link.js  (Phase 10.6c / 10.6g.4)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const linkHandlerStart = src.indexOf('async function handleBookingGeneratePaymentLink');
const linkHandlerEnd = src.indexOf('// Phase 10.6a — Staff add service record', linkHandlerStart);
const linkHandler = linkHandlerStart >= 0 && linkHandlerEnd > linkHandlerStart
  ? src.slice(linkHandlerStart, linkHandlerEnd)
  : '';
const linkUiFn = src.match(/function bcRenderPaymentLinkSectionHtml[\s\S]*?\n\}/)?.[0] || '';
const linkInit = src.match(/function bcInitPaymentLinkShell[\s\S]*?\n\}/)?.[0] || '';
const cancelHandler = src.match(/async function handleBookingCancelPaymentLink[\s\S]*?\n\}/)?.[0] || '';
const cancelUi = src.match(/function bcInitCancelPaymentLinkShell[\s\S]*?\n\}/)?.[0] || '';
const invFn = src.match(/function bcRenderRunningInvoiceHtml[\s\S]*?\n\}/)?.[0] || '';
const ledgerUiSlice = src.match(/function bcPaymentLedgerSortRows[\s\S]*?function bcRenderPaymentLinkSectionHtml/)?.[0] || '';
const ledgerHelpers = src.match(/function paymentLedgerPaidTotalCents[\s\S]*?function bookingLedgerBalanceFromRows/)?.[0] || '';
const copyIconFn = src.match(/function bcCopyPaymentLinkIcon[\s\S]*?\n\}/)?.[0] || '';

console.log('\nA. Package script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check(pkg.scripts && pkg.scripts['verify:staff-generate-payment-link'],
  'package.json has verify:staff-generate-payment-link script');

console.log('\nB. Generate Payment Link UI (no duplicate URL)');

check(/Generate Payment Link/.test(linkUiFn), 'Generate Payment Link button label');
check(/id="bc-generate-payment-link-btn"/.test(linkUiFn), 'generate button id');
check(/id="bc-payment-link-result"/.test(linkUiFn), 'result area for confirmation only');
check(/bcRenderPaymentLinkSectionHtml/.test(invFn), 'running invoice renders payment link section');
check(/bcBookingStatusIsCancelled\(bk\.status\)/.test(linkUiFn),
  'cancelled booking hides payment link section');
check(!/bookingStatusIsCancelled\(/.test(linkUiFn),
  'payment link UI uses client bcBookingStatusIsCancelled helper');
check(/needsRefund/.test(linkUiFn) && /Refund \/ credit review/.test(linkUiFn),
  'refund review blocks payment link UI');
check(/paidInFull|balanceDue <= 0/.test(linkUiFn),
  'paid in full / zero balance hides generate button');
check(!/bc-payment-link-active/.test(linkUiFn),
  '10.6g.4: no active-link URL row under generate button');
check(!/bcRenderPaymentLinkUrlRowHtml/.test(linkUiFn),
  '10.6g.4: section does not render duplicate URL row helper');
check(!/bc-payment-link-copy-btn/.test(linkUiFn),
  '10.6g.4: no duplicate copy button under generate button');
check(!/checkout_url/.test(linkUiFn),
  '10.6g.4: generate section HTML has no checkout_url');
check(!/bcRenderPaymentLinkUrlRowHtml/.test(src),
  '10.6g.4: duplicate URL row helper removed from bundle');

console.log('\nC. Success message + history link display');

check(/Payment link ready in Payment history\./.test(linkInit),
  '10.6g.4: success points to Payment history');
check(!/res\.data\.payment_link_url|res\.data\.checkout_url/.test(linkInit),
  '10.6g.4: success handler does not inject raw checkout URL');
check(!/bc-payment-link-copy-btn/.test(linkInit),
  '10.6g.4: init does not wire duplicate copy under button');
check(/pr\.checkout_url/.test(invFn), 'Payment history row renders checkout_url');
check(/ctx-pay-record-url/.test(invFn), 'checkout link block in Payment history');
check(/bcCopyUrl\(this\)/.test(invFn) || /btn-bc-copy-link-icon/.test(invFn),
  'Payment history keeps copy control');
check(/btn-bc-cancel-link-icon/.test(invFn), 'Payment history cancel link icon');
check(/navigator\.clipboard\.writeText/.test(copyIconFn),
  'clipboard helper kept for manual-create copy icon');
check(!/bcCopyPaymentLinkIcon/.test(linkInit),
  'generate init does not wire section copy icon');

console.log('\nD. API endpoint');

check(/async function handleBookingGeneratePaymentLink/.test(src), 'handler exists');
check(/pathname === '\/staff\/bookings\/generate-payment-link'/.test(src), 'route registered');
check(/requireAuth\(req, res, 'operator'\)/.test(
  src.slice(src.indexOf("pathname === '/staff/bookings/generate-payment-link'"),
    src.indexOf("pathname === '/staff/bookings/generate-payment-link'") + 600),
), 'operator auth on route');
check(/bookingLedgerBalanceFromRows/.test(linkHandler),
  'balance from invoice total minus paid ledger');
check(/bookingLedgerBalanceFromRows/.test(linkHandler) && /paymentLedgerPaidTotalCents/.test(ledgerHelpers),
  'uses ledger paid total in balance calculation');
check(/no_payment_due/.test(linkHandler), 'no_payment_due response');
check(/refund_review_needed/.test(linkHandler), 'refund_review_needed response');
check(/stripe\.checkout\.sessions\.create/.test(linkHandler),
  'Stripe checkout session created in generate handler');
check((linkHandler.match(/stripe\.checkout\.sessions\.create/g) || []).length === 1,
  'exactly one Stripe session create in generate handler');

console.log('\nE. Payment record + no paid truth');

check(/INSERT INTO payments/.test(linkHandler), 'creates payment row');
check(/'draft'::payment_record_status/.test(linkHandler), 'starts as draft');
check(/'checkout_created'::payment_record_status/.test(linkHandler), 'updates to checkout_created');
check(/amount_paid_cents, 0|amount_paid_cents = 0|\$3, 0/.test(linkHandler),
  'amount_paid_cents stays zero on insert');
check(!/UPDATE bookings[\s\S]{0,800}amount_paid_cents/.test(linkHandler),
  'handler does not update booking amount_paid_cents');
check(!/'paid'::payment_record_status/.test(linkHandler),
  'handler does not mark payment paid');
check(/checkout_url/.test(linkHandler), 'stores checkout_url');
check(/payment_link_url/.test(linkHandler), 'returns payment_link_url');
check(/staff_payment_link/.test(linkHandler), 'metadata source staff_payment_link');
check(/send_mutation:\s*false/.test(linkHandler), 'send_mutation false in response');

console.log('\nF. Idempotency');

check(/idempotent:\s*true/.test(linkHandler), 'idempotent response path');
check(/ledgerActivePaymentLinkRow/.test(linkHandler) || /ledgerActivePaymentLinkRow/.test(src),
  'reuses active link for same amount');
check(/idempotency_key/.test(linkHandler), 'idempotency_key in metadata');

console.log('\nG. Drawer reload + history');

check(/bcInitPaymentLinkShell\(res\.data\)/.test(src), 'drawer init payment link shell');
check(/loadBlockDetail\(bk\.booking_code\)/.test(linkInit),
  'success reloads drawer for payment history');
check(/generate-payment-link/.test(linkInit), 'UI posts to generate-payment-link');
check(/return 'Stripe link created/.test(src),
  'history shows awaiting-payment label for link rows');
check(/bcPaymentLedgerIsPaidStatus/.test(invFn) || /bcPaymentLedgerIsPaidStatus/.test(ledgerHelpers),
  'paid helper excludes link rows from Paid total');
check(/ctx-pay-record-checkout/.test(invFn), 'checkout link styling in history');

console.log('\nH. Phase 10.6f — cancel link + regenerate');

check(!/Paid total uses payment history/.test(invFn),
  'explanatory totals copy removed');
check(/paymentLedgerIsCancelledLinkStatus/.test(ledgerHelpers) || /bcPaymentLedgerIsCancelledLinkStatus/.test(src),
  'cancelled rows skipped for active link');
check(/ledgerActivePaymentLinkRow/.test(ledgerHelpers) && /paymentLedgerIsCancelledLinkStatus/.test(ledgerHelpers),
  'active link helper ignores cancelled rows');
check(/async function handleBookingCancelPaymentLink/.test(src), 'cancel handler exists');
check(/pathname === '\/staff\/bookings\/cancel-payment-link'/.test(src), 'cancel route registered');
check(/'cancelled'::payment_record_status/.test(cancelHandler), 'void sets cancelled status');
check(!/UPDATE bookings/.test(cancelHandler), 'cancel does not change booking paid total');
check(/bcInitCancelPaymentLinkShell\(res\.data\)/.test(src), 'drawer init cancel shell');
check(/loadBlockDetail\(bk\.booking_code\)/.test(cancelUi),
  'after cancel reload enables fresh generate state');

console.log('\nI. Phase 10.6f.1 — stale link + generate behavior');

check(/paymentLedgerIsStaleUnpaidLinkRow/.test(ledgerHelpers),
  'server stale link helper in ledger block');
check(/ledgerActivePaymentLinkRow[\s\S]{0,400}paymentLedgerIsStaleUnpaidLinkRow/.test(ledgerHelpers),
  'active link reuse skips stale wrong-amount rows');
check(/paymentLinkIntendedAmountCents/.test(ledgerHelpers),
  '10.6g.2: active link matches intended amount (deposit vs balance)');
check(/deposit_only/.test(ledgerHelpers),
  '10.6g.2: deposit link kind in server stale helper');
check(/bcPaymentLedgerIsStaleUnpaidLinkRow/.test(ledgerUiSlice),
  'UI stale link detection in payment history');
check(/Outdated amount/.test(ledgerUiSlice), 'stale badge in payment history');
check(/Current balance changed\. Generate a new link\./.test(ledgerUiSlice),
  'stale guidance allows new link generation');
check(/bcPaymentLinkIntendedAmountCents/.test(src),
  '10.6g.2: UI intended payment amount helper');

console.log('\nJ. Safety boundaries');

check(!/sendWhatsApp|whatsapp\.com|triggerN8n|n8n\.webhook|fetch\([^)]*n8n/i.test(linkHandler + cancelHandler),
  'no WhatsApp/n8n calls in handler');
check(/no_whatsapp:\s*true/.test(linkHandler) && /n8n_called:\s*false/.test(linkHandler),
  'response flags no WhatsApp/n8n send');
check(!/UPDATE booking_beds|INSERT INTO booking_beds|DELETE FROM booking_beds/.test(linkHandler),
  'no booking_beds mutation');
check(!/booking_service_records/.test(linkHandler),
  'no booking_service_records mutation');
check(!/database\/migrations|run-sql\.js/.test(linkHandler), 'no migrations in handler');
check(!/deploy|production/i.test(linkHandler), 'no deploy/production in handler');

const bookingGenRouteOnly = /handleBookingGeneratePaymentLink/.test(src);
check(bookingGenRouteOnly, 'booking generate handler is the 10.6c Stripe entry for balance');

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
