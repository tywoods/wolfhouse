'use strict';

const { isAdditionalInvoiceService, serviceRecordBillableCents } = require('./staff-booking-services-schedule');
const { bookingLedgerInvoicePaidBalance } = require('./booking-invoice-totals');

function paymentError(code, httpStatus, message) {
  return Object.assign(new Error(message || code), { code, httpStatus, publicMessage: message || code });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Pure camelCase input contract; throws { code, httpStatus, publicMessage }.
// Raw numeric cents only. Omitted scope means legacy booking scope; only that
// legacy shape may omit method (cash). Missing/empty date means receipt-day UTC.
// Never pass a floored amount or silently default an explicit unsupported method.
function validateStaffManualPayment(input) {
  const invalid = message => { throw paymentError('invalid_manual_payment', 400, message); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Payment input is required.');
  input = { ...input,
    paymentScope: input.paymentScope === undefined ? 'booking' : input.paymentScope,
    method: input.method === undefined && input.paymentScope === undefined ? 'cash'
      : typeof input.method === 'string' ? input.method.trim().toLowerCase() : input.method,
    paymentDate: input.paymentDate == null || input.paymentDate === '' ? null : input.paymentDate,
  };
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > 2147483647) {
    invalid('amount_cents must be a positive integer within the database integer range.');
  }
  if (typeof input.clientSlug !== 'string' || !input.clientSlug.trim()) invalid('client_slug is required.');
  if (typeof input.bookingId !== 'string' || !UUID.test(input.bookingId)) invalid('booking_id must be a valid UUID.');
  if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) invalid('idempotency_key is required.');
  if (!['cash', 'bank_transfer', 'in_store'].includes(input.method)) invalid('Unsupported payment method.');
  if (!['guest', 'booking'].includes(input.paymentScope)) invalid('payment_scope must be guest or booking.');
  if (input.paymentScope === 'guest' && (typeof input.bookingGuestId !== 'string' || !UUID.test(input.bookingGuestId))) {
    invalid('Guest scope requires a valid booking_guest_id.');
  }
  if (input.paymentScope === 'booking' && input.bookingGuestId != null) invalid('Booking scope cannot include a guest.');
  if (input.paymentDate !== null && (typeof input.paymentDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate)
    || input.paymentDate.startsWith('0000-') || !Number.isFinite(Date.parse(input.paymentDate))
    || new Date(input.paymentDate).toISOString().slice(0,10) !== input.paymentDate)) invalid('payment_date must be a calendar date.');
  if (input.note != null && typeof input.note !== 'string') invalid('note must be text.');
  return { ...input, clientSlug: input.clientSlug.trim(), bookingId: input.bookingId.toLowerCase(),
    bookingGuestId: input.bookingGuestId == null ? null : input.bookingGuestId.toLowerCase(),
    idempotencyKey: input.idempotencyKey.trim(), note: input.note == null ? null : input.note.trim().slice(0,500) };
}

async function bookingTotals(pg, booking) {
  const sum = await pg.query(`SELECT COALESCE(SUM(amount_paid_cents),0)::bigint AS total
    FROM payments WHERE booking_id=$1::uuid AND client_id=$2::uuid AND status='paid'`,
  [booking.id, booking.client_id]);
  const paid = Number(sum.rows[0].total);
  const services = await pg.query(`SELECT amount_due_cents, status, metadata FROM booking_service_records
    WHERE booking_id=$1::uuid AND client_slug=$2`,
  [booking.id, booking.client_slug]);
  const additional = services.rows.filter(isAdditionalInvoiceService).reduce((sum,row)=>sum+serviceRecordBillableCents(row),0);
  const serviceTotal = services.rows.reduce((sum,row)=>sum+serviceRecordBillableCents(row),0);
  const total = bookingLedgerInvoicePaidBalance(booking,serviceTotal,paid,0,additional).invoice_total_cents;
  return { invoice_total_cents: total, booking_paid_cents: paid, balance_due_cents: total > 0 ? Math.max(total - paid, 0) : 0 };
}

// Caller owns staff write authorization, authenticated tenant binding and actorLabel.
// Supply one reserved PG connection, outside any transaction: this function owns it.
// Transaction/lock order matches per-guest-checkout: booking, guest, payment.
// No provider, messaging, hold-promotion or guest allocation effects.
async function recordStaffManualPayment(pg, input) {
  const { clientSlug, bookingId, paymentScope, bookingGuestId, amountCents, method,
    idempotencyKey, note, paymentDate, actorLabel } = validateStaffManualPayment(input);
  await pg.query('BEGIN');
  try {
    const loaded = await pg.query(`SELECT b.id, b.client_id, b.status, b.total_amount_cents, b.payment_status, b.metadata, c.slug AS client_slug
      FROM bookings b JOIN clients c ON c.id=b.client_id
      WHERE b.id=$1::uuid AND c.slug=$2 FOR UPDATE OF b`, [bookingId, clientSlug]);
    const booking = loaded.rows[0];
    if (!booking) throw paymentError('booking_not_found', 404);
    if (['cancelled', 'canceled', 'expired'].includes(String(booking.status).toLowerCase())) {
      throw paymentError('booking_not_active', 400, 'Cannot record payment on a cancelled or expired booking.');
    }
    if (bookingGuestId) {
      const guest = await pg.query(`SELECT id FROM booking_guests
        WHERE id=$1::uuid AND booking_id=$2::uuid AND client_id=$3::uuid FOR UPDATE`,
      [bookingGuestId, bookingId, booking.client_id]);
      if (!guest.rows[0]) throw paymentError('booking_guest_not_found', 404);
    }
    const existing = await pg.query(`SELECT id::text AS payment_id,status::text AS payment_status,
      booking_guest_id,amount_due_cents,amount_paid_cents,paid_at,metadata,currency,payment_kind
      FROM payments WHERE booking_id=$1::uuid AND client_id=$2::uuid
        AND metadata->>'idempotency_key'=$3 FOR UPDATE`, [bookingId, booking.client_id, idempotencyKey]);
    if (existing.rows[0]) {
      const prior = existing.rows[0];
      const md = prior.metadata || {};
      const sameIntent = existing.rows.length === 1 && prior.payment_status === 'paid'
        && prior.currency === 'EUR' && prior.payment_kind === 'full_amount'
        && Number(prior.amount_due_cents) === amountCents && Number(prior.amount_paid_cents) === amountCents
        && (prior.booking_guest_id || null) === bookingGuestId
        && (md.payment_scope || (prior.booking_guest_id ? 'guest' : 'booking')) === paymentScope
        && md.method === method && md.source === 'staff_' + method
        && (md.note == null ? null : md.note) === note
        // An omitted date means retain the original receipt date on a later-day retry.
        && (paymentDate === null || md.payment_date === paymentDate);
      if (!sameIntent) throw paymentError('idempotency_conflict', 409,
        'This idempotency key was already used for a different payment intent.');
      const totals = await bookingTotals(pg, booking);
      await pg.query('COMMIT');
      return { idempotent: true, payment: existing.rows[0], booking_paid_cents: totals.booking_paid_cents, balance_due_cents: totals.balance_due_cents };
    }
    const receiptDate = paymentDate || new Date().toISOString().slice(0,10);
    const metadata = { source: 'staff_' + method, method, idempotency_key: idempotencyKey, note,
      payment_date: receiptDate, recorded_by: actorLabel, staff_portal: true,
      payment_scope: paymentScope, booking_guest_id: bookingGuestId };
    const inserted = await pg.query(`INSERT INTO payments
      (client_id,booking_id,booking_guest_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents,paid_at,metadata)
      VALUES($1::uuid,$2::uuid,$3::uuid,'paid'::payment_record_status,'full_amount'::payment_kind,'EUR',$4,$4,$5::timestamptz,$6::jsonb)
      RETURNING id::text AS payment_id,status::text AS payment_status,booking_guest_id,
        amount_due_cents,amount_paid_cents,paid_at,metadata`,
    [booking.client_id, bookingId, bookingGuestId, amountCents, receiptDate + 'T12:00:00.000Z', JSON.stringify(metadata)]);
    // Match stripe-hold-promote-policy's cumulative guest projection. Its 'paid'
    // status describes a paid receipt; remaining share still comes from SQL sums.
    if (bookingGuestId) await pg.query(`UPDATE booking_guests bg
      SET amount_paid_cents=(SELECT COALESCE(SUM(p.amount_paid_cents),0) FROM payments p
        WHERE p.booking_guest_id=bg.id AND p.client_id=bg.client_id AND p.booking_id=bg.booking_id AND p.status='paid'),
        payment_status='paid', updated_at=NOW()
      WHERE id=$1::uuid AND booking_id=$2::uuid AND client_id=$3::uuid`,
    [bookingGuestId, bookingId, booking.client_id]);
    const totals = await bookingTotals(pg, booking);
    const paid = totals.booking_paid_cents;
    const total = totals.invoice_total_cents;
    const balance = totals.balance_due_cents;
    let status = booking.payment_status;
    if (total > 0 && balance === 0) status = 'paid';
    else if (paid > 0 && (status === 'not_requested' || (status === 'paid' && balance > 0 && total > Number(booking.total_amount_cents || 0)))) status = 'deposit_paid';
    await pg.query(`UPDATE bookings SET amount_paid_cents=$1,balance_due_cents=$2,payment_status=$3::payment_status
      WHERE id=$4::uuid AND client_id=$5::uuid`, [paid, balance, status, bookingId, booking.client_id]);
    await pg.query('COMMIT');
    return { idempotent: false, payment: inserted.rows[0], booking_paid_cents: paid, balance_due_cents: balance };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

module.exports = { recordStaffManualPayment, validateStaffManualPayment };
