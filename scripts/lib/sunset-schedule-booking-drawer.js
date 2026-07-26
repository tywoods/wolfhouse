'use strict';

/**
 * Sunset Schedule — booking drawer context, payment summary, and updates.
 * Sunset client only. Prefer persisted amount_due_cents (including explicit 0 for
 * zeroed bundle peers / course companions). Live Admin fallback only when the
 * amount was never stored (null/undefined).
 */

const crypto = require('crypto');
const {
  normalizeSunsetLocationId,
  resolveRecordLocationId,
  attachLocationToMetadata,
} = require('./sunset-school-locations');

const { resolveTenantBusinessConfigAsync, resolveTenantBusinessConfig } = require('./tenant-business-config');
const {
  SUNSET_CLIENT_SLUG,
  METADATA_SOURCE_TAG,
  DB_SOURCE,
  LUNA_DB_SOURCE,
  LUNA_METADATA_SOURCE_TAG,
  isLunaTrustedActor,
  UI_TO_DB_SERVICE_TYPE,
  DB_TO_UI_SERVICE_TYPE,
  UI_TO_SR_PAYMENT,
  UI_TO_BOOKING_PAYMENT,
  FULL_DAY_EQUIPMENT_ADDON_KEY,
  DEFAULT_LESSON_CATEGORY,
  validateScheduleBookingBody,
  bookingStatusFromPayment,
  componentList,
  resolveFullDayEquipmentAddonUnitCents,
  insertFullDayEquipmentAddonRows,
  prepareCanonicalRentalsForCreate,
  buildSchedulePricingIntent,
  schedulePricingIntentsEqual,
  isSunsetBookingFinanciallyCommitted,
  applyAuthoritativeSchedulePricingInTxn,
  insertScheduleComponentServiceRows,
  lockSchedulePaymentsForUpdate,
  applyEditPaidAmountInTxn,
  paidBookingRepriceRequiredResult,
  PAID_BOOKING_REPRICE_REQUIRED,
  buildRentalPricingDescriptor,
} = require('./sunset-schedule-booking-writes');

const {
  serviceRecordUnitPriceCents,
  isBundleRentalServiceRow,
  parseRentalPricingMeta,
} = require('./sunset-stripe-payment-links');
const { reconcilePendingStripePaymentsForBooking } = require('./stripe-payment-reconcile');

const { loadPrivateLessonFromDb, defaultPrivateLessonApi } = require('./sunset-admin-private-lesson-rules');

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '').trim());
}

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function normalizeUiPayment(ps) {
  const p = String(ps || '').toLowerCase();
  if (p === 'paid' || p === 'complete' || p === 'completed') return 'paid';
  return 'unpaid';
}

// Safe allowlist of paid-method labels stored in booking metadata (does not affect payment math).
const PAYMENT_METHOD_VALUES = new Set(['bank_transfer', 'in_store', 'link']);
function normalizePaymentMethod(m) {
  const v = String(m || '').toLowerCase().trim();
  return PAYMENT_METHOD_VALUES.has(v) ? v : null;
}

function staffUiServiceType(componentKey) {
  if (componentKey === 'lesson') return 'lesson';
  if (componentKey === 'course') return 'course';
  if (componentKey === 'private_lesson') return 'private_lesson';
  if (componentKey === 'surfboard') return 'board_rental';
  return 'wetsuit_rental';
}

function resolveGuestCount(components) {
  if (components.private_lesson) return components.private_lesson.surfer_count;
  if (components.lesson) return components.lesson.quantity;
  if (components.course) return components.course.quantity;
  const keys = componentList(components).filter((k) => k !== FULL_DAY_EQUIPMENT_ADDON_KEY);
  const counts = keys.map((k) => Number(components[k] && components[k].quantity)).filter((n) => Number.isFinite(n));
  return counts.length ? Math.max(...counts) : 1;
}

function bookingHeaderDates(input) {
  const dates = input.service_dates.slice();
  if (input.components.private_lesson) {
    input.components.private_lesson.sessions.forEach((s) => dates.push(s.date));
  }
  const sorted = [...new Set(dates)].sort();
  return { firstDate: sorted[0], lastDate: sorted[sorted.length - 1] };
}
function formatSunsetDrawerDailyItemLabel(dbType, qty, sr) {
  const meta = parseMeta(sr && sr.metadata);
  const component = String(meta.component || sr?.metadata_component || '').toLowerCase();
  const serviceKey = String(meta.service_key || '').toLowerCase();
  const q = Number(qty) || 1;
  const sep = ' · ';
  if (dbType === 'addon_service' && (component === FULL_DAY_EQUIPMENT_ADDON_KEY || serviceKey === FULL_DAY_EQUIPMENT_ADDON_KEY)) {
    // Compact "Name · quantity" only. Localized name resolved by the UI (i18n key
    // schedule.type.fullDayEquipment); server label falls back to the Spanish product name.
    return `Material el resto del día${sep}${q}`;
  }
  if (component === 'course') {
    const name = meta.course_label || sr?.course_label;
    if (name) return `${name}${sep}${q}`;
    const map = DB_TO_UI_SERVICE_TYPE || {};
    return `${map[dbType] || dbType || 'Course'}${sep}${q}`;
  }
  if (component === 'private_lesson') {
    const name = meta.private_lesson_label || 'Private Course';
    return `${name}${sep}${q}`;
  }
  if (dbType === 'surfboard') return `Surfboard${sep}${q}`;
  if (dbType === 'wetsuit') return `Wetsuit${sep}${q}`;
  const map = DB_TO_UI_SERVICE_TYPE || {};
  const ui = map[dbType] || dbType;
  if (ui === 'lesson' || dbType === 'surf_lesson') {
    const name = meta.course_label || sr?.course_label || 'Group Course';
    return `${name}${sep}${q}`;
  }
  return `${ui || 'Item'}${sep}${q}`;
}

function lineItemLabel(dbType, qty, dateIso, slotTime, sr) {
  return formatSunsetDrawerDailyItemLabel(dbType, qty, sr);
}

async function loadSunsetBookingBundle(pg, clientSlug, bookingId, bookingCode) {
  const bookingRes = await pg.query(
    `SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.phone,
            b.status::text AS status, b.payment_status::text AS payment_status,
            b.check_in::text AS check_in, b.check_out::text AS check_out,
            b.guest_count, b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents,
            b.metadata
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
    `SELECT id::text AS service_record_id, service_type::text AS service_type,
            service_date::text AS service_date, quantity,
            amount_due_cents, amount_paid_cents, payment_status::text AS payment_status,
            metadata->>'slot_time' AS slot_time, metadata->>'notes' AS notes,
            metadata->>'staff_ui_service_type' AS staff_ui_service_type,
            metadata->>'component' AS metadata_component,
            metadata->>'components' AS metadata_components,
            metadata->>'location_id' AS location_id,
            metadata->>'source' AS metadata_source,
            metadata->>'staff_manual_schedule' AS staff_manual_schedule,
            metadata->>'course_id' AS course_id,
            metadata->>'course_label' AS course_label,
            service_time_local,
            service_time_local_end,
            metadata
       FROM booking_service_records
      WHERE client_slug = $1 AND booking_id = $2::uuid
      ORDER BY service_date, id`,
    [clientSlug, booking.booking_id],
  );
  const payRes = await pg.query(
    `SELECT id::text AS payment_id, status::text AS payment_status,
            amount_due_cents, amount_paid_cents, checkout_url, created_at
       FROM payments
      WHERE booking_id = $1::uuid AND checkout_url IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [booking.booking_id],
  );
  const paidSumRes = await pg.query(
    `SELECT COALESCE(SUM(amount_paid_cents), 0)::int AS paid_total
       FROM payments
      WHERE booking_id = $1::uuid
        AND status = 'paid'::payment_record_status`,
    [booking.booking_id],
  );
  const payments_paid_cents = Number(paidSumRes.rows[0]?.paid_total || 0);
  return {
    booking,
    services: svcRes.rows,
    payment_link: payRes.rows[0] || null,
    payments_paid_cents,
  };
}

function aggregateComponentsFromServices(services) {
  const components = {};
  let slotTime = null;
  const dates = new Set();
  const privateSessions = [];
  (services || []).forEach((sr) => {
    const dbType = String(sr.service_type || '').toLowerCase();
    const meta = parseMeta(sr.metadata);
    const component = String(meta.component || sr.metadata_component || '').toLowerCase();
    const serviceKey = String(meta.service_key || '').toLowerCase();
    // Full-day equipment add-on: per-date quantity map; its dates do NOT expand the booking date range.
    if (dbType === 'addon_service'
      && (component === FULL_DAY_EQUIPMENT_ADDON_KEY || serviceKey === FULL_DAY_EQUIPMENT_ADDON_KEY)) {
      if (!components[FULL_DAY_EQUIPMENT_ADDON_KEY]) {
        components[FULL_DAY_EQUIPMENT_ADDON_KEY] = { enabled: true, dates: {} };
      }
      const iso = String(sr.service_date || '').slice(0, 10);
      if (iso) components[FULL_DAY_EQUIPMENT_ADDON_KEY].dates[iso] = Number(sr.quantity) || 1;
      return;
    }
    dates.add(String(sr.service_date || '').slice(0, 10));
    const ui = sr.staff_ui_service_type || DB_TO_UI_SERVICE_TYPE[dbType] || component;
    if (component === 'private_lesson' || ui === 'private_lesson') {
      privateSessions.push({
        date: String(sr.service_date || '').slice(0, 10),
        start: sr.service_time_local || sr.slot_time || meta.slot_time || '10:00',
        end: sr.service_time_local_end || '',
      });
      if (!components.private_lesson) {
        components.private_lesson = {
          enabled: true,
          quantity: 0,
          surfer_count: Number(sr.quantity) || 1,
          sessions: [],
        };
      }
      components.private_lesson.quantity += 1;
      components.private_lesson.surfer_count = Number(sr.quantity) || components.private_lesson.surfer_count;
      return;
    }
    let key = ui === 'board_rental' ? 'surfboard'
      : (ui === 'wetsuit_rental' ? 'wetsuit' : (ui === 'course' || component === 'course' ? 'course' : ui));
    if (key === 'lesson' && (meta.course_id || sr.course_id)) key = 'course';
    if (!components[key]) {
      components[key] = {
        quantity: Number(sr.quantity) || 1,
        slot_time: sr.slot_time || meta.slot_time || null,
      };
    } else if (Number(sr.quantity) > Number(components[key].quantity || 0)) {
      components[key].quantity = Number(sr.quantity) || components[key].quantity;
    }
    if (key === 'course') {
      components[key].course_id = meta.course_id || sr.course_id || components[key].course_id || null;
      components[key].course_label = meta.course_label || sr.course_label || components[key].course_label || null;
      if (meta.tier_key) components[key].tier_key = meta.tier_key;
      if (meta.offering_id) components[key].offering_id = meta.offering_id;
    }
    if (key === 'lesson') {
      const slot = sr.slot_time || meta.slot_time || null;
      if (slot) components[key].slot_time = slot;
      const cat = meta.lesson_category || sr.lesson_category || null;
      components[key].category = String(cat || components[key].category || DEFAULT_LESSON_CATEGORY).trim()
        || DEFAULT_LESSON_CATEGORY;
      slotTime = components[key].slot_time || slotTime;
    }
  });
  if (components.private_lesson) {
    components.private_lesson.sessions = privateSessions.sort((a, b) => a.date.localeCompare(b.date));
    components.private_lesson.quantity = components.private_lesson.sessions.length || components.private_lesson.quantity;
  }
  const sortedDates = [...dates].filter(Boolean).sort();
  return {
    components,
    date_from: sortedDates[0] || null,
    date_to: sortedDates[sortedDates.length - 1] || sortedDates[0] || null,
    slot_time: slotTime,
  };
}

function deriveDrawerPaymentUiStatus(booking, subtotalCents, paidCents) {
  const paid = Number(paidCents) || 0;
  const subtotal = Number(subtotalCents) || 0;
  if (paid > 0 && (subtotal === 0 || paid >= subtotal)) return 'paid';
  const raw = String(booking && booking.payment_status || '').toLowerCase();
  if (raw === 'paid' || raw === 'complete' || raw === 'completed') return 'paid';
  return 'unpaid';
}

/** Persisted due amount including explicit 0. null = never stored (live fallback eligible). */
function readPersistedServiceDueCents(sr) {
  if (!sr || sr.amount_due_cents == null || sr.amount_due_cents === '') return null;
  const n = Number(sr.amount_due_cents);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function readAuthoritativeBookingTotalCents(booking) {
  if (!booking || booking.total_amount_cents == null || booking.total_amount_cents === '') return null;
  const n = Number(booking.total_amount_cents);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function readAuthoritativeBalanceDueCents(booking) {
  if (!booking || booking.balance_due_cents == null || booking.balance_due_cents === '') return null;
  const n = Number(booking.balance_due_cents);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function buildPaymentSummary(prices, booking, services, adminSource, paymentsPaidCents, adminCfg) {
  const bookingMeta = parseMeta(booking && booking.metadata);
  const rentalPricing = parseRentalPricingMeta(bookingMeta);
  const lineItems = [];
  let lineSumCents = 0;
  (services || []).forEach((sr) => {
    const persisted = readPersistedServiceDueCents(sr);
    let lineCents = 0;
    let usedLive = false;
    if (persisted != null) {
      // Explicit 0 is create-accounting truth for zeroed bundle/course peers — never reprice.
      lineCents = persisted;
    } else if (rentalPricing && isBundleRentalServiceRow(sr, rentalPricing)) {
      // Ambiguous legacy bundle constituent with null amount: do not invent independent live prices.
      lineCents = 0;
      usedLive = false;
    } else {
      const liveUnit = serviceRecordUnitPriceCents(prices, sr, adminCfg || null);
      usedLive = liveUnit != null;
      if (usedLive) lineCents = liveUnit;
    }
    lineSumCents += lineCents;
    const qty = Number(sr.quantity) || 1;
    const srMeta = parseMeta(sr.metadata);
    lineItems.push({
      service_record_id: sr.service_record_id,
      service_type: sr.service_type,
      service_date: sr.service_date,
      quantity: qty,
      unit_cents: (usedLive || persisted != null) && qty
        ? Math.round(lineCents / qty)
        : null,
      line_cents: lineCents,
      label: lineItemLabel(sr.service_type, sr.quantity, sr.service_date, sr.slot_time, sr),
      priced_live: usedLive,
      pricing_group_id: srMeta.pricing_group_id || null, rental_bundle_id: srMeta.rental_bundle_id || null,
      offering_key: srMeta.offering_key || null, bundle_part: srMeta.bundle_part || null,
      rental_pricing_role: srMeta.rental_pricing_role || null,
      duration_key: srMeta.duration_key || (rentalPricing && rentalPricing.duration) || null,
      rental_service_dates: Array.isArray(srMeta.rental_service_dates) ? srMeta.rental_service_dates : null,
      component: srMeta.component || null, course_id: srMeta.course_id || null, offering_id: srMeta.offering_id || null, tier_key: srMeta.tier_key || null,
    });
  });
  const bookingTotal = readAuthoritativeBookingTotalCents(booking);
  // Prefer server booking total when present so headline money matches create/quote truth.
  const subtotalCents = bookingTotal != null ? bookingTotal : lineSumCents;
  const storedPaid = Number(booking && booking.amount_paid_cents);
  const ledgerPaid = Number(paymentsPaidCents);
  const paidCents = Math.max(
    Number.isFinite(storedPaid) ? storedPaid : 0,
    Number.isFinite(ledgerPaid) ? ledgerPaid : 0,
  );
  const uiStatus = deriveDrawerPaymentUiStatus(booking, subtotalCents, paidCents);
  const storedBalance = readAuthoritativeBalanceDueCents(booking);
  const balanceDue = uiStatus === 'paid'
    ? 0
    : (storedBalance != null ? storedBalance : Math.max(subtotalCents - paidCents, 0));
  return {
    line_items: lineItems,
    subtotal_cents: subtotalCents,
    total_cents: subtotalCents,
    paid_cents: paidCents,
    balance_due_cents: balanceDue,
    payment_status: uiStatus,
    price_source: adminSource || bookingMeta.sunset_price_source || 'config',
    live_pricing: lineItems.some((li) => li.priced_live), rental_pricing: rentalPricing || null,
    pricing_note: bookingTotal != null
      ? 'Totals use persisted booking amount_due; line amounts keep create allocation (explicit zeros preserved).'
      : 'Totals use current Admin prices when line amounts are not stored.',
  };
}

function resolveBundleLocationId(bundle) {
  const meta = parseMeta(bundle && bundle.booking && bundle.booking.metadata);
  let recordLocationId = normalizeSunsetLocationId(meta.location_id || null);
  (bundle && bundle.services || []).some((sr) => {
    const srLoc = sr && sr.location_id;
    if (srLoc) {
      recordLocationId = normalizeSunsetLocationId(srLoc);
      return true;
    }
    return false;
  });
  return recordLocationId;
}

function serviceRecordIsStaffManual(sr) {
  if (!sr) return false;
  if (sr.metadata_source === METADATA_SOURCE_TAG) return true;
  const flag = sr.staff_manual_schedule;
  return flag === true || flag === 'true' || flag === 't';
}

function bundleHasTrustedScheduleDrawerAttribution(bundle) {
  const meta = parseMeta(bundle && bundle.booking && bundle.booking.metadata);
  if (meta.source === METADATA_SOURCE_TAG || meta.staff_manual_schedule) return true;
  if (meta.source === LUNA_METADATA_SOURCE_TAG || meta.luna_guest_booking) return true;
  if (meta.actor_source && isLunaTrustedActor({ source: meta.actor_source })) return true;
  return (bundle && bundle.services || []).some((sr) => {
    if (String(sr.record_source || sr.source || '').toLowerCase() === LUNA_DB_SOURCE) return true;
    return serviceRecordIsStaffManual(sr);
  });
}

/** @deprecated use bundleHasTrustedScheduleDrawerAttribution */
function bundleIsStaffManualSchedule(bundle) {
  return bundleHasTrustedScheduleDrawerAttribution(bundle);
}

async function getSunsetScheduleBookingDrawerContext(pg, opts) {
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
    return { ok: false, status: 400, body: { success: false, error: 'invalid booking_id' } };
  }

  let bundle = await loadSunsetBookingBundle(pg, clientSlug, bookingId, bookingCode);
  if (!bundle) {
    return { ok: false, status: 404, body: { success: false, error: 'booking not found' } };
  }
  const activeLocationId = normalizeSunsetLocationId(opts.locationId);
  const recordLocationId = resolveBundleLocationId(bundle);
  if (recordLocationId !== activeLocationId) {
    return { ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } };
  }
  let paymentReconcile = null;
  if (opts.stripe && bundle.booking && bundle.booking.booking_id) {
    paymentReconcile = await reconcilePendingStripePaymentsForBooking(pg, opts.stripe, {
      clientSlug,
      bookingId: bundle.booking.booking_id,
    });
    if (paymentReconcile && paymentReconcile.reconciled > 0) {
      bundle = await loadSunsetBookingBundle(pg, clientSlug, bundle.booking.booking_id, null);
    }
  }
  const meta = parseMeta(bundle.booking.metadata);
  if (!bundleHasTrustedScheduleDrawerAttribution(bundle)) {
    return { ok: false, status: 403, body: { success: false, error: 'drawer_untrusted_booking_source', reason_code: 'drawer_untrusted_booking_source' } };
  }

  let adminCfg;
  try {
    adminCfg = await resolveTenantBusinessConfigAsync(clientSlug, { locationId: activeLocationId });
  } catch (err) {
    console.error('[schedule drawer] config load failed:', err && err.message);
    adminCfg = resolveTenantBusinessConfig(clientSlug, activeLocationId);
  }
  const prices = adminCfg.ok ? (adminCfg.prices || []) : [];
  const agg = aggregateComponentsFromServices(bundle.services);
  const payment = buildPaymentSummary(
    prices,
    bundle.booking,
    bundle.services,
    adminCfg.source,
    bundle.payments_paid_cents,
    adminCfg,
  );

  let stripeLink = null;
  let paymentLinkInvalidated = meta.payment_link_invalidated === true || meta.sunset_stripe_link_stale === true;
  try {
    const {
      buildPaymentLinkCommand,
      getPaymentStatus,
      PAYMENT_LINK_OPERATIONS,
      PAYMENT_LINK_CHANNELS,
    } = require('./luna-front-desk-payment-link-service');
    const statusBuilt = buildPaymentLinkCommand({
      operation: PAYMENT_LINK_OPERATIONS.GET_STATUS,
      trustedClientSlug: clientSlug,
      channel: PAYMENT_LINK_CHANNELS.STAFF_SCHEDULE,
      bookingId: bundle.booking.booking_id,
      bookingCode: bundle.booking.booking_code,
    });
    if (statusBuilt.ok) {
      const payStatus = await getPaymentStatus(pg, statusBuilt.command);
      if (payStatus.ok) {
        paymentLinkInvalidated = paymentLinkInvalidated || payStatus.body.lifecycle === 'invalidated'
          || payStatus.body.lifecycle === 'cancelled'
          || payStatus.body.lifecycle === 'booking_cancelled';
        if (payStatus.body.actionable && payStatus.body.checkout_url) {
          stripeLink = {
            payment_id: payStatus.body.payment_id,
            payment_status: payStatus.body.payment_status,
            amount_due_cents: payStatus.body.amount_due_cents,
            checkout_url: payStatus.body.checkout_url,
            actionable: true,
            stale: false,
          };
        }
      }
    }
  } catch (payLinkErr) {
    console.error('[schedule drawer] payment status read failed:', payLinkErr && payLinkErr.message);
  }

  const legacyLink = bundle.payment_link;
  const linkStale = paymentLinkInvalidated
    || !!(legacyLink && legacyLink.amount_due_cents != null && Number(legacyLink.amount_due_cents) !== payment.balance_due_cents);
  if (!stripeLink && legacyLink && legacyLink.checkout_url && !paymentLinkInvalidated && !linkStale) {
    stripeLink = {
      payment_id: legacyLink.payment_id,
      payment_status: legacyLink.payment_status,
      amount_due_cents: Number(legacyLink.amount_due_cents),
      checkout_url: legacyLink.checkout_url,
      actionable: true,
      stale: linkStale,
    };
  }
  const link = stripeLink;

  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      booking_id: bundle.booking.booking_id,
      booking_code: bundle.booking.booking_code,
      guest_name: bundle.booking.guest_name,
      phone: bundle.booking.phone || meta.guest_phone || null,
      notes: bundle.services[0] && bundle.services[0].notes ? bundle.services[0].notes : null,
      payment_status: payment.payment_status,
      payment_method: payment.payment_status === 'paid' ? (normalizePaymentMethod(meta.sunset_payment_method) || null) : null,
      date_from: agg.date_from,
      date_to: agg.date_to,
      components: agg.components,
      rentals: Array.isArray(meta.rentals) ? meta.rentals : [],
      rental_pricing: parseRentalPricingMeta(meta) || meta.rental_pricing || null, slot_time: agg.slot_time,
      payment,
      stripe_link: link ? {
        payment_id: link.payment_id,
        payment_status: link.payment_status,
        amount_due_cents: Number(link.amount_due_cents),
        checkout_url: link.checkout_url,
        stale: linkStale,
      } : null,
      stripe_link_stale: linkStale,
      payment_link_invalidated: paymentLinkInvalidated,
      editable: true,
      location_id: recordLocationId,
      payment_reconcile: paymentReconcile,
    },
  };
}

function resolveBookingEditAttribution(bundle, actor) {
  const meta = parseMeta(bundle && bundle.booking && bundle.booking.metadata);
  const originallyLuna = meta.source === LUNA_METADATA_SOURCE_TAG
    || meta.luna_guest_booking === true
    || (meta.actor_source && isLunaTrustedActor({ source: meta.actor_source }))
    || (bundle && bundle.services || []).some((sr) => String(sr.record_source || sr.source || '').toLowerCase() === LUNA_DB_SOURCE);
  if (originallyLuna) {
    return {
      dbSource: LUNA_DB_SOURCE,
      metadataSource: LUNA_METADATA_SOURCE_TAG,
      staffManualSchedule: false,
      lunaGuestBooking: true,
      actorSource: meta.actor_source || null,
      createdByStaff: null,
      lastEditedByStaff: actor && actor.email ? actor.email : null,
    };
  }
  return {
    dbSource: DB_SOURCE,
    metadataSource: METADATA_SOURCE_TAG,
    staffManualSchedule: true,
    lunaGuestBooking: false,
    actorSource: null,
    createdByStaff: actor && actor.email ? actor.email : null,
    lastEditedByStaff: actor && actor.email ? actor.email : null,
  };
}


function pricingIntentFromBundle(bundle) {
  const services = (bundle && bundle.services) || [];
  const agg = aggregateComponentsFromServices(services);
  const meta = parseMeta(bundle && bundle.booking && bundle.booking.metadata);
  let rentals = Array.isArray(meta.rentals) ? meta.rentals.slice() : [];
  if (rentals.length) {
    const cover = {};
    services.forEach((sr) => {
      const m = parseMeta(sr.metadata);
      const ok = String(m.offering_key || '').trim();
      if (!ok) return;
      if (!cover[ok]) cover[ok] = new Set();
      const iso = String(sr.service_date || '').slice(0, 10);
      if (iso) cover[ok].add(iso);
      (m.rental_service_dates || []).forEach((d) => {
        const x = String(d || '').slice(0, 10);
        if (x) cover[ok].add(x);
      });
    });
    rentals = rentals.map((r) => ({
      ...r,
      covered_dates: cover[r.offering_key]
        ? [...cover[r.offering_key]].sort()
        : (r.covered_dates || r.rental_service_dates || []),
      pricing_group_id: r.pricing_group_id
        || (meta.rental_pricing && meta.rental_pricing.pricing_group_id)
        || null,
    }));
  }
  return buildSchedulePricingIntent({
    service_dates: (() => {
      const dates = new Set();
      services.forEach((sr) => {
        const m = parseMeta(sr.metadata);
        const component = String(m.component || sr.metadata_component || '').toLowerCase();
        const ui = String(sr.staff_ui_service_type || '').toLowerCase();
        if (component === FULL_DAY_EQUIPMENT_ADDON_KEY) return;
        if (component === 'private_lesson' || ui === 'private_lesson') return;
        if (String(sr.service_type || '').toLowerCase() === 'addon_service') return;
        const iso = String(sr.service_date || '').slice(0, 10);
        if (iso) dates.add(iso);
      });
      if (!dates.size && agg.date_from) {
        if (agg.date_from) dates.add(agg.date_from);
        if (agg.date_to) dates.add(agg.date_to);
      }
      return [...dates].sort();
    })(),
    components: agg.components,
    rentals,
  }, { rentals });
}

async function updateSunsetScheduleBooking(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }
  const bookingId = String(opts.bookingId || opts.body?.booking_id || '').trim();
  if (!bookingId || !isUuid(bookingId)) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id is required' } };
  }

  const bundle = await loadSunsetBookingBundle(pg, clientSlug, bookingId, null);
  if (!bundle) {
    return { ok: false, status: 404, body: { success: false, error: 'booking not found' } };
  }
  const activeLocationId = normalizeSunsetLocationId(opts.locationId);
  if (resolveBundleLocationId(bundle) !== activeLocationId) {
    return { ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } };
  }
  if (!bundleHasTrustedScheduleDrawerAttribution(bundle)) {
    return { ok: false, status: 403, body: { success: false, error: 'updates_untrusted_booking_source', reason_code: 'updates_untrusted_booking_source' } };
  }

  const rentalPrep = prepareCanonicalRentalsForCreate(opts.body || {});
  if (!rentalPrep.ok) {
    return { ok: false, status: 400, body: { success: false, error: rentalPrep.error, reason: rentalPrep.reason, reason_code: rentalPrep.reason } };
  }

  const validated = validateScheduleBookingBody({
    ...(rentalPrep.present ? rentalPrep.body : (opts.body || {})),
    guest_name: (opts.body && opts.body.guest_name) != null
      ? opts.body.guest_name
      : bundle.booking.guest_name,
  });
  if (!validated.ok) {
    return { ok: false, status: 400, body: { success: false, error: validated.error } };
  }
  const input = validated.value;
  const phoneRaw = opts.body?.guest_phone ?? opts.body?.phone_number ?? opts.body?.phone;
  const guest_phone = phoneRaw != null
    ? String(phoneRaw).trim().slice(0, 40)
    : (bundle.booking.phone || '');
  if (guest_phone) input.guest_phone = guest_phone;

  const srPayment = UI_TO_SR_PAYMENT[input.payment_status];
  const bookingPayment = UI_TO_BOOKING_PAYMENT[input.payment_status];
  const bookingStatus = bookingStatusFromPayment(input.payment_status);
  const paymentMethod = input.payment_status === 'paid'
    ? normalizePaymentMethod(opts.body && opts.body.payment_method)
    : null;
  const editAttribution = resolveBookingEditAttribution(bundle, opts.actor);
  const componentKeys = componentList(input.components);
  const guestCount = resolveGuestCount(input.components);
  const { firstDate, lastDate } = bookingHeaderDates(input);
  let canonicalRentals = rentalPrep.present ? rentalPrep.rentals : null;
  let rentalSpanDates = rentalPrep.present ? rentalPrep.rentalSpanDates : null;
  let rentalPricingGroupId = rentalPrep.present ? rentalPrep.pricingGroupId : null;
  let rentalPricingDescriptor = buildRentalPricingDescriptor(input.rental_pricing, input.service_dates);

  await pg.query('BEGIN');
  try {
    const rollback = async (result) => { await pg.query('ROLLBACK'); return result; };
    // Lock booking by client; re-check active location on locked header+services.
    const lockRes = await pg.query(
      `SELECT b.id::text AS booking_id, b.client_id::text AS client_id,
              b.booking_code, b.guest_name, b.phone,
              b.status::text AS status, b.payment_status::text AS payment_status,
              b.check_in::text AS check_in, b.check_out::text AS check_out,
              b.guest_count, b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents,
              b.metadata
         FROM bookings b
         INNER JOIN clients c ON c.id = b.client_id
        WHERE c.slug = $1 AND b.id = $2::uuid
        FOR UPDATE OF b`,
      [clientSlug, bookingId],
    );
    if (!lockRes.rows.length) {
      return rollback({ ok: false, status: 404, body: { success: false, error: 'booking not found' } });
    }
    const clientId = lockRes.rows[0].client_id;
    const svcLockRes = await pg.query(
      `SELECT id::text AS service_record_id, service_type::text AS service_type,
              service_date::text AS service_date, quantity,
              amount_due_cents, amount_paid_cents, payment_status::text AS payment_status,
              service_time_local, service_time_local_end, metadata, source AS record_source
         FROM booking_service_records
        WHERE client_slug = $1 AND booking_id = $2::uuid
        ORDER BY service_date, id FOR UPDATE`,
      [clientSlug, bookingId],
    );
    // Lock payment ledger (client+booking) before paid/intent decision.
    const payLock = await lockSchedulePaymentsForUpdate(pg, bookingId, clientId);
    const lockedServices = svcLockRes.rows.map((sr) => {
      const m = parseMeta(sr.metadata);
      return Object.assign({}, sr, {
        slot_time: m.slot_time || null,
        staff_ui_service_type: m.staff_ui_service_type || null,
        metadata_component: m.component || null,
        location_id: m.location_id || null,
        metadata_source: m.source || null,
        course_id: m.course_id || null,
        course_label: m.course_label || null,
        lesson_category: m.lesson_category || null,
      });
    });
    const lockedBundle = {
      booking: lockRes.rows[0],
      services: lockedServices,
      payments_paid_cents: payLock.paidCents,
      locked_payments: payLock.rows,
    };
    const recordLocationId = resolveBundleLocationId(lockedBundle);
    if (recordLocationId !== activeLocationId) {
      return rollback({ ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } });
    }
    if (!bundleHasTrustedScheduleDrawerAttribution(lockedBundle)) {
      return rollback({ ok: false, status: 403, body: { success: false, error: 'updates_untrusted_booking_source', reason_code: 'updates_untrusted_booking_source' } });
    }

    const lockedMeta = parseMeta(lockedBundle.booking.metadata);
    // PATCH rentals omitted → preserve existing (not wipe). Explicit present uses prep.
    if (!rentalPrep.present) {
      if (Array.isArray(lockedMeta.rentals) && lockedMeta.rentals.length) {
        canonicalRentals = lockedMeta.rentals;
        if (lockedMeta.rental_pricing) rentalPricingDescriptor = lockedMeta.rental_pricing;
        rentalPricingGroupId = (lockedMeta.rental_pricing && lockedMeta.rental_pricing.pricing_group_id) || null;
      }
    } else if (canonicalRentals) {
      const bundleRental = canonicalRentals.find((r) => r.offering_key === 'board_and_suit_rental');
      if (bundleRental) {
        rentalPricingDescriptor = {
          pricing_group_id: rentalPricingGroupId,
          offering_key: bundleRental.offering_key,
          duration: bundleRental.duration_key,
          quantity: bundleRental.quantity,
          service_date: (rentalSpanDates && rentalSpanDates[0]) || input.service_dates[0],
          components: ['surfboard', 'wetsuit'],
          quoted_total_cents: null,
          rental_service_dates: rentalSpanDates,
        };
      }
    }
    const existingIntent = pricingIntentFromBundle(lockedBundle);
    const requestedIntent = buildSchedulePricingIntent(input, {
      rentals: rentalPrep.present
        ? (rentalPrep.rentals || []).map((r) => ({ ...r, covered_dates: rentalSpanDates || [] }))
        : (canonicalRentals || []),
      rentalCoveredDates: rentalSpanDates || undefined,
      preserveExistingRentals: !rentalPrep.present ? (canonicalRentals || []) : undefined,
    });
    const pricingChanged = !schedulePricingIntentsEqual(existingIntent, requestedIntent);
    if (pricingChanged && isSunsetBookingFinanciallyCommitted(lockedBundle)) {
      return rollback(paidBookingRepriceRequiredResult());
    }

    const bundleId = lockedMeta.bundle_id || crypto.randomBytes(8).toString('hex');
    const headerMetaPatch = attachLocationToMetadata({
      guest_phone: guest_phone || null,
      bundle_id: bundleId,
      components: componentKeys,
      sunset_payment_method: paymentMethod,
      sunset_stripe_link_stale: true,
      sunset_updated_at: new Date().toISOString(),
      source: editAttribution.metadataSource,
      staff_manual_schedule: editAttribution.staffManualSchedule,
      luna_guest_booking: editAttribution.lunaGuestBooking,
      actor_source: editAttribution.actorSource,
      last_edited_by_staff: editAttribution.lastEditedByStaff,
      rentals: canonicalRentals || lockedMeta.rentals || null,
      rental_pricing: rentalPricingDescriptor || lockedMeta.rental_pricing || null,
      notes: input.notes || null,
    }, recordLocationId);

    // Non-pricing: keep service rows/totals. Paid: locked ledger / manual payment row.
    if (!pricingChanged) {
      const headerUpd = await pg.query(
        // MULTICLIENT_SCOPE_OK: Edit header matches Create trust boundary
        `UPDATE bookings
            SET guest_name = $1,
                phone = NULLIF($2, ''),
                status = $3::booking_status,
                payment_status = $4::payment_status,
                guest_count = $5,
                metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb
          WHERE id = $7::uuid AND client_id = $8::uuid`,
        [
          input.guest_name, guest_phone, bookingStatus, bookingPayment, guestCount,
          JSON.stringify(headerMetaPatch), bookingId, clientId,
        ],
      );
      if (Number(headerUpd && headerUpd.rowCount) !== 1) {
        return rollback({ ok: false, status: 409, body: { success: false, error: 'booking_update_conflict' } });
      }
      if (input.payment_status === 'paid') {
        const paidApply = await applyEditPaidAmountInTxn(pg, {
          bookingId, clientId, paymentsPaidCents: lockedBundle.payments_paid_cents,
          paymentMethod, actorEmail: editAttribution.lastEditedByStaff,
        });
        if (!paidApply.ok) return rollback(paidApply);
      }
      await pg.query('COMMIT');
      const ctxKeep = await getSunsetScheduleBookingDrawerContext(pg, { clientSlug, bookingId });
      return {
        ok: true,
        status: 200,
        body: {
          success: true,
          booking_id: bookingId,
          booking_code: lockedBundle.booking.booking_code,
          records: lockedBundle.services,
          pricing_intent_unchanged: true,
          context: ctxKeep.ok ? ctxKeep.body : null,
          stripe_link_stale: true,
        },
      };
    }

    // Reprice: capacity/config after lock (self-exclusion for course seats).
    let privateLessonConfig = defaultPrivateLessonApi();
    if (input.components.private_lesson) {
      const plLoad = await loadPrivateLessonFromDb(pg, { clientSlug, locationId: recordLocationId });
      privateLessonConfig = plLoad.api || privateLessonConfig;
    }

    let addonUnitCents = null;
    if (input.components[FULL_DAY_EQUIPMENT_ADDON_KEY]) {
      addonUnitCents = await resolveFullDayEquipmentAddonUnitCents(pg, clientSlug, recordLocationId);
      if (addonUnitCents == null) {
        return rollback({ ok: false, status: 409, body: { success: false, error: 'full_day_equipment_extension_price_unavailable' } });
      }
    }

    let assignedCourse = null;
    if (input.components.course) {
      const { assertCourseAssignable } = require('./sunset-admin-course-join');
      const { packPriceItemCode } = require('./sunset-admin-price-identity');
      const gate = await assertCourseAssignable(pg, {
        clientSlug,
        locationId: recordLocationId,
        courseId: input.components.course.course_id,
        serviceDates: input.service_dates,
        quantity: input.components.course.quantity,
        excludeBookingId: bookingId,
      });
      if (!gate.ok) return rollback(gate);
      assignedCourse = gate;
      if (!input.components.course.course_label
        || input.components.course.course_label === input.components.course.course_id) {
        input.components.course.course_label = gate.course_label || input.components.course.course_label;
      }
      const tierKey = String(input.components.course.tier_key || '').trim();
      if (tierKey) {
        input.components.course.offering_id = packPriceItemCode(
          input.components.course.course_id,
          tierKey,
        );
      }
    }

    // Re-lock ledger immediately before delete so concurrent payment insert serializes.
    const rePay = await lockSchedulePaymentsForUpdate(pg, bookingId, clientId);
    lockedBundle.payments_paid_cents = rePay.paidCents;
    lockedBundle.locked_payments = rePay.rows;
    if (isSunsetBookingFinanciallyCommitted(lockedBundle)) {
      return rollback(paidBookingRepriceRequiredResult());
    }

    const headerUpd = await pg.query(
      // MULTICLIENT_SCOPE_OK: Edit reprice header
      `UPDATE bookings
          SET guest_name = $1,
              phone = NULLIF($2, ''),
              status = $3::booking_status,
              payment_status = $4::payment_status,
              check_in = $5::date,
              check_out = ($6::date + INTERVAL '1 day')::date,
              guest_count = $7,
              metadata = COALESCE(metadata, '{}'::jsonb) || $8::jsonb
        WHERE id = $9::uuid AND client_id = $10::uuid`,
      [
        input.guest_name, guest_phone, bookingStatus, bookingPayment, firstDate, lastDate,
        guestCount, JSON.stringify(headerMetaPatch), bookingId, clientId,
      ],
    );
    if (Number(headerUpd && headerUpd.rowCount) !== 1) {
      return rollback({ ok: false, status: 409, body: { success: false, error: 'booking_update_conflict' } });
    }

    await pg.query(
      `DELETE FROM booking_service_records
        WHERE client_slug = $1 AND booking_id = $2::uuid AND source = ANY($3::text[])`,
      [clientSlug, bookingId, [DB_SOURCE, LUNA_DB_SOURCE]],
    );

    const bookingCode = lockedBundle.booking.booking_code;
    const createdRows = await insertScheduleComponentServiceRows(pg, {
      clientSlug, bookingId, bookingCode, input, componentKeys,
      attribution: editAttribution, locationId: recordLocationId, srPayment,
      privateLessonConfig, assignedCourse, canonicalRentals, rentalSpanDates,
      rentalPricingGroupId, rentalPricingDescriptor, bundleId,
      privateLessonDefaultLabel: 'Private Course',
      wrapMeta: (meta, loc) => attachLocationToMetadata(meta, loc),
      metaBase: {
        updated_by_staff: editAttribution.lastEditedByStaff,
        last_edited_by_staff: editAttribution.lastEditedByStaff,
      },
    });

    if (input.components[FULL_DAY_EQUIPMENT_ADDON_KEY]) {
      const addonRows = await insertFullDayEquipmentAddonRows(pg, {
        clientSlug,
        bookingId,
        bookingCode,
        guestName: input.guest_name,
        addonDates: input.components[FULL_DAY_EQUIPMENT_ADDON_KEY].dates,
        addonUnitCents,
        componentKeys,
        bundleId,
        locationId: recordLocationId,
        srPayment,
        notes: input.notes || null,
        needsReply: input.needs_reply,
        guestPhone: guest_phone || null,
        actorEmail: editAttribution.lastEditedByStaff,
        idempotencyKey: null,
        attribution: editAttribution,
      });
      addonRows.forEach((r) => createdRows.push(r));
    }

    // Shared Create dual path: exact claim then total/balance before COMMIT.
    await applyAuthoritativeSchedulePricingInTxn(pg, {
      clientSlug, bookingId, clientId, createdRows,
      locationId: recordLocationId,
      lockedPaidCents: lockedBundle.payments_paid_cents,
      canonicalRentals,
      rentalPrepBody: rentalPrep.body,
      quotePrepBody: rentalPrep.body,
      rentalPricingDescriptor,
      quoteChannel: opts.quoteChannel,
      quoteProvenance: opts.quoteProvenance,
      now: opts.now,
    });

    if (input.payment_status === 'paid') {
      const paidApply = await applyEditPaidAmountInTxn(pg, {
        bookingId, clientId, paymentsPaidCents: lockedBundle.payments_paid_cents,
        paymentMethod, actorEmail: editAttribution.lastEditedByStaff,
      });
      if (!paidApply.ok) return rollback(paidApply);
    }

    await pg.query('COMMIT');
    const ctx = await getSunsetScheduleBookingDrawerContext(pg, { clientSlug, bookingId });
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        booking_id: bookingId,
        booking_code: bookingCode,
        records: createdRows,
        context: ctx.ok ? ctx.body : null,
        stripe_link_stale: true,
      },
    };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
    if (err && err.sunsetPriceFail) return err.sunsetPriceFail;
    throw err;
  }
}

// Soft-delete a staff-created schedule booking: mark the booking + its service records cancelled
// so they drop off the schedule (the day query filters out cancelled bookings/records).
async function cancelSunsetScheduleBooking(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }
  const bookingId = String(opts.bookingId || opts.body?.booking_id || '').trim();
  if (!bookingId || !isUuid(bookingId)) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id is required' } };
  }
  const bundle = await loadSunsetBookingBundle(pg, clientSlug, bookingId, null);
  if (!bundle) {
    return { ok: false, status: 404, body: { success: false, error: 'booking not found' } };
  }
  const activeLocationId = normalizeSunsetLocationId(opts.locationId);
  if (resolveBundleLocationId(bundle) !== activeLocationId) {
    return { ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } };
  }
  if (!bundleHasTrustedScheduleDrawerAttribution(bundle)) {
    return { ok: false, status: 403, body: { success: false, error: 'delete_untrusted_booking_source', reason_code: 'delete_untrusted_booking_source' } };
  }
  await pg.query('BEGIN');
  try {
    await pg.query(
      `UPDATE booking_service_records SET status = 'cancelled'
        WHERE client_slug = $1 AND booking_id = $2::uuid AND status <> 'cancelled'`,
      [clientSlug, bookingId],
    );
    const cancelUpd = await pg.query(
      // MULTICLIENT_SCOPE_OK: cancel via client join trust boundary
      `UPDATE bookings b SET status = 'cancelled'::booking_status,
              metadata = COALESCE(b.metadata, '{}'::jsonb) || $1::jsonb
        FROM clients c
        WHERE b.id = $2::uuid AND c.id = b.client_id AND c.slug = $3`,
      [JSON.stringify({ cancelled_by_staff: true, cancelled_at: new Date().toISOString() }), bookingId, clientSlug],
    );
    if (Number(cancelUpd && cancelUpd.rowCount) !== 1) {
      await pg.query('ROLLBACK');
      return { ok: false, status: 409, body: { success: false, error: 'booking_cancel_conflict' } };
    }
    await pg.query('COMMIT');
    return {
      ok: true,
      status: 200,
      body: { success: true, deleted: true, booking_id: bookingId, booking_code: bundle.booking.booking_code },
    };
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }
}

module.exports = {
  resolveBookingEditAttribution,
  getSunsetScheduleBookingDrawerContext,
  updateSunsetScheduleBooking,
  cancelSunsetScheduleBooking,
  buildPaymentSummary,
  deriveDrawerPaymentUiStatus,
  aggregateComponentsFromServices,
  normalizePaymentMethod,
  formatSunsetDrawerDailyItemLabel,
  pricingIntentFromBundle,
  PAID_BOOKING_REPRICE_REQUIRED,
};
