'use strict';

/**
 * Stage 55 — Open-world thread state (lane collapse v1).
 *
 * One enum describes where the guest is in their journey. Router lanes remain
 * for now; downstream code reads active_thread instead of inferring from lanes.
 */

const THREAD_STATES = Object.freeze([
  'intake',
  'quoted',
  'awaiting_payment',
  'booked',
  'post_booking',
]);

const PAID_STATUSES = new Set(['deposit_paid', 'paid', 'fully_paid']);

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function readPaymentStatus(ctx) {
  const c = ctx || {};
  const pt = c.payment_truth || c.live_payment_truth || {};
  const status = trimStr(pt.payment_status || c.payment_status).toLowerCase();
  return status;
}

function isPaidContext(ctx) {
  const c = ctx || {};
  if (c.payment_received === true) return true;
  return PAID_STATUSES.has(readPaymentStatus(c));
}

/**
 * @param {object} guestContext
 * @returns {'intake'|'quoted'|'awaiting_payment'|'booked'|'post_booking'}
 */
function resolveActiveThread(guestContext) {
  const ctx = guestContext || {};
  const quote = ctx.quote && typeof ctx.quote === 'object' ? ctx.quote : {};
  const paid = isPaidContext(ctx);

  if (paid && ctx.confirmation_sent === true) return 'post_booking';
  if (paid) return 'booked';

  if (ctx.payment_link_sent === true || ctx.stripe_link_created === true) {
    return 'awaiting_payment';
  }

  const pc = ctx.payment_choice && typeof ctx.payment_choice === 'object' ? ctx.payment_choice : {};
  if (pc.payment_choice_ready === true || ctx.hold_created === true) {
    return 'awaiting_payment';
  }

  if (quote.quote_status === 'ready') return 'quoted';

  const fields = ctx.extracted_fields
    || (ctx.result && ctx.result.extracted_fields)
    || {};
  if (fields.check_in && fields.check_out && fields.guest_count != null) {
    return 'intake';
  }

  return 'intake';
}

function attachActiveThreadToGuestContext(guestContext) {
  const ctx = guestContext && typeof guestContext === 'object' ? { ...guestContext } : {};
  ctx.active_thread = resolveActiveThread(ctx);
  return ctx;
}

function isPostBookingThread(guestContext) {
  const t = resolveActiveThread(guestContext);
  return t === 'booked' || t === 'post_booking';
}

function isActiveBookingThread(guestContext) {
  const t = resolveActiveThread(guestContext);
  return t === 'intake' || t === 'quoted' || t === 'awaiting_payment';
}

module.exports = {
  THREAD_STATES,
  PAID_STATUSES,
  resolveActiveThread,
  attachActiveThreadToGuestContext,
  isPostBookingThread,
  isActiveBookingThread,
  isPaidContext,
  readPaymentStatus,
};
