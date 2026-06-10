/**
 * Stage 28h.3 — Verifier for new-booking reset after quote/payment-choice state.
 *
 * Usage:
 *   npm run verify:stage28h-reset-new-booking-intent
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const MERGE = path.join(__dirname, 'lib', 'luna-guest-context-merge.js');
const PC = path.join(__dirname, 'lib', 'luna-guest-payment-choice-dry-run.js');
const QUOTE = path.join(__dirname, 'lib', 'luna-guest-quote-proposal-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const GREETING_VERIFIER = path.join(__dirname, 'verify-stage28h-live-inbox-greeting.js');
const SCRIPT = 'verify:stage28h-reset-new-booking-intent';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage28h-reset-new-booking-intent.js  (Stage 28h.3)\n`);

for (const f of [ROUTER, ORCH, MERGE, PC, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('0', `${path.basename(f)} syntax error`);
  }
}

const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const orchSrc = fs.readFileSync(ORCH, 'utf8');
const mergeSrc = fs.readFileSync(MERGE, 'utf8');
const pcSrc = fs.readFileSync(PC, 'utf8');
const quoteSrc = fs.readFileSync(QUOTE, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

const {
  detectNewBookingResetIntent,
  isGreetingOnlyMessage,
  runLunaGuestMessageRouterDryRun,
} = require('./lib/luna-guest-message-router');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { runGuestPaymentChoiceDryRun } = require('./lib/luna-guest-payment-choice-dry-run');
const { stripQuotePaymentStateForReset } = require('./lib/luna-guest-context-merge');

section('A. Wiring');

if (pkg.scripts[SCRIPT]) pass('A1', 'verifier npm script registered');
else fail('A1', 'verifier script missing');

if (orchSrc.includes('detectNewBookingResetIntent')
  && orchSrc.includes('stripQuotePaymentStateForReset')) {
  pass('A2', 'orchestrator handles reset after active quote');
} else {
  fail('A2', 'orchestrator reset wiring missing');
}

if (pcSrc.includes('new_booking_reset')) pass('A3', 'payment-choice adapter skips reset turns');
else fail('A3', 'payment-choice reset guard missing');

if (quoteSrc.includes('not confirming or holding')) pass('A4', 'quote copy mentions no hold yet');
else fail('A4', 'quote hold clarity missing');

section('B. Reset intent detection');

const resetPhrases = [
  'no no I want to create another booking',
  'actually I want a new booking',
  'start over',
  'new booking',
  'different booking',
  'not that one',
  'forget that booking',
  "let's start again",
];
for (const p of resetPhrases) {
  if (detectNewBookingResetIntent(p)) pass('B1', `"${p}" detected`);
  else fail('B1', `"${p}" not detected`);
}

if (!detectNewBookingResetIntent('Deposit is fine')) {
  pass('B2', 'deposit choice is not reset intent');
} else {
  fail('B2', 'deposit misclassified as reset');
}

section('C. Orchestrator reset after quote state');

const poisonedQuoteContext = {
  message_lane: 'new_booking_inquiry',
  intake_state: 'ready_for_availability_check',
  quote: {
    quote_status: 'ready',
    quote_total_cents: 59800,
    payment_choice_needed: true,
    deposit_options: { deposit_required_cents: 20000 },
  },
  payment_choice_needed: true,
  result: {
    message_lane: 'new_booking_inquiry',
    intake_state: 'ready_for_availability_check',
    readiness_state: 'ready_for_availability_check',
    booking_intake_ready: true,
    extracted_fields: {
      check_in: '2026-07-10',
      check_out: '2026-07-17',
      guest_count: 2,
      package_interest: 'malibu',
    },
    detected_language: 'en',
  },
  availability: { availability_status: 'available', availability_check_attempted: true },
};

(async () => {
  const resetOut = await runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    message_text: 'no no I want to create another booking',
    guest_phone: '+491726422307',
    guest_context: poisonedQuoteContext,
  }, { dry_run: true });

  if (resetOut.proposed_next_action !== 'collect_payment_choice'
    && resetOut.proposed_next_action !== 'staff_handoff_required') {
    pass('C1', `next action is ${resetOut.proposed_next_action}, not payment choice`);
  } else {
    fail('C1', `still payment/handoff: ${resetOut.proposed_next_action}`);
  }

  if (resetOut.proposed_luna_reply && resetOut.proposed_luna_reply.includes('start a new booking')) {
    pass('C2', 'reset reply asks for new booking details');
  } else {
    fail('C2', `wrong reply: ${(resetOut.proposed_luna_reply || '').slice(0, 100)}`);
  }

  if (!resetOut.proposed_luna_reply.includes('deposit or the full amount')) {
    pass('C3', 'reset reply does not repeat payment-choice prompt');
  } else {
    fail('C3', 'payment-choice prompt leaked into reset reply');
  }

  if (!resetOut.payment_choice || resetOut.payment_choice.payment_choice_ready !== true) {
    pass('C4', 'no payment_choice_ready on reset-only turn');
  } else {
    fail('C4', 'payment choice incorrectly marked ready');
  }

  if (!resetOut.hold_payment_draft_plan || resetOut.hold_payment_draft_plan.plan_status !== 'ready') {
    pass('C5', 'no hold plan created on reset-only turn');
  } else {
    fail('C5', 'hold plan created on reset');
  }

  const cleared = stripQuotePaymentStateForReset(poisonedQuoteContext);
  if (cleared.quote_status === 'not_ready' && cleared.payment_choice_needed === false) {
    pass('C6', 'stripQuotePaymentStateForReset clears quote/payment flags');
  } else {
    fail('C6', 'context strip incomplete');
  }

  section('D. Reset with new details in same message');

  const freshOut = await runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    message_text: 'Actually make it Uluwatu for 3 people August 4 to 11',
    guest_phone: '+491726422307',
    guest_context: poisonedQuoteContext,
    reference_date: '2026-06-10',
  }, { dry_run: true, reference_date: '2026-06-10' });

  const fields = freshOut.result && freshOut.result.extracted_fields;
  if (fields && fields.package_interest === 'uluwatu' && fields.guest_count === 3) {
    pass('D1', 'reset message with details extracts new package/guests');
  } else {
    fail('D1', `expected uluwatu/3 guests: ${JSON.stringify(fields)}`);
  }

  if (fields && fields.check_in === '2026-08-04' && fields.check_out === '2026-08-11') {
    pass('D2', 'reset with details uses new dates instead of prior malibu quote');
  } else {
    fail('D2', `expected Aug 4–11 dates: ${JSON.stringify(fields)}`);
  }

  if (freshOut.proposed_next_action !== 'collect_payment_choice') {
    pass('D3', 'reset-with-details does not continue old payment-choice step');
  } else {
    fail('D3', 'still on collect_payment_choice after reset-with-details');
  }

  section('E. Payment-choice adapter guard');

  const pcOut = runGuestPaymentChoiceDryRun(
    { message_text: 'no no I want to create another booking' },
    poisonedQuoteContext,
  );
  if (pcOut.payment_choice_reasons && pcOut.payment_choice_reasons.includes('new_booking_reset')) {
    pass('E1', 'payment-choice dry-run returns new_booking_reset reason');
  } else {
    fail('E1', `unexpected pc reasons: ${JSON.stringify(pcOut.payment_choice_reasons)}`);
  }

  section('F. Greeting regression (28h.1)');

  if (isGreetingOnlyMessage('hello?')) {
    const helloRouter = runLunaGuestMessageRouterDryRun(
      { message_text: 'hello?', guest_context: poisonedQuoteContext },
      { guest_phone: '+491726422307' },
    );
    if (!helloRouter.safe_handoff_required) pass('F1', 'greeting still avoids handoff with quote context');
    else fail('F1', 'greeting handoff regression');
  } else {
    fail('F1', 'greeting detector regression');
  }

  if (!routerSrc.includes('create_stripe_test_link_confirmed: true')
    && !orchSrc.includes('runGuestConfirmationSend')) {
    pass('F2', 'no Stripe/confirmation paths added');
  } else {
    fail('F2', 'forbidden send path detected');
  }

  console.log(`\n── Summary ──\n\nResults: ${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
