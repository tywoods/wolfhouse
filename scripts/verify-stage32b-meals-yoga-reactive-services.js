/**
 * Stage 32b — reactive meals/yoga verifier.
 *
 * Usage:
 *   npm run verify:stage32b-meals-yoga-reactive-services
 */

'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const ROOT = path.join(__dirname, '..');
const POLICY = path.join(__dirname, 'lib', 'luna-booking-reactive-services-policy.js');
const ADDONS_POLICY = path.join(__dirname, 'lib', 'luna-booking-addons-policy.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage32b-meals-yoga-reactive-services';
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine');

const {
  detectReactiveServiceIntent,
  extractReactiveServicesFromMessage,
  guestDecidedLater,
  buildReactiveServicesObservability,
  resolveGuestSchedulingCapability,
} = require('./lib/luna-booking-reactive-services-policy');
const {
  extractAddOnSelections,
  quoteAwaitingAddonsDecision,
} = require('./lib/luna-booking-addons-policy');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');
const { normalizeGuestContextForChain } = require('./lib/luna-guest-context-merge');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage32b-meals-yoga-reactive-services.js  (Stage 32b)\n`);

section('A. Files + package');
check('A1', fs.existsSync(POLICY), 'reactive services policy module exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A2', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const stage32bFixtures = [
  'yoga-request-mid-booking.json',
  'meals-request-mid-booking.json',
  'meals-yoga-not-proactively-offered.json',
  'yoga-decide-later-does-not-block.json',
  'meals-request-then-deposit-flow.json',
];
for (const f of stage32bFixtures) {
  check(`A3-${f}`, fs.existsSync(path.join(FIXTURE_DIR, f)), `fixture ${f}`);
}

section('B. Reactive intent parsing');
check('B1', detectReactiveServiceIntent('Can I add yoga?') === 'yoga', '"Can I add yoga?" → yoga');
check('B2', detectReactiveServiceIntent('Can I book dinners?') === 'meals', '"Can I book dinners?" → meals');
check('B3', guestDecidedLater("I'll decide later"), '"I\'ll decide later" detected');
check('B4', extractAddOnSelections('yoga and wetsuit').includes('wetsuit')
  && !extractAddOnSelections('yoga and wetsuit').includes('yoga'),
  'yoga not treated as proactive surf add-on');

section('C. Scheduling source');
const sched = resolveGuestSchedulingCapability();
check('C1', sched.staff_schedule_module === 'staff-booking-services-schedule',
  'staff scheduling module referenced');
check('C2', sched.guest_attach_available === false,
  'guest dry-run stores pending (no fake scheduling attach)');

section('D. Orchestrator mid-booking flows');

async function runTurn(message, prior) {
  const out = await runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo',
    channel: 'dry_run',
    message_text: message,
    guest_phone: '+491726422399',
    guest_context: prior || {},
    reference_date: '2026-06-10',
  });
  const review = {
    result: out.result,
    availability: out.availability,
    quote: out.quote,
    payment_choice: out.payment_choice,
    hold_payment_draft_plan: out.hold_payment_draft_plan,
    proposed_luna_reply: out.proposed_luna_reply,
  };
  const composed = composeLunaGuestReply({
    payload: review,
    message_text: message,
    prior_guest_context: prior || {},
    brain_decision: out.result && out.result.conversation_brain,
  });
  return {
    out,
    reply: composed && composed.reply ? composed.reply : out.proposed_luna_reply,
    ctx: normalizeGuestContextForChain({
      result: out.result,
      availability: out.availability,
      quote: out.quote,
      payment_choice: out.payment_choice,
      extracted_fields: out.result && out.result.extracted_fields,
    }),
  };
}

(async () => {
  let ctx = {};
  let r = await runTurn('hi', ctx);
  ctx = r.ctx;
  r = await runTurn('book a stay', ctx);
  ctx = r.ctx;
  r = await runTurn('July 6-10 for 1 guest', ctx);
  ctx = r.ctx;
  r = await runTurn('Marco', ctx);
  ctx = r.ctx;

  const quoteReply = r.reply || '';
  check('D1', /wetsuit|surfboard|lessons/i.test(quoteReply), 'surf add-on question after quote');
  check('D2', !/\byoga\b/i.test(quoteReply), 'normal quote flow does not mention yoga');
  check('D3', !/\b(?:dinner|meals|breakfast)\b/i.test(quoteReply), 'normal quote flow does not mention meals');

  const yogaQ = await runTurn('Can I add yoga?', ctx);
  check('D4', /yoga/i.test(yogaQ.reply || ''), 'yoga question answered');
  check('D5', yogaQ.out.result.yoga_status === 'requested' || yogaQ.out.result.yoga_status === 'needs_staff_confirmation',
    'yoga request stored');
  check('D6', yogaQ.out.result.extracted_fields.check_in === '2026-07-06',
    'booking context preserved after yoga question');
  check('D7', /July|keep going|anything else/i.test(yogaQ.reply || ''),
    'returns to booking flow after yoga');

  const mealsQ = await runTurn('Can I book dinners?', yogaQ.ctx);
  check('D8', /dinner|days/i.test(mealsQ.reply || ''), 'meals question asks for days when needed');
  check('D9', mealsQ.out.result.meals_status === 'requested',
    'meal request stored as requested');

  const decideLater = await runTurn("I'll decide later on the dinners", mealsQ.ctx);
  check('D10', decideLater.out.result.meals_status === 'interested'
    || decideLater.out.result.extracted_fields.meals_request?.status === 'interested',
    '"decide later" stores interest only');
  check('D11', decideLater.out.quote && decideLater.out.quote.quote_status === 'ready',
    'decide later does not block quote');

  const ownStuff = await runTurn('just the stay', decideLater.ctx);
  ctx = ownStuff.ctx;
  check('D12', ownStuff.out.result.extracted_fields.addons_skipped === true,
    'surf add-ons still work after reactive services');

  const deposit = await runTurn('deposit', ctx);
  check('D13', deposit.out.payment_choice && deposit.out.payment_choice.payment_choice === 'deposit',
    'deposit flow still works after meals/yoga');

  const obs = buildReactiveServicesObservability(deposit.out.result.extracted_fields, 'wolfhouse-somo');
  check('D14', obs.meals_status != null && obs.yoga_status != null, 'observability fields populated');
  check('D15', Array.isArray(obs.services_requested) || obs.services_pending_manual,
    'services_requested / pending_manual tracked');

  section('E. Stage 32 surf add-ons + transfer still wired');
  check('E1', fs.existsSync(ADDONS_POLICY), 'stage 32 addons policy still present');
  check('E2', quoteAwaitingAddonsDecision({ quote_status: 'ready', addons_pending_after_quote: true }),
    'addons pending helper intact');

  console.log(`\n${passes}/${passes + failures} checks passed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
