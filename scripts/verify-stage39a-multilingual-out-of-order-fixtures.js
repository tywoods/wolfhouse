/**
 * Stage 39a — Multilingual out-of-order fixture pack verifier.
 *
 * Usage:
 *   npm run verify:stage39a-multilingual-out-of-order-fixtures
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'multilingual-out-of-order');
const BATCH_RUNNER = path.join(__dirname, 'run-luna-guest-flow-batch.js');
const BATCH_LIB = path.join(__dirname, 'lib', 'luna-conversation-fixture-set-batch.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const TRUTH = path.join(__dirname, 'lib', 'luna-guest-stripe-payment-truth-apply.js');
const SEND = path.join(__dirname, 'lib', 'luna-guest-confirmation-send-go-no-go.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage39a-multilingual-out-of-order-fixtures';
const RESULTS_DOC = path.join(ROOT, 'docs', 'STAGE-39A-MULTILINGUAL-OUT-OF-ORDER-FIXTURE-RESULTS.md');

const REQUIRED_FIXTURES = [
  'it-short-stay-out-of-order.json',
  'it-package-addons-messy.json',
  'it-yoga-dinner-midflow.json',
  'en-clean-but-casual.json',
  'es-short-stay-cash-question.json',
  'de-package-question.json',
  'mixed-it-en-booking.json',
  'typo-heavy-booking.json',
  'emoji-heavy-surf-addons.json',
  'correction-language-switch.json',
  'reset-spanish.json',
  'german-transfer-side-question.json',
];

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage39a-multilingual-out-of-order-fixtures.js  (Stage 39a)\n`);

section('A. Files + package');

check('A1', fs.existsSync(FIXTURE_DIR), 'multilingual fixture directory exists');
check('A2', fs.existsSync(BATCH_LIB), 'conversation fixture-set batch module exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A3', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);
check('A4', pkg.scripts && pkg.scripts['luna:guest-flow-batch'], 'luna:guest-flow-batch script exists');

const files = fs.existsSync(FIXTURE_DIR)
  ? fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort()
  : [];
check('A5', files.length === 12, `exactly 12 fixtures exist (got ${files.length})`);
for (const f of REQUIRED_FIXTURES) {
  check('A6', files.includes(f), `fixture ${f}`);
}

section('B. Language + style coverage');

const fixtures = files.map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')));
const langs = new Set(fixtures.flatMap((fx) => [fx.language, ...(fx.language_tags || [])]));
check('B1', langs.has('it'), 'Italian coverage');
check('B2', langs.has('en'), 'English coverage');
check('B3', langs.has('es'), 'Spanish coverage');
check('B4', langs.has('de'), 'German coverage');
check('B5', fixtures.some((fx) => (fx.language_tags || []).includes('mixed')), 'mixed language fixture');
check('B6', fixtures.some((fx) => (fx.language_tags || []).includes('typo')), 'typo fixture');
check('B7', fixtures.some((fx) => (fx.language_tags || []).includes('emoji')), 'emoji fixture');

section('C. Scenario assertions');

const allJson = fixtures.map((fx) => JSON.stringify(fx)).join('\n');
check('C1', /expected_language|language_tags/.test(allJson), 'language fields in fixtures');
check('C2', /expected_stale_quote|expected_corrected_fields|correction/.test(allJson), 'correction assertions');
check('C3', /expected_reset_detected|reset-spanish/.test(allJson), 'reset assertions');
check('C4', /expected_service_interest|wetsuit|surfboard|yoga|meal|dinner/.test(allJson), 'add-on/service assertions');
check('C5', /cash|efectivo/.test(allJson), 'cash side-question fixture');
check('C6', /Transfer|transfer/.test(allJson), 'transfer side-question fixture');
check('C7', fixtures.every((fx) => fx.fixture_set === 'multilingual-out-of-order'), 'fixture_set tag on all fixtures');

section('D. Runner wiring');

const batchSrc = fs.readFileSync(BATCH_RUNNER, 'utf8');
const batchLibSrc = fs.readFileSync(BATCH_LIB, 'utf8');
check('D1', batchSrc.includes('multilingual-out-of-order'), 'batch runner routes multilingual-out-of-order');
check('D2', batchLibSrc.includes('runConversationFixtureSetAsBatch'), 'batch lib exports runner');
check('D3', batchLibSrc.includes('detected_language'), 'batch reports language');
check('D4', batchLibSrc.includes('internal_language'), 'batch reports forbidden language');

section('E. Safety');

const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
const truthSrc = fs.readFileSync(TRUTH, 'utf8');
const sendSrc = fs.readFileSync(SEND, 'utf8');
check('E1', !batchLibSrc.match(/sends_whatsapp:\s*true|graph\.facebook\.com/i), 'no WhatsApp send in batch lib');
check('E2', !batchLibSrc.includes('checkout.sessions.create'), 'no Stripe create in batch lib');
check('E3', !sendSrc.includes('multilingual-out-of-order'), 'confirmation send unchanged');
check('E4', !truthSrc.includes('multilingual-out-of-order'), 'payment truth unchanged');
check('E5', !composerSrc.includes('n8n.activate'), 'no n8n activation');
check('E6', routerSrc.includes('empezamos de nuevo'), 'Spanish reset phrase wired');

section('F. Results doc');

check('F1', fs.existsSync(RESULTS_DOC), 'STAGE-39A results doc exists');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Stage 39a verifier: ${failures === 0 ? 'PASS' : 'FAIL'} (${passes} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
