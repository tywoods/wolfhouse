'use strict';

/**
 * End-to-end Wolfhouse date-change verification.
 *
 * This intentionally uses the repository-pinned PGlite PostgreSQL-wire server,
 * node-postgres, migration-owned schema, the real Staff API router/auth boundary,
 * the real DB pricing overlay/calculator, and the real Luna Python plugin.
 * It never connects to a configured or remote environment.
 */
const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'date-change-e2e-bot-token-32-characters-minimum';
const SLUG = 'wolfhouse-somo';
const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const ROOM_ID = '20000000-0000-4000-8000-000000000001';
const BED_IDS = Array.from({ length: 6 }, (_, i) => `30000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const BOOKING_IDS = Array.from({ length: 6 }, (_, i) => `40000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const MIGRATIONS = ['001_init.sql', '003_rename_hostel_to_client.sql', '009_auth_staff_users.sql', '076_wolfhouse_pricing_admin.sql'];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function post(baseUrl, route, payload, token = TOKEN, guestPhone) {
  const headers = { 'content-type': 'application/json', 'x-luna-bot-token': token };
  if (guestPhone) headers['x-luna-guest-phone'] = guestPhone;
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

function runPython(source, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', source], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`Python Luna verifier exited ${code}: ${stderr || stdout}`));
      resolve(stdout.trim());
    });
  });
}

async function applySchema(pool) {
  for (const name of MIGRATIONS) {
    const sql = await fsp.readFile(path.join(ROOT, 'database', 'migrations', name), 'utf8');
    await pool.query(sql);
  }
  const tables = await pool.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name IN
    ('clients','bookings','beds','booking_beds','wh_pricing_seasons','wh_pricing_season_ranges','wh_pricing_items','wh_pricing_rules')`);
  assert.equal(tables.rowCount, 8, 'repository migrations must own every harness table');
}

async function seed(pool) {
  await pool.query(`INSERT INTO clients (id, slug, name) VALUES ($1,$2,'E2E Wolfhouse')`, [CLIENT_ID, SLUG]);
  await pool.query(`INSERT INTO rooms (id, client_id, room_code, name, room_type, capacity)
    VALUES ($1,$2,'R1','Wire Room','shared',6)`, [ROOM_ID, CLIENT_ID]);
  for (let i = 0; i < BED_IDS.length; i += 1) {
    await pool.query(`INSERT INTO beds (id, client_id, room_id, bed_code, bed_number)
      VALUES ($1,$2,$3,$4,$5)`, [BED_IDS[i], CLIENT_ID, ROOM_ID, `R1-B${i + 1}`, i + 1]);
  }

  const bookings = [
    ['WH-E2E', '+34111000001', '2027-04-01', '2027-04-08', 11100, 2000, 9100],
    ['WH-CONFLICT', '+34111000002', '2027-05-01', '2027-05-08', 24900, 0, 24900],
    ['WH-EN', '+34111000003', '2027-04-01', '2027-04-08', 10000, 1000, 9000],
    ['WH-ES', '+34111000004', '2027-04-01', '2027-04-08', 10000, 1000, 9000],
    ['WH-IT', '+34111000005', '2027-04-01', '2027-04-08', 10000, 1000, 9000],
  ];
  for (let i = 0; i < bookings.length; i += 1) {
    const [code, phone, checkIn, checkOut, total, paid, balance] = bookings[i];
    await pool.query(`INSERT INTO bookings
      (id, client_id, booking_code, phone, status, check_in, check_out, guest_count,
       package_code, requested_room_type, total_amount_cents, deposit_required_cents,
       amount_paid_cents, balance_due_cents)
      VALUES ($1,$2,$3,$4,'confirmed',$5,$6,1,'malibu','shared',$7,20000,$8,$9)`,
    [BOOKING_IDS[i], CLIENT_ID, code, phone, checkIn, checkOut, total, paid, balance]);
    await pool.query(`INSERT INTO booking_beds
      (client_id, booking_id, bed_id, bed_code, room_code, assignment_start_date, assignment_end_date)
      VALUES ($1,$2,$3,$4,'R1',$5,$6)`,
    [CLIENT_ID, BOOKING_IDS[i], BED_IDS[i], `R1-B${i + 1}`, checkIn, checkOut]);
  }
  // Same bed as WH-E2E, but old dates: proving quote excludes its own booking.
  // A different booking blocks a later target and proves conflict refusal.
  await pool.query(`INSERT INTO bookings
    (id, client_id, booking_code, phone, status, check_in, check_out, guest_count,
     package_code, requested_room_type, total_amount_cents, deposit_required_cents,
     amount_paid_cents, balance_due_cents)
    VALUES ($1,$2,'WH-BLOCKER','+34111000006','confirmed','2027-06-01','2027-06-08',1,
      'malibu','shared',24900,20000,0,24900)`, [BOOKING_IDS[5], CLIENT_ID]);
  await pool.query(`INSERT INTO booking_beds
    (client_id, booking_id, bed_id, bed_code, room_code, assignment_start_date, assignment_end_date)
    VALUES ($1,$2,$3,'R1-B1','R1','2027-06-01','2027-06-08')`, [CLIENT_ID, BOOKING_IDS[5], BED_IDS[0]]);

  const season = await pool.query(`INSERT INTO wh_pricing_seasons
    (client_slug, code, label, priority, bookable) VALUES ($1,'spring_autumn','E2E Spring',50,true) RETURNING id`, [SLUG]);
  await pool.query(`INSERT INTO wh_pricing_season_ranges
    (season_id, client_slug, start_month, start_day, end_month, end_day)
    VALUES ($1,$2,4,1,10,31)`, [season.rows[0].id, SLUG]);
  await pool.query(`INSERT INTO wh_pricing_items
    (client_slug,item_type,item_code,label,metadata)
    VALUES ($1,'package','malibu','E2E Malibu','{"base_room_type":"shared","inclusions":["shared_room"]}'::jsonb)`, [SLUG]);
  await pool.query(`INSERT INTO wh_pricing_rules
    (client_slug,item_type,item_code,season_code,unit,amount_cents,currency) VALUES
    ($1,'package','malibu','spring_autumn','per_person_per_week',42000,'EUR'),
    ($1,'supplement','shared',NULL,'per_person_per_night',0,'EUR'),
    ($1,'deposit','standard_package',NULL,'per_booking',12000,'EUR')`, [SLUG]);
}

async function main() {
  // RED contract first: this verifier replaces the old fake-PG/static-source gate.
  assert.equal(process.env.NODE_ENV || 'test', 'test');
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wolfhouse-date-change-e2e-'));
  const pgPort = await freePort();
  const db = new PGlite(path.join(tempDir, 'pglite'), { extensions: { pgcrypto } });
  await db.waitReady;
  const wire = new PGLiteSocketServer({ db, host: '127.0.0.1', port: pgPort, maxConnections: 8 });
  let pool;
  let httpServer;
  try {
    await wire.start();
    pool = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${pgPort}/postgres`, max: 4 });
    await applySchema(pool);
    await seed(pool);

    Object.assign(process.env, {
      NODE_ENV: 'test', STAFF_RUNTIME_PROFILE: 'test', STAFF_AUTH_REQUIRED: 'true', STAFF_AUTH_HTTPS: 'false',
      STAFF_QUERY_API_HOST: '127.0.0.1', STAFF_API_FORTRESS_OFFLINE_LISTENER: '1',
      LUNA_BOT_INTERNAL_TOKEN: TOKEN, LUNA_DATE_CHANGE_TOKEN_SECRET: `${TOKEN}-quote-signing`,
      LUNA_CLIENT_SLUG: SLUG, DEFAULT_CLIENT_SLUG: SLUG, STAFF_API_INGRESS_TENANT_SLUG: SLUG,
      META_WEBHOOK_SKIP_VERIFY: 'true', STRIPE_WEBHOOK_SKIP_VERIFY: 'true',
    });
    const staffApi = require('./staff-query-api');
    // The production flow deliberately performs nested withPgClient calls while
    // the source booking is locked. Reuse that transaction's wire client: PGlite
    // serializes queries globally and (unlike stock Postgres) cannot progress a
    // second connection while the first owns an open transaction.
    const pgContext = new AsyncLocalStorage();
    staffApi.setFortress15j3OfflineSeams({
      withPgClient: async (fn) => {
        const current = pgContext.getStore();
        if (current) return fn(current);
        const client = await pool.connect();
        try { return await pgContext.run(client, () => fn(client)); } finally { client.release(); }
      },
    });
    httpServer = staffApi.createStaffQueryApiHttpServer({ ingressBinding: { tenant_slug: SLUG } });
    const httpPort = await listen(httpServer);
    const baseUrl = `http://127.0.0.1:${httpPort}`;

    // The target overlaps the booking's own current assignment (Apr 1–8), so a
    // successful quote+move directly proves own-booking exclusion over PG wire.
    const payload = { booking_code: 'WH-E2E', guest_phone: '+34111000001', new_check_in: '2027-04-02', new_check_out: '2027-04-09' };
    const unauth = await post(baseUrl, '/staff/bot/bookings/date-change-quote', payload, 'wrong-token-that-is-at-least-32-characters', payload.guest_phone);
    assert.equal(unauth.status, 401, 'real bot auth must reject a wrong token');

    const missingPrincipal = await post(baseUrl, '/staff/bot/bookings/date-change-quote', payload);
    assert.equal(missingPrincipal.status, 409, 'body phone must not become the trusted principal');
    assert.equal(missingPrincipal.body.reason_code, 'invalid_guest_phone');
    const spoofedBody = await post(baseUrl, '/staff/bot/bookings/date-change-quote', payload, TOKEN, '+349****9999');
    assert.equal(spoofedBody.status, 409, 'body/header identity mismatch must fail closed');
    assert.equal(spoofedBody.body.reason_code, 'booking_owner_mismatch');

    const quote = await post(baseUrl, '/staff/bot/bookings/date-change-quote', payload, TOKEN, payload.guest_phone);
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    assert.equal(quote.body.success, true, 'own assignment must not self-conflict');
    assert.equal(quote.body.quote.total_cents, 42000, 'DB package pricing must drive the real calculator');
    assert.equal(quote.body.quote.deposit_required_cents, 12000, 'DB deposit pricing must drive the real calculator');
    const move = await post(baseUrl, '/staff/bot/bookings/date-change', { ...payload, quote_token: quote.body.quote_token }, TOKEN, payload.guest_phone);
    assert.equal(move.status, 200);
    assert.equal(move.body.moved_same_booking, true);
    const changed = await pool.query(`SELECT check_in::text, check_out::text, total_amount_cents,
      deposit_required_cents, amount_paid_cents, balance_due_cents FROM bookings WHERE id=$1`, [BOOKING_IDS[0]]);
    assert.deepEqual(changed.rows[0], { check_in: '2027-04-02', check_out: '2027-04-09', total_amount_cents: 42000,
      deposit_required_cents: 12000, amount_paid_cents: 2000, balance_due_cents: 40000 });
    const assignment = await pool.query(`SELECT assignment_start_date::text AS check_in,
      assignment_end_date::text AS check_out FROM booking_beds WHERE booking_id=$1`, [BOOKING_IDS[0]]);
    assert.deepEqual(assignment.rows[0], { check_in: '2027-04-02', check_out: '2027-04-09' });

    const conflictPayload = {
      ...payload, new_check_in: '2027-06-02', new_check_out: '2027-06-07',
    };
    const conflict = await post(baseUrl, '/staff/bot/bookings/date-change-quote', conflictPayload, TOKEN, conflictPayload.guest_phone);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.reason_code, 'new_dates_unavailable');
    const otherOwner = await post(baseUrl, '/staff/bot/bookings/date-change-quote', {
      booking_code: 'WH-E2E', guest_phone: '+349****9999', new_check_in: '2027-07-01', new_check_out: '2027-07-08',
    }, TOKEN, '+349****9999');
    assert.equal(otherOwner.status, 409);
    assert.equal(otherOwner.body.reason_code, 'booking_owner_mismatch');

    const python = String.raw`
import json, os, sys, types
staging = os.path.join(os.getcwd(), 'docker', 'hermes-staging')
sys.path.insert(0, os.path.join(staging, 'plugins'))
sys.path.insert(0, staging)
import wolfhouse_staff_api as api
phone = os.environ['VERIFY_PHONE']
api._live_turn_guest_phone = lambda: phone
locale = os.environ['VERIFY_LOCALE']
code = os.environ['VERIFY_CODE']
start = os.environ['VERIFY_START']
end = os.environ['VERIFY_END']
quoted = json.loads(api.quote_booking_date_change({'booking_code': code, 'new_check_in': start, 'new_check_out': end, 'language': locale}))
assert quoted['success'] is True, quoted
moved = json.loads(api.move_booking_dates({'booking_code': code, 'new_check_in': start, 'new_check_out': end, 'quote_token': quoted['quote_token'], 'language': locale}))
assert moved['success'] is True and moved['moved_same_booking'] is True, moved
print(json.dumps({'locale': locale, 'quote_tool': quoted['tool'], 'move_tool': moved['tool'], 'booking_code': moved['booking']['booking_code']}))
`;
    const localeCases = [
      ['EN', 'WH-EN', '+34111000003', '2027-07-01', '2027-07-08'],
      ['ES', 'WH-ES', '+34111000004', '2027-07-08', '2027-07-15'],
      ['IT', 'WH-IT', '+34111000005', '2027-07-15', '2027-07-22'],
    ];
    const localeReceipts = [];
    for (const [locale, code, phone, start, end] of localeCases) {
      const stdout = await runPython(python, {
        WOLFHOUSE_STAFF_API_BASE_URL: baseUrl, LUNA_BOT_INTERNAL_TOKEN: TOKEN, LUNA_CLIENT_SLUG: SLUG,
        WOLFHOUSE_WHATSAPP_GUEST_PHONE: phone, VERIFY_PHONE: phone, VERIFY_LOCALE: locale,
        VERIFY_CODE: code, VERIFY_START: start, VERIFY_END: end,
      });
      const receipt = JSON.parse(stdout.split('\n').at(-1));
      assert.equal(receipt.locale, locale);
      localeReceipts.push(receipt);
    }

    console.log(`schema migrations: ${MIGRATIONS.join(', ')}`);
    console.log('authenticated HTTP: wrong-token=401 missing-principal=409 spoofed-body=409 quote=200 move=200 conflict=409 other-owner=409');
    console.log(`database receipt: ${JSON.stringify({ booking: changed.rows[0], assignment: assignment.rows[0] })}`);
    console.log(`Luna locale receipts: ${JSON.stringify(localeReceipts)}`);
    console.log('verify-wolfhouse-date-change-e2e: PASS');
  } finally {
    if (httpServer && httpServer.listening) await closeServer(httpServer);
    if (pool) await pool.end();
    await wire.stop().catch(() => {});
    await db.close().catch(() => {});
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
