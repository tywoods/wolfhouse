/**
 * Stage 40e — Final hammer cleanup verifier (Spanish cash + reset guest_count).
 *
 * Usage:
 *   npm run verify:stage40e-final-hammer-cleanup
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAYMENT = path.join(__dirname, 'lib', 'luna-guest-payment-choice-dry-run.js');
const GENERATOR = path.join(__dirname, 'lib', 'luna-random-guest-flow-generator.js');
const INTAKE = path.join(__dirname, 'lib', 'luna-guest-message-intake.js');
const TRANSITIONS = path.join(__dirname, 'lib', 'luna-booking-state-transitions.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'hammer-regressions');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage40e-final-hammer-cleanup';

const REQUIRED_FIXTURES = [
  'spanish-cash-preserves-quote-efectivo.json',
  'spanish-cash-preserves-quote-transferencia.json',
  'reset-new-booking-facts-guest-count.json',
];

const { detectPaymentChoiceFromMessage } = require('./lib/luna-guest-payment-choice-dry-run');
const { isQuotePreservingSideQuestion, evaluateQuoteStaleInvalidation } = require('./lib/luna-booking-state-transitions');
const { extractGuestCountFromText } = require('./lib/luna-booking-intake-policy');
const { normalizeHammerDateText } = require('./lib/luna-guest-message-intake');
const { cashReplyContainsForLanguage } = require('./lib/luna-random-guest-flow-generator');
const { detectTransferSideQuestionIntent } = require('./lib/luna-guest-service-transfer-explainer');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage40e-final-hammer-cleanup.js  (Stage 40e)\n`);

section('A. Spanish cash side-question');

const paymentSrc = fs.readFileSync(PAYMENT, 'utf8');
const generatorSrc = fs.readFileSync(GENERATOR, 'utf8');

check('A1', paymentSrc.includes('efectivo') && paymentSrc.includes('transferencia'), 'Spanish payment phrase detection');
check('A2', detectPaymentChoiceFromMessage('puedo pagar en efectivo?') === 'arrival_payment_question', 'puedo pagar en efectivo');
check('A3', detectPaymentChoiceFromMessage('puedo pagar por transferencia?') === 'arrival_payment_question', 'puedo pagar por transferencia');
check('A4', detectPaymentChoiceFromMessage('puedo pagar con tarjeta?') === 'arrival_payment_question', 'puedo pagar con tarjeta');
check('A5', detectPaymentChoiceFromMessage('puedo pagar al llegar?') === 'arrival_payment_question', 'puedo pagar al llegar');
check('A6', cashReplyContainsForLanguage('es')[0] === 'efectivo', 'hammer expects efectivo for ES cash reply');
check('A7', generatorSrc.includes('cashReplyContainsForLanguage'), 'generator localized cash reply expectations');

const quoteCtx = { quote: { quote_status: 'ready', payment_choice_needed: true } };
check('A8', !evaluateQuoteStaleInvalidation(quoteCtx, { extracted_fields: {} }, 'puedo pagar en efectivo?'), 'Spanish cash does not stale quote');
check('A9', isQuotePreservingSideQuestion('puedo pagar en efectivo?') === true, 'Spanish cash preserves quote chain');
check('A10', detectTransferSideQuestionIntent('puedo pagar por transferencia?') === null, 'payment transferencia not airport transfer');

section('B. Reset guest_count retention');

const intakeSrc = fs.readFileSync(INTAKE, 'utf8');
check('B1', intakeSrc.includes('siamoo') || intakeSrc.includes('siamo+'), 'hammer guest typo normalization');
check('B2', normalizeHammerDateText('siamoo in 2').includes('siamo'), 'siamoo → siamo normalization');
check('B3', extractGuestCountFromText('siamoo in 2, 8-12 luglo, solo il soggiorno') === 2, 'post-reset siamoo in 2 extracts guest_count');
check('B4', extractGuestCountFromText('July 1-5 for 2') === 2, 'reset follow-up for 2');

section('C. Fixtures + package');

for (const f of REQUIRED_FIXTURES) {
  check(`C-${f}`, fs.existsSync(path.join(FIXTURE_DIR, f)), `${f} exists`);
}
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('C4', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

section('D. Safety');

const orchSrc = fs.readFileSync(ORCH, 'utf8');
check('D1', !orchSrc.includes('sendWhatsApp') && !orchSrc.includes('whatsapp.send'), 'no WhatsApp send path');
check('D2', !paymentSrc.includes('stripe.checkout.sessions.create'), 'no Stripe path');
check('D3', !orchSrc.includes('runGuestConfirmationSend') && !orchSrc.includes('sendConfirmationMessage'), 'no confirmation send path');
check('D4', !orchSrc.includes('n8n.activate'), 'no n8n activation');
check('D5', !orchSrc.includes('deployToProduction'), 'no production changes');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Stage 40e verifier: ${failures === 0 ? 'PASS' : 'FAIL'} (${passes} passed, ${failures} failed)\n`);
process.exit(failures === 0 ? 0 : 1);
