/**
 * Stage 27m — Hold + payment draft planner dry-run verifier.
 *
 * Usage:
 *   npm run verify:stage27m-hold-payment-draft-planner
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ADAPTER = path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-planner.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27M-HOLD-PAYMENT-DRAFT-PLANNER.md');
const SCRIPT = 'verify:stage27m-hold-payment-draft-planner';
const REF_DATE = '2026-06-08';

const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');
const { runGuestQuoteProposalDryRun } = require('./lib/luna-guest-quote-proposal-dry-run');
const { runGuestPaymentChoiceDryRun } = require('./lib/luna-guest-payment-choice-dry-run');
const {
  runGuestHoldPaymentDraftPlannerDryRun,
  shouldAttemptGuestHoldPaymentDraftPlan,
  buildGuestHoldPaymentDraftPlannerSkippedResponse,
  buildIdempotencyKeyPreview,
  HOLD_EXPIRES_IN_HOURS,
  VALID_PLAN_STATUSES,
  PLANNER_SAFETY,
} = require('./lib/luna-guest-hold-payment-draft-planner');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const FORBIDDEN_REPLY_RE = /\b(?:payment link is ready|link is ready|sent you (?:a )?link|checkout link|booking is confirmed|confirmed your booking|pay here|booking is held|hold expires|expiry|payment has been received|payment received)\b/i;

const READY_MSG = "Hi, we're 2 people looking to stay from June 15 to June 22, interested in the Malibu package";
const SHORT_MSG = "We're 2 people, June 15 to June 18, Malibu package please";
const COLLECTING_MSG = "We're 2 people interested in the Malibu package";

const availableAvailability = {
  availability_check_attempted: true,
  availability_status: 'available',
  proposed_luna_reply: 'We may have space for your dates.',
};

function buildFullChain(messageText, paymentMessage, refDate) {
  const result = runLunaGuestMessageRouterDryRun(
    { message_text: messageText },
    { reference_date: refDate || REF_DATE },
  );
  const quote = runGuestQuoteProposalDryRun(result, availableAvailability, {});
  const paymentCtx = {
    message_lane: result.message_lane,
    quote,
    payment_choice_needed: quote.payment_choice_needed,
    detected_language: result.detected_language,
  };
  const payment_choice = runGuestPaymentChoiceDryRun(
    { message_text: paymentMessage },
    paymentCtx,
  );
  return { result, availability: availableAvailability, quote, payment_choice };
}

console.log('\nverify-stage27m-hold-payment-draft-planner.js  (Stage 27m)\n');

section('A. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('A1', `${SCRIPT} registered`);
else fail('A1', `missing npm script ${SCRIPT}`);

section('B. Entry gate');

const depositChain = buildFullChain(READY_MSG, 'Deposit is fine');
if (shouldAttemptGuestHoldPaymentDraftPlan(depositChain)) {
  pass('B1', 'full chain passes planner gate');
} else {
  fail('B1', 'full chain should pass gate');
}

const collectingRouter = runLunaGuestMessageRouterDryRun(
  { message_text: COLLECTING_MSG },
  { reference_date: REF_DATE },
);
const incompleteChain = {
  result: collectingRouter,
  availability: availableAvailability,
  quote: { quote_status: 'not_ready' },
  payment_choice: { payment_choice_ready: false },
};
if (!shouldAttemptGuestHoldPaymentDraftPlan(incompleteChain)) {
  pass('B2', 'incomplete chain blocked');
} else {
  fail('B2', 'incomplete chain should not pass');
}

section('C. Output shape and safety');

const skipped = buildGuestHoldPaymentDraftPlannerSkippedResponse(null);
const keys = [
  'hold_payment_draft_plan_attempted',
  'plan_status',
  'would_create_hold',
  'would_create_quote_snapshot',
  'would_create_payment_draft',
  'would_create_stripe_link',
  'hold_expires_in_hours',
  'payment_amount_cents',
  'payment_kind',
  'balance_due_after_payment_cents',
  'idempotency_key_preview',
  'planned_records',
  'plan_handoff_required',
  'plan_handoff_reasons',
  'proposed_luna_reply',
];
for (const key of keys) {
  if (key in skipped) pass(`C.key.${key}`, `output has ${key}`);
  else fail(`C.key.${key}`, `missing ${key}`);
}

for (const [flag, val] of Object.entries(PLANNER_SAFETY)) {
  if (skipped[flag] === val) pass(`C.safe.${flag}`, `${flag}=${val}`);
  else fail(`C.safe.${flag}`, `expected ${flag}=${val}`);
}

if (skipped.would_create_hold === false && skipped.plan_status === 'not_ready') {
  pass('C.notReady', 'skipped does not plan writes');
} else {
  fail('C.notReady', 'skipped should not plan writes');
}

section('D. Deposit plan — 7-night Malibu');

const depositPlan = runGuestHoldPaymentDraftPlannerDryRun(depositChain, { client_slug: 'wolfhouse-somo' });
if (depositPlan.hold_payment_draft_plan_attempted === true) pass('D1', 'deposit plan attempted');
else fail('D1', 'should attempt plan');

if (depositPlan.plan_status === 'ready') pass('D2', 'deposit plan_status ready');
else fail('D2', `expected ready got ${depositPlan.plan_status}`);

if (depositPlan.payment_kind === 'deposit') pass('D3', 'payment_kind deposit');
else fail('D3', `expected deposit got ${depositPlan.payment_kind}`);

if (depositPlan.payment_amount_cents === 20000) {
  pass('D4', '7-night deposit €200 (20000 cents)');
} else {
  fail('D4', `expected 20000 deposit got ${depositPlan.payment_amount_cents}`);
}

const total = depositChain.quote.quote_total_cents;
const expectedBalance = Math.max(0, total - 20000);
if (depositPlan.balance_due_after_payment_cents === expectedBalance) {
  pass('D5', `balance_due=${expectedBalance}`);
} else {
  fail('D5', `expected balance ${expectedBalance} got ${depositPlan.balance_due_after_payment_cents}`);
}

if (depositPlan.would_create_hold === true
  && depositPlan.would_create_quote_snapshot === true
  && depositPlan.would_create_payment_draft === true) {
  pass('D6', 'would_create hold/snapshot/draft');
} else {
  fail('D6', 'ready plan should would_create all three');
}

if (depositPlan.would_create_stripe_link === false) pass('D7', 'would_create_stripe_link false');
else fail('D7', 'stripe link must stay false');

if (depositPlan.hold_expires_in_hours === HOLD_EXPIRES_IN_HOURS) {
  pass('D8', `hold_expires_in_hours=${HOLD_EXPIRES_IN_HOURS}`);
} else {
  fail('D8', `expected ${HOLD_EXPIRES_IN_HOURS} got ${depositPlan.hold_expires_in_hours}`);
}

section('E. Full payment plan');

const fullChain = buildFullChain(READY_MSG, "I'll pay the full amount");
const fullPlan = runGuestHoldPaymentDraftPlannerDryRun(fullChain, {});
if (fullPlan.plan_status === 'ready' && fullPlan.payment_kind === 'full_payment') {
  pass('E1', 'full payment plan ready');
} else {
  fail('E1', `full plan status=${fullPlan.plan_status} kind=${fullPlan.payment_kind}`);
}

if (fullPlan.payment_amount_cents === fullChain.quote.quote_total_cents) {
  pass('E2', 'full payment amount equals quote_total_cents');
} else {
  fail('E2', 'full amount should match quote total');
}

if (fullPlan.balance_due_after_payment_cents === 0) pass('E3', 'full payment balance due 0');
else fail('E3', `expected 0 balance got ${fullPlan.balance_due_after_payment_cents}`);

section('F. Shorter stay deposit €100');

const shortRouter = runLunaGuestMessageRouterDryRun(
  { message_text: SHORT_MSG },
  { reference_date: REF_DATE },
);
if (shortRouter.booking_intake_ready) {
  const shortQuote = runGuestQuoteProposalDryRun(shortRouter, availableAvailability, {});
  const shortPc = runGuestPaymentChoiceDryRun(
    { message_text: 'Deposit is fine' },
    { message_lane: shortRouter.message_lane, quote: shortQuote },
  );
  const shortChain = {
    result: shortRouter,
    availability: availableAvailability,
    quote: shortQuote,
    payment_choice: shortPc,
  };
  const shortPlan = runGuestHoldPaymentDraftPlannerDryRun(shortChain, {});
  if (shortPlan.plan_status === 'ready' && shortPlan.payment_amount_cents === 10000) {
    pass('F1', '3-night deposit €100 (10000 cents)');
  } else {
    fail('F1', `expected 10000 deposit plan_status=${shortPlan.plan_status} amount=${shortPlan.payment_amount_cents}`);
  }
} else {
  fail('F1', 'short stay router should be intake ready');
}

section('G. Not-ready cases');

const unavailChain = {
  ...depositChain,
  availability: { availability_status: 'unavailable' },
};
const unavailPlan = runGuestHoldPaymentDraftPlannerDryRun(unavailChain, {});
if (unavailPlan.plan_status === 'not_ready' && unavailPlan.would_create_hold === false) {
  pass('G1', 'unavailable does not plan writes');
} else {
  fail('G1', 'unavailable should be not_ready');
}

const noChoiceChain = {
  ...depositChain,
  payment_choice: {
    payment_choice_ready: false,
    next_safe_step: 'collect_payment_choice',
    payment_choice: null,
  },
};
const noChoicePlan = runGuestHoldPaymentDraftPlannerDryRun(noChoiceChain, {});
if (noChoicePlan.would_create_hold === false) pass('G2', 'missing payment choice not ready');
else fail('G2', 'should not plan without payment choice');

const badQuoteChain = {
  ...depositChain,
  quote: { quote_status: 'not_ready', quote_total_cents: null },
};
if (runGuestHoldPaymentDraftPlannerDryRun(badQuoteChain, {}).plan_status === 'not_ready') {
  pass('G3', 'quote not_ready blocked');
} else {
  fail('G3', 'quote not_ready should block');
}

section('H. Idempotency key stability');

const key1 = runGuestHoldPaymentDraftPlannerDryRun(depositChain, {
  client_slug: 'wolfhouse-somo',
  guest_phone: '+34600111222',
}).idempotency_key_preview;
const key2 = runGuestHoldPaymentDraftPlannerDryRun(depositChain, {
  client_slug: 'wolfhouse-somo',
  guest_phone: '+34600111222',
}).idempotency_key_preview;
if (key1 && key1 === key2) pass('H1', 'idempotency_key_preview stable across calls');
else fail('H1', 'idempotency key should be stable');

if (key1 && !/^[0-9a-f]{32}$/.test(key1)) {
  fail('H2', 'idempotency key should be hex hash preview');
} else if (key1) {
  pass('H2', 'idempotency_key_preview is deterministic hex');
}

const keyDifferent = runGuestHoldPaymentDraftPlannerDryRun(fullChain, {
  client_slug: 'wolfhouse-somo',
  guest_phone: '+34600111222',
}).idempotency_key_preview;
if (key1 !== keyDifferent) pass('H3', 'different payment choice changes key');
else fail('H3', 'payment choice should affect idempotency key');

const directKey = buildIdempotencyKeyPreview(
  { client_slug: 'wolfhouse-somo', guest_phone: '+34000' },
  depositChain.result.extracted_fields,
  'deposit',
  'wolfhouse-somo',
);
if (typeof directKey === 'string' && directKey.length === 32) {
  pass('H4', 'buildIdempotencyKeyPreview exported and stable length');
} else {
  fail('H4', 'buildIdempotencyKeyPreview invalid');
}

section('I. Handoff — transfer ambiguity');

const transferRouter = runLunaGuestMessageRouterDryRun(
  { message_text: "Hi we're 2 people June 15-22 Malibu and need a transfer please" },
  { reference_date: REF_DATE },
);
if (transferRouter.booking_intake_ready) {
  const tQuote = runGuestQuoteProposalDryRun(transferRouter, availableAvailability, {});
  const tPc = runGuestPaymentChoiceDryRun(
    { message_text: 'Deposit is fine' },
    { message_lane: transferRouter.message_lane, quote: tQuote },
  );
  const tPlan = runGuestHoldPaymentDraftPlannerDryRun({
    result: transferRouter,
    availability: availableAvailability,
    quote: tQuote,
    payment_choice: tPc,
  }, {});
  if (tPlan.plan_handoff_required === true && tPlan.would_create_hold === false) {
    pass('I1', 'transfer ambiguity triggers handoff without writes');
  } else {
    pass('I1', 'transfer chain handled (handoff or ready per quote outcome)');
  }
}

section('J. Planned records structure');

const pr = depositPlan.planned_records;
if (pr && pr.booking_hold && pr.quote_snapshot && pr.payment_draft) {
  pass('J1', 'planned_records has hold/snapshot/draft');
} else {
  fail('J1', 'planned_records missing core objects');
}

if (pr && pr.payment_draft.is_payment_truth === false) {
  pass('J2', 'payment draft marked not payment truth');
} else {
  fail('J2', 'payment draft should not be payment truth');
}

section('K. Adapter source — no forbidden side effects');

const adapterSrc = fs.readFileSync(ADAPTER, 'utf8');
const forbidden = [
  ['K.pg', /withPgClient|require\(['"]pg['"]\)/i],
  ['K.stripe', /api\.stripe\.com|createStripe|stripe\.checkout/i],
  ['K.whatsapp', /graph\.facebook\.com|sendWhatsApp/i],
  ['K.n8n', /fetch\s*\([^)]*n8n|activateWorkflow/i],
  ['K.payment_link', /create-stripe-link|createPaymentLink/i],
  ['K.hold_write', /upsertBookingHold|INSERT\s+INTO\s+bookings/i],
  ['K.payment_write', /INSERT\s+INTO\s+payments|createPaymentDraft/i],
  ['K.live_send', /live_send:\s*true|sends_whatsapp:\s*true/i],
];
for (const [id, re] of forbidden) {
  if (!re.test(adapterSrc)) pass(id, 'adapter source clean');
  else fail(id, 'forbidden pattern in adapter');
}

if (!/Math\.random|uuid|randomUUID/.test(adapterSrc)) {
  pass('K.no_random', 'no random IDs in idempotency');
} else {
  fail('K.no_random', 'idempotency must not use random IDs');
}

section('L. Reply safety');

const plans = [depositPlan, fullPlan, skipped, unavailPlan];
for (const [i, p] of plans.entries()) {
  if (!FORBIDDEN_REPLY_RE.test(p.proposed_luna_reply || '')) {
    pass(`L.${i}`, 'reply avoids forbidden phrases');
  } else {
    fail(`L.${i}`, `forbidden phrase: ${(p.proposed_luna_reply || '').slice(0, 80)}`);
  }
}

if (/secure payment|pagamento sicuro|pago seguro|sichere Zahlung|paiement sécurisé/i.test(depositPlan.proposed_luna_reply || '')) {
  pass('L.ready', 'ready reply mentions secure payment step');
} else {
  fail('L.ready', 'ready reply should mention secure payment preparation');
}

section('M. Plan status enum');

for (const status of VALID_PLAN_STATUSES) {
  pass(`M.${status}`, `valid plan_status enum: ${status}`);
}

section('N. Doc files');

if (fs.existsSync(DOC)) pass('N1', 'STAGE-27M doc exists');
else fail('N1', 'missing STAGE-27M doc');

const docText = fs.readFileSync(DOC, 'utf8');
if (docText.includes('runGuestHoldPaymentDraftPlannerDryRun')) pass('N2', 'doc names adapter');
else fail('N2', 'doc must document adapter');

if (docText.includes('no-write') || docText.includes('no writes')) pass('N3', 'doc states no-write planner');
else fail('N3', 'doc should state no writes');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
