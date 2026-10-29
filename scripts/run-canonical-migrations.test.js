'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runCanonicalMigrations,
  assertWolfhouseProdFreshEmptyTarget,
  probeFreshWolfhouseProd,
} = require('./run-canonical-migrations');

const PROD = {
  host: '178.33.91.59',
  port: 5432,
  user: 'wolfhouse',
  password: 'x',
  database: 'wolfhouse_prod',
};

function fakeClient({ empty = true } = {}) {
  return {
    async connect() {},
    async end() {},
    async query(sql) {
      const text = String(sql);
      if (/to_regclass/.test(text)) {
        return {
          rows: [{
            ledger_exists: false,
            ledger_rows: 0,
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

test('fresh-empty probe refuses a non-empty wolfhouse_prod catalog', async () => {
  const fresh = await probeFreshWolfhouseProd(fakeClient({ empty: false }));
  assert.equal(fresh.ok, false);
  assert.ok(fresh.errors.some((e) => e.code === 'wolfhouse_prod_not_empty'));
});

test('fresh-empty probe accepts an empty catalog', async () => {
  const fresh = await probeFreshWolfhouseProd(fakeClient({ empty: true }));
  assert.equal(fresh.ok, true);
});

test('fresh-empty flag selects wolfhouse_prod_fresh_empty safety mode', async () => {
  const result = await runCanonicalMigrations({
    connection: PROD,
    allowWolfhouseProdFreshEmptyApply: true,
    dryRun: true,
    client: fakeClient(),
    advisoryLockHeld: true,
  });
  assert.equal(result.safetyMode, 'wolfhouse_prod_fresh_empty');
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
