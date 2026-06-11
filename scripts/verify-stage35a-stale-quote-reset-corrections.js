/**
 * Stage 35a — stale quote, correction, and reset handling verifier.
 *
 * Usage:
 *   npm run verify:stage35a-stale-quote-reset-corrections
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const ROOT = path.join(__dirname, '..');
const TRANSITIONS = path.join(__dirname, 'lib', 'luna-booking-state-transitions.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const ADDONS = path.join(__dirname, 'lib', 'luna-booking-addons-policy.js');
const PC = path.join(__dirname, 'lib', 'luna-guest-payment-choice-dry-run.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const PLANNER = path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-planner.js');
const RUNNER = path.join(__dirname, 'run-luna-conversation-state-machine-tests.js');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage35a-stale-quote-reset-corrections';

const {
  evaluateQuoteStaleInvalidation,
  applyQuoteStaleInvalidation,
  detectFieldCorrectionIntent,
  quoteChainIsStale,
  shouldPreservePriorReadyQuote,
  stalePaymentLinkBlocked,
  normalizeStaleQuoteReason,
} = require('./lib/luna-booking-state-transitions');
const { detectPricedAddonQuoteChange } = require('./lib/luna-booking-addons-policy');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { detectNewBookingResetIntent } = require('./lib/luna-guest-message-router');
const { buildPaymentChoiceWireContext } = require('./lib/luna-guest-payment-choice-dry-run');
const { isForbiddenGuestCopy } = require('./lib/luna-guest-reply-style-contract');
const { withPgClient } = require('./lib/pg-connect');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage35a-stale-quote-reset-corrections.js  (Stage 35a)\n`);

section('A. Files + package');

check('A1', fs.existsSync(TRANSITIONS), 'state transitions module exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A2', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const orchSrc = fs.readFileSync(ORCH, 'utf8');
const addonsSrc = fs.readFileSync(ADDONS, 'utf8');
const pcSrc = fs.readFileSync(PC, 'utf8');
const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
const plannerSrc = fs.readFileSync(PLANNER, 'utf8');
const runnerSrc = fs.readFileSync(RUNNER, 'utf8');

const fixtureIds = [
  'date-correction-before-payment',
  'guest-count-correction-before-payment',
  'package-switch-before-payment',
  'reset-after-quote',
  'cash-side-question-payment-context',
];
for (const id of fixtureIds) {
  check('A3', fs.existsSync(path.join(FIXTURE_DIR, `${id}.json`)), `fixture ${id}`);
}

section('B. Wiring + stale helpers');

check('B1', orchSrc.includes('evaluateQuoteStaleInvalidation'), 'orchestrator evaluates stale quotes');
check('B2', orchSrc.includes('applyQuoteStaleInvalidation'), 'orchestrator applies stale invalidation');
check('B3', pcSrc.includes('stalePaymentLinkBlocked'), 'payment choice blocks stale quote');
check('B4', plannerSrc.includes('stalePaymentLinkBlocked'), 'hold planner blocks stale quote');
check('B5', runnerSrc.includes('expected_stale_quote_reason'), 'tester stale reason expectation');
check('B6', runnerSrc.includes('expected_reset_detected'), 'tester reset expectation');
check('B7', normalizeStaleQuoteReason(['check_in', 'check_out'], false) === 'dates_changed', 'dates_changed reason');
check('B8', normalizeStaleQuoteReason(['guest_count'], false) === 'guest_count_changed', 'guest_count_changed reason');
check('B9', normalizeStaleQuoteReason(['package_interest'], true) === 'package_changed', 'package_changed reason');

section('C. Add-ons skip must not stale quote');

check('C1', !detectPricedAddonQuoteChange(
  { service_interest: [], addons_skipped: null },
  { service_interest: [], addons_skipped: true },
), 'declining add-ons does not invalidate quote');

section('D. Reset vs correction intent');

check('D1', detectNewBookingResetIntent('no no, start over'), 'start over detected');
check('D2', detectNewBookingResetIntent('no no I want to create another booking'), 'another booking reset detected');
check('D3', !detectNewBookingResetIntent('actually make it Uluwatu'), 'package correction is not reset');
check('D4', detectFieldCorrectionIntent('actually July 2-6'), 'date correction detected');
check('D5', !detectFieldCorrectionIntent('can I pay cash?'), 'cash question not correction');
check('D6', routerSrc.includes('arrival_payment_question'), 'router handles cash-on-arrival in active quote');

section('E. Stale invalidation unit');

const priorCtx = {
  quote: { quote_status: 'ready', quote_total_cents: 59800, payment_choice_needed: true },
  result: { extracted_fields: { package_interest: 'malibu', guest_count: 2, check_in: '2026-07-10', check_out: '2026-07-17' } },
};
const pkgInv = evaluateQuoteStaleInvalidation(priorCtx, {
  extracted_fields: { package_interest: 'uluwatu', guest_count: 2, check_in: '2026-07-10', check_out: '2026-07-17' },
}, 'actually make it Uluwatu');
check('E1', pkgInv && pkgInv.stale_quote_reason === 'package_changed', 'package switch invalidates quote');
check('E2', !evaluateQuoteStaleInvalidation(priorCtx, priorCtx.result, 'can I pay cash?'), 'cash side question preserves quote');

const stripped = applyQuoteStaleInvalidation(priorCtx, pkgInv);
check('E3', stripped.quote.quote_status === 'not_ready' && stripped.quote.quote_stale === true, 'stale quote cleared');
check('E4', stalePaymentLinkBlocked(stripped), 'stale chain blocks payment link');
check('E5', !shouldPreservePriorReadyQuote(stripped), 'stale chain blocks prior quote reuse');

const wire = buildPaymentChoiceWireContext(stripped, { message_lane: 'new_booking_inquiry' }, {}, { quote_status: 'not_ready' });
check('E6', wire.quote.quote_status === 'not_ready', 'wire context does not resurrect stale quote');

section('F. Composer correction copy');

check('F1', composerSrc.includes('buildDateCorrectionPaymentReply'), 'composer date correction payment reply');
check('F2', composerSrc.includes('isDateCorrection'), 'composer date correction detection');

section('G. Safety');

check('G1', !orchSrc.includes('sendWhatsApp') && !orchSrc.includes('send_whatsapp'), 'no WhatsApp send');
check('G2', !orchSrc.match(/\bactivate.*n8n\b/i), 'no n8n activation');
check('G3', !orchSrc.includes('stripe.checkout.sessions.create'), 'no Stripe creation in orchestrator');
check('G4', !addonsSrc.match(/\bdeploy.*production/i), 'no production deploy hooks');

section('H. Orchestrator flows');

(async () => {
  function ctxFrom(out) {
    const r = out || {};
    return {
      message_lane: r.result && r.result.message_lane,
      intake_state: r.result && r.result.intake_state,
      readiness_state: r.result && r.result.readiness_state,
      booking_intake_ready: r.result && r.result.booking_intake_ready,
      extracted_fields: r.result && r.result.extracted_fields,
      package_night_rule: r.result && r.result.package_night_rule,
      result: { ...(r.result || {}), proposed_luna_reply: r.proposed_luna_reply },
      availability: r.availability,
      quote: r.quote,
      payment_choice: r.payment_choice,
      hold_payment_draft_plan: r.hold_payment_draft_plan,
      contact_name: 'Marco',
      whatsapp_guest_name: 'Marco',
      previous_quote_invalidated: r.result && r.result.previous_quote_invalidated === true ? true : undefined,
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
      language_hint: 'en',
      dry_run: true,
      automation_gate_context: { public_guest_automation_enabled: false, whatsapp_dry_run: true, live_send_allowed: false },
    }, {
      reference_date: '2026-06-10',
      pg,
      guest_name: 'Marco',
      contact_name: 'Marco',
      dry_run: true,
    }));
    if (!out || !out.result) throw new Error(`orchestrator returned empty for "${message_text}"`);
    return { out, ctx: ctxFrom(out) };
  }

  let ctx = {};
  for (const msg of ['book a stay', 'July 1-5', '1', 'no thanks, I have my own stuff']) {
    ({ ctx } = await turn(ctx, msg));
  }
  const dateFix = (await turn(ctx, 'actually July 2-6')).out;
  check('H1', dateFix.result.previous_quote_invalidated === true, 'date correction marks stale');
  check('H2', dateFix.result.stale_quote_reason === 'dates_changed', 'date correction reason');
  check('H3', dateFix.result.extracted_fields.check_in === '2026-07-02', 'dates updated');

  ctx = {};
  for (const msg of ['July 1-5 for 1', 'no thanks, I have my own stuff']) {
    ({ ctx } = await turn(ctx, msg));
  }
  const cash = (await turn(ctx, 'can I pay cash?')).out;
  check('H4', !cash.result.previous_quote_invalidated, 'cash question does not invalidate quote');
  check('H5', cash.quote && cash.quote.quote_status === 'ready', 'quote preserved through cash question');
  const cashReply = String(cash.proposed_luna_reply || '');
  check('H6', /cash|arrival|bank transfer/i.test(cashReply), 'cash question answered');
  check('H7', !isForbiddenGuestCopy(cashReply), 'cash reply natural');

  ctx = {};
  ({ ctx } = await turn(ctx, 'Malibu July 10 to July 17 for 2'));
  const reset = (await turn(ctx, 'no no, start over')).out;
  check('H8', reset.result.new_booking_reset === true, 'reset detected after quote');

  ctx = {};
  ({ ctx } = await turn(ctx, 'July 1-5 for 1'));
  const hi = (await turn(ctx, 'hi')).out;
  check('H9', !hi.result.new_booking_reset, 'hi mid-flow does not reset');

  section('Summary');
  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
