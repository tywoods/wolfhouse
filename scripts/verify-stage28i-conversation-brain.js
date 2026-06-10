/**
 * Stage 28i — Verifier for the Luna conversation brain (deterministic first slice).
 *
 * Usage:
 *   npm run verify:stage28i-conversation-brain
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BRAIN = path.join(__dirname, 'lib', 'luna-conversation-brain.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28i-conversation-brain';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

async function runTurns(turns) {
  const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
  let ctx = {};
  const out = [];
  for (const message_text of turns) {
    const o = await runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      message_text,
      guest_phone: '+491726422307',
      guest_context: ctx,
      reference_date: '2026-06-10',
    }, { dry_run: true, reference_date: '2026-06-10' });
    out.push({ message_text, orchestrator: o, result: o.result || {} });
    ctx = o.result ? { ...ctx, ...o.result, result: o.result } : ctx;
  }
  return out;
}

function isHandoffReply(reply) {
  return /follow up soon|passing this to our team|hand(?:ing)? this over/i.test(reply || '');
}

console.log(`\nverify-stage28i-conversation-brain.js  (Stage 28i)\n`);

for (const f of [BRAIN, ROUTER, ORCH, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('0', `${path.basename(f)} syntax error`);
  }
}

const brainSrc = fs.readFileSync(BRAIN, 'utf8');
const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const orchSrc = fs.readFileSync(ORCH, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

const brain = require('./lib/luna-conversation-brain');
const { decideConversationAction } = brain;

section('A. Wiring + contract');

if (pkg.scripts[SCRIPT]) pass('A1', 'verifier npm script registered');
else fail('A1', 'verifier script missing');

if (routerSrc.includes("require('./luna-conversation-brain')")
  && routerSrc.includes('decideConversationAction(')) {
  pass('A2', 'router consults conversation brain');
} else {
  fail('A2', 'brain not wired into router');
}

{
  const d = decideConversationAction({ message_text: 'hi' });
  const keys = ['intent', 'reply_type', 'preserve_context', 'reset_context',
    'extracted_fields_patch', 'side_question_answer_needed', 'next_missing_field',
    'should_handoff', 'confidence', 'safety_flags'];
  const missing = keys.filter((k) => !(k in d));
  if (missing.length === 0) pass('A3', 'decision contract complete');
  else fail('A3', `missing decision keys: ${missing.join(',')}`);
}

section('B. Deterministic detectors');

{
  const d = decideConversationAction({
    message_text: 'explain the packages',
    in_active_booking: true,
    active_missing_field: 'package_interest',
    prior_extracted_fields: { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1 },
  });
  if (d.intent === 'side_question' && d.side_question_answer_needed && d.preserve_context && d.should_handoff === false) {
    pass('B1', '"explain the packages" => preserved side_question');
  } else {
    fail('B1', `decision=${JSON.stringify(d)}`);
  }
}

{
  const d = decideConversationAction({ message_text: '1', in_active_booking: true, active_missing_field: 'guest_count' });
  if (d.intent === 'answer_missing_field' && d.extracted_fields_patch.guest_count === 1 && d.should_handoff === false) {
    pass('B2', '"1" answers guest_count');
  } else {
    fail('B2', `decision=${JSON.stringify(d)}`);
  }
}

{
  const d = decideConversationAction({ message_text: 'Malibu', in_active_booking: true, active_missing_field: 'package_interest' });
  if (d.intent === 'package_choice' && d.extracted_fields_patch.package_interest === 'malibu') {
    pass('B3', '"Malibu" => package_choice patch');
  } else {
    fail('B3', `decision=${JSON.stringify(d)}`);
  }
}

{
  const d = decideConversationAction({ message_text: 'no no I want to create another booking', in_active_booking: true });
  if (d.intent === 'reset_new_booking' && d.reset_context === true) {
    pass('B4', 'reset signal detected');
  } else {
    fail('B4', `decision=${JSON.stringify(d)}`);
  }
}

{
  const d = decideConversationAction({ message_text: 'what is Uluwatu?', in_active_booking: false });
  if (d.intent === 'side_question' && d.side_question_type === 'uluwatu') {
    pass('B5', '"what is Uluwatu?" => uluwatu side_question');
  } else {
    fail('B5', `decision=${JSON.stringify(d)}`);
  }
}

{
  const d = decideConversationAction({ message_text: 'asdkjfh qwop', in_active_booking: true, active_missing_field: 'package_interest' });
  if (d.intent === 'clarify' && d.should_handoff === false) {
    pass('B6', 'unknown mid-booking => clarify (no handoff)');
  } else {
    fail('B6', `decision=${JSON.stringify(d)}`);
  }
}

section('C. Test 1 — package side-question during active intake');

(async () => {
  const turns = await runTurns(['hi', 'book a stay', 'July 1-5', '1', 'explain the packages']);
  const last = turns[turns.length - 1];
  const r = last.result;
  const reply = last.orchestrator.proposed_luna_reply || '';

  if (/malibu/i.test(reply) && /uluwatu/i.test(reply) && /waimea/i.test(reply)) pass('C1', 'package explanation returned');
  else fail('C1', `reply=${reply.slice(0, 120)}`);

  if (!r.safe_handoff_required && !isHandoffReply(reply)) pass('C2', 'no handoff on side-question');
  else fail('C2', `handoff=${r.safe_handoff_required}`);

  const ef = r.extracted_fields || {};
  if (ef.check_in === '2026-07-01' && ef.check_out === '2026-07-05' && ef.guest_count === 1) {
    pass('C3', 'dates + guests preserved through side-question');
  } else {
    fail('C3', `ef=${JSON.stringify(ef)}`);
  }

  if (/which (?:one|package)|malibu, uluwatu/i.test(reply)) pass('C4', 'asks which package');
  else fail('C4', 'no package follow-up question');

  section('D. Test 3 — package choice after explanation');

  const turns2 = await runTurns(['hi', 'book a stay', 'July 10-17', '1', 'explain the packages', 'Malibu']);
  const pick = turns2[turns2.length - 1].result;
  if (pick.message_lane === 'new_booking_inquiry') pass('D1', 'Malibu continues booking lane');
  else fail('D1', `lane=${pick.message_lane}`);

  if ((pick.extracted_fields || {}).package_interest === 'malibu') pass('D2', 'package_interest=malibu set');
  else fail('D2', `package=${(pick.extracted_fields || {}).package_interest}`);

  if (pick.extracted_fields.check_in === '2026-07-10' && pick.extracted_fields.guest_count === 1) {
    pass('D3', 'dates/guests reused for the pick');
  } else {
    fail('D3', `ef=${JSON.stringify(pick.extracted_fields)}`);
  }

  if (!pick.safe_handoff_required) pass('D4', 'package choice does not hand off');
  else fail('D4', 'handoff on package choice');

  section('E. Test 4 — reset after quote (injected quote/payment state)');

  // A quote only forms with a live DB, so inject the poisoned post-quote context here.
  const poisonedQuoteContext = {
    message_lane: 'new_booking_inquiry',
    intake_state: 'ready_for_availability_check',
    quote: { quote_status: 'ready', quote_total_cents: 59800, payment_choice_needed: true },
    payment_choice_needed: true,
    result: {
      message_lane: 'new_booking_inquiry',
      intake_state: 'ready_for_availability_check',
      readiness_state: 'ready_for_availability_check',
      booking_intake_ready: true,
      extracted_fields: { check_in: '2026-07-10', check_out: '2026-07-17', guest_count: 2, package_interest: 'malibu' },
      detected_language: 'en',
    },
    availability: { availability_status: 'available', availability_check_attempted: true },
  };
  const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
  const resetOut = await runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    message_text: 'no no I want to create another booking',
    guest_phone: '+491726422307',
    guest_context: poisonedQuoteContext,
  }, { dry_run: true });
  const resetReply = resetOut.proposed_luna_reply || '';
  if (resetOut.proposed_next_action !== 'collect_payment_choice'
    && !/deposit or the full amount/i.test(resetReply)) {
    pass('E1', 'reset clears payment-choice continuation');
  } else {
    fail('E1', `next=${resetOut.proposed_next_action} reply=${resetReply.slice(0, 80)}`);
  }
  if (/start a new booking|new booking/i.test(resetReply) && !isHandoffReply(resetReply)) pass('E2', 'reset asks new booking basics');
  else fail('E2', `reply=${resetReply.slice(0, 80)}`);
  // brain itself flags the reset
  const resetDecision = decideConversationAction({ message_text: 'no no I want to create another booking', in_active_booking: true });
  if (resetDecision.reset_context === true) pass('E3', 'brain flags reset_context');
  else fail('E3', 'brain missed reset');

  section('F. Test 5 — package-specific side question');

  const uluTurns = await runTurns(['hi', 'book a stay', 'July 1-5', '1', 'what does Uluwatu include?']);
  const ulu = uluTurns[uluTurns.length - 1];
  const uluReply = ulu.orchestrator.proposed_luna_reply || '';
  if (/uluwatu/i.test(uluReply) && /€349|349/.test(uluReply)) pass('F1', 'Uluwatu explained');
  else fail('F1', `reply=${uluReply.slice(0, 120)}`);
  if (ulu.result.extracted_fields?.check_in === '2026-07-01' && !ulu.result.safe_handoff_required) {
    pass('F2', 'Uluwatu side-question preserves context, no handoff');
  } else {
    fail('F2', `ef=${JSON.stringify(ulu.result.extracted_fields)} handoff=${ulu.result.safe_handoff_required}`);
  }

  section('G. Test 6 — clarify unknown mid-booking');

  const clarTurns = await runTurns(['hi', 'book a stay', 'July 1-5', '1', 'asdkjfh qwop']);
  const clar = clarTurns[clarTurns.length - 1];
  const clarReply = clar.orchestrator.proposed_luna_reply || '';
  if (!clar.result.safe_handoff_required && !isHandoffReply(clarReply)) pass('G1', 'unknown mid-booking does not hand off');
  else fail('G1', `handoff=${clar.result.safe_handoff_required}`);
  if (/which package|didn't quite catch|malibu/i.test(clarReply)) pass('G2', 'clarify re-asks active field');
  else fail('G2', `reply=${clarReply.slice(0, 80)}`);

  section('H. Test 7 — intro only on greeting');

  const introTurns = await runTurns(['hi', 'book a stay', 'July 1-5', '1', 'explain the packages']);
  if (/^Hey!/i.test(introTurns[0].orchestrator.proposed_luna_reply || '')) pass('H1', 'greeting uses Hey intro');
  else fail('H1', 'greeting intro missing');
  let repeated = false;
  for (const t of introTurns.slice(1)) {
    if (/^Hi! I'm Luna from Wolfhouse/i.test(t.orchestrator.proposed_luna_reply || '')) repeated = true;
  }
  if (!repeated) pass('H2', 'no repeated intro mid-flow');
  else fail('H2', 'repeated intro found');

  section('I. Test 8 — safety boundaries');

  const sf = brain.BRAIN_SAFETY_FLAGS;
  const allFalse = Object.values(sf).every((v) => v === false);
  if (allFalse) pass('I1', 'brain safety flags all false');
  else fail('I1', `safety=${JSON.stringify(sf)}`);

  // LLM never trusted for unsafe fields / never auto-enabled in production
  const sanitized = brain.sanitizeLlmDecision({
    intent: 'side_question',
    creates_booking: true,
    safety_flags: { creates_booking: true },
    extracted_fields_patch: { guest_count: 2, secret_total_price: 999 },
  }, 'guest_count');
  if (sanitized && sanitized.safety_flags.creates_booking === false
    && !('secret_total_price' in sanitized.extracted_fields_patch)
    && sanitized.extracted_fields_patch.guest_count === 2) {
    pass('I2', 'LLM decision sanitized (unsafe fields stripped)');
  } else {
    fail('I2', `sanitized=${JSON.stringify(sanitized)}`);
  }

  if (brain.isConversationBrainLlmEnabled({ NODE_ENV: 'production', LUNA_CONVERSATION_BRAIN_ENABLED: 'true', LUNA_CONVERSATION_BRAIN_LLM_ENABLED: 'true' }) === false) {
    pass('I3', 'LLM fallback disabled in production');
  } else {
    fail('I3', 'LLM fallback NOT disabled in production');
  }

  if (!brainSrc.includes('create_stripe') && !brainSrc.includes('confirmation_send')
    && !routerSrc.includes('create_stripe_test_link') && !orchSrc.includes('runGuestConfirmationSend')) {
    pass('I4', 'no Stripe/confirmation paths added');
  } else {
    fail('I4', 'forbidden paths touched');
  }

  // a pure side-question turn must not produce a booking write / payment-choice plan
  if (last.orchestrator.proposed_next_action !== 'collect_payment_choice'
    && last.orchestrator.hold_payment_draft_plan?.plan_status !== 'ready') {
    pass('I5', 'side-question alone creates no booking write');
  } else {
    fail('I5', `next=${last.orchestrator.proposed_next_action}`);
  }

  console.log(`\n── Summary ──\n\nResults: ${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
