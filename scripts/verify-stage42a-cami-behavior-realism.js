/**
 * Stage 42a — Cami behavior realism + tone judge verifier.
 *
 * Usage:
 *   npm run verify:stage42a-cami-behavior-realism
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PERSONALITY = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.personalities.json');
const VARIATION = path.join(__dirname, 'lib', 'luna-guest-cami-reply-variation.js');
const TONE_JUDGE = path.join(__dirname, 'lib', 'luna-cami-tone-judge.js');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'cami-realism');
const BATCH = path.join(__dirname, 'lib', 'luna-conversation-fixture-set-batch.js');
const RUN_BATCH = path.join(__dirname, 'run-luna-guest-flow-batch.js');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const TRUTH = path.join(__dirname, 'lib', 'luna-guest-stripe-payment-truth-apply.js');
const STYLE = path.join(__dirname, 'lib', 'luna-guest-reply-style-contract.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage42a-cami-behavior-realism';

const { judgeCamiTone } = require('./lib/luna-cami-tone-judge');
const { pickCamiVariant, loadCamiBehavior, resolveCamiTemplate } = require('./lib/luna-guest-cami-reply-variation');
const { validateComposerFacts } = require('./lib/luna-guest-reply-style-contract');
const { FIXTURE_SET_DIRS } = require('./lib/luna-conversation-fixture-set-batch');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage42a-cami-behavior-realism.js  (Stage 42a)\n');

section('A. Files + package');

check('A1', fs.existsSync(VARIATION), 'reply variation helper exists');
check('A2', fs.existsSync(TONE_JUDGE), 'Cami tone judge exists');
check('A3', fs.existsSync(FIXTURE_DIR), 'cami-realism fixture directory exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A4', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const fixtureFiles = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'));
check('A5', fixtureFiles.length === 10, `10 cami-realism fixtures (got ${fixtureFiles.length})`);

section('B. Cami behavior profile');

const personality = JSON.parse(fs.readFileSync(PERSONALITY, 'utf8'));
const cami = personality.personalities && personality.personalities.cami;
const behavior = cami && cami.behavior;
check('B1', !!behavior, 'Cami behavior layer exists');
check('B2', behavior && behavior.core_patterns && behavior.core_patterns.one_question_at_a_time === true, 'one-question-at-a-time rule');
check('B3', behavior && Array.isArray(behavior.soft_logistics_rules) && behavior.soft_logistics_rules.length >= 2, 'soft logistics rules');
check('B4', behavior && Array.isArray(behavior.reassurance_rules) && behavior.reassurance_rules.length >= 2, 'reassurance rules');
check('B5', behavior && Array.isArray(behavior.uncertainty_rules) && behavior.uncertainty_rules.length >= 2, 'uncertainty rules');
check('B6', behavior && behavior.variation_pools && behavior.variation_pools.en && behavior.variation_pools.en.welcome, 'EN welcome variation pool');

section('C. Reply variation helper');

const behaviorLoaded = loadCamiBehavior('wolfhouse-somo');
check('C1', !!behaviorLoaded, 'loadCamiBehavior returns Cami behavior');
const pickedA = pickCamiVariant({
  variants: ['Hello {{name}}', 'Hey {{name}}', 'Hi {{name}}'],
  seed: 'test-seed',
  turnIndex: 0,
  poolKey: 'welcome',
  vars: { name: 'Sam' },
});
check('C2', typeof pickedA === 'string' && pickedA.length > 0, 'variant pick returns non-empty template');
const pickedB = pickCamiVariant({
  variants: ['Hello {{name}}', 'Hey {{name}}', 'Hi {{name}}'],
  seed: 'test-seed',
  turnIndex: 0,
  poolKey: 'welcome',
  vars: { name: 'Sam' },
});
check('C3', pickedA === pickedB, 'variant pick is deterministic for same seed');

section('D. Tone judge');

const warm = judgeCamiTone('Heyyy! Wolfhouse in Somo 🌊 What dates are you thinking?', { priorReplies: [] });
check('D1', warm.cami_score >= 70, `warm reply scores well (${warm.cami_score})`);
check('D2', warm.flags.length === 0 || !warm.flags.includes('no_warmth'), 'warm reply not flagged no_warmth');

const robotic = judgeCamiTone('Great — I\'ll check accommodation availability for your dates.', { priorReplies: [] });
check('D3', robotic.flags.includes('robotic_opening') || robotic.cami_score < 70, 'robotic opening flagged');

const fake = judgeCamiTone('You\'re confirmed — your booking is held!', { priorReplies: [], hasPaymentTruth: false });
check('D4', fake.flags.includes('fake_confirmation'), 'fake certainty flagged without payment truth');

const internal = judgeCamiTone('quote_status is ready in staging dry run', { priorReplies: [] });
check('D5', internal.flags.includes('internal_language'), 'internal language flagged');

check('D6', typeof warm.suggested_category === 'string', 'suggested_category returned');

section('E. Fixture-set runner');

check('E1', FIXTURE_SET_DIRS['cami-realism'] === FIXTURE_DIR, 'batch module registers cami-realism set');
const batchSrc = fs.readFileSync(BATCH, 'utf8');
check('E2', batchSrc.includes('judgeCamiTone'), 'batch runner integrates tone judge');
check('E3', batchSrc.includes('cami_score_average'), 'batch reports cami score average');

const runBatchSrc = fs.readFileSync(RUN_BATCH, 'utf8');
check('E4', runBatchSrc.includes("'cami-realism'"), 'run-luna-guest-flow-batch routes cami-realism');

section('F. Safety — no payment/Stripe/send changes');

const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
const truthSrc = fs.readFileSync(TRUTH, 'utf8');
check('F1', composerSrc.includes('validateComposerFacts'), 'composer still validates business facts');
check('F2', validateComposerFacts('ask_payment_choice', {}).length > 0, 'validateComposerFacts still blocks ungrounded payment choice');
const variationSrc = fs.readFileSync(VARIATION, 'utf8');
check('F3', !variationSrc.includes('sends_whatsapp') && !variationSrc.includes('activateN8n') && !truthSrc.includes('activateN8n'), 'no WhatsApp send or n8n activation in new modules');
check('F4', composerSrc.includes('buildPersonalityReplyLexicon'), 'personality affects wording only via lexicon');

section('G. Expected fixture ids');

const expectedIds = [
  'unsure-package-choice',
  'friend-arrives-later',
  'mixed-services-per-person',
  'can-you-hold-it',
  'i-already-paid',
  'link-doesnt-work',
  'transfer-flight-chaos',
  'social-vibe-question',
  'beginners-welcome',
  'repeated-flow-no-template-feel',
];
for (let i = 0; i < expectedIds.length; i++) {
  const id = expectedIds[i];
  check(`G${i + 1}`, fixtureFiles.some((f) => f.replace('.json', '') === id), `fixture ${id} exists`);
}

console.log(`\n── Result: ${failures === 0 ? 'PASS' : 'FAIL'} ──`);
console.log(`${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
