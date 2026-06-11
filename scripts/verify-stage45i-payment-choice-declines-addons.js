/**

 * Stage 45i / 45i.1 — payment choice first after quote; add-ons optional for packages.

 *

 * Usage:

 *   node scripts/verify-stage45i-payment-choice-declines-addons.js

 */



'use strict';



const path = require('path');



require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });



const {

  paymentChoiceDeclinesPendingAddons,

  guestDeclinedAddons,

  extractAddOnSelections,

  isAddonSideQuestion,

  addonsAnsweredThisTurn,

} = require('./lib/luna-booking-addons-policy');

const { detectPaymentChoiceFromMessage, runGuestPaymentChoiceDryRun, buildPaymentChoiceWireContext } = require('./lib/luna-guest-payment-choice-dry-run');

const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');

const { normalizeGuestContextForChain } = require('./lib/luna-guest-context-merge');

const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');

const { runGuestQuoteProposalDryRun } = require('./lib/luna-guest-quote-proposal-dry-run');



let passes = 0;

let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }

function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }

function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }

function section(t) { console.log(`\n── ${t} ──`); }



console.log('\nverify-stage45i-payment-choice-declines-addons.js  (Stage 45i.1)\n');



section('A. Policy rule (compatibility fallback)');

check('A1', paymentChoiceDeclinesPendingAddons('Deposit is fine'), 'deposit is fine declines pending add-ons');

check('A2', paymentChoiceDeclinesPendingAddons("I'll pay the deposit"), 'I\'ll pay the deposit declines add-ons');

check('A3', paymentChoiceDeclinesPendingAddons('pay deposit'), 'pay deposit declines add-ons');

check('A4', paymentChoiceDeclinesPendingAddons('pay in full'), 'pay in full declines add-ons');

check('A5', paymentChoiceDeclinesPendingAddons('full payment is fine'), 'full payment is fine declines add-ons');

check('A6', !paymentChoiceDeclinesPendingAddons('what about lessons?'), 'add-on side question not treated as decline');

check('A7', !paymentChoiceDeclinesPendingAddons('how much are rentals?'), 'rental side question not treated as decline');

check('A8', !paymentChoiceDeclinesPendingAddons('wetsuit and lessons'), 'explicit add-on request not skipped');

check('A9', !paymentChoiceDeclinesPendingAddons('maybe'), 'vague reply not payment-choice decline');

check('A10', guestDeclinedAddons('just the stay'), 'explicit just-the-stay still works');

check('A11', addonsAnsweredThisTurn('Deposit is fine', null, {}), 'addonsAnsweredThisTurn for deposit');



async function runTurn(message, prior, extra = {}) {

  const out = await runGuestAutomationOrchestratorDryRun({

    client_slug: 'wolfhouse-somo',

    channel: 'dry_run',

    message_text: message,

    guest_phone: '+34600995570',

    guest_context: prior || {},

    reference_date: '2026-06-08',

    ...extra,

  });

  return {

    out,

    reply: out.proposed_luna_reply,

    ctx: normalizeGuestContextForChain({

      result: out.result,

      availability: out.availability,

      quote: out.quote,

      payment_choice: out.payment_choice,

      extracted_fields: out.result && out.result.extracted_fields,

    }),

  };

}



function quotedMalibuCtx() {

  return {

    message_lane: 'new_booking_inquiry',

    quote: {

      quote_status: 'ready',

      addons_pending_after_quote: false,

      short_stay_addons_pending: false,

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

      extracted_fields: {

        check_in: '2026-08-18',

        check_out: '2026-08-25',

        guest_count: 2,

        package_interest: 'malibu',

      },

    },

  };

}



function legacyAddonsPendingCtx() {

  return {

    ...quotedMalibuCtx(),

    quote: {

      ...quotedMalibuCtx().quote,

      addons_pending_after_quote: true,

      payment_choice_needed: false,

    },

  };

}



function clearedWireCtx() {

  const prior = quotedMalibuCtx();

  return buildPaymentChoiceWireContext(

    prior,

    prior.result,

    prior.availability,

    prior.quote,

  );

}



(async () => {
  section('B. Quote flags + 3-turn deposit (quoted → deposit)');
  const mockRouter = {
    success: true,
    message_lane: 'new_booking_inquiry',
    booking_intake_ready: true,
    readiness_state: 'ready_for_availability_check',
    package_night_rule: 'weekly_package',
    detected_language: 'en',
    extracted_fields: {
      check_in: '2026-08-18',
      check_out: '2026-08-25',
      guest_count: 2,
      package_interest: 'malibu',
      guest_name: 'Marco',
    },
  };
  const mockAvail = { availability_check_attempted: true, availability_status: 'available' };
  const quoteOut = runGuestQuoteProposalDryRun(mockRouter, mockAvail, { client_slug: 'wolfhouse-somo' });
  check('B0', quoteOut.quote_status === 'ready', 'quote proposal ready for weekly Malibu');
  check('B0a', quoteOut.payment_choice_needed === true, 'payment_choice_needed true after package quote');
  check('B0b', quoteOut.addons_pending_after_quote !== true,
    'weekly package quote does not set addons_pending_after_quote');

  const t3 = await runTurn('Deposit is fine', quotedMalibuCtx());
  check('B1', t3.out.payment_choice && t3.out.payment_choice.payment_choice === 'deposit',
    'deposit payment choice detected on turn 3');
  check('B2', t3.out.payment_choice && t3.out.payment_choice.payment_choice_ready === true,
    'payment choice ready without add-on decline');
  check('B3', t3.out.payment_choice && t3.out.payment_choice.next_safe_step === 'ready_for_hold_payment_draft',
    'ready for hold/payment draft');
  check('B4', !(t3.out.quote && t3.out.quote.addons_pending_after_quote === true),
    'no add-on blocker after deposit');
  check('B5', !/stripe link/i.test(String(t3.reply || '')),
    'copy avoids Stripe link wording');

  section('C. 3-turn full payment (quoted → full payment)');
  const f3 = await runTurn("I'll pay in full", quotedMalibuCtx());
  check('C1', f3.out.payment_choice && f3.out.payment_choice.payment_choice === 'full_payment',
    'full payment detected on turn 3');
  check('C2', f3.out.payment_choice && f3.out.payment_choice.payment_choice_ready === true,
    'full payment choice ready');
  check('C3', f3.out.payment_choice && f3.out.payment_choice.next_safe_step === 'ready_for_hold_payment_draft',
    'full payment ready for hold/payment draft');

  section('D. Quote copy — payment first, add-ons optional/later');
  const composed = composeLunaGuestReply({
    payload: {
      client_slug: 'wolfhouse-somo',
      result: quotedMalibuCtx().result,
      availability: quotedMalibuCtx().availability,
      quote: quotedMalibuCtx().quote,
    },
  });
  const quoteReply = composed && composed.reply ? composed.reply : String(composed || '');
  check('D1', /deposit|full/i.test(quoteReply), 'quote asks deposit or full payment');
  check('D2', /which do you prefer|deposit|full/i.test(quoteReply),
    'quote leads with deposit vs full payment choice');
  check('D3', !/just the stay/i.test(quoteReply),
    'does not force just-the-stay wording');
  check('D4', !/stripe link/i.test(quoteReply),
    'quote copy avoids Stripe link');

  const camiHosted = composeLunaGuestReply({
    payload: {
      client_slug: 'wolfhouse-somo',
      prior_guest_context: { guest_phone: '+34600995563', cami_variation_history: { turn_count: 1 } },
      result: quotedMalibuCtx().result,
      availability: quotedMalibuCtx().availability,
      quote: quotedMalibuCtx().quote,
    },
    guest_phone: '+34600995563',
  });
  const camiReply = camiHosted && camiHosted.reply ? camiHosted.reply : '';
  check('D5', /deposit|full/i.test(camiReply), 'Cami package quote asks deposit or full');
  check('D6', /which do you prefer|deposit|full/i.test(camiReply),
    'Cami package quote leads with deposit vs full payment choice');
  check('D7', !/just the stay/i.test(camiReply), 'Cami package quote does not force just-the-stay');
  check('D8', !/stripe link/i.test(camiReply), 'Cami package quote avoids Stripe link');

  section('E. Explicit add-on request stays safe');
  const addonTurn = await runTurn('Can we add surf lessons?', quotedMalibuCtx());
  check('E1', extractAddOnSelections('Can we add surf lessons?').length >= 1
    || isAddonSideQuestion('Can we add surf lessons?'),
    'surf lessons parsed or treated as add-on side question');
  check('E2', !(addonTurn.out.payment_choice && addonTurn.out.payment_choice.payment_choice_ready),
    'add-on request does not jump to payment choice ready');
  check('E3', detectPaymentChoiceFromMessage('Can we add surf lessons?') == null,
    'add-on question not mistaken for payment choice');

  section('F. 4-turn just-the-stay + deposit still works');
  let ctx4 = quotedMalibuCtx();
  ctx4 = (await runTurn('just the stay', ctx4)).ctx;
  const pc4 = runGuestPaymentChoiceDryRun({ message_text: 'Deposit is fine' }, buildPaymentChoiceWireContext(
    ctx4,
    ctx4.result || quotedMalibuCtx().result,
    quotedMalibuCtx().availability,
    quotedMalibuCtx().quote,
  ));
  check('F1', pc4.payment_choice_ready === true,
    '4-turn deposit still ready after explicit just-the-stay');

  section('G. Legacy compatibility — deposit clears stale addons_pending flag');
  const legacyDeposit = await runTurn('Deposit is fine', legacyAddonsPendingCtx());
  check('G1', legacyDeposit.out.quote && legacyDeposit.out.quote.addons_pending_after_quote === false,
    'orchestrator deposit clears legacy addons_pending_after_quote');
  check('G2', legacyDeposit.out.result.extracted_fields.addons_skipped === true,
    'orchestrator deposit sets addons_skipped on legacy context');
  const pcLegacy = runGuestPaymentChoiceDryRun({ message_text: 'Deposit is fine' }, buildPaymentChoiceWireContext(
    legacyAddonsPendingCtx(),
    legacyAddonsPendingCtx().result,
    legacyAddonsPendingCtx().availability,
    { ...legacyAddonsPendingCtx().quote, addons_pending_after_quote: false, payment_choice_needed: true },
  ));
  check('G3', pcLegacy.payment_choice_ready === true,
    'legacy cleared wire context payment choice ready');

  console.log(`\n── Summary ──\n\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});


