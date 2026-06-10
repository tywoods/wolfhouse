/**
 * Stage 29b.4 — Confirmation send go/no-go after payment truth verifier.
 *
 * Usage:
 *   npm run verify:stage29b4-confirmation-send-go-no-go
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'run-luna-conversation-state-machine-tests.js');
const SEND_MOD = path.join(__dirname, 'lib', 'luna-guest-confirmation-send-go-no-go.js');
const SHORT_STAY = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'short-stay-accommodation-only-to-deposit.json');
const SEVEN_NIGHT = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'seven-night-direct-package-to-deposit.json');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage29b4-confirmation-send-go-no-go';

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage29b4-confirmation-send-go-no-go.js  (Stage 29b.4)\n');

section('A. Runner + package');

check('A1', fs.existsSync(RUNNER), 'runner exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A2', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const runnerSrc = fs.readFileSync(RUNNER, 'utf8');
const sendSrc = fs.readFileSync(SEND_MOD, 'utf8');

section('B. --attempt-confirmation-send CLI');

check('B1', runnerSrc.includes('--attempt-confirmation-send'), 'supports --attempt-confirmation-send');
check('B2', runnerSrc.includes('attemptConfirmationSend'), 'parses attemptConfirmationSend');
check('B3', runnerSrc.includes('--attempt-confirmation-send requires --expect-confirmation-preview'),
  'requires confirmation preview first');
check('B4', runnerSrc.includes('--allow-real-whatsapp-send'), 'supports --allow-real-whatsapp-send');
check('B5', runnerSrc.includes('--allow-real-whatsapp-send requires --attempt-confirmation-send'),
  'real WhatsApp requires send attempt');
check('B6', runnerSrc.includes('WHATSAPP_DRY_RUN_must_be_false') || runnerSrc.includes('WHATSAPP_DRY_RUN=false'),
  'refuses real WhatsApp without explicit env');

section('C. Existing confirmation send go/no-go path');

check('C1', runnerSrc.includes('runGuestConfirmationSendGoNoGo'),
  'uses Stage 27r confirmation send go/no-go');
check('C2', sendSrc.includes('sendLunaBookingConfirmation'), 'go/no-go reuses Phase 20j send path');
check('C3', !runnerSrc.includes('sendLunaBookingConfirmation'),
  'runner does not import send helper directly');
check('C4', sendSrc.includes('buildPreviewLoaderFrom27q'), 'injects 27q preview not regenerated');

section('D. Prerequisites');

check('D1', runnerSrc.includes('confirmation_preview_required') || runnerSrc.includes('confirmation_preview_not_ready'),
  'send requires preview ready');
check('D2', runnerSrc.includes('payment_truth_required_before_confirmation_preview')
  || runnerSrc.includes('deposit_paid'),
  'payment truth prerequisite preserved in chain');

section('E. Send assertions');

check('E1', runnerSrc.includes('checkConfirmationSendExpectations'), 'confirmation send expectation checks');
check('E2', runnerSrc.includes('expected_send_status_without_approval'), 'blocked without approval');
check('E3', runnerSrc.includes('expected_send_status'), 'expected send status assertion');
check('E4', runnerSrc.includes('duplicate_confirmation_blocked'), 'duplicate send blocked');
check('E5', runnerSrc.includes('confirmation_message_matches_preview'), 'preview-grounded message check');
check('E6', runnerSrc.includes('whatsapp_sent_expected'), 'WhatsApp send expectation');
check('E7', runnerSrc.includes('provider_send_performed'), 'provider send tracking');
check('E8', runnerSrc.includes('printConfirmationSendDiagnostics'), 'send diagnostics printer');

section('F. Safety');

check('F1', runnerSrc.includes('assertNotProduction') && runnerSrc.includes('assertNotProductionDb'),
  'production refused');
check('F2', runnerSrc.includes('isWhatsappDryRun') || runnerSrc.includes('WHATSAPP_DRY_RUN'),
  'WhatsApp dry-run default preserved');
check('F3', runnerSrc.includes('evaluateConfirmationLiveSendAllowlist'),
  'live send allowlist gate for real WhatsApp flag');
check('F4', runnerSrc.includes('calls_n8n') && runnerSrc.includes('calls_n8n_expected'),
  'no n8n assertion');
check('F5', runnerSrc.includes('stripe_live_used') || runnerSrc.includes('isStripeTestSecretKey'),
  'Stripe test safety preserved in chain');

section('G. Fixtures');

for (const [id, file] of [['G1', SHORT_STAY], ['G2', SEVEN_NIGHT]]) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(id, data.confirmation_send_expect && data.confirmation_send_expect.confirmation_send_attempted === true,
    `${path.basename(file)} has confirmation_send_expect`);
}

section('H. Syntax');

for (const f of [RUNNER, SEND_MOD, __filename]) {
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
