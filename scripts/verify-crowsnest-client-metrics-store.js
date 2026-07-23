'use strict';

/**
 * Deterministic verifier for the Crowsnest client-metrics store (Pupil).
 * Pure offline checks — no network, no real DB. Exercises memory + fail_closed
 * + postgres (mocked pool) backends, fail-soft Spyglass reader, and migration 048.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-client-metrics-store.js');
const FIXTURE = path.join(ROOT, 'fixtures', 'crowsnest-client-metrics', 'valid-measured.json');
const MIGRATION_REL = 'database/migrations/048_crowsnest_metrics_client_metrics_snapshots.sql';
const MIGRATION_PATH = path.join(ROOT, MIGRATION_REL);
const MANIFEST_PATH = path.join(ROOT, 'database', 'migrations', 'canonical-manifest.json');

const {
  sha256CanonicalLfV1File,
  forwardEntries,
  loadManifest,
} = require('./lib/migration-integrity');

const store = require(STORE_PATH);

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name, detail ? `— ${detail}` : ''); }
}

function isDdlSql(sql) {
  return /\bCREATE\s+(SCHEMA|TABLE)\b/i.test(String(sql || ''));
}

(async () => {
  ok('store module exists', fs.existsSync(STORE_PATH));
  // Must never READ the tenant DB env (mentioning it in a comment is fine; accessing it is not).
  const storeSrc = fs.readFileSync(STORE_PATH, 'utf8');
  ok('never accesses WOLFHOUSE_DATABASE_URL / DATABASE_URL', !/(?:process\.env|env)\s*(?:\.\s*|\[\s*['"])\s*(?:WOLFHOUSE_DATABASE_URL|DATABASE_URL)\b/.test(storeSrc));

  // Backend selection
  ok('no DSN + non-prod => memory', store.resolveBackend({ NODE_ENV: 'development' }) === 'memory');
  ok('no DSN + production => fail_closed', store.resolveBackend({ NODE_ENV: 'production' }) === 'fail_closed');
  ok('DSN present => postgres (reserved)', store.resolveBackend({ CROWSNEST_METRICS_DATABASE_URL: 'postgres://x' }) === 'postgres');

  // Memory backend round-trip
  const mem = store.createMemoryRepository();
  const valid = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const put = await mem.putSnapshot(valid);
  ok('memory: valid snapshot accepted', put.ok === true);
  const got = await mem.getLatest(valid.client_slug);
  ok('memory: getLatest returns the snapshot', got && got.snapshot_id === valid.snapshot_id);
  ok('memory: getAllLatest includes it', (await mem.getAllLatest()).length === 1);

  // Contract is enforced on put
  const bad = await mem.putSnapshot({ schema_version: 'wrong', client_slug: 'x' });
  ok('memory: invalid snapshot rejected with errors', bad.ok === false && Array.isArray(bad.errors) && bad.errors.length > 0);

  // Latest-wins by captured_at
  const older = { ...valid, snapshot_id: 'snap_older', captured_at: '2026-07-22T14:00:00.000Z' };
  const newer = { ...valid, snapshot_id: 'snap_newer', captured_at: '2026-07-22T16:00:00.000Z' };
  await mem.putSnapshot(older);
  await mem.putSnapshot(newer);
  ok('memory: newer captured_at wins', (await mem.getLatest(valid.client_slug)).snapshot_id === 'snap_newer');

  // Fail-closed backend: reads empty (never throws), writes rejected
  const fc = store.createFailClosedRepository();
  ok('fail_closed: getAllLatest is empty (honest "not reporting yet")', (await fc.getAllLatest()).length === 0);
  ok('fail_closed: getLatest is null', (await fc.getLatest('wolfhouse-somo')) === null);
  const fcPut = await fc.putSnapshot(valid);
  ok('fail_closed: put rejected as misconfigured', fcPut.ok === false && fcPut.code === 'client_metrics_store_misconfigured');

  // Spyglass reader is fail-soft: returns a plain map, never throws
  store._resetRepositoryForTests();
  const prodMap = await store.getSpyglassClientMetricsMap({ NODE_ENV: 'production' }); // fail_closed
  ok('reader (prod/no DSN) yields empty map', prodMap && Object.keys(prodMap).length === 0);

  // Postgres backend — exercised with an injected mock pool (no real DB).
  // Runtime DDL is strict opt-in: autoCreateSchema === true AND non-production.
  // Default / unset NODE_ENV (Azure candidate) must emit no CREATE.
  const defaultCalls = [];
  const defaultPool = {
    query: async (sql, params) => {
      defaultCalls.push({ sql: String(sql), params });
      return { rows: [] };
    },
  };
  const pgDefault = store.createPostgresRepository({
    pool: defaultPool,
    env: { CROWSNEST_METRICS_DATABASE_URL: 'postgres://x' }, // NODE_ENV unset
  });
  await pgDefault.putSnapshot(valid);
  ok(
    'postgres unset env/default: never emits CREATE SCHEMA/TABLE',
    !defaultCalls.some((c) => isDdlSql(c.sql)),
    defaultCalls.map((c) => c.sql.split('\n')[0]).join(' | '),
  );
  ok(
    'postgres unset env/default: upsert still runs without DDL',
    defaultCalls.some((c) => /INSERT INTO crowsnest_metrics\.client_metrics_snapshots/.test(c.sql)),
  );

  const falseCalls = [];
  const falsePool = {
    query: async (sql, params) => {
      falseCalls.push({ sql: String(sql), params });
      return { rows: [] };
    },
  };
  const pgFalse = store.createPostgresRepository({
    pool: falsePool,
    env: { NODE_ENV: 'development', CROWSNEST_METRICS_DATABASE_URL: 'postgres://x' },
    autoCreateSchema: false,
  });
  await pgFalse.putSnapshot(valid);
  ok(
    'postgres non-prod autoCreateSchema:false: never emits CREATE',
    !falseCalls.some((c) => isDdlSql(c.sql)),
  );

  const calls = [];
  const fakePool = {
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      if (/^\s*SELECT event FROM/i.test(sql)) {
        // getLatest has a WHERE $1; getAllLatest does not
        return { rows: params ? [{ event: valid }] : [{ event: valid }] };
      }
      return { rows: [] }; // CREATE SCHEMA / CREATE TABLE / INSERT
    },
  };
  const pg = store.createPostgresRepository({
    pool: fakePool,
    env: { NODE_ENV: 'development', CROWSNEST_METRICS_DATABASE_URL: 'postgres://x' },
    autoCreateSchema: true,
  });
  ok('postgres: backend label is postgres', pg.backend === 'postgres');
  const pgPut = await pg.putSnapshot(valid);
  ok('postgres: valid snapshot put ok', pgPut.ok === true);
  ok(
    'postgres explicit non-prod autoCreate:true: ensures schema + table before write',
    calls.some((c) => /CREATE SCHEMA IF NOT EXISTS crowsnest_metrics/.test(c.sql))
      && calls.some((c) => /CREATE TABLE IF NOT EXISTS crowsnest_metrics\.client_metrics_snapshots/.test(c.sql)),
  );
  // Explicit test env + true is the other local-opt-in path.
  const testCalls = [];
  const testPool = {
    query: async (sql, params) => {
      testCalls.push({ sql: String(sql), params });
      return { rows: [] };
    },
  };
  const pgTest = store.createPostgresRepository({
    pool: testPool,
    env: { NODE_ENV: 'test', CROWSNEST_METRICS_DATABASE_URL: 'postgres://x' },
    autoCreateSchema: true,
  });
  await pgTest.putSnapshot(valid);
  ok(
    'postgres explicit test autoCreate:true: emits CREATE SCHEMA/TABLE',
    testCalls.some((c) => isDdlSql(c.sql)),
  );
  ok('postgres: upsert is latest-wins on conflict', calls.some((c) => /INSERT INTO crowsnest_metrics\.client_metrics_snapshots/.test(c.sql) && /ON CONFLICT \(client_slug\) DO UPDATE/.test(c.sql) && /EXCLUDED\.captured_at >=/.test(c.sql)));
  const pgAll = await pg.getAllLatest();
  ok('postgres: getAllLatest maps rows to events', Array.isArray(pgAll) && pgAll[0] && pgAll[0].snapshot_id === valid.snapshot_id);

  // Invalid event is rejected BEFORE any DB call.
  const callsBefore = calls.length;
  const pgBad = await pg.putSnapshot({ schema_version: 'nope' });
  ok('postgres: invalid event rejected without touching the pool', pgBad.ok === false && calls.length === callsBefore);

  // createRepository routes a DSN-configured env to the postgres backend.
  ok('createRepository(DSN) => postgres backend', store.createRepository({ CROWSNEST_METRICS_DATABASE_URL: 'postgres://x' }).backend === 'postgres');

  // ── Production postgres: no runtime DDL (schema pre-provisioned by migration 048) ──
  const prodCalls = [];
  const prodPool = {
    query: async (sql, params) => {
      prodCalls.push({ sql: String(sql), params });
      if (/^\s*SELECT event FROM/i.test(sql)) return { rows: [{ event: valid }] };
      return { rows: [] };
    },
  };
  const pgProd = store.createPostgresRepository({
    pool: prodPool,
    env: { NODE_ENV: 'production', CROWSNEST_METRICS_DATABASE_URL: 'postgres://x' },
  });
  const prodPut = await pgProd.putSnapshot(valid);
  ok('postgres production: valid snapshot put ok', prodPut.ok === true);
  ok(
    'postgres production: never emits CREATE SCHEMA/TABLE (on write)',
    prodPut.ok === true && !prodCalls.some((c) => isDdlSql(c.sql)),
    prodCalls.map((c) => c.sql.split('\n')[0]).join(' | '),
  );
  ok(
    'postgres production: upsert still runs without DDL',
    prodCalls.some((c) => /INSERT INTO crowsnest_metrics\.client_metrics_snapshots/.test(c.sql)),
  );
  const prodReadCallsBefore = prodCalls.length;
  await pgProd.getAllLatest();
  ok(
    'postgres production: never emits CREATE SCHEMA/TABLE (on read)',
    !prodCalls.slice(prodReadCallsBefore).some((c) => isDdlSql(c.sql)),
  );
  // Even an explicit autoCreateSchema:true must not override production.
  const forcedCalls = [];
  const forcedPool = {
    query: async (sql, params) => {
      forcedCalls.push({ sql: String(sql), params });
      return { rows: [] };
    },
  };
  const pgForced = store.createPostgresRepository({
    pool: forcedPool,
    env: { NODE_ENV: 'production', CROWSNEST_METRICS_DATABASE_URL: 'postgres://x' },
    autoCreateSchema: true,
  });
  await pgForced.putSnapshot(valid);
  ok(
    'postgres production: autoCreateSchema cannot enable DDL',
    !forcedCalls.some((c) => isDdlSql(c.sql)),
  );

  // Missing / unusable table: fail closed — ingest-safe error; reads empty.
  const missingPool = {
    query: async () => {
      const err = new Error('relation "crowsnest_metrics.client_metrics_snapshots" does not exist');
      err.code = '42P01';
      throw err;
    },
  };
  const pgMissing = store.createPostgresRepository({
    pool: missingPool,
    env: { NODE_ENV: 'production', CROWSNEST_METRICS_DATABASE_URL: 'postgres://x' },
  });
  let threwOnPut = false;
  let missPut;
  try {
    missPut = await pgMissing.putSnapshot(valid);
  } catch {
    threwOnPut = true;
  }
  ok(
    'postgres missing table: put returns safe error (no throw)',
    !threwOnPut
      && missPut
      && missPut.ok === false
      && missPut.status === 503
      && missPut.code === 'client_metrics_store_unavailable',
  );
  let threwOnRead = false;
  let missAll;
  try {
    missAll = await pgMissing.getAllLatest();
  } catch {
    threwOnRead = true;
  }
  ok('postgres missing table: getAllLatest degrades to empty', !threwOnRead && Array.isArray(missAll) && missAll.length === 0);
  let threwOnLatest = false;
  let missOne;
  try {
    missOne = await pgMissing.getLatest(valid.client_slug);
  } catch {
    threwOnLatest = true;
  }
  ok('postgres missing table: getLatest degrades to null', !threwOnLatest && missOne === null);

  // ── Migration 048 + manifest ──
  ok('migration 048 exists', fs.existsSync(MIGRATION_PATH), MIGRATION_REL);
  const migSrc = fs.existsSync(MIGRATION_PATH) ? fs.readFileSync(MIGRATION_PATH, 'utf8') : '';
  ok('migration 048 creates crowsnest_metrics schema', /CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+crowsnest_metrics/i.test(migSrc));
  ok(
    'migration 048 creates client_metrics_snapshots',
    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+crowsnest_metrics\.client_metrics_snapshots/i.test(migSrc),
  );
  ok(
    'migration 048 does not hardcode staging role grants',
    !/\bGRANT\s+\w/i.test(migSrc) && !/crowsnest_sales_staging/i.test(migSrc) && !/\bTO\s+\w*staging\w*/i.test(migSrc),
  );
  ok('migration 048 is transactional', /\bBEGIN\b/.test(migSrc) && /\bCOMMIT\b/.test(migSrc));

  let manifest = null;
  try {
    manifest = loadManifest(MANIFEST_PATH);
  } catch (err) {
    ok('canonical manifest loads', false, String(err && err.message));
  }
  if (manifest) {
    const forwards = forwardEntries(manifest);
    const entry = manifest.entries.find((e) => e.filename === '048_crowsnest_metrics_client_metrics_snapshots.sql');
    ok('manifest includes 048_crowsnest_metrics_client_metrics_snapshots.sql', Boolean(entry));
    ok('048 is canonical_forward', entry && entry.classification === 'canonical_forward' && entry.inForwardChain === true);
    ok('048 order is 46', entry && entry.order === 46);
    if (entry && fs.existsSync(MIGRATION_PATH)) {
      const live = sha256CanonicalLfV1File(MIGRATION_PATH);
      ok('048 sha256 matches live file', entry.sha256 === live, `manifest=${entry.sha256} live=${live}`);
    }
    ok('forward count includes 050 (48)', forwards.length === 48, `forward=${forwards.length}`);
  }

  console.log(`\n── verify:crowsnest-client-metrics-store: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) { console.error('verify:crowsnest-client-metrics-store — FAILURES'); process.exit(1); }
  console.log('verify:crowsnest-client-metrics-store — ALL CHECKS PASSED');
})().catch((err) => { console.error(err); process.exit(1); });
