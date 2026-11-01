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
    bed_code: 'R12-B1', room_code: 'R12', room_type: 'mixed', selling_mode: 'private',
    capacity: 2, bed_active: true, bed_sellable: true, gender_strategy: 'Flexible',
  },
  {
    bed_code: 'R12-B2', room_code: 'R12', room_type: 'mixed', selling_mode: 'private',
    capacity: 2, bed_active: true, bed_sellable: true, gender_strategy: 'Flexible',
  },
];
const allOccupied = [{ bed_code: 'R12-B1' }, { bed_code: 'R12-B2' }];
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

const shortBeds = [
  {
    bed_code: 'R1-B1', room_code: 'R1', room_type: 'mixed', capacity: 2,
    bed_active: true, bed_sellable: true, gender_strategy: 'Flexible',
  },
  {
    bed_code: 'R1-B2', room_code: 'R1', room_type: 'mixed', capacity: 2,
    bed_active: true, bed_sellable: true, gender_strategy: 'Flexible',
  },
];
const shortCommand = {
  ...command,
  guestCount: 3,
  roomType: 'shared',
  roomPreference: 'mixed',
};
const shortInv = computeWolfhouseAvailabilityInventory(shortBeds, [], shortCommand);
assert.equal(shortInv.hasEnoughBeds, false);
assert.equal(shortInv.constraintKind, 'capacity', 'free undersized inventory is capacity, not occupied');
assert.equal(shortInv.constraintCode, 'configured_capacity_insufficient');
assert.notEqual(shortInv.constraintKind, 'occupied');
const shortMapped = mapBotHttpAvailabilityResponse(
  buildCanonicalAvailabilityBody(shortCommand, shortInv, { ok: true, nights: 7 }),
);
assert.equal(shortMapped.constraint_kind, 'capacity');
assert.equal(shortMapped.constraint_code, 'configured_capacity_insufficient');
assert.ok(shortMapped.next_action);
assert.notEqual(shortMapped.constraint_kind, 'occupied');

const protectedOnly = [
  {
    bed_code: 'R6-B1', room_code: 'R6', room_type: 'matrimonial_private_couple', capacity: 2,
    bed_active: true, bed_sellable: true, gender_strategy: 'Private',
  },
  {
    bed_code: 'R6-B2', room_code: 'R6', room_type: 'matrimonial_private_couple', capacity: 2,
    bed_active: true, bed_sellable: true, gender_strategy: 'Private',
  },
];
const protectedOccupied = [{ bed_code: 'R6-B1' }, { bed_code: 'R6-B2' }];
const protectedInv = computeWolfhouseAvailabilityInventory(protectedOnly, protectedOccupied, command);
assert.equal(protectedInv.constraintKind, 'party_ineligible',
  'occupied protected-only still evaluates party eligibility');
assert.equal(protectedInv.constraintCode, 'protected_couple_private_requires_two_guests');
assert.equal(protectedInv.requiredPartySize, 2);
const protectedMapped = mapBotHttpAvailabilityResponse(
  buildCanonicalAvailabilityBody(command, protectedInv, { ok: true, nights: 7 }),
);
assert.equal(protectedMapped.constraint_kind, 'party_ineligible');
assert.equal(protectedMapped.constraint_code, 'protected_couple_private_requires_two_guests');
assert.equal(protectedMapped.required_party_size, 2);
assert.equal(protectedMapped.next_action, 'explain_party_ineligible');
assert.notEqual(protectedMapped.constraint_kind, 'occupied');

console.log('ok staff-availability-zero-stock-constraint');
