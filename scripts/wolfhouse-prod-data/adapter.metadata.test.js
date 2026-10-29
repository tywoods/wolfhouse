'use strict';

/**
 * #1489 adapter metadata: Staff/Luna pricing keys must survive export→import.
 *
 * Live France TEST wh_pricing_items.metadata holds
 * allow_daily_proration, includes, min_days, pebble, promoted_from.
 * The old 4-key allowlist rejected that snapshot with invalid_metadata.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
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

/** Keys Staff Admin Pricing + Luna catalog actually read/write on package rows. */
const LIVE_TEST_METADATA = Object.freeze({
  allow_daily_proration: true,
  includes: ['Stay in a mixed dorm', 'Breakfast'],
  min_days: 7,
  pebble: 'peach',
  promoted_from: 'config',
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadBaseTables() {
  return clone(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).tables);
}

function livePackageItem(metadata) {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    client_slug: 'wolfhouse-somo',
    item_type: 'package',
    item_code: 'malibu',
    label: 'Malibu',
    description: 'Week package',
    metadata,
    active: true,
    sort_order: 0,
  };
}

function tablesWithItems(items) {
  const tables = loadBaseTables();
  tables.wh_pricing_items = items;
  return tables;
}

function captureWarns(fn) {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const result = fn();
    return { result, lines };
  } finally {
    process.stderr.write = original;
  }
}

test('France TEST live key set is a faithful envelope, not invalid_metadata', () => {
  const tables = tablesWithItems([livePackageItem(clone(LIVE_TEST_METADATA))]);
  const envelope = contract.envelope(tables, { bookings: 4, guests: 2, payments: 1, messages: 2, sessions: 1 });
  assert.equal(envelope.kind, 'wolfhouse_config_export');
  assert.deepEqual(envelope.tables.wh_pricing_items[0].metadata, LIVE_TEST_METADATA);
});

test('typed Staff/Luna keys keep type checks', () => {
  const bad = [
    { min_days: -1 },
    { min_days: 1.5 },
    { allow_daily_proration: 'yes' },
    { includes: 'Stay' },
    { includes: [1] },
    { pebble: 3 },
    { promoted_from: true },
    { minimum_nights: '7' },
    { pricing_unit: 1 },
    { per_guest: 'true' },
    { inclusions: ['ok', 2] },
  ];
  for (const patch of bad) {
    const metadata = Object.assign(clone(LIVE_TEST_METADATA), patch);
    const tables = tablesWithItems([livePackageItem(metadata)]);
    assert.throws(
      () => contract.envelope(tables),
      (err) => err && err.code === 'invalid_metadata',
      'expected invalid_metadata for ' + JSON.stringify(patch),
    );
  }
});

test('unknown metadata keys carry through with a warning and are never dropped', () => {
  const metadata = Object.assign(clone(LIVE_TEST_METADATA), { future_staff_flag: 'keep-me' });
  const tables = tablesWithItems([livePackageItem(metadata)]);
  const { result, lines } = captureWarns(() => contract.envelope(tables));
  assert.equal(result.tables.wh_pricing_items[0].metadata.future_staff_flag, 'keep-me');
  assert.deepEqual(result.tables.wh_pricing_items[0].metadata, metadata);
  assert.ok(
    lines.some((line) => /unknown_pricing_item_metadata_key:future_staff_flag/.test(line)),
    'unknown key must be logged, not silently dropped: ' + JSON.stringify(lines),
  );
});

test('legacy typed keys still validate when present', () => {
  const metadata = {
    pricing_unit: 'per_day',
    per_guest: true,
    inclusions: ['breakfast'],
    min_days: 5,
  };
  const tables = tablesWithItems([livePackageItem(metadata)]);
  const envelope = contract.envelope(tables);
  assert.deepEqual(envelope.tables.wh_pricing_items[0].metadata, metadata);
});

function ownValue(object, key) {
  const desc = Object.getOwnPropertyDescriptor(object, key);
  assert.ok(desc, 'missing own key ' + key);
  return desc.value;
}

function liveMetadataFromJsonPairs(pairs) {
  const parts = Object.keys(LIVE_TEST_METADATA).map((key) => (
    JSON.stringify(key) + ':' + JSON.stringify(LIVE_TEST_METADATA[key])
  ));
  for (const [key, value] of pairs) {
    parts.push(JSON.stringify(key) + ':' + JSON.stringify(value));
  }
  return JSON.parse('{' + parts.join(',') + '}');
}

test('prototype-named own keys warn and copy; they are not treated as validators', () => {
  const named = [
    ['hasOwnProperty', 'keep-hop'],
    ['constructor', 'keep-ctor'],
    ['toString', 'keep-ts'],
    ['__proto__', 'keep-proto'],
  ];
  const metadata = liveMetadataFromJsonPairs(named);
  const tables = tablesWithItems([livePackageItem(metadata)]);
  const original = tables.wh_pricing_items[0];
  const { result, lines } = captureWarns(() => contract.envelope(tables));
  assert.equal(original.metadata, metadata);
  assert.equal(result.tables.wh_pricing_items[0].metadata, metadata);
  for (const [key, value] of named) {
    assert.equal(ownValue(result.tables.wh_pricing_items[0].metadata, key), value);
    assert.ok(
      lines.some((line) => line.includes('unknown_pricing_item_metadata_key:' + key)),
      'missing warning for ' + key + ': ' + JSON.stringify(lines),
    );
  }
  assert.equal(result.configHash, contract.hash(result.tables));
});

test('JSON null metadata round-trips without mutating or stale_config_hash', () => {
  const tables = tablesWithItems([livePackageItem(null)]);
  const row = tables.wh_pricing_items[0];
  const envelope = contract.envelope(tables);
  assert.equal(row.metadata, null);
  assert.equal(envelope.tables.wh_pricing_items[0].metadata, null);
  assert.equal(envelope.tables.wh_pricing_items[0], row);
  assert.equal(envelope.configHash, contract.hash(envelope.tables));
  assert.equal(contract.validate(envelope), true);
  assert.equal(envelope.tables.wh_pricing_items[0].metadata, null);
});

const SCHEMA_SQL = `
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
`;

async function seedSnapshot(db, tables) {
  await db.exec(SCHEMA_SQL);
  const c = tables.clients[0];
  const r = tables.rooms[0];
  const b = tables.beds[0];
  const s = tables.wh_pricing_seasons[0];
  const rng = tables.wh_pricing_season_ranges[0];
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
  for (const item of tables.wh_pricing_items) {
    await db.query(
      'INSERT INTO wh_pricing_items VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',
      [item.id, item.client_slug, item.item_type, item.item_code, item.label, item.description, JSON.stringify(item.metadata), item.active, item.sort_order],
    );
  }
}

test('PGlite: France TEST snapshot export→import keeps every table equal', async () => {
  const sourceTables = tablesWithItems([
    livePackageItem(clone(LIVE_TEST_METADATA)),
    {
      id: '00000000-0000-4000-8000-000000000011',
      client_slug: 'wolfhouse-somo',
      item_type: 'policy',
      item_code: 'package_min_nights',
      label: 'Package Night minimum',
      description: null,
      metadata: { minimum_nights: 7 },
      active: true,
      sort_order: 1,
    },
  ]);
  const source = new PGlite();
  const dest = new PGlite();
  try {
    await seedSnapshot(source, sourceTables);
    const exported = await adapter.exportFromReadOnlyTest(source);
    assert.deepEqual(exported.tables.wh_pricing_items[0].metadata, LIVE_TEST_METADATA);
    assert.equal(exported.tables.wh_pricing_items[1].metadata.minimum_nights, 7);
    assert.equal(exported.exportedCounts.bookings, 0);

    await dest.exec(SCHEMA_SQL);
    const imported = await adapter.applyImport(new contract.SqlConfigAdapter(dest), exported, TARGET);
    assert.equal(imported.configHash, exported.configHash);

    const roundTrip = await adapter.exportFromReadOnlyTest(dest);
    for (const name of contract.ORDER) {
      assert.equal(contract.hash(roundTrip.tables[name]), contract.hash(exported.tables[name]), name);
    }
    assert.equal(roundTrip.configHash, exported.configHash);
    assert.deepEqual(roundTrip.tables.wh_pricing_items[0].metadata, LIVE_TEST_METADATA);
  } finally {
    await source.close();
    await dest.close();
  }
});

test('PGlite: JSON null metadata export→import stays null on every table', async () => {
  const sourceTables = tablesWithItems([livePackageItem(null)]);
  const source = new PGlite();
  const dest = new PGlite();
  try {
    await seedSnapshot(source, sourceTables);
    const exported = await adapter.exportFromReadOnlyTest(source);
    assert.equal(exported.tables.wh_pricing_items[0].metadata, null);
    await dest.exec(SCHEMA_SQL);
    const imported = await adapter.applyImport(new contract.SqlConfigAdapter(dest), exported, TARGET);
    assert.equal(imported.configHash, exported.configHash);
    const roundTrip = await adapter.exportFromReadOnlyTest(dest);
    assert.equal(roundTrip.tables.wh_pricing_items[0].metadata, null);
    assert.equal(roundTrip.configHash, exported.configHash);
    for (const name of contract.ORDER) {
      assert.equal(contract.hash(roundTrip.tables[name]), contract.hash(exported.tables[name]), name);
    }
  } finally {
    await source.close();
    await dest.close();
  }
});
