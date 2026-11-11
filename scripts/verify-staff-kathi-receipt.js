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
assert.equal(projected[0].room_number, 9);
assert.equal(projected[0].type, 'operator_surfweek');
assert.equal(projected[0].room_label, 'Room 9');
assert.equal(projected[0].room_kind, 'shared');
assert.equal(projected[0].occupancy, 'shared');
assert.equal(projected[0].assigned_bed_code, 'R9-B1');

const r3Guests = [
  { guest_number: 1, guest_name: 'Ana', assigned_room_code: 'R3' },
  { guest_number: 2, guest_name: 'Luis', assigned_room_code: 'R3' },
];
const r3Assignments = [
  { guest_number: 1, bed_code: 'R3-B1', room_code: 'R3' },
  { guest_number: 2, bed_code: 'R3-B2', room_code: 'R3' },
];
const r3Beds = [
  { room_code: 'R3', room_type: 'matrimonial_or_mixed', capacity: 4, gender_strategy: 'Flexible', bed_code: 'R3-B1' },
  { room_code: 'R3', room_type: 'matrimonial_or_mixed', capacity: 4, gender_strategy: 'Flexible', bed_code: 'R3-B2' },
];
const r3Projected = create.projectCreatedGuestRooms(r3Guests, r3Assignments, { line_items: [] }, r3Beds);
assert.equal(r3Projected.length, 2);
assert.equal(r3Projected[0].number, 'R3');
assert.equal(r3Projected[0].room_number, 3);
assert.equal(r3Projected[0].type, 'matrimonial_or_mixed');
assert.equal(r3Projected[0].room_kind, 'shared');
assert.equal(r3Projected[0].occupancy, 'shared');
assert.equal(r3Projected[0].gender, 'mixed');
assert.equal(r3Projected[0].room_label, null);
assert.equal(r3Projected[0].assigned_bed_code, 'R3-B1');
assert.equal(r3Projected[1].assigned_bed_code, 'R3-B2');
assert.equal(r3Projected[1].room_number, 3);
assert.equal(r3Projected[1].room_kind, 'shared');

const r1Projected = create.projectCreatedGuestRooms(
  [{ guest_number: 1, guest_name: 'Alex', assigned_room_code: 'R1' }],
  [{ guest_number: 1, bed_code: 'R1-B1', room_code: 'R1' }],
  { line_items: [] },
  [{ room_code: 'R1', room_type: 'mixed', capacity: 5, gender_strategy: 'Flexible', bed_code: 'R1-B1' }],
);
assert.equal(r1Projected[0].number, 'R1');
assert.equal(r1Projected[0].room_number, 1);
assert.equal(r1Projected[0].room_kind, 'shared');
assert.equal(r1Projected[0].occupancy, 'shared');
assert.equal(r1Projected[0].gender, 'mixed');
assert.equal(r1Projected[0].room_label, null);
assert.notEqual(r1Projected[0].room_label, 'R1');

const api = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');
assert.match(api, /projectGuestRooms\(/);
assert.doesNotMatch(
  api,
  /projectGuestRooms\(\s*row\._booking_guests \|\| \[\]\s*,\s*null\s*,/,
);

const createSrc = fs.readFileSync(
  path.join(root, 'scripts/lib/luna-front-desk-accommodation-booking-create-service.js'),
  'utf8',
);
assert.doesNotMatch(
  createSrc,
  /loadConfig\(\)[\s\S]{0,180}balancePaymentTiming/,
  'must not read loadConfig().payment',
);
assert.doesNotMatch(
  createSrc.slice(createSrc.indexOf('result._booking_guests = await insertBookingGuestsForBooking')),
  /loadPolicyBedRows\(pg/,
  'optional receipt enrichment must not query inside the saved-booking transaction',
);

const known = create.projectBalanceDueFact({
  checkIn: '2026-11-08',
  balancePaymentTiming: 'at_arrival_or_checkin',
});
assert.equal(known.balance_due_timing, 'at_arrival_or_checkin');
assert.equal(known.balance_due_at, '2026-11-08');

const unknown = create.projectBalanceDueFact({ checkIn: '2026-11-08' });
assert.equal(unknown.balance_due_timing, null);
assert.equal(unknown.balance_due_at, null, 'missing timing stays unknown, never check-in day');

const fromRule = create.projectBalanceDueFact({
  checkIn: '2027-03-10',
  clientSlug: 'wolfhouse-somo',
});
assert.equal(fromRule.balance_due_timing, 'at_arrival_or_checkin');
assert.equal(fromRule.balance_due_at, '2027-03-10');

const recovered = api.slice(
  api.indexOf('if (built.recovered || (built.body && built.body._duplicate))'),
  api.indexOf('if (built.dryRun)'),
);
const idempotent = api.slice(
  api.indexOf('if (row._duplicate)'),
  api.indexOf('// Preserve typed commit-time policy rejection'),
);
assert.match(recovered, /guest_rooms/);
assert.match(recovered, /balance_due_at|balance_due_timing/);
assert.match(idempotent, /guest_rooms/);
assert.match(idempotent, /balance_due_at|balance_due_timing/);
assert.match(api, /projectStaffReceiptFacts/);

assert.equal(typeof rooms.catalogFromRoomRows, 'function');
assert.equal(typeof create.projectStaffReceiptFacts, 'function');

const facts = create.projectStaffReceiptFacts({
  guests,
  assignments,
  quote: { line_items: [] },
  roomRows: bedRows,
  checkIn: '2027-03-10',
  clientSlug: 'wolfhouse-somo',
});
assert.equal(facts.guest_rooms[0].room_label, 'Room 9');
assert.equal(facts.balance_due_timing, 'at_arrival_or_checkin');

const csvWouldSay = 'CSV Room';
const liveFacts = create.projectStaffReceiptFacts({
  guests,
  assignments,
  quote: { line_items: [] },
  roomRows: [{ room_code: 'R9', room_name: 'Malibu', room_type: 'operator_surfweek', capacity: 6 }],
  checkIn: '2027-03-10',
  clientSlug: 'wolfhouse-somo',
});
assert.equal(liveFacts.guest_rooms[0].room_label, 'Malibu', 'live Staff room name, not CSV');
assert.notEqual(liveFacts.guest_rooms[0].room_label, csvWouldSay);

assert.match(createSrc, /function savedWolfhouseCreateResult/);
assert.match(createSrc, /savedWolfhouseCreateResult\(/);
const savedFn = create.savedWolfhouseCreateResult({
  booking_id: 'saved-1',
  booking_code: 'WH-20270310-13389959',
  status: 'confirmed',
  check_in: '2027-03-10',
  check_out: '2027-03-17',
  metadata: {},
  booking_guests: guests,
  bed_assignments: assignments,
});
assert.equal(savedFn.body.check_in, '2027-03-10');
assert.equal(savedFn.body.bed_assignments[0].room_code, 'R9');
assert.match(createSrc, /bk\.check_in/);
assert.match(createSrc, /booking_beds|bed_assignments|assigned_room_code/);

assert.match(recovered, /check_in/);
assert.match(idempotent, /check_in|cmd\.checkIn/);
assert.doesNotMatch(
  createSrc.slice(createSrc.indexOf('result._booking_guests = await insertBookingGuestsForBooking')),
  /configuredRoomRows\(|loadWolfhouseInventoryFromCsv\(/,
  'fresh receipt must not read CSV inside the saved-booking transaction',
);
assert.match(createSrc, /authoritativeRoomRows|liveRoomRows|loadPolicyBedRows\(pg, clientSlug\)/);

console.log('ok kathi receipt room name/type and balance due');
