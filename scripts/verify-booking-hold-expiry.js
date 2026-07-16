'use strict';

/**
 * verify:booking-hold-expiry (WB-4)
 *
 * Offline RED→GREEN for idempotent hold-expiry worker.
 *
 * Run: node scripts/verify-booking-hold-expiry.js
 */

const {
  expireDueBookingHolds,
  expireOneBookingHoldTx,
  selectDueHoldCandidates,
  isHoldDueForExpiry,
  isBookingPaidForHoldExpiry,
  HOLD_EXPIRED_BY_WORKER_META_KEY,
} = require('./lib/booking-hold-expiry');
const {
  decideStripeHoldPromote,
  applyStripeBookingPaymentTruthWrites,
  PAYMENT_AFTER_HOLD_EXPIRY_META_KEY,
} = require('./lib/stripe-hold-promote-policy');
const {
  resolveActionableCheckoutUrl,
} = require('./lib/luna-front-desk-payment-link-service');

const CLIENT_A = '11111111-1111-1111-1111-111111111111';
const CLIENT_B = '22222222-2222-2222-2222-222222222222';
const BOOKING = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PAYMENT = 'pppppppp-pppp-pppp-pppp-pppppppppppp';
const BED = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const NOW = new Date('2026-07-16T10:00:00.000Z');
const PAST = new Date('2026-07-16T09:00:00.000Z');
const FUTURE = new Date('2026-07-16T11:00:00.000Z');

let pass = 0;
let fail = 0;

function assert(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name);
    if (detail) console.log(`        ${detail}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeFakePg(seed = {}) {
  const state = {
    clients: Object.assign({
      [CLIENT_A]: { slug: 'wolfhouse-somo' },
      [CLIENT_B]: { slug: 'sunset' },
    }, seed.clients || {}),
    bookings: Object.assign({}, seed.bookings || {}),
    payments: Object.assign({}, seed.payments || {}),
    beds: Object.assign({}, seed.beds || {}),
    queries: [],
    begun: false,
    committed: false,
    rolledBack: false,
    bookingLocks: {},
    failOn: seed.failOn || null,
  };

  async function acquireBookingLock(id) {
    while (state.bookingLocks[id]) await sleep(5);
    state.bookingLocks[id] = true;
  }

  function releaseBookingLock(id) {
    delete state.bookingLocks[id];
  }

  async function query(sql, params) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    state.queries.push({ text, params });
    if (state.failOn && state.failOn(text, params, state)) {
      const err = new Error(state.failOn.message || 'forced_failure');
      err.code = state.failOn.code || 'forced_failure';
      throw err;
    }
    if (/^BEGIN$/i.test(text)) {
      state.begun = true;
      state.committed = false;
      state.rolledBack = false;
      state.txSnapshot = {
        bookings: JSON.parse(JSON.stringify(state.bookings)),
        payments: JSON.parse(JSON.stringify(state.payments)),
        beds: JSON.parse(JSON.stringify(state.beds)),
      };
      return { rowCount: 0, rows: [] };
    }
    if (/^COMMIT$/i.test(text)) {
      state.committed = true;
      state.txSnapshot = null;
      for (const id of Object.keys(state.bookingLocks)) releaseBookingLock(id);
      return { rowCount: 0, rows: [] };
    }
    if (/^ROLLBACK$/i.test(text)) {
      state.rolledBack = true;
      if (state.txSnapshot) {
        state.bookings = state.txSnapshot.bookings;
        state.payments = state.txSnapshot.payments;
        state.beds = state.txSnapshot.beds;
        state.txSnapshot = null;
      }
      for (const id of Object.keys(state.bookingLocks)) releaseBookingLock(id);
      return { rowCount: 0, rows: [] };
    }

    if (/FROM clients WHERE slug/i.test(text)) {
      const slug = params[0];
      const row = Object.entries(state.clients).find(([, c]) => c.slug === slug);
      return { rowCount: row ? 1 : 0, rows: row ? [{ client_id: row[0] }] : [] };
    }

    if (/FROM bookings b[\s\S]*hold_expires_at <=/i.test(text) && !/FOR UPDATE/i.test(text)) {
      const asOf = new Date(params[0]);
      const clientFilter = params[1];
      const rows = [];
      for (const [id, bk] of Object.entries(state.bookings)) {
        if (bk.status !== 'hold') continue;
        if (!bk.hold_expires_at) continue;
        if (new Date(bk.hold_expires_at) > asOf) continue;
        if (clientFilter && bk.client_id !== clientFilter) continue;
        const client = state.clients[bk.client_id];
        rows.push({
          booking_id: id,
          client_id: bk.client_id,
          location_id: bk.location_id || null,
          client_slug: client && client.slug,
          booking_code: bk.booking_code || id.slice(0, 8),
          hold_expires_at: bk.hold_expires_at,
          payment_status: bk.payment_status || 'waiting_payment',
        });
      }
      rows.sort((a, b) => new Date(a.hold_expires_at) - new Date(b.hold_expires_at));
      const limit = params[3];
      return { rowCount: Math.min(rows.length, limit), rows: rows.slice(0, limit) };
    }

    if (/FROM bookings b[\s\S]*FOR UPDATE/i.test(text)) {
      const bookingId = params[0];
      const clientId = params[1];
      await acquireBookingLock(bookingId);
      const bk = state.bookings[bookingId];
      if (!bk || bk.client_id !== clientId) {
        releaseBookingLock(bookingId);
        return { rowCount: 0, rows: [] };
      }
      const client = state.clients[bk.client_id];
      return {
        rowCount: 1,
        rows: [{
          booking_id: bookingId,
          client_id: bk.client_id,
          status: bk.status,
          payment_status: bk.payment_status || 'waiting_payment',
          hold_expires_at: bk.hold_expires_at,
          client_slug: client && client.slug,
        }],
      };
    }

    if (/FROM bookings[\s\S]*FOR UPDATE/i.test(text)) {
      const bookingId = params[0];
      const clientId = params[1];
      await acquireBookingLock(bookingId);
      const bk = state.bookings[bookingId];
      if (!bk || bk.client_id !== clientId) {
        releaseBookingLock(bookingId);
        return { rowCount: 0, rows: [] };
      }
      return {
        rowCount: 1,
        rows: [{
          booking_id: bookingId,
          booking_status: bk.status,
          hold_expires_at: bk.hold_expires_at || null,
          hold_expired_by_db: bk.status === 'expired' || !!bk.hold_expired_by_db,
          bk_total: bk.bk_total != null ? bk.bk_total : 50000,
          bk_amount_paid: bk.amount_paid_cents || 0,
          bk_balance: bk.balance_due_cents != null ? bk.balance_due_cents : 50000,
          bk_deposit: bk.bk_deposit != null ? bk.bk_deposit : 10000,
        }],
      };
    }

    if (/FROM payments[\s\S]*FOR UPDATE/i.test(text)) {
      const paymentId = params[0];
      const clientId = params[1];
      const pm = state.payments[paymentId];
      if (!pm || pm.client_id !== clientId) return { rowCount: 0, rows: [] };
      await sleep(1);
      return {
        rowCount: 1,
        rows: [{
          payment_id: paymentId,
          booking_id: pm.booking_id,
          client_id: pm.client_id,
          booking_guest_id: pm.booking_guest_id || null,
          payment_status: pm.status,
          payment_kind: pm.payment_kind || 'deposit_only',
          currency: pm.currency || 'EUR',
          amount_due_cents: pm.amount_due_cents != null ? pm.amount_due_cents : 10000,
          pm_amount_paid: pm.amount_paid_cents || 0,
          stripe_checkout_session_id: pm.stripe_checkout_session_id || null,
        }],
      };
    }

    if (/SUM\(amount_paid_cents\)/i.test(text) || /COALESCE\(SUM\(amount_paid_cents\)/i.test(text)) {
      const bookingId = params[0];
      const excludeId = params[1];
      const clientId = params[2];
      let total = 0;
      for (const [id, p] of Object.entries(state.payments)) {
        if (p.booking_id !== bookingId) continue;
        if (clientId && p.client_id !== clientId) continue;
        if (excludeId && id === excludeId) continue;
        if (p.status === 'paid') total += Number(p.amount_paid_cents || 0);
      }
      return { rowCount: 1, rows: [{ total }] };
    }

    if (/UPDATE payments/i.test(text) && /AND client_id = \$5/i.test(text)) {
      const paymentId = params[3];
      const clientId = params[4];
      const pm = state.payments[paymentId];
      if (!pm || pm.client_id !== clientId) return { rowCount: 0, rows: [] };
      pm.status = 'paid';
      pm.amount_paid_cents = params[0];
      pm.metadata = Object.assign({}, pm.metadata || {}, JSON.parse(params[2] || '{}'));
      return { rowCount: 1, rows: [] };
    }

    if (/UPDATE bookings/i.test(text) && /amount_paid_cents/i.test(text) && /AND client_id = \$/i.test(text)) {
      const hasMeta = /metadata/.test(text);
      const bookingId = params[3];
      const clientId = hasMeta ? params[6] : params[5];
      const promote = hasMeta ? params[5] : params[4];
      const payStatus = params[2];
      const paid = params[0];
      const balance = params[1];
      const metaMerge = hasMeta ? JSON.parse(params[4] || '{}') : null;
      const bk = state.bookings[bookingId];
      if (!bk || bk.client_id !== clientId) return { rowCount: 0, rows: [] };
      bk.amount_paid_cents = paid;
      bk.balance_due_cents = balance;
      bk.payment_status = payStatus;
      if (bk.status === 'hold' && promote) bk.status = 'confirmed';
      if (metaMerge) bk.metadata = Object.assign({}, bk.metadata || {}, metaMerge);
      return { rowCount: 1, rows: [] };
    }

    if (/FROM payments p/i.test(text) && /COUNT/i.test(text)) {
      const bookingId = params[0];
      const clientId = params[1];
      if (/status = 'paid'/i.test(text)) {
        let n = 0;
        for (const pm of Object.values(state.payments)) {
          if (pm.booking_id === bookingId && pm.client_id === clientId && pm.status === 'paid') n += 1;
        }
        return { rowCount: 1, rows: [{ n }] };
      }
      if (/ANY/i.test(text)) {
        const statuses = params[2] || [];
        let n = 0;
        for (const pm of Object.values(state.payments)) {
          if (pm.booking_id !== bookingId || pm.client_id !== clientId) continue;
          if (!statuses.includes(pm.status)) continue;
          if (Number(pm.amount_paid_cents || 0) > 0) continue;
          n += 1;
        }
        return { rowCount: 1, rows: [{ n }] };
      }
    }

    if (/FROM booking_beds/i.test(text) && /COUNT/i.test(text)) {
      const bookingId = params[0];
      const clientId = params[1];
      let n = 0;
      for (const bed of Object.values(state.beds)) {
        if (bed.booking_id === bookingId && bed.client_id === clientId) n += 1;
      }
      return { rowCount: 1, rows: [{ n }] };
    }

    if (/UPDATE bookings[\s\S]*status = 'expired'/i.test(text)) {
      const bookingId = params[0];
      const clientId = params[1];
      const meta = JSON.parse(params[2]);
      const bk = state.bookings[bookingId];
      if (!bk || bk.client_id !== clientId || bk.status !== 'hold') {
        return { rowCount: 0, rows: [] };
      }
      bk.status = 'expired';
      bk.metadata = Object.assign({}, bk.metadata || {}, meta);
      releaseBookingLock(bookingId);
      return { rowCount: 1, rows: [{ booking_id: bookingId }] };
    }

    if (/DELETE FROM booking_beds/i.test(text)) {
      const bookingId = params[0];
      const clientId = params[1];
      const deleted = [];
      for (const [id, bed] of Object.entries(state.beds)) {
        if (bed.booking_id === bookingId && bed.client_id === clientId) {
          deleted.push(id);
          delete state.beds[id];
        }
      }
      return { rowCount: deleted.length, rows: deleted.map((id) => ({ bed_row_id: id })) };
    }

    if (/UPDATE payments p/i.test(text) && /checkout_url = NULL/i.test(text)) {
      const bookingId = params[0];
      const clientId = params[1];
      const statuses = params[2] || [];
      const meta = JSON.parse(params[3]);
      const invalidated = [];
      for (const [id, pm] of Object.entries(state.payments)) {
        if (pm.booking_id !== bookingId || pm.client_id !== clientId) continue;
        if (!statuses.includes(pm.status)) continue;
        if (Number(pm.amount_paid_cents || 0) > 0) continue;
        if (pm.status === 'paid') continue;
        pm.checkout_url = null;
        pm.metadata = Object.assign({}, pm.metadata || {}, meta);
        invalidated.push(id);
      }
      return {
        rowCount: invalidated.length,
        rows: invalidated.map((id) => ({
          payment_id: id,
          payment_status: state.payments[id].status,
          stripe_checkout_session_id: state.payments[id].stripe_checkout_session_id || null,
        })),
      };
    }

    throw new Error(`unhandled fake pg query: ${text.slice(0, 120)}`);
  }

  return { query, state };
}

async function main() {
  console.log('\nverify:booking-hold-expiry (WB-4)\n');

  console.log('── Pure helpers ──');
  assert('isHoldDueForExpiry past hold', isHoldDueForExpiry({ status: 'hold', hold_expires_at: PAST }, NOW));
  assert('isHoldDueForExpiry future hold false', !isHoldDueForExpiry({ status: 'hold', hold_expires_at: FUTURE }, NOW));
  assert('isBookingPaidForHoldExpiry deposit_paid', isBookingPaidForHoldExpiry({ payment_status: 'deposit_paid' }, 0));
  assert('isBookingPaidForHoldExpiry paid payment row', isBookingPaidForHoldExpiry({ payment_status: 'waiting_payment' }, 1));

  console.log('\n── Due hold expires (apply) ──');
  {
    const fake = makeFakePg({
      bookings: {
        [BOOKING]: {
          client_id: CLIENT_A,
          status: 'hold',
          hold_expires_at: PAST.toISOString(),
          payment_status: 'waiting_payment',
          metadata: {},
        },
      },
      payments: {
        [PAYMENT]: {
          booking_id: BOOKING,
          client_id: CLIENT_A,
          status: 'checkout_created',
          amount_paid_cents: 0,
          amount_due_cents: 10000,
          payment_kind: 'deposit_only',
          currency: 'EUR',
          checkout_url: 'https://checkout.stripe.test/x',
          stripe_checkout_session_id: 'cs_test_hold_expiry_late',
          metadata: {},
        },
      },
      beds: {
        [BED]: { booking_id: BOOKING, client_id: CLIENT_A, bed_code: 'A1' },
      },
    });
    const summary = await expireDueBookingHolds(fake, { apply: true, now: NOW, batchSize: 10 });
    assert('expired count', summary.expired === 1, JSON.stringify(summary));
    assert('bed released', summary.beds_released === 1);
    assert('payment invalidated', summary.payments_invalidated === 1);
    assert('booking status expired', fake.state.bookings[BOOKING].status === 'expired');
    assert('worker metadata', !!fake.state.bookings[BOOKING].metadata[HOLD_EXPIRED_BY_WORKER_META_KEY]);
    assert('payment status preserved checkout_created', fake.state.payments[PAYMENT].status === 'checkout_created');
    assert('checkout_url cleared', fake.state.payments[PAYMENT].checkout_url == null);
    assert('stripe session id preserved',
      fake.state.payments[PAYMENT].stripe_checkout_session_id === 'cs_test_hold_expiry_late');
    assert('bed deleted', !fake.state.beds[BED]);
    const link = resolveActionableCheckoutUrl({
      bookingRow: { status: fake.state.bookings[BOOKING].status, metadata: fake.state.bookings[BOOKING].metadata },
      paymentRow: {
        payment_id: PAYMENT,
        payment_status: fake.state.payments[PAYMENT].status,
        checkout_url: fake.state.payments[PAYMENT].checkout_url,
        amount_paid_cents: 0,
      },
    });
    assert('expired booking link non-actionable', link.actionable === false);
  }

  console.log('\n── Not-due hold skipped ──');
  {
    const fake = makeFakePg({
      bookings: {
        [BOOKING]: {
          client_id: CLIENT_A,
          status: 'hold',
          hold_expires_at: FUTURE.toISOString(),
          payment_status: 'waiting_payment',
        },
      },
    });
    const candidates = await selectDueHoldCandidates(fake, { now: NOW });
    assert('not-due not selected', candidates.length === 0);
    const summary = await expireDueBookingHolds(fake, { apply: true, now: NOW });
    assert('not-due zero expired', summary.expired === 0);
  }

  console.log('\n── Paid booking skipped ──');
  {
    const fake = makeFakePg({
      bookings: {
        [BOOKING]: {
          client_id: CLIENT_A,
          status: 'hold',
          hold_expires_at: PAST.toISOString(),
          payment_status: 'deposit_paid',
        },
      },
    });
    const summary = await expireDueBookingHolds(fake, { apply: true, now: NOW });
    assert('paid booking skipped_paid', summary.skipped_paid === 1 && summary.expired === 0);
    assert('paid booking stays hold', fake.state.bookings[BOOKING].status === 'hold');
  }

  console.log('\n── Paid payment row skipped ──');
  {
    const fake = makeFakePg({
      bookings: {
        [BOOKING]: {
          client_id: CLIENT_A,
          status: 'hold',
          hold_expires_at: PAST.toISOString(),
          payment_status: 'waiting_payment',
        },
      },
      payments: {
        [PAYMENT]: { booking_id: BOOKING, client_id: CLIENT_A, status: 'paid', amount_paid_cents: 5000 },
      },
    });
    const summary = await expireDueBookingHolds(fake, { apply: true, now: NOW });
    assert('paid payment row skipped_paid', summary.skipped_paid === 1);
    assert('booking unchanged', fake.state.bookings[BOOKING].status === 'hold');
  }

  console.log('\n── Already expired not selected ──');
  {
    const fake = makeFakePg({
      bookings: {
        [BOOKING]: {
          client_id: CLIENT_A,
          status: 'expired',
          hold_expires_at: PAST.toISOString(),
          payment_status: 'waiting_payment',
        },
      },
    });
    const candidates = await selectDueHoldCandidates(fake, { now: NOW });
    assert('already expired not in scan', candidates.length === 0);
  }

  console.log('\n── Tenant mismatch skipped ──');
  {
    const fake = makeFakePg({
      bookings: {
        [BOOKING]: {
          client_id: CLIENT_A,
          status: 'hold',
          hold_expires_at: PAST.toISOString(),
          payment_status: 'waiting_payment',
        },
      },
    });
    const out = await expireOneBookingHoldTx(fake, {
      bookingId: BOOKING,
      clientId: CLIENT_B,
      now: NOW,
      apply: true,
    });
    assert('wrong client skipped_changed', out.skipped_changed === 1 && out.expired === 0);
    assert('booking still hold', fake.state.bookings[BOOKING].status === 'hold');
  }

  console.log('\n── Duplicate workers idempotent ──');
  {
    const fake = makeFakePg({
      bookings: {
        [BOOKING]: {
          client_id: CLIENT_A,
          status: 'hold',
          hold_expires_at: PAST.toISOString(),
          payment_status: 'waiting_payment',
          metadata: {},
        },
      },
    });
    const first = await expireOneBookingHoldTx(fake, {
      bookingId: BOOKING, clientId: CLIENT_A, now: NOW, apply: true,
    });
    const second = await expireOneBookingHoldTx(fake, {
      bookingId: BOOKING, clientId: CLIENT_A, now: NOW, apply: true,
    });
    assert('first expires', first.expired === 1);
    assert('second skipped_changed', second.skipped_changed === 1 && second.expired === 0);
    assert('still expired once', fake.state.bookings[BOOKING].status === 'expired');
  }

  console.log('\n── Rollback on error ──');
  {
    const fake = makeFakePg({
      bookings: {
        [BOOKING]: {
          client_id: CLIENT_A,
          status: 'hold',
          hold_expires_at: PAST.toISOString(),
          payment_status: 'waiting_payment',
        },
      },
    });
    fake.state.failOn = (text) => {
      if (/DELETE FROM booking_beds/i.test(text)) return true;
      return false;
    };
    fake.state.failOn.message = 'simulated_bed_delete_failure';
    fake.state.failOn.code = 'bed_fail';
    const out = await expireOneBookingHoldTx(fake, {
      bookingId: BOOKING, clientId: CLIENT_A, now: NOW, apply: true,
    });
    assert('rollback flagged', fake.state.rolledBack === true);
    assert('error recorded', out.errors.length === 1);
    assert('booking still hold after rollback', fake.state.bookings[BOOKING].status === 'hold');
  }

  console.log('\n── Dry-run no writes ──');
  {
    const fake = makeFakePg({
      bookings: {
        [BOOKING]: {
          client_id: CLIENT_A,
          status: 'hold',
          hold_expires_at: PAST.toISOString(),
          payment_status: 'waiting_payment',
        },
      },
      payments: {
        [PAYMENT]: {
          booking_id: BOOKING, client_id: CLIENT_A, status: 'checkout_created', amount_paid_cents: 0,
        },
      },
    });
    const summary = await expireDueBookingHolds(fake, { apply: false, now: NOW });
    assert('dry-run would expire', summary.expired === 1);
    assert('dry-run no booking write', fake.state.bookings[BOOKING].status === 'hold');
    assert('dry-run no payment write', fake.state.payments[PAYMENT].status === 'checkout_created');
  }

  console.log('\n── Paid payment never cancelled ──');
  {
    const paidId = 'paid-pay-id-0001';
    const fake = makeFakePg({
      bookings: {
        [BOOKING]: {
          client_id: CLIENT_A,
          status: 'hold',
          hold_expires_at: PAST.toISOString(),
          payment_status: 'waiting_payment',
          metadata: {},
        },
      },
      payments: {
        [paidId]: {
          booking_id: BOOKING, client_id: CLIENT_A, status: 'paid', amount_paid_cents: 10000,
        },
        [PAYMENT]: {
          booking_id: BOOKING, client_id: CLIENT_A, status: 'checkout_created', amount_paid_cents: 0,
        },
      },
    });
    const summary = await expireDueBookingHolds(fake, { apply: true, now: NOW });
    assert('skipped because paid row exists', summary.skipped_paid === 1);
    assert('paid row still paid', fake.state.payments[paidId].status === 'paid');
    assert('checkout row untouched when skip', fake.state.payments[PAYMENT].status === 'checkout_created');
  }

  console.log('\n── Late payment no-revival (stripe-hold-promote-policy) ──');
  {
    const decision = decideStripeHoldPromote(
      { booking_status: 'expired', hold_expires_at: PAST.toISOString() },
      { newBkPayStatus: 'deposit_paid' },
    );
    assert('expired booking no promote', !decision.promote_to_confirmed);
    assert('expired booking no auto-confirm', !decision.allow_auto_confirmation);
    assert('payment_after_hold_expiry flag', decision.payment_after_hold_expiry === true);
    assert('metadata patch key', decision.metadata_patch && decision.metadata_patch[PAYMENT_AFTER_HOLD_EXPIRY_META_KEY]);
  }

  console.log('\n── Integration: expire → non-actionable link → late Stripe apply ──');
  {
    const sessionId = 'cs_test_late_after_expiry';
    const fake = makeFakePg({
      bookings: {
        [BOOKING]: {
          client_id: CLIENT_A,
          status: 'hold',
          hold_expires_at: PAST.toISOString(),
          payment_status: 'waiting_payment',
          amount_paid_cents: 0,
          balance_due_cents: 50000,
          bk_total: 50000,
          bk_deposit: 10000,
          metadata: {},
        },
      },
      payments: {
        [PAYMENT]: {
          booking_id: BOOKING,
          client_id: CLIENT_A,
          status: 'checkout_created',
          amount_paid_cents: 0,
          amount_due_cents: 10000,
          payment_kind: 'deposit_only',
          currency: 'EUR',
          checkout_url: 'https://checkout.stripe.test/late',
          stripe_checkout_session_id: sessionId,
          metadata: {},
        },
      },
    });

    const summary = await expireDueBookingHolds(fake, { apply: true, now: NOW });
    assert('integration expired', summary.expired === 1);
    assert('integration session preserved',
      fake.state.payments[PAYMENT].stripe_checkout_session_id === sessionId);
    assert('integration status still checkout_created',
      fake.state.payments[PAYMENT].status === 'checkout_created');
    assert('integration checkout cleared', fake.state.payments[PAYMENT].checkout_url == null);

    const resolved = resolveActionableCheckoutUrl({
      bookingRow: {
        status: fake.state.bookings[BOOKING].status,
        metadata: fake.state.bookings[BOOKING].metadata,
      },
      paymentRow: {
        payment_id: PAYMENT,
        payment_status: fake.state.payments[PAYMENT].status,
        checkout_url: fake.state.payments[PAYMENT].checkout_url,
        amount_paid_cents: 0,
        amount_due_cents: 10000,
      },
    });
    assert('integration link non-actionable', resolved.actionable === false);

    await fake.query('BEGIN');
    const truth = await applyStripeBookingPaymentTruthWrites(fake, {
      pm: {
        payment_id: PAYMENT,
        booking_id: BOOKING,
        client_id: CLIENT_A,
        payment_status: 'checkout_created',
        payment_kind: 'deposit_only',
        amount_due_cents: 10000,
        currency: 'EUR',
        stripe_checkout_session_id: sessionId,
      },
      session: {
        id: sessionId,
        amount_total: 10000,
        currency: 'eur',
        payment_intent: 'pi_test_late',
        metadata: { payment_id: PAYMENT, client_slug: 'wolfhouse-somo' },
      },
      stripePaidCents: 10000,
      paymentMetadataPatch: { source: 'wb4_late_stripe_integration' },
      buildBookingMetaMerge: ({ money, decision }) => {
        const merge = {};
        if (decision && decision.metadata_patch) Object.assign(merge, decision.metadata_patch);
        return merge;
      },
    });
    await fake.query('COMMIT');

    assert('integration payment becomes paid', fake.state.payments[PAYMENT].status === 'paid');
    assert('integration money recorded on payment',
      Number(fake.state.payments[PAYMENT].amount_paid_cents) === 10000);
    assert('integration booking remains expired', fake.state.bookings[BOOKING].status === 'expired');
    assert('integration booking money recorded',
      Number(fake.state.bookings[BOOKING].amount_paid_cents) === 10000);
    assert('integration no auto-confirmation',
      truth.decision && truth.decision.allow_auto_confirmation === false);
    assert('integration no promote',
      truth.decision && truth.decision.promote_to_confirmed === false);
    assert('integration payment_after_hold_expiry',
      truth.decision && truth.decision.payment_after_hold_expiry === true);
  }

  console.log(`\n── verify:booking-hold-expiry ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
