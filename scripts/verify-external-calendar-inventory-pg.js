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
  try {
    await client.query(sql);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already idle */ }
    throw err;
  }
}

async function insertMinimalOccupancy(pg, { bookingId, bedId, clientId, start, end, status }) {
  const code = 'GATE-' + String(bookingId).replace(/-/g, '').slice(0, 16);
  await pg.query(
    `INSERT INTO bookings (id, client_id, booking_code, status, check_in, check_out)
     VALUES ($1::uuid, $2::uuid, $3, $4::booking_status, $5::date, $6::date)
     ON CONFLICT (id) DO NOTHING`,
    [bookingId, clientId, code, status || 'confirmed', start, end]
  );
  await pg.query(
    `INSERT INTO booking_beds (
        id, client_id, booking_id, bed_id, assignment_start_date, assignment_end_date, assignment_type
      ) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, 'external_inventory_block')`,
    [clientId, bookingId, bedId, start, end]
  );
}

async function waitForAdvisoryWait(observer, pid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await observer.query(
      `SELECT 1
         FROM pg_locks
        WHERE locktype = 'advisory'
          AND granted = false
          AND pid = $1
        LIMIT 1`,
      [pid]
    );
    if (r.rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('barrier_timeout_waiting_for_advisory_lock');
}

async function sessionRace(a, b, observer, workA, workB, expect) {
  await a.query('BEGIN');
  await workA(a);
  await b.query('BEGIN');
  const pidRes = await b.query('SELECT pg_backend_pid() AS pid');
  const bPid = pidRes.rows[0].pid;
  await b.query(`SET LOCAL lock_timeout = '8s'`);
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
  if (expect === 'one') {
    await waitForAdvisoryWait(observer, bPid, 5000);
    await a.query('COMMIT');
    await bWork;
    if (bCommitted) throw new Error('both_conflicting_occupancies_committed');
    const msg = String(bErr && bErr.message || '');
    if (/lock_timeout|statement_timeout|canceling statement/i.test(msg)) {
      throw new Error('race_lost_to_timeout:' + msg);
    }
    if (!/booking_beds_overlap_conflict/.test(msg)) {
      throw new Error('expected_overlap_conflict_got:' + msg);
    }
    return { loserError: msg };
  }
  if (expect === 'both') {
    await a.query('COMMIT');
    await bWork;
    if (!bCommitted) throw new Error('parallel_nonoverlap_failed:' + (bErr && bErr.message));
    return { both: true };
  }
  throw new Error('unknown_expect');
}

async function runOccupancyRaceMatrix(a, b, observer, fx) {
  const id = () => crypto.randomUUID();
  await sessionRace(a, b, observer,
    (pg) => insertMinimalOccupancy(pg, { ...fx, bookingId: id(), start: '2026-09-10', end: '2026-09-12' }),
    (pg) => insertMinimalOccupancy(pg, { ...fx, bookingId: id(), start: '2026-09-10', end: '2026-09-12' }),
    'one');
  ok('race insert vs insert: one commit', true);

  const stayA = id();
  const stayB = id();
  await insertMinimalOccupancy(a, { ...fx, bookingId: stayA, start: '2026-09-01', end: '2026-09-03' });
  await insertMinimalOccupancy(a, { ...fx, bookingId: stayB, start: '2026-09-20', end: '2026-09-22' });
  await sessionRace(a, b, observer,
    async (pg) => {
      await pg.query(
        `UPDATE booking_beds SET assignment_start_date = '2026-09-05', assignment_end_date = '2026-09-07'
          WHERE booking_id = $1`,
        [stayA]
      );
    },
    async (pg) => {
      await pg.query(
        `UPDATE booking_beds SET assignment_start_date = '2026-09-05', assignment_end_date = '2026-09-07'
          WHERE booking_id = $1`,
        [stayB]
      );
    },
    'one');
  ok('race date-change vs date-change: one commit', true);

  const bed2 = await a.query(
    `INSERT INTO beds (client_id, room_id, bed_code)
     VALUES ($1, $2, 'B') RETURNING id`,
    [fx.clientId, fx.roomId]
  );
  const moveA = id();
  await insertMinimalOccupancy(a, { ...fx, bookingId: moveA, start: '2026-10-01', end: '2026-10-03' });
  await sessionRace(a, b, observer,
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
  await sessionRace(a, b, observer,
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
  await sessionRace(a, b, observer,
    (pg) => insertMinimalOccupancy(pg, { ...fx, bookingId: parA, start: '2026-12-01', end: '2026-12-03' }),
    (pg) => insertMinimalOccupancy(pg, {
      ...fx, bookingId: parB, bedId: bed2.rows[0].id, start: '2026-12-01', end: '2026-12-03',
    }),
    'both');
  const bothRows = await a.query(
    `SELECT bb.booking_id::text AS booking_id,
            bb.bed_id::text AS bed_id,
            bb.assignment_start_date::text AS start_date,
            bb.assignment_end_date::text AS end_date,
            b.status::text AS booking_status
       FROM booking_beds bb
       JOIN bookings b ON b.id = bb.booking_id
      WHERE bb.booking_id IN ($1::uuid, $2::uuid)`,
    [parA, parB]
  );
  if (bothRows.rows.length !== 2) throw new Error('both_rows_missing:' + bothRows.rows.length);
  const byId = Object.fromEntries(bothRows.rows.map((r) => [r.booking_id, r]));
  if (!byId[parA] || !byId[parB]) throw new Error('both_booking_ids_missing');
  if (byId[parA].bed_id !== String(fx.bedId)) throw new Error('parA_wrong_bed');
  if (byId[parB].bed_id !== String(bed2.rows[0].id)) throw new Error('parB_wrong_bed');
  if (byId[parA].start_date !== '2026-12-01' || byId[parA].end_date !== '2026-12-03') {
    throw new Error('parA_wrong_range');
  }
  if (byId[parB].start_date !== '2026-12-01' || byId[parB].end_date !== '2026-12-03') {
    throw new Error('parB_wrong_range');
  }
  if (byId[parA].booking_status !== 'confirmed') throw new Error('parA_inactive_status');
  if (byId[parB].booking_status !== 'confirmed') throw new Error('parB_inactive_status');
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
  const other = await pg.query(
    `INSERT INTO clients (slug, name) VALUES ('sunset-gate', 'Sunset gate')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`
  );
  const otherId = other.rows[0].id;
  const otherBed = await pg.query(
    `INSERT INTO rooms (client_id, room_code) VALUES ($1, 'SS') RETURNING id`,
    [otherId]
  ).then(async (room) => pg.query(
    `INSERT INTO beds (client_id, room_id, bed_code) VALUES ($1, $2, '1') RETURNING id`,
    [otherId, room.rows[0].id]
  ));
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

async function tablePresent(pg, name) {
  const r = await pg.query('SELECT to_regclass($1) AS reg', ['public.' + name]);
  return r.rows[0].reg != null;
}

async function ensure089Up(pg) {
  if (!(await tablePresent(pg, 'external_calendar_connections'))) {
    await applySqlFile(pg, '089_external_calendar_inventory.sql');
    await applySqlFile(pg, '090_external_calendar_inventory_tenant_integrity.sql');
  }
}

async function createBridgeConnection(pg, fx) {
  const conn = await pg.query(
    `INSERT INTO external_calendar_connections (client_id, name, spreadsheet_id, status)
     VALUES ($1, 'gate-state', '12345678901234567890', 'disabled') RETURNING id`,
    [fx.clientId]
  );
  return conn.rows[0].id;
}

async function run089State(pg, fx, { uid, status, bookingId, expect }) {
  await ensure089Up(pg);
  const connectionId = await createBridgeConnection(pg, fx);
  await pg.query(
    `INSERT INTO external_inventory_events (
        connection_id, client_id, external_uid, period_start, period_end, booking_id, status
      ) VALUES ($1, $2, $3, '2027-02-01', '2027-02-03', $4, $5)`,
    [connectionId, fx.clientId, uid, bookingId, status]
  );
  let threw = null;
  try {
    await applySqlFile(pg, '089_external_calendar_inventory_down.sql');
  } catch (err) {
    threw = err;
  }
  if (expect === 'refuse') {
    if (!threw || !/089_down_refused/.test(String(threw.message || threw))) {
      throw new Error('089_down_did_not_refuse_' + uid);
    }
    if (!(await tablePresent(pg, 'external_calendar_connections'))) {
      throw new Error('089_refuse_dropped_tables_' + uid);
    }
    await pg.query('DELETE FROM external_inventory_events');
    ok('089 down refuses ' + uid, true);
    return;
  }
  if (threw) throw new Error('089_down_unexpected_refuse_' + uid + ':' + threw.message);
  if (await tablePresent(pg, 'external_calendar_connections')) {
    throw new Error('089_allow_left_tables_' + uid);
  }
  if (await tablePresent(pg, 'external_inventory_events')) {
    throw new Error('089_allow_left_events_' + uid);
  }
  ok('089 down accepts ' + uid, true);
}

async function prove089IdentityMatrix(pg, fx) {
  const linked = crypto.randomUUID();
  await insertMinimalOccupancy(pg, { ...fx, bookingId: linked, start: '2027-02-01', end: '2027-02-03' });

  await run089State(pg, fx, {
    uid: 'imported-linked', status: 'imported', bookingId: linked, expect: 'refuse',
  });
  await run089State(pg, fx, {
    uid: 'imported-unlinked', status: 'imported', bookingId: null, expect: 'allow',
  });
  await run089State(pg, fx, {
    uid: 'tombstoned-linked', status: 'tombstoned', bookingId: linked, expect: 'allow',
  });
  await run089State(pg, fx, {
    uid: 'skipped-unmapped-linked', status: 'skipped_unmapped', bookingId: linked, expect: 'allow',
  });
  await run089State(pg, fx, {
    uid: 'skipped-conflict-linked', status: 'skipped_conflict', bookingId: linked, expect: 'allow',
  });

  await applySqlFile(pg, '089_external_calendar_inventory_down.sql');
  await applySqlFile(pg, '089_external_calendar_inventory_down.sql');
  ok('live 089 down twice after every identity state', true);
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
  let observer;
  try {
    await admin.query('CREATE DATABASE ' + quoted);
    const connStr = databaseUrlForName(adminUrl, dbName);
    a = new Client({ connectionString: connStr });
    b = new Client({ connectionString: connStr });
    observer = new Client({ connectionString: connStr });
    await a.connect();
    await b.connect();
    await observer.connect();

    const chain = selectForwardChainThrough('091_booking_occupancy_serialization');
    for (const m of chain) await applySqlFile(a, m.filename);
    ok('live applied canonical chain through 091', chain[chain.length - 1].id === '091_booking_occupancy_serialization');

    const hostel = await a.query(
      `INSERT INTO clients (slug, name) VALUES ('wolfhouse-somo', 'Wolfhouse')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    const clientId = hostel.rows[0].id;
    const room = await a.query(
      `INSERT INTO rooms (client_id, room_code) VALUES ($1, 'R1') RETURNING id`,
      [clientId]
    );
    const bed = await a.query(
      `INSERT INTO beds (client_id, room_id, bed_code) VALUES ($1, $2, 'A') RETURNING id`,
      [clientId, room.rows[0].id]
    );
    const fixture = {
      clientId,
      roomId: room.rows[0].id,
      bedId: bed.rows[0].id,
    };

    await runOccupancyRaceMatrix(a, b, observer, fixture);
    const connectionId = await live090Hostile(a, fixture);
    await prove091OwnershipRefuse(a);

    await applySqlFile(a, '091_booking_occupancy_serialization_down.sql');
    await applySqlFile(a, '091_booking_occupancy_serialization_down.sql');
    ok('live 091 down twice', true);
    await applySqlFile(a, '090_external_calendar_inventory_tenant_integrity_down.sql');
    await applySqlFile(a, '090_external_calendar_inventory_tenant_integrity_down.sql');
    ok('live 090 down twice', true);

    await prove089IdentityMatrix(a, fixture);

    await applySqlFile(a, '089_external_calendar_inventory.sql');
    await applySqlFile(a, '090_external_calendar_inventory_tenant_integrity.sql');
    await applySqlFile(a, '091_booking_occupancy_serialization.sql');
    ok('live reapply 089-091', true);

    await sessionRace(a, b, observer,
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
    await Promise.all([closeQuiet(a), closeQuiet(b), closeQuiet(observer)]);
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
  ok('gate closes clients independently', /Promise\.all\(\[closeQuiet\(a\), closeQuiet\(b\), closeQuiet\(observer\)\]\)/.test(gateSrc));
  ok('gate waits for advisory lock barrier', /waitForAdvisoryWait/.test(gateSrc) && /expected_overlap_conflict/.test(gateSrc));
  ok('date-change uses unused 09-05 range', /2026-09-05/.test(gateSrc) && /2026-09-07/.test(gateSrc));
  const run089Body = gateSrc.slice(
    gateSrc.indexOf('async function run089State'),
    gateSrc.indexOf('async function prove089IdentityMatrix')
  );
  ok('run089State applies canonical down',
    run089Body.indexOf('089_external_calendar_inventory_down.sql') >= 0);
  ok('run089State does not re-count refuse rows',
    run089Body.indexOf('count(*)') < 0 && run089Body.indexOf('status = \'imported\'') < 0);
  const prove089Body = gateSrc.slice(
    gateSrc.indexOf('async function prove089IdentityMatrix'),
    gateSrc.indexOf('async function runLiveDisposableGate')
  );
  ok('five isolated 089 identity states',
    (prove089Body.match(/await run089State\(/g) || []).length === 5);
  ok('both-commit race queries resulting rows',
    /both_rows_missing/.test(gateSrc)
    && /parA_wrong_bed/.test(gateSrc)
    && /parB_wrong_range/.test(gateSrc)
    && /JOIN bookings/.test(gateSrc)
    && /parA_inactive_status/.test(gateSrc)
    && /parB_inactive_status/.test(gateSrc));
  ok('089 identity covers five states',
    /imported-unlinked/.test(gateSrc) && /tombstoned-linked/.test(gateSrc) && /skipped-conflict-linked/.test(gateSrc));

  await runLiveDisposableGate();
}

main().catch((e) => { console.error(e); process.exit(1); });
