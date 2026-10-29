'use strict';

/**
 * Prod import must reconcile migration-seeded config rows that share a
 * natural unique key with TEST but have different UUIDs. ON CONFLICT (id)
 * alone raises 23505. End state is exactly the source envelope.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const contract = require('./contract');
const adapter = require('./adapter');

const TARGET = {
  host: 'wolfhouse-prod-postgres',
  port: 5432,
  database: 'wolfhouse_prod',
  network: 'wolfhouse-prod-private',
  manifestId: 'wolfhouse-prod-data-v2026-10-28.3',
  mounts: { data: '/var/lib/wolfhouse-prod/data', backupSpool: '/var/lib/wolfhouse-prod/backup-spool' },
  backupDestination: 'azure://acct/container/object',
};

const SCHEMA_SQL = `
  CREATE TABLE clients (
    id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, name text, currency text, timezone text
  );
  CREATE TABLE rooms (
    id uuid PRIMARY KEY, client_id uuid REFERENCES clients(id), room_code text, name text, capacity int,
    fill_priority int, private_priority int, gender_strategy text, room_type text,
    sort_order int, can_be_matrimonial bool, often_used_by_operator bool,
    avoid_until_needed bool, active bool,
    UNIQUE (client_id, room_code)
  );
  CREATE TABLE beds (
    id uuid PRIMARY KEY, client_id uuid, room_id uuid REFERENCES rooms(id), bed_code text, bed_number int,
    bed_label text, planning_row_label text, sellable bool, active bool,
    UNIQUE (client_id, bed_code)
  );
  CREATE TABLE wh_pricing_seasons (
    id uuid PRIMARY KEY, client_slug text, code text, label text, priority int,
    bookable bool, active bool, sort_order int
  );
  CREATE UNIQUE INDEX uq_wh_pricing_seasons_code
    ON wh_pricing_seasons (client_slug, code) WHERE active = true;
  CREATE TABLE wh_pricing_season_ranges (
    id uuid PRIMARY KEY, season_id uuid REFERENCES wh_pricing_seasons(id) ON DELETE CASCADE,
    client_slug text, start_month int, start_day int, end_month int, end_day int, sort_order int
  );
  CREATE TABLE wh_pricing_items (
    id uuid PRIMARY KEY, client_slug text, item_type text, item_code text, label text,
    description text, metadata jsonb, active bool, sort_order int
  );
  CREATE UNIQUE INDEX uq_wh_pricing_items_code
    ON wh_pricing_items (client_slug, item_type, item_code) WHERE active = true;
  CREATE TABLE wh_pricing_rules (
    id uuid PRIMARY KEY, client_slug text, item_type text, item_code text, season_code text,
    unit text, amount_cents int, currency text, active bool
  );
  CREATE UNIQUE INDEX uq_wh_pricing_rules_scope
    ON wh_pricing_rules (client_slug, item_type, item_code, COALESCE(season_code, ''))
    WHERE active = true;
  CREATE TABLE wh_pricing_transfer_rules (
    id uuid PRIMARY KEY, client_slug text, airport_code text, label text, aliases text,
    requires_package bool, included_when_package bool, min_guest_count int,
    max_guest_count int, active bool, sort_order int
  );
  CREATE UNIQUE INDEX uq_wh_pricing_transfer_rules_airport
    ON wh_pricing_transfer_rules (client_slug, airport_code) WHERE active = true;
  CREATE TABLE bookings (n int);
  CREATE TABLE guests (n int);
  CREATE TABLE payments (n int);
  CREATE TABLE messages (n int);
  CREATE TABLE auth_sessions (n int);
`;

function id(n) {
  return '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceTables() {
  const clientId = id(1);
  const roomId = id(2);
  const seasonId = id(4);
  return {
    clients: [{ id: clientId, slug: 'wolfhouse-somo', name: 'Wolfhouse', currency: 'EUR', timezone: 'Europe/Madrid' }],
    rooms: [{
      id: roomId, client_id: clientId, room_code: 'R1', name: 'Room 1', capacity: 4,
      fill_priority: 2, private_priority: 3, gender_strategy: 'mixed', room_type: 'dorm',
      sort_order: 1, can_be_matrimonial: true, often_used_by_operator: true, avoid_until_needed: true, active: true,
    }],
    beds: [{
      id: id(3), client_id: clientId, room_id: roomId, bed_code: 'R1-1', bed_number: 1,
      bed_label: 'R1-1', planning_row_label: 'A', sellable: false, active: true,
    }],
    wh_pricing_seasons: [{
      id: seasonId, client_slug: 'wolfhouse-somo', code: 'summer', label: 'Summer',
      priority: 0, bookable: true, active: true, sort_order: 0,
    }],
    wh_pricing_season_ranges: [{
      id: id(5), season_id: seasonId, client_slug: 'wolfhouse-somo',
      start_month: 1, start_day: 1, end_month: 12, end_day: 31, sort_order: 0,
    }],
    wh_pricing_items: [{
      id: id(20), client_slug: 'wolfhouse-somo', item_type: 'rental', item_code: 'wetsuit_rental',
      label: 'Wetsuit', description: null, metadata: {}, active: true, sort_order: 0,
    }],
    wh_pricing_rules: [
      { item_code: 'wetsuit_rental', amount_cents: 600, n: 31 },
      { item_code: 'soft_top_rental', amount_cents: 1500, n: 32 },
      { item_code: 'hard_board_rental', amount_cents: 2000, n: 33 },
      { item_code: 'wetsuit_soft_top_combo', amount_cents: 1500, n: 34 },
      { item_code: 'wetsuit_hard_board_combo', amount_cents: 2000, n: 35 },
    ].map((row) => ({
      id: id(row.n),
      client_slug: 'wolfhouse-somo',
      item_type: 'rental',
      item_code: row.item_code,
      season_code: null,
      unit: 'per_day',
      amount_cents: row.amount_cents,
      currency: 'EUR',
      active: true,
    })),
    wh_pricing_transfer_rules: [{
      id: id(40), client_slug: 'wolfhouse-somo', airport_code: 'SDR', label: 'Santander',
      aliases: '{}', requires_package: false, included_when_package: true,
      min_guest_count: null, max_guest_count: null, active: true, sort_order: 0,
    }],
  };
}

async function execSchema(db) {
  await db.exec(SCHEMA_SQL);
}

async function insertSeededDestination(db) {
  // Migration-shaped seeds: same natural keys, different UUIDs, plus a leftover.
  await db.query(
    'INSERT INTO clients VALUES ($1,$2,$3,$4,$5)',
    [id(101), 'wolfhouse-somo', 'Seed Client', 'EUR', 'UTC'],
  );
  await db.query(
    'INSERT INTO rooms VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
    [id(102), id(101), 'R1', 'Seed Room', 9, 9, 9, 'male', 'dorm', 9, false, false, false, true],
  );
  await db.query(
    'INSERT INTO beds VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id(103), id(101), id(102), 'R1-1', 9, 'seed', 'Z', true, true],
  );
  await db.query(
    'INSERT INTO wh_pricing_seasons VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id(104), 'wolfhouse-somo', 'summer', 'Seed Summer', 9, false, true, 9],
  );
  await db.query(
    'INSERT INTO wh_pricing_season_ranges VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id(105), id(104), 'wolfhouse-somo', 6, 1, 8, 31, 9],
  );
  await db.query(
    'INSERT INTO wh_pricing_items VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',
    [id(120), 'wolfhouse-somo', 'rental', 'wetsuit_rental', 'Seed Wetsuit', 'seed', '{}', true, 9],
  );
  const seedRules = [
    [id(131), 'wetsuit_rental', 500],
    [id(132), 'soft_top_rental', 1500],
    [id(133), 'hard_board_rental', 2000],
    [id(134), 'wetsuit_soft_top_combo', 1500],
    [id(135), 'wetsuit_hard_board_combo', 2000],
    [id(199), 'ghost_rental', 1],
  ];
  for (const [seedId, code, cents] of seedRules) {
    await db.query(
      'INSERT INTO wh_pricing_rules VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [seedId, 'wolfhouse-somo', 'rental', code, null, 'per_day', cents, 'EUR', true],
    );
  }
  await db.query(
    'INSERT INTO wh_pricing_transfer_rules VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [id(140), 'wolfhouse-somo', 'SDR', 'Seed SDR', '{}', true, false, 4, 8, true, 9],
  );
}

async function readBack(db) {
  const sql = new contract.SqlConfigAdapter(db);
  const tables = {};
  for (const name of contract.ORDER) tables[name] = await sql.readOnly(name, contract.SPEC[name]);
  return tables;
}

test('seeded dest with different UUIDs imports: TEST ids/values win, leftovers gone', async () => {
  const db = new PGlite();
  try {
    await execSchema(db);
    await insertSeededDestination(db);
    const envelope = contract.envelope(sourceTables());
    const imported = await adapter.applyImport(new contract.SqlConfigAdapter(db), envelope, TARGET);
    assert.equal(imported.configHash, envelope.configHash);
    const actual = await readBack(db);
    assert.equal(contract.hash(actual), envelope.configHash);
    assert.equal(actual.wh_pricing_rules.length, 5);
    assert.equal(actual.wh_pricing_rules.some((row) => row.item_code === 'ghost_rental'), false);
    assert.equal(actual.wh_pricing_rules.find((row) => row.item_code === 'wetsuit_rental').id, id(31));
    assert.equal(actual.wh_pricing_rules.find((row) => row.item_code === 'wetsuit_rental').amount_cents, 600);
    assert.equal(actual.clients[0].id, id(1));
    assert.equal(actual.wh_pricing_seasons[0].id, id(4));
    assert.equal(actual.wh_pricing_items[0].id, id(20));
    assert.equal(actual.wh_pricing_transfer_rules[0].id, id(40));
    assert.equal(actual.wh_pricing_season_ranges[0].id, id(5));
  } finally {
    await db.close();
  }
});

test('seeded dest import is re-runnable and stays equal', async () => {
  const db = new PGlite();
  try {
    await execSchema(db);
    await insertSeededDestination(db);
    const envelope = contract.envelope(sourceTables());
    const sql = new contract.SqlConfigAdapter(db);
    await adapter.applyImport(sql, envelope, TARGET);
    const second = await adapter.applyImport(sql, envelope, TARGET);
    assert.equal(second.configHash, envelope.configHash);
    const actual = await readBack(db);
    assert.equal(contract.hash(actual), envelope.configHash);
    assert.equal(actual.wh_pricing_rules.length, 5);
  } finally {
    await db.close();
  }
});

test('duplicate natural keys in the envelope are rejected', () => {
  const tables = sourceTables();
  tables.wh_pricing_rules.push({
    id: id(99),
    client_slug: 'wolfhouse-somo',
    item_type: 'rental',
    item_code: 'wetsuit_rental',
    season_code: null,
    unit: 'per_day',
    amount_cents: 1,
    currency: 'EUR',
    active: true,
  });
  assert.throws(
    () => contract.envelope(tables),
    (err) => err && String(err.code || err.message).includes('duplicate_natural_key'),
  );
});

test('equality read-back fails closed if dest would not match source', async () => {
  const db = new PGlite();
  try {
    await execSchema(db);
    const envelope = contract.envelope(sourceTables());
    const tampered = clone(envelope);
    tampered.tables.wh_pricing_rules[0].amount_cents = 1;
    await assert.rejects(
      () => adapter.applyImport(new contract.SqlConfigAdapter(db), tampered, TARGET),
      (err) => err && err.code === 'stale_config_hash',
    );
    const rows = await db.query('SELECT count(*)::int n FROM wh_pricing_rules');
    assert.equal(rows.rows[0].n, 0);
  } finally {
    await db.close();
  }
});
