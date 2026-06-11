/**
 * Stage 46c — relative/vague date intake + beginner package continuation.
 *
 * Usage:
 *   node scripts/verify-stage46c-relative-date-intake.js
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');
const { normalizeGuestContextForChain } = require('./lib/luna-guest-context-merge');
const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');

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
  console.log('\nverify-stage46c-relative-date-intake.js  (Stage 46c)\n');

  section('1. Vague month — Can I come in June?');
  {
    const r = await runTurn('Can I come in June?', {});
    check('1a', !isHandoff(r.out) && !replyHandoff(r.reply), 'no handoff');
    check('1b', /exact check-in and check-out dates in June/i.test(r.reply || ''), 'asks exact June dates');
    check('1c', !STRIPE_LINK_RE.test(r.reply || ''), 'no Stripe wording');
  }

  section('2. Vague month — Any beds free in August?');
  {
    const r = await runTurn('Any beds free in August?', {});
    check('2a', !isHandoff(r.out) && !replyHandoff(r.reply), 'no handoff');
    check('2b', /dates|check-in|check-out|August/i.test(r.reply || ''), 'asks dates in August');
  }

  section('3. Relative date — next weekend');
  {
    const r = await runTurn('next weekend', {});
    check('3a', !isHandoff(r.out) && !replyHandoff(r.reply), 'no handoff');
    check('3b', /exact check-in and check-out dates/i.test(r.reply || ''), 'asks exact dates');
  }

  section('4. Relative date — from Friday to Sunday');
  {
    const r = await runTurn('from Friday to Sunday', {});
    check('4a', !isHandoff(r.out) && !replyHandoff(r.reply), 'no handoff');
    check('4b', /exact check-in and check-out dates/i.test(r.reply || ''), 'asks exact dates');
  }

  section('5. Beginner package — dates already provided');
  {
    const { last } = await runFlow(['beginner surf package', 'August 1-8', '1 guest']);
    check('5a', !isHandoff(last.out) && !replyHandoff(last.reply), 'no handoff on final turn');
    check('5b', last.out.result.extracted_fields.guest_count === 1, 'guest_count=1');
    check('5c', !/what dates|check-in and check-out dates, and how many/i.test(last.reply || ''),
      'does not re-ask dates');
    check('5d', /package|guests|malibu|waimea|accommodation|quote|deposit|€/i.test(last.reply || ''),
      'continues to package/guest/quote step');
  }

  section('6. Exact regression — Hello → Book a stay → June 12 to 20th → 3 please');
  {
    const { last } = await runFlow(['Hello', 'Book a stay', 'June 12 to 20th', '3 please']);
    check('6a', !isHandoff(last.out) && !replyHandoff(last.reply), 'no handoff');
    check('6b', last.out.result.extracted_fields.guest_count === 3, 'guest_count=3');
    check('6c', /surf package|accommodation|malibu|package/i.test(last.reply || ''),
      'asks package/accommodation');
  }

  section('7. Golden Malibu booking still passes');
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
    check('7a', !isHandoff(deposit.out), 'no handoff');
    check('7b', pc.payment_choice === 'deposit' || pc.payment_choice_ready === true,
      'payment path ready');
    check('7c', !STRIPE_LINK_RE.test(deposit.reply || ''), 'no Stripe link guest wording');
  }

  section('8. Router dry-run — no write risk flags');
  {
    for (const [id, msg] of [
      ['8a', 'Can I come in June?'],
      ['8b', 'next weekend'],
    ]) {
      const r = runLunaGuestMessageRouterDryRun({ message_text: msg, guest_context: {} }, { reference_date: REF });
      check(`${id}-lane`, r.message_lane === 'new_booking_inquiry', `${msg} → booking lane`);
      check(`${id}-handoff`, !r.safe_handoff_required, `${msg} → no handoff`);
      check(`${id}-write`, r.write_ready !== true, `${msg} → no write ready`);
    }
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
