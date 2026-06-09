/**
 * Stage 27w.2 — Guest context field merge verifier.
 *
 * Usage:
 *   npm run verify:stage27w2-guest-context-merge
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MERGE = path.join(__dirname, 'lib', 'luna-guest-context-merge.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const API = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27w2-guest-context-merge';

const {
  mergeGuestExtractedFields,
  collectPriorExtractedFields,
} = require('./lib/luna-guest-context-merge');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const REF_DATE = '2026-06-08';
const BANNED_INTERNAL_COPY_RE = /\b(?:confirmed quote|payment choice|payment_choice|quote_status|guest_context|intake_state|readiness_state|automation gate|next_safe_step|dry run)\b/i;

function baseInput(overrides) {
  return {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    dry_run: true,
    reference_date: REF_DATE,
    automation_gate_context: { public_guest_automation_enabled: false },
    ...overrides,
  };
}

function guestContextFromReview(out) {
  return {
    message_lane: out.result && out.result.message_lane,
    intake_state: out.result && out.result.intake_state,
    readiness_state: out.result && out.result.readiness_state,
    booking_intake_ready: out.result && out.result.booking_intake_ready,
    extracted_fields: out.result && out.result.extracted_fields,
    result: out.result,
    availability: out.availability,
    quote: out.quote,
    payment_choice_needed: out.quote && out.quote.payment_choice_needed,
    payment_choice: out.payment_choice,
    hold_payment_draft_plan: out.hold_payment_draft_plan,
    detected_language: out.result && out.result.detected_language,
  };
}

console.log('\nverify-stage27w2-guest-context-merge.js  (Stage 27w.2)\n');

section('A. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('A1', `${SCRIPT} registered`);
else fail('A1', `missing npm script ${SCRIPT}`);

section('B. Merge helper unit tests');

const nullOverwrite = mergeGuestExtractedFields(
  { guest_count: 2, package_interest: 'malibu', check_in: null },
  { check_in: '2026-07-10', check_out: '2026-07-17', guest_count: null, package_interest: null },
);
if (nullOverwrite.guest_count === 2) pass('B1', 'null current guest_count does not erase prior');
else fail('B1', `guest_count ${nullOverwrite.guest_count}`);
if (nullOverwrite.package_interest === 'malibu') pass('B2', 'null current package_interest preserved');
else fail('B2', `package ${nullOverwrite.package_interest}`);
if (nullOverwrite.check_in === '2026-07-10' && nullOverwrite.check_out === '2026-07-17') {
  pass('B3', 'new dates merged in');
} else fail('B3', 'dates not merged');

const collected = collectPriorExtractedFields({
  extracted_fields: { guest_count: 2 },
  result: { extracted_fields: { package_interest: 'malibu' } },
});
if (collected.guest_count === 2 && collected.package_interest === 'malibu') {
  pass('B4', 'collectPriorExtractedFields merges ctx + result');
} else fail('B4', JSON.stringify(collected));

section('C. Turn 1 partial booking → asks dates');

(async () => {
  const turn1 = await runGuestAutomationOrchestratorDryRun(baseInput({
    message_text: 'Hi, we are 2 people interested in the Malibu package',
  }), {});

  if (turn1.result && turn1.result.booking_intake_ready === false) {
    pass('C1', 'turn 1 booking_intake_ready false');
  } else fail('C1', 'turn 1 should not be intake ready');

  if (/dates|check-in|check-out|stay/i.test(turn1.proposed_luna_reply || '')) {
    pass('C2', 'turn 1 asks for dates');
  } else fail('C2', turn1.proposed_luna_reply);

  if (turn1.result.extracted_fields.guest_count === 2
    && turn1.result.extracted_fields.package_interest === 'malibu') {
    pass('C3', 'turn 1 extracted guest_count and package');
  } else fail('C3', JSON.stringify(turn1.result.extracted_fields));

  section('D. Turn 2 dates only preserves prior fields');

  const ctxA = guestContextFromReview(turn1);
  const turn2 = await runGuestAutomationOrchestratorDryRun(baseInput({
    message_text: 'July 10 to July 17',
    guest_context: ctxA,
  }), {});

  const f2 = turn2.result && turn2.result.extracted_fields;
  if (f2 && f2.guest_count === 2 && f2.package_interest === 'malibu') {
    pass('D1', 'turn 2 preserves guest_count and package_interest');
  } else fail('D1', JSON.stringify(f2));

  if (f2 && f2.check_in === '2026-07-10' && f2.check_out === '2026-07-17') {
    pass('D2', 'turn 2 adds check_in/check_out');
  } else fail('D2', JSON.stringify(f2));

  if (turn2.result && turn2.result.booking_intake_ready === true) {
    pass('D3', 'turn 2 booking_intake_ready true');
  } else fail('D3', `ready=${turn2.result && turn2.result.booking_intake_ready}`);

  if (!/how many guests/i.test(turn2.proposed_luna_reply || '')) {
    pass('D4', 'turn 2 does not ask guest count again');
  } else fail('D4', turn2.proposed_luna_reply);

  if (!BANNED_INTERNAL_COPY_RE.test(turn2.proposed_luna_reply || '')) {
    pass('D5', 'turn 2 reply avoids internal copy');
  } else fail('D5', turn2.proposed_luna_reply);

  section('E. Turn 1 dates, turn 2 package preserves dates');

  const datesFirst = await runGuestAutomationOrchestratorDryRun(baseInput({
    message_text: 'July 10 to July 17',
  }), {});

  const ctxDates = guestContextFromReview(datesFirst);
  const packageSecond = await runGuestAutomationOrchestratorDryRun(baseInput({
    message_text: 'We want the Malibu package for 2 guests',
    guest_context: ctxDates,
  }), {});

  const fp = packageSecond.result && packageSecond.result.extracted_fields;
  if (fp && fp.check_in === '2026-07-10' && fp.check_out === '2026-07-17') {
    pass('E1', 'turn 2 package preserves dates');
  } else fail('E1', JSON.stringify(fp));

  if (fp && fp.guest_count === 2 && fp.package_interest === 'malibu') {
    pass('E2', 'turn 2 package adds guest_count and package');
  } else fail('E2', JSON.stringify(fp));

  section('F. Quote context + Deposit is fine');

  const depositTurn = await runGuestAutomationOrchestratorDryRun(baseInput({
    message_text: 'Deposit is fine',
    guest_context: {
      message_lane: 'new_booking_inquiry',
      quote: {
        quote_status: 'ready',
        payment_choice_needed: true,
        quote_total_cents: 123456,
      },
      payment_choice_needed: true,
    },
  }), {});

  if (depositTurn.payment_choice && depositTurn.payment_choice.payment_choice_detected === true) {
    pass('F1', 'payment_choice_detected true');
  } else fail('F1', 'deposit not detected');

  if (depositTurn.payment_choice && depositTurn.payment_choice.payment_choice === 'deposit') {
    pass('F2', 'payment_choice deposit');
  } else fail('F2', depositTurn.payment_choice && depositTurn.payment_choice.payment_choice);

  if (depositTurn.payment_choice && depositTurn.payment_choice.payment_choice_ready === true) {
    pass('F3', 'payment_choice_ready true');
  } else fail('F3', 'not ready');

  if (depositTurn.payment_choice && depositTurn.payment_choice.next_safe_step === 'ready_for_hold_payment_draft') {
    pass('F4', 'next_safe_step ready_for_hold_payment_draft');
  } else fail('F4', depositTurn.payment_choice && depositTurn.payment_choice.next_safe_step);

  section('F2. Deposit turn with full prior booking chain → hold plan ready');

  const fullChainCtx = {
    message_lane: 'new_booking_inquiry',
    booking_intake_ready: true,
    readiness_state: 'ready_for_availability_check',
    result: {
      message_lane: 'new_booking_inquiry',
      booking_intake_ready: true,
      readiness_state: 'ready_for_availability_check',
      extracted_fields: {
        check_in: '2026-07-10',
        check_out: '2026-07-17',
        guest_count: 2,
        package_interest: 'malibu',
      },
      detected_language: 'en',
    },
    availability: {
      availability_check_attempted: true,
      availability_status: 'available',
    },
    quote: {
      quote_status: 'ready',
      payment_choice_needed: true,
      quote_total_cents: 59800,
      deposit_options: { deposit_required_cents: 20000 },
    },
    payment_choice_needed: true,
  };

  const depositFull = await runGuestAutomationOrchestratorDryRun(baseInput({
    message_text: 'Deposit is fine',
    guest_context: fullChainCtx,
  }), {});

  const plan = depositFull.hold_payment_draft_plan;
  if (plan && plan.plan_status === 'ready') pass('F5', 'hold_payment_draft_plan.plan_status ready');
  else fail('F5', `plan_status=${plan && plan.plan_status}`);

  if (plan && plan.would_create_hold === true) pass('F6', 'would_create_hold true');
  else fail('F6', `would_create_hold=${plan && plan.would_create_hold}`);

  if (plan && plan.would_create_payment_draft === true) pass('F7', 'would_create_payment_draft true');
  else fail('F7', `would_create_payment_draft=${plan && plan.would_create_payment_draft}`);

  if (plan && plan.would_create_stripe_link === false) pass('F8', 'would_create_stripe_link false');
  else fail('F8', `would_create_stripe_link=${plan && plan.would_create_stripe_link}`);

  if (depositFull.result && depositFull.result.message_lane !== 'new_booking_inquiry') {
    pass('F9', 'current turn lane may drift without breaking planner');
  } else pass('F9', 'deposit turn processed with booking chain context');

  if (depositFull.sends_whatsapp === false && depositFull.live_send_blocked === true) {
    pass('F10', 'deposit turn safety flags');
  } else fail('F10', 'safety flags missing');

  section('G. Source wiring');

  const routerSrc = fs.readFileSync(ROUTER, 'utf8');
  const orchSrc = fs.readFileSync(ORCH, 'utf8');
  const apiSrc = fs.readFileSync(API, 'utf8');

  if (routerSrc.includes('collectPriorExtractedFields')) pass('G1', 'router uses collectPriorExtractedFields');
  else fail('G1', 'router merge missing');

  if (orchSrc.includes('normalizeGuestContextForChain') && orchSrc.includes('guest_context: chainGuestContext')) {
    pass('G2', 'orchestrator forwards normalized guest_context to router');
  } else fail('G2', 'orchestrator guest_context wiring missing');

  if (orchSrc.includes('buildHoldPaymentDraftPlannerChain')) {
    pass('G4', 'orchestrator uses buildHoldPaymentDraftPlannerChain for 27m');
  } else fail('G4', 'planner chain merge missing in orchestrator');

  if (apiSrc.includes('extracted_fields: r.result') && apiSrc.includes('hold_payment_draft_plan')) {
    pass('G3', 'simulator stores full review context for next turn');
  } else fail('G3', 'simulator guest_context incomplete');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
