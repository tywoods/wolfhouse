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
  PAYMENT_AFTER_HOLD_EXPIRY_META_KEY,
} = require('./lib/stripe-hold-promote-policy');

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

    if (/UPDATE payments p[\s\S]*status = 'cancelled'/i.test(text)) {
      const bookingId = params[0];
      const clientId = params[1];
      const statuses = params[2] || [];
      const meta = JSON.parse(params[3]);
      const cancelled = [];
      for (const [id, pm] of Object.entries(state.payments)) {
        if (pm.booking_id !== bookingId || pm.client_id !== clientId) continue;
        if (!statuses.includes(pm.status)) continue;
        if (Number(pm.amount_paid_cents || 0) > 0) continue;
        if (pm.status === 'paid') continue;
        pm.status = 'cancelled';
        pm.checkout_url = null;
        pm.metadata = Object.assign({}, pm.metadata || {}, meta);
        cancelled.push(id);
      }
      return { rowCount: cancelled.length, rows: cancelled.map((id) => ({ payment_id: id })) };
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
          checkout_url: 'https://checkout.stripe.test/x',
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
    assert('payment cancelled', summary.payments_cancelled === 1);
    assert('booking status expired', fake.state.bookings[BOOKING].status === 'expired');
    assert('worker metadata', !!fake.state.bookings[BOOKING].metadata[HOLD_EXPIRED_BY_WORKER_META_KEY]);
    assert('paid payment row untouched', fake.state.payments[PAYMENT].status === 'cancelled');
    assert('bed deleted', !fake.state.beds[BED]);
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

  console.log(`\n── verify:booking-hold-expiry ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
