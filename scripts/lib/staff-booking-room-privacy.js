'use strict';

// Presentation only. Neither a tariff/quote nor a physical room type proves a
// saved private sale. Read persisted flags plus the existing companion protocol.
const SAVED_BOOKING_ROOM_PRIVACY_SQL = `
WITH parent AS (
  SELECT b.* FROM bookings b JOIN clients c ON c.id = b.client_id
  WHERE c.slug = $1 AND (b.id::text = $2 OR ($2::text IS NULL AND b.booking_code = $3)) LIMIT 1
), assigned AS (
  SELECT bb.* FROM booking_beds bb JOIN parent p
    ON p.id = bb.booking_id AND p.client_id = bb.client_id
  WHERE COALESCE(bb.assignment_type, '') NOT IN ('private_room_block','operator_block','staff_block')
    AND bb.assignment_start_date <= p.check_in AND bb.assignment_end_date >= p.check_out
), inventory AS (
  SELECT bd.bed_code, r.room_code FROM beds bd
  JOIN rooms r ON r.id = bd.room_id AND r.client_id = bd.client_id
  JOIN parent p ON p.client_id = bd.client_id
  WHERE r.room_code IN (SELECT room_code FROM assigned)
), blocks AS (
  SELECT block.id::text AS booking_id, block.booking_code, bb.bed_code, bb.room_code,
    bb.assignment_start_date::text AS check_in, bb.assignment_end_date::text AS check_out
  FROM parent p
  JOIN bookings block ON block.client_id = p.client_id
    AND block.metadata->>'private_room_parent_booking_id' = p.id::text
  JOIN clients c ON c.id = block.client_id AND c.slug = $1
  JOIN booking_beds bb ON bb.booking_id = block.id AND bb.client_id = block.client_id
  JOIN inventory i ON i.bed_code = bb.bed_code AND i.room_code = bb.room_code
  WHERE block.status::text = 'blocked'
    AND block.check_in <= p.check_in AND block.check_out >= p.check_out
    AND bb.assignment_start_date <= p.check_in AND bb.assignment_end_date >= p.check_out
    AND NOT EXISTS (SELECT 1 FROM assigned a WHERE a.bed_code = bb.bed_code)
)
SELECT to_jsonb(p) AS booking,
  COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM assigned a), '[]'::jsonb) AS assignments,
  COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM inventory i), '[]'::jsonb) AS inventory,
  COALESCE((SELECT jsonb_agg(to_jsonb(b)) FROM blocks b), '[]'::jsonb) AS blocks
FROM parent p`;

const unique = values => [...new Set(values.filter(Boolean))].sort();
function unknownPrivacy(bookingCode, diagnostic) {
  return { source: 'saved_booking', booking_code: bookingCode || null,
    private_room_enabled: null, room_codes: [], blocked_bed_codes: [],
    block_booking_codes: [], blocks: [], evidence_complete: false,
    diagnostics: [diagnostic] };
}

// One persisted-flag interpretation for Staff edit snapshots and saved receipts.
// Unknown stays unknown; a price supplement or inventory type cannot prove it.
function savedBookingPrivateFlag(row) {
  if (!row) return null;
  let meta = row.metadata || {};
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (_) { meta = {}; } }
  if (meta && typeof meta.private_room_enabled === 'boolean') return meta.private_room_enabled;
  for (const value of [row.room_preference, row.requested_room_type]) {
    const flag = String(value || '').trim().toLowerCase();
    if (['couple_private', 'private_room', 'private', 'double', 'matrimonial'].includes(flag)) return true;
    if (['shared', 'mixed', 'dorm', 'male_only', 'female_only', 'operator_surfweek'].includes(flag)) return false;
  }
  return null;
}

// Inputs are the tenant/date/room-scoped rows from the reader, not caller quotes.
function projectSavedBookingRoomPrivacy(saved, bookingCode) {
  if (!saved || !saved.booking) return unknownPrivacy(bookingCode, 'saved_booking_not_found');
  const { booking, assignments = [], inventory = [], blocks = [] } = saved;
  const meta = booking.metadata || {};
  const enabled = savedBookingPrivateFlag(booking);
  const roomCodes = unique(assignments.map(a => a.room_code));
  const assignedBeds = new Set(assignments.map(a => a.bed_code));
  const blockBeds = new Set(blocks.map(b => b.bed_code));
  const complete = roomCodes.length > 0 && inventory.length > 0
    && assignments.every(a => inventory.some(i => i.bed_code === a.bed_code && i.room_code === a.room_code))
    && inventory.every(i => assignedBeds.has(i.bed_code) || blockBeds.has(i.bed_code));
  return {
    source: 'saved_booking', booking_code: booking.booking_code,
    private_room_enabled: enabled, room_codes: roomCodes,
    check_in: booking.check_in, check_out: booking.check_out,
    persisted_flags: { room_preference: booking.room_preference || null,
      requested_room_type: booking.requested_room_type || null,
      private_room_enabled: meta.private_room_enabled == null ? null : meta.private_room_enabled },
    blocked_bed_codes: unique(blocks.map(b => b.bed_code)),
    block_booking_codes: unique(blocks.map(b => b.booking_code)), blocks,
    evidence_complete: enabled === true ? complete : enabled === false,
    diagnostics: enabled == null ? ['saved_privacy_flags_unknown']
      : enabled && !complete ? ['private_room_protection_incomplete'] : [],
  };
}

async function loadSavedBookingRoomPrivacy(pg, { clientSlug, bookingId, bookingCode, inTransaction = false }) {
  let savepoint = false;
  try {
    // A failed optional SELECT must not poison a caller-owned booking transaction.
    if (inTransaction) {
      await pg.query('SAVEPOINT saved_room_privacy_read');
      savepoint = true;
    }
    const result = await pg.query(SAVED_BOOKING_ROOM_PRIVACY_SQL,
      [clientSlug, bookingId ? String(bookingId) : null, bookingCode || null]);
    const privacy = projectSavedBookingRoomPrivacy(result.rows[0], bookingCode);
    if (savepoint) await pg.query('RELEASE SAVEPOINT saved_room_privacy_read');
    return privacy;
  } catch (_) {
    if (savepoint) {
      try {
        await pg.query('ROLLBACK TO SAVEPOINT saved_room_privacy_read');
        await pg.query('RELEASE SAVEPOINT saved_room_privacy_read');
      } catch (_) { /* diagnostic only; never replace the saved receipt */ }
    }
    return unknownPrivacy(bookingCode, 'privacy_read_unavailable');
  }
}
module.exports = { SAVED_BOOKING_ROOM_PRIVACY_SQL, savedBookingPrivateFlag, projectSavedBookingRoomPrivacy, loadSavedBookingRoomPrivacy };
