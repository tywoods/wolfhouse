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

  let createdCalls = 0;
  const pendingAuthority = group.createBookingCheckoutAuthority({
    withPgClient: async fn => fn({ query: async () => ({ rows: [{ guest_active: false, other_group_active: true }] }) }),
    buildPaymentLinkCommand: () => { throw new Error('must not build'); },
  });
  await assert.rejects(() => pendingAuthority.create({ bookingId: uuid, paymentChoice: 'deposit', operationKey: 'new-group', principalId: 'staff' }),
    error => error.code === 'booking_payment_group_checkout_active');

  let capturedIntentKey = null;
  let expiredCalls = 0;
  const retryAuthority = group.createBookingCheckoutAuthority({
    withPgClient: async fn => fn({ query: async (sql, params) => {
      if (/AS guest_active/.test(sql)) { capturedIntentKey = params[1]; return { rows: [{ guest_active: false, other_group_active: false }] }; }
      if (/intent_key/.test(sql)) return { rows: [{ payment_id: 'pay-1', checkout_id: 'cs_test_1', intent_key: capturedIntentKey }] };
      return { rows: [] };
    } }),
    buildPaymentLinkCommand: opts => ({ ok: true, command: opts }),
    createPaymentLink: async () => { createdCalls += 1; return { ok: true, body: { payment_id: 'pay-1', amount_due_cents: 20000,
      currency: 'EUR', checkout_url: 'https://checkout.stripe.com/c/pay', stripe_checkout_session_id: 'cs_test_1' } }; },
    readStripeCheckout: async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay', livemode: false,
      status: 'open', payment_status: 'unpaid', amount_total: 20000, currency: 'eur', expires_at: Math.floor(Date.now()/1000)+3600,
      metadata: { client_slug: 'wolfhouse-somo', booking_id: uuid, payment_id: 'pay-1', payment_scope: 'booking' } }),
    expireStripeCheckout: async () => { expiredCalls += 1; },
  });
  await retryAuthority.create({ bookingId: uuid, paymentChoice: 'balance', operationKey: 'same-balance', principalId: 'staff' });
  assert.equal(expiredCalls, 0, 'same balance intent must not expire its own checkout');

  let recoveryRead = true;
  const recoveryAuthority = group.createBookingCheckoutAuthority({
    withPgClient: async fn => fn({ query: async (sql) => {
      if (/SELECT p.id::text payment_id/.test(sql) && recoveryRead) { recoveryRead = false; return { rows: [{ payment_id: 'pay-2', checkout_id: null }] }; }
      if (/SELECT p.id::text payment_id/.test(sql)) return { rows: [{ payment_id: 'pay-2', checkout_id: 'cs_test_recovered',
        checkout_url: 'https://checkout.stripe.com/c/recovered', amount_due_cents: 20000, currency: 'EUR', metadata: { payment_scope: 'booking' } }] };
      if (/AS guest_active/.test(sql)) return { rows: [{ guest_active: false, other_group_active: false }] };
      return { rows: [] };
    } }),
    buildPaymentLinkCommand: opts => ({ ok: true, command: opts }),
    createPaymentLink: async () => ({ ok: true, body: { payment_id: 'pay-2', amount_due_cents: 20000,
      currency: 'EUR', checkout_url: 'https://checkout.stripe.com/c/recovered', stripe_checkout_session_id: 'cs_test_recovered' } }),
    readStripeCheckout: async () => ({ id: 'cs_test_recovered', url: 'https://checkout.stripe.com/c/recovered', livemode: false,
      status: 'open', payment_status: 'unpaid', amount_total: 20000, currency: 'eur', expires_at: Math.floor(Date.now()/1000)+3600,
      metadata: { client_slug: 'wolfhouse-somo', booking_id: uuid, payment_id: 'pay-2', payment_scope: 'booking' } }),
  });
  const recovered = await recoveryAuthority.read({ bookingId: uuid, paymentChoice: 'deposit', operationKey: 'lost-response', principalId: 'staff' });
  assert.equal(recovered.checkoutId, 'cs_test_recovered');

  const recoveryMismatch = group.createBookingCheckoutAuthority({
    withPgClient: async fn => fn({ query: async () => ({ rows: [{ payment_id: 'pay-local', checkout_id: 'cs_test_bad',
      amount_due_cents: 20000, currency: 'EUR', metadata: { payment_scope: 'booking' }, checkout_url: 'https://checkout.stripe.com/c/bad' }] }) }),
    readStripeCheckout: async () => ({ id: 'cs_test_bad', url: 'https://checkout.stripe.com/c/bad', livemode: false,
      status: 'open', payment_status: 'unpaid', amount_total: 1, currency: 'eur', expires_at: Math.floor(Date.now()/1000)+3600,
      metadata: { client_slug: 'wolfhouse-somo', booking_id: uuid, payment_id: 'pay-local', payment_scope: 'booking' } }),
  });
  await assert.rejects(() => recoveryMismatch.read({ bookingId: uuid, paymentChoice: 'deposit', operationKey: 'bad-readback', principalId: 'staff' }),
    error => error.code === 'provider_readback_mismatch');

  // A creation-time payment shell is inert only when the booking carries the
  // fresh trusted-v3 provenance. Classic/unknown drafts remain fail closed.
  const overlapSql = [];
  const inertAuthority = group.createBookingCheckoutAuthority({
    withPgClient: async fn => fn({ query: async (sql) => {
      overlapSql.push(sql);
      if (/AS guest_active/.test(sql)) return { rows: [{ guest_active: false, other_group_active: false }] };
      return { rows: [] };
    } }),
    buildPaymentLinkCommand: opts => ({ ok: true, command: opts }),
    createPaymentLink: async () => ({ ok: true, body: { payment_id: 'pay-v3', amount_due_cents: 20000,
      currency: 'EUR', checkout_url: 'https://checkout.stripe.com/c/v3', stripe_checkout_session_id: 'cs_test_v3' } }),
    readStripeCheckout: async () => ({ id: 'cs_test_v3', url: 'https://checkout.stripe.com/c/v3', livemode: false,
      status: 'open', payment_status: 'unpaid', amount_total: 20000, currency: 'eur', expires_at: Math.floor(Date.now()/1000)+3600,
      metadata: { client_slug: 'wolfhouse-somo', booking_id: uuid, payment_id: 'pay-v3', payment_scope: 'booking' } }),
  });
  await inertAuthority.create({ bookingId: uuid, paymentChoice: 'deposit', operationKey: 'fresh-v3', principalId: 'staff' });
  assert.match(overlapSql[0], /luna_v3_provenance/);
  assert.match(overlapSql[0], /fresh_one_try/);
  assert.match(overlapSql[0], /amount_paid_cents/);
  console.log('PASS b2 contracts, exclusion, idempotent retry, and lost-response recovery');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
