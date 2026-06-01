/**
 * Stage 7.7k6 — Admin-only manual/operator lock override proof.
 *
 * Proves that POST /staff/bed-calendar/reassign/confirm with
 * manual_operator_lock_override:true behaves correctly:
 *
 *   A. Operator + override=false  → 409 manual_operator_lock (unchanged)
 *   B. Operator + override=true   → 403 insufficient_override_role (operator blocked)
 *   C. Admin    + override=false  → 409 manual_operator_lock (still blocked)
 *   D. Admin    + override=true   → 200, rows_updated=1, override applied in audit
 *   E. Cleanup  → all protected table counts restored to baseline
 *
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  LOCAL / DEV FIXTURE PROOF ONLY                               ║
 * ║  Starts API server locally. No live data changes.             ║
 * ║  No UI wiring. No calendar edit. No workflow activation.      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Prerequisites:
 *   node scripts/run-sql.js scripts/fixtures/stage7.2c-auth-seed.sql
 *   (auth seed users are re-applied automatically by this proof)
 *
 * Usage:
 *   node scripts/fixtures/stage7.7k6-reassign-override-proof.js [port]
 */

'use strict';

const http    = require('http');
const path    = require('path');
const { execSync, spawn } = require('child_process');
const { withPgClient } = require(path.join(__dirname, '..', 'lib', 'pg-connect'));

const CLIENT_SLUG   = 'wolfhouse-somo';
const BOOKING_CODE  = 'WH-77K6-OVERRIDE-001';
const PORT          = parseInt(process.argv[2] || '3046', 10);
const SEED_FILE     = path.join(__dirname, 'stage7.7k6-reassign-override-seed.sql');
const CLEANUP_FILE  = path.join(__dirname, 'stage7.7k6-reassign-override-cleanup.sql');
const AUTH_SEED     = path.join(__dirname, 'stage7.2c-auth-seed.sql');
const RUN_SQL       = path.join(__dirname, '..', 'run-sql.js');
const API_SCRIPT    = path.join(__dirname, '..', 'staff-query-api.js');

// Test credentials (from stage7.2c-auth-seed.sql)
const OPERATOR_EMAIL = 'operator.stage72c@example.test';
const OPERATOR_PASS  = 'OperatorPass123!';
const ADMIN_EMAIL    = 'admin.stage72c@example.test';
const ADMIN_PASS     = 'AdminPass123!';

let passed = 0, failed = 0;
const failMessages = [];
function ok(msg)   { console.log('  PASS  ' + msg); passed++; }
function fail(msg) { console.error('  FAIL  ' + msg); failed++; failMessages.push(msg); }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGet(urlStr, cookie) {
  return new Promise((resolve, reject) => {
    const opts = new URL(urlStr);
    const reqOpts = {
      hostname: opts.hostname, port: opts.port, path: opts.pathname + opts.search,
      method: 'GET',
      headers: cookie ? { Cookie: cookie } : {},
    };
    const req = http.request(reqOpts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(urlStr, payload, cookie) {
  return new Promise((resolve, reject) => {
    const jsonBody = JSON.stringify(payload);
    const opts = new URL(urlStr);
    const reqOpts = {
      hostname: opts.hostname, port: opts.port, path: opts.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(jsonBody),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    };
    const req = http.request(reqOpts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    req.write(jsonBody);
    req.end();
  });
}

function extractCookie(headers) {
  const setCookie = headers['set-cookie'];
  if (!setCookie) return null;
  const line = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return line.split(';')[0];
}

async function login(email, password) {
  const r = await httpPost(`http://localhost:${PORT}/staff/auth/login`, {
    client: CLIENT_SLUG, email, password,
  });
  if (r.status !== 200) return null;
  return extractCookie(r.headers);
}

async function waitForApi(maxMs = 8000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await httpGet(`http://localhost:${PORT}/healthz`);
      return true;
    } catch { await new Promise(r => setTimeout(r, 300)); }
  }
  return false;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function counts(pg) {
  const [bk, bb, py, pe, sh, we] = await Promise.all([
    pg.query('SELECT COUNT(*)::int AS n FROM bookings'),
    pg.query('SELECT COUNT(*)::int AS n FROM booking_beds'),
    pg.query('SELECT COUNT(*)::int AS n FROM payments'),
    pg.query('SELECT COUNT(*)::int AS n FROM payment_events'),
    pg.query('SELECT COUNT(*)::int AS n FROM staff_handoffs'),
    pg.query('SELECT COUNT(*)::int AS n FROM workflow_events'),
  ]);
  return {
    bookings: +bk.rows[0].n, booking_beds: +bb.rows[0].n,
    payments: +py.rows[0].n, payment_events: +pe.rows[0].n,
    staff_handoffs: +sh.rows[0].n, workflow_events: +we.rows[0].n,
  };
}

function runSql(file) { execSync(`node "${RUN_SQL}" "${file}"`, { stdio: 'pipe' }); }

async function getBedCode(bookingBedId) {
  return withPgClient(async (pg) => {
    const r = await pg.query(
      'SELECT bed_code FROM booking_beds WHERE id = $1::uuid',
      [bookingBedId]
    );
    return r.rows[0]?.bed_code || null;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nStage 7.7k6 — admin-only manual/operator lock override proof\n');
  console.log('  LOCAL/DEV fixture proof only. No UI wiring. No live data.\n');
  console.log('  Port:', PORT, '  Client:', CLIENT_SLUG);

  let baseline, afterSeed, afterOverride, afterCleanup;
  let bookingBedId, oldBedCode, newBedCode, startDate, endDate;
  let seedApplied = false;
  let apiProc = null;

  // ── 0. Guard: local DB ─────────────────────────────────────────────────────
  const dbInfo = await withPgClient(async (pg) => {
    const r = await pg.query('SELECT current_database() AS db, inet_server_addr() AS addr');
    return r.rows[0];
  });
  const addr = String(dbInfo.addr || '');
  const isLocal = !addr || addr === '127.0.0.1' || addr === '::1'
    || /^10\./.test(addr) || /^192\.168\./.test(addr)
    || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(addr);
  if (!isLocal) throw new Error(`SAFETY ABORT: DB addr "${addr}" is non-local`);
  console.log('\n  DB:', dbInfo.db, '  addr:', addr || 'localhost');

  // ── 1. Baseline ────────────────────────────────────────────────────────────
  baseline = await withPgClient(counts);
  console.log('\n  Baseline: bookings=' + baseline.bookings +
    ' booking_beds=' + baseline.booking_beds +
    ' workflow_events=' + baseline.workflow_events);

  // ── 2. Seed: apply auth users + fixture booking (assignment_type='manual') ──
  console.log('\n  Seeding fixture (assignment_type=manual)...');
  runSql(AUTH_SEED);
  runSql(SEED_FILE);
  seedApplied = true;

  afterSeed = await withPgClient(counts);
  check(afterSeed.bookings     === baseline.bookings + 1,    'Seed: bookings +1');
  check(afterSeed.booking_beds === baseline.booking_beds + 1,'Seed: booking_beds +1');
  check(afterSeed.payments     === baseline.payments,         'Seed: payments unchanged');

  // ── 3. Lookup fixture assignment, confirm manual lock, find free target ─────
  const fixture = await withPgClient(async (pg) => {
    const r = await pg.query(`
      SELECT bb.id::text AS id, bb.bed_code, bb.room_code, bb.assignment_type,
             bb.assignment_start_date::text, bb.assignment_end_date::text
      FROM booking_beds bb
      INNER JOIN bookings bk ON bk.id = bb.booking_id
      INNER JOIN clients   c  ON c.id  = bb.client_id
      WHERE bk.booking_code = $1 AND c.slug = $2 LIMIT 1
    `, [BOOKING_CODE, CLIENT_SLUG]);
    return r.rows[0] || null;
  });
  if (!fixture) throw new Error('Fixture booking_beds row not found after seed');
  bookingBedId = fixture.id;
  oldBedCode   = fixture.bed_code;
  startDate    = fixture.assignment_start_date;
  endDate      = fixture.assignment_end_date;

  check(fixture.assignment_type === 'manual',
    'Fixture: assignment_type=manual (manual_operator_lock will fire without override)');
  console.log('\n  Fixture: booking_bed_id=' + bookingBedId +
    ' old_bed=' + oldBedCode + ' range=' + startDate + '->' + endDate);

  newBedCode = await withPgClient(async (pg) => {
    const r = await pg.query(`
      SELECT b.bed_code FROM beds b INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.active = TRUE AND b.sellable = TRUE
        AND b.id != (SELECT bed_id FROM booking_beds WHERE id = $2::uuid)
        AND b.id NOT IN (
          SELECT bb2.bed_id FROM booking_beds bb2
          INNER JOIN bookings bk2 ON bk2.id = bb2.booking_id
          WHERE bk2.status NOT IN ('cancelled','expired')
            AND bb2.assignment_start_date < $4 AND bb2.assignment_end_date > $3
        )
      ORDER BY b.bed_code LIMIT 1
    `, [CLIENT_SLUG, bookingBedId, startDate, endDate]);
    return r.rows[0]?.bed_code || null;
  });
  if (!newBedCode) throw new Error('No free target bed for fixture range');
  console.log('  Target:  new_bed=' + newBedCode + ' (free for fixture range)');

  // ── 4. Start API server ────────────────────────────────────────────────────
  console.log('\n  Starting API (STAFF_AUTH_REQUIRED=true, STAFF_ACTIONS_ENABLED=true)...');
  apiProc = spawn(process.execPath, [API_SCRIPT], {
    env: {
      ...process.env,
      STAFF_QUERY_API_PORT:  String(PORT),
      STAFF_AUTH_REQUIRED:   'true',
      STAFF_ACTIONS_ENABLED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiProc.stdout.on('data', () => {});
  apiProc.stderr.on('data', () => {});

  const ready = await waitForApi(10000);
  check(ready, 'API started and /healthz responded');
  if (!ready) throw new Error('API failed to start on port ' + PORT);

  // ── Login operator and admin ───────────────────────────────────────────────
  const operatorCookie = await login(OPERATOR_EMAIL, OPERATOR_PASS);
  check(!!operatorCookie, 'Operator login succeeded');

  const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASS);
  check(!!adminCookie, 'Admin login succeeded');

  const BASE_BODY = {
    client:          CLIENT_SLUG,
    booking_bed_id:  bookingBedId,
    target_bed_code: newBedCode,
    reason:          'Stage 7.7k6 override proof',
    confirm:         true,
  };

  // ── CASE A: Operator + override=false → 409 manual_operator_lock ────────────
  console.log('\n  A. Operator + override=false → expect 409 manual_operator_lock...');
  if (operatorCookie) {
    const rA = await httpPost(
      `http://localhost:${PORT}/staff/bed-calendar/reassign/confirm`,
      { ...BASE_BODY, manual_operator_lock_override: false },
      operatorCookie
    );
    console.log('    status:', rA.status, '  block_reason:', rA.body?.block_reason);
    check(rA.status === 409,                                             'A: operator override=false → 409');
    check(rA.body?.block_reason === 'manual_operator_lock',             'A: block_reason=manual_operator_lock');
    check(Number(rA.body?.rows_updated || 0) === 0,                    'A: rows_updated=0 (no write)');
    check((await getBedCode(bookingBedId)) === oldBedCode,              'A: assignment unchanged');
  } else {
    fail('A: operator login failed — skipping case A');
  }

  // ── CASE B: Operator + override=true → 403 insufficient_override_role ───────
  console.log('\n  B. Operator + override=true → expect 403 insufficient_override_role...');
  if (operatorCookie) {
    const rB = await httpPost(
      `http://localhost:${PORT}/staff/bed-calendar/reassign/confirm`,
      { ...BASE_BODY, manual_operator_lock_override: true },
      operatorCookie
    );
    console.log('    status:', rB.status, '  error:', rB.body?.error, '  block_reason:', rB.body?.block_reason);
    check(rB.status === 403,                                             'B: operator override=true → 403');
    check(rB.body?.block_reason === 'insufficient_override_role' ||
          (rB.body?.error || '').includes('admin'),                     'B: insufficient_override_role in response');
    check(rB.body?.current_role === 'operator',                         'B: current_role=operator in response');
    check((await getBedCode(bookingBedId)) === oldBedCode,              'B: assignment unchanged after 403');
  } else {
    fail('B: operator login failed — skipping case B');
  }

  // ── CASE C: Admin + override=false → 409 manual_operator_lock ───────────────
  console.log('\n  C. Admin + override=false → expect 409 manual_operator_lock...');
  if (adminCookie) {
    const rC = await httpPost(
      `http://localhost:${PORT}/staff/bed-calendar/reassign/confirm`,
      { ...BASE_BODY, manual_operator_lock_override: false },
      adminCookie
    );
    console.log('    status:', rC.status, '  block_reason:', rC.body?.block_reason);
    check(rC.status === 409,                                             'C: admin override=false → 409');
    check(rC.body?.block_reason === 'manual_operator_lock',             'C: block_reason=manual_operator_lock');
    check(Number(rC.body?.rows_updated || 0) === 0,                    'C: rows_updated=0 (no write)');
    check((await getBedCode(bookingBedId)) === oldBedCode,              'C: assignment unchanged');
  } else {
    fail('C: admin login failed — skipping case C');
  }

  // ── CASE D: Admin + override=true → 200, rows_updated=1 ─────────────────────
  console.log('\n  D. Admin + override=true → expect 200, rows_updated=1...');
  let overrideResponse = null;
  if (adminCookie) {
    overrideResponse = await httpPost(
      `http://localhost:${PORT}/staff/bed-calendar/reassign/confirm`,
      { ...BASE_BODY, manual_operator_lock_override: true },
      adminCookie
    );
    console.log('\n  API response (D):');
    console.log('    status                              :', overrideResponse.status);
    console.log('    success                             :', overrideResponse.body?.success);
    console.log('    rows_updated                        :', overrideResponse.body?.rows_updated);
    console.log('    old_bed_code                        :', overrideResponse.body?.old_bed_code);
    console.log('    new_bed_code                        :', overrideResponse.body?.new_bed_code);
    console.log('    override_requested                  :', overrideResponse.body?.manual_operator_lock_override_requested);
    console.log('    override_applied                    :', overrideResponse.body?.manual_operator_lock_override_applied);
    console.log('    audit_event_id                      :', overrideResponse.body?.audit_event_id);

    const ap = overrideResponse.body?.audit_payload || {};
    console.log('    audit.override_requested            :', ap.manual_operator_lock_override_requested);
    console.log('    audit.override_applied              :', ap.manual_operator_lock_override_applied);
    console.log('    audit.override_role                 :', ap.override_role);

    check(overrideResponse.status === 200,                              'D: admin override=true → 200');
    check(overrideResponse.body?.success === true,                      'D: response success=true');
    check(Number(overrideResponse.body?.rows_updated) === 1,            'D: rows_updated=1');
    check(overrideResponse.body?.old_bed_code === oldBedCode,           'D: old_bed_code=' + oldBedCode);
    check(overrideResponse.body?.new_bed_code === newBedCode,           'D: new_bed_code=' + newBedCode);
    check(overrideResponse.body?.assignment_start_date === startDate,   'D: assignment_start_date unchanged');
    check(overrideResponse.body?.assignment_end_date   === endDate,     'D: assignment_end_date unchanged');
    check(!!overrideResponse.body?.audit_event_id,                      'D: audit_event_id present');
    check(overrideResponse.body?.manual_operator_lock_override_requested === true,
      'D: override_requested=true in response');
    check(overrideResponse.body?.manual_operator_lock_override_applied === true,
      'D: override_applied=true in response');
    check(ap.manual_operator_lock_override_requested === true,          'D: audit_payload.override_requested=true');
    check(ap.manual_operator_lock_override_applied   === true,          'D: audit_payload.override_applied=true');
    check(ap.override_role === 'admin',                                 'D: audit_payload.override_role=admin');

    // DB verify
    const bedAfterD = await getBedCode(bookingBedId);
    check(bedAfterD === newBedCode, 'D: DB bed_code moved to new bed (' + newBedCode + ')');
  } else {
    fail('D: admin login failed — skipping case D');
  }

  // ── D2. DB counts after successful override write ─────────────────────────
  afterOverride = await withPgClient(counts);
  check(afterOverride.booking_beds   === afterSeed.booking_beds,        'D: booking_beds count unchanged');
  check(afterOverride.payments       === baseline.payments,             'D: payments unchanged');
  check(afterOverride.payment_events === baseline.payment_events,       'D: payment_events unchanged');
  check(afterOverride.staff_handoffs === baseline.staff_handoffs,       'D: staff_handoffs unchanged');
  check(afterOverride.workflow_events === afterSeed.workflow_events + 1,'D: workflow_events +1 (audit row)');

  // ── Kill API before cleanup ────────────────────────────────────────────────
  if (apiProc) { try { apiProc.kill('SIGTERM'); } catch (_) {} apiProc = null; }

  // ── CASE E: Cleanup — restore all counts to baseline ──────────────────────
  console.log('\n  E. Cleanup...');
  try { runSql(CLEANUP_FILE); } catch (e) { console.error('  Cleanup error:', e.message); }

  afterCleanup = await withPgClient(counts);
  console.log('\n  Post-cleanup deltas vs baseline:');
  const tracked = ['bookings','booking_beds','payments','payment_events','staff_handoffs','workflow_events'];
  for (const k of tracked) {
    console.log('    ' + k.padEnd(20) + ': ' + (afterCleanup[k] - baseline[k]));
  }
  check(afterCleanup.bookings       === baseline.bookings,              'E: bookings restored to baseline');
  check(afterCleanup.booking_beds   === baseline.booking_beds,          'E: booking_beds restored to baseline');
  check(afterCleanup.payments       === baseline.payments,              'E: payments unchanged throughout');
  check(afterCleanup.payment_events === baseline.payment_events,        'E: payment_events unchanged throughout');
  check(afterCleanup.staff_handoffs === baseline.staff_handoffs,        'E: staff_handoffs unchanged throughout');
  check(afterCleanup.workflow_events === baseline.workflow_events,
    'E: workflow_events restored to baseline (fixture audit rows cleaned up)');

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(70));
  console.log('Result: ' + passed + ' passed, ' + failed + ' failed');
  if (failed === 0) {
    console.log('\nPROOF PASS');
    console.log('  A: operator + override=false  → 409 manual_operator_lock  (unchanged)');
    console.log('  B: operator + override=true   → 403 insufficient_override_role');
    console.log('  C: admin    + override=false  → 409 manual_operator_lock  (unchanged)');
    console.log('  D: admin    + override=true   → 200, rows_updated=1, override fields in audit');
    console.log('  E: cleanup                    → all protected table counts at baseline');
    console.log('  No UI wiring. No workflow activation. No live data.\n');
  } else {
    console.error('\nPROOF FAIL');
    for (const m of failMessages) console.error('  • ' + m);
    console.log();
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nUnhandled error:', e.message);
  process.exit(1);
});
