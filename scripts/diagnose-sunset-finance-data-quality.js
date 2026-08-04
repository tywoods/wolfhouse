'use strict';

/**
 * Captain read-only diagnostic for Finance data-quality (malformed + balance drift).
 *
 * Soft-fail path: malformed rows zero + sanitized ID logs; material balance
 * drift soft-flags booking_id + recon fields and still returns summary (HTTP 200).
 * FinanceDataQualityError / 503 is reserved for unrecoverable overflow/structure.
 *
 * Live incident class (authoritative): booking c713c1d7-7f11-4087-bb95-f78c0eaec65e
 * total=3500 balance_due=2000 no matching captured payment → expected 3500, delta 1500.
 * BADINT=[]; not restore-cancelled. Owner chooses balance 3500 if unpaid OR capture
 * missing 1500 payment if paid — do not repair from this script.
 *
 * Usage (read-only — never mutates DB):
 *   node scripts/diagnose-sunset-finance-data-quality.js
 *   node scripts/diagnose-sunset-finance-data-quality.js --client=sunset --location=sunset-somo
 *
 * Env: DATABASE_URL or STAFF_DATABASE_URL (same as staff-query-api).
 * If no DB is reachable, prints exact SQL Captain can run manually.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');

const clientSlug = (process.argv.find((a) => a.startsWith('--client=')) || '--client=sunset').split('=')[1];
const locationId = (process.argv.find((a) => a.startsWith('--location=')) || '--location=sunset-somo').split('=')[1];

const {
  parseCanonicalIntCents,
  sanitizeFinanceOffendingRecord,
  createFinanceDiagnostics,
  withFinanceDiagnostics,
  toIntSoft,
  effectiveServiceDueCents,
  reconcileBookingBalances,
  computeSunsetFinanceSummary,
} = require(path.join(ROOT, 'scripts', 'lib', 'sunset-finance-summary.js'));

const MANUAL_SQL = `
-- Read-only Captain diagnostic SQL (run against staging/prod as operator).
-- Replace $1=client_slug, $2=location_id.

-- 1) Bookings with non-integer / null totals or balances among finance-scoped set
SELECT b.id::text AS booking_id,
       b.booking_code,
       b.total_amount_cents,
       b.balance_due_cents,
       b.status::text
  FROM bookings b
  JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1
   AND b.metadata->>'location_id' = $2
   AND b.status::text NOT IN ('cancelled', 'canceled', 'expired', 'hold')
   AND (
     b.total_amount_cents IS NULL
     OR b.balance_due_cents IS NULL
     -- Postgres: flag values that would fail JS canonical integer parse when cast
     OR b.total_amount_cents <> trunc(b.total_amount_cents)
     OR b.balance_due_cents <> trunc(b.balance_due_cents)
   )
 ORDER BY b.created_at DESC
 LIMIT 200;

-- 2) Payments with bad amount_paid_cents
SELECT p.id::text AS payment_id,
       p.booking_id::text AS booking_id,
       p.amount_paid_cents,
       p.status::text,
       p.paid_at
  FROM payments p
  JOIN bookings b ON b.id = p.booking_id AND p.client_id = b.client_id
  JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1
   AND b.metadata->>'location_id' = $2
   AND p.status = 'paid'
   AND p.paid_at IS NOT NULL
   AND p.finance_exclusion IS NULL
   AND (
     p.amount_paid_cents IS NULL
     OR p.amount_paid_cents <> trunc(p.amount_paid_cents)
   )
 LIMIT 200;

-- 3) Refund records with bad amount_cents
SELECT r.id::text AS refund_id,
       r.booking_id::text AS booking_id,
       r.amount_cents,
       r.effective_date
  FROM booking_refund_records r
  JOIN clients c ON c.id = r.client_id
 WHERE c.slug = $1
   AND r.location_id = $2
   AND r.source = 'staff_manual_record'
   AND (
     r.amount_cents IS NULL
     OR r.amount_cents <> trunc(r.amount_cents)
   )
 LIMIT 200;

-- 4) BSR amount_due_cents / custom metadata.amount_cents issues
SELECT bsr.id::text AS service_record_id,
       bsr.booking_id::text AS booking_id,
       bsr.amount_due_cents,
       bsr.metadata->>'amount_cents' AS meta_amount_cents,
       bsr.metadata->>'source' AS meta_source
  FROM booking_service_records bsr
  JOIN bookings b ON b.id = bsr.booking_id
  JOIN clients c ON c.id = b.client_id
 WHERE bsr.client_slug = c.slug
   AND c.slug = $1
   AND b.metadata->>'location_id' = $2
   AND bsr.status <> 'cancelled'
   AND bsr.service_date IS NOT NULL
   AND (
     bsr.amount_due_cents IS NULL
     OR bsr.amount_due_cents <> trunc(bsr.amount_due_cents)
   )
 LIMIT 200;

-- 5) Material balance drift (authoritative total − paid vs balance_due)
--    Soft-fail path: Finance still returns 200; check server logs for
--    [finance.data_quality] material_balance_drift and data_quality.balance_drift.
--    Known live class example: total=3500 balance_due=2000 no payment → delta 1500.
--    Owner money decision required — do not auto-repair.
`;

function printManual() {
  console.log('=== READ-ONLY Captain finance data-quality diagnostic ===');
  console.log(`scope: client=${clientSlug} location=${locationId}`);
  console.log('');
  console.log(MANUAL_SQL);
  console.log('');
  console.log('Owner / Captain guidance (this script never mutates):');
  console.log('  1) Malformed null/non-integer rows: soft-zero + [finance.data_quality] ID logs.');
  console.log('  2) Material balance drift: soft-flag booking_id + recon fields; Finance stays up.');
  console.log('  3) For drifted bookings: owner chooses — set balance_due = expected owed if unpaid,');
  console.log('     OR capture the missing payment if it was paid. Do not guess live money truth.');
  console.log('  4) After owner decision, Captain revalidates with this script / finance summary.');
  console.log('  5) 503 FINANCE_DATA_QUALITY = unrecoverable overflow/structure only (not soft drift).');
}

async function tryLive() {
  const url = process.env.DATABASE_URL || process.env.STAFF_DATABASE_URL || process.env.PG_CONNECTION_STRING;
  if (!url) {
    console.log('No DATABASE_URL — printing manual SQL only.\n');
    printManual();
    return 0;
  }
  let pg;
  try {
    // Optional live path; never mutate.
    // eslint-disable-next-line import/no-extraneous-dependencies
    const { Client } = require('pg');
    pg = new Client({ connectionString: url, statement_timeout: 30000 });
    await pg.connect();
    await pg.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { fetchSunsetFinanceData } = require(path.join(ROOT, 'scripts', 'lib', 'sunset-finance-data.js'));
    const data = await fetchSunsetFinanceData(pg, { clientSlug, locationId });
    await pg.query('COMMIT');
    console.log('fetch ok');
    console.log('data_quality:', JSON.stringify(data.data_quality || {}, null, 2));
    const summary = computeSunsetFinanceSummary({
      now: new Date(),
      timeZone: 'Europe/Madrid',
      ...data,
    });
    console.log('summary data_quality:', JSON.stringify(summary.data_quality || {}, null, 2));
    console.log('periods.today.booked_cents:', summary.periods.today.booked_cents);
    console.log('Live diagnose complete — no writes performed.');
    return 0;
  } catch (err) {
    try { if (pg) await pg.query('ROLLBACK'); } catch (_e) { /* ignore */ }
    console.error('Live diagnose failed (read-only):', err && err.code, err && err.message);
    console.log('\nFalling back to manual SQL:\n');
    printManual();
    return 1;
  } finally {
    try { if (pg) await pg.end(); } catch (_e) { /* ignore */ }
  }
}

if (require.main === module) {
  tryLive().then((code) => process.exit(code || 0));
}

module.exports = {
  MANUAL_SQL,
  parseCanonicalIntCents,
  sanitizeFinanceOffendingRecord,
  createFinanceDiagnostics,
  withFinanceDiagnostics,
  toIntSoft,
  effectiveServiceDueCents,
  reconcileBookingBalances,
};
