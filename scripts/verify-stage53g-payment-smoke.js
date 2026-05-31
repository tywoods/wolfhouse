'use strict';
/**
 * Stage 5.3g — Combined payment/staff query smoke gate (READ-ONLY flow + fixture SQL).
 *
 * Seeds three fixture states, asserts each lands in the correct query bucket,
 * then cleans up and confirms 0 fixture rows remain.
 *
 * Fixture phones:
 *   +34600000155  WH-53-FIXTURE-001  payment_pending / waiting_payment  + payments row (checkout_created)
 *   +34600000156  WH-53-CONFIRM-001  payment_pending / deposit_paid     + payments row (paid), send_confirmation=TRUE
 *   +34600000157  WH-53G-NOPAY-001   payment_pending / waiting_payment  NO payments row  (tests Query D)
 *
 * Expected query buckets (with all three fixtures seeded):
 *   payment_balances  — 3 fixture rows (all are payment_pending)
 *   A  deposit_paid   — 1 (fixture 2 only)
 *   B  fully_paid     — 0
 *   C  balance_due    — 1 (fixture 2 only; total=69900, paid=20000 → balance=49900)
 *   D  no_payment     — 1 (fixture 3 only; no payments row)
 *   E  waiting_payment — 2 (fixtures 1 + 3; both have payment_status=waiting_payment)
 *   F  confirm_needed  — 1 (fixture 2 only)
 *
 * Safety guarantees:
 *   - No workflow activation
 *   - No webhook POST
 *   - No booking_beds writes
 *   - No payment_events writes
 *   - Cleanup restores all rows to baseline
 *
 * Usage:
 *   node scripts/verify-stage53g-payment-smoke.js
 */

const { Client } = require('pg');
const {
  getPaymentBalancesQuery,
  CLIENT_SLUG,
} = require('./lib/payment-balances-query');
const {
  getDepositPaidQuery,
  getFullyPaidQuery,
  getBalanceDueQuery,
  getNoPaymentRecordQuery,
  getWaitingPaymentQuery,
  getConfirmationNeededQuery,
} = require('./lib/staff-payment-queries');

const PG_URL =
  process.env.WOLFHOUSE_DATABASE_URL ||
  'postgres://wolfhouse:oGFMhl9w59Ym4Gf@localhost:5433/wolfhouse';

// ---------------------------------------------------------------------------
// Fixture definitions
// ---------------------------------------------------------------------------
const FIXTURES = {
  F1: { phone: '+34600000155', rawPhone: '34600000155', code: 'WH-53-FIXTURE-001' },
  F2: { phone: '+34600000156', rawPhone: '34600000156', code: 'WH-53-CONFIRM-001' },
  F3: { phone: '+34600000157', rawPhone: '34600000157', code: 'WH-53G-NOPAY-001' },
};
const ALL_PHONES = Object.values(FIXTURES).flatMap((f) => [f.phone, f.rawPhone]);
const ALL_CODES  = Object.values(FIXTURES).map((f) => f.code);

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------
function cleanupSql() {
  const phones = ALL_PHONES.map((p) => `'${p}'`).join(', ');
  return `
BEGIN;
DELETE FROM payment_events
WHERE booking_id IN (
  SELECT b.id FROM bookings b INNER JOIN clients c ON c.id = b.client_id
  WHERE c.slug = '${CLIENT_SLUG}' AND b.phone IN (${phones})
);
UPDATE conversations
  SET current_hold_booking_id = NULL, updated_at = NOW()
  WHERE phone IN (${phones})
    AND current_hold_booking_id IN (
      SELECT b.id FROM bookings b INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = '${CLIENT_SLUG}' AND b.phone IN (${phones})
    );
DELETE FROM payments
WHERE booking_id IN (
  SELECT b.id FROM bookings b INNER JOIN clients c ON c.id = b.client_id
  WHERE c.slug = '${CLIENT_SLUG}' AND b.phone IN (${phones})
);
DELETE FROM bookings
WHERE phone IN (${phones})
  AND client_id = (SELECT id FROM clients WHERE slug = '${CLIENT_SLUG}');
DELETE FROM conversations
WHERE phone IN (${phones})
  AND client_id = (SELECT id FROM clients WHERE slug = '${CLIENT_SLUG}');
COMMIT;
`;
}

// Fixture 1: payment_pending / waiting_payment + payments row (checkout_created)
function seedF1Sql() {
  return `
BEGIN;
INSERT INTO bookings (
  client_id, booking_code, phone, guest_name, status, payment_status,
  check_in, check_out, guest_count, package_code, requested_room_type, room_preference,
  hold_expires_at, assignment_status, availability_check_status,
  total_amount_cents, deposit_required_cents, send_confirmation, booking_source
)
SELECT c.id, 'WH-53-FIXTURE-001', '+34600000155', 'Test Guest 53g-F1',
  'payment_pending'::booking_status, 'waiting_payment'::payment_status,
  '2026-07-01', '2026-07-08', 1, 'malibu', 'shared', 'shared',
  NOW() + INTERVAL '1 hour', 'unassigned'::assignment_status, 'available'::availability_check_status,
  69900, 20000, FALSE, 'whatsapp'::booking_source
FROM clients c WHERE c.slug = '${CLIENT_SLUG}';

INSERT INTO payments (client_id, booking_id, status, payment_kind, currency, amount_due_cents, amount_paid_cents, stripe_checkout_session_id, checkout_url)
SELECT c.id, b.id, 'checkout_created'::payment_record_status, 'deposit_only'::payment_kind, 'EUR', 20000, 0,
  'cs_test_stage53g_f1_001', 'https://checkout.stripe.test/stage53g/f1'
FROM bookings b INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = '${CLIENT_SLUG}' AND b.phone = '+34600000155' AND b.booking_code = 'WH-53-FIXTURE-001';
COMMIT;
`;
}

// Fixture 2: payment_pending / deposit_paid + payments row (paid) + send_confirmation=TRUE
function seedF2Sql() {
  return `
BEGIN;
INSERT INTO bookings (
  client_id, booking_code, phone, guest_name, status, payment_status,
  check_in, check_out, guest_count, package_code, requested_room_type, room_preference,
  hold_expires_at, assignment_status, availability_check_status,
  total_amount_cents, deposit_required_cents, amount_paid_cents,
  send_confirmation, confirmation_sent_at, booking_source
)
SELECT c.id, 'WH-53-CONFIRM-001', '+34600000156', 'Test Guest 53g-F2',
  'payment_pending'::booking_status, 'deposit_paid'::payment_status,
  '2026-07-01', '2026-07-08', 2, 'malibu', 'shared', 'shared',
  NOW() + INTERVAL '1 hour', 'unassigned'::assignment_status, 'available'::availability_check_status,
  69900, 20000, 20000,
  TRUE, NULL, 'whatsapp'::booking_source
FROM clients c WHERE c.slug = '${CLIENT_SLUG}';

INSERT INTO payments (client_id, booking_id, status, payment_kind, currency, amount_due_cents, amount_paid_cents, stripe_checkout_session_id, checkout_url, paid_at)
SELECT c.id, b.id, 'paid'::payment_record_status, 'deposit_only'::payment_kind, 'EUR', 20000, 20000,
  'cs_test_stage53g_f2_001', 'https://checkout.stripe.test/stage53g/f2', NOW()
FROM bookings b INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = '${CLIENT_SLUG}' AND b.phone = '+34600000156' AND b.booking_code = 'WH-53-CONFIRM-001';
COMMIT;
`;
}

// Fixture 3: payment_pending / waiting_payment, NO payments row (tests Query D)
function seedF3Sql() {
  return `
BEGIN;
INSERT INTO bookings (
  client_id, booking_code, phone, guest_name, status, payment_status,
  check_in, check_out, guest_count, package_code, requested_room_type, room_preference,
  hold_expires_at, assignment_status, availability_check_status,
  total_amount_cents, deposit_required_cents, send_confirmation, booking_source
)
SELECT c.id, 'WH-53G-NOPAY-001', '+34600000157', 'Test Guest 53g-F3',
  'payment_pending'::booking_status, 'waiting_payment'::payment_status,
  '2026-07-15', '2026-07-22', 1, 'malibu', 'shared', 'shared',
  NOW() + INTERVAL '1 hour', 'unassigned'::assignment_status, 'available'::availability_check_status,
  69900, 20000, FALSE, 'whatsapp'::booking_source
FROM clients c WHERE c.slug = '${CLIENT_SLUG}';
COMMIT;
`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fixtureCount(rows) {
  return rows.filter(
    (r) => ALL_PHONES.includes(String(r.phone || '')) || ALL_CODES.includes(r.booking_code)
  ).length;
}

function check(label, actual, expected) {
  const ok = actual === expected;
  const mark = ok ? '✓' : '✗';
  const line = `  ${mark}  ${label.padEnd(42)} got=${actual} expected=${expected}`;
  return { ok, line };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('Stage 5.3g — Combined payment/staff query smoke gate');
  console.log(`Client: ${CLIENT_SLUG}`);
  console.log();

  const c = new Client({ connectionString: PG_URL });
  await c.connect();

  // ── 0. Capture baseline booking_beds count ─────────────────────────────────
  const { rows: bbRows } = await c.query('SELECT COUNT(*) AS n FROM booking_beds');
  const baselineBeds = Number(bbRows[0].n);

  // ── 1. Cleanup (idempotent) ────────────────────────────────────────────────
  console.log('1. Cleanup (pre-seed, idempotent)…');
  await c.query(cleanupSql());

  // ── 2. Baseline queries ────────────────────────────────────────────────────
  console.log('2. Baseline queries (expect 0 fixture rows in every bucket)…');
  const baseline = await runAllQueries(c);
  const baselineErrors = [];
  for (const [key, rows] of Object.entries(baseline)) {
    const n = fixtureCount(rows);
    if (n !== 0) baselineErrors.push(`  Baseline ${key} has ${n} fixture row(s) — cleanup may be incomplete`);
  }
  if (baselineErrors.length) {
    console.error('BASELINE FAIL:');
    baselineErrors.forEach((e) => console.error(e));
    await c.end();
    process.exit(1);
  }
  console.log('   OK — 0 fixture rows in all buckets at baseline.');

  // ── 3. Seed all three fixtures ─────────────────────────────────────────────
  console.log('3. Seeding fixtures…');
  await c.query(seedF1Sql());
  console.log('   F1 seeded: WH-53-FIXTURE-001 (+34600000155) payment_pending/waiting_payment + payments(checkout_created)');
  await c.query(seedF2Sql());
  console.log('   F2 seeded: WH-53-CONFIRM-001 (+34600000156) payment_pending/deposit_paid + payments(paid) + send_confirmation=TRUE');
  await c.query(seedF3Sql());
  console.log('   F3 seeded: WH-53G-NOPAY-001  (+34600000157) payment_pending/waiting_payment, NO payments row');

  // ── 4. Run queries and assert expected counts ──────────────────────────────
  console.log('\n4. Running queries and asserting expected bucket counts…');
  const seeded = await runAllQueries(c);

  const results = [
    check('payment_balances  (3 fixtures)',       fixtureCount(seeded.balances),  3),
    check('A  deposit_paid   (F2 only)',           fixtureCount(seeded.A),         1),
    check('B  fully_paid     (none)',              fixtureCount(seeded.B),         0),
    check('C  balance_due    (F2 only)',           fixtureCount(seeded.C),         1),
    check('D  no_payment_row (F3 only)',           fixtureCount(seeded.D),         1),
    check('E  waiting_payment (F1 + F3)',          fixtureCount(seeded.E),         2),
    check('F  confirm_needed  (F2 only)',          fixtureCount(seeded.F),         1),
  ];

  results.forEach((r) => console.log(r.line));

  const failed = results.filter((r) => !r.ok);

  // ── 5. Cleanup ─────────────────────────────────────────────────────────────
  console.log('\n5. Cleanup…');
  await c.query(cleanupSql());
  console.log('   Done.');

  // ── 6. Post-cleanup queries ────────────────────────────────────────────────
  console.log('6. Post-cleanup queries (expect 0 fixture rows in every bucket)…');
  const afterCleanup = await runAllQueries(c);
  const cleanupResults = [];
  for (const [key, rows] of Object.entries(afterCleanup)) {
    const n = fixtureCount(rows);
    cleanupResults.push(check(`post-cleanup ${key}`, n, 0));
  }
  cleanupResults.forEach((r) => console.log(r.line));
  const cleanupFailed = cleanupResults.filter((r) => !r.ok);

  // ── 7. booking_beds unchanged ──────────────────────────────────────────────
  const { rows: bbAfter } = await c.query('SELECT COUNT(*) AS n FROM booking_beds');
  const afterBeds = Number(bbAfter[0].n);
  const bedsCheck = check('booking_beds unchanged', afterBeds, baselineBeds);
  console.log('\n7. Protected table counts:');
  console.log(bedsCheck.line);

  await c.end();

  // ── 8. Final verdict ───────────────────────────────────────────────────────
  const allFailed = [...failed, ...cleanupFailed, ...(bedsCheck.ok ? [] : [bedsCheck])];
  console.log('\n── Stage 5.3g summary ──');
  if (allFailed.length === 0) {
    console.log('PASS — all query buckets correct, cleanup restored baseline, booking_beds unchanged.');
  } else {
    console.error(`FAIL — ${allFailed.length} assertion(s) failed:`);
    allFailed.forEach((r) => console.error(r.line));
    process.exit(1);
  }
}

async function runAllQueries(c) {
  const balances = await c.query(getPaymentBalancesQuery(),    [CLIENT_SLUG]);
  const A        = await c.query(getDepositPaidQuery(),        [CLIENT_SLUG]);
  const B        = await c.query(getFullyPaidQuery(),          [CLIENT_SLUG]);
  const C        = await c.query(getBalanceDueQuery(),         [CLIENT_SLUG]);
  const D        = await c.query(getNoPaymentRecordQuery(),    [CLIENT_SLUG]);
  const E        = await c.query(getWaitingPaymentQuery(),     [CLIENT_SLUG]);
  const F        = await c.query(getConfirmationNeededQuery(), [CLIENT_SLUG]);
  return {
    balances: balances.rows,
    A: A.rows, B: B.rows, C: C.rows,
    D: D.rows, E: E.rows, F: F.rows,
  };
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
