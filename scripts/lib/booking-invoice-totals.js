/**
 * Phase 26i — Transfer charges in booking invoice / balance totals.
 *
 * Reads booking_transfers directly; no payment row writes.
 *
 * @module booking-invoice-totals
 */

'use strict';

const { ACTIVE_TRANSFER_PEBBLE_STATUSES } = require('./booking-transfers');

/**
 * @param {object} row
 * @returns {boolean}
 */
function isActiveTransferForInvoice(row) {
  if (!row) return false;
  const status = String(row.status || '').toLowerCase();
  if (!ACTIVE_TRANSFER_PEBBLE_STATUSES.has(status)) return false;
  const cents = Number(row.price_cents);
  return Number.isFinite(cents) && cents > 0;
}

/**
 * @param {object[]} transferRows
 * @returns {number}
 */
function sumActiveTransferChargesCents(transferRows) {
  return (transferRows || []).reduce((sum, row) => {
    if (!isActiveTransferForInvoice(row)) return sum;
    return sum + Number(row.price_cents || 0);
  }, 0);
}

/**
 * @param {string} direction
 * @returns {string}
 */
function transferDirectionLabel(direction) {
  const d = String(direction || '').toLowerCase();
  if (d === 'arrival') return 'Arrival transfer';
  if (d === 'departure') return 'Departure transfer';
  return 'Transfer';
}

/**
 * @param {object[]} transferRows
 * @returns {Array<{ direction: string, label: string, price_cents: number }>}
 */
function transferInvoiceLineItems(transferRows) {
  const items = [];
  for (const row of transferRows || []) {
    if (!isActiveTransferForInvoice(row)) continue;
    items.push({
      direction: row.direction,
      label: transferDirectionLabel(row.direction),
      price_cents: Number(row.price_cents || 0),
    });
  }
  items.sort((a, b) => {
    const order = { arrival: 0, departure: 1 };
    return (order[a.direction] ?? 9) - (order[b.direction] ?? 9);
  });
  return items;
}

// Shared accommodation/service projection used by Staff balance, calendar and manual receipts.
const EDIT_PREVIEW_ACCOMM_LINE_CODES = Object.freeze({
  package: true, package_proration: true, room_supplement: true,
  accommodation_only: true, manual_accommodation: true,
  // Per-guest package lines (multi-guest bookings with guest_packages). Without
  // these the quote_snapshot accommodation lines aren't recognized, so the
  // running invoice falls back to "total - services" and added services net out.
  guest_package: true, guest_package_proration: true, guest_accommodation_only: true,
});

function bookingLedgerParseMetadata(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function bookingLedgerAccommodationCents(bookingRow, svcDueCents, quoteSnap, additionalSvcCents) {
  // Only the embedded portion can be subtracted from the persisted base total.
  const svcSum = Number(svcDueCents || 0) - Number(additionalSvcCents || 0);
  if (quoteSnap && Array.isArray(quoteSnap.line_items)) {
    let sum = 0;
    let any = false;
    for (const li of quoteSnap.line_items) {
      if (li.code && EDIT_PREVIEW_ACCOMM_LINE_CODES[li.code] && li.total_cents != null) {
        sum += Number(li.total_cents);
        any = true;
      }
    }
    const bookingTotal = bookingRow && bookingRow.total_amount_cents != null
      ? Number(bookingRow.total_amount_cents) : null;
    // If quote lines already equal the authoritative booking total, package
    // services are embedded there. Subtract their operational service rows so
    // adding svcSum below counts them exactly once.
    if (any && sum > 0 && bookingTotal != null && bookingTotal > 0 && sum >= bookingTotal) {
      return Math.max(bookingTotal - svcSum, 0);
    }
    // A zero-valued original quote snapshot must not erase later authoritative
    // booking totals. Fall through to total-minus-services when the booking
    // total proves that accommodation value exists.
    if (any && (sum > 0
      || bookingTotal == null
      || bookingTotal <= svcSum)) return sum;
  }
  if (bookingRow && bookingRow.total_amount_cents != null) {
    const total = Number(bookingRow.total_amount_cents);
    const derived = total - svcSum;
    return derived >= 0 ? derived : total;
  }
  return null;
}

function bookingLedgerInvoicePaidBalance(bookingRow, svcDueCents, ledgerPaidCents, transferDueCents, additionalSvcCents) {
  const bk = bookingRow || {};
  const md = bookingLedgerParseMetadata(bk.metadata);
  const quoteSnap = md.quote_snapshot || null;
  const svcSum = Number(svcDueCents || 0);
  const transferSum = Number(transferDueCents || 0);
  const accCents = bookingLedgerAccommodationCents(bk, svcSum, quoteSnap, additionalSvcCents);
  const invoiceTotal = accCents != null ? accCents + svcSum + transferSum : null;
  const paidTotal = ledgerPaidCents != null ? Number(ledgerPaidCents) : 0;
  const depositRequired = bk.deposit_required_cents != null ? Number(bk.deposit_required_cents) : 0;
  let balanceDue = null;
  let needsRefund = false;
  if (invoiceTotal != null) {
    if (invoiceTotal > paidTotal) balanceDue = invoiceTotal - paidTotal;
    else if (invoiceTotal < paidTotal) { needsRefund = true; balanceDue = 0; }
    else balanceDue = 0;
  }
  return {
    invoice_total_cents: invoiceTotal,
    paid_total_cents: paidTotal,
    balance_due_cents: balanceDue,
    deposit_required_cents: depositRequired,
    needs_refund: needsRefund,
  };
}

module.exports = {
  EDIT_PREVIEW_ACCOMM_LINE_CODES,
  bookingLedgerParseMetadata,
  bookingLedgerAccommodationCents,
  bookingLedgerInvoicePaidBalance,
  isActiveTransferForInvoice,
  sumActiveTransferChargesCents,
  transferInvoiceLineItems,
  transferDirectionLabel,
};
