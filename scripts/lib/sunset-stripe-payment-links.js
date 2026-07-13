'use strict';

/**
 * Sunset Schedule — Stripe payment links for manual/staff bookings (staging/dev).
 * Sunset client only. Persists to payments table; does not send guest messages.
 */

const crypto = require('crypto');
const {
  normalizeSunsetLocationId,
  resolveRecordLocationId,
} = require('./sunset-school-locations');
const { resolveTenantBusinessConfigAsync, SUNSET_ADMIN_CLIENT } = require('./tenant-business-config');
const { buildPaymentLinkObservability } = require('./luna-payment-short-link');
const {
  LUNA_METADATA_SOURCE_TAG,
  METADATA_SOURCE_TAG,
  isLunaTrustedActor,
} = require('./sunset-schedule-booking-writes');

const SUNSET_CLIENT_SLUG = SUNSET_ADMIN_CLIENT;
const SUNSET_STAGING_PUBLIC_PAYMENT_BASE = 'https://sunset-staging.lunafrontdesk.com';

const LESSON_OFFERING_KEY = 'group_lesson_adult';
const LESSON_UNIT_KEY = 'single_lesson';
const BOARD_OFFERING_KEY = 'board_rental';
const WETSUIT_OFFERING_KEY = 'wetsuit_rental';
const RENTAL_UNIT_KEY = '1_day';
const BOARD_AND_SUIT_OFFERING_KEY = 'board_and_suit_rental';
// Full-day equipment extension add-on (per person, per day). Price is config/DB backed:
// tenant_price_rules item_type='rental', item_code='full_day_equipment_extension__day', unit='day'.
const FULL_DAY_EQUIPMENT_ADDON_KEY = 'full_day_equipment_extension';
const FULL_DAY_EQUIPMENT_ADDON_UNIT = 'day';

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '').trim());
}

function bookingEligibleForScheduleStripeLink(meta) {
  const m = meta || {};
  if (m.source === METADATA_SOURCE_TAG || m.staff_manual_schedule) return true;
  if (m.source === LUNA_METADATA_SOURCE_TAG || m.luna_guest_booking) return true;
  if (m.actor_source && isLunaTrustedActor({ source: m.actor_source })) return true;
  return false;
}

function sunsetPaymentLinkObservability(bookingCode, checkoutUrl, sessionId, opts) {
  return buildPaymentLinkObservability({
    booking_code: bookingCode,
    client_slug: SUNSET_CLIENT_SLUG,
    stripe_checkout_url: checkoutUrl,
    stripe_checkout_session_id: sessionId,
    base_url: (opts && opts.publicPaymentBaseUrl) || SUNSET_STAGING_PUBLIC_PAYMENT_BASE,
    env: opts && opts.env,
  });
}

function attachGuestPaymentFields(body, bookingCode, checkoutUrl, sessionId, opts) {
  const obs = sunsetPaymentLinkObservability(bookingCode, checkoutUrl, sessionId, opts);
  return {
    ...body,
    ...obs,
    checkout_url: checkoutUrl || body.checkout_url || null,
    payment_link_url: checkoutUrl || body.payment_link_url || null,
  };
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

/** Stable server identity for one Sunset authoritative payment intent (request keys excluded). */
function buildAuthoritativePaymentIntentKey(opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  const bookingId = String(opts.bookingId || '').trim();
  const paymentKind = String(opts.paymentKind || 'full_amount').trim();
  const amountDueCents = Number(opts.amountDueCents || 0);
  const currency = String(opts.currency || 'EUR').trim().toUpperCase();
  const digest = crypto.createHash('sha256')
    .update([clientSlug, bookingId, paymentKind, String(amountDueCents), currency].join('|'))
    .digest('hex')
    .slice(0, 32);
  return `sunset-checkout-${digest}`;
}

function buildStripeCheckoutIdempotencyKey(opts) {
  return buildAuthoritativePaymentIntentKey(opts);
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
    params.append(`payment_intent_data[metadata][${key}]`, String(value == null ? '' : value));
  }
  const headers = {
    Authorization: `Bearer ${opts.secretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (opts.idempotencyKey) {
    headers['Idempotency-Key'] = String(opts.idempotencyKey);
  }
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers,
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) ? data.error.message : `Stripe HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function normalizeRentalDuration(raw) {
  const compact = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (compact === 'half_day' || compact === 'halfday') return 'half_day';
  return compact;
}

function parseRentalPricingMeta(meta) {
  const rp = meta && meta.rental_pricing;
  if (!rp || typeof rp !== 'object') return null;
  const offering_key = String(rp.offering_key || '').trim();
  const duration = normalizeRentalDuration(rp.duration);
  const quantity = parseInt(String(rp.quantity), 10);
  if (!offering_key || !duration || !Number.isInteger(quantity) || quantity < 1) return null;
  const quotedRaw = rp.quoted_total_cents;
  const quoted_total_cents = quotedRaw == null || quotedRaw === ''
    ? null
    : parseInt(String(quotedRaw), 10);
  const pricing_group_id = String(rp.pricing_group_id || '').trim() || null;
  const service_date = String(rp.service_date || '').trim() || null;
  const components = Array.isArray(rp.components)
    ? rp.components.map((c) => String(c || '').trim()).filter(Boolean)
    : [];
  return {
    offering_key,
    duration,
    quantity,
    pricing_group_id,
    service_date,
    components,
    quoted_total_cents: quoted_total_cents != null && Number.isInteger(quoted_total_cents) && quoted_total_cents >= 0
      ? quoted_total_cents
      : null,
  };
}

function configuredRentalBundleTotalCents(prices, rentalPricing) {
  if (!rentalPricing) return null;
  const unitCents = findPriceCents(
    prices,
    'rental',
    rentalPricing.offering_key,
    rentalPricing.duration,
  );
  if (unitCents == null || unitCents <= 0) return null;
  return unitCents * rentalPricing.quantity;
}

function serviceRowPricingGroupId(sr) {
  return String(parseMeta(sr && sr.metadata).pricing_group_id || '').trim();
}

function isBundleRentalServiceRow(sr, rentalPricing) {
  if (!rentalPricing || rentalPricing.offering_key !== BOARD_AND_SUIT_OFFERING_KEY) return false;
  const groupId = rentalPricing.pricing_group_id;
  if (!groupId) return false;
  const dbType = String(sr.service_type || '').toLowerCase();
  if (dbType !== 'surfboard' && dbType !== 'wetsuit') return false;
  return serviceRowPricingGroupId(sr) === groupId;
}

function validateBundleRentalGroup(svcRows, rentalPricing) {
  if (!rentalPricing || rentalPricing.offering_key !== BOARD_AND_SUIT_OFFERING_KEY) {
    return { ok: false, error: 'rental_pricing_group_invalid' };
  }
  const groupId = rentalPricing.pricing_group_id;
  if (!groupId) return { ok: false, error: 'rental_pricing_group_invalid' };
  const groupRows = svcRows.filter((sr) => serviceRowPricingGroupId(sr) === groupId);
  const boards = groupRows.filter((sr) => String(sr.service_type || '').toLowerCase() === 'surfboard');
  const suits = groupRows.filter((sr) => String(sr.service_type || '').toLowerCase() === 'wetsuit');
  if (groupRows.length !== 2 || boards.length !== 1 || suits.length !== 1) {
    return { ok: false, error: 'rental_pricing_group_invalid' };
  }
  const board = boards[0];
  const suit = suits[0];
  if (Number(board.quantity) !== rentalPricing.quantity || Number(suit.quantity) !== rentalPricing.quantity) {
    return { ok: false, error: 'rental_pricing_group_invalid' };
  }
  if (rentalPricing.service_date) {
    const expected = String(rentalPricing.service_date);
    if (String(board.service_date || '') !== expected || String(suit.service_date || '') !== expected) {
      return { ok: false, error: 'rental_pricing_group_invalid' };
    }
  }
  const boardLoc = normalizeSunsetLocationId(parseMeta(board.metadata).location_id);
  const suitLoc = normalizeSunsetLocationId(parseMeta(suit.metadata).location_id);
  if (boardLoc !== suitLoc) {
    return { ok: false, error: 'rental_pricing_group_invalid' };
  }
  const expectedComponents = rentalPricing.components && rentalPricing.components.length
    ? rentalPricing.components
    : ['surfboard', 'wetsuit'];
  if (expectedComponents.indexOf('surfboard') < 0 || expectedComponents.indexOf('wetsuit') < 0) {
    return { ok: false, error: 'rental_pricing_group_invalid' };
  }
  return { ok: true, bundleRows: [board, suit] };
}

function isFullDayEquipmentAddon(sr) {
  const dbType = String(sr && sr.service_type || '').toLowerCase();
  if (dbType !== 'addon_service') return false;
  const meta = parseMeta(sr && sr.metadata);
  const key = String(meta.service_key || meta.component || '').toLowerCase();
  return key === FULL_DAY_EQUIPMENT_ADDON_KEY;
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
  } else if (dbType === 'addon_service' && isFullDayEquipmentAddon(sr)) {
    // Per person, per day: authoritative price × quantity(people). Never metadata.unit_amount_cents.
    unitCents = findPriceCents(prices, 'rental', FULL_DAY_EQUIPMENT_ADDON_KEY, FULL_DAY_EQUIPMENT_ADDON_UNIT);
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

async function applyBundleRentalPricing(pg, prices, svcRows, rentalPricing) {
  const configuredTotal = configuredRentalBundleTotalCents(prices, rentalPricing);
  if (configuredTotal == null) {
    return { ok: false, error: 'rental_bundle_price_unavailable' };
  }
  if (rentalPricing.quoted_total_cents != null && rentalPricing.quoted_total_cents !== configuredTotal) {
    return {
      ok: false,
      error: 'rental_pricing_quote_mismatch',
      configured_total_cents: configuredTotal,
      quoted_total_cents: rentalPricing.quoted_total_cents,
    };
  }
  const validated = validateBundleRentalGroup(svcRows, rentalPricing);
  if (!validated.ok) return validated;
  const bundleRows = validated.bundleRows.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  let applied = 0;
  for (let i = 0; i < bundleRows.length; i += 1) {
    const due = i === 0 ? configuredTotal : 0;
    await pg.query(
      `UPDATE booking_service_records SET amount_due_cents = $1 WHERE id = $2::uuid`,
      [due, bundleRows[i].id],
    );
    applied += due;
  }
  return { ok: true, total_cents: applied, configured_total_cents: configuredTotal, bundleRowIds: bundleRows.map((r) => String(r.id)) };
}

async function priceSunsetBookingServices(pg, clientSlug, bookingId) {
  const bookingLocRes = await pg.query(
    `SELECT metadata FROM bookings b INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.id = $2::uuid LIMIT 1`,
    [clientSlug, bookingId],
  );
  const bookingMeta = bookingLocRes.rows[0] && bookingLocRes.rows[0].metadata
    ? (typeof bookingLocRes.rows[0].metadata === 'object'
      ? bookingLocRes.rows[0].metadata
      : JSON.parse(bookingLocRes.rows[0].metadata))
    : {};
  const { normalizeSunsetLocationId, resolveRecordLocationId } = require('./sunset-school-locations');
  const locationId = resolveRecordLocationId({}, bookingMeta);
  const adminCfg = await resolveTenantBusinessConfigAsync(clientSlug, { pgClient: pg, locationId });
  if (!adminCfg.ok) return { ok: false, error: 'admin_config_unavailable' };
  const prices = adminCfg.prices || [];
  const rentalPricing = parseRentalPricingMeta(bookingMeta);
  const svcRes = await pg.query(
    `SELECT id, service_type::text AS service_type, service_date::text AS service_date,
            quantity, amount_due_cents, metadata
       FROM booking_service_records
      WHERE client_slug = $1 AND booking_id = $2::uuid`,
    [clientSlug, bookingId],
  );
  let totalCents = 0;
  const bundleRowIds = new Set();
  if (rentalPricing && rentalPricing.offering_key === BOARD_AND_SUIT_OFFERING_KEY) {
    const bundlePriced = await applyBundleRentalPricing(pg, prices, svcRes.rows, rentalPricing);
    if (!bundlePriced.ok) return bundlePriced;
    totalCents += bundlePriced.total_cents;
    (bundlePriced.bundleRowIds || []).forEach((id) => bundleRowIds.add(id));
  }
  for (const sr of svcRes.rows) {
    if (bundleRowIds.has(String(sr.id))) continue;
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

async function findActiveCompatiblePaymentRow(pg, bookingId, paymentKind, amountDueCents, currency) {
  const res = await pg.query(
    `SELECT id::text AS payment_id, checkout_url, stripe_checkout_session_id,
            status::text AS payment_status, amount_due_cents, payment_kind::text AS payment_kind,
            currency, metadata
       FROM payments
      WHERE booking_id = $1::uuid
        AND payment_kind = $2::payment_kind
        AND amount_due_cents = $3
        AND currency = $4
        AND metadata->>'source' = 'sunset_schedule_stripe_link'
        AND status IN ('draft'::payment_record_status, 'checkout_created'::payment_record_status)
      ORDER BY created_at DESC
      LIMIT 1`,
    [bookingId, paymentKind, amountDueCents, currency],
  );
  return res.rows[0] || null;
}

/** @deprecated Use findActiveCompatiblePaymentRow — request keys are observability-only. */
async function findIdempotentPaymentRow(pg, bookingId, idempotencyKey) {
  const res = await pg.query(
    `SELECT id::text AS payment_id, checkout_url, stripe_checkout_session_id,
            status::text AS payment_status, amount_due_cents, metadata
       FROM payments
      WHERE booking_id = $1::uuid
        AND metadata->>'idempotency_key' = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [bookingId, idempotencyKey],
  );
  return res.rows[0] || null;
}

async function lockBookingForPaymentLink(pg, clientSlug, bookingId) {
  const res = await pg.query(
    `SELECT b.id::text AS booking_id
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND b.id = $2::uuid
      FOR UPDATE`,
    [clientSlug, bookingId],
  );
  return res.rows[0] || null;
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
  const requestIdempotencyKey = String(opts.idempotencyKey || '').trim() || null;

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
  const { booking, services } = loaded;
  const meta = parseMeta(booking.metadata);
  const activeLocationId = normalizeSunsetLocationId(opts.locationId);
  const recordLocationId = resolveRecordLocationId(
    parseMeta((services[0] && services[0].metadata) || {}),
    meta,
  );
  if (recordLocationId !== activeLocationId) {
    return { ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } };
  }
  if (!bookingEligibleForScheduleStripeLink(meta)) {
    return { ok: false, status: 403, body: { success: false, error: 'stripe_links_limited_to_schedule_managed_bookings' } };
  }

  const paymentKind = 'full_amount';
  const currency = 'EUR';

  await pg.query('BEGIN');
  try {
    const locked = await lockBookingForPaymentLink(pg, clientSlug, booking.booking_id);
    if (!locked) {
      await pg.query('ROLLBACK');
      return { ok: false, status: 404, body: { success: false, error: 'booking not found' } };
    }

    const priced = await priceSunsetBookingServices(pg, clientSlug, booking.booking_id);
    if (!priced.ok) {
      await pg.query('ROLLBACK');
      const failBody = { success: false, error: priced.error };
      if (priced.configured_total_cents != null) failBody.configured_total_cents = priced.configured_total_cents;
      if (priced.quoted_total_cents != null) failBody.quoted_total_cents = priced.quoted_total_cents;
      return { ok: false, status: 422, body: failBody };
    }

    const amountDueCents = priced.total_cents;
    const stripeIdempotencyKey = buildStripeCheckoutIdempotencyKey({
      clientSlug,
      bookingId: booking.booking_id,
      paymentKind,
      amountDueCents,
      currency,
    });

    const metaStale = !!meta.sunset_stripe_link_stale;
    const idemRow = await findActiveCompatiblePaymentRow(
      pg, booking.booking_id, paymentKind, amountDueCents, currency,
    );
    if (!metaStale && idemRow && idemRow.checkout_url) {
      await pg.query('COMMIT');
      return {
        ok: true,
        status: 200,
        body: attachGuestPaymentFields({
          success: true,
          idempotent: true,
          booking_id: booking.booking_id,
          booking_code: booking.booking_code,
          payment_id: idemRow.payment_id,
          payment_status: idemRow.payment_status,
          amount_due_cents: Number(idemRow.amount_due_cents),
          stripe_mutation: false,
        }, booking.booking_code, idemRow.checkout_url, idemRow.stripe_checkout_session_id, opts),
      };
    }

    if (idemRow && !idemRow.checkout_url && idemRow.stripe_checkout_session_id) {
      const idemMeta = parseMeta(idemRow.metadata);
      const recoveredUrl = idemMeta.payment_link_url
        || (idemMeta.stripe_session_id ? `https://checkout.stripe.com/c/pay/${idemMeta.stripe_session_id}` : null);
      if (!recoveredUrl) {
        await pg.query('ROLLBACK');
        return { ok: false, status: 409, body: { success: false, error: 'stripe_session_recovery_failed' } };
      }
      const expiresAt = null;
      await pg.query(
        `UPDATE payments
            SET status = 'checkout_created'::payment_record_status,
                stripe_checkout_session_id = $1,
                checkout_url = $2,
                expires_at = $3,
                metadata = metadata || $4::jsonb
          WHERE id = $5::uuid`,
        [
          idemRow.stripe_checkout_session_id,
          recoveredUrl,
          expiresAt,
          JSON.stringify({
            stripe_session_id: idemRow.stripe_checkout_session_id,
            payment_link_url: recoveredUrl,
          }),
          idemRow.payment_id,
        ],
      );
      await pg.query('COMMIT');
      await pg.query('BEGIN');
      try {
        await pg.query(
          `UPDATE bookings
              SET payment_status = 'payment_link_sent'::payment_status,
                  metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
            WHERE id = $2::uuid`,
          [JSON.stringify({
            last_stripe_payment_id: idemRow.payment_id,
            last_payment_link_url: recoveredUrl,
            sunset_stripe_link_stale: false,
          }), booking.booking_id],
        );
        await pg.query('COMMIT');
      } catch (err) {
        await pg.query('ROLLBACK');
        throw err;
      }
      return {
        ok: true,
        status: 200,
        body: attachGuestPaymentFields({
          success: true,
          idempotent: true,
          booking_id: booking.booking_id,
          booking_code: booking.booking_code,
          payment_id: idemRow.payment_id,
          payment_status: 'checkout_created',
          amount_due_cents: amountDueCents,
          stripe_mutation: false,
        }, booking.booking_code, recoveredUrl, idemRow.stripe_checkout_session_id, opts),
      };
    }

    const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
    const clientId = clientRes.rows[0] && clientRes.rows[0].id;
    if (!clientId) throw new Error('client not found');

    const pmMeta = {
      source: 'sunset_schedule_stripe_link',
      method: 'payment_link',
      authoritative_intent_key: stripeIdempotencyKey,
      idempotency_key: requestIdempotencyKey,
      booking_code: booking.booking_code,
      created_by: opts.actor && opts.actor.email ? opts.actor.email : null,
      staff_portal: true,
    };

    let paymentId;
    if (idemRow && !idemRow.checkout_url) {
      paymentId = idemRow.payment_id;
    } else {
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
      paymentId = ins.rows[0].payment_id;
    }

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
        idempotency_key: requestIdempotencyKey || stripeIdempotencyKey,
        authoritative_intent_key: stripeIdempotencyKey,
      },
      idempotencyKey: stripeIdempotencyKey,
    });

    await pg.query(
      `UPDATE payments
          SET stripe_checkout_session_id = $1,
              metadata = metadata || $2::jsonb
        WHERE id = $3::uuid`,
      [
        session.id,
        JSON.stringify({
          stripe_session_id: session.id,
          stripe_livemode: session.livemode,
          payment_link_url: session.url,
        }),
        paymentId,
      ],
    );

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

    await pg.query('COMMIT');

    await pg.query('BEGIN');
    try {
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
    } catch (err) {
      await pg.query('ROLLBACK');
      throw err;
    }

    return {
      ok: true,
      status: 201,
      body: attachGuestPaymentFields({
        success: true,
        created: true,
        booking_id: booking.booking_id,
        booking_code: booking.booking_code,
        payment_id: paymentId,
        payment_status: 'checkout_created',
        amount_due_cents: amountDueCents,
        stripe_mutation: true,
        send_mutation: false,
        message: 'Stripe payment link created. Nothing was sent to the guest.',
      }, booking.booking_code, session.url, session.id, opts),
    };
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }
}

async function deleteSunsetScheduleStripeLink(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }
  const bookingId = String(opts.bookingId || '').trim();
  const bookingCode = String(opts.bookingCode || '').trim();
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
  const { booking, services } = loaded;
  const meta = parseMeta(booking.metadata);
  const activeLocationId = normalizeSunsetLocationId(opts.locationId);
  const recordLocationId = resolveRecordLocationId(
    parseMeta((services[0] && services[0].metadata) || {}),
    meta,
  );
  if (recordLocationId !== activeLocationId) {
    return { ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } };
  }
  if (!bookingEligibleForScheduleStripeLink(meta)) {
    return { ok: false, status: 403, body: { success: false, error: 'stripe_links_limited_to_schedule_managed_bookings' } };
  }

  // Void the current link(s): clearing checkout_url removes them from the drawer + short link, and
  // marking the booking stale lets the next "Create link" mint a fresh Stripe session.
  const upd = await pg.query(
    `UPDATE payments
        SET checkout_url = NULL,
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
      WHERE booking_id = $1::uuid
        AND checkout_url IS NOT NULL
        AND status IN ('draft'::payment_record_status, 'checkout_created'::payment_record_status)`,
    [booking.booking_id, JSON.stringify({ voided_by_staff: true, voided_at: new Date().toISOString() })],
  );
  await pg.query(
    `UPDATE bookings
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
      WHERE id = $2::uuid`,
    [JSON.stringify({ sunset_stripe_link_stale: true, last_payment_link_url: null }), booking.booking_id],
  );
  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      deleted: true,
      voided_count: upd.rowCount || 0,
      booking_id: booking.booking_id,
      booking_code: booking.booking_code,
    },
  };
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
  SUNSET_STAGING_PUBLIC_PAYMENT_BASE,
  bookingEligibleForScheduleStripeLink,
  sunsetPaymentLinkObservability,
  attachGuestPaymentFields,
  buildAuthoritativePaymentIntentKey,
  buildStripeCheckoutIdempotencyKey,
  findActiveCompatiblePaymentRow,
  findIdempotentPaymentRow,
  lockBookingForPaymentLink,
  createSunsetScheduleStripeLink,
  deleteSunsetScheduleStripeLink,
  getSunsetSchedulePaymentLink,
  priceSunsetBookingServices,
  loadBookingWithServices,
  serviceRecordUnitPriceCents,
  isFullDayEquipmentAddon,
  findPriceCents,
  normalizeRentalDuration,
  parseRentalPricingMeta,
  configuredRentalBundleTotalCents,
  isBundleRentalServiceRow,
  validateBundleRentalGroup,
  serviceRowPricingGroupId,
  applyBundleRentalPricing,
  BOARD_AND_SUIT_OFFERING_KEY,
  FULL_DAY_EQUIPMENT_ADDON_KEY,
  FULL_DAY_EQUIPMENT_ADDON_UNIT,
};
