'use strict';

/**
 * Bot test-booking cancel — unpaid payment row neutralization helpers.
 * Used by POST /staff/bot/bookings/cancel (test-lane teardown only).
 */

const NEUTRALIZABLE_PAYMENT_STATUSES = new Set(['checkout_created', 'draft', 'pending']);

const PROTECTED_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'partially_paid']);

function parsePaymentMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch (_) {
    return {};
  }
}

function paymentRowHasRedirectableCheckoutUrl(row) {
  if (!row) return false;
  if (row.checkout_url) return true;
  const md = parsePaymentMetadata(row.metadata);
  return !!(md.payment_link_url || md.checkout_url);
}

function paymentRowProtectedFromBotCancelNeutralization(row) {
  if (!row) return true;
  const st = String(row.payment_status || '').toLowerCase();
  if (PROTECTED_PAYMENT_STATUSES.has(st)) return true;
  if (Number(row.amount_paid_cents || 0) > 0) return true;
  return false;
}

function paymentRowEligibleForBotCancelNeutralization(row) {
  if (!row || paymentRowProtectedFromBotCancelNeutralization(row)) return false;
  const st = String(row.payment_status || '').toLowerCase();
  if (st === 'cancelled' || st === 'canceled' || st === 'expired') {
    return paymentRowHasRedirectableCheckoutUrl(row);
  }
  return NEUTRALIZABLE_PAYMENT_STATUSES.has(st);
}

function buildBotTestBookingCancelPaymentMetadata(extra) {
  return {
    test_booking_cancelled: true,
    cancelled_at: new Date().toISOString(),
    cancel_reason: 'test_booking_cancelled',
    source: 'bot_booking_cancel',
    ...(extra || {}),
  };
}

function isStripeTestCheckoutSessionId(sessionId) {
  const id = String(sessionId || '').trim();
  return id.startsWith('cs_test_');
}

function sanitizeStripeSessionIdForAudit(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  if (id.startsWith('cs_test_') || id.startsWith('cs_live_')) {
    return `${id.slice(0, 12)}…${id.slice(-4)}`;
  }
  return `${id.slice(0, 8)}…`;
}

module.exports = {
  NEUTRALIZABLE_PAYMENT_STATUSES,
  PROTECTED_PAYMENT_STATUSES,
  paymentRowHasRedirectableCheckoutUrl,
  paymentRowProtectedFromBotCancelNeutralization,
  paymentRowEligibleForBotCancelNeutralization,
  buildBotTestBookingCancelPaymentMetadata,
  isStripeTestCheckoutSessionId,
  sanitizeStripeSessionIdForAudit,
};
