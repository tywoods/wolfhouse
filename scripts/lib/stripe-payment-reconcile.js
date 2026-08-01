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
  applyStripeBookingPaymentTruthWrites,
  isLockedPaymentValidationError,
} = require('./stripe-hold-promote-policy');
// Money math lives inside applyStripeBookingPaymentTruthWrites (under locks).

// Payment ledger statuses still awaiting Stripe truth (mirror of the webhook's
// ELIGIBLE_PAYMENT_LEDGER_STATUSES; 'paid' rows are already settled).
const RECONCILE_PENDING_STATUSES = ['draft', 'checkout_created', 'pending'];
const BOOKING_RECONCILE_MAX = 20;
const STRIPE_SESSION_ID_RE = /^cs_[a-zA-Z0-9_]+$/;

function isValidStripeSessionId(sid) {
  return typeof sid === 'string' && STRIPE_SESSION_ID_RE.test(sid.trim());
}

async function listDuplicatePaidFullPaymentSessions(pg, bookingId, clientId) {
  const params = [bookingId];
  let clientPred = '';
  if (clientId) {
    clientPred = ' AND client_id = $2';
    params.push(clientId);
  }
  const res = await pg.query(
    `SELECT DISTINCT stripe_checkout_session_id AS sid, id::text AS payment_id, amount_paid_cents
       FROM payments
      WHERE booking_id = $1::uuid
        AND status = 'paid'::payment_record_status
        AND payment_kind = 'full_amount'::payment_kind
        AND stripe_checkout_session_id IS NOT NULL${clientPred}`,
    params,
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
 * Mirrors the POST /staff/stripe/webhook DB writes exactly. Already-paid booking
 * payments enter the shared apply helper under lock for identity validation.
 * Never sends messages.
 */
async function reconcilePaidStripeSession(pg, session, meta) {
  meta = meta || {};
  const eventType = meta.eventType || 'checkout.session.completed';
  if (!session || !session.id) return { ok: false, reconciled: false, reason: 'no_session' };

  const expectedClientSlug = typeof meta.expectedClientSlug === 'string'
    ? meta.expectedClientSlug.trim()
    : '';
  if (!expectedClientSlug) {
    return {
      ok: false,
      reconciled: false,
      reason: 'expected_client_slug_required',
      no_db_write: true,
    };
  }

  const lookup = await lookupPaymentForStripeSession(pg, session, expectedClientSlug);
  if (!lookup.ok) {
    return {
      ok: false,
      reconciled: false,
      reason: lookup.reason || 'lookup_rejected',
      queried: lookup.queried === true,
      no_db_write: true,
    };
  }
  const pm = lookup.payment;
  if (!pm) return { ok: true, reconciled: false, reason: 'no_matching_payment' };
  if (pm.payment_kind === 'addon_service') {
    return { ok: true, reconciled: false, reason: 'addon_service_skipped', payment_id: pm.payment_id };
  }

  const reasons = validateStripeBookingPaymentEvent(pm, session, eventType, expectedClientSlug);
  if (reasons.length > 0) {
    return { ok: false, reconciled: false, reason: 'validation_failed', reasons, payment_id: pm.payment_id };
  }

  const stripePaidCents = Number(session.amount_total || pm.amount_due_cents || 0);
  let duplicateDiagnostic = null;
  let paymentTruthResult = null;

  await pg.query('BEGIN');
  try {
    paymentTruthResult = await applyStripeBookingPaymentTruthWrites(pg, {
      pm,
      session,
      stripePaidCents,
      capStripeToRemaining: true,
      paymentMetadataPatch: {
        stripe_event_id: meta.eventId || null,
        stripe_event_type: eventType,
        stripe_session_id: session.id,
        stripe_livemode: meta.livemode || false,
        source: 'stripe_api_reconcile',
      },
      buildBookingMetaMerge: ({ money, decision }) => {
        const merge = {};
        if (decision.allow_auto_confirmation) {
          const draft = buildReconcileConfirmationDraft(
            pm,
            money.newBkPayStatus,
            money.newBkPaid,
            money.newBkBalance,
          );
          if (draft) merge.confirmation_draft = draft;
        }
        const bkMetaPatch = bookingMetadataPatchForStripePayment(pm, money.newBkPayStatus);
        if (bkMetaPatch) Object.assign(merge, bkMetaPatch);
        return merge;
      },
      afterPaymentPaid: async (pgInner) => {
        const duplicateCheck = await listDuplicatePaidFullPaymentSessions(
          pgInner,
          pm.booking_id,
          pm.client_id,
        );
        if (duplicateCheck.duplicate) {
          duplicateDiagnostic = duplicateCheck.diagnostic;
          return {
            bookingMetaMerge: {
              duplicate_full_payment_diagnostic: duplicateDiagnostic,
            },
          };
        }
        return null;
      },
    });
    await pg.query('COMMIT');
  } catch (e) {
    try { await pg.query('ROLLBACK'); } catch (_) {}
    if (isLockedPaymentValidationError(e)) {
      return {
        ok: false,
        reconciled: false,
        reason: 'locked_payment_validation_failed',
        code: e.code || e.message,
        reasons: e.reasons || [e.code || e.message],
        payment_id: pm.payment_id,
        booking_id: pm.booking_id,
        no_whatsapp: true,
        no_confirmation_sent: true,
        no_db_write: true,
      };
    }
    throw e;
  }

  if (paymentTruthResult && paymentTruthResult.already_paid) {
    return {
      ok: true,
      reconciled: false,
      reason: 'already_paid',
      payment_id: pm.payment_id,
      no_whatsapp: true,
      no_confirmation_sent: true,
    };
  }

  const money = paymentTruthResult && paymentTruthResult.money;
  const decision = paymentTruthResult && paymentTruthResult.decision;
  return {
    ok: true,
    reconciled: true,
    payment_id: pm.payment_id,
    booking_id: pm.booking_id,
    booking_code: pm.booking_code,
    new_bk_payment_status: money ? money.newBkPayStatus : null,
    amount_paid_cents: money ? money.newPmPaidCents : null,
    duplicate_full_payment_diagnostic: duplicateDiagnostic,
    payment_after_hold_expiry: !!(decision && decision.payment_after_hold_expiry),
    payment_on_terminal_booking: !!(decision && decision.payment_on_terminal_booking),
    hold_promote_reason: decision ? decision.reason : null,
    hold_promoted_to_confirmed: !!(decision && decision.promote_to_confirmed),
    no_whatsapp: true,
    no_confirmation_sent: true,
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
        expectedClientSlug: clientSlug,
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
        expectedClientSlug: clientSlug,
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

// ── Advisory schedule-day reconcile (non-blocking + light throttle) ──────────
// handleSunsetScheduleDayGet must not await Stripe RTT. Kick background work and
// throttle rapid reload storms to once per (clientSlug+date) per ~2 minutes.
const RECONCILE_DATE_THROTTLE_MS = 2 * 60 * 1000;
const _reconcileDateLastKickMs = new Map();

function reconcileDateThrottleKey(clientSlug, dateIso) {
  return `${String(clientSlug || '').trim()}::${String(dateIso || '').trim()}`;
}

/** Test seam — clears in-memory throttle map. */
function resetReconcileDateThrottleForTests() {
  _reconcileDateLastKickMs.clear();
}

/**
 * @returns {boolean} true when a new kick is allowed (and records the kick time).
 */
function shouldKickReconcileForDate(clientSlug, dateIso, nowMs) {
  const key = reconcileDateThrottleKey(clientSlug, dateIso);
  if (!clientSlug || !dateIso || key === '::' || key.startsWith('::') || key.endsWith('::')) {
    return false;
  }
  const now = nowMs != null ? Number(nowMs) : Date.now();
  const last = _reconcileDateLastKickMs.get(key);
  if (last != null && (now - last) < RECONCILE_DATE_THROTTLE_MS) {
    return false;
  }
  _reconcileDateLastKickMs.set(key, now);
  // Bound map growth under many distinct dates.
  if (_reconcileDateLastKickMs.size > 512) {
    const cutoff = now - (RECONCILE_DATE_THROTTLE_MS * 2);
    for (const [k, t] of _reconcileDateLastKickMs) {
      if (t < cutoff) _reconcileDateLastKickMs.delete(k);
    }
  }
  return true;
}

/**
 * Fire-and-forget advisory reconcile. Never awaits `runner`. Swallows rejections.
 * @param {() => (any|Promise<any>)} runner
 * @param {{ clientSlug?: string, dateIso?: string, nowMs?: number }} [opts]
 * @returns {{ kicked: boolean, reason?: string }}
 */
function kickAdvisoryReconcilePendingStripePaymentsForDate(runner, opts) {
  opts = opts || {};
  const clientSlug = opts.clientSlug;
  const dateIso = opts.dateIso;
  if (!clientSlug || !dateIso) {
    return { kicked: false, reason: 'missing_inputs' };
  }
  if (typeof runner !== 'function') {
    return { kicked: false, reason: 'no_runner' };
  }
  if (!shouldKickReconcileForDate(clientSlug, dateIso, opts.nowMs)) {
    return { kicked: false, reason: 'throttled' };
  }
  try {
    Promise.resolve()
      .then(() => runner())
      .catch(() => { /* advisory — never surface */ });
  } catch (_) {
    return { kicked: false, reason: 'sync_throw' };
  }
  return { kicked: true };
}

module.exports = {
  RECONCILE_PENDING_STATUSES,
  BOOKING_RECONCILE_MAX,
  RECONCILE_DATE_THROTTLE_MS,
  isValidStripeSessionId,
  listDuplicatePaidFullPaymentSessions,
  reconcilePaidStripeSession,
  reconcilePendingStripePaymentsForDate,
  reconcilePendingStripePaymentsForBooking,
  reconcileDateThrottleKey,
  resetReconcileDateThrottleForTests,
  shouldKickReconcileForDate,
  kickAdvisoryReconcilePendingStripePaymentsForDate,
};
