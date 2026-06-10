/**
 * Stage 28h.7 — Verifier for intake continuation replies + no repeated intro.
 *
 * Usage:
 *   npm run verify:stage28h7-intake-continuation
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28h7-intake-continuation';

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

console.log(`\nverify-stage28h7-intake-continuation.js  (Stage 28h.7)\n`);

for (const f of [ROUTER, ORCH, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('0', `${path.basename(f)} syntax error`);
  }
}

const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const orchSrc = fs.readFileSync(ORCH, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

const {
  runLunaGuestMessageRouterDryRun,
  parseContinuationGuestCount,
  isIntakeContinuationAnswer,
  resolveActiveIntakeMissingField,
  isGreetingOnlyMessage,
  buildGreetingMenuReply,
} = require('./lib/luna-guest-message-router');

section('A. Wiring');

if (pkg.scripts[SCRIPT]) pass('A1', 'verifier npm script registered');
else fail('A1', 'verifier script missing');

if (routerSrc.includes('parseContinuationGuestCount')
  && routerSrc.includes('isIntakeContinuationAnswer')
  && routerSrc.includes('ask_package_ready')) {
  pass('A2', 'continuation helpers present');
} else {
  fail('A2', 'continuation helpers missing');
}

if (routerSrc.includes('includeIntro: false')
  || routerSrc.includes('includeIntro:false')) {
  pass('A3', 'booking replies skip repeated intro');
} else {
  fail('A3', 'intro skip not wired');
}

section('B. Continuation parsers');

if (parseContinuationGuestCount('1') === 1) pass('B1', '"1" => guest_count 1');
else fail('B1', `"1" => ${parseContinuationGuestCount('1')}`);

if (parseContinuationGuestCount('2') === 2) pass('B2', '"2" => guest_count 2');
else fail('B2', `"2" => ${parseContinuationGuestCount('2')}`);

const guestCtx = {
  message_lane: 'new_booking_inquiry',
  intake_state: 'collecting_required_details',
  missing_required_fields: ['guest_count', 'package_interest'],
  extracted_fields: { check_in: '2026-07-01', check_out: '2026-07-05' },
};
if (resolveActiveIntakeMissingField(guestCtx) === 'guest_count') pass('B3', 'active missing field is guest_count');
else fail('B3', `active field ${resolveActiveIntakeMissingField(guestCtx)}`);

if (isIntakeContinuationAnswer('1', 'guest_count')) pass('B4', '"1" answers guest_count field');
else fail('B4', 'continuation answer not detected');

section('C. Full conversation flow');

(async () => {
  const turns = await runTurns([
    'Hello',
    'Yes I want to book a stay',
    'July 1-5',
    '1',
  ]);
  const last = turns[turns.length - 1];
  const r = last.result;

  if (!r.safe_handoff_required) pass('C1', 'final turn does not hand off');
  else fail('C1', 'unexpected handoff on "1"');

  if (r.message_lane === 'new_booking_inquiry') pass('C2', 'final turn stays on booking lane');
  else fail('C2', `lane=${r.message_lane}`);

  const ef = r.extracted_fields || {};
  if (ef.check_in === '2026-07-01' && ef.check_out === '2026-07-05') {
    pass('C3', 'dates preserved across turns');
  } else {
    fail('C3', `dates=${ef.check_in}/${ef.check_out}`);
  }

  if (ef.guest_count === 1) pass('C4', 'guest_count=1 on final turn');
  else fail('C4', `guest_count=${ef.guest_count}`);

  if (r.package_night_rule === 'short_stay_guidance'
    && (r.missing_required_fields || []).includes('stay_type')
    && !(r.missing_required_fields || []).includes('guest_count')) {
    pass('C5', 'short stay (<7 nights) routes to stay_type guidance after guest count');
  } else {
    fail('C5', `missing=${JSON.stringify(r.missing_required_fields)} rule=${r.package_night_rule}`);
  }

  const reply = last.orchestrator.proposed_luna_reply || '';
  if (/accommodation|under 7 nights|add-ons/i.test(reply)
    && !/follow up soon|passing this to our team/i.test(reply)) {
    pass('C6', 'short stay guidance not handoff');
  } else {
    fail('C6', `reply=${reply}`);
  }

  if (last.orchestrator.proposed_next_action !== 'collect_payment_choice'
    && last.orchestrator.hold_payment_draft_plan?.plan_status !== 'ready') {
    pass('C7', 'no booking write / payment choice yet');
  } else {
    fail('C7', `next=${last.orchestrator.proposed_next_action}`);
  }

  const dateTurn = turns[2];
  if (dateTurn.result.extracted_fields?.check_in && dateTurn.result.extracted_fields?.check_out) {
    pass('C8', 'July 1-5 extracts date range');
  } else {
    fail('C8', 'July 1-5 date parse failed');
  }

  section('D. Intro behavior');

  const helloReply = turns[0].orchestrator.proposed_luna_reply || '';
  if (/^Hey!/i.test(helloReply)) pass('D1', 'greeting uses Hey intro');
  else fail('D1', `greeting=${helloReply.slice(0, 60)}`);

  for (const t of turns.slice(1)) {
    if (!/^Hi! I'm Luna from Wolfhouse/i.test(t.orchestrator.proposed_luna_reply || '')) {
      pass('D2', `"${t.message_text}" reply has no repeated Hi intro`);
    } else {
      fail('D2', `"${t.message_text}" still has Hi intro`);
    }
  }

  section('E. Guest count 2 continuation (short stay)');

  const turns2 = await runTurns(['Yes I want to book a stay', 'July 1-5', '2']);
  const r2 = turns2[2].result;
  if (r2.extracted_fields?.guest_count === 2) pass('E1', '"2" extracts guest_count=2');
  else fail('E1', `guest_count=${r2.extracted_fields?.guest_count}`);

  section('E2. 7-night intake still asks package after guest count');

  const turns7 = await runTurns(['Yes I want to book a stay', 'July 10-17', '1']);
  const r7 = turns7[turns7.length - 1].result;
  const reply7 = turns7[turns7.length - 1].orchestrator.proposed_luna_reply || '';
  if (r7.package_night_rule === 'weekly_explain_before_choice'
    && /malibu|uluwatu|waimea/i.test(reply7)) {
    pass('E2', '7-night stay explains/asks package after guest count');
  } else {
    fail('E2', `rule=${r7.package_night_rule} reply=${reply7.slice(0, 80)}`);
  }

  section('F. Scope guard');

  if (!routerSrc.includes('create_stripe_test_link')
    && !orchSrc.includes('runGuestConfirmationSend')) {
    pass('F1', 'no Stripe/confirmation paths added');
  } else {
    fail('F1', 'forbidden paths touched');
  }

  if (isGreetingOnlyMessage('hello?') && buildGreetingMenuReply('en').includes('book a stay')) {
    pass('F2', 'greeting regression intact');
  } else {
    fail('F2', 'greeting regression');
  }

  console.log(`\n── Summary ──\n\nResults: ${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
