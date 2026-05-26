/**
 * Local 3b.3b E2E — impact report, optional AT prep, reassign webhook twice, PG duplicate check.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  let recordId = 'recBtWzIvmjQ5mmo0';
  let guestCount = 3;
  let skipPrep = false;
  let skipSync = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--record-id=')) recordId = arg.slice('--record-id='.length).trim();
    else if (arg === '--record-id' && argv[i + 1]) recordId = argv[++i].trim();
    else if (arg.startsWith('--guest-count=')) guestCount = Number(arg.slice('--guest-count='.length));
    else if (arg === '--skip-prep') skipPrep = true;
    else if (arg === '--skip-sync') skipSync = true;
  }
  if (recordId.startsWith('WH-')) recordId = recordId.slice(3);
  return { recordId, guestCount, skipPrep, skipSync };
}

function runNode(script, args = []) {
  const r = spawnSync('node', [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    throw new Error(`${script} exited ${r.status}`);
  }
  return r.stdout;
}

async function postWebhook(recordId) {
  const base =
    process.env.N8N_WEBHOOK_URL ||
    process.env.N8N_WEBHOOK_BASE ||
    'http://host.docker.internal:5678/webhook';
  const url = base.replace(/\/$/, '').endsWith('/webhook')
    ? `${base.replace(/\/$/, '')}/reassign-booking-beds`
    : `${base.replace(/\/$/, '')}/webhook/reassign-booking-beds`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ record_id: recordId, guest_count: 3 }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Webhook non-JSON (${res.status}): ${text.slice(0, 800)}`);
  }
  return { status: res.status, json };
}

function assertFirst(json) {
  const fails = [];
  if (!(Number(json.pg_deleted_count) >= 0)) fails.push('pg_deleted_count present');
  if (!json.assign_triggered) fails.push('assign_triggered === true');
  if (!(Number(json.pg_inserted_count) > 0)) fails.push('pg_inserted_count > 0');
  if (json.airtable_reset_ok !== true) fails.push('airtable_reset_ok === true');
  if (json.ok !== true) fails.push('ok === true');
  if (json.partial_failure) fails.push(`partial_failure null (got ${json.partial_failure})`);
  if (json.idempotent === true) fails.push('idempotent === false on first call');
  if (fails.length) {
    throw new Error(`First webhook failed: ${fails.join('; ')}\n${JSON.stringify(json, null, 2)}`);
  }
}

function assertSecond(json, firstInserted) {
  const fails = [];
  if (!(Number(json.pg_deleted_count) > 0)) fails.push('pg_deleted_count > 0 on second call');
  if (!json.assign_triggered) fails.push('assign_triggered on second call');
  if (json.ok !== true) fails.push('ok === true on second call');
  if (json.partial_failure) fails.push(`no partial_failure (got ${json.partial_failure})`);
  if (fails.length) {
    throw new Error(`Second webhook failed: ${fails.join('; ')}\n${JSON.stringify(json, null, 2)}`);
  }
}

async function checkNoDuplicateNaturalKeys(bookingCode) {
  const { withPgClient } = require('./lib/pg-connect');
  return withPgClient(async (client) => {
    const { rows } = await client.query(
      `SELECT bb.bed_code, bb.assignment_start_date::text AS s, bb.assignment_end_date::text AS e, COUNT(*)::int AS c
       FROM booking_beds bb
       INNER JOIN bookings b ON b.id = bb.booking_id
       WHERE b.booking_code = $1
       GROUP BY bb.bed_code, bb.assignment_start_date, bb.assignment_end_date
       HAVING COUNT(*) > 1`,
      [bookingCode]
    );
    if (rows.length) {
      throw new Error(`Duplicate PG natural keys: ${JSON.stringify(rows)}`);
    }
    const { rows: total } = await client.query(
      `SELECT COUNT(*)::int AS c FROM booking_beds bb
       INNER JOIN bookings b ON b.id = bb.booking_id WHERE b.booking_code = $1`,
      [bookingCode]
    );
    return total[0].c;
  });
}

async function main() {
  const { recordId, guestCount, skipPrep, skipSync } = parseArgs(process.argv.slice(2));
  const bookingCode = `WH-${recordId}`;
  console.log(`\n3b.3b local E2E — ${recordId}\n`);

  if (!skipSync) {
    console.log('db:sync...');
    runNode('scripts/sync-csv-to-postgres.js', []);
  }

  if (!skipPrep) {
    runNode('scripts/prep-reassign-e2e-airtable.js', [
      `--record-id=${recordId}`,
      `--guest-count=${guestCount}`,
    ]);
  }

  console.log('Calling reassign webhook (1/2)...');
  const first = await postWebhook(recordId);
  console.log(JSON.stringify(first.json, null, 2));
  assertFirst(first.json);

  const bedCountAfterFirst = await checkNoDuplicateNaturalKeys(bookingCode);
  console.log(`PG bed rows after first call: ${bedCountAfterFirst} (no duplicate natural keys)`);

  console.log('\nCalling reassign webhook (2/2)...');
  const second = await postWebhook(recordId);
  console.log(JSON.stringify(second.json, null, 2));
  assertSecond(second.json, first.json.pg_inserted_count);

  const bedCountAfterSecond = await checkNoDuplicateNaturalKeys(bookingCode);
  console.log(`PG bed rows after second call: ${bedCountAfterSecond}`);

  console.log('\n3b.3b E2E assertions passed.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
