'use strict';

/**
 * Read-only Fill House / Fill Room preview.
 * Uses the existing allocator's eligibility function. Does not call chooseBeds
 * and does not write bookings, holds, or blocks.
 */

const crypto = require('crypto');
const {
  deriveAllocatorContext,
  expandRoomsWithFlippedMixed,
  operatorBlockedRoomsFromBlocks,
  resolveRoomCategory,
  roomEligibleForGroup,
} = require('./luna-bed-allocator');
const {
  reason,
  roomNumberFromCode,
} = require('./staff-room-fill-policy');

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_NIGHTS = 366;

function addDay(iso) {
  const match = ISO_DATE.exec(iso);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return null;
  if (date.toISOString().slice(0, 10) !== iso) return null;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function nightsBetween(checkIn, checkOut) {
  if (!ISO_DATE.test(checkIn) || !ISO_DATE.test(checkOut) || !(checkIn < checkOut)) return null;
  const nights = [];
  let cursor = checkIn;
  while (cursor < checkOut) {
    nights.push(cursor);
    cursor = addDay(cursor);
    if (!cursor || nights.length > MAX_NIGHTS) return null;
  }
  return nights.length ? nights : null;
}

function ratioCmp(an, ad, bn, bd) {
  const left = BigInt(an) * BigInt(bd);
  const right = BigInt(bn) * BigInt(ad);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sellableBeds(room) {
  return (room.beds || [])
    .filter((bed) => bed.active === true && bed.sellable === true && bed.bedId)
    .slice()
    .sort((a, b) => {
      const an = a.bedNumber == null ? Number.MAX_SAFE_INTEGER : a.bedNumber;
      const bn = b.bedNumber == null ? Number.MAX_SAFE_INTEGER : b.bedNumber;
      if (an !== bn) return an - bn;
      if (a.bedId < b.bedId) return -1;
      if (a.bedId > b.bedId) return 1;
      return 0;
    });
}

function blockCovers(block, night) {
  return String(block.start) <= night && night < String(block.end);
}

function isBlockType(assignmentType) {
  const value = String(assignmentType || '').toLowerCase();
  return value.includes('block') || value.includes('private') || value.includes('staff') || value.includes('owner') || value.includes('external');
}

function buildOccupancy(rooms, occupancy, nights) {
  const byRoom = new Map(rooms.map((room) => [room.roomId, room]));
  const byCode = new Map(rooms.map((room) => [room.roomCode, room]));
  const blockedRooms = operatorBlockedRoomsFromBlocks((occupancy || []).map((row) => ({
    assignment_type: row.assignmentType || row.assignment_type,
    room_code: row.roomCode || row.room_code || (byRoom.get(row.roomId) || {}).roomCode,
  })));
  const busy = new Map();
  for (const room of rooms) {
    for (const bed of sellableBeds(room)) busy.set(bed.bedId, new Set());
  }
  for (const row of occupancy || []) {
    const room = byRoom.get(row.roomId) || byCode.get(row.roomCode || row.room_code);
    if (!room) continue;
    const roomBlocked = blockedRooms.has(room.roomCode);
    const targets = roomBlocked ? sellableBeds(room) : sellableBeds(room).filter((bed) => bed.bedId === row.bedId);
    for (const night of nights) {
      if (!blockCovers(row, night) && !roomBlocked) continue;
      if (roomBlocked && !blockCovers(row, night)) continue;
      for (const bed of targets) {
        if (busy.has(bed.bedId)) busy.get(bed.bedId).add(night);
      }
    }
  }
  return { busy, blockedRooms };
}

function continuousBeds(room, busy, nights) {
  return sellableBeds(room).filter((bed) => nights.every((night) => !busy.get(bed.bedId).has(night)));
}

function unavailableCount(room, busy, night) {
  return sellableBeds(room).filter((bed) => busy.get(bed.bedId).has(night)).length;
}

function safetyFor(room, ctx, partySize) {
  const category = resolveRoomCategory({
    room_type: room.roomType,
    gender_strategy: room.genderStrategy,
    capacity: room.capacity,
    can_be_matrimonial: room.canBeMatrimonial,
    often_used_by_operator: room.oftenUsedByOperator,
  });
  if (category === 'operator_surfweek') {
    return { ok: false, special: 'operator', reasons: ['operator_restricted'] };
  }
  const eligible = roomEligibleForGroup(category, ctx.groupGender, {
    guestCount: partySize,
    roomPreference: ctx.roomPreference,
    allowProtected: true,
    allowOperator: false,
    groupGender: ctx.groupGender,
  });
  if (!eligible) {
    if (category === 'matrimonial_private_couple') return { ok: false, reasons: ['protected_private_room'] };
    return { ok: false, reasons: ['incompatible_room_type'] };
  }
  return { ok: true, reasons: [], category };
}

function availabilityReasons(room, busy, nights, occupancy) {
  const beds = sellableBeds(room);
  if (!room.active) return ['room_inactive'];
  if (!beds.length) return ['no_sellable_beds'];
  const free = continuousBeds(room, busy, nights);
  if (free.length) return [];
  const someNightHasFree = nights.some((night) => unavailableCount(room, busy, night) < beds.length);
  if (someNightHasFree) return ['no_continuous_beds'];
  const roomBlocks = (occupancy || []).filter((row) => row.roomId === room.roomId || row.roomCode === room.roomCode);
  if (roomBlocks.length && roomBlocks.every((row) => isBlockType(row.assignmentType || row.assignment_type))) {
    return ['blocked_for_stay'];
  }
  return ['full_for_stay'];
}

function scoreRoom(room, busy, nights, unitSize, rank) {
  const capacity = sellableBeds(room).length;
  let peakNum = 0;
  let peakDen = 1;
  let sum = 0;
  for (const night of nights) {
    const projected = unavailableCount(room, busy, night) + unitSize;
    sum += projected;
    if (ratioCmp(projected, capacity, peakNum, peakDen) > 0) {
      peakNum = projected;
      peakDen = capacity;
    }
  }
  return {
    room,
    rank,
    peakNum,
    peakDen,
    meanNum: sum,
    meanDen: capacity * nights.length,
  };
}

function compareScore(a, b) {
  const peak = ratioCmp(a.peakNum, a.peakDen, b.peakNum, b.peakDen);
  if (peak) return peak;
  const mean = ratioCmp(a.meanNum, a.meanDen, b.meanNum, b.meanDen);
  if (mean) return mean;
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.room.roomId < b.room.roomId) return -1;
  if (a.room.roomId > b.room.roomId) return 1;
  return 0;
}

function markBusy(busy, bedIds, nights) {
  for (const bedId of bedIds) {
    if (!busy.has(bedId)) busy.set(bedId, new Set());
    for (const night of nights) busy.get(bedId).add(night);
  }
}

function specialTierCouldPlace(rooms, ctx, busy, nights) {
  const operatorFree = rooms.some((room) => {
    const category = resolveRoomCategory({
      room_type: room.roomType,
      gender_strategy: room.genderStrategy,
      capacity: room.capacity,
      can_be_matrimonial: room.canBeMatrimonial,
      often_used_by_operator: room.oftenUsedByOperator,
    });
    return category === 'operator_surfweek' && continuousBeds(room, busy, nights).length > 0;
  });
  if (operatorFree) return true;
  if (ctx.groupGender !== 'mixed') return false;
  const flipped = expandRoomsWithFlippedMixed(rooms.map((room) => ({
    room_code: room.roomCode,
    room_type: room.roomType,
    gender_strategy: room.genderStrategy,
    capacity: room.capacity,
    fill_priority: 999,
    can_be_matrimonial: room.canBeMatrimonial,
    often_used_by_operator: room.oftenUsedByOperator,
    beds: sellableBeds(room).map((bed) => ({
      bed_code: bed.bedCode || bed.bedId,
      available: continuousBeds(room, busy, nights).some((free) => free.bedId === bed.bedId),
    })),
  })));
  return flipped.some((room) => room.flipped_from && (room.beds || []).some((bed) => bed.available));
}

function explainRoom(room, flags, selectedIds) {
  const codes = [];
  if (!room.active) codes.push('room_inactive');
  if (sellableBeds(room).length < 1) codes.push('no_sellable_beds');
  for (const code of flags.safety || []) {
    if (!codes.includes(code)) codes.push(code);
  }
  for (const code of flags.availability || []) {
    if (!codes.includes(code)) codes.push(code);
  }
  if (flags.partyTooSmall) codes.push('insufficient_party_capacity');
  if (flags.safetySkipped && selectedIds.size) codes.push('safety_tier_precedes_priority');
  const selected = selectedIds.has(room.roomId);
  if (!selected && !codes.length) codes.push(flags.evaluated ? 'eligible_not_selected' : 'not_evaluated');
  return {
    roomId: room.roomId,
    roomCode: room.roomCode,
    roomNumber: room.roomNumber == null ? roomNumberFromCode(room.roomCode) : room.roomNumber,
    status: selected ? 'selected' : (codes.some((code) => code !== 'eligible_not_selected' && code !== 'insufficient_party_capacity') ? 'skipped' : 'eligible_not_selected'),
    reasons: codes.map(reason),
  };
}

function previewRoomFill({ catalogue, occupancy, policy, request }) {
  const rooms = (catalogue || []).map((room) => ({
    ...room,
    beds: (room.beds || []).map((bed) => ({ ...bed })),
  }));
  const checkIn = request && request.checkIn;
  const checkOut = request && request.checkOut;
  const partySize = request && request.partySize;
  if (!checkIn || !checkOut || !Number.isInteger(partySize) || partySize < 1) {
    return {
      ok: true,
      decision: {
        status: 'not_evaluated',
        selected: [],
        rationale: [reason('request_details_missing')],
        rooms: rooms.map((room) => ({
          roomId: room.roomId,
          roomCode: room.roomCode,
          roomNumber: room.roomNumber,
          status: 'not_evaluated',
          reasons: [reason('not_evaluated')],
        })),
      },
    };
  }
  const nights = nightsBetween(checkIn, checkOut);
  if (!nights) {
    return { ok: false, status: 422, error: 'invalid_stay' };
  }
  const ctx = deriveAllocatorContext({
    guestCount: partySize,
    groupGender: request.groupGender || 'unknown',
    roomPreference: request.roomPreference || null,
    genderPreference: request.roomPreference || null,
  });
  const rankOf = new Map((policy.roomPriority || []).map((id, index) => [id, index]));
  const ordered = rooms.slice().sort((a, b) => (rankOf.get(a.roomId) ?? 9999) - (rankOf.get(b.roomId) ?? 9999) || (a.roomId < b.roomId ? -1 : 1));
  const { busy } = buildOccupancy(rooms, occupancy, nights);
  const flags = new Map(rooms.map((room) => [room.roomId, {
    safety: [],
    availability: [],
    partyTooSmall: false,
    safetySkipped: false,
    evaluated: false,
  }]));

  if (ctx.needsClarification) {
    return {
      ok: true,
      decision: finish({
        status: 'clarification',
        selected: [],
        rationale: [reason('incompatible_group_constraints')],
        clarification: ctx.conflict || 'needs_clarification',
        rooms,
        flags,
        selectedIds: new Set(),
      }),
    };
  }

  for (const room of ordered) {
    const slot = flags.get(room.roomId);
    slot.evaluated = true;
    if (!room.active) {
      slot.safety.push('room_inactive');
      continue;
    }
    const safety = safetyFor(room, ctx, partySize);
    if (!safety.ok) {
      slot.safety.push(...safety.reasons);
      slot.safetySkipped = true;
      continue;
    }
    slot.availability.push(...availabilityReasons(room, busy, nights, occupancy));
  }

  const eligible = ordered.filter((room) => {
    const slot = flags.get(room.roomId);
    return room.active && !slot.safety.length && !slot.availability.length;
  });
  const whole = eligible.filter((room) => continuousBeds(room, busy, nights).length >= partySize);
  for (const room of eligible) {
    if (continuousBeds(room, busy, nights).length < partySize) flags.get(room.roomId).partyTooSmall = true;
  }

  const splitPermission = request.splitPermission;
  let units;
  let split = false;
  if (whole.length) {
    units = [{ size: partySize, rooms: whole }];
  } else if (splitPermission !== true) {
    return {
      ok: true,
      decision: finish({
        status: 'no_fit',
        selected: [],
        rationale: [reason('split_permission_required')],
        rooms,
        flags,
        selectedIds: new Set(),
      }),
    };
  } else {
    split = true;
    units = Array.from({ length: partySize }, () => ({ size: 1, rooms: null }));
  }

  const selected = [];
  const selectedIds = new Set();
  let tieBreak = false;
  const mode = policy.fillMode === 'room' ? 'room' : 'house';

  for (const unit of units) {
    const pool = (unit.rooms || eligible).filter((room) => continuousBeds(room, busy, nights).length >= unit.size);
    if (!pool.length) {
      if (specialTierCouldPlace(rooms, ctx, busy, nights)) {
        return { ok: false, status: 422, error: 'preview_policy_not_supported' };
      }
      return {
        ok: true,
        decision: finish({
          status: 'no_fit',
          selected: [],
          rationale: [reason('full_for_stay')],
          rooms,
          flags,
          selectedIds: new Set(),
        }),
      };
    }
    let winner;
    if (mode === 'room') {
      winner = pool.slice().sort((a, b) => (rankOf.get(a.roomId) ?? 9999) - (rankOf.get(b.roomId) ?? 9999))[0];
    } else {
      const scored = pool.map((room) => scoreRoom(room, busy, nights, unit.size, rankOf.get(room.roomId) ?? 9999));
      scored.sort(compareScore);
      winner = scored[0].room;
      if (scored.length > 1
        && ratioCmp(scored[0].peakNum, scored[0].peakDen, scored[1].peakNum, scored[1].peakDen) === 0
        && ratioCmp(scored[0].meanNum, scored[0].meanDen, scored[1].meanNum, scored[1].meanDen) === 0
        && scored[0].rank !== scored[1].rank) {
        tieBreak = true;
      }
    }
    const beds = continuousBeds(winner, busy, nights).slice(0, unit.size);
    markBusy(busy, beds.map((bed) => bed.bedId), nights);
    selectedIds.add(winner.roomId);
    const existing = selected.find((row) => row.roomId === winner.roomId);
    const picked = beds.map((bed) => ({ bedId: bed.bedId, bedCode: bed.bedCode || '' }));
    if (existing) existing.beds.push(...picked);
    else {
      selected.push({
        roomId: winner.roomId,
        roomCode: winner.roomCode,
        roomNumber: winner.roomNumber,
        beds: picked,
      });
    }
  }

  if (!selected.length && specialTierCouldPlace(rooms, ctx, busy, nights)) {
    return { ok: false, status: 422, error: 'preview_policy_not_supported' };
  }

  const rationale = [];
  if (mode === 'room') rationale.push(reason('room_priority_first'));
  else {
    rationale.push(reason('house_lowest_projected_occupancy'));
    if (tieBreak) rationale.push(reason('house_priority_tiebreak'));
  }
  if (partySize > 1 && !split) rationale.push(reason('party_kept_together'));
  if (split) rationale.push(reason('split_required'));
  if ([...flags.values()].some((slot) => slot.safetySkipped) && selected.length) {
    rationale.push(reason('safety_tier_precedes_priority'));
  }

  return {
    ok: true,
    decision: finish({
      status: 'placed',
      selected,
      rationale,
      split,
      rooms,
      flags,
      selectedIds,
    }),
  };
}

function finish(input) {
  const decision = {
    status: input.status,
    selected: (input.selected || []).slice().sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0)),
    split: input.split === true,
    rationale: input.rationale || [],
    clarification: input.clarification || null,
    rooms: (input.rooms || []).map((room) => explainRoom(room, input.flags.get(room.roomId), input.selectedIds))
      .sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0)),
    reservationCreated: false,
  };
  decision.digest = crypto.createHash('sha256').update(JSON.stringify(decision), 'utf8').digest('hex');
  return decision;
}

module.exports = {
  nightsBetween,
  previewRoomFill,
  ratioCmp,
};
