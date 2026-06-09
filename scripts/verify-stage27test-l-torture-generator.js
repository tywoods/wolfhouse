/**
 * Stage 27test-l — Verifier for Luna guest torture generator/runner.
 *
 * Usage:
 *   npm run verify:stage27test-l-torture-generator
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GENERATOR = path.join(__dirname, 'generate-luna-guest-torture-fixtures.js');
const RUNNER = path.join(__dirname, 'run-luna-guest-torture-tests.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'generated-luna-guest-torture.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27TEST-L-TORTURE-GENERATOR.md');
const PKG = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27test-l-torture-generator';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27test-l-torture-generator.js  (Stage 27test-l)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

section('A. Generator');

if (fs.existsSync(GENERATOR)) pass('A1', 'generate-luna-guest-torture-fixtures.js exists');
else fail('A1', 'generator missing');

const genSrc = fs.existsSync(GENERATOR) ? fs.readFileSync(GENERATOR, 'utf8') : '';
try {
  execSync(`node --check "${GENERATOR}"`, { stdio: 'pipe' });
  pass('A2', 'generator passes node --check');
} catch {
  fail('A2', 'generator syntax error');
}

if (genSrc.includes('booking_intake_single') && genSrc.includes('multi_turn_booking')) {
  pass('A3', 'generator defines core category builders');
} else {
  fail('A3', 'category builders missing');
}

if (genSrc.includes('27100') || genSrc.includes('SEED')) {
  pass('A4', 'generator uses deterministic seed');
} else {
  fail('A4', 'deterministic seed missing');
}

section('B. Generated fixture');

let fixtureData = null;
if (!fs.existsSync(FIXTURE)) {
  fail('B1', 'generated-luna-guest-torture.json missing — run generator first');
} else {
  pass('B1', 'generated fixture file exists');
  try {
    fixtureData = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  } catch {
    fail('B2', 'fixture JSON invalid');
  }
}

if (fixtureData) {
  if (Array.isArray(fixtureData.cases) && fixtureData.cases.length >= 500) {
    pass('B2', `fixture has ${fixtureData.cases.length} cases (>= 500)`);
  } else {
    fail('B2', `case count ${fixtureData.cases && fixtureData.cases.length} < 500`);
  }

  const cats = {};
  const langs = new Set();
  for (const c of fixtureData.cases) {
    cats[c.category] = (cats[c.category] || 0) + 1;
    langs.add(c.language);
  }

  const requiredCats = [
    'booking_intake_single', 'multi_turn_booking', 'multilingual', 'package_explainer',
    'payment', 'service_addon', 'transfer', 'cancel_change_refund', 'weird_off_topic_angry',
  ];
  for (const cat of requiredCats) {
    if ((cats[cat] || 0) > 0) pass(`B3.${cat}`, `${cat}: ${cats[cat]} cases`);
    else fail(`B3.${cat}`, `missing category ${cat}`);
  }

  for (const lang of ['en', 'it', 'es', 'de', 'fr']) {
    if (langs.has(lang)) pass(`B4.${lang}`, `language ${lang} represented`);
    else fail(`B4.${lang}`, `language ${lang} missing`);
  }
  if (langs.has('mixed')) pass('B4.mixed', 'mixed-language cases present');
  else fail('B4.mixed', 'mixed-language cases missing');

  const withSafety = fixtureData.cases.filter((c) => c.expected && c.expected.banned_reply_terms_absent === true);
  if (withSafety.length === fixtureData.cases.length) {
    pass('B5', 'all cases require banned_reply_terms_absent');
  } else {
    fail('B5', `only ${withSafety.length}/${fixtureData.cases.length} cases have safety expectations`);
  }
}

section('C. Runner');

if (fs.existsSync(RUNNER)) pass('C1', 'run-luna-guest-torture-tests.js exists');
else fail('C1', 'runner missing');

const runnerSrc = fs.existsSync(RUNNER) ? fs.readFileSync(RUNNER, 'utf8') : '';
const runnerCode = runnerSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

try {
  execSync(`node --check "${RUNNER}"`, { stdio: 'pipe' });
  pass('C2', 'runner passes node --check');
} catch {
  fail('C2', 'runner syntax error');
}

if (runnerSrc.includes('review_only: true') || runnerSrc.includes('review-only')) {
  pass('C3', 'default mode is review-only');
} else {
  fail('C3', 'review-only default not evident');
}

if (runnerSrc.includes('checkTortureExpectations') && runnerSrc.includes('hallucination')) {
  pass('C4', 'runner includes torture safety/hallucination checks');
} else {
  fail('C4', 'torture safety checks missing');
}

if (runnerSrc.includes('failures_by_category') && runnerSrc.includes('pass_rate_pct')) {
  pass('C5', 'runner reports scoring by category and pass rate');
} else {
  fail('C5', 'scoring report missing');
}

if (runnerSrc.includes('run-luna-guest-golden-tests') && runnerSrc.includes('run-luna-guest-flow-batch')) {
  pass('C6', 'runner reuses golden/flow batch helpers');
} else {
  fail('C6', 'helper reuse missing');
}

const forbidden = [
  ['C7a', 'sendWhatsApp', 'WhatsApp send'],
  ['C7b', 'runGuestHoldPaymentDraftWriteDryRunApproved', 'hold/payment write'],
  ['C7c', 'runGuestStripeTestLinkCreateApproved', 'Stripe link'],
  ['C7d', 'handleBotGuestReplySend', 'guest reply send'],
];
for (const [id, sym, label] of forbidden) {
  if (!runnerCode.includes(sym)) pass(id, `runner does not call ${label}`);
  else fail(id, `runner calls ${label}`);
}

if (!/api\.stripe\.com|graph\.facebook\.com|fetch\s*\([^)]*n8n/i.test(runnerCode)) {
  pass('C8', 'no Stripe/WhatsApp/n8n fetch in runner');
} else {
  fail('C8', 'forbidden external fetch in runner');
}

if (!runnerSrc.includes('guest-simulator-create-hold-draft') && !runnerSrc.includes('create-hold-draft')) {
  pass('C9', 'runner has no hold/Stripe write path');
} else {
  fail('C9', 'runner references write paths');
}

section('D. Docs and npm scripts');

if (fs.existsSync(DOC)) pass('D1', 'STAGE-27TEST-L-TORTURE-GENERATOR.md exists');
else fail('D1', 'doc missing');

if (fs.existsSync(DOC)) {
  const doc = fs.readFileSync(DOC, 'utf8');
  if (/95%|98%|100%/.test(doc) && /threshold/i.test(doc)) pass('D2', 'doc documents score thresholds');
  else fail('D2', 'score thresholds not documented');
  if (/generate-luna-guest-torture|luna:guest-torture/i.test(doc)) pass('D3', 'doc mentions generator and runner');
  else fail('D3', 'doc missing usage');
}

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('D4', `${SCRIPT} registered`);
else fail('D4', `${SCRIPT} npm script missing`);
if (pkg.scripts && pkg.scripts['luna:guest-torture']) pass('D5', 'luna:guest-torture npm script registered');
else fail('D5', 'luna:guest-torture npm script missing');
if (pkg.scripts && pkg.scripts['luna:guest-torture:generate']) pass('D6', 'luna:guest-torture:generate registered');
else fail('D6', 'generate npm script missing');

section('E. Self-test');

try {
  const { checkTortureExpectations, findHallucinationHits } = require('./run-luna-guest-torture-tests.js');
  const mock = {
    success: true,
    dry_run: true,
    sends_whatsapp: false,
    live_send_blocked: true,
    no_write_performed: true,
    review: {
      proposed_next_action: 'ask_missing_details',
      proposed_luna_reply: 'What dates work for you?',
      result: { message_lane: 'new_booking_inquiry' },
    },
  };
  const fails = checkTortureExpectations({
    expected: { banned_reply_terms_absent: true, must_not_confirm_booking: true },
  }, mock);
  if (fails.length === 0) pass('E1', 'checkTortureExpectations passes safe mock');
  else fail('E1', `unexpected failures: ${fails.join('; ')}`);

  const bad = findHallucinationHits('Your booking is confirmed and payment received');
  if (bad.length >= 2) pass('E2', 'hallucination detector finds risky phrases');
  else fail('E2', 'hallucination detector too weak');
} catch (e) {
  fail('E1', `self-test failed: ${e.message}`);
}

section('Summary');

console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
