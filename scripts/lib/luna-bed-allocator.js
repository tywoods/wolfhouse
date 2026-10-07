/**
 * Rules-based bed/room allocator for Luna availability checks.
 * Data-driven from room_type, gender_strategy, fill_priority — not hardcoded room IDs.
 *
 * @module luna-bed-allocator
 */

'use strict';

const { normalizeGroupGender } = require('./luna-booking-intake-policy');

const CANONICAL_ROOM_TYPES = new Set([
  'male_only',
  'female_only',
  'mixed',
  'matrimonial_or_mixed',
  'matrimonial_private_couple',
  'operator_surfweek',
]);

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function normalizeToken(s) {
  return trimStr(s).toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizePref(s) {
  const p = normalizeToken(s);
  if (!p) return null;
  if (p === 'female' || p === 'female_only' || p === 'girls' || p === 'girls_room') return 'female_only';
  if (p === 'male' || p === 'male_only' || p === 'guys' || p === 'guys_room'
    || p === 'mens' || p === 'mens_room' || p === 'men' || p === 'men_s_room' || p === 'mensroom') {
    return 'male_only';
  }
  if (p === 'private' || p === 'couple' || p === 'couple_private' || p === 'private_room'
    || p === 'matrimonial' || p === 'double') return 'private';
  if (p === 'mixed' || p === 'shared') return 'mixed';
  return p;
}

function isRulesBasedRoomingEnabled() {
  const env = trimStr(process.env.LUNA_RULES_BASED_ROOMING).toLowerCase();
  if (env === '0' || env === 'false' || env === 'off' || env === 'no') return false;
  if (env === '1' || env === 'true' || env === 'on' || env === 'yes') return true;
  return true;
}

/**
 * Map DB/CSV room fields to canonical room category.
 */
function resolveRoomCategory(room) {
  const rt = normalizeToken(room.room_type);
  if (CANONICAL_ROOM_TYPES.has(rt)) return rt;
  if (rt === 'private_only') return 'matrimonial_private_couple';

  if (room.often_used_by_operator === true || room.often_used_by_operator === 'true') {
    return 'operator_surfweek';
  }

  const gs = normalizeToken(room.gender_strategy);
  const cap = Number(room.capacity) || 0;

  if (gs === 'private' || (rt.includes('private') && cap <= 2)) {
    return 'matrimonial_private_couple';
  }
  if (room.can_be_matrimonial === true || room.can_be_matrimonial === 'true') {
    return 'matrimonial_or_mixed';
  }
  if (gs.includes('female')) return 'female_only';
  if (gs.includes('male') && !gs.includes('mixed')) return 'male_only';
  if (gs.includes('mixed')) return 'mixed';
  return 'mixed';
}

function isCoupleRequest(guestCount, roomPreference) {
  const rp = normalizePref(roomPreference);
  return guestCount === 2 && (rp === 'private' || rp === 'couple');
}

// New selling modes never override protected legacy categories or flags.
function ordinarySellingMode(room) {
  if (!['female_only', 'male_only', 'mixed'].includes(room.room_type)
    || room.can_be_matrimonial === true || room.can_be_matrimonial === 'true'
    || room.often_used_by_operator === true || room.often_used_by_operator === 'true') return null;
  return room.selling_mode || 'shared';
}

function privateSellingSelection(rooms, guestCount, roomPreference) {
  if (normalizePref(roomPreference) !== 'private') return null;
  const candidates = rooms.filter(room => ['private', 'private_optional'].includes(ordinarySellingMode(room))
    && !room.operator_blocked && countOccupied(room) === 0 && countAvailable(room) >= guestCount);
  if (!candidates.length) return null;
  const winner = sortRoomsByRank(candidates, guestCount)[0];
  return { selected_bed_codes: pickBeds(winner, guestCount), room_code: winner.room_code,
    private_room: true, split: false, reason: 'exclusive_private_room' };
}

function needsGenderAwareBedAssignment({
  guestCount,
  groupGender,
  genderPreference,
  roomPreference,
}) {
  const rp = normalizePref(roomPreference || genderPreference);
  const explicit = normalizeGroupGender(groupGender) || normalizeGroupGender(genderPreference);
  const count = Math.max(1, Number(guestCount) || 1);
  return count < 2
    || !!explicit
    // Accepted mixed/shared is a placement constraint, even without composition.
    // Booking preflight uses this predicate to revalidate cached bed selections.
    || rp === 'mixed'
    || rp === 'private'
    || rp === 'female_only'
    || rp === 'male_only';
}

function countAvailable(room) {
  return (room.beds || []).filter((b) => b.available).length;
}

function countOccupied(room) {
  return totalBeds(room) - countAvailable(room);
}

function totalBeds(room) {
  return (room.beds || []).length;
}

function pickBeds(room, n) {
  return (room.beds || [])
    .filter((b) => b.available)
    .sort((a, b) => String(a.bed_code).localeCompare(String(b.bed_code)))
    .slice(0, n)
    .map((b) => b.bed_code);
}

/**
 * Hard gender eligibility — which room categories may be used for this group.
 * matrimonial_or_mixed (R3) counts as mixed dorm capacity for non-couple groups.
 */
function allowedCategoriesForGroup(groupGender, roomPreference) {
  const gender = groupGender || 'unknown';
  const rp = normalizePref(roomPreference);
  const mixedPool = new Set(['mixed', 'matrimonial_or_mixed']);

  if (gender === 'female') {
    if (rp === 'mixed') return new Set(['female_only', 'mixed', 'matrimonial_or_mixed']);
    return new Set(['female_only']);
  }
  if (gender === 'male') {
    return new Set(['male_only', 'mixed']);
  }
  return mixedPool;
}

function categoryAllowedForGroup(category, allowed) {
  return allowed.has(category);
}

function isDedicatedMixedCategory(category) {
  return category === 'mixed' || category === 'matrimonial_or_mixed';
}

/**
 * Empty gendered spare rooms that may be flipped to mixed for this stay.
 * Keeps at least one female-only and one male-only room reserved as gendered.
 */
function findFlippableGenderedRooms(rooms) {
  const enriched = rooms.map(enrichRoom);
  const femaleRooms = enriched.filter((r) => r.category === 'female_only');
  const maleRooms = enriched.filter((r) => r.category === 'male_only');
  const flipped = [];

  const emptyFemale = femaleRooms.filter((r) => countOccupied(r) === 0);
  if (femaleRooms.length >= 2 && emptyFemale.length >= 1) {
    const spare = [...emptyFemale].sort(
      (a, b) => (Number(a.fill_priority) || 0) - (Number(b.fill_priority) || 0)
        || String(a.room_code).localeCompare(String(b.room_code)),
    ).pop();
    if (spare) flipped.push({ ...spare, category: 'mixed', flipped_from: 'female_only' });
  }

  const emptyMale = maleRooms.filter((r) => countOccupied(r) === 0);
  if (maleRooms.length >= 2 && emptyMale.length >= 1) {
    const spare = [...emptyMale].sort(
      (a, b) => (Number(a.fill_priority) || 0) - (Number(b.fill_priority) || 0)
        || String(a.room_code).localeCompare(String(b.room_code)),
    ).pop();
    if (spare) flipped.push({ ...spare, category: 'mixed', flipped_from: 'male_only' });
  }

  return flipped;
}

function expandRoomsWithFlippedMixed(rooms) {
  const base = rooms.map((r) => ({
    ...r,
    beds: (r.beds || []).map((b) => ({ ...b })),
  }));
  const byCode = new Map(base.map((r) => [r.room_code, r]));
  for (const flip of findFlippableGenderedRooms(base)) {
    const room = byCode.get(flip.room_code);
    if (room) room._flippedToMixed = true;
  }
  return base.map((r) => {
    const enriched = enrichRoom(r);
    if (r._flippedToMixed) {
      return { ...enriched, category: 'mixed', flipped_from: enriched.category };
    }
    return enriched;
  });
}

function roomEligibleForGroup(category, groupGender, opts) {
  const { guestCount, roomPreference, allowProtected, allowOperator } = opts;

  if (category === 'operator_surfweek') return !!allowOperator;

  if (category === 'matrimonial_private_couple') {
    return isCoupleRequest(guestCount, roomPreference) && allowProtected !== false;
  }

  const allowed = allowedCategoriesForGroup(groupGender, roomPreference);
  return categoryAllowedForGroup(category, allowed);
}

function enrichRoom(room) {
  return {
    ...room,
    category: resolveRoomCategory(room),
  };
}

function rankRoom(room, guestCount) {
  const available = countAvailable(room);
  const occupied = countOccupied(room);
  const leftover = available - guestCount;
  const fillPriority = room.fill_priority != null ? Number(room.fill_priority) : 999;

  if (guestCount <= 2) {
    const isPartial = occupied > 0;
    return {
      partialFirst: isPartial ? 0 : 1,
      fullnessAfter: isPartial ? -(occupied + guestCount) : 0,
      leftover,
      fill_priority: fillPriority,
      room_code: room.room_code,
    };
  }

  const isEmpty = occupied === 0;
  return {
    emptyFirst: isEmpty ? 0 : 1,
    leftover,
    fill_priority: fillPriority,
    room_code: room.room_code,
  };
}

function compareRank(a, b) {
  if (a.partialFirst != null && b.partialFirst != null) {
    if (a.partialFirst !== b.partialFirst) return a.partialFirst - b.partialFirst;
    if (a.fullnessAfter !== b.fullnessAfter) return a.fullnessAfter - b.fullnessAfter;
  }
  if (a.emptyFirst != null && b.emptyFirst != null) {
    if (a.emptyFirst !== b.emptyFirst) return a.emptyFirst - b.emptyFirst;
  }
  if (a.leftover !== b.leftover) return a.leftover - b.leftover;
  if (a.fill_priority !== b.fill_priority) return a.fill_priority - b.fill_priority;
  return String(a.room_code).localeCompare(String(b.room_code));
}

function sortRoomsByRank(rooms, guestCount) {
  return [...rooms]
    .map((r) => ({ room: r, rank: rankRoom(r, guestCount) }))
    .sort((a, b) => compareRank(a.rank, b.rank))
    .map((x) => x.room);
}

function pickReason(room, guestCount, split, cram) {
  if (cram) return 'cram_gender_eligible_rooms';
  if (split) return 'split_across_eligible_rooms';
  const cat = room.category;
  if (cat === 'female_only') return 'female_default_female_room';
  if (cat === 'male_only') return 'male_default_male_room';
  if (guestCount <= 2 && countOccupied(room) > 0) return 'consolidate_partial_room';
  if (guestCount >= 3 && countOccupied(room) === 0) return 'own_empty_room';
  return 'single_mixed_or_best_fit_room';
}

function tryCouplePlacement(rooms, opts) {
  const eligibleProtected = rooms
    .map(enrichRoom)
    .filter((r) => r.category === 'matrimonial_private_couple'
      && roomEligibleForGroup(r.category, opts.groupGender, opts)
      && countAvailable(r) >= 2);

  if (eligibleProtected.length) {
    const winner = sortRoomsByRank(eligibleProtected, 2)[0];
    return {
      selected_bed_codes: pickBeds(winner, 2),
      room_code: winner.room_code,
      split: false,
      reason: 'couple_protected_room',
    };
  }

  const eligibleJoined = rooms
    .map(enrichRoom)
    .filter((r) => r.category === 'matrimonial_or_mixed'
      && countAvailable(r) >= 2
      && countAvailable(r) === totalBeds(r));

  if (eligibleJoined.length) {
    const winner = sortRoomsByRank(eligibleJoined, 2)[0];
    return {
      selected_bed_codes: pickBeds(winner, 2),
      room_code: winner.room_code,
      split: false,
      reason: 'couple_matrimonial_or_mixed_empty_room',
    };
  }

  return null;
}

function cramAcrossEligibleRooms(eligible, guestCount) {
  const sorted = sortRoomsByRank(
    eligible.filter((r) => countAvailable(r) > 0),
    guestCount,
  );
  const plan = [];
  let rem = guestCount;
  for (const room of sorted) {
    if (rem <= 0) break;
    const take = Math.min(rem, countAvailable(room));
    if (take <= 0) continue;
    plan.push({ room, take });
    rem -= take;
  }
  return rem <= 0 ? plan : null;
}

/** Cram with strict tier order: lower tier rooms fill before higher tiers. */
function cramAcrossTierOrdered(rooms, guestCount) {
  const sorted = [...rooms]
    .filter((r) => countAvailable(r) > 0)
    .sort((a, b) => {
      const ta = a._allocTier != null ? a._allocTier : 999;
      const tb = b._allocTier != null ? b._allocTier : 999;
      if (ta !== tb) return ta - tb;
      return compareRank(rankRoom(a, guestCount), rankRoom(b, guestCount));
    });
  const plan = [];
  let rem = guestCount;
  for (const room of sorted) {
    if (rem <= 0) break;
    const take = Math.min(rem, countAvailable(room));
    if (take <= 0) continue;
    plan.push({ room, take });
    rem -= take;
  }
  return rem <= 0 ? plan : null;
}

function singleRoomReasonForTier(tier, room, guestCount) {
  if (tier === 2) return 'operator_room_fallback';
  if (tier === 3) return 'flipped_gendered_room_to_mixed';
  return pickReason(room, guestCount, false, false);
}

function cramReasonForTier(maxTier, plan) {
  const usedFlip = plan.some((p) => p.room.flipped_from);
  const usedOperator = plan.some((p) => enrichRoom(p.room).category === 'operator_surfweek');
  if (maxTier >= 3 && usedFlip) return 'cram_flipped_mixed_rooms';
  if (maxTier >= 2 && usedOperator) return 'cram_mixed_operator_rooms';
  return 'cram_gender_eligible_rooms';
}

function mergeSafetyOpts(...optsList) {
  const merged = {};
  for (const o of optsList) {
    if (!o) continue;
    if (o.allowOperator) merged.allowOperator = true;
    if (o.allowFlip) merged.allowFlip = true;
  }
  return merged;
}

/**
 * Place guests using tier pools in order. Single-room wins stay within the earliest
 * tier that fits; overflow crams cumulatively across tiers (1, then 1+2, then 1+2+3).
 */
function tryPlaceWithTieredPools({
  pools,
  guestCount,
  groupGender,
  roomPreference,
}) {
  const activePools = (pools || []).filter((p) => p.rooms && p.rooms.length);
  if (!activePools.length) return null;

  // Single-room fit — dedicated tier only (keeps small groups off operator/flip)
  const firstPool = activePools[0];
  if (firstPool) {
    const eligible = firstPool.rooms.filter(
      (r) => roomEligibleForGroup(r.category, groupGender, firstPool.allocOpts) && countAvailable(r) > 0,
    );
    const fitting = eligible.filter((r) => countAvailable(r) >= guestCount);
    if (fitting.length) {
      const winner = sortRoomsByRank(fitting, guestCount)[0];
      const result = {
        selected_bed_codes: pickBeds(winner, guestCount),
        room_code: winner.room_code,
        split: false,
        reason: pickReason(winner, guestCount, false, false),
      };
      if (!assertSelectionGenderSafe(result, eligible, groupGender, roomPreference, firstPool.safetyOpts)) {
        return { handoff: true, reason: 'gender_eligibility_violation' };
      }
      return result;
    }
  }

  // Cumulative tier cram (overflow combines tiers; no single-room in operator/flip)
  const cumulative = [];
  const cumulativeEligible = [];
  const cumulativeSafety = [];
  for (const pool of activePools) {
    const eligible = pool.rooms.filter(
      (r) => roomEligibleForGroup(r.category, groupGender, pool.allocOpts) && countAvailable(r) > 0,
    );
    for (const r of eligible) {
      cumulative.push({ ...r, _allocTier: pool.tier });
      cumulativeEligible.push(r);
      cumulativeSafety.push(pool.safetyOpts);
    }
    const totalAvail = cumulative.reduce((s, r) => s + countAvailable(r), 0);
    if (totalAvail < guestCount) continue;

    const cramPlan = cramAcrossTierOrdered(cumulative, guestCount);
    if (!cramPlan) continue;

    const result = buildCramSelection(cramPlan, guestCount);
    result.reason = cramReasonForTier(pool.tier, cramPlan);
    if (!assertSelectionGenderSafe(
      result,
      cumulativeEligible,
      groupGender,
      roomPreference,
      mergeSafetyOpts(...cumulativeSafety),
    )) {
      return { handoff: true, reason: 'gender_eligibility_violation' };
    }
    return result;
  }

  return null;
}

function buildCramSelection(plan, guestCount) {
  const selected = [];
  let primaryRoom = null;
  for (const part of plan) {
    if (!primaryRoom) primaryRoom = part.room.room_code;
    selected.push(...pickBeds(part.room, part.take));
  }
  const multiRoom = plan.length > 1;
  return {
    selected_bed_codes: selected,
    room_code: primaryRoom,
    split: multiRoom,
    reason: multiRoom
      ? pickReason(plan[0].room, guestCount, true, true)
      : pickReason(plan[0].room, guestCount, false, false),
  };
}

function assertSelectionGenderSafe(selection, eligibleRooms, groupGender, roomPreference, opts = {}) {
  const byCode = new Map(eligibleRooms.map((r) => [r.room_code, r]));
  const allowed = allowedCategoriesForGroup(groupGender, roomPreference);
  if (opts.allowOperator) allowed.add('operator_surfweek');
  for (const bedCode of selection.selected_bed_codes || []) {
    const roomCode = String(bedCode).replace(/-B\d+$/, '');
    const room = byCode.get(roomCode);
    if (!room) return false;
    if (room.flipped_from === 'female_only' || room.flipped_from === 'male_only') {
      if (!allowed.has('mixed') && !allowed.has('matrimonial_or_mixed') && !opts.allowFlip) {
        return false;
      }
      continue;
    }
    if (!allowed.has(room.category)) {
      return false;
    }
  }
  return true;
}

/**
 * @param {object} opts
 * @returns {object}
 */
function tryPlaceInEligibleRooms(rooms, guestCount, groupGender, roomPreference, allocOpts, safetyOpts = {}) {
  const eligible = rooms
    .filter((r) => roomEligibleForGroup(r.category, groupGender, allocOpts) && countAvailable(r) > 0);

  const totalAvail = eligible.reduce((s, r) => s + countAvailable(r), 0);
  if (totalAvail < guestCount) return null;

  const fitting = eligible.filter((r) => countAvailable(r) >= guestCount);
  if (fitting.length) {
    const winner = sortRoomsByRank(fitting, guestCount)[0];
    const result = {
      selected_bed_codes: pickBeds(winner, guestCount),
      room_code: winner.room_code,
      split: false,
      reason: pickReason(winner, guestCount, false, false),
    };
    if (!assertSelectionGenderSafe(result, eligible, groupGender, roomPreference, safetyOpts)) {
      return { handoff: true, reason: 'gender_eligibility_violation' };
    }
    return result;
  }

  const cramPlan = cramAcrossEligibleRooms(eligible, guestCount);
  if (!cramPlan) return null;

  const result = buildCramSelection(cramPlan, guestCount);
  if (!assertSelectionGenderSafe(result, eligible, groupGender, roomPreference, safetyOpts)) {
    return { handoff: true, reason: 'gender_eligibility_violation' };
  }
  return result;
}

function applyOperatorBlockFlags(rooms, operatorBlockedRoomCodes) {
  const blocked = operatorBlockedRoomCodes instanceof Set
    ? operatorBlockedRoomCodes
    : new Set(operatorBlockedRoomCodes || []);
  if (!blocked.size) return rooms;
  return rooms.map((r) => ({
    ...r,
    operator_blocked: blocked.has(r.room_code),
    beds: (r.beds || []).map((b) => ({
      ...b,
      available: blocked.has(r.room_code) ? false : b.available,
    })),
  }));
}

function dedicatedRoomsForGroup(rooms, groupGender, roomPreference) {
  const allowed = allowedCategoriesForGroup(groupGender, roomPreference);
  return rooms
    .map(enrichRoom)
    .filter((r) => r.category !== 'operator_surfweek' && allowed.has(r.category));
}

function operatorRoomsUnblocked(rooms) {
  return rooms
    .map(enrichRoom)
    .filter((r) => r.category === 'operator_surfweek' && !r.operator_blocked);
}

function flippedMixedRooms(rooms) {
  return expandRoomsWithFlippedMixed(rooms)
    .filter((r) => r.flipped_from && countAvailable(r) > 0);
}

function buildTieredPoolsForGroup(rooms, groupGender, roomPreference, allocOpts, operatorTierOpts, useFlipFallback) {
  const dedicated = dedicatedRoomsForGroup(rooms, groupGender, roomPreference);
  const operator = operatorRoomsUnblocked(rooms);
  const flipped = useFlipFallback ? flippedMixedRooms(rooms) : [];

  const pools = [
    {
      tier: 1,
      rooms: dedicated,
      allocOpts,
      safetyOpts: {},
    },
  ];

  if (operator.length) {
    pools.push({
      tier: 2,
      rooms: operator,
      allocOpts: operatorTierOpts,
      safetyOpts: { allowOperator: true },
    });
  }

  if (flipped.length) {
    pools.push({
      tier: 3,
      rooms: flipped,
      allocOpts,
      safetyOpts: { allowFlip: true },
    });
  }

  return pools;
}

function operatorBlockedRoomsFromBlocks(blockRows) {
  const rooms = new Set();
  for (const row of blockRows || []) {
    if (String(row.assignment_type || '').toLowerCase() === 'operator_block' && row.room_code) {
      rooms.add(row.room_code);
    }
  }
  return rooms;
}

function chooseBeds(opts) {
  const guestCount = Math.max(1, Number(opts.guestCount) || 1);
  let groupGender = opts.groupGender || 'unknown';
  const roomPreference = normalizePref(opts.roomPreference);
  const allowProtected = opts.allowProtected !== false;
  const allowOperator = opts.allowOperator === true;
  const allocOpts = { guestCount, roomPreference, allowProtected, allowOperator, groupGender };

  let rooms = (opts.rooms || []).map((r) => ({
    room_code: r.room_code,
    room_type: r.room_type,
    selling_mode: r.selling_mode,
    gender_strategy: r.gender_strategy,
    capacity: r.capacity,
    fill_priority: r.fill_priority,
    can_be_matrimonial: r.can_be_matrimonial,
    often_used_by_operator: r.often_used_by_operator,
    operator_blocked: !!r.operator_blocked,
    beds: (r.beds || []).map((b) => ({
      bed_code: b.bed_code,
      available: b.available === true,
    })),
  }));
  rooms = applyOperatorBlockFlags(rooms, opts.operatorBlockedRoomCodes);
  const privatePick = privateSellingSelection(rooms, guestCount, roomPreference);
  if (privatePick) return privatePick;
  rooms = rooms.filter(room => ordinarySellingMode(room) !== 'private');

  if (rooms.some((r) => (r.beds || []).some((b) => b.available !== true && b.available !== false))) {
    return { handoff: true, reason: 'invalid_bed_availability_state' };
  }

  if (isCoupleRequest(guestCount, roomPreference)) {
    const coupleResult = tryCouplePlacement(rooms, allocOpts);
    if (coupleResult) return coupleResult;
  }
  if (roomPreference === 'private') return { handoff: true, reason: 'no_empty_private_room' };

  if (roomPreference === 'female_only') {
    groupGender = 'female';
    allocOpts.groupGender = 'female';
  }
  if (roomPreference === 'male_only') {
    groupGender = 'male';
    allocOpts.groupGender = 'male';
  }

  // Unknown composition cannot make a gendered room safe by relabelling it.
  // Keep the existing overflow policy only for explicitly mixed composition.
  const useFlipFallback = groupGender === 'mixed';
  const operatorTierOpts = { ...allocOpts, allowOperator: true };

  const tierPools = buildTieredPoolsForGroup(
    rooms,
    groupGender,
    roomPreference,
    allocOpts,
    operatorTierOpts,
    useFlipFallback,
  );

  const result = tryPlaceWithTieredPools({
    pools: tierPools,
    guestCount,
    groupGender,
    roomPreference,
  });
  if (result && !result.handoff) return result;
  if (result && result.handoff) return result;

  if (groupGender === 'unknown') {
    return { handoff: false, needs_clarification: true, reason: 'no_eligible_mixed_room' };
  }
  if (groupGender === 'mixed') {
    return { handoff: true, reason: 'no_eligible_mixed_room' };
  }
  return { handoff: true, reason: 'no_eligible_room' };
}

/** Legacy capacity-only picker (feature-flag rollback). */
function chooseBedsCapacityOnly({ rooms, guestCount, roomPreference }) {
  const n = Math.max(1, Number(guestCount) || 1);
  const privatePick = privateSellingSelection(rooms, n, roomPreference);
  if (privatePick) return privatePick;
  if (normalizePref(roomPreference) === 'private') return chooseBeds({ rooms, guestCount: n, roomPreference });
  rooms = (rooms || []).filter(room => ordinarySellingMode(room) !== 'private');
  const byRoom = new Map();
  for (const room of rooms || []) {
    const avail = (room.beds || []).filter((b) => b.available);
    if (!avail.length) continue;
    byRoom.set(room.room_code, { room, beds: avail });
  }
  const roomFit = [...byRoom.entries()]
    .filter(([, v]) => v.beds.length >= n)
    .sort((a, b) => a[1].beds.length - b[1].beds.length || String(a[0]).localeCompare(String(b[0])))[0];
  if (roomFit) {
    const picked = roomFit[1].beds
      .sort((a, b) => String(a.bed_code).localeCompare(String(b.bed_code)))
      .slice(0, n)
      .map((b) => b.bed_code);
    return {
      selected_bed_codes: picked,
      room_code: roomFit[0],
      split: false,
      reason: 'legacy_capacity_smallest_room',
    };
  }
  const flat = (rooms || [])
    .flatMap((r) => (r.beds || []).filter((b) => b.available))
    .sort((a, b) => String(a.bed_code).localeCompare(String(b.bed_code)))
    .slice(0, n)
    .map((b) => b.bed_code);
  if (flat.length < n) {
    return { handoff: true, reason: 'not_enough_available_beds' };
  }
  return {
    selected_bed_codes: flat,
    room_code: null,
    split: true,
    reason: 'legacy_capacity_scatter',
  };
}

function deriveAllocatorContext({
  guestCount,
  guestName,
  guestNames,
  genderPreference,
  roomPreference,
  groupGender: explicitGroupGender,
}) {
  const rp = normalizePref(roomPreference || genderPreference);
  const explicit = normalizeGroupGender(explicitGroupGender)
    || normalizeGroupGender(genderPreference);
  const count = Math.max(1, Number(guestCount) || 1);

  if (rp === 'female_only') {
    if (explicit === 'male') {
      return {
        groupGender: 'male',
        roomPreference: null,
        conflict: 'female_only_overrides_explicit_male',
        needsClarification: true,
      };
    }
    return { groupGender: 'female', roomPreference: 'female_only' };
  }
  if (rp === 'male_only') {
    if (explicit === 'female') {
      return {
        groupGender: 'female',
        roomPreference: null,
        conflict: 'male_only_overrides_explicit_female',
        needsClarification: true,
      };
    }
    return { groupGender: 'male', roomPreference: 'male_only' };
  }
  if (rp === 'private') {
    return { groupGender: explicit || 'unknown', roomPreference: 'private' };
  }
  if (explicit) {
    return { groupGender: explicit, roomPreference: rp || (explicit === 'mixed' ? 'mixed' : null) };
  }
  if (rp === 'mixed') {
    if (count >= 2) {
      return { groupGender: 'unknown', roomPreference: 'mixed' };
    }
    return { groupGender: explicit || 'unknown', roomPreference: 'mixed' };
  }

  if (count >= 2) {
    return { groupGender: explicit || 'unknown', roomPreference: rp };
  }

  // Solo — honor Luna's room_preference / gender_preference only; never guess from guest name
  if (explicit) {
    return { groupGender: explicit, roomPreference: rp };
  }
  return { groupGender: 'unknown', roomPreference: rp };
}

function buildAllocatorRoomsFromBedRows(bedRows, occupiedBedCodes, allowedBedCodes) {
  const occupied = occupiedBedCodes instanceof Set ? occupiedBedCodes : new Set(occupiedBedCodes || []);
  const allowed = allowedBedCodes instanceof Set ? allowedBedCodes : null;
  const roomMap = new Map();

  for (const row of bedRows || []) {
    if (!row.bed_code || row.bed_active === false || row.bed_sellable === false) continue;
    // Keep filtered siblings as unavailable: a subset is not proof of an empty room.
    const code = row.room_code || '__unknown__';
    if (!roomMap.has(code)) {
      roomMap.set(code, {
        room_code: code,
        room_type: row.room_type,
        selling_mode: row.selling_mode,
        gender_strategy: row.gender_strategy,
        capacity: row.capacity,
        fill_priority: row.fill_priority,
        can_be_matrimonial: row.can_be_matrimonial,
        often_used_by_operator: row.often_used_by_operator,
        beds: [],
      });
    }
    roomMap.get(code).beds.push({
      bed_code: row.bed_code,
      available: !occupied.has(row.bed_code) && (!allowed || allowed.has(row.bed_code)),
    });
  }

  return [...roomMap.values()].filter((r) => r.beds.length > 0);
}

function runAvailabilityBedSelection(params) {
  const {
    bedRows,
    occupiedBedCodes,
    allowedBedCodes,
    blockRows,
    operatorBlockedRoomCodes,
    guestCount,
    guestName,
    guestNames,
    genderPreference,
    roomPreference,
    groupGender,
    capacityOnly = false,
    useRules = isRulesBasedRoomingEnabled(),
  } = params;

  const blockedRooms = operatorBlockedRoomCodes
    || operatorBlockedRoomsFromBlocks(blockRows);
  const rooms = buildAllocatorRoomsFromBedRows(bedRows, occupiedBedCodes, allowedBedCodes);
  const ctx = deriveAllocatorContext({
    guestCount,
    guestName,
    guestNames,
    genderPreference,
    roomPreference,
    groupGender,
  });
  if (ctx.needsClarification) {
    return {
      handoff: false,
      needs_clarification: true,
      reason: ctx.conflict || 'room_preference_conflicts_with_explicit_gender',
      selected_bed_codes: [],
      selected_room_code: null,
      group_gender: ctx.groupGender,
      room_preference: ctx.roomPreference,
      conflict: ctx.conflict,
    };
  }

  // Rollback may change ranking, not the safety of unknown mixed/shared placement.
  const requireMixedSafety = ctx.groupGender === 'unknown' && ctx.roomPreference === 'mixed';
  const pick = (!capacityOnly && (useRules || requireMixedSafety))
    ? chooseBeds({
      rooms,
      guestCount,
      groupGender: ctx.groupGender,
      roomPreference: ctx.roomPreference,
      allowProtected: true,
      operatorBlockedRoomCodes: blockedRooms,
    })
    : chooseBedsCapacityOnly({ rooms, guestCount, roomPreference: ctx.roomPreference });

  if (pick.handoff || pick.needs_clarification) {
    return {
      ...pick,
      selected_bed_codes: [],
      selected_room_code: null,
      group_gender: ctx.groupGender,
      room_preference: ctx.roomPreference,
    };
  }

  return {
    ...pick,
    selected_room_code: pick.room_code || null,
    group_gender: ctx.groupGender,
    room_preference: ctx.roomPreference,
  };
}

function rejectIncompatiblePreselectedBeds({ selectedBedCodes, bedRows, groupGender }) {
  const gender = normalizeGroupGender(groupGender);
  if (gender !== 'male' && gender !== 'female') return { ok: true, bed_codes: [] };
  const banned = gender === 'male' ? 'female_only' : 'male_only';
  const rooms = buildAllocatorRoomsFromBedRows(bedRows, new Set(), null);
  const bedToCategory = new Map();
  for (const room of rooms) {
    const category = resolveRoomCategory(room);
    for (const bed of room.beds || []) {
      if (bed && bed.bed_code) bedToCategory.set(bed.bed_code, category);
    }
  }
  const bad = (selectedBedCodes || []).filter((code) => bedToCategory.get(code) === banned);
  if (bad.length) {
    return { ok: false, reason: 'incompatible_preselected_beds', bed_codes: bad };
  }
  return { ok: true, bed_codes: [] };
}

/** Validate an accepted ordered selection, never search for replacement beds.
 * Name hints are provisional room eligibility (same >=0.70 contract as Hermes),
 * not stored demographic facts. Bind hints by unique roster name, not position.
 */
function validateExplicitBedSelection({ selectedBedCodes, bedRows, blockRows, guestCount, body = {} }) {
  const bad = (reason, codes = selectedBedCodes) => ({ ok: false, reason, bed_codes: codes });
  if (!Array.isArray(selectedBedCodes) || selectedBedCodes.length !== guestCount
    || selectedBedCodes.length > 20 || new Set(selectedBedCodes).size !== selectedBedCodes.length
    || selectedBedCodes.some(code => typeof code !== 'string' || !/^[A-Za-z0-9_-]+$/.test(code))) {
    return bad('invalid_bed_codes');
  }
  const byCode = new Map((bedRows || []).map(row => [row.bed_code, row]));
  const selected = selectedBedCodes.map(code => byCode.get(code));
  const unavailable = selectedBedCodes.filter((code, i) => !selected[i]
    || selected[i].bed_active !== true || selected[i].bed_sellable !== true);
  if (unavailable.length) return bad('availability_changed', unavailable);
  // Exact selections need an authoritative category, not the legacy
  // auto-allocator's unknown-metadata-to-mixed fallback.
  if (selected.some(row => !CANONICAL_ROOM_TYPES.has(normalizeToken(row.room_type))
    && !['shared', 'private_only'].includes(normalizeToken(row.room_type)))) return bad('invalid_room_metadata');
  const occupied = new Set((blockRows || []).map(row => row.bed_code));
  const blockedRooms = operatorBlockedRoomsFromBlocks(blockRows || []);
  const conflicts = selectedBedCodes.filter((code, i) => occupied.has(code) || blockedRooms.has(selected[i].room_code));
  if (conflicts.length) return bad('availability_changed', conflicts);

  const roster = Array.isArray(body.guests) && body.guests.length === guestCount
    ? body.guests : (guestCount === 1 ? [{ name: body.guest_name }] : []);
  const nameOf = row => trimStr(row && (row.name || row.guest_name)).toLowerCase();
  const hints = Array.isArray(body.room_name_hints) ? body.room_name_hints : [];
  const knownGender = value => {
    const gender = normalizeGroupGender(value);
    return gender === 'male' || gender === 'female' ? gender : null;
  };
  const pref = normalizePref(body.room_preference || body.gender_preference || body.room_type);
  const group = knownGender(body.explicit_gender || body.group_gender || body.gender_preference);
  let conflictingStatements = false;
  const guestGender = index => {
    const guest = roster[index] || {};
    const name = nameOf(guest);
    const matched = name && roster.filter(row => nameOf(row) === name).length === 1
      ? hints.filter(row => row && nameOf(row) === name) : [];
    const hint = matched.length === 1 ? matched[0] : null;
    const explicit = guest.explicit_gender || guest.explicit_statement;
    const hintExplicit = hint && (hint.explicit_gender || hint.explicit_statement);
    if (explicit && hintExplicit && knownGender(explicit) !== knownGender(hintExplicit)) {
      conflictingStatements = true;
      return null;
    }
    // A person's correction outranks a stale group summary. Unknown explicit
    // statements do not fall back to guesses; contradictory explicit sources fail.
    if (explicit || hintExplicit) return knownGender(explicit || hintExplicit);
    if (group) return group;
    if (!hint || hint.ambiguous === true) return null;
    const confidence = hint.confidence;
    if ((typeof confidence !== 'number' && typeof confidence !== 'string') || trimStr(confidence) === ''
      || !Number.isFinite(Number(confidence)) || Number(confidence) < 0.70 || Number(confidence) > 1) return null;
    return knownGender(hint.hint || hint.name_hint);
  };
  const categories = selected.map(resolveRoomCategory);
  const privateRequest = pref === 'private';
  const ordinaryPrivate = privateRequest && selected.every(row => ['private', 'private_optional'].includes(ordinarySellingMode(row)));
  if (ordinaryPrivate) {
    const room = selected[0].room_code;
    if (!privateRequest || selected.some(row => row.room_code !== room)
      || (blockRows || []).some(row => row.room_code === room)) return bad('incompatible_preselected_beds');
    return { ok: true, private_room: true };
  }
  if (selected.some(row => ordinarySellingMode(row) === 'private')) return bad('incompatible_preselected_beds');
  if (privateRequest) {
    const room = selected[0].room_code;
    if (guestCount !== 2 || selected.some(row => row.room_code !== room)
      || categories.some(category => !['matrimonial_private_couple', 'matrimonial_or_mixed'].includes(category))
      || (blockRows || []).some(row => row.room_code === room)) return bad('incompatible_preselected_beds');
  }
  const incompatible = selectedBedCodes.filter((code, i) => {
    const category = categories[i];
    const gender = guestGender(i);
    if (pref === 'female_only' && (gender !== 'female' || category !== 'female_only')) return true;
    if (pref === 'male_only' && (gender !== 'male' || category !== 'male_only')) return true;
    if (category === 'female_only') return gender !== 'female';
    if (category === 'male_only') return gender !== 'male';
    if (category === 'matrimonial_private_couple') return !privateRequest;
    return false;
  });
  if (conflictingStatements) return bad('conflicting_guest_eligibility');
  if (incompatible.length) return bad('incompatible_preselected_beds', incompatible);
  return { ok: true };
}

module.exports = {
  ordinarySellingMode,
  validateExplicitBedSelection,
  chooseBeds,
  chooseBedsCapacityOnly,
  resolveRoomCategory,
  allowedCategoriesForGroup,
  roomEligibleForGroup,
  deriveAllocatorContext,
  buildAllocatorRoomsFromBedRows,
  findFlippableGenderedRooms,
  expandRoomsWithFlippedMixed,
  operatorBlockedRoomsFromBlocks,
  applyOperatorBlockFlags,
  isRulesBasedRoomingEnabled,
  needsGenderAwareBedAssignment,
  runAvailabilityBedSelection,
  rejectIncompatiblePreselectedBeds,
};
