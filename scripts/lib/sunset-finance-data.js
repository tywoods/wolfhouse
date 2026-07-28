'use strict';

/**
 * Sunset Admin Finance data layer — read-only, parameterized SQL that returns the
 * correctly-scoped rows for the pure summary math (scripts/lib/sunset-finance-summary.js).
 *
 * Scope is fixed by the caller ($1 = client slug 'sunset', $2 = location id
 * 'sunset-somo'); this module never interpolates identifiers. Skipper-audited
 * source contract (Stage 3 V1):
 *
 *  - Booked / Outstanding / count feed (BSR + bookings): exclude cancelled BSR,
 *    cancelled bookings, demo_fixture_stage888, and undated rows; scope location
 *    via bookings.metadata->>'location_id'.
 *  - Collected (gross) feed (payments): status='paid', paid_at NOT NULL, scoped by
 *    clients.slug + booking location, excluding synthetic test_booking_cancelled
 *    rows. Deliberately NOT filtered by booking status — cancelled-booking cash
 *    stays gross-collected until a refund ledger exists.
 */

// $1 = client_slug ('sunset'), $2 = location_id ('sunset-somo')
const BSR_SQL = `
  SELECT bsr.booking_id,
         bsr.service_date::text AS service_date,
         bsr.amount_due_cents,
         bsr.metadata
    FROM booking_service_records bsr
    JOIN bookings b ON b.id = bsr.booking_id
   WHERE bsr.client_slug = $1
     AND bsr.status <> 'cancelled'
     AND bsr.source <> 'demo_fixture_stage888'
     AND bsr.service_date IS NOT NULL
     AND b.status <> 'cancelled'
     AND b.metadata->>'location_id' = $2
`;

// Distinct qualifying bookings (≥1 dated, non-cancelled, non-demo BSR row) + authoritative total.
const BOOKINGS_SQL = `
  SELECT DISTINCT b.id AS booking_id,
         b.total_amount_cents
    FROM bookings b
    JOIN booking_service_records bsr ON bsr.booking_id = b.id
   WHERE bsr.client_slug = $1
     AND bsr.status <> 'cancelled'
     AND bsr.source <> 'demo_fixture_stage888'
     AND bsr.service_date IS NOT NULL
     AND b.status <> 'cancelled'
     AND b.metadata->>'location_id' = $2
`;

// Collected (gross): scoped paid payments. No booking-status filter by design.
const PAYMENTS_SQL = `
  SELECT p.booking_id,
         p.amount_paid_cents,
         p.paid_at
    FROM payments p
    JOIN bookings b ON b.id = p.booking_id
    JOIN clients c ON c.id = p.client_id
   WHERE c.slug = $1
     AND b.metadata->>'location_id' = $2
     AND p.status = 'paid'
     AND p.paid_at IS NOT NULL
     AND COALESCE((p.metadata->>'test_booking_cancelled')::boolean, false) = false
`;

function rows(result) {
  return (result && Array.isArray(result.rows)) ? result.rows : [];
}

/**
 * Fetch the three scoped row sets for the finance summary.
 * @param {{ query: Function }} pg  query-capable client (injected; module opens no pools)
 * @param {{ clientSlug: string, locationId: string }} scope
 * @returns {Promise<{ bsr: object[], payments: object[], bookings: object[] }>}
 */
async function fetchSunsetFinanceData(pg, scope) {
  const clientSlug = String((scope && scope.clientSlug) || '').trim();
  const locationId = String((scope && scope.locationId) || '').trim();
  const params = [clientSlug, locationId];

  const [bsrRes, bookingsRes, paymentsRes] = await Promise.all([
    pg.query(BSR_SQL, params),
    pg.query(BOOKINGS_SQL, params),
    pg.query(PAYMENTS_SQL, params),
  ]);

  return {
    bsr: rows(bsrRes).map((r) => ({
      booking_id: r.booking_id,
      service_date: r.service_date,
      amount_due_cents: r.amount_due_cents,
      metadata: r.metadata || {},
    })),
    bookings: rows(bookingsRes).map((r) => ({
      booking_id: r.booking_id,
      total_amount_cents: r.total_amount_cents,
    })),
    payments: rows(paymentsRes).map((r) => ({
      booking_id: r.booking_id,
      amount_paid_cents: r.amount_paid_cents,
      paid_at: r.paid_at,
    })),
  };
}

module.exports = {
  BSR_SQL,
  BOOKINGS_SQL,
  PAYMENTS_SQL,
  fetchSunsetFinanceData,
};
