'use strict';

// Offline PostgreSQL-engine regression. No server, Stripe, or guest access.
// npm install --prefix /tmp/sd-0250-pg --no-audit --no-fund @electric-sql/pglite@0.3.14
// NODE_PATH=/tmp/sd-0250-pg/node_modules node scripts/verify-checkout-status-postgres.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { GuestPaymentStatusProjectionError, markGuestsPaymentLinkRequested, markGuestsPaidForBookingPayment } = require(
  process.env.GUEST_PAYMENT_STATUS_SOURCE || './lib/booking-guest-payment-status');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

(async () => {
  const db = new PGlite();
  const errors = [];
  const pg = { query: async (sql, params) => {
    try {
      const result = await db.query(sql, params);
      return { ...result, rowCount: result.affectedRows };
    } catch (error) {
      errors.push(error.message);
      throw error;
    }
  } };
  try {
    // Booking uses the real enum; migration 024 uses TEXT for guest status.
    // Retain enum-guest compatibility and legacy TEXT booking status controls.
    const migration = name => fs.readFileSync(path.join(__dirname, '../database/migrations', name), 'utf8');
    const enumSql = migration('001_init.sql').match(/CREATE TYPE payment_status AS ENUM\s*\([\s\S]*?\);/)[0];
    const additions = migration('004_payment_schema_phase2.sql').match(/ALTER TYPE payment_status[^;]+;/g);
    await db.exec(enumSql);
    for (const sql of additions) await db.exec(sql);
    const guestType = migration('024_booking_guests.sql').match(/payment_status\s+(TEXT)\s+NOT NULL/i)[1];
    for (const bookingStatusType of ['payment_status', 'TEXT']) {
    for (const guestStatusType of [guestType, 'payment_status']) {
    await db.exec(`CREATE TABLE bookings (id uuid PRIMARY KEY, client_id uuid, payment_status ${bookingStatusType});
      CREATE TABLE booking_guests (id uuid PRIMARY KEY, client_id uuid, booking_id uuid,
        payment_status ${guestStatusType}, payment_id uuid, updated_at timestamptz);`);
    for (const count of [1, 4]) {
      for (const separate of [false, true]) {
        await db.exec('TRUNCATE bookings, booking_guests');
        await db.query('INSERT INTO bookings VALUES ($1, $2, $3)', [id(1), id(2), 'not_requested']);
        for (let i = 0; i < count; i += 1) {
          await db.query('INSERT INTO booking_guests (id, client_id, booking_id, payment_status) VALUES ($1,$2,$3,$4)',
            [id(10 + i), id(2), id(1), 'not_requested']);
        }
        // Wrong tenant must leave both projections unchanged.
        await db.exec('BEGIN');
        await markGuestsPaymentLinkRequested(pg, { clientId: id(999), bookingId: id(1), paymentId: id(3) });
        await db.exec('COMMIT');
        assert.equal((await db.query('SELECT payment_status FROM bookings')).rows[0].payment_status, 'not_requested');
        assert.ok((await db.query('SELECT payment_status, payment_id FROM booking_guests')).rows
          .every(r => r.payment_status === 'not_requested' && r.payment_id === null), 'wrong tenant cannot change guests');
        for (let i = 0; i < (separate ? count : 1); i += 1) {
          await db.exec('BEGIN');
          await markGuestsPaymentLinkRequested(pg, {
            clientId: id(2), bookingId: id(1), paymentId: id(3 + i),
            bookingGuestId: separate ? id(10 + i) : null,
          });
          await db.exec('COMMIT');
        }
        const booking = (await db.query('SELECT payment_status FROM bookings')).rows[0];
        assert.equal(booking.payment_status, 'payment_link_sent', `count=${count} separate=${separate}; SQL errors: ${errors.join('; ')}`);
        assert.deepEqual((await db.query('SELECT payment_status FROM booking_guests')).rows.map(r => r.payment_status),
          Array(count).fill('payment_link_sent'));
        for (const status of ['deposit_paid', 'paid']) {
          await db.query('UPDATE bookings SET payment_status = $1', [status]);
          await db.query('UPDATE booking_guests SET payment_status = $1', [status]);
          await db.exec('BEGIN');
          await markGuestsPaymentLinkRequested(pg, { clientId: id(2), bookingId: id(1), paymentId: id(3) });
          await db.exec('COMMIT');
          assert.equal((await db.query('SELECT payment_status FROM bookings')).rows[0].payment_status, status);
          assert.ok((await db.query('SELECT payment_status FROM booking_guests')).rows.every(r => r.payment_status === status));
        }
        console.log(`PASS PostgreSQL checkout status: booking_type=${bookingStatusType} guest_type=${guestStatusType} guests=${count} separate=${separate}; tenant and paid truth preserved`);
      }
    }
    // Dedicated paid-writer path, not merely paid-state preservation at checkout.
    await db.exec('TRUNCATE bookings, booking_guests');
    for (const [n, status, paymentId] of [[10, 'payment_link_sent', id(3)],
      [11, 'deposit_paid', id(3)], [12, 'paid', id(3)],
      [13, 'payment_link_sent', id(4)], [14, 'not_requested', null]]) {
      await db.query('INSERT INTO booking_guests (id,client_id,booking_id,payment_status,payment_id) VALUES ($1,$2,$3,$4,$5)',
        [id(n), id(2), id(1), status, paymentId]);
    }
    const statuses = async () => (await db.query('SELECT payment_status FROM booking_guests ORDER BY id')).rows.map(r => r.payment_status);
    const paid = async (paymentStatus, clientId = id(2)) => {
      await db.exec('BEGIN');
      await markGuestsPaidForBookingPayment(pg, { clientId, bookingId: id(1), paymentId: id(3), paymentStatus });
      await db.exec('COMMIT');
    };
    const original = await statuses();
    await paid('paid', id(999));
    await paid('payment_link_sent');
    assert.deepEqual(await statuses(), original, 'tenant and unpaid-state guards');
    await paid('deposit_paid');
    assert.deepEqual(await statuses(), ['deposit_paid', 'deposit_paid', 'paid', 'payment_link_sent', 'deposit_paid']);
    await paid('paid');
    assert.deepEqual(await statuses(), ['paid', 'paid', 'paid', 'payment_link_sent', 'paid']);
    await paid('deposit_paid');
    assert.deepEqual(await statuses(), ['paid', 'paid', 'paid', 'payment_link_sent', 'paid'], 'no paid downgrade');
    assert.deepEqual(errors, [], 'no swallowed SQL errors');
    console.log(`PASS PostgreSQL paid writer: booking_type=${bookingStatusType} guest_type=${guestStatusType}; deposit/full, tenant, other-payment and no-downgrade controls`);
    // No booking prerequisite: guest-only fixtures must still project successfully.
    await db.exec('TRUNCATE bookings, booking_guests');
    await db.query('INSERT INTO booking_guests (id,client_id,booking_id,payment_status) VALUES ($1,$2,$3,$4)',
      [id(10), id(2), id(1), 'not_requested']);
    assert.equal(await markGuestsPaymentLinkRequested(pg, { clientId: id(2), bookingId: id(1), paymentId: id(3) }), 1);
    assert.deepEqual(await statuses(), ['payment_link_sent']);

    // Test transaction owner, not production caller integration. Real CHECK failures
    // exercise first UPDATE and second UPDATE (including rollback of partial work).
    await db.exec(`ALTER TABLE bookings ADD COLUMN confirmed boolean DEFAULT false;
      CREATE TABLE payments (id uuid PRIMARY KEY, booking_id uuid, status text, checkout_url text);
      CREATE TABLE receipts (id uuid PRIMARY KEY, payment_id uuid, amount_cents integer);`);
    for (const [operation, writer, target] of [
      ['payment_link_requested', markGuestsPaymentLinkRequested, 'booking_guests'],
      ['payment_link_requested', markGuestsPaymentLinkRequested, 'bookings'],
      ['booking_payment_paid', markGuestsPaidForBookingPayment, 'booking_guests'],
    ]) {
      await db.exec('TRUNCATE bookings, booking_guests, payments, receipts');
      await db.query('INSERT INTO bookings (id,client_id,payment_status) VALUES ($1,$2,$3)', [id(1), id(2), 'not_requested']);
      await db.query('INSERT INTO booking_guests (id,client_id,booking_id,payment_status) VALUES ($1,$2,$3,$4)',
        [id(10), id(2), id(1), 'not_requested']);
      const forbidden = operation === 'payment_link_requested' ? 'payment_link_sent' : 'paid';
      await db.exec(`ALTER TABLE ${target} ADD CONSTRAINT injected_projection_failure CHECK (payment_status <> '${forbidden}');`);
      const beforeErrors = errors.length;
      await db.exec('BEGIN');
      // Authoritative facts precede the optional projection boundary.
      const primaryBookingStatus = operation === 'booking_payment_paid' ? 'paid' : 'not_requested';
      await db.query('UPDATE bookings SET confirmed = true, payment_status = $2 WHERE id = $1', [id(1), primaryBookingStatus]);
      await db.query('INSERT INTO payments VALUES ($1,$2,$3,$4)', [id(3), id(1), 'paid', 'https://checkout.invalid/local-fixture']);
      await db.query('INSERT INTO receipts VALUES ($1,$2,$3)', [id(20), id(3), 12000]);
      await db.exec('SAVEPOINT caller_optional_status');
      let recovered = false;
      try {
        await writer(pg, { clientId: id(2), bookingId: id(1), paymentId: id(3), paymentStatus: 'paid' });
        assert.fail('actual optional UPDATE must fail');
      } catch (error) {
        assert.equal(error.name, 'GuestPaymentStatusProjectionError');
        assert.ok(error instanceof GuestPaymentStatusProjectionError);
        assert.equal(error.code, 'GUEST_PAYMENT_STATUS_PROJECTION_FAILED');
        assert.equal(error.operation, operation);
        assert.equal(error.cause.code, '23514');
        assert.equal(error.cause.constraint, 'injected_projection_failure');
        assert.equal(error.cause.table, target);
        // A typed JS error alone does NOT repair a PostgreSQL transaction.
        await assert.rejects(db.query('SELECT 1'), error => error.code === '25P02');
        await db.exec('ROLLBACK TO SAVEPOINT caller_optional_status');
        recovered = true;
      }
      await db.exec('RELEASE SAVEPOINT caller_optional_status');
      assert.ok(recovered);
      await db.exec('COMMIT');
      assert.equal(errors.length, beforeErrors + 1, 'exactly one real UPDATE failure, no hidden savepoint errors');
      errors.splice(beforeErrors);
      assert.deepEqual((await db.query('SELECT confirmed, payment_status FROM bookings')).rows,
        [{ confirmed: true, payment_status: primaryBookingStatus }]);
      assert.deepEqual((await db.query('SELECT payment_status, payment_id FROM booking_guests')).rows,
        [{ payment_status: 'not_requested', payment_id: null }], 'partial guest projection rolled back too');
      assert.deepEqual((await db.query('SELECT * FROM payments')).rows,
        [{ id: id(3), booking_id: id(1), status: 'paid', checkout_url: 'https://checkout.invalid/local-fixture' }]);
      assert.deepEqual((await db.query('SELECT * FROM receipts')).rows,
        [{ id: id(20), payment_id: id(3), amount_cents: 12000 }]);
      await db.exec(`ALTER TABLE ${target} DROP CONSTRAINT injected_projection_failure`);
      console.log(`PASS real UPDATE failure: booking_type=${bookingStatusType} guest_type=${guestStatusType} operation=${operation} target=${target}; caller isolation preserves booking/payment/receipt facts`);
    }
    await db.exec('DROP TABLE payments, receipts');
    await db.exec('DROP TABLE booking_guests, bookings');
    }
    }
  } finally {
    await db.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
