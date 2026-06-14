/**
 * Phase 3b.4b — Postgres mutations for Manual Entry mirror (local only).
 */
const { toIsoDateString } = require('./bed-drift-keys');

const MANUAL_ENTRY_NOTES_PREFIX = 'Manual Entry ID:';
const ASSIGNMENT_TYPE_MANUAL = 'Manual Staff';
const EXECUTE_NOTES = 'Mirrored via manual-entry-postgres.js (local 3b.4b)';

async function countPayments(client, clientId, bookingId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS c FROM payments WHERE client_id = $1 AND booking_id = $2`,
    [clientId, bookingId]
  );
  return rows[0].c;
}

async function assertPaymentsTableUnchanged(client, clientId, bookingId, beforeCount) {
  const afterCount = await countPayments(client, clientId, bookingId);
  if (afterCount !== beforeCount) {
    throw new Error('payments row count changed unexpectedly');
  }
}

async function assertPaymentStatusUnchanged(client, clientId, bookingId, beforePaymentStatus) {
  const { rows } = await client.query(
    `SELECT payment_status::text AS payment_status FROM bookings WHERE id = $1 AND client_id = $2`,
    [bookingId, clientId]
  );
  if (rows[0].payment_status !== beforePaymentStatus) {
    throw new Error('payment_status changed unexpectedly');
  }
}

function staffNotesWithManualEntry(existingNotes, manualEntryId, extraNotes) {
  const parts = [];
  const base = String(existingNotes || '').trim();
  if (base) parts.push(base);
  const tag = `${MANUAL_ENTRY_NOTES_PREFIX} ${manualEntryId}`;
  if (!base.includes(manualEntryId)) parts.push(tag);
  if (extraNotes) parts.push(String(extraNotes).trim());
  return parts.filter(Boolean).join('\n') || tag;
}

async function lookupBookingForCreate(client, clientId, parsed, provisionalCode) {
  if (parsed.booking_code || parsed.airtable_record_id) {
    let q = `SELECT id, booking_code, airtable_record_id, guest_name, status::text AS status,
             payment_status::text AS payment_status, assignment_status::text AS assignment_status,
             availability_check_status::text AS availability_check_status,
             check_in::text AS check_in, check_out::text AS check_out, guest_count,
             booking_source::text AS booking_source, package_code, staff_notes, metadata
             FROM bookings WHERE client_id = $1`;
    const p = [clientId];
    if (parsed.booking_code) {
      p.push(parsed.booking_code);
      q += ` AND booking_code = $${p.length}`;
    }
    if (parsed.airtable_record_id) {
      p.push(parsed.airtable_record_id);
      q += ` AND airtable_record_id = $${p.length}`;
    }
    q += ' LIMIT 2';
    const { rows } = await client.query(q, p);
    if (rows.length > 1) return { error: 'booking_ambiguous', matches: rows.length };
    if (rows.length) return { found: true, booking: rows[0] };
  }

  const { rows: byMeta } = await client.query(
    `SELECT id, booking_code, airtable_record_id, guest_name, status::text AS status,
            payment_status::text AS payment_status, assignment_status::text AS assignment_status,
            availability_check_status::text AS availability_check_status,
            check_in::text AS check_in, check_out::text AS check_out, guest_count,
            booking_source::text AS booking_source, package_code, staff_notes, metadata
     FROM bookings
     WHERE client_id = $1 AND metadata->>'manual_entry_id' = $2
     LIMIT 2`,
    [clientId, parsed.manual_entry_id]
  );
  if (byMeta.length > 1) return { error: 'booking_ambiguous', matches: byMeta.length };
  if (byMeta.length) return { found: true, booking: byMeta[0] };

  const { rows: byCode } = await client.query(
    `SELECT id, booking_code, airtable_record_id, guest_name, status::text AS status,
            payment_status::text AS payment_status, assignment_status::text AS assignment_status,
            availability_check_status::text AS availability_check_status,
            check_in::text AS check_in, check_out::text AS check_out, guest_count,
            booking_source::text AS booking_source, package_code, staff_notes, metadata
     FROM bookings
     WHERE client_id = $1 AND booking_code = $2
     LIMIT 1`,
    [clientId, provisionalCode]
  );
  if (byCode.length) return { found: true, booking: byCode[0] };
  return { found: false, booking: null };
}

async function upsertBookingForCreate(client, clientId, parsed, provisionalCode, assignmentAfter) {
  const resolved = await lookupBookingForCreate(client, clientId, parsed, provisionalCode);
  if (resolved.error) return resolved;

  const staffNotes = staffNotesWithManualEntry(
    resolved.booking?.staff_notes,
    parsed.manual_entry_id,
    parsed.notes
  );
  const metadata = JSON.stringify({ manual_entry_id: parsed.manual_entry_id });

  if (resolved.found) {
    const b = resolved.booking;
    const paymentsBefore = await countPayments(client, clientId, b.id);
    const paymentStatusBefore = b.payment_status;

    const { rows } = await client.query(
      `UPDATE bookings SET
         guest_name = COALESCE($3, guest_name),
         check_in = COALESCE($4::date, check_in),
         check_out = COALESCE($5::date, check_out),
         guest_count = COALESCE($6, guest_count),
         status = COALESCE($7::booking_status, status),
         payment_status = COALESCE($8::payment_status, payment_status),
         package_code = COALESCE($9, package_code),
         phone = COALESCE($10, phone),
         email = COALESCE($11, email),
         staff_notes = $12,
         booking_source = 'manual_staff',
         airtable_record_id = COALESCE($13, airtable_record_id),
         assignment_status = $14::assignment_status,
         availability_check_status = $15::availability_check_status,
         metadata = COALESCE(metadata, '{}'::jsonb) || $16::jsonb
       WHERE id = $1 AND client_id = $2
       RETURNING id, booking_code, airtable_record_id, guest_name, status::text AS status,
         payment_status::text AS payment_status, assignment_status::text AS assignment_status,
         availability_check_status::text AS availability_check_status`,
      [
        b.id,
        clientId,
        parsed.guest_name,
        parsed.check_in,
        parsed.check_out,
        parsed.guest_count,
        parsed.status,
        parsed.payment_status,
        parsed.package_code,
        parsed.phone || null,
        parsed.email || null,
        staffNotes,
        parsed.airtable_record_id || null,
        assignmentAfter.assignment_status,
        assignmentAfter.availability_check_status,
        metadata,
      ]
    );

    await assertPaymentsTableUnchanged(client, clientId, b.id, paymentsBefore);

    return {
      booking_id: rows[0].id,
      booking_code: rows[0].booking_code,
      booking: rows[0],
      created: false,
      updated: true,
      payments_count: paymentsBefore,
      payment_status_before: paymentStatusBefore,
      payment_status_after: rows[0].payment_status,
    };
  }

  const bookingCode = parsed.booking_code || provisionalCode;
  const insertRes = await client.query(
    `INSERT INTO bookings (
       client_id,
       booking_code,
       airtable_record_id,
       guest_name,
       phone,
       email,
       status,
       payment_status,
       assignment_status,
       availability_check_status,
       check_in,
       check_out,
       guest_count,
       package_code,
       booking_source,
       staff_notes,
       metadata
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7::booking_status,
       $8::payment_status,
       $9::assignment_status,
       $10::availability_check_status,
       $11::date, $12::date, $13,
       $14, 'manual_staff', $15, $16::jsonb
     )
     RETURNING id, booking_code, airtable_record_id, guest_name, status::text AS status,
       payment_status::text AS payment_status, assignment_status::text AS assignment_status,
       availability_check_status::text AS availability_check_status`,
    [
      clientId,
      bookingCode,
      parsed.airtable_record_id || null,
      parsed.guest_name,
      parsed.phone || null,
      parsed.email || null,
      parsed.status,
      parsed.payment_status,
      assignmentAfter.assignment_status,
      assignmentAfter.availability_check_status,
      parsed.check_in,
      parsed.check_out,
      parsed.guest_count,
      parsed.package_code,
      staffNotes,
      metadata,
    ]
  );

  return {
    booking_id: insertRes.rows[0].id,
    booking_code: insertRes.rows[0].booking_code,
    booking: insertRes.rows[0],
    created: true,
    updated: false,
    payments_count: 0,
    payment_status_before: null,
    payment_status_after: insertRes.rows[0].payment_status,
  };
}

async function insertBookingBeds(client, clientId, bookingId, bookingCode, guestName, bedsToInsert) {
  const inserted = [];
  for (const row of bedsToInsert) {
    const res = await client.query(
      `INSERT INTO booking_beds (
         client_id,
         booking_id,
         bed_id,
         bed_code,
         room_code,
         assignment_start_date,
         assignment_end_date,
         assignment_type,
         assignment_notes,
         guest_name,
         airtable_record_id
       ) VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10, NULL)
       RETURNING id, bed_code, assignment_start_date::text AS assignment_start_date,
         assignment_end_date::text AS assignment_end_date`,
      [
        clientId,
        bookingId,
        row.bed_id,
        row.bed_code,
        row.room_code,
        row.assignment_start_date,
        row.assignment_end_date,
        ASSIGNMENT_TYPE_MANUAL,
        EXECUTE_NOTES,
        guestName,
      ]
    );
    inserted.push({
      booking_bed_id: res.rows[0].id,
      bed_code: res.rows[0].bed_code,
      assignment_start_date: toIsoDateString(res.rows[0].assignment_start_date),
      assignment_end_date: toIsoDateString(res.rows[0].assignment_end_date),
      natural_key: row.natural_key,
    });
  }
  return inserted;
}

async function updateBookingFields(client, clientId, bookingId, diff, parsed) {
  const paymentsBefore = await countPayments(client, clientId, bookingId);
  const { rows: beforeRows } = await client.query(
    `SELECT payment_status::text AS payment_status FROM bookings WHERE id = $1 AND client_id = $2`,
    [bookingId, clientId]
  );
  const paymentStatusBefore = beforeRows[0].payment_status;

  const sets = [];
  const params = [bookingId, clientId];
  const addSet = (col, val, cast) => {
    params.push(val);
    sets.push(`${col} = $${params.length}${cast || ''}`);
  };

  for (const [key, change] of Object.entries(diff)) {
    if (key === 'guest_name') addSet('guest_name', change.would_be);
    else if (key === 'check_in') addSet('check_in', change.would_be, '::date');
    else if (key === 'check_out') addSet('check_out', change.would_be, '::date');
    else if (key === 'guest_count') addSet('guest_count', change.would_be);
    else if (key === 'status') addSet('status', change.would_be, '::booking_status');
    else if (key === 'payment_status') addSet('payment_status', change.would_be, '::payment_status');
    else if (key === 'package_code') addSet('package_code', change.would_be);
  }

  if (parsed.phone) addSet('phone', parsed.phone);
  if (parsed.email) addSet('email', parsed.email);
  if (parsed.notes) {
    params.push(
      staffNotesWithManualEntry(null, parsed.manual_entry_id, parsed.notes)
    );
    sets.push(`staff_notes = COALESCE(staff_notes, '') || E'\\n' || $${params.length}`);
  }

  if (!sets.length) {
    return {
      booking_rows_updated: 0,
      fields_updated: [],
      payments_count: paymentsBefore,
      idempotent: true,
    };
  }

  const sql = `UPDATE bookings SET ${sets.join(', ')}
     WHERE id = $1 AND client_id = $2
     RETURNING id, booking_code, guest_name, status::text AS status, payment_status::text AS payment_status`;
  const { rows, rowCount } = await client.query(sql, params);

  await assertPaymentsTableUnchanged(client, clientId, bookingId, paymentsBefore);

  return {
    booking_rows_updated: rowCount,
    fields_updated: Object.keys(diff),
    booking: rows[0],
    payments_count: paymentsBefore,
    payment_status_before: paymentStatusBefore,
    payment_status_after: rows[0]?.payment_status,
    idempotent: false,
  };
}

async function deleteBedsAndCancelBooking(client, clientId, bookingId, existingBeds) {
  const paymentsBefore = await countPayments(client, clientId, bookingId);
  const { rows: beforeRows } = await client.query(
    `SELECT status::text AS status, payment_status::text AS payment_status,
            assignment_status::text AS assignment_status,
            availability_check_status::text AS availability_check_status
     FROM bookings WHERE id = $1 AND client_id = $2`,
    [bookingId, clientId]
  );
  const before = beforeRows[0];
  const paymentStatusBefore = before.payment_status;

  const deleteRes = await client.query(
    `DELETE FROM booking_beds WHERE client_id = $1 AND booking_id = $2`,
    [clientId, bookingId]
  );

  const updateRes = await client.query(
    `UPDATE bookings
     SET status = 'cancelled',
         assignment_status = 'needs_review',
         availability_check_status = 'needs_review'
     WHERE id = $1 AND client_id = $2`,
    [bookingId, clientId]
  );

  await assertPaymentsTableUnchanged(client, clientId, bookingId, paymentsBefore);
  await assertPaymentStatusUnchanged(client, clientId, bookingId, paymentStatusBefore);

  return {
    deleted_beds: deleteRes.rowCount,
    beds_deleted_detail: existingBeds,
    booking_rows_updated: updateRes.rowCount,
    status_before: before.status,
    status_after: 'cancelled',
    payment_status_before: paymentStatusBefore,
    payment_status_unchanged: true,
    payments_count: paymentsBefore,
    idempotent: deleteRes.rowCount === 0 && before.status === 'cancelled',
  };
}

module.exports = {
  ASSIGNMENT_TYPE_MANUAL,
  upsertBookingForCreate,
  insertBookingBeds,
  updateBookingFields,
  deleteBedsAndCancelBooking,
  countPayments,
  assertPaymentsTableUnchanged,
  assertPaymentStatusUnchanged,
};
