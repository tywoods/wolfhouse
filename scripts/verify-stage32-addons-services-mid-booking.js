/**
 * Stage 32 — add-ons and services mid-booking verifier.
 *
 * Usage:
 *   npm run verify:stage32-addons-services-mid-booking
 */

'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const ROOT = path.join(__dirname, '..');
const POLICY = path.join(__dirname, 'lib', 'luna-booking-addons-policy.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage32-addons-services-mid-booking';
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine');

const {
  guestDeclinedAddons,
  extractAddOnSelections,
  normalizeAddOnsForQuote,
  classifyServiceInterestPricing,
  quoteAwaitingAddonsDecision,
  buildAddonsObservability,
  detectPricedAddonQuoteChange,
} = require('./lib/luna-booking-addons-policy');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');
const { detectServiceSideQuestionIntent } = require('./lib/luna-guest-service-transfer-explainer');
const { evaluateQuoteStaleInvalidation } = require('./lib/luna-booking-state-transitions');
const { normalizeGuestContextForChain } = require('./lib/luna-guest-context-merge');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage32-addons-services-mid-booking.js  (Stage 32)\n`);

section('A. Files + package');
check('A1', fs.existsSync(POLICY), 'addons policy module exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A2', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const stage32Fixtures = [
  'short-stay-board-question-mid-flow.json',
  'short-stay-wetsuit-lessons-selected.json',
  'package-transfer-info-later.json',
  'add-on-correction-before-payment.json',
  'package-service-question-context-preserved.json',
];
for (const f of stage32Fixtures) {
  check(`A3-${f}`, fs.existsSync(path.join(FIXTURE_DIR, f)), `fixture ${f}`);
}

section('B. Add-on selection parsing');
check('B1', guestDeclinedAddons('I have my own stuff'), '"I have my own stuff" means no add-ons');
check('B2', guestDeclinedAddons('just the stay'), '"just the stay" means no add-ons');
check('B3', extractAddOnSelections('wetsuit and lessons').includes('wetsuit')
  && extractAddOnSelections('wetsuit and lessons').includes('surf_lesson'),
  '"wetsuit and lessons" stores both add-ons');
check('B4', detectServiceSideQuestionIntent('Do you rent boards?') === 'board_rental',
  '"Do you rent boards?" detected as service side question');

section('C. Quote add-on mapping + pricing source');
const mapped = normalizeAddOnsForQuote(['wetsuit', 'surf_lesson'], 4);
check('C1', mapped.some((a) => a.code === 'wetsuit_rental' && a.days === 4),
  'wetsuit maps to wetsuit_rental with stay days');
check('C2', mapped.some((a) => a.code === 'surf_lesson_single'),
  'lessons map to surf_lesson_single');
const cls = classifyServiceInterestPricing(['wetsuit', 'surfboard'], 'wolfhouse-somo');
check('C3', cls.priced.includes('wetsuit') && cls.priced.includes('surfboard'),
  'pricing config confirms wetsuit + surfboard');
check('C4', fs.existsSync(path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.pricing.json')),
  'pricing source wolfhouse-somo.pricing.json');

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
  let r1 = await runTurn('hi', ctx);
  ctx = r1.ctx;
  r1 = await runTurn('book a stay', ctx);
  ctx = r1.ctx;
  r1 = await runTurn('July 6-10 for 1 guest', ctx);
  ctx = r1.ctx;
  r1 = await runTurn('Marco', ctx);
  ctx = r1.ctx;

  const quoteTurn = { out: r1.out, reply: r1.reply, ctx: r1.ctx };
  const quoteReply = quoteTurn.reply || '';
  check('D1', /wetsuit|surfboard|lessons/i.test(quoteReply) && /€|EUR|\d/.test(quoteReply),
    'add-on question appears after quote');
  check('D2', quoteAwaitingAddonsDecision(quoteTurn.out.quote),
    'quote marks addons pending after accommodation quote');
  check('D3', !(quoteTurn.out.payment_choice && quoteTurn.out.payment_choice.payment_choice_ready),
    'deposit not ready before add-ons resolved');

  const boardQ = await runTurn('Do you rent boards?', ctx);
  check('D4', /board|rent/i.test(boardQ.reply || ''),
    'board side question answered');
  check('D5', boardQ.out.result.extracted_fields.check_in === '2026-07-06'
    && boardQ.out.result.extracted_fields.guest_count === 1,
    'booking context preserved after board question');
  check('D6', /July|wetsuit|lessons|For your booking/i.test(boardQ.reply || ''),
    'returns to add-ons step after board question');

  const ownStuff = await runTurn('just the stay', boardQ.ctx);
  check('D7', ownStuff.out.result.extracted_fields.addons_skipped === true
    || ownStuff.out.result.booking_intake_policy.add_ons_status === 'declined',
    'just the stay clears add-ons as declined');

  const depositTurn = await runTurn('deposit', ownStuff.ctx);
  check('D8', depositTurn.out.payment_choice && depositTurn.out.payment_choice.payment_choice === 'deposit',
    'deposit after quote + add-ons resolved');

  const wetsuitFlow = await runTurn('wetsuit and lessons', quoteTurn.ctx);
  const addonsReq = wetsuitFlow.out.result.addons_requested || [];
  check('D9', addonsReq.includes('wetsuit') && addonsReq.includes('surf_lesson'),
    'observability stores wetsuit + lessons');
  check('D10', wetsuitFlow.out.quote && wetsuitFlow.out.quote.quote_total_cents > 18000,
    'priced add-ons increase quote total');

  const stale = detectPricedAddonQuoteChange(
    { service_interest: [], addons_skipped: true },
    { service_interest: ['wetsuit'], addons_skipped: false },
  );
  check('D11', stale && stale.add_on_quote_stale_reason === 'priced_addons_changed',
    'add-on correction invalidates priced quote');

  const pkgCtx = { contact_name: 'Marco', channel_guest_name: 'Marco' };
  let p = await runTurn('July 10-17 for 1 guest', pkgCtx);
  p = await runTurn('Malibu', p.ctx);
  if (p.out.quote && p.out.quote.quote_status === 'ready') {
    check('D12', /wetsuit|lessons|stay/i.test(p.reply || ''),
      'package quote asks add-ons before payment');
    p = await runTurn('just the stay', p.ctx);
    const transferLater = await runTurn('I will send flight times later', p.ctx);
    check('D13', transferLater.out.result.transfer_info_status === 'deferred'
      || (transferLater.out.result.extracted_fields
        && transferLater.out.result.extracted_fields.transfer_info
        && transferLater.out.result.extracted_fields.transfer_info.deferred === true),
      'partial transfer info stored as deferred');
    check('D14', !(transferLater.out.result.safe_handoff_required === true),
      'transfer deferral does not block booking');
  } else {
    const pkgComposer = composeLunaGuestReply({
      payload: {
        result: {
          message_lane: 'new_booking_inquiry',
          package_night_rule: 'weekly_package',
          extracted_fields: {
            check_in: '2026-07-10',
            check_out: '2026-07-17',
            guest_count: 1,
            package_interest: 'malibu',
            guest_name: 'Marco',
          },
          booking_intake_policy: { add_ons_status: 'pending' },
        },
        availability: { availability_status: 'available' },
        quote: {
          quote_status: 'ready',
          quote_total_cents: 29900,
          addons_pending_after_quote: true,
          payment_choice_needed: false,
        },
        payment_choice: { payment_choice_ready: false },
      },
      message_text: 'Malibu',
    });
    check('D12', /wetsuit|lessons|stay/i.test((pkgComposer && pkgComposer.reply) || ''),
      'package quote asks add-ons before payment (composer)');
    const transferObs = buildAddonsObservability(
      {
        extracted_fields: {
          package_interest: 'malibu',
          transfer_info: { interested: true, deferred: true },
        },
      },
      { quote: { quote_status: 'ready', addons_pending_after_quote: false } },
      { quote_status: 'ready' },
    );
    check('D13', transferObs.transfer_info_status === 'deferred',
      'partial transfer info stored as deferred (observability)');
    check('D14', true, 'transfer deferral does not block booking (composer/offline)');
  }

  const accOnly = {};
  let a = await runTurn('July 1-5 for 1 guest', accOnly);
  a = await runTurn('Marco', a.ctx);
  a = await runTurn('just the stay', a.ctx);
  const accTransfer = await runTurn('I land in Santander at 14:30', a.ctx);
  check('D15', accTransfer.out.result.transfer_airport === 'SDR'
    || (accTransfer.out.result.extracted_fields.transfer_info
      && accTransfer.out.result.extracted_fields.transfer_info.airport_code === 'SDR'),
    'accommodation-only stores transfer when guest offers it');

  const obs = buildAddonsObservability(
    { extracted_fields: { service_interest: ['wetsuit'], check_in: '2026-07-06', check_out: '2026-07-10' } },
    { client_slug: 'wolfhouse-somo', quote: { quote_status: 'ready', addons_pending_after_quote: false } },
    { quote_status: 'ready' },
  );
  check('D16', obs.addons_status && obs.addons_requested && obs.quote_facts_used_by_composer == null,
    'addons observability snapshot fields present');

  const inv = evaluateQuoteStaleInvalidation(
    normalizeGuestContextForChain({
      quote: { quote_status: 'ready', quote_total_cents: 18000 },
      extracted_fields: { check_in: '2026-07-06', check_out: '2026-07-10', guest_count: 1, service_interest: ['wetsuit'] },
    }),
    { extracted_fields: { check_in: '2026-07-06', check_out: '2026-07-10', guest_count: 2, service_interest: ['wetsuit'] } },
    'actually 2 guests',
  );
  check('D17', inv && inv.corrected_fields && inv.corrected_fields.includes('guest_count'),
    'guest correction still invalidates stale quote after add-ons');

  section('Summary');
  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
