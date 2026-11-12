'use strict';

/**
 * Mixed group (2 women in female-only + 1 man in mixed) must validate and
 * not refuse the save. keep_together across two rooms is a staff warning,
 * not a blocker. Occupancy still refuses a taken bed.
 *
 * Run: node scripts/verify-luna-mixed-group-split-save.js
 */
const assert = require('node:assert/strict');
const { validateExplicitBedSelection } = require('./lib/luna-bed-allocator');

function beds() {
  const female = [1, 2, 3].map((i) => ({
    bed_code: `R7-B${i}`,
    room_code: 'R7',
    room_type: 'female_only',
    gender_strategy: 'Female only',
    capacity: 3,
    can_be_matrimonial: false,
    bed_active: true,
    bed_sellable: true,
    selling_mode: 'shared',
  }));
  const mixed = [1, 2, 3].map((i) => ({
    bed_code: `R1-B${i}`,
    room_code: 'R1',
    room_type: 'mixed',
    gender_strategy: 'mixed',
    capacity: 3,
    can_be_matrimonial: false,
    bed_active: true,
    bed_sellable: true,
    selling_mode: 'shared',
  }));
  return female.concat(mixed);
}

const body = {
  keep_together: true,
  guests: [
    { name: 'Ada', explicit_gender: 'female' },
    { name: 'Bea', explicit_gender: 'female' },
    { name: 'Cal', explicit_gender: 'male' },
  ],
};

const ok = validateExplicitBedSelection({
  selectedBedCodes: ['R7-B1', 'R7-B2', 'R1-B1'],
  bedRows: beds(),
  blockRows: [],
  guestCount: 3,
  body,
});
assert.equal(ok.ok, true, JSON.stringify(ok));
assert.notEqual(ok.reason, 'same_room_unavailable');
assert.notEqual(ok.reason, 'incompatible_preselected_beds');
console.log('PASS mixed-group person-bound split is allowed (keep_together does not 409)');

const taken = validateExplicitBedSelection({
  selectedBedCodes: ['R7-B1', 'R7-B2', 'R1-B1'],
  bedRows: beds(),
  blockRows: [{ bed_code: 'R1-B1', room_code: 'R1' }],
  guestCount: 3,
  body,
});
assert.equal(taken.ok, false);
assert.equal(taken.reason, 'availability_changed');
console.log('PASS taken bed still refuses');
