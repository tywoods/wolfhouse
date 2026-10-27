'use strict';

/**
 * Regression: authenticated /staff/bot/booking-create-from-plan attribution
 * must survive the ordinary accommodation create SQL write.  This deliberately
 * uses the PGlite real-command/real-INSERT harness rather than Finance-shaped
 * input fixtures.
 */
const assert = require('node:assert/strict');
const { stampBookingCreateSource } = require('./lib/booking-create-source-attribution');
const { runPayload } = require('./verify-luna-create-booking-occupants');

const basePayload = {
  confirm: true,
  check_in: '2026-08-03',
  check_out: '2026-08-06',
  guest_count: 1,
  guest_name: 'Attribution Guest',
  guests: [{ name: 'Attribution Guest' }],
  phone: '+999****1448',
  package_code: 'package_none',
  room_type: 'shared',
  selected_bed_codes: ['R3-B1'],
  payment_choice: 'full',
};

async function createAs(authMode, spoofedSource) {
  const payload = stampBookingCreateSource({ ...basePayload, source: spoofedSource }, authMode);
  return runPayload(payload);
}

async function main() {
  const luna = await createAs('bot_token', 'staff');
  assert.equal(luna.ok, true, JSON.stringify(luna.body));
  assert.equal(luna.bookings[0].metadata.source, 'luna_guest',
    'bot_token source is persisted by the real INSERT');
  const lunaInsert = luna.sql_calls.find((call) => call.kind === 'booking_create');
  assert.equal(lunaInsert.params[19], 'luna_guest', 'real create SQL receives trusted Luna source');

  const staff = await createAs('staff_portal', 'luna_guest');
  assert.equal(staff.ok, true, JSON.stringify(staff.body));
  assert.equal(staff.bookings[0].metadata.source, 'staff',
    'staff attribution remains staff despite body spoof');
  const staffInsert = staff.sql_calls.find((call) => call.kind === 'booking_create');
  assert.equal(staffInsert.params[19], 'staff', 'real create SQL receives trusted staff source');

  console.log('PASS verify-booking-create-source-persistence');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});