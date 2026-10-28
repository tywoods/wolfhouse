'use strict';

// Executable regression for the Staff create-from-plan route.  This deliberately
// invokes the exported production route instead of inspecting its source.
const assert = require('node:assert/strict');
const {
  handleBotBookingCreateFromPlan,
  makeInMemoryBotReq,
} = require('./lib/staff-bot-v2-routes');

const DEPOSIT_CENTS = 20000;
const TOTAL_CENTS = 60000;
const GUESTS = [
  { booking_guest_id: '11111111-1111-4111-8111-111111111111', guest_number: 1, guest_name: 'One' },
  { booking_guest_id: '22222222-2222-4222-8222-222222222222', guest_number: 2, guest_name: 'Two' },
];

function responseCapture() {
  return {
    statusCode: 0, body: null,
    writeHead(code) { this.statusCode = code; },
    end(data) { this.body = JSON.parse(data); },
  };
}

async function run({ paymentChoice, separate = false }) {
  const linkRequests = [];
  const body = {
    client_slug: 'wolfhouse-somo', payment_choice: paymentChoice,
    per_guest_payment_links: separate,
    payment_distribution: separate ? 'separate' : 'together',
    guests: GUESTS.map(({ guest_name: name }) => ({ name })),
  };
  const req = { headers: {}, body };
  const readBody = async (request) => {
    if (request.body) return JSON.stringify(request.body);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  };
  const res = responseCapture();
  await handleBotBookingCreateFromPlan(req, res, {}, 'bot_token', {
    DEFAULT_CLIENT: 'wolfhouse-somo', STAFF_AUTH_REQUIRED: true,
    boundClientSlug: 'wolfhouse-somo', STRIPE_LINKS_ENABLED: true, STRIPE_SECRET_KEY: 'test-only',
    readBody,
    send400: (out, error) => { out.writeHead(400); out.end(JSON.stringify({ success: false, error })); },
    sendJSON: (out, status, payload) => { out.writeHead(status); out.end(JSON.stringify(payload)); return payload; },
    appendAuditLog: () => {}, makeInMemoryBotReq,
    handleBotBookingCreate: async (request, out) => {
      const create = JSON.parse(await readBody(request));
      assert.equal(create.payment_choice, paymentChoice, 'authoritative amount choice reaches Staff create');
      assert.equal(create.per_guest_payment_links, separate);
      const amount = paymentChoice === 'deposit' ? DEPOSIT_CENTS : TOTAL_CENTS;
      out.writeHead(201);
      out.end(JSON.stringify({
        success: true, created: true, write_performed: true,
        booking_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', booking_code: 'WH-ONEYES',
        payment_link_amount_cents: amount, quote: {
          deposit_required_cents: DEPOSIT_CENTS, total_cents: TOTAL_CENTS,
          payment_link_amount_cents: amount,
        },
        booking_guests: GUESTS,
      }));
    },
    handleBotGuestPaymentCreateLink: async (guestId, request, out) => {
      const link = JSON.parse(await readBody(request));
      linkRequests.push({ guestId, ...link });
      const full = link.payment_target === 'full_share';
      const amount = (full ? TOTAL_CENTS : DEPOSIT_CENTS) / GUESTS.length;
      const guest = GUESTS.find((row) => row.booking_guest_id === guestId);
      out.writeHead(200);
      out.end(JSON.stringify({
        success: true, booking_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        booking_code: 'WH-ONEYES', ...guest, payment_id: `pay-${guest.guest_number}`,
        currency: 'EUR', amount_due_cents: amount, payment_target: link.payment_target,
        stripe_checkout_session_id: `cs-${guest.guest_number}`,
        checkout_url: `https://checkout.stripe.com/c/pay/${guest.guest_number}`,
      }));
    },
  });
  assert.equal(res.statusCode, 201);
  return { result: res.body, linkRequests };
}

(async () => {
  for (const [choice, expected] of [['deposit', DEPOSIT_CENTS], ['full', TOTAL_CENTS]]) {
    const { result, linkRequests } = await run({ paymentChoice: choice });
    assert.equal(result.payment_link_amount_cents, expected,
      `${choice} choice must preserve its authoritative booking-link amount`);
    assert.deepEqual(linkRequests, [], 'together payment must not mint guest links');
  }

  for (const [choice, target, perGuest] of [
    ['deposit', 'deposit', DEPOSIT_CENTS / 2],
    ['full', 'full_share', TOTAL_CENTS / 2],
  ]) {
    const { result, linkRequests } = await run({ paymentChoice: choice, separate: true });
    assert.equal(linkRequests.length, 2);
    assert(linkRequests.every((request) => request.payment_target === target));
    assert.equal(result.per_guest_payment_links_created, 2);
    assert.deepEqual(result.guest_payment_links.map((link) => link.amount_due_cents),
      [perGuest, perGuest], `${choice} separate links must retain the selected amount per guest`);
    assert(result.guest_payment_links.every((link) => link.payment_target === target));
  }
  console.log('verify-classic-one-yes-staff-payment-links PASS');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });