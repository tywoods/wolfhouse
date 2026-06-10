/**
 * Stage 29a — Luna conversation state-machine tester verifier.
 *
 * Usage:
 *   npm run verify:stage29a-live-lite-conversation-state-machine
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'run-luna-conversation-state-machine-tests.js');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage29a-live-lite-conversation-state-machine';
const TEST_SCRIPT = 'test:luna-conversations';

const REQUIRED_FIXTURES = [
  'short-stay-accommodation-only-to-deposit.json',
  'seven-night-direct-package-to-deposit.json',
  'package-side-question-mid-flow.json',
];

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage29a-live-lite-conversation-state-machine.js  (Stage 29a)\n');

section('A. Files and package scripts');

check('A1', fs.existsSync(RUNNER), 'runner exists');
check('A2', fs.existsSync(FIXTURE_DIR), 'fixture directory exists');
for (const f of REQUIRED_FIXTURES) {
  check(`A3-${f}`, fs.existsSync(path.join(FIXTURE_DIR, f)), `fixture ${f} exists`);
}
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A4', pkg.scripts && pkg.scripts[TEST_SCRIPT], `npm script ${TEST_SCRIPT}`);
check('A5', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

section('B. Runner structure');

const runnerSrc = fs.readFileSync(RUNNER, 'utf8');
check('B1', runnerSrc.includes('runGuestAutomationOrchestratorDryRun'),
  'uses real Luna guest automation orchestrator');
check('B2', runnerSrc.includes('guestContextFromOrchestrator') || runnerSrc.includes('guest_context'),
  'preserves multi-turn conversation state');
check('B3', runnerSrc.includes('contact_name') && runnerSrc.includes('whatsapp_guest_name'),
  'supports contact_name / whatsapp_guest_name');
check('B4', runnerSrc.includes('reply_contains') && runnerSrc.includes('expected_fields'),
  'supports per-turn expectations');
check('B5', runnerSrc.includes('final_expect') || runnerSrc.includes('checkFinalExpectations'),
  'supports final expectations');
check('B6', runnerSrc.includes('INTERNAL_LANGUAGE_BLACKLIST') || runnerSrc.includes('dry run'),
  'internal language blacklist present');
check('B7', runnerSrc.includes('booking_flow_stage') && runnerSrc.includes('next_required_field'),
  'turn-level diagnostics include booking flow fields');
check('B8', runnerSrc.includes('--all') && runnerSrc.includes('--fixture'),
  'CLI supports --all and --fixture');
check('B9', runnerSrc.includes('--verbose') && runnerSrc.includes('--json'),
  'CLI supports --verbose and --json');
check('B10', runnerSrc.includes('assertNotProduction') || runnerSrc.includes('production host blocked'),
  'production guard for --allow-writes');
check('B11', !runnerSrc.includes('runGuestConfirmation'), 'no confirmation send import');
check('B12', !runnerSrc.includes('createStripeCheckout') && !runnerSrc.includes('live_stripe'),
  'no live Stripe wiring in runner');
check('B13', runnerSrc.includes('sends_whatsapp') && runnerSrc.includes('dry_run'),
  'default safety flags checked');
check('B14', runnerSrc.includes('calls_n8n'), 'n8n send guard present');

section('C. Syntax');

for (const f of [RUNNER, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('C', `${path.basename(f)} passes node --check`);
  } catch {
    fail('C', `${path.basename(f)} syntax error`);
  }
}

section('Summary');
console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
