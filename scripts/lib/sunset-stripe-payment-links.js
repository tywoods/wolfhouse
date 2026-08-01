'use strict';

/**
 * Sunset Schedule — Stripe payment links for manual/staff bookings (staging/dev).
 * Sunset client only. Persists to payments table; does not send guest messages.
 */

const crypto = require('crypto');
const {
  normalizeSunsetLocationId,
  isSunsetLocationId,
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

function rentalUnitAliases(unit) {
  const u = String(unit || '').trim();
  if (!u) return [''];
  // Config async path normalizes 1_day → full_day; treat as equivalent for lookup.
  if (u === '1_day' || u === 'full_day') return [u, u === '1_day' ? 'full_day' : '1_day'];
  return [u];
}

function findPriceCents(prices, category, offeringKey, unit) {
  const list = prices || [];
  const cat = String(category || '').toLowerCase();
  const ok = String(offeringKey || '');
  const units = rentalUnitAliases(unit);
  for (const u of units) {
    let row = list.find((p) => p.active !== false
      && String(p.category || '').toLowerCase() === cat
      && String(p.offering_key || '') === ok
      && (!u || String(p.unit || '') === u));
    // DB tenant_price_rules backfill uses item_code = offering__unit (unit often person/day).
    if (!row && u) {
      const combined = `${ok}__${u}`;
      row = list.find((p) => p.active !== false
        && String(p.category || '').toLowerCase() === cat
        && (String(p.offering_key || '') === combined
          || String(p.item_code || '') === combined));
    }
    // Explicit configured zero is a valid free price (not missing).
    if (row && Number.isInteger(row.amount_cents) && row.amount_cents >= 0) {
      return Math.round(Number(row.amount_cents));
    }
    if (row && row.amount != null) {
      const n = Math.round(Number(row.amount) * 100);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}

function priceRowAmountCents(price) {
  if (!price) return null;
  if (Number.isInteger(price.amount_cents) && price.amount_cents >= 0) {
    return Math.round(Number(price.amount_cents));
  }
  if (price.amount == null) return null;
  const n = Math.round(Number(price.amount) * 100);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Live guest quotes must never use baseline unverified_seed rows (e.g. €30
 * group_lesson_adult from sunset.baseline.json). Admin DB / confirmed rows only.
 */
function isLiveQuotableGroupLessonPrice(price) {
  if (!price || price.active === false) return false;
  const status = String(price.pricing_status || price.effective_state || '').toLowerCase();
  if (status === 'unverified_seed' || status === 'owner_required') return false;
  if (price.seed_source && String(price.source || '').toLowerCase() === 'config') return false;
  const key = String(price.offering_key || price.item_code || '');
  const isSlot = /^lesson_slot_/i.test(key);
  const isLegacyAdult = key === LESSON_OFFERING_KEY
    || key === `${LESSON_OFFERING_KEY}__${LESSON_UNIT_KEY}`
    || key === `${LESSON_OFFERING_KEY}__session`;
  if (!isSlot && !isLegacyAdult) return false;
  const source = String(price.source || '').toLowerCase();
  if (source === 'db' || status === 'db' || status === 'confirmed' || status === 'provisional') return true;
  // Slot rows from merged admin catalogs sometimes omit source — allow when not seed-tagged.
  if (isSlot && !price.seed_source && status !== 'unverified_seed') return true;
  return false;
}

/** Authoritative adult/group-lesson unit (per surfer, per session). Never the baseline seed. */
function resolveSunsetGroupLessonUnitCents(prices) {
  const list = prices || [];
  const slotAmounts = [];
  for (const p of list) {
    if (!isLiveQuotableGroupLessonPrice(p)) continue;
    const key = String(p.offering_key || p.item_code || '');
    if (!/^lesson_slot_/i.test(key)) continue;
    const cents = priceRowAmountCents(p);
    if (cents != null) slotAmounts.push(cents);
  }
  if (slotAmounts.length) {
    const unique = [...new Set(slotAmounts)];
    // Generic quote has no slot_id — only safe when all admin slots share one unit.
    if (unique.length === 1) return unique[0];
    return null;
  }

  for (const p of list) {
    if (!isLiveQuotableGroupLessonPrice(p)) continue;
    const key = String(p.offering_key || p.item_code || '');
    const isLegacyAdult = key === LESSON_OFFERING_KEY
      || key === `${LESSON_OFFERING_KEY}__${LESSON_UNIT_KEY}`
      || key === `${LESSON_OFFERING_KEY}__session`;
    if (!isLegacyAdult) continue;
    if (key === LESSON_OFFERING_KEY
      && p.unit != null
      && String(p.unit) !== LESSON_UNIT_KEY
      && String(p.unit) !== 'session') {
      continue;
    }
    const cents = priceRowAmountCents(p);
    if (cents != null) return cents;
  }
  return null;
}

/** Same arithmetic as one surf_lesson service row: unit × surfers; quote sums across dates. */
function computeSunsetGroupLessonQuoteTotalCents(unitCents, quantity, dateCount) {
  const unit = Number(unitCents) || 0;
  const qty = Number(quantity) || 0;
  const dates = Number(dateCount) || 0;
  if (unit <= 0 || qty <= 0 || dates <= 0) return 0;
  return unit * qty * dates;
}

/** Stable server identity for one Sunset authoritative payment intent (request keys excluded). */
function buildAuthoritativePaymentIntentKey(opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  const bookingId = String(opts.bookingId || '').trim();
  const paymentKind = String(opts.paymentKind || 'full_amount').trim();
  const amountDueCents = Number(opts.amountDueCents || 0);
  const currency = String(opts.currency || 'EUR').trim().toUpperCase();
  const generation = String(opts.generation || 'initial').trim();
  const digest = crypto.createHash('sha256')
    .update([clientSlug, bookingId, paymentKind, String(amountDueCents), currency, generation].join('|'))
    .digest('hex')
    .slice(0, 32);
  return `sunset-checkout-${digest}`;
}

function buildStripeCheckoutIdempotencyKey(opts) {
  return buildAuthoritativePaymentIntentKey(opts);
}

function resolveAuthoritativeOutstandingCents(totalCents, authoritativeBalanceDueCents) {
  if (authoritativeBalanceDueCents == null || !Number.isInteger(Number(authoritativeBalanceDueCents))) {
    throw new Error('authoritative balance due cents required');
  }
  const total = Number(totalCents);
  const remaining = Number(authoritativeBalanceDueCents);
  if (!Number.isInteger(total) || total < 0 || remaining < 0 || remaining > total) {
    throw new Error('authoritative balance due cents invalid');
  }
  return remaining;
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

function isStrictIsoCalendarDate(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw;
}

function parseRentalPricingMeta(bookingMeta) {
  const meta = bookingMeta || {};
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
  const rawRentalDates = Array.isArray(rp.rental_service_dates)
    ? rp.rental_service_dates.map((d) => String(d || '').trim())
    : [];
  const rental_service_dates_invalid = Object.prototype.hasOwnProperty.call(rp, 'rental_service_dates')
    && (!Array.isArray(rp.rental_service_dates)
      || rawRentalDates.length === 0
      || rawRentalDates.some((d) => !isStrictIsoCalendarDate(d))
      || new Set(rawRentalDates).size !== rawRentalDates.length);
  const rental_service_dates = rawRentalDates.slice().sort();
  const components = Array.isArray(rp.components)
    ? rp.components.map((c) => String(c || '').trim()).filter(Boolean)
    : [];
  return {
    offering_key,
    duration,
    quantity,
    pricing_group_id,
    service_date,
    rental_service_dates,
    rental_service_dates_invalid,
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

function validateBundleRentalGroup(svcRows, rentalPricing, expectedLocationId) {
  if (!rentalPricing
    || rentalPricing.rental_service_dates_invalid
    || rentalPricing.offering_key !== BOARD_AND_SUIT_OFFERING_KEY) {
    return { ok: false, error: 'rental_pricing_group_invalid' };
  }
  const groupId = rentalPricing.pricing_group_id;
  if (!groupId) return { ok: false, error: 'rental_pricing_group_invalid' };
  const groupRows = svcRows.filter((sr) => serviceRowPricingGroupId(sr) === groupId);
  const expectedDates = rentalPricing.rental_service_dates && rentalPricing.rental_service_dates.length
    ? rentalPricing.rental_service_dates
    : (rentalPricing.service_date ? [String(rentalPricing.service_date)] : []);
  if (!expectedDates.length || expectedDates.some((date) => !isStrictIsoCalendarDate(date))) {
    return { ok: false, error: 'rental_pricing_group_invalid' };
  }
  if (groupRows.length !== expectedDates.length * 2) {
    return { ok: false, error: 'rental_pricing_group_invalid' };
  }
  const expectedDateSet = new Set(expectedDates);
  for (const expectedDate of expectedDates) {
    const dateRows = groupRows.filter((sr) => String(sr.service_date || '') === expectedDate);
    const boards = dateRows.filter((sr) => String(sr.service_type || '').toLowerCase() === 'surfboard');
    const suits = dateRows.filter((sr) => String(sr.service_type || '').toLowerCase() === 'wetsuit');
    if (dateRows.length !== 2 || boards.length !== 1 || suits.length !== 1) {
      return { ok: false, error: 'rental_pricing_group_invalid' };
    }
  }
  if (groupRows.some((sr) => !expectedDateSet.has(String(sr.service_date || '')))) {
    return { ok: false, error: 'rental_pricing_group_invalid' };
  }
  if (groupRows.some((sr) => Number(sr.quantity) !== rentalPricing.quantity)) {
    return { ok: false, error: 'rental_pricing_group_invalid' };
  }
  if (rentalPricing.service_date && !expectedDateSet.has(String(rentalPricing.service_date))) {
    return { ok: false, error: 'rental_pricing_group_invalid' };
  }
  const expectedLocation = String(expectedLocationId || '').trim().toLowerCase();
  if (!isSunsetLocationId(expectedLocation)) {
    return { ok: false, error: 'rental_pricing_group_invalid' };
  }
  const rowLocations = groupRows.map((sr) => String(parseMeta(sr.metadata).location_id || '').trim().toLowerCase());
  if (rowLocations.some((location) => !isSunsetLocationId(location) || location !== expectedLocation)) {
    return { ok: false, error: 'rental_pricing_group_invalid' };
  }
  const expectedComponents = rentalPricing.components && rentalPricing.components.length
    ? rentalPricing.components
    : ['surfboard', 'wetsuit'];
  if (expectedComponents.indexOf('surfboard') < 0 || expectedComponents.indexOf('wetsuit') < 0) {
    return { ok: false, error: 'rental_pricing_group_invalid' };
  }
  return { ok: true, bundleRows: groupRows };
}

function isFullDayEquipmentAddon(sr) {
  const dbType = String(sr && sr.service_type || '').toLowerCase();
  if (dbType !== 'addon_service') return false;
  const meta = parseMeta(sr && sr.metadata);
  const key = String(meta.service_key || meta.component || '').toLowerCase();
  return key === FULL_DAY_EQUIPMENT_ADDON_KEY;
}

function serviceRecordUnitPriceCents(prices, sr, adminCfg) {
  const dbType = String(sr.service_type || '').toLowerCase();
  const qty = Number(sr.quantity) || 1;
  const meta = parseMeta(sr && sr.metadata);
  let unitCents = null;

  // Exact Admin offering identity wins over the generic group-lesson fallback.
  if (meta.offering_id || meta.course_id) {
    const { resolveOfferingUnitCentsForBooking } = require('./sunset-luna-admin-catalog');
    const resolved = resolveOfferingUnitCentsForBooking(adminCfg || { ok: true, source: 'config', prices }, {
      offering_id: meta.offering_id,
      course_id: meta.course_id,
      location_id: meta.location_id,
    });
    if (!resolved.ok || resolved.unit_amount_cents == null || resolved.unit_amount_cents < 0) {
      return null;
    }
    const billing = String(resolved.billing_unit || '').toLowerCase();
    const courseUnit = !!meta.course_id
      || /week|course|bundle|^\d+_day|^\d+_days|^\d+_week/.test(billing);
    // Course/bundle unit: charge once per surfer for the component row (not re-multiplied
    // by days here — each persisted course service row still multiplies by quantity).
    return resolved.unit_amount_cents * qty;
  }

  if (dbType === 'surf_lesson') {
    // Never silently price a free-form course label as a generic €30 lesson.
    if (meta.course_id || String(meta.staff_ui_service_type || '').toLowerCase() === 'course') {
      return null;
    }
    // Ordinary group lesson: admin-authoritative only — never baseline unverified_seed.
    unitCents = resolveSunsetGroupLessonUnitCents(prices);
  } else if (dbType === 'surfboard') {
    const dur = String(meta.duration_key || meta.unit || RENTAL_UNIT_KEY).trim() || RENTAL_UNIT_KEY;
    unitCents = findPriceCents(prices, 'rental', BOARD_OFFERING_KEY, dur);
  } else if (dbType === 'wetsuit') {
    const dur = String(meta.duration_key || meta.unit || RENTAL_UNIT_KEY).trim() || RENTAL_UNIT_KEY;
    unitCents = findPriceCents(prices, 'rental', WETSUIT_OFFERING_KEY, dur);
  } else if (dbType === 'addon_service' && isFullDayEquipmentAddon(sr)) {
    // Per person, per day: authoritative price × quantity(people). Never metadata.unit_amount_cents.
    unitCents = findPriceCents(prices, 'rental', FULL_DAY_EQUIPMENT_ADDON_KEY, FULL_DAY_EQUIPMENT_ADDON_UNIT);
  } else if (
    (dbType === 'addon_service' || meta.rental_offering === true || meta.generic_rental === true)
    && String(meta.offering_key || '').trim()
  ) {
    // Exact offering future-write (board_and_suit + custom catalog): one ordinary row.
    const offeringKey = String(meta.offering_key || '').trim();
    const dur = String(meta.duration_key || meta.unit || RENTAL_UNIT_KEY).trim() || RENTAL_UNIT_KEY;
    unitCents = findPriceCents(prices, 'rental', offeringKey, dur);
  }
  // null = missing/unconfigured; 0 = explicit free (valid).
  if (unitCents == null || unitCents < 0) return null;
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

async function applyBundleRentalPricing(pg, prices, svcRows, rentalPricing, expectedLocationId) {
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
  const validated = validateBundleRentalGroup(svcRows, rentalPricing, expectedLocationId);
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

/**
 * Prefer fail-closed tenant_price_rules for Sunset course / private-lesson /
 * group-slot rows (same loader as rentals). Rentals and Wolfhouse paths are
 * unchanged — only Sunset surf_lesson identities with course/lesson metadata.
 */
async function resolveSunsetServiceDueCents(pg, clientSlug, prices, sr, adminCfg, locationId) {
  const slug = String(clientSlug || '').trim();
  if (slug !== SUNSET_CLIENT_SLUG) {
    return serviceRecordUnitPriceCents(prices, sr, adminCfg);
  }
  const meta = parseMeta(sr && sr.metadata);
  const { resolveActiveSunsetAdminPrice } = require('./sunset-admin-price-resolve');
  const loc = meta.location_id || locationId;

  // Prefer generic Admin identity for ANY Sunset service that carries enough
  // offering metadata. Service-type hard-coded prices are not consulted first.
  const live = await resolveActiveSunsetAdminPrice(pg, {
    clientSlug: slug,
    locationId: loc,
    quantity: Number(sr.quantity) || 1,
    metadata: { ...meta, location_id: loc, service_type: sr.service_type },
    pgClient: pg,
  });

  // Explicit configured zero is valid (free product). Only missing/unpriced is null.
  if (live.ok === true && live.amount_cents != null && Number(live.amount_cents) >= 0) {
    return Number(live.amount_cents);
  }

  // Course/lesson fail closed when identity was claimed but price missing.
  const {
    isCourseOrLessonServiceRecord,
  } = require('./sunset-course-lesson-price-lookup');
  if (isCourseOrLessonServiceRecord(sr, meta)) {
    if (live.reason === 'tables_missing' || live.reason === 'db_read_disabled') {
      return serviceRecordUnitPriceCents(prices, sr, adminCfg);
    }
    return null;
  }

  // Course-owned equipment free snapshot: during_course / all_day unit is 0.
  if (meta.course_equipment === true) {
    const mode = meta.course_equipment_mode === 'all_day' ? 'all_day' : 'during_course';
    const modeField = mode === 'all_day' ? 'all_day_price_cents' : 'during_course_price_cents';
    if (meta[modeField] === 0 || meta[modeField] === '0') return 0;
    if (meta.unit_amount_cents === 0 || meta.unit_amount_cents === '0') return 0;
  }

  // Rentals / addons: keep legacy merged-prices helper only when identity could
  // not be formed (older rows). Never use baseline when Admin DB is authoritative
  // and identity resolved to not_found.
  if (live.reason === 'price_not_configured' || live.reason === 'ambiguous_price') {
    return null;
  }
  return serviceRecordUnitPriceCents(prices, sr, adminCfg);
}

/**
 * True when service metadata proves an explicit configured free unit price
 * (course equipment during_course / all_day, or snapshotted unit_amount 0).
 * Missing/unknown prices are NOT free.
 */
function isExplicitFreeServiceMeta(meta) {
  const m = meta || {};
  if (m.course_equipment === true) {
    const mode = m.course_equipment_mode === 'all_day' ? 'all_day' : 'during_course';
    const modeField = mode === 'all_day' ? 'all_day_price_cents' : 'during_course_price_cents';
    if (m[modeField] === 0 || m[modeField] === '0') return true;
    if (m.unit_amount_cents === 0 || m.unit_amount_cents === '0') return true;
    if (m.during_course_price_cents === 0 && mode === 'during_course') return true;
    if (m.all_day_price_cents === 0 && mode === 'all_day') return true;
  }
  if ((m.rental_offering === true || m.generic_rental === true)
    && (m.unit_amount_cents === 0 || m.unit_amount_cents === '0')) {
    return true;
  }
  return false;
}

function courseOfferingGroupKey(meta) {
  const m = meta || {};
  const offering = String(m.offering_id || '').trim();
  if (/^surf_pack_.+__.+$/i.test(offering)) return offering;
  const courseId = m.course_id != null ? String(m.course_id).trim() : '';
  const tierKey = (m.tier && m.tier.key) || m.tier_key || m.duration_key || '';
  if (courseId && tierKey) {
    const { packPriceItemCode } = require('./sunset-course-lesson-price-lookup');
    return packPriceItemCode(courseId, tierKey);
  }
  return courseId || null;
}

function isCourseServiceMeta(meta) {
  const m = meta || {};
  const component = String(m.component || m.staff_ui_service_type || '').toLowerCase();
  return component === 'course' || !!m.course_id;
}

/** Operator-facing copy for portal; keep reason_code for logs only. */
function staffFacingSunsetPriceError(reasonCode) {
  return require('./sunset-course-lesson-price-lookup').staffFacingSunsetPriceError(reasonCode);
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
  // Historical dual-component board_and_suit (pricing_group + halves) vs future
  // exact offering (one addon_service row, empty components, no group).
  // Historical path stays fail-closed on tampered groups; exact path prices
  // independently below.
  if (rentalPricing && rentalPricing.offering_key === BOARD_AND_SUIT_OFFERING_KEY) {
    const hasExactOfferingRow = svcRes.rows.some((sr) => {
      const m = parseMeta(sr.metadata);
      return m.rental_offering === true
        && String(m.offering_key || '') === BOARD_AND_SUIT_OFFERING_KEY
        && (String(sr.service_type || '').toLowerCase() === 'addon_service'
          || m.component === BOARD_AND_SUIT_OFFERING_KEY);
    });
    const claimsHistoricalDescriptor = !!(rentalPricing.pricing_group_id)
      || (Array.isArray(rentalPricing.components) && rentalPricing.components.length > 0);
    const hasHistoricalHalfRows = svcRes.rows.some((sr) => {
      const m = parseMeta(sr.metadata);
      const st = String(sr.service_type || '').toLowerCase();
      return (st === 'surfboard' || st === 'wetsuit'
        || m.bundle_part === 'surfboard' || m.bundle_part === 'wetsuit')
        && !!serviceRowPricingGroupId(sr);
    });
    // Prefer exact offering when present and descriptor is not historical.
    const useHistoricalBundle = !hasExactOfferingRow
      && (claimsHistoricalDescriptor || hasHistoricalHalfRows);
    if (useHistoricalBundle) {
      const bundlePriced = await applyBundleRentalPricing(
        pg, prices, svcRes.rows, rentalPricing, locationId,
      );
      if (!bundlePriced.ok) return bundlePriced;
      totalCents += bundlePriced.total_cents;
      (bundlePriced.bundleRowIds || []).forEach((id) => bundleRowIds.add(id));
    }
  }
  // Whole-course Admin tiers (week/package): charge once per offering × quantity,
  // never re-multiply by every expanded service date row.
  const coursePrimaryRowId = new Map();
  const courseSorted = svcRes.rows.slice().sort((a, b) => {
    const d = String(a.service_date || '').localeCompare(String(b.service_date || ''));
    if (d) return d;
    return String(a.id).localeCompare(String(b.id));
  });
  for (const sr of courseSorted) {
    const meta = parseMeta(sr.metadata);
    if (!isCourseServiceMeta(meta)) continue;
    const key = courseOfferingGroupKey(meta);
    if (!key) continue;
    if (!coursePrimaryRowId.has(key)) coursePrimaryRowId.set(key, String(sr.id));
  }

  let priceSource = adminCfg.source || 'config';
  for (const sr of svcRes.rows) {
    if (bundleRowIds.has(String(sr.id))) continue;
    const meta = parseMeta(sr.metadata);
    if (isCourseServiceMeta(meta)) {
      const key = courseOfferingGroupKey(meta);
      if (key && coursePrimaryRowId.get(key) !== String(sr.id)) {
        await pg.query(
          `UPDATE booking_service_records SET amount_due_cents = $1 WHERE id = $2::uuid`,
          [0, sr.id],
        );
        continue;
      }
    }
    const storedRaw = sr.amount_due_cents;
    const hasStored = storedRaw != null && storedRaw !== '' && Number.isFinite(Number(storedRaw));
    let due = hasStored ? Number(storedRaw) : null;

    // Positive stored amount is authoritative for this reprice pass.
    if (due != null && due > 0) {
      totalCents += due;
      continue;
    }

    // Zero or missing: re-resolve. Explicit free (configured 0) is valid;
    // missing/unpriced remains fail-closed.
    const resolved = await resolveSunsetServiceDueCents(
      pg, clientSlug, prices, sr, adminCfg, locationId,
    );
    if (resolved != null && Number.isFinite(Number(resolved)) && Number(resolved) >= 0) {
      due = Number(resolved);
      if (String(clientSlug).trim() === SUNSET_CLIENT_SLUG
        && (meta.course_id || meta.component === 'course' || meta.component === 'private_lesson'
          || meta.component === 'lesson' || meta.staff_ui_service_type === 'course'
          || meta.staff_ui_service_type === 'private_lesson')) {
        priceSource = 'db';
      }
      if (!hasStored || Number(storedRaw) !== due) {
        await pg.query(
          `UPDATE booking_service_records SET amount_due_cents = $1 WHERE id = $2::uuid`,
          [due, sr.id],
        );
      }
      totalCents += due;
      continue;
    }

    // Resolve miss: accept only when stored 0 is an explicit free snapshot.
    if (hasStored && Number(storedRaw) === 0 && isExplicitFreeServiceMeta(meta)) {
      totalCents += 0;
      continue;
    }

    return { ok: false, error: `no_price_for_${sr.service_type}` };
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
      JSON.stringify({ sunset_priced_at: new Date().toISOString(), sunset_price_source: priceSource }),
      bookingId,
    ],
  );
  return { ok: true, total_cents: totalCents, sunset_price_source: priceSource };
}

/**
 * Price a just-created Sunset booking via the DB-authoritative path.
 * On failure, cancel the booking so we never leave a silent €0 confirmed row.
 * Sunset-only helper used by both the staff manual and Luna create routes.
 */
async function priceSunsetBookingAfterCreate(pg, clientSlug, bookingId) {
  const slug = String(clientSlug || '').trim();
  if (slug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, error: 'unsupported_client', client_slug: slug };
  }
  const id = String(bookingId || '').trim();
  if (!id) return { ok: false, error: 'booking_id_required' };

  let priced;
  try {
    priced = await priceSunsetBookingServices(pg, slug, id);
  } catch (err) {
    priced = { ok: false, error: 'pricing_failed', detail: err && err.message };
  }
  if (priced && priced.ok) return priced;

  const errCode = (priced && priced.error) || 'pricing_failed';
  try {
    await pg.query(
      `UPDATE bookings
          SET status = 'cancelled',
              metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $1::uuid`,
      [id, JSON.stringify({
        sunset_price_failed: true,
        sunset_price_error: errCode,
        sunset_price_failed_at: new Date().toISOString(),
      })],
    );
    await pg.query(
      `UPDATE booking_service_records
          SET status = 'cancelled'
        WHERE booking_id = $1::uuid`,
      [id],
    );
  } catch (_) {
    // Best-effort cancel — surface the original pricing error regardless.
  }
  return {
    ok: false,
    error: errCode,
    booking_cancelled: true,
    booking_id: id,
    priced: priced || null,
  };
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
  if (!env.staffActions) return { ok: false, status: 403, error: 'staff_actions_disabled' };
  if (!env.stripeLinks) return { ok: false, status: 403, error: 'stripe_links_disabled' };
  if (!env.secretKey) return { ok: false, status: 503, error: 'payment_provider_unavailable' };
  if (String(env.secretKey).startsWith('sk_live_')) {
    return { ok: false, status: 403, error: 'payment_provider_not_allowed' };
  }
  if (!env.successUrl || !env.cancelUrl) {
    return { ok: false, status: 503, error: 'payment_provider_unavailable' };
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
    `SELECT b.id::text AS booking_id, b.metadata
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND b.id = $2::uuid
      FOR UPDATE`,
    [clientSlug, bookingId],
  );
  return res.rows[0] || null;
}

async function invalidateObsoleteActivePaymentRows(pg, bookingId, amountDueCents, invalidateAll) {
  return pg.query(
    `UPDATE payments
        SET status = 'cancelled'::payment_record_status,
            checkout_url = NULL,
            expires_at = COALESCE(expires_at, NOW()),
            metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
      WHERE booking_id = $1::uuid
        AND metadata->>'source' = 'sunset_schedule_stripe_link'
        AND status IN ('draft'::payment_record_status, 'checkout_created'::payment_record_status)
        AND ($2::boolean OR amount_due_cents <> $4)`,
    [bookingId, invalidateAll === true, JSON.stringify({
      payment_link_invalidated: true,
      invalidation_reason: 'authoritative_balance_replacement',
    }), amountDueCents],
  );
}

async function createSunsetScheduleStripeLink(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }

  // Location is an authorization input, never a default. Reject before env,
  // normalization, database, or provider work.
  const suppliedLocationId = typeof opts.locationId === 'string' ? opts.locationId : '';
  const rawLocationId = suppliedLocationId.trim();
  if (!rawLocationId || suppliedLocationId !== rawLocationId || !isSunsetLocationId(rawLocationId)
    || rawLocationId !== normalizeSunsetLocationId(rawLocationId)) {
    return { ok: false, status: 400, body: { success: false, error: 'unsupported_location' } };
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
  const activeLocationId = rawLocationId;
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

    let authoritativeBalanceDueCents = opts.authoritativeBalanceDueCents;
    if (authoritativeBalanceDueCents == null) {
      const paidRes = await pg.query(
        `SELECT COALESCE(SUM(p.amount_paid_cents), 0)::bigint AS paid_cents
           FROM payments p
          WHERE p.booking_id = $1::uuid
            AND p.status = 'paid'::payment_record_status`,
        [booking.booking_id],
      );
      const paidCents = Number(paidRes.rows[0] && paidRes.rows[0].paid_cents || 0);
      authoritativeBalanceDueCents = Math.max(0, priced.total_cents - paidCents);
    }
    let amountDueCents;
    try {
      amountDueCents = resolveAuthoritativeOutstandingCents(
        priced.total_cents,
        authoritativeBalanceDueCents,
      );
    } catch (err) {
      await pg.query('ROLLBACK');
      return { ok: false, status: 409, body: { success: false, error: 'authoritative_balance_unavailable' } };
    }
    if (amountDueCents <= 0) {
      await pg.query('ROLLBACK');
      return { ok: false, status: 422, body: { success: false, error: 'no_payment_due', message: 'No outstanding balance due.', amount_due_cents: 0 } };
    }
    const lockedMeta = parseMeta(locked.metadata);
    const stripeIdempotencyKey = buildStripeCheckoutIdempotencyKey({
      clientSlug,
      bookingId: booking.booking_id,
      paymentKind,
      amountDueCents,
      currency,
      generation: lockedMeta.payment_link_generation || 'initial',
    });

    // Re-read metadata from the row locked after any concurrent request. A
    // pre-lock drawer snapshot must never force a second replacement.
    const metaStale = !!lockedMeta.sunset_stripe_link_stale;
    await invalidateObsoleteActivePaymentRows(pg, booking.booking_id, amountDueCents, metaStale);
    const idemRow = await findActiveCompatiblePaymentRow(
      pg, booking.booking_id, paymentKind, amountDueCents, currency,
    );
    if (idemRow && idemRow.checkout_url) {
      await pg.query(
        `UPDATE bookings
            SET payment_status = 'payment_link_sent'::payment_status,
                metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
          WHERE id = $2::uuid`,
        [JSON.stringify({
          last_stripe_payment_id: idemRow.payment_id,
          last_payment_link_url: idemRow.checkout_url,
          sunset_stripe_link_stale: false,
          payment_link_invalidated: false,
        }), booking.booking_id],
      );
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
            payment_link_invalidated: false,
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

    await pg.query(
      `UPDATE bookings
          SET payment_status = 'payment_link_sent'::payment_status,
              metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
        WHERE id = $2::uuid`,
      [JSON.stringify({
        last_stripe_payment_id: paymentId,
        last_payment_link_url: session.url,
        sunset_stripe_link_stale: false,
        payment_link_invalidated: false,
      }), booking.booking_id],
    );
    await pg.query('COMMIT');

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
  const suppliedLocationId = typeof opts.locationId === 'string' ? opts.locationId : '';
  const rawLocationId = suppliedLocationId.trim();
  if (!rawLocationId || suppliedLocationId !== rawLocationId || !isSunsetLocationId(rawLocationId)
    || rawLocationId !== normalizeSunsetLocationId(rawLocationId)) {
    return { ok: false, status: 400, body: { success: false, error: 'unsupported_location' } };
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
  const activeLocationId = rawLocationId;
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
    [JSON.stringify({
      sunset_stripe_link_stale: true,
      last_payment_link_url: null,
      payment_link_invalidated: true,
      payment_link_generation: crypto.randomUUID(),
    }), booking.booking_id],
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
  const {
    buildPaymentLinkCommand,
    getPaymentStatus,
    PAYMENT_LINK_OPERATIONS,
    PAYMENT_LINK_CHANNELS,
  } = require('./luna-front-desk-payment-link-service');
  const built = buildPaymentLinkCommand({
    operation: PAYMENT_LINK_OPERATIONS.GET_STATUS,
    trustedClientSlug: opts.clientSlug,
    channel: PAYMENT_LINK_CHANNELS.STAFF_SCHEDULE,
    bookingId: opts.bookingId,
    bookingCode: opts.bookingCode,
  });
  if (!built.ok) {
    return { ok: false, status: built.status || 400, body: built.body };
  }
  const result = await getPaymentStatus(pg, built.command);
  if (!result.ok) return result;
  return {
    ok: true,
    status: result.status,
    body: attachGuestPaymentFields(
      result.body,
      result.body.booking_code,
      result.body.checkout_url,
      null,
      opts,
    ),
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
  resolveAuthoritativeOutstandingCents,
  findActiveCompatiblePaymentRow,
  findIdempotentPaymentRow,
  lockBookingForPaymentLink,
  createSunsetScheduleStripeLink,
  deleteSunsetScheduleStripeLink,
  getSunsetSchedulePaymentLink,
  priceSunsetBookingServices,
  priceSunsetBookingAfterCreate,
  staffFacingSunsetPriceError,
  loadBookingWithServices,
  serviceRecordUnitPriceCents,
  isFullDayEquipmentAddon,
  findPriceCents,
  isLiveQuotableGroupLessonPrice,
  resolveSunsetGroupLessonUnitCents,
  computeSunsetGroupLessonQuoteTotalCents,
  LESSON_OFFERING_KEY,
  LESSON_UNIT_KEY,
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
