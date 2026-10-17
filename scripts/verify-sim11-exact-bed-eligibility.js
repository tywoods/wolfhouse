'use strict';
const assert = require('node:assert/strict');
const {
  AVAILABILITY_CHANNELS,
  buildWolfhouseAvailabilityCommand,
  executeWolfhouseAvailabilityCheck,
  mapBotHttpAvailabilityResponse,
} = require('./lib/luna-front-desk-accommodation-availability-service');

const beds = [
  { bed_code: 'R7-B3', room_code: 'R7', room_type: 'operator_surfweek',
    gender_strategy: 'Flexible', selling_mode: 'shared', often_used_by_operator: true,
    bed_active: true, bed_sellable: true },
  { bed_code: 'R7-B4', room_code: 'R7', room_type: 'operator_surfweek',
    gender_strategy: 'Flexible', selling_mode: 'shared', often_used_by_operator: true,
    bed_active: true, bed_sellable: true },
];
function pg(blocks = []) {
  let call = 0;
  return { query: async () => ({ rows: call++ === 0 ? beds : blocks }) };
}
function pgRows(rows, blocks = []) {
  let call = 0;
  return { query: async () => ({ rows: call++ === 0 ? rows : blocks }) };
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
  const mapped = mapBotHttpAvailabilityResponse(valid.body);
  assert.deepEqual(mapped.exact_bed_eligibility, valid.body.exact_bed_eligibility);
  assert.equal(mapped.available_beds.length, 2, 'extra free beds remain inventory, not eligibility');
  if (process.argv.includes('--emit-valid-http-json')) {
    process.stdout.write(JSON.stringify(mapped));
    return;
  }

  const occupied = await executeWolfhouseAvailabilityCheck(
    pg([{ bed_code: 'R7-B3', room_code: 'R7' }]), command());
  assert.equal(occupied.body.exact_bed_eligibility.eligible, false);
  assert.equal(occupied.body.exact_bed_eligibility.reason, 'availability_changed');
  assert.deepEqual(occupied.body.exact_bed_eligibility.guest_bed_assignments, []);

  const changed = await executeWolfhouseAvailabilityCheck(pg(),
    command({ selected_bed_codes: ['R7-B5'] }));
  assert.equal(changed.body.exact_bed_eligibility.eligible, false);
  assert.equal(changed.body.exact_bed_eligibility.reason, 'availability_changed');
  assert.deepEqual(changed.body.exact_bed_eligibility.selected_bed_codes, ['R7-B5']);
  const privateBed = [{ bed_code: 'P1-B1', room_code: 'P1', room_type: 'mixed',
    gender_strategy: 'Flexible', selling_mode: 'private', bed_active: true, bed_sellable: true }];
  const privateValid = await executeWolfhouseAvailabilityCheck(
    pgRows(privateBed), command({ room_preference: 'private', selected_bed_codes: ['P1-B1'] }));
  const privateMapped = mapBotHttpAvailabilityResponse(privateValid.body);
  assert.equal(privateMapped.exact_bed_eligibility.eligible, true);
  const privateChanged = await executeWolfhouseAvailabilityCheck(
    pgRows(privateBed), command({ room_preference: 'shared', selected_bed_codes: ['P1-B1'] }));
  const privateChangedMapped = mapBotHttpAvailabilityResponse(privateChanged.body);
  assert.equal(privateChangedMapped.exact_bed_eligibility.eligible, false);
  console.log('PASS Staff-authoritative exact bed eligibility through HTTP mapper: valid with extra free bed, occupied, changed, private intent');
})().catch(err => { console.error(err); process.exitCode = 1; });
