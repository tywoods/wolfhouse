'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isPrivateRoomCompanionBlock,
  projectBlockedBedDisplay,
} = require('./lib/staff-blocked-bed-display');

const parentId = 'b8b6678b-b3f4-4796-ae9e-b8f46d1a133a';
const parentCode = 'WH-20270412-PARENT';
const booking = {
  status: 'blocked',
  guest_count: 3,
  guest_name: 'Blocked',
  total_amount_cents: null,
  staff_notes: `Private room companion block for ${parentId}`,
};
const metadata = {
  staff_calendar_block: true,
  block_type: 'private_room_companion',
  source: 'private_room_companion_block',
  private_room_parent_booking_id: parentId,
  private_room_parent_booking_code: parentCode,
};

assert.equal(isPrivateRoomCompanionBlock(booking, metadata), true);

const view = projectBlockedBedDisplay(booking, metadata);
assert.equal(view.is_blocked_inventory, true);
assert.deepEqual(view.guest_accommodation_lines, []);
assert.deepEqual(view.booking_guests, []);
assert.equal(view.parent_booking_id, parentId);
assert.equal(view.parent_booking_code, parentCode);
assert.match(view.staff_notes, /Private room companion block/);
assert.equal(view.luna_guest_notes.length, 1);
assert.match(view.luna_guest_notes[0].text, /Private room companion block/);

const live = {
  booking_guests: [],
  status: 'blocked',
  metadata,
};
const projectedLines = require('./lib/staff-blocked-bed-display').guestAccommodationLinesForBooking(
  { guest_count: 3 },
  metadata,
  [{ guest_number: 1, accommodation_cents: 12000 }, { guest_number: 2, accommodation_cents: 12000 }, { guest_number: 3, accommodation_cents: 12000 }],
);
assert.deepEqual(projectedLines, []);

const normal = projectBlockedBedDisplay({ status: 'confirmed', guest_count: 2 }, {});
assert.equal(normal, null);

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
assert.match(api, /projectBlockedBedDisplay/);
assert.match(api, /is_blocked_inventory/);
assert.doesNotMatch(api, /Unnamed guest 2/);

const query = fs.readFileSync(path.join(__dirname, 'lib/staff-booking-detail-queries.js'), 'utf8');
assert.match(query, /staff_notes/);

const invoiceFn = api.slice(api.indexOf('function bcRenderRunningInvoiceHtml'), api.indexOf('function bcRenderRunningInvoiceHtml') + 2500);
assert.match(invoiceFn, /is_blocked_inventory/);

console.log('verify-blocked-bed-display: PASS');
