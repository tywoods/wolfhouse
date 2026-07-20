'use strict';

/**
 * Stripe checkout.session payment truth — lookup + validation helpers for
 * POST /staff/stripe/webhook (Stage 8.4.11). Shared by staff-query-api and tests.
 *
 * FORTRESS Slice 15B: lookup and validation bind to an authoritative
 * expectedClientSlug (deployment/runtime). Stripe metadata is never tenant
 * authority. Both session-id and metadata.payment_id SELECTs are scoped by
 * exact cl.slug ownership via parameterization.
 */

const { trimSlug } = require('./stripe-webhook-tenant-config');

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

/**
 * Look up a payment for a Stripe Checkout Session, scoped to expectedClientSlug.
 *
 * Session-id path is authoritative inside the expected tenant and may accept
 * absent metadata.client_slug. Metadata.payment_id fallback requires
 * metadata.client_slug present and exactly equal to expectedClientSlug before
 * any DB query (fail closed; no existence leak on absent/mismatch).
 *
 * @returns {{
 *   ok: boolean,
 *   payment: object|null,
 *   reason: string|null,
 *   queried: boolean,
 *   lookup_path: string|null,
 * }}
 */
async function lookupPaymentForStripeSession(pg, session, expectedClientSlug) {
  const slug = trimSlug(expectedClientSlug);
  if (!slug) {
    return {
      ok: false,
      payment: null,
      reason: 'expected_client_slug_required',
      queried: false,
      lookup_path: null,
    };
  }
  if (!pg || !session || !session.id) {
    return {
      ok: false,
      payment: null,
      reason: 'invalid_session',
      queried: false,
      lookup_path: null,
    };
  }

  const sessionId = session.id;
  const metaPaymentId = session.metadata && session.metadata.payment_id
    ? trimSlug(session.metadata.payment_id)
    : '';
  const metaClientSlug = session.metadata && session.metadata.client_slug
    ? trimSlug(session.metadata.client_slug)
    : '';

  const bySession = await pg.query(
    `${PAYMENT_LOOKUP_SQL}
     WHERE p.stripe_checkout_session_id = $1
       AND cl.slug = $2
     LIMIT 1`,
    [sessionId, slug],
  );
  if (bySession.rows[0]) {
    const row = bySession.rows[0];
    if (trimSlug(row.client_slug) !== slug) {
      return {
        ok: false,
        payment: null,
        reason: 'payment_client_slug_mismatch',
        queried: true,
        lookup_path: 'session_id',
      };
    }
    return {
      ok: true,
      payment: row,
      reason: null,
      queried: true,
      lookup_path: 'session_id',
    };
  }

  if (!metaPaymentId) {
    return {
      ok: true,
      payment: null,
      reason: 'payment_not_found',
      queried: true,
      lookup_path: null,
    };
  }

  // Metadata-ID fallback: require metadata.client_slug === expected before ANY query.
  if (!metaClientSlug) {
    return {
      ok: false,
      payment: null,
      reason: 'metadata_client_slug_required',
      queried: false,
      lookup_path: null,
    };
  }
  if (metaClientSlug !== slug) {
    return {
      ok: false,
      payment: null,
      reason: 'metadata_client_slug_mismatch',
      queried: false,
      lookup_path: null,
    };
  }

  const byMeta = await pg.query(
    `${PAYMENT_LOOKUP_SQL}
     WHERE p.id = $1::uuid
       AND cl.slug = $2
     LIMIT 1`,
    [metaPaymentId, slug],
  );
  const row = byMeta.rows[0] || null;
  if (row && trimSlug(row.client_slug) !== slug) {
    return {
      ok: false,
      payment: null,
      reason: 'payment_client_slug_mismatch',
      queried: true,
      lookup_path: 'metadata_payment_id',
    };
  }
  return {
    ok: true,
    payment: row,
    reason: row ? null : 'payment_not_found',
    queried: true,
    lookup_path: row ? 'metadata_payment_id' : null,
  };
}

/**
 * Validate Stripe session against a looked-up payment row.
 * Independently requires pm.client_slug === expectedClientSlug (metadata is not authority).
 * Retains metadata mismatch / session / amount / status checks.
 *
 * @param {object|null} pm
 * @param {object} session
 * @param {string} eventType
 * @param {string} expectedClientSlug
 * @returns {string[]}
 */
function validateStripeBookingPaymentEvent(pm, session, eventType, expectedClientSlug) {
  const reasons = [];
  const slug = trimSlug(expectedClientSlug);
  if (!slug) {
    reasons.push('expected_client_slug_required');
    return reasons;
  }
  if (!pm) {
    reasons.push('payment_not_found');
    return reasons;
  }
  if (trimSlug(pm.client_slug) !== slug) {
    reasons.push('payment_client_slug_mismatch');
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
  PAYMENT_LOOKUP_SQL,
  lookupPaymentForStripeSession,
  validateStripeBookingPaymentEvent,
  bookingMetadataPatchForStripePayment,
};
