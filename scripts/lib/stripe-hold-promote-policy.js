'use strict';

/**
 * Shared Stripe payment-truth hold→confirmed promote policy.
 *
 * Used by POST /staff/stripe/webhook and stripe-payment-reconcile so the two
 * paths cannot drift. Invariant:
 *   Stripe-confirmed money is always persisted, but an expired hold (or an
 *   already-expired booking) must never silently promote/revive to confirmed.
 *
 * Expiry is decided from database time under a FOR UPDATE lock — never client clocks.
 */

const PAYMENT_AFTER_HOLD_EXPIRY_META_KEY = 'payment_after_hold_expiry';

function coerceDbBool(value) {
  return value === true || value === 't' || value === 'true' || value === 1 || value === '1';
}

function buildPaymentAfterHoldExpiryMetadata(locked, reason) {
  return {
    [PAYMENT_AFTER_HOLD_EXPIRY_META_KEY]: {
      reason,
      booking_status_at_payment: locked && locked.booking_status ? locked.booking_status : null,
      hold_expires_at: locked && locked.hold_expires_at != null ? locked.hold_expires_at : null,
      recorded_via_db_clock: true,
      policy: 'stripe_hold_promote_policy',
    },
  };
}

/**
 * Lock the booking row for payment-truth mutation. Scoped by trusted client_id.
 * @returns {Promise<object|null>}
 */
async function lockBookingForStripePaymentTruth(pg, { bookingId, clientId }) {
  if (!pg || !bookingId || !clientId) return null;
  const res = await pg.query(
    `SELECT id::text AS booking_id,
            status::text AS booking_status,
            hold_expires_at,
            (hold_expires_at IS NOT NULL AND hold_expires_at < NOW()) AS hold_expired_by_db
       FROM bookings
      WHERE id = $1::uuid
        AND client_id = $2
      FOR UPDATE`,
    [bookingId, clientId],
  );
  return (res.rows && res.rows[0]) || null;
}

/**
 * Pure policy decision from a locked booking snapshot + derived money status.
 */
function decideStripeHoldPromote(locked, money) {
  const newBkPayStatus = money && money.newBkPayStatus;
  const moneyOk = newBkPayStatus === 'deposit_paid' || newBkPayStatus === 'paid';

  if (!locked) {
    return {
      promote_to_confirmed: false,
      payment_after_hold_expiry: false,
      allow_auto_confirmation: false,
      reason: 'booking_lock_miss',
      fail_closed: true,
      metadata_patch: null,
    };
  }

  const status = String(locked.booking_status || '');

  if (status === 'expired') {
    return {
      promote_to_confirmed: false,
      payment_after_hold_expiry: true,
      allow_auto_confirmation: false,
      reason: 'booking_already_expired',
      fail_closed: false,
      metadata_patch: buildPaymentAfterHoldExpiryMetadata(locked, 'booking_already_expired'),
    };
  }

  if (status === 'hold') {
    if (coerceDbBool(locked.hold_expired_by_db)) {
      return {
        promote_to_confirmed: false,
        payment_after_hold_expiry: true,
        allow_auto_confirmation: false,
        reason: 'hold_expired',
        fail_closed: false,
        metadata_patch: buildPaymentAfterHoldExpiryMetadata(locked, 'hold_expired'),
      };
    }
    return {
      promote_to_confirmed: moneyOk,
      payment_after_hold_expiry: false,
      allow_auto_confirmation: moneyOk,
      reason: moneyOk ? 'hold_promote_ok' : 'hold_money_not_promoting',
      fail_closed: false,
      metadata_patch: null,
    };
  }

  // confirmed / payment_pending / cancelled / checked_in / etc. — preserve non-hold status
  return {
    promote_to_confirmed: false,
    payment_after_hold_expiry: false,
    allow_auto_confirmation: moneyOk,
    reason: 'non_hold_preserve',
    fail_closed: false,
    metadata_patch: null,
  };
}

/**
 * Apply payment + booking (+ optional booking_guest) truth under an already-open
 * transaction. Caller owns BEGIN/COMMIT/ROLLBACK.
 *
 * @param {object} pg
 * @param {object} opts
 * @param {object} opts.pm — payment lookup row (must include payment_id, booking_id, client_id)
 * @param {object} opts.session — Stripe Checkout Session
 * @param {object} opts.paymentMetadataPatch — merged into payments.metadata
 * @param {{ newPmPaidCents, newBkPaid, newBkBalance, newBkPayStatus }} opts.money
 * @param {object} [opts.bookingMetaMerge]
 * @param {(pg: object) => Promise<{ bookingMetaMerge?: object }|null|void>} [opts.afterPaymentPaid]
 */
async function applyStripeBookingPaymentTruthWrites(pg, opts) {
  const pm = opts && opts.pm;
  const session = (opts && opts.session) || {};
  const money = (opts && opts.money) || {};
  const paymentMetadataPatch = (opts && opts.paymentMetadataPatch) || {};
  const bookingMetaMerge = Object.assign({}, (opts && opts.bookingMetaMerge) || {});

  if (!pm || !pm.payment_id || !pm.booking_id || !pm.client_id) {
    const err = new Error('payment_truth_inputs_incomplete');
    err.code = 'payment_truth_inputs_incomplete';
    throw err;
  }

  const locked = await lockBookingForStripePaymentTruth(pg, {
    bookingId: pm.booking_id,
    clientId: pm.client_id,
  });
  if (!locked) {
    const err = new Error('booking_lock_miss');
    err.code = 'booking_lock_miss';
    throw err;
  }

  const decision = decideStripeHoldPromote(locked, { newBkPayStatus: money.newBkPayStatus });
  if (decision.fail_closed) {
    const err = new Error(decision.reason);
    err.code = decision.reason;
    throw err;
  }

  if (decision.metadata_patch) {
    Object.assign(bookingMetaMerge, decision.metadata_patch);
  }
  if (decision.payment_after_hold_expiry) {
    delete bookingMetaMerge.confirmation_draft;
  }

  const payUpd = await pg.query(
    `UPDATE payments
         SET status                     = 'paid'::payment_record_status,
             amount_paid_cents          = $1,
             paid_at                    = NOW(),
             stripe_payment_intent_id   = $2,
             stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, $6),
             metadata                   = metadata || $3::jsonb
       WHERE id = $4
         AND client_id = $5`,
    [
      money.newPmPaidCents,
      session.payment_intent || null,
      JSON.stringify(paymentMetadataPatch),
      pm.payment_id,
      pm.client_id,
      session.id || null,
    ],
  );
  if (!payUpd.rowCount) {
    const err = new Error('payment_update_client_scope_miss');
    err.code = 'payment_update_client_scope_miss';
    throw err;
  }

  if (typeof opts.afterPaymentPaid === 'function') {
    const extra = await opts.afterPaymentPaid(pg);
    if (extra && extra.bookingMetaMerge && typeof extra.bookingMetaMerge === 'object') {
      Object.assign(bookingMetaMerge, extra.bookingMetaMerge);
    }
  }

  const hasMerge = Object.keys(bookingMetaMerge).length > 0;
  const promote = decision.promote_to_confirmed === true;
  let bkUpd;
  if (hasMerge) {
    bkUpd = await pg.query(
      `UPDATE bookings
           SET amount_paid_cents = $1,
               balance_due_cents = $2,
               payment_status    = $3::payment_status,
               status            = CASE WHEN status = 'hold' AND $6 THEN 'confirmed'::booking_status ELSE status END,
               metadata          = COALESCE(metadata, '{}'::jsonb) || $5::jsonb
         WHERE id = $4::uuid
           AND client_id = $7`,
      [
        money.newBkPaid,
        money.newBkBalance,
        money.newBkPayStatus,
        pm.booking_id,
        JSON.stringify(bookingMetaMerge),
        promote,
        pm.client_id,
      ],
    );
  } else {
    bkUpd = await pg.query(
      `UPDATE bookings
           SET amount_paid_cents = $1,
               balance_due_cents = $2,
               payment_status    = $3::payment_status,
               status            = CASE WHEN status = 'hold' AND $5 THEN 'confirmed'::booking_status ELSE status END
         WHERE id = $4::uuid
           AND client_id = $6`,
      [
        money.newBkPaid,
        money.newBkBalance,
        money.newBkPayStatus,
        pm.booking_id,
        promote,
        pm.client_id,
      ],
    );
  }
  if (!bkUpd.rowCount) {
    const err = new Error('booking_update_client_scope_miss');
    err.code = 'booking_update_client_scope_miss';
    throw err;
  }

  if (pm.booking_guest_id) {
    const gUpd = await pg.query(
      `UPDATE booking_guests
           SET amount_paid_cents = $1,
               payment_status = 'paid',
               updated_at = NOW()
         WHERE id = $2::uuid
           AND client_id = $3
           AND booking_id = $4::uuid`,
      [money.newPmPaidCents, pm.booking_guest_id, pm.client_id, pm.booking_id],
    );
    if (!gUpd.rowCount) {
      const err = new Error('booking_guest_update_client_scope_miss');
      err.code = 'booking_guest_update_client_scope_miss';
      throw err;
    }
  }

  return {
    ok: true,
    decision,
    locked,
  };
}

module.exports = {
  PAYMENT_AFTER_HOLD_EXPIRY_META_KEY,
  coerceDbBool,
  buildPaymentAfterHoldExpiryMetadata,
  lockBookingForStripePaymentTruth,
  decideStripeHoldPromote,
  applyStripeBookingPaymentTruthWrites,
};
