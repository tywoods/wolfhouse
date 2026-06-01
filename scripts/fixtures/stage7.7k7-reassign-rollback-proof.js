/**
 * Stage 7.7k7 — Bed reassignment rollback/undo proof.
 *
 * Proves:
 *   Case A — Happy-path undo:
 *     Move WH-77K7-UNDO-001 A→B (admin, confirm=true)
 *     Capture rollback_payload (booking_bed_id, old_bed_code, new_bed_code, dates)
 *     Undo B→A using rollback_payload.old_bed_code (admin, override=true)
 *     Assert: rows_updated=1, DB restored, date range unchanged, audit written
 *
 *   Case B — Conflict-on-undo:
 *     Move WH-77K7-CONFLICT-001 A→B (admin, confirm=true)
 *     Seed blocker booking on old bed A with overlapping dates
 *     Attempt undo B→A (admin, override=true)
 *     Assert: blocked=true, block_reason=target_bed_overlap, rows_updated=0
 *     Assert: booking B remains on B (no overwrite, no double-booking)
 *     Remove blocker
 *
 *   Cleanup: all protected table counts return to baseline (delta=0)
 *
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  LOCAL / DEV FIXTURE PROOF ONLY                               ║
 * ║  No API server. No UI wiring. No live data changes.           ║
 * ║  No workflow activation. No webhook POST.                     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   node scripts/fixtures/stage7.7k7-reassign-rollback-proof.js
 */

'use strict';

const path      = require('path');
const { execSync } = require('child_process');
const { withPgClient } = require(path.join(__dirname, '..', 'lib', 'pg-connect'));
const { reassignBookingBedSql } = require(path.join(__dirname, '..', 'lib', 'staff-bed-reassignment-sql'));

const CLIENT_SLUG    = 'wolfhouse-somo';
const BOOKING_CODE_A = 'WH-77K7-UNDO-001';
const BOOKING_CODE_B = 'WH-77K7-CONFLICT-001';
const BLOCKER_CODE   = 'WH-77K7-BLOCKER-001';
const STAFF_USER_ID  = 'fixture-admin-k7';
const STAFF_ROLE     = 'admin';

// Each operation uses a distinct reason string because booking_beds has a unique
// constraint on (client_id, assignment_label), so every UPDATE needs a unique label.
const REASON_A_MOVE  = 'K7-proof-A-move';
const REASON_A_UNDO  = 'K7-proof-A-undo';
const REASON_B_MOVE  = 'K7-proof-B-move';
const REASON_B_UNDO  = 'K7-proof-B-undo-attempt';

const UNDO_START     = '2027-03-01';
const UNDO_END       = '2027-03-08';
const CONFLICT_START = '2027-03-15';
const CONFLICT_END   = '2027-03-22';

const SEED_FILE    = path.join(__dirname, 'stage7.7k7-reassign-rollback-seed.sql');
const CLEANUP_FILE = path.join(__dirname, 'stage7.7k7-reassign-rollback-cleanup.sql');
const RUN_SQL      = path.join(__dirname, '..', 'run-sql.js');

let passed = 0, failed = 0;
const failMessages = [];
function ok(msg)   { console.log('  PASS  ' + msg); passed++; }
function fail(msg) { console.error('  FAIL  ' + msg); failed++; failMessages.push(msg); }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }

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
    bookings:       +bk.rows[0].n,
    booking_beds:   +bb.rows[0].n,
    payments:       +py.rows[0].n,
    payment_events: +pe.rows[0].n,
    staff_handoffs: +sh.rows[0].n,
    workflow_events:+we.rows[0].n,
  };
}

function runSql(file) { execSync(`node "${RUN_SQL}" "${file}"`, { stdio: 'pipe' }); }

async function lookupFixture(pg, bookingCode) {
  const r = await pg.query(`
    SELECT
      bb.id::text                         AS id,
      bb.bed_id::text                     AS bed_id,
      bb.bed_code,
      bb.room_code,
      bb.assignment_start_date::text      AS assignment_start_date,
      bb.assignment_end_date::text        AS assignment_end_date
    FROM booking_beds bb
    INNER JOIN bookings bk ON bk.id = bb.booking_id
    INNER JOIN clients   c  ON c.id  = bb.client_id
    WHERE bk.booking_code = $1 AND c.slug = $2
    LIMIT 1
  `, [bookingCode, CLIENT_SLUG]);
  return r.rows[0] || null;
}

async function findFreeTargetBed(pg, excludeBedId, startDate, endDate) {
  const r = await pg.query(`
    SELECT b.bed_code, b.id::text AS bed_id
    FROM beds b
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1
      AND b.active   = TRUE
      AND b.sellable = TRUE
      AND b.id      != $2::uuid
      AND b.id NOT IN (
        SELECT bb2.bed_id FROM booking_beds bb2
        INNER JOIN bookings bk2 ON bk2.id = bb2.booking_id
        WHERE bk2.status NOT IN ('cancelled', 'expired')
          AND bb2.assignment_start_date < $4::date
          AND bb2.assignment_end_date   > $3::date
      )
    ORDER BY b.bed_code
    LIMIT 1
  `, [CLIENT_SLUG, excludeBedId, startDate, endDate]);
  return r.rows[0] || null;
}

// Executes the reassignBookingBedSql inside a single BEGIN/COMMIT transaction.
// reason must be unique per operation (booking_beds has a unique assignment_label constraint).
async function runReassign(bookingCode, bookingBedId, targetBedCode, overrideFlag, reason) {
  return await withPgClient(async (pg) => {
    await pg.query('BEGIN');
    try {
      const result = await pg.query(reassignBookingBedSql(), [
        CLIENT_SLUG,   // $1 client_slug
        bookingCode,   // $2 booking_code
        bookingBedId,  // $3 booking_bed_id
        targetBedCode, // $4 target_bed_code
        STAFF_USER_ID, // $5 staff_user_id
        STAFF_ROLE,    // $6 staff_role
        reason,        // $7 reason_note (unique per op to avoid label constraint violation)
        true,          // $8 confirm
        overrideFlag,  // $9 manual_operator_lock_override
      ]);
      await pg.query('COMMIT');
      return result.rows[0];
    } catch (e) {
      await pg.query('ROLLBACK');
      throw e;
    }
  });
}

async function getBedCode(bookingBedId) {
  return await withPgClient(async (pg) => {
    const r = await pg.query(
      `SELECT bed_code FROM booking_beds WHERE id = $1::uuid`, [bookingBedId]
    );
    return r.rows[0]?.bed_code || null;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nStage 7.7k7 — bed reassignment rollback/undo proof\n');
  console.log('  LOCAL/DEV fixture proof only.');
  console.log('  No API server. No UI wiring. No live data.\n');

  let baseline, afterSeed, afterCleanup;
  let blockerBookingId = null, blockerBbId = null;

  // ── 0. Guard: local DB ────────────────────────────────────────────────────────
  const dbInfo = await withPgClient(async (pg) => {
    const r = await pg.query(`SELECT current_database() AS db, inet_server_addr() AS addr`);
    return r.rows[0];
  });
  const addr = String(dbInfo.addr || '');
  const isLocal = !addr || addr === '127.0.0.1' || addr === '::1'
    || /^10\./.test(addr) || /^192\.168\./.test(addr)
    || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(addr);
  if (!isLocal) throw new Error('SAFETY ABORT: DB addr "' + addr + '" is non-local');
  console.log('  DB:', dbInfo.db, '  addr:', addr || 'localhost\n');

  // ── 1. Baseline ───────────────────────────────────────────────────────────────
  baseline = await withPgClient(counts);
  console.log('  Baseline: bookings=' + baseline.bookings +
    '  booking_beds=' + baseline.booking_beds +
    '  workflow_events=' + baseline.workflow_events);

  // ── 2. Seed fixtures ──────────────────────────────────────────────────────────
  console.log('\n  Seeding fixtures (UNDO-001 + CONFLICT-001)...');
  runSql(SEED_FILE);

  afterSeed = await withPgClient(counts);
  check(afterSeed.bookings     === baseline.bookings + 2,     'Seed: bookings +2');
  check(afterSeed.booking_beds === baseline.booking_beds + 2, 'Seed: booking_beds +2');
  check(afterSeed.payments     === baseline.payments,          'Seed: payments unchanged');

  // ── 3. Look up seeded fixture rows ────────────────────────────────────────────
  const fixtureA = await withPgClient(async (pg) => lookupFixture(pg, BOOKING_CODE_A));
  const fixtureB = await withPgClient(async (pg) => lookupFixture(pg, BOOKING_CODE_B));

  if (!fixtureA) throw new Error('Fixture A not found after seed: ' + BOOKING_CODE_A);
  if (!fixtureB) throw new Error('Fixture B not found after seed: ' + BOOKING_CODE_B);

  console.log('\n  Fixture A: id=' + fixtureA.id +
    '  bed=' + fixtureA.bed_code +
    '  range=' + fixtureA.assignment_start_date + ' → ' + fixtureA.assignment_end_date);
  console.log('  Fixture B: id=' + fixtureB.id +
    '  bed=' + fixtureB.bed_code +
    '  range=' + fixtureB.assignment_start_date + ' → ' + fixtureB.assignment_end_date);

  // Find free target beds for each fixture
  const targetA = await withPgClient(async (pg) =>
    findFreeTargetBed(pg, fixtureA.bed_id, UNDO_START, UNDO_END));
  const targetB = await withPgClient(async (pg) =>
    findFreeTargetBed(pg, fixtureB.bed_id, CONFLICT_START, CONFLICT_END));

  if (!targetA) throw new Error('No free target bed for fixture A range (' + UNDO_START + '–' + UNDO_END + ')');
  if (!targetB) throw new Error('No free target bed for fixture B range (' + CONFLICT_START + '–' + CONFLICT_END + ')');

  console.log('  Target for A move: ' + targetA.bed_code);
  console.log('  Target for B move: ' + targetB.bed_code);

  // ─────────────────────────────────────────────────────────────────────────────
  // CASE A: Happy-path undo
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n  ── Case A: Happy-path undo ─────────────────────────────────');

  const bedA_orig = fixtureA.bed_code;

  // A.1 Move A → targetA (assignment_type=automatic → no lock; override=false)
  console.log('\n  A.1: Move ' + bedA_orig + ' → ' + targetA.bed_code + ' (admin, confirm=true)...');
  const moveA = await runReassign(BOOKING_CODE_A, fixtureA.id, targetA.bed_code, false, REASON_A_MOVE);

  check(Number(moveA.rows_updated) === 1,     'A move: rows_updated=1');
  check(moveA.blocked === false,               'A move: not blocked');
  check(moveA.old_bed_code === bedA_orig,      'A move: old_bed_code=' + bedA_orig);
  check(moveA.new_bed_code === targetA.bed_code, 'A move: new_bed_code=' + targetA.bed_code);
  check(!!moveA.audit_event_id,                'A move: audit_event_id present (audit written)');

  // A.2 Verify rollback_payload fields
  const rpA = moveA.rollback_payload;
  check(typeof rpA === 'object' && rpA !== null,
    'A move: rollback_payload is object');
  check(rpA?.booking_bed_id === fixtureA.id,
    'rollback_payload.booking_bed_id = ' + fixtureA.id);
  check(rpA?.old_bed_code === bedA_orig,
    'rollback_payload.old_bed_code = ' + bedA_orig);
  check(rpA?.new_bed_code === targetA.bed_code,
    'rollback_payload.new_bed_code = ' + targetA.bed_code);
  check(rpA?.assignment_start_date === UNDO_START,
    'rollback_payload.assignment_start_date = ' + UNDO_START);
  check(rpA?.assignment_end_date === UNDO_END,
    'rollback_payload.assignment_end_date = ' + UNDO_END);

  // A.3 DB: bed_code = targetA after move
  const bedAfterMove = await getBedCode(fixtureA.id);
  check(bedAfterMove === targetA.bed_code,
    'DB after A move: bed_code = ' + targetA.bed_code);

  // A.4 Undo: targetA → bedA_orig
  //     After move, assignment_type='manual' → override=true + admin required
  console.log('\n  A.4: Undo ' + targetA.bed_code + ' → ' + bedA_orig +
    ' (admin, override=true, using rollback_payload.old_bed_code)...');
  const undoTarget = rpA.old_bed_code;
  const undoA = await runReassign(BOOKING_CODE_A, fixtureA.id, undoTarget, true, REASON_A_UNDO);

  check(Number(undoA.rows_updated) === 1,      'A undo: rows_updated=1');
  check(undoA.blocked === false,                'A undo: not blocked');
  check(undoA.old_bed_code === targetA.bed_code, 'A undo: old_bed_code=' + targetA.bed_code);
  check(undoA.new_bed_code === bedA_orig,        'A undo: new_bed_code=' + bedA_orig);
  check(undoA.assignment_start_date === UNDO_START,
    'A undo: assignment_start_date unchanged (' + UNDO_START + ')');
  check(undoA.assignment_end_date === UNDO_END,
    'A undo: assignment_end_date unchanged (' + UNDO_END + ')');
  check(!!undoA.audit_event_id,
    'A undo: audit_event_id present (undo audit written)');

  // A.5 DB: bed_code restored to original
  const bedAfterUndo = await getBedCode(fixtureA.id);
  check(bedAfterUndo === bedA_orig,
    'DB after A undo: bed_code restored to original (' + bedA_orig + ')');

  // A.6 Table counts after Case A: booking_beds unchanged, workflow_events +2
  const afterCaseA = await withPgClient(counts);
  check(afterCaseA.booking_beds   === afterSeed.booking_beds,
    'Case A: booking_beds count unchanged (no rows added/removed)');
  check(afterCaseA.workflow_events === afterSeed.workflow_events + 2,
    'Case A: workflow_events +2 (move audit + undo audit)');
  check(afterCaseA.payments       === baseline.payments,
    'Case A: payments unchanged');
  check(afterCaseA.payment_events === baseline.payment_events,
    'Case A: payment_events unchanged');
  check(afterCaseA.staff_handoffs === baseline.staff_handoffs,
    'Case A: staff_handoffs unchanged');

  console.log('\n  Case A PASS — ' + bedA_orig + '→' + targetA.bed_code +
    ' (audit+1) · undo ' + targetA.bed_code + '→' + bedA_orig +
    ' (audit+1) · DB restored · dates unchanged');

  // ─────────────────────────────────────────────────────────────────────────────
  // CASE B: Conflict-on-undo
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n  ── Case B: Conflict-on-undo ────────────────────────────────');

  const bedB_orig   = fixtureB.bed_code;
  const bedB_origId = fixtureB.bed_id;

  // B.1 Move CONFLICT-001 bedB_orig → targetB
  console.log('\n  B.1: Move ' + bedB_orig + ' → ' + targetB.bed_code + ' (admin, confirm=true)...');
  const moveB = await runReassign(BOOKING_CODE_B, fixtureB.id, targetB.bed_code, false, REASON_B_MOVE);

  check(Number(moveB.rows_updated) === 1,      'B move: rows_updated=1');
  check(moveB.new_bed_code === targetB.bed_code, 'B move: new_bed_code=' + targetB.bed_code);
  check(!!moveB.audit_event_id,                 'B move: audit_event_id present');

  // B.2 Seed a blocker on bedB_orig (old bed) with overlapping dates 2027-03-16→2027-03-21
  //     The blocker must be a real booking with status='confirmed' so the overlap check fires.
  console.log('\n  B.2: Seeding blocker on old bed ' + bedB_orig + ' (2027-03-16 → 2027-03-21)...');

  const blockerInfo = await withPgClient(async (pg) => {
    const clientResult = await pg.query(
      `SELECT id FROM clients WHERE slug = $1`, [CLIENT_SLUG]);
    const clientId = clientResult.rows[0]?.id;
    if (!clientId) throw new Error('Client not found when seeding blocker');

    // Get room_code for the original bed directly from beds/rooms
    const bedRoomResult = await pg.query(`
      SELECT r.room_code, b.bed_code
      FROM beds b INNER JOIN rooms r ON r.id = b.room_id
      WHERE b.id = $1::uuid LIMIT 1
    `, [bedB_origId]);
    const roomCode = bedRoomResult.rows[0]?.room_code;
    const bedCode  = bedRoomResult.rows[0]?.bed_code;
    if (!roomCode) throw new Error('Room code not found for bed id ' + bedB_origId);

    const bkResult = await pg.query(`
      INSERT INTO bookings (
        client_id, booking_code, guest_name, phone, email,
        guest_count, package_code, check_in, check_out,
        status, payment_status, assignment_status,
        requested_room_type, room_preference, primary_room_code,
        needs_rooming_review, total_amount_cents,
        deposit_required_cents, amount_paid_cents, balance_due_cents
      ) VALUES (
        $1, $2, 'Blocker K7 Guest', '+34600000399', 'blocker-k7@example.com',
        1, 'SURF_7', '2027-03-16', '2027-03-21',
        'confirmed', 'deposit_paid', 'assigned',
        'shared_dorm', 'no preference', $3,
        false, 84000, 21000, 21000, 63000
      ) RETURNING id::text
    `, [clientId, BLOCKER_CODE, roomCode]);
    const blocker_booking_id = bkResult.rows[0].id;

    const bbResult = await pg.query(`
      INSERT INTO booking_beds (
        booking_id, bed_id, client_id, room_code, bed_code,
        assignment_start_date, assignment_end_date,
        assignment_type, assignment_label, planning_row_label
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5,
        '2027-03-16', '2027-03-21',
        'automatic', 'K7-BLOCKER-001-fixture', $6
      ) RETURNING id::text
    `, [blocker_booking_id, bedB_origId, clientId, roomCode, bedCode, BLOCKER_CODE]);
    const blocker_bb_id = bbResult.rows[0].id;

    return { bookingId: blocker_booking_id, bbId: blocker_bb_id };
  });
  blockerBookingId = blockerInfo.bookingId;
  blockerBbId      = blockerInfo.bbId;
  check(!!blockerBookingId, 'Blocker booking created on old bed ' + bedB_orig + ' (overlapping dates)');

  // B.3 Attempt undo B: targetB → bedB_orig  (should fail: target_bed_overlap)
  //     After the move, assignment_type='manual'. Using override=true + admin
  //     bypasses the manual lock (B6) but overlap check (B8) still fires.
  console.log('\n  B.3: Attempt undo ' + targetB.bed_code + ' → ' + bedB_orig +
    ' (admin, override=true) — expect target_bed_overlap...');
  const undoB = await runReassign(BOOKING_CODE_B, fixtureB.id, bedB_orig, true, REASON_B_UNDO);

  check(undoB.blocked === true,
    'B undo: blocked=true (cannot overwrite blocker)');
  check(undoB.block_reason === 'target_bed_overlap',
    'B undo: block_reason=target_bed_overlap');
  check(Number(undoB.rows_updated) === 0,
    'B undo: rows_updated=0 (no overwrite)');
  check(Number(undoB.conflict_count) > 0,
    'B undo: conflict_count > 0 (blocker detected)');

  // B.4 Verify booking B still on target bed (not overwritten)
  const bedAfterBlockedUndo = await getBedCode(fixtureB.id);
  check(bedAfterBlockedUndo === targetB.bed_code,
    'DB: booking B remains on ' + targetB.bed_code + ' after blocked undo (no double-booking)');

  // B.5 Remove the blocker (cleanup before final cleanup SQL)
  await withPgClient(async (pg) => {
    await pg.query(`DELETE FROM booking_beds WHERE id = $1::uuid`, [blockerBbId]);
    await pg.query(`DELETE FROM bookings WHERE id = $1::uuid`,     [blockerBookingId]);
  });
  blockerBookingId = null;
  blockerBbId      = null;
  console.log('  B.5: Blocker removed.');

  // B.6 workflow_events: A.move+1 A.undo+1 B.move+1 B.blocked_undo+0 → baseline+3
  const afterCaseB = await withPgClient(counts);
  check(afterCaseB.workflow_events === afterSeed.workflow_events + 3,
    'Case B: workflow_events = seed+3 (A:move+undo=2, B:move=1, blocked_undo=0)');
  check(afterCaseB.booking_beds === afterSeed.booking_beds,
    'Case B: booking_beds count unchanged (blocker removed)');
  check(afterCaseB.payments       === baseline.payments,
    'Case B: payments unchanged');
  check(afterCaseB.payment_events === baseline.payment_events,
    'Case B: payment_events unchanged');

  console.log('\n  Case B PASS — undo blocked by target_bed_overlap (rows_updated=0) · booking remains on ' + targetB.bed_code);

  // ── Cleanup ────────────────────────────────────────────────────────────────────
  console.log('\n  Running cleanup SQL...');
  try { runSql(CLEANUP_FILE); } catch (e) { console.error('  Cleanup error:', e.message); }

  // ── Final delta check ─────────────────────────────────────────────────────────
  afterCleanup = await withPgClient(counts);
  console.log('\n  Post-cleanup deltas vs baseline:');
  const keys = ['bookings','booking_beds','payments','payment_events','staff_handoffs','workflow_events'];
  for (const k of keys) {
    const delta = afterCleanup[k] - baseline[k];
    console.log('    ' + k.padEnd(20) + ': ' + (delta === 0 ? '0' : '⚠ ' + delta));
  }

  check(afterCleanup.bookings       === baseline.bookings,
    'Final: bookings restored to baseline');
  check(afterCleanup.booking_beds   === baseline.booking_beds,
    'Final: booking_beds restored to baseline');
  check(afterCleanup.payments       === baseline.payments,
    'Final: payments unchanged throughout');
  check(afterCleanup.payment_events === baseline.payment_events,
    'Final: payment_events unchanged throughout');
  check(afterCleanup.staff_handoffs === baseline.staff_handoffs,
    'Final: staff_handoffs unchanged throughout');
  check(afterCleanup.workflow_events === baseline.workflow_events,
    'Final: workflow_events restored to baseline (fixture audit rows cleaned up → delta=0)');

  // ── Summary ────────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(62));
  console.log('Result: ' + passed + ' passed, ' + failed + ' failed');

  if (failed === 0) {
    console.log('\nPROOF PASS — Stage 7.7k7');
    console.log('  Case A (happy-path undo):');
    console.log('    move A→B    rows_updated=1  audit_event_id present');
    console.log('    rollback_payload: booking_bed_id · old_bed_code · new_bed_code · dates ✓');
    console.log('    undo B→A    rows_updated=1  audit_event_id present');
    console.log('    DB: bed restored · date range unchanged ✓');
    console.log('  Case B (conflict-on-undo):');
    console.log('    move A→B    rows_updated=1 ✓');
    console.log('    blocker seeded on old bed A (overlapping dates)');
    console.log('    undo attempt → blocked=true  block_reason=target_bed_overlap  rows_updated=0 ✓');
    console.log('    booking stays on B · no double-booking · no overwrite ✓');
    console.log('  Protected tables: payments · payment_events · staff_handoffs delta=0 ✓');
    console.log('  workflow_events: +3 during proof · cleanup returns to baseline ✓');
    console.log('  No UI wiring. No API server. No live data.\n');
    console.log('  NOTE: UI calendar editing remains disabled.');
    console.log('        Cami/Ale sign-off required before staging/live reassignment.\n');
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
