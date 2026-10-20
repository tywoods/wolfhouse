#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { buildCanonicalAvailabilityBody, mapBotHttpAvailabilityResponse, AVAILABILITY_CHANNELS } = require('./lib/luna-front-desk-accommodation-availability-service');

function project(guests, roomPreference = 'female_only') {
  const command = {
    channel: AVAILABILITY_CHANNELS.BOT_HTTP, clientSlug: 'wolfhouse-somo',
    checkIn: '2026-11-18', checkOut: '2026-11-21', guestCount: guests.length,
    roomType: 'shared', roomPreference, transportBody: { guests },
  };
  const inventory = {
    groupGenderResolved: null, allocationReason: null, allocationSplit: false,
    rulesRooming: false, roomOptionFlags: { girls_room_available: true, private_room_available: false },
    selectedBedCodes: [], exactBedValidation: null, selectedRoomCode: null,
    needsClarification: true, clarificationConflict: 'room_eligibility_unknown',
    hasEnoughBeds: true, availableCount: 2, availableBeds: [], occupiedBedCodes: new Set(),
    warnings: [], blockers: [], roomingHandoff: false, selectedPrivateRoom: false,
  };
  const canonical = buildCanonicalAvailabilityBody(command, inventory, null);
  const mapped = mapBotHttpAvailabilityResponse(canonical);
  assert.deepEqual(mapped.room_eligibility, canonical.room_eligibility,
    'bot HTTP projection must forward Staff room_eligibility unchanged');
  return canonical.room_eligibility;
}
assert.deepEqual(project([{ name: 'Emma' }]), {
  status: 'unsure', requested_room_preference: 'female_only', affected_guest_indices: [0],
  reason_code: 'room_eligibility_unknown', question_kind: 'confirm_room_eligibility',
});
const yes = project([{ name: 'Emma', explicit_gender: 'female' }]);
assert.equal(yes.status, 'yes');
assert.equal(yes.question_kind, null);
const no = project([{ name: 'Emma', explicit_gender: 'male' }]);
assert.deepEqual(no, {
  status: 'no', requested_room_preference: 'female_only', affected_guest_indices: [0],
  reason_code: 'room_eligibility_incompatible', question_kind: null,
});
assert.deepEqual(project([{ name: 'A', explicit_gender: 'female' }, { name: 'B' }]).affected_guest_indices, [1]);
assert.equal(project([{ name: 'A' }], 'mixed'), null);

// Constructed Sim24 Becker shape: an explicit whole-party fact remains authoritative
// for unnamed slots, but never overrides a contradictory person-bound fact.
function projectAggregate(guests, groupGender) {
  const command = {
    channel: AVAILABILITY_CHANNELS.BOT_HTTP, clientSlug: 'wolfhouse-somo',
    checkIn: '2026-11-18', checkOut: '2026-11-21', guestCount: 2,
    roomType: 'shared', roomPreference: 'male_only', groupGender,
    transportBody: { guests, group_gender: groupGender },
  };
  const inventory = {
    groupGenderResolved: groupGender, allocationReason: null, allocationSplit: false,
    rulesRooming: false, roomOptionFlags: { girls_room_available: false, private_room_available: false },
    selectedBedCodes: [], exactBedValidation: null, selectedRoomCode: null,
    needsClarification: false, clarificationConflict: null, hasEnoughBeds: true,
    availableCount: 2, availableBeds: [], occupiedBedCodes: new Set(), warnings: [], blockers: [],
    roomingHandoff: false, selectedPrivateRoom: false,
  };
  return buildCanonicalAvailabilityBody(command, inventory, null).room_eligibility;
}
assert.equal(projectAggregate([], 'male').status, 'yes');
assert.deepEqual(projectAggregate([{ name: 'Becker', explicit_gender: 'female' }, {}], 'male'), {
  status: 'no', requested_room_preference: 'male_only', affected_guest_indices: [0],
  reason_code: 'room_eligibility_incompatible', question_kind: null,
});
console.log('PASS Wolfhouse Staff room_eligibility producer contract: yes/no/unsure; person and explicit whole-party scope; inventory independent');
