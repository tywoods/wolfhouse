/**
 * Compare CSV row counts vs Postgres after Phase 1 sync.
 * Usage: npm run db:verify
 */
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });
const { readCsvFile } = require('./lib/parse-csv');

const connectionString =
  process.env.WOLFHOUSE_DATABASE_URL ||
  `postgres://${process.env.WOLFHOUSE_DB_USER || 'wolfhouse'}:${process.env.WOLFHOUSE_DB_PASSWORD}@localhost:${process.env.WOLFHOUSE_DB_PORT || 5433}/${process.env.WOLFHOUSE_DB_NAME || 'wolfhouse'}`;

async function countCsv(name) {
  const rows = readCsvFile(path.join(__dirname, '..', 'database', name));
  return rows.filter((r) => Object.values(r).some((v) => v)).length;
}

async function main() {
  const client = new Client({ connectionString });
  await client.connect();

  const checks = [
    ['Bookings', 'Bookings-Grid view.csv', 'bookings'],
    ['Booking Beds', 'Booking Beds-Active Bed Assignments.csv', 'booking_beds'],
    ['Conversations', 'Conversations-Grid view.csv', 'conversations'],
    ['Messages', 'Messages-Grid view.csv', 'messages'],
  ];

  console.log('\nPhase 1 verification (CSV vs Postgres)\n');
  let ok = true;

  for (const [label, csv, table] of checks) {
    const csvCount = await countCsv(csv);
    const { rows } = await client.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
    const dbCount = rows[0].c;
    const match = csvCount === dbCount;
    if (!match) ok = false;
    console.log(
      `${match ? '✓' : '✗'} ${label}: CSV=${csvCount}  Postgres=${dbCount}`
    );
  }

  const { rows: rules } = await client.query(
    `SELECT COUNT(*)::int AS c FROM package_price_rules`
  );
  console.log(
    `${rules[0].c >= 9 ? '✓' : '✗'} Package price rules: ${rules[0].c} (expect 9)`
  );
  if (rules[0].c < 9) ok = false;

  const { rows: sample } = await client.query(
    `SELECT package_stay_total_per_person_eur(249, 3) AS malibu_3n`
  );
  console.log(`✓ Pricing fn Malibu 3 nights: €${sample[0].malibu_3n} (expect 110)`);

  const { rows: events } = await client.query(
    `SELECT message, created_at FROM workflow_events
     WHERE workflow_name = 'phase1-csv-sync' ORDER BY created_at DESC LIMIT 1`
  );
  if (events.length) {
    console.log(`✓ Last sync event: ${events[0].message} @ ${events[0].created_at}`);
  }

  await client.end();
  console.log(ok ? '\nAll checks passed.\n' : '\nSome checks failed — re-run db:sync or refresh CSVs.\n');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
