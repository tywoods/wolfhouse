'use strict';
const assert = require('node:assert/strict');
const { projectCreatedGuestRooms } = require('./lib/luna-front-desk-accommodation-booking-create-service');
const { projectGuestRooms } = require('./lib/staff-guest-room-state');
const guests = [
  { guest_number: 1, guest_name: 'Ana', assigned_room_code: 'R7' },
  { guest_number: 2, guest_name: 'Ben', assigned_room_code: 'R7' },
];
const catalog = { R7: { type: 'mixed', capacity: 4, room_name: 'Room 7' } };
for (const room_type of ['private', 'double']) {
  const quote = { success: true, room_type,
    line_items: [{ code: 'room_supplement', total_cents: 6000 }] };
  const rows = projectGuestRooms(guests, catalog, quote);
  assert.deepEqual(rows.map(row => row.room_kind), ['private', 'private']);
  assert.equal(rows.reduce((sum, row) => sum + row.supplement_cents, 0), 6000);
  for (const row of rows) {
    assert.equal(row.type, 'private', 'guest-facing saved type follows the sale');
    assert.equal(row.inventory_room_type, 'mixed', 'physical catalog type remains available separately');
    assert.equal(row.room_label, 'Room 7, private room');
  }
  const receipt = projectCreatedGuestRooms(guests, guests.map((g, i) => ({
    guest_number: g.guest_number, room_code: 'R7', bed_code: `R7-B${i + 1}`,
  })), quote, [{ room_code: 'R7', room_type: 'mixed', room_name: 'Room 7', capacity: 4 }]);
  assert.deepEqual(receipt.map(row => row.room_kind), ['private', 'private']);
  assert.ok(receipt.every(row => row.room_label === 'Room 7, private room'));
}
for (const quote of [null, {}, { success: false, room_type: 'private' },
    { success: true, room_type: 'shared' }, { line_items: [{ code: 'room_supplement', total_cents: 6000 }] }]) {
  assert.ok(projectGuestRooms(guests, catalog, quote).every(row => row.room_kind === 'shared'));
}
assert.equal(projectGuestRooms([{ guest_number: 1, assigned_room_code: 'unknown' }], catalog,
  { success: true, room_type: 'private' })[0].room_kind, null);
const mixedRooms = projectGuestRooms([guests[0], { ...guests[1], assigned_room_code: 'R8' }],
  { ...catalog, R8: { type: 'mixed', capacity: 4 } }, { success: true, room_type: 'private' });
assert.ok(mixedRooms.every(row => row.room_kind === 'shared'), 'a generic private quote cannot relabel a split allocation');
console.log('PASS private/double saved sale overrides catalog mixed label; shared/unknown/split remain unchanged; supplement conserved');
