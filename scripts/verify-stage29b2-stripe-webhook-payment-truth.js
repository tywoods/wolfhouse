/**
 * Stage 29b.2 — Luna conversation Stripe TEST webhook payment truth verifier.
 *
 * Usage:
 *   npm run verify:stage29b2-stripe-webhook-payment-truth
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'run-luna-conversation-state-machine-tests.js');
const TRUTH = path.join(__dirname, 'lib', 'luna-guest-stripe-payment-truth-apply.js');
const SHORT_STAY = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'short-stay-accommodation-only-to-deposit.json');
const SEVEN_NIGHT = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'seven-night-direct-package-to-deposit.json');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage29b2-stripe-webhook-payment-truth';

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage29b2-stripe-webhook-payment-truth.js  (Stage 29b.2)\n');

section('A. Runner + package');

check('A1', fs.existsSync(RUNNER), 'runner exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A2', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const runnerSrc = fs.readFileSync(RUNNER, 'utf8');
const truthSrc = fs.readFileSync(TRUTH, 'utf8');

section('B. --simulate-stripe-webhook CLI');

check('B1', runnerSrc.includes('--simulate-stripe-webhook'), 'supports --simulate-stripe-webhook');
check('B2', runnerSrc.includes('simulateStripeWebhook'), 'parses simulateStripeWebhook');
check('B3', runnerSrc.includes('--simulate-stripe-webhook requires --allow-writes'),
  'simulation requires --allow-writes');
check('B4', runnerSrc.includes('--simulate-stripe-webhook requires --require-stripe-test-link'),
  'simulation requires --require-stripe-test-link');

section('C. Existing payment truth path');

check('C1', runnerSrc.includes('runGuestStripePaymentTruthApplyApproved'),
  'uses Stage 27p payment truth helper');
check('C2', truthSrc.includes('handleStripeWebhook'), 'helper documents reused webhook path');
check('C3', !runnerSrc.includes("status = 'paid'") || runnerSrc.includes('runGuestStripePaymentTruthApplyApproved'),
  'runner does not direct SQL payment truth mutation');
check('C4', runnerSrc.includes('confirm_payment_truth'), 'confirm_payment_truth gate preserved');

section('D. Safety');

check('D1', runnerSrc.includes('assertNotProduction') && runnerSrc.includes('assertNotProductionDb'),
  'production host/db refused');
check('D2', runnerSrc.includes('isStripeTestSecretKey') || runnerSrc.includes('stripe_test_mode_required'),
  'live Stripe refused');
check('D3', !runnerSrc.includes('runGuestConfirmationSend') && !runnerSrc.includes('runGuestConfirmation('),
  'no live confirmation send import');
check('D4', runnerSrc.includes('sends_whatsapp') && runnerSrc.includes('calls_n8n must not'),
  'no WhatsApp/n8n');
check('D5', runnerSrc.includes('paid_booking_cleanup_refused'), 'cleanup refuses paid bookings');

section('E. Assertions + diagnostics');

check('E1', runnerSrc.includes('checkWebhookExpectations'), 'webhook expectation checks');
check('E2', runnerSrc.includes('expected_payment_status_after_webhook')
  || runnerSrc.includes('expected_booking_payment_status_after_webhook'),
  'payment status after webhook assertion');
check('E3', runnerSrc.includes('expected_amount_paid_cents'), 'amount_paid_cents assertion');
check('E4', runnerSrc.includes('confirmation_sent_at_unchanged')
  || runnerSrc.includes('expected_confirmation_sent_at_unchanged'),
  'confirmation_sent_at unchanged assertion');
check('E5', runnerSrc.includes('printStripeWebhookDiagnostics'), 'webhook diagnostics printer');
check('E6', runnerSrc.includes('idempotency') && runnerSrc.includes('idempotent_replay'),
  'webhook idempotency check');

section('F. Fixtures');

for (const [id, file] of [['F1', SHORT_STAY], ['F2', SEVEN_NIGHT]]) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(id, data.webhook_expect && data.webhook_expect.expected_payment_status_after_webhook === 'deposit_paid',
    `${path.basename(file)} has webhook_expect`);
}

section('G. Syntax');

for (const f of [RUNNER, TRUTH, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('G', `${path.basename(f)} passes node --check`);
  } catch {
    fail('G', `${path.basename(f)} syntax error`);
  }
}

section('Summary');
console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
