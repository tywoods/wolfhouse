/**
 * Phase 10.6d — Manual booking payment choice at create + payment history.
 *
 * Usage:
 *   npm run verify:staff-manual-booking-payment-choice
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

console.log('\nverify-staff-manual-booking-payment-choice.js  (Phase 10.6d)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const hStart = src.indexOf('async function handleManualBookingCreate');
const hEnd   = src.indexOf('\n// ───', hStart + 50);
const handler = hStart > 0 ? src.slice(hStart, hEnd > 0 ? hEnd : hStart + 15000) : '';
const applyFn = src.match(/async function manualBookingApplyStaffPaymentChoice[\s\S]*?\n\}/)?.[0] || '';
const uiHtml = src.match(/Section: Payment[\s\S]*?Section: Notes/)?.[0] || '';
const createFn = src.match(/function runManualBookingCreate[\s\S]*?\n\}/)?.[0] || '';
const resultFn = src.match(/function renderCreateResult[\s\S]*?\n\}/)?.[0] || '';
const paidFieldsFn = src.match(/function bcUpdateManualBookingPaidFields[\s\S]*?\n\}/)?.[0] || '';
const ledgerFn = src.match(/function paymentLedgerPaidTotalCents[\s\S]*?\n\}/)?.[0] || '';

console.log('\nA. Package script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check(
  pkg.scripts && pkg.scripts['verify:staff-manual-booking-payment-choice'],
  'package.json has verify:staff-manual-booking-payment-choice script',
);

console.log('\nB. Payment choice UI options');

check(/value="stripe_deposit">Stripe deposit link/.test(uiHtml), 'Stripe deposit link option');
check(/value="stripe_full">Stripe full payment link/.test(uiHtml), 'Stripe full payment link option');
check(/value="paid_cash">Already paid cash/.test(uiHtml), 'Already paid cash option');
check(/value="paid_bank_transfer">Already paid bank transfer/.test(uiHtml), 'Already paid bank transfer option');
check(/value="no_payment_yet">No payment yet/.test(uiHtml), 'No payment yet option');
check(/id="bk-paid-amount-type"/.test(uiHtml), 'paid_amount_type select');
check(/value="custom">Custom amount/.test(uiHtml), 'custom paid amount type');
check(/function bcUpdateManualBookingPaidFields/.test(paidFieldsFn), 'paid fields toggle helper');
check(/paid_amount_type/.test(createFn), 'create payload sends paid_amount_type');
check(/paid_amount_cents/.test(createFn), 'create payload can send paid_amount_cents');

console.log('\nC. Handler — staff payment choices');

check(/MANUAL_BOOKING_STAFF_PAYMENT_CHOICES/.test(src), 'staff payment choice set defined');
check(/normalizeManualBookingStaffPaymentChoice/.test(handler), 'handler normalizes payment_choice');
check(/manualBookingApplyStaffPaymentChoice/.test(handler), 'handler calls apply payment choice');
check(/payment_choice must be one of: stripe_deposit/.test(handler), 'invalid choice rejected');
check(/sqlDepositCents/.test(handler), 'sql deposit cents skips draft for paid/no_payment');
check(/payment_link_url/.test(handler.slice(handler.indexOf('return sendJSON(res, 201'))),
  'success response includes payment_link_url');
check(/payment_choice:\s*staffPayChoice/.test(handler), 'success response includes payment_choice');

console.log('\nD. Stripe deposit / full at create');

check(/manualBookingAmountDueForStaffChoice/.test(src)
  && /staffChoice === 'stripe_deposit'/.test(src),
  'deposit amount from manualBookingAmountDueForStaffChoice');
check(/staffChoice === 'stripe_full'/.test(src) && /manualBookingAmountDueForStaffChoice/.test(src),
  'full amount from manualBookingAmountDueForStaffChoice');
check(/stripe\.checkout\.sessions\.create/.test(applyFn), 'Stripe session created in apply');
check(/'checkout_created'::payment_record_status/.test(applyFn), 'payment row checkout_created');
check(/amount_paid_cents = 0/.test(applyFn), 'Stripe rows keep amount_paid_cents zero');
check(/staff_manual_stripe/.test(applyFn), 'metadata source staff_manual_stripe');
const stripeBlock = applyFn.slice(applyFn.indexOf('if (!STRIPE_LINKS_ENABLED'));
check(!/SET amount_paid_cents/.test(stripeBlock),
  'Stripe apply path does not set booking amount_paid from link row');
check(/SET amount_paid_cents/.test(applyFn.slice(0, stripeBlock.length || applyFn.length)),
  'cash/bank path updates booking amount_paid from paid ledger');

console.log('\nE. Cash / bank paid at create');

check(/staff_cash/.test(applyFn), 'cash source staff_cash');
check(/staff_bank_transfer/.test(applyFn), 'bank source staff_bank_transfer');
check(/'paid'::payment_record_status/.test(applyFn), 'paid status for cash/bank');
check(/paid_cash/.test(applyFn) && /paid_bank_transfer/.test(applyFn), 'paid_cash and paid_bank_transfer branches');
check(/no_payment_yet/.test(applyFn), 'no_payment_yet branch');

console.log('\nF. Ledger + create result UI');

check(/function paymentLedgerPaidTotalCents/.test(src)
  && /paymentLedgerIsPaidStatus/.test(ledgerFn)
  && /checkout_created/.test(src),
  'ledger counts paid only for paid status (not checkout_created)');
check(/payment_link_url/.test(resultFn), 'create result shows payment_link_url');
check(/bc-create-payment-link-copy-btn/.test(resultFn), 'copy icon on create result link');
check(/btn-bc-copy-link-icon/.test(resultFn), 'icon-only copy on create result');
check(/bcOpenDrawerAfterManualCreate/.test(createFn) || /loadBedCalendar/.test(createFn),
  'drawer reload after create');

console.log('\nG. Safety');

check(!/graph\.facebook\.com/.test(handler + applyFn + createFn),
  'no WhatsApp graph API in manual create path');
check(!/n8n\.cloud|activate.*workflow/i.test(handler + applyFn),
  'no n8n activation in manual create payment path');
const stripeInsert = applyFn.slice(applyFn.indexOf('STRIPE_NOT_CONFIGURED'));
check(!/'paid'::payment_record_status/.test(stripeInsert.slice(0, 1200)),
  'Stripe block does not mark payment paid');
check(!/send_mutation:\s*true/.test(handler), 'handler does not set send_mutation true');
check(/send_mutation:\s*false/.test(handler), 'success response send_mutation false');
check(!/INSERT INTO booking_beds|UPDATE booking_beds|DELETE FROM booking_beds/.test(applyFn),
  'apply does not mutate booking_beds');
check(!/docs\//.test(path.basename(__filename)), 'verifier is not under docs');

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
