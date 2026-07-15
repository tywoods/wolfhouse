'use strict';

/**
 * Stripe checkout.session payment truth — lookup + validation helpers for
 * POST /staff/stripe/webhook (Stage 8.4.11). Shared by staff-query-api and tests.
 */

const STRIPE_BOOKING_PAYMENT_EVENT_TYPES = Object.freeze([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

const ELIGIBLE_PAYMENT_LEDGER_STATUSES = Object.freeze([
  'draft',
  'checkout_created',
  'pending',
]);

const PAYMENT_LOOKUP_SQL = `
  SELECT p.id                     AS payment_id,
         p.booking_id,
         p.client_id,
         p.booking_guest_id,
         p.status                 AS payment_status,
         p.payment_kind,
         p.currency,
         p.amount_due_cents,
         p.amount_paid_cents      AS pm_amount_paid,
         p.stripe_checkout_session_id,
         p.metadata                 AS payment_metadata,
         b.booking_code,
         b.total_amount_cents     AS bk_total,
         b.amount_paid_cents      AS bk_amount_paid,
         b.balance_due_cents      AS bk_balance,
         b.deposit_required_cents AS bk_deposit,
         b.guest_name,
         b.primary_room_code,
         b.status::text           AS booking_status,
         b.hold_expires_at,
         (SELECT bb.room_code
            FROM booking_beds bb
           WHERE bb.booking_id = b.id
           ORDER BY bb.created_at ASC
           LIMIT 1)              AS assigned_room_code,
         COALESCE(
           NULLIF(TRIM(b.metadata->'guest'->>'phone'), ''),
           NULLIF(TRIM(b.phone), '')
         )                        AS guest_phone,
         cl.slug                  AS client_slug
    FROM payments p
    JOIN bookings b  ON b.id = p.booking_id AND b.client_id = p.client_id
    JOIN clients  cl ON cl.id = p.client_id`;

async function lookupPaymentForStripeSession(pg, session) {
  if (!pg || !session || !session.id) return null;
  const sessionId = session.id;
  const metaPaymentId = session.metadata && session.metadata.payment_id;

  const bySession = await pg.query(
    `${PAYMENT_LOOKUP_SQL}
     WHERE p.stripe_checkout_session_id = $1
     LIMIT 1`,
    [sessionId],
  );
  if (bySession.rows[0]) {
    return bySession.rows[0];
  }

  if (metaPaymentId) {
    const byMeta = await pg.query(
      `${PAYMENT_LOOKUP_SQL}
       WHERE p.id = $1::uuid
       LIMIT 1`,
      [metaPaymentId],
    );
    return byMeta.rows[0] || null;
  }

  return null;
}

function validateStripeBookingPaymentEvent(pm, session, eventType) {
  const reasons = [];
  if (!pm) {
    reasons.push('payment_not_found');
    return reasons;
  }
  if (pm.payment_status === 'paid') {
    return reasons;
  }
  if (!ELIGIBLE_PAYMENT_LEDGER_STATUSES.includes(pm.payment_status)) {
    reasons.push(`payment_status_${pm.payment_status}_not_eligible`);
  }
  if (pm.payment_kind === 'addon_service') {
    reasons.push('addon_service_use_addon_path');
  }

  const sessionPayStatus = String(session.payment_status || '').toLowerCase();
  if (sessionPayStatus !== 'paid') {
    reasons.push('stripe_session_not_paid');
  }

  const sessionStatus = String(session.status || '').toLowerCase();
  if (eventType === 'checkout.session.completed' && sessionStatus && sessionStatus !== 'complete') {
    reasons.push('stripe_session_not_complete');
  }

  if ((pm.currency || '').toUpperCase() !== 'EUR') {
    reasons.push('payment_currency_not_eur');
  }
  const sessionCurrency = String(session.currency || 'eur').toUpperCase();
  if (sessionCurrency !== 'EUR') {
    reasons.push('stripe_session_currency_mismatch');
  }

  const amountDue = Number(pm.amount_due_cents || 0);
  if (amountDue <= 0) {
    reasons.push('amount_due_invalid');
  }

  const stripePaidCents = Number(session.amount_total || 0);
  if (stripePaidCents <= 0) {
    reasons.push('stripe_amount_missing');
  } else if (stripePaidCents !== amountDue) {
    reasons.push('stripe_amount_mismatch');
  }

  const metaPaymentId = session.metadata && session.metadata.payment_id;
  if (metaPaymentId && metaPaymentId !== pm.payment_id && pm.stripe_checkout_session_id !== session.id) {
    reasons.push('stripe_metadata_payment_id_mismatch');
  }

  const metaClientSlug = session.metadata && session.metadata.client_slug;
  if (metaClientSlug && metaClientSlug !== pm.client_slug) {
    reasons.push('stripe_metadata_client_slug_mismatch');
  }

  if (pm.stripe_checkout_session_id && pm.stripe_checkout_session_id !== session.id) {
    reasons.push('stripe_session_id_mismatch');
  }

  return reasons;
}

function bookingMetadataPatchForStripePayment(pm, newBkPayStatus) {
  if (newBkPayStatus !== 'paid' && newBkPayStatus !== 'deposit_paid') {
    return null;
  }
  const patch = {
    sunset_stripe_link_stale: false,
  };
  if (pm.client_slug === 'sunset' && newBkPayStatus === 'paid') {
    patch.sunset_payment_method = 'link';
  }
  return patch;
}

module.exports = {
  STRIPE_BOOKING_PAYMENT_EVENT_TYPES,
  ELIGIBLE_PAYMENT_LEDGER_STATUSES,
  lookupPaymentForStripeSession,
  validateStripeBookingPaymentEvent,
  bookingMetadataPatchForStripePayment,
};
