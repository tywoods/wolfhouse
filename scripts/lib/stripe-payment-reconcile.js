'use strict';

/**
 * Webhook-independent Stripe payment reconcile.
 *
 * POST /staff/stripe/webhook is the primary path that marks a payment paid, but
 * it depends on Stripe delivering + signing events to THIS deployment. When that
 * delivery is not configured (common on staging), payments sit at
 * 'checkout_created' forever even though the guest actually paid.
 *
 * This module reconciles by PULLING truth from the Stripe API (checkout session
 * retrieve) using the same secret key that created the link, then applying the
 * exact same payment-truth writes the webhook does. It reuses the shared
 * validation + derivation helpers so the money math cannot drift from the
 * webhook. Payment-truth DB writes ONLY — no WhatsApp / email / n8n side effects.
 */

const {
  validateStripeBookingPaymentEvent,
  bookingMetadataPatchForStripePayment,
  lookupPaymentForStripeSession,
} = require('./stripe-webhook-payment-truth');
const {
  sumCompletedPaymentCentsForBooking,
  deriveBookingPaymentState,
} = require('./luna-booking-payment-totals');

// Payment ledger statuses still awaiting Stripe truth (mirror of the webhook's
// ELIGIBLE_PAYMENT_LEDGER_STATUSES; 'paid' rows are already settled).
const RECONCILE_PENDING_STATUSES = ['draft', 'checkout_created', 'pending'];
const BOOKING_RECONCILE_MAX = 20;
const STRIPE_SESSION_ID_RE = /^cs_[a-zA-Z0-9_]+$/;

function isValidStripeSessionId(sid) {
  return typeof sid === 'string' && STRIPE_SESSION_ID_RE.test(sid.trim());
}

async function listDuplicatePaidFullPaymentSessions(pg, bookingId) {
  const res = await pg.query(
    `SELECT DISTINCT stripe_checkout_session_id AS sid, id::text AS payment_id, amount_paid_cents
       FROM payments
      WHERE booking_id = $1::uuid
        AND status = 'paid'::payment_record_status
        AND payment_kind = 'full_amount'::payment_kind
        AND stripe_checkout_session_id IS NOT NULL`,
    [bookingId],
  );
  const sessions = (res.rows || []).filter((r) => isValidStripeSessionId(r.sid));
  if (sessions.length <= 1) return { duplicate: false, sessions };
  return {
    duplicate: true,
    sessions,
    diagnostic: {
      reason: 'duplicate_full_payment_sessions',
      staff_review_required: true,
      session_count: sessions.length,
      session_ids: sessions.map((s) => s.sid),
      payment_ids: sessions.map((s) => s.payment_id),
    },
  };
}

function buildReconcileConfirmationDraft(pm, newBkPayStatus, newBkPaid, newBkBalance) {
  if (newBkPayStatus !== 'deposit_paid' && newBkPayStatus !== 'paid') return null;
  return {
    booking_code: pm.booking_code,
    guest_name: pm.guest_name || null,
    payment_status: newBkPayStatus,
    amount_paid_cents: newBkPaid,
    balance_due_cents: newBkBalance,
    sends_whatsapp: false,
    whatsapp_dry_run: true,
    source: 'stripe_api_reconcile',
  };
}

/**
 * Apply payment truth for a single already-retrieved Stripe session.
 * Mirrors the POST /staff/stripe/webhook DB writes exactly. Idempotent: a payment
 * already 'paid' is skipped; an unpaid/mismatched session is rejected via the
 * shared validator. Never sends messages.
 */
async function reconcilePaidStripeSession(pg, session, meta) {
  meta = meta || {};
  const eventType = meta.eventType || 'checkout.session.completed';
  if (!session || !session.id) return { ok: false, reconciled: false, reason: 'no_session' };

  const pm = await lookupPaymentForStripeSession(pg, session);
  if (!pm) return { ok: true, reconciled: false, reason: 'no_matching_payment' };
  if (pm.payment_status === 'paid') {
    return { ok: true, reconciled: false, reason: 'already_paid', payment_id: pm.payment_id };
  }
  if (pm.payment_kind === 'addon_service') {
    return { ok: true, reconciled: false, reason: 'addon_service_skipped', payment_id: pm.payment_id };
  }

  const reasons = validateStripeBookingPaymentEvent(pm, session, eventType);
  if (reasons.length > 0) {
    return { ok: false, reconciled: false, reason: 'validation_failed', reasons, payment_id: pm.payment_id };
  }

  const stripePaidCents = Number(session.amount_total || pm.amount_due_cents || 0);
  const prevCompletedPaid = await sumCompletedPaymentCentsForBooking(pg, pm.booking_id, pm.payment_id);
  const bookingTotal = Number(pm.bk_total || 0);
  const alreadyPaid = Number(prevCompletedPaid || 0);
  const remaining = Math.max(bookingTotal - alreadyPaid, 0);
  const cappedStripePaidCents = Math.min(stripePaidCents, remaining);
  const derived = deriveBookingPaymentState({
    bkTotal: pm.bk_total,
    prevCompletedPaidCents: prevCompletedPaid,
    stripePaidCents: cappedStripePaidCents,
    paymentKind: pm.payment_kind,
    amountDueCents: pm.amount_due_cents,
  });
  const { newPmPaidCents, newBkPaid, newBkBalance, newBkPayStatus } = derived;

  const confirmationDraft = buildReconcileConfirmationDraft(pm, newBkPayStatus, newBkPaid, newBkBalance);
  const bkMetaPatch = bookingMetadataPatchForStripePayment(pm, newBkPayStatus);
  const bookingMetaMerge = {};
  if (confirmationDraft) bookingMetaMerge.confirmation_draft = confirmationDraft;
  if (bkMetaPatch) Object.assign(bookingMetaMerge, bkMetaPatch);
  const hasBookingMetaMerge = Object.keys(bookingMetaMerge).length > 0;
  const promotesToConfirmed = newBkPayStatus === 'deposit_paid' || newBkPayStatus === 'paid';
  let duplicateDiagnostic = null;

  await pg.query('BEGIN');
  try {
    await pg.query(
      `SELECT id FROM bookings WHERE id = $1::uuid FOR UPDATE`,
      [pm.booking_id],
    );
    await pg.query(
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
        newPmPaidCents,
        session.payment_intent || null,
        JSON.stringify({
          stripe_event_id: meta.eventId || null,
          stripe_event_type: eventType,
          stripe_session_id: session.id,
          stripe_livemode: meta.livemode || false,
          source: 'stripe_api_reconcile',
        }),
        pm.payment_id,
        pm.client_id,
        session.id,
      ],
    );
    const duplicateCheck = await listDuplicatePaidFullPaymentSessions(pg, pm.booking_id);
    if (duplicateCheck.duplicate) {
      duplicateDiagnostic = duplicateCheck.diagnostic;
      bookingMetaMerge.duplicate_full_payment_diagnostic = duplicateDiagnostic;
    }
    const hasBookingMetaMergeFinal = Object.keys(bookingMetaMerge).length > 0;
    await pg.query(
      hasBookingMetaMergeFinal
        ? `UPDATE bookings
             SET amount_paid_cents = $1,
                 balance_due_cents = $2,
                 payment_status    = $3::payment_status,
                 status            = CASE WHEN status = 'hold' AND $6 THEN 'confirmed'::booking_status ELSE status END,
                 metadata          = COALESCE(metadata, '{}'::jsonb) || $5::jsonb
           WHERE id = $4`
        : `UPDATE bookings
             SET amount_paid_cents = $1,
                 balance_due_cents = $2,
                 payment_status    = $3::payment_status,
                 status            = CASE WHEN status = 'hold' AND $5 THEN 'confirmed'::booking_status ELSE status END
           WHERE id = $4`,
      hasBookingMetaMergeFinal
        ? [newBkPaid, newBkBalance, newBkPayStatus, pm.booking_id, JSON.stringify(bookingMetaMerge), promotesToConfirmed]
        : [newBkPaid, newBkBalance, newBkPayStatus, pm.booking_id, promotesToConfirmed],
    );
    if (pm.booking_guest_id) {
      await pg.query(
        `UPDATE booking_guests
           SET amount_paid_cents = $1, payment_status = 'paid', updated_at = NOW()
         WHERE id = $2`,
        [newPmPaidCents, pm.booking_guest_id],
      );
    }
    await pg.query('COMMIT');
  } catch (e) {
    try { await pg.query('ROLLBACK'); } catch (_) {}
    throw e;
  }

  return {
    ok: true,
    reconciled: true,
    payment_id: pm.payment_id,
    booking_id: pm.booking_id,
    booking_code: pm.booking_code,
    new_bk_payment_status: newBkPayStatus,
    amount_paid_cents: newPmPaidCents,
    duplicate_full_payment_diagnostic: duplicateDiagnostic,
  };
}

/**
 * Reconcile pending Stripe payments for bookings that have a service on `dateIso`.
 * Retrieves each session from the Stripe API and applies truth to paid ones.
 * Best-effort per payment: one failure never aborts the batch. Bounded by `limit`.
 */
async function reconcilePendingStripePaymentsForDate(pg, stripe, opts) {
  opts = opts || {};
  const clientSlug = opts.clientSlug;
  const dateIso = opts.dateIso;
  const limit = Math.min(Number(opts.limit || 25), 100);
  if (!pg || !stripe || !clientSlug || !dateIso) {
    return { ok: false, error: 'clientSlug + dateIso + stripe required', checked: 0, reconciled: 0, results: [] };
  }

  const sel = await pg.query(
    `SELECT DISTINCT p.stripe_checkout_session_id AS sid
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       JOIN clients cl ON cl.id = p.client_id
      WHERE cl.slug = $1
        AND p.stripe_checkout_session_id IS NOT NULL
        AND p.status::text = ANY($2)
        AND EXISTS (
          SELECT 1 FROM booking_service_records sr
           WHERE sr.booking_id = b.id
             AND sr.client_slug = $1
             AND sr.service_date = $3::date
        )
      LIMIT ${limit}`,
    [clientSlug, RECONCILE_PENDING_STATUSES, dateIso],
  );

  const results = [];
  let reconciled = 0;
  for (const row of sel.rows) {
    const sid = row.sid;
    try {
      const session = await stripe.checkout.sessions.retrieve(sid);
      const res = await reconcilePaidStripeSession(pg, session, {
        eventType: 'checkout.session.completed',
        livemode: !!(session && session.livemode),
      });
      if (res.reconciled) reconciled++;
      results.push({ session_id: sid, ...res });
    } catch (e) {
      results.push({
        session_id: sid, ok: false, reconciled: false,
        reason: 'stripe_retrieve_error', error: String((e && e.message) || e).slice(0, 140),
      });
    }
  }
  return { ok: true, checked: sel.rows.length, reconciled, results };
}

/**
 * Reconcile pending Stripe payments for one booking only (drawer / payment-status reads).
 * Scoped to the exact booking — never scans unrelated tenants or dates.
 */
async function reconcilePendingStripePaymentsForBooking(pg, stripe, opts) {
  opts = opts || {};
  const clientSlug = opts.clientSlug;
  const bookingId = opts.bookingId;
  const limit = Math.min(Number(opts.limit || BOOKING_RECONCILE_MAX), BOOKING_RECONCILE_MAX);
  if (!pg || !stripe || !clientSlug || !bookingId) {
    return {
      ok: false,
      error: 'clientSlug + bookingId + stripe required',
      checked: 0,
      reconciled: 0,
      results: [],
      errors: [{ reason: 'missing_inputs' }],
      had_errors: true,
      rows_selected: 0,
      unique_sessions_checked: 0,
      skipped_malformed: 0,
      truncated_pending_count: 0,
    };
  }

  const sel = await pg.query(
    `SELECT p.stripe_checkout_session_id AS sid, p.id::text AS payment_id, p.created_at
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       JOIN clients cl ON cl.id = p.client_id
      WHERE cl.slug = $1
        AND b.id = $2::uuid
        AND p.stripe_checkout_session_id IS NOT NULL
        AND p.status::text = ANY($3)
      ORDER BY p.created_at ASC, p.id ASC`,
    [clientSlug, bookingId, RECONCILE_PENDING_STATUSES],
  );

  const allRows = sel.rows || [];
  let skippedMalformed = 0;
  const seenSessions = new Set();
  const selected = [];
  let eligibleBeyondLimit = 0;
  for (const row of allRows) {
    const sid = String(row.sid || '').trim();
    if (!isValidStripeSessionId(sid)) {
      skippedMalformed += 1;
      continue;
    }
    if (seenSessions.has(sid)) continue;
    seenSessions.add(sid);
    if (selected.length < limit) {
      selected.push({ ...row, sid });
    } else {
      eligibleBeyondLimit += 1;
    }
  }
  const truncatedPendingCount = eligibleBeyondLimit;

  const results = [];
  const errors = [];
  let reconciled = 0;
  for (const row of selected) {
    const sid = row.sid;
    try {
      const session = await stripe.checkout.sessions.retrieve(sid);
      const res = await reconcilePaidStripeSession(pg, session, {
        eventType: 'checkout.session.completed',
        livemode: !!(session && session.livemode),
      });
      if (res.reconciled) reconciled += 1;
      results.push({ session_id: sid, payment_id: row.payment_id, ...res });
      if (!res.ok || (res.reason && res.reason !== 'already_paid' && !res.reconciled)) {
        errors.push({ session_id: sid, payment_id: row.payment_id, reason: res.reason, reasons: res.reasons || null });
      }
      if (res.duplicate_full_payment_diagnostic) {
        errors.push({
          session_id: sid,
          payment_id: row.payment_id,
          reason: 'duplicate_full_payment_sessions',
          diagnostic: res.duplicate_full_payment_diagnostic,
        });
      }
    } catch (e) {
      const err = {
        session_id: sid,
        payment_id: row.payment_id,
        ok: false,
        reconciled: false,
        reason: 'stripe_retrieve_error',
        error: String((e && e.message) || e).slice(0, 140),
      };
      results.push(err);
      errors.push(err);
    }
  }
  return {
    ok: true,
    checked: selected.length,
    reconciled,
    results,
    errors,
    had_errors: errors.length > 0,
    rows_selected: allRows.length,
    unique_sessions_checked: selected.length,
    skipped_malformed: skippedMalformed,
    truncated_pending_count: truncatedPendingCount,
  };
}

module.exports = {
  RECONCILE_PENDING_STATUSES,
  BOOKING_RECONCILE_MAX,
  isValidStripeSessionId,
  listDuplicatePaidFullPaymentSessions,
  reconcilePaidStripeSession,
  reconcilePendingStripePaymentsForDate,
  reconcilePendingStripePaymentsForBooking,
};
