'use strict';

/**
 * Stage 27p — Apply Stripe webhook payment truth for guest hold/payment draft.
 *
 * Reuses the same payment + booking update pattern as
 * handleStripeWebhook (Stage 8.4.11) in staff-query-api.js.
 *
 * No WhatsApp send · no confirmation send · no Meta/n8n.
 */

const fs = require('fs');
const path = require('path');
const { withPgClient } = require('./pg-connect');
const { isStagingResetEnvironment } = require('./luna-test-reset-phone');

const WRITE_SOURCE = 'luna_guest_stage27p';
const REUSED_WEBHOOK_PATH = 'handleStripeWebhook (Stage 8.4.11)';
const DEFAULT_CLIENT = 'wolfhouse-somo';

const ELIGIBLE_PAYMENT_STATUSES = Object.freeze([
  'checkout_created',
  'pending',
]);

const TRUTH_SAFETY = Object.freeze({
  sends_whatsapp: false,
  live_send_blocked: true,
  confirmation_sent: false,
  whatsapp_sent: false,
  calls_n8n: false,
});

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function readEnv(env) {
  return env || process.env;
}

function isGuestStripePaymentTruthEnvironment(env, hostHeader) {
  return isStagingResetEnvironment(env || process.env, hostHeader || '');
}

function confirmPaymentTruthApproved(context) {
  const ctx = context || {};
  return ctx.confirm_payment_truth === true || ctx.confirmPaymentTruth === true;
}

function extractStripeSession(input) {
  const src = input || {};
  if (src.stripe_session && typeof src.stripe_session === 'object') {
    return { session: src.stripe_session, event: src.stripe_event || null };
  }
  const event = src.stripe_event;
  if (event && event.data && event.data.object) {
    return { session: event.data.object, event };
  }
  return { session: null, event: event || null };
}

function isStripeTestSession(session, event) {
  if (event && event.livemode === true) return false;
  if (session && session.livemode === true) return false;
  return true;
}

function stripeEventType(input) {
  const event = (input || {}).stripe_event;
  return event && event.type ? event.type : 'checkout.session.completed';
}

/**
 * Hard gates before payment truth work.
 */
function shouldAllowGuestStripePaymentTruthApply(input, context) {
  const ctx = context || {};
  const env = readEnv(ctx.env);
  const reasons = [];
  const { session, event } = extractStripeSession(input);

  if (!isGuestStripePaymentTruthEnvironment(env, ctx.host_header)) {
    reasons.push('production_or_unknown_environment_blocked');
  }
  if (!confirmPaymentTruthApproved(ctx)) {
    reasons.push('confirm_payment_truth_required');
  }
  if (!session) {
    reasons.push('stripe_session_required');
  }
  if (session && !isStripeTestSession(session, event)) {
    reasons.push('stripe_test_mode_required');
  }
  const evtType = stripeEventType(input);
  if (event && evtType !== 'checkout.session.completed') {
    reasons.push('event_type_not_checkout_session_completed');
  }
  if (!trimStr((input || {}).payment_draft_id) && !(session && session.id)) {
    reasons.push('payment_draft_id_or_session_id_required');
  }

  return { allowed: reasons.length === 0, reasons };
}

function loadClientConfirmationArrival(clientSlug) {
  try {
    const cfgPath = path.join(__dirname, '..', '..', 'config', 'clients', `${clientSlug}.baseline.json`);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return {
      gate_code: cfg.confirmation?.gate_code || cfg.property?.gate_code || null,
      address: cfg.confirmation?.address || cfg.property?.address || null,
    };
  } catch (_) {
    return { gate_code: null, address: null };
  }
}

function buildPaymentConfirmationDraft(pm, bkPayStatus, bkPaidCents, bkBalanceCents) {
  if (bkPayStatus !== 'deposit_paid' && bkPayStatus !== 'paid') return null;
  const arrival = loadClientConfirmationArrival(pm.client_slug || DEFAULT_CLIENT);
  return {
    booking_code: pm.booking_code,
    guest_name: pm.guest_name || null,
    payment_status: bkPayStatus,
    amount_paid_cents: bkPaidCents,
    balance_due_cents: bkBalanceCents,
    room_number: pm.primary_room_code || null,
    address: arrival.address || null,
    gate_code: arrival.gate_code || null,
    sends_whatsapp: false,
    whatsapp_dry_run: true,
  };
}

function buildBlockedResponse(reasons, extra) {
  return {
    success: false,
    ...TRUTH_SAFETY,
    payment_truth_attempted: false,
    payment_truth_recorded: false,
    payment_status: null,
    booking_id: null,
    booking_code: null,
    booking_status: null,
    amount_paid_cents: null,
    balance_due_cents: null,
    stripe_checkout_session_id: null,
    idempotent_replay: false,
    next_safe_step: 'awaiting_payment_truth',
    block_reasons: reasons,
    reused_webhook_path: REUSED_WEBHOOK_PATH,
    staff_notice: 'Payment truth not applied — gates or validation not satisfied. No guest confirmation sent.',
    ...extra,
  };
}

function buildValidationBlockedResponse(pm, session, reasons) {
  return {
    success: false,
    ...TRUTH_SAFETY,
    payment_truth_attempted: true,
    payment_truth_recorded: false,
    payment_status: pm ? pm.payment_status : null,
    booking_id: pm ? pm.booking_id : null,
    booking_code: pm ? pm.booking_code : null,
    booking_status: pm ? pm.booking_status : null,
    amount_paid_cents: null,
    balance_due_cents: pm ? Number(pm.bk_balance || 0) : null,
    stripe_checkout_session_id: session ? session.id : null,
    idempotent_replay: false,
    next_safe_step: 'awaiting_payment_truth',
    block_reasons: reasons,
    reused_webhook_path: REUSED_WEBHOOK_PATH,
    staff_notice: 'Payment truth blocked — Stripe session/payment mismatch. No guest confirmation sent.',
  };
}

function formatIdempotentSuccess(pm) {
  return {
    success: true,
    ...TRUTH_SAFETY,
    payment_truth_attempted: true,
    payment_truth_recorded: true,
    payment_status: 'paid',
    booking_id: pm.booking_id,
    booking_code: pm.booking_code,
    booking_status: pm.booking_status,
    amount_paid_cents: Number(pm.pm_amount_paid || 0),
    balance_due_cents: Number(pm.bk_balance || 0),
    stripe_checkout_session_id: pm.stripe_checkout_session_id,
    idempotent_replay: true,
    next_safe_step: 'ready_for_confirmation_dry_run',
    reused_webhook_path: REUSED_WEBHOOK_PATH,
    staff_notice: 'Payment already marked paid (idempotent replay). Ready for confirmation dry-run — not sent to guest.',
  };
}

function formatAppliedSuccess(pm, session, newPmPaidCents, newBkPaid, newBkBalance, newBkPayStatus) {
  return {
    success: true,
    ...TRUTH_SAFETY,
    payment_truth_attempted: true,
    payment_truth_recorded: true,
    payment_status: 'paid',
    booking_id: pm.booking_id,
    booking_code: pm.booking_code,
    booking_status: pm.booking_status,
    booking_payment_status: newBkPayStatus,
    amount_paid_cents: newPmPaidCents,
    balance_due_cents: newBkBalance,
    booking_amount_paid_cents: newBkPaid,
    stripe_checkout_session_id: session.id,
    idempotent_replay: false,
    next_safe_step: 'ready_for_confirmation_dry_run',
    reused_webhook_path: REUSED_WEBHOOK_PATH,
    staff_notice: 'Stripe payment truth recorded. Ready for confirmation dry-run — no WhatsApp or confirmation sent.',
  };
}

async function fetchPaymentForTruth(pg, paymentDraftId, sessionId) {
  const q = `
    SELECT p.id                     AS payment_id,
           p.booking_id::text       AS booking_id,
           p.client_id,
           p.status::text           AS payment_status,
           p.payment_kind::text     AS payment_kind,
           p.currency,
           p.amount_due_cents,
           p.amount_paid_cents      AS pm_amount_paid,
           p.stripe_checkout_session_id,
           p.metadata               AS payment_metadata,
           b.booking_code,
           b.status::text           AS booking_status,
           b.total_amount_cents     AS bk_total,
           b.amount_paid_cents      AS bk_amount_paid,
           b.balance_due_cents      AS bk_balance,
           b.deposit_required_cents AS bk_deposit,
           b.hold_expires_at,
           b.guest_name,
           b.primary_room_code,
           cl.slug                  AS client_slug
      FROM payments p
      JOIN bookings b  ON b.id  = p.booking_id
      JOIN clients  cl ON cl.id = p.client_id
     WHERE ${paymentDraftId ? 'p.id = $1::uuid' : 'p.stripe_checkout_session_id = $1'}`;
  const r = await pg.query(q, [paymentDraftId || sessionId]);
  return r.rows[0] || null;
}

function validatePaymentForTruth(pm, session, input) {
  const reasons = [];
  if (!pm) {
    reasons.push('payment_not_found');
    return reasons;
  }

  const bookingId = trimStr(input && input.booking_id);
  const bookingCode = trimStr(input && input.booking_code);
  if (bookingId && pm.booking_id !== bookingId) reasons.push('booking_id_mismatch');
  if (bookingCode && pm.booking_code !== bookingCode) reasons.push('booking_code_mismatch');

  if (!pm.booking_id) reasons.push('booking_missing');
  if (pm.payment_status === 'paid' || Number(pm.pm_amount_paid || 0) > 0) {
    return reasons; // handled as idempotent upstream
  }
  if (!ELIGIBLE_PAYMENT_STATUSES.includes(pm.payment_status)) {
    reasons.push(`payment_status_${pm.payment_status}_not_eligible`);
  }
  if (pm.payment_kind === 'addon_service') {
    reasons.push('addon_service_not_supported');
  }
  if ((pm.currency || '').toUpperCase() !== 'EUR') {
    reasons.push('currency_not_eur');
  }
  if (!pm.amount_due_cents || pm.amount_due_cents <= 0) {
    reasons.push('amount_due_invalid');
  }

  const sessionId = session && session.id;
  if (!sessionId) {
    reasons.push('stripe_session_id_missing');
  } else if (pm.stripe_checkout_session_id && pm.stripe_checkout_session_id !== sessionId) {
    reasons.push('stripe_session_id_mismatch');
  }

  const sessionCurrency = (session.currency || 'eur').toUpperCase();
  if (sessionCurrency !== 'EUR') {
    reasons.push('stripe_session_currency_mismatch');
  }

  const stripePaidCents = Number(session.amount_total || 0);
  if (stripePaidCents !== Number(pm.amount_due_cents || 0)) {
    reasons.push('stripe_amount_mismatch');
  }

  if (pm.hold_expires_at && new Date(pm.hold_expires_at) <= new Date()) {
    reasons.push('hold_expired');
  }

  const metaPaymentId = session.metadata && session.metadata.payment_id;
  if (metaPaymentId && metaPaymentId !== pm.payment_id) {
    reasons.push('stripe_metadata_payment_id_mismatch');
  }

  return reasons;
}

async function applyPaymentTruthTransaction(pg, pm, session, event, env, actor, metadataSource) {
  const sessionId = session.id;
  const stripePaidCents = Number(session.amount_total || pm.amount_due_cents || 0);
  const newPmPaidCents = stripePaidCents;
  const prevBkPaid = Number(pm.bk_amount_paid || 0);
  const bkTotal = Number(pm.bk_total || 0);
  const newBkPaid = Math.min(prevBkPaid + stripePaidCents, bkTotal > 0 ? bkTotal : prevBkPaid + stripePaidCents);
  const newBkBalance = bkTotal > 0 ? Math.max(bkTotal - newBkPaid, 0) : 0;

  let newBkPayStatus;
  if (newBkBalance === 0 && bkTotal > 0) {
    newBkPayStatus = 'paid';
  } else if (pm.payment_kind === 'deposit_only') {
    newBkPayStatus = 'deposit_paid';
  } else {
    newBkPayStatus = 'waiting_payment';
  }

  const confirmationDraft = buildPaymentConfirmationDraft(pm, newBkPayStatus, newBkPaid, newBkBalance);
  const skipVerify = readEnv(env).STRIPE_WEBHOOK_SKIP_VERIFY === 'true';

  await pg.query('BEGIN');
  try {
    await pg.query(
      `UPDATE payments
          SET status                   = 'paid'::payment_record_status,
              amount_paid_cents        = $1,
              paid_at                  = NOW(),
              stripe_payment_intent_id = $2,
              metadata                 = metadata || $3::jsonb
        WHERE id = $4`,
      [
        newPmPaidCents,
        session.payment_intent || null,
        JSON.stringify({
          stripe_event_id: event && event.id ? event.id : null,
          stripe_event_type: event && event.type ? event.type : 'checkout.session.completed',
          stripe_session_id: sessionId,
          stripe_livemode: event ? event.livemode : session.livemode,
          skip_verify_used: skipVerify,
          source: metadataSource,
          stage: '27p',
          created_by: actor,
        }),
        pm.payment_id,
      ],
    );

    await pg.query(
      confirmationDraft
        ? `UPDATE bookings
               SET amount_paid_cents = $1,
                   balance_due_cents = $2,
                   payment_status    = $3::payment_status,
                   metadata          = COALESCE(metadata, '{}'::jsonb)
                                       || jsonb_build_object('confirmation_draft', $5::jsonb)
             WHERE id = $4::uuid`
        : `UPDATE bookings
               SET amount_paid_cents = $1,
                   balance_due_cents = $2,
                   payment_status    = $3::payment_status
             WHERE id = $4::uuid`,
      confirmationDraft
        ? [newBkPaid, newBkBalance, newBkPayStatus, pm.booking_id, JSON.stringify(confirmationDraft)]
        : [newBkPaid, newBkBalance, newBkPayStatus, pm.booking_id],
    );

    await pg.query('COMMIT');
  } catch (e) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }

  return { newPmPaidCents, newBkPaid, newBkBalance, newBkPayStatus };
}

/**
 * Stage 27p — apply Stripe payment truth for guest draft payment.
 *
 * @param {{ payment_draft_id?: string, booking_id?: string, booking_code?: string, stripe_event?: object, stripe_session?: object, staff_operator?: string, source?: string }} input
 * @param {{ confirm_payment_truth?: boolean, env?: object, pg?: object, host_header?: string }} context
 */
async function runGuestStripePaymentTruthApplyApproved(input, context) {
  const ctx = context || {};
  const src = input || {};
  const env = readEnv(ctx.env);
  const { session, event } = extractStripeSession(src);

  const allow = shouldAllowGuestStripePaymentTruthApply(src, ctx);
  if (!allow.allowed) {
    return buildBlockedResponse(allow.reasons);
  }

  const paymentDraftId = trimStr(src.payment_draft_id);
  const sessionId = session.id;
  const actor = trimStr(src.staff_operator) || 'luna-guest-stage27p';
  const metadataSource = trimStr(src.source) || WRITE_SOURCE;

  const run = async (pg) => {
    const pm = await fetchPaymentForTruth(pg, paymentDraftId, sessionId);
    if (!pm) {
      return buildBlockedResponse(['payment_not_found']);
    }

    if (pm.payment_status === 'paid' || Number(pm.pm_amount_paid || 0) > 0) {
      return formatIdempotentSuccess(pm);
    }

    const validationReasons = validatePaymentForTruth(pm, session, src);
    if (validationReasons.length) {
      return buildValidationBlockedResponse(pm, session, validationReasons);
    }

    try {
      const amounts = await applyPaymentTruthTransaction(
        pg, pm, session, event, env, actor, metadataSource,
      );
      return formatAppliedSuccess(
        pm, session,
        amounts.newPmPaidCents,
        amounts.newBkPaid,
        amounts.newBkBalance,
        amounts.newBkPayStatus,
      );
    } catch (dbErr) {
      return {
        success: false,
        ...TRUTH_SAFETY,
        payment_truth_attempted: true,
        payment_truth_recorded: false,
        payment_status: pm.payment_status,
        booking_id: pm.booking_id,
        booking_code: pm.booking_code,
        booking_status: pm.booking_status,
        amount_paid_cents: null,
        balance_due_cents: Number(pm.bk_balance || 0),
        stripe_checkout_session_id: sessionId,
        idempotent_replay: false,
        next_safe_step: 'awaiting_payment_truth',
        block_reasons: [`database_error:${dbErr.message}`],
        reused_webhook_path: REUSED_WEBHOOK_PATH,
        staff_notice: 'Payment truth DB update failed. No guest confirmation sent.',
      };
    }
  };

  if (ctx.pg && typeof ctx.pg.query === 'function') {
    return run(ctx.pg);
  }

  try {
    return await withPgClient(run);
  } catch (err) {
    return buildBlockedResponse(['database_unavailable', err.message || 'pg_error']);
  }
}

module.exports = {
  runGuestStripePaymentTruthApplyApproved,
  shouldAllowGuestStripePaymentTruthApply,
  isGuestStripePaymentTruthEnvironment,
  confirmPaymentTruthApproved,
  extractStripeSession,
  validatePaymentForTruth,
  ELIGIBLE_PAYMENT_STATUSES,
  REUSED_WEBHOOK_PATH,
  WRITE_SOURCE,
  TRUTH_SAFETY,
};
