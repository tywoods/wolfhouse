'use strict';

/**
 * prove-sunset-schema-observer-local — FOUNDATION Slice 6
 *
 * Local-only proof:
 *  1) build Dockerfile.luna-sunset-staff-api
 *  2) disposable PG + canonical 36 migrations → observer MATCH (exit 0)
 *  3) mutate schema → exact drift + nonzero exit
 *  4) wrong target / stacked SQL / secret leak fail-closed (via helper gates + CLI)
 *  5) cleanup containers, volumes, credentials
 *
 * Never mutates Azure / ACR / Key Vault / live Sunset DB.
 */

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { runCanonicalMigrations } = require('./run-canonical-migrations');
const {
  OBSERVER_DSN_ENV,
  assertSqlAllowed,
  assertObserverTarget,
  assertNoLeakedDsn,
  assertReadOnlySession,
  APPLICATION_NAME,
} = require('./lib/sunset-schema-observer');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'foundation-slice6');
const REPORT_PATH = path.join(OUT_DIR, 'local-observer-proof-report.json');
const CONTRACT = path.join(ROOT, 'fixtures', 'sunset-schema-observer', 'expected-product-schema.json');
const IMAGE = 'wh-local/luna-sunset-staff-api:slice6-observer';

const suffix = crypto.randomBytes(4).toString('hex');
const NET = `wh-obs-net-${suffix}`;
const PG_CONTAINER = `wh-obs-pg-${suffix}`;
const PG_VOLUME = `wh-obs-vol-${suffix}`;
const DB = `wh_mig_obs_${suffix}`;
const USER = `wh_mig_u_${suffix}`;
const PASSWORD = crypto.randomBytes(18).toString('base64url');
let hostPort = null;

const report = {
  ok: false,
  kind: 'sunset-schema-observer-local-proof',
  generatedAt: new Date().toISOString(),
  steps: [],
};

function step(name, ok, detail) {
  report.steps.push({ name, ok, detail: detail || null });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function docker(args, opts) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(opts || {}),
  });
}

function cleanup() {
  try { docker(['rm', '-f', PG_CONTAINER]); } catch (_) { /* ignore */ }
  try { docker(['volume', 'rm', '-f', PG_VOLUME]); } catch (_) { /* ignore */ }
  try { docker(['network', 'rm', NET]); } catch (_) { /* ignore */ }
}

async function waitForPg(connection, attempts) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    const client = new Client({ ...connection, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (e) {
      last = e;
      try { await client.end(); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last || new Error('postgres never ready');
}

function runObserverInImage(dsn, extraArgs) {
  const args = [
    'run', '--rm',
    '--network', NET,
    '-e', `${OBSERVER_DSN_ENV}=${dsn}`,
    IMAGE,
    'node', 'scripts/observe-sunset-schema-drift.js',
    '--allow-local-ephemeral',
    '--contract', '/app/fixtures/sunset-schema-observer/expected-product-schema.json',
    ...(extraArgs || []),
  ];
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    status: r.status == null ? 1 : r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
  };
}

function parseObserverJson(stdout) {
  const begin = stdout.indexOf('WH_SCHEMA_OBSERVER_BEGIN');
  const end = stdout.indexOf('WH_SCHEMA_OBSERVER_END');
  if (begin < 0 || end < 0 || end <= begin) return null;
  const body = stdout.slice(begin + 'WH_SCHEMA_OBSERVER_BEGIN'.length, end).trim();
  return JSON.parse(body);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  cleanup();

  if (!fs.existsSync(CONTRACT)) {
    console.log('Generating expected product-schema contract…');
    execFileSync(process.execPath, [path.join(__dirname, 'generate-sunset-expected-schema-contract.js')], {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
    });
  }
  step('contract-present', fs.existsSync(CONTRACT));

  console.log('Building Sunset Staff API image locally (no push)…');
  docker(['build', '-f', 'Dockerfile.luna-sunset-staff-api', '-t', IMAGE, '.'], { cwd: ROOT });
  step('image-built', true, IMAGE);

  docker(['network', 'create', NET]);
  docker([
    'run', '-d', '--name', PG_CONTAINER,
    '--network', NET,
    '--network-alias', 'obs-pg',
    '-e', `POSTGRES_USER=${USER}`,
    '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
    '-e', 'POSTGRES_DB=postgres',
    '-p', '127.0.0.1::5432',
    '-v', `${PG_VOLUME}:/var/lib/postgresql/data`,
    'postgres:15-alpine',
  ]);
  const portMap = String(docker(['port', PG_CONTAINER, '5432/tcp'])).trim();
  hostPort = Number(portMap.match(/:(\d+)\s*$/)[1]);
  const admin = {
    host: '127.0.0.1',
    port: hostPort,
    user: USER,
    password: PASSWORD,
    database: 'postgres',
  };
  await waitForPg(admin, 60);
  {
    const c = new Client(admin);
    await c.connect();
    await c.query(`CREATE DATABASE ${DB}`);
    await c.end();
  }
  const conn = { ...admin, database: DB };
  const applied = await runCanonicalMigrations({ connection: conn });
  step('canonical-migrations', applied.ok, `forward=${applied.forwardCount}`);
  if (!applied.ok) throw new Error('migrations failed');

  const dsnHost = `postgresql://${encodeURIComponent(USER)}:${encodeURIComponent(PASSWORD)}@obs-pg:5432/${DB}`;
  const matchRun = runObserverInImage(dsnHost);
  const matchJson = parseObserverJson(matchRun.stdout);
  const matchOk = matchRun.status === 0 && matchJson && matchJson.ok === true && matchJson.match === true;
  step('observer-match-exit-0', matchOk, `status=${matchRun.status} match=${matchJson && matchJson.match}`);
  report.match = matchJson;

  // Mutate disposable schema → drift
  {
    const c = new Client(conn);
    await c.connect();
    await c.query('CREATE TABLE wh_observer_drift_probe (id int PRIMARY KEY)');
    await c.end();
  }
  const driftRun = runObserverInImage(dsnHost);
  const driftJson = parseObserverJson(driftRun.stdout);
  const driftOk = driftRun.status !== 0
    && driftJson
    && driftJson.ok === false
    && Number(driftJson.drift && driftJson.drift.counts && driftJson.drift.counts.live_only) >= 1;
  step(
    'observer-drift-nonzero',
    driftOk,
    `status=${driftRun.status} live_only=${driftJson && driftJson.drift && driftJson.drift.counts && driftJson.drift.counts.live_only}`,
  );
  report.drift = driftJson;

  // Wrong target fail-closed (CLI)
  const wrongDsn = `postgresql://${encodeURIComponent(USER)}:${encodeURIComponent(PASSWORD)}@obs-pg:5432/postgres`;
  const wrong = runObserverInImage(wrongDsn);
  const wrongJson = parseObserverJson(wrong.stdout);
  step(
    'red-wrong-target-cli',
    wrong.status !== 0 && wrongJson && (wrongJson.code === 'wrong_target' || wrongJson.code === 'local_db_not_ephemeral' || (wrongJson.errors || []).length),
    `status=${wrong.status} code=${wrongJson && wrongJson.code}`,
  );

  // Helper RED gates (no live guest rows / stacked / writable / leak)
  step('red-stacked-sql-helper', !assertSqlAllowed('SELECT 1; SELECT 2').ok);
  step(
    'red-wrong-host-helper',
    !assertObserverTarget({
      host: 'not-sunset.example',
      database: 'sunset_staging',
      tlsOk: true,
    }).ok,
  );
  step(
    'red-writable-session-helper',
    !assertReadOnlySession({
      transaction_read_only: 'off',
      application_name: APPLICATION_NAME,
      statement_timeout: '30s',
      lock_timeout: '5s',
    }).ok,
  );
  const leakDsn = 'postgresql://u:p@host/db';
  step('red-secret-leak-helper', assertNoLeakedDsn(`out ${leakDsn}`, leakDsn).length > 0);
  step(
    'green-match-secret-free',
    matchJson ? assertNoLeakedDsn(JSON.stringify(matchJson), dsnHost).length === 0 : false,
  );

  report.ok = report.steps.every((s) => s.ok);
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  cleanup();
  // Drop password from process env if present
  delete process.env[OBSERVER_DSN_ENV];
  console.log(`\n── prove:sunset-schema-observer-local ${report.ok ? 'PASSED' : 'FAILED'} ──`);
  console.log(`report: ${REPORT_PATH}`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  cleanup();
  console.error(e);
  report.ok = false;
  report.error = String(e && e.message ? e.message : e).slice(0, 500);
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  } catch (_) { /* ignore */ }
  process.exit(1);
});
