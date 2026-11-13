'use strict';

// Adapter-only link-call proof. Real saved booking SQL is proved separately by
// verify-missing-payment-choice-always-saves.js; these receipts are synthetic.
const assert = require('node:assert/strict');
const { handleBotBookingCreateFromPlan } = require('./lib/staff-bot-v2-routes');
let networkAttempts = 0;
const denyNetwork = () => { networkAttempts++; throw Error('Network forbidden'); };
require('node:net').Socket.prototype.connect = denyNetwork;
require('node:tls').connect = denyNetwork;
for (const name of ['node:http', 'node:https']) {
  require(name).request = denyNetwork;
  require(name).get = denyNetwork;
}
globalThis.fetch = denyNetwork;

async function run({ pending, choice, retry = false }) {
  const targets = [];
  let output;
  const body = { client_slug: 'wolfhouse-somo', payment_link_distribution: 'separate',
    per_guest_payment_links: true, guests: [{ name: 'Offline A' }, { name: 'Offline B' }] };
  if (choice !== undefined) body.payment_choice = choice;
  await handleBotBookingCreateFromPlan({}, {}, null, 'bot', {
    readBody: async () => JSON.stringify(body),
    sendJSON: (_res, status, payload) => { output = { status, payload }; },
    send400: () => { throw Error('Unexpected 400'); },
    DEFAULT_CLIENT: 'wolfhouse-somo', STAFF_AUTH_REQUIRED: true, BOT_BOOKING_ENABLED: true,
    STRIPE_LINKS_ENABLED: true, STRIPE_SECRET_KEY: 'offline-no-credential',
    handleBotBookingCreate: async (_req, res) => {
      res.writeHead(retry ? 200 : 201);
      res.end(JSON.stringify({ success: true, created: !retry, write_performed: !retry,
        idempotent: retry, booking_id: 'offline-adapter-receipt', uses_per_guest_model: true,
        booking_guests: [{ booking_guest_id: 'offline-a' }, { booking_guest_id: 'offline-b' }],
        payment_choice_pending: pending, ask_payment_amount: pending,
        next_action: pending ? 'ask_deposit_or_full' : 'create_stripe_link' }));
    },
    handleBotGuestPaymentCreateLink: async (id, req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      const payload = JSON.parse(raw);
      targets.push(payload.payment_target);
      res.end(JSON.stringify({ success: true, booking_guest_id: id,
        payment_target: payload.payment_target, checkout_url: `https://checkout.invalid/${id}` }));
    },
  });
  assert.equal(output.status, retry ? 200 : 201);
  assert.equal(output.payload.success, true);
  assert.equal(output.payload.booking_id, 'offline-adapter-receipt');
  assert.equal(output.payload.payment_choice_pending, pending);
  assert.equal(output.payload.ask_payment_amount, pending);
  if (pending) {
    assert.deepEqual(targets, [], 'saved pending-tier receipt never permits guest link creation');
    assert.equal(output.payload.next_action, 'ask_deposit_or_full');
    assert.equal(output.payload.guest_payment_links, undefined);
    assert.notEqual(output.payload.staff_review_needed, true);
  } else {
    assert.deepEqual(targets, [choice === 'full' ? 'full_share' : 'deposit'].flatMap(x => [x, x]));
    assert.equal(output.payload.guest_payment_links.length, 2);
  }
}
(async () => {
  for (const retry of [false, true]) {
    for (const choice of [undefined, '', 'deposit']) await run({ pending: true, retry, choice });
  }
  for (const choice of ['deposit', 'full']) await run({ pending: false, choice });
  assert.equal(networkAttempts, 0);
  console.log('PASS pending-tier wrapper: no pending-tier link calls; explicit deposit/full create per-guest links; no network');
})().catch(error => { console.error(error); process.exitCode = 1; });
