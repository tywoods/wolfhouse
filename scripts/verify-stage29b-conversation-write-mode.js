/**
 * Stage 29b — Luna conversation write-mode verifier.
 *
 * Usage:
 *   npm run verify:stage29b-conversation-write-mode
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'run-luna-conversation-state-machine-tests.js');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine');
const HOLD_WRITE = path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-write.js');
const STRIPE = path.join(__dirname, 'lib', 'luna-guest-stripe-test-link-create.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage29b-conversation-write-mode';

const WRITE_FIXTURES = [
  'short-stay-accommodation-only-to-deposit.json',
  'seven-night-direct-package-to-deposit.json',
];

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage29b-conversation-write-mode.js  (Stage 29b)\n');

section('A. Runner + package script');

check('A1', fs.existsSync(RUNNER), 'runner exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A2', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

section('B. Write-mode runner structure');

const runnerSrc = fs.readFileSync(RUNNER, 'utf8');
check('B1', runnerSrc.includes('--allow-writes'), 'supports --allow-writes');
check('B2', runnerSrc.includes('assertNotProduction') && runnerSrc.includes('assertNotProductionDb'),
  'non-production guard for writes');
check('B3', runnerSrc.includes('cleanupUnpaidTestBooking') || runnerSrc.includes('assessCleanupEligibility'),
  'cleanup logic for unpaid test holds');
check('B4', runnerSrc.includes('assessCleanupEligibility') && runnerSrc.includes('allowPaid: false'),
  'refuses cleanup for paid bookings path');
check('B5', runnerSrc.includes('booking_created') && runnerSrc.includes('payment_draft_created')
  && runnerSrc.includes('stripe_test_checkout_created'),
  'side-effect assertions supported');
check('B6', !runnerSrc.includes('sk_live_') && !runnerSrc.includes('live_stripe'),
  'no live Stripe references');
check('B7', !runnerSrc.includes('runGuestConfirmation'), 'no confirmation send import');
check('B8', !runnerSrc.includes('calls_n8n: true') || runnerSrc.includes('calls_n8n must not'),
  'no n8n activation');
check('B9', runnerSrc.includes('sends_whatsapp') && runnerSrc.includes('dry_run: true'),
  'conversation stays dry-run; no real WhatsApp default');
check('B10', runnerSrc.includes('runGuestHoldPaymentDraftWriteDryRunApproved'),
  'uses existing hold/payment draft writer');
check('B11', runnerSrc.includes('runGuestStripeTestLinkCreateApproved'),
  'uses existing Stripe TEST checkout path');
check('B12', runnerSrc.includes('idempotency'), 'idempotency check support');
check('B13', runnerSrc.includes('booking_flow_stage') && runnerSrc.includes('verbose'),
  'turn diagnostics preserved');

section('C. Fixture write expectations');

for (const file of WRITE_FIXTURES) {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
  const data = JSON.parse(raw);
  check(`C-${file}`, data.write_expect && data.write_expect.booking_created === true
    && data.write_expect.cleanup_expected === true,
    `${file} has write_expect`);
}

const sevenNight = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'seven-night-direct-package-to-deposit.json'), 'utf8'));
check('C3', sevenNight.write_expect && sevenNight.write_expect.idempotency_check === true,
  'seven-night fixture has idempotency_check');

const packageSide = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'package-side-question-mid-flow.json'), 'utf8'));
check('C4', !packageSide.write_expect, 'package-side-question remains dry-run only');

section('D. Existing write modules');

const holdSrc = fs.readFileSync(HOLD_WRITE, 'utf8');
const stripeSrc = fs.readFileSync(STRIPE, 'utf8');
check('D1', holdSrc.includes('isGuestHoldPaymentDraftWriteEnvironment'), 'hold writer has env guard');
check('D2', stripeSrc.includes('isStripeTestSecretKey'), 'stripe module requires test key');

section('E. Syntax');

for (const f of [RUNNER, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('E', `${path.basename(f)} passes node --check`);
  } catch {
    fail('E', `${path.basename(f)} syntax error`);
  }
}

section('Summary');
console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
