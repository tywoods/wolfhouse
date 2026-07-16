'use strict';

/**
 * Shared Stripe payment-truth hold→confirmed promote policy.
 *
 * Used by POST /staff/stripe/webhook and stripe-payment-reconcile so the two
 * paths cannot drift.
 *
 * Correct transaction boundary (caller owns BEGIN/COMMIT/ROLLBACK):
 *   1. Lock booking (id + client_id) FOR UPDATE
 *   2. Lock/reload payment (id + client_id) FOR UPDATE
 *   3. If payment already paid → idempotent return (no second auto-send)
 *   4. Revalidate locked payment vs Stripe session (fail closed; no stale fields)
 *   5. Sum completed payments scoped by client_id (exclude this payment)
 *   6. Derive booking money totals under the locks from locked payment fields
 *   7. Decide promote / auto-confirmation from locked booking status + DB expiry
 *   8. Apply payment / booking / guest writes
 *
 * Invariant: Stripe money is persisted only when the locked payment still matches
 * the session; expired/terminal bookings never silently promote or revive;
 * unknown non-bookable statuses fail closed for auto-confirmation.
 */

const {
  sumCompletedPaymentCentsForBooking,
  deriveBookingPaymentState,
} = require('./luna-booking-payment-totals');
const {
  ELIGIBLE_PAYMENT_LEDGER_STATUSES,
} = require('./stripe-webhook-payment-truth');

const PAYMENT_AFTER_HOLD_EXPIRY_META_KEY = 'payment_after_hold_expiry';
const PAYMENT_ON_TERMINAL_BOOKING_META_KEY = 'payment_on_terminal_booking';

/** Statuses that may still receive intentional payment confirmation. */
const AUTO_CONFIRM_ELIGIBLE_STATUSES = new Set([
  'confirmed',
  'payment_pending',
  'checked_in',
]);

const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);

/** Stable diagnostic codes for under-lock payment revalidation failures. */
const LOCKED_PAYMENT_VALIDATION_CODES = Object.freeze({
  STATUS_NOT_ELIGIBLE: 'locked_payment_status_not_eligible',
  BOOKING_MISMATCH: 'locked_payment_booking_mismatch',
  CLIENT_MISMATCH: 'locked_payment_client_mismatch',
  KIND_ADDON: 'locked_payment_kind_addon_service',
  CURRENCY_NOT_EUR: 'locked_payment_currency_not_eur',
  SESSION_CURRENCY_MISMATCH: 'locked_stripe_session_currency_mismatch',
  AMOUNT_DUE_INVALID: 'locked_amount_due_invalid',
  STRIPE_AMOUNT_MISMATCH: 'locked_stripe_amount_mismatch',
  SESSION_REPLACED: 'locked_stripe_session_replaced',
  METADATA_PAYMENT_ID_MISMATCH: 'locked_stripe_metadata_payment_id_mismatch',
});

function isLockedPaymentValidationError(err) {
  return !!(err && (err.locked_payment_validation === true
    || (err.code && String(err.code).startsWith('locked_'))));
}

function throwLockedPaymentValidation(code, extraReasons) {
  const reasons = Array.isArray(extraReasons) && extraReasons.length
    ? extraReasons
    : [code];
  const err = new Error(code);
  err.code = code;
  err.reasons = reasons;
  err.locked_payment_validation = true;
  throw err;
}

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

function buildPaymentOnTerminalBookingMetadata(locked, reason) {
  return {
    [PAYMENT_ON_TERMINAL_BOOKING_META_KEY]: {
      reason,
      booking_status_at_payment: locked && locked.booking_status ? locked.booking_status : null,
      policy: 'stripe_hold_promote_policy',
    },
  };
}

/**
 * Lock the booking row for payment-truth mutation. Scoped by trusted client_id.
 */
async function lockBookingForStripePaymentTruth(pg, { bookingId, clientId }) {
  if (!pg || !bookingId || !clientId) return null;
  const res = await pg.query(
    `SELECT id::text AS booking_id,
            status::text AS booking_status,
            hold_expires_at,
            (hold_expires_at IS NOT NULL AND hold_expires_at < NOW()) AS hold_expired_by_db,
            total_amount_cents AS bk_total,
            amount_paid_cents AS bk_amount_paid,
            balance_due_cents AS bk_balance,
            deposit_required_cents AS bk_deposit
       FROM bookings
      WHERE id = $1::uuid
        AND client_id = $2
      FOR UPDATE`,
    [bookingId, clientId],
  );
  return (res.rows && res.rows[0]) || null;
}

/**
 * Lock/reload the target payment under the same transaction.
 */
async function lockPaymentForStripePaymentTruth(pg, { paymentId, clientId }) {
  if (!pg || !paymentId || !clientId) return null;
  const res = await pg.query(
    `SELECT id::text AS payment_id,
            booking_id::text AS booking_id,
            client_id::text AS client_id,
            booking_guest_id::text AS booking_guest_id,
            status::text AS payment_status,
            payment_kind::text AS payment_kind,
            currency,
            amount_due_cents,
            amount_paid_cents AS pm_amount_paid,
            stripe_checkout_session_id
       FROM payments
      WHERE id = $1::uuid
        AND client_id = $2
      FOR UPDATE`,
    [paymentId, clientId],
  );
  return (res.rows && res.rows[0]) || null;
}

/**
 * Revalidate the locked payment row against the Stripe session and trusted
 * original booking/client context. Must run after FOR UPDATE and before any
 * aggregation or money writes. Uses ONLY locked payment fields for kind,
 * amount, currency, and session binding — never stale pre-lock snapshots.
 *
 * @param {object} lockedPayment
 * @param {object} session
 * @param {{ expectedBookingId: string, expectedClientId: string }} ctx
 * @returns {{ ok: true } | never} — throws locked_payment_validation on failure
 */
function validateLockedPaymentForStripeTruth(lockedPayment, session, ctx) {
  const expectedBookingId = ctx && ctx.expectedBookingId;
  const expectedClientId = ctx && ctx.expectedClientId;
  const reasons = [];

  if (!lockedPayment) {
    throwLockedPaymentValidation(LOCKED_PAYMENT_VALIDATION_CODES.STATUS_NOT_ELIGIBLE, [
      'locked_payment_missing',
    ]);
  }

  const status = String(lockedPayment.payment_status || '');
  if (!ELIGIBLE_PAYMENT_LEDGER_STATUSES.includes(status)) {
    reasons.push(LOCKED_PAYMENT_VALIDATION_CODES.STATUS_NOT_ELIGIBLE);
    reasons.push(`payment_status_${status || 'empty'}_not_eligible`);
  }

  if (String(lockedPayment.booking_id) !== String(expectedBookingId)) {
    reasons.push(LOCKED_PAYMENT_VALIDATION_CODES.BOOKING_MISMATCH);
  }
  if (String(lockedPayment.client_id) !== String(expectedClientId)) {
    reasons.push(LOCKED_PAYMENT_VALIDATION_CODES.CLIENT_MISMATCH);
  }

  const paymentKind = String(lockedPayment.payment_kind || '');
  if (paymentKind === 'addon_service') {
    reasons.push(LOCKED_PAYMENT_VALIDATION_CODES.KIND_ADDON);
  }

  const payCurrency = String(lockedPayment.currency || '').toUpperCase();
  if (payCurrency !== 'EUR') {
    reasons.push(LOCKED_PAYMENT_VALIDATION_CODES.CURRENCY_NOT_EUR);
  }
  const sessionCurrency = String((session && session.currency) || 'eur').toUpperCase();
  if (sessionCurrency !== 'EUR') {
    reasons.push(LOCKED_PAYMENT_VALIDATION_CODES.SESSION_CURRENCY_MISMATCH);
  }

  const amountDue = Number(lockedPayment.amount_due_cents);
  if (!Number.isFinite(amountDue) || amountDue <= 0) {
    reasons.push(LOCKED_PAYMENT_VALIDATION_CODES.AMOUNT_DUE_INVALID);
  }

  const stripePaidCents = Number(session && session.amount_total);
  if (!Number.isFinite(stripePaidCents) || stripePaidCents <= 0) {
    reasons.push(LOCKED_PAYMENT_VALIDATION_CODES.STRIPE_AMOUNT_MISMATCH);
    reasons.push('stripe_amount_missing');
  } else if (Number.isFinite(amountDue) && amountDue > 0 && stripePaidCents !== amountDue) {
    reasons.push(LOCKED_PAYMENT_VALIDATION_CODES.STRIPE_AMOUNT_MISMATCH);
  }

  const lockedSessionId = lockedPayment.stripe_checkout_session_id
    ? String(lockedPayment.stripe_checkout_session_id)
    : '';
  const sessionId = session && session.id ? String(session.id) : '';
  if (lockedSessionId && sessionId && lockedSessionId !== sessionId) {
    reasons.push(LOCKED_PAYMENT_VALIDATION_CODES.SESSION_REPLACED);
  }

  const metaPaymentId = session && session.metadata && session.metadata.payment_id
    ? String(session.metadata.payment_id)
    : '';
  const lockedPaymentId = String(lockedPayment.payment_id || '');
  const sessionBindingAuthoritative = !!(lockedSessionId && sessionId && lockedSessionId === sessionId);
  if (metaPaymentId && metaPaymentId !== lockedPaymentId && !sessionBindingAuthoritative) {
    reasons.push(LOCKED_PAYMENT_VALIDATION_CODES.METADATA_PAYMENT_ID_MISMATCH);
  }

  if (reasons.length) {
    // Prefer the first stable locked_* code as err.code for logging.
    const primary = reasons.find((r) => String(r).startsWith('locked_')) || reasons[0];
    throwLockedPaymentValidation(primary, reasons);
  }
  return { ok: true };
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
      payment_on_terminal_booking: false,
      allow_auto_confirmation: false,
      reason: 'booking_lock_miss',
      fail_closed: true,
      metadata_patch: null,
    };
  }

  const status = String(locked.booking_status || '');

  if (CANCELLED_STATUSES.has(status)) {
    return {
      promote_to_confirmed: false,
      payment_after_hold_expiry: false,
      payment_on_terminal_booking: true,
      allow_auto_confirmation: false,
      reason: 'booking_cancelled',
      fail_closed: false,
      metadata_patch: buildPaymentOnTerminalBookingMetadata(locked, 'cancelled'),
    };
  }

  if (status === 'expired') {
    return {
      promote_to_confirmed: false,
      payment_after_hold_expiry: true,
      payment_on_terminal_booking: true,
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
        payment_on_terminal_booking: false,
        allow_auto_confirmation: false,
        reason: 'hold_expired',
        fail_closed: false,
        metadata_patch: buildPaymentAfterHoldExpiryMetadata(locked, 'hold_expired'),
      };
    }
    return {
      promote_to_confirmed: moneyOk,
      payment_after_hold_expiry: false,
      payment_on_terminal_booking: false,
      allow_auto_confirmation: moneyOk,
      reason: moneyOk ? 'hold_promote_ok' : 'hold_money_not_promoting',
      fail_closed: false,
      metadata_patch: null,
    };
  }

  if (AUTO_CONFIRM_ELIGIBLE_STATUSES.has(status)) {
    return {
      promote_to_confirmed: false,
      payment_after_hold_expiry: false,
      payment_on_terminal_booking: false,
      allow_auto_confirmation: moneyOk,
      reason: 'non_hold_preserve',
      fail_closed: false,
      metadata_patch: null,
    };
  }

  // Unknown / non-bookable (needs_review, blocked, …): record money, never auto-confirm,
  // never change terminal/non-bookable status.
  return {
    promote_to_confirmed: false,
    payment_after_hold_expiry: false,
    payment_on_terminal_booking: true,
    allow_auto_confirmation: false,
    reason: 'non_bookable_status',
    fail_closed: false,
    metadata_patch: buildPaymentOnTerminalBookingMetadata(locked, 'non_bookable_status'),
  };
}

/**
 * Apply payment + booking (+ optional booking_guest) truth under an already-open
 * transaction. Caller owns BEGIN/COMMIT/ROLLBACK and must BEGIN before calling.
 *
 * Derivation of money totals happens ONLY after booking + payment locks are held.
 *
 * @param {object} opts.pm — payment lookup row (payment_id, booking_id, client_id, …)
 * @param {object} opts.session — Stripe Checkout Session
 * @param {number} opts.stripePaidCents — session amount (raw); reconcile may pass capped
 * @param {boolean} [opts.capStripeToRemaining=false] — reconcile path caps to remaining due
 * @param {object} opts.paymentMetadataPatch
 * @param {(ctx) => object|null|Promise<object|null>} [opts.buildBookingMetaMerge]
 * @param {(pg) => Promise<{bookingMetaMerge?: object}|null|void>} [opts.afterPaymentPaid]
 */
async function applyStripeBookingPaymentTruthWrites(pg, opts) {
  const pm = opts && opts.pm;
  const session = (opts && opts.session) || {};
  const paymentMetadataPatch = (opts && opts.paymentMetadataPatch) || {};
  const rawStripePaid = Number(
    opts && opts.stripePaidCents != null
      ? opts.stripePaidCents
      : (session.amount_total || (pm && pm.amount_due_cents) || 0),
  );
  const capStripeToRemaining = !!(opts && opts.capStripeToRemaining);

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

  const lockedPayment = await lockPaymentForStripePaymentTruth(pg, {
    paymentId: pm.payment_id,
    clientId: pm.client_id,
  });
  if (!lockedPayment) {
    const err = new Error('payment_lock_miss');
    err.code = 'payment_lock_miss';
    throw err;
  }

  if (lockedPayment.payment_status === 'paid') {
    return {
      ok: true,
      already_paid: true,
      idempotent: true,
      decision: {
        promote_to_confirmed: false,
        payment_after_hold_expiry: false,
        payment_on_terminal_booking: false,
        allow_auto_confirmation: false,
        reason: 'already_paid_under_lock',
        fail_closed: false,
        metadata_patch: null,
      },
      locked,
      lockedPayment,
      money: null,
    };
  }

  // Fail closed before aggregation/writes when the locked row no longer matches
  // the Stripe session that was validated against the pre-lock snapshot.
  validateLockedPaymentForStripeTruth(lockedPayment, session, {
    expectedBookingId: pm.booking_id,
    expectedClientId: pm.client_id,
  });

  const prevCompletedPaid = await sumCompletedPaymentCentsForBooking(
    pg,
    pm.booking_id,
    pm.payment_id,
    pm.client_id,
  );

  // Authoritative money fields come ONLY from the locked payment + locked booking.
  const bkTotal = locked.bk_total;
  const paymentKind = lockedPayment.payment_kind;
  const amountDueCents = lockedPayment.amount_due_cents;

  let stripePaidCents = Number(session.amount_total);
  if (!Number.isFinite(stripePaidCents) || stripePaidCents <= 0) {
    stripePaidCents = Number(rawStripePaid);
  }
  if (capStripeToRemaining) {
    const bookingTotal = Number(bkTotal || 0);
    const remaining = Math.max(bookingTotal - Number(prevCompletedPaid || 0), 0);
    stripePaidCents = Math.min(stripePaidCents, remaining);
  }

  const derived = deriveBookingPaymentState({
    bkTotal,
    prevCompletedPaidCents: prevCompletedPaid,
    stripePaidCents,
    paymentKind,
    amountDueCents,
  });
  const money = {
    newPmPaidCents: derived.newPmPaidCents,
    newBkPaid: derived.newBkPaid,
    newBkBalance: derived.newBkBalance,
    newBkPayStatus: derived.newBkPayStatus,
  };

  const decision = decideStripeHoldPromote(locked, { newBkPayStatus: money.newBkPayStatus });
  if (decision.fail_closed) {
    const err = new Error(decision.reason);
    err.code = decision.reason;
    throw err;
  }

  const bookingMetaMerge = {};
  if (typeof opts.buildBookingMetaMerge === 'function') {
    const built = await opts.buildBookingMetaMerge({
      money,
      decision,
      locked,
      lockedPayment,
      pm,
    });
    if (built && typeof built === 'object') Object.assign(bookingMetaMerge, built);
  }
  if (decision.metadata_patch) {
    Object.assign(bookingMetaMerge, decision.metadata_patch);
  }
  if (decision.payment_after_hold_expiry || decision.payment_on_terminal_booking) {
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

  // Guest linkage is taken from the locked payment only (no stale pre-lock id).
  const guestId = lockedPayment.booking_guest_id || null;
  if (guestId) {
    const gUpd = await pg.query(
      `UPDATE booking_guests
           SET amount_paid_cents = $1,
               payment_status = 'paid',
               updated_at = NOW()
         WHERE id = $2::uuid
           AND client_id = $3
           AND booking_id = $4::uuid`,
      [money.newPmPaidCents, guestId, pm.client_id, pm.booking_id],
    );
    if (!gUpd.rowCount) {
      const err = new Error('booking_guest_update_client_scope_miss');
      err.code = 'booking_guest_update_client_scope_miss';
      throw err;
    }
  }

  return {
    ok: true,
    already_paid: false,
    idempotent: false,
    decision,
    locked,
    lockedPayment,
    money,
    prevCompletedPaidCents: prevCompletedPaid,
  };
}

module.exports = {
  PAYMENT_AFTER_HOLD_EXPIRY_META_KEY,
  PAYMENT_ON_TERMINAL_BOOKING_META_KEY,
  AUTO_CONFIRM_ELIGIBLE_STATUSES,
  CANCELLED_STATUSES,
  LOCKED_PAYMENT_VALIDATION_CODES,
  coerceDbBool,
  isLockedPaymentValidationError,
  buildPaymentAfterHoldExpiryMetadata,
  buildPaymentOnTerminalBookingMetadata,
  lockBookingForStripePaymentTruth,
  lockPaymentForStripePaymentTruth,
  validateLockedPaymentForStripeTruth,
  decideStripeHoldPromote,
  applyStripeBookingPaymentTruthWrites,
};
