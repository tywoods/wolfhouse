'use strict';

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function isPrivateRoomCompanionBlock(booking, metadata) {
  const bk = booking || {};
  const md = metadata || bk.metadata || {};
  if (String(bk.status || '').toLowerCase() === 'blocked') return true;
  if (md.staff_calendar_block === true && md.block_type === 'private_room_companion') return true;
  if (md.source === 'private_room_companion_block') return true;
  if (trimStr(md.private_room_parent_booking_id)) return true;
  return false;
}

function projectBlockedBedDisplay(booking, metadata) {
  if (!isPrivateRoomCompanionBlock(booking, metadata)) return null;
  const bk = booking || {};
  const md = metadata || bk.metadata || {};
  const parentId = trimStr(md.private_room_parent_booking_id) || null;
  const parentCode = trimStr(md.private_room_parent_booking_code) || null;
  const staffNotes = trimStr(bk.staff_notes);
  const noteText = staffNotes || (parentId || parentCode
    ? `Private room companion block for ${parentCode || parentId}`
    : '');
  return {
    is_blocked_inventory: true,
    guest_accommodation_lines: [],
    booking_guests: [],
    parent_booking_id: parentId,
    parent_booking_code: parentCode,
    staff_notes: noteText || null,
    luna_guest_notes: noteText ? [{ source: 'staff', text: noteText }] : [],
  };
}

function guestAccommodationLinesForBooking(booking, metadata, liveLines) {
  if (isPrivateRoomCompanionBlock(booking, metadata)) return [];
  return Array.isArray(liveLines) ? liveLines : [];
}

module.exports = {
  isPrivateRoomCompanionBlock,
  projectBlockedBedDisplay,
  guestAccommodationLinesForBooking,
};
