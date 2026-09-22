#!/usr/bin/env node
'use strict';

/**
 * Offline contract for WOLFHOUSE-LIVE-SIM-BOOKING-GENDER-001.
 * Does not call a live simulator, Stripe, or a database.
 */

const assert = require('assert');
const {
  evaluateWolfhouseSimulatorEffectBudget,
  handleBotBookingCreateFromPlan,
  handleBotPaymentCreateStripeLink,
} = require('./lib/staff-bot-v2-routes');
const {
  deriveAllocatorContext,
  rejectIncompatiblePreselectedBeds,
} = require('./lib/luna-bed-allocator');

function ok(label, condition) {
  assert.ok(condition, label);
  console.log(`ok - ${label}`);
}

const denied = evaluateWolfhouseSimulatorEffectBudget({
  simulator_synthetic: true,
  source_owner: 'crowsnest-guest-door',
  wolfhouse_staging_capability: 'wolfhouse_staging_booking_test_link',
  client_slug: 'wolfhouse-somo',
}, {
  BOT_BOOKING_ENABLED: true,
  STRIPE_SECRET_KEY: 'sk_live_not_for_simulator',
  PUBLIC_PAYMENT_BASE_URL: 'https://staff-staging.lunafrontdesk.com',
});
ok('live stripe claim is an intentional block', denied.ok === false && denied.outcome === 'INTENTIONALLY_BLOCKED' && denied.reasons.includes('live_stripe_key_blocked'));

const admitted = evaluateWolfhouseSimulatorEffectBudget({
  simulator_synthetic: true,
  source_owner: 'crowsnest-guest-door',
  wolfhouse_staging_capability: 'wolfhouse_staging_booking_test_link',
  client_slug: 'wolfhouse-somo',
}, {
  BOT_BOOKING_ENABLED: true,
  STRIPE_SECRET_KEY: 'sk_test_wolfhouse_staging_fixture',
  PUBLIC_PAYMENT_BASE_URL: 'https://staff-staging.lunafrontdesk.com',
  WOLFHOUSE_STRIPE_MODE: 'test',
});
ok('approved staging claim skips nested transfers', admitted.ok === true && admitted.skip_transfers === true);

const ordinary = evaluateWolfhouseSimulatorEffectBudget({ client_slug: 'wolfhouse-somo' }, {
  BOT_BOOKING_ENABLED: true,
  STRIPE_SECRET_KEY: 'sk_test_wolfhouse_staging_fixture',
});
ok('ordinary Wolfhouse create is not captured by the simulator budget', ordinary.claimed === false && ordinary.skip_transfers === false);

const ctx = deriveAllocatorContext({ guestCount: 1, groupGender: 'male', roomPreference: 'female_only' });
ok('allocator does not let female_only rewrite explicit male', ctx.groupGender === 'male' && ctx.needsClarification === true);
const stale = rejectIncompatiblePreselectedBeds({
  selectedBedCodes: ['R5-1'],
  bedRows: [{ bed_code: 'R5-1', room_code: 'R5', room_type: 'female_only' }],
  groupGender: 'male',
});
ok('stale all-female bed codes are rejected', stale.ok === false);

const claim = {
  simulator_synthetic: true,
  source_owner: 'crowsnest-guest-door',
  wolfhouse_staging_capability: 'wolfhouse_staging_booking_test_link',
  client_slug: 'wolfhouse-somo',
};

function deniedCtx() {
  const captured = { status: null, payload: null };
  return {
    captured,
    sendJSON(_res, status, payload) {
      captured.status = status;
      captured.payload = payload;
    },
    send400() {
      captured.status = 400;
      captured.payload = null;
    },
    readBody: async () => JSON.stringify(claim),
    appendAuditLog: async () => { throw new Error('audit must not run on a blocked simulator claim'); },
    makeInMemoryBotReq() { throw new Error('create must not delegate on a blocked simulator claim'); },
    withPgClient: async () => { throw new Error('db must not run on a blocked simulator claim'); },
    DEFAULT_CLIENT: 'wolfhouse-somo',
    STAFF_AUTH_REQUIRED: true,
    BOT_BOOKING_ENABLED: true,
    STRIPE_LINKS_ENABLED: true,
    STRIPE_SECRET_KEY: 'not-a-real-key',
    WOLFHOUSE_STRIPE_MODE: 'live',
    PUBLIC_PAYMENT_BASE_URL: 'https://staff-staging.lunafrontdesk.com',
    stripeCheckoutRedirectUrlsConfigured: () => true,
  };
}

(async () => {
  const createCtx = deniedCtx();
  await handleBotBookingCreateFromPlan({}, {}, { staff_user_id: 'verifier' }, 'bot', createCtx);
  ok('create handler blocks a live-mode simulator claim before any write',
    createCtx.captured
    && createCtx.captured.status === 403
    && createCtx.captured.payload.outcome === 'INTENTIONALLY_BLOCKED'
    && createCtx.captured.payload.write_performed === false
    && createCtx.captured.payload.do_not_escalate === true);

  const linkCtx = deniedCtx();
  await handleBotPaymentCreateStripeLink('11111111-1111-4111-8111-111111111111', {}, {}, { staff_user_id: 'verifier' }, 'bot', linkCtx);
  ok('stripe-link handler blocks the same claim before Stripe or the database',
    linkCtx.captured
    && linkCtx.captured.status === 403
    && linkCtx.captured.payload.intentional_capability_block === true
    && linkCtx.captured.payload.write_performed === false);

  console.log('verify:wolfhouse-live-sim-booking-gender-001 passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
