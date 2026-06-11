/**
 * Stage 40a — Random hammer tester verifier.
 *
 * Usage:
 *   npm run verify:stage40a-random-hammer-tester
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GENERATOR = path.join(__dirname, 'lib', 'luna-random-guest-flow-generator.js');
const CLASSIFIER = path.join(__dirname, 'lib', 'luna-hammer-classifier.js');
const RUNNER = path.join(__dirname, 'run-luna-random-hammer-test.js');
const BATCH = path.join(__dirname, 'lib', 'luna-conversation-fixture-set-batch.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage40a-random-hammer-tester';
const HAMMER_SCRIPT = 'hammer:luna';

const { generateHammerScenarios, createSeededRng, SCENARIO_TYPES } = require('./lib/luna-random-guest-flow-generator');
const { HAMMER_FAILURE_CATEGORIES } = require('./lib/luna-hammer-classifier');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage40a-random-hammer-tester.js  (Stage 40a)\n`);

section('A. Files + scripts');

check('A1', fs.existsSync(GENERATOR), 'luna-random-guest-flow-generator.js exists');
check('A2', fs.existsSync(CLASSIFIER), 'luna-hammer-classifier.js exists');
check('A3', fs.existsSync(RUNNER), 'run-luna-random-hammer-test.js exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A4', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);
check('A5', pkg.scripts && pkg.scripts[HAMMER_SCRIPT], `npm script ${HAMMER_SCRIPT}`);

section('B. Generator');

const genSrc = fs.readFileSync(GENERATOR, 'utf8');
check('B1', genSrc.includes('createSeededRng') && genSrc.includes('seed'), 'seed support in generator');
check('B2', genSrc.includes('generateHammerScenarios'), 'generateHammerScenarios exported');
check('B3', SCENARIO_TYPES.length >= 12, `12+ scenario types (${SCENARIO_TYPES.length})`);
check('B4', genSrc.includes("'it'") && genSrc.includes("'de'") && genSrc.includes('mixed'), 'language coverage');

const g1 = generateHammerScenarios({ count: 24, seed: 999, language: 'all' });
const g2 = generateHammerScenarios({ count: 24, seed: 999, language: 'all' });
check('B5', JSON.stringify(g1.scenarios.map((s) => s.id)) === JSON.stringify(g2.scenarios.map((s) => s.id)), 'same seed → same scenarios');
const g3 = generateHammerScenarios({ count: 24, seed: 1000, language: 'all' });
check('B6', JSON.stringify(g1.scenarios.map((s) => s.id)) !== JSON.stringify(g3.scenarios.map((s) => s.id)), 'different seed → different scenarios');

const rngA = createSeededRng(42);
const rngB = createSeededRng(42);
check('B7', rngA() === rngB(), 'seeded RNG deterministic');

section('C. Runner');

const runnerSrc = fs.readFileSync(RUNNER, 'utf8');
check('C1', runnerSrc.includes('--count'), 'count CLI support');
check('C2', runnerSrc.includes('--seed'), 'seed CLI support');
check('C3', runnerSrc.includes('--language'), 'language CLI support');
check('C4', runnerSrc.includes('runConversationFixture'), 'uses conversation state-machine path');
check('C5', runnerSrc.includes('review_only') || runnerSrc.includes('review-only'), 'review-only mode documented');
check('C6', runnerSrc.includes('writeJsonReport') && runnerSrc.includes('writeMarkdownReport'), 'JSON + markdown report support');
check('C7', runnerSrc.includes('exportFailureFixtures') && runnerSrc.includes('--fixture-out'), 'failure fixture export support');

section('D. Classification');

const clsSrc = fs.readFileSync(CLASSIFIER, 'utf8');
check('D1', HAMMER_FAILURE_CATEGORIES.includes('date_parsing'), 'date_parsing category');
check('D2', HAMMER_FAILURE_CATEGORIES.includes('guest_count'), 'guest_count category');
check('D3', HAMMER_FAILURE_CATEGORIES.includes('hallucinated_availability'), 'hallucinated_availability category');
check('D4', clsSrc.includes('suggested_fix_areas') || clsSrc.includes('suggestFixAreas'), 'suggested fix areas');

section('E. Safety');

const batchSrc = fs.readFileSync(BATCH, 'utf8');
check('E1', !runnerSrc.match(/sends_whatsapp:\s*true|graph\.facebook\.com/i), 'no WhatsApp send in hammer runner');
check('E2', !runnerSrc.includes('checkout.sessions.create'), 'no Stripe create in hammer runner');
check('E3', !runnerSrc.includes('n8n.activate'), 'no n8n activation');
check('E4', batchSrc.includes('dry_run: true'), 'batch path uses dry_run');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Stage 40a verifier: ${failures === 0 ? 'PASS' : 'FAIL'} (${passes} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
