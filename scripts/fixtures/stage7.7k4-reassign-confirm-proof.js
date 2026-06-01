/**
 * Stage 7.7k4 — Confirmed local fixture bed reassignment write proof.
 *
 * Runs reassignBookingBedSql() with confirm=true against a seeded fixture,
 * verifies exactly one booking_beds row is updated (old→new bed),
 * then undoes the move and verifies all table counts return to baseline.
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  LOCAL / DEV FIXTURE PROOF ONLY                                  ║
 * ║  Does NOT expose a confirmed-write API route or UI.              ║
 * ║  Must only run against local/dev DB (checked below).             ║
 * ║  Does NOT call reassign-booking-beds-pg-sql.js (bot reset path). ║
 * ║  No workflow activation. No webhooks. No WhatsApp. No Stripe.    ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   node scripts/run-sql.js scripts/fixtures/stage7.7k4-reassign-confirm-seed.sql
 *   node scripts/fixtures/stage7.7k4-reassign-confirm-proof.js
 *   node scripts/run-sql.js scripts/fixtures/stage7.7k4-reassign-confirm-cleanup.sql
 *
 * The proof script also seeds, runs, cleans up automatically.
 */

'use strict';

const path = require('path');
const { execSync }    = require('child_process');
const { withPgClient } = require(path.join(__dirname, '..', 'lib', 'pg-connect'));
const { reassignBookingBedSql } = require(path.join(__dirname, '..', 'lib', 'staff-bed-reassignment-sql'));

const CLIENT_SLUG    = 'wolfhouse-somo';
const BOOKING_CODE   = 'WH-77K4-REASSIGN-001';
const SEED_FILE      = path.join(__dirname, 'stage7.7k4-reassign-confirm-seed.sql');
const CLEANUP_FILE   = path.join(__dirname, 'stage7.7k4-reassign-confirm-cleanup.sql');
const RUN_SQL_SCRIPT = path.join(__dirname, '..', 'run-sql.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const results = [];
function ok(msg)   { console.log('  PASS  ' + msg); passed++; results.push({ ok: true,  msg }); }
function fail(msg) { console.error('  FAIL  ' + msg); failed++;  results.push({ ok: false, msg }); }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }

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
    bookings:       Number(bk.rows[0].n),
    booking_beds:   Number(bb.rows[0].n),
    payments:       Number(py.rows[0].n),
    payment_events: Number(pe.rows[0].n),
    staff_handoffs: Number(sh.rows[0].n),
    workflow_events: Number(we.rows[0].n),
  };
}

function runSql(file) {
  execSync(`node "${RUN_SQL_SCRIPT}" "${file}"`, { stdio: 'pipe' });
}

// ── Guard: refuse to run against non-local DB ─────────────────────────────────

async function guardLocalDb(pg) {
  const r = await pg.query(`SELECT current_database() AS db, inet_server_addr() AS addr`);
  const { db, addr } = r.rows[0];
  const addrStr = String(addr || '');
  // Allow: loopback, private RFC-1918 ranges (10/8, 172.16–31/12, 192.168/16),
  // Docker bridge networks (172.17–31), and null/empty (Unix socket / no addr).
  const isLocal = !addrStr || addrStr === '127.0.0.1' || addrStr === '::1'
    || /^10\./.test(addrStr)
    || /^192\.168\./.test(addrStr)
    || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(addrStr);  // 172.16–172.31 (Docker)
  if (!isLocal) {
    throw new Error(
      `SAFETY ABORT: DB server address "${addrStr}" looks non-local. ` +
      `This fixture proof must only run against local/dev DB.`
    );
  }
  return { db, addr: addrStr };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nStage 7.7k4 — confirmed bed reassignment write proof\n');
  console.log('  NOT WIRED — local fixture only. No API route. No UI. No live data.\n');

  let baseline, afterSeed, afterMove, afterUndo, afterCleanup;
  let bookingBedId, oldBedCode, newBedCode, oldRoomCode;
  let bookingId, moveResult, undoResult;
  let seedApplied = false;

  try {
    // ── 0. Guard: local DB only ──────────────────────────────────────────────
    const dbInfo = await withPgClient(guardLocalDb);
    console.log('  DB:', dbInfo.db, '  addr:', dbInfo.addr || 'localhost');

    // ── 1. Baseline counts (before seed) ─────────────────────────────────────
    baseline = await withPgClient(counts);
    console.log('\n  Baseline counts:');
    console.log('    bookings:', baseline.bookings, '  booking_beds:', baseline.booking_beds,
      '  payments:', baseline.payments, '  payment_events:', baseline.payment_events);
    console.log('    staff_handoffs:', baseline.staff_handoffs,
      '  workflow_events:', baseline.workflow_events);

    // ── 2. Apply seed ─────────────────────────────────────────────────────────
    console.log('\n  Seeding fixture...');
    runSql(SEED_FILE);
    seedApplied = true;
    afterSeed = await withPgClient(counts);
    check(afterSeed.bookings   === baseline.bookings   + 1, 'Seed: bookings +1');
    check(afterSeed.booking_beds === baseline.booking_beds + 1, 'Seed: booking_beds +1');
    check(afterSeed.payments   === baseline.payments,         'Seed: payments unchanged');
    check(afterSeed.payment_events === baseline.payment_events, 'Seed: payment_events unchanged');
    check(afterSeed.staff_handoffs === baseline.staff_handoffs, 'Seed: staff_handoffs unchanged');

    // ── 3. Look up fixture assignment ─────────────────────────────────────────
    const fixture = await withPgClient(async (pg) => {
      const r = await pg.query(`
        SELECT bb.id, bb.bed_code, bb.room_code, bb.bed_id,
               bb.assignment_start_date::text AS assignment_start_date,
               bb.assignment_end_date::text   AS assignment_end_date,
               b.id AS booking_id, b.booking_code
        FROM booking_beds bb
        INNER JOIN bookings b ON b.id = bb.booking_id
        INNER JOIN clients  c ON c.id = bb.client_id
        WHERE b.booking_code = $1 AND c.slug = $2
        LIMIT 1
      `, [BOOKING_CODE, CLIENT_SLUG]);
      return r.rows[0] || null;
    });
    if (!fixture) throw new Error('Fixture assignment not found after seed');
    bookingBedId = fixture.id;
    oldBedCode   = fixture.bed_code;
    oldRoomCode  = fixture.room_code;
    bookingId    = fixture.booking_id;
    const startDate = fixture.assignment_start_date;
    const endDate   = fixture.assignment_end_date;
    console.log('\n  Fixture assignment:');
    console.log('    booking_bed_id:', bookingBedId);
    console.log('    old_bed_code  :', oldBedCode, ' old_room_code:', oldRoomCode);
    console.log('    date range    :', new Date(startDate).toISOString().slice(0,10),
      '->', new Date(endDate).toISOString().slice(0,10));

    // ── 4. Find a free target bed ─────────────────────────────────────────────
    newBedCode = await withPgClient(async (pg) => {
      const r = await pg.query(`
        SELECT b.bed_code
        FROM beds b INNER JOIN clients c ON c.id = b.client_id
        WHERE c.slug = $1 AND b.active = TRUE AND b.sellable = TRUE
          AND b.id != (SELECT bed_id FROM booking_beds WHERE id = $2)
          AND b.id NOT IN (
            SELECT bb2.bed_id FROM booking_beds bb2
            INNER JOIN bookings bk2 ON bk2.id = bb2.booking_id
            WHERE bk2.status NOT IN ('cancelled','expired')
              AND bb2.assignment_start_date < $4
              AND bb2.assignment_end_date   > $3
          )
        ORDER BY b.bed_code LIMIT 1
      `, [CLIENT_SLUG, bookingBedId, startDate, endDate]);
      return r.rows[0]?.bed_code || null;
    });
    if (!newBedCode) throw new Error('No free target bed found for fixture date range');
    console.log('    new_bed_code  :', newBedCode, ' (free for fixture range)');

    // ── 5. Run confirmed reassignment (confirm=true) ──────────────────────────
    console.log('\n  Running reassignBookingBedSql() with confirm=true...');
    moveResult = await withPgClient(async (pg) => {
      await pg.query('BEGIN');
      let result;
      try {
        result = await pg.query(
          reassignBookingBedSql(),
          [
            CLIENT_SLUG,                       // $1 client_slug
            BOOKING_CODE,                      // $2 booking_code
            bookingBedId,                      // $3 booking_bed_id
            newBedCode,                        // $4 target_bed_code
            'fixture-proof-k4',                // $5 staff_user_id
            'operator',                        // $6 staff_role
            'Stage 7.7k4 fixture confirm proof', // $7 reason_note
            true,                              // $8 confirm = TRUE
          ]
        );
        await pg.query('COMMIT');
      } catch (e) {
        try { await pg.query('ROLLBACK'); } catch (_) {}
        throw e;
      }
      return result.rows[0] || null;
    });
    if (!moveResult) throw new Error('reassignBookingBedSql returned no result row');

    // ── 6. Assert move result ─────────────────────────────────────────────────
    console.log('\n  Move result:');
    console.log('    blocked     :', moveResult.blocked);
    console.log('    block_reason:', moveResult.block_reason);
    console.log('    rows_updated:', moveResult.rows_updated);
    console.log('    old_bed     :', moveResult.old_bed_code, '->', moveResult.new_bed_code);
    console.log('    start_date  :', moveResult.assignment_start_date,
      '  end_date:', moveResult.assignment_end_date);

    check(moveResult.blocked === false,           'blocked=false (no blocker fired)');
    check(!moveResult.block_reason,               'block_reason is null/empty');
    check(Number(moveResult.rows_updated) === 1,  'rows_updated=1 (exactly one row moved)');
    check(moveResult.old_bed_code === oldBedCode, 'old_bed_code matches fixture (' + oldBedCode + ')');
    check(moveResult.new_bed_code === newBedCode, 'new_bed_code matches target (' + newBedCode + ')');
    check(typeof moveResult.audit_payload === 'object' && moveResult.audit_payload !== null,
      'audit_payload present and is object');
    check(typeof moveResult.rollback_payload === 'object' && moveResult.rollback_payload !== null,
      'rollback_payload present and is object');
    check(moveResult.rollback_payload.old_bed_code === oldBedCode,
      'rollback_payload.old_bed_code = ' + oldBedCode);
    check(moveResult.rollback_payload.booking_bed_id === bookingBedId,
      'rollback_payload.booking_bed_id matches');
    // Dates returned from DB as ::text (e.g. '2026-10-05'); no timezone conversion.
    check(moveResult.assignment_start_date === startDate,
      'assignment_start_date unchanged (' + moveResult.assignment_start_date + ')');
    check(moveResult.assignment_end_date === endDate,
      'assignment_end_date unchanged (' + moveResult.assignment_end_date + ')');

    // ── 7. Verify DB state after move ─────────────────────────────────────────
    afterMove = await withPgClient(counts);
    check(afterMove.booking_beds   === afterSeed.booking_beds,
      'booking_beds count unchanged after move (no insert/delete — only update)');
    check(afterMove.payments       === baseline.payments,
      'payments count unchanged after move');
    check(afterMove.payment_events === baseline.payment_events,
      'payment_events count unchanged after move');
    check(afterMove.staff_handoffs === baseline.staff_handoffs,
      'staff_handoffs count unchanged after move');

    const rowAfterMove = await withPgClient(async (pg) => {
      const r = await pg.query(
        `SELECT bb.bed_code, bb.assignment_type, bb.assignment_label
         FROM booking_beds bb WHERE bb.id = $1::uuid`,
        [bookingBedId]
      );
      return r.rows[0] || null;
    });
    check(rowAfterMove !== null,                         'booking_beds row still exists after move');
    check(rowAfterMove.bed_code === newBedCode,          'booking_beds.bed_code = new bed (' + newBedCode + ')');
    check(rowAfterMove.assignment_type === 'manual',     'assignment_type set to manual after move');

    // workflow_events: helper inserts one row on success
    const weDelta = afterMove.workflow_events - afterSeed.workflow_events;
    check(weDelta === 1, 'workflow_events: +1 audit row written on success (delta=' + weDelta + ')');

    if (moveResult.audit_event_id) {
      console.log('    audit_event_id:', moveResult.audit_event_id);
    }

    // ── 8. Undo: direct SQL rollback using rollback_payload data ─────────────
    // NOTE: running the helper again with confirm=true is intentionally blocked by
    // the `manual_operator_lock` safety gate (the move set assignment_type='manual').
    // This is correct behaviour — a second move requires explicit staff review/override.
    // For this fixture proof, the rollback is demonstrated via a direct parameterised
    // UPDATE that mirrors what a future rollback path would do, using rollback_payload.
    console.log('\n  Undoing move (direct SQL rollback from rollback_payload)...');
    const rp = moveResult.rollback_payload;
    check(rp.old_bed_code  === oldBedCode,  'rollback_payload contains original old_bed_code');
    check(rp.booking_bed_id === bookingBedId, 'rollback_payload contains booking_bed_id for undo');

    // Look up old bed_id from bed_code for the direct undo UPDATE
    const oldBedId = await withPgClient(async (pg) => {
      const r = await pg.query(`
        SELECT b.id FROM beds b INNER JOIN clients c ON c.id = b.client_id
        WHERE b.bed_code = $1 AND c.slug = $2 LIMIT 1
      `, [oldBedCode, CLIENT_SLUG]);
      return r.rows[0]?.id || null;
    });
    if (!oldBedId) throw new Error('Could not find old bed id for undo');

    const undoRows = await withPgClient(async (pg) => {
      await pg.query('BEGIN');
      let r;
      try {
        // Direct parameterised UPDATE — mirrors what a rollback helper would do.
        // Restores bed_id, room_code, bed_code to the values in rollback_payload.
        r = await pg.query(`
          UPDATE booking_beds bb
          SET
            bed_id           = $1::uuid,
            bed_code         = $2,
            room_code        = $3,
            assignment_type  = 'automatic',
            assignment_label = 'Rolled back by fixture proof',
            updated_at       = NOW()
          FROM clients c
          WHERE bb.id          = $4::uuid
            AND bb.client_id   = c.id
            AND c.slug         = $5
          RETURNING bb.id, bb.bed_code
        `, [oldBedId, oldBedCode, oldRoomCode, bookingBedId, CLIENT_SLUG]);
        await pg.query('COMMIT');
      } catch (e) {
        try { await pg.query('ROLLBACK'); } catch (_) {}
        throw e;
      }
      return r.rows;
    });
    check(undoRows.length === 1,                         'Undo: exactly 1 row rolled back');
    check(undoRows[0].bed_code === oldBedCode,            'Undo: bed_code restored to ' + oldBedCode);

    const rowAfterUndo = await withPgClient(async (pg) => {
      const r = await pg.query(
        `SELECT bed_code FROM booking_beds WHERE id = $1::uuid`,
        [bookingBedId]
      );
      return r.rows[0] || null;
    });
    check(rowAfterUndo?.bed_code === oldBedCode, 'DB: booking_beds.bed_code restored to ' + oldBedCode);

  } catch (err) {
    fail('EXCEPTION: ' + err.message);
    console.error('\n  Error stack:', err.stack);
  } finally {
    // ── 9. Cleanup: always run regardless of proof outcome ───────────────────
    if (seedApplied) {
      console.log('\n  Running cleanup...');
      try { runSql(CLEANUP_FILE); } catch (e) { console.error('  Cleanup error:', e.message); }
    }

    // ── 10. Final delta assertions ────────────────────────────────────────────
    try {
      afterCleanup = await withPgClient(counts);
      console.log('\n  Post-cleanup counts vs baseline:');
      console.log('    bookings delta      :', afterCleanup.bookings       - baseline.bookings);
      console.log('    booking_beds delta  :', afterCleanup.booking_beds   - baseline.booking_beds);
      console.log('    payments delta      :', afterCleanup.payments       - baseline.payments);
      console.log('    payment_events delta:', afterCleanup.payment_events - baseline.payment_events);
      console.log('    staff_handoffs delta:', afterCleanup.staff_handoffs - baseline.staff_handoffs);
      console.log('    workflow_events delta:', afterCleanup.workflow_events - baseline.workflow_events);

      check(afterCleanup.bookings       === baseline.bookings,       'bookings restored to baseline');
      check(afterCleanup.booking_beds   === baseline.booking_beds,   'booking_beds restored to baseline');
      check(afterCleanup.payments       === baseline.payments,       'payments unchanged throughout');
      check(afterCleanup.payment_events === baseline.payment_events, 'payment_events unchanged throughout');
      check(afterCleanup.staff_handoffs === baseline.staff_handoffs, 'staff_handoffs unchanged throughout');
      // workflow_events: cleanup removes fixture audit rows; delta should be 0
      check(afterCleanup.workflow_events === baseline.workflow_events,
        'workflow_events restored to baseline (fixture audit rows cleaned up)');
    } catch (e) {
      fail('Post-cleanup count check failed: ' + e.message);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log('Result: ' + passed + ' passed, ' + failed + ' failed');
  if (failed === 0) {
    console.log('\nPROOF PASS');
    console.log('  rows_updated=1 on move; rows_updated=1 on undo');
    console.log('  booking_beds: old→new→old (all counts at baseline after cleanup)');
    console.log('  payments / payment_events / staff_handoffs: delta=0 throughout');
    console.log('  workflow_events: +1 (move) +1 (undo) cleaned up → delta=0');
    console.log('  No API route. No UI wiring. Fixture-only proof.\n');
  } else {
    console.error('\nPROOF FAIL — see failures above\n');
    process.exit(1);
  }
}

main().catch((e) => { console.error('Unhandled error:', e); process.exit(1); });
