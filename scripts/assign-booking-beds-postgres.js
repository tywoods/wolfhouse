/**
 * Phase 3b.2b — Assign bed rows in Postgres only (local).
 * Mirrors hosted Bed Assignment inventory effect for explicit --beds; does NOT call Airtable.
 * Does NOT touch payments, payment_status, bookings.status, or delete bookings.
 *
 * Default: dry-run. Requires --execute to mutate.
 *
 * Usage:
 *   npm run db:assign:booking-beds -- --booking-code=WH-recX --beds=R7-B1,R7-B2
 *   npm run db:assign:booking-beds -- --booking-code=WH-recX --beds=R7-B1 --execute
 */
const { withPgClient } = require('./lib/pg-connect');
const { toIsoDateString } = require('./lib/bed-drift-keys');
const { loadAssignPlan, parseBedList } = require('./lib/assign-booking-beds-plan');

const DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
const ASSIGN_NOTES = 'Assigned via assign-booking-beds-postgres.js (local 3b.2b)';

function parseArgs(argv) {
  const flags = {
    clientSlug: DEFAULT_CLIENT_SLUG,
    bookingCode: null,
    airtableRecordId: null,
    bedCodes: [],
    checkIn: null,
    checkOut: null,
    execute: false,
    assignmentType: 'Auto Assigned',
    strictGuestCount: false,
    allowConflict: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') flags.execute = true;
    else if (arg === '--dry-run') flags.execute = false;
    else if (arg === '--strict-guest-count') flags.strictGuestCount = true;
    else if (arg === '--allow-conflict') flags.allowConflict = true;
    else if (arg.startsWith('--booking-code=')) {
      flags.bookingCode = arg.slice('--booking-code='.length).trim();
    } else if (arg === '--booking-code' && argv[i + 1]) {
      flags.bookingCode = argv[++i].trim();
    } else if (arg.startsWith('--airtable-record-id=')) {
      flags.airtableRecordId = arg.slice('--airtable-record-id='.length).trim();
    } else if (arg === '--airtable-record-id' && argv[i + 1]) {
      flags.airtableRecordId = argv[++i].trim();
    } else if (arg.startsWith('--beds=')) {
      flags.bedCodes = parseBedList(arg.slice('--beds='.length));
    } else if (arg === '--beds' && argv[i + 1]) {
      flags.bedCodes = parseBedList(argv[++i]);
    } else if (arg.startsWith('--check-in=')) {
      flags.checkIn = toIsoDateString(arg.slice('--check-in='.length));
    } else if (arg === '--check-in' && argv[i + 1]) {
      flags.checkIn = toIsoDateString(argv[++i]);
    } else if (arg.startsWith('--check-out=')) {
      flags.checkOut = toIsoDateString(arg.slice('--check-out='.length));
    } else if (arg === '--check-out' && argv[i + 1]) {
      flags.checkOut = toIsoDateString(argv[++i]);
    } else if (arg.startsWith('--client=')) {
      flags.clientSlug = arg.slice('--client='.length).trim();
    } else if (arg.startsWith('--assignment-type=')) {
      flags.assignmentType = arg.slice('--assignment-type='.length).trim();
    }
  }
  return flags;
}

function usage() {
  console.error(`
Usage: npm run db:assign:booking-beds -- --booking-code=WH-rec... --beds=R7-B1,R7-B2

Options:
  --booking-code=WH-rec...       Required (unless --airtable-record-id)
  --beds=R7-B1,R7-B2             Required comma-separated bed codes
  --check-in=YYYY-MM-DD          Default: booking.check_in
  --check-out=YYYY-MM-DD         Default: booking.check_out
  --airtable-record-id=rec...    Alternative lookup
  --client=wolfhouse-somo        Default client slug
  --assignment-type=...          Default: Auto Assigned
  --dry-run                      No mutations (default when --execute omitted)
  --execute                      INSERT booking_beds + UPDATE assignment fields
  --strict-guest-count           Refuse --execute if bed count != guest_count
  --allow-conflict               On PG overlap: set needs_review/conflict instead of failing

Dry-run is the default. Pass --execute to apply changes.
Tip: npm run db:report:assign-impact -- (same flags) before first execute.
`);
}

function printBedTable(title, rows, columns) {
  console.log(`\n  ${title} (${rows.length}):\n`);
  if (!rows.length) {
    console.log('    (none)\n');
    return;
  }
  for (const row of rows) {
    const parts = columns.map((col) => {
      const v = row[col.key] ?? '';
      return String(v).padEnd(col.width);
    });
    console.log(`    ${parts.join('  ')}`);
  }
  console.log('');
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if ((!flags.bookingCode && !flags.airtableRecordId) || !flags.bedCodes.length) {
    usage();
    process.exit(1);
  }

  const mode = flags.execute ? 'EXECUTE' : 'DRY RUN';

  const result = await withPgClient(async (client) => {
    const plan = await loadAssignPlan(client, flags);
    if (plan.error) return plan;

    const { rows: paymentRows } = await client.query(
      `SELECT id FROM payments WHERE client_id = $1 AND booking_id = $2`,
      [plan.clientId, plan.bookingId]
    );

    if (plan.unknownBedCodes.length) {
      return { ...plan, error: 'unknown_bed_codes', payments_count: paymentRows.length };
    }

    if (plan.hasOverlaps && flags.execute && !flags.allowConflict) {
      return { ...plan, error: 'postgres_overlap_conflicts', payments_count: paymentRows.length };
    }

    if (
      flags.execute &&
      flags.strictGuestCount &&
      plan.guestCountMatches === false
    ) {
      return { ...plan, error: 'guest_count_mismatch', payments_count: paymentRows.length };
    }

    if (
      flags.execute &&
      ['cancelled', 'expired'].includes(plan.booking.status)
    ) {
      return { ...plan, error: 'booking_not_assignable', payments_count: paymentRows.length };
    }

    if (!flags.execute) {
      return { mode: 'dry_run', plan, payments_count: paymentRows.length };
    }

    if (!plan.assignmentAfter) {
      return { ...plan, error: 'postgres_overlap_conflicts', payments_count: paymentRows.length };
    }

    await client.query('BEGIN');
    try {
      const paymentsBefore = (
        await client.query(
          `SELECT COUNT(*)::int AS c FROM payments WHERE client_id = $1 AND booking_id = $2`,
          [plan.clientId, plan.bookingId]
        )
      ).rows[0].c;

      const paymentStatusBefore = plan.booking.payment_status;
      let insertedCount = 0;
      const insertedIds = [];

      for (const row of plan.wouldInsert) {
        const insertRes = await client.query(
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
           RETURNING id`,
          [
            plan.clientId,
            plan.bookingId,
            row.bed_id,
            row.bed_code,
            row.room_code,
            row.assignment_start_date,
            row.assignment_end_date,
            flags.assignmentType,
            ASSIGN_NOTES,
            plan.booking.guest_name,
          ]
        );
        insertedCount += 1;
        insertedIds.push(insertRes.rows[0].id);
      }

      const updateRes = await client.query(
        `UPDATE bookings
         SET assignment_status = $3::assignment_status,
             availability_check_status = $4::availability_check_status
         WHERE id = $1 AND client_id = $2`,
        [
          plan.bookingId,
          plan.clientId,
          plan.assignmentAfter.assignment_status,
          plan.assignmentAfter.availability_check_status,
        ]
      );

      const paymentsAfter = (
        await client.query(
          `SELECT COUNT(*)::int AS c FROM payments WHERE client_id = $1 AND booking_id = $2`,
          [plan.clientId, plan.bookingId]
        )
      ).rows[0].c;

      const paymentStatusAfter = (
        await client.query(
          `SELECT payment_status::text AS payment_status FROM bookings WHERE id = $1`,
          [plan.bookingId]
        )
      ).rows[0].payment_status;

      if (paymentsBefore !== paymentsAfter) {
        throw new Error('payments row count changed unexpectedly');
      }
      if (paymentStatusAfter !== paymentStatusBefore) {
        throw new Error('payment_status changed unexpectedly');
      }

      await client.query('COMMIT');

      return {
        mode: 'execute',
        plan,
        payments_count: paymentsBefore,
        inserted_count: insertedCount,
        inserted_booking_bed_ids: insertedIds,
        booking_rows_updated: updateRes.rowCount,
        idempotent: insertedCount === 0,
        payments_count_before: paymentsBefore,
        payments_count_after: paymentsAfter,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });

  if (result.error === 'booking_not_found') {
    console.error('\nPhase 3b.2b — Assign booking beds (Postgres only)\n');
    console.error('Booking not found.\n');
    process.exit(1);
  }
  if (result.error === 'booking_ambiguous') {
    console.error(`Ambiguous booking lookup (${result.matches} rows).\n`);
    process.exit(1);
  }
  if (result.error === 'client_not_found') {
    console.error(`Client not found: ${result.slug}\n`);
    process.exit(1);
  }
  if (result.error === 'missing_assignment_dates') {
    console.error('Missing check-in/check-out (pass --check-in/--check-out or set on booking).\n');
    process.exit(1);
  }
  if (result.error === 'invalid_date_range') {
    console.error(`Invalid date range: ${result.check_in} .. ${result.check_out}\n`);
    process.exit(1);
  }
  if (result.error === 'unknown_bed_codes') {
    console.error('\nPhase 3b.2b — Assign booking beds (Postgres only)\n');
    console.error(`Unknown bed code(s): ${result.unknownBedCodes.join(', ')}\n`);
    process.exit(1);
  }
  if (result.error === 'postgres_overlap_conflicts') {
    console.error('\nPhase 3b.2b — Assign booking beds (Postgres only) [EXECUTE]\n');
    console.error(
      `Postgres overlap conflict(s): ${result.overlapConflicts.length}. Use --allow-conflict to assign with needs_review/conflict.\n`
    );
    printOverlapConflicts(result.overlapConflicts);
    process.exit(1);
  }
  if (result.error === 'guest_count_mismatch') {
    console.error('\nPhase 3b.2b — Assign booking beds (Postgres only) [EXECUTE]\n');
    console.error(
      `Guest count mismatch: guest_count=${result.guestCount} total_beds_after=${result.totalAfterAssign}\n`
    );
    process.exit(1);
  }
  if (result.error === 'booking_not_assignable') {
    console.error(`Booking status "${result.booking.status}" is not assignable.\n`);
    process.exit(1);
  }

  console.log(`\nPhase 3b.2b — Assign booking beds (Postgres only) [${mode}]\n`);

  const plan = result.plan;
  const booking = plan.booking;
  const paymentsCount = result.payments_count ?? 0;

  console.log(`  Booking:     ${booking.booking_code} (${plan.bookingId})`);
  console.log(`  Status:      ${booking.status} (unchanged by this script)`);
  console.log(`  Payment:     ${booking.payment_status} (unchanged by this script)`);
  console.log(`  Payments:    ${paymentsCount} row(s) (untouched)`);
  console.log(`  Guest count: ${plan.guestCount ?? '(n/a)'}`);
  console.log(`  Dates:       ${plan.checkIn} → ${plan.checkOut}`);

  printBedTable('Existing booking_beds', plan.existingBedRows, [
    { key: 'booking_bed_id', width: 22 },
    { key: 'bed_code', width: 9 },
    { key: 'assignment_start_date', width: 11 },
    { key: 'assignment_end_date', width: 11 },
    { key: 'natural_key', width: 40 },
  ]);

  printBedTable('Proposed inserts', plan.wouldInsert, [
    { key: 'bed_code', width: 9 },
    { key: 'assignment_start_date', width: 11 },
    { key: 'assignment_end_date', width: 11 },
    { key: 'natural_key', width: 40 },
  ]);

  printBedTable('Skipped (already assigned)', plan.wouldSkip, [
    { key: 'bed_code', width: 9 },
    { key: 'natural_key', width: 40 },
    { key: 'reason', width: 36 },
  ]);

  if (plan.overlapConflicts.length) {
    printOverlapConflicts(plan.overlapConflicts);
  }

  if (plan.guestCountMatches === false) {
    console.log(
      `  Warning:     guest_count=${plan.guestCount} but total beds after assign would be ${plan.totalAfterAssign}`
    );
  }

  const after = plan.assignmentAfter;
  if (after) {
    console.log('  Would UPDATE bookings:');
    console.log(
      `    assignment_status:       ${booking.assignment_status} → ${after.assignment_status}`
    );
    console.log(
      `    availability_check_status: ${booking.availability_check_status} → ${after.availability_check_status}`
    );
  }

  if (result.mode === 'dry_run') {
    console.log('\n  No mutations (dry-run). Pass --execute to apply.');
    console.log(
      '  Tip: npm run db:report:assign-impact -- --booking-code=' + booking.booking_code
    );
    console.log(
      '\n  Note: Airtable Booking Beds unchanged until 3b.2c; expect bed-drift until AT sync.\n'
    );
    process.exit(plan.guestCountMatches === false && flags.strictGuestCount ? 1 : 0);
  }

  console.log('\n  EXECUTE applied:');
  console.log(`    inserted booking_beds: ${result.inserted_count}`);
  console.log(`    updated bookings:      ${result.booking_rows_updated} row(s)`);
  console.log(
    `    payments row count:    ${result.payments_count_before} → ${result.payments_count_after} (unchanged)`
  );
  if (result.idempotent) {
    console.log('    idempotent:            yes (0 beds inserted on this run)');
  }
  console.log(
    '\n  Airtable Booking Beds unchanged. Re-run db:report:bed-drift to compare CSV export.\n'
  );
  process.exit(0);
}

function printOverlapConflicts(conflicts) {
  console.log(`\n  Postgres overlap conflicts (${conflicts.length}):\n`);
  for (const c of conflicts) {
    console.log(
      `    ${c.proposed_bed_code} ${c.proposed_dates.start}–${c.proposed_dates.end} conflicts with ${c.conflicting_booking_code} (${c.conflicting_dates.start}–${c.conflicting_dates.end})`
    );
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
