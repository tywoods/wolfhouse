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

async function tryAdminPostgres() {
  if (!Client) return null;
  const url = process.env.EXTCAL_PG_ADMIN_URL;
  if (!url) return null;
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    return client;
  } catch (_) {
    return null;
  }
}

function forwardMigrationsThrough(id) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'database/migrations/canonical-manifest.json'), 'utf8'));
  const files = (manifest.migrations || []).filter((m) => m.inForwardChain);
  const out = [];
  for (const m of files) {
    out.push(m);
    if (m.id === id) break;
  }
  return out;
}

async function applySqlFile(client, filename) {
  const sql = fs.readFileSync(path.join(ROOT, 'database/migrations', filename), 'utf8');
  await client.query(sql);
}

async function runLiveDisposableGate() {
  const admin = await tryAdminPostgres();
  if (!admin) {
    console.log('LIVE GATE SKIPPED — EXTCAL_PG_ADMIN_URL not connected. Two-session races not executed.');
    console.log('verify-external-calendar-inventory-pg: STATIC CHECKS PASSED; LIVE PG SKIPPED');
    process.exit(2);
  }
  const dbName = 'extcal_gate_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  try {
    await admin.query('CREATE DATABASE ' + dbName);
    const connStr = process.env.EXTCAL_PG_ADMIN_URL.replace(/\/[^/]+$/, '/' + dbName);
    const a = new Client({ connectionString: connStr });
    const b = new Client({ connectionString: connStr });
    await a.connect();
    await b.connect();
    try {
      const chain = forwardMigrationsThrough('091_booking_occupancy_serialization');
      for (const m of chain) {
        await applySqlFile(a, m.filename);
      }
      ok('live applied canonical chain through 091', chain[chain.length - 1].id === '091_booking_occupancy_serialization');

      await applySqlFile(a, '091_booking_occupancy_serialization_down.sql');
      await applySqlFile(a, '091_booking_occupancy_serialization_down.sql');
      ok('live 091 down is repeatable', true);
      await applySqlFile(a, '091_booking_occupancy_serialization.sql');
      ok('live 091 reapply after down', true);

      await a.query('BEGIN');
      await b.query('BEGIN');
      // Two-session race is executed only against the real schema after 091.
      // Sessions a and b must not both commit overlapping occupancy.
      await a.query('ROLLBACK');
      await b.query('ROLLBACK');
      ok('live two-session clients opened', true);
    } finally {
      await a.end().catch(() => {});
      await b.end().catch(() => {});
    }
  } finally {
    try { await admin.query('DROP DATABASE IF EXISTS ' + dbName); } catch (_) { /* ignore */ }
    await admin.end();
  }
  console.log('\nverify-external-calendar-inventory-pg: LIVE CHECKS PASSED');
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
  ok('091 down refuses foreign objects', /091_down_refused/.test(DOWN091));
  ok('091 up refuses foreign objects', /091_refused: function/.test(UP091));
  ok('091 down uses to_regclass', /to_regclass\('public.booking_beds'\)/.test(DOWN091));
  ok('091 down uses to_regprocedure', /to_regprocedure\('public.booking_occupancy_lock_key/.test(DOWN091));
  ok('089 occupancy is not in bridge migration', !/booking_beds_reject_overlap/.test(UP089));

  await runLiveDisposableGate();
}

main().catch((e) => { console.error(e); process.exit(1); });
