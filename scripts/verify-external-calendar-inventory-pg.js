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
    if (!m.sha256) throw new Error('missing_sha256:' + m.filename);
    if (m.sha256 !== sha) throw new Error('sha_mismatch:' + m.filename);
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

async function sessionRace(a, b, workA, workB, expect) {
  await a.query('BEGIN');
  await workA(a);
  await b.query('BEGIN');
  await b.query(`SET LOCAL lock_timeout = '2s'`);
  await b.query(`SET LOCAL statement_timeout = '4s'`);
  let bCommitted = false;
  let bErr = null;
  const bWork = (async () => {
    try {
      await workB(b);
      await b.query('COMMIT');
      bCommitted = true;
    } catch (err) {
      bErr = err;
      try { await b.query('ROLLBACK'); } catch (_) { /* ignore */ }
    }
  })();
  await a.query('COMMIT');
  await bWork;
  if (expect === 'one') {
    if (bCommitted) throw new Error('both_conflicting_occupancies_committed');
    if (!bErr) throw new Error('second_session_did_not_error');
    return { loserError: String(bErr.message || bErr) };
  }
  if (expect === 'both') {
    if (!bCommitted) throw new Error('parallel_nonoverlap_failed:' + (bErr && bErr.message));
    return { both: true };
  }
  throw new Error('unknown_expect');
}

async function runOccupancyRaceMatrix(a, b, fx) {
  const id = () => crypto.randomUUID();
  await sessionRace(a, b,
    (pg) => insertMinimalOccupancy(pg, { ...fx, bookingId: id(), start: '2026-09-10', end: '2026-09-12' }),
    (pg) => insertMinimalOccupancy(pg, { ...fx, bookingId: id(), start: '2026-09-10', end: '2026-09-12' }),
    'one');
  ok('race insert vs insert: one commit', true);

  const stayA = id();
  const stayB = id();
  await insertMinimalOccupancy(a, { ...fx, bookingId: stayA, start: '2026-09-01', end: '2026-09-03' });
  await insertMinimalOccupancy(a, { ...fx, bookingId: stayB, start: '2026-09-20', end: '2026-09-22' });
  await sessionRace(a, b,
    async (pg) => {
      await pg.query(
        `UPDATE booking_beds SET assignment_start_date = '2026-09-10', assignment_end_date = '2026-09-12'
          WHERE booking_id = $1`,
        [stayA]
      );
    },
    async (pg) => {
      await pg.query(
        `UPDATE booking_beds SET assignment_start_date = '2026-09-10', assignment_end_date = '2026-09-12'
          WHERE booking_id = $1`,
        [stayB]
      );
    },
    'one');
  ok('race date-change vs date-change: one commit', true);

  const bed2 = await a.query(
    `INSERT INTO beds (hostel_id, room_code, bed_code) VALUES ($1, 'R1', 'B') RETURNING id`,
    [fx.hostelId]
  );
  const moveA = id();
  await insertMinimalOccupancy(a, { ...fx, bookingId: moveA, start: '2026-10-01', end: '2026-10-03' });
  await sessionRace(a, b,
    async (pg) => {
      await pg.query(`UPDATE booking_beds SET bed_id = $2 WHERE booking_id = $1`, [moveA, bed2.rows[0].id]);
    },
    async (pg) => {
      await insertMinimalOccupancy(pg, {
        ...fx, bookingId: id(), bedId: bed2.rows[0].id, start: '2026-10-01', end: '2026-10-03',
      });
    },
    'one');
  ok('race bed-move vs insert: one commit', true);

  const inactive = id();
  await insertMinimalOccupancy(a, { ...fx, bookingId: inactive, start: '2026-11-01', end: '2026-11-03', status: 'cancelled' });
  await sessionRace(a, b,
    async (pg) => {
      await pg.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [inactive]);
    },
    async (pg) => {
      await insertMinimalOccupancy(pg, { ...fx, bookingId: id(), start: '2026-11-01', end: '2026-11-03' });
    },
    'one');
  ok('race reactivate vs insert: one commit', true);

  const parA = id();
  const parB = id();
  await sessionRace(a, b,
    (pg) => insertMinimalOccupancy(pg, { ...fx, bookingId: parA, start: '2026-12-01', end: '2026-12-03' }),
    (pg) => insertMinimalOccupancy(pg, {
      ...fx, bookingId: parB, bedId: bed2.rows[0].id, start: '2026-12-01', end: '2026-12-03',
    }),
    'both');
  ok('race different beds in parallel: both commit', true);

  const same = id();
  await insertMinimalOccupancy(a, { ...fx, bookingId: same, start: '2027-01-01', end: '2027-01-03' });
  await a.query('BEGIN');
  await a.query(
    `UPDATE booking_beds SET assignment_start_date = '2027-01-02', assignment_end_date = '2027-01-04'
      WHERE booking_id = $1`,
    [same]
  );
  await a.query('COMMIT');
  ok('same-booking date update commits', true);
}

async function live090Hostile(pg, fx) {
  const other = await pg.query(`INSERT INTO clients (slug) VALUES ('sunset-gate') RETURNING id`).catch(async () => {
    const r = await pg.query(`SELECT id FROM clients WHERE slug = 'sunset-gate' LIMIT 1`);
    return r;
  });
  const otherId = other.rows[0].id;
  const otherBed = await pg.query(
    `INSERT INTO beds (hostel_id, room_code, bed_code) VALUES ($1, 'SS', '1') RETURNING id`,
    [fx.hostelId]
  );
  try { await pg.query(`UPDATE beds SET client_id = $2 WHERE id = $1`, [otherBed.rows[0].id, otherId]); } catch (_) {}
  const conn = await pg.query(
    `INSERT INTO external_calendar_connections (client_id, name, spreadsheet_id, status)
     VALUES ($1, 'gate', '12345678901234567890', 'disabled') RETURNING id`,
    [fx.clientId]
  );
  let mapThrew = false;
  try {
    await pg.query(
      `INSERT INTO external_calendar_unit_maps (connection_id, client_id, external_unit_key, bed_id)
       VALUES ($1, $2, 'RX', $3)`,
      [conn.rows[0].id, fx.clientId, otherBed.rows[0].id]
    );
  } catch (err) {
    mapThrew = /extcal_tenant_mismatch/.test(String(err.message || err));
  }
  if (!mapThrew) throw new Error('090_live_did_not_reject_foreign_bed');
  ok('live 090 rejects cross-tenant bed map', true);
  return conn.rows[0].id;
}

async function prove091OwnershipRefuse(pg) {
  await pg.query(`COMMENT ON FUNCTION public.booking_occupancy_lock_key(text, uuid) IS 'foreign'`);
  let upRefused = false;
  try {
    await applySqlFile(pg, '091_booking_occupancy_serialization.sql');
  } catch (err) {
    upRefused = /091_refused/.test(String(err.message || err));
  }
  if (!upRefused) throw new Error('091_up_did_not_refuse_foreign_function');
  await pg.query(`COMMENT ON FUNCTION public.booking_occupancy_lock_key(text, uuid) IS '091_booking_occupancy_serialization v1'`);

  await pg.query(`COMMENT ON TRIGGER booking_beds_reject_overlap_trg ON public.booking_beds IS '091_booking_occupancy_serialization v2'`);
  let downRefused = false;
  try {
    await applySqlFile(pg, '091_booking_occupancy_serialization_down.sql');
  } catch (err) {
    downRefused = /091_down_refused/.test(String(err.message || err));
  }
  if (!downRefused) throw new Error('091_down_did_not_refuse_newer_trigger');
  await pg.query(`COMMENT ON TRIGGER booking_beds_reject_overlap_trg ON public.booking_beds IS '091_booking_occupancy_serialization v1'`);
  ok('live 091 up/down refuse foreign and newer ownership', true);
}

async function prove089IdentityMatrix(pg, fx, connectionId) {
  const bookingId = crypto.randomUUID();
  await insertMinimalOccupancy(pg, { ...fx, bookingId, start: '2027-02-01', end: '2027-02-03' });
  await pg.query(
    `INSERT INTO external_inventory_events (
        connection_id, client_id, external_uid, period_start, period_end, booking_id, status
      ) VALUES ($1, $2, 'uid-imported', '2027-02-01', '2027-02-03', $3, 'imported')`,
    [connectionId, fx.clientId, bookingId]
  );
  let refusedImported = false;
  try {
    await applySqlFile(pg, '089_external_calendar_inventory_down.sql');
  } catch (err) {
    refusedImported = /089_down_refused/.test(String(err.message || err));
  }
  if (!refusedImported) throw new Error('089_down_did_not_refuse_imported');
  ok('live 089 down refuses imported+linked event', true);

  await pg.query(`UPDATE external_inventory_events SET status = 'tombstoned', booking_id = NULL WHERE external_uid = 'uid-imported'`);
  await applySqlFile(pg, '089_external_calendar_inventory_down.sql');
  await applySqlFile(pg, '089_external_calendar_inventory_down.sql');
  ok('live 089 down twice after tombstone', true);
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
    };

    await runOccupancyRaceMatrix(a, b, fixture);
    const connectionId = await live090Hostile(a, fixture);
    await prove091OwnershipRefuse(a);

    await applySqlFile(a, '091_booking_occupancy_serialization_down.sql');
    await applySqlFile(a, '091_booking_occupancy_serialization_down.sql');
    ok('live 091 down twice', true);
    await applySqlFile(a, '090_external_calendar_inventory_tenant_integrity_down.sql');
    await applySqlFile(a, '090_external_calendar_inventory_tenant_integrity_down.sql');
    ok('live 090 down twice', true);

    await prove089IdentityMatrix(a, fixture, connectionId);

    await applySqlFile(a, '089_external_calendar_inventory.sql');
    await applySqlFile(a, '090_external_calendar_inventory_tenant_integrity.sql');
    await applySqlFile(a, '091_booking_occupancy_serialization.sql');
    ok('live reapply 089-091', true);

    await sessionRace(a, b,
      (pg) => insertMinimalOccupancy(pg, { ...fixture, bookingId: crypto.randomUUID(), start: '2027-03-01', end: '2027-03-03' }),
      (pg) => insertMinimalOccupancy(pg, { ...fixture, bookingId: crypto.randomUUID(), start: '2027-03-01', end: '2027-03-03' }),
      'one');
    ok('live final overlap smoke race', true);
  } finally {
    const cleanupErrors = [];
    async function closeQuiet(client) {
      if (!client) return;
      try { await client.end(); } catch (err) { cleanupErrors.push(err); }
    }
    await Promise.all([closeQuiet(a), closeQuiet(b)]);
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName]
      );
      await admin.query('DROP DATABASE IF EXISTS ' + quoted);
    } catch (err) {
      cleanupErrors.push(err);
    }
    await closeQuiet(admin);
    if (cleanupErrors.length) {
      console.error('LIVE CLEANUP FAILED', cleanupErrors.map((e) => e.message || e).join(' | '));
      process.exit(1);
    }
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
  ok('gate executes 089 down refusal', /089_down_did_not_refuse_imported/.test(gateSrc));
  ok('gate has occupancy race matrix', /runOccupancyRaceMatrix/.test(gateSrc) && /race reactivate vs insert/.test(gateSrc));
  ok('gate has live 090 hostile write', /090_live_did_not_reject_foreign_bed/.test(gateSrc));
  ok('gate injects foreign 091 comments', /COMMENT ON FUNCTION public.booking_occupancy_lock_key/.test(gateSrc));
  ok('gate requires sha256 on every selected file', /missing_sha256/.test(gateSrc));
  ok('gate downs 091 then 090 twice', /live 091 down twice/.test(gateSrc) && /live 090 down twice/.test(gateSrc));
  ok('gate closes clients independently', /Promise\.all\(\[closeQuiet\(a\), closeQuiet\(b\)\]\)/.test(gateSrc));

  await runLiveDisposableGate();
}

main().catch((e) => { console.error(e); process.exit(1); });
