'use strict';

/**
 * Shared Sunset Staff money scope — Finance + Bookings KPI parity.
 *
 * Staff API / ledger is authority. Do not invent amounts.
 * Keep payment collected exclusions identical on Finance summary and Bookings KPIs.
 *
 * Collected / Net (cash):
 *   paid payments with paid_at, excluding test-cancelled, finance_exclusion,
 *   and schedule-deleted markers (migration 053).
 * Outstanding / Booked (operational):
 *   exclude cancelled / expired / hold bookings (and canceled spelling).
 */

const BOOKING_STATUS_EXCLUSIONS = Object.freeze([
  'cancelled',
  'canceled',
  'expired',
  'hold',
]);

/** SQL `IN (...)` list matching BOOKING_STATUS_EXCLUSIONS. */
const BOOKING_STATUS_EXCLUSIONS_SQL = "('cancelled', 'canceled', 'expired', 'hold')";

/**
 * Payment rows eligible for collected / gross / net.
 * Assumes payments aliased as `p`. Status predicate stays caller-owned
 * (`p.status = 'paid'` vs `p.status = 'paid'::payment_record_status`).
 */
const PAYMENT_COLLECTED_SCOPE_SQL = [
  'AND p.paid_at IS NOT NULL',
  "AND COALESCE((p.metadata->>'test_booking_cancelled')::boolean, false) = false",
  'AND p.finance_exclusion IS NULL',
  "AND COALESCE((p.metadata->>'schedule_booking_deleted')::boolean, false) = false",
].join('\n     ');

function isExcludedBookingStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return BOOKING_STATUS_EXCLUSIONS.indexOf(s) !== -1;
}

module.exports = {
  BOOKING_STATUS_EXCLUSIONS,
  BOOKING_STATUS_EXCLUSIONS_SQL,
  PAYMENT_COLLECTED_SCOPE_SQL,
  isExcludedBookingStatus,
};
