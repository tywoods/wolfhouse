/**
 * Phase 3b.0 — Bed / booking_beds drift audit (read-only).
 * Does NOT call Airtable API or mutate Postgres, Airtable, or Sheets.
 *
 * Usage:
 *   npm run db:report:bed-drift
 *   npm run db:report:bed-drift -- --overlap-from=2026-06-01 --overlap-to=2026-08-31
 */
const fs = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const {
  toIsoDateString,
  assignmentNaturalKey,
  loadCsvBedAssignments,
  loadCsvBookingCodes,
} = require('./lib/bed-drift-keys');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const CLIENT_SLUG = 'wolfhouse-somo';

function parseArgs(argv) {
  const flags = { overlapFrom: null, overlapTo: null, clientSlug: CLIENT_SLUG };
  for (const arg of argv) {
    if (arg.startsWith('--overlap-from=')) flags.overlapFrom = arg.slice('--overlap-from='.length);
    else if (arg.startsWith('--overlap-to=')) flags.overlapTo = arg.slice('--overlap-to='.length);
    else if (arg.startsWith('--client=')) flags.clientSlug = arg.slice('--client='.length);
  }
  return flags;
}

function groupCountsByBooking(assignments) {
  const counts = new Map();
  for (const a of assignments) {
    counts.set(a.booking_code, (counts.get(a.booking_code) || 0) + 1);
  }
  return counts;
}

function indexByNaturalKey(assignments) {
  const map = new Map();
  for (const a of assignments) {
    if (!map.has(a.natural_key)) map.set(a.natural_key, []);
    map.get(a.natural_key).push(a);
  }
  return map;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const csvBeds = loadCsvBedAssignments();
  const csvBookings = loadCsvBookingCodes();
  const csvBedByKey = indexByNaturalKey(csvBeds);
  const csvCountByBooking = groupCountsByBooking(csvBeds);

  const report = await withPgClient(async (client) => {
    const { rows: clientRows } = await client.query(`SELECT id FROM clients WHERE slug = $1`, [
      flags.clientSlug,
    ]);
    if (!clientRows.length) throw new Error(`Client not found: ${flags.clientSlug}`);
    const clientId = clientRows[0].id;

    const { rows: pgBedRows } = await client.query(
      `SELECT
         bb.id AS booking_bed_id,
         b.booking_code,
         b.status::text AS booking_status,
         b.payment_status::text AS payment_status,
         b.assignment_status::text AS assignment_status,
         bb.bed_code,
         bb.room_code,
         bb.assignment_start_date::text AS assignment_start_date,
         bb.assignment_end_date::text AS assignment_end_date,
         bb.airtable_record_id
       FROM booking_beds bb
       INNER JOIN bookings b ON b.id = bb.booking_id
       WHERE bb.client_id = $1
       ORDER BY b.booking_code, bb.bed_code`,
      [clientId]
    );

    const pgBeds = pgBedRows.map((row) => {
      const startIso = toIsoDateString(row.assignment_start_date);
      const endIso = toIsoDateString(row.assignment_end_date);
      const bedCode = String(row.bed_code || '').trim().toUpperCase();
      return {
        booking_bed_id: row.booking_bed_id,
        booking_code: row.booking_code,
        booking_status: row.booking_status,
        payment_status: row.payment_status,
        assignment_status: row.assignment_status,
        bed_code: bedCode,
        room_code: row.room_code,
        assignment_start_date: startIso,
        assignment_end_date: endIso,
        natural_key: assignmentNaturalKey(row.booking_code, bedCode, startIso, endIso),
        source: 'postgres',
      };
    });

    const pgBedByKey = indexByNaturalKey(pgBeds);
    const pgCountByBooking = groupCountsByBooking(pgBeds);

    const allBookingCodes = new Set([...csvCountByBooking.keys(), ...pgCountByBooking.keys()]);
    const perBookingBedCounts = [];

    for (const bookingCode of [...allBookingCodes].sort()) {
      const inCsv = csvBookings.has(bookingCode);
      const inPg = pgCountByBooking.has(bookingCode);
      const csvCount = csvCountByBooking.get(bookingCode) || 0;
      const pgCount = pgCountByBooking.get(bookingCode) || 0;
      const likelyLocalOnly = !inCsv && inPg;

      perBookingBedCounts.push({
        booking_code: bookingCode,
        csv_bed_rows: csvCount,
        postgres_bed_rows: pgCount,
        delta: pgCount - csvCount,
        in_csv_export: inCsv,
        in_postgres: inPg,
        likely_local_only_booking: likelyLocalOnly,
        count_mismatch_actionable: inCsv && csvCount !== pgCount,
      });
    }

    const keysOnlyInCsv = [];
    for (const [key, rows] of csvBedByKey) {
      if (!pgBedByKey.has(key)) {
        const r = rows[0];
        const bookingInCsv = csvBookings.has(r.booking_code);
        keysOnlyInCsv.push({
          natural_key: key,
          booking_code: r.booking_code,
          bed_code: r.bed_code,
          assignment_start_date: r.assignment_start_date,
          assignment_end_date: r.assignment_end_date,
          actionable: bookingInCsv,
        });
      }
    }

    const keysOnlyInPostgres = [];
    for (const [key, rows] of pgBedByKey) {
      if (!csvBedByKey.has(key)) {
        const r = rows[0];
        const bookingInCsv = csvBookings.has(r.booking_code);
        keysOnlyInPostgres.push({
          natural_key: key,
          booking_code: r.booking_code,
          bed_code: r.bed_code,
          assignment_start_date: r.assignment_start_date,
          assignment_end_date: r.assignment_end_date,
          booking_bed_id: r.booking_bed_id,
          likely_local_only_booking: !bookingInCsv,
          actionable: bookingInCsv,
        });
      }
    }

    const { rows: duplicateNatural } = await client.query(
      `SELECT
         b.booking_code,
         bb.bed_code,
         bb.assignment_start_date::text AS assignment_start_date,
         bb.assignment_end_date::text AS assignment_end_date,
         COUNT(*)::int AS row_count,
         array_agg(bb.id::text ORDER BY bb.created_at) AS booking_bed_ids
       FROM booking_beds bb
       INNER JOIN bookings b ON b.id = bb.booking_id
       WHERE bb.client_id = $1
       GROUP BY b.booking_code, bb.bed_id, bb.bed_code, bb.assignment_start_date, bb.assignment_end_date
       HAVING COUNT(*) > 1`,
      [clientId]
    );

    let overlapSql = `
      SELECT
        b1.booking_code AS booking_a,
        b2.booking_code AS booking_b,
        bd.bed_code,
        bb1.assignment_start_date::text AS start_a,
        bb1.assignment_end_date::text AS end_a,
        bb2.assignment_start_date::text AS start_b,
        bb2.assignment_end_date::text AS end_b,
        bb1.id::text AS booking_bed_id_a,
        bb2.id::text AS booking_bed_id_b
      FROM booking_beds bb1
      INNER JOIN booking_beds bb2
        ON bb1.client_id = bb2.client_id
       AND bb1.bed_id = bb2.bed_id
       AND bb1.id < bb2.id
       AND bb1.assignment_start_date < bb2.assignment_end_date
       AND bb2.assignment_start_date < bb1.assignment_end_date
      INNER JOIN bookings b1 ON b1.id = bb1.booking_id
      INNER JOIN bookings b2 ON b2.id = bb2.booking_id
      INNER JOIN beds bd ON bd.id = bb1.bed_id
      WHERE bb1.client_id = $1
        AND b1.status NOT IN ('cancelled', 'expired')
        AND b2.status NOT IN ('cancelled', 'expired')`;
    const overlapParams = [clientId];
    if (flags.overlapFrom) {
      overlapParams.push(flags.overlapFrom);
      overlapSql += ` AND bb1.assignment_end_date > $${overlapParams.length}::date`;
    }
    if (flags.overlapTo) {
      overlapParams.push(flags.overlapTo);
      overlapSql += ` AND bb1.assignment_start_date < $${overlapParams.length}::date`;
    }
    overlapSql += ' ORDER BY bd.bed_code, bb1.assignment_start_date LIMIT 500';

    const { rows: overlappingAssignments } = await client.query(overlapSql, overlapParams);

    const { rows: pgBookingStateRows } = await client.query(
      `SELECT booking_code, status::text AS booking_status, payment_status::text AS payment_status,
              assignment_status::text AS assignment_status
       FROM bookings WHERE client_id = $1`,
      [clientId]
    );

    const weirdAssignmentState = [];
    for (const row of pgBookingStateRows) {
      const code = row.booking_code;
      const bedCount = pgCountByBooking.get(code) || 0;
      const pay = String(row.payment_status || '');
      const bookStatus = String(row.booking_status || '');
      const assignStatus = String(row.assignment_status || '');
      const paidLike =
        pay === 'deposit_paid' || pay === 'paid' || bookStatus === 'confirmed';
      const assignedLike = assignStatus === 'assigned';
      const assigningInProgress = assignStatus === 'assigning';
      const issues = [];

      if (paidLike && bedCount === 0 && !assigningInProgress) {
        issues.push('paid_or_confirmed_but_no_booking_beds');
      }
      if (paidLike && assignStatus === 'unassigned' && bedCount === 0) {
        issues.push('paid_or_confirmed_but_assignment_status_unassigned');
      }
      if (assignedLike && bedCount === 0) {
        issues.push('assignment_status_assigned_but_no_booking_beds');
      }
      if (bookStatus === 'hold' && bedCount > 0 && pay === 'not_requested') {
        issues.push('hold_with_beds_but_payment_not_requested');
      }

      if (issues.length) {
        weirdAssignmentState.push({
          booking_code: code,
          booking_status: bookStatus,
          payment_status: pay,
          assignment_status: assignStatus,
          postgres_bed_rows: bedCount,
          in_csv_export: csvBookings.has(code),
          likely_local_only_booking: !csvBookings.has(code),
          issues,
        });
      }
    }

    const actionableKeyCsv = keysOnlyInCsv.filter((k) => k.actionable);
    const actionableKeyPg = keysOnlyInPostgres.filter((k) => k.actionable && !k.likely_local_only_booking);
    const actionableCountMismatch = perBookingBedCounts.filter((r) => r.count_mismatch_actionable);

    return {
      generated_at: new Date().toISOString(),
      client_slug: flags.clientSlug,
      read_only: true,
      no_mutations: true,
      summary: {
        csv_bed_rows: csvBeds.length,
        postgres_bed_rows: pgBeds.length,
        csv_booking_codes_with_beds: csvCountByBooking.size,
        postgres_booking_codes_with_beds: pgCountByBooking.size,
        keys_only_in_csv_total: keysOnlyInCsv.length,
        keys_only_in_csv_actionable: actionableKeyCsv.length,
        keys_only_in_postgres_total: keysOnlyInPostgres.length,
        keys_only_in_postgres_actionable: actionableKeyPg.length,
        keys_only_in_postgres_likely_local_only: keysOnlyInPostgres.filter(
          (k) => k.likely_local_only_booking
        ).length,
        per_booking_count_mismatches_actionable: actionableCountMismatch.length,
        postgres_duplicate_natural_keys: duplicateNatural.length,
        postgres_overlapping_pairs: overlappingAssignments.length,
        weird_assignment_state_rows: weirdAssignmentState.length,
        weird_assignment_state_actionable: weirdAssignmentState.filter((w) => !w.likely_local_only_booking)
          .length,
      },
      per_booking_bed_counts: perBookingBedCounts,
      keys_only_in_csv: keysOnlyInCsv,
      keys_only_in_postgres: keysOnlyInPostgres,
      postgres_duplicate_natural_keys: duplicateNatural,
      postgres_overlapping_assignments: overlappingAssignments,
      weird_assignment_state: weirdAssignmentState,
      overlap_filter: {
        from: flags.overlapFrom,
        to: flags.overlapTo,
      },
    };
  });

  const stamp = report.generated_at.replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(REPORTS_DIR, `bed-drift-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  const s = report.summary;
  console.log('\nPhase 3b.0 — Bed / booking_beds drift audit (read-only)\n');
  console.log(`  CSV bed rows:              ${s.csv_bed_rows}`);
  console.log(`  Postgres bed rows:         ${s.postgres_bed_rows}`);
  console.log(`  Keys only in CSV:           ${s.keys_only_in_csv_total} (${s.keys_only_in_csv_actionable} actionable)`);
  console.log(
    `  Keys only in Postgres:     ${s.keys_only_in_postgres_total} (${s.keys_only_in_postgres_actionable} actionable, ${s.keys_only_in_postgres_likely_local_only} local-only booking)`
  );
  console.log(`  Per-booking count mismatch:  ${s.per_booking_count_mismatches_actionable} actionable`);
  console.log(`  PG duplicate natural keys:   ${s.postgres_duplicate_natural_keys}`);
  console.log(`  PG overlapping pairs:      ${s.postgres_overlapping_pairs}`);
  console.log(
    `  Weird assignment state:    ${s.weird_assignment_state_rows} (${s.weird_assignment_state_actionable} actionable)`
  );

  if (report.keys_only_in_csv.filter((k) => k.actionable).length) {
    console.log('\n  Sample keys only in CSV (actionable):');
    for (const k of report.keys_only_in_csv.filter((x) => x.actionable).slice(0, 5)) {
      console.log(`    ${k.natural_key}`);
    }
  }

  if (report.postgres_duplicate_natural_keys.length) {
    console.log('\n  Duplicate natural keys (Postgres):');
    for (const d of report.postgres_duplicate_natural_keys.slice(0, 5)) {
      console.log(`    ${d.booking_code} ${d.bed_code} ${d.assignment_start_date}–${d.assignment_end_date} ×${d.row_count}`);
    }
  }

  console.log(`\nWrote ${outPath}`);
  console.log('No Postgres, Airtable, or Sheets mutations.\n');

  const actionable =
    s.keys_only_in_csv_actionable > 0 ||
    s.keys_only_in_postgres_actionable > 0 ||
    s.per_booking_count_mismatches_actionable > 0 ||
    s.postgres_duplicate_natural_keys > 0 ||
    s.postgres_overlapping_pairs > 0 ||
    s.weird_assignment_state_actionable > 0;

  if (actionable) {
    console.log('Bed drift: actionable issues found for CSV-export bookings. Exit 1.\n');
    process.exit(1);
  }

  if (
    s.keys_only_in_postgres_likely_local_only > 0 ||
    s.per_booking_count_mismatches_actionable === 0
  ) {
    console.log('Note: Postgres-only / local-only Phase 2 test data may explain non-actionable deltas.\n');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
