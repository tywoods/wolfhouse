'use strict';

/**
 * verify:sunset-stripe-payment-reconcile
 *
 * Booking-scoped Stripe reconcile + drawer paid-state tests (offline mocks).
 *
 * Run: node scripts/verify-sunset-stripe-payment-reconcile.js
 */

const {
  reconcilePaidStripeSession,
  reconcilePendingStripePaymentsForBooking,
} = require('./lib/stripe-payment-reconcile');
const { buildPaymentSummary } = require('./lib/sunset-schedule-booking-drawer');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

function buildReconcilePg(pm, booking) {
  const state = { pm: { ...pm }, booking: { ...booking }, committed: false };
  const pg = {
    state,
    query: async (sql, params) => {
      const q = String(sql);
      if (/BEGIN/i.test(q)) { state.inTx = true; return { rows: [] }; }
      if (/COMMIT/i.test(q)) { state.inTx = false; state.committed = true; return { rows: [] }; }
      if (/ROLLBACK/i.test(q)) { state.inTx = false; return { rows: [] }; }
      if (/FROM payments p[\s\S]*stripe_checkout_session_id = \$1/i.test(q)) {
        return state.pm.stripe_checkout_session_id === params[0] ? { rows: [state.pm] } : { rows: [] };
      }
      if (/SELECT p\.stripe_checkout_session_id AS sid/i.test(q)) {
        if (state.pm.payment_status === 'paid') return { rows: [] };
        return { rows: [{ sid: state.pm.stripe_checkout_session_id, payment_id: state.pm.payment_id }] };
      }
      if (/sum\(amount_paid_cents\)/i.test(q)) return { rows: [{ total: 0 }] };
      if (/UPDATE payments/i.test(q)) {
        state.pm.payment_status = 'paid';
        state.pm.amount_paid_cents = params[0];
        return { rows: [] };
      }
      if (/UPDATE bookings/i.test(q)) {
        state.booking.amount_paid_cents = params[0];
        state.booking.balance_due_cents = params[1];
        state.booking.payment_status = params[2];
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return pg;
}

console.log('\nverify:sunset-stripe-payment-reconcile\n');

console.log('[1] reconcilePaidStripeSession marks paid');
(async () => {
  const pm = {
    payment_id: 'pay-1',
    payment_status: 'checkout_created',
    payment_kind: 'full_amount',
    currency: 'EUR',
    amount_due_cents: 4500,
    stripe_checkout_session_id: 'cs_test_frankie',
    client_slug: 'sunset',
    booking_id: 'bk-frankie',
    booking_code: 'SUNSET-20260802-FRK',
    client_id: 'client-1',
    bk_total: 4500,
    bk_amount_paid: 0,
    bk_balance: 4500,
    guest_name: 'Frankie',
  };
  const session = {
    id: 'cs_test_frankie',
    payment_status: 'paid',
    status: 'complete',
    currency: 'eur',
    amount_total: 4500,
    metadata: { payment_id: 'pay-1', client_slug: 'sunset' },
  };
  const pg = buildReconcilePg(pm, { payment_status: 'waiting_payment', amount_paid_cents: 0, balance_due_cents: 4500 });
  const first = await reconcilePaidStripeSession(pg, session, { eventType: 'checkout.session.completed' });
  assert('first reconcile applied', first.reconciled === true);
  assert('payment ledger paid', pg.state.pm.payment_status === 'paid');
  assert('booking amount_paid_cents', pg.state.booking.amount_paid_cents === 4500);
  assert('booking payment_status paid', pg.state.booking.payment_status === 'paid');

  const second = await reconcilePaidStripeSession(pg, session, { eventType: 'checkout.session.completed' });
  assert('idempotent second reconcile', second.reconciled === false && second.reason === 'already_paid');

  console.log('\n[2] reconcilePendingStripePaymentsForBooking scoped');
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (sid) => {
          if (sid !== 'cs_test_frankie') throw new Error('unexpected session');
          return session;
        },
      },
    },
  };
  const batch = await reconcilePendingStripePaymentsForBooking(pg, stripe, {
    clientSlug: 'sunset',
    bookingId: 'bk-frankie',
  });
  assert('booking reconcile checked pending', batch.checked >= 0);
  assert('booking reconcile returns results array', Array.isArray(batch.results));
  assert('errors observable when missing inputs', (await reconcilePendingStripePaymentsForBooking(null, null, {})).had_errors === true);

  console.log('\n[3] Drawer cannot stay Unpaid after ledger paid');
  const paidSummary = buildPaymentSummary([], {
    payment_status: 'waiting_payment',
    amount_paid_cents: 4500,
    metadata: {},
  }, [], 'config', 4500);
  assert('drawer UI paid when ledger paid', paidSummary.payment_status === 'paid');
  assert('balance zero when fully paid', paidSummary.balance_due_cents === 0);

  console.log(`\n── verify:sunset-stripe-payment-reconcile ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  if (fail > 0) process.exit(1);
})();
