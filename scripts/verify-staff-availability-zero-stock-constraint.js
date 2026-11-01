#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  computeWolfhouseAvailabilityInventory,
  buildCanonicalAvailabilityBody,
  mapBotHttpAvailabilityResponse,
} = require('./lib/luna-front-desk-accommodation-availability-service');

const beds = [
  {
    bed_code: 'R1-B1', room_code: 'R1', room_type: 'mixed', capacity: 1,
    bed_active: true, bed_sellable: true, gender_strategy: 'Flexible',
  },
  {
    bed_code: 'R6-B1', room_code: 'R6', room_type: 'matrimonial_private_couple', capacity: 2,
    bed_active: true, bed_sellable: true, gender_strategy: 'Private',
  },
];
const allOccupied = [{ bed_code: 'R1-B1' }, { bed_code: 'R6-B1' }];
const command = {
  clientSlug: 'wolfhouse-somo',
  checkIn: '2027-06-05',
  checkOut: '2027-06-12',
  guestCount: 1,
  roomType: 'private',
  roomPreference: 'private',
  genderPreference: null,
  groupGender: null,
  keepTogether: false,
  guestName: 'Alex',
  guests: [],
  assignmentMode: false,
  transportBody: {},
};

const inventory = computeWolfhouseAvailabilityInventory(beds, allOccupied, command);
assert.equal(inventory.hasEnoughBeds, false);
assert.equal(inventory.constraintKind, 'occupied', 'zero stock still sets constraint_kind');
assert.ok(inventory.constraintCode, 'zero stock still sets constraint_code');

const canonical = buildCanonicalAvailabilityBody(command, inventory, { ok: true, nights: 7 });
assert.equal(canonical.constraint_kind, 'occupied');
assert.ok(canonical.constraint_code);
assert.ok(canonical.domain_next_action);

const mapped = mapBotHttpAvailabilityResponse(canonical);
assert.equal(mapped.constraint_kind, 'occupied');
assert.ok(mapped.constraint_code);
assert.ok(mapped.next_action, 'zero stock next_action is not null');
assert.notEqual(mapped.constraint_kind, null);
assert.notEqual(mapped.constraint_code, null);

console.log('ok staff-availability-zero-stock-constraint');
