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

async function addExcludedDependents(db) {
  await db.exec(`
    ALTER TABLE bookings ADD COLUMN client_id uuid REFERENCES clients(id) ON DELETE CASCADE;
    CREATE TABLE conversations (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE staff_users (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
  `);
}

test('deleting a dest client UUID fails closed when conversations and staff would cascade', async () => {
  const db = new PGlite();
  try {
    await execSchema(db);
    await addExcludedDependents(db);
    await insertSeededDestination(db);
    await db.query('INSERT INTO conversations VALUES ($1,$2)', [id(501), id(101)]);
    await db.query('INSERT INTO staff_users VALUES ($1,$2)', [id(502), id(101)]);
    const envelope = contract.envelope(sourceTables());
    await assert.rejects(
      () => adapter.applyImport(new contract.SqlConfigAdapter(db), envelope, TARGET),
      (err) => err && err.code === 'protected_dependent',
    );
    assert.equal((await db.query('SELECT count(*)::int n FROM conversations')).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::int n FROM staff_users')).rows[0].n, 1);
    assert.equal((await db.query('SELECT id FROM clients WHERE slug=$1', ['wolfhouse-somo'])).rows[0].id, id(101));
  } finally {
    await db.close();
  }
});

test('a booking inserted before BEGIN is not cascaded away', async () => {
  const db = new PGlite();
  try {
    await execSchema(db);
    await addExcludedDependents(db);
    await insertSeededDestination(db);
    await db.query('INSERT INTO bookings (n, client_id) VALUES ($1,$2)', [1, id(101)]);
    const envelope = contract.envelope(sourceTables());
    await assert.rejects(
      () => adapter.applyImport(new contract.SqlConfigAdapter(db), envelope, TARGET),
      (err) => err && (err.code === 'destination_operational_nonzero' || err.code === 'protected_dependent'),
    );
    assert.equal((await db.query('SELECT count(*)::int n FROM bookings')).rows[0].n, 1);
    assert.equal((await db.query('SELECT id FROM clients WHERE slug=$1', ['wolfhouse-somo'])).rows[0].id, id(101));
  } finally {
    await db.close();
  }
});

test('incoming UUID owned by Sunset is rejected and does not change tenant', async () => {
  const db = new PGlite();
  try {
    await execSchema(db);
    await addExcludedDependents(db);
    await db.query(
      'INSERT INTO clients VALUES ($1,$2,$3,$4,$5)',
      [id(1), 'sunset-beach', 'Sunset', 'EUR', 'UTC'],
    );
    await db.query('INSERT INTO conversations VALUES ($1,$2)', [id(601), id(1)]);
    const envelope = contract.envelope(sourceTables());
    await assert.rejects(
      () => adapter.applyImport(new contract.SqlConfigAdapter(db), envelope, TARGET),
      (err) => err && err.code === 'uuid_owned_by_other_tenant',
    );
    const client = (await db.query('SELECT slug FROM clients WHERE id=$1', [id(1)])).rows[0];
    assert.equal(client.slug, 'sunset-beach');
    assert.equal((await db.query('SELECT count(*)::int n FROM conversations')).rows[0].n, 1);
    assert.equal((await db.query('SELECT client_id FROM conversations')).rows[0].client_id, id(1));
  } finally {
    await db.close();
  }
});

function swapTables() {
  const clientId = id(1);
  const roomA = id(2);
  const roomB = id(12);
  const seasonA = id(4);
  const seasonB = id(14);
  return {
    clients: [{ id: clientId, slug: 'wolfhouse-somo', name: 'Wolfhouse', currency: 'EUR', timezone: 'Europe/Madrid' }],
    rooms: [
      {
        id: roomA, client_id: clientId, room_code: 'R1', name: 'Room 1', capacity: 4,
        fill_priority: 2, private_priority: 3, gender_strategy: 'mixed', room_type: 'dorm',
        sort_order: 1, can_be_matrimonial: true, often_used_by_operator: true, avoid_until_needed: true, active: true,
      },
      {
        id: roomB, client_id: clientId, room_code: 'R2', name: 'Room 2', capacity: 5,
        fill_priority: 3, private_priority: 4, gender_strategy: 'mixed', room_type: 'dorm',
        sort_order: 2, can_be_matrimonial: false, often_used_by_operator: false, avoid_until_needed: false, active: true,
      },
    ],
    beds: [
      {
        id: id(3), client_id: clientId, room_id: roomA, bed_code: 'R1-1', bed_number: 1,
        bed_label: 'R1-1', planning_row_label: 'A', sellable: false, active: true,
      },
      {
        id: id(13), client_id: clientId, room_id: roomB, bed_code: 'R2-1', bed_number: 1,
        bed_label: 'R2-1', planning_row_label: 'B', sellable: true, active: true,
      },
    ],
    wh_pricing_seasons: [
      { id: seasonA, client_slug: 'wolfhouse-somo', code: 'summer', label: 'Summer', priority: 0, bookable: true, active: true, sort_order: 0 },
      { id: seasonB, client_slug: 'wolfhouse-somo', code: 'winter', label: 'Winter', priority: 1, bookable: true, active: true, sort_order: 1 },
    ],
    wh_pricing_season_ranges: [
      { id: id(5), season_id: seasonA, client_slug: 'wolfhouse-somo', start_month: 1, start_day: 1, end_month: 6, end_day: 30, sort_order: 0 },
      { id: id(15), season_id: seasonB, client_slug: 'wolfhouse-somo', start_month: 7, start_day: 1, end_month: 12, end_day: 31, sort_order: 1 },
    ],
    wh_pricing_items: [
      { id: id(20), client_slug: 'wolfhouse-somo', item_type: 'rental', item_code: 'wetsuit_rental', label: 'Wetsuit', description: null, metadata: {}, active: true, sort_order: 0 },
      { id: id(21), client_slug: 'wolfhouse-somo', item_type: 'rental', item_code: 'soft_top_rental', label: 'Soft top', description: null, metadata: {}, active: true, sort_order: 1 },
    ],
    wh_pricing_rules: [
      { id: id(31), client_slug: 'wolfhouse-somo', item_type: 'rental', item_code: 'wetsuit_rental', season_code: null, unit: 'per_day', amount_cents: 600, currency: 'EUR', active: true },
      { id: id(32), client_slug: 'wolfhouse-somo', item_type: 'rental', item_code: 'soft_top_rental', season_code: null, unit: 'per_day', amount_cents: 1500, currency: 'EUR', active: true },
    ],
    wh_pricing_transfer_rules: [
      { id: id(40), client_slug: 'wolfhouse-somo', airport_code: 'SDR', label: 'Santander', aliases: '{}', requires_package: false, included_when_package: true, min_guest_count: null, max_guest_count: null, active: true, sort_order: 0 },
      { id: id(41), client_slug: 'wolfhouse-somo', airport_code: 'BIO', label: 'Bilbao', aliases: '{}', requires_package: true, included_when_package: false, min_guest_count: 4, max_guest_count: null, active: true, sort_order: 1 },
    ],
  };
}

async function insertSwappedKeys(db, tables) {
  const c = tables.clients[0];
  await db.query('INSERT INTO clients VALUES ($1,$2,$3,$4,$5)', [c.id, c.slug, c.name, c.currency, c.timezone]);
  const r0 = tables.rooms[0];
  const r1 = tables.rooms[1];
  await db.query(
    'INSERT INTO rooms VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
    [r0.id, r0.client_id, r1.room_code, r0.name, r0.capacity, r0.fill_priority, r0.private_priority, r0.gender_strategy, r0.room_type, r0.sort_order, r0.can_be_matrimonial, r0.often_used_by_operator, r0.avoid_until_needed, r0.active],
  );
  await db.query(
    'INSERT INTO rooms VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
    [r1.id, r1.client_id, r0.room_code, r1.name, r1.capacity, r1.fill_priority, r1.private_priority, r1.gender_strategy, r1.room_type, r1.sort_order, r1.can_be_matrimonial, r1.often_used_by_operator, r1.avoid_until_needed, r1.active],
  );
  const b0 = tables.beds[0];
  const b1 = tables.beds[1];
  await db.query(
    'INSERT INTO beds VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [b0.id, b0.client_id, b0.room_id, b1.bed_code, b0.bed_number, b0.bed_label, b0.planning_row_label, b0.sellable, b0.active],
  );
  await db.query(
    'INSERT INTO beds VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [b1.id, b1.client_id, b1.room_id, b0.bed_code, b1.bed_number, b1.bed_label, b1.planning_row_label, b1.sellable, b1.active],
  );
  const s0 = tables.wh_pricing_seasons[0];
  const s1 = tables.wh_pricing_seasons[1];
  await db.query('INSERT INTO wh_pricing_seasons VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [s0.id, s0.client_slug, s1.code, s0.label, s0.priority, s0.bookable, s0.active, s0.sort_order]);
  await db.query('INSERT INTO wh_pricing_seasons VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [s1.id, s1.client_slug, s0.code, s1.label, s1.priority, s1.bookable, s1.active, s1.sort_order]);
  for (const rng of tables.wh_pricing_season_ranges) {
    await db.query(
      'INSERT INTO wh_pricing_season_ranges VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [rng.id, rng.season_id, rng.client_slug, rng.start_month, rng.start_day, rng.end_month, rng.end_day, rng.sort_order],
    );
  }
  const i0 = tables.wh_pricing_items[0];
  const i1 = tables.wh_pricing_items[1];
  await db.query('INSERT INTO wh_pricing_items VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)', [i0.id, i0.client_slug, i0.item_type, i1.item_code, i0.label, i0.description, '{}', i0.active, i0.sort_order]);
  await db.query('INSERT INTO wh_pricing_items VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)', [i1.id, i1.client_slug, i1.item_type, i0.item_code, i1.label, i1.description, '{}', i1.active, i1.sort_order]);
  const ru0 = tables.wh_pricing_rules[0];
  const ru1 = tables.wh_pricing_rules[1];
  await db.query('INSERT INTO wh_pricing_rules VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [ru0.id, ru0.client_slug, ru0.item_type, ru1.item_code, ru0.season_code, ru0.unit, ru0.amount_cents, ru0.currency, ru0.active]);
  await db.query('INSERT INTO wh_pricing_rules VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [ru1.id, ru1.client_slug, ru1.item_type, ru0.item_code, ru1.season_code, ru1.unit, ru1.amount_cents, ru1.currency, ru1.active]);
  const t0 = tables.wh_pricing_transfer_rules[0];
  const t1 = tables.wh_pricing_transfer_rules[1];
  await db.query('INSERT INTO wh_pricing_transfer_rules VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [t0.id, t0.client_slug, t1.airport_code, t0.label, t0.aliases, t0.requires_package, t0.included_when_package, t0.min_guest_count, t0.max_guest_count, t0.active, t0.sort_order]);
  await db.query('INSERT INTO wh_pricing_transfer_rules VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [t1.id, t1.client_slug, t0.airport_code, t1.label, t1.aliases, t1.requires_package, t1.included_when_package, t1.min_guest_count, t1.max_guest_count, t1.active, t1.sort_order]);
}

test('retained-id natural-key swaps converge on six unique-key tables', async () => {
  const db = new PGlite();
  try {
    await execSchema(db);
    const tables = swapTables();
    await insertSwappedKeys(db, tables);
    const envelope = contract.envelope(tables);
    const imported = await adapter.applyImport(new contract.SqlConfigAdapter(db), envelope, TARGET);
    assert.equal(imported.configHash, envelope.configHash);
    const actual = await readBack(db);
    assert.equal(contract.hash(actual), envelope.configHash);
    assert.equal(actual.rooms.find((row) => row.id === id(2)).room_code, 'R1');
    assert.equal(actual.rooms.find((row) => row.id === id(12)).room_code, 'R2');
    assert.equal(actual.beds.find((row) => row.id === id(3)).bed_code, 'R1-1');
    assert.equal(actual.wh_pricing_seasons.find((row) => row.id === id(4)).code, 'summer');
    assert.equal(actual.wh_pricing_items.find((row) => row.id === id(20)).item_code, 'wetsuit_rental');
    assert.equal(actual.wh_pricing_rules.find((row) => row.id === id(31)).item_code, 'wetsuit_rental');
    assert.equal(actual.wh_pricing_transfer_rules.find((row) => row.id === id(40)).airport_code, 'SDR');
  } finally {
    await db.close();
  }
});
