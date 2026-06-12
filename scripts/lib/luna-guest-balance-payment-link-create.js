'use strict';

/**
 * Stage 56g — Guest balance payment link (outstanding balance on existing booking).
 *
 * Mirrors staff POST /staff/bookings/generate-payment-link for WhatsApp guests.
 */

const { withPgClient } = require('./pg-connect');
const { isStagingResetEnvironment } = require('./luna-test-reset-phone');
const {
  stripeCheckoutSessionSuccessUrl,
  stripeCheckoutSessionCancelUrl,
  stripeCheckoutRedirectUrlsConfigured,
} = require('./luna-guest-stripe-test-link-create');
const {
  buildPaymentShortLink,
  buildPaymentLinkObservability,
} = require('./luna-payment-short-link');

const WRITE_SOURCE = 'luna_guest_balance_payment_link_56g';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LINK_SAFETY = Object.freeze({
  sends_whatsapp: false,
  live_send_blocked: true,
  payment_truth_recorded: false,
  whatsapp_sent: false,
  calls_n8n: false,
  payment_link_sent: false,
});

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function readEnv(env) {
  return env || process.env;
}

function parseMetadata(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function isStripeTestSecretKey(env) {
  const key = trimStr(readEnv(env).STRIPE_SECRET_KEY);
  return key.startsWith('sk_test_');
}

function isPaidPaymentStatus(status) {
  return String(status || '').toLowerCase() === 'paid';
}

function serviceRecordBillableCents(row) {
  const r = row || {};
  if (String(r.status || '').toLowerCase() === 'cancelled') return 0;
  if (isPaidPaymentStatus(r.payment_status)) return 0;
  return Number(r.amount_due_cents || 0);
}

/**
 * Invoice balance — matches staff bookingLedgerInvoicePaidBalance / Payments tab.
 *
 * Services live on booking_service_records (invoice Services section). Addon payment
 * ledger cards (e.g. "Dinner — due at checkout") are display-only and must not be
 * added again. When total_amount_cents is the quote base, invoice = total (not total + svc).
 */
function computeBookingBalanceDueCents(bookingRow, svcRows, paymentRows) {
  const bk = bookingRow || {};
  const svcDue = (svcRows || []).reduce((s, r) => s + serviceRecordBillableCents(r), 0);
  const paidTotal = (paymentRows || []).reduce((s, pr) => {
    const st = String(pr.payment_status || pr.status || '').toLowerCase();
    if (!isPaidPaymentStatus(st)) return s;
    return s + Number(pr.amount_paid_cents || 0);
  }, 0);
  const total = Number(bk.total_amount_cents || 0);
  const derivedAcc = total - svcDue;
  const invoiceTotal = derivedAcc >= 0 ? total : total + svcDue;
  if (invoiceTotal > paidTotal) return invoiceTotal - paidTotal;
  return 0;
}

function paymentRowHasActiveCheckout(pr) {
  if (!pr) return false;
  const st = String(pr.payment_status || pr.status || '').toLowerCase();
  if (st === 'cancelled' || st === 'canceled' || st === 'expired' || st === 'failed') return false;
  if (Number(pr.amount_paid_cents || 0) > 0) return false;
  const md = parseMetadata(pr.metadata);
  return !!(pr.checkout_url || md.payment_link_url || md.checkout_url);
}

/**
 * Guest explicitly asks for a balance/full payment link on an existing booking.
 */
function detectBalancePaymentLinkRequest(messageText) {
  const t = String(messageText || '').trim();
  if (!t) return false;
  if (/\b(?:send(?:\s+me)?|can you send|could you send|please send)\b[\s\S]{0,40}\b(?:the\s+)?(?:(?:full|remaining|outstanding|balance)\s+)?(?:payment\s+)?link\b/i.test(t)) {
    return true;
  }
  if (/\b(?:full|remaining|outstanding|balance)\s+(?:payment\s+)?link\b/i.test(t)) {
    return true;
  }
  if (/\b(?:payment|checkout|pay)\s+link\b/i.test(t)
    && /\b(?:full|remaining|outstanding|balance|rest|left)\b/i.test(t)) {
    return true;
  }
  return false;
}

function hasExistingPaidBookingContext(guestContext) {
  const ctx = guestContext || {};
  const bookingId = trimStr(ctx.booking_id);
  if (!bookingId) return false;
  const paySt = trimStr(ctx.payment_status || (ctx.result && ctx.result.payment_status)).toLowerCase();
  const bkSt = trimStr(ctx.booking_status || (ctx.result && ctx.result.booking_status)).toLowerCase();
  return paySt === 'deposit_paid' || paySt === 'paid' || paySt === 'balance_due'
    || bkSt === 'confirmed' || bkSt === 'hold';
}

function confirmBalancePaymentLinkApproved(context) {
  const ctx = context || {};
  return ctx.confirm_balance_payment_link === true || ctx.confirmBalancePaymentLink === true;
}

function shouldAllowGuestBalancePaymentLinkCreate(input, context) {
  const ctx = context || {};
  const env = readEnv(ctx.env);
  const reasons = [];

  if (!isStagingResetEnvironment(env, ctx.host_header || '')) {
    reasons.push('production_or_unknown_environment_blocked');
  }
  if (!confirmBalancePaymentLinkApproved(ctx)) {
    reasons.push('confirm_balance_payment_link_required');
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

function formatBalanceLinkResponse(out) {
  const src = out || {};
  const obs = buildPaymentLinkObservability({
    booking_code: src.booking_code,
    client_slug: src.client_slug,
    stripe_checkout_url: src.stripe_checkout_url,
    stripe_checkout_session_id: src.stripe_checkout_session_id,
    env: src.env,
  });
  return {
    ...src,
    ...obs,
    demo_stripe_test_link: true,
    stripe_link_created: src.success === true && !!src.stripe_checkout_url,
    stripe_link_reused: src.idempotent === true,
    stripe_link_attempted: true,
    stripe_link_status: src.success ? 'created' : 'blocked',
    payment_link_sent: false,
  };
}

/**
 * @param {object} input — { booking_id, client_slug?, inbound_message_id? }
 * @param {object} context — { confirm_balance_payment_link, env, pg, host_header }
 */
async function runGuestBalancePaymentLinkCreateApproved(input, context) {
  const ctx = context || {};
  const env = readEnv(ctx.env);
  const src = input || {};
  const bookingId = trimStr(src.booking_id);
  const clientSlug = trimStr(src.client_slug) || 'wolfhouse-somo';

  const allow = shouldAllowGuestBalancePaymentLinkCreate(src, ctx);
  if (!allow.allowed) {
    return formatBalanceLinkResponse({
      success: false,
      ...LINK_SAFETY,
      stripe_link_block_reasons: allow.reasons,
      source: WRITE_SOURCE,
    });
  }

  const run = async (pg) => {
    const bkRes = await pg.query(
      `SELECT b.id::text AS booking_id, b.booking_code, b.guest_name,
              b.check_in::text AS check_in, b.check_out::text AS check_out,
              b.status::text AS booking_status, b.payment_status::text AS payment_status,
              b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents,
              cl.id AS client_id, cl.slug AS client_slug
         FROM bookings b
         JOIN clients cl ON cl.id = b.client_id
        WHERE b.id = $1::uuid AND cl.slug = $2`,
      [bookingId, clientSlug],
    );
    const booking = bkRes.rows[0];
    if (!booking) {
      return {
        success: false,
        ...LINK_SAFETY,
        stripe_link_block_reasons: ['booking_not_found'],
        source: WRITE_SOURCE,
      };
    }
    if (String(booking.booking_status || '').toLowerCase() === 'cancelled') {
      return {
        success: false,
        ...LINK_SAFETY,
        stripe_link_block_reasons: ['booking_cancelled'],
        booking_id: bookingId,
        booking_code: booking.booking_code,
        source: WRITE_SOURCE,
      };
    }

    const svcRes = await pg.query(
      `SELECT id::text, service_type, status, payment_status, amount_due_cents
         FROM booking_service_records
        WHERE booking_id = $1::uuid`,
      [bookingId],
    );
    const pmRes = await pg.query(
      `SELECT id::text AS payment_id, status::text AS payment_status,
              payment_kind::text AS payment_kind, amount_due_cents, amount_paid_cents,
              checkout_url, metadata
         FROM payments
        WHERE booking_id = $1::uuid
        ORDER BY created_at DESC`,
      [bookingId],
    );

    const balanceDueCents = computeBookingBalanceDueCents(
      booking,
      svcRes.rows,
      pmRes.rows,
    );

    if (balanceDueCents <= 0) {
      return {
        success: false,
        ...LINK_SAFETY,
        stripe_link_block_reasons: ['no_payment_due'],
        booking_id: bookingId,
        booking_code: booking.booking_code,
        balance_due_cents: 0,
        source: WRITE_SOURCE,
      };
    }

    const activeLink = (pmRes.rows || []).find((pr) => {
      if (!paymentRowHasActiveCheckout(pr)) return false;
      return Number(pr.amount_due_cents) === Number(balanceDueCents);
    });
    if (activeLink && activeLink.checkout_url) {
      const shortUrl = buildPaymentShortLink({
        booking_code: booking.booking_code,
        client_slug: clientSlug,
        env,
      });
      return formatBalanceLinkResponse({
        success: true,
        idempotent: true,
        created: false,
        booking_id: bookingId,
        booking_code: booking.booking_code,
        client_slug: clientSlug,
        amount_due_cents: balanceDueCents,
        balance_due_cents: balanceDueCents,
        payment_id: activeLink.payment_id,
        stripe_checkout_url: activeLink.checkout_url,
        checkout_url: activeLink.checkout_url,
        guest_payment_url: shortUrl || activeLink.checkout_url,
        source: WRITE_SOURCE,
        env,
      });
    }

    const idempotencyKey = `guest-balance:${bookingId}:${balanceDueCents}`;
    const existing = (pmRes.rows || []).find((pr) => {
      const md = parseMetadata(pr.metadata);
      return md.idempotency_key === idempotencyKey && pr.checkout_url;
    });
    if (existing && existing.checkout_url) {
      const shortUrl = buildPaymentShortLink({
        booking_code: booking.booking_code,
        client_slug: clientSlug,
        env,
      });
      return formatBalanceLinkResponse({
        success: true,
        idempotent: true,
        created: false,
        booking_id: bookingId,
        booking_code: booking.booking_code,
        client_slug: clientSlug,
        amount_due_cents: balanceDueCents,
        balance_due_cents: balanceDueCents,
        payment_id: existing.payment_id,
        stripe_checkout_url: existing.checkout_url,
        checkout_url: existing.checkout_url,
        guest_payment_url: shortUrl || existing.checkout_url,
        source: WRITE_SOURCE,
        env,
      });
    }

    const pmMeta = {
      source: 'luna_guest_balance_payment_link',
      method: 'payment_link',
      idempotency_key: idempotencyKey,
      booking_code: booking.booking_code,
      amount_due_cents: balanceDueCents,
      payment_origin: WRITE_SOURCE,
      created_by: 'luna-guest-balance-link',
    };

    const ins = await pg.query(
      `INSERT INTO payments (
         client_id, booking_id, status, payment_kind, currency,
         amount_due_cents, amount_paid_cents, metadata
       ) VALUES (
         $1, $2::uuid, 'draft'::payment_record_status, 'full_amount'::payment_kind, 'EUR',
         $3, 0, $4::jsonb
       )
       RETURNING id::text AS payment_id`,
      [booking.client_id, bookingId, balanceDueCents, JSON.stringify(pmMeta)],
    );
    const paymentId = ins.rows[0].payment_id;

    let stripe;
    try {
      stripe = require('stripe')(env.STRIPE_SECRET_KEY);
    } catch (err) {
      return {
        success: false,
        ...LINK_SAFETY,
        stripe_link_block_reasons: ['stripe_sdk_load_failed'],
        booking_id: bookingId,
        booking_code: booking.booking_code,
        source: WRITE_SOURCE,
      };
    }

    const productName = `Booking ${booking.booking_code || paymentId} — ${booking.guest_name || 'Guest'}`;
    const productDesc = `Outstanding balance | ${booking.check_in || ''} – ${booking.check_out || ''} | ${clientSlug}`;

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        currency: 'eur',
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: { name: productName, description: productDesc },
            unit_amount: balanceDueCents,
          },
          quantity: 1,
        }],
        metadata: {
          client_slug: clientSlug,
          booking_id: bookingId,
          booking_code: booking.booking_code || '',
          payment_id: paymentId,
          payment_kind: 'full_amount',
          source: WRITE_SOURCE,
          idempotency_key: idempotencyKey,
        },
        success_url: stripeCheckoutSessionSuccessUrl(env),
        cancel_url: stripeCheckoutSessionCancelUrl(env),
      });
    } catch (stripeErr) {
      return {
        success: false,
        ...LINK_SAFETY,
        stripe_link_block_reasons: ['stripe_session_create_failed'],
        stripe_error: String(stripeErr.message || stripeErr).slice(0, 200),
        booking_id: bookingId,
        booking_code: booking.booking_code,
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
        WHERE id = $5::uuid`,
      [
        session.id,
        session.url,
        expiresAt,
        JSON.stringify({
          stripe_session_id: session.id,
          stripe_livemode: session.livemode,
          payment_link_url: session.url,
        }),
        paymentId,
      ],
    );

    const shortUrl = buildPaymentShortLink({
      booking_code: booking.booking_code,
      client_slug: clientSlug,
      env,
    });

    return formatBalanceLinkResponse({
      success: true,
      idempotent: false,
      created: true,
      booking_id: bookingId,
      booking_code: booking.booking_code,
      client_slug: clientSlug,
      amount_due_cents: balanceDueCents,
      balance_due_cents: balanceDueCents,
      payment_id: paymentId,
      stripe_checkout_session_id: session.id,
      stripe_checkout_url: session.url,
      checkout_url: session.url,
      guest_payment_url: shortUrl || session.url,
      source: WRITE_SOURCE,
      env,
    });
  };

  if (ctx.pg) return run(ctx.pg);
  return withPgClient(run);
}

module.exports = {
  WRITE_SOURCE,
  detectBalancePaymentLinkRequest,
  hasExistingPaidBookingContext,
  computeBookingBalanceDueCents,
  shouldAllowGuestBalancePaymentLinkCreate,
  runGuestBalancePaymentLinkCreateApproved,
};
