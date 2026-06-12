/**
 * Stage 50e — Post-booking add-on attach + service payment link verifier.
 *
 * Usage:
 *   node scripts/verify-stage50e-guest-service-payment-tools.js
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const {
  hasServiceAttachIntent,
  evaluateWriteToolReadiness,
  buildDeterministicWriteToolPlan,
} = require('./lib/luna-guest-agent-write-tool-executor');
const {
  shouldAllowGuestServicePaymentLinkCreate,
  confirmServicePaymentLinkApproved,
} = require('./lib/luna-guest-addon-service-payment-link-create');
const {
  isGuestServicePayNowEnabled,
  runGuestGptWriteToolPlanner,
} = require('./lib/luna-guest-gpt-write-tool-planner');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

const BOOKING_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const SERVICE_ENV = {
  ...process.env,
  LUNA_GUEST_GPT_WRITE_TOOLS_ENABLED: 'true',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  STAFF_ACTIONS_ENABLED: 'true',
  STRIPE_LINKS_ENABLED: 'true',
  NODE_ENV: 'staging',
};

const POST_BOOKING_CHAIN = {
  result: {
    message_lane: 'add_service_request',
    extracted_fields: {
      check_in: '2026-06-19',
      check_out: '2026-06-29',
      guest_count: 3,
      service_interest: ['yoga_class', 'meals'],
      yoga_request: 'yes please',
    },
  },
  quote: { quote_status: 'ready' },
  payment_choice: { payment_choice_ready: false },
};

(async () => {
  console.log('\nverify-stage50e-guest-service-payment-tools.js  (Stage 50e)\n');

  section('A. Service attach intent detection');
  {
    check('A1', hasServiceAttachIntent({ service_interest: ['surfboard'] }), 'gear interest');
    check('A2', hasServiceAttachIntent({ yoga_request: 'yes' }), 'yoga request');
    check('A3', !hasServiceAttachIntent({ guest_count: 3 }), 'no intent without services');
  }

  section('B. Post-booking deterministic plan');
  {
    const plan = buildDeterministicWriteToolPlan(POST_BOOKING_CHAIN, {
      env: SERVICE_ENV,
      booking_id: BOOKING_ID,
      message_text: 'can we add yoga and dinners?',
    });
    const ids = plan.map((p) => p.tool_id);
    check('B1', ids.includes('attach_post_booking_services'), 'plans attach');
    check('B2', !ids.includes('create_booking_hold'), 'no hold on post-booking');
  }

  section('C. Service payment link plan when pay-now enabled');
  {
    const plan = buildDeterministicWriteToolPlan(POST_BOOKING_CHAIN, {
      env: { ...SERVICE_ENV, LUNA_GUEST_SERVICE_PAY_NOW_ENABLED: 'true' },
      booking_id: BOOKING_ID,
    });
    const ids = plan.map((p) => p.tool_id);
    check('C1', ids.includes('create_service_payment_link'), 'plans service payment link');
    check('C2', isGuestServicePayNowEnabled({ LUNA_GUEST_SERVICE_PAY_NOW_ENABLED: 'true' }), 'pay now flag');
  }

  section('D. Attach readiness gates');
  {
    const blocked = evaluateWriteToolReadiness('attach_post_booking_services', POST_BOOKING_CHAIN, {
      env: SERVICE_ENV,
    });
    check('D1', blocked.ready === false, 'blocked without booking_id');
    check('D2', blocked.block_reasons.includes('booking_id_missing'), 'booking_id reason');

    const ready = evaluateWriteToolReadiness('attach_post_booking_services', POST_BOOKING_CHAIN, {
      env: SERVICE_ENV,
      booking_id: BOOKING_ID,
      pg: { query: async () => ({ rows: [] }) },
      confirm_write: true,
    });
    check('D3', ready.ready === true, 'ready with booking + intent + pg');
  }

  section('E. Service payment link gates');
  {
    const blocked = shouldAllowGuestServicePaymentLinkCreate({
      booking_id: BOOKING_ID,
      service_record_ids: [],
    }, { env: SERVICE_ENV, confirm_service_payment_link: false });
    check('E1', blocked.allowed === false, 'blocked without confirm');
    check('E2', blocked.reasons.includes('confirm_service_payment_link_required'), 'confirm reason');

    const noFlag = shouldAllowGuestServicePaymentLinkCreate({
      booking_id: BOOKING_ID,
    }, {
      env: SERVICE_ENV,
      confirm_service_payment_link: true,
      host_header: 'staff-staging.lunafrontdesk.com',
    });
    check('E3', noFlag.allowed === false, 'blocked without SERVICE_PAY_NOW flag');
    check('E4', noFlag.reasons.includes('LUNA_GUEST_SERVICE_PAY_NOW_ENABLED_required'), 'pay now flag reason');

    const allowed = shouldAllowGuestServicePaymentLinkCreate({
      booking_id: BOOKING_ID,
    }, {
      env: {
        ...SERVICE_ENV,
        LUNA_GUEST_SERVICE_PAY_NOW_ENABLED: 'true',
        STRIPE_SECRET_KEY: 'sk_test_fake',
        STRIPE_CHECKOUT_SUCCESS_URL: 'https://staff-staging.lunafrontdesk.com/staff/payment/success?session_id={CHECKOUT_SESSION_ID}',
        STRIPE_CHECKOUT_CANCEL_URL: 'https://staff-staging.lunafrontdesk.com/staff/payment/cancel',
      },
      confirm_service_payment_link: true,
      host_header: 'staff-staging.lunafrontdesk.com',
    });
    check('E5', allowed.allowed === true, 'allowed with all gates');
    check('E6', confirmServicePaymentLinkApproved({ confirm_service_payment_link: true }), 'confirm helper');
  }

  section('F. Write planner includes service tools post-booking');
  {
    const out = await runGuestGptWriteToolPlanner({
      message_text: 'add yoga and send me a payment link for the extras',
      chain_snapshot: POST_BOOKING_CHAIN,
      booking_id: BOOKING_ID,
      client_slug: 'wolfhouse-somo',
    }, {
      env: {
        ...SERVICE_ENV,
        LUNA_GUEST_SERVICE_PAY_NOW_ENABLED: 'true',
        LUNA_GUEST_GPT_WRITE_TOOLS_ACTIVE: 'false',
      },
      exec_ctx: { booking_id: BOOKING_ID },
    });
    check('F1', out.planned_tools.includes('attach_post_booking_services'), 'attach in plan');
    check('F2', out.planned_tools.includes('create_service_payment_link'), 'service link in plan');
    check('F3', out.service_pay_now_enabled === true, 'service pay flag observed');
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
