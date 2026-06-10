/**
 * Stage 29b.3 — Confirmation preview after payment truth verifier.
 *
 * Usage:
 *   npm run verify:stage29b3-confirmation-preview-after-payment
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'run-luna-conversation-state-machine-tests.js');
const PREVIEW = path.join(__dirname, 'lib', 'luna-guest-confirmation-preview-dry-run.js');
const SHORT_STAY = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'short-stay-accommodation-only-to-deposit.json');
const SEVEN_NIGHT = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'seven-night-direct-package-to-deposit.json');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage29b3-confirmation-preview-after-payment';

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage29b3-confirmation-preview-after-payment.js  (Stage 29b.3)\n');

section('A. Runner + package');

check('A1', fs.existsSync(RUNNER), 'runner exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A2', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const runnerSrc = fs.readFileSync(RUNNER, 'utf8');
const previewSrc = fs.readFileSync(PREVIEW, 'utf8');

section('B. --expect-confirmation-preview CLI');

check('B1', runnerSrc.includes('--expect-confirmation-preview'), 'supports --expect-confirmation-preview');
check('B2', runnerSrc.includes('expectConfirmationPreview'), 'parses expectConfirmationPreview');
check('B3', runnerSrc.includes('--expect-confirmation-preview requires --simulate-stripe-webhook'),
  'requires payment truth simulation first');

section('C. Existing confirmation preview path');

check('C1', runnerSrc.includes('runGuestConfirmationPreviewDryRun'),
  'uses Stage 27q confirmation preview dry-run');
check('C2', previewSrc.includes('getLunaBookingConfirmationPreview'),
  'preview helper reuses Phase 14b path');
check('C3', !runnerSrc.includes('sendLunaBookingConfirmation'),
  'no direct live confirmation send import');

section('D. Payment truth prerequisite');

check('D1', runnerSrc.includes('payment_truth_required_before_confirmation_preview'),
  'preview requires deposit_paid/paid from webhook');
check('D2', runnerSrc.includes('deposit_paid') || runnerSrc.includes("'paid'"),
  'checks paid booking payment status');

section('E. Confirmation assertions');

check('E1', runnerSrc.includes('checkConfirmationExpectations'), 'confirmation expectation checks');
check('E2', runnerSrc.includes('confirmation_preview_ready'), 'preview ready assertion');
check('E3', runnerSrc.includes('2684') || runnerSrc.includes('gate_code_present'),
  'gate code expectation');
check('E4', runnerSrc.includes('confirmation_message_contains_booking_code'), 'booking code expectation');
check('E5', runnerSrc.includes('confirmation_message_contains_paid_cents'), 'paid amount expectation');
check('E6', runnerSrc.includes('confirmation_sent_at_unchanged') || runnerSrc.includes('confirmation_sent_at_before'),
  'confirmation_sent_at unchanged assertion');
check('E7', runnerSrc.includes('INTERNAL_LANGUAGE_BLACKLIST') || runnerSrc.includes('confirmation_message_not_contains'),
  'no internal/dev language checks');
check('E8', runnerSrc.includes('messageHasBedLeak') || runnerSrc.includes('bed_number_exposed'),
  'bed number exposure detection');

section('F. Safety');

check('F1', runnerSrc.includes('assertNotProduction') && runnerSrc.includes('assertNotProductionDb'),
  'production refused');
check('F2', runnerSrc.includes('sends_whatsapp') && runnerSrc.includes('calls_n8n must not'),
  'no WhatsApp/n8n');
check('F3', runnerSrc.includes('printConfirmationPreviewDiagnostics'), 'preview diagnostics printer');

section('G. Fixtures');

for (const [id, file] of [['G1', SHORT_STAY], ['G2', SEVEN_NIGHT]]) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(id, data.confirmation_expect && data.confirmation_expect.confirmation_preview_ready === true,
    `${path.basename(file)} has confirmation_expect`);
}

section('H. Syntax');

for (const f of [RUNNER, PREVIEW, __filename]) {
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
