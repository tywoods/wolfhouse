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


// Scratch-only add/add resolution: unchanged C19 assertions in a private scope.
const roomCases = (() => {
'use strict';
const assert = require('node:assert/strict');
const { createRoomFixture } = require('./fixtures/dup-state-lookout-sql');
const service = require('./lib/luna-front-desk-accommodation-booking-create-service');
const room = require('./lib/staff-guest-room-state');

async function qualifyF() {
  const f = await createRoomFixture();
  try {
    const before = await f.snapshot();
    const lookup = await f.lookup();
    const receipt = service.savedWolfhouseCreateResult(lookup);
    const recovered = [await f.recover(), await f.recover()];
    assert.deepEqual(await f.snapshot(), before, 'repeated real recovery must insert/change nothing');
    console.log('F qualification:', JSON.stringify({
      saved: f.guests.map(g => ({ id: g.id, n: g.guest_number, bed: g.assigned_bed_code, room: g.assigned_room_code })),
      bed_order: lookup.bed_assignments.map(b => b.bed_code),
      lookup: lookup.booking_guests, receipt: receipt.body.guest_rooms,
      recoveries: recovered.map(r => ({ ok: r.ok, booking_id: r.body.booking_id,
        write_performed: r.body.write_performed, rooms: r.body.guest_rooms })),
    }));
    assert.deepEqual(receipt.body.guest_rooms.map(g => [g.booking_guest_id, g.assigned_bed_code, g.number]),
      f.guests.map(g => [g.id, g.assigned_bed_code, g.assigned_room_code]), 'C19 full frozen saved lookup/receipt qualification');
  } finally { await f.db.close(); }
}

async function roomIdentity() {
  const f = await createRoomFixture();
  try {
    const lookup = await f.lookup(); // Actual frozen recovery SQL; leave its consumer gap visible.
    const before = await f.snapshot();
    const catalog = room.catalogFromRoomRows(f.beds);
    const rows = room.projectGuestRooms(f.guests, catalog, f.booking.metadata.quote_snapshot,
      lookup.room_privacy, f.beds);
    assert.deepEqual(rows.map(g => [g.booking_guest_id, g.assigned_bed_code, g.number]),
      f.guests.map(g => [g.id, g.assigned_bed_code, g.assigned_room_code]),
      'ROOM primitive must retain actual saved guest IDs and bed/room identity');
    assert.deepEqual(f.created.body.guest_rooms.map(g => [g.booking_guest_id, g.assigned_bed_code, g.number]),
      f.guests.map(g => [g.id, g.assigned_bed_code, g.assigned_room_code]), 'actual fresh Staff receipt retains IDs and beds');
    assert.deepEqual(room.projectGuestRooms(rows, catalog, f.booking.metadata.quote_snapshot, lookup.room_privacy), rows,
      'a second receipt projection must retain saved IDs and bed binding');
    // Synthetic stale/reordered DTO copies; authoritative guest/bed SQL stays untouched.
    const stale = f.guests.slice().reverse().map(g => ({ ...g,
      assigned_room_code: g.assigned_room_code === 'R3' ? 'R1' : 'R3', room_code: 'R99', number: 'R99' }));
    for (const assignments of [f.beds, f.beds.slice().reverse()]) {
      const rebound = room.projectGuestRooms(stale, catalog, f.booking.metadata.quote_snapshot, lookup.room_privacy, assignments);
      assert.deepEqual(rebound.map(g => [g.booking_guest_id, g.assigned_bed_code, g.number]),
        f.guests.slice().reverse().map(g => [g.id, g.assigned_bed_code, g.assigned_room_code]),
        'actual assigned bed join must win over stale room copies, either array order and tied timestamps');
    }
    const lead = f.guests[0], leadBed = f.beds.find(b => b.bed_code === lead.assigned_bed_code);
    for (const assignments of [[], null, [leadBed, leadBed],
      [{ ...leadBed, booking_id: '00000000-0000-4000-8000-000000000099' }],
      [{ ...leadBed, client_id: '00000000-0000-4000-8000-000000000099' }],
      [{ ...leadBed, booking_guest_id: f.guests[1].id }],
      [{ ...leadBed, room_code: null }]]) {
      const unknown = room.projectGuestRoomState({ ...lead, room_code: 'R99', number: 'R99' },
        catalog, {}, lookup.room_privacy, assignments);
      assert.equal(unknown.booking_guest_id, lead.id);
      assert.equal(unknown.assigned_bed_code, lead.assigned_bed_code);
      assert.equal(unknown.number, null, 'missing/ambiguous/wrong-scoped binding cannot borrow a cached room');
      assert.equal(unknown.assigned_room_code, null);
    }
    const unnamedBinding = room.projectGuestRoomState({ ...lead, assigned_bed_code: null, guest_name: 'C19 Second' },
      catalog, {}, lookup.room_privacy, f.beds);
    assert.equal(unnamedBinding.number, null, 'never bind by display name or guest ordinal');
    for (const recovered of [await f.recover(), await f.recover()]) {
      assert.equal(recovered.ok, true);
      assert.equal(recovered.body.booking_id, f.booking.id);
      assert.equal(recovered.body.write_performed, false);
    }
    assert.deepEqual(await f.snapshot(), before, 'projection and repeated recovery cannot affect saved rows');
    console.log('PASS C19 ROOM primitive: real create INSERT/COMMIT -> saved lookup -> ID/bed-bound projection -> independent SELECT');
    console.log('PASS C19 controls: fresh receipt IDs/beds; stale/reordered copies; missing/ambiguous/foreign bindings; second projection; two recoveries insert nothing');
    console.log('BOUNDARY: native recovered receipt still requires Skip K06; --case=frozen-recovery keeps the strict integrated assertion');
  } finally { await f.db.close(); }
}

return { room: roomIdentity, 'frozen-recovery': qualifyF };
})();

async function main() {
  const cases = { solo: compactSolo, omitted: omittedSolo, group: unknownGroup,
    calculator: calculatorControl, types: projectionTypes, readFault: projectionReadFault, ...roomCases };
  const selected = process.argv.find(arg => arg.startsWith('--case='));
  if (selected) {
    const name = selected.slice('--case='.length);
    assert.ok(cases[name], 'unknown case');
    await cases[name]();
  } else {
    for (const [name, test] of Object.entries(cases)) {
      if (name !== 'frozen-recovery') await test();
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
