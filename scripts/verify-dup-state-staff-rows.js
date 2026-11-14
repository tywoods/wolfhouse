#!/usr/bin/env node
'use strict';

// C16: actual Staff create, transaction COMMIT and independent SQL readback.
// No fakePg/provider/HTTP response. Existing reduced schema/catalog seed runs
// real occupant migrations. Explicit test-only payment columns allow the real
// per-guest SQL prepare to run without calling Stripe or any network transport.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { seedOfflineBookingDb } = require('./verify-luna-create-booking-occupants');
const { buildWolfhouseBookingCreateCommand, executeWolfhouseBookingCreate,
  BOOKING_CREATE_CHANNELS } = require('./lib/luna-front-desk-accommodation-booking-create-service');
const { createSqlStore } = require('./lib/per-guest-checkout');

async function fixture(count, quote, options = {}) {
  const db = new PGlite();
  const sql = [], errors = [];
  const pg = { async query(text, params = []) {
    // Synthetic selective projection-read fault, executed by real PostgreSQL.
    if (options.readFault && /^SELECT guest_count, total_amount_cents AS total_cents,/.test(text.trim())) {
      text = 'SELECT 1/0'; params = [];
    }
    sql.push(String(text).trim());
    try { return await db.query(text, params); }
    catch (error) { errors.push(error.code); throw error; }
  } };
  try {
    const body = {
      confirm: true, check_in: '2026-07-06', check_out: '2026-07-12',
      guest_count: count, guest_name: 'C16 Lead',
      guests: Array.from({ length: count }, (_, i) => ({ name: `C16 Guest ${i + 1}` })),
      phone: '+999' + '88000002', package_code: 'malibu', room_type: 'shared',
      group_gender: 'mixed', selected_bed_codes: ['R3-B1', 'R3-B2'].slice(0, count),
      payment_choice: 'deposit', per_guest_payment_links: true,
      ...(quote ? { always_save_accepted_booking: true, accepted_quote: quote } : {}),
    };
    await seedOfflineBookingDb(db, body);
    await db.exec(fs.readFileSync(path.join(__dirname,
      '../database/migrations/136_wolfhouse_package_default_nights.sql'), 'utf8'));
    // Reduced seed lacks payment transport columns from production 001/004.
    // These additions are local fixture schema only, not product migrations.
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
      channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP, trustedClientSlug: 'wolfhouse-somo',
      transportBody: body, pgClient: pg,
    });
    assert.equal(built.ok, true, JSON.stringify(built.body));
    assert.equal(built.command.guestsNorm.guest_count, count, 'actual plan count, not compact quote count');
    const result = await executeWolfhouseBookingCreate(pg, built.command, {
      stripeConfig: { stripeLinksEnabled: false },
    });
    assert.equal(result.ok, true, JSON.stringify(result.body));
    assert.ok(sql.includes('COMMIT'), 'actual create COMMIT, not a fake commit');
    assert.equal(sql.includes('ROLLBACK'), false);
    const booking = (await db.query('SELECT * FROM bookings')).rows;
    const guests = (await db.query('SELECT * FROM booking_guests ORDER BY guest_number')).rows;
    assert.equal(booking.length, 1);
    assert.equal(result.body.booking_id, booking[0].id, 'returned receipt points at the actual INSERT');
    assert.equal(guests.length, count);
    assert.equal((await db.query('SELECT * FROM booking_beds')).rows.length, count);
    assert.deepEqual(errors, options.readFault ? ['22012'] : []);
    return { db, pg, sql, errors, body, result, booking: booking[0], guests };
  } catch (error) { await db.close(); throw error; }
}

async function compactSolo() {
  const quote = { total_cents: 28000, deposit_required_cents: 10000,
    balance_due_cents: 18000, payment_link_amount_cents: 10000,
    package_code: 'malibu', currency: 'EUR', per_person: [] };
  const f = await fixture(1, quote);
  try {
    assert.equal(f.booking.total_amount_cents, 28000);
    assert.equal(f.booking.deposit_required_cents, 10000);
    assert.equal(f.guests[0].deposit_amount_cents, 10000, 'compact solo must not become a zero-deposit guest');
    assert.equal(f.guests[0].metadata.subtotal_cents, 28000);
    assert.equal(f.guests[0].metadata.package_code, 'malibu');
    const prepared = await createSqlStore(work => work(f.pg), f.guests[0].id,
      'wolfhouse-somo', 'offline-c16').prepare('deposit');
    assert.equal(prepared.zero, undefined, 'actual prepare must not report nothing_due');
    assert.equal(prepared.amount, 10000);
    assert.deepEqual(f.errors, []);
    console.log('PASS compact solo: real create saved 28000/10000; actual SQL prepare due 10000');
  } finally { await f.db.close(); }
}

async function omittedSolo() {
  const f = await fixture(1, { total_cents: 28000, deposit_required_cents: 10000,
    balance_due_cents: 18000, payment_link_amount_cents: 10000,
    package_code: 'malibu', currency: 'EUR' });
  try {
    assert.equal(f.guests[0].deposit_amount_cents, 10000);
    assert.equal(f.guests[0].metadata.money.subtotal_cents, 28000);
    assert.equal(f.guests[0].metadata.money_attribution.state, 'known');
    assert.equal(Object.hasOwn(f.booking.metadata.quote_snapshot, 'guest_count'), false);
    assert.equal(Object.hasOwn(f.booking.metadata.quote_snapshot, 'per_person'), false);
    assert.equal(f.guests[0].metadata.package_code, 'malibu');
    const prepared = await createSqlStore(work => work(f.pg), f.guests[0].id,
      'wolfhouse-somo', 'offline-c16').prepare('full');
    assert.equal(prepared.amount, 28000);
    assert.equal(prepared.zero, undefined);
    console.log('PASS omitted per_person/quote count: real solo plan maps accepted aggregate; full prepare due 28000');
  } finally { await f.db.close(); }
}

async function unknownGroup() {
  for (const perPerson of [undefined, [], [{ guest_number: 1, subtotal_cents: 20000,
    deposit_cents: 7000, package_code: 'malibu' }]]) {
    const quote = { total_cents: 56000, deposit_required_cents: 20000,
      balance_due_cents: 36000, payment_link_amount_cents: 20000,
      package_code: 'malibu', currency: 'EUR', guest_count: 2,
      ...(perPerson === undefined ? {} : { per_person: perPerson }) };
    const f = await fixture(2, quote);
    try {
      const firstUnknown = perPerson && perPerson.length ? 1 : 0;
      const paymentsBefore = (await f.db.query('SELECT id FROM payments ORDER BY id')).rows;
      for (const guest of f.guests.slice(firstUnknown)) {
        const dto = f.result.body._booking_guests.find(row => row.booking_guest_id === guest.id);
        assert.equal(dto.deposit_amount_cents, null, 'DTO cannot expose legacy zero as known money');
        assert.equal(dto.subtotal_cents, null);
        assert.equal(dto.money_attribution.state, 'unknown');
        assert.equal(guest.metadata.money_attribution?.state, 'unknown',
          'an unattributed person must not be labelled zero-due or an equal split');
        assert.deepEqual(guest.metadata.money, { subtotal_cents: null, deposit_cents: null });
        assert.equal(guest.deposit_amount_cents, 0, 'legacy non-null SQL placeholder, not known money');
        assert.equal(Object.hasOwn(guest.metadata, 'subtotal_cents'), false,
          'do not publish a null legacy alias that old Number(null) readers call free');
        const store = createSqlStore(work => work(f.pg), guest.id, 'wolfhouse-somo', 'offline-c16');
        await assert.rejects(store.prepare('deposit'), /authoritative_guest_money_unavailable/);
      }
      if (firstUnknown) {
        assert.equal(f.guests[0].metadata.money_attribution.state, 'known');
        assert.deepEqual(f.guests[0].metadata.money, { subtotal_cents: 20000, deposit_cents: 7000 });
      }
      // Failed optional checkout preparation cannot undo the already accepted save.
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 1);
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM booking_guests')).rows[0].n, 2);
      assert.deepEqual((await f.db.query('SELECT id FROM payments ORDER BY id')).rows, paymentsBefore,
        'unavailable attribution does not create a checkout attempt');
      const after = (await f.db.query('SELECT * FROM bookings')).rows[0];
      assert.equal(after.total_amount_cents, 56000);
      assert.equal(after.deposit_required_cents, 20000);
      assert.deepEqual(after.metadata.quote_snapshot, quote, 'historical accepted snapshot unchanged');
      assert.deepEqual(f.errors, []);
    } finally { await f.db.close(); }
  }
  console.log('PASS group absent/empty/partial attribution: unknown stays nullable; real booking commits; no invented split or zero prepare');
}

async function calculatorControl() {
  const f = await fixture(2);
  try {
    const quoted = f.booking.metadata.quote_snapshot.per_person;
    assert.equal(quoted.length, 2);
    for (let i = 0; i < 2; i++) {
      assert.equal(f.guests[i].deposit_amount_cents, quoted[i].deposit_cents);
      assert.equal(f.guests[i].metadata.subtotal_cents, quoted[i].subtotal_cents);
      assert.equal(f.guests[i].metadata.package_code, quoted[i].package_code);
      assert.equal(f.guests[i].metadata.money_attribution.state, 'known');
      const prepared = await createSqlStore(work => work(f.pg), f.guests[i].id,
        'wolfhouse-somo', 'offline-c16').prepare('deposit');
      assert.equal(prepared.amount, quoted[i].deposit_cents);
      assert.equal(prepared.zero, undefined);
    }
    assert.deepEqual(f.errors, []);
    console.log('PASS real calculator control: attributed group rows/prepare unchanged');
  } finally { await f.db.close(); }
}

async function projectionTypes() {
  const { normalizeAcceptedPersonMoney } = require('./lib/booking-guests');
  const guests = [{ guest_number: 1 }, { guest_number: 2 }];
  for (const bad of [null, undefined, '', '0', '10000', false, true, -1, 1.5, Infinity, NaN, 2147483648]) {
    const rows = normalizeAcceptedPersonMoney({ total_cents: 28000, deposit_required_cents: 10000,
      per_person: [{ guest_number: 1, subtotal_cents: bad, deposit_cents: bad }] }, guests);
    assert.equal(rows[0].subtotal_cents, null);
    assert.equal(rows[0].deposit_cents, null);
    assert.equal(rows[0].money_attribution.state, 'unknown');
  }
  const incompleteRoster = normalizeAcceptedPersonMoney({ total_cents: 56000,
    deposit_required_cents: 20000 }, guests.slice(0, 1), { guest_count: 2 });
  assert.equal(incompleteRoster[0].subtotal_cents, null, 'one supplied row is not a solo plan');
  assert.equal(incompleteRoster[0].deposit_cents, null);
  const zero = normalizeAcceptedPersonMoney({ total_cents: 0, deposit_required_cents: 0 }, guests.slice(0, 1))[0];
  assert.equal(zero.subtotal_cents, 0);
  assert.equal(zero.deposit_cents, 0);
  assert.equal(zero.money_attribution.state, 'known', 'explicit zero is not unknown');
  const partial = normalizeAcceptedPersonMoney({ per_person: [{ guest_number: 2, subtotal_cents: 21000 }] }, guests);
  assert.equal(partial[1].subtotal_cents, 21000);
  assert.equal(partial[1].deposit_cents, null);
  assert.equal(partial[1].money_attribution.state, 'partial');
  assert.equal(partial[0].subtotal_cents, null);
  console.log('PASS typed projection: null/missing/invalid is unknown, explicit zero remains known, no aggregate group allocation');
}

async function projectionReadFault() {
  const f = await fixture(1, { total_cents: 28000, deposit_required_cents: 10000,
    balance_due_cents: 18000, payment_link_amount_cents: 10000,
    package_code: 'malibu', per_person: [] }, { readFault: true });
  try {
    assert.equal(f.booking.total_amount_cents, 28000);
    assert.equal(f.booking.deposit_required_cents, 10000);
    assert.equal(f.guests[0].metadata.money_attribution.state, 'unknown');
    assert.equal(f.result.body._booking_guests[0].money_attribution.error_code, '22012');
    assert.equal(f.result.body._booking_guests[0].deposit_amount_cents, null);
    assert.equal(f.sql.includes('ROLLBACK'), false);
    console.log('PASS synthetic projection-read SQL fault: accepted booking/guest/bed COMMIT survives; unknown/error explicit');
  } finally { await f.db.close(); }
}

async function main() {
  const cases = { solo: compactSolo, omitted: omittedSolo, group: unknownGroup,
    calculator: calculatorControl, types: projectionTypes, readFault: projectionReadFault };
  const selected = process.argv.find(arg => arg.startsWith('--case='));
  if (selected) {
    const name = selected.slice('--case='.length);
    assert.ok(cases[name], 'unknown case');
    await cases[name]();
  } else {
    for (const test of Object.values(cases)) await test();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
