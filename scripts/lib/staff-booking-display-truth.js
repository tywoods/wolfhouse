'use strict';

const { isStaffAccommodationMeta, isIsoDate } = require('./sunset-accommodation-price-resolver');
const { PAYMENT_COLLECTED_SCOPE_SQL } = require('./sunset-staff-money-scope');

function staffBookingStayDates(booking, services) {
  const meta = (raw) => {
    if (raw && typeof raw === 'object') return raw;
    try { return JSON.parse(raw || '{}') || {}; } catch (_) { return {}; }
  };
  let stays = (services || []).filter((s) => !['cancelled', 'canceled'].includes(String(s.status || '')))
    .map((s) => meta(s.metadata)).filter(isStaffAccommodationMeta);
  if (!stays.length) {
    const accommodation = meta(booking.metadata).accommodation;
    stays = accommodation ? (Array.isArray(accommodation.stays) ? accommodation.stays : [accommodation]) : [];
  }
  stays = stays.filter((s) => s && isIsoDate(s.check_in) && isIsoDate(s.check_out) && s.check_in < s.check_out);
  // Do not flatten nonconsecutive stays into a fictitious continuous stay.
  const unique = [...new Map(stays.map((s) => [s.check_in + '/' + s.check_out, s])).values()];
  return unique.length === 1
    ? { check_in: unique[0].check_in, check_out: unique[0].check_out }
    : { check_in: booking.check_in, check_out: booking.check_out };
}

// Read-only display projection. Never writes booking/payment state or creates links.
// A settled ledger aggregate wins over the denormalized booking paid amount.
// No settled rows: retain the existing legacy/manual booking-amount fallback.
function staffPaymentDisplayStatus(total, paid, remaining) {
  if (total == null || paid == null) return 'unknown';
  const due = remaining == null ? Math.max(total - paid, 0) : remaining;
  if (due === 0 && (total > 0 || paid > 0)) return 'paid';
  if (paid > 0) return 'partial';
  return 'unpaid';
}

function buildStaffBookingDisplayTruth(booking, services, collectedCents) {
  const number = (value) => value == null || value === '' || !Number.isFinite(Number(value))
    ? null : Number(value);
  // Reuse Bookings' persisted-total fallback, including signed custom lines.
  // Resolve at call time: Bookings also imports the display status/date helpers.
  const { computeChargedCents } = require('./sunset-bookings-admin');
  const total = computeChargedCents(booking, services);
  const paid = number(collectedCents) ?? number(booking.amount_paid_cents) ?? 0;
  return {
    payment_status: staffPaymentDisplayStatus(total, paid),
    total_amount_cents: total,
    amount_paid_cents: paid,
    balance_due_cents: total == null || paid == null ? null : Math.max(total - paid, 0),
    ...staffBookingStayDates(booking, services),
  };
}

const STAFF_BOOKING_DISPLAY_TRUTH_SQL = `
SELECT b.id::text AS booking_id, b.check_in::text, b.check_out::text,
       b.total_amount_cents, b.amount_paid_cents, b.metadata,
       (SELECT SUM(p.amount_paid_cents) FROM payments p
         WHERE p.booking_id = b.id AND p.client_id = b.client_id
           AND p.status::text = 'paid'
           ${PAYMENT_COLLECTED_SCOPE_SQL}) AS collected_cents,
       (SELECT jsonb_agg(jsonb_build_object('metadata', s.metadata, 'status', s.status,
                                          'amount_due_cents', s.amount_due_cents))
          FROM booking_service_records s
         WHERE s.booking_id = b.id AND s.client_slug = c.slug) AS services
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1 AND b.id = ANY($2::uuid[])
`;

async function hydrateStaffBookingDisplayTruth(pg, clientSlug, rows) {
  const ids = [...new Set((rows || []).filter(Boolean).map((r) => r.booking_id).filter(Boolean))];
  if (!ids.length) return;
  const result = await pg.query(STAFF_BOOKING_DISPLAY_TRUTH_SQL, [clientSlug, ids]);
  const byId = new Map(result.rows.map((b) => [b.booking_id,
    buildStaffBookingDisplayTruth(b, b.services || [], b.collected_cents)]));
  for (const row of rows) {
    if (!row || !byId.has(row.booking_id)) continue;
    const truth = byId.get(row.booking_id);
    Object.assign(row, truth, {
      display_truth: truth,
      booking_payment_status: truth.payment_status,
      payment_amount_paid_cents: truth.amount_paid_cents,
      // Historical field name; Guests uses it as remaining collection balance.
      payment_amount_due_cents: truth.balance_due_cents,
    });
  }
}

module.exports = { staffPaymentDisplayStatus, staffBookingStayDates, buildStaffBookingDisplayTruth,
  hydrateStaffBookingDisplayTruth, STAFF_BOOKING_DISPLAY_TRUTH_SQL };
