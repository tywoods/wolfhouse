/**
 * Stage 33 — package add-ons composer fix + post-hold service attach verifier.
 *
 * Usage:
 *   npm run verify:stage33-package-addons-and-service-attach
 */

'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const ROOT = path.join(__dirname, '..');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage33-package-addons-and-service-attach';
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine');

const { withPgClient } = require('./lib/pg-connect');
const {
  extractAddOnSelections,
  isExplicitAddonSelectionMessage,
  isAddonSideQuestion,
  quoteAwaitingAddonsDecision,
  buildAddonsObservability,
} = require('./lib/luna-booking-addons-policy');
const {
  collectPendingManualServices,
  PENDING_ATTACH_ORIGIN,
  SERVICE_RECORD_DB_SOURCE,
} = require('./lib/luna-guest-pending-service-attach');
const {
  filterBookingsSince,
  pickProofBookingCandidate,
  pollForPaymentLinkSend,
} = require('./lib/luna-hosted-proof-booking-lookup');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');
const { detectServiceSideQuestionIntent } = require('./lib/luna-guest-service-transfer-explainer');
const { buildReactiveServicesObservability } = require('./lib/luna-booking-reactive-services-policy');
const { normalizeGuestContextForChain } = require('./lib/luna-guest-context-merge');
const holdWriteSrc = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-write.js'), 'utf8');
const orchestratorSrc = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js'), 'utf8');
const quoteSrc = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-quote-proposal-dry-run.js'), 'utf8');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage33-package-addons-and-service-attach.js  (Stage 33)\n`);

section('A. Files + package script');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A1', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);
check('A2', fs.existsSync(path.join(__dirname, 'lib', 'luna-guest-pending-service-attach.js')),
  'pending service attach module exists');
check('A3', fs.existsSync(path.join(__dirname, 'lib', 'luna-hosted-proof-booking-lookup.js')),
  'hosted proof booking lookup module exists');

const stage33Fixtures = [
  'package-one-shot-addons-before-deposit.json',
  'package-one-shot-just-stay-then-deposit.json',
  'explicit-addons-selection.json',
  'package-yoga-pending-attach.json',
];
for (const f of stage33Fixtures) {
  check(`A4-${f}`, fs.existsSync(path.join(FIXTURE_DIR, f)), `fixture ${f}`);
}

section('B. Explicit add-on routing vs side questions');
check('B1', isExplicitAddonSelectionMessage('wetsuit and lessons'),
  '"wetsuit and lessons" is explicit add-on selection');
check('B2', !isAddonSideQuestion('wetsuit and lessons'),
  '"wetsuit and lessons" is not add-on side question');
check('B3', extractAddOnSelections('wetsuit and lessons').includes('wetsuit')
  && extractAddOnSelections('wetsuit and lessons').includes('surf_lesson'),
  'selection parser stores wetsuit + surf_lesson');
check('B4', isAddonSideQuestion('Do you rent boards?'),
  'true side question still detected');
check('B5', detectServiceSideQuestionIntent('Do you rent boards?') === 'board_rental',
  'board rental side question intent preserved');

section('C. Composer ownership + legacy quote retirement');
check('C1', quoteSrc.includes('composer owns guest copy'),
  'package quote no longer uses legacy deposit template in quote module');
check('C2', !/quoteAwaitingAddonsDecision\(quote\)\s*\n\s*&& !quoteLegacyReplyIsStale\(quote, result\)\) \{\s*\n\s*return sanitizeReply\(quote\.proposed_luna_reply/s.test(orchestratorSrc),
  'orchestrator no longer prefers legacy quote when addons pending');
check('C3', orchestratorSrc.includes('isExplicitAddonSelectionMessage'),
  'orchestrator skips service explainer for explicit add-on selections');

section('D. Post-hold pending service attach (static)');
const pending = collectPendingManualServices({
  yoga_request: { status: 'requested' },
  services_pending_manual: ['yoga'],
});
check('D1', pending.some((s) => s.type === 'yoga'), 'yoga pending manual collected');
check('D2', PENDING_ATTACH_ORIGIN === 'luna_guest_pending'
  && SERVICE_RECORD_DB_SOURCE === 'luna_guest', 'attach DB source + pending origin constants');
check('D3', holdWriteSrc.includes('attachPendingManualGuestServices'),
  'hold write path calls pending service attach');
check('D4', holdWriteSrc.includes('attached_manual_services'),
  'hold write exposes attached_manual_services observability');
check('D5', !holdWriteSrc.includes('sends_whatsapp: true'),
  'no WhatsApp send path added');
check('D6', holdWriteSrc.includes('calls_n8n: false'),
  'hold write keeps n8n disabled');

section('E. Harness lookup helpers');
const bookings = [
  { booking_id: 'a', created_at: '2026-06-10T10:00:00Z', updated_at: '2026-06-10T11:00:00Z', check_in: '2026-07-10', check_out: '2026-07-17' },
  { booking_id: 'b', created_at: '2026-06-09T10:00:00Z', updated_at: '2026-06-09T10:00:00Z', check_in: '2026-07-10', check_out: '2026-07-17' },
];
const filtered = filterBookingsSince(bookings, '2026-06-10T10:30:00Z');
check('E1', filtered.some((b) => b.booking_id === 'a'), 'updated_at qualifies reused hold lookup');
check('E2', !filtered.some((b) => b.booking_id === 'b'), 'stale booking excluded by activity window');
const picked = pickProofBookingCandidate(bookings, {
  sinceIso: '2026-06-10T09:00:00Z',
  checkIn: '2026-07-10',
  checkOut: '2026-07-17',
});
check('E3', picked && picked.booking_id === 'a', 'pickProofBookingCandidate prefers latest activity');

section('F. Orchestrator flows');

async function runTurn(message, prior) {
  const input = {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    message_text: message,
    guest_phone: '+491726422399',
    guest_context: prior || {},
    reference_date: '2026-06-10',
    dry_run: true,
    automation_gate_context: {
      public_guest_automation_enabled: false,
      whatsapp_dry_run: true,
      live_send_allowed: false,
    },
  };
  const out = await withPgClient((pg) => runGuestAutomationOrchestratorDryRun(input, {
    reference_date: '2026-06-10',
    dry_run: true,
    pg,
  }));
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
    composed,
    reply: composed && composed.covered && composed.reply ? composed.reply : out.proposed_luna_reply,
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
  const pkgOneShot = await runTurn('Malibu July 10 to July 17 for 1', {});
  const pkgReply = pkgOneShot.reply || '';
  check('F1', /wetsuit|lessons/i.test(pkgReply) && /Malibu|€|\d/i.test(pkgReply),
    'package one-shot asks surf add-ons with package quote');
  check('F2', !/I am not confirming|not confirming or holding/i.test(pkgReply),
    'no legacy internal quote copy on package one-shot');
  check('F3', pkgOneShot.composed && pkgOneShot.composed.reply_source === 'luna_reply_composer',
    'package one-shot final reply source is composer');
  check('F4', pkgOneShot.composed && pkgOneShot.composed.composer_state === 'package_quote_ready',
    'package one-shot composer state is package_quote_ready');
  check('F5', quoteAwaitingAddonsDecision(pkgOneShot.out.quote),
    'addons pending before deposit on package one-shot');
  check('F6', !(pkgOneShot.out.payment_choice && pkgOneShot.out.payment_choice.payment_choice_ready),
    'deposit not ready before add-ons resolved on package one-shot');

  const pkgDecline = await runTurn('just the stay', pkgOneShot.ctx);
  check('F7', pkgDecline.out.result.extracted_fields.addons_skipped === true,
    'just the stay declines package add-ons');
  const pkgDeposit = await runTurn('deposit', pkgDecline.ctx);
  check('F8', pkgDeposit.out.payment_choice && pkgDeposit.out.payment_choice.payment_choice === 'deposit',
    'deposit detected after add-ons declined on package flow');

  let shortCtx = {};
  let short = await runTurn('July 6-10 for 1 guest', shortCtx);
  shortCtx = short.ctx;
  short = await runTurn('Marco', shortCtx);
  shortCtx = short.ctx;
  const addonPick = await runTurn('wetsuit and lessons', shortCtx);
  const addonReply = addonPick.reply || '';
  check('F9', !/Neopren-Verleih|I am not adding rentals|do you want to know about wetsuits/i.test(addonReply),
    '"wetsuit and lessons" does not use wetsuit explainer');
  check('F10', /(?:deposit|full|hold the spot)/i.test(addonReply),
    'explicit add-on selection proceeds to deposit/full prompt');
  const addonObs = buildAddonsObservability(
    { extracted_fields: addonPick.out.result.extracted_fields },
    {},
    addonPick.out.quote,
  );
  check('F11', addonObs.addons_requested.includes('wetsuit')
    && addonObs.addons_requested.includes('surf_lesson'),
    'addons_requested includes wetsuit + surf_lesson');

  const boardQ = await runTurn('Do you rent boards?', addonPick.ctx);
  check('F12', /board|rent/i.test(boardQ.reply || ''),
    'true service side question still answered');

  let yogaCtx = {};
  let yogaFlow = await runTurn('Malibu July 10 to July 17 for 1', yogaCtx);
  yogaCtx = yogaFlow.ctx;
  yogaFlow = await runTurn('just the stay', yogaCtx);
  yogaCtx = yogaFlow.ctx;
  const yogaAsk = await runTurn('Can I add yoga?', yogaCtx);
  const yogaObs = buildReactiveServicesObservability(yogaAsk.out.result.extracted_fields, 'wolfhouse-somo');
  check('F13', yogaObs.yoga_status === 'requested' || yogaObs.yoga_status === 'interested',
    'yoga_status requested when guest asks reactively');
  check('F14', Array.isArray(yogaObs.services_pending_manual) && yogaObs.services_pending_manual.includes('yoga'),
    'services_pending_manual includes yoga before hold');
  check('F15', !/Are you going to need a wetsuit.*yoga|yoga.*wetsuit.*lessons/i.test(yogaAsk.reply || ''),
    'yoga/meals not proactively upsold in add-ons question');

  section('G. Safety');
  check('G1', !holdWriteSrc.includes('creates_stripe_link: true'),
    'hold write does not create live Stripe links');
  check('G2', holdWriteSrc.includes('whatsapp_sent: false'),
    'hold write keeps WhatsApp blocked');

  section('H. Late send poll helper');
  let pollCount = 0;
  const pollResult = await pollForPaymentLinkSend(async () => {
    pollCount += 1;
    if (pollCount < 2) return [];
    return [{ message_text: 'Pay here https://checkout.stripe.com/test', created_at: '2026-06-10T12:00:05Z' }];
  }, { sinceIso: '2026-06-10T12:00:00Z', intervalMs: 50, maxWaitMs: 500, firstWindowMs: 5 });
  check('H1', pollResult.send != null, 'pollForPaymentLinkSend finds late payment link send');
  check('H2', pollResult.late_send_observed === true || pollResult.waited_ms > 5,
    'late send reported when outside first window');

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
