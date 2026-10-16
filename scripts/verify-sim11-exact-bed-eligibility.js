'use strict';
const assert = require('node:assert/strict');
const {
  AVAILABILITY_CHANNELS,
  buildWolfhouseAvailabilityCommand,
  executeWolfhouseAvailabilityCheck,
} = require('./lib/luna-front-desk-accommodation-availability-service');

const beds = [
  { bed_code: 'R7-B3', room_code: 'R7', room_type: 'operator_surfweek',
    gender_strategy: 'Flexible', selling_mode: 'shared', often_used_by_operator: true,
    bed_active: true, bed_sellable: true },
];
function pg(blocks = []) {
  let call = 0;
  return { query: async () => ({ rows: call++ === 0 ? beds : blocks }) };
}
function command(overrides = {}) {
  const transportBody = {
    check_in: '2026-10-25', check_out: '2026-10-28', guest_count: 1,
    room_type: 'any', room_preference: 'shared',
    guests: [{ name: 'Holly' }], selected_bed_codes: ['R7-B3'],
    ...overrides,
  };
  const built = buildWolfhouseAvailabilityCommand({
    channel: AVAILABILITY_CHANNELS.BOT_HTTP,
    trustedClientSlug: 'wolfhouse-somo', transportBody,
    quoteConfig: { package_min_nights: 1 },
    demoCalendarEnrichment: false,
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  return built.command;
}

(async () => {
  const valid = await executeWolfhouseAvailabilityCheck(pg(), command());
  assert.equal(valid.ok, true, JSON.stringify(valid));
  assert.equal(valid.body.exact_bed_eligibility.eligible, true);
  assert.deepEqual(valid.body.exact_bed_eligibility.selected_bed_codes, ['R7-B3']);
  assert.deepEqual(valid.body.exact_bed_eligibility.guest_bed_assignments,
    [{ guest_index: 0, guest_name: 'Holly', bed_code: 'R7-B3' }]);

  const occupied = await executeWolfhouseAvailabilityCheck(
    pg([{ bed_code: 'R7-B3', room_code: 'R7' }]), command());
  assert.equal(occupied.body.exact_bed_eligibility.eligible, false);
  assert.equal(occupied.body.exact_bed_eligibility.reason, 'availability_changed');
  assert.deepEqual(occupied.body.exact_bed_eligibility.guest_bed_assignments, []);

  const changed = await executeWolfhouseAvailabilityCheck(pg(),
    command({ selected_bed_codes: ['R7-B4'] }));
  assert.equal(changed.body.exact_bed_eligibility.eligible, false);
  assert.equal(changed.body.exact_bed_eligibility.reason, 'availability_changed');
  assert.deepEqual(changed.body.exact_bed_eligibility.selected_bed_codes, ['R7-B4']);
  console.log('PASS Staff-authoritative exact bed eligibility: valid, occupied, changed');
})().catch(err => { console.error(err); process.exitCode = 1; });
