/**
 * Stage 54 — Ungated confirmations, live context persistence, July flow regressions.
 *
 * Usage:
 *   node scripts/verify-stage54-open-world-confirmations.js
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const {
  evaluateConfirmationLiveSendAllowlist,
  isConfirmationLiveSendRecipientAllowlisted,
} = require('./lib/luna-guest-confirmation-live-send-allowlist');
const {
  isAutoConfirmationSendEnabled,
  tryAutoSendBookingConfirmation,
} = require('./lib/luna-guest-confirmation-auto-send');
const { mergeLiveStagingGuestContext } = require('./lib/luna-guest-live-context-persist');
const {
  shouldPrioritizeKnowledgeOverService,
  hasPostBookingHold,
} = require('./lib/luna-guest-knowledge-config');
const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { normalizeGuestContextForChain } = require('./lib/luna-guest-context-merge');
const { LUNA_GUEST_STAGING_V1 } = require('./lib/luna-guest-staging-profile');
const { runConversationFixture } = require('./lib/luna-conversation-fixture-set-batch');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

section('A. Confirmation allowlist removed');
{
  const env = { WHATSAPP_DRY_RUN: 'false' };
  const evalAny = evaluateConfirmationLiveSendAllowlist('+34600111222', env);
  check('A1', evalAny.allowed === true, '+34600111222 allowed without allowlist env');
  check('A2', isConfirmationLiveSendRecipientAllowlisted('+491701234567', env), 'any E.164 phone allowed');
  const evalBad = evaluateConfirmationLiveSendAllowlist('', env);
  check('A3', evalBad.allowed === false && evalBad.reasons.includes('to_required'), 'empty to still blocked');
}

section('B. Staging profile — auto-send on');
check('B1', LUNA_GUEST_STAGING_V1.LUNA_AUTO_SEND_ENABLED === 'true', 'LUNA_AUTO_SEND_ENABLED in staging v1');
check('B2', isAutoConfirmationSendEnabled(LUNA_GUEST_STAGING_V1), 'isAutoConfirmationSendEnabled true on profile');

section('C. Live context merge');
{
  const merged = mergeLiveStagingGuestContext(
    { quote: { quote_status: 'ready', payment_choice_needed: true } },
    {
      bookingWrite: { booking_code: 'WH-G27-X', write_status: 'created' },
      stripeLink: { stripe_link_created: true },
      proposedReply: 'Pay here https://pay.example/pay/WH-G27-X',
    },
  );
  check('C1', merged.booking_code === 'WH-G27-X', 'booking_code persisted');
  check('C2', merged.payment_link_sent === true, 'payment_link_sent set');
  check('C3', merged.payment_choice_needed === false, 'payment_choice_needed cleared after link');
}

section('D. Post-booking wetsuit — service lane not FAQ');
{
  const ctx = { booking_code: 'WH-G27-X', hold_created: true, payment_received: true };
  check('D1', hasPostBookingHold(ctx), 'hasPostBookingHold detects hold');
  check('D2', shouldPrioritizeKnowledgeOverService('book a wetsuit for 2 days', 'wetsuit_info', ctx) === false,
    'book wetsuit routes to service not FAQ');
  const route = runLunaGuestMessageRouterDryRun({
    message_text: 'book a wetsuit for 2 days',
    guest_context: ctx,
  });
  check('D3', route.message_lane === 'add_service_request', 'router → add_service_request post-booking');
}

section('E. Gratitude after payment link — no re-ask');
(async () => {
  const env = {
    ...process.env,
    ...LUNA_GUEST_STAGING_V1,
    LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED: 'false',
    LUNA_GUEST_FRONTDESK_PLANNER_ENABLED: 'false',
    LUNA_GUEST_COMPOSER_BYPASS_ENABLED: 'false',
  };
  const prior = normalizeGuestContextForChain({
    payment_link_sent: true,
    payment_choice_needed: false,
    quote: { quote_status: 'ready', payment_choice_needed: false, check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1 },
    payment_choice: { payment_choice_ready: true, payment_choice: 'deposit', payment_choice_detected: true },
    result: {
      message_lane: 'new_booking_inquiry',
      extracted_fields: { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1, package_interest: 'malibu' },
      detected_language: 'en',
    },
  });
  const out = await runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo',
    channel: 'dry_run',
    message_text: 'awesome thanks',
    guest_phone: '+34600954001',
    guest_context: prior,
    reference_date: '2026-06-10',
  }, { env });
  const reply = String(out.proposed_luna_reply || '').toLowerCase();
  check('E1', !/would you prefer|deposit or the full|full amount/.test(reply), 'gratitude does not re-ask payment choice');
})().then(() => section('F. July fixture batch')).then(async () => {
  const fx = require(path.join(
    __dirname, '..', 'fixtures', 'luna-conversation-state-machine', 'cami-realism',
    'july-1-5-accommodation-deposit-flow.json',
  ));
  const result = await runConversationFixture(fx, { referenceDate: '2026-06-10' }, 54);
  check('F1', result.result === 'PASS', `july fixture ${result.result} (${result.failures.length} failures)`);
  if (result.failures.length) {
    for (const f of result.failures.slice(0, 8)) fail('F1x', f);
  }
}).then(() => {
  section('Summary');
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
