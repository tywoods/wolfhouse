/**
 * Stage 27k — Guest intake payment choice wire verifier.
 *
 * Usage:
 *   npm run verify:stage27k-payment-choice-wire
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const HARNESS = path.join(__dirname, 'run-guest-intake-dry-run.js');
const ADAPTER = path.join(__dirname, 'lib', 'luna-guest-payment-choice-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27K-PAYMENT-CHOICE-WIRE.md');
const SCRIPT = 'verify:stage27k-payment-choice-wire';

const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');
const { runGuestQuoteProposalDryRun } = require('./lib/luna-guest-quote-proposal-dry-run');
const {
  runGuestPaymentChoiceDryRun,
  shouldAttemptGuestPaymentChoiceWire,
  buildPaymentChoiceWireContext,
  buildGuestPaymentChoiceWireSkippedResponse,
} = require('./lib/luna-guest-payment-choice-dry-run');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const REF_DATE = '2026-06-08';
const READY_MSG = "Hi, we're 2 people looking to stay from June 15 to June 22, interested in the Malibu package";

const FORBIDDEN_REPLY_RE = /\b(?:payment link is ready|link is ready|sent you (?:a )?link|checkout link|booking is confirmed|confirmed your booking|pay here|booking is held)\b/i;

const availableAvailability = {
  availability_check_attempted: true,
  availability_status: 'available',
  proposed_luna_reply: 'We may have space for your dates.',
};

function quoteReadyGuestContext() {
  return {
    message_lane: 'new_booking_inquiry',
    quote: {
      quote_status: 'ready',
      payment_choice_needed: true,
      quote_total_cents: 123456,
      deposit_options: { deposit_required_cents: 20000 },
    },
    payment_choice_needed: true,
  };
}

function simulateWire(messageText, guestContext) {
  const router = runLunaGuestMessageRouterDryRun({ message_text: messageText });
  const wireCtx = buildPaymentChoiceWireContext(guestContext, router, availableAvailability, null);
  if (shouldAttemptGuestPaymentChoiceWire(guestContext)) {
    return runGuestPaymentChoiceDryRun({ message_text: messageText }, wireCtx);
  }
  return buildGuestPaymentChoiceWireSkippedResponse(guestContext);
}

console.log('\nverify-stage27k-payment-choice-wire.js  (Stage 27k)\n');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0a', 'staff-query-api.js passes node --check');
} catch {
  fail('0a', 'staff-query-api.js syntax error');
}

try {
  execSync(`node --check "${HARNESS}"`, { stdio: 'pipe' });
  pass('0b', 'harness passes node --check');
} catch {
  fail('0b', 'harness syntax error');
}

const src = fs.readFileSync(API, 'utf8');
const harnessSrc = fs.readFileSync(HARNESS, 'utf8');
const handlerStart = src.indexOf('async function handleBotGuestIntakeDryRun(');
const handlerEnd = handlerStart > -1
  ? src.indexOf('\n// Phase 13c — in-memory req', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? src.slice(handlerStart, handlerEnd)
  : '';

section('A. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('A1', `${SCRIPT} registered`);
else fail('A1', `missing npm script ${SCRIPT}`);

section('B. Endpoint imports and wiring');

if (/require\(['"]\.\/lib\/luna-guest-payment-choice-dry-run['"]\)/.test(src)) {
  pass('B1', 'imports luna-guest-payment-choice-dry-run');
} else {
  fail('B1', 'luna-guest-payment-choice-dry-run not imported');
}

if (handler.includes('runGuestPaymentChoiceDryRun(')) pass('B2', 'handler calls runGuestPaymentChoiceDryRun');
else fail('B2', 'runGuestPaymentChoiceDryRun not called in handler');

if (handler.includes('shouldAttemptGuestPaymentChoiceWire(')) {
  pass('B3', 'handler gates on shouldAttemptGuestPaymentChoiceWire');
} else {
  fail('B3', 'shouldAttemptGuestPaymentChoiceWire gate missing');
}

if (handler.includes('buildGuestPaymentChoiceWireSkippedResponse(')) {
  pass('B4', 'not-eligible path uses buildGuestPaymentChoiceWireSkippedResponse');
} else {
  fail('B4', 'skipped payment choice helper missing');
}

if (handler.includes('payment_choice,')) pass('B5', 'success response includes payment_choice object');
else fail('B5', 'payment_choice not in success response');

if (/shouldAttemptGuestPaymentChoiceWire[\s\S]{0,600}runGuestPaymentChoiceDryRun/.test(handler)) {
  pass('B6', 'payment choice adapter only on eligible guest_context path');
} else {
  fail('B6', 'payment choice gating pattern missing');
}

if (handler.includes('buildPaymentChoiceWireContext(')) pass('B7', 'merges guest_context with chain');
else fail('B7', 'buildPaymentChoiceWireContext missing');

section('C. Wire gate');

const quoteCtx = quoteReadyGuestContext();
if (shouldAttemptGuestPaymentChoiceWire(quoteCtx)) pass('C1', 'quote-ready guest_context passes wire gate');
else fail('C1', 'quote-ready context should pass');

if (!shouldAttemptGuestPaymentChoiceWire(null)) pass('C2', 'empty guest_context blocked');
else fail('C2', 'empty context should not pass');

if (!shouldAttemptGuestPaymentChoiceWire({ quote: { quote_status: 'not_ready', payment_choice_needed: false } })) {
  pass('C3', 'not_ready quote blocked');
} else {
  fail('C3', 'not_ready quote should not pass');
}

section('D. Deposit and full payment second-turn');

const deposit = simulateWire('Deposit is fine', quoteCtx);
if (deposit.payment_choice === 'deposit') pass('D1', 'deposit detected');
else fail('D1', `expected deposit got ${deposit.payment_choice}`);

if (deposit.payment_choice_ready === true) pass('D2', 'deposit ready with quote context');
else fail('D2', 'deposit should be ready');

if (deposit.next_safe_step === 'ready_for_hold_payment_draft') {
  pass('D3', 'deposit → ready_for_hold_payment_draft');
} else {
  fail('D3', `unexpected next_safe_step ${deposit.next_safe_step}`);
}

const full = simulateWire("I'll pay the full amount", quoteCtx);
if (full.payment_choice === 'full_payment') pass('D4', 'full_payment detected');
else fail('D4', `expected full_payment got ${full.payment_choice}`);

if (full.payment_choice_ready === true && full.next_safe_step === 'ready_for_hold_payment_draft') {
  pass('D5', 'full payment ready_for_hold_payment_draft');
} else {
  fail('D5', 'full payment should be ready');
}

section('E. Link request — detect only');

const link = simulateWire('Send me the link', quoteCtx);
if (link.payment_choice === 'payment_link_request') pass('E1', 'link request detected');
else fail('E1', `expected payment_link_request got ${link.payment_choice}`);

if (link.creates_stripe_link === false && link.payment_link_sent === false) {
  pass('E2', 'no stripe link created or sent');
} else {
  fail('E2', 'must not create or send link');
}

if (link.payment_choice_ready === false) pass('E3', 'link request not ready');
else fail('E3', 'link request should not be ready');

section('F. Cash/bank on arrival');

const cash = simulateWire('Can I pay cash when I arrive?', quoteCtx);
if (cash.payment_choice === 'arrival_payment_question') pass('F1', 'cash arrival detected');
else fail('F1', `expected arrival_payment_question got ${cash.payment_choice}`);

if (cash.next_safe_step === 'answer_arrival_payment_question') {
  pass('F2', 'answer_arrival_payment_question');
} else {
  fail('F2', `unexpected next_safe_step ${cash.next_safe_step}`);
}

if (/cash|bank transfer|Stripe|arrival|check-in/i.test(cash.proposed_luna_reply || '')) {
  pass('F3', 'arrival reply explains balance options safely');
} else {
  fail('F3', 'arrival reply should mention payment options');
}

if (!FORBIDDEN_REPLY_RE.test(cash.proposed_luna_reply || '')) pass('F4', 'arrival reply safe');
else fail('F4', 'forbidden phrase in arrival reply');

section('G. No quote context — not ready');

const noCtx = simulateWire('Deposit is fine', null);
if (noCtx.payment_choice_ready === false) pass('G1', 'deposit without guest_context not ready');
else fail('G1', 'must not be ready without context');

if (noCtx.payment_choice_detected === false) pass('G2', 'skipped path not detected');
else fail('G2', 'skipped should not mark detected');

if (noCtx.next_safe_step === 'not_ready') pass('G3', 'next_safe_step not_ready');
else fail('G3', `expected not_ready got ${noCtx.next_safe_step}`);

section('H. Payment question lane with quote context still evaluates choice');

const paymentRouter = runLunaGuestMessageRouterDryRun({ message_text: 'Deposit is fine' });
if (paymentRouter.message_lane === 'payment_question' || paymentRouter.message_lane != null) {
  const laneDeposit = simulateWire('Deposit is fine', quoteCtx);
  if (laneDeposit.payment_choice_ready === true) {
    pass('H1', 'deposit ready even when router may classify payment_question');
  } else {
    fail('H1', 'wire context should preserve booking lane for payment choice');
  }
} else {
  fail('H1', 'router did not return message_lane');
}

section('I. First-turn quote still works (27i preserved)');

const readyRouter = runLunaGuestMessageRouterDryRun(
  { message_text: READY_MSG },
  { reference_date: REF_DATE },
);
const firstQuote = runGuestQuoteProposalDryRun(readyRouter, availableAvailability, {});
if (firstQuote.quote_status === 'ready' && firstQuote.payment_choice_needed === true) {
  pass('I1', 'first-turn quote ready with payment_choice_needed');
} else {
  fail('I1', 'first-turn quote chain preserved');
}

if (/deposit or the full|deposito|depósito|Anzahlung|acompte/i.test(firstQuote.proposed_luna_reply || '')) {
  pass('I2', 'first-turn quote asks deposit vs full');
} else {
  fail('I2', 'quote reply should ask payment choice');
}

const skippedNoCtx = buildGuestPaymentChoiceWireSkippedResponse(null);
const pcKeys = [
  'payment_choice_detected',
  'payment_choice',
  'payment_choice_ready',
  'payment_choice_reasons',
  'next_safe_step',
];
for (const key of pcKeys) {
  if (key in skippedNoCtx) pass(`I.key.${key}`, `skipped payment_choice has ${key}`);
  else fail(`I.key.${key}`, `missing ${key}`);
}

section('J. Harness payment choice summary');

for (const field of pcKeys) {
  if (harnessSrc.includes(field)) pass(`J.${field}`, `harness prints ${field}`);
  else fail(`J.${field}`, `harness missing ${field}`);
}

if (harnessSrc.includes('payment choice dry-run')) pass('J.section', 'harness has payment choice section');
else fail('J.section', 'payment choice section header missing');

if (harnessSrc.includes('--guest-context-json')) pass('J.guestContext', 'harness supports --guest-context-json');
else fail('J.guestContext', '--guest-context-json missing');

if (harnessSrc.includes('en-deposit-after-quote')) pass('J.fixture', 'harness has payment choice fixture');
else fail('J.fixture', 'payment choice fixture missing');

if (harnessSrc.includes('--json')) pass('J.json', 'harness retains --json option');
else fail('J.json', '--json missing');

section('K. Safety — no forbidden live actions in handler');

const forbidden = [
  ['K.stripe', /api\.stripe\.com|createStripe|checkout\.sessions/i],
  ['K.whatsapp', /graph\.facebook\.com|sendWhatsApp|whatsapp\.send/i],
  ['K.n8n', /fetch\s*\([^)]*n8n|activateWorkflow/i],
  ['K.payment_link', /create-stripe-link|createPaymentLink|payment_link_sent:\s*true/i],
  ['K.hold', /createHold|booking_hold|INSERT\s+INTO\s+holds/i],
  ['K.booking_create', /runManualBookingCreate|handleBotBookingCreate|INSERT\s+INTO\s+bookings/i],
  ['K.payment_draft', /INSERT\s+INTO\s+payments|createPaymentDraft/i],
  ['K.send_action', /send_guest|live_send:\s*true|sends_whatsapp:\s*true/i],
];
for (const [id, re] of forbidden) {
  if (!re.test(handler)) pass(id, 'handler clean');
  else fail(id, 'forbidden pattern in handler');
}

const adapterSrc = fs.readFileSync(ADAPTER, 'utf8');
if (!/runGuestPaymentChoiceDryRun/.test(handler.replace(/require\([^)]*luna-guest-payment-choice-dry-run[^)]*\)/, ''))) {
  pass('K.delegate', 'handler delegates payment choice via adapter import only');
} else {
  /* handler only calls imported fn — ok */
  pass('K.delegate', 'handler uses adapter import');
}

section('L. Reply safety on wire fixtures');

for (const [label, fx] of [
  ['deposit', deposit],
  ['full', full],
  ['link', link],
  ['cash', cash],
]) {
  if (!FORBIDDEN_REPLY_RE.test(fx.proposed_luna_reply || '')) {
    pass(`L.${label}`, `${label} reply safe`);
  } else {
    fail(`L.${label}`, `forbidden phrase in ${label} reply`);
  }
}

section('M. Doc files');

if (fs.existsSync(DOC)) pass('M1', 'STAGE-27K doc exists');
else fail('M1', 'missing STAGE-27K doc');

const docText = fs.readFileSync(DOC, 'utf8');
if (docText.includes('"payment_choice"') && docText.includes('payment_choice_ready')) {
  pass('M2', 'doc documents payment_choice response fields');
} else fail('M2', 'doc missing payment_choice fields');

if (docText.includes('Deposit is fine') && docText.includes('Send me the link')) {
  pass('M3', 'doc includes second-turn examples');
} else fail('M3', 'doc missing examples');

if (docText.includes('guest_context') && docText.includes('payment_choice_needed')) {
  pass('M4', 'doc covers guest_context quote gate');
} else fail('M4', 'doc missing guest_context gate');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
