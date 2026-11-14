#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createNameFixture } = require('./fixtures/dup-state-lookout-sql');
const { propagateBookingLeadName } = require('./lib/staff-booking-name-propagate');

async function requiredEdit(testCase) {
  const f = await createNameFixture();
  const warnings = [];
  const warn = console.warn;
  try {
    if (testCase !== 'missing_guest_rooms') await f.legacyRooms();
    if (testCase.startsWith('trigger_')) await f.failMirror(testCase.slice(8));
    console.warn = (...args) => warnings.push(args.join(' '));
    const result = await f.edit([{ booking_guest_id: f.guests[0].id, guest_name: 'Lead Corrected' }]);
    console.warn = warn;
    assert.equal(result.status, 200, `${testCase}: required handler must commit`);
    assert.equal(result.body.success, true);
    // Independent SELECTs, outside the handler transaction (not returned dictionaries).
    const booking = (await f.db.query('SELECT * FROM bookings')).rows;
    const guests = (await f.db.query('SELECT * FROM booking_guests ORDER BY guest_number')).rows;
    const beds = (await f.db.query('SELECT * FROM booking_beds ORDER BY bed_code')).rows;
    assert.equal(booking.length, 1);
    assert.equal(guests.length, 2);
    assert.equal(beds.length, 2);
    assert.equal(booking[0].guest_name, 'Lead Corrected');
    assert.equal(guests[0].guest_name, 'Lead Corrected');
    assert.equal(guests[1].guest_name, 'Companion Before');
    assert.equal(booking[0].total_amount_cents, f.booking.total_amount_cents);
    assert.equal(booking[0].deposit_required_cents, f.booking.deposit_required_cents);
    assert.equal(f.sqlErrors.includes('25P02'), false, 'no aborted-transaction cascade');
    assert.equal(f.calls.filter(sql => sql === 'ROLLBACK').length, 0);
    assert.equal(f.calls.filter(sql => sql === 'COMMIT').length, 2, 'create + required name edit commit');
    assert.ok(result.body.saved_at);
    if (testCase === 'healthy') {
      assert.equal(warnings.length, 0);
      assert.equal(beds[0].guest_name, 'Lead Corrected');
      const legacy = (await f.db.query('SELECT * FROM guest_rooms ORDER BY guest_number')).rows;
      assert.equal(legacy[0].guest_name, 'Lead Corrected');
      assert.equal(f.sqlErrors.length, 0);
    } else {
      assert.equal(warnings.length, 1, 'optional failure must be surfaced, not swallowed');
      assert.match(warnings[0], /booking_name_mirror_failed/);
      assert.match(warnings[0], testCase === 'missing_guest_rooms' ? /42P01/ : /P0001/);
      assert.equal(f.sqlErrors.length, 1, 'only the injected SQL error');
      assert.ok(f.calls.some(sql => sql.startsWith('ROLLBACK TO SAVEPOINT ')));
      // Later independent mirrors still run after one optional mirror fails.
      if (testCase !== 'trigger_metadata') {
        assert.equal(booking[0].metadata.booking_guests[0].guest_name, 'Lead Corrected');
      }
    }
    console.log(`PASS ${testCase}: real create + required name handler COMMIT + independent SELECT`);
  } finally { console.warn = warn; await f.db.close(); }
}

async function sameNameLeadEdit() {
  const f = await createNameFixture({ sameName: true, reverseBeds: true });
  try {
    await f.legacyRooms();
    const [lead, companion] = f.guests;
    assert.notEqual(lead.id, companion.id);
    assert.equal(lead.guest_name, companion.guest_name);
    assert.notEqual(lead.assigned_bed_code, companion.assigned_bed_code);
    // Reverse the current mirror order to disallow index-based identity too.
    await f.db.query(`UPDATE bookings SET metadata = jsonb_set(metadata, '{booking_guests}', $1::jsonb)
      WHERE id=$2`, [JSON.stringify([
      { guest_number: 2, guest_name: companion.guest_name },
      { guest_number: 1, guest_name: lead.guest_name },
    ]), f.booking.id]);
    const beforeBeds = (await f.db.query('SELECT * FROM booking_beds ORDER BY bed_code')).rows;
    const result = await f.edit([{ booking_guest_id: lead.id, guest_name: 'Lead Corrected' }]);
    assert.equal(result.status, 200);
    assert.deepEqual(Array.from(result.body.after, g => g.booking_guest_id), [lead.id]);
    const guests = (await f.db.query('SELECT * FROM booking_guests ORDER BY guest_number')).rows;
    assert.equal(guests[0].guest_name, 'Lead Corrected');
    assert.deepEqual(guests[1], companion, 'same-name companion is a distinct identity, not an edit target');
    const beds = (await f.db.query('SELECT * FROM booking_beds ORDER BY bed_code')).rows;
    assert.equal(beds.find(b => b.bed_code === lead.assigned_bed_code).guest_name, 'Lead Corrected');
    assert.deepEqual(beds.find(b => b.bed_code === companion.assigned_bed_code),
      beforeBeds.find(b => b.bed_code === companion.assigned_bed_code));
    const legacy = (await f.db.query('SELECT * FROM guest_rooms ORDER BY guest_number')).rows;
    assert.deepEqual(legacy.map(g => g.guest_name), ['Lead Corrected', 'Lead Before']);
    const booking = (await f.db.query('SELECT * FROM bookings')).rows[0];
    assert.equal(booking.guest_name, 'Lead Corrected');
    assert.deepEqual(booking.metadata.booking_guests, [
      { guest_number: 2, guest_name: 'Lead Before' },
      { guest_number: 1, guest_name: 'Lead Corrected' },
    ]);
    assert.deepEqual(booking.metadata.quote_snapshot, f.booking.metadata.quote_snapshot);
    assert.equal(booking.total_amount_cents, f.booking.total_amount_cents);
    assert.equal(booking.deposit_required_cents, f.booking.deposit_required_cents);
    assert.equal(f.calls.filter(sql => sql === 'COMMIT').length, 2);
    assert.deepEqual(f.sqlErrors, []);
    console.log('PASS C23 same-name lead edit: real handler COMMIT; only selected guest/bed/ordinal mirrors change');
  } finally { await f.db.close(); }
}

async function explicitIdentityScope() {
  const f = await createNameFixture({ sameName: true, reverseBeds: true });
  try {
    await f.legacyRooms();
    const [lead, companion] = f.guests;
    // A copy with an explicit ID cannot be stolen by another person's ordinal.
    const current = [
      { booking_guest_id: lead.id, guest_number: 2, guest_name: lead.guest_name },
      { booking_guest_id: companion.id, guest_number: 1, guest_name: companion.guest_name },
    ];
    await f.db.query(`UPDATE bookings SET metadata=jsonb_set(metadata,'{booking_guests}',$1::jsonb)
      WHERE id=$2`, [JSON.stringify(current), f.booking.id]);
    const beforeBeds = (await f.db.query('SELECT * FROM booking_beds ORDER BY bed_code')).rows;
    await f.pg.query('BEGIN');
    await f.pg.query('UPDATE booking_guests SET guest_name=$1 WHERE id=$2', ['Second Corrected', companion.id]);
    const result = await propagateBookingLeadName(f.pg, { bookingId: f.booking.id,
      clientId: f.booking.client_id, bookingGuestId: companion.id,
      oldName: 'Not an identity', newName: 'Second Corrected' });
    await f.pg.query('COMMIT');
    assert.equal(result.ok, true);
    assert.deepEqual(result.affected_scope, { booking_guests: [companion.id],
      booking_beds: [companion.assigned_bed_code], guest_rooms: [2], metadata: [companion.id] });
    const guests = (await f.db.query('SELECT * FROM booking_guests ORDER BY guest_number')).rows;
    assert.deepEqual(guests[0], lead);
    assert.equal(guests[1].guest_name, 'Second Corrected');
    const beds = (await f.db.query('SELECT * FROM booking_beds ORDER BY bed_code')).rows;
    assert.deepEqual(beds.find(b => b.bed_code === lead.assigned_bed_code),
      beforeBeds.find(b => b.bed_code === lead.assigned_bed_code));
    assert.equal(beds.find(b => b.bed_code === companion.assigned_bed_code).guest_name, 'Second Corrected');
    const booking = (await f.db.query('SELECT * FROM bookings')).rows[0];
    assert.equal(booking.guest_name, lead.guest_name, 'companion does not rename the booking lead');
    assert.deepEqual(booking.metadata.booking_guests, [current[0], { ...current[1], guest_name: 'Second Corrected' }]);
    const legacy = (await f.db.query('SELECT * FROM guest_rooms ORDER BY guest_number')).rows;
    assert.deepEqual(legacy.map(g => g.guest_name), [lead.guest_name, 'Second Corrected']);
    const emptyScope = { booking_guests: [], booking_beds: [], guest_rooms: [], metadata: [] };
    for (const scope of [
      { bookingGuestId: '00000000-0000-4000-8000-000000000001' },
      { bookingGuestId: companion.id, clientId: '00000000-0000-4000-8000-000000000002' },
      { bookingGuestId: companion.id, bookingId: '00000000-0000-4000-8000-000000000003' },
    ]) {
      const out = await propagateBookingLeadName(f.pg, { bookingId: f.booking.id,
        clientId: f.booking.client_id, newName: 'Wrong Scope', ...scope });
      assert.equal(out.ok, true);
      assert.deepEqual(out.affected_scope, emptyScope, 'wrong identity never falls back to lead/name');
    }
    assert.deepEqual((await f.db.query('SELECT * FROM booking_guests ORDER BY guest_number')).rows, guests);
    assert.deepEqual((await f.db.query('SELECT * FROM booking_beds ORDER BY bed_code')).rows, beds);
    assert.deepEqual((await f.db.query('SELECT * FROM bookings')).rows[0], booking);
    assert.deepEqual((await f.db.query('SELECT * FROM guest_rooms ORDER BY guest_number')).rows, legacy);
    // Missing assignment is not permission to recover a bed by its old name.
    await f.pg.query('BEGIN');
    await f.pg.query('UPDATE booking_guests SET assigned_bed_code=NULL WHERE id=$1', [companion.id]);
    const unbound = await propagateBookingLeadName(f.pg, { bookingId: f.booking.id,
      clientId: f.booking.client_id, bookingGuestId: companion.id,
      oldName: 'Second Corrected', newName: 'Unbound Corrected' });
    await f.pg.query('COMMIT');
    assert.equal(unbound.ok, true);
    assert.deepEqual(unbound.affected_scope.booking_beds, []);
    assert.deepEqual((await f.db.query('SELECT * FROM booking_beds ORDER BY bed_code')).rows, beds);
    console.log('PASS C23 explicit-ID primitive: actual affected scope; ID beats ordinal; wrong scopes/unbound bed never guess');
  } finally { await f.db.close(); }
}

async function main() {
  if (process.argv.includes('--case=same-name')) return sameNameLeadEdit();
  if (process.argv.includes('--case=explicit-id')) return explicitIdentityScope();
  await sameNameLeadEdit();
  await explicitIdentityScope();
  for (const testCase of ['missing_guest_rooms', 'healthy', 'trigger_guest_rooms',
    'trigger_booking_beds', 'trigger_metadata', 'trigger_booking_guests']) {
    await requiredEdit(testCase);
  }
  // Existing nontransactional consumer remains supported; it must not gain a BEGIN/COMMIT.
  const f = await createNameFixture();
  const warnings = [], warn = console.warn;
  try {
    const before = f.calls.length;
    console.warn = (...args) => warnings.push(args.join(' '));
    const out = await propagateBookingLeadName(f.pg, { bookingId: f.booking.id,
      clientId: f.booking.client_id, oldName: 'Lead Before', newName: 'Auto Corrected' });
    console.warn = warn;
    assert.equal(out.ok, false);
    assert.deepEqual(out.mirror_errors, [{ mirror: 'guest_rooms', code: '42P01' }]);
    assert.deepEqual(out.affected_scope, { booking_guests: [f.guests[0].id],
      booking_beds: [f.guests[0].assigned_bed_code], guest_rooms: [], metadata: [f.guests[0].id] });
    assert.equal(warnings.length, 1);
    assert.equal(f.calls.slice(before).some(sql => /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)), false);
    assert.equal((await f.db.query('SELECT guest_name FROM booking_guests WHERE guest_number=1')).rows[0].guest_name,
      'Auto Corrected');
    assert.equal((await f.db.query('SELECT metadata FROM bookings')).rows[0].metadata.booking_guests[0].guest_name,
      'Auto Corrected');
    console.log('PASS autocommit: explicit mirror error; no caller transaction ownership change');
  } finally { console.warn = warn; await f.db.close(); }
  const required = await createNameFixture();
  try {
    await required.legacyRooms();
    await required.failMirror('required_guest');
    const result = await required.edit([{ booking_guest_id: required.guests[0].id,
      guest_name: 'Lead Corrected' }]);
    assert.equal(result.status, 500, 'a real required write error must not be labelled success');
    assert.equal((await required.db.query('SELECT guest_name FROM bookings')).rows[0].guest_name,
      'Lead Before');
    assert.equal((await required.db.query('SELECT guest_name FROM booking_guests WHERE guest_number=1')).rows[0].guest_name,
      'Lead Before');
    assert.deepEqual(required.sqlErrors, ['P0001']);
    assert.equal(required.calls.filter(sql => sql === 'ROLLBACK').length, 1);
    console.log('PASS required-write inverse: real SQL error remains truthful; no partial required name edit');
  } finally { await required.db.close(); }
  console.log('PASS C22: 8 SQL cases; no network, provider, guest send or live database');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
