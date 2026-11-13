'use strict';

/**
 * Offline proof for add-guest blockers 2 and 3 (Cap on 596ea450):
 *   2) saved booking total €449.50 but invoice stayed €300; €300 paid → balance €0 not €149.50
 *   3) per-guest amount calculator threw authoritative_guest_money_unavailable
 *      for deposit / full-share / remaining-share
 *
 * No network, no Stripe, no live bookings.
 */

const assert = require('node:assert/strict');
const { bookingLedgerInvoicePaidBalance } = require('./lib/booking-invoice-totals');
const addGuestAttach = require('./lib/luna-guest-addguest-attach');
const { amountFor } = require('./lib/per-guest-checkout');

const SEP_ADDED_GUEST_CENTS = 14950;
const SAMPLE_BOOKING_CENTS = 30000;
const SAMPLE_NEW_TOTAL_CENTS = SAMPLE_BOOKING_CENTS + SEP_ADDED_GUEST_CENTS;
const ENABLED_ENV = { OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true' };

function quoteSnap300() {
  return {
    total_cents: SAMPLE_BOOKING_CENTS,
    line_items: [{ code: 'guest_package', total_cents: SAMPLE_BOOKING_CENTS }],
  };
}

function invoiceAfterAddGuest(extraSvcCents, additionalSvcCents) {
  return bookingLedgerInvoicePaidBalance(
    {
      total_amount_cents: SAMPLE_NEW_TOTAL_CENTS,
      deposit_required_cents: 10000,
      metadata: {
        add_guest_origin: addGuestAttach.ADD_GUEST_ATTACH_ORIGIN,
        added_guest_names: ['Tom'],
        quote_snapshot: quoteSnap300(),
      },
    },
    extraSvcCents || 0,
    SAMPLE_BOOKING_CENTS,
    0,
    additionalSvcCents || 0,
  );
}

function makeFakePg(paymentStatus) {
  const state = { updates: [], insertedGuests: [] };
  const pg = {
    state,
    async query(sql, params) {
      const s = String(sql);
      if (/FROM bookings b/i.test(s) && /SELECT/i.test(s) && !/UPDATE/i.test(s)) {
        return {
          rows: [{
            booking_id: 'bk-1', booking_code: 'WH-SAMPLE', client_id: 'client-uuid-1',
            guest_count: 2, guest_name: 'John, Jane',
            total_amount_cents: SAMPLE_BOOKING_CENTS, amount_paid_cents: SAMPLE_BOOKING_CENTS,
            balance_due_cents: 0, deposit_required_cents: 10000,
            payment_status: paymentStatus,
            check_in: '2026-09-16', check_out: '2026-09-19',
            package_code: 'no_package', metadata: { quote_snapshot: quoteSnap300() },
          }],
        };
      }
      if (/UPDATE bookings/i.test(s)) { state.updates.push(params); return { rows: [], rowCount: 1 }; }
      if (/UPDATE payments/i.test(s)) {
        return { rows: [{ payment_draft_id: 'pay-draft-1', amount_due_cents: params[2] }], rowCount: 1 };
      }
      if (/INSERT INTO booking_guests/i.test(s)) {
        state.insertedGuests.push({ sql: s, params });
        return {
          rows: [{
            booking_guest_id: `bg-${state.insertedGuests.length}`,
            guest_number: params[2],
            guest_name: params[3],
            payment_status: 'not_requested',
          }],
        };
      }
      return { rows: [] };
    },
  };
  return pg;
}

function guestRowFromInsert(insert) {
  const params = insert.params;
  const sql = insert.sql;
  const depositFromSql = /,\s*0,\s*0,\s*'not_requested'/.test(sql);
  const deposit = depositFromSql ? 0 : Number(params[4]);
  const rawMd = depositFromSql ? params[4] : params[5];
  const md = typeof rawMd === 'string' ? JSON.parse(rawMd) : (rawMd || {});
  return {
    guest_metadata: md,
    deposit_amount_cents: deposit,
    amount_paid_cents: 0,
  };
}

async function main() {
  // ── Blocker 2: invoice must include added guest room charge ──────────────
  const noSvc = invoiceAfterAddGuest(0, 0);
  assert.equal(
    noSvc.invoice_total_cents,
    SAMPLE_NEW_TOTAL_CENTS,
    'blocker 2: invoice total equals saved booking total €449.50',
  );
  assert.equal(
    noSvc.balance_due_cents,
    SEP_ADDED_GUEST_CENTS,
    'blocker 2: €300 paid → balance €149.50 not €0',
  );

  const yoga = 3000;
  const withYoga = invoiceAfterAddGuest(yoga, yoga);
  assert.equal(
    withYoga.invoice_total_cents,
    SAMPLE_NEW_TOTAL_CENTS + yoga,
    'blocker 2: extra services sit on top of the added room charge',
  );
  assert.equal(
    withYoga.balance_due_cents,
    SEP_ADDED_GUEST_CENTS + yoga,
    'blocker 2: extra services do not hide the missing room charge',
  );

  // ── Blocker 3: added guest can price deposit / full / remaining ──────────
  const pg = makeFakePg('pending');
  const out = await addGuestAttach.addGuestToBooking(pg, {
    clientSlug: 'wolfhouse-somo',
    bookingId: 'bk-1',
    newGuestNames: ['Tom'],
    env: ENABLED_ENV,
    availabilityChecker: async () => ({ available: true, status: 'available', detail: {} }),
  });
  assert.equal(out.status, 'ok');
  assert.equal(out.new_total_amount_cents, SAMPLE_NEW_TOTAL_CENTS);
  assert.equal(pg.state.insertedGuests.length, 1, 'one guest row inserted');

  const row = guestRowFromInsert(pg.state.insertedGuests[0]);
  const depositDue = amountFor(row, 'deposit');
  const fullShare = amountFor(row, 'full');
  const remainingShare = amountFor(row, 'remaining');
  assert.equal(typeof depositDue, 'number');
  assert.ok(Number.isInteger(depositDue) && depositDue >= 0, 'deposit amount is a non-negative integer');
  assert.equal(fullShare, SEP_ADDED_GUEST_CENTS, 'full-share is the added guest room charge');
  assert.equal(remainingShare, SEP_ADDED_GUEST_CENTS, 'remaining-share is unpaid room charge');

  console.log('PASS verify-luna-add-guest-invoice-and-link', {
    invoice_total_cents: noSvc.invoice_total_cents,
    balance_due_cents: noSvc.balance_due_cents,
    with_yoga_invoice_cents: withYoga.invoice_total_cents,
    deposit_due: depositDue,
    full_share: fullShare,
    remaining_share: remainingShare,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
