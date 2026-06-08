/**
 * Phase 26h.1 — Verifier for drawer Transfers/Payments polish + remove transfer.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-drawer-payments-transfers-polish
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROUTES = path.join(__dirname, 'lib', 'staff-booking-transfers-routes.js');
const HELPER = path.join(__dirname, 'lib', 'booking-transfers.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26h-1-DRAWER-PAYMENTS-TRANSFERS-POLISH.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-drawer-payments-transfers-polish';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
];

const UPSTREAM = [
  'verify:luna-agent-phase26-services-schedule-writes',
  'verify:luna-agent-phase26-drawer-file-tab-polish',
  'verify:luna-agent-phase26-transfer-calendar-pebble',
  'verify:luna-agent-phase26-transfer-editor',
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

console.log('\nverify-luna-agent-phase26-drawer-payments-transfers-polish.js  (Phase 26h.1)\n');

try {
  execSync(`node --check "${ROUTES}"`, { stdio: 'pipe' });
  execSync(`node --check "${HELPER}"`, { stdio: 'pipe' });
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'routes + helper + staff-query-api pass node --check');
} catch {
  fail('0', 'syntax check failed');
}

const routesSrc = readOrEmpty(ROUTES);
const helperSrc = readOrEmpty(HELPER);
const apiSrc = readOrEmpty(API);
const transferSlice = (apiSrc.match(/function bcRenderTransferCard[\s\S]{0,2200}/) || [''])[0];
const invoiceSlice = (apiSrc.match(/function bcRenderRunningInvoiceHtml[\s\S]{0,12000}/) || [''])[0];

section('A. Transfer card polish');

if (/bc-transfer-card bc-drawer-overview-card|bc-drawer-overview-card[\s\S]{0,40}bc-transfer-card/.test(transferSlice)) {
  pass('A1', 'transfer cards use Overview/light card class');
} else fail('A1', 'transfer card styling');
if (/background:var\(--surface\)/.test(apiSrc.match(/\.bc-transfer-card[\s\S]{0,160}/)?.[0] || '') ||
    /bc-drawer-overview-card/.test(transferSlice)) {
  pass('A2', 'transfer card uses lighter surface color');
} else fail('A2', 'transfer card color');
if (/bc-transfer-tab-spacer/.test(apiSrc)) pass('A3', 'transfer tab spacer retained');
else fail('A3', 'transfer spacer');

section('B. Remove transfer');

if (/bc-transfer-remove/.test(transferSlice) || /bc-transfer-remove/.test(apiSrc)) {
  pass('B1', 'remove transfer buttons in UI');
} else fail('B1', 'remove buttons');
if (/bcRemoveTransfer|method:\s*'DELETE'/.test(apiSrc) && /\/transfers\//.test(apiSrc)) {
  pass('B2', 'UI calls DELETE transfer route');
} else fail('B2', 'DELETE UI wiring');
if (/BOOKING_TRANSFER_DIRECTION_RE/.test(routesSrc) && /handleDeleteBookingTransfer/.test(routesSrc)) {
  pass('B3', 'DELETE transfer direction route');
} else fail('B3', 'DELETE route');
if (/deleteBookingTransfer/.test(routesSrc) && /DELETE FROM booking_transfers/.test(helperSrc)) {
  pass('B4', 'delete helper removes booking_transfers row');
} else fail('B4', 'delete SQL');
if (/client_slug is required/.test(routesSrc) && /normalizeTransferDirection/.test(routesSrc)) {
  pass('B5', 'validates client_slug + direction');
} else fail('B5', 'validation');
if (/no_payment_write:\s*true/.test(routesSrc.match(/handleDeleteBookingTransfer[\s\S]{0,1200}/)?.[0] || '')) {
  pass('B6', 'remove route no_payment_write flag');
} else fail('B6', 'no_payment_write');
if (/Remove this transfer from the booking/.test(apiSrc)) pass('B7', 'confirm prompt');
else fail('B7', 'confirm prompt');
if (/bcClearTransferForm/.test(apiSrc)) pass('B8', 'clears direction form on remove');
else fail('B8', 'form clear');
if (/ACTIVE_TRANSFER_PEBBLE_STATUSES/.test(helperSrc) && /bcBuildTransferSummaryFromTransfers/.test(apiSrc)) {
  pass('B9', 'pebble uses requested/confirmed filter');
} else fail('B9', 'pebble filter');

section('C. Payments layout polish');

if (/ctx-payments-tab-layout/.test(invoiceSlice) && /ctx-payments-col-main/.test(invoiceSlice) &&
    /ctx-payments-col-history/.test(invoiceSlice)) {
  pass('C1', 'responsive two-column payments layout');
} else fail('C1', 'two-column layout');
if (/grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/.test(apiSrc) &&
    /@media \(max-width:860px\)[\s\S]{0,80}ctx-payments-tab-layout[\s\S]{0,80}1fr/.test(apiSrc)) {
  pass('C2', 'stacks on narrow width');
} else fail('C2', 'narrow stack');
if (/bc-drawer-overview-card/.test(invoiceSlice) && /ctx-payment-history-card/.test(invoiceSlice)) {
  pass('C3', 'Payments uses light card styling');
} else fail('C3', 'light cards');
if (/ctx-inv-group-title">Services</.test(invoiceSlice) && !/ctx-inv-group-title">Add-ons</.test(invoiceSlice)) {
  pass('C4', 'Add-ons renamed Services in Payments breakdown');
} else fail('C4', 'Services label');
if (/ctx-payment-history-card/.test(invoiceSlice) && /Payment history/.test(invoiceSlice)) {
  pass('C5', 'Payment History in its own card');
} else fail('C5', 'history card');
if (/ctx-pay-record/.test(invoiceSlice) && /ctx-payments-col-history/.test(invoiceSlice)) {
  pass('C6', 'receipts in Payment History column');
} else fail('C6', 'receipt stack');
if (/bc-generate-payment-link-btn/.test(apiSrc) && /Record Cash Payment|bc-cash-payment/.test(apiSrc)) {
  pass('C7', 'Generate Payment Link + Record Cash Payment retained');
} else fail('C7', 'payment actions');
if (/bcRenderCashPaymentFormHtml[\s\S]{0,800}bcRenderPaymentLinkSectionHtml/.test(invoiceSlice)) {
  pass('C8', 'Record Cash Payment before Generate Payment Link');
} else fail('C8', 'payment button order');

section('D. Payments bottom spacer');

if (/bc-payments-tab-spacer/.test(apiSrc) && /\.bc-payments-tab-spacer[\s\S]{0,80}height:280px/.test(apiSrc)) {
  pass('D1', 'payments tab bottom spacer');
} else fail('D1', 'payments spacer');
if (/\.bc-payments-tab-spacer[\s\S]{0,80}background:transparent/.test(apiSrc)) {
  pass('D2', 'spacer transparent on beige panel');
} else fail('D2', 'spacer background');
if (!/bc-payments-tab-spacer[\s\S]{0,80}border:/.test(apiSrc)) {
  pass('D3', 'spacer not bordered/debug');
} else fail('D3', 'spacer border');

section('E. Wiring');

if (/BOOKING_TRANSFER_DIRECTION_RE/.test(apiSrc) && /dispatchBookingTransferDirectionRoute/.test(apiSrc)) {
  pass('E1', 'DELETE route wired in staff-query-api');
} else fail('E1', 'DELETE wiring');
if (/BOOKING_TRANSFER_DIRECTION_RE[\s\S]{0,600}BOOKING_TRANSFER_LOOKUP_RE/.test(apiSrc)) {
  pass('E2', 'direction DELETE before lookup/transfers routes');
} else fail('E2', 'route order');

section('F. Docs + npm');

const doc = readOrEmpty(DOC);
if (/Remove transfer|DELETE/i.test(doc) && /Services/i.test(doc)) pass('F1', 'doc covers remove + Services');
else fail('F1', 'doc content');
if (/no payment|No Stripe|spacer/i.test(doc)) pass('F2', 'doc safety + spacer');
else fail('F2', 'doc safety');

const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('F3', 'npm script registered');
else fail('F3', 'npm script');

section('G. Safety');

if (!routesSrc.match(/\bstripe\b/i) && !helperSrc.match(/\bstripe\b/i)) {
  pass('G1', 'no Stripe in transfer slice');
} else fail('G1', 'Stripe touched');
if (!/INSERT INTO payments|payment_intent/.test(routesSrc + helperSrc)) {
  pass('G2', 'remove route does not write payments');
} else fail('G2', 'payment writes');
const routesSafety = routesSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const helperSafety = helperSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
if (!/whatsapp|n8n|guest_message/i.test(routesSafety + helperSafety)) {
  pass('G3', 'no WhatsApp/Meta/n8n in slice');
} else fail('G3', 'messaging touched');

for (const f of GUEST_UNTOUCHED) {
  const base = path.basename(f);
  const src = readOrEmpty(f);
  if (!/bc-transfer-remove|deleteBookingTransfer|ctx-payments-tab/.test(src)) {
    pass(`G.${base}`, `${base} unchanged`);
  } else fail(`G.${base}`, `${base} touched`);
}

section('H. Upstream verifiers');

for (const script of UPSTREAM) {
  try {
    execSync(`npm run ${script}`, { stdio: 'pipe', cwd: ROOT, timeout: 120000 });
    pass(`H.${script}`, `${script} still passes`);
  } catch {
    fail(`H.${script}`, `${script} failed`);
  }
}

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
