/**
 * Verify local Postgres after sync + Phase 2a schema (clients, payment enums).
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

  console.log('\nLocal DB verification\n');
  let ok = true;

  const { rows: clientRow } = await client.query(
    `SELECT slug FROM clients WHERE slug = 'wolfhouse-somo'`
  );
  const hasClient = clientRow.length === 1;
  console.log(`${hasClient ? '✓' : '✗'} clients table: wolfhouse-somo`);
  if (!hasClient) ok = false;

  const { rows: legacyHostel } = await client.query(
    `SELECT to_regclass('public.hostels') AS t`
  );
  const noHostelsTable = legacyHostel[0].t === null;
  console.log(`${noHostelsTable ? '✓' : '✗'} hostels table removed (renamed to clients)`);
  if (!noHostelsTable) ok = false;

  const { rows: legacyCol } = await client.query(
    `SELECT COUNT(*)::int AS c FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'hostel_id'`
  );
  console.log(
    `${legacyCol[0].c === 0 ? '✓' : '✗'} no hostel_id columns remain (found ${legacyCol[0].c})`
  );
  if (legacyCol[0].c !== 0) ok = false;

  const checks = [
    ['Bookings', 'Bookings-Grid view.csv', 'bookings'],
    ['Booking Beds', 'Booking Beds-Active Bed Assignments.csv', 'booking_beds'],
    ['Conversations', 'Conversations-Grid view.csv', 'conversations'],
    ['Messages', 'Messages-Grid view.csv', 'messages'],
  ];

  for (const [label, csv, table] of checks) {
    const csvCount = await countCsv(csv);
    const { rows } = await client.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
    const dbCount = rows[0].c;
    const match = csvCount === dbCount;
    if (!match) ok = false;
    console.log(`${match ? '✓' : '✗'} ${label}: CSV=${csvCount}  Postgres=${dbCount}`);
  }

  const { rows: rules } = await client.query(
    `SELECT COUNT(*)::int AS c FROM package_price_rules`
  );
  if (rules[0].c < 9) ok = false;
  console.log(`✓ Package price rules: ${rules[0].c} (expect 9)`);

  const { rows: sample } = await client.query(
    `SELECT package_stay_total_per_person_eur(249, 3) AS malibu_3n`
  );
  console.log(`✓ Pricing fn Malibu 3 nights: €${sample[0].malibu_3n} (expect 110)`);

  const { rows: payCols } = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'payments'
     AND column_name IN ('payment_kind', 'amount_due_cents', 'amount_paid_cents', 'client_id')
     ORDER BY column_name`
  );
  const colNames = payCols.map((r) => r.column_name);
  const payColsOk =
    colNames.includes('payment_kind') &&
    colNames.includes('amount_due_cents') &&
    colNames.includes('amount_paid_cents') &&
    colNames.includes('client_id');
  console.log(
    `${payColsOk ? '✓' : '✗'} payments columns: ${colNames.join(', ')}`
  );
  if (!payColsOk) ok = false;

  const { rows: kinds } = await client.query(
    `SELECT unnest(enum_range(NULL::payment_kind))::text AS v`
  );
  const kindVals = kinds.map((r) => r.v).sort();
  const kindsOk =
    kindVals.includes('deposit_only') && kindVals.includes('full_amount');
  console.log(`${kindsOk ? '✓' : '✗'} payment_kind enum: ${kindVals.join(', ')}`);
  if (!kindsOk) ok = false;

  const { rows: pstat } = await client.query(
    `SELECT unnest(enum_range(NULL::payment_status))::text AS v`
  );
  const statVals = pstat.map((r) => r.v);
  for (const required of [
    'waiting_payment',
    'payment_link_sent',
    'deposit_paid',
    'paid',
    'failed',
    'expired',
    'refunded',
  ]) {
    const has = statVals.includes(required);
    if (!has) ok = false;
    console.log(`${has ? '✓' : '✗'} payment_status includes ${required}`);
  }

  await client.end();
  console.log(ok ? '\nAll checks passed.\n' : '\nSome checks failed.\n');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
