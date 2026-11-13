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
const fs = require('node:fs');
const path = require('node:path');
const { bookingLedgerInvoicePaidBalance } = require('./lib/booking-invoice-totals');
const addGuestAttach = require('./lib/luna-guest-addguest-attach');
const checkout = require('./lib/per-guest-checkout');
const { amountFor } = checkout;

const SEP_ADDED_GUEST_CENTS = 14950;
const SAMPLE_BOOKING_CENTS = 30000;
const SAMPLE_NEW_TOTAL_CENTS = SAMPLE_BOOKING_CENTS + SEP_ADDED_GUEST_CENTS;
const BUNDLED_ORIGINAL_CENTS = 97500;
const BUNDLED_EMBEDDED_SVC_CENTS = 30000;
const BUNDLED_AFTER_ADD_CENTS = BUNDLED_ORIGINAL_CENTS + SEP_ADDED_GUEST_CENTS;
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

  const bundled = bookingLedgerInvoicePaidBalance(
    {
      total_amount_cents: BUNDLED_AFTER_ADD_CENTS,
      deposit_required_cents: 32500,
      metadata: {
        add_guest_origin: addGuestAttach.ADD_GUEST_ATTACH_ORIGIN,
        added_guest_names: ['Tom'],
        quote_snapshot: {
          total_cents: BUNDLED_ORIGINAL_CENTS,
          line_items: [{ code: 'guest_package', total_cents: BUNDLED_ORIGINAL_CENTS }],
        },
      },
    },
    BUNDLED_EMBEDDED_SVC_CENTS,
    32500,
    0,
    0,
  );
  assert.equal(
    bundled.invoice_total_cents,
    BUNDLED_AFTER_ADD_CENTS,
    'blocker 2 bundled: invoice is original €975 + room €149.50 = €1,124.50, not €1,424.50',
  );
  assert.equal(
    bundled.balance_due_cents,
    BUNDLED_AFTER_ADD_CENTS - 32500,
    'blocker 2 bundled: balance uses the non-double-counted invoice',
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

  const link = await proveAddedGuestPayLink();
  assert.equal(link.amount, SEP_ADDED_GUEST_CENTS, 'added guest link amount is €149.50');
  assert.ok(link.providerCreates >= 1, 'provider create was called (not blocked at unallocated receipt)');
  assert.match(String(link.url), /^https:\/\/checkout\.stripe\.com\//);
  assert.ok(Number(link.expires_at) > Math.floor(Date.now() / 1000), 'link is unexpired');

  console.log('PASS verify-luna-add-guest-invoice-and-link', {
    invoice_total_cents: noSvc.invoice_total_cents,
    balance_due_cents: noSvc.balance_due_cents,
    bundled_invoice_cents: bundled.invoice_total_cents,
    with_yoga_invoice_cents: withYoga.invoice_total_cents,
    deposit_due: depositDue,
    full_share: fullShare,
    remaining_share: remainingShare,
    link_amount: link.amount,
    link_url: link.url,
    provider_creates: link.providerCreates,
  });
}

async function proveAddedGuestPayLink() {
  const { PGlite } = require('@electric-sql/pglite');
  const C1 = '10000000-0000-4000-8000-000000000001';
  const B1 = '20000000-0000-4000-8000-000000000001';
  const G_ADDED = '30000000-0000-4000-8000-000000000099';
  const db = new PGlite();
  await db.exec(`
    CREATE TYPE payment_record_status AS ENUM ('draft','checkout_created','pending','paid','expired','cancelled','failed');
    CREATE TYPE payment_kind AS ENUM ('deposit_only','full_amount');
    CREATE TABLE clients (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
    CREATE TABLE bookings (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id),
      booking_code text, status text NOT NULL DEFAULT 'confirmed',
      guest_name text DEFAULT 'John, Jane, Tom', phone text DEFAULT '+349****6789', guest_count integer DEFAULT 3,
      check_in date DEFAULT '2026-09-16', check_out date DEFAULT '2026-09-19',
      deposit_required_cents integer DEFAULT 10000, total_amount_cents integer DEFAULT 44950, balance_due_cents integer DEFAULT 14950,
      metadata jsonb NOT NULL DEFAULT '{}');
    CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;
    CREATE TABLE payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES clients(id),
      booking_id uuid NOT NULL REFERENCES bookings(id), status payment_record_status NOT NULL DEFAULT 'draft',
      payment_kind payment_kind NOT NULL DEFAULT 'full_amount', currency char(3) NOT NULL DEFAULT 'EUR',
      amount_due_cents integer NOT NULL CHECK(amount_due_cents >= 0),
      amount_paid_cents integer NOT NULL DEFAULT 0 CHECK(amount_paid_cents >= 0),
      stripe_checkout_session_id text, checkout_url text, expires_at timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT NOW()
    );
  `);
  for (const migration of ['024_booking_guests.sql', '107_per_guest_checkout_authoritative_intent.sql']) {
    await db.exec(fs.readFileSync(path.join(__dirname, '../database/migrations', migration), 'utf8'));
  }
  await db.query('INSERT INTO clients VALUES ($1,$2)', [C1, 'wolfhouse-somo']);
  await db.query(
    `INSERT INTO bookings(id,client_id,booking_code,total_amount_cents,balance_due_cents)
     VALUES ($1,$2,'WH-ADDGUEST',$3,$4)`,
    [B1, C1, SAMPLE_NEW_TOTAL_CENTS, SEP_ADDED_GUEST_CENTS],
  );
  await db.query(
    `INSERT INTO booking_guests(id,client_id,booking_id,guest_number,guest_name,deposit_amount_cents,amount_paid_cents,metadata)
     VALUES ($1,$2,$3,3,'Tom',$4,0,$5::jsonb)`,
    [G_ADDED, C1, B1, 5000, JSON.stringify({
      source: addGuestAttach.ADD_GUEST_ATTACH_ORIGIN,
      add_guest_write_source: 'luna_guest',
      subtotal_cents: SEP_ADDED_GUEST_CENTS,
    })],
  );
  await db.query(
    `INSERT INTO payments(client_id,booking_id,booking_guest_id,status,amount_due_cents,amount_paid_cents,metadata)
     VALUES ($1,$2,NULL,'paid',$3,$3,'{\"source\":\"staff_cash\"}'::jsonb)`,
    [C1, B1, SAMPLE_BOOKING_CENTS],
  );

  const pg = {
    async query(sql, params) {
      const result = await db.query(sql, params);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  const calls = [];
  const sessions = new Map();
  const stripe = {
    checkout: {
      sessions: {
        async create(params, options) {
          calls.push({ method: 'create', params, options });
          if (!sessions.has(options.idempotencyKey)) {
            const id = 'cs_offline_addguest_' + (sessions.size + 1);
            sessions.set(options.idempotencyKey, {
              id,
              status: 'open',
              payment_status: 'unpaid',
              url: 'https://checkout.stripe.com/c/pay/' + id,
              expires_at: Math.floor(Date.now() / 1000) + 86400,
            });
          }
          return sessions.get(options.idempotencyKey);
        },
        async retrieve(id) {
          calls.push({ method: 'retrieve', id });
          return [...sessions.values()].find((s) => s.id === id);
        },
        async expire(id) {
          calls.push({ method: 'expire', id });
        },
      },
    },
  };

  const result = await checkout.run({
    withPgClient: (fn) => fn(pg),
    stripe,
    guestId: G_ADDED,
    clientSlug: 'wolfhouse-somo',
    actorId: 'offline-staff',
    paymentTarget: 'remaining_share',
    successUrl: 'https://example.invalid/success',
    cancelUrl: 'https://example.invalid/cancel',
  });
  return {
    amount: result.amount,
    url: result.session && result.session.url,
    expires_at: result.session && result.session.expires_at,
    providerCreates: calls.filter((c) => c.method === 'create').length,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
