'use strict';

/**
 * Schedule group paint for one booking that occupies more than one bed.
 *
 * A group booking is one booking_id with several booking_beds rows (often
 * different guest names, sometimes different rooms). The grid must keep one
 * bar per assigned bed, but must not clone the booking name and the booking
 * money pills onto every bed. Money pills stay on the primary bed only.
 * Sibling bars share a soft accent so a hover can find them across rooms.
 *
 * BOOKING-BAR-ACCENT-001: every booking gets one stable left-edge color.
 * The color is a hash of booking_id, not payment status or price. Two
 * bookings whose stays are within 2 months do not share that color.
 * A gap of at least 2 months may reuse it. Hue variations are the overflow.
 */

const GROUP_ACCENTS = [
  '#D7E3D4',
  '#E4DCEC',
  '#D9E4EE',
  '#E7E0D4',
  '#DCE8E4',
  '#E5DDD8',
  '#DDE3EA',
  '#E3E6D8',
];

function normCode(value) {
  return String(value || '').trim().toUpperCase();
}

function normName(value) {
  const s = String(value || '').trim();
  if (!s || s === '\u2014') return '';
  return s;
}

function accentForGroupKey(key) {
  const s = String(key || '');
  if (!s) return GROUP_ACCENTS[0];
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash * 33 + s.charCodeAt(i)) >>> 0;
  }
  return GROUP_ACCENTS[hash % GROUP_ACCENTS.length];
}

const ACCENT_HUE_COUNT = 24;
const ACCENT_VARIATIONS = [
  { s: 48, l: 38 },
  { s: 42, l: 28 },
  { s: 36, l: 48 },
  { s: 55, l: 32 },
];
const ACCENT_GAP_MONTHS = 2;

const BOOKING_ACCENT_STAY_SQL = `
SELECT b.id::text AS booking_id,
       b.check_in::text AS check_in,
       b.check_out::text AS check_out
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1
   AND b.status NOT IN ('cancelled', 'expired')
   AND b.check_in < ($3::date + INTERVAL '2 months')
   AND b.check_out > ($2::date - INTERVAL '2 months')
`;

function hashBookingId(key) {
  const s = String(key || '');
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash * 33 + s.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function isoDate(value) {
  const s = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function addCalendarMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m - 1) + months, d));
  return dt.toISOString().slice(0, 10);
}

function stayOf(row) {
  const start = isoDate(row && (row.check_in || row.start_date || row.assignment_start_date));
  const end = isoDate(row && (row.check_out || row.end_date || row.assignment_end_date)) || start;
  return { start, end };
}

function staysWithinAccentWindow(a, b) {
  if (!a.start || !b.start) return true;
  const aEnd = a.end || a.start;
  const bEnd = b.end || b.start;
  const aFirst = a.start <= b.start;
  const earlierEnd = aFirst ? aEnd : bEnd;
  const laterStart = aFirst ? b.start : a.start;
  if (laterStart <= earlierEnd) return true;
  return laterStart < addCalendarMonths(earlierEnd, ACCENT_GAP_MONTHS);
}

function accentColor(hueIndex, variationIndex) {
  const hue = (hueIndex % ACCENT_HUE_COUNT) * (360 / ACCENT_HUE_COUNT);
  const variation = ACCENT_VARIATIONS[variationIndex] || ACCENT_VARIATIONS[0];
  return `hsl(${Math.round(hue)} ${variation.s}% ${variation.l}%)`;
}

/**
 * Stable color per booking_id. Walks preferred hue, then hue variations,
 * so a stay within 2 months of another booking does not reuse that color.
 */
function assignBookingAccents(rows) {
  const byId = new Map();
  (rows || []).forEach((row) => {
    const id = String(row && (row.booking_id || row.id) || '').trim();
    if (!id || byId.has(id)) return;
    const stay = stayOf(row);
    byId.set(id, { id, start: stay.start, end: stay.end });
  });
  const sorted = [...byId.values()].sort((a, b) => {
    const ds = String(a.start).localeCompare(String(b.start));
    if (ds) return ds;
    return a.id.localeCompare(b.id);
  });
  const assigned = [];
  const colors = new Map();
  sorted.forEach((booking) => {
    const preferred = hashBookingId(booking.id) % ACCENT_HUE_COUNT;
    const forbidden = new Set();
    assigned.forEach((prev) => {
      if (staysWithinAccentWindow(prev, booking)) forbidden.add(prev.slotKey);
    });
    let chosen = null;
    for (let variation = 0; variation < ACCENT_VARIATIONS.length && !chosen; variation += 1) {
      for (let step = 0; step < ACCENT_HUE_COUNT; step += 1) {
        const hue = (preferred + step) % ACCENT_HUE_COUNT;
        const slotKey = `${hue}:${variation}`;
        if (forbidden.has(slotKey)) continue;
        chosen = { hue, variation, slotKey, color: accentColor(hue, variation) };
        break;
      }
    }
    if (!chosen) {
      const variation = hashBookingId(booking.id) % ACCENT_VARIATIONS.length;
      chosen = {
        hue: preferred,
        variation,
        slotKey: `${preferred}:${variation}:overflow`,
        color: accentColor(preferred, variation),
      };
    }
    assigned.push({ ...booking, ...chosen });
    colors.set(booking.id, chosen.color);
  });
  return colors;
}

function guestsForBooking(guestRows, bookingId) {
  return (guestRows || [])
    .filter((row) => String(row.booking_id || '') === String(bookingId || ''))
    .slice()
    .sort((a, b) => Number(a.guest_number || 0) - Number(b.guest_number || 0));
}

function bedSort(a, b) {
  const room = normCode(a.room_code).localeCompare(normCode(b.room_code), undefined, { numeric: true });
  if (room) return room;
  return normCode(a.bed_code).localeCompare(normCode(b.bed_code), undefined, { numeric: true });
}

function matchGuestToBed(guests, used, row) {
  const bedCode = normCode(row.bed_code);
  const roomCode = normCode(row.room_code);
  if (!bedCode) return null;
  return guests.find((guest) => {
    if (used.has(guest)) return false;
    if (normCode(guest.assigned_bed_code) !== bedCode) return false;
    const guestRoom = normCode(guest.assigned_room_code);
    return !guestRoom || !roomCode || guestRoom === roomCode;
  }) || null;
}

function resolveBedDisplayName(row, guest) {
  if (guest && normName(guest.guest_name)) return normName(guest.guest_name);
  const bedGuest = normName(row.bed_guest_name);
  const bookingGuest = normName(row.guest_name);
  if (bedGuest && bedGuest.toLowerCase() !== bookingGuest.toLowerCase()) return bedGuest;
  return '';
}

function guestMetaObject(guest) {
  if (!guest) return {};
  const raw = guest.metadata != null ? guest.metadata : guest.guest_metadata;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

function storedGuestShareCents(guest) {
  const n = Number(guestMetaObject(guest).subtotal_cents);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Copy the matched guest's stored share onto the bar. Does not recompute a quote.
 * Link flags are set only when the block already carries link ids from the
 * existing payment-link rows.
 */
function applyCalendarGuestPebbleFields(block, guest, isPrimary) {
  if (!block) return;
  if (guest) {
    block.calendar_guest_id = guest.booking_guest_id ? String(guest.booking_guest_id) : null;
    block.calendar_guest_number = guest.guest_number != null ? Number(guest.guest_number) : null;
    block.calendar_guest_share_cents = storedGuestShareCents(guest);
    block.calendar_guest_deposit_cents = guest.deposit_amount_cents != null
      ? Number(guest.deposit_amount_cents) : null;
    block.calendar_guest_paid_cents = guest.amount_paid_cents != null
      ? Number(guest.amount_paid_cents) : null;
    const pkg = String(guestMetaObject(guest).package_code || '').trim().toLowerCase();
    block.calendar_guest_package_code = pkg && pkg !== 'no_package' && pkg !== 'package_none' ? pkg : null;
  }
  const hasLinkList = Array.isArray(block.active_link_guest_ids);
  const bookingLinkKnown = block.has_booking_level_active_link != null;
  if (!hasLinkList && !bookingLinkKnown) return;
  const guestId = guest && guest.booking_guest_id ? String(guest.booking_guest_id) : '';
  const ownLink = !!(guestId && hasLinkList && block.active_link_guest_ids.map(String).includes(guestId));
  const unscopedOnPrimary = !ownLink && !!isPrimary && block.has_booking_level_active_link === true;
  block.calendar_guest_link_sent = ownLink || unscopedOnPrimary;
}

/**
 * @param {object[]} blocks calendar blocks (one per booking_beds row)
 * @param {object[]} guestRows booking_guests rows for those bookings
 * @param {object[]} [accentStayRows] booking stays in a ±2 month window
 * @returns {object[]} same block objects, with group paint fields set
 */
function annotateCalendarBlocks(blocks, guestRows, accentStayRows) {
  const list = Array.isArray(blocks) ? blocks : [];
  const byBooking = new Map();
  list.forEach((block) => {
    const id = String(block && block.booking_id || '');
    if (!byBooking.has(id)) byBooking.set(id, []);
    byBooking.get(id).push(block);
  });

  byBooking.forEach((beds, bookingId) => {
    const guests = guestsForBooking(guestRows, bookingId);
    const sorted = beds.slice().sort(bedSort);
    const used = new Set();
    const guestByBlock = new Map();
    sorted.forEach((block) => {
      const match = matchGuestToBed(guests, used, block);
      if (match) used.add(match);
      guestByBlock.set(block, match);
    });
    const leftover = guests.filter((guest) => !used.has(guest));
    let leftoverIndex = 0;
    sorted.forEach((block) => {
      if (guestByBlock.get(block)) return;
      if (resolveBedDisplayName(block, null)) return;
      if (leftover[leftoverIndex]) {
        guestByBlock.set(block, leftover[leftoverIndex]);
        leftoverIndex += 1;
      }
    });

    const size = beds.length;
    const accent = null;
    const primaryGuest = guests.find((guest) => Number(guest.guest_number) === 1) || null;
    let primary = null;
    if (primaryGuest && normCode(primaryGuest.assigned_bed_code)) {
      primary = sorted.find((block) => normCode(block.bed_code) === normCode(primaryGuest.assigned_bed_code)) || null;
    }
    if (!primary) primary = sorted[0] || null;

    beds.forEach((block) => {
      const guest = guestByBlock.get(block) || null;
      const display = resolveBedDisplayName(block, guest);
      if (display) {
        block.guest_name = display;
        block.bed_guest_name = display;
      }
      block.calendar_group_key = bookingId || null;
      block.calendar_group_size = size;
      block.calendar_group_accent = accent;
      block.calendar_show_payment_pills = size <= 1 || block === primary;
      applyCalendarGuestPebbleFields(block, guest, block === primary);
    });
  });

  const accentSource = (accentStayRows && accentStayRows.length) ? accentStayRows : list;
  const accentById = assignBookingAccents(accentSource.concat(list));
  list.forEach((block) => {
    const id = String(block && block.booking_id || '').trim();
    block.calendar_group_accent = id ? (accentById.get(id) || null) : null;
  });

  return list;
}

function groupHoverTargets(blocks, hovered) {
  if (!hovered) return [];
  const key = hovered.calendar_group_key;
  const size = Number(hovered.calendar_group_size || 0);
  if (!key || size < 2) return [hovered];
  return (blocks || []).filter((block) => block && block.calendar_group_key === key);
}

module.exports = {
  GROUP_ACCENTS,
  ACCENT_HUE_COUNT,
  ACCENT_GAP_MONTHS,
  BOOKING_ACCENT_STAY_SQL,
  accentForGroupKey,
  assignBookingAccents,
  staysWithinAccentWindow,
  annotateCalendarBlocks,
  applyCalendarGuestPebbleFields,
  groupHoverTargets,
};
