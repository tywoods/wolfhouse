'use strict';

/**
 * Staff portal — mutate existing paid payment ledger rows (void / edit).
 * Never DELETE payments. Recomputes booking amount_paid / balance_due / payment_status.
 * Sunset method allowlist matches BOOKING-PAYMENT-METHOD-001 (link / bank_transfer / in_store).
 */

const {
  SUNSET_PAID_METHODS,
  normalizeSunsetPaidMethod,
} = require('./sunset-schedule-booking-writes');

const STAFF_MANUAL_METHOD_SOURCES = {
  cash: 'staff_cash',
  in_store: 'staff_in_store',
  bank_transfer: 'staff_bank_transfer',
  link: 'staff_link',
};

function normalizeStaffManualMethod(raw) {
  const n = normalizeSunsetPaidMethod(raw);
  if (n) return n;
  const v = String(raw || '').toLowerCase().trim();
  if (v === 'cash') return 'in_store';
  return null;
}

function staffManualMethodSource(method) {
  const m = normalizeStaffManualMethod(method) || 'in_store';
  return STAFF_MANUAL_METHOD_SOURCES[m] || STAFF_MANUAL_METHOD_SOURCES.in_store;
}

async function sumPaidLedgerCents(pg, bookingId, clientSlug) {
  const sumRes = await pg.query(
    `SELECT COALESCE(SUM(p.amount_paid_cents), 0)::int AS total
       FROM payments p
      INNER JOIN bookings b ON b.id = p.booking_id
      INNER JOIN clients c ON c.id = b.client_id
      WHERE p.booking_id = $1::uuid
        AND c.slug = $2
        AND p.status = 'paid'::payment_record_status`,
    [bookingId, clientSlug],
  );
  return Number(sumRes.rows[0] && sumRes.rows[0].total) || 0;
}

async function loadBookingMoneyHeader(pg, bookingId, clientSlug) {
  const res = await pg.query(
    `SELECT b.id::text AS booking_id,
            b.total_amount_cents,
            b.amount_paid_cents,
            b.balance_due_cents,
            b.payment_status::text AS payment_status,
            b.metadata
       FROM bookings b
      INNER JOIN clients c ON c.id = b.client_id
      WHERE b.id = $1::uuid AND c.slug = $2
      LIMIT 1`,
    [bookingId, clientSlug],
  );
  return res.rows[0] || null;
}

function deriveBookingPaymentStatus(bkTotal, paidTotal) {
  const total = Math.max(0, Number(bkTotal) || 0);
  const paid = Math.max(0, Number(paidTotal) || 0);
  const balance = total > 0 ? Math.max(total - paid, 0) : 0;
  if (total > 0 && balance === 0 && paid > 0) return { paid, balance, payment_status: 'paid' };
  if (paid > 0) return { paid, balance, payment_status: 'deposit_paid' };
  return { paid, balance, payment_status: 'waiting_payment' };
}

async function applyBookingMoneyFromLedger(pg, opts) {
  const bookingId = opts.bookingId;
  const clientSlug = opts.clientSlug;
  const methodForMeta = opts.methodForMeta != null
    ? normalizeStaffManualMethod(opts.methodForMeta)
    : null;
  const booking = await loadBookingMoneyHeader(pg, bookingId, clientSlug);
  if (!booking) {
    return { ok: false, status: 404, error: 'booking_not_found' };
  }
  const paidTotal = await sumPaidLedgerCents(pg, bookingId, clientSlug);
  const derived = deriveBookingPaymentStatus(booking.total_amount_cents, paidTotal);
  const params = [derived.paid, derived.balance, derived.payment_status, bookingId, clientSlug];
  let metaFragment = '';
  if (derived.payment_status === 'paid' && methodForMeta) {
    metaFragment = ', metadata = COALESCE(metadata, \'{}\'::jsonb) || $6::jsonb';
    params.push(JSON.stringify({ sunset_payment_method: methodForMeta }));
  } else if (derived.payment_status !== 'paid') {
    metaFragment = ', metadata = (COALESCE(metadata, \'{}\'::jsonb) - \'sunset_payment_method\')';
  }
  const upd = await pg.query(
    `UPDATE bookings b
        SET amount_paid_cents = $1,
            balance_due_cents = $2,
            payment_status = $3::payment_status
            ${metaFragment}
       FROM clients c
      WHERE b.id = $4::uuid
        AND c.id = b.client_id
        AND c.slug = $5`,
    params,
  );
  if (Number(upd && upd.rowCount) !== 1) {
    return { ok: false, status: 409, error: 'booking_payment_update_conflict' };
  }
  return {
    ok: true,
    booking_paid_cents: derived.paid,
    balance_due_cents: derived.balance,
    payment_status: derived.payment_status,
  };
}

async function lockPaidPaymentRow(pg, opts) {
  const res = await pg.query(
    `SELECT p.id::text AS payment_id,
            p.status::text AS payment_status,
            p.amount_due_cents,
            p.amount_paid_cents,
            p.metadata,
            b.id::text AS booking_id
       FROM payments p
      INNER JOIN bookings b ON b.id = p.booking_id
      INNER JOIN clients c ON c.id = b.client_id
      WHERE p.id = $1::uuid
        AND b.id = $2::uuid
        AND c.slug = $3
      FOR UPDATE OF p`,
    [opts.paymentId, opts.bookingId, opts.clientSlug],
  );
  return res.rows[0] || null;
}

async function voidStaffPaidPayment(pg, opts) {
  const method = null;
  const row = await lockPaidPaymentRow(pg, opts);
  if (!row) return { ok: false, status: 404, error: 'payment_not_found' };
  if (String(row.payment_status || '').toLowerCase() !== 'paid') {
    return { ok: false, status: 409, error: 'payment_not_paid' };
  }
  const voidMeta = {
    voided_by_staff: true,
    voided_at: new Date().toISOString(),
    voided_reason: opts.reason || 'staff_invoice_void',
    voided_by: opts.actorLabel || null,
  };
  const upd = await pg.query(
    `UPDATE payments
        SET status = 'cancelled'::payment_record_status,
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
      WHERE id = $1::uuid
        AND status = 'paid'::payment_record_status`,
    [opts.paymentId, JSON.stringify(voidMeta)],
  );
  if (Number(upd && upd.rowCount) !== 1) {
    return { ok: false, status: 409, error: 'payment_void_conflict' };
  }
  const applied = await applyBookingMoneyFromLedger(pg, {
    bookingId: opts.bookingId,
    clientSlug: opts.clientSlug,
    methodForMeta: method,
  });
  if (!applied.ok) return applied;
  return {
    ok: true,
    payment_id: opts.paymentId,
    voided: true,
    booking_paid_cents: applied.booking_paid_cents,
    balance_due_cents: applied.balance_due_cents,
    payment_status: applied.payment_status,
  };
}

async function updateStaffPaidPayment(pg, opts) {
  const amountCents = Math.floor(Number(opts.amountCents));
  if (!(amountCents > 0)) {
    return { ok: false, status: 400, error: 'amount_cents_must_be_positive' };
  }
  const method = normalizeStaffManualMethod(opts.method);
  if (!method || !SUNSET_PAID_METHODS.has(method)) {
    return { ok: false, status: 400, error: 'invalid_payment_method' };
  }
  const row = await lockPaidPaymentRow(pg, opts);
  if (!row) return { ok: false, status: 404, error: 'payment_not_found' };
  if (String(row.payment_status || '').toLowerCase() !== 'paid') {
    return { ok: false, status: 409, error: 'payment_not_paid' };
  }
  let prevMeta = {};
  try {
    prevMeta = row.metadata && typeof row.metadata === 'object'
      ? row.metadata
      : JSON.parse(row.metadata || '{}');
  } catch (_) {
    prevMeta = {};
  }
  const nextMeta = {
    ...prevMeta,
    method,
    source: staffManualMethodSource(method),
    staff_portal: true,
    edited_by_staff: true,
    edited_at: new Date().toISOString(),
    edited_by: opts.actorLabel || null,
  };
  if (opts.note != null) nextMeta.note = String(opts.note).trim().slice(0, 500) || null;

  const upd = await pg.query(
    `UPDATE payments
        SET amount_due_cents = $2,
            amount_paid_cents = $2,
            metadata = $3::jsonb
      WHERE id = $1::uuid
        AND status = 'paid'::payment_record_status`,
    [opts.paymentId, amountCents, JSON.stringify(nextMeta)],
  );
  if (Number(upd && upd.rowCount) !== 1) {
    return { ok: false, status: 409, error: 'payment_update_conflict' };
  }
  const applied = await applyBookingMoneyFromLedger(pg, {
    bookingId: opts.bookingId,
    clientSlug: opts.clientSlug,
    methodForMeta: method,
  });
  if (!applied.ok) return applied;
  return {
    ok: true,
    payment_id: opts.paymentId,
    amount_cents: amountCents,
    method,
    booking_paid_cents: applied.booking_paid_cents,
    balance_due_cents: applied.balance_due_cents,
    payment_status: applied.payment_status,
  };
}

async function outstandingBalanceCents(pg, bookingId, clientSlug) {
  const booking = await loadBookingMoneyHeader(pg, bookingId, clientSlug);
  if (!booking) return { ok: false, status: 404, error: 'booking_not_found' };
  const paidTotal = await sumPaidLedgerCents(pg, bookingId, clientSlug);
  const total = Math.max(0, Number(booking.total_amount_cents) || 0);
  const balance = total > 0 ? Math.max(total - paidTotal, 0) : 0;
  return {
    ok: true,
    total_cents: total,
    paid_cents: paidTotal,
    balance_due_cents: balance,
    booking,
  };
}

module.exports = {
  SUNSET_PAID_METHODS,
  STAFF_MANUAL_METHOD_SOURCES,
  normalizeStaffManualMethod,
  staffManualMethodSource,
  sumPaidLedgerCents,
  loadBookingMoneyHeader,
  deriveBookingPaymentStatus,
  applyBookingMoneyFromLedger,
  voidStaffPaidPayment,
  updateStaffPaidPayment,
  outstandingBalanceCents,
};
