'use strict';

/**
 * Staff API guest room facts — plain fields Luna/Staff can state without inventing copy.
 * room_kind is only private|shared when the assigned catalog room and saved occupancy prove it.
 * Hybrid matrimonial_or_mixed is mixed-capable capacity, not private by category.
 * Unknown rooms stay unknown. Requested type is never asserted as the room.
 * Internal room codes stay on `number`; numeric inventory identity is `room_number`.
 * Rooms have no names: room_label is a catalog guest-safe name only, never the code.
 * Supplements are split across the private guests who actually have that room.
 */

const ROOM_KINDS = new Set(['private', 'shared']);
const ROOM_NUMBER_RE = /^(?:R)?(\d+)$/i;

const PRIVATE_TYPE_RE = /private|double|matrimonial|ensuite|couple/;
const SHARED_TYPE_RE = /shared|dorm|mixed|male_only|female_only|operator_surfweek/;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function numericRoomNumber(code) {
  const match = ROOM_NUMBER_RE.exec(trimStr(code));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function isHybridMixedType(type) {
  return trimStr(type).toLowerCase() === 'matrimonial_or_mixed';
}

function genderFromCatalog(type) {
  const t = trimStr(type).toLowerCase();
  if (t === 'female_only') return 'female';
  if (t === 'male_only') return 'male';
  if (t === 'mixed' || t === 'matrimonial_or_mixed') return 'mixed';
  return null;
}

function roomKindFromType(type, capacity) {
  const t = trimStr(type).toLowerCase();
  if (!t && (capacity == null || capacity === '')) return null;
  // Hybrid category alone is mixed-capable capacity, not private.
  if (isHybridMixedType(t)) return null;
  if (PRIVATE_TYPE_RE.test(t)) return 'private';
  if (SHARED_TYPE_RE.test(t)) return 'shared';
  const cap = Number(capacity);
  if (cap === 1 || cap === 2) return 'private';
  if (Number.isFinite(cap) && cap >= 3) return 'shared';
  return null;
}

function occupancyFromSaved(type, cat, guest) {
  // Legacy couple/operator protections take precedence over ordinary selling_mode.
  // Calendar/query default selling_mode=shared must not erase matrimonial_private_couple.
  const dedicated = roomKindFromType(type, cat && cat.capacity);
  if (dedicated === 'private') return 'private';
  const selling = trimStr(cat && (cat.selling_mode || cat.sellingMode)).toLowerCase();
  if (selling === 'private') return 'private';
  if (isHybridMixedType(type)) {
    if (selling === 'shared') return 'shared';
    const bed = trimStr(guest && (guest.assigned_bed_code || guest.bed_code));
    return bed ? 'shared' : null;
  }
  if (selling === 'shared') return 'shared';
  return dedicated;
}

function catalogMap(catalog) {
  if (!catalog) return {};
  if (catalog.rooms && typeof catalog.rooms === 'object') return catalog.rooms;
  return catalog;
}

function catalogFromRoomRows(rows) {
  const catalog = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const code = trimStr(row && (row.room_code || row.number));
    if (!code) continue;
    if (catalog[code]) continue;
    const explicitNumber = row.room_number != null && row.room_number !== ''
      ? Number(row.room_number)
      : numericRoomNumber(code);
    catalog[code] = {
      type: trimStr(row.room_type || row.type) || null,
      room_name: trimStr(row.room_name || row.name || row.guest_safe_room_label) || null,
      capacity: row.capacity,
      gender_strategy: trimStr(row.gender_strategy || row.genderStrategy) || null,
      selling_mode: trimStr(row.selling_mode || row.sellingMode) || null,
      room_number: Number.isSafeInteger(explicitNumber) ? explicitNumber : null,
    };
  }
  return catalog;
}

function loadConfiguredRoomCatalog() {
  try {
    const inv = require('./wolfhouse-inventory-source');
    return catalogFromRoomRows(
      inv.csvInventoryToBedCalendarRows(inv.loadWolfhouseInventoryFromCsv()),
    );
  } catch (_err) {
    return {};
  }
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

function guestSafeRoomLabel(cat, number) {
  if (!cat) return null;
  const label = trimStr(
    cat.guest_safe_room_label || cat.room_label || cat.room_name
    || cat.display_name || cat.name || cat.label,
  );
  if (!label || label === number) return null;
  return label;
}

function projectOne(guest, catalog) {
  const src = guest && typeof guest === 'object' ? guest : {};
  const number = trimStr(src.assigned_room_code || src.room_code || src.room_number || src.number) || null;
  const rooms = catalogMap(catalog);
  const cat = number && rooms[number] ? rooms[number] : null;
  const type = cat ? (trimStr(cat.type) || null) : null;
  const occupancy = cat ? occupancyFromSaved(type, cat, src) : null;
  const roomKind = occupancy || (cat ? roomKindFromType(type, cat.capacity) : null);
  const explicitNumber = cat && cat.room_number != null && cat.room_number !== ''
    ? Number(cat.room_number)
    : numericRoomNumber(number);
  return {
    booking_guest_id: trimStr(src.booking_guest_id || src.guest_id) || null,
    guest_number: src.guest_number != null ? Number(src.guest_number) : null,
    guest_name: trimStr(src.guest_name || src.name) || null,
    room_kind: roomKind,
    occupancy: occupancy || null,
    gender: cat ? genderFromCatalog(type) : null,
    room_label: guestSafeRoomLabel(cat, number),
    type,
    number,
    room_number: Number.isSafeInteger(explicitNumber) ? explicitNumber : null,
    assigned_bed_code: trimStr(src.assigned_bed_code || src.bed_code) || null,
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
  const total = line ? Number(line.total_cents) : NaN;
  const budget = line && Number.isFinite(total) && total >= 0 ? total : null;

  let allocated = 0;
  for (const g of rows) {
    if (g.room_kind !== 'private') continue;
    if (!Object.prototype.hasOwnProperty.call(byGuest, g.guest_number)) continue;
    let cents = byGuest[g.guest_number];
    if (budget != null) {
      cents = Math.min(cents, Math.max(0, budget - allocated));
    }
    g.supplement_cents = cents;
    allocated += cents;
  }

  if (budget == null) return rows;

  const remaining = Math.max(0, budget - allocated);
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
 *   booking_guest_id: string|null,
 *   guest_number: number|null,
 *   guest_name: string|null,
 *   room_kind: 'private'|'shared'|null,
 *   occupancy: 'private'|'shared'|null,
 *   gender: 'mixed'|'male'|'female'|null,
 *   room_label: string|null,
 *   type: string|null,
 *   number: string|null,
 *   room_number: number|null,
 *   assigned_bed_code: string|null,
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
  numericRoomNumber,
  catalogFromRoomRows,
  loadConfiguredRoomCatalog,
  projectGuestRoomState,
  projectGuestRooms,
};
