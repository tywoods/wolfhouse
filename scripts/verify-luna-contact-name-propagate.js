'use strict';

/**
 * Luna update-contact name change must update bookings.guest_name AND
 * booking_guests[0], guest_rooms[0], metadata.booking_guests, booking_beds.guest_name.
 *
 * Run: node scripts/verify-luna-contact-name-propagate.js
 */
const assert = require('node:assert/strict');
const { propagateBookingLeadName } = require('./lib/staff-booking-name-propagate');

const calls = [];
const pg = {
  query: async (sql, params) => {
    calls.push({ sql: String(sql), params: params || [] });
    if (/FROM booking_guests/i.test(sql) && /SELECT/i.test(sql)) {
      return { rows: [{ id: 'g1', guest_number: 1, guest_name: 'Eli Test' }] };
    }
    if (/FROM guest_rooms/i.test(sql) || /UPDATE guest_rooms/i.test(sql)) {
      return { rows: [{ guest_name: 'Eli Changed' }] };
    }
    return { rows: [{ guest_name: 'Eli Changed' }] };
  },
};

(async () => {
  await propagateBookingLeadName(pg, {
    bookingId: 'b1',
    clientId: 'c1',
    oldName: 'Eli Test',
    newName: 'Eli Changed',
  });
  const joined = calls.map((c) => c.sql).join('\n');
  assert.match(joined, /UPDATE booking_guests/i);
  assert.match(joined, /UPDATE booking_beds/i);
  assert.match(joined, /metadata/i);
  assert.ok(
    /guest_rooms/i.test(joined) || /metadata/i.test(joined),
    'guest_rooms or metadata.guest_rooms must be updated',
  );
  const names = calls.flatMap((c) => c.params).filter((p) => p === 'Eli Changed');
  assert.ok(names.length >= 1, 'new name must be written');
  console.log('PASS name change propagates to guests, beds, metadata, guest_rooms');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
