'use strict';
const assert = require('node:assert/strict');
const { assertSafeToolRequest } = require('./lib/model-led-luna/contracts');

async function main() {
  const uuid = '11111111-1111-4111-8111-111111111111';
  const bookingReference = 'WH-1';
  assert.doesNotThrow(() => assertSafeToolRequest('send_payment_link', {
    booking_reference: bookingReference, payment_scope: 'individual', guest_position: 1,
    payment_choice: 'deposit', operation_key: 'tom-deposit',
  }));
  assert.doesNotThrow(() => assertSafeToolRequest('send_payment_link', {
    booking_reference: bookingReference, payment_scope: 'booking', payment_choice: 'balance', operation_key: 'group-balance',
  }));
  const rejected = [
    { booking_reference: bookingReference, payment_scope: 'individual', guest_position: 'Tom', payment_choice: 'deposit', operation_key: 'x1' },
    { booking_reference: bookingReference, payment_scope: 'individual', guest_position: 0, payment_choice: 'full', operation_key: 'x2' },
    { booking_reference: bookingReference, payment_scope: 'booking', guest_position: 1, payment_choice: 'deposit', operation_key: 'x3' },
    { booking_reference: bookingReference, payment_scope: 'booking', payment_choice: 'card', operation_key: 'x4' },
    { booking_reference: bookingReference, payment_scope: 'booking', payment_choice: 'deposit', amount_cents: 10000, operation_key: 'x5' },
    { booking_reference: bookingReference, payment_choice: 'deposit', operation_key: 'x6' },
  ];
  for (const value of rejected) assert.throws(() => assertSafeToolRequest('send_payment_link', value));

  const group = require('./lib/model-led-luna/v3-group-checkout');
  const calls = [];
  const authority = group.createBookingCheckoutAuthority({
    withPgClient: async fn => fn({ query: async () => ({ rows: [{ active: false }] }) }),
    buildPaymentLinkCommand: opts => ({ ok: true, command: { ...opts, paymentTarget: opts.transportBody.payment_target } }),
    createPaymentLink: async (_pg, command, exec) => {
      calls.push({ command, exec });
      return { ok: true, body: { payment_id: 'pay-1', booking_code: 'WH-1', amount_due_cents: 20000,
        currency: 'EUR', checkout_url: 'https://checkout.stripe.com/c/pay', stripe_checkout_session_id: 'cs_test_1' } };
    },
    readStripeCheckout: async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay', livemode: false,
      status: 'open', payment_status: 'unpaid', amount_total: 20000, currency: 'eur', expires_at: Math.floor(Date.now()/1000)+3600,
      metadata: { client_slug: 'wolfhouse-somo', booking_id: uuid, payment_id: 'pay-1', payment_scope: 'booking' } }),
    paymentExecOpts: { loadBookingPaymentLedger: async () => ({ invoice_total_cents: 20000 }) },
  });
  const created = await authority.create({ bookingId: uuid, paymentChoice: 'deposit', operationKey: 'group-1', principalId: 'staff' });
  assert.equal(created.amountCents, 20000);
  assert.equal(created.scope, 'booking');
  assert.equal(calls.length, 1);
  console.log('PASS b2 contracts and booking checkout adapter');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
