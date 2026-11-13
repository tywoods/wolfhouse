'use strict';

/**
 * (a) Checkout must move bookings.payment_status off not_requested
 *     to payment_link_sent (Staff enum — not the overlay).
 * (b) Per-guest checkout must cancel the unscoped booking-level
 *     deposit_only draft so no leftover €600 row remains.
 *
 * Never overwrites paid/deposit_paid. Never blocks a booking save.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  markBookingPaymentRequestedAfterCheckout,
  voidUnscopedDepositDraftAfterPerGuestCheckout,
} = require('./lib/booking-payment-requested-after-checkout');

const BOOKING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

function fakePg() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params: params || [] });
      return { rows: [], rowCount: 1 };
    },
  };
}

async function main() {
  const pgA = fakePg();
  await markBookingPaymentRequestedAfterCheckout(pgA, {
    bookingId: BOOKING,
    clientId: CLIENT,
  });
  assert.equal(pgA.calls.length, 1, 'marks booking once');
  const markSql = pgA.calls[0].sql;
  assert.match(markSql, /UPDATE bookings/i);
  assert.match(markSql, /payment_status\s*=\s*'payment_link_sent'/i);
  assert.match(markSql, /payment_status\s*=\s*'not_requested'/i,
    'only leaves not_requested; paid stays paid');
  assert.equal(pgA.calls[0].params[0], BOOKING);
  assert.equal(pgA.calls[0].params[1], CLIENT);

  const pgPaid = fakePg();
  await markBookingPaymentRequestedAfterCheckout(pgPaid, {
    bookingId: BOOKING,
    clientId: CLIENT,
  });
  assert.doesNotMatch(pgPaid.calls[0].sql, /deposit_paid|fully_paid|'paid'/i,
    'does not force paid bookings backwards');

  const pgB = fakePg();
  await voidUnscopedDepositDraftAfterPerGuestCheckout(pgB, {
    bookingId: BOOKING,
    clientId: CLIENT,
  });
  assert.equal(pgB.calls.length, 1);
  const voidSql = pgB.calls[0].sql;
  assert.match(voidSql, /UPDATE payments/i);
  assert.match(voidSql, /cancelled/i);
  assert.match(voidSql, /booking_guest_id IS NULL/i);
  assert.match(voidSql, /deposit_only/i);
  assert.match(voidSql, /status\s*=\s*'draft'/i);
  assert.doesNotMatch(voidSql, /DELETE FROM payments/i, 'void, do not delete');
  assert.match(voidSql, /provider_idempotency_key|checkout_url|stripe_checkout_session_id|checkout_preparation/,
    'void WHERE excludes a prepared together draft');

  const libDir = path.join(__dirname, 'lib');
  const perGuestSrc = fs.readFileSync(path.join(libDir, 'per-guest-checkout.js'), 'utf8');
  const linkSrc = fs.readFileSync(path.join(libDir, 'luna-front-desk-payment-link-service.js'), 'utf8');
  const botSrc = fs.readFileSync(path.join(libDir, 'staff-bot-v2-routes.js'), 'utf8');
  assert.match(perGuestSrc, /markBookingPaymentRequestedAfterCheckout/,
    'per-guest checkout marks the booking requested');
  assert.match(perGuestSrc, /voidUnscopedDepositDraftAfterPerGuestCheckout/,
    'per-guest checkout voids the unscoped group draft');
  assert.match(linkSrc, /markBookingPaymentRequestedAfterCheckout/,
    'booking-level checkout marks the booking requested');
  assert.doesNotMatch(linkSrc, /voidUnscopedDepositDraftAfterPerGuestCheckout/,
    'together/booking-level checkout must not void its own draft');
  assert.match(
    botSrc,
    /SET status\s*=\s*'checkout_created'::payment_record_status[\s\S]{0,1200}markBookingPaymentRequestedAfterCheckout/,
    'create-balance-link marks the booking requested after checkout update',
  );

  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  const INERT = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
  const TOGETHER = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
  await db.exec(`
    CREATE TYPE payment_record_status AS ENUM ('draft','checkout_created','cancelled','paid','expired','failed');
    CREATE TYPE payment_kind AS ENUM ('deposit_only','full_amount');
    CREATE TABLE clients (id uuid PRIMARY KEY, slug text NOT NULL);
    CREATE TABLE bookings (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), booking_code text);
    CREATE TABLE payments (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL,
      booking_id uuid NOT NULL,
      booking_guest_id uuid,
      status payment_record_status NOT NULL,
      payment_kind payment_kind NOT NULL,
      stripe_checkout_session_id text,
      checkout_url text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    INSERT INTO clients (id, slug) VALUES ('${CLIENT}', 'wolfhouse-somo');
    INSERT INTO bookings (id, client_id, booking_code) VALUES ('${BOOKING}', '${CLIENT}', 'WH-VOID-1');
    INSERT INTO payments (id, client_id, booking_id, booking_guest_id, status, payment_kind, metadata)
      VALUES
        ('${INERT}', '${CLIENT}', '${BOOKING}', NULL, 'draft', 'deposit_only', '{"source":"staff_manual"}'::jsonb),
        ('${TOGETHER}', '${CLIENT}', '${BOOKING}', NULL, 'draft', 'deposit_only',
         '{"payment_scope":"booking","provider_idempotency_key":"together-pay-1","checkout_preparation":"pending"}'::jsonb);
  `);
  await voidUnscopedDepositDraftAfterPerGuestCheckout(db, {
    bookingId: BOOKING,
    clientId: CLIENT,
  });
  const after = await db.query(
    `SELECT id::text AS id, status::text AS status
       FROM payments WHERE booking_id = $1::uuid ORDER BY id`,
    [BOOKING],
  );
  const byId = Object.fromEntries(after.rows.map((r) => [r.id, r.status]));
  assert.equal(byId[INERT], 'cancelled', 'inert leftover draft is cancelled');
  assert.equal(byId[TOGETHER], 'draft', 'prepared together draft stays draft');

  console.log(JSON.stringify({
    ok: true,
    booking_status: 'payment_link_sent',
    void_unscoped_draft: true,
    inert_status: byId[INERT],
    together_status: byId[TOGETHER],
  }));
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
