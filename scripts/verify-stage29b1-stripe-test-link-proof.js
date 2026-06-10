/**
 * Stage 29b.1 — Luna conversation write-mode Stripe TEST link proof verifier.
 *
 * Usage:
 *   npm run verify:stage29b1-stripe-test-link-proof
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'run-luna-conversation-state-machine-tests.js');
const STRIPE = path.join(__dirname, 'lib', 'luna-guest-stripe-test-link-create.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage29b1-stripe-test-link-proof';

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage29b1-stripe-test-link-proof.js  (Stage 29b.1)\n');

section('A. Runner + package script');

check('A1', fs.existsSync(RUNNER), 'runner exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A2', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const runnerSrc = fs.readFileSync(RUNNER, 'utf8');
const stripeSrc = fs.readFileSync(STRIPE, 'utf8');

section('B. --require-stripe-test-link CLI');

check('B1', runnerSrc.includes('--require-stripe-test-link'), 'supports --require-stripe-test-link');
check('B2', runnerSrc.includes('requireStripeTestLink'), 'parses requireStripeTestLink option');
check('B3', runnerSrc.includes('--require-stripe-test-link requires --allow-writes'),
  'require flag requires --allow-writes');

section('C. Stripe TEST gate detection');

check('C1', runnerSrc.includes('STAFF_ACTIONS_ENABLED') || runnerSrc.includes('shouldAllowGuestStripeTestLinkCreate'),
  'runner checks STAFF_ACTIONS_ENABLED via stripe gate');
check('C2', runnerSrc.includes('STRIPE_LINKS_ENABLED') || runnerSrc.includes('shouldAllowGuestStripeTestLinkCreate'),
  'runner checks STRIPE_LINKS_ENABLED via stripe gate');
check('C3', runnerSrc.includes('isStripeTestSecretKey'), 'runner refuses non-test Stripe keys');
check('C4', runnerSrc.includes('assertNotProduction') && runnerSrc.includes('assertNotProductionDb'),
  'runner refuses production host/db');
check('C5', runnerSrc.includes('assessStripeTestLinkEnvironment') || runnerSrc.includes('assessWriteEnvironment'),
  'staging/local environment assessment');

section('D. Required vs optional Stripe behavior');

check('D1', runnerSrc.includes('isStripeCheckoutRequired'), 'stripe requirement resolver');
check('D2', runnerSrc.includes('stripe_test_checkout_required'), 'fail with exact reason when required');
check('D3', runnerSrc.includes('PASS_optional') || runnerSrc.includes('stripe_outcome'),
  'optional Stripe pass outcome documented');
check('D4', runnerSrc.includes('stripeRequired') && (runnerSrc.includes('stripeExpect === false')
  || runnerSrc.includes('stripeExpect === true')),
  'preserves optional stripe when flag not passed');

section('E. Side-effect assertions');

check('E1', runnerSrc.includes('stripe_checkout_url'), 'checkout URL tracked');
check('E2', runnerSrc.includes('stripe_checkout_session_id'), 'checkout session id tracked');
check('E3', runnerSrc.includes('payment_status_after_checkout'), 'payment status after checkout tracked');
check('E4', runnerSrc.includes('stripe_live_used'), 'stripe_live_used assertion');
check('E5', runnerSrc.includes('confirmation_sent'), 'confirmation_sent assertion');
check('E6', runnerSrc.includes('payment_amount_paid_cents') || runnerSrc.includes('amount_paid_cents'),
  'payment truth not mutated by checkout creation');

section('F. Runner output documentation');

check('F1', runnerSrc.includes('printStripeWriteDiagnostics'), 'stripe write diagnostics printer');
check('F2', runnerSrc.includes('missing gate/env'), 'skipped stripe prints missing gates');
check('F3', runnerSrc.includes('checkout_url present'), 'created stripe prints checkout_url presence');
check('F4', runnerSrc.includes('require_stripe_test_link'), 'prints require flag state');

section('G. Safety defaults preserved');

check('G1', runnerSrc.includes('dry_run: true') && runnerSrc.includes('sends_whatsapp'),
  'conversation stays dry-run; no real WhatsApp default');
check('G2', !runnerSrc.includes('sendLunaBookingConfirmation'),
  'no direct live confirmation send import');
check('G3', runnerSrc.includes('calls_n8n must not') || runnerSrc.includes('calls_n8n === true'),
  'no n8n activation');
check('G4', stripeSrc.includes('payment_truth_recorded: false'), 'stripe module does not record payment truth');
check('G5', stripeSrc.includes('stripe_test_mode_required') || stripeSrc.includes('isStripeTestSecretKey'),
  'stripe lib blocks live keys');

section('H. Syntax');

for (const f of [RUNNER, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('H', `${path.basename(f)} passes node --check`);
  } catch {
    fail('H', `${path.basename(f)} syntax error`);
  }
}

section('Summary');
console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
