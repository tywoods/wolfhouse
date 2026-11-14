'use strict';

let mirrorSavepointSequence = 0;

/** Isolate one optional copy without owning or committing the caller transaction. */
async function writeOptionalNameMirror(pg, mirror, sql, params, errors) {
  const savepoint = `booking_name_mirror_${++mirrorSavepointSequence}`;
  let transactional = false;
  try {
    await pg.query(`SAVEPOINT ${savepoint}`);
    transactional = true;
  } catch (error) {
    // Existing update-contact also calls this helper in autocommit mode, where
    // each statement already isolates its SQL failure. No BEGIN/COMMIT here.
    if (error.code !== '25P01') throw error;
  }
  try {
    await pg.query(sql, params);
  } catch (error) {
    if (transactional) {
      await pg.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await pg.query(`RELEASE SAVEPOINT ${savepoint}`);
    }
    // Callers historically ignore this helper's result. Surface the failure in
    // bounded diagnostics too, without SQL text, parameters, names or messages.
    const failure = { mirror, code: /^[0-9A-Z]{5}$/.test(error.code || '') ? error.code : 'unknown' };
    errors.push(failure);
    console.warn('booking_name_mirror_failed', JSON.stringify(failure));
    return;
  }
  if (transactional) await pg.query(`RELEASE SAVEPOINT ${savepoint}`);
}

/**
 * Propagate a Luna/staff lead-name change to optional guest-name copies.
 * The caller's required guest/lead edit must survive any individual mirror error.
 */
async function propagateBookingLeadName(pg, { bookingId, clientId, oldName, newName }) {
  const next = String(newName || '').trim();
  const prev = String(oldName || '').trim();
  if (!pg || !bookingId || !next) return { ok: false };
  const id = bookingId;
  const cid = clientId || null;
  const mirrorErrors = [];

  await writeOptionalNameMirror(pg, 'booking_guests',
    `UPDATE booking_guests
        SET guest_name = $3
      WHERE booking_id = $1::uuid
        AND ($4::uuid IS NULL OR client_id = $4::uuid)
        AND (
          guest_number = 1
          OR ($2 <> '' AND guest_name = $2)
        )`,
    [id, prev, next, cid], mirrorErrors,
  );

  await writeOptionalNameMirror(pg, 'booking_beds',
    `UPDATE booking_beds
        SET guest_name = $3
      WHERE booking_id = $1::uuid
        AND ($2 <> '' AND guest_name = $2)`,
    [id, prev, next], mirrorErrors,
  );

  await writeOptionalNameMirror(pg, 'guest_rooms',
    `UPDATE guest_rooms
        SET guest_name = $3
      WHERE booking_id = $1::uuid
        AND (
          guest_number = 1
          OR ($2 <> '' AND guest_name = $2)
        )`,
    [id, prev, next], mirrorErrors,
  );

  await writeOptionalNameMirror(pg, 'metadata',
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
    [id, prev, next], mirrorErrors,
  );

  return mirrorErrors.length ? { ok: false, mirror_errors: mirrorErrors } : { ok: true };
}

module.exports = { propagateBookingLeadName };
