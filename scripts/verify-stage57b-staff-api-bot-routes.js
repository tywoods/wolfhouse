/**
 * Stage 57b — Staff API bot route contract verifier.
 *
 * Static contract gate for routes Hermes Luna wrapper calls directly.
 * These routes must live under /staff/bot/* and use requireBotAuth.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

function routeBlock(route) {
  const idx = src.indexOf(`pathname === '${route}'`);
  if (idx < 0) return '';
  return src.slice(idx, idx + 700);
}

console.log('\nverify-stage57b-staff-api-bot-routes.js  (Stage 57b)\n');

section('A. Transfer save bot route');
{
  const b = routeBlock('/staff/bot/transfers/save');
  check('A1', !!b, 'route exists');
  check('A2', /method !== 'POST'/.test(b), 'POST only');
  check('A3', /requireBotAuth\(req, res\)/.test(b), 'uses bot auth');
  check('A4', /handleBotTransferSave/.test(b), 'dispatches handler');
}

section('B. Payment status bot route');
{
  const b = routeBlock('/staff/bot/payments/status');
  check('B1', !!b, 'route exists');
  check('B2', /method !== 'POST'/.test(b), 'POST only');
  check('B3', /requireBotAuth\(req, res\)/.test(b), 'uses bot auth');
  check('B4', /handleBotPaymentStatus/.test(b), 'dispatches handler');
}

section('C. Handler safety contract');
{
  check('C1', /async function handleBotTransferSave/.test(src), 'transfer handler defined');
  check('C2', /confirm_transfer_write/.test(src), 'transfer write confirm gate present');
  check('C3', /handlePostBookingTransfer\(/.test(src), 'transfer handler delegates to staff transfer save path');
  check('C4', /async function handleBotPaymentStatus/.test(src), 'payment status handler defined');
  check('C5', /no_payment_write:\s*true/.test(src), 'payment status is read-only');
  check('C6', /checkout_created|paid|deposit_paid|fully_paid/.test(src), 'payment truth states exposed');
}

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
