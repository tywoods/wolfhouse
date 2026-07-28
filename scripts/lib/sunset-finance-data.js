'use strict';

// Finance excludes transient/terminal non-operational bookings. Gross paid cash is
// intentionally independent of booking status until an authoritative refund ledger exists.
const BOOKING_EXCLUSIONS = "('cancelled', 'canceled', 'expired', 'hold')";

const BSR_SQL = `
  SELECT bsr.booking_id, bsr.service_date::text AS service_date,
         bsr.amount_due_cents, bsr.metadata
    FROM booking_service_records bsr
    JOIN bookings b ON b.id = bsr.booking_id
    JOIN clients c ON b.client_id = c.id
   WHERE bsr.client_slug = c.slug
     AND c.slug = $1
     AND bsr.status <> 'cancelled'
     AND bsr.source <> 'demo_fixture_stage888'
     AND bsr.service_date IS NOT NULL
     AND b.status::text NOT IN ${BOOKING_EXCLUSIONS}
     AND b.metadata->>'location_id' = $2
`;

const BOOKINGS_SQL = `
  SELECT DISTINCT b.id AS booking_id, b.total_amount_cents, b.balance_due_cents
    FROM bookings b
    JOIN booking_service_records bsr ON bsr.booking_id = b.id
    JOIN clients c ON b.client_id = c.id
   WHERE bsr.client_slug = c.slug
     AND c.slug = $1
     AND bsr.status <> 'cancelled'
     AND bsr.source <> 'demo_fixture_stage888'
     AND bsr.service_date IS NOT NULL
     AND b.status::text NOT IN ${BOOKING_EXCLUSIONS}
     AND b.metadata->>'location_id' = $2
`;

const PAYMENTS_SQL = `
  SELECT p.booking_id, p.amount_paid_cents, p.paid_at
    FROM payments p
    JOIN bookings b ON b.id = p.booking_id AND p.client_id = b.client_id
    JOIN clients c ON b.client_id = c.id
   WHERE c.slug = $1
     AND b.metadata->>'location_id' = $2
     AND p.status = 'paid'
     AND p.paid_at IS NOT NULL
     AND COALESCE((p.metadata->>'test_booking_cancelled')::boolean, false) = false
`;

function rows(result) { return result && Array.isArray(result.rows) ? result.rows : []; }

class FinanceDataQualityError extends Error {
  constructor() {
    super('finance data quality check failed');
    this.name = 'FinanceDataQualityError';
    this.code = 'FINANCE_DATA_QUALITY';
  }
  toJSON() { return { name: this.name, code: this.code }; }
}
function integerCents(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new FinanceDataQualityError();
  return n;
}

async function fetchSunsetFinanceData(pg, scope) {
  const clientSlug = String((scope && scope.clientSlug) || '').trim();
  const locationId = String((scope && scope.locationId) || '').trim();
  const params = [clientSlug, locationId];
  await pg.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let bsrRes; let bookingsRes; let paymentsRes;
  try {
    bsrRes = await pg.query(BSR_SQL, params);
    bookingsRes = await pg.query(BOOKINGS_SQL, params);
    paymentsRes = await pg.query(PAYMENTS_SQL, params);
    const paid = new Map();
    for (const p of rows(paymentsRes)) paid.set(p.booking_id, (paid.get(p.booking_id) || 0) + integerCents(p.amount_paid_cents));
    for (const b of rows(bookingsRes)) {
      if (b.balance_due_cents == null) throw new FinanceDataQualityError();
      const expected = Math.max(0, integerCents(b.total_amount_cents) - (paid.get(b.booking_id) || 0));
      if (expected !== integerCents(b.balance_due_cents)) throw new FinanceDataQualityError();
    }
    await pg.query('COMMIT');
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* preserve original */ }
    throw err;
  }
  return {
    bsr: rows(bsrRes).map((r) => ({ booking_id:r.booking_id, service_date:r.service_date, amount_due_cents:r.amount_due_cents, metadata:r.metadata || {} })),
    bookings: rows(bookingsRes).map((r) => ({ booking_id:r.booking_id, total_amount_cents:r.total_amount_cents, balance_due_cents:r.balance_due_cents })),
    payments: rows(paymentsRes).map((r) => ({ booking_id:r.booking_id, amount_paid_cents:r.amount_paid_cents, paid_at:r.paid_at })),
  };
}

module.exports = { BSR_SQL, BOOKINGS_SQL, PAYMENTS_SQL, fetchSunsetFinanceData, FinanceDataQualityError };
