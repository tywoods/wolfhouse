'use strict';

const { effectiveServiceDueCents, reconcileBookingBalances, FinanceDataQualityError } = require('./sunset-finance-summary');

// Finance excludes transient/terminal non-operational bookings from BSR/booked views.
// Gross paid cash intentionally includes cancelled-booking payments until recorded refunds
// reduce Net (Slice 2 ledger). Deleted schedule bookings set payments.finance_exclusion.
const BOOKING_EXCLUSIONS = "('cancelled', 'canceled', 'expired', 'hold')";

const BSR_SQL = `
  SELECT bsr.booking_id, bsr.service_date::text AS service_date,
         bsr.service_type::text AS service_type,
         bsr.quantity,
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
     AND p.finance_exclusion IS NULL
     AND COALESCE((p.metadata->>'schedule_booking_deleted')::boolean, false) = false
`;

/**
 * Slice 2 — recorded refunds from migration 056 booking_refund_records.
 * Scope: ledger columns only (c.slug + r.location_id). Never booking metadata.
 * Recorded state = row exists (no status column); source CHECK is staff_manual_record.
 * Date bucketing is pure-math on effective_date (fetch all for location, multi-range).
 */
const REFUNDS_SQL = `
  SELECT r.booking_id::text AS booking_id,
         r.amount_cents,
         r.effective_date::text AS effective_date,
         r.location_id,
         r.source
    FROM booking_refund_records r
    JOIN clients c ON c.id = r.client_id
   WHERE c.slug = $1
     AND r.location_id = $2
     AND r.source = 'staff_manual_record'
`;

const RENTAL_STOCK_SQL = `
  SELECT offering_key, group_key, label, stock_quantity, active
    FROM tenant_rental_offerings
   WHERE client_slug = $1
     AND active = true
     AND (location_id = $2 OR location_id IS NULL OR location_id = '')
`;

const SURF_PACKS_SQL = `
  SELECT id::text AS pack_id, label, config_json
    FROM tenant_surf_pack_rules
   WHERE client_slug = $1
     AND active = true
     AND (location_id = $2 OR location_id IS NULL OR location_id = '')
`;

function rows(result) { return result && Array.isArray(result.rows) ? result.rows : []; }

function integerCents(value) {
  return effectiveServiceDueCents({ amount_due_cents: value, metadata: {} });
}

function mapBsr(r) {
  return {
    booking_id: r.booking_id,
    service_date: r.service_date,
    service_type: r.service_type != null ? String(r.service_type) : null,
    quantity: r.quantity != null ? Number(r.quantity) : 1,
    amount_due_cents: r.amount_due_cents,
    metadata: r.metadata || {},
  };
}

function mapStock(r) {
  let stock = null;
  if (r.stock_quantity !== undefined && r.stock_quantity !== null) {
    const n = Number(r.stock_quantity);
    stock = Number.isInteger(n) ? n : null;
  }
  return {
    offering_key: String(r.offering_key || ''),
    group_key: String(r.group_key || ''),
    label: String(r.label || ''),
    stock_quantity: stock,
    active: r.active !== false,
  };
}

function mapPack(r) {
  let cfg = r.config_json;
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg); } catch (_e) { cfg = {}; }
  }
  if (!cfg || typeof cfg !== 'object') cfg = {};
  const gs = cfg.group_size != null ? Number(cfg.group_size) : null;
  return {
    pack_id: String(r.pack_id || r.id || ''),
    label: String(r.label || ''),
    group_size: Number.isFinite(gs) && gs > 0 ? gs : null,
    config: cfg,
  };
}

function mapRefund(r) {
  return {
    booking_id: r.booking_id != null ? String(r.booking_id) : null,
    amount_cents: r.amount_cents,
    effective_date: r.effective_date != null ? String(r.effective_date).slice(0, 10) : null,
    location_id: r.location_id != null ? String(r.location_id) : null,
    source: r.source != null ? String(r.source) : null,
  };
}

function isMissingRelationError(err) {
  if (!err) return false;
  if (err.code === '42P01') return true;
  const msg = String(err.message || '');
  return /booking_refund_records/i.test(msg) && /does not exist|undefined_table/i.test(msg);
}

async function fetchSunsetFinanceData(pg, scope) {
  const clientSlug = String((scope && scope.clientSlug) || '').trim();
  const locationId = String((scope && scope.locationId) || '').trim();
  const params = [clientSlug, locationId];
  await pg.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let bsrRes; let bookingsRes; let paymentsRes;
  let refundsRes; let stockRes; let packsRes;
  let refundLedgerUnavailable = false;
  try {
    bsrRes = await pg.query(BSR_SQL, params);
    bookingsRes = await pg.query(BOOKINGS_SQL, params);
    paymentsRes = await pg.query(PAYMENTS_SQL, params);
    try {
      // SAVEPOINT so 42P01 does not abort the outer REPEATABLE READ txn (PG marks
      // the whole transaction aborted after any error without a savepoint).
      await pg.query('SAVEPOINT finance_refunds_sp');
      try {
        refundsRes = await pg.query(REFUNDS_SQL, params);
        await pg.query('RELEASE SAVEPOINT finance_refunds_sp');
      } catch (err) {
        if (isMissingRelationError(err)) {
          try { await pg.query('ROLLBACK TO SAVEPOINT finance_refunds_sp'); } catch (_rb) { /* best effort */ }
          try { await pg.query('RELEASE SAVEPOINT finance_refunds_sp'); } catch (_rel) { /* already rolled back */ }
          refundsRes = { rows: [] };
          refundLedgerUnavailable = true;
        } else {
          try { await pg.query('ROLLBACK TO SAVEPOINT finance_refunds_sp'); } catch (_rb) { /* best effort */ }
          throw err;
        }
      }
    } catch (err) {
      throw err;
    }
    try {
      stockRes = await pg.query(RENTAL_STOCK_SQL, params);
    } catch (_e) {
      stockRes = { rows: [] }; // table/column may be absent on older DBs
    }
    try {
      packsRes = await pg.query(SURF_PACKS_SQL, params);
    } catch (_e) {
      packsRes = { rows: [] };
    }

    const bsr = rows(bsrRes).map(mapBsr);
    const bookings = rows(bookingsRes).map((r) => ({
      booking_id: r.booking_id,
      total_amount_cents: r.total_amount_cents,
      balance_due_cents: r.balance_due_cents,
    }));
    const payments = rows(paymentsRes).map((r) => ({
      booking_id: r.booking_id,
      amount_paid_cents: r.amount_paid_cents,
      paid_at: r.paid_at,
    }));
    const refund_records = rows(refundsRes).map(mapRefund);
    const rental_stock = rows(stockRes).map(mapStock);
    const surf_packs = rows(packsRes).map(mapPack);

    try {
      for (const row of bsr) effectiveServiceDueCents(row);
      for (const payment of payments) integerCents(payment.amount_paid_cents);
      for (const refund of refund_records) integerCents(refund.amount_cents);
      for (const booking of bookings) {
        if (booking.total_amount_cents != null) integerCents(booking.total_amount_cents);
        if (booking.balance_due_cents != null) integerCents(booking.balance_due_cents);
      }
      if (reconcileBookingBalances({ bookings, bsr, payments }).material) throw new FinanceDataQualityError();
    } catch (err) {
      throw err instanceof FinanceDataQualityError ? err : new FinanceDataQualityError();
    }
    await pg.query('COMMIT');
    return {
      bsr,
      bookings,
      payments,
      // Slice 2: empty pending proxy (retired from Net math/hero). Keep key for old callers.
      pending_refund_payments: [],
      refund_records,
      refund_ledger_unavailable: refundLedgerUnavailable,
      rental_stock,
      surf_packs,
    };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* preserve original */ }
    throw err;
  }
}

module.exports = {
  BSR_SQL,
  BOOKINGS_SQL,
  PAYMENTS_SQL,
  REFUNDS_SQL,
  RENTAL_STOCK_SQL,
  SURF_PACKS_SQL,
  fetchSunsetFinanceData,
  FinanceDataQualityError,
  // Deprecated export kept so any stale require of PENDING_REFUND_SQL does not crash
  // at module load; Slice 2 no longer queries it.
  PENDING_REFUND_SQL: null,
};
