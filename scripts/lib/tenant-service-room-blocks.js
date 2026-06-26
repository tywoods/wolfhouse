'use strict';

/**
 * Wolfhouse camp/service catalog — whole-room inventory blocks for tenant_services.
 * Creates operator whole_room bookings linked to a service row (camp dates + selected rooms).
 */

const crypto = require('crypto');

const ROOM_BEDS_SQL = `
SELECT
  bd.id::text             AS bed_id,
  bd.bed_code,
  r.id::text              AS room_id,
  r.room_code
FROM beds bd
INNER JOIN rooms r ON r.id = bd.room_id
INNER JOIN clients c ON c.id = bd.client_id
WHERE c.slug = $1
  AND upper(trim(r.room_code)) = upper(trim($2))
  AND r.active = TRUE
  AND bd.active = TRUE
  AND bd.sellable = TRUE
ORDER BY COALESCE(bd.bed_number, 999) ASC, bd.bed_code ASC
`;

const BED_CONFLICTS_SQL = `
SELECT
  bb.bed_code,
  b.booking_code,
  b.booking_source::text  AS booking_source
FROM booking_beds bb
INNER JOIN bookings b ON b.id = bb.booking_id
INNER JOIN clients c ON c.id = b.client_id
INNER JOIN beds bd ON bd.id = bb.bed_id
INNER JOIN rooms r ON r.id = bd.room_id
WHERE c.slug = $1
  AND upper(trim(r.room_code)) = upper(trim($2))
  AND bb.assignment_start_date < $4::date
  AND bb.assignment_end_date   > $3::date
  AND b.status NOT IN ('cancelled', 'expired')
  AND NOT (
    b.metadata->>'tenant_service_id' IS NOT NULL
    AND b.metadata->>'tenant_service_id' = $5
  )
ORDER BY bb.bed_code ASC, b.booking_code ASC
`;

function normalizeRoomCode(raw) {
  return String(raw || '').trim().toUpperCase();
}

function normalizeRoomCodes(list) {
  const seen = {};
  const out = [];
  (list || []).forEach((raw) => {
    const code = normalizeRoomCode(raw);
    if (!code || seen[code]) return;
    seen[code] = true;
    out.push(code);
  });
  return out.sort();
}

function serviceBlockCheckOut(endDateIso) {
  const d = new Date(`${endDateIso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function generateCampBlockBookingCode(serviceId) {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(2).toString('hex');
  const tail = String(serviceId || '').replace(/-/g, '').slice(0, 6);
  return `CAMP-${d}-${tail}-${rand}`.toUpperCase();
}

async function ensureServiceBlockColumns(client) {
  await client.query(`ALTER TABLE tenant_services ADD COLUMN IF NOT EXISTS block_rooms_enabled BOOLEAN NOT NULL DEFAULT false`);
  await client.query(`ALTER TABLE tenant_services ADD COLUMN IF NOT EXISTS blocked_room_codes TEXT[] NOT NULL DEFAULT '{}'`);
  await client.query(`ALTER TABLE tenant_services ADD COLUMN IF NOT EXISTS room_block_booking_ids UUID[] NOT NULL DEFAULT '{}'`);
}

async function cancelServiceRoomBlocks(pg, clientId, bookingIds) {
  const ids = (bookingIds || []).filter(Boolean);
  if (!ids.length) return;
  await pg.query(
    `UPDATE bookings
        SET status = 'cancelled',
            staff_notes = COALESCE(staff_notes, '') || E'\nCamp/service room block removed via Camps and Services admin.'
      WHERE client_id = $1
        AND id = ANY($2::uuid[])
        AND status NOT IN ('cancelled', 'expired')`,
    [clientId, ids],
  );
  await pg.query(
    `DELETE FROM booking_beds
      WHERE client_id = $1
        AND booking_id = ANY($2::uuid[])`,
    [clientId, ids],
  );
}

async function createCampRoomBlock(pg, {
  clientId,
  clientSlug,
  service,
  roomCode,
  checkIn,
  checkOut,
  actor,
}) {
  const beds = (await pg.query(ROOM_BEDS_SQL, [clientSlug, roomCode])).rows;
  if (!beds.length) {
    throw Object.assign(new Error(`room_not_found:${roomCode}`), { code: 'room_not_found', room_code: roomCode });
  }
  const conflicts = (await pg.query(BED_CONFLICTS_SQL, [
    clientSlug, roomCode, checkIn, checkOut, String(service.id),
  ])).rows;
  if (conflicts.length) {
    throw Object.assign(new Error('bed_conflicts'), { code: 'bed_conflicts', room_code: roomCode, conflicts });
  }

  const roomId = beds[0].room_id;
  const operatorName = String(service.name || 'Camp').trim().slice(0, 120);
  const bookingCode = generateCampBlockBookingCode(service.id);
  const metadata = JSON.stringify({
    source: 'tenant_service_camp_block',
    tenant_service_id: String(service.id),
    tenant_service_name: operatorName,
    created_by: actor && actor.staff_user_id ? String(actor.staff_user_id) : null,
  });
  const staffNotes = `Camp/service room block for "${operatorName}" (${checkIn} → ${checkOut}).`;

  const bkIns = await pg.query(
    `INSERT INTO bookings (
       client_id, booking_code, guest_name, operator_name,
       booking_source, block_type, status, payment_status, assignment_status,
       availability_check_status, check_in, check_out, guest_count,
       primary_room_code, room_to_block_id, staff_notes,
       deposit_required_cents, deposit_paid_cents, balance_due_cents,
       total_amount_cents, amount_paid_cents, metadata
     ) VALUES (
       $1, $2, $3, $4,
       'operator', 'whole_room', 'confirmed', 'not_requested', 'assigned',
       'unknown', $5::date, $6::date, 1,
       $7, $8::uuid, $9,
       0, 0, 0, 0, 0, $10::jsonb
     )
     RETURNING id`,
    [clientId, bookingCode, operatorName, operatorName, checkIn, checkOut, roomCode, roomId, staffNotes, metadata],
  );
  const bookingId = bkIns.rows[0].id;

  for (const bed of beds) {
    await pg.query(
      `INSERT INTO booking_beds (
         client_id, booking_id, bed_id, assignment_type, assignment_notes,
         assignment_start_date, assignment_end_date, guest_name, room_code, bed_code
       ) VALUES (
         $1, $2, $3::uuid, 'operator_block', $4,
         $5::date, $6::date, $7, $8, $9
       )`,
      [
        clientId, bookingId, bed.bed_id,
        `Camp block: ${operatorName}`,
        checkIn, checkOut, operatorName, bed.room_code, bed.bed_code,
      ],
    );
  }
  await pg.query(
    `UPDATE bookings SET assignment_status = 'assigned' WHERE id = $1 AND client_id = $2`,
    [bookingId, clientId],
  );
  return bookingId;
}

/**
 * Sync whole-room blocks for a tenant_services row. Mutates service.room_block_booking_ids in DB.
 */
async function syncServiceRoomBlocks(pg, { clientSlug, service, actor }) {
  if (!service || !service.id) return { ok: true, booking_ids: [] };

  await ensureServiceBlockColumns(pg);
  const clientRes = await pg.query(`SELECT id FROM clients WHERE slug = $1`, [clientSlug]);
  if (!clientRes.rows.length) return { ok: false, error: 'client_not_found' };
  const clientId = clientRes.rows[0].id;

  const prevIds = Array.isArray(service.room_block_booking_ids) ? service.room_block_booking_ids : [];
  await cancelServiceRoomBlocks(pg, clientId, prevIds);

  const enabled = service.block_rooms_enabled === true;
  const roomCodes = normalizeRoomCodes(service.blocked_room_codes);
  if (!enabled || !roomCodes.length) {
    await pg.query(
      `UPDATE tenant_services SET room_block_booking_ids = '{}'::uuid[] WHERE id = $1::uuid AND client_slug = $2`,
      [service.id, clientSlug],
    );
    return { ok: true, booking_ids: [] };
  }

  const startDate = service.start_date ? String(service.start_date).slice(0, 10) : null;
  const endDate = service.end_date ? String(service.end_date).slice(0, 10) : null;
  if (!startDate || !endDate) {
    return { ok: false, error: 'block_rooms_requires_start_and_end_date' };
  }
  const checkOut = serviceBlockCheckOut(endDate);
  if (!checkOut || checkOut <= startDate) {
    return { ok: false, error: 'invalid_service_date_window' };
  }

  const newIds = [];
  for (const roomCode of roomCodes) {
    try {
      const bookingId = await createCampRoomBlock(pg, {
        clientId,
        clientSlug,
        service,
        roomCode,
        checkIn: startDate,
        checkOut,
        actor,
      });
      newIds.push(bookingId);
    } catch (err) {
      if (err.code === 'bed_conflicts') {
        return { ok: false, error: 'bed_conflicts', room_code: err.room_code, conflicts: err.conflicts || [] };
      }
      if (err.code === 'room_not_found') {
        return { ok: false, error: err.message, room_code: err.room_code };
      }
      throw err;
    }
  }

  await pg.query(
    `UPDATE tenant_services SET room_block_booking_ids = $3::uuid[] WHERE id = $1::uuid AND client_slug = $2`,
    [service.id, clientSlug, newIds],
  );
  return { ok: true, booking_ids: newIds };
}

module.exports = {
  normalizeRoomCodes,
  ensureServiceBlockColumns,
  syncServiceRoomBlocks,
  cancelServiceRoomBlocks,
  serviceBlockCheckOut,
};
