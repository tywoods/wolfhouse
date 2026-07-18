'use strict';

/**
 * prove-sunset-schema-observer-local — FOUNDATION Slice 6
 *
 * Local-only proof:
 *  1) build Dockerfile.luna-sunset-staff-api
 *  2) disposable PG + canonical 36 migrations
 *  3) dedicated non-superuser observer role (least privilege) → MATCH exit 0
 *  4) prove INSERT/UPDATE/CREATE fail for that role
 *  5) mutate table + enum → drift exit 4
 *  6) wrong target / stacked SQL / secret leak fail-closed
 *  7) cleanup containers, volumes, credentials
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
  EXPECTED_HOST,
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
const OBS_ROLE = `wh_obs_ro_${suffix}`;
const OBS_PASS = crypto.randomBytes(18).toString('base64url');
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

function runObserverInImage(dsn) {
  const args = [
    'run', '--rm',
    '--network', NET,
    '-e', `${OBSERVER_DSN_ENV}=${dsn}`,
    IMAGE,
    'node', 'scripts/observe-sunset-schema-drift.js',
    '--allow-local-ephemeral',
    '--contract', '/app/fixtures/sunset-schema-observer/expected-product-schema.json',
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

async function createRestrictedObserverRole(adminConn) {
  const c = new Client(adminConn);
  await c.connect();
  await c.query(`
    CREATE ROLE ${OBS_ROLE} LOGIN PASSWORD '${OBS_PASS}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION
  `);
  await c.query(`GRANT CONNECT ON DATABASE ${DB} TO ${OBS_ROLE}`);
  await c.query(`GRANT USAGE ON SCHEMA public TO ${OBS_ROLE}`);
  // Catalog introspection only — no DML grants on product tables.
  await c.query(`ALTER ROLE ${OBS_ROLE} SET default_transaction_read_only = on`);
  const superCheck = await c.query(
    `SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = $1`,
    [OBS_ROLE],
  );
  await c.end();
  const row = superCheck.rows[0];
  return {
    ok: row && row.rolsuper === false && row.rolcreaterole === false && row.rolcreatedb === false,
    row,
  };
}

async function proveRoleCannotMutate(obsConn) {
  // Bypass role default_transaction_read_only so we prove privilege denial, not only session RO.
  const c = new Client({
    ...obsConn,
    options: '-c default_transaction_read_only=off',
  });
  await c.connect();
  const results = {};
  try {
    await c.query('INSERT INTO bookings DEFAULT VALUES');
    results.insert = { ok: false, detail: 'insert unexpectedly succeeded' };
  } catch (e) {
    const msg = String(e.message || e);
    results.insert = {
      ok: /permission denied|insufficient privilege|must be owner/i.test(msg),
      detail: msg.slice(0, 160),
    };
  }
  try {
    await c.query('UPDATE bookings SET id = id WHERE false');
    results.update = { ok: false, detail: 'update unexpectedly succeeded' };
  } catch (e) {
    const msg = String(e.message || e);
    results.update = {
      ok: /permission denied|insufficient privilege|must be owner/i.test(msg),
      detail: msg.slice(0, 160),
    };
  }
  try {
    await c.query('CREATE TABLE wh_obs_should_fail (id int)');
    results.create = { ok: false, detail: 'create unexpectedly succeeded' };
  } catch (e) {
    const msg = String(e.message || e);
    results.create = {
      ok: /permission denied|insufficient privilege|must be owner/i.test(msg),
      detail: msg.slice(0, 160),
    };
  }
  await c.end();
  return results;
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

  const role = await createRestrictedObserverRole(conn);
  step('restricted-role-nonsuperuser', role.ok, JSON.stringify(role.row));

  const obsConn = {
    host: '127.0.0.1',
    port: hostPort,
    user: OBS_ROLE,
    password: OBS_PASS,
    database: DB,
  };
  const mut = await proveRoleCannotMutate(obsConn);
  step('role-insert-denied', mut.insert.ok, mut.insert.detail);
  step('role-update-denied', mut.update.ok, mut.update.detail);
  step('role-create-denied', mut.create.ok, mut.create.detail);

  const dsnHost = 'postgresql://'
    + encodeURIComponent(OBS_ROLE)
    + ':'
    + encodeURIComponent(OBS_PASS)
    + '@'
    + 'obs-pg'
    + ':5432/'
    + DB;
  const matchRun = runObserverInImage(dsnHost);
  const matchJson = parseObserverJson(matchRun.stdout);
  const matchOk = matchRun.status === 0 && matchJson && matchJson.ok === true && matchJson.match === true;
  step('observer-match-as-restricted-role', matchOk, `status=${matchRun.status} match=${matchJson && matchJson.match}`);
  report.match = matchJson;

  // Table drift (as bootstrap — observer role cannot DDL)
  {
    const c = new Client(conn);
    await c.connect();
    await c.query('CREATE TABLE wh_observer_drift_probe (id int PRIMARY KEY)');
    await c.end();
  }
  const tableDrift = runObserverInImage(dsnHost);
  const tableJson = parseObserverJson(tableDrift.stdout);
  step(
    'observer-table-drift-exit-4',
    tableDrift.status === 4
      && tableJson
      && tableJson.ok === false
      && Number(tableJson.drift && tableJson.drift.counts && tableJson.drift.counts.live_only) >= 1,
    `status=${tableDrift.status} live_only=${tableJson && tableJson.drift && tableJson.drift.counts && tableJson.drift.counts.live_only}`,
  );

  // Reset table drift then enum drift
  {
    const c = new Client(conn);
    await c.connect();
    await c.query('DROP TABLE IF EXISTS wh_observer_drift_probe');
    // Enum label/order drift: add a new label (changes enum set)
    await c.query("ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'wh_obs_enum_drift'");
    await c.end();
  }
  const enumDrift = runObserverInImage(dsnHost);
  const enumJson = parseObserverJson(enumDrift.stdout);
  const enumMismatch = enumJson
    && Array.isArray(enumJson.drift && enumJson.drift.sample)
    && enumJson.drift.sample.some((d) => d.section === 'enums');
  step(
    'observer-enum-drift-exit-4',
    enumDrift.status === 4 && enumJson && enumJson.ok === false && (
      Number(enumJson.drift.counts.live_only) >= 1
      || Number(enumJson.drift.counts.definition_mismatch) >= 1
      || enumMismatch
    ),
    `status=${enumDrift.status} counts=${JSON.stringify(enumJson && enumJson.drift && enumJson.drift.counts)}`,
  );
  report.enumDrift = enumJson;

  const wrongDsn = 'postgresql://'
    + encodeURIComponent(OBS_ROLE)
    + ':'
    + encodeURIComponent(OBS_PASS)
    + '@'
    + 'obs-pg'
    + ':5432/'
    + 'postgres';
  const wrong = runObserverInImage(wrongDsn);
  const wrongJson = parseObserverJson(wrong.stdout);
  step(
    'red-wrong-target-cli',
    wrong.status !== 0 && wrongJson && (wrongJson.code === 'wrong_target' || (wrongJson.errors || []).length),
    `status=${wrong.status} code=${wrongJson && wrongJson.code}`,
  );

  step('red-stacked-sql-helper', !assertSqlAllowed('SELECT 1; SELECT 2').ok);
  step(
    'red-wrong-host-helper',
    !assertObserverTarget({
      host: 'not-sunset.example',
      database: 'sunset_staging',
      sslmode: 'verify-full',
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
  const leakDsn = 'postgresql://' + 'u' + ':' + 'p' + '@' + 'host' + '/' + 'db';
  step('red-secret-leak-helper', assertNoLeakedDsn(`out ${leakDsn}`, leakDsn).length > 0);
  step(
    'green-match-secret-free',
    matchJson ? assertNoLeakedDsn(JSON.stringify(matchJson), dsnHost).length === 0 : false,
  );
  step(
    'green-match-used-restricted-role',
    Boolean(matchJson) && !String(dsnHost).includes(USER),
  );
  void EXPECTED_HOST;

  report.ok = report.steps.every((s) => s.ok);
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  cleanup();
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
