/**
 * Phase 3b.3a — Reassign impact report (read-only).
 * Simulates delete-all booking_beds + assign proposed --beds; no mutations.
 *
 * Usage:
 *   npm run db:report:reassign-impact -- --booking-code=WH-recX --beds=R7-B1,R7-B2
 */
const fs = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const { toIsoDateString } = require('./lib/bed-drift-keys');
const { loadReassignPlan, parseBedList } = require('./lib/reassign-impact-plan');
const { formatPlanningRowFromPostgres } = require('./lib/planning-row-format');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';

function parseArgs(argv) {
  const flags = {
    clientSlug: DEFAULT_CLIENT_SLUG,
    bookingCode: null,
    airtableRecordId: null,
    bedCodes: [],
    checkIn: null,
    checkOut: null,
  };
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
    }
  }
  return flags;
}

function usage() {
  console.error(`
Usage: npm run db:report:reassign-impact -- --booking-code=WH-rec... --beds=R7-B1,R7-B2 [options]

Required:
  --booking-code=WH-rec...     Booking to reassign (or --airtable-record-id)
  --beds=R7-B1,R7-B2           Proposed post-reassign bed codes

Optional:
  --check-in=YYYY-MM-DD        Assignment dates (default: booking.check_in)
  --check-out=YYYY-MM-DD
  --airtable-record-id=rec...
  --client=wolfhouse-somo

Read-only: no Postgres, Airtable, Sheets, or payment mutations.
`);
}

function buildPlanningRow(booking, row, extra = {}) {
  const formatted = formatPlanningRowFromPostgres({
    booking_code: booking.booking_code,
    airtable_record_id: booking.airtable_record_id,
    booking_source: booking.booking_source,
    guest_name: booking.guest_name,
    guest_count: booking.guest_count,
    status: booking.status,
    payment_status: booking.payment_status,
    assignment_status: extra.assignment_status || 'assigned',
    package_code: booking.package_code,
    deposit_paid_cents: null,
    requested_room_type: booking.requested_room_type,
    room_preference: booking.room_preference,
    guest_gender_group_type: booking.guest_gender_group_type,
    assignment_start_date: row.assignment_start_date,
    assignment_end_date: row.assignment_end_date,
    room_code: row.room_code,
    bed_code: row.bed_code,
    assignment_notes: null,
    planning_row_label: null,
  });
  return {
    bed_code: String(row.bed_code || '').toUpperCase(),
    assignment_start_date: toIsoDateString(row.assignment_start_date),
    assignment_end_date: toIsoDateString(row.assignment_end_date),
    display_text: formatted['Display Text'],
    color_type: formatted['Color Type'],
    ...extra,
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if ((!flags.bookingCode && !flags.airtableRecordId) || !flags.bedCodes.length) {
    usage();
    process.exit(1);
  }

  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const report = await withPgClient(async (client) => {
    const plan = await loadReassignPlan(client, flags);
    if (plan.error) return plan;

    const booking = plan.booking;
    const bookingCode = plan.bookingCode;
    const checkIn = plan.checkIn;
    const checkOut = plan.checkOut;

    const { rows: paymentRows } = await client.query(
      `SELECT id, status::text AS status, payment_kind::text AS payment_kind,
              amount_due_cents, amount_paid_cents, created_at::text AS created_at
       FROM payments WHERE client_id = $1 AND booking_id = $2 ORDER BY created_at`,
      [plan.clientId, plan.bookingId]
    );

    const { rows: paymentEventCount } = await client.query(
      `SELECT COUNT(*)::int AS c
       FROM payment_events pe
       INNER JOIN payments p ON p.id = pe.payment_id
       WHERE p.client_id = $1 AND p.booking_id = $2`,
      [plan.clientId, plan.bookingId]
    );

    const hasConflict =
      plan.unknownBedCodes.length > 0 || plan.overlapConflicts.length > 0;
    const assignStatus = hasConflict ? 'needs_review' : 'assigned';
    const availStatus = hasConflict ? 'conflict' : 'available';

    const statusAssignable = !['cancelled', 'expired'].includes(booking.status);

    const planningRowsBefore = [];
    const planningRowsAfterCancelOnly = [];
    const planningRowsAfterReassign = [];

    if (statusAssignable) {
      for (const row of plan.existingBedRowsBeforeDelete) {
        planningRowsBefore.push(
          buildPlanningRow(
            {
              booking_code: bookingCode,
              airtable_record_id: booking.airtable_record_id,
              booking_source: booking.booking_source,
              guest_name: booking.guest_name,
              guest_count: booking.guest_count,
              status: booking.status,
              payment_status: booking.payment_status,
              package_code: booking.package_code,
              requested_room_type: booking.requested_room_type,
              room_preference: booking.room_preference,
              guest_gender_group_type: booking.guest_gender_group_type,
            },
            row
          )
        );
      }

      for (const row of plan.wouldInsert) {
        planningRowsAfterReassign.push(
          buildPlanningRow(
            {
              booking_code: bookingCode,
              airtable_record_id: booking.airtable_record_id,
              booking_source: booking.booking_source,
              guest_name: booking.guest_name,
              guest_count: booking.guest_count,
              status: booking.status,
              payment_status: booking.payment_status,
              package_code: booking.package_code,
              requested_room_type: booking.requested_room_type,
              room_preference: booking.room_preference,
              guest_gender_group_type: booking.guest_gender_group_type,
            },
            row,
            { is_new_after_reassign: true }
          )
        );
      }
    }

    const removedBedCodes = plan.wouldDelete.map((r) => r.bed_code);
    const addedBedCodes = plan.wouldInsert.map((r) => r.bed_code);

    return {
      generated_at: new Date().toISOString(),
      phase: '3b.3a',
      read_only: true,
      no_mutations: true,
      no_delete: true,
      no_insert: true,
      no_update: true,
      input: {
        booking_code: flags.bookingCode || bookingCode,
        airtable_record_id: flags.airtableRecordId || booking.airtable_record_id,
        client_slug: flags.clientSlug,
        beds: flags.bedCodes,
        check_in: checkIn,
        check_out: checkOut,
        dates_from_booking: !flags.checkIn || !flags.checkOut,
      },
      postgres_booking: {
        id: plan.bookingId,
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
      },
      summary: {
        existing_booking_beds_count: plan.existingBedRowsBeforeDelete.length,
        would_delete_count: plan.wouldDeleteCount,
        proposed_bed_count: plan.proposed.length,
        would_insert_count: plan.wouldInsert.length,
        would_skip_count: plan.wouldSkip.length,
        unknown_bed_codes_count: plan.unknownBedCodes.length,
        postgres_overlap_conflicts_count: plan.overlapConflicts.length,
        guest_count: plan.guestCount,
        guest_count_matches_after_reassign: plan.guestCountMatches,
        payments_rows: paymentRows.length,
        payment_events_rows: paymentEventCount[0].c,
        planning_rows_before_count: planningRowsBefore.length,
        planning_rows_after_cancel_count: planningRowsAfterCancelOnly.length,
        planning_rows_after_reassign_count: planningRowsAfterReassign.length,
      },
      reset_phase: {
        note: 'All current booking_beds for this booking would be removed (reassign reset).',
        postgres_booking_beds_existing: plan.existingBedRowsBeforeDelete,
        postgres_booking_beds_would_delete: plan.wouldDelete,
        booking_fields_after_cancel_phase: {
          assignment_status: { would_be: 'unassigned', maps_airtable: 'Unassigned' },
          availability_check_status: {
            would_be: 'not_checked',
            maps_airtable: 'Not Checked',
          },
          status: { current: booking.status, would_change: false },
          payment_status: { current: booking.payment_status, would_change: false },
        },
      },
      assign_phase: {
        note: 'Proposed beds after reset; overlaps exclude this booking’s current rows.',
        proposed_beds: plan.proposed,
        postgres_booking_beds_would_insert: plan.wouldInsert,
        postgres_booking_beds_would_skip: plan.wouldSkip,
        unknown_bed_codes: plan.unknownBedCodes,
        postgres_overlap_conflicts: plan.overlapConflicts,
        booking_fields_after_full_reassign: {
          assignment_status: {
            current: booking.assignment_status,
            would_be: assignStatus,
            maps_airtable: hasConflict ? 'Needs Review' : 'Assigned',
          },
          availability_check_status: {
            current: booking.availability_check_status,
            would_be: availStatus,
            maps_airtable: hasConflict ? 'Conflict' : 'Available',
          },
          status: { current: booking.status, would_change: false },
          payment_status: { current: booking.payment_status, would_change: false },
        },
      },
      guest_count_check: {
        guest_count: plan.guestCount,
        beds_before_delete: plan.existingBedRowsBeforeDelete.length,
        proposed_beds: plan.proposed.length,
        would_insert: plan.wouldInsert.length,
        total_after_reassign: plan.wouldInsert.length,
        matches: plan.guestCountMatches,
        note:
          plan.guestCount == null
            ? 'guest_count missing or zero — comparison skipped'
            : plan.guestCountMatches
              ? 'Proposed bed count matches guest_count after full reassign'
              : 'Proposed bed count differs from guest_count',
      },
      payments_untouched: {
        policy:
          'No INSERT/UPDATE/DELETE on payments, payment_events, or payment_status in reassign impact path',
        payments_count: paymentRows.length,
        payment_events_count: paymentEventCount[0].c,
        payment_status_would_change: false,
        payments: paymentRows,
      },
      planning_report_impact: {
        rows_before: planningRowsBefore,
        rows_after_cancel_only: planningRowsAfterCancelOnly,
        rows_after_reassign: planningRowsAfterReassign,
        planning_delta: {
          removed_count: planningRowsBefore.length,
          added_count: planningRowsAfterReassign.length,
          bed_codes_removed: removedBedCodes,
          bed_codes_added: addedBedCodes,
        },
      },
      warnings: [],
      actionable: [],
    };
  });

  if (report.error === 'booking_not_found') {
    console.error(
      `\nReassign impact: booking not found (${flags.bookingCode || flags.airtableRecordId})\n`
    );
    process.exit(1);
  }
  if (report.error === 'booking_ambiguous') {
    console.error(`\nReassign impact: ambiguous booking lookup (${report.matches} rows)\n`);
    process.exit(1);
  }
  if (report.error === 'missing_assignment_dates') {
    console.error(
      `\nReassign impact: need --check-in/--check-out or booking dates on ${report.booking_code}\n`
    );
    process.exit(1);
  }
  if (report.error === 'invalid_date_range') {
    console.error(`\nReassign impact: invalid date range ${report.check_in} .. ${report.check_out}\n`);
    process.exit(1);
  }
  if (report.error === 'client_not_found') {
    console.error(`\nReassign impact: client not found: ${report.slug}\n`);
    process.exit(1);
  }

  if (report.assign_phase?.unknown_bed_codes?.length) {
    report.warnings.push(
      `unknown_bed_codes: ${report.assign_phase.unknown_bed_codes.join(', ')}`
    );
    report.actionable.push('unknown_bed_codes');
  }
  if (report.assign_phase?.postgres_overlap_conflicts?.length) {
    report.warnings.push(
      `postgres_overlap_conflicts: ${report.assign_phase.postgres_overlap_conflicts.length} conflict(s)`
    );
    report.actionable.push('postgres_overlap_conflicts');
  }
  if (report.guest_count_check?.matches === false) {
    report.warnings.push(
      `guest_count_mismatch: guest_count=${report.guest_count_check.guest_count} total_after_reassign=${report.guest_count_check.total_after_reassign}`
    );
    report.actionable.push('guest_count_mismatch');
  }
  if (report.summary.would_delete_count === 0) {
    report.warnings.push('no_existing_booking_beds: reset phase would delete 0 PG rows');
  }
  if (report.summary.would_skip_count > 0) {
    report.warnings.push(
      'unexpected_would_skip: assign phase should not skip when existing beds are cleared in simulation'
    );
  }
  if (['cancelled', 'expired'].includes(report.postgres_booking.status)) {
    report.warnings.push(`booking_status_${report.postgres_booking.status}: reassign may be skipped`);
  }

  const stamp = report.generated_at.replace(/[:.]/g, '-').slice(0, 19);
  const safeCode = (report.postgres_booking.booking_code || 'unknown').replace(/[^\w-]/g, '_');
  const outPath = path.join(REPORTS_DIR, `reassign-impact-${safeCode}-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  const s = report.summary;
  console.log('\nPhase 3b.3a — Reassign impact report (read-only)\n');
  console.log(`  Booking:           ${report.postgres_booking.booking_code}`);
  console.log(`  Status:            ${report.postgres_booking.status}`);
  console.log(`  Guest count:       ${s.guest_count ?? '(n/a)'}`);
  console.log(`  Would delete (PG): ${s.would_delete_count}`);
  console.log(`  Would insert (PG): ${s.would_insert_count}`);
  console.log(`  PG overlaps:       ${s.postgres_overlap_conflicts_count}`);
  console.log(`  Payments:          ${s.payments_rows} rows (untouched)`);
  console.log(`  Planning before:   ${s.planning_rows_before_count}`);
  console.log(`  Planning after:    ${s.planning_rows_after_reassign_count}`);
  if (report.warnings.length) {
    console.log('\n  Warnings:');
    for (const w of report.warnings) console.log(`    - ${w}`);
  }
  console.log(`\nWrote ${outPath}`);
  console.log('No Postgres, Airtable, Sheets, or payment mutations.\n');

  if (report.actionable.length) {
    console.log(`Reassign impact: actionable: ${report.actionable.join(', ')}. Exit 2.\n`);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
