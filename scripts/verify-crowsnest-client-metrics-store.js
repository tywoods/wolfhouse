'use strict';

/**
 * Deterministic verifier for the Crowsnest client-metrics store (Pupil slice 1).
 * Pure offline checks — no network, no real DB. Exercises the memory + fail_closed
 * backends and the fail-soft Spyglass reader.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-client-metrics-store.js');
const FIXTURE = path.join(ROOT, 'fixtures', 'crowsnest-client-metrics', 'valid-measured.json');

const store = require(STORE_PATH);

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); }
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
  const pg = store.createPostgresRepository({ pool: fakePool });
  ok('postgres: backend label is postgres', pg.backend === 'postgres');
  const pgPut = await pg.putSnapshot(valid);
  ok('postgres: valid snapshot put ok', pgPut.ok === true);
  ok('postgres: ensures schema + table before write', calls.some((c) => /CREATE SCHEMA IF NOT EXISTS crowsnest_metrics/.test(c.sql)) && calls.some((c) => /CREATE TABLE IF NOT EXISTS crowsnest_metrics\.client_metrics_snapshots/.test(c.sql)));
  ok('postgres: upsert is latest-wins on conflict', calls.some((c) => /INSERT INTO crowsnest_metrics\.client_metrics_snapshots/.test(c.sql) && /ON CONFLICT \(client_slug\) DO UPDATE/.test(c.sql) && /EXCLUDED\.captured_at >=/.test(c.sql)));
  const pgAll = await pg.getAllLatest();
  ok('postgres: getAllLatest maps rows to events', Array.isArray(pgAll) && pgAll[0] && pgAll[0].snapshot_id === valid.snapshot_id);

  // Invalid event is rejected BEFORE any DB call.
  const callsBefore = calls.length;
  const pgBad = await pg.putSnapshot({ schema_version: 'nope' });
  ok('postgres: invalid event rejected without touching the pool', pgBad.ok === false && calls.length === callsBefore);

  // createRepository routes a DSN-configured env to the postgres backend.
  ok('createRepository(DSN) => postgres backend', store.createRepository({ CROWSNEST_METRICS_DATABASE_URL: 'postgres://x' }).backend === 'postgres');

  console.log(`\n── verify:crowsnest-client-metrics-store: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) { console.error('verify:crowsnest-client-metrics-store — FAILURES'); process.exit(1); }
  console.log('verify:crowsnest-client-metrics-store — ALL CHECKS PASSED');
})().catch((err) => { console.error(err); process.exit(1); });
