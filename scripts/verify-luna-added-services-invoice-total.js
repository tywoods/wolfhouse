'use strict';

/**
 * Luna-added yoga/rentals must roll into invoice total + balance due.
 * Real SQL save+read: INSERT booking €415, INSERT yoga €30, SELECT, ledger → €445.
 *
 * Usage: node scripts/verify-luna-added-services-invoice-total.js
 */

const assert = require('assert');
const path = require('path');
const {
  bookingLedgerInvoicePaidBalance,
} = require('./lib/booking-invoice-totals');

const ACC = 41500;
const YOGA = 3000; // 2 × €15
const RENTAL = 5000;
const BOOKING_CODE = 'WH-TEST-YOGA-445';
const CLIENT_ID = '00000000-0000-0000-0000-000000000001';

function loadPGlite() {
  const tries = [
    '@electric-sql/pglite',
    '/opt/data/workspace/sandbox-repos/WH-lookout/wt-1665-rebase/node_modules/@electric-sql/pglite',
    '/opt/data/wolfhouse-agent/node_modules/@electric-sql/pglite',
    '/opt/data/cursor-workspace/WH/node_modules/@electric-sql/pglite',
  ];
  for (const spec of tries) {
    try {
      return require(spec).PGlite;
    } catch (_) { /* next */ }
  }
  throw new Error('PGlite unavailable — cannot run SQL save+read invoice test');
}

const staySnapshot = {
  total_cents: ACC,
  line_items: [
    { code: 'guest_package', total_cents: 20750 },
    { code: 'guest_package', total_cents: 20750 },
  ],
};

async function main() {
  const PGlite = loadPGlite();
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE clients (id uuid PRIMARY KEY, slug text);
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id uuid,
      booking_code text,
      guest_name text,
      status text,
      total_amount_cents int,
      deposit_required_cents int,
      amount_paid_cents int,
      balance_due_cents int,
      metadata jsonb DEFAULT '{}'
    );
    CREATE TABLE booking_service_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id uuid,
      booking_code text,
      client_slug text,
      service_type text,
      quantity int,
      status text,
      amount_due_cents int,
      amount_paid_cents int,
      source text,
      metadata jsonb DEFAULT '{}'
    );
    INSERT INTO clients VALUES ('${CLIENT_ID}', 'wolfhouse-somo');
  `);

  const saved = await db.query(
    `INSERT INTO bookings (
       client_id, booking_code, guest_name, status,
       total_amount_cents, deposit_required_cents, amount_paid_cents, balance_due_cents, metadata
     ) VALUES ($1, $2, $3, 'confirmed', $4, 20000, 0, $4, $5::jsonb)
     RETURNING id, booking_code, total_amount_cents, amount_paid_cents, deposit_required_cents, metadata`,
    [CLIENT_ID, BOOKING_CODE, 'Ty test', ACC, JSON.stringify({ quote_snapshot: staySnapshot })],
  );
  const bookingRow = saved.rows[0];
  assert.ok(bookingRow && bookingRow.id, 'SQL INSERT bookings returned booking_id');
  assert.strictEqual(bookingRow.booking_code, BOOKING_CODE);
  assert.strictEqual(Number(bookingRow.total_amount_cents), ACC);

  await db.query(
    `INSERT INTO booking_service_records (
       booking_id, booking_code, client_slug, service_type, quantity, status,
       amount_due_cents, amount_paid_cents, source, metadata
     ) VALUES
       ($1, $2, 'wolfhouse-somo', 'yoga', 2, 'confirmed', $3, 0, 'luna_guest', '{}'::jsonb),
       ($1, $2, 'wolfhouse-somo', 'wetsuit', 1, 'confirmed', $4, 0, 'luna_guest', '{}'::jsonb)`,
    [bookingRow.id, BOOKING_CODE, YOGA, RENTAL],
  );

  const readBooking = await db.query(
    `SELECT id, booking_code, total_amount_cents, amount_paid_cents, deposit_required_cents, metadata
       FROM bookings WHERE id = $1`,
    [bookingRow.id],
  );
  const readSvc = await db.query(
    `SELECT COALESCE(SUM(amount_due_cents), 0)::int AS svc_due_cents
       FROM booking_service_records WHERE booking_id = $1`,
    [bookingRow.id],
  );
  const booking = readBooking.rows[0];
  const svcDue = Number(readSvc.rows[0].svc_due_cents);
  assert.strictEqual(svcDue, YOGA + RENTAL, 'SQL read yoga+rental cents');

  const yogaOnly = bookingLedgerInvoicePaidBalance(
    booking, YOGA, 0, 0, 0,
  );
  assert.strictEqual(yogaOnly.invoice_total_cents, ACC + YOGA, 'invoice 415+30 yoga = 445');
  assert.strictEqual(yogaOnly.balance_due_cents, ACC + YOGA, 'balance due 445');

  const yogaAndRental = bookingLedgerInvoicePaidBalance(
    booking, svcDue, 0, 0, 0,
  );
  assert.strictEqual(
    yogaAndRental.invoice_total_cents,
    ACC + YOGA + RENTAL,
    'invoice = stay + yoga + rental',
  );
  assert.strictEqual(
    yogaAndRental.balance_due_cents,
    ACC + YOGA + RENTAL,
    'balance due includes rentals',
  );

  await db.close();
  console.log('PASS verify-luna-added-services-invoice-total SQL save+read', {
    booking_id: bookingRow.id,
    booking_code: BOOKING_CODE,
    stay: ACC,
    stay_plus_yoga: yogaOnly.invoice_total_cents,
    stay_plus_yoga_rental: yogaAndRental.invoice_total_cents,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
