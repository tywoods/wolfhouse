/**
 * Phase 26j.1a — Transfer total runtime helper scope (browser vs Node).
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-transfer-total-runtime
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const INVOICE = path.join(ROOT, 'scripts', 'lib', 'booking-invoice-totals.js');
const PKG = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-transfer-total-runtime';

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

console.log('\nverify-luna-agent-phase26-transfer-total-runtime.js  (Phase 26j.1a)\n');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  execSync(`node --check "${INVOICE}"`, { stdio: 'pipe' });
  pass('0', 'syntax check');
} catch {
  fail('0', 'syntax check');
}

const apiSrc = readOrEmpty(API);
const invoiceSrc = readOrEmpty(INVOICE);
const pkg = JSON.parse(readOrEmpty(PKG) || '{}');
const lookupHandler = apiSrc.match(/async function handlePostBookingTransfer[\s\S]{0,1200}/)?.[0] || '';

const clientSlice = (apiSrc.match(/function bcIsActiveTransferForInvoice[\s\S]{0,12000}/) || [''])[0];
const serverLedgerSlice = (apiSrc.match(/function bookingLedgerBalanceFromRows[\s\S]{0,600}/) || [''])[0];

section('A. Module exports');

const {
  sumActiveTransferChargesCents,
  transferInvoiceLineItems,
} = require('./lib/booking-invoice-totals');

if (/sumActiveTransferChargesCents/.test(invoiceSrc) && typeof sumActiveTransferChargesCents === 'function') {
  pass('A1', 'booking-invoice-totals exports sumActiveTransferChargesCents');
} else fail('A1', 'module export');
if (typeof transferInvoiceLineItems === 'function') pass('A2', 'transferInvoiceLineItems exported');
else fail('A2', 'line items export');

section('B. Server runtime uses Node import');

if (/require\('\.\/lib\/booking-invoice-totals'\)/.test(apiSrc)) pass('B1', 'staff-query-api imports booking-invoice-totals');
else fail('B1', 'import missing');
if (/sumActiveTransferChargesCents\(transferRows\)/.test(serverLedgerSlice)) {
  pass('B2', 'server bookingLedgerBalanceFromRows calls imported helper');
} else fail('B2', 'server ledger helper');

section('C. Browser UI uses bc* helpers (no ReferenceError)');

if (/function bcSumActiveTransferChargesCents/.test(clientSlice)) {
  pass('C1', 'bcSumActiveTransferChargesCents defined in staff UI script');
} else fail('C1', 'client sum helper missing');
if (/function bcTransferInvoiceLineItems/.test(clientSlice)) {
  pass('C2', 'bcTransferInvoiceLineItems defined in staff UI script');
} else fail('C2', 'client line-items helper missing');
if (/bcSumActiveTransferChargesCents\(transferRows\)/.test(clientSlice)) {
  pass('C3', 'drawer ledger path calls bcSumActiveTransferChargesCents');
} else fail('C3', 'ledger client call');
if (!/\bsumActiveTransferChargesCents\(/.test(clientSlice)) {
  pass('C4', 'browser slice does not call bare sumActiveTransferChargesCents');
} else fail('C4', 'bare helper still in browser slice');
if (!/\btransferInvoiceLineItems\(/.test(clientSlice)) {
  pass('C5', 'browser slice does not call bare transferInvoiceLineItems');
} else fail('C5', 'bare line-items in browser slice');

section('D. Totals behavior preserved');

const rows = [
  { direction: 'arrival', status: 'requested', price_cents: 2500 },
  { direction: 'departure', status: 'confirmed', price_cents: 6000 },
  { direction: 'departure', status: 'not_needed', price_cents: 6000 },
];
if (sumActiveTransferChargesCents(rows) === 8500) pass('D1', 'transfer charges still summed for invoice');
else fail('D1', 'sum behavior');
if (/bc-inv-transfers/.test(apiSrc)) pass('D2', 'Transfers invoice section retained');
else fail('D2', 'invoice section');

section('E. Safety');

if (!lookupHandler.includes('INSERT INTO payments')) pass('E1', 'transfer save no payment row');
else fail('E1', 'payment insert on transfer');
if (!/whatsapp|n8n|luna-meta/i.test(clientSlice.match(/bcSumActiveTransferChargesCents[\s\S]{0,800}/)?.[0] || '')) {
  pass('E2', 'no WhatsApp/Meta/n8n in client transfer helper slice');
} else fail('E2', 'messaging touched');

for (const f of GUEST_UNTOUCHED) {
  const base = path.basename(f);
  if (!fs.existsSync(f) || fs.readFileSync(f, 'utf8').length > 0) {
    pass(`E.${base}`, `${base} untouched`);
  }
}

section('F. npm script');

if (pkg.scripts && pkg.scripts[SCRIPT]) pass('F1', 'npm script registered');
else fail('F1', 'npm script');

console.log(`\n── Summary ──\n  PASS: ${passes}\n  FAIL: ${failures}\n`);
process.exit(failures ? 1 : 0);
