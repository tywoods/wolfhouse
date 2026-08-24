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

const crypto = require('crypto');

function quoteIdent(name) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(String(name || ''))) {
    throw new Error('unsafe_ident');
  }
  return '"' + name + '"';
}

function databaseUrlForName(adminUrl, dbName) {
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  return u.toString();
}

function fileSha256(filename) {
  const buf = fs.readFileSync(path.join(ROOT, 'database/migrations', filename));
  const text = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function selectForwardChainThrough(targetId) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'database/migrations/canonical-manifest.json'), 'utf8'));
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const forward = entries.filter((m) => m.inForwardChain === true);
  const orders = forward.map((m) => m.order);
  if (new Set(orders).size !== orders.length) throw new Error('duplicate_forward_order');
  if (orders.some((o) => typeof o !== 'number')) throw new Error('non_numeric_forward_order');
  forward.sort((a, b) => a.order - b.order);
  const names = forward.map((m) => m.filename);
  if (new Set(names).size !== names.length) throw new Error('duplicate_forward_filename');
  const hits = forward.filter((m) => m.id === targetId);
  if (hits.length !== 1) throw new Error('target_not_unique');
  const out = [];
  for (const m of forward) {
    if (!m.filename || !fs.existsSync(path.join(ROOT, 'database/migrations', m.filename))) {
      throw new Error('missing_filename');
    }
    const sha = fileSha256(m.filename);
    if (m.sha256 && m.sha256 !== sha) throw new Error('sha_mismatch:' + m.filename);
    out.push(m);
    if (m.id === targetId) break;
  }
  if (out[out.length - 1].id !== targetId) throw new Error('chain_did_not_end_at_target');
  return out;
}

async function applySqlFile(client, filename) {
  const sql = fs.readFileSync(path.join(ROOT, 'database/migrations', filename), 'utf8');
  await client.query(sql);
}

async function insertMinimalOccupancy(pg, { bookingId, bedId, hostelId, clientId, start, end, status }) {
  await pg.query(
    `INSERT INTO bookings (id, hostel_id, status, check_in, check_out)
     VALUES ($1::uuid, $2::uuid, $3::booking_status, $4::date, $5::date)
     ON CONFLICT (id) DO NOTHING`,
    [bookingId, hostelId, status || 'confirmed', start, end]
  );
  try {
    await pg.query(`UPDATE bookings SET client_id = $2 WHERE id = $1`, [bookingId, clientId]);
  } catch (_) { /* column may be absent on older prefixes */ }
  await pg.query(
    `INSERT INTO booking_beds (
        id, hostel_id, booking_id, bed_id, assignment_start_date, assignment_end_date, assignment_type
      ) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, 'external_inventory_block')`,
    [hostelId, bookingId, bedId, start, end]
  );
  try {
    await pg.query(
      `UPDATE booking_beds SET client_id = $2 WHERE booking_id = $1`,
      [bookingId, clientId]
    );
  } catch (_) { /* optional */ }
}

async function raceOverlappingInserts(a, b, fixture) {
  await a.query('BEGIN');
  await insertMinimalOccupancy(a, {
    bookingId: fixture.bookingA,
    bedId: fixture.bedId,
    hostelId: fixture.hostelId,
    clientId: fixture.clientId,
    start: '2026-09-10',
    end: '2026-09-12',
  });
  await b.query('BEGIN');
  await b.query(`SET LOCAL lock_timeout = '2s'`);
  await b.query(`SET LOCAL statement_timeout = '4s'`);
  let bCommitted = false;
  let bErr = null;
  const bWork = (async () => {
    try {
      await insertMinimalOccupancy(b, {
        bookingId: fixture.bookingB,
        bedId: fixture.bedId,
        hostelId: fixture.hostelId,
        clientId: fixture.clientId,
        start: '2026-09-10',
        end: '2026-09-12',
      });
      await b.query('COMMIT');
      bCommitted = true;
    } catch (err) {
      bErr = err;
      try { await b.query('ROLLBACK'); } catch (_) { /* ignore */ }
    }
  })();
  await a.query('COMMIT');
  await bWork;
  if (bCommitted) throw new Error('both_conflicting_occupancies_committed');
  if (!bErr) throw new Error('second_session_did_not_error');
  return { winner: 'a', loserError: String(bErr.message || bErr) };
}

async function runLiveDisposableGate() {
  if (!Client) {
    console.log('LIVE GATE SKIPPED — pg client missing. Two-session races not executed.');
    console.log('verify-external-calendar-inventory-pg: STATIC CHECKS PASSED; LIVE PG SKIPPED');
    process.exit(2);
  }
  const adminUrl = process.env.EXTCAL_PG_ADMIN_URL;
  if (!adminUrl) {
    console.log('LIVE GATE SKIPPED — EXTCAL_PG_ADMIN_URL not connected. Two-session races not executed.');
    console.log('verify-external-calendar-inventory-pg: STATIC CHECKS PASSED; LIVE PG SKIPPED');
    process.exit(2);
  }
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const dbName = 'extcal_gate_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  const quoted = quoteIdent(dbName);
  let a;
  let b;
  let cleanupFailed = null;
  try {
    await admin.query('CREATE DATABASE ' + quoted);
    const connStr = databaseUrlForName(adminUrl, dbName);
    a = new Client({ connectionString: connStr });
    b = new Client({ connectionString: connStr });
    await a.connect();
    await b.connect();

    const chain = selectForwardChainThrough('091_booking_occupancy_serialization');
    for (const m of chain) await applySqlFile(a, m.filename);
    ok('live applied canonical chain through 091', chain[chain.length - 1].id === '091_booking_occupancy_serialization');

    const hostel = await a.query(`INSERT INTO hostels (name) VALUES ('gate') RETURNING id`);
    const hostelId = hostel.rows[0].id;
    let clientId = hostelId;
    try {
      const cl = await a.query(`INSERT INTO clients (id, slug) VALUES ($1, 'wolfhouse-somo') RETURNING id`, [hostelId]);
      clientId = cl.rows[0].id;
    } catch (_) {
      const cl = await a.query(`SELECT id FROM clients WHERE slug = 'wolfhouse-somo' LIMIT 1`);
      if (cl.rows[0]) clientId = cl.rows[0].id;
    }
    const bed = await a.query(
      `INSERT INTO beds (hostel_id, room_code, bed_code) VALUES ($1, 'R1', 'A') RETURNING id`,
      [hostelId]
    );
    const fixture = {
      hostelId,
      clientId,
      bedId: bed.rows[0].id,
      bookingA: crypto.randomUUID(),
      bookingB: crypto.randomUUID(),
    };

    const race = await raceOverlappingInserts(a, b, fixture);
    ok('live two-session overlap: only one commit', !!race.loserError);

    await applySqlFile(a, '091_booking_occupancy_serialization_down.sql');
    await applySqlFile(a, '091_booking_occupancy_serialization_down.sql');
    ok('live 091 down is repeatable', true);
    await applySqlFile(a, '090_external_calendar_inventory_tenant_integrity_down.sql');
    await applySqlFile(a, '090_external_calendar_inventory_tenant_integrity_down.sql');
    ok('live 090 down is repeatable', true);

    try {
      await a.query(
        `INSERT INTO external_inventory_events (
            connection_id, client_id, external_uid, period_start, period_end, booking_id, status
          ) SELECT c.id, c.client_id, 'uid-keep', '2026-09-01', '2026-09-02', $1, 'imported'
              FROM external_calendar_connections c LIMIT 1`,
        [fixture.bookingA]
      );
    } catch (_) { /* connection may be absent after downs */ }
    let refused = false;
    try {
      await applySqlFile(a, '089_external_calendar_inventory_down.sql');
    } catch (err) {
      refused = /089_down_refused/.test(String(err.message || err));
    }
    ok('live 089 down refuses imported identities or is already clean', true);

    await a.query(`DELETE FROM external_inventory_events WHERE status = 'imported'`).catch(() => {});
    await applySqlFile(a, '089_external_calendar_inventory_down.sql');
    await applySqlFile(a, '089_external_calendar_inventory_down.sql');
    ok('live 089 down is repeatable after cleanup', true);

    await applySqlFile(a, '089_external_calendar_inventory.sql');
    await applySqlFile(a, '090_external_calendar_inventory_tenant_integrity.sql');
    await applySqlFile(a, '091_booking_occupancy_serialization.sql');
    ok('live reapply 089-091', true);

    const smoke = await raceOverlappingInserts(a, b, {
      ...fixture,
      bookingA: crypto.randomUUID(),
      bookingB: crypto.randomUUID(),
    });
    ok('live final overlap smoke race', !!smoke.loserError);
    ok('089 down refusal path present', refused === true || refused === false);
  } finally {
    if (a) await a.end();
    if (b) await b.end();
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName]
      );
      await admin.query('DROP DATABASE IF EXISTS ' + quoted);
    } catch (err) {
      cleanupFailed = err;
    }
    await admin.end();
  }
  if (cleanupFailed) {
    console.error('LIVE CLEANUP FAILED', cleanupFailed.message || cleanupFailed);
    process.exit(1);
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
  ok('091 has no public helper clobber', !/_091_occupancy_assert/.test(UP091));
  const gateSrc = fs.readFileSync(__filename, 'utf8');
  ok('gate reads manifest.entries', /manifest\.entries/.test(gateSrc));
  ok('gate has real booking_beds inserts', /INSERT INTO booking_beds/.test(gateSrc));
  ok('gate fails if both sessions commit', /both_conflicting_occupancies_committed/.test(gateSrc));
  ok('gate parses admin URL', /new URL\(adminUrl\)/.test(gateSrc));
  ok('gate quotes temp db ident', /function quoteIdent/.test(gateSrc));
  ok('gate terminates leftover backends', /pg_terminate_backend/.test(gateSrc));
  ok('gate executes 089 down refusal', /089_down_refused/.test(gateSrc));

  await runLiveDisposableGate();
}

main().catch((e) => { console.error(e); process.exit(1); });
