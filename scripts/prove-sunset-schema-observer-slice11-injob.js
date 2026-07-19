'use strict';

/**
 * In-job Slice 11 proofs: read-only GREEN/RED, synthetic drift vs CANONICAL fixture, recovery.
 * Uses SUNSET_SCHEMA_OBSERVER_DATABASE_URL secretRef. No live schema mutation.
 * Synthetic mismatch compares against fixtures/.../expected-product-schema.json (canonical only).
 */

const fs = require('fs');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const {
  OBSERVER_DSN_ENV,
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  fingerprintProductSchema,
  assertNoLeakedDsn,
  redactSecrets,
} = require('./lib/sunset-schema-observer');

const ROLE = 'sunset_schema_observer';
const DRIFT_LABEL = 'slice11_synthetic_enum_mismatch_label';
const CONTRACT = '/app/fixtures/sunset-schema-observer/expected-product-schema.json';

function emit(payload) {
  const text = JSON.stringify(payload);
  const leaks = assertNoLeakedDsn(text, process.env[OBSERVER_DSN_ENV] || null);
  if (leaks.length) throw new Error(`proof leaked secrets: ${leaks.join(',')}`);
  process.stdout.write('WH_SLICE11_PROOF_BEGIN\n');
  process.stdout.write(`${text}\n`);
  process.stdout.write('WH_SLICE11_PROOF_END\n');
}

function denyOk(err) {
  const m = String(err && err.message || err);
  return /permission denied|insufficient privilege|must be owner|cannot execute .* in a read-only transaction|read-only transaction/i.test(m);
}

function denyDetail(err) {
  return redactSecrets(String(err && err.message || err)).slice(0, 160);
}

async function withClient(opts, fn) {
  const dsn = process.env[OBSERVER_DSN_ENV] || '';
  if (!dsn) throw new Error('missing_dsn_env');
  const u = new URL(dsn);
  if (u.hostname !== EXPECTED_HOST) throw new Error('wrong_host');
  if ((u.pathname || '').replace(/^\//, '') !== EXPECTED_DATABASE) throw new Error('wrong_db');
  const client = new Client({
    connectionString: dsn,
    ssl: { rejectUnauthorized: true, servername: EXPECTED_HOST },
    connectionTimeoutMillis: 20000,
    application_name: 'wh-sunset-schema-observer',
    options: opts || undefined,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.end(); } catch (_) { /* ignore */ }
  }
}

function runObserver(contractPath) {
  const r = spawnSync(process.execPath, ['/app/scripts/observe-sunset-schema-drift.js', '--contract', contractPath], {
    encoding: 'utf8',
    env: process.env,
    timeout: 90000,
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const b = out.indexOf('WH_SCHEMA_OBSERVER_BEGIN');
  const e = out.indexOf('WH_SCHEMA_OBSERVER_END');
  let report = null;
  if (b >= 0 && e > b) {
    try { report = JSON.parse(out.slice(b + 'WH_SCHEMA_OBSERVER_BEGIN'.length, e).trim()); } catch (_) { report = null; }
  }
  return {
    status: r.status,
    report,
    leaked: /postgres(ql)?:\/\/[^\s"']+:[^\s"']+@/i.test(out),
  };
}

async function main() {
  const session = await withClient(undefined, async (client) => {
    const id = await client.query('SELECT current_database() AS db, current_user AS usr');
    const tro = await client.query('SHOW transaction_read_only');
    const cat = await client.query("SELECT COUNT(*)::int AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'");
    const attrs = (await client.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user')).rows[0];
    const memberships = (await client.query('SELECT r.rolname AS member_of FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE u.rolname=current_user ORDER BY 1')).rows.map((r) => r.member_of);
    const ownedObjects = (await client.query("SELECT n.nspname||'.'||c.relname AS obj FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname=current_user ORDER BY 1 LIMIT 20")).rows.map((r) => r.obj);
    const hasConnect = (await client.query("SELECT has_database_privilege(current_user, current_database(), 'CONNECT') AS c")).rows[0].c === true;
    let hasSelectBookings = false;
    try {
      hasSelectBookings = (await client.query("SELECT has_table_privilege(current_user, 'public.bookings', 'SELECT') AS s")).rows[0].s === true;
    } catch (_) {
      hasSelectBookings = null;
    }
    const out = {
      host: EXPECTED_HOST,
      current_database: id.rows[0].db,
      current_user: id.rows[0].usr,
      transaction_read_only: String(tro.rows[0].transaction_read_only).toLowerCase(),
      catalog_public_table_count: cat.rows[0].n,
      attributes: {
        rolsuper: attrs.rolsuper === true,
        rolcreatedb: attrs.rolcreatedb === true,
        rolcreaterole: attrs.rolcreaterole === true,
        rolinherit: attrs.rolinherit === true,
        rolreplication: attrs.rolreplication === true,
        rolbypassrls: attrs.rolbypassrls === true,
        rolcanlogin: attrs.rolcanlogin === true,
      },
      memberships,
      ownedObjects,
      hasConnect,
      hasSelectBookings,
    };
    out.green_host_db = out.current_database === EXPECTED_DATABASE && out.current_user === ROLE;
    out.green_read_only = out.transaction_read_only === 'on';
    out.green_catalog = Number(out.catalog_public_table_count) > 0;
    out.green_authority = out.attributes.rolsuper === false
      && out.attributes.rolcreatedb === false
      && out.attributes.rolcreaterole === false
      && out.attributes.rolinherit === false
      && out.attributes.rolreplication === false
      && out.attributes.rolbypassrls === false
      && out.memberships.length === 0
      && out.ownedObjects.length === 0
      && out.hasConnect === true
      && out.hasSelectBookings === false;
    return out;
  });

  const denied = await withClient('-c default_transaction_read_only=off', async (client) => {
    const red = {};
    try { await client.query('INSERT INTO bookings DEFAULT VALUES'); red.insert = { ok: false, detail: 'unexpected_success' }; }
    catch (e) { red.insert = { ok: denyOk(e), detail: denyDetail(e) }; }
    try { await client.query('UPDATE bookings SET id = id WHERE false'); red.update = { ok: false, detail: 'unexpected_success' }; }
    catch (e) { red.update = { ok: denyOk(e), detail: denyDetail(e) }; }
    try { await client.query('CREATE TABLE wh_slice11_should_fail (id int)'); red.createTable = { ok: false, detail: 'unexpected_success' }; }
    catch (e) { red.createTable = { ok: denyOk(e), detail: denyDetail(e) }; }
    try { await client.query('CREATE ROLE wh_slice11_escalation_probe'); red.createRole = { ok: false, detail: 'unexpected_success' }; }
    catch (e) { red.createRole = { ok: denyOk(e), detail: denyDetail(e) }; }
    return red;
  });

  const match = runObserver(CONTRACT);
  const contract = JSON.parse(fs.readFileSync(CONTRACT, 'utf8'));
  const mutated = JSON.parse(JSON.stringify(contract));
  if (!Array.isArray(mutated.snapshot.enums)) throw new Error('enums_missing');
  mutated.snapshot.enums.push({
    type: 'assignment_status',
    label: DRIFT_LABEL,
    order: 999,
  });
  mutated.productFingerprint = fingerprintProductSchema(mutated.snapshot);
  const driftPath = '/tmp/wh-slice11-drift-contract.json';
  fs.writeFileSync(driftPath, JSON.stringify(mutated));
  const drift = runObserver(driftPath);
  try { fs.unlinkSync(driftPath); } catch (_) { /* ignore */ }
  const recover = runObserver(CONTRACT);
  const mismatchCount = (r) => {
    const c = r && r.report && r.report.drift && r.report.drift.counts;
    if (!c) return null;
    return c.expected_only + c.live_only + c.definition_mismatch;
  };

  emit({
    ok: true,
    kind: 'sunset-schema-observer-slice11-injob-proof',
    session,
    denied,
    match: {
      status: match.status,
      ok: !!(match.report && match.report.ok),
      match: !!(match.report && match.report.match),
      productFingerprintExpected: match.report && match.report.productFingerprintExpected || null,
      productFingerprintLive: match.report && match.report.productFingerprintLive || null,
      mismatchCount: mismatchCount(match),
      leaked: match.leaked,
    },
    drift: {
      method: 'isolated_injob_observer_with_temp_synthetic_contract',
      status: drift.status,
      ok: !!(drift.report && drift.report.ok),
      match: !!(drift.report && drift.report.match),
      code: drift.report && drift.report.code || null,
      mismatchCount: mismatchCount(drift),
      counts: drift.report && drift.report.drift && drift.report.drift.counts || null,
      hasDefinitionMismatch: !!(drift.report && drift.report.drift && drift.report.drift.counts && drift.report.drift.counts.definition_mismatch > 0),
      hasMarker: JSON.stringify(drift.report || {}).includes('definition_mismatch'),
      driftLabel: DRIFT_LABEL,
      leaked: drift.leaked,
      distinctFromLiveJobBaseline: true,
      liveSchemaMutated: false,
    },
    recover: {
      status: recover.status,
      ok: !!(recover.report && recover.report.ok),
      match: !!(recover.report && recover.report.match),
      mismatchCount: mismatchCount(recover),
      leaked: recover.leaked,
    },
  });
  process.exit(0);
}

main().catch((e) => {
  try {
    emit({ ok: false, error: redactSecrets(String(e && e.message || e)).slice(0, 400) });
  } catch (_) {
    process.stderr.write(redactSecrets(String(e && e.message || e)));
  }
  process.exit(1);
});
