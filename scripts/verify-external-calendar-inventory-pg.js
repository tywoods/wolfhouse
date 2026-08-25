'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let Client = null;
let pgLoadError = null;

const {
  loadManifest,
  MIGRATIONS_DIR,
  sha256CanonicalLfV1File,
} = require('./lib/migration-integrity');

const ROOT = path.join(__dirname, '..');
const UP089 = fs.readFileSync(path.join(ROOT, 'database/migrations/089_external_calendar_inventory.sql'), 'utf8');
const DOWN089 = fs.readFileSync(path.join(ROOT, 'database/migrations/089_external_calendar_inventory_down.sql'), 'utf8');
const UP090 = fs.readFileSync(path.join(ROOT, 'database/migrations/090_external_calendar_inventory_tenant_integrity.sql'), 'utf8');
const DOWN090 = fs.readFileSync(path.join(ROOT, 'database/migrations/090_external_calendar_inventory_tenant_integrity_down.sql'), 'utf8');
const UP091 = fs.readFileSync(path.join(ROOT, 'database/migrations/091_booking_occupancy_serialization.sql'), 'utf8');
const DOWN091 = fs.readFileSync(path.join(ROOT, 'database/migrations/091_booking_occupancy_serialization_down.sql'), 'utf8');

const TARGET_ID = '091_booking_occupancy_serialization';
const TARGET_FILE = '091_booking_occupancy_serialization.sql';
const OWNED_COMMENT = '091_booking_occupancy_serialization v1';
const SHA_RE = /^[0-9a-f]{64}$/;

const UUID_BED_1 = '00000000-0000-4000-8000-0000000000b1';
const UUID_BED_2 = '00000000-0000-4000-8000-0000000000b2';
const UUID_BED_SS = '00000000-0000-4000-8000-0000000000b3';
const UUID_ROOM_WH = '00000000-0000-4000-8000-0000000000a1';
const UUID_ROOM_SS = '00000000-0000-4000-8000-0000000000a2';

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

function quoteIdent(name) {
  if (typeof name !== 'string' || !name.length || name.length > 63) {
    throw new Error('invalid SQL identifier');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('invalid SQL identifier');
  }
  return '"' + name.replace(/"/g, '""') + '"';
}

function assertUniqueForwardEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('manifest.entries is required');
  }
  const forward = entries.filter((e) => e && e.inForwardChain === true);
  const orders = new Map();
  const ids = new Map();
  const filenames = new Map();
  const checksums = new Map();
  for (const e of forward) {
    if (typeof e.order !== 'number' || !Number.isInteger(e.order) || e.order < 1) {
      throw new Error('forward entry ' + (e && e.id) + ' has non-numeric order');
    }
    if (!e.id || typeof e.id !== 'string') throw new Error('forward entry missing id');
    if (!e.filename || typeof e.filename !== 'string') throw new Error('forward entry missing filename');
    if (!SHA_RE.test(String(e.sha256 || ''))) throw new Error('forward entry ' + e.id + ' has invalid checksum');
    if (orders.has(e.order)) {
      throw new Error('duplicate forward order ' + e.order + ' (' + orders.get(e.order) + ' vs ' + e.id + ')');
    }
    if (ids.has(e.id)) throw new Error('duplicate forward id ' + e.id);
    if (filenames.has(e.filename)) throw new Error('duplicate forward filename ' + e.filename);
    if (checksums.has(e.sha256)) {
      throw new Error('duplicate forward checksum ' + e.sha256.slice(0, 12) + ' (' + checksums.get(e.sha256) + ' vs ' + e.id + ')');
    }
    orders.set(e.order, e.id);
    ids.set(e.id, e);
    filenames.set(e.filename, e.id);
    checksums.set(e.sha256, e.id);
  }
  return forward.slice().sort((a, b) => a.order - b.order);
}

function verifyMigrationChecksums(chain, migrationsDir) {
  for (const e of chain) {
    const abs = path.join(migrationsDir, e.filename);
    if (!fs.existsSync(abs)) {
      throw new Error('migration file missing: ' + e.filename);
    }
    const live = sha256CanonicalLfV1File(abs);
    if (live !== e.sha256) {
      throw new Error('checksum mismatch for ' + e.filename + ' expected=' + e.sha256 + ' live=' + live);
    }
  }
}

function selectCanonicalForwardThrough(manifest, targetId, migrationsDir) {
  if (!manifest || !Array.isArray(manifest.entries)) {
    throw new Error('canonical-manifest.json must expose entries[]');
  }
  const sorted = assertUniqueForwardEntries(manifest.entries);
  const targets = sorted.filter((e) => e.id === targetId);
  if (targets.length !== 1) {
    throw new Error('require exactly one ' + targetId + ' in forward chain, found ' + targets.length);
  }
  if (targets[0].filename !== TARGET_FILE) {
    throw new Error('091 target filename mismatch: ' + targets[0].filename);
  }
  const idx = sorted.findIndex((e) => e.id === targetId);
  const chain = sorted.slice(0, idx + 1);
  if (!chain.length || chain[chain.length - 1].id !== targetId) {
    throw new Error('selected chain does not end at ' + targetId);
  }
  if (chain[chain.length - 1].filename !== TARGET_FILE) {
    throw new Error('selected chain tail filename is not ' + TARGET_FILE);
  }
  verifyMigrationChecksums(chain, migrationsDir || MIGRATIONS_DIR);
  return chain;
}

const DISPOSABLE_LOCAL_CLUSTER_REQUIREMENT =
  'This gate creates, terminates connections to, and drops a disposable database and therefore requires a disposable local cluster';

function disposableTargetError(prefix) {
  return new Error(
    (prefix ? prefix + ' ' : '')
    + DISPOSABLE_LOCAL_CLUSTER_REQUIREMENT
    + ' (loopback IPv4 127.0.0.0/8, IPv6 ::1, localhost, or a Unix-domain socket).'
  );
}

function decodeHostCandidate(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

function unwrapIpv6Brackets(host) {
  const h = String(host || '');
  if (h.charAt(0) === '[' && h.charAt(h.length - 1) === ']') return h.slice(1, -1);
  return h;
}

function isLoopbackIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return octets[0] === 127;
}

function isLoopbackIpv6(host) {
  const h = unwrapIpv6Brackets(host).toLowerCase();
  return h === '::1' || h === '0:0:0:0:0:0:0:1';
}

function isUnixSocketPath(value) {
  return typeof value === 'string' && value.charAt(0) === '/';
}

function isAllowedLocalTarget(value) {
  const decoded = decodeHostCandidate(value);
  if (!decoded) return false;
  if (isUnixSocketPath(decoded)) return true;
  const host = unwrapIpv6Brackets(decoded).toLowerCase();
  if (host === 'localhost') return true;
  if (isLoopbackIpv4(host)) return true;
  if (isLoopbackIpv6(host)) return true;
  return false;
}

// Locked pg-connection-string@2.13.0 (package-lock, pg@8.21.0) copies every URL
// search parameter with last-wins assignment:
//   for (const entry of result.searchParams.entries()) { config[entry[0]] = entry[1] }
// then `if (!config.host) config.host = decodeURIComponent(hostname)`.
// URLSearchParams.get() returns only the first value, so disposable-target
// validation must enumerate with getAll. Keys are case-sensitive in both
// URLSearchParams and that parser (`config.host` vs `config.HOST`).
// Endpoint-affecting query keys from that parser + libpq copy-through:
//   host     — special-cased override of the URL authority host
//   hostaddr — copied onto the config object (libpq TCP address)
// `port` overrides the listen port only and cannot change the host.
// `hostname` / `service` / `options` are copied but are not used as the JS
// client's connect host by pg@8.21.0 ConnectionParameters (`this.host = val('host', config)`).
const PG_ENDPOINT_QUERY_KEYS = ['host', 'hostaddr'];

function hasEndpointQueryCaseVariant(searchParams) {
  for (const [key] of searchParams.entries()) {
    const lower = String(key).toLowerCase();
    if (PG_ENDPOINT_QUERY_KEYS.indexOf(lower) !== -1 && key !== lower) return true;
  }
  return false;
}

function parseAdminUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw disposableTargetError('EXTCAL_PG_ADMIN_URL is not a valid URL.');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (err) {
    throw disposableTargetError('EXTCAL_PG_ADMIN_URL is not a valid URL.');
  }
  if (!/^postgres(ql)?:$/i.test(parsed.protocol)) {
    throw disposableTargetError('EXTCAL_PG_ADMIN_URL must use postgres:// or postgresql://.');
  }

  // Reject lookalike keys (HOST, HostAddr, ...) even though 2.13.0 is
  // case-sensitive, so a later case-insensitive consumer cannot redirect.
  if (hasEndpointQueryCaseVariant(parsed.searchParams)) {
    throw disposableTargetError('EXTCAL_PG_ADMIN_URL is not an allowed disposable local PostgreSQL endpoint.');
  }

  const hostValues = parsed.searchParams.getAll('host');
  const hostaddrValues = parsed.searchParams.getAll('hostaddr');

  // Duplicate host/hostaddr: last value wins in pg-connection-string. Reject
  // even when every duplicate is local (default-deny, no precedence emulation).
  if (hostValues.length > 1 || hostaddrValues.length > 1) {
    throw disposableTargetError('EXTCAL_PG_ADMIN_URL is not an allowed disposable local PostgreSQL endpoint.');
  }
  if (hostValues.length && hostaddrValues.length) {
    throw disposableTargetError('EXTCAL_PG_ADMIN_URL is not an allowed disposable local PostgreSQL endpoint.');
  }

  const authorityHost = parsed.hostname || '';
  const hasAuthorityHost = authorityHost !== '';
  const hasQueryEndpoint = hostValues.length > 0 || hostaddrValues.length > 0;
  if (hasAuthorityHost && hasQueryEndpoint) {
    throw disposableTargetError('EXTCAL_PG_ADMIN_URL is not an allowed disposable local PostgreSQL endpoint.');
  }

  let endpoint = '';
  if (hasAuthorityHost) {
    endpoint = authorityHost;
  } else if (hostValues.length === 1) {
    endpoint = hostValues[0];
  } else if (hostaddrValues.length === 1) {
    endpoint = hostaddrValues[0];
  }

  if (!endpoint) {
    throw disposableTargetError('EXTCAL_PG_ADMIN_URL host is missing.');
  }
  if (!isAllowedLocalTarget(endpoint)) {
    throw disposableTargetError('EXTCAL_PG_ADMIN_URL is not an allowed disposable local PostgreSQL endpoint.');
  }
  return parsed;
}

function buildDatabaseUrl(adminUrl, databaseName) {
  const href = adminUrl && typeof adminUrl === 'object' ? adminUrl.href : adminUrl;
  const validated = parseAdminUrl(href);
  const u = new URL(validated.href);
  u.pathname = '/' + String(databaseName || '');
  parseAdminUrl(u.href);
  return u.href;
}

function ignoreClientErrors(client) {
  client.on('error', () => { /* connection reset during bounded cleanup */ });
  return client;
}

function clientFromUrl(adminUrl, databaseName, applicationName) {
  return ignoreClientErrors(new Client({
    connectionString: buildDatabaseUrl(adminUrl, databaseName),
    application_name: applicationName || 'extcal-gate',
    connectionTimeoutMillis: 8000,
  }));
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

function refuseLiveUnavailable(reason, hint) {
  console.error('LIVE PG UNAVAILABLE: ' + reason);
  console.error(hint);
  console.error('This gate does not PASS after skip. Provide a disposable stock PostgreSQL admin URL and the pg package.');
  process.exit(2);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const err = new Error(
    'orchestration deadline exceeded for ' + label + ' after ' + timeoutMs + 'ms'
  );
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(err), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function configureRaceSession(client) {
  await client.query(`SET LOCAL lock_timeout = '8s'`);
  await client.query(`SET LOCAL statement_timeout = '12s'`);
  await client.query(`SET LOCAL deadlock_timeout = '200ms'`);
}

async function configureWorkerSession(client) {
  await client.query(`SET lock_timeout = '8s'`);
  await client.query(`SET statement_timeout = '30s'`);
  await client.query(`SET deadlock_timeout = '200ms'`);
  await client.query(`SET idle_in_transaction_session_timeout = '20s'`);
}

async function rollbackRace(a, b) {
  await a.query('ROLLBACK').catch(() => {});
  await b.query('ROLLBACK').catch(() => {});
}

async function cancelBackend(observer, pid) {
  if (pid == null) return;
  try {
    await observer.query('SELECT pg_cancel_backend($1)', [pid]);
  } catch (_) { /* ignore */ }
}

async function applySqlFile(client, filename) {
  const sql = fs.readFileSync(path.join(ROOT, 'database/migrations', filename), 'utf8');
  await client.query(sql);
}

async function expectSqlError(fn, pattern, label) {
  let threw = false;
  let message = '';
  try {
    await fn();
  } catch (err) {
    threw = true;
    message = String(err && err.message || err);
  }
  ok(label, threw && pattern.test(message), message);
  return message;
}

function isLockWaitObservation(row) {
  if (!row || typeof row !== 'object') return false;
  const waitType = String(row.wait_event_type || '');
  const waitEvent = String(row.wait_event || '');
  return waitType === 'Lock' || /Lock/.test(waitEvent);
}

function summarizeWait(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    wait_event_type: row.wait_event_type == null ? null : String(row.wait_event_type),
    wait_event: row.wait_event == null ? null : String(row.wait_event),
    state: row.state == null ? null : String(row.state),
    application_name: row.application_name == null ? null : String(row.application_name),
  };
}

async function waitUntilWaiting(observer, pid, timeoutMs, caseName) {
  const label = caseName ? String(caseName) : 'unnamed session';
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const r = await withTimeout(
      observer.query(
        `SELECT wait_event_type, wait_event, state, application_name
           FROM pg_catalog.pg_stat_activity
          WHERE pid = $1`,
        [pid]
      ),
      remaining + 50,
      'waitUntilWaiting poll ' + label
    );
    const row = r.rows[0] || null;
    last = row;
    if (isLockWaitObservation(row)) {
      return row;
    }
    await sleep(Math.min(20, Math.max(0, deadline - Date.now())));
  }
  const observed = summarizeWait(last);
  throw new Error(
    'lock-wait timeout for ' + label
    + ' pid=' + pid
    + ' within ' + timeoutMs + 'ms: expected Lock wait was not observed'
    + (observed
      ? ' (last_state=' + observed.state
        + ' wait_event_type=' + observed.wait_event_type
        + ' wait_event=' + observed.wait_event
        + ' application_name=' + observed.application_name + ')'
      : ' (backend not visible)')
  );
}

async function seedTenants(client) {
  const wh = await client.query(
    `INSERT INTO public.clients (slug, name) VALUES ('wolfhouse-somo', 'Wolfhouse') RETURNING id`
  );
  const ss = await client.query(
    `INSERT INTO public.clients (slug, name) VALUES ('other-tenant', 'Other Tenant') RETURNING id`
  );
  const whId = wh.rows[0].id;
  const ssId = ss.rows[0].id;
  await client.query(
    `INSERT INTO public.rooms (id, client_id, room_code, capacity)
     VALUES ($1::uuid, $2, 'WH1', 2), ($3::uuid, $4, 'SS1', 2)`,
    [UUID_ROOM_WH, whId, UUID_ROOM_SS, ssId]
  );
  await client.query(
    `INSERT INTO public.beds (id, client_id, room_id, bed_code)
     VALUES ($1::uuid, $2, $3::uuid, 'WH-B1'),
            ($4::uuid, $2, $3::uuid, 'WH-B2'),
            ($5::uuid, $6, $7::uuid, 'SS-B1')`,
    [UUID_BED_1, whId, UUID_ROOM_WH, UUID_BED_2, UUID_BED_SS, ssId, UUID_ROOM_SS]
  );
  return { whId, ssId };
}

async function insertBooking(client, { clientId, code, status, start, end, phone }) {
  // Distinct default phones: trg_sync_customer_bookings upserts customers on
  // (client_id, phone). A shared phone serializes sibling INSERTs behind the
  // open transaction that first touched that customer row.
  const phoneVal = phone || ('extcal-gate-' + String(code).slice(0, 48));
  const r = await client.query(
    `INSERT INTO public.bookings (
        client_id, booking_code, guest_name, phone, status, payment_status,
        assignment_status, check_in, check_out, guest_count, booking_source
      ) VALUES (
        $1, $2, $3, $4, $5::booking_status, 'not_requested',
        'assigned', $6::date, $7::date, 1, 'other'
      ) RETURNING id`,
    [clientId, code, code, phoneVal, status, start, end]
  );
  return r.rows[0].id;
}

async function insertAssignment(client, { clientId, bookingId, bedId, type, start, end }) {
  const r = await client.query(
    `INSERT INTO public.booking_beds (
        client_id, booking_id, bed_id, assignment_type,
        assignment_start_date, assignment_end_date
      ) VALUES ($1,$2,$3::uuid,$4,$5::date,$6::date)
      RETURNING id`,
    [clientId, bookingId, bedId, type, start, end]
  );
  return r.rows[0].id;
}

async function countActiveOnBed(client, { clientId, bedId, start, end }) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS n
       FROM public.booking_beds bb
       JOIN public.bookings bk ON bk.id = bb.booking_id
      WHERE bb.client_id = $1
        AND bb.bed_id = $2::uuid
        AND bb.assignment_start_date < $4::date
        AND bb.assignment_end_date > $3::date
        AND bk.status::text NOT IN ('cancelled', 'expired')`,
    [clientId, bedId, start, end]
  );
  return r.rows[0].n;
}

async function runTwoSessionInsertRace(observer, a, b, { clientId, bedId, start, end, prefix }) {
  const codeA = prefix + '-A-' + crypto.randomBytes(3).toString('hex');
  const codeB = prefix + '-B-' + crypto.randomBytes(3).toString('hex');
  const bookingA = await insertBooking(observer, {
    clientId, code: codeA, status: 'confirmed', start, end,
  });
  const bookingB = await insertBooking(observer, {
    clientId, code: codeB, status: 'confirmed', start, end,
  });

  let pidB = null;
  let pendingB = null;
  let waited = null;
  let aCommitted = false;
  let bCommitted = false;
  let bMessage = '';
  try {
    await a.query('BEGIN');
    await configureRaceSession(a);
    await insertAssignment(a, {
      clientId, bookingId: bookingA, bedId, type: 'external_inventory_block', start, end,
    });

    await b.query('BEGIN');
    await configureRaceSession(b);
    pidB = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pendingB = insertAssignment(b, {
      clientId, bookingId: bookingB, bedId, type: 'staff_block', start, end,
    });
    try {
      waited = await waitUntilWaiting(observer, pidB, 4000, prefix + ' session B');
    } catch (err) {
      await cancelBackend(observer, pidB);
      if (pendingB) await pendingB.catch(() => {});
      throw err;
    }

    try {
      await a.query('COMMIT');
      aCommitted = true;
    } catch (err) {
      await a.query('ROLLBACK').catch(() => {});
    }

    try {
      await withTimeout(pendingB, 15000, prefix + ' pending B');
      await b.query('COMMIT');
      bCommitted = true;
    } catch (err) {
      bMessage = String(err && err.message || err);
      await cancelBackend(observer, pidB);
      if (pendingB) await pendingB.catch(() => {});
      await b.query('ROLLBACK').catch(() => {});
    }

    const n = await countActiveOnBed(observer, { clientId, bedId, start, end });
    ok(
      prefix + ' conflicting transactions cannot both commit',
      isLockWaitObservation(waited) && aCommitted !== bCommitted && n === 1,
      JSON.stringify({ aCommitted, bCommitted, n, waited: summarizeWait(waited), bMessage })
    );
    ok(
      prefix + ' loser refused overlap or lock',
      (aCommitted && !bCommitted && /overlap_conflict|lock timeout|deadlock|canceling statement|orchestration deadline/i.test(bMessage))
        || (!aCommitted && bCommitted),
      bMessage
    );
    return { aCommitted, bCommitted, n, waited: !!waited };
  } finally {
    await cancelBackend(observer, pidB);
    if (pendingB) await pendingB.catch(() => {});
    await rollbackRace(a, b);
  }
}

async function terminateDisposableBackends(admin, dbName) {
  await admin.query(
    `SELECT pg_terminate_backend(pid)
       FROM pg_catalog.pg_stat_activity
      WHERE datname = $1
        AND pid <> pg_backend_pid()`,
    [dbName]
  );
}

async function dropDisposableDatabase(admin, dbName) {
  const ident = quoteIdent(dbName);
  await terminateDisposableBackends(admin, dbName);
  await sleep(50);
  try {
    await admin.query('DROP DATABASE IF EXISTS ' + ident + ' WITH (FORCE)');
  } catch (err) {
    await terminateDisposableBackends(admin, dbName);
    await sleep(80);
    try {
      await admin.query('DROP DATABASE IF EXISTS ' + ident);
    } catch (err2) {
      throw new Error('cleanup failed: DROP DATABASE refused: ' + (err2 && err2.message));
    }
  }
  const still = await admin.query(
    `SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1`,
    [dbName]
  );
  if (still.rowCount) {
    throw new Error('cleanup failed: disposable database still exists after DROP');
  }
}

async function objectComment(client, kind, ident) {
  if (kind === 'fn') {
    const r = await client.query(
      `SELECT obj_description($1::regprocedure, 'pg_proc') AS owned`,
      [ident]
    );
    return r.rows[0] && r.rows[0].owned;
  }
  const r = await client.query(
    `SELECT obj_description(t.oid, 'pg_trigger') AS owned
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND t.tgname = $2`,
    ident
  );
  return r.rows[0] && r.rows[0].owned;
}

async function runLiveDisposableGate(chain) {
  const rawUrl = process.env.EXTCAL_PG_ADMIN_URL;
  if (!rawUrl) {
    refuseLiveUnavailable(
      'EXTCAL_PG_ADMIN_URL is not set.',
      'Set EXTCAL_PG_ADMIN_URL=postgres://user:pass@127.0.0.1:5432/postgres?sslmode=disable for a disposable local/admin database. Do not point it at Sunset, production, or shared staging.'
    );
  }

  const adminUrl = parseAdminUrl(rawUrl);

  try {
    Client = require('pg').Client;
  } catch (err) {
    Client = null;
    pgLoadError = err;
  }
  if (!Client) {
    refuseLiveUnavailable(
      'Node pg dependency is not installed (' + String(pgLoadError && pgLoadError.message || 'require failed') + ').',
      'Install the pg package in this worktree, then set EXTCAL_PG_ADMIN_URL to a disposable stock PostgreSQL admin URL.'
    );
  }

  const admin = ignoreClientErrors(new Client({
    connectionString: adminUrl.href,
    application_name: 'extcal-gate-admin',
    connectionTimeoutMillis: 8000,
  }));
  try {
    await admin.connect();
    await admin.query('SELECT 1');
  } catch (err) {
    try { await admin.end(); } catch (_) { /* ignore */ }
    refuseLiveUnavailable(
      'could not connect with EXTCAL_PG_ADMIN_URL (' + String(err && err.code || 'connect_failed') + ').',
      'Confirm the URL reaches a disposable stock PostgreSQL that can CREATE DATABASE. Query/TLS options on the URL are preserved.'
    );
  }

  const dbName = 'extcal_gate_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  let created = false;
  const workers = [];
  let liveError = null;
  try {
    await admin.query('CREATE DATABASE ' + quoteIdent(dbName));
    created = true;

    const a = clientFromUrl(adminUrl, dbName, 'extcal-gate-a');
    const b = clientFromUrl(adminUrl, dbName, 'extcal-gate-b');
    const observer = clientFromUrl(adminUrl, dbName, 'extcal-gate-observer');
    workers.push(a, b, observer);
    await a.connect();
    await b.connect();
    await observer.connect();

    for (const m of chain) {
      await applySqlFile(a, m.filename);
    }
    ok('live applied canonical chain through 091',
      chain.length > 0
      && chain[chain.length - 1].id === TARGET_ID
      && chain[chain.length - 1].filename === TARGET_FILE);
    for (const worker of [a, b, observer]) {
      await configureWorkerSession(worker);
    }

    const tenants = await seedTenants(observer);
    const { whId, ssId } = tenants;

    const conn = await observer.query(
      `INSERT INTO public.external_calendar_connections (client_id, name, spreadsheet_id, sheet_name)
       VALUES ($1, 'wh-sheet', '1234567890abcdef', 'inventory') RETURNING id`,
      [whId]
    );
    const connId = conn.rows[0].id;
    await observer.query(
      `INSERT INTO public.external_calendar_secrets (connection_id, secret_ref)
       VALUES ($1, 'KV_WH_SHEET_TOKEN')`,
      [connId]
    );
    await observer.query(
      `INSERT INTO public.external_calendar_unit_maps (connection_id, client_id, external_unit_key, bed_id)
       VALUES ($1, $2, 'R1A', $3::uuid)`,
      [connId, whId, UUID_BED_1]
    );
    await expectSqlError(
      () => observer.query(
        `INSERT INTO public.external_calendar_unit_maps (connection_id, client_id, external_unit_key, bed_id)
         VALUES ($1, $2, 'RX', $3::uuid)`,
        [connId, whId, UUID_BED_SS]
      ),
      /extcal_tenant_mismatch/,
      'live PG rejects cross-tenant bed map'
    );
    const guestBk = await insertBooking(observer, {
      clientId: ssId, code: 'SS-GUEST-1', status: 'confirmed',
      start: '2026-09-01', end: '2026-09-03',
    });
    await expectSqlError(
      () => observer.query(
        `INSERT INTO public.external_inventory_events (
            connection_id, client_id, external_uid, period_start, period_end, booking_id, status
          ) VALUES ($1, $2, 'uid-x', '2026-09-01', '2026-09-03', $3, 'imported')`,
        [connId, whId, guestBk]
      ),
      /extcal_tenant_mismatch/,
      'live PG rejects cross-tenant booking event'
    );

    await runTwoSessionInsertRace(observer, a, b, {
      clientId: whId, bedId: UUID_BED_1,
      start: '2026-09-10', end: '2026-09-12', prefix: 'insert-overlap',
    });

    const moveA = await insertBooking(observer, {
      clientId: whId, code: 'MOVE-A', status: 'confirmed',
      start: '2026-09-20', end: '2026-09-22',
    });
    const moveC = await insertBooking(observer, {
      clientId: whId, code: 'MOVE-C', status: 'confirmed',
      start: '2026-09-26', end: '2026-09-28',
    });
    const assignMoveA = await insertAssignment(observer, {
      clientId: whId, bookingId: moveA, bedId: UUID_BED_2,
      type: 'staff_block', start: '2026-09-20', end: '2026-09-22',
    });
    const assignMoveC = await insertAssignment(observer, {
      clientId: whId, bookingId: moveC, bedId: UUID_BED_2,
      type: 'external_inventory_block', start: '2026-09-26', end: '2026-09-28',
    });
    let pidMove = null;
    let pendingMove = null;
    let moveWaited = null;
    let moveAok = false;
    let moveBok = false;
    let moveBmsg = '';
    try {
      await a.query('BEGIN');
      await configureRaceSession(a);
      await a.query(
        `UPDATE public.booking_beds SET bed_id = $2::uuid WHERE id = $1`,
        [assignMoveA, UUID_BED_1]
      );
      await b.query('BEGIN');
      await configureRaceSession(b);
      pidMove = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pendingMove = b.query(
        `UPDATE public.booking_beds
            SET bed_id = $2::uuid,
                assignment_start_date = '2026-09-20',
                assignment_end_date = '2026-09-22'
          WHERE id = $1`,
        [assignMoveC, UUID_BED_1]
      );
      try {
        moveWaited = await waitUntilWaiting(observer, pidMove, 4000, 'bed-change session B');
      } catch (err) {
        await cancelBackend(observer, pidMove);
        if (pendingMove) await pendingMove.catch(() => {});
        throw err;
      }
      try { await a.query('COMMIT'); moveAok = true; } catch (_) { await a.query('ROLLBACK').catch(() => {}); }
      try {
        await withTimeout(pendingMove, 15000, 'bed-change pending B');
        await b.query('COMMIT');
        moveBok = true;
      } catch (err) {
        moveBmsg = String(err && err.message || err);
        await cancelBackend(observer, pidMove);
        if (pendingMove) await pendingMove.catch(() => {});
        await b.query('ROLLBACK').catch(() => {});
      }
      const nMove = await countActiveOnBed(observer, {
        clientId: whId, bedId: UUID_BED_1, start: '2026-09-20', end: '2026-09-22',
      });
      ok('assignment bed-change race cannot double-occupy',
        isLockWaitObservation(moveWaited) && moveAok !== moveBok && nMove === 1,
        JSON.stringify({ moveAok, moveBok, nMove, moveBmsg, moveWaited: summarizeWait(moveWaited) }));
    } finally {
      await cancelBackend(observer, pidMove);
      if (pendingMove) await pendingMove.catch(() => {});
      await rollbackRace(a, b);
    }

    const cancelled = await insertBooking(observer, {
      clientId: whId, code: 'XBLK-CANCEL', status: 'cancelled',
      start: '2026-10-01', end: '2026-10-03',
    });
    await insertAssignment(observer, {
      clientId: whId, bookingId: cancelled, bedId: UUID_BED_1,
      type: 'external_inventory_block', start: '2026-10-01', end: '2026-10-03',
    });
    const ordinary = await insertBooking(observer, {
      clientId: whId, code: 'GUEST-OCT', status: 'confirmed',
      start: '2026-10-01', end: '2026-10-03',
    });
    await insertAssignment(observer, {
      clientId: whId, bookingId: ordinary, bedId: UUID_BED_1,
      type: 'manual', start: '2026-10-01', end: '2026-10-03',
    });
    await expectSqlError(
      () => observer.query(
        `UPDATE public.bookings SET status = 'blocked' WHERE id = $1`,
        [cancelled]
      ),
      /booking_beds_overlap_conflict/,
      'cancelled external-block reactivation refuses overlap'
    );
    const stillCancelled = await observer.query(
      `SELECT status::text AS status FROM public.bookings WHERE id = $1`,
      [cancelled]
    );
    ok('reactivation left cancelled booking cancelled', stillCancelled.rows[0].status === 'cancelled');

    const dateBk = await insertBooking(observer, {
      clientId: whId, code: 'DATE-SHIFT', status: 'confirmed',
      start: '2026-11-01', end: '2026-11-03',
    });
    const dateAssign = await insertAssignment(observer, {
      clientId: whId, bookingId: dateBk, bedId: UUID_BED_2,
      type: 'manual', start: '2026-11-01', end: '2026-11-03',
    });
    const blocker = await insertBooking(observer, {
      clientId: whId, code: 'DATE-BLOCK', status: 'blocked',
      start: '2026-11-05', end: '2026-11-08',
    });
    await insertAssignment(observer, {
      clientId: whId, bookingId: blocker, bedId: UUID_BED_2,
      type: 'staff_block', start: '2026-11-05', end: '2026-11-08',
    });
    await expectSqlError(
      () => observer.query(
        `UPDATE public.booking_beds
            SET assignment_start_date = '2026-11-06', assignment_end_date = '2026-11-09'
          WHERE id = $1`,
        [dateAssign]
      ),
      /booking_beds_overlap_conflict/,
      'booking date overlap change refused'
    );

    // Live regression of the 600s hang: shared-phone insertBooking inside an
    // open race txn vs a sibling INSERT. trg_sync_customer_bookings takes a
    // row lock on customers(client_id, phone). The waiter is session B so the
    // observer can still poll pg_stat_activity. Bounded by lock_timeout and
    // an orchestration deadline; blocker rollback must unblock the waiter.
    const sharedHangPhone = 'extcal-shared-hang';
    let pidHang = null;
    let pendingHang = null;
    let hangWaited = null;
    try {
      await a.query('BEGIN');
      await configureRaceSession(a);
      await insertBooking(a, {
        clientId: whId, code: 'HANG-A', status: 'confirmed',
        start: '2028-01-01', end: '2028-01-03', phone: sharedHangPhone,
      });
      await b.query('BEGIN');
      await configureRaceSession(b);
      pidHang = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pendingHang = insertBooking(b, {
        clientId: whId, code: 'HANG-B', status: 'confirmed',
        start: '2028-01-10', end: '2028-01-12', phone: sharedHangPhone,
      });
      hangWaited = await waitUntilWaiting(observer, pidHang, 4000, 'shared-phone booking insert session B');
      ok('shared-phone booking insert waits on open sibling transaction',
        isLockWaitObservation(hangWaited)
        && String(hangWaited.wait_event) === 'transactionid',
        JSON.stringify({ hangWaited: summarizeWait(hangWaited) }));
      await a.query('ROLLBACK');
      let hangBmsg = '';
      let hangBok = false;
      try {
        await withTimeout(pendingHang, 8000, 'shared-phone hang waiter');
        hangBok = true;
      } catch (err) {
        hangBmsg = String(err && err.message || err);
        await cancelBackend(observer, pidHang);
        await pendingHang.catch(() => {});
      }
      ok('shared-phone waiter finishes boundedly after blocker rollback',
        hangBok || /lock timeout|canceling statement|statement timeout|orchestration deadline/i.test(hangBmsg),
        hangBmsg);
    } finally {
      await cancelBackend(observer, pidHang);
      if (pendingHang) await pendingHang.catch(() => {});
      await rollbackRace(a, b);
    }

    try {
      await a.query('BEGIN');
      await configureRaceSession(a);
      await insertBooking(a, {
        clientId: whId, code: 'DIST-A', status: 'confirmed',
        start: '2028-02-01', end: '2028-02-03', phone: 'extcal-dist-a',
      });
      const distStarted = Date.now();
      await withTimeout(
        insertBooking(observer, {
          clientId: whId, code: 'DIST-B', status: 'confirmed',
          start: '2028-02-10', end: '2028-02-12', phone: 'extcal-dist-b',
        }),
        8000,
        'distinct-phone observer insert'
      );
      const distMs = Date.now() - distStarted;
      ok('distinct-phone booking insert does not wait on sibling txn',
        distMs < 2000, 'elapsed_ms=' + distMs);
    } finally {
      await rollbackRace(a, b);
    }

    const swapA = await insertBooking(observer, {
      clientId: whId, code: 'SWAP-A', status: 'confirmed',
      start: '2026-08-01', end: '2026-08-03',
    });
    const swapB = await insertBooking(observer, {
      clientId: whId, code: 'SWAP-B', status: 'confirmed',
      start: '2026-08-10', end: '2026-08-12',
    });
    const swapAssignA = await insertAssignment(observer, {
      clientId: whId, bookingId: swapA, bedId: UUID_BED_1,
      type: 'manual', start: '2026-08-01', end: '2026-08-03',
    });
    const swapAssignB = await insertAssignment(observer, {
      clientId: whId, bookingId: swapB, bedId: UUID_BED_2,
      type: 'external_inventory_block', start: '2026-08-10', end: '2026-08-12',
    });
    let pidSwap = null;
    let pendingSwap = null;
    let swapWaited = null;
    try {
      await a.query('BEGIN');
      await configureRaceSession(a);
      await a.query(
        `UPDATE public.booking_beds SET bed_id = $2::uuid WHERE id = $1`,
        [swapAssignA, UUID_BED_2]
      );
      await b.query('BEGIN');
      await configureRaceSession(b);
      pidSwap = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pendingSwap = b.query(
        `UPDATE public.booking_beds SET bed_id = $2::uuid WHERE id = $1`,
        [swapAssignB, UUID_BED_1]
      );
      try {
        swapWaited = await waitUntilWaiting(observer, pidSwap, 4000, 'lock-ordered bed-swap session B');
      } catch (err) {
        await cancelBackend(observer, pidSwap);
        if (pendingSwap) await pendingSwap.catch(() => {});
        throw err;
      }
      ok('lock-ordered bed swap observed blocker/wait state',
        swapWaited && isLockWaitObservation(swapWaited),
        JSON.stringify({ swapWaited: summarizeWait(swapWaited) }));
      await a.query('COMMIT');
      await withTimeout(pendingSwap, 15000, 'lock-ordered bed-swap pending B');
      await b.query('COMMIT');
      const afterSwapA = await observer.query(`SELECT bed_id::text AS bed FROM public.booking_beds WHERE id = $1`, [swapAssignA]);
      const afterSwapB = await observer.query(`SELECT bed_id::text AS bed FROM public.booking_beds WHERE id = $1`, [swapAssignB]);
      ok('lock-ordered bed swap committed without deadlock',
        swapWaited
        && isLockWaitObservation(swapWaited)
        && afterSwapA.rows[0].bed === UUID_BED_2
        && afterSwapB.rows[0].bed === UUID_BED_1,
        JSON.stringify({ swapWaited: summarizeWait(swapWaited), afterA: afterSwapA.rows[0], afterB: afterSwapB.rows[0] }));
    } finally {
      await cancelBackend(observer, pidSwap);
      if (pendingSwap) await pendingSwap.catch(() => {});
      await rollbackRace(a, b);
    }

    await a.query(`
      CREATE OR REPLACE FUNCTION public._091_occupancy_assert_fn(text)
      RETURNS text LANGUAGE sql AS $f$ SELECT 'sentinel-unrelated'::text $f$;
    `);
    await a.query(`COMMENT ON FUNCTION public._091_occupancy_assert_fn(text) IS 'unrelated-public-object'`);
    await a.query(`
      CREATE OR REPLACE FUNCTION public._091_occupancy_assert_trg(text, text)
      RETURNS text LANGUAGE sql AS $f$ SELECT 'sentinel-trg'::text $f$;
    `);
    await a.query(`COMMENT ON FUNCTION public._091_occupancy_assert_trg(text, text) IS 'unrelated-public-object'`);
    await applySqlFile(a, TARGET_FILE);
    const sentinel = await a.query(`SELECT public._091_occupancy_assert_fn('x') AS v`);
    const sentinelTrg = await a.query(`SELECT public._091_occupancy_assert_trg('a','b') AS v`);
    const sentinelComment = await a.query(
      `SELECT obj_description('public._091_occupancy_assert_fn(text)'::regprocedure, 'pg_proc') AS c`
    );
    ok('unrelated public._091_occupancy_assert_fn untouched',
      sentinel.rows[0].v === 'sentinel-unrelated' && sentinelComment.rows[0].c === 'unrelated-public-object');
    ok('unrelated public._091_occupancy_assert_trg untouched',
      sentinelTrg.rows[0].v === 'sentinel-trg');

    await a.query(`COMMENT ON FUNCTION public.booking_occupancy_lock_key(text, uuid) IS 'foreign-newer-v2'`);
    await expectSqlError(
      () => applySqlFile(a, TARGET_FILE),
      /091_refused: function/,
      '091 up refuses foreign/newer ownership comment'
    );
    // 091.sql starts with BEGIN; RAISE leaves this session aborted until ROLLBACK.
    await a.query('ROLLBACK').catch(() => {});
    await expectSqlError(
      () => applySqlFile(a, '091_booking_occupancy_serialization_down.sql'),
      /091_down_refused/,
      '091 down refuses foreign/newer ownership comment'
    );
    await a.query('ROLLBACK').catch(() => {});
    await a.query(`COMMENT ON FUNCTION public.booking_occupancy_lock_key(text, uuid) IS '${OWNED_COMMENT}'`);
    await applySqlFile(a, TARGET_FILE);
    const restored = await objectComment(a, 'fn', 'public.booking_occupancy_lock_key(text,uuid)');
    ok('091 owned objects restored after foreign comment', restored === OWNED_COMMENT);

    const linkedBk = await insertBooking(observer, {
      clientId: whId, code: 'XBLK-LINK', status: 'blocked',
      start: '2026-12-01', end: '2026-12-03',
    });
    await insertAssignment(observer, {
      clientId: whId, bookingId: linkedBk, bedId: UUID_BED_1,
      type: 'external_inventory_block', start: '2026-12-01', end: '2026-12-03',
    });
    await observer.query(
      `INSERT INTO public.external_inventory_events (
          connection_id, client_id, external_uid, period_start, period_end, booking_id, status
        ) VALUES ($1,$2,'uid-imported','2026-12-01','2026-12-03',$3,'imported')`,
      [connId, whId, linkedBk]
    );
    await observer.query(
      `INSERT INTO public.external_inventory_events (
          connection_id, client_id, external_uid, period_start, period_end, status
        ) VALUES ($1,$2,'uid-skip-unmapped','2026-12-04','2026-12-05','skipped_unmapped'),
                 ($1,$2,'uid-skip-conflict','2026-12-06','2026-12-07','skipped_conflict'),
                 ($1,$2,'uid-tombstone','2026-12-08','2026-12-09','tombstoned')`,
      [connId, whId]
    );

    await applySqlFile(a, '091_booking_occupancy_serialization_down.sql');
    await applySqlFile(a, '091_booking_occupancy_serialization_down.sql');
    const goneLock = await a.query(`SELECT to_regprocedure('public.booking_occupancy_lock_key(text,uuid)') IS NULL AS gone`);
    ok('091 down twice removed occupancy objects', goneLock.rows[0].gone === true);

    await applySqlFile(a, '090_external_calendar_inventory_tenant_integrity_down.sql');
    await applySqlFile(a, '090_external_calendar_inventory_tenant_integrity_down.sql');
    const gone090 = await a.query(
      `SELECT to_regprocedure('public.external_calendar_assert_same_client()') IS NULL AS gone`
    );
    ok('090 down twice removed tenant-integrity function', gone090.rows[0].gone === true);

    await expectSqlError(
      () => applySqlFile(a, '089_external_calendar_inventory_down.sql'),
      /089_down_refused/,
      '089 down refuses imported owner-schedule identity'
    );
    await a.query('ROLLBACK').catch(() => {});
    const stillConn = await a.query(`SELECT COUNT(*)::int AS n FROM public.external_calendar_connections`);
    ok('089 down left bridge identities in place on refusal', stillConn.rows[0].n >= 1);

    await a.query(`
      UPDATE public.external_inventory_events
         SET booking_id = NULL, status = 'tombstoned'
       WHERE status = 'imported'`);
    await a.query(`DELETE FROM public.external_inventory_events`);
    await a.query(`DELETE FROM public.external_calendar_unit_maps`);
    await a.query(`DELETE FROM public.external_calendar_secrets`);
    await a.query(`DELETE FROM public.external_calendar_connections`);

    await applySqlFile(a, '089_external_calendar_inventory_down.sql');
    await applySqlFile(a, '089_external_calendar_inventory_down.sql');
    const gone089 = await a.query(`SELECT to_regclass('public.external_calendar_connections') IS NULL AS gone`);
    ok('089 down twice dropped bridge tables', gone089.rows[0].gone === true);

    await applySqlFile(a, '089_external_calendar_inventory.sql');
    await applySqlFile(a, '090_external_calendar_inventory_tenant_integrity.sql');
    await applySqlFile(a, TARGET_FILE);
    const reapplied = await objectComment(a, 'fn', 'public.booking_occupancy_lock_key(text,uuid)');
    ok('reapplied 089->090->091 owned occupancy', reapplied === OWNED_COMMENT);

    await runTwoSessionInsertRace(observer, a, b, {
      clientId: whId, bedId: UUID_BED_1,
      start: '2027-01-10', end: '2027-01-12', prefix: 'final-reapply',
    });
  } catch (err) {
    liveError = err;
  } finally {
    for (const worker of workers) {
      try { await worker.query('ROLLBACK'); } catch (_) { /* ignore */ }
    }
    for (const worker of workers) {
      try {
        await withTimeout(worker.end(), 5000, 'worker.end');
      } catch (_) {
        try { worker.end(); } catch (_) { /* ignore */ }
      }
    }
    if (created) {
      try { await terminateDisposableBackends(admin, dbName); } catch (_) { /* ignore */ }
      try {
        await dropDisposableDatabase(admin, dbName);
      } catch (cleanupErr) {
        const wrapped = new Error('loud cleanup failure: ' + cleanupErr.message);
        liveError = liveError
          ? new Error(String(liveError.message || liveError) + '; ' + wrapped.message)
          : wrapped;
      }
    }
    try { await withTimeout(admin.end(), 5000, 'admin.end'); } catch (_) {
      try { admin.end(); } catch (_) { /* ignore */ }
    }
  }
  if (liveError) throw liveError;
  console.log('\nverify-external-calendar-inventory-pg: LIVE CHECKS PASSED');
}

async function main() {
  console.log('verify-external-calendar-inventory-pg');

  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'database/migrations/canonical-manifest.json'),
    'utf8'
  ));
  ok('canonical-manifest exposes entries[]', Array.isArray(manifest.entries) && manifest.entries.length > 0);
  ok('loadManifest.entries is the same array', Array.isArray(loadManifest().entries));

  const chain = selectCanonicalForwardThrough(manifest, TARGET_ID, MIGRATIONS_DIR);
  ok('selected chain is non-empty', chain.length >= 3);
  ok('selected chain ends at 091',
    chain[chain.length - 1].id === TARGET_ID
    && chain[chain.length - 1].filename === TARGET_FILE
    && chain[chain.length - 1].order === chain[chain.length - 1].order);
  ok('exactly one 091 target in forward chain',
    manifest.entries.filter((e) => e.inForwardChain === true && e.id === TARGET_ID).length === 1);
  ok('089 and 090 precede 091 in selected chain',
    chain.some((e) => e.id === '089_external_calendar_inventory')
    && chain.some((e) => e.id === '090_external_calendar_inventory_tenant_integrity')
    && chain.findIndex((e) => e.id === '089_external_calendar_inventory')
      < chain.findIndex((e) => e.id === TARGET_ID));
  ok('selected chain is sorted by numeric order',
    chain.every((e, i) => i === 0 || chain[i - 1].order < e.order));
  ok('every selected checksum verified against file bytes',
    chain.every((e) => sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, e.filename)) === e.sha256));

  let dupOrderThrew = false;
  try {
    assertUniqueForwardEntries([
      { id: 'a', filename: 'a.sql', sha256: 'aa'.repeat(32), order: 1, inForwardChain: true },
      { id: 'b', filename: 'b.sql', sha256: 'bb'.repeat(32), order: 1, inForwardChain: true },
      { id: TARGET_ID, filename: TARGET_FILE, sha256: 'cc'.repeat(32), order: 2, inForwardChain: true },
    ]);
  } catch (err) {
    dupOrderThrew = /duplicate forward order/.test(err.message);
  }
  ok('duplicate numeric order is rejected', dupOrderThrew);

  let dupIdThrew = false;
  try {
    assertUniqueForwardEntries([
      { id: TARGET_ID, filename: 'a.sql', sha256: 'aa'.repeat(32), order: 1, inForwardChain: true },
      { id: TARGET_ID, filename: TARGET_FILE, sha256: 'bb'.repeat(32), order: 2, inForwardChain: true },
    ]);
  } catch (err) {
    dupIdThrew = /duplicate forward id/.test(err.message);
  }
  ok('duplicate forward id is rejected', dupIdThrew);

  let dupFileThrew = false;
  try {
    assertUniqueForwardEntries([
      { id: 'a', filename: TARGET_FILE, sha256: 'aa'.repeat(32), order: 1, inForwardChain: true },
      { id: TARGET_ID, filename: TARGET_FILE, sha256: 'bb'.repeat(32), order: 2, inForwardChain: true },
    ]);
  } catch (err) {
    dupFileThrew = /duplicate forward filename/.test(err.message);
  }
  ok('duplicate forward filename is rejected', dupFileThrew);

  let dupSumThrew = false;
  try {
    assertUniqueForwardEntries([
      { id: 'a', filename: 'a.sql', sha256: 'ab'.repeat(32), order: 1, inForwardChain: true },
      { id: TARGET_ID, filename: TARGET_FILE, sha256: 'ab'.repeat(32), order: 2, inForwardChain: true },
    ]);
  } catch (err) {
    dupSumThrew = /duplicate forward checksum/.test(err.message);
  }
  ok('duplicate forward checksum is rejected', dupSumThrew);

  let missingTargetThrew = false;
  try {
    selectCanonicalForwardThrough({
      entries: [
        { id: '001_init', filename: '001_init.sql', sha256: 'aa'.repeat(32), order: 1, inForwardChain: true },
      ],
    }, TARGET_ID, MIGRATIONS_DIR);
  } catch (err) {
    missingTargetThrew = /exactly one/.test(err.message);
  }
  ok('missing 091 target is rejected', missingTargetThrew);

  let checksumThrew = false;
  try {
    verifyMigrationChecksums([
      { id: TARGET_ID, filename: TARGET_FILE, sha256: '00'.repeat(32) },
    ], MIGRATIONS_DIR);
  } catch (err) {
    checksumThrew = /checksum mismatch/.test(err.message);
  }
  ok('wrong file checksum is rejected', checksumThrew);

  assertStockSql(UP089, '089');
  assertStockSql(UP090, '090');
  assertStockSql(UP091, '091');
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
  ok('091 has no public _091 occupancy assert helpers',
    !/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\._091_occupancy_assert_/i.test(UP091));
  ok('091 ownership checks are inline DO', /DO\s+\$assert091\$/.test(UP091) && /to_regprocedure/.test(UP091));
  ok('089 down refuses imported identities', /089_down_refused/.test(DOWN089));
  ok('090 down drops tenant triggers', /external_calendar_unit_maps_tenant_trg/.test(DOWN090));

  function loadLockedPgConnectionStringParse() {
    try {
      const mod = require('pg-connection-string');
      return mod.parse || mod;
    } catch (_) {
      return null;
    }
  }

  function lastQueryValue(raw, key) {
    const all = new URL(raw).searchParams.getAll(key);
    return all.length ? all[all.length - 1] : null;
  }

  function expectLockedParserHost(raw, expectedHost, label) {
    const parseCs = loadLockedPgConnectionStringParse();
    if (!parseCs) return;
    let cfg;
    try {
      cfg = parseCs(raw);
    } catch (err) {
      ok(label + ' (locked parser threw)', false, String(err && err.message || err));
      return;
    }
    ok(label, cfg && String(cfg.host) === expectedHost, cfg && cfg.host);
  }

  const localhostUrl = parseAdminUrl('postgres://gate:pw@localhost:5432/postgres?sslmode=disable');
  ok('accepts localhost admin URL',
    localhostUrl.hostname === 'localhost'
    && localhostUrl.searchParams.get('sslmode') === 'disable'
    && localhostUrl.href.indexOf('sslmode=disable') !== -1);
  const loopbackUrl = parseAdminUrl('postgres://gate:pw@127.4.5.6:5432/postgres?sslmode=require');
  ok('accepts 127.x loopback admin URL',
    loopbackUrl.hostname === '127.4.5.6'
    && loopbackUrl.searchParams.get('sslmode') === 'require');
  const ipv4Url = parseAdminUrl('postgres://gate:pw@127.0.0.1:5432/postgres?sslmode=disable');
  ok('accepts 127.0.0.1 admin URL',
    ipv4Url.hostname === '127.0.0.1'
    && ipv4Url.searchParams.get('sslmode') === 'disable');
  const ipv6Url = parseAdminUrl('postgres://gate:pw@[::1]:5432/postgres?sslmode=disable');
  ok('accepts ::1 loopback admin URL',
    unwrapIpv6Brackets(ipv6Url.hostname) === '::1'
    && ipv6Url.searchParams.get('sslmode') === 'disable');
  const socketUrl = parseAdminUrl('postgres:///postgres?host=/var/run/postgresql');
  ok('accepts Unix-domain socket admin URL',
    socketUrl.searchParams.getAll('host').length === 1
    && socketUrl.searchParams.get('host') === '/var/run/postgresql'
    && !socketUrl.hostname);
  const encodedSocketUrl = parseAdminUrl('postgres:///postgres?host=%2Fvar%2Frun%2Fpostgresql&sslmode=disable');
  ok('accepts percent-encoded Unix-domain socket host query',
    encodedSocketUrl.searchParams.getAll('host').join() === '/var/run/postgresql'
    && encodedSocketUrl.searchParams.get('sslmode') === 'disable');
  const queryLocalhostUrl = parseAdminUrl('postgres:///postgres?host=localhost&sslmode=disable');
  ok('accepts query host=localhost without authority host',
    queryLocalhostUrl.searchParams.getAll('host').join() === 'localhost'
    && queryLocalhostUrl.searchParams.get('sslmode') === 'disable'
    && !queryLocalhostUrl.hostname);
  const queryLoopbackUrl = parseAdminUrl('postgres:///postgres?host=127.0.0.1&sslmode=prefer');
  ok('accepts query host=127.0.0.1 without authority host',
    queryLoopbackUrl.searchParams.getAll('host').join() === '127.0.0.1'
    && queryLoopbackUrl.searchParams.get('sslmode') === 'prefer');
  const queryIpv6Url = parseAdminUrl('postgres:///postgres?host=::1&sslmode=disable');
  ok('accepts query host=::1 without authority host',
    queryIpv6Url.searchParams.getAll('host').join() === '::1'
    && queryIpv6Url.searchParams.get('sslmode') === 'disable');
  const hostaddrUrl = parseAdminUrl('postgres:///postgres?hostaddr=127.0.0.1&sslmode=disable');
  ok('accepts single local hostaddr query without authority host',
    hostaddrUrl.searchParams.getAll('hostaddr').join() === '127.0.0.1'
    && hostaddrUrl.searchParams.getAll('host').length === 0
    && hostaddrUrl.searchParams.get('sslmode') === 'disable');
  const portOptUrl = parseAdminUrl('postgres://localhost:5432/postgres?port=5432&sslmode=disable');
  ok('preserves non-endpoint port and sslmode query options',
    portOptUrl.hostname === 'localhost'
    && portOptUrl.searchParams.get('port') === '5432'
    && portOptUrl.searchParams.get('sslmode') === 'disable'
    && portOptUrl.searchParams.getAll('host').length === 0
    && portOptUrl.searchParams.getAll('hostaddr').length === 0);

  const builtLocal = new URL(buildDatabaseUrl(localhostUrl, 'extcal_gate_test'));
  ok('buildDatabaseUrl preserves sslmode and does not add host selectors',
    builtLocal.pathname === '/extcal_gate_test'
    && builtLocal.hostname === 'localhost'
    && builtLocal.searchParams.get('sslmode') === 'disable'
    && builtLocal.searchParams.getAll('host').length === 0
    && builtLocal.searchParams.getAll('hostaddr').length === 0);
  const builtSocket = new URL(buildDatabaseUrl(socketUrl, 'extcal_gate_test'));
  ok('buildDatabaseUrl preserves the single Unix-socket host query',
    builtSocket.pathname === '/extcal_gate_test'
    && builtSocket.searchParams.getAll('host').join() === '/var/run/postgresql'
    && !builtSocket.hostname);
  expectLockedParserHost(localhostUrl.href, 'localhost', 'locked parser host is localhost for accepted URL');
  expectLockedParserHost(socketUrl.href, '/var/run/postgresql', 'locked parser host is the Unix socket for accepted URL');
  expectLockedParserHost(queryLocalhostUrl.href, 'localhost', 'locked parser host is query localhost for accepted URL');

  const hostnameLookalike = 'postgres://localhost:5432/postgres?hostname=prod.example.org&sslmode=disable';
  const hostnameLookalikeUrl = parseAdminUrl(hostnameLookalike);
  ok('hostname query is not an endpoint selector and does not hide localhost',
    hostnameLookalikeUrl.hostname === 'localhost'
    && hostnameLookalikeUrl.searchParams.get('hostname') === 'prod.example.org'
    && hostnameLookalikeUrl.searchParams.get('sslmode') === 'disable');
  expectLockedParserHost(hostnameLookalike, 'localhost', 'locked parser ignores hostname query for connect host');

  function expectAdminUrlRejected(raw, label) {
    let threw = false;
    let message = '';
    try {
      parseAdminUrl(raw);
    } catch (err) {
      threw = true;
      message = String(err && err.message || err);
    }
    ok(label,
      threw
      && /creates/.test(message)
      && /terminates connections to/.test(message)
      && /drops a disposable database/.test(message)
      && /disposable local cluster/.test(message)
      && !/s3cret/.test(message),
      message);
  }

  expectAdminUrlRejected(
    'postgres://gate:s3cret@shared-staging.example.org:5432/postgres',
    'rejects shared-staging.example.org'
  );
  expectAdminUrlRejected(
    'postgres://gate:s3cret@prod.example.org:5432/postgres',
    'rejects prod.example.org'
  );
  expectAdminUrlRejected(
    'postgres://gate:s3cret@8.8.8.8:5432/postgres',
    'rejects public IP'
  );
  expectAdminUrlRejected(
    'postgres://gate:s3cret@wh-flex.postgres.database.azure.com:5432/postgres?sslmode=require',
    'rejects Azure PostgreSQL hostname'
  );
  expectAdminUrlRejected('not a url', 'rejects malformed URLs');
  expectAdminUrlRejected(
    'http://127.0.0.1:5432/postgres',
    'rejects non-postgres URL scheme'
  );
  expectAdminUrlRejected(
    'postgres://gate:s3cret@db:5432/postgres',
    'rejects ambiguous DNS host'
  );
  expectAdminUrlRejected(
    'postgres://gate:s3cret@host.docker.internal:5432/postgres',
    'rejects ambiguous docker DNS host'
  );
  expectAdminUrlRejected(
    'postgres://gate:s3cret@localhost:5432/postgres?host=prod.example.org',
    'rejects query host override to a non-local endpoint'
  );

  const dupSocketThenRemote = 'postgres:///postgres?host=%2Fvar%2Frun%2Fpostgresql&host=prod.example.org';
  ok('first host is the local Unix socket, last host is remote (get vs getAll)',
    new URL(dupSocketThenRemote).searchParams.get('host') === '/var/run/postgresql'
    && lastQueryValue(dupSocketThenRemote, 'host') === 'prod.example.org');
  expectAdminUrlRejected(
    dupSocketThenRemote,
    'rejects local Unix socket host then remote duplicate host'
  );
  expectLockedParserHost(
    dupSocketThenRemote,
    'prod.example.org',
    'locked parser last duplicate host would redirect to prod.example.org'
  );

  const dupLocalhostThenRemote = 'postgres:///postgres?host=localhost&host=prod.example.org';
  ok('first host is localhost, last host is remote',
    new URL(dupLocalhostThenRemote).searchParams.get('host') === 'localhost'
    && lastQueryValue(dupLocalhostThenRemote, 'host') === 'prod.example.org');
  expectAdminUrlRejected(
    dupLocalhostThenRemote,
    'rejects localhost query host then remote duplicate host'
  );
  expectLockedParserHost(
    dupLocalhostThenRemote,
    'prod.example.org',
    'locked parser last duplicate host would redirect after localhost'
  );

  const dupRemoteThenLocal = 'postgres:///postgres?host=prod.example.org&host=localhost';
  ok('first host is remote, last host is localhost',
    new URL(dupRemoteThenLocal).searchParams.get('host') === 'prod.example.org'
    && lastQueryValue(dupRemoteThenLocal, 'host') === 'localhost');
  expectAdminUrlRejected(
    dupRemoteThenLocal,
    'rejects remote first then local duplicate host'
  );
  expectLockedParserHost(
    dupRemoteThenLocal,
    'localhost',
    'locked parser last duplicate host would be localhost after remote first'
  );

  expectAdminUrlRejected(
    'postgres:///postgres?host=localhost&host=localhost',
    'rejects duplicate local host values'
  );
  expectAdminUrlRejected(
    'postgres:///postgres?hostaddr=127.0.0.1&hostaddr=127.0.0.1',
    'rejects duplicate hostaddr values'
  );
  expectAdminUrlRejected(
    'postgres:///postgres?hostaddr=127.0.0.1&hostaddr=8.8.8.8',
    'rejects local then remote duplicate hostaddr'
  );
  expectAdminUrlRejected(
    'postgres:///postgres?host=localhost&hostaddr=127.0.0.1',
    'rejects simultaneous host and hostaddr'
  );
  expectAdminUrlRejected(
    'postgres://localhost:5432/postgres?host=prod.example.org',
    'rejects authority localhost plus conflicting query host'
  );
  expectAdminUrlRejected(
    'postgres://localhost:5432/postgres?host=localhost',
    'rejects mixed authority localhost plus query host=localhost'
  );
  expectAdminUrlRejected(
    'postgres://127.0.0.1:5432/postgres?hostaddr=127.0.0.1',
    'rejects mixed authority plus hostaddr even when both are local'
  );
  expectAdminUrlRejected(
    'postgres://localhost:5432/postgres?HOST=prod.example.org',
    'rejects HOST case-variant endpoint query key'
  );
  expectAdminUrlRejected(
    'postgres://localhost:5432/postgres?HostAddr=8.8.8.8',
    'rejects HostAddr case-variant endpoint query key'
  );
  expectAdminUrlRejected(
    'postgres:///postgres?hostaddr=8.8.8.8',
    'rejects public hostaddr-only query'
  );

  let timeoutThrew = false;
  let timeoutMsg = '';
  let timeoutResult = null;
  try {
    timeoutResult = await waitUntilWaiting({
      query: async () => ({
        rows: [{ wait_event_type: null, wait_event: null, state: 'idle', application_name: 'extcal-gate-b' }],
      }),
    }, 4242, 50, 'offline-timeout-session');
  } catch (err) {
    timeoutThrew = true;
    timeoutMsg = String(err && err.message || err);
  }
  ok('waitUntilWaiting timeout throws instead of returning null',
    timeoutThrew
    && timeoutResult === null
    && /lock-wait timeout/.test(timeoutMsg)
    && /offline-timeout-session/.test(timeoutMsg)
    && /pid=4242/.test(timeoutMsg));

  const immediateWait = await waitUntilWaiting({
    query: async () => ({
      rows: [{ wait_event_type: 'Lock', wait_event: 'relation', state: 'active', application_name: 'extcal-gate-b' }],
    }),
  }, 7, 200, 'offline-lock-hit');
  ok('waitUntilWaiting returns lock observation',
    isLockWaitObservation(immediateWait) && immediateWait.wait_event === 'relation');

  const selfSrc = fs.readFileSync(__filename, 'utf8');
  const liveStart = selfSrc.indexOf('async function runLiveDisposableGate');
  const liveEnd = selfSrc.indexOf('\nasync function main(');
  const insertStart = selfSrc.indexOf('async function runTwoSessionInsertRace');
  const insertEnd = selfSrc.indexOf('async function terminateDisposableBackends');
  const waitStart = selfSrc.indexOf('async function waitUntilWaiting');
  const waitEnd = selfSrc.indexOf('\nasync function seedTenants');
  ok('static slices for wait/target audit are present',
    liveStart >= 0 && liveEnd > liveStart
    && insertStart >= 0 && insertEnd > insertStart
    && waitStart >= 0 && waitEnd > waitStart);
  const liveSrc = selfSrc.slice(liveStart, liveEnd);
  const insertSrc = selfSrc.slice(insertStart, insertEnd);
  const waitSrc = selfSrc.slice(waitStart, waitEnd);
  const parseAt = liveSrc.indexOf('parseAdminUrl(');
  const requireAt = liveSrc.indexOf("require('pg')");
  const createAt = liveSrc.indexOf('CREATE DATABASE');
  const connectAt = liveSrc.indexOf('admin.connect');
  ok('unsafe target rejected before importing pg', parseAt >= 0 && requireAt > parseAt);
  ok('unsafe target rejected before CREATE DATABASE', parseAt >= 0 && createAt > parseAt);
  ok('unsafe target rejected before admin.connect', parseAt >= 0 && connectAt > parseAt);
  const parseStart = selfSrc.indexOf('function parseAdminUrl(');
  const parseEnd = selfSrc.indexOf('\nfunction buildDatabaseUrl(');
  const parseSrc = selfSrc.slice(parseStart, parseEnd);
  const buildStart = selfSrc.indexOf('function buildDatabaseUrl(');
  const buildEnd = selfSrc.indexOf('\nfunction clientFromUrl(');
  const buildSrc = selfSrc.slice(buildStart, buildEnd);
  ok('parseAdminUrl enumerates host and hostaddr with getAll',
    parseStart >= 0 && parseEnd > parseStart
    && /searchParams\.getAll\(\s*['"]host['"]\s*\)/.test(parseSrc)
    && /searchParams\.getAll\(\s*['"]hostaddr['"]\s*\)/.test(parseSrc));
  ok('parseAdminUrl does not validate host via first-only get',
    !/searchParams\.get\(\s*['"]host['"]\s*\)/.test(parseSrc)
    && !/searchParams\.get\(\s*['"]hostaddr['"]\s*\)/.test(parseSrc));
  ok('buildDatabaseUrl revalidates and only assigns pathname',
    buildStart >= 0 && buildEnd > buildStart
    && /parseAdminUrl\(/.test(buildSrc)
    && /u\.pathname\s*=/.test(buildSrc)
    && !/searchParams\.set\(/.test(buildSrc)
    && !/searchParams\.append\(/.test(buildSrc));
  ok('waitUntilWaiting cannot silently return null',
    /throw new Error\(/.test(waitSrc)
    && /lock-wait timeout/.test(waitSrc)
    && !/\breturn null\b/.test(waitSrc));
  ok('no discarded waitUntilWaiting result',
    !/^\s*await waitUntilWaiting\s*\(/m.test(selfSrc));
  const insertNoJson = insertSrc.replace(/JSON\.stringify\((?:[^()]|\([^()]*\))*\)/g, 'JSON_DETAIL');
  ok('insert race binds waited from waitUntilWaiting',
    /waited = await waitUntilWaiting\(/.test(insertSrc));
  ok('insert race requires waited in acceptance predicate',
    /isLockWaitObservation\(\s*waited\s*\)/.test(insertNoJson));
  const liveNoJson = liveSrc.replace(/JSON\.stringify\((?:[^()]|\([^()]*\))*\)/g, 'JSON_DETAIL');
  ok('bed-change race binds moveWaited from waitUntilWaiting',
    /moveWaited = await waitUntilWaiting\(/.test(liveSrc));
  ok('bed-change race requires moveWaited in acceptance predicate',
    /isLockWaitObservation\(\s*moveWaited\s*\)/.test(liveNoJson));
  ok('lock-ordered swap binds swapWaited from waitUntilWaiting',
    /swapWaited = await waitUntilWaiting\(/.test(liveSrc));
  ok('lock-ordered swap requires swapWaited in acceptance predicate',
    /isLockWaitObservation\(\s*swapWaited\s*\)/.test(liveNoJson)
    && /swapWaited\s*&&/.test(liveNoJson));
  const swapAInsert = liveSrc.match(/const swapA = await insertBooking\((\w+)/);
  ok('lock-ordered swap inserts SWAP-A on observer before race txn',
    swapAInsert && swapAInsert[1] === 'observer');
  ok('lock-ordered swap inserts SWAP-B on observer',
    /const swapB = await insertBooking\(observer/.test(liveSrc));
  ok('shared-phone hang probe observes transactionid wait',
    /shared-phone booking insert waits on open sibling transaction/.test(liveSrc)
    && /wait_event\) === 'transactionid'/.test(liveSrc));
  ok('races bound pending promises with orchestration deadline',
    /withTimeout\(pendingMove/.test(liveSrc)
    && /withTimeout\(pendingSwap/.test(liveSrc)
    && /withTimeout\(pendingB/.test(insertSrc)
    && /withTimeout\(pendingHang/.test(liveSrc));
  ok('race paths rollback both clients in finally',
    /rollbackRace\(a, b\)/.test(insertSrc)
    && /rollbackRace\(a, b\)/.test(liveSrc));

  await runLiveDisposableGate(chain);
  console.log('\nverify-external-calendar-inventory-pg: ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
