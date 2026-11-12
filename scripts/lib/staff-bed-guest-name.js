'use strict';

// booking_beds.guest_name may be a legacy copy of the booking lead's name.
// Prefer the uniquely assigned booking guest, never row order or a party-wide name.
// A scalar aggregate preserves one block per bed even for ambiguous legacy rows.
// Callers provide the existing bookings b / booking_beds bb / rooms r aliases.
const BED_GUEST_NAME_SQL = `COALESCE((
    SELECT CASE WHEN COUNT(*) = 1 THEN MAX(NULLIF(BTRIM(bg.guest_name), '')) END
    FROM booking_guests bg
    WHERE bg.client_id = b.client_id
      AND bg.booking_id = b.id
      AND bg.assigned_bed_code = bb.bed_code
      AND bg.assigned_room_code = COALESCE(NULLIF(bb.room_code, ''), r.room_code)
  ), bb.guest_name)`;

module.exports = { BED_GUEST_NAME_SQL };
