/**
 * Phase 3b.1b — Cancel bed assignments in Postgres only (local).
 * Mirrors hosted Cancel Bed Assignments inventory effect; does NOT call Airtable.
 * Does NOT touch payments, payment_status, bookings.status, or delete bookings.
 *
 * Default: dry-run. Requires --execute to mutate.
 *
 * Usage:
 *   npm run db:cancel:booking-beds -- --booking-code=WH-rechKjCcySkfLzxUD
 *   npm run db:cancel:booking-beds -- --booking-code=WH-recX --execute
 */
const { withPgClient } = require('./lib/pg-connect');
const { assignmentNaturalKey, toIsoDateString } = require('./lib/bed-drift-keys');

const DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';

function parseArgs(argv) {
  const flags = {
    clientSlug: DEFAULT_CLIENT_SLUG,
    bookingCode: null,
    airtableRecordId: null,
    execute: false,
    dryRun: false,
    requireStatusCancelled: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') flags.execute = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--require-status-cancelled') flags.requireStatusCancelled = true;
    else if (arg.startsWith('--booking-code=')) {
      flags.bookingCode = arg.slice('--booking-code='.length).trim();
    } else if (arg === '--booking-code' && argv[i + 1]) {
      flags.bookingCode = argv[++i].trim();
    } else if (arg.startsWith('--airtable-record-id=')) {
      flags.airtableRecordId = arg.slice('--airtable-record-id='.length).trim();
    } else if (arg === '--airtable-record-id' && argv[i + 1]) {
      flags.airtableRecordId = argv[++i].trim();
    } else if (arg.startsWith('--client=')) {
      flags.clientSlug = arg.slice('--client='.length).trim();
    }
  }
  return flags;
}

function usage() {
  console.error(`
Usage: npm run db:cancel:booking-beds -- --booking-code=WH-rec...

Options:
  --booking-code=WH-rec...       Required (unless --airtable-record-id)
  --airtable-record-id=rec...    Alternative lookup
  --client=wolfhouse-somo        Default client slug
  --dry-run                      No mutations (default when --execute omitted)
  --execute                      DELETE booking_beds + UPDATE assignment fields
  --require-status-cancelled     Refuse --execute unless status is cancelled/expired

Dry-run is the default. Pass --execute to apply changes.
`);
}

function printBedRows(beds) {
  if (!beds.length) {
    console.log('  (no booking_beds rows for this booking)\n');
    return;
  }
  console.log('  booking_bed_id          bed_code   start        end          natural_key');
  console.log('  ----------------------  ---------  -----------  -----------  ------------------------------');
  for (const bed of beds) {
    const id = String(bed.booking_bed_id).padEnd(22);
    const code = String(bed.bed_code).padEnd(9);
    const start = String(bed.assignment_start_date).padEnd(11);
    const end = String(bed.assignment_end_date).padEnd(11);
    console.log(`  ${id}  ${code}  ${start}  ${end}  ${bed.natural_key}`);
  }
  console.log('');
}

async function loadBookingAndBeds(client, flags) {
  const { rows: clientRows } = await client.query(`SELECT id FROM clients WHERE slug = $1`, [
    flags.clientSlug,
  ]);
  if (!clientRows.length) throw new Error(`Client not found: ${flags.clientSlug}`);
  const clientId = clientRows[0].id;

  let bookingQuery = `SELECT
       id,
       booking_code,
       airtable_record_id,
       guest_name,
       status::text AS status,
       payment_status::text AS payment_status,
       assignment_status::text AS assignment_status,
       availability_check_status::text AS availability_check_status
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
  if (!bookingRows.length) {
    return { error: 'booking_not_found' };
  }
  if (bookingRows.length > 1) {
    return { error: 'booking_ambiguous', count: bookingRows.length };
  }

  const booking = bookingRows[0];
  const { rows: bedRows } = await client.query(
    `SELECT
       bb.id AS booking_bed_id,
       bb.bed_code,
       bb.room_code,
       bb.assignment_start_date::text AS assignment_start_date,
       bb.assignment_end_date::text AS assignment_end_date
     FROM booking_beds bb
     WHERE bb.client_id = $1 AND bb.booking_id = $2
     ORDER BY bb.bed_code, bb.assignment_start_date`,
    [clientId, booking.id]
  );

  const beds = bedRows.map((row) => {
    const startIso = toIsoDateString(row.assignment_start_date);
    const endIso = toIsoDateString(row.assignment_end_date);
    const bedCode = String(row.bed_code || '').trim().toUpperCase();
    return {
      booking_bed_id: row.booking_bed_id,
      bed_code: bedCode,
      room_code: row.room_code,
      assignment_start_date: startIso,
      assignment_end_date: endIso,
      natural_key: assignmentNaturalKey(booking.booking_code, bedCode, startIso, endIso),
    };
  });

  const { rows: paymentCountRows } = await client.query(
    `SELECT COUNT(*)::int AS c FROM payments WHERE client_id = $1 AND booking_id = $2`,
    [clientId, booking.id]
  );

  return {
    clientId,
    booking,
    beds,
    payments_count: paymentCountRows[0].c,
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags.bookingCode && !flags.airtableRecordId) {
    usage();
    process.exit(1);
  }

  const mode = flags.execute ? 'EXECUTE' : 'DRY RUN';

  const result = await withPgClient(async (client) => {
    const loaded = await loadBookingAndBeds(client, flags);
    if (loaded.error === 'booking_not_found') return loaded;
    if (loaded.error === 'booking_ambiguous') return loaded;

    const { clientId, booking, beds, payments_count } = loaded;

    if (
      flags.execute &&
      flags.requireStatusCancelled &&
      !['cancelled', 'expired'].includes(booking.status)
    ) {
      return {
        error: 'status_not_cancelled',
        booking,
        beds,
        payments_count,
      };
    }

    const paidLike =
      booking.payment_status === 'deposit_paid' || booking.payment_status === 'paid';

    const plan = {
      booking_code: booking.booking_code,
      booking_id: booking.id,
      status: booking.status,
      payment_status: booking.payment_status,
      assignment_status_before: booking.assignment_status,
      availability_check_status_before: booking.availability_check_status,
      assignment_status_after: 'needs_review',
      availability_check_status_after: 'needs_review',
      booking_beds_to_delete: beds.length,
      payments_count,
      paid_like_warning: paidLike,
    };

    if (!flags.execute) {
      return { mode: 'dry_run', plan, beds, booking, payments_count };
    }

    await client.query('BEGIN');
    try {
      const paymentsBefore = (
        await client.query(
          `SELECT COUNT(*)::int AS c FROM payments WHERE client_id = $1 AND booking_id = $2`,
          [clientId, booking.id]
        )
      ).rows[0].c;

      const deleteRes = await client.query(
        `DELETE FROM booking_beds
         WHERE client_id = $1 AND booking_id = $2`,
        [clientId, booking.id]
      );

      const updateRes = await client.query(
        `UPDATE bookings
         SET assignment_status = 'needs_review',
             availability_check_status = 'needs_review'
         WHERE id = $1 AND client_id = $2`,
        [booking.id, clientId]
      );

      const paymentsAfter = (
        await client.query(
          `SELECT COUNT(*)::int AS c FROM payments WHERE client_id = $1 AND booking_id = $2`,
          [clientId, booking.id]
        )
      ).rows[0].c;

      const paymentStatusAfter = (
        await client.query(
          `SELECT payment_status::text AS payment_status FROM bookings WHERE id = $1`,
          [booking.id]
        )
      ).rows[0].payment_status;

      if (paymentsBefore !== paymentsAfter) {
        throw new Error('payments row count changed unexpectedly');
      }
      if (paymentStatusAfter !== booking.payment_status) {
        throw new Error('payment_status changed unexpectedly');
      }

      await client.query('COMMIT');

      return {
        mode: 'execute',
        plan,
        beds,
        booking,
        deleted_beds: deleteRes.rowCount,
        booking_rows_updated: updateRes.rowCount,
        payments_count_before: paymentsBefore,
        payments_count_after: paymentsAfter,
        idempotent: deleteRes.rowCount === 0,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });

  console.log(`\nPhase 3b.1b — Cancel booking beds (Postgres only) [${mode}]\n`);

  if (result.error === 'booking_not_found') {
    console.error('Booking not found.\n');
    process.exit(1);
  }
  if (result.error === 'booking_ambiguous') {
    console.error(`Ambiguous booking lookup (${result.count} rows).\n`);
    process.exit(1);
  }
  if (result.error === 'status_not_cancelled') {
    console.error(
      `Refused: booking status is "${result.booking.status}" (use --require-status-cancelled only when cancelled/expired).\n`
    );
    process.exit(1);
  }

  const { booking, beds, plan } = result;

  console.log(`  Booking:     ${booking.booking_code} (${booking.id})`);
  console.log(`  Status:      ${booking.status} (unchanged by this script)`);
  console.log(`  Payment:     ${booking.payment_status} (unchanged by this script)`);
  console.log(`  Payments:    ${result.payments_count ?? plan.payments_count} row(s) (untouched)`);
  if (plan.paid_like_warning) {
    console.log('  Warning:     payment_status is deposit_paid or paid — beds still released in PG only.');
  }

  console.log(`\n  booking_beds that would be / were deleted (${beds.length}):\n`);
  printBedRows(beds);

  if (result.mode === 'dry_run') {
    console.log('  Would UPDATE bookings:');
    console.log(`    assignment_status:       ${plan.assignment_status_before} → needs_review`);
    console.log(
      `    availability_check_status: ${plan.availability_check_status_before} → needs_review`
    );
    console.log('\n  No mutations (dry-run). Pass --execute to apply.');
    console.log(
      '  Tip: npm run db:report:cancel-impact -- --booking-code=' + booking.booking_code
    );
    console.log(
      '\n  Note: Airtable Booking Beds are unchanged until 3b.1c; expect bed-drift if CSV export still has beds.\n'
    );
    process.exit(0);
  }

  console.log('  EXECUTE applied:');
  console.log(`    deleted booking_beds:  ${result.deleted_beds}`);
  console.log(`    updated bookings:      ${result.booking_rows_updated} row(s)`);
  console.log(
    `    payments row count:    ${result.payments_count_before} → ${result.payments_count_after} (unchanged)`
  );
  if (result.idempotent) {
    console.log('    idempotent:            yes (0 beds deleted on this run)');
  }
  console.log(
    '\n  Airtable Booking Beds unchanged. Re-run db:report:bed-drift to compare CSV export.\n'
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
