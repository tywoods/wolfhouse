#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const create = require('./lib/luna-front-desk-accommodation-booking-create-service');
const rooms = require('./lib/staff-guest-room-state');

const guests = [
  { guest_number: 1, guest_name: 'Kathi', assigned_room_code: 'R9' },
];
const assignments = [{ guest_number: 1, bed_code: 'R9-B1', room_code: 'R9' }];
const bedRows = [
  {
    room_code: 'R9',
    room_name: 'Room 9',
    room_type: 'operator_surfweek',
    capacity: 6,
  },
];

const projected = create.projectCreatedGuestRooms(guests, assignments, { line_items: [] }, bedRows);
assert.equal(projected.length, 1);
assert.equal(projected[0].number, 'R9');
assert.equal(projected[0].type, 'operator_surfweek');
assert.equal(projected[0].room_label, 'Room 9');
assert.equal(projected[0].room_kind, 'shared');

const api = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');
assert.match(api, /projectGuestRooms\(/);
assert.doesNotMatch(
  api,
  /projectGuestRooms\(\s*row\._booking_guests \|\| \[\]\s*,\s*null\s*,/,
);

assert.match(api, /balance_due_at|balance_due_timing/);
const createSrc = fs.readFileSync(
  path.join(root, 'scripts/lib/luna-front-desk-accommodation-booking-create-service.js'),
  'utf8',
);
assert.match(createSrc, /balance_due_at|balance_due_timing/);

const timing = create.projectBalanceDueFact
  ? create.projectBalanceDueFact({
    checkIn: '2026-11-08',
    balancePaymentTiming: 'at_arrival_or_checkin',
  })
  : null;
assert.ok(timing);
assert.equal(timing.balance_due_timing, 'at_arrival_or_checkin');
assert.equal(timing.balance_due_at, '2026-11-08');

assert.equal(typeof rooms.catalogFromRoomRows, 'function');

console.log('ok kathi receipt room name/type and balance due');
