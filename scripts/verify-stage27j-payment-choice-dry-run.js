/**
 * Stage 27j — Guest payment choice capture dry-run verifier.
 *
 * Usage:
 *   npm run verify:stage27j-payment-choice-dry-run
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ADAPTER = path.join(__dirname, 'lib', 'luna-guest-payment-choice-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27J-PAYMENT-CHOICE-DRY-RUN.md');
const SCRIPT = 'verify:stage27j-payment-choice-dry-run';
const REF_DATE = '2026-06-08';

const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');
const { runGuestQuoteProposalDryRun } = require('./lib/luna-guest-quote-proposal-dry-run');
const {
  runGuestPaymentChoiceDryRun,
  shouldAttemptGuestPaymentChoiceCapture,
  detectPaymentChoiceFromMessage,
  buildGuestPaymentChoiceSkippedResponse,
  VALID_PAYMENT_CHOICES,
  VALID_NEXT_SAFE_STEPS,
  PAYMENT_CHOICE_SAFETY,
} = require('./lib/luna-guest-payment-choice-dry-run');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const FORBIDDEN_REPLY_RE = /\b(?:payment link is ready|link is ready|sent you (?:a )?link|checkout link|booking is confirmed|confirmed your booking|pay here|booking is held|payment has been received|payment received)\b/i;

const READY_MSG = "Hi, we're 2 people looking to stay from June 15 to June 22, interested in the Malibu package";

const availableAvailability = {
  availability_check_attempted: true,
  availability_status: 'available',
  proposed_luna_reply: 'We may have space for your dates.',
};

function buildQuoteReadyGuestContext() {
  const router = runLunaGuestMessageRouterDryRun(
    { message_text: READY_MSG },
    { reference_date: REF_DATE },
  );
  const quote = runGuestQuoteProposalDryRun(router, availableAvailability, {});
  return {
    message_lane: router.message_lane,
    intake_state: router.intake_state,
    readiness_state: router.readiness_state,
    extracted_fields: router.extracted_fields,
    availability: availableAvailability,
    quote,
    quote_status: quote.quote_status,
    payment_choice_needed: quote.payment_choice_needed,
    detected_language: router.detected_language,
    result: router,
  };
}

console.log('\nverify-stage27j-payment-choice-dry-run.js  (Stage 27j)\n');

section('A. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('A1', `${SCRIPT} registered`);
else fail('A1', `missing npm script ${SCRIPT}`);

section('B. Gate — quote payment choice needed');

const quoteCtx = buildQuoteReadyGuestContext();
if (shouldAttemptGuestPaymentChoiceCapture(quoteCtx)) {
  pass('B1', 'quote ready + payment_choice_needed passes gate');
} else {
  fail('B1', 'quote-ready context should pass gate');
}

const noQuoteCtx = { message_lane: 'new_booking_inquiry' };
if (!shouldAttemptGuestPaymentChoiceCapture(noQuoteCtx)) {
  pass('B2', 'missing quote context blocked');
} else {
  fail('B2', 'missing quote should not pass gate');
}

const notReadyQuoteCtx = {
  message_lane: 'new_booking_inquiry',
  quote: { quote_status: 'not_ready', payment_choice_needed: false },
};
if (!shouldAttemptGuestPaymentChoiceCapture(notReadyQuoteCtx)) {
  pass('B3', 'quote not_ready blocked');
} else {
  fail('B3', 'not_ready quote should not pass gate');
}

section('C. Output shape and safety flags');

const skipped = buildGuestPaymentChoiceSkippedResponse(noQuoteCtx, null);
const outputKeys = [
  'payment_choice_detected',
  'payment_choice',
  'payment_choice_ready',
  'payment_choice_reasons',
  'next_safe_step',
  'proposed_luna_reply',
];

for (const key of outputKeys) {
  if (key in skipped) pass(`C.key.${key}`, `output has ${key}`);
  else fail(`C.key.${key}`, `missing ${key}`);
}

for (const [flag, val] of Object.entries(PAYMENT_CHOICE_SAFETY)) {
  if (skipped[flag] === val) pass(`C.safe.${flag}`, `${flag}=${val}`);
  else fail(`C.safe.${flag}`, `expected ${flag}=${val} got ${skipped[flag]}`);
}

if (skipped.payment_choice_ready === false) pass('C.notReady', 'skipped not payment_choice_ready');
else fail('C.notReady', 'skipped should not be ready');

section('D. Fixture — deposit is fine');

const deposit = runGuestPaymentChoiceDryRun({ message_text: 'Deposit is fine' }, quoteCtx);
if (deposit.payment_choice === 'deposit') pass('D1', 'detects deposit');
else fail('D1', `expected deposit got ${deposit.payment_choice}`);

if (deposit.payment_choice_detected === true) pass('D2', 'payment_choice_detected');
else fail('D2', 'should detect choice');

if (deposit.payment_choice_ready === true) pass('D3', 'deposit ready with quote context');
else fail('D3', 'deposit should be ready');

if (deposit.next_safe_step === 'ready_for_hold_payment_draft') {
  pass('D4', 'next_safe_step ready_for_hold_payment_draft');
} else {
  fail('D4', `expected ready_for_hold_payment_draft got ${deposit.next_safe_step}`);
}

if (!FORBIDDEN_REPLY_RE.test(deposit.proposed_luna_reply)) {
  pass('D5', 'deposit reply safe');
} else {
  fail('D5', 'deposit reply contains forbidden phrase');
}

section('E. Fixture — full payment');

const full = runGuestPaymentChoiceDryRun({ message_text: "I'll pay the full amount" }, quoteCtx);
if (full.payment_choice === 'full_payment') pass('E1', 'detects full_payment');
else fail('E1', `expected full_payment got ${full.payment_choice}`);

if (full.payment_choice_ready === true) pass('E2', 'full payment ready');
else fail('E2', 'full should be ready');

if (full.next_safe_step === 'ready_for_hold_payment_draft') {
  pass('E3', 'full → ready_for_hold_payment_draft');
} else {
  fail('E3', `unexpected next_safe_step ${full.next_safe_step}`);
}

section('F. Fixture — arrival / cash / bank questions');

const cash = runGuestPaymentChoiceDryRun(
  { message_text: 'Can I pay cash when I arrive?' },
  quoteCtx,
);
if (cash.payment_choice === 'arrival_payment_question') pass('F1', 'cash arrival detected');
else fail('F1', `expected arrival_payment_question got ${cash.payment_choice}`);

if (cash.payment_choice_ready === false) pass('F2', 'arrival question not ready');
else fail('F2', 'arrival should not be ready');

if (cash.next_safe_step === 'answer_arrival_payment_question') {
  pass('F3', 'answer_arrival_payment_question');
} else {
  fail('F3', `expected answer_arrival_payment_question got ${cash.next_safe_step}`);
}

if (/cash|bank transfer|Stripe|arrival|check-in/i.test(cash.proposed_luna_reply)) {
  pass('F4', 'arrival reply explains balance options');
} else {
  fail('F4', 'arrival reply should mention cash/bank/Stripe/arrival');
}

const bank = runGuestPaymentChoiceDryRun(
  { message_text: 'Can I pay by bank transfer?' },
  quoteCtx,
);
if (bank.payment_choice === 'arrival_payment_question') pass('F5', 'bank transfer detected');
else fail('F5', `expected arrival_payment_question got ${bank.payment_choice}`);

section('G. Fixture — send link request');

const link = runGuestPaymentChoiceDryRun({ message_text: 'Send me the link' }, quoteCtx);
if (link.payment_choice === 'payment_link_request') pass('G1', 'link request detected');
else fail('G1', `expected payment_link_request got ${link.payment_choice}`);

if (link.payment_choice_ready === false) pass('G2', 'link request not ready');
else fail('G2', 'link request should not be ready');

if (link.creates_stripe_link === false && link.payment_link_sent === false) {
  pass('G3', 'no stripe link created or sent');
} else {
  fail('G3', 'must not create or send payment link');
}

if (/cannot send|not confirming|non posso|no confirmo|nicht bestätige|ne confirme pas/i.test(link.proposed_luna_reply)) {
  pass('G4', 'link reply does not claim link is ready');
} else {
  fail('G4', 'link reply should clarify no automatic link');
}

if (!FORBIDDEN_REPLY_RE.test(link.proposed_luna_reply)) {
  pass('G5', 'link reply avoids forbidden phrases');
} else {
  fail('G5', 'link reply contains forbidden phrase');
}

section('H. Fixture — unclear after quote');

const unclear = runGuestPaymentChoiceDryRun({ message_text: 'Yes' }, quoteCtx);
if (unclear.payment_choice === 'unclear') pass('H1', 'unclear detected');
else fail('H1', `expected unclear got ${unclear.payment_choice}`);

if (unclear.payment_choice_ready === false) pass('H2', 'unclear not ready');
else fail('H2', 'unclear should not be ready');

if (unclear.next_safe_step === 'collect_payment_choice') pass('H3', 'collect_payment_choice');
else fail('H3', `expected collect_payment_choice got ${unclear.next_safe_step}`);

if (/deposit or the full|deposito|depósito|Anzahlung|acompte/i.test(unclear.proposed_luna_reply)) {
  pass('H4', 'unclear reply asks deposit vs full (one question)');
} else {
  fail('H4', 'unclear reply should ask deposit vs full');
}

section('I. Fixture — payment choice without quote context');

const depositNoQuote = runGuestPaymentChoiceDryRun({ message_text: 'Deposit is fine' }, noQuoteCtx);
if (depositNoQuote.payment_choice_ready === false) {
  pass('I1', 'deposit without quote not ready');
} else {
  fail('I1', 'deposit without quote must not be ready');
}

if (depositNoQuote.payment_choice === 'deposit' || depositNoQuote.payment_choice_detected) {
  pass('I2', 'still detects deposit intent');
} else {
  fail('I2', 'should still detect deposit from message');
}

section('J. Fixture — non-booking payment/balance question');

const balanceLane = runGuestPaymentChoiceDryRun(
  { message_text: 'I want to pay the deposit for my balance' },
  { message_lane: 'payment_question' },
);
if (balanceLane.payment_choice_ready === false) pass('J1', 'payment_question lane not ready');
else fail('J1', 'non-booking lane must not be ready');

if (balanceLane.next_safe_step === 'staff_handoff_required') {
  pass('J2', 'non-booking → staff_handoff_required');
} else {
  fail('J2', `expected staff_handoff_required got ${balanceLane.next_safe_step}`);
}

section('K. Detection helper');

const detectCases = [
  ['Deposit is fine', 'deposit'],
  ["I'll pay the full amount", 'full_payment'],
  ['Can I pay cash when I arrive?', 'arrival_payment_question'],
  ['Can I pay by bank transfer?', 'arrival_payment_question'],
  ['Send me the link', 'payment_link_request'],
  ['Yes', 'unclear'],
  ['Hello there', null],
];

for (const [msg, expected] of detectCases) {
  const got = detectPaymentChoiceFromMessage(msg);
  if (got === expected) pass(`K.${expected || 'null'}`, `"${msg.slice(0, 30)}" → ${expected}`);
  else fail(`K.${expected || 'null'}`, `"${msg}" expected ${expected} got ${got}`);
}

section('L. Enum values');

for (const choice of VALID_PAYMENT_CHOICES) {
  if (typeof choice === 'string') pass(`L.choice.${choice}`, 'valid payment_choice enum');
  else fail(`L.choice.${choice}`, 'invalid choice entry');
}

for (const step of VALID_NEXT_SAFE_STEPS) {
  if (typeof step === 'string') pass(`L.step.${step}`, 'valid next_safe_step enum');
  else fail(`L.step.${step}`, 'invalid step entry');
}

section('M. Adapter source — no forbidden side effects');

const adapterSrc = fs.readFileSync(ADAPTER, 'utf8');
const forbiddenPatterns = [
  ['M.stripe', /api\.stripe\.com|createStripe|stripe\.checkout/i],
  ['M.whatsapp', /graph\.facebook\.com|sendWhatsApp|whatsapp\.send/i],
  ['M.n8n', /fetch\s*\([^)]*n8n|activateWorkflow/i],
  ['M.payment_link', /create-stripe-link|createPaymentLink/i],
  ['M.hold', /createHold|create_hold|INSERT\s+INTO\s+holds/i],
  ['M.booking_write', /\bINSERT\s+INTO\s+bookings\b/i],
  ['M.payment_draft', /createPaymentDraft|create_payment_draft|\bpayment_drafts\b/i],
  ['M.live_send', /live_send:\s*true|sends_whatsapp:\s*true(?!.*blocked)/i],
];

for (const [id, re] of forbiddenPatterns) {
  if (!re.test(adapterSrc)) pass(id, 'adapter source clean');
  else fail(id, 'forbidden pattern in adapter');
}

section('N. All fixture replies safe');

const allFixtures = [deposit, full, cash, bank, link, unclear, depositNoQuote, balanceLane];
for (const [i, fx] of allFixtures.entries()) {
  if (!FORBIDDEN_REPLY_RE.test(fx.proposed_luna_reply)) {
    pass(`N.${i}`, 'reply avoids forbidden confirm/link phrases');
  } else {
    fail(`N.${i}`, `forbidden phrase in: ${fx.proposed_luna_reply.slice(0, 80)}`);
  }
  if (fx.dry_run === true && fx.sends_whatsapp === false && fx.live_send_blocked === true) {
    pass(`N.safe.${i}`, 'dry_run safety flags');
  } else {
    fail(`N.safe.${i}`, 'missing dry_run safety flags');
  }
}

section('O. Doc files');

if (fs.existsSync(DOC)) pass('O1', 'STAGE-27J doc exists');
else fail('O1', 'missing STAGE-27J doc');

const docText = fs.readFileSync(DOC, 'utf8');
if (docText.includes('runGuestPaymentChoiceDryRun')) pass('O2', 'doc names adapter');
else fail('O2', 'doc must document runGuestPaymentChoiceDryRun');

if (docText.includes('payment_choice_needed')) pass('O3', 'doc references payment_choice_needed gate');
else fail('O3', 'doc should reference payment_choice_needed');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
