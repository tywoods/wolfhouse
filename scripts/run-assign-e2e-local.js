/**
 * Local 3b.2c E2E — prep Airtable test booking then call assign webhook twice.
 * Does not touch hosted n8n Cloud workflows (Airtable automation may still race).
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  let recordId = 'recSyn7QcPdVrYa1D';
  let guestCount = 2;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--record-id=')) recordId = arg.slice('--record-id='.length).trim();
    else if (arg === '--record-id' && argv[i + 1]) recordId = argv[++i].trim();
    else if (arg.startsWith('--guest-count=')) guestCount = Number(arg.slice('--guest-count='.length));
  }
  if (recordId.startsWith('WH-')) recordId = recordId.slice(3);
  return { recordId, guestCount };
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
    ? `${base.replace(/\/$/, '')}/assign-beds-to-booking`
    : `${base.replace(/\/$/, '')}/webhook/assign-beds-to-booking`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ record_id: recordId }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Webhook non-JSON (${res.status}): ${text.slice(0, 500)}`);
  }
  return { status: res.status, json };
}

function assertFirst(json) {
  const fails = [];
  if (!(Number(json.pg_inserted_count) > 0)) fails.push('pg_inserted_count > 0');
  if (json.airtable_create_ok !== true) fails.push('airtable_create_ok === true');
  if (json.airtable_update_ok !== true) fails.push('airtable_update_ok === true');
  if (json.partial_failure) fails.push('partial_failure is null');
  if (json.idempotent === true) fails.push('idempotent === false on first call');
  if (json.skipped_reason) fails.push(`no skipped_reason (got ${json.skipped_reason})`);
  if (fails.length) {
    throw new Error(`First webhook assertions failed: ${fails.join('; ')}\n${JSON.stringify(json, null, 2)}`);
  }
}

function assertSecond(json) {
  const fails = [];
  if (Number(json.pg_inserted_count) !== 0) fails.push('pg_inserted_count === 0');
  if (!(Number(json.pg_skipped_count) > 0)) fails.push('pg_skipped_count > 0');
  if (json.idempotent !== true) fails.push('idempotent === true');
  if (fails.length) {
    throw new Error(`Second webhook assertions failed: ${fails.join('; ')}\n${JSON.stringify(json, null, 2)}`);
  }
}

async function main() {
  const { recordId, guestCount } = parseArgs(process.argv.slice(2));
  console.log(`\n3b.2c local E2E — ${recordId}\n`);

  runNode('scripts/cancel-booking-beds-postgres.js', [
    `--booking-code=WH-${recordId}`,
    '--execute',
  ]);

  runNode('scripts/prep-assign-e2e-airtable.js', [
    `--record-id=${recordId}`,
    `--guest-count=${guestCount}`,
  ]);

  console.log('Calling assign webhook (1/2)...');
  const first = await postWebhook(recordId);
  console.log(JSON.stringify(first.json, null, 2));
  assertFirst(first.json);
  console.log('First call OK.\n');

  console.log('Status-only prep for idempotent re-assign (keep AT/PG beds)...');
  runNode('scripts/prep-assign-e2e-airtable.js', [
    `--record-id=${recordId}`,
    `--guest-count=${guestCount}`,
    '--keep-booking-beds',
  ]);

  console.log('Calling assign webhook (2/2)...');
  const second = await postWebhook(recordId);
  console.log(JSON.stringify(second.json, null, 2));
  assertSecond(second.json);
  console.log('Second call OK (idempotent).\n');

  runNode('scripts/verify-booking-bed-count.js', [
    `--booking-code=WH-${recordId}`,
    `--expected-count=${first.json.pg_inserted_count}`,
  ]);

  console.log('E2E assign webhook success path passed.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
