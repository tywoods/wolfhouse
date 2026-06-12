/**
 * Stage 56 — Open-world milestones A+B+C: transcript, frontdesk planner, composer bypass.
 *
 * Usage:
 *   node scripts/verify-stage56-open-world-frontdesk.js
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const {
  resolveGuestThreadTranscript,
  transcriptFromGuestContext,
} = require('./lib/luna-guest-thread-transcript-loader');
const {
  buildFrontdeskReplyPlan,
  ASK_COMPOSER_STATES,
  isGuestFrontdeskPlannerEnabled,
} = require('./lib/luna-guest-frontdesk-planner');
const {
  composeFrontdeskGuestReply,
  buildFrontdeskIntakeDraft,
} = require('./lib/luna-guest-frontdesk-reply');
const {
  isComposerBypassEnabled,
  FRONTDESK_CAMI_STATES,
} = require('./lib/luna-guest-composer-ownership');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { LUNA_GUEST_STAGING_V1 } = require('./lib/luna-guest-staging-profile');
const { runConversationFixture } = require('./lib/luna-conversation-fixture-set-batch');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

section('A. Transcript from guest_context');
{
  const ctx = {
    thread_transcript: [
      { role: 'assistant', text: 'Hey! July dates work?' },
      { role: 'guest', text: 'July 1-5 for 1' },
      { role: 'assistant', text: 'Perfect — accommodation or package?' },
    ],
  };
  const bundle = transcriptFromGuestContext(ctx);
  check('A1', bundle.transcript.length === 3, 'injected transcript loaded');
  check('A2', bundle.transcript[1].role === 'guest', 'guest turn preserved');
}

section('B. Frontdesk reply plan bypasses ask_*');
{
  const plan = buildFrontdeskReplyPlan({
    payload: {
      result: {
        extracted_fields: { check_in: '2026-07-01', check_out: '2026-07-05' },
        missing_required_fields: ['guest_count'],
      },
      quote: { quote_status: 'not_ready' },
      payment_choice: {},
    },
    prior_guest_context: { active_thread: 'intake' },
    frontdesk_pre_plan: { intent: 'booking_intake', missing_fields: ['guest_count'] },
    composed: { covered: true, reply: 'How many guests?', composer_state: 'ask_guests' },
  });
  check('B1', plan.composer_state_bypassed === 'ask_guests', 'ask_guests marked for bypass');
  check('B2', plan.frontdesk_composer_state === 'frontdesk_intake', 'frontdesk intake state');
  check('B3', ASK_COMPOSER_STATES.has('ask_guests'), 'ask_guests in bypass set');
}

section('C. Composer bypass produces Cami draft');
{
  const env = { LUNA_GUEST_COMPOSER_BYPASS_ENABLED: 'true' };
  const draft = buildFrontdeskIntakeDraft(
    {
      missing_fields: ['guest_count'],
      next_required_field: 'guest_count',
      facts_for_cami: { check_in: '2026-07-01', check_out: '2026-07-05' },
    },
    { result: { extracted_fields: { check_in: '2026-07-01', check_out: '2026-07-05' } } },
    'July 1-5 for 1',
  );
  check('C1', /guest_count|how many guests/i.test(draft), 'draft hints guest count naturally');
  const composed = composeFrontdeskGuestReply({
    payload: {
      result: {
        message_lane: 'new_booking_inquiry',
        extracted_fields: { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1 },
        greeting_only: false,
      },
      quote: { quote_status: 'not_ready' },
      payment_choice: {},
      gate: { gate_status: 'allowed_dry_run' },
    },
    message_text: 'just me',
    prior_guest_context: { active_thread: 'intake' },
    frontdesk_reply_plan: {
      reply_mode: 'ask_missing_naturally',
      composer_state_bypassed: 'ask_package',
      frontdesk_composer_state: 'frontdesk_intake',
      missing_fields: ['package_or_accommodation'],
    },
    env,
  });
  check('C2', composed && composed.composer_state === 'frontdesk_intake', 'bypass → frontdesk_intake');
  check('C3', composed && composed.cami_author_required === true, 'Cami required for bypass reply');
  check('C4', FRONTDESK_CAMI_STATES.has('frontdesk_intake'), 'frontdesk_intake Cami-eligible');
}

section('D. Staging profile flags');
check('D1', LUNA_GUEST_STAGING_V1.LUNA_GUEST_FRONTDESK_PLANNER_ENABLED === 'true', 'frontdesk on in staging');
check('D2', LUNA_GUEST_STAGING_V1.LUNA_GUEST_COMPOSER_BYPASS_ENABLED === 'true', 'composer bypass on in staging');
check('D3', isGuestFrontdeskPlannerEnabled(LUNA_GUEST_STAGING_V1), 'frontdesk enabled helper');
check('D4', isComposerBypassEnabled(LUNA_GUEST_STAGING_V1), 'bypass enabled helper');

section('E. Orchestrator with mocked frontdesk planner');
(async function runOrchestratorTest() {
  const mockPlan = JSON.stringify({
    planned_tools: ['get_conversation_context', 'collect_missing_booking_fields'],
    intent: 'booking_intake',
    missing_fields: ['guest_count'],
    rationale: 'guest gave dates',
  });
  const env = {
    ...process.env,
    ...LUNA_GUEST_STAGING_V1,
    LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED: 'false',
  };
  const out = await runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo',
    channel: 'dry_run',
    message_text: 'July 1 to 5',
    guest_phone: '+34600956001',
    guest_context: {
      thread_transcript: [
        { role: 'assistant', text: 'Hey! When are you thinking of coming?' },
      ],
      detected_language: 'en',
    },
    reference_date: '2026-06-10',
  }, {
    env,
    frontdesk_planner_caller: async () => mockPlan,
  });
  const fd = out.result && out.result.guest_frontdesk;
  check('E1', fd && fd.frontdesk_planner_used === true, 'mocked frontdesk planner used');
  check('E2', out.guest_context_chain && out.guest_context_chain.transcript_turns >= 1, 'transcript on context chain');
  check('E3', fd && fd.transcript_turns >= 1, 'transcript turns in observability');
}()).then(() => {
  section('Summary');
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
