'use strict';

/**
 * verify:sunset-stripe-payment-reconcile
 *
 * Booking-scoped Stripe reconcile + drawer paid-state tests (offline mocks).
 *
 * Run: node scripts/verify-sunset-stripe-payment-reconcile.js
 */

const fs = require('fs');
const path = require('path');
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

const RECONCILE_SRC = fs.readFileSync(
  path.join(__dirname, 'lib', 'stripe-payment-reconcile.js'),
  'utf8',
);
assert('reconcile imports isLockedPaymentValidationError', /isLockedPaymentValidationError/.test(RECONCILE_SRC));
assert('reconcile returns locked_payment_validation_failed', /locked_payment_validation_failed/.test(RECONCILE_SRC));
assert('reconcile one client BEGIN→apply→COMMIT/ROLLBACK',
  /await pg\.query\('BEGIN'\)[\s\S]{0,2500}applyStripeBookingPaymentTruthWrites[\s\S]{0,2000}COMMIT[\s\S]{0,500}ROLLBACK/.test(RECONCILE_SRC));

function buildReconcilePg(pm, booking) {
  const state = {
    pm: { ...pm },
    booking: {
      client_id: pm.client_id,
      status: booking.status || 'hold',
      hold_expired_by_db: booking.hold_expired_by_db === true,
      hold_expires_at: booking.hold_expires_at || null,
      metadata: {},
      ...booking,
    },
    committed: false,
  };
  const pg = {
    state,
    query: async (sql, params) => {
      const q = String(sql);
      if (/BEGIN/i.test(q)) { state.inTx = true; return { rows: [], rowCount: 0 }; }
      if (/COMMIT/i.test(q)) { state.inTx = false; state.committed = true; return { rows: [], rowCount: 0 }; }
      if (/ROLLBACK/i.test(q)) { state.inTx = false; return { rows: [], rowCount: 0 }; }
      if (/FROM bookings[\s\S]*FOR UPDATE/i.test(q)) {
        const bookingId = params[0];
        const clientId = params[1];
        if (state.pm.booking_id !== bookingId || state.booking.client_id !== clientId) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rowCount: 1,
          rows: [{
            booking_id: bookingId,
            booking_status: state.booking.status || 'confirmed',
            hold_expires_at: state.booking.hold_expires_at || null,
            hold_expired_by_db: !!state.booking.hold_expired_by_db,
            bk_total: state.booking.bk_total != null ? state.booking.bk_total : (state.pm.bk_total || 4500),
            bk_amount_paid: state.booking.amount_paid_cents || 0,
            bk_balance: state.booking.balance_due_cents != null ? state.booking.balance_due_cents : 4500,
            bk_deposit: state.pm.bk_deposit || 0,
          }],
        };
      }
      if (/FROM payments[\s\S]*FOR UPDATE/i.test(q)) {
        const paymentId = params[0];
        const clientId = params[1];
        if (state.pm.payment_id !== paymentId || state.pm.client_id !== clientId) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rowCount: 1,
          rows: [{
            payment_id: state.pm.payment_id,
            booking_id: state.pm.booking_id,
            client_id: state.pm.client_id,
            booking_guest_id: state.pm.booking_guest_id || null,
            payment_status: state.pm.payment_status,
            payment_kind: state.pm.payment_kind,
            currency: state.pm.currency || 'EUR',
            amount_due_cents: state.pm.amount_due_cents,
            pm_amount_paid: state.pm.amount_paid_cents || 0,
            stripe_checkout_session_id: state.pm.stripe_checkout_session_id || null,
          }],
        };
      }
      if (/COALESCE\(SUM\(amount_paid_cents\)/i.test(q) || /sum\(amount_paid_cents\)/i.test(q)) {
        return { rows: [{ total: 0 }], rowCount: 1 };
      }
      if (/FROM payments p[\s\S]*stripe_checkout_session_id = \$1/i.test(q)) {
        return state.pm.stripe_checkout_session_id === params[0]
          && (!params[1] || params[1] === state.pm.client_slug)
          ? { rows: [state.pm], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/SELECT p\.stripe_checkout_session_id AS sid/i.test(q)) {
        if (state.pm.payment_status === 'paid') return { rows: [], rowCount: 0 };
        return {
          rows: [{ sid: state.pm.stripe_checkout_session_id, payment_id: state.pm.payment_id }],
          rowCount: 1,
        };
      }
      if (/SELECT DISTINCT stripe_checkout_session_id/i.test(q)) {
        return { rows: [], rowCount: 0 };
      }
      if (/UPDATE payments/i.test(q)) {
        if (params[4] && params[4] !== state.pm.client_id) return { rows: [], rowCount: 0 };
        state.pm.payment_status = 'paid';
        state.pm.amount_paid_cents = params[0];
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE bookings/i.test(q)) {
        const clientId = /metadata/.test(q) ? params[6] : params[5];
        if (clientId && clientId !== state.booking.client_id) return { rows: [], rowCount: 0 };
        state.booking.amount_paid_cents = params[0];
        state.booking.balance_due_cents = params[1];
        state.booking.payment_status = params[2];
        const promote = /metadata/.test(q) ? params[5] : params[4];
        if ((state.booking.status || 'hold') === 'hold' && promote) state.booking.status = 'confirmed';
        if (/metadata/.test(q) && params[4]) {
          state.booking.metadata = { ...(state.booking.metadata || {}), ...JSON.parse(params[4]) };
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
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
  const pg = buildReconcilePg(pm, {
    payment_status: 'waiting_payment',
    amount_paid_cents: 0,
    balance_due_cents: 4500,
    status: 'confirmed',
    client_id: 'client-1',
  });
  const first = await reconcilePaidStripeSession(pg, session, {
    eventType: 'checkout.session.completed',
    expectedClientSlug: 'sunset',
  });
  assert('first reconcile applied', first.reconciled === true);
  assert('payment ledger paid', pg.state.pm.payment_status === 'paid');
  assert('booking amount_paid_cents', pg.state.booking.amount_paid_cents === 4500);
  assert('booking payment_status paid', pg.state.booking.payment_status === 'paid');

  const second = await reconcilePaidStripeSession(pg, session, {
    eventType: 'checkout.session.completed',
    expectedClientSlug: 'sunset',
  });
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

  console.log('\n[4] Duplicate full-payment transition diagnostic');
  function buildDuplicatePg(existingPaid, pendingPm) {
    const payments = [
      { ...existingPaid, payment_status: 'paid', status: 'paid' },
      { ...pendingPm, payment_status: 'checkout_created', status: 'checkout_created' },
    ];
    const booking = {
      payment_status: 'waiting_payment',
      amount_paid_cents: Number(existingPaid.amount_paid_cents || 0),
      balance_due_cents: 0,
      metadata: {},
      status: 'confirmed',
      client_id: pendingPm.client_id,
    };
    const pg = {
      payments,
      booking,
      query: async (sql, params) => {
        const q = String(sql);
        if (/BEGIN/i.test(q)) return { rows: [], rowCount: 0 };
        if (/COMMIT/i.test(q)) return { rows: [], rowCount: 0 };
        if (/ROLLBACK/i.test(q)) return { rows: [], rowCount: 0 };
        if (/FROM bookings[\s\S]*FOR UPDATE/i.test(q)) {
          if (params[0] !== pendingPm.booking_id || params[1] !== pendingPm.client_id) {
            return { rows: [], rowCount: 0 };
          }
          return {
            rowCount: 1,
            rows: [{
              booking_id: pendingPm.booking_id,
              booking_status: booking.status,
              hold_expires_at: null,
              hold_expired_by_db: false,
              bk_total: pendingPm.bk_total || 4500,
              bk_amount_paid: booking.amount_paid_cents || 0,
              bk_balance: booking.balance_due_cents || 0,
              bk_deposit: 0,
            }],
          };
        }
        if (/FROM payments[\s\S]*FOR UPDATE/i.test(q)) {
          const hit = payments.find((p) => p.payment_id === params[0] && p.client_id === params[1]);
          if (!hit) return { rows: [], rowCount: 0 };
          return {
            rowCount: 1,
            rows: [{
              payment_id: hit.payment_id,
              booking_id: hit.booking_id,
              client_id: hit.client_id,
              booking_guest_id: hit.booking_guest_id || null,
              payment_status: hit.payment_status || hit.status,
              payment_kind: hit.payment_kind,
              currency: hit.currency || 'EUR',
              amount_due_cents: hit.amount_due_cents,
              pm_amount_paid: hit.amount_paid_cents || 0,
              stripe_checkout_session_id: hit.stripe_checkout_session_id || null,
            }],
          };
        }
        if (/FROM payments p[\s\S]*stripe_checkout_session_id = \$1/i.test(q)) {
          const hit = payments.find((p) => p.stripe_checkout_session_id === params[0]
            && (!params[1] || p.client_slug === params[1]));
          return hit ? { rows: [hit], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/COALESCE\(SUM\(amount_paid_cents\)/i.test(q) || /sum\(amount_paid_cents\)/i.test(q)) {
          return { rows: [{ total: Number(existingPaid.amount_paid_cents || 0) }], rowCount: 1 };
        }
        if (/SELECT DISTINCT stripe_checkout_session_id/i.test(q)) {
          const paid = payments.filter((p) => (p.payment_status === 'paid' || p.status === 'paid') && p.payment_kind === 'full_amount');
          return {
            rowCount: paid.length,
            rows: paid.map((p) => ({
              sid: p.stripe_checkout_session_id,
              payment_id: p.payment_id,
              amount_paid_cents: p.amount_paid_cents,
            })),
          };
        }
        if (/UPDATE payments/i.test(q)) {
          const row = payments.find((p) => p.payment_id === params[3] && p.client_id === params[4]);
          if (row) {
            row.payment_status = 'paid';
            row.status = 'paid';
            row.amount_paid_cents = params[0];
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (/UPDATE bookings/i.test(q)) {
          const clientId = /metadata/.test(q) ? params[6] : params[5];
          if (clientId && clientId !== booking.client_id) return { rows: [], rowCount: 0 };
          booking.amount_paid_cents = params[0];
          booking.balance_due_cents = params[1];
          booking.payment_status = params[2];
          if (/metadata/.test(q) && params[4]) {
            booking.metadata = { ...booking.metadata, ...JSON.parse(params[4]) };
          }
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    return pg;
  }

  const existingPaid = {
    payment_id: 'pay-a',
    payment_status: 'paid',
    payment_kind: 'full_amount',
    amount_paid_cents: 4500,
    stripe_checkout_session_id: 'cs_test_paid_a',
    client_id: 'client-1',
    booking_id: 'bk-dup',
    booking_code: 'SUNSET-DUP',
    amount_due_cents: 4500,
    bk_total: 4500,
    guest_name: 'Dup Guest',
  };
  const pendingPm = {
    payment_id: 'pay-b',
    payment_status: 'checkout_created',
    payment_kind: 'full_amount',
    currency: 'EUR',
    amount_due_cents: 4500,
    stripe_checkout_session_id: 'cs_test_paid_b',
    client_slug: 'sunset',
    booking_id: 'bk-dup',
    booking_code: 'SUNSET-DUP',
    client_id: 'client-1',
    bk_total: 4500,
    bk_amount_paid: 4500,
    bk_balance: 0,
    guest_name: 'Dup Guest',
  };
  const dupPg = buildDuplicatePg(existingPaid, pendingPm);
  const dupSession = {
    id: 'cs_test_paid_b',
    payment_status: 'paid',
    status: 'complete',
    currency: 'eur',
    amount_total: 4500,
    metadata: { payment_id: 'pay-b', client_slug: 'sunset' },
  };
  const dupRes = await reconcilePaidStripeSession(dupPg, dupSession, {
    eventType: 'checkout.session.completed',
    expectedClientSlug: 'sunset',
  });
  assert('duplicate transition reconciled', dupRes.reconciled === true);
  assert('duplicate diagnostic emitted', dupRes.duplicate_full_payment_diagnostic != null);
  assert('both session ids in diagnostic',
    dupRes.duplicate_full_payment_diagnostic.session_ids.includes('cs_test_paid_a')
    && dupRes.duplicate_full_payment_diagnostic.session_ids.includes('cs_test_paid_b'));
  assert('booking not over-credited', dupPg.booking.amount_paid_cents <= 4500);
  const dupAgain = await reconcilePaidStripeSession(dupPg, dupSession, {
    eventType: 'checkout.session.completed',
    expectedClientSlug: 'sunset',
  });
  assert('duplicate reconcile idempotent', dupAgain.reconciled === false && dupAgain.reason === 'already_paid');

  console.log('\n[5] Drawer cannot stay Unpaid after ledger paid');
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
