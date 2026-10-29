'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runCanonicalMigrations,
  assertWolfhouseProdFreshEmptyTarget,
  probeFreshWolfhouseProd,
  probeFreshSyntheticDatabase,
} = require('./run-canonical-migrations');

const PROD = {
  host: '178.33.91.59',
  port: 5432,
  user: 'wolfhouse',
  password: 'x',
  database: 'wolfhouse_prod',
};

function missingLedgerError() {
  const err = new Error('relation "schema_migration_ledger" does not exist');
  err.code = '42P01';
  return err;
}

function fakeClient(opts) {
  const options = opts || {};
  const empty = options.empty !== false;
  const sessionDb = options.sessionDb || 'wolfhouse_prod';
  const state = {
    ledgerCreated: false,
    queries: [],
    countedMissingLedger: 0,
  };
  const client = {
    state,
    async connect() {},
    async end() {},
    async query(sql) {
      const text = String(sql);
      state.queries.push(text);
      if (/current_database/i.test(text)) {
        return { rows: [{ database: sessionDb }] };
      }
      if (/to_regclass\('public\.schema_migration_ledger'\)/i.test(text) && !/COUNT\(\*\)/.test(text)) {
        return { rows: [{ ledger_exists: state.ledgerCreated }] };
      }
      if (/FROM\s+public\.schema_migration_ledger\b/i.test(text) || /FROM\s+schema_migration_ledger\b/i.test(text)) {
        if (!state.ledgerCreated) {
          state.countedMissingLedger += 1;
          throw missingLedgerError();
        }
        if (/COUNT\(\*\)/.test(text)) return { rows: [{ ledger_rows: 0 }] };
        return { rows: [] };
      }
      if (/CREATE TABLE IF NOT EXISTS schema_migration_ledger/i.test(text) || /CREATE TABLE IF NOT EXISTS public\.schema_migration_ledger/i.test(text)) {
        state.ledgerCreated = true;
        return { rows: [] };
      }
      if (/pg_namespace|pg_class|pg_proc|pg_type|pg_trigger/i.test(text)) {
        return {
          rows: [{
            user_schemas: 0,
            user_relations: empty ? 0 : 3,
            user_functions: 0,
            user_types: 0,
            user_triggers: 0,
          }],
        };
      }
      return { rows: [] };
    },
  };
  return client;
}

test('default runner still refuses wolfhouse_prod', async () => {
  const result = await runCanonicalMigrations({ connection: PROD, dryRun: true, client: fakeClient() });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'target_db_not_ephemeral' || e.code === 'target_host_not_loopback' || e.code === 'target_db_forbidden'));
});

test('fresh-empty flag refuses any other database', async () => {
  const result = await runCanonicalMigrations({
    connection: { ...PROD, database: 'wolfhouse_staging' },
    allowWolfhouseProdFreshEmptyApply: true,
    dryRun: true,
    client: fakeClient(),
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'wolfhouse_prod_database_mismatch'));
});

test('fresh-empty flag refuses sunset_staging', async () => {
  const result = await runCanonicalMigrations({
    connection: { ...PROD, database: 'sunset_staging', host: 'luna-sunset-staging-pg-app.postgres.database.azure.com' },
    allowWolfhouseProdFreshEmptyApply: true,
    dryRun: true,
    client: fakeClient(),
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'wolfhouse_prod_database_mismatch' || e.code === 'wolfhouse_prod_host_mismatch'));
});

test('fresh probe never SELECTs a missing ledger (no 42P01)', async () => {
  const client = fakeClient({ empty: true });
  const fresh = await probeFreshWolfhouseProd(client);
  assert.equal(fresh.ok, true);
  assert.equal(client.state.countedMissingLedger, 0);
  assert.equal(fresh.ledgerExists, false);
});

test('fresh-empty probe refuses a non-empty wolfhouse_prod catalog', async () => {
  const fresh = await probeFreshWolfhouseProd(fakeClient({ empty: false }));
  assert.equal(fresh.ok, false);
  assert.ok(fresh.errors.some((e) => e.code === 'wolfhouse_prod_not_empty'));
});

test('prod freshness stays mandatory even when skipFreshnessProbe is set', async () => {
  const result = await runCanonicalMigrations({
    connection: PROD,
    allowWolfhouseProdFreshEmptyApply: true,
    skipFreshnessProbe: true,
    dryRun: true,
    advisoryLockHeld: true,
    client: fakeClient({ empty: false }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'wolfhouse_prod_not_empty'));
});

test('injected client must execute against declared wolfhouse_prod', async () => {
  const result = await runCanonicalMigrations({
    connection: PROD,
    allowWolfhouseProdFreshEmptyApply: true,
    dryRun: true,
    advisoryLockHeld: true,
    client: fakeClient({ sessionDb: 'postgres' }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'session_database_mismatch'));
});

test('fresh-empty dry-run succeeds on a truly empty catalog without pre-creating the ledger', async () => {
  const client = fakeClient({ empty: true });
  const result = await runCanonicalMigrations({
    connection: PROD,
    allowWolfhouseProdFreshEmptyApply: true,
    dryRun: true,
    advisoryLockHeld: true,
    client,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.safetyMode, 'wolfhouse_prod_fresh_empty');
  assert.ok(result.applied.length > 0);
  assert.equal(client.state.countedMissingLedger, 0);
  assert.equal(client.state.ledgerCreated, true);
});

test('fresh-empty cannot combine with Sunset no-op', async () => {
  const result = await runCanonicalMigrations({
    connection: PROD,
    allowWolfhouseProdFreshEmptyApply: true,
    allowSunsetStagingCanonicalRunnerNoop: true,
    dryRun: true,
    client: fakeClient(),
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'conflicting_safety_capabilities'));
});

test('assertWolfhouseProdFreshEmptyTarget is database-narrow', () => {
  assert.equal(assertWolfhouseProdFreshEmptyTarget(PROD).ok, true);
  assert.equal(assertWolfhouseProdFreshEmptyTarget({ ...PROD, database: 'other' }).ok, false);
  assert.equal(assertWolfhouseProdFreshEmptyTarget({ ...PROD, host: 'azure.example' }).ok, false);
});

test('PGlite fresh probe does not 42P01 when the ledger table is absent', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    const fresh = await probeFreshSyntheticDatabase(db);
    assert.equal(fresh.ok, true);
    assert.equal(fresh.ledgerExists, false);
  } finally {
    await db.close();
  }
});
