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
  let result;
  try {
    result = await pg.query(sql, params);
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
  return result;
}

/**
 * Propagate the selected guest's name to optional copies, using stored identity.
 * Existing lead-only callers omit bookingGuestId: their target is stable slot 1.
 * An explicit ID never falls back to the lead. oldName remains accepted by old
 * callers but is not an identity predicate. Caller owns the required name edit.
 */
async function propagateBookingLeadName(pg, { bookingId, clientId, bookingGuestId, newName }) {
  const next = String(newName || '').trim();
  if (!pg || !bookingId || !next) return { ok: false };
  const mirrorErrors = [];
  const affectedScope = {};
  const params = [bookingId, next, clientId || null, bookingGuestId ?? null];
  const target = `WITH edited_guest AS (
    SELECT id, booking_id, client_id, guest_number, assigned_bed_code
      FROM booking_guests
     WHERE booking_id = $1::uuid
       AND ($3::uuid IS NULL OR client_id = $3::uuid)
       AND (($4::uuid IS NULL AND guest_number = 1) OR id = $4::uuid)
  ) `;
  const copy = async (mirror, sql) => {
    const result = await writeOptionalNameMirror(pg, mirror, target + sql, params, mirrorErrors);
    affectedScope[mirror] = (result ? result.rows : []).map(row => row.identity);
  };

  await copy('booking_guests',
    `UPDATE booking_guests g
        SET guest_name = $2
       FROM edited_guest e
      WHERE g.id = e.id AND g.booking_id = e.booking_id AND g.client_id = e.client_id
      RETURNING g.id::text AS identity`,
  );

  await copy('booking_beds',
    `UPDATE booking_beds b
        SET guest_name = $2
       FROM edited_guest e
      WHERE b.booking_id = e.booking_id AND b.client_id = e.client_id
        AND b.bed_code = e.assigned_bed_code
      RETURNING b.bed_code AS identity`,
  );

  await copy('guest_rooms',
    `UPDATE guest_rooms r
        SET guest_name = $2
       FROM edited_guest e
      WHERE r.booking_id = e.booking_id AND r.guest_number = e.guest_number
      RETURNING r.guest_number AS identity`,
  );

  // ID-bearing copies match by ID; pre-save copies use their stable ordinal.
  // Names and JSON array position never associate people. Preserve array order.
  const matches = `CASE WHEN COALESCE(elem->>'booking_guest_id', elem->>'id') IS NOT NULL
    THEN lower(COALESCE(elem->>'booking_guest_id', elem->>'id')) = e.id::text
    ELSE elem->>'guest_number' = e.guest_number::text END`;
  await copy('metadata',
    `UPDATE bookings b
        SET metadata = COALESCE(b.metadata, '{}'::jsonb)
          || jsonb_build_object(
               'booking_guests', (
                 SELECT COALESCE(jsonb_agg(
                   CASE WHEN ${matches}
                     THEN elem || jsonb_build_object('guest_name', $2::text)
                     ELSE elem END ORDER BY ordinal
                 ), '[]'::jsonb)
                 FROM jsonb_array_elements(COALESCE(b.metadata->'booking_guests', '[]'::jsonb))
                   WITH ORDINALITY AS entries(elem, ordinal)
               )
             ),
            updated_at = NOW()
       FROM edited_guest e
      WHERE b.id = e.booking_id AND b.client_id = e.client_id
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(b.metadata->'booking_guests', '[]'::jsonb)) elem
          WHERE ${matches}
        )
      RETURNING e.id::text AS identity`,
  );

  return { ok: mirrorErrors.length === 0, affected_scope: affectedScope,
    ...(mirrorErrors.length ? { mirror_errors: mirrorErrors } : {}) };
}

module.exports = { propagateBookingLeadName };
