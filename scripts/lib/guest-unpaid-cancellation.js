'use strict';

const KNOWN_UNPAID_BOOKING_STATUSES = new Set(['not_requested', 'waiting_payment', 'unpaid', 'pending', 'failed']);

function finiteNonNegativeInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function classifyGuestCancellationPaymentEvidence(row) {
  if (!row || row.booking_found !== true) return { eligible: false, reason: 'booking_not_found' };
  if (row.phone_matches !== true) return { eligible: false, reason: 'booking_not_owned' };
  if (row.evidence_consistent !== true) return { eligible: false, reason: 'payment_evidence_inconsistent' };

  const status = typeof row.booking_payment_status === 'string'
    ? row.booking_payment_status.trim().toLowerCase()
    : '';
  const values = [
    row.booking_amount_paid_cents,
    row.booking_deposit_paid_cents,
    row.payment_row_count,
    row.payment_positive_count,
    row.payment_captured_count,
    row.payment_unknown_status_count,
    row.payment_event_paid_count,
    row.guest_row_count,
    row.guest_positive_count,
    row.guest_paid_status_count,
    row.guest_unknown_status_count,
    row.guest_unknown_amount_count,
  ].map(finiteNonNegativeInt);
  if (!KNOWN_UNPAID_BOOKING_STATUSES.has(status) || values.some((n) => n === null)) {
    return { eligible: false, reason: 'payment_evidence_unknown' };
  }
  const [bookingPaid, depositPaid, paymentRows, paymentPositive, paymentCaptured, paymentUnknown, paymentEventPaid,
    , guestPositive, guestPaid, guestUnknown, guestUnknownAmount] = values;
  if (paymentUnknown > 0 || guestUnknown > 0 || guestUnknownAmount > 0) {
    return { eligible: false, reason: 'payment_evidence_unknown' };
  }
  if (paymentRows > 0 || bookingPaid > 0 || depositPaid > 0 || paymentPositive > 0 || paymentCaptured > 0 || paymentEventPaid > 0 || guestPositive > 0 || guestPaid > 0) {
    return { eligible: false, reason: 'payment_exists' };
  }
  return { eligible: true, reason: 'authoritative_zero_payment' };
}

const GUEST_CANCEL_PAYMENT_EVIDENCE_SQL = `
SELECT TRUE AS booking_found,
       regexp_replace(COALESCE(b.phone, ''), '[^0-9]', '', 'g') = regexp_replace($3, '[^0-9]', '', 'g') AS phone_matches,
       b.id::text AS booking_id,
       b.client_id::text AS client_id,
       b.booking_code,
       b.status::text AS booking_status,
       b.payment_status::text AS booking_payment_status,
       b.amount_paid_cents AS booking_amount_paid_cents,
       b.deposit_paid_cents AS booking_deposit_paid_cents,
       (SELECT COUNT(*)::int FROM payments p WHERE p.client_id=b.client_id AND p.booking_id=b.id) AS payment_row_count,
       (SELECT COUNT(*)::int FROM payments p WHERE p.client_id=b.client_id AND p.booking_id=b.id AND COALESCE(p.amount_paid_cents,0)>0) AS payment_positive_count,
       (SELECT COUNT(*)::int FROM payments p WHERE p.client_id=b.client_id AND p.booking_id=b.id AND LOWER(COALESCE(p.status::text,'')) IN ('paid','succeeded','partially_paid','captured')) AS payment_captured_count,
       (SELECT COUNT(*)::int FROM payments p WHERE p.client_id=b.client_id AND p.booking_id=b.id AND LOWER(COALESCE(p.status::text,'')) NOT IN ('not_requested','waiting_payment','pending','created','open','draft','checkout_created','unpaid','failed','cancelled','canceled','expired','paid','succeeded','partially_paid','captured')) AS payment_unknown_status_count,
       (SELECT COUNT(*)::int FROM payment_events pe WHERE pe.client_id=b.client_id AND (pe.booking_id=b.id OR EXISTS (SELECT 1 FROM payments ep WHERE ep.client_id=b.client_id AND ep.booking_id=b.id AND ep.id=pe.payment_id)) AND LOWER(COALESCE(pe.event_type,'')) IN ('checkout.session.completed','checkout.session.async_payment_succeeded','payment_intent.succeeded','charge.succeeded','payment_intent.amount_capturable_updated')) AS payment_event_paid_count,
       (SELECT COUNT(*)::int FROM booking_guests bg WHERE bg.client_id=b.client_id AND bg.booking_id=b.id) AS guest_row_count,
       (SELECT COUNT(*)::int FROM booking_guests bg WHERE bg.client_id=b.client_id AND bg.booking_id=b.id AND COALESCE(bg.amount_paid_cents,0)>0) AS guest_positive_count,
       (SELECT COUNT(*)::int FROM booking_guests bg WHERE bg.client_id=b.client_id AND bg.booking_id=b.id AND LOWER(COALESCE(bg.payment_status,'')) IN ('paid','deposit_paid','partially_paid','succeeded','captured')) AS guest_paid_status_count,
       (SELECT COUNT(*)::int FROM booking_guests bg WHERE bg.client_id=b.client_id AND bg.booking_id=b.id AND LOWER(COALESCE(bg.payment_status,'')) NOT IN ('not_requested','waiting_payment','pending','created','open','draft','checkout_created','unpaid','failed','cancelled','canceled','expired','paid','deposit_paid','partially_paid','succeeded','captured')) AS guest_unknown_status_count,
       (SELECT COUNT(*)::int FROM booking_guests bg WHERE bg.client_id=b.client_id AND bg.booking_id=b.id AND bg.amount_paid_cents IS NULL) AS guest_unknown_amount_count,
       NOT (
         (COALESCE(b.amount_paid_cents,0)=0 AND COALESCE(b.deposit_paid_cents,0)=0 AND LOWER(COALESCE(b.payment_status::text,'')) IN ('deposit_paid','partially_paid','paid'))
         OR (COALESCE(b.amount_paid_cents,0)>0 AND LOWER(COALESCE(b.payment_status::text,'')) IN ('not_requested','waiting_payment','unpaid','pending','failed'))
       ) AS evidence_consistent
FROM bookings b
JOIN clients c ON c.id=b.client_id
WHERE c.slug=$1 AND UPPER(b.booking_code)=UPPER($2)
FOR UPDATE OF b
`;

const GUEST_CANCEL_BOOKING_UPDATE_SQL = `
UPDATE bookings b
SET status = 'cancelled'::booking_status
FROM clients c
WHERE b.client_id=c.id
  AND c.slug=$1
  AND b.id::text=$2
  AND regexp_replace(COALESCE(b.phone,''), '[^0-9]', '', 'g') = regexp_replace($3, '[^0-9]', '', 'g')
  AND b.amount_paid_cents=0
  AND b.deposit_paid_cents=0
  AND LOWER(COALESCE(b.payment_status::text,'')) IN ('not_requested','waiting_payment','unpaid','pending','failed')
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.client_id=b.client_id AND p.booking_id=b.id)
  AND NOT EXISTS (SELECT 1 FROM payment_events pe WHERE pe.client_id=b.client_id AND (pe.booking_id=b.id OR EXISTS (SELECT 1 FROM payments ep WHERE ep.client_id=b.client_id AND ep.booking_id=b.id AND ep.id=pe.payment_id)) AND LOWER(COALESCE(pe.event_type,'')) IN ('checkout.session.completed','checkout.session.async_payment_succeeded','payment_intent.succeeded','charge.succeeded','payment_intent.amount_capturable_updated'))
  AND NOT EXISTS (SELECT 1 FROM booking_guests bg WHERE bg.client_id=b.client_id AND bg.booking_id=b.id AND (bg.amount_paid_cents IS NULL OR bg.amount_paid_cents>0 OR LOWER(COALESCE(bg.payment_status,'')) NOT IN ('not_requested','waiting_payment','pending','created','open','draft','checkout_created','unpaid','failed','cancelled','canceled','expired')))
RETURNING b.id::text AS booking_id, b.booking_code, b.status::text AS status
`;

const GUEST_CANCEL_PAYMENT_ROWS_LOCK_SQL = `
SELECT p.id FROM payments p WHERE p.client_id=$1::uuid AND p.booking_id=$2::uuid FOR UPDATE
`;
const GUEST_CANCEL_GUEST_ROWS_LOCK_SQL = `
SELECT bg.id FROM booking_guests bg WHERE bg.client_id=$1::uuid AND bg.booking_id=$2::uuid FOR UPDATE
`;
const GUEST_CANCEL_PAYMENT_EVENT_ROWS_LOCK_SQL = `
SELECT pe.id FROM payment_events pe
WHERE pe.client_id=$1::uuid
  AND (pe.booking_id=$2::uuid OR EXISTS (
    SELECT 1 FROM payments p
    WHERE p.client_id=$1::uuid AND p.booking_id=$2::uuid AND p.id=pe.payment_id
  ))
FOR UPDATE
`;

async function executeGuestUnpaidCancellationBoundary(pg, { clientSlug, bookingCode, phone }) {
  const initialRes = await pg.query(GUEST_CANCEL_PAYMENT_EVIDENCE_SQL, [clientSlug, bookingCode, phone]);
  const initialRow = initialRes.rows[0] || null;
  if (!initialRow) return { blocked: true, reason: 'booking_not_owned' };
  await pg.query(GUEST_CANCEL_PAYMENT_ROWS_LOCK_SQL, [initialRow.client_id, initialRow.booking_id]);
  await pg.query(GUEST_CANCEL_GUEST_ROWS_LOCK_SQL, [initialRow.client_id, initialRow.booking_id]);
  await pg.query(GUEST_CANCEL_PAYMENT_EVENT_ROWS_LOCK_SQL, [initialRow.client_id, initialRow.booking_id]);
  const evidenceRes = await pg.query(GUEST_CANCEL_PAYMENT_EVIDENCE_SQL, [clientSlug, bookingCode, phone]);
  const evidenceRow = evidenceRes.rows[0] || null;
  const decision = classifyGuestCancellationPaymentEvidence(evidenceRow);
  if (!decision.eligible) return { blocked: true, reason: decision.reason };
  const updateRes = await pg.query(GUEST_CANCEL_BOOKING_UPDATE_SQL, [clientSlug, evidenceRow.booking_id, phone]);
  if (!updateRes.rows[0]) return { blocked: true, reason: 'payment_race_or_evidence_changed' };
  return { blocked: false, evidenceRow, updatedRow: updateRes.rows[0] };
}

module.exports = {
  KNOWN_UNPAID_BOOKING_STATUSES,
  classifyGuestCancellationPaymentEvidence,
  GUEST_CANCEL_PAYMENT_EVIDENCE_SQL,
  GUEST_CANCEL_BOOKING_UPDATE_SQL,
  GUEST_CANCEL_PAYMENT_ROWS_LOCK_SQL,
  GUEST_CANCEL_GUEST_ROWS_LOCK_SQL,
  GUEST_CANCEL_PAYMENT_EVENT_ROWS_LOCK_SQL,
  executeGuestUnpaidCancellationBoundary,
};
