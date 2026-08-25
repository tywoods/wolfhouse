'use strict';

const {
  effectiveServiceDueCents,
  reconcileBookingBalances,
  FinanceDataQualityError,
  createFinanceDiagnostics,
  parseCanonicalIntCents,
  reportMalformedMonetary,
  withFinanceDiagnostics,
  toIntSoft,
} = require('./sunset-finance-summary');

// Finance excludes transient/terminal non-operational bookings from BSR/booked views.
// Gross paid cash intentionally includes cancelled-booking payments until recorded refunds
// reduce Net (Slice 2 ledger). Deleted schedule bookings set payments.finance_exclusion.
const BOOKING_EXCLUSIONS = "('cancelled', 'canceled', 'expired', 'hold')";

const BSR_SQL = `
  SELECT bsr.id::text AS service_record_id,
         bsr.booking_id, bsr.service_date::text AS service_date,
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
  SELECT p.id::text AS payment_id, p.booking_id, p.amount_paid_cents, p.paid_at
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
  SELECT r.id::text AS refund_id,
         r.booking_id::text AS booking_id,
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

function mapBsr(r) {
  return {
    service_record_id: r.service_record_id != null ? String(r.service_record_id) : null,
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
    refund_id: r.refund_id != null ? String(r.refund_id) : null,
    booking_id: r.booking_id != null ? String(r.booking_id) : null,
    amount_cents: r.amount_cents,
    effective_date: r.effective_date != null ? String(r.effective_date).slice(0, 10) : null,
    location_id: r.location_id != null ? String(r.location_id) : null,
    source: r.source != null ? String(r.source) : null,
  };
}

/**
 * Soft-scan monetary rows at fetch time. Malformed amounts stay on the row
 * (summary soft-zeros them) and emit sanitized ID diagnostics. Never throws
 * for per-row malformations. Material balance drift is also soft-flagged by
 * the caller (structured log + data_quality) — never aborts the whole tab.
 * FinanceDataQualityError is reserved for unrecoverable overflow/structure.
 */
function softScanFinanceRows({ bsr, bookings, payments, refund_records }, diagnostics) {
  return withFinanceDiagnostics(diagnostics || createFinanceDiagnostics(), (diag) => {
    for (const row of bsr || []) {
      // Touch soft path so logs fire with service_record_id when present.
      effectiveServiceDueCents(row);
    }
    for (const payment of payments || []) {
      toIntSoft(payment.amount_paid_cents, {
        source: 'payment.amount_paid_cents',
        booking_id: payment.booking_id,
        payment_id: payment.payment_id || null,
      });
    }
    for (const refund of refund_records || []) {
      toIntSoft(refund.amount_cents, {
        source: 'refund.amount_cents',
        booking_id: refund.booking_id,
        refund_id: refund.refund_id || null,
      });
    }
    for (const booking of bookings || []) {
      if (booking.total_amount_cents != null) {
        toIntSoft(booking.total_amount_cents, {
          source: 'booking.total_amount_cents',
          booking_id: booking.booking_id,
        });
      }
      if (booking.balance_due_cents != null) {
        const p = parseCanonicalIntCents(booking.balance_due_cents);
        if (!p.ok) {
          reportMalformedMonetary({
            source: 'booking.balance_due_cents',
            booking_id: booking.booking_id,
            reason: p.reason,
          });
        }
      }
    }
    return diag;
  });
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
      payment_id: r.payment_id != null ? String(r.payment_id) : null,
      booking_id: r.booking_id,
      amount_paid_cents: r.amount_paid_cents,
      paid_at: r.paid_at,
    }));
    const refund_records = rows(refundsRes).map(mapRefund);
    const rental_stock = rows(stockRes).map(mapStock);
    const surf_packs = rows(packsRes).map(mapPack);

    // Soft-scan: one malformed row or one stale balance_due must not abort Finance.
    // Keep FinanceDataQualityError only for genuine unrecoverable invariants
    // (unsafe overflow during checked math elsewhere). Material drift → flag + continue.
    const diagnostics = createFinanceDiagnostics();
    softScanFinanceRows({ bsr, bookings, payments, refund_records }, diagnostics);
    // Reconcile only — soft malformed already logged; do not re-soft-parse here.
    // Skip rows with malformed money so we do not invent drift from soft zeros.
    // Track bookings whose BSR was incomplete so legacy null-total recon can skip
    // (never invent material_balance_drift from partial BSR sums).
    const incompleteBsrBookingIds = new Set();
    const cleanPayments = payments.filter((p) => parseCanonicalIntCents(p.amount_paid_cents).ok);
    const cleanBookings = bookings.filter((b) => {
      if (b.total_amount_cents != null && !parseCanonicalIntCents(b.total_amount_cents).ok) return false;
      if (b.balance_due_cents != null && !parseCanonicalIntCents(b.balance_due_cents).ok) return false;
      // Skip bookings whose payments had malformed amounts (already in diagnostics).
      const badPay = payments.some((p) => String(p.booking_id) === String(b.booking_id)
        && !parseCanonicalIntCents(p.amount_paid_cents).ok);
      return !badPay;
    });
    const cleanBsr = bsr.filter((row) => {
      const md = row.metadata || {};
      const isCustom = md.source === 'staff_custom_line'
        || md.staff_custom_line === true
        || md.component === 'staff_custom_line';
      const raw = isCustom && md.amount_cents != null ? md.amount_cents : row.amount_due_cents;
      const ok = parseCanonicalIntCents(raw).ok;
      if (!ok && row.booking_id != null) incompleteBsrBookingIds.add(String(row.booking_id));
      return ok;
    });
    // Soft-fail path: log + flag material drifts; never throw (summary still returns).
    // Overflow inside reconcile (checkedAdd/Subtract) remains the only hard path.
    let reconcileResult;
    try {
      reconcileResult = reconcileBookingBalances({
        bookings: cleanBookings,
        bsr: cleanBsr,
        payments: cleanPayments,
        diagnostics,
        report: true,
        // When cleanBsr dropped rows, recon cannot re-detect them — pass the set.
        incompleteBsrBookingIds,
      });
    } catch (err) {
      // Only genuine unrecoverable structure/overflow escapes as typed quality error.
      throw err instanceof FinanceDataQualityError ? err : new FinanceDataQualityError();
    }
    await pg.query('COMMIT');
    const reconUnavailable = (reconcileResult && Array.isArray(reconcileResult.reconciliation_unavailable))
      ? reconcileResult.reconciliation_unavailable.slice()
      : (diagnostics.reconciliation_unavailable || []).slice();
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
      // Soft-fail diagnostics for Captain (malformed: IDs only; drift: booking_id + recon cents).
      data_quality: {
        malformed_count: diagnostics.malformed.length,
        malformed: diagnostics.malformed.slice(),
        balance_drift_count: diagnostics.balance_drift.length,
        balance_drift: diagnostics.balance_drift.slice(),
        flagged_booking_ids: (reconcileResult && reconcileResult.flagged_booking_ids)
          ? reconcileResult.flagged_booking_ids.slice()
          : [],
        reconciliation_unavailable: reconUnavailable,
        reconciliation_unavailable_count: reconUnavailable.length,
      },
    };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* preserve original */ }
    throw err;
  }
}

const LODGING_BOOKINGS_SQL = `
  SELECT b.id AS booking_id,
         b.total_amount_cents,
         b.balance_due_cents,
         b.check_in::text AS check_in,
         b.created_at
    FROM bookings b
    JOIN clients c ON b.client_id = c.id
   WHERE c.slug = $1
     AND b.status::text NOT IN ${BOOKING_EXCLUSIONS}
`;

const LODGING_BSR_SQL = `
  SELECT b.id::text AS service_record_id,
         b.id AS booking_id,
         COALESCE(b.check_in::text, to_char(b.created_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD')) AS service_date,
         'accommodation'::text AS service_type,
         1 AS quantity,
         b.total_amount_cents AS amount_due_cents,
         '{}'::jsonb AS metadata
    FROM bookings b
    JOIN clients c ON b.client_id = c.id
   WHERE c.slug = $1
     AND b.status::text NOT IN ${BOOKING_EXCLUSIONS}
     AND (b.check_in IS NOT NULL OR b.created_at IS NOT NULL)
`;

const LODGING_PAYMENTS_SQL = `
  SELECT p.id::text AS payment_id, p.booking_id, p.amount_paid_cents, p.paid_at
    FROM payments p
    JOIN bookings b ON b.id = p.booking_id AND p.client_id = b.client_id
    JOIN clients c ON b.client_id = c.id
   WHERE c.slug = $1
     AND p.status = 'paid'
     AND p.paid_at IS NOT NULL
     AND COALESCE((p.metadata->>'test_booking_cancelled')::boolean, false) = false
`;

const LODGING_REFUNDS_SQL = `
  SELECT r.id::text AS refund_id,
         r.booking_id::text AS booking_id,
         r.amount_cents,
         r.effective_date::text AS effective_date,
         r.location_id,
         r.source
    FROM booking_refund_records r
    JOIN clients c ON c.id = r.client_id
   WHERE c.slug = $1
     AND r.source = 'staff_manual_record'
`;

async function fetchLodgingFinanceData(pg, scope) {
  const clientSlug = String((scope && scope.clientSlug) || '').trim();
  const params = [clientSlug];
  await pg.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let bsrRes; let bookingsRes; let paymentsRes; let refundsRes;
  let refundLedgerUnavailable = false;
  try {
    bsrRes = await pg.query(LODGING_BSR_SQL, params);
    bookingsRes = await pg.query(LODGING_BOOKINGS_SQL, params);
    paymentsRes = await pg.query(LODGING_PAYMENTS_SQL, params);
    try {
      await pg.query('SAVEPOINT finance_refunds_sp');
      try {
        refundsRes = await pg.query(LODGING_REFUNDS_SQL, params);
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

    const bsr = rows(bsrRes).map(mapBsr);
    const bookings = rows(bookingsRes).map((r) => ({
      booking_id: r.booking_id,
      total_amount_cents: r.total_amount_cents,
      balance_due_cents: r.balance_due_cents,
    }));
    const payments = rows(paymentsRes).map((r) => ({
      payment_id: r.payment_id != null ? String(r.payment_id) : null,
      booking_id: r.booking_id,
      amount_paid_cents: r.amount_paid_cents,
      paid_at: r.paid_at,
    }));
    const refund_records = rows(refundsRes).map(mapRefund);
    const diagnostics = createFinanceDiagnostics();
    softScanFinanceRows({ bsr, bookings, payments, refund_records }, diagnostics);
    const incompleteBsrBookingIds = new Set();
    const cleanPayments = payments.filter((p) => parseCanonicalIntCents(p.amount_paid_cents).ok);
    const cleanBookings = bookings.filter((b) => {
      if (b.total_amount_cents != null && !parseCanonicalIntCents(b.total_amount_cents).ok) return false;
      if (b.balance_due_cents != null && !parseCanonicalIntCents(b.balance_due_cents).ok) return false;
      const badPay = payments.some((p) => String(p.booking_id) === String(b.booking_id)
        && !parseCanonicalIntCents(p.amount_paid_cents).ok);
      return !badPay;
    });
    const cleanBsr = bsr.filter((row) => {
      const ok = parseCanonicalIntCents(row.amount_due_cents).ok;
      if (!ok && row.booking_id != null) incompleteBsrBookingIds.add(String(row.booking_id));
      return ok;
    });
    let reconcileResult;
    try {
      reconcileResult = reconcileBookingBalances({
        bookings: cleanBookings,
        bsr: cleanBsr,
        payments: cleanPayments,
        diagnostics,
        report: true,
        incompleteBsrBookingIds,
      });
    } catch (err) {
      throw err instanceof FinanceDataQualityError ? err : new FinanceDataQualityError();
    }
    await pg.query('COMMIT');
    const reconUnavailable = (reconcileResult && Array.isArray(reconcileResult.reconciliation_unavailable))
      ? reconcileResult.reconciliation_unavailable.slice()
      : (diagnostics.reconciliation_unavailable || []).slice();
    return {
      bsr,
      bookings,
      payments,
      pending_refund_payments: [],
      refund_records,
      refund_ledger_unavailable: refundLedgerUnavailable,
      rental_stock: [],
      surf_packs: [],
      data_quality: {
        malformed_count: diagnostics.malformed.length,
        malformed: diagnostics.malformed.slice(),
        balance_drift_count: diagnostics.balance_drift.length,
        balance_drift: diagnostics.balance_drift.slice(),
        flagged_booking_ids: (reconcileResult && reconcileResult.flagged_booking_ids)
          ? reconcileResult.flagged_booking_ids.slice()
          : [],
        reconciliation_unavailable: reconUnavailable,
        reconciliation_unavailable_count: reconUnavailable.length,
      },
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
  fetchLodgingFinanceData,
  FinanceDataQualityError,
  // Deprecated export kept so any stale require of PENDING_REFUND_SQL does not crash
  // at module load; Slice 2 no longer queries it.
  PENDING_REFUND_SQL: null,
};
