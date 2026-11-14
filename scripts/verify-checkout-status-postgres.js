'use strict';

// Offline PostgreSQL-engine regression. No server, Stripe, or guest access.
// npm install --prefix /tmp/sd-0250-pg --no-audit --no-fund @electric-sql/pglite@0.3.14
// NODE_PATH=/tmp/sd-0250-pg/node_modules node scripts/verify-checkout-status-postgres.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { markGuestsPaymentLinkRequested } = require('./lib/booking-guest-payment-status');
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
    // Use the real booking/guest enum, not the payments-record enum or a test invention.
    const migration = name => fs.readFileSync(path.join(__dirname, '../database/migrations', name), 'utf8');
    const enumSql = migration('001_init.sql').match(/CREATE TYPE payment_status AS ENUM\s*\([\s\S]*?\);/)[0];
    const additions = migration('004_payment_schema_phase2.sql').match(/ALTER TYPE payment_status[^;]+;/g);
    await db.exec(enumSql);
    for (const sql of additions) await db.exec(sql);
    await db.exec(`CREATE TABLE bookings (id uuid PRIMARY KEY, client_id uuid, payment_status payment_status);
      CREATE TABLE booking_guests (id uuid PRIMARY KEY, client_id uuid, booking_id uuid,
        payment_status payment_status, payment_id uuid, updated_at timestamptz);`);
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
        console.log(`PASS PostgreSQL checkout status: guests=${count} separate=${separate}; tenant and paid truth preserved`);
      }
    }
    assert.deepEqual(errors, [], 'no swallowed SQL errors');
  } finally {
    await db.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
