/**
 * Phase 10.6g.5 — Stripe Checkout success/cancel landing pages.
 *
 * Usage:
 *   npm run verify:staff-stripe-checkout-landing
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

console.log('\nverify-staff-stripe-checkout-landing.js  (Phase 10.6g.5)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const landingBlock = src.match(/function sendHTML[\s\S]*?function isStripeCheckoutCancelLandingPath[\s\S]*?\n\}/)?.[0] || '';
const routerSlice = src.match(/async function router[\s\S]{0,1200}Phase 10\.6g\.5[\s\S]{0,800}/)?.[0] || '';
const webhookStart = src.indexOf('async function handleStripeWebhook');
const webhookEnd = src.indexOf('// ─────────────────────────────────────────────────────────────────────────────\n// Request router', webhookStart);
const webhookHandler = webhookStart >= 0 && webhookEnd > webhookStart
  ? src.slice(webhookStart, webhookEnd)
  : src.match(/async function handleStripeWebhook[\s\S]*?\n\}/)?.[0] || '';

const stripeCreateSlices = [
  src.match(/async function handleBookingGeneratePaymentLink[\s\S]*?stripe\.checkout\.sessions\.create[\s\S]{0,400}/)?.[0] || '',
  src.match(/async function handlePaymentCreateStripeLink[\s\S]*?stripe\.checkout\.sessions\.create[\s\S]{0,400}/)?.[0] || '',
].join('\n');

console.log('\nA. Package script');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check(pkg.scripts && pkg.scripts['verify:staff-stripe-checkout-landing'],
  'package.json has verify:staff-stripe-checkout-landing script');

console.log('\nB. Checkout redirect URLs use env');
check(/success_url:\s*STRIPE_SUCCESS_URL/.test(src),
  'checkout success_url comes from STRIPE_SUCCESS_URL env');
check(/cancel_url:\s*STRIPE_CANCEL_URL/.test(src),
  'checkout cancel_url comes from STRIPE_CANCEL_URL env');

console.log('\nC. Success landing route + HTML');
check(/handleStripeCheckoutSuccessLanding/.test(landingBlock),
  'success landing handler exists');
check(/Payment received/.test(landingBlock) && /Thanks/.test(landingBlock),
  'success page title and thanks copy');
check(/Wolfhouse has your booking\/payment update/.test(landingBlock),
  'success page Wolfhouse confirmation copy');
check(/sendHTML\(res,\s*200/.test(landingBlock),
  'success route returns HTML 200');
check(/\/staff\/payment\/success/.test(landingBlock) || /isStripeCheckoutSuccessLandingPath/.test(landingBlock),
  'success path matching helper');
check(/pathname === '\/staff'.*session_id|session_id.*pathname === '\/staff'/.test(landingBlock)
  || /query\.session_id/.test(landingBlock),
  'bare /staff success when session_id present (staging env)');

console.log('\nD. Cancel landing route + HTML');
check(/handleStripeCheckoutCancelLanding/.test(landingBlock),
  'cancel landing handler exists');
check(/Payment not completed/.test(landingBlock),
  'cancel page title');
check(/No payment was completed/.test(landingBlock),
  'cancel page body copy');
check(/\/staff\/payment\/cancel|\/staff\/stripe\/cancel/.test(landingBlock),
  'explicit cancel landing paths');

console.log('\nE. Router wires public GET (no JSON 404)');
check(/Phase 10\.6g\.5/.test(routerSlice),
  'router registers 10.6g.5 landing block');
check(/isStripeCheckoutSuccessLandingPath/.test(routerSlice),
  'router checks success landing path');
check(/isStripeCheckoutCancelLandingPath/.test(routerSlice),
  'router checks cancel landing path');
check(!/requireAuth/.test(routerSlice),
  'landing routes are not behind staff auth');

console.log('\nF. Optional return link (safe query params)');
check(/safeLandingBookingCode/.test(landingBlock) && /safeLandingClientSlug/.test(landingBlock),
  'sanitizes booking_code and client_slug query params');
check(/Return to Luna Front Desk/.test(landingBlock),
  'optional return link copy');

console.log('\nG. Display only — webhook remains payment truth');
check(!/UPDATE payments/.test(landingBlock) && !/INSERT INTO payments/.test(landingBlock),
  'landing handlers do not mutate payments');
check(!/'paid'::payment_record_status/.test(landingBlock),
  'landing handlers do not mark payments paid');
check(/checkout\.sessions\.completed|payment_intent\.succeeded|mark.*paid/i.test(webhookHandler),
  'webhook handler still processes Stripe payment completion');
check(!/handleStripeCheckoutSuccessLanding/.test(webhookHandler),
  'webhook does not delegate to success landing page');

console.log('\nH. Safety boundaries');
check(!/sendWhatsApp|whatsapp\.com|triggerN8n|n8n\.webhook/i.test(landingBlock),
  'no WhatsApp/n8n in landing slice');
check(!/database\/migrations|run-sql\.js/.test(landingBlock),
  'no migrations in landing slice');
check(!/deploy|production/i.test(landingBlock),
  'no deploy/production in landing slice');

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
