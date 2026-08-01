'use strict';

const { effectiveServiceDueCents, reconcileBookingBalances, FinanceDataQualityError } = require('./sunset-finance-summary');

// Finance excludes transient/terminal non-operational bookings. Gross paid cash is
// intentionally independent of booking status until an authoritative refund ledger exists.
// Deleted cancelled schedule bookings set payments.finance_exclusion and are excluded from Collected.
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

/** Paid cash still on cancelled bookings — Slice 1 "Pending refund" proxy (owner decision). */
const PENDING_REFUND_SQL = `
  SELECT p.booking_id, p.amount_paid_cents, p.paid_at
    FROM payments p
    JOIN bookings b ON b.id = p.booking_id AND p.client_id = b.client_id
    JOIN clients c ON b.client_id = c.id
   WHERE c.slug = $1
     AND b.metadata->>'location_id' = $2
     AND p.status = 'paid'
     AND p.paid_at IS NOT NULL
     AND b.status::text IN ('cancelled', 'canceled')
     AND COALESCE((p.metadata->>'test_booking_cancelled')::boolean, false) = false
     AND p.finance_exclusion IS NULL
     AND COALESCE((p.metadata->>'schedule_booking_deleted')::boolean, false) = false
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

async function fetchSunsetFinanceData(pg, scope) {
  const clientSlug = String((scope && scope.clientSlug) || '').trim();
  const locationId = String((scope && scope.locationId) || '').trim();
  const params = [clientSlug, locationId];
  await pg.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let bsrRes; let bookingsRes; let paymentsRes;
  let pendingRes; let stockRes; let packsRes;
  try {
    bsrRes = await pg.query(BSR_SQL, params);
    bookingsRes = await pg.query(BOOKINGS_SQL, params);
    paymentsRes = await pg.query(PAYMENTS_SQL, params);
    try {
      pendingRes = await pg.query(PENDING_REFUND_SQL, params);
    } catch (_e) {
      pendingRes = { rows: [] };
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
    const pending_refund_payments = rows(pendingRes).map((r) => ({
      booking_id: r.booking_id,
      amount_paid_cents: r.amount_paid_cents,
      paid_at: r.paid_at,
    }));
    const rental_stock = rows(stockRes).map(mapStock);
    const surf_packs = rows(packsRes).map(mapPack);

    try {
      for (const row of bsr) effectiveServiceDueCents(row);
      for (const payment of payments) integerCents(payment.amount_paid_cents);
      for (const payment of pending_refund_payments) integerCents(payment.amount_paid_cents);
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
      pending_refund_payments,
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
  PENDING_REFUND_SQL,
  RENTAL_STOCK_SQL,
  SURF_PACKS_SQL,
  fetchSunsetFinanceData,
  FinanceDataQualityError,
};
