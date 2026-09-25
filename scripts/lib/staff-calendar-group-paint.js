'use strict';

/**
 * Schedule group paint for one booking that occupies more than one bed.
 *
 * A group booking is one booking_id with several booking_beds rows (often
 * different guest names, sometimes different rooms). The grid must keep one
 * bar per assigned bed, but must not clone the booking name and the booking
 * money pills onto every bed. Money pills stay on the primary bed only.
 * Sibling bars share a soft accent so a hover can find them across rooms.
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
 * @returns {object[]} same block objects, with group paint fields set
 */
function annotateCalendarBlocks(blocks, guestRows) {
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
    const accent = size > 1 && bookingId ? accentForGroupKey(bookingId) : null;
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
  accentForGroupKey,
  annotateCalendarBlocks,
  applyCalendarGuestPebbleFields,
  groupHoverTargets,
};
