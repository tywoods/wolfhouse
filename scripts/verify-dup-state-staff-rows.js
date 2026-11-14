#!/usr/bin/env node
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
const selected = process.argv.find(arg => arg.startsWith('--case='))?.slice(7) || 'room';
(selected === 'frozen-recovery' ? qualifyF() : roomIdentity()).catch(error => { console.error(error); process.exitCode = 1; });
