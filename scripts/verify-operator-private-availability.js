'use strict';

// Offline regression: R7, four free beds, Apr 15–20 2027, three Malibu guests.
// The allocator consumes date-filtered occupancy; dates/package belong to callers.
const assert = require('node:assert/strict');
const { runAvailabilityBedSelection, validateExplicitBedSelection } = require('./lib/luna-bed-allocator');
const bedRows = [1, 2, 3, 4].map(i => ({
  bed_code: `R7-B${i}`, room_code: 'R7', room_type: 'operator_surfweek',
  gender_strategy: 'Anyone', capacity: 4, selling_mode: 'private_optional',
  often_used_by_operator: true, can_be_matrimonial: false,
  bed_active: true, bed_sellable: true,
}));
const pick = runAvailabilityBedSelection({
  bedRows, blockRows: [], guestCount: 3, roomPreference: 'private',
});
assert.deepEqual(pick.selected_bed_codes, ['R7-B1', 'R7-B2', 'R7-B3'],
  'unblocked operator/private_optional R7 must offer three private guest beds');
assert.equal(pick.private_room, true, 'retain exclusive-room semantics for companion-bed blocking');
const exact = validateExplicitBedSelection({
  bedRows, blockRows: [], guestCount: 3,
  selectedBedCodes: ['R7-B3', 'R7-B1', 'R7-B2'], body: { room_preference: 'private' },
});
assert.deepEqual(exact, { ok: true, private_room: true });
console.log('PASS unblocked R7 private three: allocator and exact ordered selection');

// Exercise rules-on, rollback and capacity-only entry points, including legacy
// ordinary rooms marked for occasional operator use (boolean and DB text flags).
for (const room_type of ['operator_surfweek', 'mixed']) {
  for (const often_used_by_operator of [true, 'true']) {
    for (const selling_mode of ['private_optional', 'private', 'shared']) {
      const rows = bedRows.map(row => ({ ...row, room_type, often_used_by_operator, selling_mode }));
      for (const roomPreference of ['private', 'shared']) {
        for (const blocked of [false, true]) {
          // Blocking only the unselected fourth bed must exclude the entire room.
          const blockRows = blocked ? [{ bed_code: 'R7-B4', room_code: 'R7', assignment_type: 'operator_block' }] : [];
          const allowed = !blocked && (roomPreference === 'private' ? selling_mode !== 'shared' : selling_mode !== 'private');
          for (const capacityOnly of [false, true]) for (const useRules of [false, true]) {
            const result = runAvailabilityBedSelection({
              bedRows: rows, blockRows, guestCount: 3, roomPreference, capacityOnly, useRules,
            });
            assert.deepEqual(result.selected_bed_codes, allowed ? ['R7-B1', 'R7-B2', 'R7-B3'] : [],
              JSON.stringify({ room_type, often_used_by_operator, selling_mode, roomPreference, blocked, capacityOnly, useRules }));
            if (allowed) assert.equal(result.private_room, roomPreference === 'private' ? true : undefined);
          }
          const selectedBedCodes = ['R7-B3', 'R7-B1', 'R7-B2'];
          const result = validateExplicitBedSelection({
            bedRows: rows, blockRows, selectedBedCodes, guestCount: 3,
            body: { room_preference: roomPreference },
          });
          assert.equal(result.ok, allowed);
          if (allowed && roomPreference === 'private') assert.equal(result.private_room, true);
          assert.deepEqual(selectedBedCodes, ['R7-B3', 'R7-B1', 'R7-B2'], 'exact selection never replaces/reorders beds');
        }
      }
    }
  }
}
console.log('PASS operator/flexible selling modes: private/shared, date block, rules/rollback/capacity and exact selection');

for (const capacityOnly of [false, true]) {
  const blockRows = [{ bed_code: 'R7-B4', room_code: 'R7', assignment_type: 'guest' }];
  const result = runAvailabilityBedSelection({
    bedRows, blockRows, occupiedBedCodes: new Set(['R7-B4']), guestCount: 3,
    roomPreference: 'private', capacityOnly,
  });
  assert.deepEqual(result.selected_bed_codes, [], 'occupied spare bed prevents private conversion');
  assert.equal(validateExplicitBedSelection({
    bedRows, blockRows, selectedBedCodes: ['R7-B1', 'R7-B2', 'R7-B3'], guestCount: 3,
    body: { room_preference: 'private' },
  }).ok, false);
  const blocked = runAvailabilityBedSelection({
    bedRows, blockRows: [], operatorBlockedRoomCodes: new Set(['R7']), guestCount: 3,
    roomPreference: 'private', capacityOnly,
  });
  assert.deepEqual(blocked.selected_bed_codes, [], 'caller-supplied operator room block remains authoritative');
}
console.log('PASS occupied sibling and explicit operator-block set prevent private allocation');

for (const room_type of ['female_only', 'male_only']) {
  const rows = bedRows.map(row => ({ ...row, room_type }));
  const opposite = room_type === 'female_only' ? 'male' : 'female';
  const result = runAvailabilityBedSelection({
    bedRows: rows, blockRows: [], guestCount: 3, roomPreference: 'shared', groupGender: opposite,
  });
  assert.deepEqual(result.selected_bed_codes, [], 'operator flag cannot override configured shared gender eligibility');
  assert.equal(validateExplicitBedSelection({
    bedRows: rows, blockRows: [], guestCount: 3, selectedBedCodes: ['R7-B1', 'R7-B2', 'R7-B3'],
    body: { room_preference: 'shared', group_gender: opposite },
  }).ok, false);
}
for (const can_be_matrimonial of [true, 'true']) {
  const result = runAvailabilityBedSelection({
    bedRows: bedRows.map(row => ({ ...row, can_be_matrimonial })), blockRows: [],
    guestCount: 3, roomPreference: 'private',
  });
  assert.deepEqual(result.selected_bed_codes, [], 'protected matrimonial flag retains its legacy policy');
}
console.log('PASS shared gender eligibility and matrimonial protection unchanged');
