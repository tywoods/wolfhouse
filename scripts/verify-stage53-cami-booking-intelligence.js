/**
 * Stage 53 — Cami booking intelligence: package inference, language lock,
 * mid-thread tone, variation pools, gpt-5.5 Cami author.
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const {
  inferPackageFromGearSignals,
  extractLunaGuestMessageIntake,
} = require('./lib/luna-guest-message-intake');
const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');
const {
  shouldPrioritizeKnowledgeOverService,
  isActiveBookingIntake,
} = require('./lib/luna-guest-knowledge-config');
const {
  validateCamiAuthoredReply,
  buildAuthorInput,
  authorModel,
} = require('./lib/luna-guest-cami-reply-author');
const { buildWelcomeReply } = require('./lib/luna-guest-personality-config');
const { getVariationPool, loadCamiBehavior } = require('./lib/luna-guest-cami-reply-variation');
const { LUNA_GUEST_STAGING_V1 } = require('./lib/luna-guest-staging-profile');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

section('A. Package inference from gear');
check('A1', inferPackageFromGearSignals('yea i need a surfboard and a wesuit') == null, 'board+wesuit addon → no weekly package infer');
check('A2', inferPackageFromGearSignals('surf lessons and gear please') == null, 'lessons addon → no weekly package infer');
check('A3', inferPackageFromGearSignals('just accommodation only') == null, 'accommodation only → no weekly package infer');
check('A4', inferPackageFromGearSignals('gear included') === 'uluwatu', 'tier gear included → uluwatu');
check('A5', inferPackageFromGearSignals('lessons included') === 'waimea', 'tier lessons included → waimea');
check('A6', inferPackageFromGearSignals('stay only') === 'malibu', 'tier stay only → malibu');

section('B. Router — gear mid-intake stays booking lane');
{
  const prior = {
    detected_language: 'en',
    result: {
      detected_language: 'en',
      extracted_fields: {
        check_in: '2026-06-22',
        check_out: '2026-06-29',
        guest_count: 3,
      },
    },
  };
  const out = runLunaGuestMessageRouterDryRun({
    message_text: 'yea i need a surfboard and a wetsuit',
    guest_context: prior,
  });
  check('B1', out.message_lane === 'new_booking_inquiry', 'gear mention stays new_booking_inquiry');
  check('B2', out.detected_language === 'en', 'wetsuit in English does not flip to German');
  check('B3', !out.extracted_fields || !out.extracted_fields.package_interest
    || out.extracted_fields.package_interest === 'no_package',
    'standalone gear does not infer weekly package');
}

section('C. Knowledge — no FAQ hijack mid package intake');
{
  const ctx = {
    result: {
      extracted_fields: {
        check_in: '2026-06-22',
        check_out: '2026-06-29',
        guest_count: 3,
      },
    },
  };
  check('C1', isActiveBookingIntake(ctx), 'active booking intake detected');
  check('C2', shouldPrioritizeKnowledgeOverService('board and wetsuit', 'wetsuit_info', ctx) === false,
    'wetsuit FAQ blocked during package pick');
}

section('D. Cami author defaults + validators');
check('D1', authorModel({}) === 'gpt-5.5', 'default Cami model is gpt-5.5');
check('D2', LUNA_GUEST_STAGING_V1.LUNA_GUEST_CAMI_REPLY_AUTHOR_MODEL === 'gpt-5.5', 'staging profile sets gpt-5.5');
{
  const input = buildAuthorInput({
    client_slug: 'wolfhouse-somo',
    message_text: 'deposit',
    composer_state: 'ask_payment_choice',
    deterministic_reply: 'Would you rather pay the €200 deposit or the full €1047?',
    prior_guest_context: {
      cami_variation_history: { turn_count: 4, openers: ['heyyy'] },
      result: {
        detected_language: 'en',
        extracted_fields: {
          check_in: '2026-06-22',
          check_out: '2026-06-29',
          guest_count: 3,
          package_interest: 'uluwatu',
        },
      },
    },
    payload: {
      result: {
        detected_language: 'en',
        extracted_fields: {
          check_in: '2026-06-22',
          check_out: '2026-06-29',
          guest_count: 3,
          package_interest: 'uluwatu',
        },
      },
      quote: { quote_status: 'ready', quote_total_cents: 104700, deposit_required_cents: 20000 },
    },
  });
  check('D3', !!input.cami_variant_hint, 'author input includes cami variant hint');
  const bad = validateCamiAuthoredReply(
    'Heyyy! So glad you\'re here! Deposit or full?',
    input,
  );
  check('D4', bad.includes('mid_thread_welcome_phrase') || bad.includes('mid_thread_greeting_opener'),
    'rejects mid-thread re-greeting');
}

section('E. Fable variation pools wired');
{
  const behavior = loadCamiBehavior('wolfhouse-somo');
  const pools = getVariationPool(behavior, 'en', 'package_choice');
  const welcome = buildWelcomeReply('wolfhouse-somo', 'en', {}, {
    guest_phone: '+34600111111',
    conversation_id: 'conv-wolf-1',
  });
  check('E1', Array.isArray(pools) && pools.length >= 3, 'package_choice variation pool exists');
  check('E2', welcome && /🐺/.test(welcome), 'welcome uses wolf emoji once');
  check('E3', !/so happy you(?:'re| are) here/i.test(welcome), 'welcome drops so-happy-youre-here');
}

section('F. Intake tier vs addon signals');
{
  const gearAddon = extractLunaGuestMessageIntake({
    client_slug: 'wolfhouse-somo',
    message_text: 'surfboard and wetsuit please',
  });
  check('F1', !gearAddon.package_code || gearAddon.package_code === 'no_package',
    'standalone gear request does not infer weekly package');
  const tierGear = extractLunaGuestMessageIntake({
    client_slug: 'wolfhouse-somo',
    message_text: 'gear included please',
  });
  check('F2', tierGear.package_code === 'uluwatu', 'tier gear included → uluwatu');
}

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
