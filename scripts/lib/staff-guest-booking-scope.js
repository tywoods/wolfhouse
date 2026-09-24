'use strict';

/**
 * Guest-facing Staff read scope, NOT inventory scope. Schedule/availability must
 * still see these bookings. Positive block markers survive cancellation/status
 * changes; manual_staff/operator source, zero price and guest names alone do not
 * identify a block. A private-room guest is distinct from its companion block.
 */
function sqlGuestBooking(alias = 'b') {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error('Invalid booking SQL alias');
  return `(
    COALESCE(${alias}.status::text, '') <> 'blocked'
    AND COALESCE(${alias}.block_type::text, 'none') <> 'whole_room'
    AND COALESCE(${alias}.phone, '') NOT IN ('staff-block', 'owner-schedule')
    AND COALESCE(${alias}.metadata->>'staff_calendar_block', 'false') <> 'true'
    AND COALESCE(${alias}.metadata->>'staff_source', '') <> 'staff_block'
    AND COALESCE(${alias}.metadata->>'block_type', '') <> 'private_room_companion'
    AND COALESCE(${alias}.metadata->'external_calendar'->>'connection_id', '') = ''
  )`;
}

module.exports = { sqlGuestBooking };
