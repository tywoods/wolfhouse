/**
 * Shared assign plan for 3b.2a report and 3b.2b execute script.
 * Read-only queries only.
 */
const { assignmentNaturalKey, toIsoDateString } = require('./bed-drift-keys');

function parseBedList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function roomCodeFromBedCode(bedCode) {
  const m = String(bedCode || '').match(/^(R\d+)-/i);
  return m ? m[1].toUpperCase() : null;
}

async function loadAssignPlan(client, flags) {
  const { rows: clientRows } = await client.query(`SELECT id FROM clients WHERE slug = $1`, [
    flags.clientSlug,
  ]);
  if (!clientRows.length) return { error: 'client_not_found', slug: flags.clientSlug };
  const clientId = clientRows[0].id;

  let bookingQuery = `SELECT
       id,
       booking_code,
       airtable_record_id,
       guest_name,
       status::text AS status,
       payment_status::text AS payment_status,
       assignment_status::text AS assignment_status,
       availability_check_status::text AS availability_check_status,
       check_in::text AS check_in,
       check_out::text AS check_out,
       guest_count,
       booking_source::text AS booking_source
     FROM bookings
     WHERE client_id = $1`;
  const bookingParams = [clientId];
  if (flags.bookingCode) {
    bookingParams.push(flags.bookingCode);
    bookingQuery += ` AND booking_code = $${bookingParams.length}`;
  }
  if (flags.airtableRecordId) {
    bookingParams.push(flags.airtableRecordId);
    bookingQuery += ` AND airtable_record_id = $${bookingParams.length}`;
  }
  bookingQuery += ' LIMIT 2';

  const { rows: bookingRows } = await client.query(bookingQuery, bookingParams);
  if (!bookingRows.length) return { error: 'booking_not_found', input: flags };
  if (bookingRows.length > 1) return { error: 'booking_ambiguous', input: flags, matches: bookingRows.length };

  const booking = bookingRows[0];
  const bookingId = booking.id;
  const bookingCode = booking.booking_code;

  const checkIn = flags.checkIn || toIsoDateString(booking.check_in);
  const checkOut = flags.checkOut || toIsoDateString(booking.check_out);

  if (!checkIn || !checkOut) {
    return { error: 'missing_assignment_dates', booking_code: bookingCode };
  }
  if (checkOut <= checkIn) {
    return { error: 'invalid_date_range', check_in: checkIn, check_out: checkOut };
  }

  const { rows: existingBedRows } = await client.query(
    `SELECT
       bb.id AS booking_bed_id,
       bb.bed_code,
       bb.room_code,
       bb.assignment_start_date::text AS assignment_start_date,
       bb.assignment_end_date::text AS assignment_end_date,
       bb.airtable_record_id
     FROM booking_beds bb
     WHERE bb.client_id = $1 AND bb.booking_id = $2
     ORDER BY bb.bed_code`,
    [clientId, bookingId]
  );

  const existingKeys = new Set(
    existingBedRows.map((row) => {
      const bedCode = String(row.bed_code || '').trim().toUpperCase();
      return assignmentNaturalKey(
        bookingCode,
        bedCode,
        toIsoDateString(row.assignment_start_date),
        toIsoDateString(row.assignment_end_date)
      );
    })
  );

  const { rows: bedInventory } = await client.query(
    `SELECT id, bed_code FROM beds WHERE client_id = $1`,
    [clientId]
  );
  const bedByCode = Object.fromEntries(
    bedInventory.map((b) => [String(b.bed_code).trim().toUpperCase(), b])
  );

  const proposed = [];
  const wouldInsert = [];
  const wouldSkip = [];
  const unknownBedCodes = [];
  const overlapConflicts = [];

  for (const bedCode of flags.bedCodes) {
    const naturalKey = assignmentNaturalKey(bookingCode, bedCode, checkIn, checkOut);
    const inv = bedByCode[bedCode];
    const entry = {
      bed_code: bedCode,
      room_code: roomCodeFromBedCode(bedCode),
      assignment_start_date: checkIn,
      assignment_end_date: checkOut,
      natural_key: naturalKey,
      bed_id: inv?.id || null,
    };
    proposed.push(entry);

    if (!inv) {
      unknownBedCodes.push(bedCode);
      continue;
    }

    if (existingKeys.has(naturalKey)) {
      wouldSkip.push({ ...entry, reason: 'natural_key_already_exists_for_booking' });
      continue;
    }

    const { rows: overlaps } = await client.query(
      `SELECT
         bb.id::text AS booking_bed_id,
         b.booking_code,
         bb.bed_code,
         bb.assignment_start_date::text AS assignment_start_date,
         bb.assignment_end_date::text AS assignment_end_date,
         b.status::text AS booking_status
       FROM booking_beds bb
       INNER JOIN bookings b ON b.id = bb.booking_id AND b.client_id = bb.client_id
       INNER JOIN beds bd ON bd.id = bb.bed_id AND bd.client_id = bb.client_id
       WHERE bb.client_id = $1
         AND bd.bed_code = $2
         AND bb.booking_id <> $3
         AND bb.assignment_start_date < $5::date
         AND bb.assignment_end_date > $4::date
         AND b.status NOT IN ('cancelled', 'expired')
       ORDER BY b.booking_code`,
      [clientId, bedCode, bookingId, checkIn, checkOut]
    );

    for (const o of overlaps) {
      overlapConflicts.push({
        proposed_bed_code: bedCode,
        proposed_dates: { start: checkIn, end: checkOut },
        conflicting_booking_code: o.booking_code,
        conflicting_booking_bed_id: o.booking_bed_id,
        conflicting_dates: {
          start: toIsoDateString(o.assignment_start_date),
          end: toIsoDateString(o.assignment_end_date),
        },
        conflicting_booking_status: o.booking_status,
      });
    }

    wouldInsert.push({
      ...entry,
      bed_id: inv.id,
      overlap_count: overlaps.length,
    });
  }

  const guestCount = Number(booking.guest_count) > 0 ? Number(booking.guest_count) : null;
  const totalAfterAssign = existingBedRows.length + wouldInsert.length;
  const guestCountMatches = guestCount == null ? null : totalAfterAssign === guestCount;

  const hasOverlaps = overlapConflicts.length > 0;
  const assignmentAfter = hasOverlaps && flags.allowConflict
    ? { assignment_status: 'needs_review', availability_check_status: 'conflict' }
    : hasOverlaps
      ? null
      : { assignment_status: 'assigned', availability_check_status: 'available' };

  return {
    clientId,
    booking,
    bookingId,
    bookingCode,
    checkIn,
    checkOut,
    existingBedRows: existingBedRows.map((row) => ({
      booking_bed_id: row.booking_bed_id,
      bed_code: String(row.bed_code || '').toUpperCase(),
      room_code: row.room_code,
      assignment_start_date: toIsoDateString(row.assignment_start_date),
      assignment_end_date: toIsoDateString(row.assignment_end_date),
      natural_key: assignmentNaturalKey(
        bookingCode,
        String(row.bed_code || '').toUpperCase(),
        toIsoDateString(row.assignment_start_date),
        toIsoDateString(row.assignment_end_date)
      ),
    })),
    proposed,
    wouldInsert,
    wouldSkip,
    unknownBedCodes,
    overlapConflicts,
    guestCount,
    guestCountMatches,
    totalAfterAssign,
    assignmentAfter,
    hasOverlaps,
  };
}

module.exports = {
  parseBedList,
  roomCodeFromBedCode,
  loadAssignPlan,
};
