/**
 * Phase 26i — Manual booking quote fixes + transfer totals + live balance pebbles.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-manual-booking-quote-fixes
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const QUOTE = path.join(ROOT, 'scripts', 'lib', 'wolfhouse-quote-calculator.js');
const INVOICE = path.join(ROOT, 'scripts', 'lib', 'booking-invoice-totals.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26i-MANUAL-BOOKING-QUOTE-FIXES.md');
const PKG = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-manual-booking-quote-fixes';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-luna-agent-phase26-manual-booking-quote-fixes.js  (Phase 26i)\n');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  execSync(`node --check "${QUOTE}"`, { stdio: 'pipe' });
  execSync(`node --check "${INVOICE}"`, { stdio: 'pipe' });
  pass('0', 'syntax check');
} catch {
  fail('0', 'syntax check');
}

const apiSrc = readOrEmpty(API);
const quoteSrc = readOrEmpty(QUOTE);
const lookupHandler = apiSrc.match(/async function handlePostBookingTransfer[\s\S]{0,1200}/)?.[0] || '';

section('A. Transfer invoice totals module');

const {
  sumActiveTransferChargesCents,
  transferInvoiceLineItems,
  isActiveTransferForInvoice,
} = require('./lib/booking-invoice-totals');

const rows = [
  { direction: 'arrival', status: 'requested', price_cents: 2500 },
  { direction: 'departure', status: 'confirmed', price_cents: 6000 },
  { direction: 'departure', status: 'not_needed', price_cents: 6000 },
  { direction: 'arrival', status: 'cancelled', price_cents: 1000 },
  { direction: 'arrival', status: 'requested', price_cents: 0 },
];
if (sumActiveTransferChargesCents(rows) === 8500) pass('A1', 'active transfer charges summed');
else fail('A1', 'transfer sum');
if (transferInvoiceLineItems(rows).length === 2) pass('A2', 'invoice line items for active only');
else fail('A2', 'line items');
if (!isActiveTransferForInvoice({ status: 'requested', price_cents: 0 })) pass('A3', 'price 0 excluded');
else fail('A3', 'zero price');

section('B. Ledger + invoice wiring');

if (/sumActiveTransferChargesCents/.test(apiSrc) && /transferInvoiceLineItems/.test(apiSrc)) {
  pass('B1', 'staff-query-api imports transfer totals');
} else fail('B1', 'imports');
if (/bc-inv-transfers/.test(apiSrc) && /Transfers/.test(apiSrc)) pass('B2', 'running invoice Transfers section');
else fail('B2', 'transfers section');
if (/bookingLedgerInvoicePaidBalance\([\s\S]*transferDueCents/.test(apiSrc)) pass('B3', 'server ledger includes transferDue');
else fail('B3', 'server ledger');
if (/bookingLedgerBalanceFromRows\([\s\S]*transferRows/.test(apiSrc)) pass('B4', 'payment link ledger uses transferRows');
else fail('B4', 'payment link ledger');
if (!lookupHandler.includes('INSERT INTO payments')) pass('B5', 'transfer save route no payment insert');
else fail('B5', 'transfer payment write');

section('C. Manual booking UI + package defaults');

if (/Add Services/.test(apiSrc) && !/bk-form-section-title">Add-ons/.test(apiSrc)) {
  pass('C1', 'Create New Booking heading Add Services');
} else fail('C1', 'Add Services heading');
if (/Manual Price Override/.test(apiSrc) && /bk-manual-price-night/.test(apiSrc)) {
  pass('C2', 'Manual Price Override + Price per night input');
} else fail('C2', 'manual override UI');
if (/bcApplyDefaultPackageForStay/.test(apiSrc) && /nights < 7 \? 'package_none' : 'malibu'/.test(apiSrc)) {
  pass('C3', 'package default by stay length');
} else fail('C3', 'package defaults');
if (/bcPackageUserSelected/.test(apiSrc)) pass('C4', 'manual package selection preserved');
else fail('C4', 'user selection flag');

section('D. No package + manual override quote engine');

const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');

function ceil5(cents) { return Math.ceil(cents / 500) * 500; }

const noPkg = calculateWolfhouseQuote({
  client_slug: 'wolfhouse-somo',
  check_in: '2026-04-10',
  check_out: '2026-04-13',
  guest_count: 1,
  package_code: 'package_none',
  room_type: 'shared',
  payment_choice: 'deposit',
  add_ons: [],
});
if (noPkg.success && noPkg.package_code === 'package_none') pass('D1', 'no package quote succeeds');
else fail('D1', 'no package quote');
if (!((noPkg.blockers || []).join(' ')).includes('unknown package_code')) {
  pass('D2', 'no unknown package_code package_none');
} else fail('D2', 'unknown package error');
const malibuWeekly = 24900;
const expectedNight = ceil5(malibuWeekly / 7);
if (noPkg.line_items && noPkg.line_items[0] && noPkg.line_items[0].unit_cents === expectedNight) {
  pass('D3', 'no package nightly Malibu/7 ceil5');
} else fail('D3', 'nightly ceil5');
if (noPkg.total_cents === expectedNight * 3 * 1) pass('D4', 'no package total nights × guests');
else fail('D4', 'no package total');

const manual = calculateWolfhouseQuote({
  client_slug: 'wolfhouse-somo',
  check_in: '2026-04-10',
  check_out: '2026-04-13',
  guest_count: 2,
  package_code: 'manual_override',
  manual_price_per_night_cents: 4000,
  room_type: 'shared',
  payment_choice: 'deposit',
  add_ons: [],
});
if (manual.success && manual.total_cents >= 4000 * 3 * 2) pass('D5', 'manual override uses price/night');
else fail('D5', 'manual override quote');

const manualBad = calculateWolfhouseQuote({
  client_slug: 'wolfhouse-somo',
  check_in: '2026-04-10',
  check_out: '2026-04-13',
  guest_count: 1,
  package_code: 'manual_override',
  room_type: 'shared',
  payment_choice: 'deposit',
  add_ons: [],
});
if (!manualBad.success && (manualBad.blockers || []).some((b) => /Manual Price Override/i.test(b))) {
  pass('D6', 'invalid manual price blocks safely');
} else fail('D6', 'manual price block');

section('E. Services multi Add/Remove');

if (/bc-add-ons-entry-rows/.test(apiSrc) && /Add another service/.test(apiSrc)) pass('E1', 'multi service add rows');
else fail('E1', 'multi add UI');
if (/Confirm Add/.test(apiSrc) && /bcAddServiceCollectEntryRows/.test(apiSrc)) pass('E2', 'Confirm Add all rows');
else fail('E2', 'confirm add all');
if (/remove-select.*multiple|multiple size/.test(apiSrc.replace(/\s+/g, ' '))) pass('E3', 'multi-select remove');
else fail('E3', 'multi remove select');
if (/booking_service_record_ids/.test(apiSrc)) pass('E4', 'batch remove API ids');
else fail('E4', 'batch remove API');
if (/bcAddServiceUpdateRemoveConfirmState/.test(apiSrc) && /bcOpenRemoveServiceForm/.test(apiSrc)) {
  pass('E5', 'Confirm Remove re-enable after remove');
} else fail('E5', 'confirm remove fix');
if (/bcRefreshServicesTabAfterMutation/.test(apiSrc) && /bcRefreshBookingFinancialSummary/.test(apiSrc)) {
  pass('E6', 'service mutation refreshes financial summary');
} else fail('E6', 'service financial refresh');

section('F. Live payment / balance pebbles');

if (/function bcRefreshBookingFinancialSummary/.test(apiSrc)) pass('F1', 'financial summary helper');
else fail('F1', 'helper exists');
if (/bcRefreshCalendarBlockPaymentPebbles/.test(apiSrc)) pass('F2', 'calendar block pebble refresh');
else fail('F2', 'calendar refresh');
if (/updateBcDetailHeader/.test(apiSrc) && /bcRefreshBookingFinancialSummary/.test(apiSrc)) {
  pass('F3', 'header pebble update wired');
} else fail('F3', 'header update');
if (/bcRefreshBookingFinancialSummary\([\s\S]*activeTab: 'payments'/.test(apiSrc)) {
  pass('F4', 'payment link success keeps Payments tab + refresh');
} else fail('F4', 'payment link refresh');
if (!/whatsapp|guest_message_send/i.test(apiSrc.match(/function bcInitPaymentLinkShell[\s\S]{0,2500}/)?.[0] || '')) {
  pass('F5', 'payment link shell no WhatsApp send');
} else fail('F5', 'WhatsApp in payment link');

section('G. API create + quote preview');

if (/manual_price_per_night_cents/.test(apiSrc) && /storagePackageCode/.test(apiSrc)) {
  pass('G1', 'manual booking create accepts manual price + storage package');
} else fail('G1', 'manual create');
if (/handleQuotePreview[\s\S]{0,2000}manual_price_per_night_cents/.test(apiSrc)) pass('G2', 'quote preview passes manual price');
else fail('G2', 'quote preview manual');

section('H. Docs + npm');

const doc = readOrEmpty(DOC);
if (/transfer charges|Transfers section/i.test(doc)) pass('H1', 'doc transfers');
else fail('H1', 'doc transfers');
if (/Manual Price Override|Price per night/i.test(doc)) pass('H2', 'doc manual override');
else fail('H2', 'doc manual');
if (/bcRefreshBookingFinancialSummary|live.*balance/i.test(doc)) pass('H3', 'doc live balance');
else fail('H3', 'doc balance');
const pkg = JSON.parse(readOrEmpty(PKG) || '{}');
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('H4', 'npm script registered');
else fail('H4', 'npm script');

section('I. Safety');

if (!quoteSrc.includes('stripe') && !INVOICE.includes('INSERT INTO payments')) pass('I1', 'quote/invoice no Stripe writes');
else fail('I1', 'Stripe in quote module');
for (const f of GUEST_UNTOUCHED) {
  const base = path.basename(f);
  const src = readOrEmpty(f);
  if (!/bcRefreshBookingFinancialSummary|package_none/.test(src)) pass(`I.${base}`, `${base} untouched`);
  else fail(`I.${base}`, `${base} touched`);
}

console.log(`\n── Summary ──`);
console.log(`  PASS: ${passes}`);
console.log(`  FAIL: ${failures}`);
process.exit(failures > 0 ? 1 : 0);
