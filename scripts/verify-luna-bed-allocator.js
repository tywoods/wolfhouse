'use strict';

/**
 * Unit tests for rules-based Luna bed allocator — Wolfhouse R1–R10 layout.
 */

const {
  chooseBeds,
  chooseBedsCapacityOnly,
  resolveRoomCategory,
  deriveAllocatorContext,
  allowedCategoriesForGroup,
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

/** Live Wolfhouse room layout (from Rooms table / baseline). */
function wolfhouseRoom(code, opts) {
  const layout = {
    R1: { room_type: 'mixed', gender_strategy: 'Flexible', capacity: 5, fill_priority: 2 },
    R2: { room_type: 'male_only', gender_strategy: 'Male preferred', capacity: 5, fill_priority: 3 },
    R3: { room_type: 'matrimonial_or_mixed', gender_strategy: 'Flexible', capacity: 4, fill_priority: 1, can_be_matrimonial: true },
    R4: { room_type: 'male_only', gender_strategy: 'Male preferred', capacity: 9, fill_priority: 9 },
    R5: { room_type: 'female_only', gender_strategy: 'Female preferred', capacity: 6, fill_priority: 4 },
    R6: { room_type: 'matrimonial_private_couple', gender_strategy: 'Private', capacity: 2, fill_priority: 99, can_be_matrimonial: true },
    R7: { room_type: 'operator_surfweek', gender_strategy: 'Flexible', capacity: 4, fill_priority: 5, often_used_by_operator: true },
    R8: { room_type: 'female_only', gender_strategy: 'Female preferred', capacity: 5, fill_priority: 6 },
    R9: { room_type: 'operator_surfweek', gender_strategy: 'Flexible', capacity: 6, fill_priority: 7, often_used_by_operator: true },
    R10: { room_type: 'operator_surfweek', gender_strategy: 'Flexible', capacity: 6, fill_priority: 8, often_used_by_operator: true },
  };
  const base = layout[code];
  const o = opts || {};
  const cap = o.capacity != null ? o.capacity : base.capacity;
  return {
    room_code: code,
    room_type: o.room_type != null ? o.room_type : base.room_type,
    gender_strategy: o.gender_strategy || base.gender_strategy,
    capacity: cap,
    fill_priority: o.fill_priority != null ? o.fill_priority : base.fill_priority,
    can_be_matrimonial: o.can_be_matrimonial != null ? o.can_be_matrimonial : !!base.can_be_matrimonial,
    often_used_by_operator: o.often_used_by_operator != null ? o.often_used_by_operator : !!base.often_used_by_operator,
    beds: o.beds || beds(code, cap, o.availableMask),
  };
}

function wolfhouseAll(opts) {
  const o = opts || {};
  return ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10'].map((c) => wolfhouseRoom(c, o[c] || {}));
}

function pick(opts) {
  return chooseBeds({
    allowProtected: true,
    allowOperator: false,
    rooms: opts.rooms || wolfhouseAll(),
    ...opts,
  });
}

function roomCodesFromBeds(selected) {
  return [...new Set((selected || []).map((b) => b.replace(/-B\d+$/, '')))];
}

// ── Category + data ─────────────────────────────────────────────────────────
check('CAT1', resolveRoomCategory(wolfhouseRoom('R4')) === 'male_only', 'R4 male_only not mixed');
check('CAT2', resolveRoomCategory(wolfhouseRoom('R5')) === 'female_only', 'R5 female_only');
check('CAT3', resolveRoomCategory(wolfhouseRoom('R7')) === 'operator_surfweek', 'R7 operator');

// ── Context ─────────────────────────────────────────────────────────────────
check('CTX1', deriveAllocatorContext({ guestCount: 1, guestName: 'Sarah' }).groupGender === 'female', 'Sarah → female');
check('CTX2', deriveAllocatorContext({ guestCount: 8, guestName: 'Sarah' }).groupGender === 'unknown', '8 guests one name → unknown');
check('CTX3', allowedCategoriesForGroup('female', null).has('female_only') && !allowedCategoriesForGroup('female', null).has('mixed'), 'female default female_only only');

// ── Female solo → female room, never R3/R4 ──────────────────────────────────
{
  const r = pick({ guestCount: 1, groupGender: 'female' });
  check('F1', r.room_code === 'R5' || r.room_code === 'R8', `female solo in female room (${r.room_code})`);
  check('F2', !roomCodesFromBeds(r.selected_bed_codes).some((c) => c === 'R3' || c === 'R4' || c === 'R1'), 'never mixed R1/R3 or male R4');
}

// ── Female explicit girls room ──────────────────────────────────────────────
{
  const r = pick({ guestCount: 2, groupGender: 'female', roomPreference: 'female_only' });
  check('F3', roomCodesFromBeds(r.selected_bed_codes).every((c) => c === 'R5' || c === 'R8'), 'female_only pref stays in R5/R8');
}

// ── Female pair consolidates into partial female room ───────────────────────
{
  const r = pick({
    guestCount: 2,
    groupGender: 'female',
    rooms: wolfhouseAll({
      R5: { availableMask: [false, false, false, true, true, true] },
      R8: {},
    }),
  });
  check('F4', r.room_code === 'R5', 'female pair backfills partial R5');
}

// ── Female group 4 → empty female room (own room rule) ──────────────────────
{
  const r = pick({
    guestCount: 4,
    groupGender: 'female',
    rooms: wolfhouseAll({
      R5: { availableMask: [false, true, true, true, true, true] },
      R8: {},
    }),
  });
  check('F5', r.room_code === 'R8', 'female group 4 takes empty R8 not partial R5');
}

// ── Female group 8 → split female rooms, never R4 ───────────────────────────
{
  const r = pick({ guestCount: 8, groupGender: 'female' });
  check('F6', !r.handoff && r.split, 'female 8 splits across female rooms');
  check('F7', !roomCodesFromBeds(r.selected_bed_codes).includes('R4'), 'female 8 never R4');
  check('F8', roomCodesFromBeds(r.selected_bed_codes).every((c) => c === 'R5' || c === 'R8'), 'female 8 only R5/R8');
}

// ── Female explicit mixed preference may use R1 ─────────────────────────────
{
  const r = pick({ guestCount: 1, groupGender: 'female', roomPreference: 'mixed' });
  check('F9', r.room_code === 'R1', 'female + mixed pref may use R1');
}

// ── Male solo/group ─────────────────────────────────────────────────────────
{
  const r = pick({ guestCount: 1, groupGender: 'male' });
  check('M1', r.room_code === 'R2' || r.room_code === 'R1', `male solo male or mixed (${r.room_code})`);
}
{
  const r = pick({ guestCount: 3, groupGender: 'male' });
  check('M2', r.room_code === 'R2' || r.room_code === 'R1', 'male group 3 in male or mixed');
  check('M3', !roomCodesFromBeds(r.selected_bed_codes).includes('R5'), 'male never R5');
}

// ── Unknown/mixed group → mixed only ────────────────────────────────────────
{
  const r = pick({ guestCount: 2, groupGender: 'unknown' });
  check('U1', r.room_code === 'R1', 'unknown pair → R1 mixed');
}
{
  const r = pick({ guestCount: 8, groupGender: 'unknown' });
  check('U2', !roomCodesFromBeds(r.selected_bed_codes).includes('R4'), 'unknown 8 never male R4');
  check('U3', r.handoff || (r.split && roomCodesFromBeds(r.selected_bed_codes).every((c) => c === 'R1')), 'unknown 8 mixed split or handoff');
}

// ── Couple + private ──────────────────────────────────────────────────────────
{
  const r = pick({ guestCount: 2, roomPreference: 'private' });
  check('C1', r.room_code === 'R6' && r.reason === 'couple_protected_room', 'couple → R6');
}
{
  const r = pick({
    guestCount: 2,
    roomPreference: 'private',
    rooms: wolfhouseAll({ R6: { availableMask: [false, false] } }),
  });
  check('C2', r.room_code === 'R3' && r.reason === 'couple_matrimonial_or_mixed_empty_room', 'couple fallback R3 joined');
}

// ── Protected / operator ────────────────────────────────────────────────────
{
  const r = pick({ guestCount: 1, groupGender: 'female' });
  check('P1', r.room_code !== 'R6', 'non-couple skips R6');
}
{
  const r = pick({ guestCount: 2, groupGender: 'unknown' });
  check('O1', !roomCodesFromBeds(r.selected_bed_codes).some((c) => ['R7', 'R9', 'R10'].includes(c)), 'operator rooms excluded');
}

// ── Size fill: ≤2 consolidate vs ≥3 own room ────────────────────────────────
{
  const r = pick({
    guestCount: 1,
    groupGender: 'female',
    rooms: wolfhouseAll({
      R5: { availableMask: [false, false, false, true, true, true] },
      R8: {},
    }),
  });
  check('S1', r.room_code === 'R5', 'solo female consolidates into partial R5');
}

// ── Determinism ─────────────────────────────────────────────────────────────
{
  const opts = { guestCount: 2, groupGender: 'female' };
  check('D1', JSON.stringify(pick(opts)) === JSON.stringify(pick(opts)), 'deterministic');
}

// ── Legacy rollback ─────────────────────────────────────────────────────────
{
  const legacy = chooseBedsCapacityOnly({
    guestCount: 2,
    rooms: [wolfhouseRoom('R2'), wolfhouseRoom('R4')],
  });
  check('L1', legacy.room_code === 'R2', 'legacy smallest room');
}

check('FLAG1', isRulesBasedRoomingEnabled() === true, 'rules rooming default on');

console.log(`\n── verify:luna-bed-allocator ${failed ? 'FAILED' : 'PASSED'} (${passed}/${passed + failed}) ──`);
process.exit(failed > 0 ? 1 : 0);
