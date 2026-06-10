/**
 * Stage 31a — messy conversation intelligence verifier.
 *
 * Usage:
 *   npm run verify:stage31a-messy-conversation-intelligence
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const ROOT = path.join(__dirname, '..');
const TRANSITIONS = path.join(__dirname, 'lib', 'luna-booking-state-transitions.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const MERGE = path.join(__dirname, 'lib', 'luna-guest-context-merge.js');
const PC = path.join(__dirname, 'lib', 'luna-guest-payment-choice-dry-run.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const RUNNER = path.join(__dirname, 'run-luna-conversation-state-machine-tests.js');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage31a-messy-conversation-intelligence';

const {
  evaluateQuoteStaleInvalidation,
  applyQuoteStaleInvalidation,
  detectFieldCorrectionIntent,
  detectQuoteAffectingFieldChanges,
  shouldPreservePriorReadyQuote,
} = require('./lib/luna-booking-state-transitions');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { detectNewBookingResetIntent: routerReset } = require('./lib/luna-guest-message-router');
const { buildPaymentChoiceWireContext } = require('./lib/luna-guest-payment-choice-dry-run');
const { isForbiddenGuestCopy } = require('./lib/luna-guest-reply-style-contract');
const { withPgClient } = require('./lib/pg-connect');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage31a-messy-conversation-intelligence.js  (Stage 31a)\n`);

section('A. Files + package');

check('A1', fs.existsSync(TRANSITIONS), 'state transitions module exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A2', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const orchSrc = fs.readFileSync(ORCH, 'utf8');
const mergeSrc = fs.readFileSync(MERGE, 'utf8');
const pcSrc = fs.readFileSync(PC, 'utf8');
const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const runnerSrc = fs.readFileSync(RUNNER, 'utf8');

const fixtureIds = [
  'package-switch-before-payment',
  'date-correction-before-payment',
  'guest-count-correction-before-payment',
  'reset-after-quote',
  'cash-side-question-payment-context',
];
for (const id of fixtureIds) {
  check('A3', fs.existsSync(path.join(FIXTURE_DIR, `${id}.json`)), `fixture ${id}`);
}

section('B. Wiring');

check('B1', orchSrc.includes('evaluateQuoteStaleInvalidation'), 'orchestrator evaluates stale quotes');
check('B2', orchSrc.includes('applyQuoteStaleInvalidation'), 'orchestrator applies stale invalidation');
check('B3', pcSrc.includes('shouldPreservePriorReadyQuote'), 'payment choice respects stale flag');
check('B4', mergeSrc.includes('previous_quote_invalidated'), 'merge preserves stale guard');
check('B5', runnerSrc.includes('expected_stale_quote'), 'tester stale quote expectation');
check('B6', runnerSrc.includes('expected_reset_detected'), 'tester reset expectation');

section('C. Reset vs correction intent');

check('C1', routerReset('no no I want to create another booking'), 'reset phrase detected');
check('C2', routerReset('start over'), 'start over detected');
check('C3', !routerReset('actually make it Uluwatu'), 'package correction is not reset');
check('C4', detectFieldCorrectionIntent('actually make it Uluwatu'), 'package correction detected');
check('C5', detectFieldCorrectionIntent('actually July 2-6'), 'date correction detected');
check('C6', detectFieldCorrectionIntent('actually we are 2'), 'guest count correction detected');
check('C7', !detectFieldCorrectionIntent('can I pay cash?'), 'cash question not correction');

section('D. Stale quote invalidation unit');

const priorCtx = {
  quote: { quote_status: 'ready', quote_total_cents: 59800, payment_choice_needed: true },
  extracted_fields: { package_interest: 'malibu', guest_count: 2, check_in: '2026-07-10', check_out: '2026-07-17' },
  result: { extracted_fields: { package_interest: 'malibu', guest_count: 2, check_in: '2026-07-10', check_out: '2026-07-17' } },
};
const pkgInv = evaluateQuoteStaleInvalidation(priorCtx, {
  extracted_fields: { package_interest: 'uluwatu', guest_count: 2, check_in: '2026-07-10', check_out: '2026-07-17' },
}, 'actually make it Uluwatu');
check('D1', pkgInv && pkgInv.stale_quote_reason === 'package_changed', 'package switch invalidates quote');
check('D2', !evaluateQuoteStaleInvalidation(priorCtx, priorCtx.result, 'can I pay cash?'), 'cash side question preserves quote');

const dateInv = evaluateQuoteStaleInvalidation({
  quote: { quote_status: 'ready', quote_total_cents: 18000 },
  result: { extracted_fields: { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1 } },
}, {
  extracted_fields: { check_in: '2026-07-02', check_out: '2026-07-06', guest_count: 1 },
}, 'actually July 2-6');
check('D3', dateInv && dateInv.corrected_fields.includes('check_in'), 'date correction marks stale');

const stripped = applyQuoteStaleInvalidation(priorCtx, pkgInv);
check('D4', stripped.quote.quote_status === 'not_ready' && stripped.quote.quote_stale === true, 'stale quote cleared');
check('D5', !shouldPreservePriorReadyQuote(stripped), 'stale chain blocks prior quote reuse');

const wire = buildPaymentChoiceWireContext(stripped, { message_lane: 'new_booking_inquiry' }, {}, { quote_status: 'not_ready' });
check('D6', wire.quote.quote_status === 'not_ready', 'wire context does not resurrect stale quote');

section('E. Orchestrator flows');

(async () => {
  function ctxFrom(out) {
    return {
      message_lane: out.result && out.result.message_lane,
      extracted_fields: out.result && out.result.extracted_fields,
      quote: out.quote,
      payment_choice: out.payment_choice,
      availability: out.availability,
      result: { ...(out.result || {}), proposed_luna_reply: out.proposed_luna_reply },
      previous_quote_invalidated: out.result && out.result.previous_quote_invalidated,
      stale_quote_reason: out.result && out.result.stale_quote_reason,
      corrected_fields: out.result && out.result.corrected_fields,
      new_booking_reset: out.result && out.result.new_booking_reset,
      contact_name: 'Marco',
      whatsapp_guest_name: 'Marco',
    };
  }

  async function turn(ctx, message_text) {
    const out = await withPgClient((pg) => runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      message_text,
      guest_phone: '+491726422307',
      guest_name: 'Marco',
      contact_name: 'Marco',
      guest_context: ctx,
      reference_date: '2026-06-10',
    }, {
      reference_date: '2026-06-10',
      pg,
      guest_name: 'Marco',
      contact_name: 'Marco',
    }));
    if (!out || !out.result) throw new Error(`orchestrator returned empty for "${message_text}"`);
    return { out, ctx: ctxFrom(out) };
  }

  let ctx = {};
  let t1;
  ({ out: t1, ctx } = await turn(ctx, 'Malibu July 10 to July 17 for 2'));
  check('E1', t1.quote && t1.quote.quote_status === 'ready', 'malibu quote ready');
  let t2;
  ({ out: t2, ctx } = await turn(ctx, 'actually make it Uluwatu'));
  check('E2', t2.result.previous_quote_invalidated === true, 'package switch marks stale');
  check('E3', t2.quote && t2.quote.quote_status === 'ready' && t2.quote.package_code === 'uluwatu', 'uluwatu re-quote');
  check('E4', t2.quote.quote_total_cents !== t1.quote.quote_total_cents, 'quote total changed after package switch');

  ctx = {};
  ({ ctx } = await turn(ctx, 'book a stay'));
  ({ ctx } = await turn(ctx, 'July 1-5'));
  ({ ctx } = await turn(ctx, '1'));
  const gc1 = (await turn(ctx, 'actually we are 2')).out;
  check('E5', gc1.result.previous_quote_invalidated === true, 'guest count correction stale');
  check('E6', gc1.result.extracted_fields.guest_count === 2, 'guest count updated');
  check('E7', gc1.quote.quote_total_cents === 36000, 're-quote for 2 guests');

  ctx = {};
  ({ ctx } = await turn(ctx, 'Malibu July 10 to July 17 for 2'));
  const reset = (await turn(ctx, 'no no I want to create another booking')).out;
  check('E8', reset.result.new_booking_reset === true, 'reset detected after quote');
  check('E9', reset.quote.quote_status === 'not_ready', 'quote cleared on reset');

  ctx = {};
  ({ ctx } = await turn(ctx, 'July 1-5 for 1 guest'));
  ({ ctx } = await turn(ctx, 'no thanks, I have my own stuff'));
  const cash = (await turn(ctx, 'can I pay cash?')).out;
  check('E10', !cash.result.previous_quote_invalidated, 'cash question does not invalidate quote');
  check('E11', cash.quote.quote_status === 'ready', 'quote preserved through cash question');
  const cashReply = String(cash.proposed_luna_reply || '');
  check('E12', /cash|arrival|bank transfer/i.test(cashReply), 'cash question answered');
  check('E13', !isForbiddenGuestCopy(cashReply), 'cash reply natural');

  section('F. Mid-flow greeting does not reset');

  ctx = {};
  ({ ctx } = await turn(ctx, 'July 1-5 for 1'));
  const hi = (await turn(ctx, 'hi')).out;
  check('F1', !hi.result.new_booking_reset, 'hi mid-flow does not reset');
  check('F2', hi.result.extracted_fields && hi.result.extracted_fields.check_in === '2026-07-01', 'dates preserved after hi');

  section('G. Safety');

  check('G1', !orchSrc.includes('sendWhatsApp') && !orchSrc.includes('send_whatsapp'), 'no WhatsApp send');
  check('G2', !orchSrc.match(/\bactivate.*n8n\b/i), 'no n8n activation');
  check('G3', !orchSrc.includes('stripe.checkout.sessions.create'), 'no Stripe creation in orchestrator');
  check('G4', !orchSrc.match(/deploy.*production/i), 'no production deploy hooks');

  section('Summary');
  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
