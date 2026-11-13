'use strict';

/**
 * Solo Luna bookings must persist the real per-guest deposit, package_code and
 * subtotal through insertBookingGuestsForBooking — the same args as
 * luna-front-desk-accommodation-booking-create-service.js ~1869
 * (server perPersonBreakdown, no client money). Groups stay €200/guest.
 *
 * Independent expected values (Staff Pricing short €100 / long €200 per person):
 *   1 guest, 3-night stay-only → deposit €100
 *   2 guests, 7-night malibu   → each deposit €200
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  calculateWolfhouseQuote: calculateWolfhouseQuoteRaw,
  loadConfig,
} = require('./lib/wolfhouse-quote-calculator');
const { applyAuthoritativeSeasonsToConfig } = require('./lib/wolfhouse-pricing-resolve');
const {
  insertBookingGuestsForBooking,
  buildPerPersonBreakdown,
} = require('./lib/booking-guests');
const {
  wolfhouseBookingDepositCents,
} = require('./lib/wolfhouse-stay-deposit');

const pricingFixture = applyAuthoritativeSeasonsToConfig(loadConfig(), [
  { code: 'summer', label: 'Summer', priority: 0, sort_order: 1, bookable: true, active: true,
    ranges: [{ start_month: 7, start_day: 1, end_month: 7, end_day: 31 }] },
  { code: 'august', label: 'August', priority: 10, sort_order: 2, bookable: true, active: true,
    ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }] },
]);
function calculateWolfhouseQuote(input) {
  return calculateWolfhouseQuoteRaw(input, pricingFixture);
}

const SOLO_SHORT_DEPOSIT_CENTS = 10000;
const GROUP_LONG_DEPOSIT_CENTS = 20000;
const CLIENT = '10000000-0000-4000-8000-000000000001';
const BOOKING_SOLO = '20000000-0000-4000-8000-0000000000a1';
const BOOKING_GROUP = '20000000-0000-4000-8000-0000000000a2';
const BOOKING_EMPTY = '20000000-0000-4000-8000-0000000000a3';

function soloShortQuote() {
  return calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-07-10',
    check_out: '2026-07-13',
    guest_count: 1,
    package_code: 'package_none',
    payment_choice: 'deposit',
    uses_per_guest_deposits: false,
  });
}

function groupLongQuote() {
  return calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-08-01',
    check_out: '2026-08-08',
    guest_count: 2,
    package_code: 'malibu',
    payment_choice: 'deposit',
    uses_per_guest_deposits: true,
  });
}

/** Same shape as create-service.js:1864–1874 (server breakdown, no client money). */
function createServiceInsertArgs(quote, bookingId, guests) {
  const perPersonRows = Array.isArray(quote.per_person)
    ? quote.per_person
    : buildPerPersonBreakdown(quote, {
      guest_names: guests.map((g) => g.guest_name),
      payment_choice: 'deposit',
    });
  return {
    clientId: CLIENT,
    bookingId,
    guests,
    bedAssignments: [],
    perPersonBreakdown: perPersonRows,
    quote,
  };
}

async function openDb() {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE clients (id uuid PRIMARY KEY, slug text NOT NULL UNIQUE);
    CREATE TABLE bookings (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL REFERENCES clients(id),
      booking_code text NOT NULL,
      guest_name text,
      guest_count integer NOT NULL DEFAULT 1,
      payment_status text NOT NULL DEFAULT 'not_requested',
      status text NOT NULL DEFAULT 'confirmed'
    );
    CREATE TABLE booking_guests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id uuid NOT NULL REFERENCES clients(id),
      booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      guest_number integer NOT NULL,
      guest_name text NOT NULL,
      assigned_room_code text,
      assigned_bed_code text,
      deposit_amount_cents integer NOT NULL DEFAULT 0 CHECK (deposit_amount_cents >= 0),
      amount_paid_cents integer NOT NULL DEFAULT 0,
      payment_status text NOT NULL DEFAULT 'not_requested',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    INSERT INTO clients (id, slug) VALUES ('${CLIENT}', 'wolfhouse-somo');
    INSERT INTO bookings (id, client_id, booking_code, guest_name, guest_count)
      VALUES
        ('${BOOKING_SOLO}', '${CLIENT}', 'WH-SOLO-1', 'Sam', 1),
        ('${BOOKING_GROUP}', '${CLIENT}', 'WH-GROUP-2', 'A', 2),
        ('${BOOKING_EMPTY}', '${CLIENT}', 'WH-EMPTY-1', 'Eva', 1);
  `);
  return db;
}

async function selectGuests(db, bookingId) {
  const r = await db.query(
    `SELECT guest_number, guest_name, deposit_amount_cents,
            metadata->>'package_code' AS package_code,
            (metadata->>'subtotal_cents')::int AS subtotal_cents,
            metadata->>'staff_warning' AS staff_warning,
            (metadata->>'price_needs_staff_review')::boolean AS price_needs_staff_review
       FROM booking_guests
      WHERE booking_id = $1::uuid
      ORDER BY guest_number`,
    [bookingId],
  );
  return r.rows;
}

async function main() {
  const createSrc = fs.readFileSync(
    path.join(__dirname, 'lib/luna-front-desk-accommodation-booking-create-service.js'),
    'utf8',
  );
  assert.match(
    createSrc,
    /insertBookingGuestsForBooking\(pg, \{[^}]*perPersonBreakdown:\s*perPersonRows,\s*quote,/,
    'create-service save path passes quote so insert fallback can run',
  );

  const solo = soloShortQuote();
  assert.equal(solo.success, true, 'solo quote succeeds');
  assert.equal(solo.deposit_required_cents, SOLO_SHORT_DEPOSIT_CENTS);
  assert.ok(Array.isArray(solo.per_person) && solo.per_person.length === 1);
  assert.equal(solo.per_person[0].deposit_cents, SOLO_SHORT_DEPOSIT_CENTS);
  assert.ok(String(solo.per_person[0].package_code || '').trim());
  assert.ok(Number.isInteger(solo.per_person[0].subtotal_cents) && solo.per_person[0].subtotal_cents > 0);

  const group = groupLongQuote();
  assert.equal(group.success, true);
  assert.equal(group.per_person.length, 2);
  assert.ok(group.per_person.every((p) => p.deposit_cents === GROUP_LONG_DEPOSIT_CENTS),
    'group still stores €200 per guest');

  const db = await openDb();
  await db.query('BEGIN');
  await insertBookingGuestsForBooking(db, createServiceInsertArgs(
    solo,
    BOOKING_SOLO,
    [{ guest_number: 1, guest_name: 'Sam' }],
  ));
  await insertBookingGuestsForBooking(db, createServiceInsertArgs(
    group,
    BOOKING_GROUP,
    [{ guest_number: 1, guest_name: 'A' }, { guest_number: 2, guest_name: 'B' }],
  ));
  await insertBookingGuestsForBooking(db, {
    clientId: CLIENT,
    bookingId: BOOKING_EMPTY,
    guests: [{ guest_number: 1, guest_name: 'Eva' }],
    bedAssignments: [],
    perPersonBreakdown: [],
  });
  await db.query('COMMIT');

  const soloRows = await selectGuests(db, BOOKING_SOLO);
  assert.equal(soloRows.length, 1);
  assert.equal(Number(soloRows[0].deposit_amount_cents), SOLO_SHORT_DEPOSIT_CENTS,
    'SELECT solo deposit_amount_cents is €100, not 0');
  assert.equal(soloRows[0].package_code, solo.per_person[0].package_code);
  assert.equal(Number(soloRows[0].subtotal_cents), solo.per_person[0].subtotal_cents);

  const groupRows = await selectGuests(db, BOOKING_GROUP);
  assert.equal(groupRows.length, 2);
  assert.deepEqual(
    groupRows.map((r) => Number(r.deposit_amount_cents)),
    [GROUP_LONG_DEPOSIT_CENTS, GROUP_LONG_DEPOSIT_CENTS],
    'SELECT group deposit_amount_cents stays €200 each',
  );
  assert.ok(groupRows.every((r) => String(r.package_code || '').trim()));
  assert.ok(groupRows.every((r) => Number.isInteger(Number(r.subtotal_cents)) && Number(r.subtotal_cents) > 0));

  const emptyRows = await selectGuests(db, BOOKING_EMPTY);
  assert.equal(emptyRows.length, 1, 'empty breakdown still saves the guest');
  assert.equal(emptyRows[0].staff_warning, 'guest_deposit_unknown_empty_breakdown',
    'empty breakdown with no quote warns staff instead of silently storing 0 as priced money');
  assert.equal(emptyRows[0].price_needs_staff_review, true);

  const financials = wolfhouseBookingDepositCents({
    guest_count: 1,
    check_in: '2026-07-10',
    check_out: '2026-07-13',
    package_code: solo.per_person[0].package_code,
    metadata: { quote_snapshot: { per_person: solo.per_person, package_code: solo.per_person[0].package_code } },
  }, { nights_threshold: 6, long_stay_cents: 20000, short_stay_cents: 10000, source: 'admin_pricing' });
  assert.equal(financials, SOLO_SHORT_DEPOSIT_CENTS);

  console.log(JSON.stringify({
    ok: true,
    solo_deposit_cents: Number(soloRows[0].deposit_amount_cents),
    solo_package_code: soloRows[0].package_code,
    solo_subtotal_cents: Number(soloRows[0].subtotal_cents),
    group_deposits: groupRows.map((r) => Number(r.deposit_amount_cents)),
    empty_staff_warning: emptyRows[0].staff_warning,
    financials_deposit_cents: financials,
  }));
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
