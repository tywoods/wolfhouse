'use strict';

// Helper contract only. The PostgreSQL companion exercises real SQL failures.
const assert = require('node:assert/strict');
const {
  GuestPaymentStatusProjectionError,
  markGuestsPaymentLinkRequested,
  markGuestsPaidForBookingPayment,
} = require('./lib/booking-guest-payment-status');

(async () => {
  const input = { clientId: 'tenant', bookingId: 'booking', paymentId: 'payment', paymentStatus: 'paid' };
  for (const [writer, operation, statements] of [
    [markGuestsPaymentLinkRequested, 'payment_link_requested', 2],
    [markGuestsPaidForBookingPayment, 'booking_payment_paid', 1],
  ]) {
    for (let failAt = 0; failAt < statements; failAt += 1) {
      const cause = Object.assign(new Error('injected status UPDATE failure'), { code: '23514' });
      const calls = [];
      const pg = { query: async sql => {
        calls.push(sql);
        if (/^UPDATE/.test(sql) && calls.filter(s => /^UPDATE/.test(s)).length === failAt + 1) throw cause;
        return { rowCount: 1 };
      } };
      await assert.rejects(writer(pg, input), error => {
        assert.equal(error.name, 'GuestPaymentStatusProjectionError');
        assert.ok(error instanceof GuestPaymentStatusProjectionError);
        assert.equal(error.code, 'GUEST_PAYMENT_STATUS_PROJECTION_FAILED');
        assert.equal(error.operation, operation);
        assert.equal(error.cause, cause, 'original PostgreSQL error remains inspectable');
        return true;
      });
      assert.equal(calls.length, failAt + 1);
      assert.ok(calls.every(sql => /^UPDATE/.test(sql)), 'no hidden transaction control, rollback or prerequisite SELECT');
    }
    const calls = [];
    assert.equal(await writer({ query: async sql => { calls.push(sql); return { rowCount: 2 }; } }, input), 2);
    assert.equal(calls.length, statements);
    assert.ok(calls.every(sql => /^UPDATE/.test(sql)));
    console.log(`PASS typed projection failure and caller-owned transaction: ${operation}`);
  }
  const noQuery = { query: async () => assert.fail('guard should not query') };
  assert.equal(await markGuestsPaymentLinkRequested(noQuery, {}), 0);
  assert.equal(await markGuestsPaidForBookingPayment(noQuery, { ...input, paymentStatus: 'waiting_payment' }), 0);
  console.log('PASS missing input and unpaid-state no-op guards');
})().catch(error => { console.error(error); process.exitCode = 1; });
