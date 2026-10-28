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
  host: '178.33.91.59',
  database: 'wolfhouse_prod',
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
