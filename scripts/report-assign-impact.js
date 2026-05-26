/**
 * Phase 3b.2a — Assign impact report (read-only).
 * Shows what WOULD happen if proposed beds were assigned; no INSERT/UPDATE.
 *
 * Usage:
 *   npm run db:report:assign-impact -- --booking-code=WH-recX --beds=R7-B1,R7-B2 --check-in=2026-08-07 --check-out=2026-08-12
 */
const fs = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const { assignmentNaturalKey, toIsoDateString } = require('./lib/bed-drift-keys');
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

function parseBedList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function usage() {
  console.error(`
Usage: npm run db:report:assign-impact -- --booking-code=WH-rec... --beds=R7-B1,R7-B2 [options]

Required:
  --booking-code=WH-rec...     Booking to assign (or --airtable-record-id)
  --beds=R7-B1,R7-B2           Comma-separated bed codes to simulate

Optional:
  --check-in=YYYY-MM-DD        Assignment start (default: booking.check_in)
  --check-out=YYYY-MM-DD       Assignment end (default: booking.check_out)
  --airtable-record-id=rec...  Alternative booking lookup
  --client=wolfhouse-somo      Default client slug

Read-only: no Postgres, Airtable, Sheets, or payment mutations.
`);
}

function roomCodeFromBedCode(bedCode) {
  const m = String(bedCode || '').match(/^(R\d+)-/i);
  return m ? m[1].toUpperCase() : null;
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
         booking_source::text AS booking_source,
         package_code,
         requested_room_type,
         room_preference,
         guest_gender_group_type::text AS guest_gender_group_type
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
      return { error: 'booking_not_found', input: flags };
    }
    if (bookingRows.length > 1) {
      return { error: 'booking_ambiguous', input: flags, matches: bookingRows.length };
    }

    const booking = bookingRows[0];
    const bookingId = booking.id;
    const bookingCode = booking.booking_code;

    const checkIn = flags.checkIn || toIsoDateString(booking.check_in);
    const checkOut = flags.checkOut || toIsoDateString(booking.check_out);

    if (!checkIn || !checkOut) {
      return { error: 'missing_assignment_dates', input: flags, booking_code: bookingCode };
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
        const startIso = toIsoDateString(row.assignment_start_date);
        const endIso = toIsoDateString(row.assignment_end_date);
        return assignmentNaturalKey(bookingCode, bedCode, startIso, endIso);
      })
    );

    const { rows: bedInventory } = await client.query(
      `SELECT id, bed_code, room_id FROM beds WHERE client_id = $1`,
      [clientId]
    );
    const bedByCode = Object.fromEntries(
      bedInventory.map((b) => [String(b.bed_code).trim().toUpperCase(), b])
    );

    const proposed = [];
    const wouldInsert = [];
    const wouldSkip = [];
    const unknownBeds = [];
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
        unknownBeds.push(bedCode);
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
           b.id::text AS other_booking_id,
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
        room_id: inv.room_id,
        would_overlap_other_booking: overlaps.length > 0,
        overlap_count: overlaps.length,
      });
    }

    const { rows: paymentRows } = await client.query(
      `SELECT id, status::text AS status, payment_kind::text AS payment_kind,
              amount_due_cents, amount_paid_cents, created_at::text AS created_at
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

    const guestCount = Number(booking.guest_count) > 0 ? Number(booking.guest_count) : null;
    const proposedBedCount = proposed.length;
    const newInsertCount = wouldInsert.length;
    const guestCountMatches =
      guestCount == null ? null : newInsertCount + existingBedRows.length === guestCount;

    const planningRowsAfter = [];
    const statusAssignable = !['cancelled', 'expired'].includes(booking.status);
    if (statusAssignable) {
      const allBedsAfter = [
        ...existingBedRows.map((row) => ({
          bed_code: row.bed_code,
          room_code: row.room_code,
          assignment_start_date: row.assignment_start_date,
          assignment_end_date: row.assignment_end_date,
        })),
        ...wouldInsert.map((row) => ({
          bed_code: row.bed_code,
          room_code: row.room_code,
          assignment_start_date: row.assignment_start_date,
          assignment_end_date: row.assignment_end_date,
        })),
      ];

      for (const row of allBedsAfter) {
        if (!row.bed_code || !row.assignment_start_date || !row.assignment_end_date) continue;
        const formatted = formatPlanningRowFromPostgres({
          booking_code: bookingCode,
          airtable_record_id: booking.airtable_record_id,
          booking_source: booking.booking_source,
          guest_name: booking.guest_name,
          guest_count: booking.guest_count,
          status: booking.status,
          payment_status: booking.payment_status,
          assignment_status: 'assigned',
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
        planningRowsAfter.push({
          bed_code: String(row.bed_code).toUpperCase(),
          assignment_start_date: toIsoDateString(row.assignment_start_date),
          assignment_end_date: toIsoDateString(row.assignment_end_date),
          is_new_if_assign_ran: wouldInsert.some(
            (w) =>
              w.bed_code === String(row.bed_code).toUpperCase() &&
              w.assignment_start_date === toIsoDateString(row.assignment_start_date)
          ),
          display_text: formatted['Display Text'],
          color_type: formatted['Color Type'],
        });
      }
    }

    return {
      generated_at: new Date().toISOString(),
      phase: '3b.2a',
      read_only: true,
      no_mutations: true,
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
      },
      summary: {
        existing_booking_beds_count: existingBedRows.length,
        proposed_bed_count: proposedBedCount,
        would_insert_count: newInsertCount,
        would_skip_count: wouldSkip.length,
        unknown_bed_codes_count: unknownBeds.length,
        postgres_overlap_conflicts_count: overlapConflicts.length,
        guest_count: guestCount,
        guest_count_matches_proposed_plus_existing: guestCountMatches,
        payments_rows: paymentRows.length,
        payment_events_rows: paymentEventCount[0].c,
        planning_rows_after_assign_count: planningRowsAfter.length,
        planning_rows_new_count: planningRowsAfter.filter((r) => r.is_new_if_assign_ran).length,
      },
      proposed_beds: proposed,
      postgres_booking_beds_existing: existingBedRows.map((row) => ({
        booking_bed_id: row.booking_bed_id,
        bed_code: String(row.bed_code || '').toUpperCase(),
        room_code: row.room_code,
        assignment_start_date: toIsoDateString(row.assignment_start_date),
        assignment_end_date: toIsoDateString(row.assignment_end_date),
        airtable_record_id: row.airtable_record_id,
        natural_key: assignmentNaturalKey(
          bookingCode,
          String(row.bed_code || '').toUpperCase(),
          toIsoDateString(row.assignment_start_date),
          toIsoDateString(row.assignment_end_date)
        ),
      })),
      postgres_booking_beds_would_insert: wouldInsert,
      postgres_booking_beds_would_skip: wouldSkip,
      unknown_bed_codes: unknownBeds,
      postgres_overlap_conflicts: overlapConflicts,
      guest_count_check: {
        guest_count: guestCount,
        existing_beds: existingBedRows.length,
        would_insert: newInsertCount,
        total_after_assign: existingBedRows.length + newInsertCount,
        matches: guestCountMatches,
        note:
          guestCount == null
            ? 'guest_count missing or zero on booking — comparison skipped'
            : guestCountMatches
              ? 'Proposed assign matches guest count'
              : 'Bed count after assign would differ from guest_count',
      },
      booking_fields_would_update_if_assign_ran: {
        note: 'Hosted Bed Assignment workflow; 3b.2b/3b.2c would mirror assignment fields in Postgres.',
        status: { current: booking.status, would_change: false },
        payment_status: { current: booking.payment_status, would_change: false },
        assignment_status: {
          current: booking.assignment_status,
          would_be: overlapConflicts.length > 0 || unknownBeds.length > 0 ? 'needs_review' : 'assigned',
          maps_airtable:
            overlapConflicts.length > 0 || unknownBeds.length > 0 ? 'Needs Review' : 'Assigned',
        },
        availability_check_status: {
          current: booking.availability_check_status,
          would_be: overlapConflicts.length > 0 ? 'conflict' : 'available',
          maps_airtable: overlapConflicts.length > 0 ? 'Conflict' : 'Available',
        },
      },
      payments_untouched: {
        policy: 'No INSERT/UPDATE/DELETE on payments or payment_events in assign path',
        payments_count: paymentRows.length,
        payment_events_count: paymentEventCount[0].c,
        payment_status_would_change: false,
        payments: paymentRows,
      },
      planning_report_impact: {
        note:
          'Rows that would appear in planning:report:postgres after assign (same filters as 3a; status not cancelled/expired).',
        rows_after_assign: planningRowsAfter,
        new_row_count: planningRowsAfter.filter((r) => r.is_new_if_assign_ran).length,
      },
      warnings: [],
      actionable: [],
    };
  });

  if (report.error === 'booking_not_found') {
    console.error(`\nAssign impact: booking not found (${flags.bookingCode || flags.airtableRecordId})\n`);
    process.exit(1);
  }
  if (report.error === 'booking_ambiguous') {
    console.error(`\nAssign impact: ambiguous booking lookup (${report.matches} rows)\n`);
    process.exit(1);
  }
  if (report.error === 'missing_assignment_dates') {
    console.error(
      `\nAssign impact: need --check-in/--check-out or booking dates on ${report.booking_code}\n`
    );
    process.exit(1);
  }
  if (report.error === 'invalid_date_range') {
    console.error(`\nAssign impact: invalid date range ${report.check_in} .. ${report.check_out}\n`);
    process.exit(1);
  }

  if (report.unknown_bed_codes.length) {
    report.warnings.push(`unknown_bed_codes: ${report.unknown_bed_codes.join(', ')}`);
    report.actionable.push('unknown_bed_codes');
  }
  if (report.postgres_overlap_conflicts.length) {
    report.warnings.push(
      `postgres_overlap_conflicts: ${report.postgres_overlap_conflicts.length} conflict(s)`
    );
    report.actionable.push('postgres_overlap_conflicts');
  }
  if (report.guest_count_check.matches === false) {
    report.warnings.push(
      `guest_count_mismatch: guest_count=${report.guest_count_check.guest_count} total_beds_after=${report.guest_count_check.total_after_assign}`
    );
    report.actionable.push('guest_count_mismatch');
  }
  if (['cancelled', 'expired'].includes(report.postgres_booking.status)) {
    report.warnings.push(`booking_status_${report.postgres_booking.status}: assign normally skipped`);
  }
  if (['assigned', 'assigning'].includes(report.postgres_booking.assignment_status)) {
    report.warnings.push(
      `assignment_status_${report.postgres_booking.assignment_status}: hosted IF may skip assign`
    );
  }
  if (report.summary.would_insert_count === 0 && report.summary.would_skip_count > 0) {
    report.warnings.push('all_proposed_beds_already_exist: assign would be idempotent for PG inserts');
  }

  const stamp = report.generated_at.replace(/[:.]/g, '-').slice(0, 19);
  const safeCode = (report.postgres_booking.booking_code || 'unknown').replace(/[^\w-]/g, '_');
  const outPath = path.join(REPORTS_DIR, `assign-impact-${safeCode}-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  const s = report.summary;
  console.log('\nPhase 3b.2a — Assign impact report (read-only)\n');
  console.log(`  Booking:        ${report.postgres_booking.booking_code}`);
  console.log(`  Status:         ${report.postgres_booking.status}`);
  console.log(`  Guest count:    ${s.guest_count ?? '(n/a)'}`);
  console.log(`  Existing beds:  ${s.existing_booking_beds_count}`);
  console.log(`  Would insert:   ${s.would_insert_count}`);
  console.log(`  Would skip:     ${s.would_skip_count}`);
  console.log(`  PG overlaps:    ${s.postgres_overlap_conflicts_count}`);
  console.log(`  Payments:       ${s.payments_rows} rows (untouched)`);
  console.log(`  Planning rows:  ${s.planning_rows_after_assign_count} (${s.planning_rows_new_count} new)`);
  if (report.warnings.length) {
    console.log('\n  Warnings:');
    for (const w of report.warnings) console.log(`    - ${w}`);
  }
  console.log(`\nWrote ${outPath}`);
  console.log('No Postgres, Airtable, Sheets, or payment mutations.\n');

  if (report.actionable.length) {
    console.log(`Assign impact: actionable: ${report.actionable.join(', ')}. Exit 2.\n`);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
