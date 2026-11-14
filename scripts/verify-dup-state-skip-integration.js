'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { amountFor } = require('./lib/per-guest-checkout');
const { seedOfflineBookingDb } = require('./verify-luna-create-booking-occupants');
const {
  buildWolfhouseBookingCreateCommand,
  executeWolfhouseBookingCreate,
  BOOKING_CREATE_CHANNELS,
} = require('./lib/luna-front-desk-accommodation-booking-create-service');

function acceptedPersonMoneyConsumer() {
  const known = {
    guest_metadata: {
      money: { subtotal_cents: 28000, deposit_cents: 10000 },
      money_attribution: { version: 1, state: 'known', source: 'accepted_solo_aggregate' },
    },
    // The legacy SQL placeholder is not the person-money authority.
    deposit_amount_cents: 0,
    amount_paid_cents: 0,
  };
  assert.equal(amountFor(known, 'deposit'), 10000,
    'personal deposit preparation consumes accepted person money, not the legacy zero placeholder');
  assert.equal(amountFor(known, 'full'), 28000,
    'personal full preparation consumes the accepted person subtotal');

  for (const attribution of [
    { money: { subtotal_cents: null, deposit_cents: null }, money_attribution: { version: 1, state: 'unknown' } },
    { money: { subtotal_cents: 28000, deposit_cents: null }, money_attribution: { version: 1, state: 'partial' } },
  ]) {
    assert.throws(() => amountFor({ guest_metadata: attribution,
      deposit_amount_cents: 0, amount_paid_cents: 0 }, 'deposit'),
    /authoritative_guest_money_unavailable/,
    'incomplete group attribution must stay unavailable instead of becoming zero or an equal split');
  }
}

async function createAndReadBack({ acceptedQuote, packageCode, guestPackages, roomType, roomPreference, acceptedOffer }) {
  const db = new PGlite();
  const sql = [];
  const pg = {
    async query(text, params = []) {
      sql.push(String(text).trim());
      return db.query(text, params);
    },
  };
  const body = {
    confirm: true,
    check_in: '2026-07-06',
    check_out: '2026-07-12',
    guest_count: 1,
    guest_name: 'C17 Guest 1',
    guests: [{ name: 'C17 Guest 1' }],
    phone: '+99988000017',
    package_code: packageCode,
    guest_packages: guestPackages,
    room_type: roomType,
    room_preference: roomPreference,
    group_gender: 'mixed',
    selected_bed_codes: ['R3-B1'],
    payment_choice: 'deposit',
    always_save_accepted_booking: true,
    accepted_quote: acceptedQuote,
    ...(acceptedOffer ? { accepted_offer: acceptedOffer } : {}),
  };
  try {
    await seedOfflineBookingDb(db, body);
    await db.exec(fs.readFileSync(path.join(__dirname,
      '../database/migrations/136_wolfhouse_package_default_nights.sql'), 'utf8'));
    await db.exec(`ALTER TYPE payment_record_status ADD VALUE 'checkout_created';
      ALTER TYPE payment_record_status ADD VALUE 'paid';
      ALTER TYPE payment_record_status ADD VALUE 'expired';
      ALTER TABLE payments ADD COLUMN amount_paid_cents integer NOT NULL DEFAULT 0;
      ALTER TABLE payments ADD COLUMN stripe_checkout_session_id text;
      ALTER TABLE payments ADD COLUMN checkout_url text;
      ALTER TABLE payments ADD COLUMN expires_at timestamptz;
      ALTER TABLE bookings ADD COLUMN amount_paid_cents integer NOT NULL DEFAULT 0;`);
    await db.exec(fs.readFileSync(path.join(__dirname,
      '../database/migrations/107_per_guest_checkout_authoritative_intent.sql'), 'utf8'));
    const built = await buildWolfhouseBookingCreateCommand({
      channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
      trustedClientSlug: 'wolfhouse-somo',
      transportBody: body,
      pgClient: pg,
    });
    assert.equal(built.ok, true, JSON.stringify(built.body));
    const result = await executeWolfhouseBookingCreate(pg, built.command, {
      stripeConfig: { stripeLinksEnabled: false },
    });
    assert.equal(result.ok, true, JSON.stringify(result.body));
    assert.ok(sql.includes('COMMIT'), 'accepted mismatch must reach a real COMMIT');
    assert.equal(sql.includes('ROLLBACK'), false, 'commercial disagreement is advisory');
    const booking = (await db.query(`SELECT id, client_id, package_code, requested_room_type,
      total_amount_cents, deposit_required_cents, balance_due_cents, metadata
      FROM bookings WHERE id = $1`, [result.body.booking_id])).rows[0];
    const guests = (await db.query(`SELECT id, booking_id, guest_number, guest_name,
      assigned_bed_code, assigned_room_code, deposit_amount_cents, metadata
      FROM booking_guests WHERE booking_id = $1 ORDER BY guest_number`, [result.body.booking_id])).rows;
    const beds = (await db.query(`SELECT booking_id, bed_code, room_code, guest_name
      FROM booking_beds WHERE booking_id = $1`, [result.body.booking_id])).rows;
    assert.equal((await db.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 1);
    assert.equal(booking.id, result.body.booking_id);
    assert.equal(guests.length, 1);
    assert.equal(beds.length, 1);
    return { db, body, booking, guests, beds, result };
  } catch (error) {
    await db.close();
    throw error;
  }
}

function acceptedQuote(packageCode, roomType) {
  return {
    total_cents: 28000,
    deposit_required_cents: 10000,
    balance_due_cents: 18000,
    payment_link_amount_cents: 10000,
    currency: 'EUR',
    package_code: packageCode,
    room_type: roomType,
    per_person: [{
      guest_number: 1,
      guest_name: 'C17 Guest 1',
      subtotal_cents: 28000,
      deposit_cents: 10000,
      package_code: packageCode,
    }],
  };
}

async function acceptedMalibuOverridesStalePlainProjection() {
  const quote = acceptedQuote('malibu', 'private');
  const f = await createAndReadBack({
    acceptedQuote: quote,
    packageCode: 'package_none',
    guestPackages: [{ guest_number: 1, package_code: 'package_none' }],
    roomType: 'shared',
    roomPreference: 'shared',
  });
  try {
    assert.equal(f.booking.package_code, 'malibu');
    assert.equal(f.booking.requested_room_type, 'private');
    assert.equal(f.booking.metadata.package_code, 'malibu');
    assert.equal(f.booking.metadata.accommodation_only, false);
    assert.deepEqual(f.booking.metadata.guest_packages,
      [{ guest_number: 1, package_code: 'malibu' }]);
    assert.equal(f.booking.metadata.quote_snapshot.package_code, 'malibu');
    assert.equal(f.booking.metadata.quote_snapshot.room_type, 'private');
    assert.equal(f.guests[0].metadata.package_code, 'malibu');
    assert.equal(f.guests[0].metadata.money.subtotal_cents, 28000);
    assert.equal(f.booking.total_amount_cents, 28000);
    assert.equal(f.booking.deposit_required_cents, 10000);
    assert.deepEqual(f.body.accepted_quote, quote, 'accepted Staff evidence is not mutated');
  } finally {
    await f.db.close();
  }
}

async function acceptedPlainSharedOverridesStalePositiveProjection() {
  const quote = acceptedQuote('package_none', 'shared');
  const olderOffer = acceptedQuote('malibu', 'private');
  const f = await createAndReadBack({
    acceptedQuote: quote,
    acceptedOffer: olderOffer,
    packageCode: 'malibu',
    guestPackages: [{ guest_number: 1, package_code: 'malibu' }],
    roomType: 'private',
    roomPreference: 'private',
  });
  try {
    assert.equal(f.booking.package_code, null, 'package_none is SQL NULL');
    assert.equal(f.booking.requested_room_type, 'shared');
    assert.equal(f.booking.metadata.package_code, 'package_none');
    assert.equal(f.booking.metadata.accommodation_only, true);
    assert.deepEqual(f.booking.metadata.guest_packages,
      [{ guest_number: 1, package_code: 'package_none' }]);
    assert.equal(f.booking.metadata.quote_snapshot.package_code, 'package_none');
    assert.equal(f.booking.metadata.quote_snapshot.room_type, 'shared');
    assert.equal(f.guests[0].metadata.package_code, 'package_none');
    assert.equal(f.booking.total_amount_cents, 28000,
      'equal price must not infer the older package');
    assert.equal(f.booking.deposit_required_cents, 10000);
    assert.deepEqual(f.body.accepted_quote, quote, 'accepted Staff evidence is not mutated');
    assert.deepEqual(f.body.accepted_offer, olderOffer, 'older offer remains history');
  } finally {
    await f.db.close();
  }
}

async function main() {
  acceptedPersonMoneyConsumer();
  console.log('PASS BC-K04 accepted person money drives personal-payment readiness');
  await acceptedMalibuOverridesStalePlainProjection();
  await acceptedPlainSharedOverridesStalePositiveProjection();
  console.log('PASS BC-K05 accepted commercial identity persists bidirectionally through COMMIT/readback');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
