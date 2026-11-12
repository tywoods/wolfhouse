'use strict';

/**
 * Propagate a Luna/staff lead-name change to every guest-name copy.
 * Never throws in a way that should block a booking save; callers catch.
 */
async function propagateBookingLeadName(pg, { bookingId, clientId, oldName, newName }) {
  const next = String(newName || '').trim();
  const prev = String(oldName || '').trim();
  if (!pg || !bookingId || !next) return { ok: false };
  const id = bookingId;
  const cid = clientId || null;

  await pg.query(
    `UPDATE booking_guests
        SET guest_name = $3
      WHERE booking_id = $1::uuid
        AND ($4::uuid IS NULL OR client_id = $4::uuid)
        AND (
          guest_number = 1
          OR ($2 <> '' AND guest_name = $2)
        )`,
    [id, prev, next, cid],
  );

  await pg.query(
    `UPDATE booking_beds
        SET guest_name = $3
      WHERE booking_id = $1::uuid
        AND ($2 <> '' AND guest_name = $2)`,
    [id, prev, next],
  );

  await pg.query(
    `UPDATE guest_rooms
        SET guest_name = $3
      WHERE booking_id = $1::uuid
        AND (
          guest_number = 1
          OR ($2 <> '' AND guest_name = $2)
        )`,
    [id, prev, next],
  ).catch(() => ({ rows: [] }));

  await pg.query(
    `UPDATE bookings
        SET metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object(
               'booking_guests', (
                 SELECT COALESCE(jsonb_agg(
                   CASE
                     WHEN (elem->>'guest_number') = '1'
                       OR ($2 <> '' AND elem->>'guest_name' = $2)
                     THEN elem || jsonb_build_object('guest_name', $3::text)
                     ELSE elem
                   END
                 ), '[]'::jsonb)
                 FROM jsonb_array_elements(COALESCE(metadata->'booking_guests', '[]'::jsonb)) elem
               )
             ),
            updated_at = NOW()
      WHERE id = $1::uuid`,
    [id, prev, next],
  );

  return { ok: true };
}

module.exports = { propagateBookingLeadName };
