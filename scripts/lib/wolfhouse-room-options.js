'use strict';

const GIRLS_ROOM_CODES = Object.freeze(['R5', 'R8']);
const PRIVATE_COUPLE_ROOM_CODES = Object.freeze(['R6']);
const COUPLE_OR_MIXED_ROOM_CODES = Object.freeze(['R3', 'R6']);

function bedsByRoom(availableBeds) {
  const map = new Map();
  for (const bed of availableBeds || []) {
    const room = String(bed.room_code || '').trim();
    if (!room) continue;
    if (!map.has(room)) map.set(room, []);
    map.get(room).push(bed);
  }
  return map;
}

function roomHasCapacity(availableBeds, roomCodes, guestCount) {
  const codes = new Set((roomCodes || []).map(String));
  const needed = Math.max(1, Number(guestCount) || 1);
  const byRoom = bedsByRoom(availableBeds);
  for (const [room, beds] of byRoom.entries()) {
    if (!codes.has(room)) continue;
    if (PRIVATE_COUPLE_ROOM_CODES.includes(room) && needed <= 2 && beds.length >= 1) {
      return true;
    }
    if (beds.length >= needed) return true;
  }
  return false;
}

function computeWolfhouseRoomOptionFlags(availableBeds, guestCount, allBeds, blockRows) {
  const count = Math.max(1, Number(guestCount) || 1);
  const { ordinarySellingMode } = require('./luna-bed-allocator');
  const sharedBeds = (availableBeds || []).filter(b => ordinarySellingMode(b) !== 'private');
  const girlsRoomAvailable = roomHasCapacity(sharedBeds, GIRLS_ROOM_CODES, 1)
    && (count === 1 || roomHasCapacity(sharedBeds, GIRLS_ROOM_CODES, count));
  // Preserve the legacy couple offer alongside explicit ordinary private modes.
  const freeCodes = new Set((availableBeds || []).map(b => b.bed_code));
  const newPrivateAvailable = [...bedsByRoom(allBeds).values()].some(beds =>
    beds.length >= count && beds.every(b => ['private', 'private_optional'].includes(ordinarySellingMode(b))
      && freeCodes.has(b.bed_code))
    && !(blockRows || []).some(block => block.room_code === beds[0].room_code));
  const privateRoomAvailable = newPrivateAvailable || (count === 2
    && roomHasCapacity(availableBeds, PRIVATE_COUPLE_ROOM_CODES, 2));
  return {
    girls_room_available: girlsRoomAvailable,
    private_room_available: privateRoomAvailable,
  };
}

const PRIVATE_ROOM_PREFERENCE_RE = /\b(?:private|couple_private|private_room|matrimonial)\b/i;

function resolveQuoteRoomTypeFromPreference(roomType, roomPreference) {
  const rt = String(roomType || 'shared').trim().toLowerCase();
  if (rt && rt !== 'shared') return rt;
  const pref = String(roomPreference || '').trim().toLowerCase();
  if (PRIVATE_ROOM_PREFERENCE_RE.test(pref)) return 'double';
  return 'shared';
}

module.exports = {
  GIRLS_ROOM_CODES,
  PRIVATE_COUPLE_ROOM_CODES,
  computeWolfhouseRoomOptionFlags,
  resolveQuoteRoomTypeFromPreference,
  roomHasCapacity,
};
