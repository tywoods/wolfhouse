/**
 * Stage 27demo-e — Open demo Stripe TEST link + WhatsApp payment link verifier.
 *
 * Usage:
 *   npm run verify:stage27demo-e-stripe-test-link-whatsapp
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const GATE = path.join(__dirname, 'lib', 'open-demo-whatsapp-gate.js');
const STRIPE = path.join(__dirname, 'lib', 'luna-guest-stripe-test-link-create.js');
const HARNESS = path.join(__dirname, 'run-open-demo-whatsapp-inbound-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27DEMO-E-STRIPE-TEST-LINK-WHATSAPP.md');
const SCRIPT = 'verify:stage27demo-e-stripe-test-link-whatsapp';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27demo-e-stripe-test-link-whatsapp.js  (Stage 27demo-e)\n');

const src = fs.readFileSync(API, 'utf8');
const gateSrc = fs.readFileSync(GATE, 'utf8');
const stripeSrc = fs.readFileSync(STRIPE, 'utf8');
const harnessSrc = fs.readFileSync(HARNESS, 'utf8');
const doc = fs.readFileSync(DOC, 'utf8');

const handlerStart = src.indexOf('async function handleBotOpenDemoWhatsAppInboundDryRun(');
const handlerEnd = src.indexOf('\nfunction parseGuestSimulatorChain(', handlerStart);
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? src.slice(handlerStart, handlerEnd)
  : '';

section('A. Open demo Stripe gate');

if (gateSrc.includes('OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED')) pass('A1', 'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED gate');
else fail('A1', 'stripe test links env gate missing');

if (gateSrc.includes('evaluateOpenDemoStripeTestLinkGate')) pass('A2', 'evaluateOpenDemoStripeTestLinkGate');
else fail('A2', 'stripe test link gate evaluator missing');

if (gateSrc.includes('isStripeLiveSecretKey') || gateSrc.includes('sk_live_')) {
  pass('A3', 'sk_live_ / live key guard');
} else {
  fail('A3', 'live Stripe key guard missing');
}

if (gateSrc.includes('isStripeTestSecretKey') || gateSrc.includes('sk_test_')) {
  pass('A4', 'sk_test_ / test mode guard');
} else {
  fail('A4', 'test mode guard missing');
}

if (gateSrc.includes('production_blocked') && gateSrc.includes('evaluateOpenDemoStripeTestLinkGate')) {
  pass('A5', 'production hard block on stripe gate');
} else {
  fail('A5', 'production block missing');
}

section('B. Handler integration');

if (handler.includes('wantsCreateStripeTestLinkConfirmed')) pass('B1', 'create_stripe_test_link_confirmed flag');
else fail('B1', 'create stripe flag missing');

if (handler.includes('wantsSendPaymentLinkWhatsAppConfirmed')) pass('B2', 'send_payment_link_whatsapp_confirmed flag');
else fail('B2', 'send payment link flag missing');

if (handler.includes('runGuestStripeTestLinkCreateApproved')) pass('B3', 'uses existing Stripe TEST link helper');
else fail('B3', 'Stripe TEST link helper not called');

if (handler.includes('evaluateGuestReplySendRouteWithPause')
    && handler.includes('buildOpenDemoPaymentLinkSendBody')) {
  pass('B4', 'uses existing WhatsApp send helper for payment link');
} else {
  fail('B4', 'WhatsApp payment link send path missing');
}

if (handler.includes('stripe_link_reused') || handler.includes('formatOpenDemoStripeLinkResponse')) {
  pass('B5', 'idempotent reuse response mapping');
} else {
  fail('B5', 'stripe link reuse mapping missing');
}

if (!handler.includes('runGuestConfirmation') && !handler.includes('confirmation_send')) {
  pass('B6', 'no confirmation send in open demo handler');
} else {
  fail('B6', 'confirmation send referenced');
}

if (!handler.includes('runGuestStripePaymentTruthApplyApproved')) {
  pass('B7', 'no payment truth from chat in handler');
} else {
  fail('B7', 'payment truth apply must not run from open demo inbound');
}

section('C. Harness and docs');

if (harnessSrc.includes('--create-stripe-test-link-confirmed')) pass('C1', 'harness create stripe flag');
else fail('C1', 'harness create stripe flag missing');

if (harnessSrc.includes('--send-payment-link-whatsapp-confirmed')) pass('C2', 'harness send payment link flag');
else fail('C2', 'harness send flag missing');

if (/webhook|payment truth|27p/i.test(doc)) pass('C3', 'docs mention webhook payment truth separately');
else fail('C3', 'docs missing payment truth note');

if (/Perfect, here/.test(doc) || /secure test payment link/.test(doc)) pass('C4', 'docs include payment link copy');
else fail('C4', 'payment link copy missing from docs');

section('D. package.json');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('D1', `${SCRIPT} npm script`);
else fail('D1', `${SCRIPT} npm script missing`);

section('E. Gate unit smoke');

try {
  const gate = require('./lib/open-demo-whatsapp-gate');
  if (!gate.wantsCreateStripeTestLinkConfirmed({})) pass('E1', 'create stripe flag defaults false');
  else fail('E1', 'create stripe should default false');

  if (!gate.wantsSendPaymentLinkWhatsAppConfirmed({})) pass('E2', 'send payment link flag defaults false');
  else fail('E2', 'send payment link should default false');

  const blocked = gate.evaluateOpenDemoStripeTestLinkGate({}, { NODE_ENV: 'production', OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'true' });
  if (!blocked.ok && blocked.code === 'production_blocked') pass('E3', 'production blocks stripe gate');
  else fail('E3', 'production should block stripe gate');

  const disabled = gate.evaluateOpenDemoStripeTestLinkGate({}, {
    NODE_ENV: 'staging',
    OPEN_DEMO_WHATSAPP_ENABLED: 'true',
    OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  });
  if (!disabled.ok) pass('E4', 'stripe gate defaults false when env unset');
  else fail('E4', 'stripe gate should block when disabled');

  const msg = gate.buildOpenDemoPaymentLinkMessage('https://checkout.stripe.test/link');
  if (msg.includes('https://checkout.stripe.test/link') && !/confirmed|received/i.test(msg)) {
    pass('E5', 'payment link message safe copy');
  } else {
    fail('E5', 'payment link message unsafe or missing url');
  }

  const liveBlocked = gate.evaluateOpenDemoStripeTestLinkGate({}, {
    NODE_ENV: 'staging',
    OPEN_DEMO_WHATSAPP_ENABLED: 'true',
    OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'true',
    OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
    STRIPE_LINKS_ENABLED: 'true',
    STAFF_ACTIONS_ENABLED: 'true',
    STRIPE_SECRET_KEY: 'sk_live_bad',
  });
  if (!liveBlocked.ok) pass('E6', 'sk_live_ blocked');
  else fail('E6', 'sk_live_ should be blocked');
} catch (err) {
  fail('E0', `gate smoke threw: ${err.message}`);
}

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('F1', 'staff-query-api.js passes node --check');
} catch {
  fail('F1', 'staff-query-api.js syntax error');
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
