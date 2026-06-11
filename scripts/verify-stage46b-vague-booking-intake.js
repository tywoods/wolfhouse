/**
 * Stage 46b — vague booking intake: guest-count order, continuation parsing, no false handoffs.
 *
 * Usage:
 *   node scripts/verify-stage46b-vague-booking-intake.js
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');
const { normalizeGuestContextForChain } = require('./lib/luna-guest-context-merge');
const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');
const { quoteAwaitingAddonsDecision } = require('./lib/luna-booking-addons-policy');

const REF = '2026-06-10';
const PHONE = '+34600460001';

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

const HANDOFF_RE = /looping in our Wolfhouse team|passing this to our team|hand off|handoff|staff will follow up/i;
const STRIPE_LINK_RE = /stripe link|checkout\.stripe/i;

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

(async () => {
  console.log('\nverify-stage46b-vague-booking-intake.js  (Stage 46b)\n');

  section('A. Exact regression — Hello → Book a stay → dates → 3 please');
  {
    const { turns, last } = await runFlow(['Hello', 'Book a stay', 'June 12 to 20th', '3 please']);
    const t2 = turns[1];
    const t3 = turns[2];
    const t4 = last;
    check('A1', !isHandoff(t4.out) && !replyHandoff(t4.reply), 'turn 4 no handoff');
    check('A2', t4.out.result.extracted_fields.guest_count === 3, 'guest_count=3 after 3 please');
    check('A3', /how many guests|guests will be staying/i.test(t3.reply || ''),
      'turn 3 asks guest count (not name)');
    check('A4', /surf package|accommodation|malibu|package/i.test(t4.reply || ''),
      'turn 4 asks package/accommodation or next booking step');
    check('A5', !STRIPE_LINK_RE.test(t4.reply || ''), 'no Stripe link wording');
  }

  section('B. No-hello variant — book a stay → june 12-20 → 3');
  {
    const { turns, last } = await runFlow(['book a stay', 'june 12-20', '3']);
    check('B1', !isHandoff(last.out) && !replyHandoff(last.reply), 'no handoff');
    check('B2', last.out.result.extracted_fields.guest_count === 3, 'guest_count parsed');
    check('B3', !/what name|your name|grab your name/i.test(last.reply || ''),
      'no repeat what name after count');
  }

  section('C. Count-only continuation — dates → for two');
  {
    const prep = await runFlow(['Book a stay', 'June 12 to 20']);
    const t = await runTurn('for two', prep.last.ctx);
    check('C1', t.out.result.extracted_fields.guest_count === 2, 'guest_count=2 from for two');
    check('C2', !isHandoff(t.out), 'no handoff');
  }

  section('D. Vague openers — no handoff, asks dates or narrowing');
  {
    for (const [id, msg] of [
      ['D1', 'Do you have space?'],
      ['D2', 'Need a room'],
      ['D3', 'Any beds free in August?'],
    ]) {
      const r = await runLunaGuestMessageRouterDryRun(
        { message_text: msg, guest_context: {} },
        { reference_date: REF },
      );
      check(`${id}a`, r.message_lane === 'new_booking_inquiry', `${msg} → new_booking_inquiry`);
      check(`${id}b`, !r.safe_handoff_required, `${msg} → no handoff`);
      check(`${id}c`, /\?/.test(r.proposed_luna_reply || '') || /dates|when|package|stay|guests/i.test(r.proposed_luna_reply || ''),
        `${msg} → asks next question`);
    }
  }

  section('E. Malibu package flow still passes');
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
      'payment path ready after deposit');
    check('E3', !STRIPE_LINK_RE.test(deposit.reply || ''), 'no Stripe link guest wording');
  }

  section('F. Add-on flow still safe');
  {
    const prep = await runFlow([
      'Malibu package for 2',
      'August 18 to August 25',
    ]);
    const addon = await runTurn('Can we add surf lessons?', prep.last.ctx);
    check('F1', !isHandoff(addon.out), 'no handoff on add-on ask');
    check('F2', quoteAwaitingAddonsDecision(addon.out.quote)
      || /lesson|add.?on|wetsuit|surf/i.test(addon.reply || ''),
      'add-ons handled');
    check('F3', !(addon.out.payment_choice && addon.out.payment_choice.payment_choice_ready === true),
      'no accidental payment-ready before add-ons resolved');
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
