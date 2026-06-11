/**
 * Stage 40d — Cash side-question + Italian correction fix verifier.
 *
 * Usage:
 *   npm run verify:stage40d-cash-correction-fixes
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAYMENT = path.join(__dirname, 'lib', 'luna-guest-payment-choice-dry-run.js');
const TRANSITIONS = path.join(__dirname, 'lib', 'luna-booking-state-transitions.js');
const INTAKE = path.join(__dirname, 'lib', 'luna-guest-message-intake.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'hammer-regressions');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage40d-cash-correction-fixes';

const REQUIRED_FIXTURES = [
  'turn2-cash-preserves-short-stay-quote-en.json',
  'turn2-cash-preserves-short-stay-quote-it.json',
  'turn2-cash-preserves-short-stay-quote-de.json',
  'italian-guest-count-correction-invalidates-quote.json',
];

const {
  detectPaymentChoiceFromMessage,
  shouldAttemptGuestPaymentChoiceWire,
} = require('./lib/luna-guest-payment-choice-dry-run');
const {
  isQuotePreservingSideQuestion,
  evaluateQuoteStaleInvalidation,
} = require('./lib/luna-booking-state-transitions');
const { extractGuestCountFromText } = require('./lib/luna-booking-intake-policy');
const { classifyMessageLane } = require('./lib/luna-guest-message-router');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage40d-cash-correction-fixes.js  (Stage 40d)\n`);

section('A. Cash side-question preservation');

const paymentSrc = fs.readFileSync(PAYMENT, 'utf8');
const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const transitionsSrc = fs.readFileSync(TRANSITIONS, 'utf8');
const intakeSrc = fs.readFileSync(INTAKE, 'utf8');

check('A1', paymentSrc.includes('cash\\s+payment') && paymentSrc.includes('contanti'), 'cash side-question detection patterns');
check('A2', detectPaymentChoiceFromMessage('cash payment ok?') === 'arrival_payment_question', 'cash payment ok? detected');
check('A3', detectPaymentChoiceFromMessage('posso pagare in contanti?') === 'arrival_payment_question', 'IT contanti detected');
check('A4', detectPaymentChoiceFromMessage('Kann ich bar bezahlen?') === 'arrival_payment_question', 'DE bar detected');
check('A5', isQuotePreservingSideQuestion('cash payment ok?') === true, 'cash side-question preserves quote chain');
check('A6', routerSrc.includes('pay_arrival_with_quote') || paymentSrc.includes('arrival'), 'cash answer copy path');
check('A7', routerSrc.includes('priorQuoteSide') || routerSrc.includes('arrival_payment_question'), 'router early cash lane');

const quoteCtx = {
  quote: { quote_status: 'ready', payment_choice_needed: false },
  message_lane: 'new_booking_inquiry',
};
check('A8', shouldAttemptGuestPaymentChoiceWire(quoteCtx, 'Can I pay cash?') === true, 'wire gate for arrival question on ready quote');
check('A9', !evaluateQuoteStaleInvalidation(quoteCtx, { extracted_fields: {} }, 'Can I pay cash?'), 'cash does not mark stale quote');

section('B. Italian guest-count correction');

check('B1', transitionsSrc.includes('no\\s+aspetta') && transitionsSrc.includes('alla\\s+fine'), 'Italian correction phrases');
check('B2', intakeSrc.includes('siamo\\s+(due|tre|quattro|cinque)'), 'Italian number words due/tre/quattro');
check('B3', extractGuestCountFromText('in realtà siamo 3') === 3, 'in realtà siamo 3 → 3');
check('B4', extractGuestCountFromText('siamo in due') === 2, 'siamo in due → 2');
check('B5', extractGuestCountFromText('siamo 2 non 1') === 2, 'siamo 2 non 1 → 2');

const priorCtx = {
  quote: { quote_status: 'ready', payment_choice_needed: true },
  extracted_fields: { guest_count: 1, check_in: '2026-07-01', check_out: '2026-07-05', package_interest: 'accommodation_only' },
  result: { extracted_fields: { guest_count: 1, check_in: '2026-07-01', check_out: '2026-07-05', package_interest: 'accommodation_only' } },
};
const stale = evaluateQuoteStaleInvalidation(priorCtx, { extracted_fields: { guest_count: 3 } }, 'in realtà siamo 3');
check('B6', stale && stale.stale_quote_reason === 'guest_count_changed', 'guest-count correction triggers guest_count_changed');
check('B7', transitionsSrc.includes('stalePaymentLinkBlocked') || paymentSrc.includes('stale_quote_blocked'), 'stale quote blocks old payment readiness');

section('C. Fixtures + package');

for (const f of REQUIRED_FIXTURES) {
  check(`C-${f}`, fs.existsSync(path.join(FIXTURE_DIR, f)), `${f} exists`);
}
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('C5', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

section('D. Safety');

const orchSrc = fs.readFileSync(ORCH, 'utf8');
check('D1', !orchSrc.includes('sendWhatsApp') && !orchSrc.includes('whatsapp.send'), 'no WhatsApp send path');
check('D2', !paymentSrc.includes('stripe.checkout.sessions.create'), 'no Stripe path');
check('D3', !orchSrc.includes('runGuestConfirmationSend') && !orchSrc.includes('sendConfirmationMessage'), 'no confirmation send path');
check('D4', !orchSrc.includes('n8n.activate'), 'no n8n activation');
check('D5', !routerSrc.includes('production') || routerSrc.includes('isProductionEnv'), 'no production changes');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Stage 40d verifier: ${failures === 0 ? 'PASS' : 'FAIL'} (${passes} passed, ${failures} failed)\n`);
process.exit(failures === 0 ? 0 : 1);
