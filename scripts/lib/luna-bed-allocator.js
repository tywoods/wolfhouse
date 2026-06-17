/**
 * Rules-based bed/room allocator for Luna availability checks.
 * Data-driven from room_type, gender_strategy, fill_priority — not hardcoded room IDs.
 *
 * @module luna-bed-allocator
 */

'use strict';

const { inferLikelyGuestGender } = require('./luna-booking-intake-policy');

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
  if (p === 'private' || p === 'couple' || p === 'matrimonial' || p === 'double') return 'private';
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

function countAvailable(room) {
  return (room.beds || []).filter((b) => b.available).length;
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

function rankRoom(room, guestCount) {
  const available = countAvailable(room);
  const occupied = totalBeds(room) - available;
  return {
    consolidation: occupied > 0 ? 0 : 1,
    leftover: available - guestCount,
    fill_priority: room.fill_priority != null ? Number(room.fill_priority) : 999,
    room_code: room.room_code,
  };
}

function compareRank(a, b) {
  if (a.consolidation !== b.consolidation) return a.consolidation - b.consolidation;
  if (a.leftover !== b.leftover) return a.leftover - b.leftover;
  if (a.fill_priority !== b.fill_priority) return a.fill_priority - b.fill_priority;
  return String(a.room_code).localeCompare(String(b.room_code));
}

function roomEligibleForGroup(category, groupGender, opts) {
  const { guestCount, roomPreference, allowProtected, allowOperator } = opts;

  if (category === 'operator_surfweek') return !!allowOperator;

  if (category === 'matrimonial_private_couple') {
    return isCoupleRequest(guestCount, roomPreference) && allowProtected !== false;
  }

  const gender = groupGender || 'unknown';
  if (gender === 'female') {
    return category === 'female_only' || category === 'mixed' || category === 'matrimonial_or_mixed';
  }
  if (gender === 'male') {
    return category === 'male_only' || category === 'mixed' || category === 'matrimonial_or_mixed';
  }
  return category === 'mixed' || category === 'matrimonial_or_mixed';
}

function enrichRoom(room) {
  return {
    ...room,
    category: resolveRoomCategory(room),
  };
}

function tryCouplePlacement(rooms, opts) {
  const eligibleProtected = rooms
    .map(enrichRoom)
    .filter((r) => r.category === 'matrimonial_private_couple'
      && roomEligibleForGroup(r.category, opts.groupGender, opts)
      && countAvailable(r) >= 2);

  if (eligibleProtected.length) {
    const winner = eligibleProtected
      .map((r) => ({ room: r, rank: rankRoom(r, 2) }))
      .sort((a, b) => compareRank(a.rank, b.rank))[0].room;
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
    const winner = eligibleJoined
      .map((r) => ({ room: r, rank: rankRoom(r, 2) }))
      .sort((a, b) => compareRank(a.rank, b.rank))[0].room;
    return {
      selected_bed_codes: pickBeds(winner, 2),
      room_code: winner.room_code,
      split: false,
      reason: 'couple_matrimonial_or_mixed_empty_room',
    };
  }

  return null;
}

function greedyRoomCount(eligible, guestCount) {
  const sorted = [...eligible].sort((a, b) => countAvailable(b) - countAvailable(a)
    || compareRank(rankRoom(a, guestCount), rankRoom(b, guestCount)));
  let rem = guestCount;
  let count = 0;
  for (const room of sorted) {
    if (rem <= 0) break;
    rem -= countAvailable(room);
    count += 1;
  }
  return rem <= 0 ? count : Infinity;
}

function tryTwoRoomSplit(eligible, guestCount) {
  const rooms = eligible
    .map((r) => ({ room: r, n: countAvailable(r) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || compareRank(rankRoom(a.room, guestCount), rankRoom(b.room, guestCount)));

  for (let i = 0; i < rooms.length; i++) {
    const firstTake = Math.min(guestCount, rooms[i].n);
    const rem = guestCount - firstTake;
    if (rem <= 0) {
      return [{ room: rooms[i].room, take: firstTake }];
    }
    for (let j = i + 1; j < rooms.length; j++) {
      if (rooms[j].n >= rem) {
        return [
          { room: rooms[i].room, take: firstTake },
          { room: rooms[j].room, take: rem },
        ];
      }
    }
  }
  return null;
}

function buildSplitSelection(plan) {
  const selected = [];
  let primaryRoom = null;
  for (const part of plan) {
    if (!primaryRoom) primaryRoom = part.room.room_code;
    selected.push(...pickBeds(part.room, part.take));
  }
  return {
    selected_bed_codes: selected,
    room_code: primaryRoom,
    split: true,
    reason: 'group_split_minimal_two_rooms',
  };
}

/**
 * @param {object} opts
 * @returns {object}
 */
function chooseBeds(opts) {
  const guestCount = Math.max(1, Number(opts.guestCount) || 1);
  let groupGender = opts.groupGender || 'unknown';
  const roomPreference = normalizePref(opts.roomPreference);
  const allowProtected = opts.allowProtected !== false;
  const allowOperator = opts.allowOperator === true;
  const allocOpts = { guestCount, roomPreference, allowProtected, allowOperator, groupGender };

  const rooms = (opts.rooms || []).map((r) => ({
    room_code: r.room_code,
    room_type: r.room_type,
    gender_strategy: r.gender_strategy,
    capacity: r.capacity,
    fill_priority: r.fill_priority,
    can_be_matrimonial: r.can_be_matrimonial,
    often_used_by_operator: r.often_used_by_operator,
    beds: (r.beds || []).map((b) => ({
      bed_code: b.bed_code,
      available: b.available === true,
    })),
  }));

  if (rooms.some((r) => (r.beds || []).some((b) => b.available !== true && b.available !== false))) {
    return { handoff: true, reason: 'invalid_bed_availability_state' };
  }

  if (isCoupleRequest(guestCount, roomPreference)) {
    const coupleResult = tryCouplePlacement(rooms, allocOpts);
    if (coupleResult) return coupleResult;
    return { handoff: true, reason: 'couple_room_unavailable' };
  }

  if (normalizePref(roomPreference) === 'female_only') {
    groupGender = 'female';
    allocOpts.groupGender = 'female';
  }

  const eligible = rooms
    .map(enrichRoom)
    .filter((r) => roomEligibleForGroup(r.category, groupGender, allocOpts) && countAvailable(r) > 0);

  const totalAvail = eligible.reduce((s, r) => s + countAvailable(r), 0);
  if (totalAvail < guestCount) {
    if (groupGender === 'unknown' || groupGender === 'mixed') {
      return { handoff: true, reason: 'no_eligible_mixed_room' };
    }
    return { handoff: true, reason: 'no_eligible_room' };
  }

  const fitting = eligible.filter((r) => countAvailable(r) >= guestCount);
  if (fitting.length) {
    const winner = fitting
      .map((r) => ({ room: r, rank: rankRoom(r, guestCount) }))
      .sort((a, b) => compareRank(a.rank, b.rank))[0].room;
    const reason = winner.category === 'female_only'
      ? 'solo_or_group_female_room'
      : winner.category === 'male_only'
        ? 'solo_or_group_male_room'
        : countAvailable(winner) > guestCount && rankRoom(winner, guestCount).consolidation === 0
          ? 'consolidate_partial_dorm'
          : 'single_mixed_or_best_fit_room';
    return {
      selected_bed_codes: pickBeds(winner, guestCount),
      room_code: winner.room_code,
      split: false,
      reason,
    };
  }

  const roomsNeeded = greedyRoomCount(eligible, guestCount);
  if (roomsNeeded >= 3) {
    return { handoff: true, reason: 'group_split_needs_staff' };
  }

  const splitPlan = tryTwoRoomSplit(eligible, guestCount);
  if (!splitPlan) {
    return { handoff: true, reason: 'group_split_needs_staff' };
  }

  return buildSplitSelection(splitPlan);
}

/** Legacy capacity-only picker (feature-flag rollback). */
function chooseBedsCapacityOnly({ rooms, guestCount }) {
  const n = Math.max(1, Number(guestCount) || 1);
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
    const beds = roomFit[1].beds
      .sort((a, b) => String(a.bed_code).localeCompare(String(b.bed_code)))
      .slice(0, n)
      .map((b) => b.bed_code);
    return {
      selected_bed_codes: beds,
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
}) {
  const rp = normalizePref(roomPreference || genderPreference);
  if (rp === 'female_only') {
    return { groupGender: 'female', roomPreference: 'female_only' };
  }
  if (rp === 'private') {
    return { groupGender: 'unknown', roomPreference: 'private' };
  }

  const names = Array.isArray(guestNames) && guestNames.length
    ? guestNames.map(trimStr).filter(Boolean)
    : (trimStr(guestName) ? [trimStr(guestName)] : []);
  const count = Math.max(1, Number(guestCount) || 1);

  if (count >= 2 && names.length <= 1) {
    return { groupGender: 'unknown', roomPreference: rp };
  }

  const genders = names.map(inferLikelyGuestGender);
  const known = genders.filter((g) => g !== 'unknown');
  if (!known.length) {
    return { groupGender: 'unknown', roomPreference: rp };
  }
  const unique = [...new Set(known)];
  if (unique.length > 1) {
    return { groupGender: 'mixed', roomPreference: rp };
  }
  return { groupGender: unique[0], roomPreference: rp };
}

function buildAllocatorRoomsFromBedRows(bedRows, occupiedBedCodes, allowedBedCodes) {
  const occupied = occupiedBedCodes instanceof Set ? occupiedBedCodes : new Set(occupiedBedCodes || []);
  const allowed = allowedBedCodes instanceof Set ? allowedBedCodes : null;
  const roomMap = new Map();

  for (const row of bedRows || []) {
    if (!row.bed_code || row.bed_active === false || row.bed_sellable === false) continue;
    if (allowed && !allowed.has(row.bed_code)) continue;
    const code = row.room_code || '__unknown__';
    if (!roomMap.has(code)) {
      roomMap.set(code, {
        room_code: code,
        room_type: row.room_type,
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
      available: !occupied.has(row.bed_code),
    });
  }

  return [...roomMap.values()].filter((r) => r.beds.length > 0);
}

function runAvailabilityBedSelection(params) {
  const {
    bedRows,
    occupiedBedCodes,
    allowedBedCodes,
    guestCount,
    guestName,
    guestNames,
    genderPreference,
    roomPreference,
    useRules = isRulesBasedRoomingEnabled(),
  } = params;

  const rooms = buildAllocatorRoomsFromBedRows(bedRows, occupiedBedCodes, allowedBedCodes);
  const ctx = deriveAllocatorContext({
    guestCount,
    guestName,
    guestNames,
    genderPreference,
    roomPreference,
  });

  const pick = useRules
    ? chooseBeds({
      rooms,
      guestCount,
      groupGender: ctx.groupGender,
      roomPreference: ctx.roomPreference,
      allowProtected: true,
      allowOperator: false,
    })
    : chooseBedsCapacityOnly({ rooms, guestCount });

  if (pick.handoff) {
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

module.exports = {
  chooseBeds,
  chooseBedsCapacityOnly,
  resolveRoomCategory,
  deriveAllocatorContext,
  buildAllocatorRoomsFromBedRows,
  isRulesBasedRoomingEnabled,
  runAvailabilityBedSelection,
};
