'use strict';

const { wolfhouseBookingDepositCents, loadWolfhouseDepositRates } = require('./wolfhouse-stay-deposit');

// The HTTP adapter supplies its existing canonical invoice reader, never request cents.
// Paid truth comes from payment rows, not the booking's cached paid projection.
// Deposit due uses nights × guests when both are known, so a stored flat €200
// cannot create a €200 link for a 7-night × 3-guest stay.
async function bookingDepositLinkAmount(pg, booking, paymentRows, execOpts, paymentTarget = 'deposit') {
  let rates = null;
  if (pg) {
    try { rates = await loadWolfhouseDepositRates(pg); } catch (_) { rates = null; }
  }
  const depositRequired = wolfhouseBookingDepositCents(booking, rates);
  if (paymentTarget === 'deposit' && depositRequired == null) {
    return { ok: false, status: 422, body: { success: false, reason_code: 'deposit_configuration_unknown', error: 'Deposit configuration is unknown.' } };
  }
  if (typeof execOpts.loadBookingPaymentLedger !== 'function') {
    return { ok: false, status: 503, body: { success: false, reason_code: 'payment_ledger_unavailable', error: 'Fresh booking payment ledger adapter required.' } };
  }
  const ledger = await execOpts.loadBookingPaymentLedger(pg, booking);
  if (!ledger || ledger.invoice_total_cents == null || !Number.isSafeInteger(Number(ledger.invoice_total_cents))
    || Number(ledger.invoice_total_cents) < 0) {
    return { ok: false, status: 422, body: { success: false, reason_code: 'invoice_total_unknown', error: 'Invoice total is unknown.' } };
  }
  const paid = paymentRows.reduce((sum, row) => String(row.payment_status).toLowerCase() === 'paid'
    ? sum + Number(row.amount_paid_cents || 0) : sum, 0);
  if (paid > Number(ledger.invoice_total_cents)) {
    return { ok: false, status: 409, body: { success: false, reason_code: 'refund_review_needed', error: 'Refund / credit review needed before creating a payment link.' } };
  }
  if (paymentTarget === 'balance') return { ok: true, amountDueCents: Math.max(Number(ledger.invoice_total_cents) - paid, 0) };
  if (paid >= depositRequired) {
    return { ok: false, status: 422, body: { success: false, reason_code: 'no_deposit_due', error: 'No remaining deposit due.' } };
  }
  return { ok: true, amountDueCents: Math.min(
    Math.max(Number(ledger.invoice_total_cents) - paid, 0),
    Math.max(depositRequired - paid, 0),
  ) };
}

module.exports = { bookingDepositLinkAmount };
