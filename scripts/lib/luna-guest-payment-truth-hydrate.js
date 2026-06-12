'use strict';

/**
 * Stage 55 — Hydrate guest_context payment truth from DB before reply planning.
 */

const { normalizeGuestContextForChain } = require('./luna-guest-context-merge');
const { attachActiveThreadToGuestContext, PAID_STATUSES } = require('./luna-guest-thread-state');
const { loadBookingSendState } = require('./luna-guest-confirmation-auto-send');

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function mergePaymentTruthRowIntoContext(guestContext, row) {
  if (!row) return guestContext || {};
  const ctx = guestContext && typeof guestContext === 'object' ? { ...guestContext } : {};
  const payStatus = trimStr(row.payment_status).toLowerCase();

  ctx.booking_id = trimStr(row.id) || ctx.booking_id || null;
  ctx.booking_code = trimStr(row.booking_code) || ctx.booking_code || null;
  ctx.payment_truth = {
    payment_status: payStatus || null,
    booking_code: ctx.booking_code,
    booking_id: ctx.booking_id,
    source: 'db_hydrate',
    hydrated_at: new Date().toISOString(),
  };

  if (row.confirmation_sent_at) ctx.confirmation_sent = true;
  if (payStatus && PAID_STATUSES.has(payStatus)) ctx.payment_received = true;

  return attachActiveThreadToGuestContext(normalizeGuestContextForChain(ctx));
}

/**
 * Load booking payment status from DB when booking_code/id present on context.
 */
async function hydrateGuestContextPaymentTruth(pg, guestContext) {
  const ctx = guestContext && typeof guestContext === 'object' ? guestContext : {};
  const bookingId = trimStr(ctx.booking_id);
  const bookingCode = trimStr(ctx.booking_code);

  if (!pg || (!bookingId && !bookingCode)) {
    return attachActiveThreadToGuestContext(normalizeGuestContextForChain(ctx));
  }

  try {
    const row = await loadBookingSendState(pg, { bookingId, bookingCode });
    return mergePaymentTruthRowIntoContext(ctx, row);
  } catch (_) {
    return attachActiveThreadToGuestContext(normalizeGuestContextForChain(ctx));
  }
}

module.exports = {
  hydrateGuestContextPaymentTruth,
  mergePaymentTruthRowIntoContext,
};
