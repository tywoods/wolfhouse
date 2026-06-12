/**
 * Stage 55 — Open-world thread state + payment truth hydrate.
 *
 * Usage:
 *   node scripts/verify-stage55-open-world-thread-state.js
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const {
  resolveActiveThread,
  attachActiveThreadToGuestContext,
  isPostBookingThread,
} = require('./lib/luna-guest-thread-state');
const { mergePaymentTruthRowIntoContext } = require('./lib/luna-guest-payment-truth-hydrate');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { normalizeGuestContextForChain } = require('./lib/luna-guest-context-merge');
const { LUNA_GUEST_STAGING_V1 } = require('./lib/luna-guest-staging-profile');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

section('A. Thread state resolution');
check('A1', resolveActiveThread({}) === 'intake', 'empty → intake');
check('A2', resolveActiveThread({ quote: { quote_status: 'ready' } }) === 'quoted', 'ready quote → quoted');
check('A3', resolveActiveThread({
  quote: { quote_status: 'ready' },
  payment_choice: { payment_choice_ready: true },
}) === 'awaiting_payment', 'payment choice ready → awaiting_payment');
check('A4', resolveActiveThread({ payment_link_sent: true }) === 'awaiting_payment', 'link sent → awaiting_payment');
check('A5', resolveActiveThread({
  payment_truth: { payment_status: 'deposit_paid' },
}) === 'booked', 'deposit_paid → booked');
check('A6', resolveActiveThread({
  payment_truth: { payment_status: 'deposit_paid' },
  confirmation_sent: true,
}) === 'post_booking', 'paid + confirmed → post_booking');

section('B. DB hydrate merge');
{
  const merged = mergePaymentTruthRowIntoContext(
    { booking_code: 'WH-G27-X' },
    {
      id: 'uuid-1',
      booking_code: 'WH-G27-X',
      payment_status: 'deposit_paid',
      confirmation_sent_at: '2026-06-10T12:00:00Z',
    },
  );
  check('B1', merged.payment_received === true, 'hydrate sets payment_received');
  check('B2', merged.confirmation_sent === true, 'hydrate sets confirmation_sent');
  check('B3', merged.active_thread === 'post_booking', 'hydrate → post_booking thread');
  check('B4', isPostBookingThread(merged), 'isPostBookingThread after hydrate');
}

section('C. Orchestrator stamps active_thread');
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
    booking_code: 'WH-G27-STAGE55',
    quote: { quote_status: 'ready', payment_choice_needed: false },
    payment_choice: { payment_choice_ready: true, payment_choice: 'deposit' },
    result: {
      message_lane: 'new_booking_inquiry',
      extracted_fields: { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1 },
      detected_language: 'en',
    },
  });
  const out = await runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo',
    channel: 'dry_run',
    message_text: 'awesome thanks',
    guest_phone: '+34600955001',
    guest_context: prior,
    reference_date: '2026-06-10',
  }, { env });
  check('C1', out.result && out.result.active_thread === 'awaiting_payment',
    `orchestrator result.active_thread=${out.result && out.result.active_thread}`);
  check('C2', out.guest_context_chain && out.guest_context_chain.active_thread === 'awaiting_payment',
    'guest_context_chain persisted');
  check('C3', out.guest_context_chain && out.guest_context_chain.payment_link_sent === true,
    'payment_link_sent in chain snapshot');
})().then(() => {
  section('Summary');
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
