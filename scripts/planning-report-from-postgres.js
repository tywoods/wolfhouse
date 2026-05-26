/**
 * Phase 3a — Read-only planning report from Postgres → local CSV.
 * SELECT only. No Airtable, Sheets, n8n, or payment mutations.
 *
 * Usage:
 *   npm run planning:report:postgres
 *   npm run planning:report:postgres -- --from=2026-08-01 --to=2026-08-31
 *
 * Docker tools:
 *   docker compose -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools \
 *     sh -c "npm install && npm run planning:report:postgres"
 */
const fs = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const {
  PLANNING_CSV_COLUMNS,
  formatPlanningRowFromPostgres,
  planningRowToCsvLine,
} = require('./lib/planning-row-format');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';

const PLANNING_SELECT_SQL = `
SELECT
  b.booking_code,
  b.airtable_record_id,
  b.booking_source::text AS booking_source,
  b.guest_name,
  b.guest_count,
  b.status::text AS status,
  b.payment_status::text AS payment_status,
  b.assignment_status::text AS assignment_status,
  b.package_code,
  b.deposit_paid_cents,
  b.requested_room_type,
  b.room_preference,
  b.guest_gender_group_type,
  bb.assignment_start_date,
  bb.assignment_end_date,
  bb.room_code,
  bb.bed_code,
  bb.assignment_notes,
  bb.planning_row_label
FROM booking_beds bb
INNER JOIN bookings b ON b.id = bb.booking_id
WHERE bb.client_id = $1
  AND b.status NOT IN ('cancelled', 'expired')
  AND bb.bed_code IS NOT NULL
  AND TRIM(bb.bed_code) <> ''
  AND bb.assignment_start_date IS NOT NULL
  AND bb.assignment_end_date IS NOT NULL
`;

function parseArgs(argv) {
  const flags = { clientSlug: DEFAULT_CLIENT_SLUG, from: null, to: null };
  for (const arg of argv) {
    if (arg.startsWith('--client=')) flags.clientSlug = arg.slice('--client='.length);
    else if (arg.startsWith('--from=')) flags.from = arg.slice('--from='.length);
    else if (arg.startsWith('--to=')) flags.to = arg.slice('--to='.length);
    else if (arg === '--from' && argv[argv.indexOf(arg) + 1]) {
      flags.from = argv[argv.indexOf(arg) + 1];
    } else if (arg === '--to' && argv[argv.indexOf(arg) + 1]) {
      flags.to = argv[argv.indexOf(arg) + 1];
    }
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const syncedAt = new Date().toISOString();

  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const { rows, clientSlug } = await withPgClient(async (client) => {
    const { rows: clientRows } = await client.query(`SELECT id FROM clients WHERE slug = $1`, [
      flags.clientSlug,
    ]);
    if (!clientRows.length) throw new Error(`Client not found: ${flags.clientSlug}`);
    const clientId = clientRows[0].id;

    const params = [clientId];
    let sql = PLANNING_SELECT_SQL;
    if (flags.from) {
      params.push(flags.from);
      sql += ` AND bb.assignment_end_date > $${params.length}::date`;
    }
    if (flags.to) {
      params.push(flags.to);
      sql += ` AND bb.assignment_start_date < $${params.length}::date`;
    }
    sql += ` ORDER BY bb.assignment_start_date, b.booking_code, bb.bed_code`;

    const { rows: assignmentRows } = await client.query(sql, params);
    return { rows: assignmentRows, clientSlug: flags.clientSlug };
  });

  const planningRows = rows.map((row) => formatPlanningRowFromPostgres(row, syncedAt));

  const stamp = syncedAt.replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(REPORTS_DIR, `planning-postgres-${stamp}.csv`);

  const lines = [PLANNING_CSV_COLUMNS.join(',')];
  for (const row of planningRows) {
    lines.push(planningRowToCsvLine(row));
  }
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');

  console.log('\nPlanning report from Postgres (read-only)\n');
  console.log(`  Client:     ${clientSlug}`);
  console.log(`  Rows:       ${planningRows.length}`);
  if (flags.from || flags.to) {
    console.log(`  Date filter: from=${flags.from || '(none)'} to=${flags.to || '(none)'}`);
  }
  console.log(`  Output:     ${outPath}`);
  console.log('\nNo Postgres mutations performed.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
