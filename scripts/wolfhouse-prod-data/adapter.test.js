'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const contract = require('./contract');
const adapter = require('./adapter');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'fixtures', 'wolfhouse-prod-data', 'config-only.json');
const TARGET = {
  host: 'wolfhouse-prod-postgres',
  port: 5432,
  database: 'wolfhouse_prod',
  network: 'wolfhouse-prod-private',
  manifestId: 'wolfhouse-prod-data-v2026-10-28.3',
  mounts: { data: '/var/lib/wolfhouse-prod/data', backupSpool: '/var/lib/wolfhouse-prod/backup-spool' },
  backupDestination: 'azure://acct/container/object',
};

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

test('fixture is a valid config-only envelope with zero operational exports', () => {
  const envelope = loadFixture();
  contract.validate(envelope);
  for (const key of contract.COUNTS) {
    assert.equal(envelope.exportedCounts[key], 0);
    assert.equal(envelope.destinationCounts[key], 0);
  }
});

test('dry-run export never copies bookings/guests/chats and reports zero writes', () => {
  const envelope = loadFixture();
  const plan = adapter.dryRunExportFromEnvelope(envelope);
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.writes, 0);
  assert.equal(plan.readOnly, true);
  assert.equal(plan.exportedCounts.bookings, 0);
  assert.equal(plan.exportedCounts.guests, 0);
  assert.equal(plan.exportedCounts.messages, 0);
  assert.ok(plan.tables.rooms >= 1);
  assert.ok(plan.tables.wh_pricing_seasons >= 1);
});

test('dry-run import is idempotent planning and writes nothing', () => {
  const envelope = loadFixture();
  const first = adapter.dryRunImport(envelope, TARGET);
  const second = adapter.dryRunImport(envelope, TARGET);
  assert.equal(first.writes, 0);
  assert.deepEqual(first.wouldUpsert, second.wouldUpsert);
  assert.equal(first.wouldUpsert.clients, 1);
});

test('adapter refuses operational rows in an export envelope', () => {
  const envelope = loadFixture();
  envelope.exportedCounts.bookings = 1;
  assert.throws(() => adapter.dryRunExportFromEnvelope(envelope), /operational_row_exported|invalid_count_contract/);
});

test('TEST export path contains no write SQL', () => {
  assert.equal(adapter.sourceHasTestWrites(), false);
});

test('CLI dry-run export and import', () => {
  const targetFile = path.join(os.tmpdir(), 'wh-prod-target.json');
  fs.writeFileSync(targetFile, JSON.stringify(TARGET));
  const exp = spawnSync(process.execPath, [path.join(__dirname, 'adapter.js'), 'export', '--dry-run', '--fixture', FIXTURE], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  assert.equal(exp.status, 0, exp.stderr);
  const exportPlan = JSON.parse(exp.stdout);
  assert.equal(exportPlan.writes, 0);
  assert.equal(exportPlan.exportedCounts.bookings, 0);

  const imp = spawnSync(process.execPath, [
    path.join(__dirname, 'adapter.js'),
    'import',
    '--dry-run',
    '--envelope',
    FIXTURE,
    '--target',
    targetFile,
  ], { encoding: 'utf8', cwd: ROOT });
  assert.equal(imp.status, 0, imp.stderr);
  const importPlan = JSON.parse(imp.stdout);
  assert.equal(importPlan.writes, 0);
  assert.equal(importPlan.wouldUpsert.clients, 1);
});

test('apply import stays idempotent on the contract upsert path', async () => {
  const envelope = loadFixture();
  const data = Object.fromEntries(contract.ORDER.map((name) => [name, []]));
  const db = {
    data,
    writes: 0,
    async transaction(fn) {
      return fn(this);
    },
    async upsertConfig(name, rows) {
      this.writes += 1;
      this.data[name] = JSON.parse(JSON.stringify(rows));
    },
    async readConfig(name) {
      return this.data[name];
    },
    async counts() {
      return { bookings: 0, guests: 0, payments: 0, messages: 0, sessions: 0 };
    },
    async verifyForeignKeys() {
      return { ok: true };
    },
  };
  await adapter.applyImport(db, envelope, TARGET);
  const writes = db.writes;
  await adapter.applyImport(db, envelope, TARGET);
  assert.equal(db.writes, writes + contract.ORDER.length);
  assert.equal(db.data.clients[0].timezone, 'Europe/Madrid');
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sampleTables(fillPriority) {
  const envelope = loadFixture();
  const tables = clone(envelope.tables);
  tables.rooms[0].fill_priority = fillPriority;
  return tables;
}

class FakePg {
  constructor(opts) {
    const options = opts || {};
    this.defaultReadOnly = options.defaultReadOnly || 'off';
    this.effectiveReadOnly = options.effectiveReadOnly || 'off';
    this.isolation = options.isolation || 'read committed';
    this.inTxn = Boolean(options.alreadyOpen);
    this.owned = false;
    this.splitBrain = Boolean(options.splitBrain);
    this.failOn = options.failOn || null;
    this.v1 = sampleTables(2);
    this.v2 = sampleTables(9);
    this.configReads = 0;
    this.began = 0;
    this.committed = 0;
    this.rolledBack = 0;
    this.sawDefaultReadOnlyProbe = false;
    this._txStatus = this.inTxn ? 'T' : 'I';
    this.database = options.database || 'wolfhouse_prod';
    this.operational = options.operational || {};
    this.inserts = 0;
  }

  snapshotLocked() {
    return this.inTxn && this.effectiveReadOnly === 'on' && /repeatable read|serializable/.test(this.isolation);
  }

  rowsFor(table) {
    const version = (this.snapshotLocked() || this.configReads === 0) ? this.v1 : this.v2;
    if (this.splitBrain && table !== 'clients') this.configReads += 1;
    else if (this.splitBrain) this.configReads += 1;
    return clone(version[table] || []);
  }

  async query(sql) {
    const text = String(sql);
    if (/default_transaction_read_only/i.test(text)) {
      this.sawDefaultReadOnlyProbe = true;
      return { rows: [{ default_transaction_read_only: this.defaultReadOnly }] };
    }
    if (/txid_current_if_assigned/i.test(text)) {
      return { rows: [{ assigned_xid: this.effectiveReadOnly === 'on' ? null : (this.inTxn ? '42' : null) }] };
    }
    if (/current_setting\('transaction_read_only'\)/i.test(text)) {
      return {
        rows: [{
          transaction_read_only: this.effectiveReadOnly,
          transaction_isolation: this.isolation,
        }],
      };
    }
    if (/^\s*SAVEPOINT\b/i.test(text)) {
      if (this._txStatus === 'I' || !this.inTxn) {
        const err = new Error('SAVEPOINT can only be used in transaction blocks');
        err.code = '25P01';
        throw err;
      }
      return { rows: [] };
    }
    if (/^\s*RELEASE\b/i.test(text)) return { rows: [] };
    if (/^\s*BEGIN\b/i.test(text)) {
      if (this.inTxn) {
        const err = new Error('there is already a transaction in progress');
        err.code = '25001';
        throw err;
      }
      this.began += 1;
      this.inTxn = true;
      this._txStatus = 'T';
      this.owned = true;
      this.configReads = 0;
      if (/READ ONLY/i.test(text)) this.effectiveReadOnly = 'on';
      if (/REPEATABLE READ/i.test(text)) this.isolation = 'repeatable read';
      if (/SERIALIZABLE/i.test(text)) this.isolation = 'serializable';
      return { rows: [] };
    }
    if (/^\s*COMMIT\b/i.test(text)) {
      this.committed += 1;
      this.inTxn = false;
      this._txStatus = 'I';
      this.owned = false;
      return { rows: [] };
    }
    if (/^\s*ROLLBACK\b/i.test(text)) {
      this.rolledBack += 1;
      this.inTxn = false;
      this._txStatus = 'I';
      this.owned = false;
      return { rows: [] };
    }
    const count = text.match(/FROM\s+(bookings|guests|payments|messages|auth_sessions)\b/i);
    if (count) {
      const table = count[1];
      const key = table === 'auth_sessions' ? 'sessions' : table;
      return { rows: [{ n: Number(this.operational[key] || 0) }] };
    }
    if (/current_database/i.test(text)) {
      return { rows: [{ database: this.database }] };
    }
    if (/^\s*INSERT\b/i.test(text)) {
      this.inserts += 1;
      return { rows: [] };
    }
    if (/information_schema|pg_constraint|pg_class|pg_attribute/i.test(text)) {
      return { rows: [] };
    }
    if (/^\s*(LOCK|UPDATE|DELETE)\b/i.test(text)) return { rows: [] };
    const from = text.match(/FROM\s+(clients|rooms|beds|wh_pricing_seasons|wh_pricing_season_ranges|wh_pricing_items|wh_pricing_rules|wh_pricing_transfer_rules)\b/i);
    if (from) {
      const table = from[1];
      if (this.failOn === table) throw Object.assign(new Error('probe_fail'), { code: 'probe_fail' });
      return { rows: this.rowsFor(table) };
    }
    throw new Error('unexpected_sql');
  }
}

test('Cap A: session default read-only on but effective txn writable is rejected', async () => {
  const pg = new FakePg({
    defaultReadOnly: 'on',
    effectiveReadOnly: 'off',
    isolation: 'read committed',
    alreadyOpen: true,
  });
  await assert.rejects(() => adapter.exportFromReadOnlyTest(pg), (err) => err && err.code === 'test_txn_not_read_only');
  assert.equal(pg.began, 0);
  assert.equal(pg.committed, 0);
  assert.equal(pg.rolledBack, 0);
  assert.equal(pg.sawDefaultReadOnlyProbe, false);
});

test('Cap B: concurrent config update cannot mix old clients with new rooms', async () => {
  const mixed = new FakePg({ splitBrain: true });
  const leaked = await contract.exportConfig(new contract.SqlConfigAdapter(mixed));
  assert.equal(leaked.tables.clients[0].name, 'Wolfhouse');
  assert.equal(leaked.tables.rooms[0].fill_priority, 9);

  const pg = new FakePg({ splitBrain: true });
  const envelope = await adapter.exportFromReadOnlyTest(pg);
  assert.equal(envelope.tables.rooms[0].fill_priority, 2);
  assert.equal(envelope.tables.clients[0].name, 'Wolfhouse');
  assert.equal(pg.began, 1);
  assert.equal(pg.committed, 1);
  assert.equal(pg.rolledBack, 0);
});

test('control: idle connection starts owned REPEATABLE READ READ ONLY snapshot', async () => {
  const pg = new FakePg({ defaultReadOnly: 'off', effectiveReadOnly: 'off', isolation: 'read committed' });
  const envelope = await adapter.exportFromReadOnlyTest(pg);
  assert.equal(envelope.tables.rooms[0].fill_priority, 2);
  assert.equal(pg.isolation, 'repeatable read');
  assert.equal(pg.effectiveReadOnly, 'on');
  assert.equal(pg.began, 1);
  assert.equal(pg.committed, 1);
});

test('control: already-open REPEATABLE READ READ ONLY snapshot is reused and not committed', async () => {
  const pg = new FakePg({
    alreadyOpen: true,
    effectiveReadOnly: 'on',
    isolation: 'repeatable read',
    splitBrain: true,
  });
  const envelope = await adapter.exportFromReadOnlyTest(pg);
  assert.equal(envelope.tables.rooms[0].fill_priority, 2);
  assert.equal(pg.began, 0);
  assert.equal(pg.committed, 0);
  assert.equal(pg.rolledBack, 0);
});

test('control: already-open read-only READ COMMITTED is rejected', async () => {
  const pg = new FakePg({
    alreadyOpen: true,
    effectiveReadOnly: 'on',
    isolation: 'read committed',
  });
  await assert.rejects(() => adapter.exportFromReadOnlyTest(pg), (err) => err && err.code === 'test_txn_not_repeatable_read');
  assert.equal(pg.began, 0);
  assert.equal(pg.rolledBack, 0);
});

test('owned snapshot is rolled back when a later config read fails', async () => {
  const pg = new FakePg({ failOn: 'rooms' });
  await assert.rejects(() => adapter.exportFromReadOnlyTest(pg), (err) => err && err.code === 'probe_fail');
  assert.equal(pg.began, 1);
  assert.equal(pg.committed, 0);
  assert.equal(pg.rolledBack, 1);
  assert.equal(pg.inTxn, false);
});

test('pool clients are rejected', async () => {
  const pool = { query: async () => ({ rows: [] }), totalCount: 0, idleCount: 0 };
  Object.defineProperty(pool, 'constructor', { value: { name: 'Pool' } });
  await assert.rejects(() => adapter.exportFromReadOnlyTest(pool), (err) => err && err.code === 'client_must_not_be_pool');
});

test('FakePg read-only txn reports null assigned xid like Postgres', async () => {
  const pg = new FakePg({ alreadyOpen: true, effectiveReadOnly: 'on', isolation: 'repeatable read' });
  const xid = await pg.query('SELECT txid_current_if_assigned() AS assigned_xid');
  assert.equal(xid.rows[0].assigned_xid, null);
  const envelope = await adapter.exportFromReadOnlyTest(pg);
  assert.equal(envelope.tables.rooms[0].fill_priority, 2);
  assert.equal(pg.committed, 0);
  assert.equal(pg._txStatus, 'T');
});

async function seedPglite(db) {
  const fixture = loadFixture();
  await db.exec(`
    CREATE TABLE clients (
      id uuid PRIMARY KEY, slug text, name text, currency text, timezone text
    );
    CREATE TABLE rooms (
      id uuid PRIMARY KEY, client_id uuid, room_code text, name text, capacity int,
      fill_priority int, private_priority int, gender_strategy text, room_type text,
      sort_order int, can_be_matrimonial bool, often_used_by_operator bool,
      avoid_until_needed bool, active bool
    );
    CREATE TABLE beds (
      id uuid PRIMARY KEY, client_id uuid, room_id uuid, bed_code text, bed_number int,
      bed_label text, planning_row_label text, sellable bool, active bool
    );
    CREATE TABLE wh_pricing_seasons (
      id uuid PRIMARY KEY, client_slug text, code text, label text, priority int,
      bookable bool, active bool, sort_order int
    );
    CREATE TABLE wh_pricing_season_ranges (
      id uuid PRIMARY KEY, season_id uuid, client_slug text, start_month int, start_day int,
      end_month int, end_day int, sort_order int
    );
    CREATE TABLE wh_pricing_items (
      id uuid PRIMARY KEY, client_slug text, item_type text, item_code text, label text,
      description text, metadata jsonb, active bool, sort_order int
    );
    CREATE TABLE wh_pricing_rules (
      id uuid PRIMARY KEY, client_slug text, item_type text, item_code text, season_code text,
      unit text, amount_cents int, currency text, active bool
    );
    CREATE TABLE wh_pricing_transfer_rules (
      id uuid PRIMARY KEY, client_slug text, airport_code text, label text, aliases text,
      requires_package bool, included_when_package bool, min_guest_count int,
      max_guest_count int, active bool, sort_order int
    );
    CREATE TABLE bookings (n int);
    CREATE TABLE guests (n int);
    CREATE TABLE payments (n int);
    CREATE TABLE messages (n int);
    CREATE TABLE auth_sessions (n int);
  `);
  const c = fixture.tables.clients[0];
  const r = fixture.tables.rooms[0];
  const b = fixture.tables.beds[0];
  const s = fixture.tables.wh_pricing_seasons[0];
  const rng = fixture.tables.wh_pricing_season_ranges[0];
  await db.query('INSERT INTO clients VALUES ($1,$2,$3,$4,$5)', [c.id, c.slug, c.name, c.currency, c.timezone]);
  await db.query(
    'INSERT INTO rooms VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
    [r.id, r.client_id, r.room_code, r.name, r.capacity, r.fill_priority, r.private_priority, r.gender_strategy, r.room_type, r.sort_order, r.can_be_matrimonial, r.often_used_by_operator, r.avoid_until_needed, r.active],
  );
  await db.query(
    'INSERT INTO beds VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [b.id, b.client_id, b.room_id, b.bed_code, b.bed_number, b.bed_label, b.planning_row_label, b.sellable, b.active],
  );
  await db.query(
    'INSERT INTO wh_pricing_seasons VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [s.id, s.client_slug, s.code, s.label, s.priority, s.bookable, s.active, s.sort_order],
  );
  await db.query(
    'INSERT INTO wh_pricing_season_ranges VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [rng.id, rng.season_id, rng.client_slug, rng.start_month, rng.start_day, rng.end_month, rng.end_day, rng.sort_order],
  );
}

test('PGlite: read-only txn has null xid, export is one snapshot, caller txn stays open', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await seedPglite(db);
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let xid = null;
    try {
      const xidRes = await db.query('SELECT txid_current_if_assigned() AS assigned_xid');
      xid = xidRes.rows[0].assigned_xid;
    } catch (err) {
      const xidRes = await db.query('SELECT pg_current_xact_id_if_assigned() AS assigned_xid');
      xid = xidRes.rows[0].assigned_xid;
    }
    assert.equal(xid, null);
    const envelope = await adapter.exportFromReadOnlyTest(db);
    assert.equal(envelope.tables.clients[0].slug, 'wolfhouse-somo');
    assert.equal(envelope.tables.rooms[0].fill_priority, 2);
    assert.equal(envelope.exportedCounts.bookings, 0);
    await db.query('SAVEPOINT still_open_after_export');
    await db.query('RELEASE SAVEPOINT still_open_after_export');
    await db.query('COMMIT');
  } finally {
    await db.close();
  }
});

test('CLI --apply without prod url fails closed', () => {
  const targetFile = path.join(os.tmpdir(), 'wh-prod-target-apply.json');
  fs.writeFileSync(targetFile, JSON.stringify(TARGET));
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'adapter.js'), 'import', '--apply', '--fixture', FIXTURE, '--target', targetFile,
  ], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, WOLFHOUSE_PROD_DATABASE_URL: '' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing_prod_url/);
});

test('applyImportCli refuses non-empty prod before writes', async () => {
  const pg = new FakePg({ operational: { bookings: 1 } });
  await assert.rejects(
    () => adapter.applyImportCli(loadFixture(), TARGET, pg),
    (err) => err && err.code === 'prod_not_empty',
  );
  assert.equal(pg.inserts, 0);
  assert.equal(pg.began, 0);
});

test('applyImportCli refuses any database other than wolfhouse_prod', async () => {
  const pg = new FakePg({ database: 'wolfhouse_staging' });
  await assert.rejects(
    () => adapter.applyImportCli(loadFixture(), TARGET, pg),
    (err) => err && err.code === 'prod_db_mismatch',
  );
  assert.equal(pg.inserts, 0);
});

test('applyImportCli writes config-only into empty wolfhouse_prod', async () => {
  const pg = new FakePg();
  const result = await adapter.applyImportCli(loadFixture(), TARGET, pg);
  assert.ok(result.configHash);
  assert.equal(result.destinationCounts.bookings, 0);
  assert.ok(pg.inserts > 0);
  assert.equal(pg.committed, 1);
});

test('bindProdUrl refuses an off-allowlist host before any query', () => {
  const pg = new FakePg();
  assert.throws(
    () => adapter.bindProdUrl('postgres://wolfhouse:x@evil.example.com:5432/wolfhouse_prod', TARGET),
    (err) => err && err.code === 'prod_url_host_not_allowlisted',
  );
  assert.equal(pg.inserts, 0);
});

test('CLI --apply refuses off-allowlist --prod-url before connect', () => {
  const targetFile = path.join(os.tmpdir(), 'wh-prod-target-bind.json');
  fs.writeFileSync(targetFile, JSON.stringify(TARGET));
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'adapter.js'),
    'import',
    '--apply',
    '--fixture', FIXTURE,
    '--target', targetFile,
    '--prod-url', 'postgres://wolfhouse:x@evil.example.com:5432/wolfhouse_prod',
  ], { encoding: 'utf8', cwd: ROOT });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prod_url_host_not_allowlisted/);
});

test('bindProdUrl accepts the isolated internal host', () => {
  const bound = adapter.bindProdUrl('postgres://wolfhouse:***@wolfhouse-prod-postgres:5432/wolfhouse_prod', TARGET);
  assert.equal(bound.host, 'wolfhouse-prod-postgres');
  assert.equal(bound.port, 5432);
  assert.equal(bound.database, 'wolfhouse_prod');
  assert.equal(bound.connectionString, undefined);
});

test('bindProdUrl refuses query host override off the allowlist', () => {
  assert.throws(
    () => adapter.bindProdUrl(
      'postgres://wolfhouse:x@wolfhouse-prod-postgres:5432/wolfhouse_prod?host=off-allowlist.invalid',
      TARGET,
    ),
    (err) => err && err.code === 'prod_url_host_not_allowlisted',
  );
});

test('bindProdUrl refuses query port override', () => {
  assert.throws(
    () => adapter.bindProdUrl(
      'postgres://wolfhouse:x@wolfhouse-prod-postgres:5432/wolfhouse_prod?port=6543',
      TARGET,
    ),
    (err) => err && err.code === 'prod_url_port_mismatch',
  );
});

test('CLI --apply refuses query host override with zero connect', () => {
  const targetFile = path.join(os.tmpdir(), 'wh-prod-target-qhost.json');
  fs.writeFileSync(targetFile, JSON.stringify(TARGET));
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'adapter.js'),
    'import', '--apply', '--fixture', FIXTURE, '--target', targetFile,
    '--prod-url', 'postgres://wolfhouse:x@wolfhouse-prod-postgres:5432/wolfhouse_prod?host=off-allowlist.invalid',
  ], { encoding: 'utf8', cwd: ROOT, timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prod_url_host_not_allowlisted/);
});

test('CLI --apply refuses query port override with zero connect', () => {
  const targetFile = path.join(os.tmpdir(), 'wh-prod-target-qport.json');
  fs.writeFileSync(targetFile, JSON.stringify(TARGET));
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'adapter.js'),
    'import', '--apply', '--fixture', FIXTURE, '--target', targetFile,
    '--prod-url', 'postgres://wolfhouse:***@wolfhouse-prod-postgres:5432/wolfhouse_prod?port=6543',
  ], { encoding: 'utf8', cwd: ROOT, timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prod_url_port_mismatch/);
});

const APPROVED_URL = 'postgres://wolfhouse:***@wolfhouse-prod-postgres:5432/wolfhouse_prod';

function inspectApplyClient(url) {
  const targetFile = path.join(os.tmpdir(), 'wh-prod-target-inspect.json');
  fs.writeFileSync(targetFile, JSON.stringify(TARGET));
  return spawnSync(process.execPath, [
    path.join(__dirname, 'adapter.js'),
    'import', '--apply', '--inspect-client', '--fixture', FIXTURE, '--target', targetFile,
    '--prod-url', url,
  ], { encoding: 'utf8', cwd: ROOT, timeout: 5000 });
}

function effectiveSsl(url) {
  const client = adapter.openPinnedClientFromConfig(adapter.bindProdUrl(url, TARGET));
  return client.connectionParameters.ssl;
}

test('effective client keeps sslmode=verify-full TLS on', () => {
  const ssl = effectiveSsl(`${APPROVED_URL}?sslmode=verify-full`);
  assert.notEqual(ssl, false);
  assert.equal(typeof ssl, 'object');
});

test('effective client keeps sslmode=require TLS on', () => {
  const ssl = effectiveSsl(`${APPROVED_URL}?sslmode=require`);
  assert.notEqual(ssl, false);
  assert.equal(typeof ssl, 'object');
});

test('effective client keeps sslmode=disable as ssl false', () => {
  const ssl = effectiveSsl(`${APPROVED_URL}?sslmode=disable`);
  assert.equal(ssl, false);
});

test('CLI inspect-client reports verify-full TLS without connecting', () => {
  const result = inspectApplyClient(`${APPROVED_URL}?sslmode=verify-full`);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.notEqual(body.ssl, false);
  assert.equal(typeof body.ssl, 'object');
  assert.equal(body.host, 'wolfhouse-prod-postgres');
});

test('CLI inspect-client reports require TLS without connecting', () => {
  const result = inspectApplyClient(`${APPROVED_URL}?sslmode=require`);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.notEqual(body.ssl, false);
});

test('CLI inspect-client reports disable as ssl false without connecting', () => {
  const result = inspectApplyClient(`${APPROVED_URL}?sslmode=disable`);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ssl, false);
});


