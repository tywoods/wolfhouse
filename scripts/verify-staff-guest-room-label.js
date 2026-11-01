#!/usr/bin/env node
'use strict';

/**
 * Internal room codes must not be promoted to public room_label.
 * Create-shaped catalogs only have {number: code}. Missing labels stay missing.
 */

const assert = require('assert');
const { projectGuestRooms, projectGuestRoomState } = require('./lib/staff-guest-room-state');

const createCatalog = {};
for (const code of ['R3', 'R6', 'R9', 'R10']) {
  createCatalog[code] = { number: code };
}

const projected = projectGuestRooms(
  [
    { guest_number: 1, guest_name: 'Alex', assigned_room_code: 'R3' },
    { guest_number: 2, guest_name: 'Sam', assigned_room_code: 'R6' },
  ],
  createCatalog,
  { line_items: [] },
);

assert.equal(projected[0].number, 'R3', 'internal id stays R3');
assert.equal(projected[0].room_label, null, 'create catalog does not promote R3 to room_label');
assert.equal(projected[0].room_kind, null, 'unknown kind stays unknown without catalog type');
assert.equal(projected[1].number, 'R6');
assert.equal(projected[1].room_label, null, 'create catalog does not promote R6 to room_label');

const named = projectGuestRoomState(
  { guest_number: 1, guest_name: 'Alex', assigned_room_code: 'R3' },
  { R3: { number: 'R3', name: 'Surf dorm', type: 'mixed', capacity: 4 } },
  { line_items: [] },
);
assert.equal(named.number, 'R3');
assert.equal(named.room_label, 'Surf dorm');
assert.notEqual(named.room_label, named.number);
assert.equal(named.room_kind, 'shared');

const codeAsName = projectGuestRoomState(
  { guest_number: 1, guest_name: 'Alex', assigned_room_code: 'R9' },
  { R9: { number: 'R9', name: 'R9', type: 'mixed', capacity: 6 } },
  { line_items: [] },
);
assert.equal(codeAsName.number, 'R9');
assert.equal(codeAsName.room_label, null, 'a label that is only the internal code stays missing');

console.log('ok staff-guest-room-label');
