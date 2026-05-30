'use strict';
/**
 * Stage 5.2d — Staff query proof runner.
 * Runs the four staff booking/hold queries and prints results.
 * READ-ONLY. No DB mutations.
 *
 * Usage:
 *   node scripts/verify-stage52d-hold-proof.js
 *
 * Safe to run before or after the fixture booking row exists.
 */

const { withPgClient } = require('./lib/pg-connect');
const {
  CLIENT_SLUG,
  getActiveHoldsQuery,
  getExpiredHoldsQuery,
  getPaymentPendingQuery,
  getNoPaymentRecordQuery,
} = require('./lib/staff-booking-hold-queries');

const FIXTURE_CODE_PREFIX = 'DRY-52-';
const FIXTURE_PHONES = ['34600000152', '+34600000152'];

function printQueryResult(label, rows) {
  console.log(`\n── ${label} ──`);
  console.log(`   Rows: ${rows.length}`);
  const fixtureRows = rows.filter(
    (r) => String(r.booking_code || '').startsWith(FIXTURE_CODE_PREFIX) ||
           FIXTURE_PHONES.includes(String(r.phone || ''))
  );
  if (fixtureRows.length > 0) {
    for (const r of fixtureRows) {
      console.log(`   [FIXTURE] booking_code=${r.booking_code} phone=${r.phone || '?'} check_in=${r.check_in} hold_expires_at=${r.hold_expires_at || 'null'} status=${r.status || r.payment_status || '?'}`);
    }
  } else {
    console.log(`   (no DRY-52-* or fixture-phone rows)`);
  }
}

async function main() {
  console.log('Stage 5.2d — Staff query proof runner (READ-ONLY)');
  console.log(`Client: ${CLIENT_SLUG}`);

  await withPgClient(async (client) => {
    const [activeRows, expiredRows, pendingRows, noPaymentRows] = await Promise.all([
      client.query(getActiveHoldsQuery(), [CLIENT_SLUG]).then((r) => r.rows),
      client.query(getExpiredHoldsQuery(), [CLIENT_SLUG]).then((r) => r.rows),
      client.query(getPaymentPendingQuery(), [CLIENT_SLUG]).then((r) => r.rows),
      client.query(getNoPaymentRecordQuery(), [CLIENT_SLUG]).then((r) => r.rows),
    ]);

    printQueryResult('A — Active holds (status=hold, not expired)', activeRows);
    printQueryResult('B — Expired/stuck holds (status=hold, past expiry)', expiredRows);
    printQueryResult('C — payment_pending (not fully paid)', pendingRows);
    printQueryResult('D — No payment record (hold/payment_pending, no paid payment)', noPaymentRows);

    const fixtureActive = activeRows.filter((r) => String(r.booking_code || '').startsWith(FIXTURE_CODE_PREFIX) || FIXTURE_PHONES.includes(String(r.phone || '')));
    const fixtureNoPayment = noPaymentRows.filter((r) => String(r.booking_code || '').startsWith(FIXTURE_CODE_PREFIX) || FIXTURE_PHONES.includes(String(r.phone || '')));

    console.log('\n── Stage 5.2d proof summary ──');
    console.log(`   Query A fixture rows (expect 1 after gate, 0 before/after cleanup): ${fixtureActive.length}`);
    console.log(`   Query D fixture rows (expect 1 after gate, 0 before/after cleanup): ${fixtureNoPayment.length}`);
    const fixtureExpired = expiredRows.filter((r) => String(r.booking_code || '').startsWith(FIXTURE_CODE_PREFIX) || FIXTURE_PHONES.includes(String(r.phone || '')));
    const fixturePending = pendingRows.filter((r) => String(r.booking_code || '').startsWith(FIXTURE_CODE_PREFIX) || FIXTURE_PHONES.includes(String(r.phone || '')));
    console.log(`   Query B fixture rows (expect 0 unless hold expired): ${fixtureExpired.length}`);
    console.log(`   Query C fixture rows (expect 0 — fixture stays at hold status): ${fixturePending.length}`);
  });
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
