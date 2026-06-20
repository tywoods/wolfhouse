'use strict';

/**
 * Sunset Schedule — Stripe payment links for manual/staff bookings (staging/dev).
 * Sunset client only. Persists to payments table; does not send WhatsApp/email.
 */

const crypto = require('crypto');
const { resolveTenantBusinessConfigAsync, SUNSET_ADMIN_CLIENT } = require('./tenant-business-config');

const SUNSET_CLIENT_SLUG = SUNSET_ADMIN_CLIENT;

const LESSON_OFFERING_KEY = 'group_lesson_adult';
const LESSON_UNIT_KEY = 'single_lesson';
const BOARD_OFFERING_KEY = 'board_rental';
const WETSUIT_OFFERING_KEY = 'wetsuit_rental';
const RENTAL_UNIT_KEY = '1_day';

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '').trim());
}

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function findPriceCents(prices, category, offeringKey, unit) {
  const list = prices || [];
  const cat = String(category || '').toLowerCase();
  const ok = String(offeringKey || '');
  const u = String(unit || '');
  let row = list.find((p) => p.active !== false
    && String(p.category || '').toLowerCase() === cat
    && String(p.offering_key || '') === ok
    && (!u || String(p.unit || '') === u));
  // DB tenant_price_rules backfill uses item_code = offering__unit (unit often person/day).
  if (!row && u) {
    const combined = `${ok}__${u}`;
    row = list.find((p) => p.active !== false
      && String(p.category || '').toLowerCase() === cat
      && String(p.offering_key || '') === combined);
  }
  if (!row || row.amount == null) return null;
  return Math.round(Number(row.amount) * 100);
}

async function createStripeCheckoutSessionViaFetch(opts) {
  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', opts.successUrl);
  params.append('cancel_url', opts.cancelUrl);
  params.append('line_items[0][quantity]', '1');
  params.append('line_items[0][price_data][currency]', 'eur');
  params.append('line_items[0][price_data][unit_amount]', String(opts.amountDueCents));
  params.append('line_items[0][price_data][product_data][name]', opts.productName);
  params.append('line_items[0][price_data][product_data][description]', opts.productDesc);
  for (const [key, value] of Object.entries(opts.metadata || {})) {
    params.append(`metadata[${key}]`, String(value == null ? '' : value));
  }
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) ? data.error.message : `Stripe HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function serviceRecordUnitPriceCents(prices, sr) {
  const dbType = String(sr.service_type || '').toLowerCase();
  const qty = Number(sr.quantity) || 1;
  let unitCents = null;
  if (dbType === 'surf_lesson') {
    unitCents = findPriceCents(prices, 'lesson', LESSON_OFFERING_KEY, LESSON_UNIT_KEY);
  } else if (dbType === 'surfboard') {
    unitCents = findPriceCents(prices, 'rental', BOARD_OFFERING_KEY, RENTAL_UNIT_KEY);
  } else if (dbType === 'wetsuit') {
    unitCents = findPriceCents(prices, 'rental', WETSUIT_OFFERING_KEY, RENTAL_UNIT_KEY);
  }
  if (unitCents == null || unitCents <= 0) return null;
  return unitCents * qty;
}

async function loadBookingWithServices(pg, clientSlug, bookingId, bookingCode) {
  const bookingRes = await pg.query(
    `SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.status::text AS status,
            b.payment_status::text AS payment_status, b.check_in::text AS check_in,
            b.check_out::text AS check_out, b.metadata
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND ${bookingId ? 'b.id = $2::uuid' : 'b.booking_code = $2'}
      LIMIT 1`,
    [clientSlug, bookingId || bookingCode],
  );
  const booking = bookingRes.rows[0];
  if (!booking) return null;
  const svcRes = await pg.query(
    `SELECT id::text AS service_record_id, service_type::text AS service_type, service_date::text AS service_date,
            quantity, amount_due_cents, amount_paid_cents, metadata
       FROM booking_service_records
      WHERE client_slug = $1 AND booking_id = $2::uuid
      ORDER BY service_date, id`,
    [clientSlug, booking.booking_id],
  );
  return { booking, services: svcRes.rows };
}

async function priceSunsetBookingServices(pg, clientSlug, bookingId) {
  const adminCfg = await resolveTenantBusinessConfigAsync(clientSlug, { pgClient: pg });
  if (!adminCfg.ok) return { ok: false, error: 'admin_config_unavailable' };
  const prices = adminCfg.prices || [];
  const svcRes = await pg.query(
    `SELECT id, service_type::text AS service_type, quantity, amount_due_cents, metadata
       FROM booking_service_records
      WHERE client_slug = $1 AND booking_id = $2::uuid`,
    [clientSlug, bookingId],
  );
  let totalCents = 0;
  for (const sr of svcRes.rows) {
    let due = Number(sr.amount_due_cents) || 0;
    if (due <= 0) {
      due = serviceRecordUnitPriceCents(prices, sr) || 0;
      if (due <= 0) {
        return { ok: false, error: `no_price_for_${sr.service_type}` };
      }
      await pg.query(
        `UPDATE booking_service_records SET amount_due_cents = $1 WHERE id = $2::uuid`,
        [due, sr.id],
      );
    }
    totalCents += due;
  }
  if (totalCents <= 0) return { ok: false, error: 'booking_total_zero' };
  await pg.query(
    `UPDATE bookings
        SET total_amount_cents = $1,
            balance_due_cents = GREATEST($1 - COALESCE(amount_paid_cents, 0), 0),
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
      WHERE id = $3::uuid`,
    [
      totalCents,
      JSON.stringify({ sunset_priced_at: new Date().toISOString(), sunset_price_source: adminCfg.source || 'config' }),
      bookingId,
    ],
  );
  return { ok: true, total_cents: totalCents };
}

async function loadLatestPaymentLink(pg, bookingId) {
  const res = await pg.query(
    `SELECT id::text AS payment_id, status::text AS payment_status, amount_due_cents, amount_paid_cents,
            checkout_url, stripe_checkout_session_id, created_at
       FROM payments
      WHERE booking_id = $1::uuid
        AND checkout_url IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [bookingId],
  );
  return res.rows[0] || null;
}

function stripeEnv(opts) {
  return {
    staffActions: opts.staffActionsEnabled === true,
    stripeLinks: opts.stripeLinksEnabled === true,
    secretKey: opts.stripeSecretKey || null,
    successUrl: opts.stripeSuccessUrl || null,
    cancelUrl: opts.stripeCancelUrl || null,
  };
}

function assertStripeEnv(env) {
  if (!env.staffActions) {
    return { ok: false, status: 403, error: 'Staff write actions are disabled. Set STAFF_ACTIONS_ENABLED=true.' };
  }
  if (!env.stripeLinks) {
    return { ok: false, status: 403, error: 'Stripe link creation is disabled. Set STRIPE_LINKS_ENABLED=true.' };
  }
  if (!env.secretKey) {
    return { ok: false, status: 503, error: 'STRIPE_SECRET_KEY not configured.' };
  }
  if (String(env.secretKey).startsWith('sk_live_')) {
    return { ok: false, status: 403, error: 'Live Stripe keys are blocked for Sunset staging payment links.' };
  }
  if (!env.successUrl || !env.cancelUrl) {
    return { ok: false, status: 503, error: 'STRIPE_CHECKOUT_SUCCESS_URL and STRIPE_CHECKOUT_CANCEL_URL must be set.' };
  }
  return { ok: true };
}

async function createSunsetScheduleStripeLink(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }

  const envCheck = assertStripeEnv(stripeEnv(opts));
  if (!envCheck.ok) {
    return { ok: false, status: envCheck.status, body: { success: false, error: envCheck.error } };
  }

  const bookingId = String(opts.bookingId || '').trim();
  const bookingCode = String(opts.bookingCode || '').trim();
  const idempotencyKey = String(opts.idempotencyKey || '').trim()
    || `sunset-schedule-${bookingId || bookingCode}-${crypto.randomBytes(4).toString('hex')}`;

  if (!bookingId && !bookingCode) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id or booking_code is required' } };
  }
  if (bookingId && !isUuid(bookingId)) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id must be a valid UUID' } };
  }

  const loaded = await loadBookingWithServices(pg, clientSlug, bookingId, bookingCode);
  if (!loaded) {
    return { ok: false, status: 404, body: { success: false, error: 'booking not found' } };
  }
  const { booking } = loaded;
  const meta = parseMeta(booking.metadata);
  if (meta.source !== 'staff_manual_schedule' && !meta.staff_manual_schedule) {
    return { ok: false, status: 403, body: { success: false, error: 'stripe_links_limited_to_staff_manual_schedule_bookings' } };
  }

  const existingLink = await loadLatestPaymentLink(pg, booking.booking_id);
  const metaStale = !!meta.sunset_stripe_link_stale;
  if (!metaStale && existingLink && existingLink.checkout_url
    && ['draft', 'checkout_created'].includes(String(existingLink.payment_status))) {
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        idempotent: true,
        booking_id: booking.booking_id,
        booking_code: booking.booking_code,
        payment_id: existingLink.payment_id,
        payment_status: existingLink.payment_status,
        amount_due_cents: Number(existingLink.amount_due_cents),
        checkout_url: existingLink.checkout_url,
        payment_link_url: existingLink.checkout_url,
        stripe_mutation: false,
        message: 'Payment link already exists.',
      },
    };
  }

  await pg.query('BEGIN');
  try {
    const priced = await priceSunsetBookingServices(pg, clientSlug, booking.booking_id);
    if (!priced.ok) {
      await pg.query('ROLLBACK');
      return { ok: false, status: 422, body: { success: false, error: priced.error } };
    }

    const amountDueCents = priced.total_cents;
    const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
    const clientId = clientRes.rows[0] && clientRes.rows[0].id;
    if (!clientId) throw new Error('client not found');

    const idem = await pg.query(
      `SELECT id::text AS payment_id, checkout_url, status::text AS payment_status, amount_due_cents
         FROM payments
        WHERE booking_id = $1::uuid AND metadata->>'idempotency_key' = $2
        LIMIT 1`,
      [booking.booking_id, idempotencyKey],
    );
    if (idem.rows[0] && idem.rows[0].checkout_url) {
      await pg.query('COMMIT');
      const row = idem.rows[0];
      return {
        ok: true,
        status: 200,
        body: {
          success: true,
          idempotent: true,
          booking_id: booking.booking_id,
          booking_code: booking.booking_code,
          payment_id: row.payment_id,
          payment_status: row.payment_status,
          amount_due_cents: Number(row.amount_due_cents),
          checkout_url: row.checkout_url,
          payment_link_url: row.checkout_url,
          stripe_mutation: false,
        },
      };
    }

    const pmMeta = {
      source: 'sunset_schedule_stripe_link',
      method: 'payment_link',
      idempotency_key: idempotencyKey,
      booking_code: booking.booking_code,
      created_by: opts.actor && opts.actor.email ? opts.actor.email : null,
      staff_portal: true,
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
      [clientId, booking.booking_id, amountDueCents, JSON.stringify(pmMeta)],
    );
    const paymentId = ins.rows[0].payment_id;

    const productName = `Sunset booking ${booking.booking_code} — ${booking.guest_name || 'Guest'}`;
    const productDesc = `Surf school services | ${booking.check_in || ''} | ${clientSlug}`;
    const session = await createStripeCheckoutSessionViaFetch({
      secretKey: opts.stripeSecretKey,
      successUrl: opts.stripeSuccessUrl,
      cancelUrl: opts.stripeCancelUrl,
      amountDueCents,
      productName,
      productDesc,
      metadata: {
        client_slug: clientSlug,
        booking_id: booking.booking_id,
        booking_code: booking.booking_code || '',
        payment_id: paymentId,
        source: 'sunset_schedule_stripe_link',
        idempotency_key: idempotencyKey,
      },
    });

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

    await pg.query(
      `UPDATE bookings
          SET payment_status = 'payment_link_sent'::payment_status,
              metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
        WHERE id = $2::uuid`,
      [JSON.stringify({
        last_stripe_payment_id: paymentId,
        last_payment_link_url: session.url,
        sunset_stripe_link_stale: false,
      }), booking.booking_id],
    );

    await pg.query('COMMIT');

    return {
      ok: true,
      status: 201,
      body: {
        success: true,
        created: true,
        booking_id: booking.booking_id,
        booking_code: booking.booking_code,
        payment_id: paymentId,
        payment_status: 'checkout_created',
        amount_due_cents: amountDueCents,
        checkout_url: session.url,
        payment_link_url: session.url,
        stripe_mutation: true,
        send_mutation: false,
        message: 'Stripe payment link created. Nothing was sent to the guest.',
      },
    };
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }
}

async function getSunsetSchedulePaymentLink(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }
  const bookingId = String(opts.bookingId || '').trim();
  const bookingCode = String(opts.bookingCode || '').trim();
  if (!bookingId && !bookingCode) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id or booking_code is required' } };
  }
  const loaded = await loadBookingWithServices(pg, clientSlug, bookingId, bookingCode);
  if (!loaded) {
    return { ok: false, status: 404, body: { success: false, error: 'booking not found' } };
  }
  const link = await loadLatestPaymentLink(pg, loaded.booking.booking_id);
  const meta = parseMeta(loaded.booking.metadata);
  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      booking_id: loaded.booking.booking_id,
      booking_code: loaded.booking.booking_code,
      payment_id: link ? link.payment_id : null,
      payment_status: link ? link.payment_status : null,
      amount_due_cents: link ? Number(link.amount_due_cents) : null,
      checkout_url: link ? link.checkout_url : null,
      payment_link_url: link ? link.checkout_url : meta.last_payment_link_url || null,
    },
  };
}

module.exports = {
  SUNSET_CLIENT_SLUG,
  createSunsetScheduleStripeLink,
  getSunsetSchedulePaymentLink,
  priceSunsetBookingServices,
  serviceRecordUnitPriceCents,
  findPriceCents,
};
