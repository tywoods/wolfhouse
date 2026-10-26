'use strict';
// Offline only: real SQL in disposable in-memory PGlite; connection identity is mocked.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PGlite } = require('@electric-sql/pglite');
const integrity = require('./lib/migration-integrity');
const { RECOVERY_TARGET } = require('./lib/staging-ledger-recovery');
const SCRIPT = path.join(__dirname, 'apply-wolfhouse-test-migration110.js');
const ID = '110_staff_room_fill_create_receipts';
const base = () => ({ target: 'wolfhouse-staging', migration: '110', host: RECOVERY_TARGET.postgresHost,
  database: RECOVERY_TARGET.database, port: RECOVERY_TARGET.port });
const argv = () => ['--target', 'wolfhouse-staging', '--migration', '110', '--host', RECOVERY_TARGET.postgresHost,
  '--database', RECOVERY_TARGET.database, '--port', '5432'];
test('Wolfhouse migration110 remains locked to the shared host and Wolfhouse database', () => {
  assert.equal(RECOVERY_TARGET.postgresHost, 'luna-pg-shared.postgres.database.azure.com');
  assert.equal(RECOVERY_TARGET.database, 'wolfhouse_staging');
});
function owner() {
  assert.ok(fs.existsSync(SCRIPT), 'dedicated supported migration110 owner must exist');
  return require(SCRIPT);
}
let disposable;
test.after(async () => { if (disposable) await disposable.close(); });
async function fixture(t, options = {}) {
  owner(); // Fail RED before allocating SQL runtime if implementation is absent.
  if (!disposable) disposable = new PGlite();
  const db = disposable;
  // Reset only this in-memory test instance; never a network/database target.
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.exec("CREATE TABLE clients(id UUID PRIMARY KEY, slug TEXT NOT NULL UNIQUE); INSERT INTO clients VALUES ('a0000000-0000-4000-8000-000000000001', 'wolfhouse-somo');");
  if (!options.noLedger) {
    await db.exec(integrity.LEDGER_DDL);
    const e = integrity.loadManifest().entries.find(x => x.id === '042_luna_sales_schema');
    await db.query(`INSERT INTO schema_migration_ledger(id,filename,checksum_sha256,apply_order,apply_kind,checksum_mode,evidence_ref,provenance_notes)
      VALUES($1,$2,$3,$4,'executed_by_canonical_runner','canonical_lf_v1','offline_fixture','offline fixture, not live history')`,
    [e.id, e.filename, e.sha256, e.order]);
  }
  const queries = [], configs = [];
  class Client {
    constructor(config) { configs.push(config); }
    async connect() {}
    async end() {}
    async query(sql, params) {
      queries.push(sql);
      if (sql.includes('current_database()')) return { rows: [{ database: options.identity || RECOVERY_TARGET.database, port: 5432 }] };
      if (options.failInsert && /^INSERT INTO public.schema_migration_ledger/.test(sql)) throw new Error('injected ledger failure');
      if (sql.includes('CREATE TABLE IF NOT EXISTS staff_room_fill_create_receipts')) { await db.exec(sql); return { rows: [] }; }
      return db.query(sql, params);
    }
  }
  return { db, Client, queries, configs };
}
async function ledger(db) { return (await db.query('SELECT * FROM schema_migration_ledger ORDER BY apply_order')).rows; }
async function exists(db) { return (await db.query("SELECT to_regclass('public.staff_room_fill_create_receipts') AS name")).rows[0].name !== null; }

test('110 forward/down registered with canonical LF hashes; other entries untouched by selection', () => {
  const m = integrity.loadManifest();
  const forward = m.entries.find(x => x.id === ID);
  assert.ok(forward, '110 must be registered in canonical manifest');
  assert.equal(forward.classification, 'canonical_forward');
  assert.equal(forward.inForwardChain, true);
  assert.equal(forward.order, 104);
  const down = m.entries.find(x => x.id === ID + '_down');
  assert.equal(down.classification, 'rollback_down');
  assert.equal(down.inForwardChain, false);
  assert.equal(down.order, null);
  assert.equal(down.pairsWith, forward.filename);
  for (const e of [forward, down]) assert.equal(e.sha256, integrity.sha256CanonicalLfV1File(path.join(integrity.MIGRATIONS_DIR, e.filename)));
});

test('default dry run is offline, no credentials/client construction and plans only110', async () => {
  let constructed = 0;
  const result = await owner().runMigration110({ ...base(), Client: class { constructor() { constructed++; } } });
  assert.equal(constructed, 0);
  assert.equal(result.status, 'offline_plan');
  assert.deepEqual(result.wouldApply, [ID]);
  assert.deepEqual(result.applied, []);
  assert.equal(result.wholeDatabaseMigrated, false);
  assert.equal(result.ledgerChecked, false);
});

test('wrong target, prod, Sunset, migration, host, port and database refuse before client construction', async () => {
  for (const delta of [{ target: 'prod' }, { target: 'sunset-staging' }, { target: 'wolfhouse-test' },
    { migration: '109' }, { migration: ID + '_down' }, { host: 'localhost' },
    { host: 'wh-staging-pg-app.postgres.database.azure.com.attacker.invalid' },
    { database: 'wolfhouse' }, { database: 'sunset_staging' }, { port: 5433 }]) {
    let constructed = 0;
    await assert.rejects(owner().runMigration110({ ...base(), ...delta, apply: true,
      Client: class { constructor() { constructed++; } } }), /target|migration|port|host|database/);
    assert.equal(constructed, 0);
  }
});

test('strict CLI defaults dry run; refuses missing, duplicate, contradictory and arbitrary flags', () => {
  const o = owner();
  assert.equal(o.parseArgs(argv()).apply, false);
  assert.equal(o.parseArgs([...argv(), '--apply']).apply, true);
  for (const args of [[], [...argv(), '--force'], [...argv(), '--migration', '109'],
    [...argv(), '--apply', '--dry-run'], [...argv(), '--dsn', 'redacted'], [...argv(), '--host']]) {
    assert.throws(() => o.parseArgs(args));
  }
  const result = spawnSync(process.execPath, [SCRIPT, ...argv()], { encoding: 'utf8', env: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'offline_plan');
});

test('only110 DDL + ledger commit; preserves042 and sentinel, TLS pinned, repeat is exact no-op', async t => {
  const f = await fixture(t);
  await f.db.exec('CREATE TABLE backlog_sentinel(value TEXT); INSERT INTO backlog_sentinel VALUES(\'unchanged\');');
  const before = await ledger(f.db);
  const result = await owner().runMigration110({ ...base(), apply: true, Client: f.Client, user: 'offline', password: 'offline' });
  assert.deepEqual(result.applied, [ID]);
  assert.equal(result.wholeDatabaseMigrated, false);
  assert.equal(await exists(f.db), true);
  const after = await ledger(f.db);
  assert.deepEqual(after[0], before[0]);
  assert.deepEqual(after.map(x => x.id), ['042_luna_sales_schema', ID]);
  assert.match(after[1].provenance_notes, /single.*110|110.*only/);
  assert.equal(after[1].checksum_mode, 'canonical_lf_v1');
  assert.equal(after[1].applied_at.getTime(), after[1].ledger_recorded_at.getTime());
  assert.equal(f.configs[0].ssl.rejectUnauthorized, true);
  assert.equal(f.configs[0].ssl.servername, RECOVERY_TARGET.postgresHost);
  assert.equal(f.configs[0].host, RECOVERY_TARGET.postgresHost);
  assert.ok(f.queries.some(q => q.includes('pg_advisory_xact_lock')));
  const repeat = await owner().runMigration110({ ...base(), apply: true, Client: f.Client });
  assert.equal(repeat.status, 'already_applied');
  assert.deepEqual(repeat.applied, []);
  assert.deepEqual(await ledger(f.db), after);
  assert.equal(f.queries.filter(q => q.includes('CREATE TABLE IF NOT EXISTS staff_room_fill_create_receipts')).length, 1);
  assert.deepEqual((await f.db.query('SELECT * FROM backlog_sentinel')).rows, [{ value: 'unchanged' }]);
  assert.ok(!f.queries.some(q => /CREATE TABLE.*schema_migration_ledger|ALTER TABLE|DROP TABLE/.test(q)));
});

test('ledger insert failure rolls back receipt DDL and leaves042 untouched', async t => {
  const f = await fixture(t, { failInsert: true });
  const before = await ledger(f.db);
  await assert.rejects(owner().runMigration110({ ...base(), apply: true, Client: f.Client }), /injected ledger failure/);
  assert.equal(await exists(f.db), false);
  assert.deepEqual(await ledger(f.db), before);
  assert.ok(f.queries.includes('ROLLBACK'));
});

test('server-reported wrong database refuses before migration or ledger writes', async t => {
  const f = await fixture(t, { identity: 'sunset_staging' });
  await assert.rejects(owner().runMigration110({ ...base(), apply: true, Client: f.Client }), /identity/);
  assert.equal(await exists(f.db), false);
  assert.equal((await ledger(f.db)).length, 1);
});

test('missing ledger is never bootstrapped', async t => {
  const f = await fixture(t, { noLedger: true });
  await assert.rejects(owner().runMigration110({ ...base(), apply: true, Client: f.Client }), /ledger/);
  assert.equal(await exists(f.db), false);
  assert.equal((await f.db.query("SELECT to_regclass('public.schema_migration_ledger') AS name")).rows[0].name, null);
});

test('empty ledger is not treated as authorization to bootstrap', async t => {
  const f = await fixture(t);
  await f.db.exec('DELETE FROM schema_migration_ledger');
  await assert.rejects(owner().runMigration110({ ...base(), apply: true, Client: f.Client }), /ledger/);
  assert.equal(await exists(f.db), false);
});

test('unexpected ledger row is refused, no backlog recovery', async t => {
  const f = await fixture(t);
  await f.db.exec("UPDATE schema_migration_ledger SET id = 'unexpected'");
  await assert.rejects(owner().runMigration110({ ...base(), apply: true, Client: f.Client }), /ledger/);
  assert.equal(await exists(f.db), false);
});

test('ledger checksum mismatch refuses both042 and110', async t => {
  const f = await fixture(t);
  await owner().runMigration110({ ...base(), apply: true, Client: f.Client });
  for (const id of ['042_luna_sales_schema', ID]) {
    const before = await ledger(f.db);
    await f.db.query('UPDATE schema_migration_ledger SET checksum_sha256=$1 WHERE id=$2', ['0'.repeat(64), id]);
    await assert.rejects(owner().runMigration110({ ...base(), apply: true, Client: f.Client }), /ledger/);
    await f.db.query('UPDATE schema_migration_ledger SET checksum_sha256=$1 WHERE id=$2', [before.find(x => x.id === id).checksum_sha256, id]);
  }
});

test('preexisting unrecorded table refuses instead of claiming IF NOT EXISTS executed it', async t => {
  const f = await fixture(t);
  await f.db.exec('CREATE TABLE staff_room_fill_create_receipts(wrong TEXT)');
  await assert.rejects(owner().runMigration110({ ...base(), apply: true, Client: f.Client }), /unrecorded/);
  assert.equal((await ledger(f.db)).length, 1);
});

test('repeat refuses missing or drifted receipt schema', async t => {
  const f = await fixture(t);
  await owner().runMigration110({ ...base(), apply: true, Client: f.Client });
  await f.db.exec('ALTER TABLE staff_room_fill_create_receipts DROP CONSTRAINT staff_room_fill_create_receipts_pkey');
  await assert.rejects(owner().runMigration110({ ...base(), apply: true, Client: f.Client }), /receipt.*schema/);
  await f.db.exec('DROP TABLE staff_room_fill_create_receipts');
  await assert.rejects(owner().runMigration110({ ...base(), apply: true, Client: f.Client }), /receipt.*schema/);
});

test('on-disk SQL tamper and manifest hash/mode tamper refuse offline before connection', async () => {
  const original = fs.readFileSync;
  const mutations = [
    { file: `${ID}.sql`, change: value => Buffer.from(value.toString() + '\nSELECT 1;\n') },
    { file: 'canonical-manifest.json', change: value => {
      const m = JSON.parse(value.toString()); m.entries.find(e => e.id === ID).sha256 = '0'.repeat(64);
      return JSON.stringify(m);
    } },
    { file: 'canonical-manifest.json', change: value => {
      const m = JSON.parse(value.toString()); m.checksumMode = 'unknown'; return JSON.stringify(m);
    } },
  ];
  for (const mutation of mutations) {
    let constructed = 0;
    fs.readFileSync = function(file, ...args) {
      const value = original.call(this, file, ...args);
      return path.basename(String(file)) === mutation.file ? mutation.change(value) : value;
    };
    try {
      await assert.rejects(owner().runMigration110({ ...base(), apply: true,
        Client: class { constructor() { constructed++; } } }), /checksum/);
      assert.equal(constructed, 0);
    } finally { fs.readFileSync = original; }
  }
});

test('canonical LF accepts CRLF checkout without changing executed SQL semantics', async () => {
  const original = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    const value = original.call(this, file, ...args);
    return path.basename(String(file)) === `${ID}.sql` ? Buffer.from(value.toString().replace(/\r?\n/g, '\r\n')) : value;
  };
  try { assert.equal((await owner().runMigration110(base())).status, 'offline_plan'); }
  finally { fs.readFileSync = original; }
});

test('real SQL failure rolls back with no receipt or ledger110', async t => {
  const f = await fixture(t);
  const before = await ledger(f.db);
  await f.db.exec("CREATE FUNCTION reject110() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'offline ledger rejection'; END $$; CREATE TRIGGER reject110 BEFORE INSERT ON schema_migration_ledger FOR EACH ROW EXECUTE FUNCTION reject110();");
  await assert.rejects(owner().runMigration110({ ...base(), apply: true, Client: f.Client }), /offline ledger rejection/);
  assert.equal(await exists(f.db), false);
  assert.deepEqual(await ledger(f.db), before);
});

test('legacy ledger is not upgraded and incomplete provenance refuses', async t => {
  const f = await fixture(t);
  await f.db.exec('ALTER TABLE schema_migration_ledger DROP COLUMN evidence_ref');
  await assert.rejects(owner().runMigration110({ ...base(), apply: true, Client: f.Client }), /evidence_ref/);
  assert.equal(await exists(f.db), false);
  assert.ok(!f.queries.some(q => /ALTER TABLE/.test(q)));
});

test('bad provenance/order in existing042 refuses instead of silently repairing history', async t => {
  const f = await fixture(t);
  for (const update of ["apply_order=41", "apply_kind='verified_structural_baseline', checksum_mode='canonical_lf_v1', checksum_sha256='bad'"]) {
    await f.db.exec(`UPDATE schema_migration_ledger SET ${update}`);
    await assert.rejects(owner().runMigration110({ ...base(), apply: true, Client: f.Client }), /ledger/);
    assert.equal(await exists(f.db), false);
  }
});

test('CLI rejects arbitrary DSN arguments without disclosing supplied credential canaries', () => {
  owner();
  const secret = 'OFFLINE_CANARY_DO_NOT_PRINT';
  const result = spawnSync(process.execPath, [SCRIPT, ...argv(), '--apply', '--dsn', secret],
    { encoding: 'utf8', env: { WH_MIG_USER: secret, WH_MIG_PASSWORD: secret }, timeout: 5000 });
  assert.equal(result.status, 1);
  assert.ok(!(`${result.stdout}${result.stderr}`).includes(secret));
});

test('wrong tenant data refuses before DDL', async t => {
  const f = await fixture(t);
  await f.db.exec("UPDATE clients SET slug='sunset'");
  await assert.rejects(owner().runMigration110({ ...base(), apply: true, Client: f.Client }), /tenant/);
  assert.equal(await exists(f.db), false);
});
