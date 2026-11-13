'use strict';

/**
 * Project Staff /payments/status so Luna does not see booking_payment_status
 * not_requested after deposit/pay links were created.
 *
 * Does not write bookings or payments. Read-only overlay on the JSON body.
 */

const LINK_SENT = new Set(['checkout_created', 'waiting_payment', 'payment_link_sent']);
const PAID = new Set(['paid', 'deposit_paid', 'fully_paid']);

function statusOf(row) {
  return String((row && (row.payment_status || row.status)) || '').toLowerCase();
}

function projectPaymentStatusAfterLinksSent(body) {
  if (!body || typeof body !== 'object') return body;
  const out = Object.assign({}, body);
  const latest = out.latest_payment && typeof out.latest_payment === 'object'
    ? Object.assign({}, out.latest_payment)
    : out.latest_payment;
  const records = Array.isArray(out.payment_records) ? out.payment_records : [];
  const latestStatus = statusOf(latest);
  const anyLinkSent = LINK_SENT.has(latestStatus)
    || !!(latest && latest.checkout_url && latestStatus && latestStatus !== 'not_requested')
    || records.some((row) => LINK_SENT.has(statusOf(row)) || (row && row.checkout_url && LINK_SENT.has(statusOf(row))));

  const bookingStatus = String(
    out.booking_payment_status
    || (latest && latest.booking_payment_status)
    || '',
  ).toLowerCase();

  if (PAID.has(bookingStatus) || PAID.has(latestStatus)) {
    if (latest) out.latest_payment = latest;
    if (!out.payment_status) out.payment_status = latestStatus || bookingStatus;
    return out;
  }

  if (anyLinkSent && (!bookingStatus || bookingStatus === 'not_requested')) {
    const sent = LINK_SENT.has(latestStatus) ? latestStatus : 'checkout_created';
    out.booking_payment_status = sent;
    out.payment_status = latestStatus || sent;
    if (latest && typeof latest === 'object') {
      latest.booking_payment_status = sent;
      out.latest_payment = latest;
    }
    return out;
  }

  if (!out.payment_status && latestStatus) out.payment_status = latestStatus;
  if (latest) out.latest_payment = latest;
  return out;
}

module.exports = {
  projectPaymentStatusAfterLinksSent,
};
