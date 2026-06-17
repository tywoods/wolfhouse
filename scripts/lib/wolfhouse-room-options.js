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

function computeWolfhouseRoomOptionFlags(availableBeds, guestCount) {
  const count = Math.max(1, Number(guestCount) || 1);
  const girlsRoomAvailable = roomHasCapacity(availableBeds, GIRLS_ROOM_CODES, 1)
    && (count === 1 || roomHasCapacity(availableBeds, GIRLS_ROOM_CODES, count));
  // Private couples room (R6) only — do not offer private supplement when R6 is taken.
  const privateRoomAvailable = count === 2
    && roomHasCapacity(availableBeds, PRIVATE_COUPLE_ROOM_CODES, 2);
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
