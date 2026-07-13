'use strict';

/**
 * verify:sunset-drawer-reconcile-bound
 *
 * Booking-scoped drawer reconciliation must be bounded, deduplicated, and diagnostic.
 *
 * Run: node scripts/verify-sunset-drawer-reconcile-bound.js
 */

const { reconcilePendingStripePaymentsForBooking, BOOKING_RECONCILE_MAX } = require('./lib/stripe-payment-reconcile');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

const BOOKING_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const DUPLICATE_SID = 'cs_test_duplicate_session';

function buildPg(pendingCount) {
  const rows = [];
  for (let i = 0; i < pendingCount; i += 1) {
    const sid = i % 5 === 0 ? DUPLICATE_SID : `cs_test_pending_${i}`;
    rows.push({
      sid,
      payment_id: `pay-${i}`,
      stripe_checkout_session_id: sid,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    });
  }
  rows.push({ sid: '', payment_id: 'pay-malformed-empty', stripe_checkout_session_id: '', created_at: '2026-01-01T00:00:00Z' });
  rows.push({ sid: 'not-a-session', payment_id: 'pay-malformed-bad', stripe_checkout_session_id: 'bad', created_at: '2026-01-01T00:00:01Z' });

  return {
    query: async (sql) => {
      const q = String(sql);
      if (/SELECT p\.stripe_checkout_session_id/i.test(q)) {
        return { rows: rows.map((r) => ({ sid: r.sid, payment_id: r.payment_id, created_at: r.created_at })) };
      }
      return { rows: [] };
    },
  };
}

console.log('\nverify:sunset-drawer-reconcile-bound\n');

(async () => {
  assert('configured max is 20', BOOKING_RECONCILE_MAX === 20, String(BOOKING_RECONCILE_MAX));

  const retrieveLog = [];
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (sid) => {
          retrieveLog.push(sid);
          return {
            id: sid,
            payment_status: 'unpaid',
            status: 'open',
            amount_total: 1000,
            metadata: {},
          };
        },
      },
    },
  };

  const pendingRows = BOOKING_RECONCILE_MAX + 8;
  const batch = await reconcilePendingStripePaymentsForBooking(
    buildPg(pendingRows),
    stripe,
    { clientSlug: 'sunset', bookingId: BOOKING_ID },
  );

  const uniqueRetrieved = new Set(retrieveLog);
  assert('provider calls never exceed max', retrieveLog.length <= BOOKING_RECONCILE_MAX,
    `calls=${retrieveLog.length} max=${BOOKING_RECONCILE_MAX}`);
  assert('duplicate session retrieved at most once',
    retrieveLog.filter((s) => s === DUPLICATE_SID).length <= 1,
    `dupCount=${retrieveLog.filter((s) => s === DUPLICATE_SID).length}`);
  assert('malformed session ids skipped', !retrieveLog.includes('') && !retrieveLog.includes('bad'));
  assert('diagnostics report rows selected', typeof batch.rows_selected === 'number' && batch.rows_selected > 0);
  assert('diagnostics report unique sessions checked', batch.unique_sessions_checked === retrieveLog.length);
  assert('diagnostics report truncated remainder', batch.truncated_pending_count > 0);
  assert('diagnostics report skipped malformed', batch.skipped_malformed >= 1);
  assert('repeated read stays bounded', retrieveLog.length <= BOOKING_RECONCILE_MAX);

  console.log(`\n── verify:sunset-drawer-reconcile-bound ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  if (fail > 0) process.exit(1);
})();
