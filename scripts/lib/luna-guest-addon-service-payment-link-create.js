'use strict';

/**
 * Stage 50e — Guest add-on service Stripe checkout link (staging/local, gated).
 *
 * Extracted from staff handleBookingServiceRecordsCreatePaymentLink pattern.
 * No payment truth · no WhatsApp · no n8n.
 */

const { withPgClient } = require('./pg-connect');
const { isStagingResetEnvironment } = require('./luna-test-reset-phone');
const {
  stripeCheckoutSessionSuccessUrl,
  stripeCheckoutSessionCancelUrl,
  stripeCheckoutRedirectUrlsConfigured,
} = require('./luna-guest-stripe-test-link-create');

const WRITE_SOURCE = 'luna_guest_service_payment_link_50e';

const LINK_SAFETY = Object.freeze({
  sends_whatsapp: false,
  live_send_blocked: true,
  payment_truth_recorded: false,
  whatsapp_sent: false,
  calls_n8n: false,
  payment_link_sent: false,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function readEnv(env) {
  return env || process.env;
}

function isStripeTestSecretKey(env) {
  const key = trimStr(readEnv(env).STRIPE_SECRET_KEY);
  return key.startsWith('sk_test_');
}

function confirmServicePaymentLinkApproved(context) {
  const ctx = context || {};
  return ctx.confirm_service_payment_link === true || ctx.confirmServicePaymentLink === true;
}

function isGuestServicePaymentLinkEnvironment(env, hostHeader) {
  return isStagingResetEnvironment(env || process.env, hostHeader || '');
}

/**
 * Hard gates before Stripe/API work for guest service payment links.
 */
function shouldAllowGuestServicePaymentLinkCreate(input, context) {
  const ctx = context || {};
  const env = readEnv(ctx.env);
  const reasons = [];

  if (!isGuestServicePaymentLinkEnvironment(env, ctx.host_header)) {
    reasons.push('production_or_unknown_environment_blocked');
  }
  if (!confirmServicePaymentLinkApproved(ctx)) {
    reasons.push('confirm_service_payment_link_required');
  }
  if (env.LUNA_GUEST_SERVICE_PAY_NOW_ENABLED !== 'true') {
    reasons.push('LUNA_GUEST_SERVICE_PAY_NOW_ENABLED_required');
  }
  if (env.STAFF_ACTIONS_ENABLED !== 'true') {
    reasons.push('STAFF_ACTIONS_ENABLED_required');
  }
  if (env.STRIPE_LINKS_ENABLED !== 'true') {
    reasons.push('STRIPE_LINKS_ENABLED_required');
  }
  if (!trimStr(env.STRIPE_SECRET_KEY)) {
    reasons.push('STRIPE_SECRET_KEY_missing');
  } else if (!isStripeTestSecretKey(env)) {
    reasons.push('STRIPE_SECRET_KEY_must_be_test');
  }
  if (!stripeCheckoutRedirectUrlsConfigured(env, input)) {
    reasons.push('stripe_checkout_redirect_urls_not_configured');
  }
  const bookingId = trimStr(input && input.booking_id);
  if (!bookingId || !UUID_RE.test(bookingId)) {
    reasons.push('booking_id_required');
  }
  return { allowed: reasons.length === 0, reasons };
}

function isMissingBookingServiceRecordsTable(err) {
  const msg = String((err && err.message) || err);
  return /booking_service_records/.test(msg) && /does not exist|not available/i.test(msg);
}

/**
 * @param {object} input — { booking_id, service_record_ids?, client_slug? }
 * @param {object} context — { confirm_service_payment_link, env, pg, host_header }
 */
async function runGuestAddonServicePaymentLinkCreateApproved(input, context) {
  const ctx = context || {};
  const env = readEnv(ctx.env);
  const src = input || {};
  const bookingId = trimStr(src.booking_id);

  const allow = shouldAllowGuestServicePaymentLinkCreate(src, ctx);
  if (!allow.allowed) {
    return {
      success: false,
      ...LINK_SAFETY,
      stripe_link_created: false,
      stripe_link_status: 'blocked',
      stripe_link_block_reasons: allow.reasons,
      source: WRITE_SOURCE,
    };
  }

  const runLink = async (pg) => {
    const bk = await pg.query(
      `SELECT b.id AS booking_id, b.booking_code, b.guest_name, b.client_id, cl.slug AS client_slug
         FROM bookings b
         JOIN clients cl ON cl.id = b.client_id
        WHERE b.id = $1`,
      [bookingId],
    );
    if (!bk.rows[0]) {
      return {
        success: false,
        ...LINK_SAFETY,
        stripe_link_created: false,
        stripe_link_status: 'not_found',
        stripe_link_block_reasons: ['booking_not_found'],
        source: WRITE_SOURCE,
      };
    }
    const booking = bk.rows[0];

    let serviceRecordIds = Array.isArray(src.service_record_ids)
      ? [...new Set(src.service_record_ids.map((id) => trimStr(id)).filter(Boolean))]
      : [];

    if (!serviceRecordIds.length) {
      const unpaid = await pg.query(
        `SELECT id::text AS id
           FROM booking_service_records
          WHERE booking_id = $1::uuid
            AND status <> 'cancelled'
            AND payment_status <> 'paid'
            AND COALESCE(amount_due_cents, 0) > 0`,
        [bookingId],
      );
      serviceRecordIds = unpaid.rows.map((r) => r.id);
    }

    if (!serviceRecordIds.length) {
      return {
        success: false,
        ...LINK_SAFETY,
        stripe_link_created: false,
        stripe_link_status: 'not_ready',
        stripe_link_block_reasons: ['no_unpaid_service_records'],
        booking_id: bookingId,
        booking_code: booking.booking_code,
        source: WRITE_SOURCE,
      };
    }

    for (const id of serviceRecordIds) {
      if (!UUID_RE.test(id)) {
        return {
          success: false,
          ...LINK_SAFETY,
          stripe_link_created: false,
          stripe_link_status: 'blocked',
          stripe_link_block_reasons: [`invalid_service_record_id:${id}`],
          source: WRITE_SOURCE,
        };
      }
    }

    const svc = await pg.query(
      `SELECT id, booking_id, service_type, status, payment_status,
              amount_due_cents, payment_id
         FROM booking_service_records
        WHERE id = ANY($1::uuid[])`,
      [serviceRecordIds],
    );
    if (svc.rows.length !== serviceRecordIds.length) {
      return {
        success: false,
        ...LINK_SAFETY,
        stripe_link_created: false,
        stripe_link_status: 'not_found',
        stripe_link_block_reasons: ['service_record_not_found'],
        source: WRITE_SOURCE,
      };
    }

    for (const row of svc.rows) {
      if (row.booking_id !== bookingId) {
        return {
          success: false,
          ...LINK_SAFETY,
          stripe_link_created: false,
          stripe_link_status: 'blocked',
          stripe_link_block_reasons: [`service_record_wrong_booking:${row.id}`],
          source: WRITE_SOURCE,
        };
      }
      if (row.status === 'cancelled' || row.payment_status === 'paid') {
        return {
          success: false,
          ...LINK_SAFETY,
          stripe_link_created: false,
          stripe_link_status: 'blocked',
          stripe_link_block_reasons: [`service_record_not_payable:${row.id}`],
          source: WRITE_SOURCE,
        };
      }
      if (Number(row.amount_due_cents || 0) <= 0) {
        return {
          success: false,
          ...LINK_SAFETY,
          stripe_link_created: false,
          stripe_link_status: 'blocked',
          stripe_link_block_reasons: [`service_record_zero_amount:${row.id}`],
          source: WRITE_SOURCE,
        };
      }
    }

    const linkedPaymentIds = [...new Set(svc.rows.map((r) => r.payment_id).filter(Boolean))];
    if (linkedPaymentIds.length > 1) {
      return {
        success: false,
        ...LINK_SAFETY,
        stripe_link_created: false,
        stripe_link_status: 'blocked',
        stripe_link_block_reasons: ['multiple_linked_payments'],
        source: WRITE_SOURCE,
      };
    }

    let paymentId;
    let amountDueCents = svc.rows.reduce((sum, r) => sum + Number(r.amount_due_cents || 0), 0);
    const allocation = {};
    for (const row of svc.rows) allocation[row.id] = Number(row.amount_due_cents || 0);

    if (linkedPaymentIds.length === 1) {
      const existingPm = (await pg.query(
        `SELECT id, status, payment_kind, amount_due_cents, stripe_checkout_session_id, checkout_url
           FROM payments WHERE id = $1`,
        [linkedPaymentIds[0]],
      )).rows[0];

      if (existingPm && existingPm.payment_kind === 'addon_service') {
        if (existingPm.status === 'checkout_created' && existingPm.checkout_url) {
          return {
            success: true,
            ...LINK_SAFETY,
            stripe_link_created: true,
            stripe_link_reused: true,
            stripe_link_status: 'reused_existing',
            stripe_checkout_url: existingPm.checkout_url,
            payment_id: existingPm.id,
            booking_id: bookingId,
            booking_code: booking.booking_code,
            payment_kind: 'addon_service',
            amount_due_cents: existingPm.amount_due_cents,
            service_record_ids: serviceRecordIds,
            source: WRITE_SOURCE,
          };
        }
        if (existingPm.status === 'draft') {
          paymentId = existingPm.id;
          amountDueCents = Number(existingPm.amount_due_cents || amountDueCents);
        }
      }
    }

    if (!paymentId) {
      const paymentMetadata = {
        source: WRITE_SOURCE,
        service_record_ids: serviceRecordIds,
        service_record_allocation_cents: allocation,
        booking_code: booking.booking_code,
      };
      await pg.query('BEGIN');
      try {
        const ins = await pg.query(
          `INSERT INTO payments (
             client_id, booking_id, status, payment_kind, currency,
             amount_due_cents, amount_paid_cents, metadata
           ) VALUES (
             $1, $2, 'draft'::payment_record_status, 'addon_service'::payment_kind, 'EUR',
             $3, 0, $4::jsonb
           ) RETURNING id`,
          [booking.client_id, bookingId, amountDueCents, JSON.stringify(paymentMetadata)],
        );
        paymentId = ins.rows[0].id;
        await pg.query(
          `UPDATE booking_service_records
              SET payment_id = $1, payment_status = 'pending', updated_at = NOW()
            WHERE id = ANY($2::uuid[])`,
          [paymentId, serviceRecordIds],
        );
        await pg.query('COMMIT');
      } catch (e) {
        try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
      }
    }

    let stripe;
    try {
      stripe = require('stripe')(trimStr(env.STRIPE_SECRET_KEY));
    } catch (e) {
      return {
        success: false,
        ...LINK_SAFETY,
        stripe_link_created: false,
        stripe_link_status: 'error',
        stripe_link_block_reasons: [`stripe_sdk_error:${e.message}`],
        payment_id: paymentId,
        source: WRITE_SOURCE,
      };
    }

    const productName = `Add-ons — ${booking.booking_code || bookingId}`;
    const productDesc = `Service add-ons | ${booking.guest_name || 'Guest'} | ${booking.client_slug}`;
    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        currency: 'eur',
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: { name: productName, description: productDesc },
            unit_amount: amountDueCents,
          },
          quantity: 1,
        }],
        metadata: {
          client_slug: booking.client_slug,
          booking_id: bookingId,
          booking_code: booking.booking_code || '',
          payment_id: paymentId,
          payment_kind: 'addon_service',
          service_record_ids: JSON.stringify(serviceRecordIds),
        },
        success_url: stripeCheckoutSessionSuccessUrl(env, src.success_url),
        cancel_url: stripeCheckoutSessionCancelUrl(env, src.cancel_url),
      });
    } catch (stripeErr) {
      return {
        success: false,
        ...LINK_SAFETY,
        stripe_link_created: false,
        stripe_link_status: 'error',
        stripe_link_block_reasons: [`stripe_session_error:${stripeErr.message}`],
        payment_id: paymentId,
        source: WRITE_SOURCE,
      };
    }

    const expiresAt = session.expires_at
      ? new Date(session.expires_at * 1000).toISOString()
      : null;

    await pg.query(
      `UPDATE payments
          SET status = 'checkout_created'::payment_record_status,
              stripe_checkout_session_id = $1,
              checkout_url = $2,
              expires_at = $3,
              metadata = metadata || $4::jsonb
        WHERE id = $5`,
      [
        session.id,
        session.url,
        expiresAt,
        JSON.stringify({
          stripe_session_id: session.id,
          source: WRITE_SOURCE,
          service_record_ids: serviceRecordIds,
          service_record_allocation_cents: allocation,
        }),
        paymentId,
      ],
    );

    return {
      success: true,
      ...LINK_SAFETY,
      stripe_link_created: true,
      stripe_link_reused: false,
      stripe_link_status: 'created',
      stripe_checkout_url: session.url,
      stripe_checkout_session_id: session.id,
      payment_id: paymentId,
      booking_id: bookingId,
      booking_code: booking.booking_code,
      payment_kind: 'addon_service',
      amount_due_cents: amountDueCents,
      service_record_ids: serviceRecordIds,
      source: WRITE_SOURCE,
    };
  };

  if (ctx.pg && typeof ctx.pg.query === 'function') {
    try {
      return await runLink(ctx.pg);
    } catch (err) {
      if (isMissingBookingServiceRecordsTable(err)) {
        return {
          success: false,
          ...LINK_SAFETY,
          stripe_link_created: false,
          stripe_link_status: 'error',
          stripe_link_block_reasons: ['booking_service_records_unavailable'],
          source: WRITE_SOURCE,
        };
      }
      return {
        success: false,
        ...LINK_SAFETY,
        stripe_link_created: false,
        stripe_link_status: 'error',
        stripe_link_block_reasons: [String(err.message || err).slice(0, 120)],
        source: WRITE_SOURCE,
      };
    }
  }

  try {
    return await withPgClient(runLink);
  } catch (err) {
    return {
      success: false,
      ...LINK_SAFETY,
      stripe_link_created: false,
      stripe_link_status: 'error',
      stripe_link_block_reasons: ['database_unavailable', String(err.message || err).slice(0, 80)],
      source: WRITE_SOURCE,
    };
  }
}

module.exports = {
  WRITE_SOURCE,
  LINK_SAFETY,
  confirmServicePaymentLinkApproved,
  shouldAllowGuestServicePaymentLinkCreate,
  isGuestServicePaymentLinkEnvironment,
  runGuestAddonServicePaymentLinkCreateApproved,
};
