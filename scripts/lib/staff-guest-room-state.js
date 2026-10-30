'use strict';

/**
 * Staff API guest room facts — plain fields Luna/Staff can state without inventing copy.
 * room_kind is only private|shared when the assigned catalog room proves it.
 * Unknown rooms stay unknown. Requested type is never asserted as the room.
 * Supplements are split across the private guests who actually have that room.
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
  if (!t && (capacity == null || capacity === '')) return null;
  if (PRIVATE_TYPE_RE.test(t)) return 'private';
  if (SHARED_TYPE_RE.test(t)) return 'shared';
  const cap = Number(capacity);
  if (cap === 1 || cap === 2) return 'private';
  if (Number.isFinite(cap) && cap >= 3) return 'shared';
  return null;
}

function catalogMap(catalog) {
  if (!catalog) return {};
  if (catalog.rooms && typeof catalog.rooms === 'object') return catalog.rooms;
  return catalog;
}

function splitCents(total, n) {
  const cents = Number(total);
  if (!Number.isFinite(cents) || cents <= 0 || n < 1) return [];
  const base = Math.floor(cents / n);
  const rem = cents - base * n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(base + (i < rem ? 1 : 0));
  return out;
}

function projectOne(guest, catalog) {
  const src = guest && typeof guest === 'object' ? guest : {};
  const number = trimStr(src.assigned_room_code || src.room_code || src.room_number || src.number) || null;
  const rooms = catalogMap(catalog);
  const cat = number && rooms[number] ? rooms[number] : null;
  const type = cat ? (trimStr(cat.type) || null) : null;
  const roomKind = cat ? roomKindFromType(type, cat.capacity) : null;
  return {
    guest_number: src.guest_number != null ? Number(src.guest_number) : null,
    guest_name: trimStr(src.guest_name || src.name) || null,
    room_kind: roomKind,
    type,
    number,
    supplement_cents: 0,
  };
}

function allocateSupplements(projected, quote) {
  const rows = (Array.isArray(projected) ? projected : []).map((g) => Object.assign({}, g, {
    supplement_cents: 0,
  }));
  const perPerson = quote && Array.isArray(quote.per_person) ? quote.per_person : [];
  const byGuest = {};
  for (const row of perPerson) {
    if (!row || row.guest_number == null) continue;
    if (row.supplement_cents == null) continue;
    const cents = Number(row.supplement_cents);
    if (Number.isFinite(cents) && cents >= 0) byGuest[row.guest_number] = cents;
  }
  const items = quote && Array.isArray(quote.line_items) ? quote.line_items : [];
  const line = items.find((item) => trimStr(item && item.code).toLowerCase() === 'room_supplement');
  const total = line ? Number(line.total_cents) : 0;

  let allocated = 0;
  for (const g of rows) {
    if (Object.prototype.hasOwnProperty.call(byGuest, g.guest_number)) {
      g.supplement_cents = byGuest[g.guest_number];
      allocated += g.supplement_cents;
    }
  }

  if (!Number.isFinite(total) || total <= 0) return rows;

  const remaining = Math.max(0, total - allocated);
  const unallocatedPrivate = rows.filter((g) => (
    g.room_kind === 'private'
    && !Object.prototype.hasOwnProperty.call(byGuest, g.guest_number)
  ));
  if (unallocatedPrivate.length) {
    const shares = splitCents(remaining, unallocatedPrivate.length);
    unallocatedPrivate.forEach((g, i) => {
      g.supplement_cents = shares[i] || 0;
    });
  } else if (remaining > 0) {
    const lastPrivate = rows.filter((g) => g.room_kind === 'private').pop();
    if (lastPrivate) lastPrivate.supplement_cents += remaining;
  }
  return rows;
}

/**
 * @returns {{
 *   guest_number: number|null,
 *   guest_name: string|null,
 *   room_kind: 'private'|'shared'|null,
 *   type: string|null,
 *   number: string|null,
 *   supplement_cents: number,
 * }}
 */
function projectGuestRoomState(guest, catalog, quote) {
  return projectGuestRooms([guest], catalog, quote)[0];
}

function projectGuestRooms(guests, catalog, quote) {
  const projected = (Array.isArray(guests) ? guests : []).map((g) => projectOne(g, catalog));
  return allocateSupplements(projected, quote);
}

module.exports = {
  ROOM_KINDS,
  roomKindFromType,
  projectGuestRoomState,
  projectGuestRooms,
};
