'use strict';

/**
 * Staff API guest room facts — plain fields Luna/Staff can state without inventing copy.
 * room_kind is only private|shared. type/number/supplement come from assignment + catalog + quote.
 */

const ROOM_KINDS = new Set(['private', 'shared']);

const PRIVATE_TYPE_RE = /private|double|matrimonial|ensuite|couple/;
const SHARED_TYPE_RE = /shared|dorm|mixed|male_only|female_only|operator_surfweek/;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function roomKindFromType(type, capacity) {
  const t = trimStr(type).toLowerCase();
  if (PRIVATE_TYPE_RE.test(t)) return 'private';
  if (SHARED_TYPE_RE.test(t)) return 'shared';
  const cap = Number(capacity);
  if (cap === 1 || cap === 2) return 'private';
  return 'shared';
}

function supplementCentsFromQuote(quote, roomKind) {
  if (roomKind !== 'private') return 0;
  const items = quote && Array.isArray(quote.line_items) ? quote.line_items : [];
  const line = items.find((item) => trimStr(item && item.code).toLowerCase() === 'room_supplement');
  if (!line) return 0;
  const cents = Number(line.total_cents);
  return Number.isFinite(cents) && cents > 0 ? cents : 0;
}

function catalogMap(catalog) {
  if (!catalog) return {};
  if (catalog.rooms && typeof catalog.rooms === 'object') return catalog.rooms;
  return catalog;
}

/**
 * @returns {{
 *   guest_number: number|null,
 *   guest_name: string|null,
 *   room_kind: 'private'|'shared',
 *   type: string|null,
 *   number: string|null,
 *   supplement_cents: number,
 * }}
 */
function projectGuestRoomState(guest, catalog, quote) {
  const src = guest && typeof guest === 'object' ? guest : {};
  const number = trimStr(src.assigned_room_code || src.room_code || src.room_number || src.number) || null;
  const rooms = catalogMap(catalog);
  const cat = number && rooms[number] ? rooms[number] : null;
  const type = trimStr((cat && cat.type) || src.room_type || src.requested_room_type || src.type) || null;
  const roomKind = roomKindFromType(type, cat && cat.capacity);
  return {
    guest_number: src.guest_number != null ? Number(src.guest_number) : null,
    guest_name: trimStr(src.guest_name || src.name) || null,
    room_kind: roomKind,
    type,
    number,
    supplement_cents: supplementCentsFromQuote(quote, roomKind),
  };
}

function projectGuestRooms(guests, catalog, quote) {
  return (Array.isArray(guests) ? guests : []).map((g) => projectGuestRoomState(g, catalog, quote));
}

module.exports = {
  ROOM_KINDS,
  roomKindFromType,
  projectGuestRoomState,
  projectGuestRooms,
};
