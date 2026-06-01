/**
 * Stage 7.7k5 — Confirmed bed reassignment API proof.
 *
 * Proves POST /staff/bed-calendar/reassign/confirm is:
 *   - POST-only (405 for GET)
 *   - Gated by STAFF_ACTIONS_ENABLED + STAFF_AUTH_REQUIRED
 *   - viewer gets 403
 *   - missing confirm/reason/uuid → 400
 *   - operator with valid body → 200 success=true, rows_updated=1
 *   - DB reflects old→new bed after commit
 *   - Second POST blocked (manual_operator_lock after first move)
 *   - Cleanup restores all protected table counts to baseline
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
 *   node scripts/fixtures/stage7.7k5-reassign-confirm-api-proof.js [port]
 */

'use strict';

const http    = require('http');
const path    = require('path');
const { execSync, spawn } = require('child_process');
const { withPgClient } = require(path.join(__dirname, '..', 'lib', 'pg-connect'));

const CLIENT_SLUG   = 'wolfhouse-somo';
const BOOKING_CODE  = 'WH-77K5-REASSIGN-001';
const PORT          = parseInt(process.argv[2] || '3045', 10);
const SEED_FILE     = path.join(__dirname, 'stage7.7k5-reassign-confirm-api-seed.sql');
const CLEANUP_FILE  = path.join(__dirname, 'stage7.7k5-reassign-confirm-api-cleanup.sql');
const AUTH_SEED     = path.join(__dirname, 'stage7.2c-auth-seed.sql');
const RUN_SQL       = path.join(__dirname, '..', 'run-sql.js');
const API_SCRIPT    = path.join(__dirname, '..', 'staff-query-api.js');

// Test credentials (from stage7.2c-auth-seed.sql)
const VIEWER_EMAIL   = 'viewer.stage72c@example.test';
const VIEWER_PASS    = 'ViewerPass123!';
const OPERATOR_EMAIL = 'operator.stage72c@example.test';
const OPERATOR_PASS  = 'OperatorPass123!';

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
  return line.split(';')[0]; // e.g. "luna_staff_session=..."
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nStage 7.7k5 — confirmed bed reassignment API proof\n');
  console.log('  LOCAL/DEV fixture proof only. No UI wiring. No live data.\n');
  console.log('  Port:', PORT, '  Client:', CLIENT_SLUG);

  let baseline, afterSeed, afterMove, afterCleanup;
  let bookingBedId, oldBedCode, newBedCode, oldRoomCode;
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

  // ── 2. Apply seeds (auth fixture users + booking fixture) ──────────────────
  console.log('\n  Seeding fixture...');
  runSql(AUTH_SEED);
  runSql(SEED_FILE);
  seedApplied = true;

  afterSeed = await withPgClient(counts);
  check(afterSeed.bookings     === baseline.bookings + 1,   'Seed: bookings +1');
  check(afterSeed.booking_beds === baseline.booking_beds + 1,'Seed: booking_beds +1');
  check(afterSeed.payments     === baseline.payments,        'Seed: payments unchanged');

  // ── 3. Lookup fixture assignment and free target bed ──────────────────────
  const fixture = await withPgClient(async (pg) => {
    const r = await pg.query(`
      SELECT bb.id::text AS id, bb.bed_code, bb.room_code,
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
  oldRoomCode  = fixture.room_code;
  const startDate = fixture.assignment_start_date;
  const endDate   = fixture.assignment_end_date;
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
      STAFF_QUERY_API_PORT: String(PORT),
      STAFF_AUTH_REQUIRED:  'true',
      STAFF_ACTIONS_ENABLED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiProc.stdout.on('data', () => {});
  apiProc.stderr.on('data', () => {});

  const ready = await waitForApi(10000);
  check(ready, 'API started and /healthz responded');
  if (!ready) throw new Error('API failed to start on port ' + PORT);

  // ── 5. GET → 405 ──────────────────────────────────────────────────────────
  try {
    const r = await httpGet(`http://localhost:${PORT}/staff/bed-calendar/reassign/confirm`);
    check(r.status === 405, 'GET /reassign/confirm → 405 (POST required)');
  } catch (e) { fail('GET /reassign/confirm request failed: ' + e.message); }

  // ── 6. Unauthenticated → 401 ───────────────────────────────────────────────
  try {
    const r = await httpPost(`http://localhost:${PORT}/staff/bed-calendar/reassign/confirm`, {
      client: CLIENT_SLUG, booking_bed_id: bookingBedId,
      target_bed_code: newBedCode, reason: 'test', confirm: true,
    });
    check(r.status === 401, 'No cookie → 401 (authentication required)');
  } catch (e) { fail('Unauth request failed: ' + e.message); }

  // ── 7. Viewer → 403 ───────────────────────────────────────────────────────
  let viewerCookie = await login(VIEWER_EMAIL, VIEWER_PASS);
  check(!!viewerCookie, 'Viewer login succeeded (session cookie obtained)');
  if (viewerCookie) {
    try {
      const r = await httpPost(`http://localhost:${PORT}/staff/bed-calendar/reassign/confirm`, {
        client: CLIENT_SLUG, booking_bed_id: bookingBedId,
        target_bed_code: newBedCode, reason: 'test', confirm: true,
      }, viewerCookie);
      check(r.status === 403,                    'Viewer → 403 (insufficient role)');
      check(r.body?.current_role === 'viewer',   'Viewer 403 response includes current_role=viewer');
    } catch (e) { fail('Viewer request failed: ' + e.message); }
  }

  // ── 8. Operator: validation errors ────────────────────────────────────────
  let operatorCookie = await login(OPERATOR_EMAIL, OPERATOR_PASS);
  check(!!operatorCookie, 'Operator login succeeded (session cookie obtained)');

  if (operatorCookie) {
    // Missing confirm
    const r1 = await httpPost(`http://localhost:${PORT}/staff/bed-calendar/reassign/confirm`, {
      client: CLIENT_SLUG, booking_bed_id: bookingBedId,
      target_bed_code: newBedCode, reason: 'test',
      // confirm deliberately omitted
    }, operatorCookie);
    check(r1.status === 400, 'Operator missing confirm → 400');

    // confirm=false
    const r2 = await httpPost(`http://localhost:${PORT}/staff/bed-calendar/reassign/confirm`, {
      client: CLIENT_SLUG, booking_bed_id: bookingBedId,
      target_bed_code: newBedCode, reason: 'test', confirm: false,
    }, operatorCookie);
    check(r2.status === 400, 'Operator confirm=false → 400');

    // Missing reason
    const r3 = await httpPost(`http://localhost:${PORT}/staff/bed-calendar/reassign/confirm`, {
      client: CLIENT_SLUG, booking_bed_id: bookingBedId,
      target_bed_code: newBedCode, confirm: true,
    }, operatorCookie);
    check(r3.status === 400, 'Operator missing reason → 400');

    // Invalid UUID
    const r4 = await httpPost(`http://localhost:${PORT}/staff/bed-calendar/reassign/confirm`, {
      client: CLIENT_SLUG, booking_bed_id: 'not-a-uuid',
      target_bed_code: newBedCode, reason: 'test', confirm: true,
    }, operatorCookie);
    check(r4.status === 400, 'Operator invalid booking_bed_id UUID → 400');

    // Missing target_bed_code
    const r5 = await httpPost(`http://localhost:${PORT}/staff/bed-calendar/reassign/confirm`, {
      client: CLIENT_SLUG, booking_bed_id: bookingBedId,
      reason: 'test', confirm: true,
    }, operatorCookie);
    check(r5.status === 400, 'Operator missing target_bed_code → 400');
  }

  // ── 9. Successful confirmed reassignment ───────────────────────────────────
  console.log('\n  Running confirmed POST (operator, confirm=true)...');
  let moveResponse;
  try {
    moveResponse = await httpPost(`http://localhost:${PORT}/staff/bed-calendar/reassign/confirm`, {
      client:           CLIENT_SLUG,
      booking_bed_id:   bookingBedId,
      target_bed_code:  newBedCode,
      reason:           'Stage 7.7k5 fixture confirm API proof',
      confirm:          true,
    }, operatorCookie);
  } catch (e) { fail('Confirmed POST request failed: ' + e.message); moveResponse = null; }

  if (moveResponse) {
    console.log('\n  API response:');
    console.log('    status       :', moveResponse.status);
    console.log('    success      :', moveResponse.body?.success);
    console.log('    rows_updated :', moveResponse.body?.rows_updated);
    console.log('    old_bed_code :', moveResponse.body?.old_bed_code);
    console.log('    new_bed_code :', moveResponse.body?.new_bed_code);
    console.log('    audit_event_id:', moveResponse.body?.audit_event_id);

    check(moveResponse.status === 200,                    'Confirmed POST → 200 OK');
    check(moveResponse.body?.success === true,            'Response: success=true');
    check(Number(moveResponse.body?.rows_updated) === 1,  'Response: rows_updated=1');
    check(moveResponse.body?.old_bed_code === oldBedCode, 'Response: old_bed_code=' + oldBedCode);
    check(moveResponse.body?.new_bed_code === newBedCode, 'Response: new_bed_code=' + newBedCode);
    check(moveResponse.body?.start_date === startDate || moveResponse.body?.assignment_start_date === startDate,
      'Response: assignment_start_date unchanged (' + startDate + ')');
    check(!!moveResponse.body?.audit_event_id,            'Response: audit_event_id present');
    check(typeof moveResponse.body?.rollback_payload === 'object' && moveResponse.body.rollback_payload !== null,
      'Response: rollback_payload present');
    check(moveResponse.body?.rollback_payload?.old_bed_code === oldBedCode,
      'rollback_payload.old_bed_code = ' + oldBedCode);
  }

  // ── 10. DB verification after move ────────────────────────────────────────
  afterMove = await withPgClient(counts);
  check(afterMove.booking_beds   === afterSeed.booking_beds,  'DB: booking_beds count unchanged after move');
  check(afterMove.payments       === baseline.payments,        'DB: payments unchanged');
  check(afterMove.payment_events === baseline.payment_events,  'DB: payment_events unchanged');
  check(afterMove.staff_handoffs === baseline.staff_handoffs,  'DB: staff_handoffs unchanged');
  check(afterMove.workflow_events === afterSeed.workflow_events + 1, 'DB: workflow_events +1 (audit row)');

  const rowAfterMove = await withPgClient(async (pg) => {
    const r = await pg.query(
      `SELECT bed_code, assignment_type FROM booking_beds WHERE id = $1::uuid`, [bookingBedId]
    );
    return r.rows[0] || null;
  });
  check(rowAfterMove?.bed_code === newBedCode,      'DB: booking_beds.bed_code = new bed (' + newBedCode + ')');
  check(rowAfterMove?.assignment_type === 'manual', 'DB: assignment_type=manual after confirmed move');

  // ── 11. Second POST: should be blocked (manual_operator_lock) ─────────────
  console.log('\n  Running second POST (expect manual_operator_lock block)...');
  let second;
  if (operatorCookie) {
    try {
      second = await httpPost(`http://localhost:${PORT}/staff/bed-calendar/reassign/confirm`, {
        client:          CLIENT_SLUG,
        booking_bed_id:  bookingBedId,
        target_bed_code: oldBedCode,    // try to move back to original bed
        reason:          'Stage 7.7k5 second attempt (should block)',
        confirm:         true,
      }, operatorCookie);
      check(second.status === 409,
        'Second POST → 409 blocked (assignment_type=manual locks further moves)');
      check(second.body?.blocked === true,                     'Second response: blocked=true');
      check(second.body?.block_reason === 'manual_operator_lock',
        'Second response: block_reason=manual_operator_lock');
      check(Number(second.body?.rows_updated || 0) === 0,     'Second response: rows_updated=0 (no write)');
      console.log('    block_reason:', second.body?.block_reason);
    } catch (e) { fail('Second POST request failed: ' + e.message); }
  }

  // ── 12. Verify DB still on new bed after blocked second attempt ───────────
  const rowAfterBlock = await withPgClient(async (pg) => {
    const r = await pg.query(
      `SELECT bed_code FROM booking_beds WHERE id = $1::uuid`, [bookingBedId]
    );
    return r.rows[0] || null;
  });
  check(rowAfterBlock?.bed_code === newBedCode, 'DB: bed_code still = new bed after blocked second attempt');

  // ── 13. Kill API server before cleanup ────────────────────────────────────
  if (apiProc) { try { apiProc.kill('SIGTERM'); } catch (_) {} apiProc = null; }

  // ── 14. Cleanup ───────────────────────────────────────────────────────────
  console.log('\n  Running cleanup...');
  try { runSql(CLEANUP_FILE); } catch (e) { console.error('  Cleanup error:', e.message); }

  // ── 15. Final count assertions ─────────────────────────────────────────────
  afterCleanup = await withPgClient(counts);
  console.log('\n  Post-cleanup deltas vs baseline:');
  const deltas = ['bookings','booking_beds','payments','payment_events','staff_handoffs','workflow_events'];
  for (const k of deltas) {
    console.log('    ' + k.padEnd(20) + ': ' + (afterCleanup[k] - baseline[k]));
  }
  check(afterCleanup.bookings       === baseline.bookings,       'bookings restored to baseline');
  check(afterCleanup.booking_beds   === baseline.booking_beds,   'booking_beds restored to baseline');
  check(afterCleanup.payments       === baseline.payments,       'payments unchanged throughout');
  check(afterCleanup.payment_events === baseline.payment_events, 'payment_events unchanged throughout');
  check(afterCleanup.staff_handoffs === baseline.staff_handoffs, 'staff_handoffs unchanged throughout');
  check(afterCleanup.workflow_events === baseline.workflow_events,
    'workflow_events restored to baseline (fixture audit rows cleaned up)');

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(62));
  console.log('Result: ' + passed + ' passed, ' + failed + ' failed');
  if (failed === 0) {
    console.log('\nPROOF PASS');
    console.log('  GET → 405 · unauthenticated → 401 · viewer → 403');
    console.log('  missing confirm/reason/uuid → 400');
    console.log('  operator confirm=true → 200, rows_updated=1, old→new bed committed');
    console.log('  second POST → 409 manual_operator_lock (no second write)');
    console.log('  workflow_events +1 (audit row written, cleaned up → delta=0)');
    console.log('  all protected table counts at baseline after cleanup');
    console.log('  No API route outside this endpoint. No UI wiring.\n');
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
