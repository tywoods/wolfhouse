'use strict';
/**
 * Stage 5.5 — Staff rooming query smoke proof runner.
 *
 * Seeds two fixture bookings to prove rooming query semantics:
 *
 *   Fixture A (WH-55-ROOMING-001, +34600000160, assignment_status=assigned):
 *     - Has a booking_beds row for bed R1-B1 (2026-07-15 → 2026-07-22)
 *     - Expected: IN  getRoomingRosterQuery()
 *     - Expected: NOT in getUnassignedBookingsQuery()
 *     - Expected: IN  getOccupiedBedsQuery() for overlapping date range
 *     - Expected: NOT in getArrivalsNeedingAssignmentQuery() (already assigned)
 *
 *   Fixture B (WH-55-UNASSIGNED-001, +34600000161, assignment_status=unassigned):
 *     - No booking_beds row
 *     - Expected: NOT in getRoomingRosterQuery()
 *     - Expected: IN  getUnassignedBookingsQuery()
 *     - Expected: IN  getArrivalsNeedingAssignmentQuery() for cutoff >= check_in
 *
 * No workflow activation. No webhook POST. No Airtable writes. No payment_events changes.
 *
 * Usage:
 *   node scripts/verify-stage55-rooming-smoke.js
 */

const { Client } = require('pg');
const {
  CLIENT_SLUG,
  getRoomingRosterQuery,
  getUnassignedBookingsQuery,
  getOccupiedBedsQuery,
  getArrivalsNeedingAssignmentQuery,
} = require('./lib/staff-rooming-queries');

const PG_URL =
  process.env.WOLFHOUSE_DATABASE_URL ||
  'postgres://wolfhouse:oGFMhl9w59Ym4Gf@localhost:5433/wolfhouse';

const FIXTURE_A = { phone: '+34600000160', bookingCode: 'WH-55-ROOMING-001',    label: 'A (assigned)' };
const FIXTURE_B = { phone: '+34600000161', bookingCode: 'WH-55-UNASSIGNED-001', label: 'B (unassigned)' };
const ALL_CODES  = [FIXTURE_A.bookingCode, FIXTURE_B.bookingCode];
const ALL_PHONES = [FIXTURE_A.phone, '34600000160', FIXTURE_B.phone, '34600000161'];

const FIXTURE_CHECK_IN  = '2026-07-15';
const FIXTURE_CHECK_OUT = '2026-07-22';
const BED_CODE          = 'R1-B1';

// Overlap probe: a date range that overlaps the fixture assignment (Jul 15–22)
const PROBE_FROM = '2026-07-16';
const PROBE_TO   = '2026-07-17';

// Arrivals cutoff: check-in <= this date
const ARRIVALS_CUTOFF = '2026-07-15';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFixture(row) {
  return (
    ALL_PHONES.includes(String(row.phone || '')) ||
    ALL_CODES.includes(row.booking_code)
  );
}

function assertEq(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: got ${actual}, expected ${expected}`);
  if (!ok) throw new Error(`Assertion failed: ${label} — got ${actual}, expected ${expected}`);
}

// ---------------------------------------------------------------------------
// Cleanup SQL
// ---------------------------------------------------------------------------
async function runCleanup(c) {
  await c.query(`
    DELETE FROM booking_beds
    WHERE booking_id IN (
      SELECT b.id FROM bookings b
      INNER JOIN clients cl ON cl.id = b.client_id
      WHERE cl.slug = 'wolfhouse-somo'
        AND b.booking_code IN ('WH-55-ROOMING-001', 'WH-55-UNASSIGNED-001')
    )
  `);
  await c.query(`
    DELETE FROM bookings
    WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo')
      AND booking_code IN ('WH-55-ROOMING-001', 'WH-55-UNASSIGNED-001')
  `);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Stage 5.5 — Rooming query smoke proof');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Client: ${CLIENT_SLUG}`);
  console.log(`Fixture A: ${FIXTURE_A.bookingCode} (${FIXTURE_A.phone}) — assigned to ${BED_CODE}`);
  console.log(`Fixture B: ${FIXTURE_B.bookingCode} (${FIXTURE_B.phone}) — unassigned`);
  console.log('');

  const c = new Client({ connectionString: PG_URL });
  await c.connect();

  let fail = false;

  try {
    // ── Step 1: Pre-run cleanup ────────────────────────────────────────────
    console.log('── Step 1: Pre-run cleanup ──');
    await runCleanup(c);
    console.log('  cleanup done');

    // ── Step 2: Baseline ──────────────────────────────────────────────────
    console.log('\n── Step 2: Baseline check ──');
    const { rows: [{ cnt: baselineBeds }] } = await c.query('SELECT COUNT(*)::int AS cnt FROM booking_beds');
    const rosterBase = (await c.query(getRoomingRosterQuery(), [CLIENT_SLUG])).rows.filter(isFixture);
    const unassignedBase = (await c.query(getUnassignedBookingsQuery(), [CLIENT_SLUG])).rows.filter(isFixture);
    assertEq('baseline roster fixture rows', rosterBase.length, 0);
    assertEq('baseline unassigned fixture rows', unassignedBase.length, 0);
    console.log(`  booking_beds baseline: ${baselineBeds}`);

    // ── Step 3: Seed fixtures ──────────────────────────────────────────────
    console.log('\n── Step 3: Seed fixture A (assigned) + B (unassigned) ──');

    // Get client_id
    const { rows: [{ id: clientId }] } = await c.query(
      `SELECT id FROM clients WHERE slug = 'wolfhouse-somo'`
    );

    // Get bed_id for R1-B1
    const { rows: beds } = await c.query(
      `SELECT b.id AS bed_id, r.id AS room_id
       FROM beds b INNER JOIN rooms r ON r.id = b.room_id
       INNER JOIN clients cl ON cl.id = b.client_id
       WHERE cl.slug = 'wolfhouse-somo' AND b.bed_code = $1`,
      [BED_CODE]
    );
    if (beds.length === 0) throw new Error(`Bed ${BED_CODE} not found in DB`);
    const { bed_id: bedId } = beds[0];
    console.log(`  resolved bed_id for ${BED_CODE}: ${bedId}`);

    // Insert Fixture A (assigned)
    await c.query(`
      INSERT INTO bookings (
        client_id, booking_code, phone, guest_name,
        status, payment_status, assignment_status,
        check_in, check_out, guest_count, package_code,
        requested_room_type, room_preference,
        hold_expires_at, availability_check_status,
        total_amount_cents, deposit_required_cents, amount_paid_cents,
        send_confirmation, booking_source
      ) VALUES (
        $1, 'WH-55-ROOMING-001', '+34600000160', 'Test Guest 55a',
        'payment_pending'::booking_status, 'deposit_paid'::payment_status, 'assigned'::assignment_status,
        '2026-07-15', '2026-07-22', 2, 'malibu',
        'shared', 'no preference',
        NOW() + INTERVAL '1 hour', 'available'::availability_check_status,
        69900, 20000, 20000,
        FALSE, 'whatsapp'::booking_source
      )
    `, [clientId]);

    // Get booking A id
    const { rows: [{ id: bookingAId }] } = await c.query(
      `SELECT id FROM bookings WHERE booking_code = 'WH-55-ROOMING-001' AND client_id = $1`,
      [clientId]
    );

    // Insert booking_beds row for Fixture A
    await c.query(`
      INSERT INTO booking_beds (
        client_id, booking_id, bed_id,
        assignment_start_date, assignment_end_date,
        room_code, bed_code, guest_name, assignment_label
      ) VALUES (
        $1, $2, $3,
        '2026-07-15', '2026-07-22',
        'R1', $4, 'Test Guest 55a', 'stage55-fixture'
      )
    `, [clientId, bookingAId, bedId, BED_CODE]);

    // Insert Fixture B (unassigned, no booking_beds)
    await c.query(`
      INSERT INTO bookings (
        client_id, booking_code, phone, guest_name,
        status, payment_status, assignment_status,
        check_in, check_out, guest_count, package_code,
        hold_expires_at, availability_check_status,
        total_amount_cents, deposit_required_cents,
        send_confirmation, booking_source
      ) VALUES (
        $1, 'WH-55-UNASSIGNED-001', '+34600000161', 'Test Guest 55b',
        'payment_pending'::booking_status, 'deposit_paid'::payment_status, 'unassigned'::assignment_status,
        '2026-07-15', '2026-07-22', 1, 'malibu',
        NOW() + INTERVAL '1 hour', 'available'::availability_check_status,
        34950, 20000,
        FALSE, 'whatsapp'::booking_source
      )
    `, [clientId]);

    const { rows: [{ cnt: afterSeedBeds }] } = await c.query('SELECT COUNT(*)::int AS cnt FROM booking_beds');
    assertEq('booking_beds after seed (baseline + 1)', afterSeedBeds, baselineBeds + 1);
    console.log('  fixtures seeded');

    // ── Step 4: Roster assertions ──────────────────────────────────────────
    console.log('\n── Step 4: Roster query (A) ──');
    const rosterRows = (await c.query(getRoomingRosterQuery(), [CLIENT_SLUG])).rows.filter(isFixture);
    const rosterA = rosterRows.find(r => r.booking_code === FIXTURE_A.bookingCode);
    const rosterB = rosterRows.find(r => r.booking_code === FIXTURE_B.bookingCode);
    assertEq('Fixture A in roster (assigned + booking_beds)', rosterA ? 1 : 0, 1);
    assertEq('Fixture B NOT in roster (no booking_beds)', rosterB ? 1 : 0, 0);
    if (rosterA) {
      console.log(`  [A] room_code=${rosterA.room_code} bed_code=${rosterA.bed_code} guest_name=${rosterA.guest_name}`);
      assertEq('roster A bed_code', rosterA.bed_code, BED_CODE);
      assertEq('roster A room_code', rosterA.room_code, 'R1');
    }

    // ── Step 5: Unassigned assertions ─────────────────────────────────────
    console.log('\n── Step 5: Unassigned query (B) ──');
    const unassignedRows = (await c.query(getUnassignedBookingsQuery(), [CLIENT_SLUG])).rows.filter(isFixture);
    const unassignedA = unassignedRows.find(r => r.booking_code === FIXTURE_A.bookingCode);
    const unassignedB = unassignedRows.find(r => r.booking_code === FIXTURE_B.bookingCode);
    assertEq('Fixture A NOT in unassigned (is assigned)', unassignedA ? 1 : 0, 0);
    assertEq('Fixture B IN unassigned (unassigned status, no booking_beds)', unassignedB ? 1 : 0, 1);

    // ── Step 6: Occupied beds probe ───────────────────────────────────────
    console.log('\n── Step 6: Occupied beds query (date overlap probe) ──');
    const occupiedRows = (await c.query(getOccupiedBedsQuery(), [CLIENT_SLUG, PROBE_FROM, PROBE_TO])).rows.filter(isFixture);
    const occupiedA = occupiedRows.find(r => r.booking_code === FIXTURE_A.bookingCode);
    assertEq(`Fixture A in occupied beds (probe ${PROBE_FROM}–${PROBE_TO})`, occupiedA ? 1 : 0, 1);
    if (occupiedA) console.log(`  [A] bed_code=${occupiedA.bed_code} start=${occupiedA.assignment_start_date} end=${occupiedA.assignment_end_date}`);

    // ── Step 7: Arrivals needing assignment ───────────────────────────────
    console.log('\n── Step 7: Arrivals needing assignment query ──');
    const arrivalsRows = (await c.query(getArrivalsNeedingAssignmentQuery(), [CLIENT_SLUG, ARRIVALS_CUTOFF])).rows.filter(isFixture);
    const arrivalsA = arrivalsRows.find(r => r.booking_code === FIXTURE_A.bookingCode);
    const arrivalsB = arrivalsRows.find(r => r.booking_code === FIXTURE_B.bookingCode);
    assertEq(`Fixture A NOT in arrivals-needing-assignment (already assigned)`, arrivalsA ? 1 : 0, 0);
    assertEq(`Fixture B IN arrivals-needing-assignment (unassigned, check_in=${FIXTURE_CHECK_IN})`, arrivalsB ? 1 : 0, 1);

    // ── Step 8: Cleanup ───────────────────────────────────────────────────
    console.log('\n── Step 8: Cleanup ──');
    await runCleanup(c);
    console.log('  cleanup done');

    // ── Step 9: Post-cleanup ──────────────────────────────────────────────
    console.log('\n── Step 9: Post-cleanup verification ──');
    const rosterPost = (await c.query(getRoomingRosterQuery(), [CLIENT_SLUG])).rows.filter(isFixture);
    assertEq('post-cleanup roster fixture rows', rosterPost.length, 0);

    const { rows: [{ cnt: postBeds }] } = await c.query('SELECT COUNT(*)::int AS cnt FROM booking_beds');
    assertEq('booking_beds restored to baseline', postBeds, baselineBeds);

    const { rows: [{ cnt: postBookings }] } = await c.query(
      `SELECT COUNT(*)::int AS cnt FROM bookings WHERE booking_code IN ('WH-55-ROOMING-001','WH-55-UNASSIGNED-001')`
    );
    assertEq('post-cleanup fixture bookings = 0', postBookings, 0);

  } catch (e) {
    console.error('\nFAIL:', e.message);
    fail = true;
    // Attempt cleanup even on failure
    try { await runCleanup(c); } catch (_) {}
  } finally {
    await c.end();
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  if (fail) {
    console.log('Result: FAIL');
    process.exit(1);
  }

  console.log('Result: PASS');
  console.log('');
  console.log('Stage 5.5 rooming smoke proof summary:');
  console.log(`  A (assigned ${BED_CODE})      → IN roster, NOT in unassigned, IN occupied, NOT in arrivals-needing-assignment ✓`);
  console.log('  B (unassigned, no beds) → NOT in roster, IN unassigned, IN arrivals-needing-assignment ✓');
  console.log('  Post-cleanup: 0 fixture rows; booking_beds baseline restored ✓');
  console.log('  No workflow activation. No webhook POST. No Airtable writes.');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
