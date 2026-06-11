/**
 * Stage 48a — package-info intent during booking intake + conversation state continuity.
 *
 * Usage:
 *   node scripts/verify-stage48a-package-info-intent.js
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');
const { normalizeGuestContextForChain } = require('./lib/luna-guest-context-merge');
const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');

const REF = '2026-06-10';
const PHONE = '+34600480048';

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

const HANDOFF_RE = /looping in our Wolfhouse team|passing this to our team|hand off|handoff|staff will follow up/i;
const STRIPE_LINK_RE = /stripe link|checkout\.stripe/i;
const EXPLAIN_ASK_RE = /want me to explain them quickly|do you already know which one you prefer/i;
const WELCOME_MENU_RE = /book a stay|checking some info/i;

async function runTurn(message, prior) {
  const out = await runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo',
    channel: 'dry_run',
    message_text: message,
    guest_phone: PHONE,
    guest_context: prior || {},
    reference_date: REF,
  });
  const payload = {
    result: out.result,
    availability: out.availability,
    quote: out.quote,
    payment_choice: out.payment_choice,
    hold_payment_draft_plan: out.hold_payment_draft_plan,
    proposed_luna_reply: out.proposed_luna_reply,
  };
  const composed = composeLunaGuestReply({
    payload,
    message_text: message,
    prior_guest_context: prior || {},
    brain_decision: out.result && out.result.conversation_brain,
  });
  return {
    out,
    reply: (composed && composed.reply) || out.proposed_luna_reply || '',
    composerState: composed && composed.composer_state,
    ctx: normalizeGuestContextForChain({
      result: out.result,
      availability: out.availability,
      quote: out.quote,
      payment_choice: out.payment_choice,
      extracted_fields: out.result && out.result.extracted_fields,
    }),
  };
}

async function runFlow(messages) {
  let ctx = {};
  const turns = [];
  for (const message of messages) {
    const t = await runTurn(message, ctx);
    turns.push({ message, ...t });
    ctx = t.ctx;
  }
  return { turns, last: turns[turns.length - 1] };
}

function isHandoff(out) {
  const r = out && out.result;
  return !!(r && (r.safe_handoff_required || r.intake_state === 'staff_handoff_required'
    || (r.handoff_reasons && r.handoff_reasons.length)));
}

function replyHandoff(reply) {
  return HANDOFF_RE.test(String(reply || ''));
}

function fieldsOf(turn) {
  const r = turn.out && turn.out.result;
  return (r && r.extracted_fields) || {};
}

(async () => {
  console.log('\nverify-stage48a-package-info-intent.js  (Stage 48a)\n');

  section('A. Live regression — hello → book → dates → guests → package info');
  {
    const { turns, last } = await runFlow([
      'hello',
      'lets book a stay',
      'June 12-22',
      '3',
      'tell me more about the packages',
    ]);
    const first = turns[0];
    const fifth = last;

    check('A1', !isHandoff(fifth.out) && !replyHandoff(fifth.reply), 'no handoff on package-info turn');
    check('A2', fifth.out.hold_payment_draft_plan == null
      || fifth.out.hold_payment_draft_plan.ready_for_hold_draft !== true, 'no booking write');
    check('A3', fieldsOf(fifth).check_in === '2026-06-12', 'preserves check_in June 12');
    check('A4', fieldsOf(fifth).check_out === '2026-06-22', 'preserves check_out June 22');
    check('A5', fieldsOf(fifth).guest_count === 3, 'preserves guest_count=3');
    check('A6', /malibu/i.test(fifth.reply) && /uluwatu|waimea/i.test(fifth.reply),
      'explains Malibu/Uluwatu/Waimea');
    check('A7', !EXPLAIN_ASK_RE.test(fifth.reply), 'does not ask want me to explain');
    check('A8', /which one sounds best|want me to check malibu|malibu is probably/i.test(fifth.reply),
      'asks package preference next');
    check('A9', fifth.composerState === 'explain_packages', 'composer explain_packages state');
    check('A10', first.composerState === 'greeting' || WELCOME_MENU_RE.test(first.reply),
      'first hello is welcome (expected new thread)');
    const midWelcome = turns.slice(1, 4).some((t) => WELCOME_MENU_RE.test(t.reply));
    check('A11', !midWelcome, 'welcome menu does not repeat mid-thread');
    check('A12', fieldsOf(turns[2]).check_in === '2026-06-12', 'dates persist after turn 3');
    check('A13', fieldsOf(turns[3]).guest_count === 3, 'guest_count persists after turn 4');
  }

  section('B. Direct package info — what are the packages?');
  {
    const r = await runTurn('what are the packages?', {});
    check('B1', !isHandoff(r.out) && !replyHandoff(r.reply), 'no handoff');
    check('B2', /malibu/i.test(r.reply) && /uluwatu|waimea/i.test(r.reply),
      'explains packages');
    check('B3', r.composerState === 'explain_packages', 'explain_packages state');
  }

  section('C. Specific package — what is Malibu?');
  {
    const r = await runTurn('what is Malibu?', {});
    check('C1', !isHandoff(r.out) && !replyHandoff(r.reply), 'no handoff');
    check('C2', /malibu/i.test(r.reply) && /€249|7 night|shared kitchen/i.test(r.reply),
      'Malibu config details');
    check('C3', /want me to check malibu/i.test(r.reply), 'offers to check Malibu');
  }

  section('D. Package choice after explanation');
  {
    const { last: explained } = await runFlow([
      'lets book a stay',
      'June 12-22',
      '3',
      'tell me more about the packages',
    ]);
    const malibu = await runTurn('Malibu', explained.ctx);
    const f = fieldsOf(malibu);
    check('D1', f.check_in === '2026-06-12' && f.check_out === '2026-06-22', 'preserves dates');
    check('D2', f.guest_count === 3, 'preserves guest_count');
    check('D3', /malibu/i.test(String(f.package_interest || '')), 'captures Malibu choice');
    check('D4', !isHandoff(malibu.out) && !replyHandoff(malibu.reply), 'no handoff');
    check('D5', malibu.composerState === 'ask_guest_name'
      || /quote|€|deposit|availability|space|check malibu|guests|package/i.test(malibu.reply),
      'continues booking path toward quote');
  }

  section('E. Golden flow still works');
  {
    const quotedCtx = normalizeGuestContextForChain({
      message_lane: 'new_booking_inquiry',
      quote: {
        quote_status: 'ready',
        addons_pending_after_quote: false,
        payment_choice_needed: true,
        quote_total_cents: 69800,
        check_in: '2026-08-18',
        check_out: '2026-08-25',
        guest_count: 2,
        package_code: 'malibu',
        deposit_options: { deposit_required_cents: 20000, full_cents: 69800 },
      },
      availability: { availability_status: 'available', availability_check_attempted: true },
      result: {
        message_lane: 'new_booking_inquiry',
        package_night_rule: 'weekly_package',
        booking_intake_ready: true,
        extracted_fields: {
          check_in: '2026-08-18',
          check_out: '2026-08-25',
          guest_count: 2,
          package_interest: 'malibu',
          guest_name: 'Marco',
        },
      },
    });
    const deposit = await runTurn('Deposit is fine', quotedCtx);
    const pc = deposit.out.payment_choice || {};
    check('E1', !isHandoff(deposit.out), 'no handoff');
    check('E2', pc.payment_choice === 'deposit' || pc.payment_choice_ready === true,
      'deposit payment path');
    check('E3', !STRIPE_LINK_RE.test(deposit.reply || ''), 'no Stripe link wording');
  }

  section('F. Router — package info preserves intake (dry-run, no writes)');
  {
    const prior = normalizeGuestContextForChain({
      result: {
        message_lane: 'new_booking_inquiry',
        extracted_fields: { check_in: '2026-06-12', check_out: '2026-06-22', guest_count: 3 },
      },
    });
    const r = runLunaGuestMessageRouterDryRun(
      { message_text: 'tell me more about the packages', guest_context: prior },
      { reference_date: REF },
    );
    check('F1', r.extracted_fields.check_in === '2026-06-12', 'router preserves check_in');
    check('F2', r.extracted_fields.guest_count === 3, 'router preserves guest_count');
    check('F3', !r.safe_handoff_required, 'router no handoff');
    check('F4', /malibu|uluwatu|waimea/i.test(r.proposed_luna_reply || ''), 'router package explainer reply');
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
