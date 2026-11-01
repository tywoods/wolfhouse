'use strict';

/**
 * Staff Portal booking cancel — same locked unpaid-cancel sequence as guest
 * unpaid cancellation, with Staff authorization instead of guest phone ownership.
 * Never refunds captured money. Never reports success that did not happen.
 */

const {
  classifyGuestCancellationPaymentEvidence,
  executeStaffUnpaidCancellationBoundary,
  STAFF_CANCEL_PAYMENT_EVIDENCE_SQL,
  STAFF_CANCEL_BOOKING_UPDATE_SQL,
} = require('./guest-unpaid-cancellation');

const MONEY_OR_RACE_REASONS = new Set([
  'payment_exists',
  'booking_has_collected_money',
  'payment_race_or_evidence_changed',
  'payment_evidence_inconsistent',
  'cancelled_booking_has_collectible_payment',
  'collectible_payment_for_cancelled_booking',
]);

function cancelReasonToken(err) {
  if (!err) return '';
  if (typeof err === 'string') return err.trim();
  return String(err.reason || err.message || err.code || '').trim();
}

function explainStaffBookingCancelError(err) {
  const raw = cancelReasonToken(err);
  if (raw === 'cancelled_booking_has_collectible_payment') {
    return 'This booking still has an open unpaid payment or payment link. Cancel cannot finish until those unpaid rows are closed.';
  }
  if (raw === 'collectible_payment_for_cancelled_booking') {
    return 'A payment row still looks collectible on a cancelled booking.';
  }
  if (raw === 'payment_exists' || raw === 'booking_has_collected_money') {
    return 'This booking has collected money. Cancel from here cannot refund it.';
  }
  if (raw === 'payment_race_or_evidence_changed') {
    return 'Payment evidence changed while cancelling. Nothing was cancelled.';
  }
  if (raw === 'payment_evidence_inconsistent') {
    return 'Payment records for this booking do not match. Cancel stopped.';
  }
  if (raw === 'booking_not_found') {
    return 'Booking not found.';
  }
  if (!raw || raw === 'cancel failed') {
    return 'Could not cancel this booking.';
  }
  return 'Could not cancel this booking: ' + raw;
}

function staffCancelConflictStatus(err) {
  const raw = cancelReasonToken(err);
  if (MONEY_OR_RACE_REASONS.has(raw)) return 409;
  if (String((err && err.message) || '').includes('cancelled_booking_has_collectible_payment')) return 409;
  if (String((err && err.message) || '').includes('collectible_payment_for_cancelled_booking')) return 409;
  return 500;
}

module.exports = {
  STAFF_CANCEL_PAYMENT_EVIDENCE_SQL,
  STAFF_CANCEL_BOOKING_UPDATE_SQL,
  classifyGuestCancellationPaymentEvidence,
  explainStaffBookingCancelError,
  staffCancelConflictStatus,
  executeStaffUnpaidCancellationBoundary,
};
