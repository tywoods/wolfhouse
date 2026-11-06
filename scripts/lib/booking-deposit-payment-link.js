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
  const facts = bookingDepositCollectionFacts(depositRequired, Number(ledger.invoice_total_cents), paymentRows);
  const paid = facts.collection_paid_total_cents;
  if (paid > Number(ledger.invoice_total_cents)) {
    return { ok: false, status: 409, body: { success: false, reason_code: 'refund_review_needed', error: 'Refund / credit review needed before creating a payment link.' } };
  }
  if (paymentTarget === 'balance') return { ok: true, amountDueCents: Math.max(Number(ledger.invoice_total_cents) - paid, 0) };
  if (paid >= depositRequired) {
    return { ok: false, status: 422, body: { success: false, reason_code: 'no_deposit_due', error: 'No remaining deposit due.' } };
  }
  return { ok: true, amountDueCents: facts.deposit_outstanding_cents };
}

// Existing collection arithmetic exposed for read composition. Null rows mean
// identity is not established, NOT an empty ledger. Admission stays with callers.
function bookingDepositCollectionFacts(depositRequired, invoiceTotal, paymentRows) {
  const paid = paymentRows == null ? null : paymentRows.reduce((sum, row) => String(row.payment_status).toLowerCase() === 'paid'
    ? sum + Number(row.amount_paid_cents || 0) : sum, 0);
  const balance = invoiceTotal == null || paid == null ? null : Math.max(invoiceTotal - paid, 0);
  return {
    deposit_display_cents: depositRequired == null || invoiceTotal == null ? null : Math.min(depositRequired, invoiceTotal),
    collection_paid_total_cents: paid,
    collection_balance_due_cents: balance,
    collection_needs_refund: invoiceTotal == null || paid == null ? null : paid > invoiceTotal,
    deposit_outstanding_cents: balance == null || depositRequired == null ? null : Math.min(
      balance, Math.max(depositRequired - paid, 0)),
  };
}

module.exports = { bookingDepositLinkAmount, bookingDepositCollectionFacts };
