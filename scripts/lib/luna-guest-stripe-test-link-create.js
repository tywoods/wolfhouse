'use strict';

/**
 * Stage 27o — Gated Stripe test Checkout link for guest draft payment (staging/local).
 *
 * Reuses the same Checkout Session + payments update pattern as
 * handlePaymentCreateStripeLink (Stage 8.4.9) in staff-query-api.js.
 *
 * No WhatsApp send · no booking confirmation · no webhook/payment truth.
 */

const { withPgClient } = require('./pg-connect');
const { isStagingResetEnvironment } = require('./luna-test-reset-phone');

const WRITE_SOURCE = 'luna_guest_stage27o';
const REUSED_STRIPE_PATH = 'handlePaymentCreateStripeLink (Stage 8.4.9)';

const LINK_SAFETY = Object.freeze({
  sends_whatsapp: false,
  live_send_blocked: true,
  booking_confirmed: false,
  payment_truth_recorded: false,
  whatsapp_sent: false,
  calls_n8n: false,
  payment_link_sent: false,
});

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function readEnv(env) {
  return env || process.env;
}

function stripeCheckoutPublicOrigin(env) {
  const e = readEnv(env);
  for (const raw of [
    e.STRIPE_CHECKOUT_PUBLIC_BASE_URL,
    e.STAFF_PUBLIC_BASE_URL,
    e.STRIPE_CHECKOUT_SUCCESS_URL || e.STRIPE_SUCCESS_URL,
    e.STRIPE_CHECKOUT_CANCEL_URL || e.STRIPE_CANCEL_URL,
  ]) {
    if (!raw) continue;
    try { return new URL(raw).origin; } catch (_) { /* skip */ }
  }
  return null;
}

function stripeCheckoutSessionSuccessUrl(env, override) {
  if (override) return override;
  const e = readEnv(env);
  const envUrl = e.STRIPE_CHECKOUT_SUCCESS_URL || e.STRIPE_SUCCESS_URL;
  if (envUrl && envUrl.includes('{CHECKOUT_SESSION_ID}')
      && /\/staff\/payment\/success|\/staff\/stripe\/success/.test(envUrl)) {
    return envUrl;
  }
  const origin = stripeCheckoutPublicOrigin(env);
  if (origin) return `${origin}/staff/payment/success?session_id={CHECKOUT_SESSION_ID}`;
  return envUrl || null;
}

function stripeCheckoutSessionCancelUrl(env, override) {
  if (override) return override;
  const e = readEnv(env);
  const envUrl = e.STRIPE_CHECKOUT_CANCEL_URL || e.STRIPE_CANCEL_URL;
  if (envUrl && /\/staff\/payment\/cancel|\/staff\/stripe\/cancel/.test(envUrl)) {
    return envUrl;
  }
  const origin = stripeCheckoutPublicOrigin(env);
  if (origin) return `${origin}/staff/payment/cancel`;
  return envUrl || null;
}

function stripeCheckoutRedirectUrlsConfigured(env, input) {
  return !!(stripeCheckoutSessionSuccessUrl(env, input && input.success_url)
    && stripeCheckoutSessionCancelUrl(env, input && input.cancel_url));
}

function isGuestStripeTestLinkEnvironment(env, hostHeader) {
  return isStagingResetEnvironment(env || process.env, hostHeader || '');
}

function confirmStripeTestLinkApproved(context) {
  const ctx = context || {};
  return ctx.confirm_stripe_test_link === true || ctx.confirmStripeTestLink === true;
}

function isStripeTestSecretKey(env) {
  const key = trimStr(readEnv(env).STRIPE_SECRET_KEY);
  return key.startsWith('sk_test_');
}

/**
 * Hard gates before Stripe/API work.
 */
function shouldAllowGuestStripeTestLinkCreate(input, context) {
  const ctx = context || {};
  const env = readEnv(ctx.env);
  const reasons = [];

  if (!isGuestStripeTestLinkEnvironment(env, ctx.host_header)) {
    reasons.push('production_or_unknown_environment_blocked');
  }
  if (!confirmStripeTestLinkApproved(ctx)) {
    reasons.push('confirm_stripe_test_link_required');
  }
  if (env.STAFF_ACTIONS_ENABLED !== 'true') {
    reasons.push('STAFF_ACTIONS_ENABLED_required');
  }
  if (env.STRIPE_LINKS_ENABLED !== 'true') {
    reasons.push('STRIPE_LINKS_ENABLED_required');
  }
  if (env.WHATSAPP_DRY_RUN !== 'true') {
    reasons.push('WHATSAPP_DRY_RUN_required');
  }
  if (!trimStr(env.STRIPE_SECRET_KEY)) {
    reasons.push('STRIPE_SECRET_KEY_missing');
  } else if (!isStripeTestSecretKey(env)) {
    reasons.push('stripe_test_mode_required');
  }
  if (!stripeCheckoutRedirectUrlsConfigured(env, input)) {
    reasons.push('stripe_redirect_urls_missing');
  }
  if (!trimStr((input || {}).payment_draft_id)) {
    reasons.push('payment_draft_id_required');
  }

  return { allowed: reasons.length === 0, reasons };
}

function buildBlockedResponse(reasons) {
  return {
    success: false,
    ...LINK_SAFETY,
    stripe_link_attempted: false,
    stripe_link_created: false,
    stripe_mode: 'test',
    booking_id: null,
    booking_code: null,
    payment_draft_id: null,
    stripe_checkout_session_id: null,
    stripe_checkout_url: null,
    payment_status: null,
    next_safe_step: 'keep_dry_run',
    block_reasons: reasons,
    reused_stripe_path: REUSED_STRIPE_PATH,
    staff_notice: 'Stripe test link not created — gates not satisfied. Link is for staff/manual testing only; not sent to guest.',
  };
}

async function fetchPaymentWithBooking(pg, paymentDraftId, input) {
  const r = await pg.query(
    `SELECT p.id::text              AS payment_draft_id,
            p.client_id,
            p.booking_id::text        AS booking_id,
            p.status::text            AS payment_status,
            p.payment_kind::text      AS payment_kind,
            p.currency,
            p.amount_due_cents,
            p.amount_paid_cents,
            p.stripe_checkout_session_id,
            p.checkout_url,
            b.booking_code,
            b.guest_name,
            b.check_in::text          AS check_in,
            b.check_out::text         AS check_out,
            b.status::text            AS booking_status,
            b.hold_expires_at,
            b.payment_status::text    AS booking_payment_status,
            cl.slug                   AS client_slug
       FROM payments p
       JOIN bookings b  ON b.id  = p.booking_id
       JOIN clients  cl ON cl.id = p.client_id
      WHERE p.id = $1::uuid`,
    [paymentDraftId],
  );
  const pm = r.rows[0] || null;
  if (!pm) return { error: 'payment_not_found' };

  const bookingId = trimStr(input && input.booking_id);
  const bookingCode = trimStr(input && input.booking_code);
  if (bookingId && pm.booking_id !== bookingId) return { error: 'booking_id_mismatch' };
  if (bookingCode && pm.booking_code !== bookingCode) return { error: 'booking_code_mismatch' };

  return { payment: pm };
}

function validatePaymentForLink(pm) {
  const reasons = [];
  if (!pm) reasons.push('payment_not_found');
  if (pm && Number(pm.amount_paid_cents || 0) > 0) reasons.push('payment_already_paid');
  if (pm && pm.payment_status === 'paid') reasons.push('payment_status_paid');
  if (pm && (!pm.amount_due_cents || pm.amount_due_cents <= 0)) {
    reasons.push('amount_due_invalid');
  }
  if (pm && (pm.currency || '').toUpperCase() !== 'EUR') reasons.push('currency_not_eur');
  if (pm && pm.booking_status === 'confirmed') reasons.push('booking_already_confirmed');
  if (pm && pm.hold_expires_at && new Date(pm.hold_expires_at) <= new Date()) {
    reasons.push('hold_expired');
  }
  return reasons;
}

function formatIdempotentSuccess(pm, extra) {
  return {
    success: true,
    ...LINK_SAFETY,
    stripe_link_attempted: true,
    stripe_link_created: true,
    idempotent: true,
    stripe_mode: 'test',
    booking_id: pm.booking_id,
    booking_code: pm.booking_code,
    payment_draft_id: pm.payment_draft_id,
    stripe_checkout_session_id: pm.stripe_checkout_session_id,
    stripe_checkout_url: pm.checkout_url,
    payment_status: pm.payment_status,
    next_safe_step: 'awaiting_payment_truth',
    reused_stripe_path: REUSED_STRIPE_PATH,
    staff_notice: 'Existing Stripe test Checkout URL returned (idempotent). For staff/manual testing only — not sent to guest.',
    ...extra,
  };
}

function formatCreatedSuccess(pm, session) {
  return {
    success: true,
    ...LINK_SAFETY,
    stripe_link_attempted: true,
    stripe_link_created: true,
    idempotent: false,
    stripe_mode: session.livemode === false ? 'test' : 'test',
    booking_id: pm.booking_id,
    booking_code: pm.booking_code,
    payment_draft_id: pm.payment_draft_id,
    stripe_checkout_session_id: session.id,
    stripe_checkout_url: session.url,
    payment_status: 'checkout_created',
    next_safe_step: 'awaiting_payment_truth',
    reused_stripe_path: REUSED_STRIPE_PATH,
    staff_notice: 'Stripe test Checkout URL created for staff/manual testing. Not sent to guest. Payment truth awaits Stage 27p webhook handling.',
  };
}

/**
 * Stage 27o — create Stripe test Checkout link for existing draft payment.
 *
 * @param {{ payment_draft_id: string, booking_id?: string, booking_code?: string, success_url?: string, cancel_url?: string, staff_operator?: string, source?: string }} input
 * @param {{ confirm_stripe_test_link?: boolean, env?: object, pg?: object, host_header?: string }} context
 */
async function runGuestStripeTestLinkCreateApproved(input, context) {
  const ctx = context || {};
  const src = input || {};
  const env = readEnv(ctx.env);
  const paymentDraftId = trimStr(src.payment_draft_id);

  const allow = shouldAllowGuestStripeTestLinkCreate(src, ctx);
  if (!allow.allowed) {
    return buildBlockedResponse(allow.reasons);
  }

  const run = async (pg) => {
    const loaded = await fetchPaymentWithBooking(pg, paymentDraftId, src);
    if (loaded.error) {
      return buildBlockedResponse([loaded.error]);
    }

    const pm = loaded.payment;
    const validationReasons = validatePaymentForLink(pm);
    if (validationReasons.length) {
      return buildBlockedResponse(validationReasons);
    }

    if (pm.payment_status === 'checkout_created' && pm.checkout_url) {
      return formatIdempotentSuccess(pm);
    }

    if (pm.payment_status !== 'draft' && pm.payment_status !== 'pending') {
      return buildBlockedResponse([`payment_status_${pm.payment_status}_not_eligible`]);
    }

    let stripe;
    try {
      stripe = require('stripe')(env.STRIPE_SECRET_KEY);
    } catch (e) {
      return buildBlockedResponse(['stripe_sdk_load_failed']);
    }

    const clientSlug = pm.client_slug;
    const productName = `Booking ${pm.booking_code || paymentDraftId} — ${pm.guest_name || 'Guest'}`;
    const productDesc = `${pm.payment_kind === 'full_amount' ? 'Full payment' : 'Deposit'} | `
      + `${pm.check_in || ''} – ${pm.check_out || ''} | ${clientSlug}`;
    const actor = trimStr(src.staff_operator) || 'luna-guest-stage27o';
    const metadataSource = trimStr(src.source) || WRITE_SOURCE;

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        currency: 'eur',
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: { name: productName, description: productDesc },
            unit_amount: pm.amount_due_cents,
          },
          quantity: 1,
        }],
        metadata: {
          client_slug: clientSlug,
          booking_id: pm.booking_id,
          booking_code: pm.booking_code || '',
          payment_id: paymentDraftId,
          payment_kind: pm.payment_kind || '',
          source: metadataSource,
          stage: '27o',
        },
        success_url: stripeCheckoutSessionSuccessUrl(env, src.success_url),
        cancel_url: stripeCheckoutSessionCancelUrl(env, src.cancel_url),
      });
    } catch (stripeErr) {
      return {
        success: false,
        ...LINK_SAFETY,
        stripe_link_attempted: true,
        stripe_link_created: false,
        stripe_mode: 'test',
        booking_id: pm.booking_id,
        booking_code: pm.booking_code,
        payment_draft_id: paymentDraftId,
        stripe_checkout_session_id: null,
        stripe_checkout_url: null,
        payment_status: pm.payment_status,
        next_safe_step: 'keep_dry_run',
        block_reasons: [`stripe_session_create_failed:${stripeErr.message}`],
        reused_stripe_path: REUSED_STRIPE_PATH,
        staff_notice: 'Stripe test session creation failed. No guest send performed.',
      };
    }

    if (session.livemode === true) {
      return buildBlockedResponse(['stripe_livemode_not_allowed']);
    }

    const expiresAt = session.expires_at
      ? new Date(session.expires_at * 1000).toISOString()
      : null;

    await pg.query(
      `UPDATE payments
          SET status                      = 'checkout_created'::payment_record_status,
              stripe_checkout_session_id  = $1,
              checkout_url                = $2,
              expires_at                  = $3,
              metadata                    = metadata || $4::jsonb
        WHERE id = $5::uuid`,
      [
        session.id,
        session.url,
        expiresAt,
        JSON.stringify({
          stripe_session_id: session.id,
          stripe_livemode: session.livemode,
          stripe_payment_status: session.payment_status,
          created_by: actor,
          source: metadataSource,
          stage: '27o',
        }),
        paymentDraftId,
      ],
    );

    return formatCreatedSuccess(pm, session);
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
  runGuestStripeTestLinkCreateApproved,
  shouldAllowGuestStripeTestLinkCreate,
  isGuestStripeTestLinkEnvironment,
  confirmStripeTestLinkApproved,
  isStripeTestSecretKey,
  stripeCheckoutSessionSuccessUrl,
  stripeCheckoutSessionCancelUrl,
  stripeCheckoutRedirectUrlsConfigured,
  REUSED_STRIPE_PATH,
  WRITE_SOURCE,
  LINK_SAFETY,
};
