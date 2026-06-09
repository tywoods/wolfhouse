/**
 * Stage 27test-d — Verifier for Luna guest flow batch runner.
 *
 * Usage:
 *   npm run verify:stage27test-d-flow-batch
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'run-luna-guest-flow-batch.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'luna-guest-flow-batch.json');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27TEST-D-FLOW-BATCH.md');
const SCRIPT = 'verify:stage27test-d-flow-batch';
const REL = 'scripts/verify-stage27test-d-flow-batch.js';
const SIM_ROUTE = '/staff/bot/guest-automation-review-dry-run';
const INBOUND_ROUTE = '/staff/bot/guest-inbound-review-dry-run';
const HOLD_ROUTE = '/staff/bot/guest-simulator-create-hold-draft';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27test-d-flow-batch.js  (Stage 27test-d)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

section('A. Fixture file');

let fixtureData = null;
if (!fs.existsSync(FIXTURE)) {
  fail('A1', 'luna-guest-flow-batch.json missing');
} else {
  pass('A1', 'fixture file exists');
  try {
    fixtureData = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  } catch {
    fail('A2', 'fixture JSON invalid');
  }
}

if (fixtureData) {
  if (Array.isArray(fixtureData.flows) && fixtureData.flows.length >= 25) {
    pass('A2', `fixture has ${fixtureData.flows.length} flows (>= 25)`);
  } else {
    fail('A2', `flow count ${fixtureData.flows && fixtureData.flows.length} < 25`);
  }

  const langs = new Set(fixtureData.flows.map((f) => f.language));
  for (const lang of ['en', 'it', 'es', 'de', 'fr']) {
    if (langs.has(lang)) pass(`A3.${lang}`, `includes language ${lang}`);
    else fail(`A3.${lang}`, `missing language ${lang}`);
  }

  if (fixtureData.fixture_sets && fixtureData.fixture_sets['booking-core']) {
    pass('A4', 'booking-core fixture set defined');
  } else {
    fail('A4', 'booking-core fixture set missing');
  }

  const coreFlows = fixtureData.flows.filter((f) => f.fixture_set === 'booking-core');
  if (coreFlows.length >= 25) pass('A5', `booking-core has ${coreFlows.length} flows`);
  else fail('A5', `booking-core flow count ${coreFlows.length} < 25`);

  const requiredIds = [
    'flow-en-malibu-deposit',
    'flow-en-malibu-full',
    'flow-en-uluwatu-deposit',
    'flow-en-waimea-beginner',
    'flow-en-accommodation-only',
    'flow-it-booking',
    'flow-inbound-idempotent',
    'flow-en-one-message',
    'flow-en-cancel-refund',
    'flow-en-off-topic-mid',
  ];
  const ids = new Set(fixtureData.flows.map((f) => f.id));
  for (const id of requiredIds) {
    if (ids.has(id)) pass(`A6.${id}`, 'required flow present');
    else fail(`A6.${id}`, 'required flow missing');
  }

  const multiTurn = fixtureData.flows.filter((f) => Array.isArray(f.turns) && f.turns.length >= 2);
  if (multiTurn.length >= 20) pass('A7', `${multiTurn.length} multi-turn flows`);
  else fail('A7', `multi-turn flows ${multiTurn.length} < 20`);
}

section('B. Runner script');

if (fs.existsSync(RUNNER)) pass('B1', 'run-luna-guest-flow-batch.js exists');
else fail('B1', 'runner missing');

const runnerSrc = fs.existsSync(RUNNER) ? fs.readFileSync(RUNNER, 'utf8') : '';
const runnerCode = runnerSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

try {
  execSync(`node --check "${RUNNER}"`, { stdio: 'pipe' });
  pass('B2', 'runner passes node --check');
} catch {
  fail('B2', 'runner syntax error');
}

if (runnerSrc.includes(SIM_ROUTE)) pass('B3', 'runner targets guest-automation-review-dry-run');
else fail('B3', 'simulator review route missing');

if (runnerSrc.includes(INBOUND_ROUTE)) pass('B4', 'runner supports inbound review route');
else fail('B4', 'inbound review route missing');

if (runnerSrc.includes('runGuestAutomationOrchestratorDryRun')) pass('B5', 'runner supports local orchestrator mode');
else fail('B5', 'local mode missing');

const cliFlags = [
  '--base-url', '--local', '--count', '--fixture-set', '--json', '--fail-fast',
  '--create-hold-draft', '--create-stripe-test-link', '--phone-prefix', '--run-id', '--reference-date',
];
for (const flag of cliFlags) {
  if (runnerSrc.includes(flag)) pass(`B6.${flag}`, `supports ${flag}`);
  else fail(`B6.${flag}`, `missing ${flag}`);
}

if (runnerSrc.includes('review_only') && runnerSrc.includes('!opts.createHoldDraft')) {
  pass('B7', 'default mode is review-only');
} else {
  fail('B7', 'review-only default not evident');
}

if (runnerSrc.includes('write_eligible') && runnerSrc.includes('createHoldDraft')) {
  pass('B8', 'writes gated by --create-hold-draft and write_eligible');
} else {
  fail('B8', 'write gating missing');
}

if (runnerSrc.includes('createStripeTestLink') && runnerSrc.includes('createHoldDraft')) {
  pass('B9', 'Stripe requires --create-hold-draft');
} else {
  fail('B9', 'Stripe flag coupling missing');
}

section('C. Assertions and safety');

if (runnerSrc.includes('checkFlowExpectations') && runnerSrc.includes('findBannedTerms')) {
  pass('C1', 'banned-term checks exist');
} else {
  fail('C1', 'banned-term checks missing');
}

if (runnerSrc.includes('checkSafetyFlags') && /sends_whatsapp/.test(runnerSrc) && /live_send_blocked/.test(runnerSrc)) {
  pass('C2', 'safety flag checks exist');
} else {
  fail('C2', 'safety checks missing');
}

if (runnerSrc.includes('payment_choice_ready') && runnerSrc.includes('quote_status')) {
  pass('C3', 'quote/payment choice assertions exist');
} else {
  fail('C3', 'quote/payment assertions missing');
}

if (runnerSrc.includes('isStaffHandoffRequired') && runnerSrc.includes('must_not_reask')) {
  pass('C4', 'handoff and re-ask checks exist');
} else {
  fail('C4', 'handoff/re-ask checks missing');
}

if (runnerSrc.includes('idempotent_replay')) {
  pass('C5', 'inbound idempotency assertion supported');
} else {
  fail('C5', 'idempotency assertion missing');
}

section('D. No live side effects in default runner path');

const forbidden = [
  ['D1', 'sendWhatsApp', 'WhatsApp send'],
  ['D2', 'handleBotGuestReplySend', 'guest reply send'],
  ['D3', 'calls_n8n', 'n8n call flag in runner'],
];
for (const [id, sym, label] of forbidden) {
  if (!runnerCode.includes(sym)) pass(id, `runner does not invoke ${label}`);
  else fail(id, `runner invokes ${label}`);
}

if (runnerSrc.includes('createHoldDraft') && runnerSrc.includes(HOLD_ROUTE)) {
  pass('D4', 'hold route only when --create-hold-draft');
} else {
  fail('D4', 'hold route gating unclear');
}

if (!/api\.stripe\.com|graph\.facebook\.com|fetch\s*\([^)]*n8n/i.test(runnerCode)) {
  pass('D5', 'no Stripe/WhatsApp/n8n fetch in runner');
} else {
  fail('D5', 'forbidden external fetch in runner');
}

if (runnerSrc.includes('assertNotProduction')) {
  pass('D6', 'production host guard present');
} else {
  fail('D6', 'production host guard missing');
}

section('E. Docs and npm scripts');

if (fs.existsSync(DOC)) pass('E1', 'STAGE-27TEST-D-FLOW-BATCH.md exists');
else fail('E1', 'doc missing');

if (fs.existsSync(DOC)) {
  const doc = fs.readFileSync(DOC, 'utf8');
  if (doc.includes('run-luna-guest-flow-batch.js')) pass('E2', 'doc mentions runner');
  else fail('E2', 'doc missing runner');
  if (/local|staging|127\.0\.0\.1/i.test(doc)) pass('E3', 'doc includes local/staging usage');
  else fail('E3', 'doc missing usage');
  if (/create-hold-draft|create-stripe-test-link/i.test(doc)) pass('E4', 'doc includes write/Stripe usage');
  else fail('E4', 'doc missing write/Stripe usage');
}

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${REL}`) pass('E5', `${SCRIPT} registered`);
else fail('E5', `${SCRIPT} npm script missing`);

if (pkg.scripts && pkg.scripts['luna:guest-flow-batch']) pass('E6', 'luna:guest-flow-batch npm script registered');
else fail('E6', 'luna:guest-flow-batch npm script missing');

section('F. Self-test helpers');

try {
  const { checkFlowExpectations } = require('./run-luna-guest-flow-batch.js');
  const mockBody = {
    success: true,
    dry_run: true,
    sends_whatsapp: false,
    live_send_blocked: true,
    no_write_performed: true,
    review: {
      proposed_next_action: 'ask_missing_details',
      proposed_luna_reply: 'When would you like to stay?',
      result: { message_lane: 'new_booking_inquiry', booking_intake_ready: false },
    },
  };
  const fails = checkFlowExpectations({ message_lane: 'new_booking_inquiry', banned_reply_terms_absent: true }, mockBody);
  if (fails.length === 0) pass('F1', 'checkFlowExpectations passes valid mock');
  else fail('F1', `checkFlowExpectations unexpected failures: ${fails.join('; ')}`);
} catch (e) {
  fail('F1', `helper self-test failed: ${e.message}`);
}

section('G. Hosted proof hygiene');

if (runnerSrc.includes('buildFlowPhone') && runnerSrc.includes('resolvedRunId')) {
  pass('G1', 'runner builds endpoint phones with run id');
} else {
  fail('G1', 'endpoint phone run-id builder missing');
}

if (runnerSrc.includes('buildInboundMessageId')) {
  pass('G2', 'inbound message ids derived from run id (no hard-coded staging ids)');
} else {
  fail('G2', 'run-scoped inbound id builder missing');
}

if (fixtureData) {
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  if (!raw.includes('batch-idempotent-flow-27testd-001')) {
    pass('G3', 'fixture has no hard-coded staging inbound id');
  } else {
    fail('G3', 'fixture still contains hard-coded staging inbound id');
  }

  const unavailable = fixtureData.flows.find((f) => f.id === 'flow-en-unavailable-dates');
  if (unavailable
      && unavailable.final_expect
      && unavailable.final_expect.quote_status === 'ready'
      && unavailable.final_expect.handoff_required === false
      && unavailable.final_expect.availability_check_attempted === true) {
    pass('G4', 'flow-en-unavailable-dates expects quote-ready with availability checked');
  } else {
    fail('G4', 'flow-en-unavailable-dates expectations inconsistent');
  }

  const changeDates = fixtureData.flows.find((f) => f.id === 'flow-en-change-dates');
  const changeTurn = changeDates && changeDates.turns && changeDates.turns.find((t) => /change dates/i.test(t.message || ''));
  if (changeTurn && !/august/i.test(changeTurn.message || '')) {
    pass('G5', 'flow-en-change-dates uses staging-aligned alternate date window');
  } else {
    fail('G5', 'flow-en-change-dates still uses August window known unavailable on staging');
  }

  const idem = fixtureData.flows.find((f) => f.id === 'flow-inbound-idempotent');
  if (idem && idem.turns.some((t) => t.reuse_inbound_message_id)) {
    pass('G6', 'flow-inbound-idempotent explicitly tests replay via reuse_inbound_message_id');
  } else {
    fail('G6', 'inbound idempotency fixture missing replay flag');
  }
}

try {
  const { buildFlowPhone, buildInboundMessageId, resolveRunId } = require('./run-luna-guest-flow-batch.js');
  const runId = resolveRunId('batch-test');
  const opts = { resolvedRunId: runId, phonePrefix: '+34600998' };
  const p0 = buildFlowPhone('endpoint', opts, 0);
  const p1 = buildFlowPhone('endpoint', opts, 1);
  const idemFlow = { id: 'flow-inbound-idempotent', turns: [{ reuse_inbound_message_id: true }] };
  const id1 = buildInboundMessageId(idemFlow, opts, 2, 0, true);
  const id2 = buildInboundMessageId(idemFlow, opts, 2, 1, true);
  if (p0 !== p1 && id1 === id2 && id1.includes(runId)) {
    pass('G7', 'endpoint phones unique per flow; idempotent fixture reuses inbound id within run');
  } else {
    fail('G7', 'endpoint phone/inbound id hygiene incorrect');
  }
} catch (e) {
  fail('G7', `flow batch hygiene self-test failed: ${e.message}`);
}

section('Summary');

console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
