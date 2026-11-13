'use strict';

/**
 * Split/separate without deposit vs full must not mint per-guest DEPOSIT links.
 * Booking still saves. Explicit deposit/full still create links.
 *
 * Usage: node scripts/verify-separate-no-tier-no-links.js
 */

const assert = require('node:assert/strict');
const {
  handleBotBookingCreateFromPlan,
  splitLinkPaymentTarget,
} = require('./lib/staff-bot-v2-routes');

assert.equal(splitLinkPaymentTarget(undefined), null);
assert.equal(splitLinkPaymentTarget(''), null);
assert.equal(splitLinkPaymentTarget('separate'), null);
assert.equal(splitLinkPaymentTarget('split'), 'deposit');
assert.equal(splitLinkPaymentTarget('deposit'), 'deposit');
assert.equal(splitLinkPaymentTarget('full'), 'full_share');

function makeResponseCapture() {
  const capture = { status: null, payload: null };
  return {
    capture,
    response: {
      setHeader() {},
      writeHead(status) { capture.status = status; },
      end(raw) { capture.payload = JSON.parse(raw); },
    },
    sendJSON(res, status, payload) {
      capture.status = status;
      capture.payload = payload;
      return payload;
    },
  };
}

async function runCreate(body) {
  const out = makeResponseCapture();
  const targets = [];
  await handleBotBookingCreateFromPlan({}, out.response, { staff_user_id: 'test' }, 'bot', {
    sendJSON: out.sendJSON,
    send400: out.sendJSON,
    readBody: async () => JSON.stringify(body),
    DEFAULT_CLIENT: 'wolfhouse-somo',
    STAFF_AUTH_REQUIRED: true,
    BOT_BOOKING_ENABLED: true,
    STRIPE_LINKS_ENABLED: true,
    STRIPE_SECRET_KEY: 'sk_test_lookout',
    handleBotBookingCreate: async (_req, res) => res.end(JSON.stringify({
      success: true,
      created: true,
      write_performed: true,
      booking_id: 'saved-separate-no-tier-1',
      booking_code: 'WH-SEPARATE-NO-TIER-1',
      uses_per_guest_model: true,
      booking_guests: (body.guests || [{}, {}]).map((g, i) => ({
        booking_guest_id: `guest-${i + 1}`,
        guest_number: i + 1,
        guest_name: g.name || `G${i + 1}`,
      })),
    })),
    handleBotGuestPaymentCreateLink: async (_id, req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      const parsed = JSON.parse(raw || '{}');
      targets.push(parsed.payment_target || null);
      res.end(JSON.stringify({
        success: true,
        booking_guest_id: _id,
        payment_target: parsed.payment_target,
        checkout_url: `https://example.test/${_id}`,
      }));
    },
  });
  return { payload: out.capture.payload, targets };
}

(async () => {
  const missing = await runCreate({
    client_slug: 'wolfhouse-somo',
    per_guest_payment_links: true,
    guests: [{ name: 'Ada' }, { name: 'Bea' }],
  });
  assert.equal(missing.payload.success, true, 'booking still saves');
  assert.equal(missing.payload.booking_id, 'saved-separate-no-tier-1');
  assert.equal(missing.targets.length, 0, 'no per-guest links without a tier');
  assert.equal(missing.payload.per_guest_payment_links_created, undefined);
  assert.equal(missing.payload.ask_payment_amount, true);
  assert.equal(missing.payload.safe_next_step, 'ask_deposit_or_full_payment');
  assert.equal(missing.payload.next_action, 'ask_deposit_or_full_payment');

  const separateOnly = await runCreate({
    client_slug: 'wolfhouse-somo',
    payment_distribution: 'separate',
    guests: [{ name: 'Ada' }, { name: 'Bea' }],
  });
  assert.equal(separateOnly.payload.success, true);
  assert.equal(separateOnly.payload.booking_id, 'saved-separate-no-tier-1');
  assert.equal(separateOnly.targets.length, 0, 'separate without tier does not mint deposit');

  const explicitSplit = await runCreate({
    client_slug: 'sunset',
    payment_choice: 'split',
    guests: [{ name: 'Gina' }, { name: 'Jamie' }, { name: 'Tina' }],
  });
  assert.equal(explicitSplit.payload.success, true);
  assert.equal(explicitSplit.payload.booking_id, 'saved-separate-no-tier-1');
  assert.deepEqual(explicitSplit.targets, ['deposit', 'deposit', 'deposit'], 'explicit split still mints deposit shares');
  assert.equal(explicitSplit.payload.per_guest_payment_links_created, 3);

  const deposit = await runCreate({
    client_slug: 'wolfhouse-somo',
    payment_choice: 'deposit',
    per_guest_payment_links: true,
    guests: [{ name: 'Ada' }, { name: 'Bea' }],
  });
  assert.equal(deposit.payload.success, true);
  assert.equal(deposit.payload.booking_id, 'saved-separate-no-tier-1');
  assert.deepEqual(deposit.targets, ['deposit', 'deposit'], 'explicit deposit still creates deposit links');
  assert.equal(deposit.payload.per_guest_payment_links_created, 2);

  const full = await runCreate({
    client_slug: 'wolfhouse-somo',
    payment_choice: 'full',
    per_guest_payment_links: true,
    guests: [{ name: 'Ada' }, { name: 'Bea' }],
  });
  assert.equal(full.payload.success, true);
  assert.equal(full.payload.booking_id, 'saved-separate-no-tier-1');
  assert.deepEqual(full.targets, ['full_share', 'full_share'], 'explicit full still creates full_share links');
  assert.equal(full.payload.per_guest_payment_links_created, 2);

  console.log('PASS separate-no-tier-no-links', {
    booking_id: missing.payload.booking_id,
    missing_links: missing.targets.length,
    deposit_links: deposit.targets.length,
    full_links: full.targets.length,
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
