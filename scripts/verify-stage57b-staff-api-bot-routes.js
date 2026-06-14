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
// Also load the extracted V2 bot routes module — checks may match either file
const v2src = fs.readFileSync(path.join(__dirname, 'lib', 'staff-bot-v2-routes.js'), 'utf8');
// Combined source for pattern checks that could live in either file
const allsrc = src + '\n' + v2src;

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

function handlerBlock(name) {
  // Check both the main API file and the extracted V2 module
  for (const s of [src, v2src]) {
    const idx = s.indexOf(`async function ${name}`);
    if (idx < 0) continue;
    const next = s.indexOf('\nasync function ', idx + 1);
    return s.slice(idx, next > idx ? next : idx + 5000);
  }
  return '';
}

console.log('\nverify-stage57b-staff-api-bot-routes.js  (Stage 57b)\n');

section('A. Transfer save bot route');
{
  const b = routeBlock('/staff/bot/transfers/save');
  check('A1', !!b, 'route exists');
  check('A2', /method !== 'POST'/.test(b), 'POST only');
  check('A3', /requireBotAuth\(req, res\)/.test(b), 'uses bot auth');
  check('A4', /handleBotTransferSave/.test(b), 'dispatches handler');
  const h = handlerBlock('handleBotTransferSave');
  // A5: check the full v2 module source since the stub in staff-query-api delegates to it
  check('A5', /body\.booking_code\s*\|\|\s*body\.bookingCode/.test(allsrc), 'transfer save accepts booking_code lookup');
  check('A6', /Symbol\.asyncIterator/.test(allsrc), 'in-memory bot req supports async-iterable route handlers');
  check('A7', /handlePostBookingTransfer/.test(allsrc), 'transfer save imports delegated post handler');
  check('A8', /allowedTransferSources/.test(allsrc) && /source:\s*transferSource/.test(allsrc), 'transfer save normalizes to accepted booking transfer source');
  check('A9', /write_performed:\s*obj\.write_performed/.test(allsrc), 'transfer save returns write_performed for successful delegated writes');
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
  check('C1', /async function handleBotTransferSave/.test(allsrc), 'transfer handler defined');
  check('C2', /confirm_transfer_write/.test(allsrc), 'transfer write confirm gate present');
  check('C3', /handlePostBookingTransfer\(/.test(allsrc), 'transfer handler delegates to staff transfer save path');
  check('C4', /async function handleBotPaymentStatus/.test(allsrc), 'payment status handler defined');
  check('C5', /no_payment_write:\s*true/.test(allsrc), 'payment status is read-only');
  check('C6', /checkout_created|paid|deposit_paid|fully_paid/.test(allsrc), 'payment truth states exposed');
  check('C7', /body\.booking_code\s*\|\|\s*body\.bookingCode/.test(allsrc), 'payment status accepts booking_code lookup');
  check('C8', /UPPER\(b\.booking_code\) = UPPER\(\$[12]\)/.test(allsrc), 'payment status can query latest payment by booking_code case-insensitively');
  check('C9', /payment_id:\s*createResponse\.payment_id/.test(allsrc) || /bridgeResult\.payment_id/.test(allsrc), 'booking-create-from-plan flattens payment_id for Hermes tools');
  check('C10', /guest_payment_url:\s*linkObs\.guest_payment_url/.test(allsrc), 'bot Stripe link returns guest_payment_url short-link field');
  check('C11', /payment_short_url:\s*linkObs\.payment_short_url/.test(allsrc), 'bot Stripe link returns payment_short_url field');
}

section('D. WhatsApp thread mirror route');
{
  const b = routeBlock('/staff/bot/whatsapp-thread-mirror');
  check('D1', !!b, 'route exists');
  check('D2', /method !== 'POST'/.test(b), 'POST only');
  check('D3', /requireBotAuth\(req, res\)/.test(b), 'uses bot auth');
  check('D4', /handleBotHermesWhatsAppThreadMirror/.test(b), 'dispatches mirror handler');
}

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
