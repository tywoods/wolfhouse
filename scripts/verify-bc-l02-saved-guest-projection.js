#!/usr/bin/env node
'use strict';

// BC-L02 qualification, test-only. Constructed accepted Staff inputs; actual
// command builder/executor, INSERTs, COMMIT and independent PGlite SELECTs.
// Reuses the committed occupants seed/reduced schema, not a second SQL harness.
// No fake query replies, production edits, live DB, provider, HTTP or guest send.
// Run all isolated cases: node scripts/verify-bc-l02-saved-guest-projection.js
// Run one case:          node scripts/verify-bc-l02-saved-guest-projection.js --case=mixed-private
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CASES = {
  'malibu-private': {
    packageCode: 'malibu', roomType: 'private', stalePackage: 'package_none', staleRoom: 'shared',
    people: [{ guest_number: 1, package_code: 'malibu', subtotal_cents: 28000, deposit_cents: 10000 }],
  },
  'explicit-plain-shared': {
    packageCode: 'package_none', roomType: 'shared', stalePackage: 'malibu', staleRoom: 'private',
    // Deliberately equal money to Malibu: price cannot select commercial identity.
    people: [{ guest_number: 1, package_code: 'package_none', subtotal_cents: 28000, deposit_cents: 10000 }],
  },
  'mixed-shared': {
    packageCode: 'malibu', roomType: 'shared', stalePackage: 'uluwatu', staleRoom: 'shared',
    people: [
      { guest_number: 1, package_code: 'malibu', subtotal_cents: 31000, deposit_cents: 10000 },
      { guest_number: 2, package_code: 'package_none', subtotal_cents: 21000, deposit_cents: 4000 },
    ],
  },
  'mixed-private': {
    packageCode: 'malibu', roomType: 'private', stalePackage: 'uluwatu', staleRoom: 'shared',
    people: [
      { guest_number: 1, package_code: 'malibu', subtotal_cents: 31000, deposit_cents: 10000, supplement_cents: 3000 },
      { guest_number: 2, package_code: 'package_none', subtotal_cents: 21000, deposit_cents: 4000, supplement_cents: 3000 },
    ],
  },
  'compact-malibu-group': {
    packageCode: 'malibu', roomType: 'shared', stalePackage: 'package_none', staleRoom: 'shared', compact: true,
    people: [
      { guest_number: 1, package_code: 'malibu', subtotal_cents: null, deposit_cents: null },
      { guest_number: 2, package_code: 'malibu', subtotal_cents: null, deposit_cents: null },
    ],
  },
  'compact-plain-group': {
    packageCode: 'package_none', roomType: 'shared', stalePackage: 'malibu', staleRoom: 'private', compact: true,
    people: [
      { guest_number: 1, package_code: 'package_none', subtotal_cents: null, deposit_cents: null },
      { guest_number: 2, package_code: 'package_none', subtotal_cents: null, deposit_cents: null },
    ],
  },
};

async function qualify(name) {
  const spec = CASES[name];
  assert.ok(spec, `Unknown case ${name}`);
  const { PGlite } = require('@electric-sql/pglite');
  const { seedOfflineBookingDb } = require('./verify-luna-create-booking-occupants');
  const { buildWolfhouseBookingCreateCommand, executeWolfhouseBookingCreate,
    BOOKING_CREATE_CHANNELS } = require('./lib/luna-front-desk-accommodation-booking-create-service');
  const networkAttempts = [];
  function denyNetwork() {
    networkAttempts.push('network attempted');
    throw new Error('BC-L02 qualification is offline only');
  }
  require('node:net').Socket.prototype.connect = denyNetwork;
  require('node:tls').connect = denyNetwork;
  for (const transport of ['node:http', 'node:https']) {
    require(transport).request = denyNetwork;
    require(transport).get = denyNetwork;
  }
  globalThis.fetch = denyNetwork;

  const count = spec.people.length; // actual plan count, NOT compact quote length
  const total = spec.compact ? 52000 : spec.people.reduce((sum, p) => sum + p.subtotal_cents, 0);
  const deposit = spec.compact ? 14000 : spec.people.reduce((sum, p) => sum + p.deposit_cents, 0);
  const acceptedQuote = {
    total_cents: total, deposit_required_cents: deposit,
    balance_due_cents: total - deposit, payment_link_amount_cents: deposit,
    currency: 'EUR', package_code: spec.packageCode, room_type: spec.roomType,
    guest_count: count, per_person: spec.compact ? [] : structuredClone(spec.people),
  };
  const body = {
    confirm: true, check_in: '2026-07-06', check_out: '2026-07-12',
    guest_count: count, guest_name: 'L02 Lead',
    guests: spec.people.map(p => ({ name: `L02 Guest ${p.guest_number}` })),
    phone: '+999' + '88000022', package_code: spec.stalePackage,
    guest_packages: spec.people.map(p => ({ guest_number: p.guest_number, package_code: spec.stalePackage })),
    room_type: spec.staleRoom, room_preference: spec.staleRoom,
    group_gender: 'mixed', selected_bed_codes: ['R3-B1', 'R3-B2'].slice(0, count),
    payment_choice: 'deposit', per_guest_payment_links: true,
    always_save_accepted_booking: true, accepted_quote: acceptedQuote,
    ...(spec.packageCode === 'package_none'
      ? { accepted_offer: { ...structuredClone(acceptedQuote), package_code: 'malibu', room_type: 'private' } }
      : {}),
  };
  const original = structuredClone(body);
  const db = new PGlite();
  const sql = [], sqlErrors = [];
  const pg = { async query(text, params = []) {
    sql.push(String(text).trim());
    try { return await db.query(text, params); }
    catch (error) { sqlErrors.push({ code: error.code, statement: String(text).trim() }); throw error; }
  } };
  try {
    await seedOfflineBookingDb(db, body);
    await db.exec(fs.readFileSync(path.join(__dirname,
      '../database/migrations/136_wolfhouse_package_default_nights.sql'), 'utf8'));
    // Explicit reduced-schema additions: production 001 room preference and
    // blocked status let real private companion locks run, not fail invisibly.
    // Remaining columns are the same payment prerequisites as L01.
    await db.exec(`ALTER TYPE booking_status ADD VALUE 'blocked';
      ALTER TYPE payment_record_status ADD VALUE 'checkout_created';
      ALTER TYPE payment_record_status ADD VALUE 'paid';
      ALTER TYPE payment_record_status ADD VALUE 'expired';
      ALTER TABLE payments ADD COLUMN amount_paid_cents integer NOT NULL DEFAULT 0;
      ALTER TABLE payments ADD COLUMN stripe_checkout_session_id text;
      ALTER TABLE payments ADD COLUMN checkout_url text;
      ALTER TABLE payments ADD COLUMN expires_at timestamptz;
      ALTER TABLE bookings ADD COLUMN amount_paid_cents integer NOT NULL DEFAULT 0;
      ALTER TABLE bookings ADD COLUMN room_preference text;`);
    await db.exec(fs.readFileSync(path.join(__dirname,
      '../database/migrations/107_per_guest_checkout_authoritative_intent.sql'), 'utf8'));
    const built = await buildWolfhouseBookingCreateCommand({
      channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP, trustedClientSlug: 'wolfhouse-somo',
      transportBody: body, pgClient: pg,
    });
    assert.equal(built.ok, true, JSON.stringify(built.body));
    const result = await executeWolfhouseBookingCreate(pg, built.command, {
      stripeConfig: { stripeLinksEnabled: false },
    });
    assert.equal(result.ok, true, JSON.stringify(result.body));
    assert.equal(sql.filter(s => s === 'COMMIT').length, 1, 'exactly one actual create COMMIT');
    assert.equal(sql.includes('ROLLBACK'), false, 'commercial mismatch never refuses the save');
    assert.deepEqual(sqlErrors, [], 'no hidden SQL fault or synthetic query response');
    assert.deepEqual(networkAttempts, [], 'including swallowed network attempts');
    assert.deepEqual(body, original, 'accepted source and stale request evidence are not mutated');

    // Independent reads bypass the service proxy, after its actual COMMIT.
    const allBookings = (await db.query('SELECT * FROM bookings')).rows;
    const bookings = allBookings.filter(b => b.id === result.body.booking_id);
    const companions = allBookings.filter(b => b.id !== result.body.booking_id);
    assert.ok(companions.every(b => b.status === 'blocked'
      && b.metadata.private_room_parent_booking_id === result.body.booking_id),
    'only real private companion block bookings may accompany the guest booking');
    const guests = (await db.query(`SELECT id, booking_id, guest_number, guest_name,
      assigned_bed_code, deposit_amount_cents, metadata FROM booking_guests
      WHERE booking_id=$1 ORDER BY guest_number`, [result.body.booking_id])).rows;
    const beds = (await db.query('SELECT booking_id, bed_code FROM booking_beds WHERE booking_id=$1',
      [result.body.booking_id])).rows;
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].id, result.body.booking_id, 'returned booking ID is the actual INSERT');
    assert.equal(guests.length, count);
    assert.equal(beds.length, count);
    assert.equal(bookings[0].total_amount_cents, total);
    assert.equal(bookings[0].deposit_required_cents, deposit);
    assert.equal(bookings[0].balance_due_cents, total - deposit);
    assert.deepEqual(bookings[0].metadata.quote_snapshot.total_cents, total);

    // Collect independent field failures, so a package failure cannot conceal
    // whether money was right, unknown, invented, or actually persisted.
    const failures = [];
    function equal(actual, expected, field) {
      try { assert.deepEqual(actual, expected, `${name}: ${field}`); }
      catch (_) { failures.push({ field, expected, actual }); }
    }
    for (const expected of spec.people) {
      const row = guests.find(g => g.guest_number === expected.guest_number);
      assert.ok(row, `Missing actual ordinal ${expected.guest_number}`);
      const prefix = `guest[${expected.guest_number}]`;
      equal(row.guest_name, `L02 Guest ${expected.guest_number}`, `${prefix}.guest_name`);
      equal(row.assigned_bed_code, body.selected_bed_codes[expected.guest_number - 1], `${prefix}.assigned_bed_code`);
      equal(row.metadata.package_code, expected.package_code, `${prefix}.metadata.package_code`);
      equal(row.metadata.money, { subtotal_cents: expected.subtotal_cents, deposit_cents: expected.deposit_cents }, `${prefix}.metadata.money`);
      equal(row.metadata.money_attribution.state, spec.compact ? 'unknown' : 'known', `${prefix}.money_attribution`);
      equal(row.deposit_amount_cents, expected.deposit_cents === null ? 0 : expected.deposit_cents, `${prefix}.legacy_sql_deposit`);
      if (spec.compact) {
        equal(Object.hasOwn(row.metadata, 'subtotal_cents'), false, `${prefix}.no_unsafe_legacy_subtotal`);
      } else {
        equal(row.metadata.subtotal_cents, expected.subtotal_cents, `${prefix}.legacy_subtotal`);
      }
      const receipt = result.body._booking_guests.find(g => g.booking_guest_id === row.id);
      assert.ok(receipt, 'returned DTO binds actual saved guest UUID');
      equal(receipt.deposit_amount_cents, expected.deposit_cents, `${prefix}.receipt.deposit_amount_cents`);
      equal(receipt.subtotal_cents, expected.subtotal_cents, `${prefix}.receipt.subtotal_cents`);
    }
    const evidence = {
      case: name, committed: true, booking_id_matches: true,
      booking_rows: bookings.length, private_companion_booking_rows: companions.length,
      guest_rows: guests.length, bed_rows: beds.length, commits: 1,
      booking_money: { total_cents: total, deposit_cents: deposit },
      input_person_packages: acceptedQuote.per_person.map(p => [p.guest_number, p.package_code]),
      saved_person_packages: (bookings[0].metadata.quote_snapshot.per_person || []).map(p => [p.guest_number, p.package_code]),
      current_guest_packages: bookings[0].metadata.guest_packages,
      rows: guests.map(g => ({ guest_number: g.guest_number, package_code: g.metadata.package_code,
        money: g.metadata.money, attribution: g.metadata.money_attribution.state })), failures,
    };
    console.log(JSON.stringify(evidence));
    assert.deepEqual(failures, [], `${name}: saved booking_guests projection differs from accepted person facts`);
    console.log(`PASS BC-L02 ${name}: actual create / COMMIT / independent guest package and money readback`);
  } finally {
    await db.close();
  }
}

async function main() {
  const selected = process.argv.find(arg => arg.startsWith('--case='));
  if (selected) return qualify(selected.slice('--case='.length));
  // Separate process per database bounds test-host WASM memory; no skipped case.
  let failed = 0;
  for (const name of Object.keys(CASES)) {
    const child = spawnSync(process.execPath, [...process.execArgv, __filename, `--case=${name}`], {
      encoding: 'utf8', env: process.env,
    });
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    if (child.status !== 0) failed++;
  }
  console.log(`BC-L02 qualification: ${Object.keys(CASES).length} cases, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
