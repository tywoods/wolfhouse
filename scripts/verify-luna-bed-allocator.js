'use strict';

/**
 * Unit tests for rules-based Luna bed allocator (chooseBeds).
 */

const {
  chooseBeds,
  chooseBedsCapacityOnly,
  resolveRoomCategory,
  deriveAllocatorContext,
  isRulesBasedRoomingEnabled,
} = require('./lib/luna-bed-allocator');

let passed = 0;
let failed = 0;

function check(id, ok, msg) {
  if (ok) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAIL ${id}: ${msg}`);
}

function beds(roomCode, n, availableMask) {
  const mask = availableMask || Array(n).fill(true);
  return mask.map((avail, i) => ({
    bed_code: `${roomCode}-B${i + 1}`,
    available: !!avail,
  }));
}

function room(code, opts) {
  const o = opts || {};
  return {
    room_code: code,
    room_type: o.room_type != null ? o.room_type : null,
    gender_strategy: o.gender_strategy || 'Flexible',
    capacity: o.capacity != null ? o.capacity : (o.beds || []).length,
    fill_priority: o.fill_priority != null ? o.fill_priority : 50,
    can_be_matrimonial: !!o.can_be_matrimonial,
    often_used_by_operator: !!o.often_used_by_operator,
    beds: o.beds || beds(code, o.capacity || 4),
  };
}

function pick(opts) {
  return chooseBeds({
    allowProtected: true,
    allowOperator: false,
    ...opts,
  });
}

// ── Category resolution from table fields ─────────────────────────────────────
check('CAT1', resolveRoomCategory({ gender_strategy: 'Male preferred' }) === 'male_only', 'Male preferred → male_only');
check('CAT2', resolveRoomCategory({ gender_strategy: 'Female preferred' }) === 'female_only', 'Female preferred → female_only');
check('CAT3', resolveRoomCategory({ gender_strategy: 'Mixed ok' }) === 'mixed', 'Mixed ok → mixed');
check('CAT4', resolveRoomCategory({ room_type: 'matrimonial_private_couple' }) === 'matrimonial_private_couple', 'canonical protected');
check('CAT5', resolveRoomCategory({ often_used_by_operator: true, gender_strategy: 'Flexible' }) === 'operator_surfweek', 'operator flag');
check('CAT6', resolveRoomCategory({ can_be_matrimonial: true, gender_strategy: 'Flexible' }) === 'matrimonial_or_mixed', 'matrimonial flag');

// ── Gender derivation ───────────────────────────────────────────────────────
check('CTX1', deriveAllocatorContext({ guestCount: 1, guestName: 'Sarah' }).groupGender === 'female', 'Sarah → female');
check('CTX2', deriveAllocatorContext({ guestCount: 1, guestName: 'Marco' }).groupGender === 'male', 'Marco → male');
check('CTX3', deriveAllocatorContext({ guestCount: 3, guestName: 'Sarah' }).groupGender === 'unknown', 'multi guest one name → unknown');
check('CTX4', deriveAllocatorContext({ guestCount: 2, roomPreference: 'private' }).roomPreference === 'private', 'private preference');

// ── Female solo never in male room ──────────────────────────────────────────
{
  const r = pick({
    guestCount: 1,
    groupGender: 'female',
    rooms: [
      room('R2', { gender_strategy: 'Male preferred', capacity: 5, fill_priority: 3, beds: beds('R2', 5) }),
      room('R1', { gender_strategy: 'Flexible', capacity: 5, fill_priority: 2, beds: beds('R1', 5) }),
    ],
  });
  check('F1', !r.handoff && r.room_code === 'R1', 'female solo picks mixed R1 not male R2');
  check('F2', !r.selected_bed_codes.some((c) => c.startsWith('R2-')), 'female solo never R2 beds');
}

{
  const r = pick({
    guestCount: 1,
    groupGender: 'female',
    rooms: [room('R2', { gender_strategy: 'Male preferred', capacity: 5, beds: beds('R2', 5) })],
  });
  check('F3', r.handoff && r.reason === 'no_eligible_room', 'female solo handoff when only male room');
}

// ── Male solo ───────────────────────────────────────────────────────────────
{
  const r = pick({
    guestCount: 1,
    groupGender: 'male',
    rooms: [
      room('R5', { gender_strategy: 'Female preferred', capacity: 6, beds: beds('R5', 6) }),
      room('R2', { gender_strategy: 'Male preferred', capacity: 5, beds: beds('R2', 5) }),
    ],
  });
  check('M1', r.room_code === 'R2', 'male solo picks male room');
}

// ── Mixed / unknown group → mixed room ──────────────────────────────────────
{
  const r = pick({
    guestCount: 2,
    groupGender: 'unknown',
    rooms: [
      room('R5', { gender_strategy: 'Female preferred', capacity: 6, beds: beds('R5', 6) }),
      room('R1', { gender_strategy: 'Flexible', capacity: 5, beds: beds('R1', 5) }),
    ],
  });
  check('U1', r.room_code === 'R1', 'unknown pair uses mixed room');
}

{
  const r = pick({
    guestCount: 2,
    groupGender: 'mixed',
    rooms: [room('R2', { gender_strategy: 'Male preferred', capacity: 5, beds: beds('R2', 5) })],
  });
  check('U2', r.handoff && r.reason === 'no_eligible_mixed_room', 'mixed group handoff without mixed room');
}

// ── Couple private ──────────────────────────────────────────────────────────
{
  const r = pick({
    guestCount: 2,
    groupGender: 'unknown',
    roomPreference: 'private',
    rooms: [
      room('R6', { room_type: 'Private-Only', gender_strategy: 'Private', capacity: 2, fill_priority: 99, beds: beds('R6', 2) }),
      room('R3', { can_be_matrimonial: true, gender_strategy: 'Flexible', capacity: 4, fill_priority: 1, beds: beds('R3', 4) }),
    ],
  });
  check('C1', r.room_code === 'R6' && r.reason === 'couple_protected_room', 'couple prefers protected R6');
}

{
  const r = pick({
    guestCount: 2,
    roomPreference: 'private',
    rooms: [
      room('R6', { room_type: 'Private-Only', gender_strategy: 'Private', capacity: 2, beds: beds('R6', 2, [false, true]) }),
      room('R3', { can_be_matrimonial: true, capacity: 4, beds: beds('R3', 4) }),
    ],
  });
  check('C2', r.room_code === 'R3' && r.reason === 'couple_matrimonial_or_mixed_empty_room', 'couple falls back to empty R3');
}

// ── Protected excluded for non-couples ──────────────────────────────────────
{
  const r = pick({
    guestCount: 1,
    groupGender: 'female',
    rooms: [
      room('R6', { room_type: 'Private-Only', gender_strategy: 'Private', capacity: 2, beds: beds('R6', 2) }),
      room('R5', { gender_strategy: 'Female preferred', capacity: 6, beds: beds('R5', 6) }),
    ],
  });
  check('P1', r.room_code === 'R5', 'solo does not take protected R6');
}

// ── Operator excluded by default ──────────────────────────────────────────
{
  const r = pick({
    guestCount: 2,
    groupGender: 'unknown',
    rooms: [
      room('R7', { often_used_by_operator: true, capacity: 4, beds: beds('R7', 4) }),
      room('R1', { gender_strategy: 'Flexible', capacity: 5, beds: beds('R1', 5) }),
    ],
  });
  check('O1', r.room_code === 'R1', 'operator room skipped by default');
}

// ── Consolidation / anti-fragmentation ──────────────────────────────────────
{
  const r = pick({
    guestCount: 2,
    groupGender: 'female',
    rooms: [
      room('R5', { gender_strategy: 'Female preferred', fill_priority: 4, beds: beds('R5', 6, [true, true, true, false, false, false]) }),
      room('R8', { gender_strategy: 'Female preferred', fill_priority: 6, beds: beds('R8', 5) }),
    ],
  });
  check('A1', r.room_code === 'R5', 'fills partial female dorm before empty');
}

// ── Oversized split / handoff ─────────────────────────────────────────────
{
  const r = pick({
    guestCount: 7,
    groupGender: 'unknown',
    rooms: [
      room('R1', { gender_strategy: 'Flexible', capacity: 3, beds: beds('R1', 3) }),
      room('R2', { gender_strategy: 'Mixed ok', capacity: 3, beds: beds('R2', 3) }),
      room('R3', { gender_strategy: 'Flexible', capacity: 3, beds: beds('R3', 3) }),
    ],
  });
  check('S1', r.handoff && r.reason === 'group_split_needs_staff', '7 guests across 3x3 needs staff');
}

// ── Determinism ───────────────────────────────────────────────────────────
{
  const opts = {
    guestCount: 2,
    groupGender: 'female',
    rooms: [
      room('R5', { gender_strategy: 'Female preferred', fill_priority: 4, beds: beds('R5', 6) }),
      room('R8', { gender_strategy: 'Female preferred', fill_priority: 6, beds: beds('R8', 5) }),
    ],
  };
  const a = JSON.stringify(pick(opts));
  const b = JSON.stringify(pick(opts));
  check('D1', a === b, 'deterministic picks');
}

// ── Legacy rollback path ────────────────────────────────────────────────────
{
  const legacy = chooseBedsCapacityOnly({
    guestCount: 2,
    rooms: [
      room('R2', { gender_strategy: 'Male preferred', capacity: 5, beds: beds('R2', 5) }),
      room('R4', { gender_strategy: 'Mixed ok', capacity: 9, beds: beds('R4', 9) }),
    ],
  });
  check('L1', legacy.room_code === 'R2', 'legacy picks smallest fitting room');
}

check('FLAG1', isRulesBasedRoomingEnabled() === true, 'rules rooming default on');

console.log(`\n── verify:luna-bed-allocator ${failed ? 'FAILED' : 'PASSED'} (${passed}/${passed + failed}) ──`);
process.exit(failed > 0 ? 1 : 0);
