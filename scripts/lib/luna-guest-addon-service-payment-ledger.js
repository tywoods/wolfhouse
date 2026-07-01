'use strict';

/**
 * Stage 38b — Guest add-on service payment ledger rows (draft/due, no Stripe by default).
 *
 * Creates auditable addon_service payment rows separate from booking deposit.
 * Idempotent by booking_id + service_record_id + payment_origin.
 */

const { resolveClientId } = require('./main-booking-hold-pg-sql');

const PAYMENT_ORIGIN = 'luna_guest_service_addon';
const LEDGER_STAGE = '38b_guest_addon_service_ledger';

const SERVICE_TYPE_LABELS = Object.freeze({
  wetsuit: 'Wetsuit rental',
  surfboard: 'Surfboard rental',
  surf_lesson: 'Group lesson',
  yoga: 'Yoga',
  meal: 'Dinner',
});

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function parseMetadata(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function serviceTypeStaffLabel(serviceType, meta) {
  const md = meta || {};
  if (md.catalog_service && md.service_name) return String(md.service_name);
  if (md.staff_ui_service_type) {
    const ui = String(md.staff_ui_service_type);
    if (ui === 'dinner' || ui === 'meals') return 'Dinner';
    return ui.charAt(0).toUpperCase() + ui.slice(1);
  }
  const t = trimStr(serviceType).toLowerCase();
  if (t === 'meal' && md.meal_type === 'dinner') return 'Dinner';
  return SERVICE_TYPE_LABELS[t] || t.replace(/_/g, ' ');
}

function buildServicePaymentIdempotencyKey(bookingId, serviceRecordId) {
  return `svc-ledger-${trimStr(bookingId)}-${trimStr(serviceRecordId)}`;
}

function isGuestAddonServicePaymentRow(row) {
  if (!row) return false;
  const kind = String(row.payment_kind || '').toLowerCase();
  if (kind !== 'addon_service') return false;
  const md = parseMetadata(row.metadata);
  return md.payment_origin === PAYMENT_ORIGIN
    || md.source === PAYMENT_ORIGIN
    || String(md.idempotency_key || '').startsWith('svc-ledger-');
}

function formatEuro(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return null;
  return `€${(Number(cents) / 100).toFixed(2)}`;
}

function formatServiceChargeDueLine(serviceType, amountCents, meta) {
  const label = serviceTypeStaffLabel(serviceType, meta);
  const eur = formatEuro(amountCents);
  return eur ? `${label} — ${eur} due at checkout` : `${label} — due at checkout`;
}

function formatAddonServicePaymentLedgerLabel(paymentRow) {
  const pr = paymentRow || {};
  const md = parseMetadata(pr.metadata);
  const st = String(pr.payment_status || '').toLowerCase();
  const label = serviceTypeStaffLabel(md.service_type, md);
  if (st === 'paid') return `${label} — paid`;
  if (st === 'checkout_created' && pr.checkout_url) {
    return `${label} — Stripe link awaiting payment`;
  }
  if (st === 'draft' || st === 'pending') {
    const eur = formatEuro(pr.amount_due_cents);
    return eur ? `${label} — ${eur} due at checkout` : `${label} — due at checkout`;
  }
  return `${label} — ${st.replace(/_/g, ' ') || 'due'}`;
}

function isPaidPaymentRow(row) {
  const st = String(row && row.payment_status || '').toLowerCase();
  if (st === 'paid') return true;
  return Number(row && row.amount_paid_cents || 0) > 0;
}

function isUnpaidServiceLedgerRow(row) {
  if (!isGuestAddonServicePaymentRow(row)) return false;
  return !isPaidPaymentRow(row);
}

function sumUnpaidServicePaymentCents(paymentRows) {
  return (paymentRows || [])
    .filter(isUnpaidServiceLedgerRow)
    .reduce((sum, row) => sum + Number(row.amount_due_cents || 0), 0);
}

function buildDryRunLedgerPlan(serviceRecords) {
  const rows = (serviceRecords || []).filter((sr) => Number(sr.amount_due_cents || 0) > 0);
  const lines = rows.map((sr) => {
    const meta = parseMetadata(sr.metadata);
    return {
      service_record_id: sr.id || sr.service_record_id,
      service_type: sr.service_type,
      amount_due_cents: Number(sr.amount_due_cents),
      staff_line: formatServiceChargeDueLine(sr.service_type, sr.amount_due_cents, meta),
      payable_at_checkout: true,
      optional_pay_now: false,
    };
  });
  return {
    dry_run: true,
    service_payment_rows_planned: lines.length,
    service_payment_total_due_cents: lines.reduce((s, l) => s + l.amount_due_cents, 0),
    service_charges_due_lines: lines.map((l) => l.staff_line),
    payable_at_checkout: true,
    optional_pay_now: false,
  };
}

function buildServiceChargesDueFromContext(input) {
  const src = input || {};
  const booking = src.booking || {};
  const serviceRecords = src.serviceRecords || src.service_records || [];
  const paymentRows = src.paymentRows || src.payment_rows || [];

  const addonPayments = (paymentRows || []).filter(isGuestAddonServicePaymentRow);
  const unpaidAddonPayments = addonPayments.filter(isUnpaidServiceLedgerRow);

  let lines = unpaidAddonPayments.map((pr) => {
    const md = parseMetadata(pr.metadata);
    return formatServiceChargeDueLine(md.service_type, pr.amount_due_cents, md);
  });

  let serviceChargesDueCents = sumUnpaidServicePaymentCents(paymentRows);

  if (!lines.length && serviceRecords.length) {
    const pendingRecords = serviceRecords.filter((sr) => {
      const ps = String(sr.payment_status || '').toLowerCase();
      if (ps === 'paid') return false;
      return Number(sr.amount_due_cents || 0) > 0;
    });
    lines = pendingRecords.map((sr) => {
      const meta = parseMetadata(sr.metadata);
      return formatServiceChargeDueLine(sr.service_type, sr.amount_due_cents, meta);
    });
    if (!serviceChargesDueCents) {
      serviceChargesDueCents = pendingRecords.reduce(
        (s, sr) => s + Number(sr.amount_due_cents || 0),
        0,
      );
    }
  }

  const paidTotal = (paymentRows || []).reduce((sum, pr) => {
    if (!isPaidPaymentRow(pr)) return sum;
    const kind = String(pr.payment_kind || '').toLowerCase();
    if (kind === 'addon_service') return sum;
    return sum + Number(pr.amount_paid_cents || 0);
  }, 0);

  const bookingBalance = booking.balance_due_cents != null
    ? Number(booking.balance_due_cents)
    : null;

  let totalDueAtCheckout = null;
  if (bookingBalance != null) {
    totalDueAtCheckout = bookingBalance;
  } else if (serviceChargesDueCents > 0) {
    totalDueAtCheckout = serviceChargesDueCents;
  }

  return {
    service_charges_due_cents: serviceChargesDueCents,
    service_charges_due_lines: lines,
    accommodation_balance_due_cents: bookingBalance,
    total_due_at_checkout_cents: totalDueAtCheckout,
    addon_service_payment_rows: unpaidAddonPayments.length,
    optional_pay_now: false,
    payable_at_checkout: true,
    paid_deposit_cents: paidTotal,
  };
}

async function findExistingServicePayment(pg, bookingId, idempotencyKey) {
  const res = await pg.query(
    `SELECT id::text AS payment_id, status::text AS payment_status,
            amount_due_cents, amount_paid_cents, payment_kind::text AS payment_kind, metadata
       FROM payments
      WHERE booking_id = $1::uuid
        AND payment_kind = 'addon_service'::payment_kind
        AND metadata->>'idempotency_key' = $2
      LIMIT 1`,
    [bookingId, idempotencyKey],
  );
  return res.rows[0] || null;
}

async function linkServiceRecordPaymentId(pg, serviceRecordId, paymentId) {
  try {
    await pg.query(
      `UPDATE booking_service_records
          SET payment_id = $1::uuid,
              updated_at = NOW()
        WHERE id = $2::uuid
          AND (payment_id IS NULL OR payment_id = $1::uuid)`,
      [paymentId, serviceRecordId],
    );
    return { linked: true };
  } catch (err) {
    if (err.code === '42703') {
      return { linked: false, payment_id_column_missing: true };
    }
    throw err;
  }
}

async function upsertServicePaymentForRecord(pg, opts) {
  const o = opts || {};
  const clientId = o.clientId;
  const bookingId = trimStr(o.bookingId);
  const bookingCode = trimStr(o.bookingCode);
  const sr = o.serviceRecord || {};
  const serviceRecordId = trimStr(sr.id || sr.service_record_id);
  const amountDueCents = Number(sr.amount_due_cents || 0);
  const serviceType = trimStr(sr.service_type);

  if (!pg || !clientId || !bookingId || !serviceRecordId || amountDueCents <= 0) {
    return { skipped: true, reason: 'missing_required_fields' };
  }

  const paymentStatus = String(sr.payment_status || '').toLowerCase();
  if (paymentStatus === 'paid') {
    return { skipped: true, reason: 'service_already_paid' };
  }

  const idempotencyKey = buildServicePaymentIdempotencyKey(bookingId, serviceRecordId);
  const existing = await findExistingServicePayment(pg, bookingId, idempotencyKey);
  if (existing) {
    if (!isPaidPaymentRow(existing)) {
      await linkServiceRecordPaymentId(pg, serviceRecordId, existing.payment_id);
    }
    return {
      existing: true,
      payment_id: existing.payment_id,
      amount_due_cents: Number(existing.amount_due_cents || 0),
      service_record_id: serviceRecordId,
      service_type: serviceType,
    };
  }

  const pmMeta = {
    source: o.writeSource || 'luna_guest_hold_payment_draft_27n',
    payment_origin: PAYMENT_ORIGIN,
    service_record_id: serviceRecordId,
    service_type: serviceType,
    booking_code: bookingCode,
    payable_at_checkout: true,
    optional_pay_now: false,
    idempotency_key: idempotencyKey,
    is_payment_truth: false,
    stage: LEDGER_STAGE,
  };

  const ins = await pg.query(
    `INSERT INTO payments (
       client_id, booking_id, status, payment_kind, currency,
       amount_due_cents, amount_paid_cents, metadata
     ) VALUES (
       $1, $2::uuid, 'draft'::payment_record_status, 'addon_service'::payment_kind, 'EUR',
       $3, 0, $4::jsonb
     ) RETURNING id::text AS payment_id, amount_due_cents`,
    [clientId, bookingId, amountDueCents, JSON.stringify(pmMeta)],
  );

  const paymentId = ins.rows[0].payment_id;
  const link = await linkServiceRecordPaymentId(pg, serviceRecordId, paymentId);

  return {
    created: true,
    payment_id: paymentId,
    amount_due_cents: Number(ins.rows[0].amount_due_cents),
    service_record_id: serviceRecordId,
    service_type: serviceType,
    payment_id_linked: link.linked === true,
    payment_id_column_missing: link.payment_id_column_missing === true,
  };
}

async function loadPricedGuestServiceRecords(pg, bookingId) {
  const res = await pg.query(
    `SELECT id::text AS service_record_id, service_type, amount_due_cents,
            payment_status, metadata, payment_id::text AS payment_id
       FROM booking_service_records
      WHERE booking_id = $1::uuid
        AND source = 'luna_guest'
        AND COALESCE(amount_due_cents, 0) > 0
        AND COALESCE(payment_status, '') <> 'paid'`,
    [bookingId],
  );
  return res.rows.map((row) => ({
    ...row,
    id: row.service_record_id,
  }));
}

/**
 * Create or reuse draft addon_service payment rows for unpaid guest service records.
 */
async function syncGuestAddonServicePaymentLedger(pg, opts) {
  const o = opts || {};
  const bookingId = trimStr(o.bookingId);
  const clientSlug = trimStr(o.clientSlug) || 'wolfhouse-somo';
  let clientId = o.clientId;

  if (!pg || !bookingId) {
    return {
      ...buildDryRunLedgerPlan(o.serviceRecords || []),
      skipped: true,
      reason: 'missing_pg_or_booking',
    };
  }

  if (!clientId) {
    const clientRes = await resolveClientId(pg, clientSlug);
    if (clientRes.error) {
      return { error: clientRes.error, service_payment_rows_created: 0 };
    }
    clientId = clientRes.client_id;
  }

  let serviceRecords = o.serviceRecords;
  if (!serviceRecords) {
    serviceRecords = await loadPricedGuestServiceRecords(pg, bookingId);
  }

  const plan = buildDryRunLedgerPlan(serviceRecords);
  if (!plan.service_payment_rows_planned) {
    return {
      service_payment_rows_created: 0,
      service_payment_rows_existing: 0,
      service_payment_total_due_cents: 0,
      service_charges_due_lines: [],
      payable_at_checkout: true,
      optional_pay_now: false,
    };
  }

  const created = [];
  const existing = [];
  const errors = [];

  for (const sr of serviceRecords) {
    if (Number(sr.amount_due_cents || 0) <= 0) continue;
    try {
      const outcome = await upsertServicePaymentForRecord(pg, {
        clientId,
        bookingId,
        bookingCode: o.bookingCode,
        serviceRecord: sr,
        writeSource: o.writeSource,
      });
      if (outcome.created) created.push(outcome);
      else if (outcome.existing) existing.push(outcome);
    } catch (err) {
      if (/invalid input value for enum payment_kind|addon_service/.test(String(err.message || ''))) {
        return {
          error: 'addon_service_payment_kind_unavailable',
          schema_gap: 'payment_kind enum missing addon_service — apply migration 011_service_payment_linkage.sql',
          service_payment_rows_created: created.length,
          service_payment_rows_existing: existing.length,
          partial: true,
        };
      }
      errors.push({ service_record_id: sr.id || sr.service_record_id, error: err.message });
    }
  }

  const totalDue = [...created, ...existing].reduce(
    (s, row) => s + Number(row.amount_due_cents || 0),
    0,
  );

  const lines = serviceRecords
    .filter((sr) => Number(sr.amount_due_cents || 0) > 0)
    .map((sr) => formatServiceChargeDueLine(sr.service_type, sr.amount_due_cents, parseMetadata(sr.metadata)));

  return {
    service_payment_rows_created: created.length,
    service_payment_rows_existing: existing.length,
    service_payment_total_due_cents: totalDue,
    service_charges_due_lines: lines,
    service_charges_due_cents: totalDue,
    payable_at_checkout: true,
    optional_pay_now: false,
    created_payments: created,
    existing_payments: existing,
    errors: errors.length ? errors : undefined,
  };
}

function paymentLedgerSummary() {
  return {
    payment_origin: PAYMENT_ORIGIN,
    payment_kind: 'addon_service',
    separate_from_deposit: true,
    creates_stripe_session: false,
    optional_pay_now: false,
    payable_at_checkout: true,
    idempotency: 'booking_id + service_record_id + payment_origin metadata key',
  };
}

module.exports = {
  PAYMENT_ORIGIN,
  LEDGER_STAGE,
  SERVICE_TYPE_LABELS,
  buildServicePaymentIdempotencyKey,
  serviceTypeStaffLabel,
  formatServiceChargeDueLine,
  formatAddonServicePaymentLedgerLabel,
  isGuestAddonServicePaymentRow,
  isUnpaidServiceLedgerRow,
  buildDryRunLedgerPlan,
  buildServiceChargesDueFromContext,
  syncGuestAddonServicePaymentLedger,
  loadPricedGuestServiceRecords,
  upsertServicePaymentForRecord,
  paymentLedgerSummary,
};
