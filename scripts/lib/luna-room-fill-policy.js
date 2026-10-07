'use strict';

// Read only the policy projected by the tenant-scoped inventory SQL, never a tool-body policy.
const { parseStoredPolicy, validatePolicyShape, roomNumberFromCode, SUPPORTED_CLIENT_SLUG } = require('./staff-room-fill-policy');
const { nightsBetween } = require('./room-fill-ranking');

function resolveRoomFillRanking({ clientSlug, bedRows = [], blockRows = [], checkIn, checkOut }) {
  if (clientSlug !== SUPPORTED_CLIENT_SLUG) return { status: 'not_applicable', byRoom: null };
  const raw = bedRows[0] && bedRows[0].room_fill_policy;
  if (raw == null) return { status: 'not_configured', byRoom: null };
  const parsed = parseStoredPolicy(raw);
  if (!parsed.ok) return { status: 'invalid_policy', byRoom: null };
  const catalogue = bedRows[0].room_fill_catalogue;
  if (!Array.isArray(catalogue) || !catalogue.length) return { status: 'catalogue_changed', byRoom: null };
  const identities = catalogue.map(row => ({ roomId: row.room_id, roomCode: row.room_code, roomNumber: roomNumberFromCode(row.room_code) }));
  if (!validatePolicyShape(parsed.policy, identities).ok) return { status: 'catalogue_changed', byRoom: null };
  const nights = nightsBetween(checkIn, checkOut);
  if (!nights) return { status: 'invalid_stay', byRoom: null };
  const order = new Map(parsed.policy.roomPriority.map((id, rank) => [id, rank]));
  const byRoom = new Map();
  const byBed = new Map();
  for (const row of bedRows) {
    if (!order.has(row.room_id)) return { status: 'catalogue_changed', byRoom: null };
    if (!byRoom.has(row.room_code)) byRoom.set(row.room_code, {
      mode: parsed.policy.fillMode, roomId: row.room_id, rank: order.get(row.room_id),
      beds: new Map(),
    });
    if (row.bed_code && row.bed_active !== false && row.bed_sellable !== false) {
      const room = byRoom.get(row.room_code);
      if (!room.beds.has(row.bed_code)) room.beds.set(row.bed_code, new Set());
      byBed.set(row.bed_code, room.beds.get(row.bed_code));
    }
  }
  for (const block of blockRows) {
    const busy = byBed.get(block.bed_code);
    if (!busy) continue;
    const start = block.assignment_start_date;
    const end = block.assignment_end_date;
    for (const night of nights) if (start <= night && night < end) busy.add(night);
  }
  for (const room of byRoom.values()) {
    room.capacity = room.beds.size;
    room.unavailable = nights.map(night => [...room.beds.values()].filter(busy => busy.has(night)).length);
    delete room.beds;
  }
  return { status: 'active', byRoom };
}

module.exports = { resolveRoomFillRanking };
