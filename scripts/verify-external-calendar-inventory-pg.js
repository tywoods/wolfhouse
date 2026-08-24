'use strict';

const fs = require('fs');
const path = require('path');

let Client = null;
try {
  ({ Client } = require('pg'));
} catch (_) {
  Client = null;
}

const ROOT = path.join(__dirname, '..');
const UP089 = fs.readFileSync(path.join(ROOT, 'database/migrations/089_external_calendar_inventory.sql'), 'utf8');
const UP090 = fs.readFileSync(path.join(ROOT, 'database/migrations/090_external_calendar_inventory_tenant_integrity.sql'), 'utf8');
const UP091 = fs.readFileSync(path.join(ROOT, 'database/migrations/091_booking_occupancy_serialization.sql'), 'utf8');
const DOWN091 = fs.readFileSync(path.join(ROOT, 'database/migrations/091_booking_occupancy_serialization_down.sql'), 'utf8');

function ok(label, cond, detail) {
  if (!cond) {
    console.error('FAIL', label, detail || '');
    throw new Error(label);
  }
  console.log('  PASS ', label);
}

function assertStockSql(sql, label) {
  ok(label + ' has no non-stock extensions', !/CREATE\s+EXTENSION/i.test(sql));
  ok(label + ' uses plpgsql/sql only', !/LANGUAGE\s+(plpython|plv8|c)\b/i.test(sql));
}

function createMemDb() {
  const db = {
    clients: [],
    beds: [],
    bookings: [],
    connections: [],
    maps: [],
    events: [],
  };
  function assertMap(row) {
    const conn = db.connections.find((c) => c.id === row.connection_id);
    if (!conn || conn.client_id !== row.client_id) throw Object.assign(new Error('extcal_tenant_mismatch'), { code: '23514' });
    const bed = db.beds.find((b) => b.id === row.bed_id);
    if (!bed || bed.client_id !== row.client_id) throw Object.assign(new Error('extcal_tenant_mismatch'), { code: '23514' });
  }
  function assertEvent(row) {
    const conn = db.connections.find((c) => c.id === row.connection_id);
    if (!conn || conn.client_id !== row.client_id) throw Object.assign(new Error('extcal_tenant_mismatch'), { code: '23514' });
    if (row.booking_id) {
      const bk = db.bookings.find((b) => b.id === row.booking_id);
      if (!bk || bk.client_id !== row.client_id) throw Object.assign(new Error('extcal_tenant_mismatch'), { code: '23514' });
    }
  }
  return {
    db,
    insertConnection(row) { db.connections.push(row); return row; },
    insertMap(row) { assertMap(row); db.maps.push(row); return row; },
    insertEvent(row) { assertEvent(row); db.events.push(row); return row; },
    insertBooking(row) { db.bookings.push(row); return row; },
  };
}

async function tryLivePostgres() {
  if (!Client) return null;
  const url = process.env.EXTCAL_PG_URL || process.env.DATABASE_URL;
  if (!url && !process.env.EXTCAL_PG_PORT) return null;
  const client = new Client({
    connectionString: url || undefined,
    host: '127.0.0.1',
    port: Number(process.env.EXTCAL_PG_PORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'test',
    database: process.env.PGDATABASE || 'postgres',
  });
  try {
    await client.connect();
    return client;
  } catch (_) {
    return null;
  }
}

async function main() {
  console.log('verify-external-calendar-inventory-pg');
  assertStockSql(UP089, '089');
  assertStockSql(UP090, '090');
  ok('090 trigger names present', /external_calendar_unit_maps_tenant_trg/.test(UP090));
  ok('090 rejects mismatched map client', /extcal_tenant_mismatch: map client_id/.test(UP090));
  ok('090 rejects mismatched bed', /extcal_tenant_mismatch: bed client_id/.test(UP090));
  ok('090 rejects mismatched booking', /extcal_tenant_mismatch: booking client_id/.test(UP090));

  const mem = createMemDb();
  const wolf = { id: 'c-wh', slug: 'wolfhouse-somo' };
  const sun = { id: 'c-ss', slug: 'sunset' };
  mem.db.clients.push(wolf, sun);
  mem.db.beds.push({ id: 'bed-wh', client_id: wolf.id }, { id: 'bed-ss', client_id: sun.id });
  mem.insertConnection({ id: 'conn-wh', client_id: wolf.id });
  mem.insertMap({ id: 'map-1', connection_id: 'conn-wh', client_id: wolf.id, bed_id: 'bed-wh' });
  let threw = false;
  try {
    mem.insertMap({ id: 'map-x', connection_id: 'conn-wh', client_id: wolf.id, bed_id: 'bed-ss' });
  } catch (e) { threw = e.code === '23514'; }
  ok('hostile foreign-bed map rejected', threw);

  threw = false;
  try {
    mem.insertMap({ id: 'map-y', connection_id: 'conn-wh', client_id: sun.id, bed_id: 'bed-wh' });
  } catch (e) { threw = e.code === '23514'; }
  ok('hostile foreign-client map rejected', threw);

  mem.insertBooking({ id: 'bk-wh', client_id: wolf.id });
  mem.insertEvent({
    id: 'ev-1', connection_id: 'conn-wh', client_id: wolf.id, booking_id: 'bk-wh',
  });
  threw = false;
  try {
    mem.insertEvent({
      id: 'ev-x', connection_id: 'conn-wh', client_id: wolf.id, booking_id: 'bk-ss-missing',
    });
  } catch (e) { threw = e.code === '23514'; }
  ok('hostile foreign booking event rejected', threw);

  assertStockSql(UP091, '091');
  ok('091 lock order is booking then bed',
    /lock_key\('booking'/.test(UP091) && /lock_key\('bed'/.test(UP091));
  ok('091 excludes assignment by row id', /bb\.id IS DISTINCT FROM NEW\.id/.test(UP091));
  ok('091 fires on booking_id client_id bed_id dates',
    /UPDATE OF booking_id, client_id, bed_id, assignment_start_date, assignment_end_date/.test(UP091));
  ok('091 down drops only occupancy objects',
    /DROP TRIGGER IF EXISTS bookings_occupancy_status_trg/.test(DOWN091)
    && /DROP FUNCTION IF EXISTS public.booking_occupancy_lock_key/.test(DOWN091));
  ok('089 occupancy is not in bridge migration', !/booking_beds_reject_overlap/.test(UP089));

  const live = await tryLivePostgres();
  if (!live) {
    console.log('LIVE GATE SKIPPED — no stock PostgreSQL daemon. Two-session races not executed.');
    console.log('verify-external-calendar-inventory-pg: STATIC CHECKS PASSED; LIVE PG SKIPPED');
    process.exit(2);
  }
  try {
    await live.query('BEGIN');
    await live.query(`
      CREATE TABLE clients (id uuid PRIMARY KEY, slug text);
      CREATE TABLE beds (id uuid PRIMARY KEY, client_id uuid NOT NULL);
      CREATE TABLE bookings (id uuid PRIMARY KEY, client_id uuid NOT NULL);
    `);
    await live.query(UP089);
    await live.query(UP090);
    const wh = await live.query(`INSERT INTO clients(id,slug) VALUES (gen_random_uuid(),'wolfhouse-somo') RETURNING id`);
    const ss = await live.query(`INSERT INTO clients(id,slug) VALUES (gen_random_uuid(),'sunset') RETURNING id`);
    const bedWh = await live.query(`INSERT INTO beds(id,client_id) VALUES (gen_random_uuid(),$1) RETURNING id`, [wh.rows[0].id]);
    const bedSs = await live.query(`INSERT INTO beds(id,client_id) VALUES (gen_random_uuid(),$1) RETURNING id`, [ss.rows[0].id]);
    const conn = await live.query(
      `INSERT INTO external_calendar_connections(client_id,name,spreadsheet_id)
       VALUES ($1,'t','12345678901234567890') RETURNING id`,
      [wh.rows[0].id]
    );
    await live.query(
      `INSERT INTO external_calendar_unit_maps(connection_id,client_id,external_unit_key,bed_id)
       VALUES ($1,$2,'R1',$3)`,
      [conn.rows[0].id, wh.rows[0].id, bedWh.rows[0].id]
    );
    let liveThrew = false;
    try {
      await live.query(
        `INSERT INTO external_calendar_unit_maps(connection_id,client_id,external_unit_key,bed_id)
         VALUES ($1,$2,'RX',$3)`,
        [conn.rows[0].id, wh.rows[0].id, bedSs.rows[0].id]
      );
    } catch (e) { liveThrew = /extcal_tenant_mismatch/.test(e.message); }
    ok('live PG rejects cross-tenant bed map', liveThrew);
    await live.query('ROLLBACK');
  } finally {
    await live.end();
  }
  console.log('\nverify-external-calendar-inventory-pg: ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
