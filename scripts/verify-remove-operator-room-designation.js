'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveRoomCategory, runAvailabilityBedSelection, validateExplicitBedSelection } = require('./lib/luna-bed-allocator');

// Legacy designation must no longer create a separate eligibility/ranking tier.
assert.equal(resolveRoomCategory({ room_type: 'operator_surfweek', gender_strategy: 'Flexible', often_used_by_operator: true }), 'mixed');
assert.equal(resolveRoomCategory({ room_type: 'flexible', gender_strategy: 'Female preferred', often_used_by_operator: true }), 'female_only');
const source = fs.readFileSync(path.join(__dirname, 'lib/luna-bed-allocator.js'), 'utf8');
assert.doesNotMatch(source, /operator_surfweek|often_used_by_operator|allowOperator|operatorTier|operator_room_fallback|cram_mixed_operator/);

// After migration R7 is ordinary mixed inventory; its selling policy is independent.
for (const selling_mode of ['shared', 'private', 'private_optional']) {
  const bedRows = [1, 2, 3, 4].map(i => ({ bed_code: `R7-B${i}`, room_code: 'R7', room_type: 'mixed',
    gender_strategy: 'Flexible', selling_mode, capacity: 4, can_be_matrimonial: false,
    bed_active: true, bed_sellable: true }));
  for (const roomPreference of ['private', 'shared']) for (const blocked of [false, true]) {
    // Caller supplies only blocks overlapping the requested dates. A block on an
    // unselected sibling still excludes the whole room, not merely that bed.
    const blockRows = blocked ? [{ bed_code: 'R7-B4', room_code: 'R7', assignment_type: 'operator_block' }] : [];
    const allowed = !blocked && (roomPreference === 'private' ? selling_mode !== 'shared' : selling_mode !== 'private');
    for (const capacityOnly of [false, true]) for (const useRules of [false, true]) {
      const result = runAvailabilityBedSelection({ bedRows, blockRows, guestCount: 3, roomPreference, capacityOnly, useRules });
      assert.deepEqual(result.selected_bed_codes, allowed ? ['R7-B1', 'R7-B2', 'R7-B3'] : []);
      if (allowed && roomPreference === 'private') assert.equal(result.private_room, true);
    }
    const exact = validateExplicitBedSelection({ bedRows, blockRows, guestCount: 3,
      selectedBedCodes: ['R7-B3', 'R7-B1', 'R7-B2'], body: { room_preference: roomPreference } });
    assert.equal(exact.ok, allowed);
    if (allowed && roomPreference === 'private') assert.equal(exact.private_room, true);
  }
}
console.log('PASS designation removed; former R7 private/shared selling policies and actual date blocks across rules/rollback/capacity/exact selection');

const rows = (code, count, extra = {}) => Array.from({ length: count }, (_, i) => ({
  room_code: code, bed_code: `${code}-B${i + 1}`, room_type: 'mixed', gender_strategy: 'Flexible',
  capacity: count, selling_mode: 'private_optional', bed_active: true, bed_sellable: true, ...extra,
}));
const former = rows('R7', 4);
for (const capacityOnly of [false, true]) {
  assert.deepEqual(runAvailabilityBedSelection({ bedRows: former, blockRows: [],
    operatorBlockedRoomCodes: new Set(['R7']), guestCount: 3, roomPreference: 'private', capacityOnly }).selected_bed_codes, []);
  const blockRows = [{ room_code: 'R7', bed_code: 'R7-B4', assignment_type: 'guest' }];
  assert.deepEqual(runAvailabilityBedSelection({ bedRows: former, blockRows,
    occupiedBedCodes: new Set(['R7-B4']), guestCount: 3, roomPreference: 'private', capacityOnly }).selected_bed_codes, []);
  assert.equal(validateExplicitBedSelection({ bedRows: former, blockRows, guestCount: 3,
    selectedBedCodes: ['R7-B1', 'R7-B2', 'R7-B3'], body: { room_preference: 'private' } }).ok, false);
}
for (const room_type of ['female_only', 'male_only']) {
  const bedRows = rows('R7', 4, { room_type });
  const gender = room_type === 'female_only' ? 'male' : 'female';
  assert.deepEqual(runAvailabilityBedSelection({ bedRows, blockRows: [], guestCount: 3,
    groupGender: gender, roomPreference: 'shared' }).selected_bed_codes, []);
}
for (const room_type of ['matrimonial_private_couple', 'matrimonial_or_mixed']) {
  assert.deepEqual(runAvailabilityBedSelection({ bedRows: rows('R6', 4, { room_type, can_be_matrimonial: true }),
    blockRows: [], guestCount: 3, roomPreference: 'private' }).selected_bed_codes, []);
}
// R7 competes as ordinary mixed inventory, not a second-tier fallback. A female
// request without acceptance of mixed rooms retains the ordinary female policy.
assert.equal(runAvailabilityBedSelection({ bedRows: [...rows('R1', 5), ...former],
  blockRows: [], guestCount: 3, roomPreference: 'shared' }).selected_room_code, 'R7');
assert.deepEqual(runAvailabilityBedSelection({ bedRows: former, blockRows: [],
  guestCount: 3, groupGender: 'female' }).selected_bed_codes, []);
assert.equal(runAvailabilityBedSelection({ bedRows: former, blockRows: [],
  guestCount: 3, groupGender: 'female', roomPreference: 'shared' }).selected_room_code, 'R7');
console.log('PASS ordinary ranking/gender policy, matrimonial protection, occupied sibling and explicit operator-block set');
