'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  runCanonicalMigrations,
  applyOne,
  assertWolfhouseProdFreshEmptyTarget,
  probeFreshWolfhouseProd,
  probeFreshSyntheticDatabase,
  OLD_111_LEDGER_FINGERPRINT,
  old111LedgerFingerprint,
  exactOld111ManifestShape,
  transitionExactOld111Ledger,
} = require('./run-canonical-migrations');
const { loadManifest, forwardEntries } = require('./lib/migration-integrity');

test('applyOne resets migration-selected role before the runner-owned ledger insert', async () => {
  const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-role-reset-'));
  const filename = '999_role_switch.sql';
  const sql = 'BEGIN;\nSET LOCAL ROLE migration_owner;\nSELECT 1;\nCOMMIT;\n';
  fs.writeFileSync(path.join(migrationsDir, filename), sql);
  const calls = [];
  const client = {
    async query(text) {
      calls.push(String(text).trim());
      return { rows: [] };
    },
  };
  const entry = {
    id: '999_role_switch',
    filename,
    sha256: crypto.createHash('sha256').update(sql).digest('hex'),
    order: 999,
  };

  try {
    await applyOne(client, entry, migrationsDir, {}, 'canonical_lf_v1');
  } finally {
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  }

  const resetIndex = calls.indexOf('RESET ROLE');
  const insertIndex = calls.findIndex((query) => query.startsWith('INSERT INTO schema_migration_ledger'));
  assert.ok(resetIndex > calls.findIndex((query) => query.includes('SET LOCAL ROLE migration_owner')));
  assert.equal(resetIndex + 1, insertIndex, `expected RESET ROLE immediately before ledger insert:\n${calls.join('\n')}`);
});

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

test('old-111 transition is fingerprinted over identity, order, checksum, and provenance', () => {
  assert.match(OLD_111_LEDGER_FINGERPRINT, /^[0-9a-f]{64}$/);
  const row = {
    id: 'x', filename: 'x.sql', checksum_sha256: 'a'.repeat(64), apply_order: 1,
    apply_kind: 'verified_structural_baseline', checksum_mode: 'canonical_lf_v1',
    evidence_ref: 'e', provenance_notes: 'p', applied_at: '2026-01-01T00:00:00Z',
    ledger_recorded_at: '2026-01-01T00:00:00Z',
  };
  const base = old111LedgerFingerprint([row]);
  for (const key of ['id', 'filename', 'checksum_sha256', 'apply_order', 'apply_kind',
    'checksum_mode', 'evidence_ref', 'provenance_notes']) {
    assert.notEqual(old111LedgerFingerprint([{ ...row, [key]: `${row[key]}-drift` }]), base, key);
  }
});

function old111Fixture() {
  const forward = forwardEntries(loadManifest());
  assert.equal(exactOld111ManifestShape(forward), true);
  const omitted = new Set(['076_wolfhouse_pricing_admin', '111_room_selling_mode']);
  const rows = forward.filter((entry) => !omitted.has(entry.id)).map((entry) => ({
    id: entry.id,
    filename: entry.filename,
    checksum_sha256: entry.sha256,
    apply_order: entry.order - (entry.order > 99 ? 1 : 0) - (entry.order > 106 ? 1 : 0),
    applied_at: '2026-01-01T00:00:00Z',
    apply_kind: 'executed_by_canonical_runner',
    checksum_mode: 'canonical_lf_v1',
    evidence_ref: `canonical_runner:${entry.id}`,
    provenance_notes: `executed_by_canonical_runner via runCanonicalMigrations; checksumMode=canonical_lf_v1`,
    ledger_recorded_at: '2026-01-01T00:00:00Z',
  }));
  return { forward, rows };
}

function transitionClient(initialRows, corruptPost = false) {
  let rows = structuredClone(initialRows);
  let snapshot;
  const calls = [];
  return {
    calls,
    get rows() { return rows; },
    async query(sql, params) {
      const text = String(sql).trim();
      calls.push(text);
      if (text === 'BEGIN') { snapshot = structuredClone(rows); return { rows: [] }; }
      if (text === 'ROLLBACK') { rows = snapshot; return { rows: [] }; }
      if (text === 'COMMIT' || text === 'RESET ROLE') return { rows: [] };
      if (text === 'UPDATE schema_migration_ledger SET apply_order = -apply_order') {
        rows.forEach((row) => { row.apply_order = -row.apply_order; }); return { rows: [] };
      }
      if (text.startsWith('UPDATE schema_migration_ledger\n      SET apply_order = CASE')) {
        rows.forEach((row) => {
          const old = -row.apply_order;
          row.apply_order = old >= 105 ? old + 2 : old >= 99 ? old + 1 : old;
        });
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO schema_migration_ledger')) {
        rows.push({
          id: params[0], filename: params[1], checksum_sha256: params[2], apply_order: params[3],
          apply_kind: params[4], checksum_mode: params[5], evidence_ref: params[6],
          provenance_notes: params[7], applied_at: 'now', ledger_recorded_at: 'now',
        });
        return { rows: [] };
      }
      if (text.startsWith('SELECT id, filename, checksum_sha256')) {
        const selected = structuredClone(rows).sort((a, b) => a.apply_order - b.apply_order);
        if (corruptPost && selected.length === 113) selected[0].checksum_sha256 = '0'.repeat(64);
        return { rows: selected };
      }
      return { rows: [] }; // migration body
    },
  };
}

test('exact old-111 transition collision-safely shifts and executes 076+111 atomically', async () => {
  const { forward, rows } = old111Fixture();
  const client = transitionClient(rows);
  const fingerprint = old111LedgerFingerprint(rows);
  assert.equal(fingerprint, OLD_111_LEDGER_FINGERPRINT);
  assert.equal(await transitionExactOld111Ledger(
    client, forward, path.join(__dirname, '..', 'database', 'migrations'),
    'canonical_lf_v1', rows, fingerprint,
  ), true);
  assert.equal(client.rows.length, 113);
  assert.deepEqual(client.rows.sort((a, b) => a.apply_order - b.apply_order).map((r) => r.apply_order),
    Array.from({ length: 113 }, (_, index) => index + 1));
  assert.ok(client.calls.indexOf('BEGIN') < client.calls.indexOf('RESET ROLE'));
  assert.equal(client.calls.filter((q) => q.startsWith('INSERT INTO schema_migration_ledger')).length, 2);
  assert.equal(client.calls.at(-1), 'COMMIT');
});

test('old-111 transition rejects drift before BEGIN and rolls back failed post-reconcile', async () => {
  const { forward, rows } = old111Fixture();
  const rejected = transitionClient(rows);
  assert.equal(await transitionExactOld111Ledger(
    rejected, forward, path.join(__dirname, '..', 'database', 'migrations'),
    'canonical_lf_v1', rows, '0'.repeat(64),
  ), false);
  assert.equal(rejected.calls.length, 0);

  const failing = transitionClient(rows, true);
  await assert.rejects(() => transitionExactOld111Ledger(
    failing, forward, path.join(__dirname, '..', 'database', 'migrations'),
    'canonical_lf_v1', rows, old111LedgerFingerprint(rows),
  ), (error) => error.code === 'old_111_post_reconcile_failed');
  assert.equal(failing.calls.at(-1), 'ROLLBACK');
  assert.deepEqual(failing.rows, rows);
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

test('fresh canonical init then config contract SELECT includes max_guest_count', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { PGlite } = require('@electric-sql/pglite');
  const contract = require('./wolfhouse-prod-data/contract');

  const dry = await runCanonicalMigrations({
    connection: PROD,
    allowWolfhouseProdFreshEmptyApply: true,
    dryRun: true,
    advisoryLockHeld: true,
    client: fakeClient({ empty: true }),
  });
  assert.equal(dry.ok, true, JSON.stringify(dry.errors));
  assert.ok(dry.applied.includes('109_wh_transfer_max_guest_count'));

  const raw = new PGlite();
  try {
    await raw.exec(`
      CREATE TABLE wh_pricing_transfer_rules (
        id UUID PRIMARY KEY,
        client_slug TEXT NOT NULL,
        airport_code TEXT NOT NULL,
        label TEXT NOT NULL,
        aliases TEXT[] NOT NULL DEFAULT '{}',
        requires_package BOOLEAN NOT NULL DEFAULT false,
        included_when_package BOOLEAN NOT NULL DEFAULT false,
        min_guest_count INTEGER,
        active BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
    `);
    await assert.rejects(
      () => raw.query('SELECT max_guest_count FROM wh_pricing_transfer_rules LIMIT 0'),
      (err) => err && (err.code === '42703' || /max_guest_count/.test(String(err.message))),
    );
    const sql109 = fs.readFileSync(
      path.join(__dirname, '..', 'database', 'migrations', '109_wh_transfer_max_guest_count.sql'),
      'utf8',
    ).replace(/^\s*BEGIN\s*;/i, '').replace(/\s*COMMIT\s*;\s*$/i, '');
    await raw.exec(sql109);
    const cols = contract.SPEC.wh_pricing_transfer_rules.join(', ');
    await raw.query(`SELECT ${cols} FROM wh_pricing_transfer_rules LIMIT 0`);
  } finally {
    await raw.close();
  }
});
