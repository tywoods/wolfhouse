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

module.exports = {
  isActiveTransferForInvoice,
  sumActiveTransferChargesCents,
  transferInvoiceLineItems,
  transferDirectionLabel,
};
