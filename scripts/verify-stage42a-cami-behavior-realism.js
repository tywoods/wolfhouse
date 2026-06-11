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

const { judgeCamiTone, hasHonestHedge, hasConstraintAlternative, hasBareRefusal } = require('./lib/luna-cami-tone-judge');
const {
  pickCamiVariant,
  loadCamiBehavior,
  applyCamiReplyVariation,
  hasCloserEnding,
  resolveCamiTemplate,
} = require('./lib/luna-guest-cami-reply-variation');
const { validateComposerFacts } = require('./lib/luna-guest-reply-style-contract');
const { FIXTURE_SET_DIRS } = require('./lib/luna-conversation-fixture-set-batch');
const { buildPersonalityPaymentSideReply } = require('./lib/luna-guest-personality-config');
const { buildPaymentQuestionReply, REPLY_TEMPLATES } = require('./lib/luna-guest-message-router');

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
check('A5', fixtureFiles.length === 14, `14 cami-realism fixtures (got ${fixtureFiles.length})`);

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
const enPools = behavior && behavior.variation_pools && behavior.variation_pools.en;
check('B7', enPools && Array.isArray(enPools.closers) && enPools.closers.length >= 3, 'EN closers variation pool');
const quoteVariants = enPools && enPools.quote_ready;
check('B8', quoteVariants && quoteVariants.filter((v) => /^yesss/i.test(v)).length <= 1, 'quote_ready has at most one Yesss variant');
const hedgeSurf = enPools && enPools.surf_report_fallback;
check('B9', hedgeSurf && hedgeSurf.some((v) => /more or less|i think|depends on|let you know|not 100% sure|we'll sort/i.test(v)), 'surf_report_fallback has honest-hedge variant');
check('B10', behavior.scenario_guides && behavior.scenario_guides.constraint_plus_alternative, 'constraint_plus_alternative scenario guide');
const transferVariants = enPools && enPools.transfer_side_question;
check('B11', transferVariants && transferVariants.some((v) => /\bbut\b/i.test(v) && /don't|do not|usually don't/i.test(v)), 'transfer pool has constraint+alternative variant');
const correctionVariants = enPools && enPools.correction_accepted;
check('B12', correctionVariants && correctionVariants.some((v) => /mixed that up|mix-up|fix it/i.test(v)), 'correction pool has self-honest variant');
const addonDeclined = enPools && enPools.addons_declined;
check('B13', addonDeclined && addonDeclined.some((v) => /no stress|change your mind/i.test(v)), 'addons_declined has zero-pressure variant');

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

const closerApplied = applyCamiReplyVariation('Quick Somo surf snapshot 🌊 Things can move fast.', {
  clientSlug: 'wolfhouse-somo',
  lang: 'en',
  composerState: 'explain_surf_report',
  variationCtx: { seed: 'closer-test', turnIndex: 2, usedOpeners: [], usedClosers: [], italianWarmthUsed: false },
});
check('C4', hasCloserEnding(closerApplied), 'closer appended when reply has no question');
check('C5', !hasCloserEnding(applyCamiReplyVariation('What dates are you thinking?', {
  clientSlug: 'wolfhouse-somo',
  lang: 'en',
  composerState: 'ask_dates',
  variationCtx: { seed: 'closer-test', turnIndex: 0, usedOpeners: [], usedClosers: [] },
})), 'no closer when reply already has a question');

const paymentCloser = applyCamiReplyVariation('Would you rather pay the {{deposit}} deposit or the full {{total}}?', {
  clientSlug: 'wolfhouse-somo',
  lang: 'en',
  composerState: 'ask_payment_choice',
  variationCtx: { seed: 'pay-closer', turnIndex: 1, usedOpeners: [], usedClosers: [], italianWarmthUsed: false },
});
check('C6', !/\bbacioni\b/i.test(paymentCloser) && !/\bun abbraccio\b/i.test(paymentCloser) && !/\ba domani\b/i.test(paymentCloser), 'payment lane does not get Italian affection closers');

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

const closerReply = judgeCamiTone('Quick Somo surf snapshot 🌊 Things can move fast.\n\nTalk soon ☀️', { priorReplies: [] });
check('D7', !closerReply.flags.includes('missing_next_step'), 'closer_present suppresses missing_next_step');
check('D8', closerReply.details.closer_present === true, 'closer_present tracked in details');

const hedgeReply = judgeCamiTone('I think conditions should be decent — more or less depends on the day.', { priorReplies: [] });
check('D9', !hedgeReply.flags.includes('no_warmth'), 'honest hedge avoids no_warmth flag');
check('D10', hasHonestHedge('I think conditions should be decent — more or less depends on the day.'), 'hasHonestHedge helper');

const yesssOnly = judgeCamiTone('Yesss, love that 🌊 What dates are you thinking?', { priorReplies: [] });
check('D11', yesssOnly.cami_score >= 70, 'Yesss reply still scores ok but is not sole energy marker');

const bareNo = judgeCamiTone('We cannot do bus-station transfers.', { priorReplies: [] });
check('D12', bareNo.flags.includes('bare_refusal'), 'bare refusal flagged when no alternative');
check('D13', hasBareRefusal('We cannot do bus-station transfers.'), 'hasBareRefusal helper');

const constraintAlt = judgeCamiTone(
  "We usually don't do bus-station transfers — but we can pick everyone up together from the airport instead 😊 Share your flight details?",
  { priorReplies: [] },
);
check('D14', !constraintAlt.flags.includes('bare_refusal'), 'constraint+alternative not flagged bare_refusal');
check('D15', constraintAlt.details.constraint_alternative === true, 'constraint_alternative tracked in details');
check('D16', constraintAlt.cami_score >= 70, `constraint+alternative scores well (${constraintAlt.cami_score})`);

const uncertaintySort = judgeCamiTone(
  "Not 100% sure on tomorrow's surf yet — depends a bit on the day, but we'll sort it 🌊 Ask anytime.",
  { priorReplies: [] },
);
check('D17', !uncertaintySort.flags.includes('bare_refusal'), 'uncertainty + sort-it passes without bare_refusal');
check('D18', !uncertaintySort.flags.includes('fake_confirmation'), 'uncertainty reply does not trigger fake certainty');
check('D19', uncertaintySort.details.constraint_alternative === true || hasConstraintAlternative("Not 100% sure — depends on the day, but we'll sort it."), 'hasConstraintAlternative on uncertainty reply');

section('H. Stage 42b — payment/transfer edge wording');

const camiTpl = cami && cami.reply_templates && cami.reply_templates.en;
const edgeCtx = { seed: 'stage42b-edge', turnIndex: 0, usedOpeners: [], usedClosers: [], italianWarmthUsed: false };

const alreadyPaidReply = resolveCamiTemplate(
  'wolfhouse-somo', 'en', 'already_paid_check', camiTpl && camiTpl.already_paid_check, {}, edgeCtx,
);
check('H1', alreadyPaidReply && /team will check|can't confirm payment/i.test(alreadyPaidReply), 'already-paid wording checks with team');
check('H2', alreadyPaidReply && !/\b(you(?:'|')?re confirmed|payment received|deposit is in)\b/i.test(alreadyPaidReply), 'already-paid does not assert payment truth');

const payLaterReply = resolveCamiTemplate(
  'wolfhouse-somo', 'en', 'pay_later_explainer', camiTpl && camiTpl.pay_later_explainer, { deposit: '€200', total: '€800' }, edgeCtx,
);
check('H3', payLaterReply && /hold|deposit|full payment/i.test(payLaterReply), 'pay-later clarifies hold/deposit need');
check('H4', payLaterReply && !/\bconfirmed\b/i.test(payLaterReply.toLowerCase()), 'pay-later does not confirm booking');

const cashReply = resolveCamiTemplate(
  'wolfhouse-somo', 'en', 'cash_side_question', camiTpl && camiTpl.answer_arrival_payment_question,
  { deposit: '€200', total: '€800' }, edgeCtx,
);
check('H5', cashReply && /deposit.*full|full.*deposit/i.test(cashReply), 'cash-on-arrival clarifies deposit/full hold step');

const linkFailReply = resolveCamiTemplate(
  'wolfhouse-somo', 'en', 'payment_link_failed', camiTpl && camiTpl.payment_link_failed, { deposit: '€200' }, edgeCtx,
);
check('H6', linkFailReply && /team will send|fresh secure link/i.test(linkFailReply), 'broken link gives calm next step');
check('H7', linkFailReply && !/\b(you(?:'|')?re confirmed|payment received)\b/i.test(linkFailReply), 'broken link does not fake confirmation');

const busTransfer = "We usually don't do bus-station transfers — but we can pick everyone up together from the airport instead 😊 Share your flight details?";
const busJudge = judgeCamiTone(busTransfer, { priorReplies: [] });
check('H8', !busJudge.flags.includes('bare_refusal'), 'bus-station constraint+alternative avoids bare_refusal');

const delayedTransfer = "No stress if you're arriving late or your flight shifts — send your updated time and we'll sort pickup 👍";
check('H9', !judgeCamiTone(delayedTransfer, { priorReplies: [] }).flags.includes('bare_refusal'), 'delayed arrival wording avoids bare_refusal');

const payCloserGuard = applyCamiReplyVariation('Would you rather pay the €200 deposit or the full €800?', {
  clientSlug: 'wolfhouse-somo',
  lang: 'en',
  composerState: 'ask_payment_choice',
  variationCtx: { seed: '42b-pay', turnIndex: 2, usedOpeners: [], usedClosers: [], italianWarmthUsed: false },
});
check('H10', !/\bbacioni\b/i.test(payCloserGuard) && !/❤️❤️|🩷🩷/.test(payCloserGuard), 'payment lane avoids Italian/heavy affection closers');

section('I. Stage 42b.1 — router payment side-question wiring');

const routerSrc = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-message-router.js'), 'utf8');
check('I1', routerSrc.includes('buildPersonalityPaymentSideReply'), 'router delegates to personality payment side helper');

const quoteGuestCtx = {
  quote: {
    quote_status: 'ready',
    quote_total_cents: 80000,
    deposit_options: { deposit_required_cents: 20000 },
  },
};

const routerAlreadyPaid = buildPaymentQuestionReply('en', 'already_paid_claim', false, [], quoteGuestCtx, 'wolfhouse-somo');
check('I2', routerAlreadyPaid && /team will check|can't confirm payment/i.test(routerAlreadyPaid), 'router already-paid uses Cami pool wording');
check('I3', routerAlreadyPaid && !/\b(you(?:'|')?re confirmed|payment received)\b/i.test(routerAlreadyPaid), 'router already-paid does not fake payment truth');
check('I4', !routerAlreadyPaid.startsWith(REPLY_TEMPLATES.en.intro), 'router Cami path skips legacy intro prefix');

const routerPayLater = buildPaymentQuestionReply('en', 'pay_later', true, [], quoteGuestCtx, 'wolfhouse-somo');
check('I5', routerPayLater && /hold|deposit|full|arrival/i.test(routerPayLater), 'router pay-later with quote clarifies hold step');

const routerPayLaterNoQuote = buildPaymentQuestionReply('en', 'pay_later', false, [], {}, 'wolfhouse-somo');
check('I6', routerPayLaterNoQuote && /hold|deposit|full payment|on arrival/i.test(routerPayLaterNoQuote), 'router pay-later without quote uses explainer pool');

const routerLinkFail = buildPaymentQuestionReply('en', 'payment_failed', true, [], quoteGuestCtx, 'wolfhouse-somo');
check('I7', routerLinkFail && /hiccup|team will send|secure.*link/i.test(routerLinkFail), 'router payment_failed uses Cami link-failure wording');
check('I8', routerLinkFail && !/\b(you(?:'|')?re confirmed|payment received)\b/i.test(routerLinkFail), 'router payment_failed does not fake confirmation');

const fallbackAlreadyPaid = buildPaymentQuestionReply('en', 'already_paid_claim', false, [], {}, 'unknown-client-no-personality');
check('I9', fallbackAlreadyPaid && fallbackAlreadyPaid.includes(REPLY_TEMPLATES.en.pay_already_paid_check), 'non-Cami client keeps safe router fallback copy');

const directSide = buildPersonalityPaymentSideReply('wolfhouse-somo', 'en', 'already_paid_claim', { guestCtx: quoteGuestCtx });
check('I10', directSide && directSide === routerAlreadyPaid, 'personality helper matches router Cami path for already-paid');

section('J. Stage 42b.2 — broken-link beats link-request detection');

const { detectPaymentQuestionKind } = require('./lib/luna-guest-message-router');
check('J1', detectPaymentQuestionKind("The payment link doesn't work") === 'payment_failed', 'broken link classified as payment_failed not link request');
check('J2', detectPaymentQuestionKind('Can you send me the payment link?') === 'payment_link_request', 'plain link request still works');

const fixtureExpectSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'luna-fixture-expectations.js'), 'utf8');
check('J3', fixtureExpectSrc.includes('no_bare_refusal'), 'fixture helper supports no_bare_refusal');
check('J4', fixtureExpectSrc.includes('no_italian_payment_closer'), 'fixture helper supports no_italian_payment_closer');
check('J5', fixtureExpectSrc.includes('expected_message_lane'), 'fixture helper supports expected_message_lane');

const orchSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'luna-guest-automation-orchestrator-dry-run.js'), 'utf8');
check('J6', orchSrc.includes("result.message_lane === 'payment_question'"), 'orchestrator prefers router payment_question reply');

section('K. Stage 42b.2a — soft transfer booking continuation tail');

const { buildComposerTransferReply } = require('./lib/luna-guest-reply-composer');
const busStationReply = buildComposerTransferReply('en', 'Can you pick me up from the bus station?', {
  check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1,
}, null);
check('K1', busStationReply && /usually don't|bus-station/i.test(busStationReply) && /airport/i.test(busStationReply), 'bus-station has constraint+alternative');
check('K2', busStationReply && !/Want to continue with your booking/i.test(busStationReply), 'bus-station avoids stiff continuation tail');
check('K3', busStationReply && /keep going|from there|booking moving/i.test(busStationReply), 'bus-station keeps soft booking continuation');

const delayedFlightReply = buildComposerTransferReply('en', 'My flight is delayed — I might arrive around midnight', {
  check_in: '2026-07-10', check_out: '2026-07-14', guest_count: 2,
}, null);
check('K4', delayedFlightReply && /updated|arrival time/i.test(delayedFlightReply), 'delayed-flight asks for updated time');
check('K5', delayedFlightReply && !/Want to continue with your booking/i.test(delayedFlightReply), 'delayed-flight avoids stiff continuation tail');
check('K6', delayedFlightReply && /booking moving|keep going|from there/i.test(delayedFlightReply), 'delayed-flight keeps soft booking continuation');
check('K7', delayedFlightReply && !/pickup is confirmed|we'll pick you up at midnight/i.test(delayedFlightReply), 'delayed-flight no fake operational promise');
const delayedNoStressCount = (String(delayedFlightReply || '').match(/\bno stress\b/gi) || []).length;
check('K8', delayedNoStressCount === 1, `delayed-flight avoids duplicate No stress (got ${delayedNoStressCount})`);
check('K9', delayedFlightReply && /We'll keep the booking moving from there/i.test(delayedFlightReply), 'delayed-flight uses de-duplicated continuation tail');

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
  'pay-later-before-quote',
  'pay-cash-on-arrival',
  'bus-station-pickup',
  'flight-delayed-late-arrival',
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
