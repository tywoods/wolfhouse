'use strict';

/**
 * Canonical Luna guest automation profile for staging.
 *
 * One place to see which flags belong together — reduces mixed signals at deploy time.
 */

const LUNA_GUEST_STAGING_V1 = Object.freeze({
  // Deterministic chain + open demo live path
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'false',

  // Reply layers (pipeline: composer owns intake; Cami warms quotes only)
  LUNA_GUEST_AGENT_BRAIN_ENABLED: 'true',
  LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED: 'true',
  LUNA_GUEST_CAMI_REPLY_AUTHOR_MODEL: 'gpt-4o',
  LUNA_GUEST_CAMI_REPLY_AUTHOR_TIMEOUT_MS: '25000',
  LUNA_GUEST_CAMI_REPLY_AUTHOR_TEMPERATURE: '0.72',
  LUNA_GUEST_FRONTDESK_PLANNER_TIMEOUT_MS: '18000',
  LUNA_CONVERSATION_BRAIN_MODEL: 'gpt-4o-mini',

  // GPT planners (read before router; write after chain)
  LUNA_GUEST_GPT_TOOL_PLANNER_ENABLED: 'false',
  LUNA_GUEST_GPT_TOOL_PLANNER_ACTIVE: 'false',
  LUNA_GUEST_GPT_WRITE_TOOLS_ENABLED: 'true',
  LUNA_GUEST_GPT_WRITE_TOOLS_ACTIVE: 'true',

  // Stage 56 open-world frontdesk (transcript + unified planner + composer bypass)
  LUNA_GUEST_FRONTDESK_PLANNER_ENABLED: 'true',
  LUNA_GUEST_FRONTDESK_PLANNER_ACTIVE: 'true',
  LUNA_GUEST_COMPOSER_BYPASS_ENABLED: 'true',
  LUNA_GUEST_UNIFIED_PLANNER_MODE: 'true',

  // WhatsApp UX — typing dots while Luna composes live replies
  LUNA_WHATSAPP_TYPING_INDICATOR_ENABLED: 'true',

  // Post-booking service Stripe links (optional — off until you want pay-now for add-ons)
  LUNA_GUEST_SERVICE_PAY_NOW_ENABLED: 'false',

  // Auto-send booking confirmation WhatsApp when payment truth is deposit_paid/paid (all phones)
  LUNA_AUTO_SEND_ENABLED: 'true',

  // Staff/Stripe gates for test checkout
  STAFF_ACTIONS_ENABLED: 'true',
  STRIPE_LINKS_ENABLED: 'true',
  PUBLIC_PAYMENT_BASE_URL: 'https://staff-staging.lunafrontdesk.com',
  STRIPE_CHECKOUT_PUBLIC_BASE_URL: 'https://staff-staging.lunafrontdesk.com',
  STRIPE_CHECKOUT_SUCCESS_URL: 'https://staff-staging.lunafrontdesk.com/staff/payment/success?session_id={CHECKOUT_SESSION_ID}',
  STRIPE_CHECKOUT_CANCEL_URL: 'https://staff-staging.lunafrontdesk.com/staff/payment/cancel',
});

const LUNA_GUEST_STAGING_V1_LABEL = 'luna-guest-staging-v1';

function applyLunaGuestStagingProfile(baseEnv, profile) {
  const p = profile || LUNA_GUEST_STAGING_V1;
  return { ...(baseEnv || process.env), ...p };
}

function describeLunaGuestStagingProfile(profile) {
  const p = profile || LUNA_GUEST_STAGING_V1;
  return {
    profile_id: LUNA_GUEST_STAGING_V1_LABEL,
    description: 'Frontdesk planner + transcript brain + Cami voice + composer bypass on intake; payment truth composer-owned',
    flags: { ...p },
    reply_ownership: {
      composer: 'payment-link + confirmation truth only (intake bypassed when COMPOSER_BYPASS on)',
      frontdesk_planner: 'sole intent owner when UNIFIED_PLANNER_MODE on (brain LLM + gpt-tool-planner off)',
      agent_brain: 'paid change + payment mismatch only',
      cami_author: 'voice-only rewrite — rejects replanning (package stall, blind choice, count/date drift)',
      writes: 'luna-guest-write-pipeline (hold → bed → deposit link → optional service add-ons)',
    },
  };
}

module.exports = {
  LUNA_GUEST_STAGING_V1,
  LUNA_GUEST_STAGING_V1_LABEL,
  applyLunaGuestStagingProfile,
  describeLunaGuestStagingProfile,
};
