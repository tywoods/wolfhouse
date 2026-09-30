'use strict';

// Synthetic inventory exercises the real allocator/availability functions, not a DB.
const assert = require('node:assert/strict');
const {
  computeWolfhouseAvailabilityInventory: inventory,
  buildWolfhouseAvailabilityCommand,
  executeWolfhouseAvailabilityCheck,
  mapBotHttpAvailabilityResponse,
  validateAvailabilityProvenanceForCreate,
} = require('./lib/luna-front-desk-accommodation-availability-service');
const { needsGenderAwareBedAssignment, runAvailabilityBedSelection } = require('./lib/luna-bed-allocator');
const { buildWolfhouseBookingCreateCommand } = require('./lib/luna-front-desk-accommodation-booking-create-service');
const { getBedCalendarRoomsQuery, getBedCalendarBlocksQuery } = require('./lib/staff-bed-calendar-queries');

function rows(roomCode, roomType, count, extra = {}) {
  return Array.from({ length: count }, (_, i) => ({
    bed_code: `${roomCode}-B${i + 1}`, room_code: roomCode,
    room_type: roomType, capacity: count, bed_active: true, bed_sellable: true,
    ...extra,
  }));
}
const command = { guestCount: 2, roomType: 'shared', roomPreference: 'mixed', assignmentMode: true };
const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('unknown mixed group must enter assignment validation, including cached beds', () => {
  assert.equal(needsGenderAwareBedAssignment(command), true);
});

test('female-only inventory blocks unknown mixed group without a handoff', () => {
  const result = inventory(rows('R5', 'female_only', 2), [], command);
  console.log('R5 REPRO', JSON.stringify(result));
  assert.deepEqual(result.selectedBedCodes, []);
  assert.equal(result.roomingHandoff, false);
  assert.equal(result.needsClarification, true);
  assert.equal(result.clarificationConflict, 'no_eligible_mixed_room');
  assert.equal(result.groupGenderResolved, 'unknown');
  assert.deepEqual(result.blockers, ['needs_clarification']);
});

test('unknown shared group cannot use spare gendered rooms through flip fallback', () => {
  const bedRows = [
    ...rows('R5', 'female_only', 2), ...rows('R8', 'female_only', 2),
    ...rows('R2', 'male_only', 2), ...rows('R4', 'male_only', 2),
    ...rows('R1', 'mixed', 1),
  ];
  const result = inventory(bedRows, [], { ...command, guestCount: 3, roomPreference: 'shared' });
  assert.deepEqual(result.selectedBedCodes, []);
  assert.equal(result.needsClarification, true);
  assert.equal(result.roomingHandoff, false);
  assert.equal(result.groupGenderResolved, 'unknown');
});

test('rules rollback cannot bypass unknown mixed eligibility', () => {
  const result = runAvailabilityBedSelection({
    bedRows: rows('R5', 'female_only', 2), ...command, useRules: false,
  });
  assert.deepEqual(result.selected_bed_codes, []);
  assert.equal(result.handoff, false);
  assert.equal(result.needs_clarification, true);
  assert.equal(result.group_gender, 'unknown');
});

// Regression matrix for the same safety boundary; no environment mutation.
for (const roomPreference of ['mixed', 'shared']) {
  for (const guestCount of [1, 2, 4]) {
    test(`${roomPreference}/${guestCount}: mixed beds win over smaller gendered rooms`, () => {
      const bedRows = [...rows('R5', 'female_only', guestCount), ...rows('R2', 'male_only', guestCount), ...rows('R1', 'mixed', 6)];
      const result = inventory(bedRows, [], { ...command, guestCount, roomPreference, guestName: 'Sarah' });
      assert.equal(result.selectedBedCodes.length, guestCount);
      assert.ok(result.selectedBedCodes.every((code) => code.startsWith('R1-')));
      assert.equal(result.groupGenderResolved, 'unknown');
      assert.equal(result.needsClarification, false);
      assert.equal(result.roomingHandoff, false);
      assert.deepEqual(result.blockers, []);
    });
    for (const category of ['female_only', 'male_only']) {
      test(`${roomPreference}/${guestCount}: ${category} alone stays blocked`, () => {
        const result = inventory(rows('R5', category, 6), [], { ...command, guestCount, roomPreference });
        assert.deepEqual(result.selectedBedCodes, []);
        assert.equal(result.groupGenderResolved, 'unknown');
        assert.equal(result.needsClarification, true);
        assert.equal(result.roomingHandoff, false);
      });
    }
    for (const useRules of [true, false]) {
      test(`${roomPreference}/${guestCount}: rules=${useRules} safe mixed placement`, () => {
        const bedRows = [...rows('R5', 'female_only', guestCount), ...rows('R1', 'mixed', 6)];
        const result = runAvailabilityBedSelection({ bedRows, guestCount, roomPreference, useRules });
        assert.equal(result.selected_bed_codes.length, guestCount);
        assert.ok(result.selected_bed_codes.every((code) => code.startsWith('R1-')));
        assert.equal(result.group_gender, 'unknown');
      });
    }
  }
}

test('partial mixed occupancy fills only free mixed beds, not partial female room', () => {
  const bedRows = [...rows('R5', 'female_only', 3), ...rows('R1', 'mixed', 4)];
  const blocks = [{ bed_code: 'R5-B1' }, { bed_code: 'R1-B1' }, { bed_code: 'R1-B2' }];
  const result = inventory(bedRows, blocks, command);
  assert.deepEqual(result.selectedBedCodes, ['R1-B3', 'R1-B4']);
  assert.equal(result.groupGenderResolved, 'unknown');
});

test('insufficient free mixed beds cannot be topped up with gendered capacity', () => {
  const bedRows = [...rows('R5', 'female_only', 3), ...rows('R1', 'mixed', 2)];
  const result = inventory(bedRows, [{ bed_code: 'R1-B1' }], command);
  assert.deepEqual(result.selectedBedCodes, []);
  assert.equal(result.needsClarification, true);
  assert.equal(result.roomingHandoff, false);
});

test('split across mixed and matrimonial-or-mixed rooms is safe', () => {
  const bedRows = [...rows('R5', 'female_only', 3), ...rows('R1', 'mixed', 2), ...rows('R3', 'matrimonial_or_mixed', 2)];
  const result = inventory(bedRows, [{ bed_code: 'R1-B1' }, { bed_code: 'R3-B1' }], command);
  assert.deepEqual(new Set(result.selectedBedCodes), new Set(['R1-B2', 'R3-B2']));
  assert.equal(result.allocationSplit, true);
  assert.deepEqual(result.blockers, []);
});

test('operator fallback respects full-room operator blocks', () => {
  const bedRows = [...rows('R5', 'female_only', 2), ...rows('R7', 'operator_surfweek', 3)];
  const open = inventory(bedRows, [], command);
  assert.deepEqual(open.selectedBedCodes, ['R7-B1', 'R7-B2']);
  const blocked = inventory(bedRows, [{ bed_code: 'R7-B1', room_code: 'R7', assignment_type: 'operator_block' }], command);
  assert.deepEqual(blocked.selectedBedCodes, []);
  assert.equal(blocked.needsClarification, true);
});

test('inactive and unsellable mixed beds do not satisfy safe capacity', () => {
  const bedRows = [...rows('R5', 'female_only', 2), ...rows('R1', 'mixed', 2, { bed_active: false }), ...rows('R3', 'mixed', 2, { bed_sellable: false })];
  const result = inventory(bedRows, [], command);
  assert.deepEqual(result.selectedBedCodes, []);
  assert.equal(result.needsClarification, true);
});

test('capacity-only early availability stays gender-neutral', () => {
  const bedRows = rows('R5', 'female_only', 2);
  const result = inventory(bedRows, [], { ...command, assignmentMode: false });
  assert.equal(result.hasEnoughBeds, true);
  assert.equal(result.groupGenderResolved, 'unknown');
  assert.equal(result.needsClarification, false);
  assert.deepEqual(result.blockers, []);
  for (const useRules of [true, false]) {
    const pick = runAvailabilityBedSelection({ bedRows, ...command, useRules, capacityOnly: true });
    assert.deepEqual(pick.selected_bed_codes, ['R5-B1', 'R5-B2']);
    assert.equal(pick.group_gender, 'unknown');
  }
});

test('explicit composition and opposite-room conflicts are preserved', () => {
  const bedRows = [...rows('R5', 'female_only', 2), ...rows('R2', 'male_only', 2), ...rows('R1', 'mixed', 2)];
  for (const [groupGender, roomPreference, roomCode] of [['female', 'female_only', 'R5'], ['male', 'male_only', 'R2'], ['mixed', 'mixed', 'R1']]) {
    const result = inventory(bedRows, [], { ...command, groupGender, roomPreference });
    // Existing male policy allows male-only OR mixed; do not tighten its ranking.
    if (groupGender === 'male') {
      assert.equal(result.selectedBedCodes.length, 2);
      assert.ok(result.selectedBedCodes.every((code) => /^(R1|R2)-/.test(code)));
    } else {
      assert.deepEqual(result.selectedBedCodes, [`${roomCode}-B1`, `${roomCode}-B2`]);
    }
    assert.equal(result.groupGenderResolved, groupGender);
  }
  for (const [groupGender, roomPreference] of [['male', 'female_only'], ['female', 'male_only']]) {
    const result = inventory(bedRows, [], { ...command, groupGender, roomPreference });
    assert.deepEqual(result.selectedBedCodes, []);
    assert.equal(result.needsClarification, true);
    assert.equal(result.roomingHandoff, false);
    assert.equal(result.groupGenderResolved, groupGender);
  }
});

test('private couple protected placement is unchanged', () => {
  const result = inventory([...rows('R6', 'matrimonial_private_couple', 2), ...rows('R5', 'female_only', 2)], [], { ...command, roomPreference: 'couple_private', roomType: 'double' });
  assert.deepEqual(result.selectedBedCodes, ['R6-B1', 'R6-B2']);
  assert.equal(result.groupGenderResolved, 'unknown');
});

// A strict in-memory query seam: only the two real read queries are accepted.
// It is NOT PostgreSQL and never executes booking/payment writes.
function readOnlyInventory(bedRows, blocks = []) {
  const calls = [];
  return { calls, query: async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM wh_pricing_items/.test(sql)) return { rows: [] }; // saved-policy read, JSON seed if no override
    if (sql === getBedCalendarRoomsQuery()) return { rows: bedRows };
    if (sql === getBedCalendarBlocksQuery()) return { rows: blocks };
    throw new Error('Unexpected query at read-only fixture seam');
  } };
}
const transport = {
  confirm: true, check_in: '2026-07-06', check_out: '2026-07-13',
  guest_count: 2, package_code: 'malibu', room_type: 'shared', room_preference: 'mixed',
  guest_name: 'Test Guest', phone: '+34000000000', payment_choice: 'full',
  selected_bed_codes: ['R5-B1', 'R5-B2'],
};
// Ten distinct rooms keep the production CSV enrichment from replacing our fixture.
function bookingRows(mixedAvailable) {
  return Array.from({ length: 10 }, (_, i) => {
    const code = `R${i + 1}`;
    return rows(code, code === 'R1' ? 'mixed' : 'female_only', 2, {
      bed_active: code === 'R5' || (code === 'R1' && mixedAvailable),
    });
  }).flat();
}

for (const roomPreference of ['mixed', 'shared']) {
  test(`cached gendered beds require a real preflight for ${roomPreference}`, async () => {
    const result = await buildWolfhouseBookingCreateCommand({
      quoteConfig: require('./lib/wolfhouse-quote-calculator').loadConfig(),
      channel: 'luna_whatsapp', trustedClientSlug: 'wolfhouse-somo',
      transportBody: { ...transport, room_preference: roomPreference },
    });
    assert.equal(result.ok, false);
    assert.equal(result.body.reason_code, 'database_required');
  });
  for (const mixedAvailable of [false, true]) {
    test(`booking preflight ${roomPreference}: cached beds ${mixedAvailable ? 'replaced by mixed' : 'blocked neutrally'}`, async () => {
      const pg = readOnlyInventory(bookingRows(mixedAvailable));
      const result = await buildWolfhouseBookingCreateCommand({
      quoteConfig: require('./lib/wolfhouse-quote-calculator').loadConfig(),
        channel: 'luna_whatsapp', trustedClientSlug: 'wolfhouse-somo', pgClient: pg,
        transportBody: { ...transport, room_preference: roomPreference },
      });
      assert.equal(pg.calls.length, 2);
      if (mixedAvailable) {
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.deepEqual(result.command.assignedBedCodes, ['R1-B1', 'R1-B2']);
        assert.equal(result.command.availabilityPreflightAssignmentMode, true);
      } else {
        assert.equal(result.ok, false);
        assert.equal(result.body.reason_code, 'needs_clarification');
        assert.equal(result.body.conflict, 'no_eligible_mixed_room');
        assert.equal(result.body.needs_human, false);
        assert.equal(result.body.do_not_escalate, true);
        assert.deepEqual(result.body.selected_bed_codes, []);
        assert.doesNotMatch(result.body.error, /gender|composition|male|female|men|women/i);
      }
    });
  }
}

test('canonical availability exposes neutral room clarification, not handoff', async () => {
  const built = buildWolfhouseAvailabilityCommand({ channel: 'booking_preflight', transportBody: transport, assignmentMode: true, demoCalendarEnrichment: false });
  assert.equal(built.ok, true);
  const result = await executeWolfhouseAvailabilityCheck(readOnlyInventory(rows('R5', 'female_only', 2)), built.command);
  assert.equal(result.ok, true);
  const body = mapBotHttpAvailabilityResponse(result.body);
  assert.equal(result.body.domain_next_action, 'ask_room_eligibility');
  assert.equal(body.next_action, 'ask_room_eligibility');
  assert.equal(result.body.needs_human, false);
  assert.equal(result.body.do_not_escalate, true);
  assert.equal(result.body.group_gender, 'unknown');
  assert.deepEqual(result.body.selected_bed_codes, []);
});

test('pre-commit recheck rejects a mixed room that becomes gendered', async () => {
  const initial = bookingRows(true);
  const built = await buildWolfhouseBookingCreateCommand({
      quoteConfig: require('./lib/wolfhouse-quote-calculator').loadConfig(),
    channel: 'luna_whatsapp', trustedClientSlug: 'wolfhouse-somo',
    pgClient: readOnlyInventory(initial), transportBody: transport,
  });
  assert.equal(built.ok, true);
  const changed = initial.map((row) => row.room_code === 'R1' ? { ...row, room_type: 'female_only' } : row);
  const pg = readOnlyInventory(changed);
  const result = await validateAvailabilityProvenanceForCreate(pg, built.command, built.command.availabilityProvenance);
  assert.equal(result.ok, false);
  assert.equal(result.body.reason_code, 'availability_changed');
  assert.equal(pg.calls.length, 3); // policy reload plus room/block SELECTs
});

async function main() {
  let passed = 0;
  for (const { name, run } of tests) {
    try { await run(); passed += 1; console.log(`PASS ${name}`); }
    catch (err) { console.error(`FAIL ${name}\n${err.stack}`); }
  }
  console.log(`Mixed-room allocation: ${passed}/${tests.length} passed (synthetic inventory; no DB or booking writes).`);
  if (passed !== tests.length) process.exitCode = 1;
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
