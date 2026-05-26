/**
 * Phase 3b.1a — Cancel impact report (read-only).
 * Shows what WOULD happen if cancel-bed logic ran; performs no DELETE/UPDATE.
 *
 * Usage:
 *   npm run db:report:cancel-impact -- --booking-code=WH-rechKjCcySkfLzxUD
 *   npm run db:report:cancel-impact -- --booking-code=WH-recX --client=wolfhouse-somo
 */
const fs = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const {
  assignmentNaturalKey,
  toIsoDateString,
  loadCsvBedAssignments,
  loadCsvBookingCodes,
} = require('./lib/bed-drift-keys');
const { formatPlanningRowFromPostgres } = require('./lib/planning-row-format');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';

function parseArgs(argv) {
  const flags = { clientSlug: DEFAULT_CLIENT_SLUG, bookingCode: null, airtableRecordId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--booking-code=')) {
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
Usage: npm run db:report:cancel-impact -- --booking-code=WH-rec...

Options:
  --booking-code=WH-rec...     Required (unless --airtable-record-id)
  --airtable-record-id=rec...  Alternative lookup
  --client=wolfhouse-somo      Default client slug
`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags.bookingCode && !flags.airtableRecordId) {
    usage();
    process.exit(1);
  }

  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const csvBedsAll = loadCsvBedAssignments();
  const csvBookings = loadCsvBookingCodes();
  const csvBedsForBooking = flags.bookingCode
    ? csvBedsAll.filter((r) => r.booking_code === flags.bookingCode)
    : [];

  const report = await withPgClient(async (client) => {
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
      bookingQuery += flags.bookingCode
        ? ` AND airtable_record_id = $${bookingParams.length}`
        : ` AND airtable_record_id = $${bookingParams.length}`;
    }
    bookingQuery += ' LIMIT 2';

    const { rows: bookingRows } = await client.query(bookingQuery, bookingParams);
    if (!bookingRows.length) {
      return { error: 'booking_not_found', input: flags };
    }
    if (bookingRows.length > 1) {
      return { error: 'booking_ambiguous', input: flags, matches: bookingRows.length };
    }

    const booking = bookingRows[0];
    const bookingId = booking.id;
    const bookingCode = booking.booking_code;

    const { rows: bedRows } = await client.query(
      `SELECT
         bb.id AS booking_bed_id,
         bb.airtable_record_id,
         bb.bed_code,
         bb.room_code,
         bb.assignment_start_date::text AS assignment_start_date,
         bb.assignment_end_date::text AS assignment_end_date,
         bb.assignment_label,
         bb.planning_row_label,
         bb.assignment_type,
         bb.created_at::text AS created_at
       FROM booking_beds bb
       WHERE bb.client_id = $1 AND bb.booking_id = $2
       ORDER BY bb.bed_code, bb.assignment_start_date`,
      [clientId, bookingId]
    );

    const postgresBedsToRemove = bedRows.map((row) => {
      const startIso = toIsoDateString(row.assignment_start_date);
      const endIso = toIsoDateString(row.assignment_end_date);
      const bedCode = String(row.bed_code || '').trim().toUpperCase();
      return {
        booking_bed_id: row.booking_bed_id,
        airtable_record_id: row.airtable_record_id,
        bed_code: bedCode,
        room_code: row.room_code,
        assignment_start_date: startIso,
        assignment_end_date: endIso,
        natural_key: assignmentNaturalKey(bookingCode, bedCode, startIso, endIso),
        assignment_label: row.assignment_label,
        planning_row_label: row.planning_row_label,
        assignment_type: row.assignment_type,
      };
    });

    const { rows: paymentRows } = await client.query(
      `SELECT id, status::text AS status, payment_kind::text AS payment_kind,
              amount_due_cents, amount_paid_cents, stripe_checkout_session_id, created_at::text AS created_at
       FROM payments WHERE client_id = $1 AND booking_id = $2 ORDER BY created_at`,
      [clientId, bookingId]
    );

    const { rows: paymentEventCount } = await client.query(
      `SELECT COUNT(*)::int AS c
       FROM payment_events pe
       INNER JOIN payments p ON p.id = pe.payment_id
       WHERE p.client_id = $1 AND p.booking_id = $2`,
      [clientId, bookingId]
    );

    const csvBeds = csvBedsAll.filter((r) => r.booking_code === bookingCode);
    const csvBedKeys = new Set(csvBeds.map((r) => r.natural_key));
    const pgBedKeys = new Set(postgresBedsToRemove.map((r) => r.natural_key));

    const keysOnlyInCsv = csvBeds
      .filter((r) => !pgBedKeys.has(r.natural_key))
      .map((r) => r.natural_key);
    const keysOnlyInPostgres = postgresBedsToRemove
      .filter((r) => !csvBedKeys.has(r.natural_key))
      .map((r) => r.natural_key);

    const planningRowsNow = [];
    const statusNotCancelled = !['cancelled', 'expired'].includes(booking.status);
    if (statusNotCancelled) {
      for (const row of bedRows) {
        if (!row.bed_code || !row.assignment_start_date || !row.assignment_end_date) continue;
        const formatted = formatPlanningRowFromPostgres({
          booking_code: bookingCode,
          airtable_record_id: booking.airtable_record_id,
          booking_source: booking.booking_source,
          guest_name: booking.guest_name,
          guest_count: booking.guest_count,
          status: booking.status,
          payment_status: booking.payment_status,
          assignment_status: booking.assignment_status,
          package_code: null,
          deposit_paid_cents: null,
          requested_room_type: null,
          room_preference: null,
          guest_gender_group_type: null,
          assignment_start_date: row.assignment_start_date,
          assignment_end_date: row.assignment_end_date,
          room_code: row.room_code,
          bed_code: row.bed_code,
          assignment_notes: null,
          planning_row_label: row.planning_row_label,
        });
        planningRowsNow.push({
          bed_code: row.bed_code,
          assignment_start_date: toIsoDateString(row.assignment_start_date),
          assignment_end_date: toIsoDateString(row.assignment_end_date),
          display_text: formatted['Display Text'],
          color_type: formatted['Color Type'],
        });
      }
    }

    const csvBooking = csvBookings.get(bookingCode);
    const inCsvExport = Boolean(csvBooking);

    return {
      generated_at: new Date().toISOString(),
      phase: '3b.1a',
      read_only: true,
      no_mutations: true,
      no_delete: true,
      no_update: true,
      input: {
        booking_code: flags.bookingCode || bookingCode,
        airtable_record_id: flags.airtableRecordId || booking.airtable_record_id,
        client_slug: flags.clientSlug,
      },
      postgres_booking: {
        id: bookingId,
        booking_code: bookingCode,
        airtable_record_id: booking.airtable_record_id,
        guest_name: booking.guest_name,
        status: booking.status,
        payment_status: booking.payment_status,
        assignment_status: booking.assignment_status,
        availability_check_status: booking.availability_check_status,
        check_in: booking.check_in,
        check_out: booking.check_out,
        guest_count: booking.guest_count,
        booking_source: booking.booking_source,
        in_csv_export: inCsvExport,
      },
      summary: {
        booking_beds_would_remove_count: postgresBedsToRemove.length,
        payments_rows: paymentRows.length,
        payment_events_rows: paymentEventCount[0].c,
        planning_rows_would_disappear_count: planningRowsNow.length,
        beds_released_for_availability: postgresBedsToRemove.map((r) => ({
          bed_code: r.bed_code,
          assignment_start_date: r.assignment_start_date,
          assignment_end_date: r.assignment_end_date,
        })),
      },
      postgres_booking_beds_would_remove: postgresBedsToRemove,
      booking_fields_would_update_if_cancel_beds_ran: {
        note:
          'Hosted Cancel Bed Assignments workflow does not set Status to Cancelled; that happens before the webhook.',
        status: {
          current: booking.status,
          would_change_in_cancel_bed_workflow: false,
          would_be_after_full_cancel_flow:
            booking.status === 'cancelled' ? booking.status : 'cancelled (set by staff/automation before webhook)',
        },
        payment_status: {
          current: booking.payment_status,
          would_change: false,
        },
        assignment_status: {
          current: booking.assignment_status,
          would_be: 'needs_review',
          maps_airtable: 'Needs Review',
        },
        availability_check_status: {
          current: booking.availability_check_status,
          would_be: 'needs_review',
          maps_airtable: 'Needs Review',
        },
      },
      payments_untouched: {
        policy: 'No DELETE or UPDATE on payments or payment_events in cancel-bed path',
        payments_count: paymentRows.length,
        payment_events_count: paymentEventCount[0].c,
        payments: paymentRows,
      },
      planning_report_impact: {
        note:
          'After beds removed and booking status is cancelled/expired, planning:report:postgres excludes these rows (same filters as 3a).',
        rows_in_current_planning_report: planningRowsNow,
        row_count_would_disappear: planningRowsNow.length,
        excluded_when_status_cancelled_or_expired: true,
      },
      bed_drift_impact: {
        note: 'Expected after PG cancel (3b.1b+): PG bed count 0; re-run db:report:bed-drift to verify.',
        before_cancel: {
          postgres_bed_rows: postgresBedsToRemove.length,
          csv_export_bed_rows: csvBeds.length,
          in_csv_export: inCsvExport,
          keys_only_in_csv: keysOnlyInCsv,
          keys_only_in_postgres: keysOnlyInPostgres,
          per_booking_count_delta_if_pg_cleared: 0 - postgresBedsToRemove.length,
        },
        after_cancel_expected: {
          postgres_bed_rows: 0,
          actionable_bed_drift_for_this_booking: inCsvExport ? csvBeds.length > 0 : false,
        },
        overlap_availability_note:
          postgresBedsToRemove.length > 0
            ? `Removing ${postgresBedsToRemove.length} assignment(s) would free bed(s) for overlap checks in db:report:bed-drift.`
            : 'No PG bed rows to release.',
      },
      warnings: [],
    };
  });

  if (report.error === 'booking_not_found') {
    console.error(`\nCancel impact: booking not found (${flags.bookingCode || flags.airtableRecordId})\n`);
    process.exit(1);
  }
  if (report.error === 'booking_ambiguous') {
    console.error(`\nCancel impact: ambiguous booking lookup (${report.matches} rows)\n`);
    process.exit(1);
  }

  if (report.postgres_booking.status !== 'cancelled' && report.postgres_booking.status !== 'expired') {
    report.warnings.push(
      'booking_status_not_cancelled: cancel-bed webhook normally runs after Status=Cancelled in Airtable.'
    );
  }
  if (report.summary.booking_beds_would_remove_count === 0) {
    report.warnings.push('no_postgres_booking_beds: cancel-bed workflow would be a no-op for PG deletes.');
  }

  const stamp = report.generated_at.replace(/[:.]/g, '-').slice(0, 19);
  const safeCode = (report.postgres_booking.booking_code || 'unknown').replace(/[^\w-]/g, '_');
  const outPath = path.join(REPORTS_DIR, `cancel-impact-${safeCode}-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  const s = report.summary;
  console.log('\nPhase 3b.1a — Cancel impact report (read-only)\n');
  console.log(`  Booking:     ${report.postgres_booking.booking_code}`);
  console.log(`  Status:      ${report.postgres_booking.status}`);
  console.log(`  Beds to remove (PG): ${s.booking_beds_would_remove_count}`);
  console.log(`  Payments:    ${s.payments_rows} rows (untouched)`);
  console.log(`  Planning rows would disappear: ${s.planning_rows_would_disappear_count}`);
  if (report.warnings.length) {
    console.log('\n  Warnings:');
    for (const w of report.warnings) console.log(`    - ${w}`);
  }
  console.log(`\nWrote ${outPath}`);
  console.log('No Postgres, Airtable, Sheets, or payment mutations.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
