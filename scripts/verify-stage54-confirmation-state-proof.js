'use strict';
/**
 * Stage 5.4 — Confirmation state proof runner (READ-ONLY except inline SQL fixtures).
 *
 * Proves getConfirmationNeededQuery() gate semantics:
 *   Fixture A (WH-54-NEEDS-001, +34600000158):
 *     send_confirmation=TRUE, confirmation_sent_at=NULL
 *     → MUST appear in Query F (needs confirmation)
 *
 *   Fixture B (WH-54-CONFIRMED-001, +34600000159):
 *     send_confirmation=TRUE, confirmation_sent_at IS NOT NULL
 *     → must NOT appear in Query F (already confirmed)
 *
 * Sequence:
 *   1. cleanup (idempotent)
 *   2. baseline: 0 fixture rows in Query F
 *   3. seed both fixtures
 *   4. assert: A in Query F, B not in Query F
 *   5. cleanup
 *   6. post-cleanup: 0 fixture rows in Query F
 *   7. booking_beds count unchanged throughout
 *
 * No workflow activation. No webhook POST. No Airtable writes. No booking_beds writes.
 *
 * Usage:
 *   node scripts/verify-stage54-confirmation-state-proof.js
 */

const { Client } = require('pg');
const { getConfirmationNeededQuery, CLIENT_SLUG } = require('./lib/staff-payment-queries');

const PG_URL =
  process.env.WOLFHOUSE_DATABASE_URL ||
  'postgres://wolfhouse:oGFMhl9w59Ym4Gf@localhost:5433/wolfhouse';

const FIXTURE_A = { phone: '+34600000158', bookingCode: 'WH-54-NEEDS-001', label: 'A (needs-confirmation)' };
const FIXTURE_B = { phone: '+34600000159', bookingCode: 'WH-54-CONFIRMED-001', label: 'B (already-confirmed)' };
const ALL_FIXTURE_CODES = [FIXTURE_A.bookingCode, FIXTURE_B.bookingCode];
const ALL_FIXTURE_PHONES = [FIXTURE_A.phone, '34600000158', FIXTURE_B.phone, '34600000159'];

// ---------------------------------------------------------------------------
// Inline SQL helpers
// ---------------------------------------------------------------------------

function cleanupSql() {
  return `
BEGIN;
DELETE FROM payments
WHERE stripe_checkout_session_id IN (
  'cs_test_stage54_needs_001',
  'cs_test_stage54_confirmed_001'
);
DELETE FROM bookings
WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo')
  AND booking_code IN ('WH-54-NEEDS-001', 'WH-54-CONFIRMED-001');
COMMIT;
`;
}

function seedSql() {
  return `
BEGIN;

-- Fixture A: needs confirmation (confirmation_sent_at IS NULL)
INSERT INTO bookings (
  client_id, booking_code, phone, guest_name,
  status, payment_status,
  check_in, check_out, guest_count, package_code,
  requested_room_type, room_preference,
  hold_expires_at, assignment_status, availability_check_status,
  total_amount_cents, deposit_required_cents, amount_paid_cents,
  send_confirmation, confirmation_sent_at,
  booking_source
)
SELECT
  c.id, 'WH-54-NEEDS-001', '+34600000158', 'Test Guest 54a',
  'payment_pending'::booking_status, 'deposit_paid'::payment_status,
  '2026-07-15', '2026-07-22', 2, 'malibu', 'shared', 'shared',
  NOW() + INTERVAL '1 hour',
  'unassigned'::assignment_status, 'available'::availability_check_status,
  69900, 20000, 20000,
  TRUE, NULL,
  'whatsapp'::booking_source
FROM clients c WHERE c.slug = 'wolfhouse-somo';

INSERT INTO payments (
  client_id, booking_id, status, payment_kind,
  currency, amount_due_cents, amount_paid_cents,
  stripe_checkout_session_id, checkout_url, paid_at
)
SELECT
  c.id, b.id,
  'paid'::payment_record_status, 'deposit_only'::payment_kind,
  'EUR', 20000, 20000,
  'cs_test_stage54_needs_001',
  'https://checkout.stripe.test/stage54/cs_test_stage54_needs_001',
  NOW()
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = 'wolfhouse-somo' AND b.booking_code = 'WH-54-NEEDS-001';

-- Fixture B: already confirmed (confirmation_sent_at IS NOT NULL)
INSERT INTO bookings (
  client_id, booking_code, phone, guest_name,
  status, payment_status,
  check_in, check_out, guest_count, package_code,
  requested_room_type, room_preference,
  hold_expires_at, assignment_status, availability_check_status,
  total_amount_cents, deposit_required_cents, amount_paid_cents,
  send_confirmation, confirmation_sent_at,
  booking_source
)
SELECT
  c.id, 'WH-54-CONFIRMED-001', '+34600000159', 'Test Guest 54b',
  'payment_pending'::booking_status, 'deposit_paid'::payment_status,
  '2026-07-15', '2026-07-22', 2, 'malibu', 'shared', 'shared',
  NOW() + INTERVAL '1 hour',
  'unassigned'::assignment_status, 'available'::availability_check_status,
  69900, 20000, 20000,
  TRUE, '2026-06-01 10:00:00+00',
  'whatsapp'::booking_source
FROM clients c WHERE c.slug = 'wolfhouse-somo';

INSERT INTO payments (
  client_id, booking_id, status, payment_kind,
  currency, amount_due_cents, amount_paid_cents,
  stripe_checkout_session_id, checkout_url, paid_at
)
SELECT
  c.id, b.id,
  'paid'::payment_record_status, 'deposit_only'::payment_kind,
  'EUR', 20000, 20000,
  'cs_test_stage54_confirmed_001',
  'https://checkout.stripe.test/stage54/cs_test_stage54_confirmed_001',
  NOW()
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = 'wolfhouse-somo' AND b.booking_code = 'WH-54-CONFIRMED-001';

COMMIT;
`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFixture(row) {
  return (
    ALL_FIXTURE_PHONES.includes(String(row.phone || '')) ||
    ALL_FIXTURE_CODES.includes(row.booking_code)
  );
}

function isFixtureA(row) {
  return row.booking_code === FIXTURE_A.bookingCode || String(row.phone || '') === FIXTURE_A.phone;
}

function isFixtureB(row) {
  return row.booking_code === FIXTURE_B.bookingCode || String(row.phone || '') === FIXTURE_B.phone;
}

async function runQuery(c, sql, params) {
  const { rows } = await c.query(sql, params);
  return rows;
}

async function getConfirmationRows(c) {
  return runQuery(c, getConfirmationNeededQuery(), [CLIENT_SLUG]);
}

async function getBookingBedCount(c) {
  const { rows } = await c.query('SELECT COUNT(*) AS cnt FROM booking_beds');
  return Number(rows[0].cnt);
}

async function execSql(c, sql) {
  await c.query(sql);
}

function assertEq(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: got ${actual}, expected ${expected}`);
  if (!ok) throw new Error(`Assertion failed: ${label} — got ${actual}, expected ${expected}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Stage 5.4 — Confirmation state proof (read-only query gate)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Client: ${CLIENT_SLUG}`);
  console.log(`Fixture A: ${FIXTURE_A.bookingCode} (${FIXTURE_A.phone}) — needs confirmation`);
  console.log(`Fixture B: ${FIXTURE_B.bookingCode} (${FIXTURE_B.phone}) — already confirmed`);
  console.log('');

  const c = new Client({ connectionString: PG_URL });
  await c.connect();

  let fail = false;

  try {
    // ── 1. Cleanup (idempotent pre-run) ────────────────────────────────────
    console.log('── Step 1: Pre-run cleanup ──');
    await execSql(c, cleanupSql());
    console.log('  cleanup SQL executed');

    // ── 2. Baseline ────────────────────────────────────────────────────────
    console.log('\n── Step 2: Baseline check ──');
    const baselineBeds = await getBookingBedCount(c);
    const baselineRows = await getConfirmationRows(c);
    const baselineFixture = baselineRows.filter(isFixture);
    assertEq('baseline fixture rows in Query F', baselineFixture.length, 0);
    console.log(`  booking_beds baseline: ${baselineBeds}`);

    // ── 3. Seed both fixtures ──────────────────────────────────────────────
    console.log('\n── Step 3: Seed fixtures A + B ──');
    await execSql(c, seedSql());

    // Verify seed counts
    const { rows: seedCheck } = await c.query(
      `SELECT booking_code, phone, send_confirmation, confirmation_sent_at, payment_status
       FROM bookings
       WHERE booking_code IN ('WH-54-NEEDS-001', 'WH-54-CONFIRMED-001')
       ORDER BY booking_code`
    );
    console.log(`  seeded bookings: ${seedCheck.length}`);
    for (const r of seedCheck) {
      console.log(
        `    ${r.booking_code}: send_confirmation=${r.send_confirmation}` +
        ` confirmation_sent_at=${r.confirmation_sent_at ?? 'NULL'}` +
        ` payment_status=${r.payment_status}`
      );
    }
    assertEq('seeded booking count', seedCheck.length, 2);

    // ── 4. Assert: A in Query F, B not in Query F ──────────────────────────
    console.log('\n── Step 4: Query F assertion ──');
    const afterSeedRows = await getConfirmationRows(c);
    const afterSeedFixture = afterSeedRows.filter(isFixture);
    const rowA = afterSeedFixture.find(isFixtureA);
    const rowB = afterSeedFixture.find(isFixtureB);

    console.log(`  Query F fixture rows after seed: ${afterSeedFixture.length}`);
    if (rowA) {
      console.log(
        `  [FIXTURE A] booking_code=${rowA.booking_code}` +
        ` confirmation_sent_at=${rowA.confirmation_sent_at ?? 'NULL'}` +
        ` payment_status=${rowA.payment_status}`
      );
    }
    if (rowB) {
      console.log(`  [FIXTURE B] booking_code=${rowB.booking_code} — UNEXPECTED (should not appear)`);
    }

    assertEq('Fixture A in Query F (needs confirmation)', rowA ? 1 : 0, 1);
    assertEq('Fixture B NOT in Query F (already confirmed)', rowB ? 1 : 0, 0);
    assertEq('total fixture rows in Query F', afterSeedFixture.length, 1);

    // Verify Fixture A fields
    if (rowA) {
      const fieldChecks = [
        [rowA.booking_code === FIXTURE_A.bookingCode, `booking_code=${rowA.booking_code}`],
        [rowA.send_confirmation === true, `send_confirmation=${rowA.send_confirmation}`],
        [rowA.confirmation_sent_at == null, `confirmation_sent_at=${rowA.confirmation_sent_at} (expected NULL)`],
        [rowA.payment_status === 'deposit_paid', `payment_status=${rowA.payment_status}`],
      ];
      console.log('\n  Fixture A field checks:');
      for (const [ok, label] of fieldChecks) {
        console.log(`    ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) throw new Error(`Fixture A field check failed: ${label}`);
      }
    }

    // Confirm Fixture B was seeded correctly (confirmation_sent_at IS NOT NULL in DB)
    const { rows: bCheck } = await c.query(
      `SELECT booking_code, send_confirmation, confirmation_sent_at, payment_status
       FROM bookings WHERE booking_code = 'WH-54-CONFIRMED-001'`
    );
    if (bCheck.length > 0) {
      const b = bCheck[0];
      console.log(
        `\n  Fixture B DB state: send_confirmation=${b.send_confirmation}` +
        ` confirmation_sent_at=${b.confirmation_sent_at ?? 'NULL'}` +
        ` payment_status=${b.payment_status}`
      );
      assertEq('Fixture B confirmation_sent_at is NOT NULL in DB', b.confirmation_sent_at != null ? 1 : 0, 1);
      assertEq('Fixture B send_confirmation=TRUE in DB', b.send_confirmation === true ? 1 : 0, 1);
    }

    // ── 5. Cleanup ─────────────────────────────────────────────────────────
    console.log('\n── Step 5: Cleanup ──');
    await execSql(c, cleanupSql());
    console.log('  cleanup SQL executed');

    // ── 6. Post-cleanup check ──────────────────────────────────────────────
    console.log('\n── Step 6: Post-cleanup verification ──');
    const postRows = await getConfirmationRows(c);
    const postFixture = postRows.filter(isFixture);
    assertEq('post-cleanup fixture rows in Query F', postFixture.length, 0);

    const { rows: postBookings } = await c.query(
      `SELECT COUNT(*) AS cnt FROM bookings
       WHERE booking_code IN ('WH-54-NEEDS-001', 'WH-54-CONFIRMED-001')`
    );
    assertEq('post-cleanup bookings count', Number(postBookings[0].cnt), 0);

    const { rows: postPayments } = await c.query(
      `SELECT COUNT(*) AS cnt FROM payments
       WHERE stripe_checkout_session_id IN ('cs_test_stage54_needs_001', 'cs_test_stage54_confirmed_001')`
    );
    assertEq('post-cleanup payments count', Number(postPayments[0].cnt), 0);

    // ── 7. booking_beds unchanged ──────────────────────────────────────────
    console.log('\n── Step 7: booking_beds invariant ──');
    const finalBeds = await getBookingBedCount(c);
    assertEq('booking_beds count unchanged', finalBeds, baselineBeds);

  } catch (e) {
    console.error('\nFAIL:', e.message);
    fail = true;
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
  console.log('Stage 5.4 — Confirmation state proof summary:');
  console.log('  Fixture A (send_confirmation=TRUE, confirmation_sent_at=NULL)    → IN  Query F ✓');
  console.log('  Fixture B (send_confirmation=TRUE, confirmation_sent_at SET)     → NOT in Query F ✓');
  console.log('  Post-cleanup: 0 fixture rows in Query F ✓');
  console.log('  booking_beds: unchanged ✓');
  console.log('  No workflow activation. No webhook POST. No Airtable writes.');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
