/**
 * Phase 10.6d / 10.6d.1 / 10.6d.2 — Manual booking payment choices + UI polish.
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
const PRICING_FILE = path.join(__dirname, '..', 'config', 'clients', 'wolfhouse-somo.pricing.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

function staffStripeLinkLeak(text) {
  return /\bStripe(?:\s+(?:link|payment|deposit|full(?:-payment)?\s+link))|\bStripe links are\b/i.test(String(text || ''));
}

console.log('\nverify-staff-manual-booking-payment-choice.js  (Phase 10.6d / 10.6d.1 / 10.6d.2)\n');

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
const applyStart = src.indexOf('async function manualBookingApplyStaffPaymentChoice');
const applyEnd = src.indexOf('\nasync function handleManualBookingCreate', applyStart + 20);
const applyFn = applyStart > 0
  ? src.slice(applyStart, applyEnd > 0 ? applyEnd : applyStart + 10000)
  : (src.match(/async function manualBookingApplyStaffPaymentChoice[\s\S]*?\n\}/)?.[0] || '');
const selPanel = src.match(/id="bc-sel-panel"[\s\S]*?id="bc-create-result"/)?.[0] || '';
const uiHtml = src.match(/Section: Payment[\s\S]*?Section: Notes/)?.[0] || '';
const createFn = src.match(/function runManualBookingCreate[\s\S]*?\n\}/)?.[0] || '';
const resultFn = src.match(/function renderCreateResult[\s\S]*?\n\}/)?.[0] || '';
const quoteFn = src.match(/function renderQuoteResult[\s\S]*?\n\}/)?.[0] || '';
const paidFieldsFn = src.match(/function bcUpdateManualBookingPaidFields[\s\S]*?\n\}/)?.[0] || '';
const createBtnFn = src.match(/function bcUpdateCreateButton[\s\S]*?\n\}/)?.[0] || '';
const buildAddonsFn = src.match(/function buildAddOns[\s\S]*?\n\}/)?.[0] || '';
const ledgerFn = src.match(/function paymentLedgerPaidTotalCents[\s\S]*?\n\}/)?.[0] || '';
const bannerBlock = src.match(/<div id="banner">[\s\S]*?<\/div>\s*\n\s*<!-- ── Tabs/)?.[0] || '';
const todayTab = src.match(/<div id="tab-today"[\s\S]*?<!-- Needs Attention tiles -->/)?.[0] || '';

console.log('\nA. Package script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check(
  pkg.scripts && pkg.scripts['verify:staff-manual-booking-payment-choice'],
  'package.json has verify:staff-manual-booking-payment-choice script',
);

console.log('\nB. Payment choice UI options');

check(/value="stripe_deposit">Deposit payment link/.test(uiHtml), 'Deposit payment link option');
check(/value="stripe_full">Full secure payment link/.test(uiHtml), 'Full secure payment link option');
check(!staffStripeLinkLeak(uiHtml), 'payment choice UI avoids Stripe link staff-facing labels');
check(/payment link|secure payment link/i.test(uiHtml), 'payment choice UI uses payment link wording');
check(/value="paid_cash">Already paid cash/.test(uiHtml), 'Already paid cash option');
check(/value="paid_bank_transfer">Already paid bank transfer/.test(uiHtml), 'Already paid bank transfer option');
check(/value="no_payment_yet">No payment yet/.test(uiHtml), 'No payment yet option');
check(/id="bk-paid-amount-type"/.test(uiHtml), 'paid_amount_type select');
check(/value="custom">Custom amount/.test(uiHtml), 'custom paid amount type');
check(/function bcUpdateManualBookingPaidFields/.test(paidFieldsFn), 'paid fields toggle helper');
check(/paid_amount_type/.test(createFn), 'create payload sends paid_amount_type');
check(/paid_amount_cents/.test(createFn), 'create payload can send paid_amount_cents');
check(/source:\s*source/.test(createFn), 'create payload sends source (staff channel metadata)');
check(!/deposit_amount_cents|total_amount_cents/.test(createFn), 'create payload does not send quote totals');

console.log('\nC. Phase 10.6d.1 — create flow polish');

check(!/id="bc-safety-notice"/.test(selPanel), 'green safety banner element removed');
check(!/MANUAL_BOOKING_ENABLED=true, STAFF_ACTIONS_ENABLED=true/.test(src),
  'green flag banner copy removed');
check(!/id="bc-sel-conflicts"/.test(selPanel), 'Preview Conflicts button removed');
check(!/function runPreviewConflicts/.test(src), 'runPreviewConflicts removed');
check(/id="bc-sel-create"/.test(selPanel), 'Create New Booking button present');
check(/Create New Booking/.test(selPanel), 'Create New Booking label in panel');
check(!/Create Manual Booking/.test(selPanel), 'Create Manual Booking label removed from panel');
check(/btn-bc-quote-soft/.test(selPanel) && /\.btn-bc-quote-soft/.test(src),
  'Calculate Quote uses soft yellow btn-bc-quote-soft');
check(/btn-bc-create-soft/.test(selPanel) && /\.btn-bc-create-soft/.test(src),
  'Create New Booking uses soft green btn-bc-create-soft');
check(/btn-bc-create-soft:disabled/.test(src) && !/\.bc-sel-create-btn\{opacity/.test(src),
  'create disabled styling scoped to :disabled (enabled button not dimmed)');
check(/bcFetchManualBookingAvailability/.test(createFn),
  'create runs internal availability check');
check(/bcSelectedBedCodes/.test(src) && /bcSelectedBeds\.map/.test(createFn),
  'create uses bcSelectedBeds bed_code list');
check(!/bcSel\.bed_code/.test(createFn), 'create does not use invalid bcSel.bed_code');
check(/bcLastQuote/.test(createBtnFn) && !/phone/.test(createBtnFn.match(/var ready[\s\S]*?btn\.disabled/)?.[0] || ''),
  'create enables after quote without requiring phone');
check(/bcUpdateCreateButton/.test(src.match(/function bcApplySelectionHighlight[\s\S]*?\n\}/)?.[0] || ''),
  'selection highlight updates create button state');
check(/btn\.disabled = !ready/.test(createBtnFn),
  'create button disabled only when required fields or quote missing');
check(/bcLastQuote = \(q && q\.success\)[\s\S]*?bcUpdateCreateButton\(\)/.test(src),
  'quote success triggers bcUpdateCreateButton');

console.log('\nD. Quote preview clarity');

check(/bk-quote-section-title">Accommodation/.test(quoteFn), 'quote Accommodation section');
check(/bk-quote-section-title">Deposit/.test(quoteFn), 'quote Deposit section');
check(/bk-quote-section-title">Selected payment/.test(quoteFn), 'quote Selected payment section');
check(/bk-quote-section-title">After create/.test(quoteFn), 'quote After create section');
check(/bcQuoteSelectedPaymentLabel/.test(quoteFn), 'selected payment label helper');
check(/bcQuotePaidNowCents/.test(quoteFn), 'paid-now helper for after-create balance');
check(/bcQuoteAccommodationNote/.test(quoteFn), 'accommodation note uses euro display helper');
const noteStart = src.indexOf('function bcQuoteAccommodationNote');
const noteEnd = src.indexOf('\nfunction renderQuoteResult', noteStart + 20);
const noteFn = noteStart > 0
  ? src.slice(noteStart, noteEnd > 0 ? noteEnd : noteStart + 3000)
  : '';
check(/fmtEur\(/.test(noteFn) && /bcQuoteReplaceCentDigits|bcQuoteDigitsBeforeCent/.test(noteFn),
  'accommodation formula converts cent markers to euro display');
check(/fmtEur\(li\.total_cents\)/.test(quoteFn),
  'quote line items show accommodation totals via fmtEur not raw cents');
check(!/bk-quote-item-amount'>[\s\S]{0,40}li\.total_cents/.test(quoteFn),
  'quote UI does not render raw cent values in amount cells');
check(!/formula_summary/.test(quoteFn), 'formula_summary not shown in quote UI');
const quoteSuccessSlice = quoteFn.slice(quoteFn.indexOf("var html = '<div class=\"bk-quote-items\">'"));
check(!/bk-preview-warn/.test(quoteSuccessSlice), 'quote success path has no bottom warning banners');
check(!/quoteWarnings/.test(quoteSuccessSlice), 'quote success path does not render warning footer');
check(!/Payment link amount/.test(quoteFn), 'duplicate payment link amount row removed');
check(/bcRefreshQuotePreviewDisplay/.test(src), 'payment choice refreshes quote display');

console.log('\nE. Handler — staff payment choices');

check(/MANUAL_BOOKING_STAFF_PAYMENT_CHOICES/.test(src), 'staff payment choice set defined');
check(/normalizeManualBookingStaffPaymentChoice/.test(handler), 'handler normalizes payment_choice');
check(/manualBookingApplyStaffPaymentChoice/.test(handler), 'handler calls apply payment choice');
check(/payment_choice must be one of: stripe_deposit/.test(handler), 'invalid choice rejected');
check(/sqlDepositCents/.test(handler), 'sql deposit cents skips legacy SQL draft for paid/no_payment/stripe');
check(/staffPayChoice === 'stripe_deposit'/.test(handler) && /staffPayChoice === 'stripe_full'/.test(handler),
  'stripe choices skip legacy SQL draft payment insert');
check(/payment_link_url/.test(handler.slice(handler.indexOf('return sendJSON(res, 201'))),
  'success response includes payment_link_url');
check(/payment_choice:\s*staffPayChoice/.test(handler), 'success response includes payment_choice');

console.log('\nF. Stripe deposit / full at create');

check(/manualBookingAmountDueForStaffChoice/.test(src)
  && /staffChoice === 'stripe_deposit'/.test(src),
  'deposit amount from manualBookingAmountDueForStaffChoice');
check(/staffChoice === 'stripe_full'/.test(src) && /manualBookingAmountDueForStaffChoice/.test(src),
  'full amount from manualBookingAmountDueForStaffChoice');
check(/stripe\.checkout\.sessions\.create/.test(applyFn), 'Stripe session created in apply');
check(/'checkout_created'::payment_record_status/.test(applyFn), 'payment row checkout_created');
check(/amount_paid_cents = 0/.test(applyFn), 'Stripe rows keep amount_paid_cents zero');
check(/staff_manual_stripe/.test(applyFn), 'metadata source staff_manual_stripe');
const stripeBlockStart = applyFn.indexOf('const amountDueCents = manualBookingAmountDueForStaffChoice');
const stripeBlock = stripeBlockStart > 0 ? applyFn.slice(stripeBlockStart) : '';
const cashBankStart = applyFn.indexOf("staffPaymentChoice === 'paid_cash'");
const cashBankBlock = cashBankStart > 0 && stripeBlockStart > cashBankStart
  ? applyFn.slice(cashBankStart, stripeBlockStart)
  : '';
check(stripeBlock.length > 0 && !/UPDATE bookings[\s\S]{0,120}SET amount_paid_cents/.test(stripeBlock),
  'Stripe apply path does not set booking amount_paid from link row');
check(/SUM\(amount_paid_cents\)/.test(cashBankBlock)
  && /status = 'paid'::payment_record_status/.test(cashBankBlock)
  && /SET amount_paid_cents/.test(cashBankBlock),
  'cash/bank path updates booking amount_paid from paid ledger sum');
check(!/checkout_created::payment_record_status/.test(cashBankBlock),
  'cash/bank path does not treat checkout_created as paid');

console.log('\nG. Cash / bank paid at create');

check(/staff_cash/.test(applyFn), 'cash source staff_cash');
check(/staff_bank_transfer/.test(applyFn), 'bank source staff_bank_transfer');
check(/'paid'::payment_record_status/.test(applyFn), 'paid status for cash/bank');
check(/paid_cash/.test(applyFn) && /paid_bank_transfer/.test(applyFn), 'paid_cash and paid_bank_transfer branches');
check(/no_payment_yet/.test(applyFn), 'no_payment_yet branch');
check(cashBankBlock.length > 0 && /paymentLedgerIsPaidStatus|status = 'paid'::payment_record_status/.test(applyFn),
  'paid ledger truth uses paid status only (not draft/checkout_created)');

console.log('\nH. Ledger + create result UI');

check(/function paymentLedgerPaidTotalCents/.test(src)
  && /paymentLedgerIsPaidStatus/.test(ledgerFn)
  && /checkout_created/.test(src),
  'ledger counts paid only for paid status (not checkout_created)');
check(/payment_link_url/.test(resultFn), 'create result shows payment_link_url');
check(/bc-create-payment-link-copy-btn/.test(resultFn), 'copy icon on create result link');
check(/btn-bc-copy-link-icon/.test(resultFn), 'icon-only copy on create result');
check(/bcOpenDrawerAfterManualCreate/.test(createFn) || /loadBedCalendar/.test(createFn),
  'drawer reload after create');

console.log('\nI. Safety');

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

console.log('\nJ. Phase 10.6d.2 — banner, yoga note, meals pricing');

check(!/READ-ONLY\s*&bull;\s*SHADOW MODE/.test(bannerBlock),
  'global top banner READ-ONLY SHADOW MODE badge removed');
check(!/Shadow Mode active/.test(todayTab) && !/No operations affect live guest data/.test(todayTab),
  'Today tab shadow-mode hero copy removed');
check(!/booked and paid on site.*confirm with staff/i.test(selPanel),
  'manual booking panel has no yoga on-site staff note');
check(!/bk-ao-meals-note/.test(selPanel) && !/not priced in quote yet/i.test(selPanel),
  'meals on-site / not priced note removed');
check(/bcQuoteAccommodationNote/.test(src),
  'quote preview formats accommodation formula in euros');
check(!/quoteWarnings/.test(quoteFn.slice(quoteFn.indexOf("var html = '<div class=\"bk-quote-items\">'"))),
  'quote preview omits bottom warning banner area');
check(/code: 'meals'/.test(buildAddonsFn), 'buildAddOns sends meals add-on to quote');
if (fs.existsSync(PRICING_FILE)) {
  const pricing = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8'));
  const meals = pricing.add_ons && pricing.add_ons.meals;
  check(meals && meals.price_cents === 1500, 'wolfhouse add_ons.meals price_cents = 1500');
} else {
  fail('wolfhouse-somo.pricing.json exists for meals price check');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
