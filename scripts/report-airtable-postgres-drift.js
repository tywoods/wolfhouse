/**
 * Phase 3.0b — Drift / audit report: CSV exports vs local Postgres (read-only).
 * Does NOT call Airtable API. Does NOT write to Postgres, Airtable, or Sheets.
 * payments / payment_events: SELECT counts only.
 *
 * Usage: npm run db:report:drift
 */
const fs = require('fs');
const path = require('path');
const { bookingCodeToAirtableRecordId } = require('./lib/airtable-record-id');
const { withPgClient } = require('./lib/pg-connect');
const { readCsvFile } = require('./lib/parse-csv');

const DB_DIR = path.join(__dirname, '..', 'database');
const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const CLIENT_SLUG = 'wolfhouse-somo';

function csvBookingCodes() {
  const rows = readCsvFile(path.join(DB_DIR, 'Bookings-Grid view.csv'));
  const codes = new Set();
  for (const row of rows) {
    const code = String(row['Booking ID'] || '').trim();
    if (code) codes.add(code);
  }
  return codes;
}

function csvBedAssignmentKeys() {
  const rows = readCsvFile(path.join(DB_DIR, 'Booking Beds-Active Bed Assignments.csv'));
  const keys = new Set();
  for (const row of rows) {
    const bookingCode = String(row['Booking ID'] || '').trim();
    const bed = String(row.Bed || row['Bed Label'] || '').trim();
    const start = String(row['Assignment Start Date'] || row['Check In'] || '').trim();
    const end = String(row['Assignment End Date'] || row['Check Out'] || '').trim();
    if (bookingCode && bed) keys.add(`${bookingCode}|${bed}|${start}|${end}`);
  }
  return keys;
}

function countCsvRows(filename) {
  const rows = readCsvFile(path.join(DB_DIR, filename));
  return rows.filter((r) => Object.values(r).some((v) => v && String(v).trim())).length;
}

async function main() {
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const csvCounts = {
    bookings: countCsvRows('Bookings-Grid view.csv'),
    booking_beds: countCsvRows('Booking Beds-Active Bed Assignments.csv'),
    conversations: countCsvRows('Conversations-Grid view.csv'),
    messages: countCsvRows('Messages-Grid view.csv'),
  };

  const csvBookings = csvBookingCodes();
  const csvBedKeys = csvBedAssignmentKeys();

  const report = await withPgClient(async (client) => {
    const { rows: clientRows } = await client.query(
      `SELECT id FROM clients WHERE slug = $1`,
      [CLIENT_SLUG]
    );
    if (!clientRows.length) throw new Error(`Client not found: ${CLIENT_SLUG}`);
    const clientId = clientRows[0].id;

    const tableCounts = {};
    for (const table of ['bookings', 'booking_beds', 'conversations', 'messages', 'payments', 'payment_events']) {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS c FROM ${table} WHERE client_id = $1`,
        [clientId]
      );
      tableCounts[table] = rows[0].c;
    }

    const { rows: pgBookings } = await client.query(
      `SELECT booking_code, airtable_record_id, status::text AS status, payment_status::text AS payment_status
       FROM bookings WHERE client_id = $1`,
      [clientId]
    );

    const pgCodes = new Set(pgBookings.map((r) => r.booking_code).filter(Boolean));

    const onlyInCsv = [...csvBookings].filter((c) => !pgCodes.has(c)).sort();
    const onlyInPg = [...pgCodes].filter((c) => !csvBookings.has(c)).sort();

    const missingAirtableId = [];
    const wrongAirtableId = [];

    for (const row of pgBookings) {
      const code = row.booking_code;
      if (!code || !code.startsWith('WH-rec')) continue;
      const expected = bookingCodeToAirtableRecordId(code);
      const current = row.airtable_record_id ? String(row.airtable_record_id).trim() : '';
      if (!current) missingAirtableId.push(code);
      else if (expected && current !== expected) {
        wrongAirtableId.push({ booking_code: code, current, expected });
      }
    }

    const { rows: pgBeds } = await client.query(
      `SELECT b.booking_code, bb.bed_code, bb.assignment_start_date::text AS start_date,
              bb.assignment_end_date::text AS end_date
       FROM booking_beds bb
       JOIN bookings b ON b.id = bb.booking_id
       WHERE bb.client_id = $1`,
      [clientId]
    );

    const pgBedKeys = new Set(
      pgBeds.map((r) => `${r.booking_code}|${r.bed_code}|${r.start_date}|${r.end_date}`)
    );

    let bedsOnlyCsv = 0;
    let bedsOnlyPg = 0;
    for (const k of csvBedKeys) if (!pgBedKeys.has(k)) bedsOnlyCsv += 1;
    for (const k of pgBedKeys) if (!csvBedKeys.has(k)) bedsOnlyPg += 1;

    return {
      generated_at: new Date().toISOString(),
      client_slug: CLIENT_SLUG,
      csv_counts: csvCounts,
      postgres_counts: tableCounts,
      count_deltas: {
        bookings: tableCounts.bookings - csvCounts.bookings,
        booking_beds: tableCounts.booking_beds - csvCounts.booking_beds,
        conversations: tableCounts.conversations - csvCounts.conversations,
        messages: tableCounts.messages - csvCounts.messages,
      },
      bookings: {
        csv_unique_codes: csvBookings.size,
        postgres_unique_codes: pgCodes.size,
        only_in_csv: onlyInCsv,
        only_in_postgres: onlyInPg,
        missing_airtable_record_id: missingAirtableId,
        wrong_airtable_record_id: wrongAirtableId,
      },
      booking_beds: {
        csv_assignment_keys: csvBedKeys.size,
        postgres_assignment_keys: pgBedKeys.size,
        keys_only_in_csv_approx: bedsOnlyCsv,
        keys_only_in_postgres_approx: bedsOnlyPg,
      },
      payments_read_only: {
        payments_rows: tableCounts.payments,
        payment_events_rows: tableCounts.payment_events,
        note: 'No mutations performed on payment tables',
      },
    };
  });

  const stamp = report.generated_at.replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(REPORTS_DIR, `drift-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\nAirtable/CSV vs Postgres drift report\n');
  console.log('Counts (CSV → Postgres):');
  for (const table of ['bookings', 'booking_beds', 'conversations', 'messages']) {
    const csv = report.csv_counts[table];
    const pg = report.postgres_counts[table];
    const delta = report.count_deltas[table];
    const mark = delta === 0 ? '✓' : '△';
    console.log(`  ${mark} ${table}: CSV=${csv}  PG=${pg}  (Δ ${delta >= 0 ? '+' : ''}${delta})`);
  }

  console.log('\nBooking codes:');
  console.log(`  CSV unique:     ${report.bookings.csv_unique_codes}`);
  console.log(`  Postgres unique: ${report.bookings.postgres_unique_codes}`);
  console.log(`  Only in CSV:    ${report.bookings.only_in_csv.length}`);
  console.log(`  Only in PG:     ${report.bookings.only_in_postgres.length}`);
  console.log(`  Missing airtable_record_id (WH-rec*): ${report.bookings.missing_airtable_record_id.length}`);
  console.log(`  Wrong airtable_record_id:             ${report.bookings.wrong_airtable_record_id.length}`);

  if (report.bookings.only_in_postgres.length) {
    console.log('\n  Postgres-only codes (often Phase 2 local tests):');
    for (const c of report.bookings.only_in_postgres.slice(0, 15)) {
      console.log(`    ${c}`);
    }
  }

  if (report.bookings.missing_airtable_record_id.length) {
    console.log('\n  Missing airtable_record_id:');
    for (const c of report.bookings.missing_airtable_record_id.slice(0, 15)) {
      console.log(`    ${c}`);
    }
  }

  console.log(`\nPayments (read-only): payments=${report.payments_read_only.payments_rows}  events=${report.payments_read_only.payment_events_rows}`);
  console.log(`\nWrote ${outPath}\n`);

  const actionableDrift =
    report.bookings.missing_airtable_record_id.length > 0 ||
    report.bookings.wrong_airtable_record_id.length > 0;

  if (actionableDrift) {
    console.log('Drift: actionable issues found (missing/wrong airtable_record_id). Exit 1.\n');
    process.exit(1);
  }

  if (report.count_deltas.bookings !== 0 || report.count_deltas.booking_beds !== 0) {
    console.log('Note: row count deltas may reflect Phase 2 local-only bookings (expected).\n');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
