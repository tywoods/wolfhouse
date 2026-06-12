/**
 * Stage 51 — Guest reply + write pipeline cleanup verifier.
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const {
  COMPOSER_OWNED_STATES,
  shouldSkipCamiAuthor,
  applyGuestReplyPipeline,
} = require('./lib/luna-guest-reply-pipeline');
const { runLunaGuestAgentBrain } = require('./lib/luna-guest-agent-brain');
const {
  LUNA_GUEST_STAGING_V1,
  describeLunaGuestStagingProfile,
} = require('./lib/luna-guest-staging-profile');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

const PROFILE_ENV = {
  ...process.env,
  ...LUNA_GUEST_STAGING_V1,
  OPENAI_API_KEY: '',
};

(async () => {
  console.log('\nverify-stage51-guest-pipeline-cleanup.js  (Stage 51)\n');

  section('A. Composer-owned = payment truth only (Stage 52)');
  {
    check('A1', !COMPOSER_OWNED_STATES.includes('greeting'), 'greeting not composer-owned');
    check('A2', !COMPOSER_OWNED_STATES.includes('explain_packages'), 'packages cami-warmable');
    check('A3', !COMPOSER_OWNED_STATES.includes('ask_payment_choice'), 'payment choice cami-warmable');
    check('A4', COMPOSER_OWNED_STATES.includes('stripe_test_link_created'), 'stripe truth owned');
  }

  section('B. Cami skip only on payment-truth states');
  {
    const hello = shouldSkipCamiAuthor({
      composed: { covered: true, composer_state: 'greeting', reply: 'Book a stay?' },
      payload: { result: { greeting_only: true } },
    });
    check('B1', hello.skip !== true, 'does not skip greeting');

    const stripe = shouldSkipCamiAuthor({
      composed: { covered: true, composer_state: 'stripe_test_link_created', reply: 'Pay here: url' },
      payload: { result: {} },
    });
    check('B2', stripe.skip === true, 'skips stripe_test_link_created');
    check('B3', stripe.reason === 'composer_owned:stripe_test_link_created', 'stripe reason');
  }

  section('C. Agent brain defers package_info when Cami on');
  {
    const agent = runLunaGuestAgentBrain({
      message_text: 'tell me about packages',
      composed: { covered: true, composer_state: 'explain_packages', reply: 'composer copy' },
      candidate_reply: 'composer copy',
      candidate_source: 'composer',
      payload: { result: { message_lane: 'new_booking_inquiry', detected_language: 'en' } },
      env: { ...PROFILE_ENV, LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED: 'true' },
    });
    check('C1', agent.fallback_used === true, 'does not override composer');
    check('C2', agent.safety_notes.some((n) => /package_info_deferred/.test(n)), 'deferred note');
  }

  section('D. Reply pipeline attempts Cami on hello (falls back without API key)');
  {
    const out = await applyGuestReplyPipeline({
      client_slug: 'wolfhouse-somo',
      message_text: 'hello!',
      composed: {
        covered: true,
        composer_state: 'greeting',
        reply: 'Hey! Book a stay or need info?',
        reply_source: 'composer',
      },
      candidate_reply: 'Hey! Book a stay or need info?',
      candidate_source: 'composer',
      payload: { result: { greeting_only: true } },
      env: PROFILE_ENV,
    });
    check('D1', out.reply.includes('Book a stay') || out.reply.includes('info'), 'reply present');
    check('D2', out.reply_pipeline.cami_skipped !== true, 'cami not skipped on hello');
    check('D3', out.cami_reply_author.cami_author_fallback_used === true, 'fallback without API key');
  }

  section('E. Staging profile documents canonical flags');
  {
    const doc = describeLunaGuestStagingProfile();
    check('E1', doc.flags.LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED === 'true', 'cami in profile');
    check('E2', doc.reply_ownership.composer, 'ownership documented');
    check('E3', doc.flags.LUNA_GUEST_GPT_WRITE_TOOLS_ENABLED === 'true', 'write planner in profile');
  }

  section('F. Orchestrator exposes guest_reply_pipeline');
  {
    const out = await runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'dry_run',
      message_text: 'hello!',
      guest_phone: '+34600500099',
      guest_context: {},
      reference_date: '2026-06-11',
    }, {
      env: {
        ...PROFILE_ENV,
        LUNA_GUEST_GPT_TOOL_PLANNER_ENABLED: 'false',
        LUNA_GUEST_GPT_WRITE_TOOLS_ENABLED: 'false',
      },
    });
    const pipe = out.result && out.result.guest_reply_pipeline;
    check('F1', !!pipe, 'pipeline observability');
    check('F2', pipe && pipe.cami_skipped !== true, 'hello cami attempted via orch');
    check('F3', !!(out.proposed_luna_reply), 'reply present');
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
