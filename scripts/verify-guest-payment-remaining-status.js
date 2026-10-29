'use strict';

const assert = require('assert');
const { handleBotGuestPaymentStatus } = require('./lib/staff-bot-v2-routes');

async function callStatus(row, body = { booking_guest_id: '00000000-0000-0000-0000-000000000001' }) {
  let response = null;
  let sql = '';
  await handleBotGuestPaymentStatus({}, {}, null, 'bot_token', {
    DEFAULT_CLIENT: 'wolfhouse-somo',
    boundClientSlug: 'wolfhouse-somo',
    readBody: async () => JSON.stringify(body),
    send400: (_res, error) => { response = { status: 400, body: { success: false, error } }; },
    sendJSON: (_res, status, payload) => { response = { status, body: payload }; },
    withPgClient: async (work) => work({
      query: async (query) => {
        sql = query;
        return { rows: row ? [row] : [] };
      },
    }),
  });
  return { response, sql };
}

(async () => {
  const partial = await callStatus({
    booking_guest_id: 'g1', guest_number: 1, guest_name: 'Jonas',
    booking_id: 'b1', booking_code: 'WH-GROUP',
    deposit_amount_cents: 10000, amount_paid_cents: 10000,
    payment_status: 'paid', payment_id: 'p1',
    guest_metadata: { subtotal_cents: 12000 },
  });
  assert.strictEqual(partial.response.status, 200);
  assert.match(partial.sql, /bg\.metadata AS guest_metadata/);
  assert.strictEqual(partial.response.body.balance_due_cents, 2000);

  const unpaid = await callStatus({
    booking_guest_id: 'g2', guest_number: 2, guest_name: 'Lena',
    booking_id: 'b1', booking_code: 'WH-GROUP',
    deposit_amount_cents: 10000, amount_paid_cents: 0,
    payment_status: 'unpaid', payment_id: null,
    guest_metadata: { subtotal_cents: 12000 },
  });
  assert.strictEqual(unpaid.response.status, 200);
  assert.strictEqual(unpaid.response.body.balance_due_cents, 12000);

  const solo = await callStatus({
    booking_guest_id: 'g3', guest_number: 1, guest_name: 'Ana',
    booking_id: 'b2', booking_code: 'WH-SOLO',
    deposit_amount_cents: 10000, amount_paid_cents: 10000,
    payment_status: 'paid', payment_id: 'p2',
    guest_metadata: { subtotal_cents: 24000 },
  });
  assert.strictEqual(solo.response.body.balance_due_cents, 14000);

  const unknown = await callStatus({
    booking_guest_id: 'g4', guest_number: 1, guest_name: 'Unknown Share',
    booking_id: 'b3', booking_code: 'WH-UNKNOWN',
    deposit_amount_cents: 10000, amount_paid_cents: 10000,
    payment_status: 'paid', payment_id: 'p3', guest_metadata: {},
  });
  assert.strictEqual(unknown.response.status, 200);
  assert.strictEqual(unknown.response.body.balance_due_cents, null);

  console.log('verify-guest-payment-remaining-status: PASS');
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
