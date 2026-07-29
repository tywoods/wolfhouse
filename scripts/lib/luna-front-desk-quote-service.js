'use strict';

/**
 * Luna Front Desk — canonical Sunset quote application service (read-only).
 *
 * Shared by Staff schedule preview and Luna bot offering-quote. Never writes
 * bookings, service records, payments, or Stripe sessions.
 *
 * See docs/LUNA-FRONT-DESK-DOMAIN-CONTRACT.md §2.5, §3.
 */

const crypto = require('crypto');
const { normalizeSunsetBookingDatesInBody } = require('./sunset-guest-date-intake');
const { parseQuoteQuantity } = require('./sunset-group-lesson-quote');
const {
  catalogCommandFromQuoteCommand,
  executeSunsetCatalog,
  executeSunsetCatalogSync,
  findCatalogOffering,
} = require('./luna-front-desk-catalog-service');
const { SUNSET_CLIENT_SLUG } = require('./sunset-bookable-offerings');
const { evaluateSunsetOfferingDates } = require('./sunset-offering-schedule');
const { resolveActiveSunsetAdminPrice } = require('./sunset-admin-price-resolve');
const { packPriceItemCode } = require('./sunset-admin-price-identity');
const {
  normalizeComponents,
  validateScheduleBookingBody,
  normalizeCustomLineItems,
  buildCustomLineQuoteLines,
  applyNoLessonEquipmentQtyFromSurfers,
  STAFF_CUSTOM_LINE_COMPONENT,
} = require('./sunset-schedule-booking-writes');
const { assertCourseAssignable } = require('./sunset-admin-course-join');
const { staffFacingSunsetPriceError } = require('./sunset-course-lesson-price-lookup');
const {
  normalizeSunsetLocationId,
  isSunsetLocationId,
} = require('./sunset-school-locations');
const { isSunsetAdminDbReadEnabled } = require('./tenant-business-config');
const {
  quoteCourseEquipment,
  checkedAdd: checkedCourseEquipmentAdd,
} = require('./sunset-course-equipment-pricing');
const {
  MAX_GROUP_COURSE_INCLUSIVE_DAYS,
  groupCourseAdminTierKeyForInclusiveDays,
  groupCourseUnitCentsFromSevenDayAdmin,
} = require('./sunset-admin-duration-keys');

const QUOTE_CHANNELS = Object.freeze({
  MANUAL_STAFF: 'manual_staff',
  LUNA_WHATSAPP: 'luna_whatsapp',
});

const QUOTE_PROVENANCE_VERSION = 2;

const CLIENT_MONEY_FIELDS = [
  'unit_amount_cents', 'amount_cents', 'total_cents', 'line_total_cents',
  'unit_price', 'unit_amount', 'line_total', 'currency_amount', 'price_source',
];

function rejectClientSuppliedMoney(body) {
  const b = body && typeof body === 'object' ? body : {};
  for (const key of CLIENT_MONEY_FIELDS) {
    if (b[key] !== undefined && b[key] !== null && b[key] !== '') {
      return { ok: false, reason: 'client_money_rejected', field: key };
    }
  }
  if (b.components && typeof b.components === 'object') {
    for (const [compKey, compVal] of Object.entries(b.components)) {
      if (!compVal || typeof compVal !== 'object') continue;
      for (const key of CLIENT_MONEY_FIELDS) {
        if (compVal[key] !== undefined && compVal[key] !== null && compVal[key] !== '') {
          return { ok: false, reason: 'client_money_rejected', field: `components.${compKey}.${key}` };
        }
      }
    }
  }
  if (Array.isArray(b.rentals)) {
    for (let i = 0; i < b.rentals.length; i += 1) {
      const row = b.rentals[i];
      if (!row || typeof row !== 'object') continue;
      for (const key of CLIENT_MONEY_FIELDS) {
        if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
          return { ok: false, reason: 'client_money_rejected', field: `rentals[${i}].${key}` };
        }
      }
      for (const key of ['amount', 'price', 'label', 'unit_price']) {
        if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
          return { ok: false, reason: 'client_money_rejected', field: `rentals[${i}].${key}` };
        }
      }
    }
  }
  if (b.price && typeof b.price === 'object') {
    for (const key of ['amount_cents', 'unit_amount_cents', 'total_cents']) {
      if (b.price[key] !== undefined && b.price[key] !== null) {
        return { ok: false, reason: 'client_money_rejected', field: `price.${key}` };
      }
    }
  }
  return { ok: true };
}

function buildSunsetQuoteCommand(opts) {
  const channel = String((opts && opts.channel) || '').trim();
  if (!Object.values(QUOTE_CHANNELS).includes(channel)) {
    return { ok: false, status: 400, body: { success: false, reason_code: 'invalid_channel', error: 'invalid quote channel' } };
  }
  const rawLoc = opts && opts.trustedLocationId;
  const locationId = normalizeSunsetLocationId(rawLoc);
  if (rawLoc != null && String(rawLoc).trim() && !isSunsetLocationId(rawLoc)) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        reason_code: 'wrong_location',
        reason: 'wrong_location',
        error: 'wrong location',
        location_id: String(rawLoc).trim(),
      },
    };
  }
  const transportBody = (opts && opts.transportBody) || {};
  const moneyReject = rejectClientSuppliedMoney(transportBody);
  if (!moneyReject.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        reason_code: moneyReject.reason,
        error: 'Client-supplied price fields are not accepted.',
        field: moneyReject.field,
      },
    };
  }
  return {
    ok: true,
    command: {
      channel,
      clientSlug: SUNSET_CLIENT_SLUG,
      locationId,
      transportBody,
      now: (opts && opts.now) instanceof Date ? opts.now : new Date(),
    },
  };
}

function resolveQuoteRequireDb(transportBody) {
  if (transportBody && (transportBody.require_db === true || transportBody.requireDb === true)) {
    return true;
  }
  return isSunsetAdminDbReadEnabled();
}

function computeBillableUnits(offering, serviceDates, quantity) {
  const dates = serviceDates || [];
  const unit = String(
    offering.billing_unit || (offering.price && offering.price.unit) || '',
  ).toLowerCase();
  // Short rental windows bill unit × qty once (not × multi-day date span).
  const shortDur = offering.tier_key || offering.duration_key
    || (offering.item_code && String(offering.item_code).includes('__')
      ? String(offering.item_code).split('__').slice(1).join('__')
      : null);
  if (offering.offering_type === 'rental' && isShortRentalDurationKey(shortDur)) {
    return quantity;
  }
  const sessionUnit = /session|single_lesson|person/.test(unit)
    && offering.offering_type !== 'course';
  const courseUnit = offering.offering_type === 'course'
    || offering.billing_mode === 'whole_offering_x_qty'
    || /week|course|bundle|day|^\d+_day|^\d+_days|^\d+_week/.test(unit);

  if (sessionUnit && !dates.length) return null;
  if (sessionUnit) return quantity * dates.length;
  if (courseUnit) return quantity;
  return quantity * Math.max(1, dates.length || 1);
}

function nestOfferingForQuote(raw) {
  const tierOrDuration = raw.tier_key
    || (raw.tier && raw.tier.key)
    || raw.duration_key
    || null;
  return {
    offering_id: raw.offering_id,
    offering_type: raw.offering_type,
    course_id: raw.course_id || null,
    // Course-owned multi-item equipment options (server labels/cents). No legacy
    // equipment_included / scalar equipment_price_cents on the current quote path.
    equipment_options: Array.isArray(raw.equipment_options)
      ? raw.equipment_options.map((row) => ({ ...row }))
      : [],
    tier_key: tierOrDuration,
    // Rental windows use duration_key canonically; keep in sync with tier_key so
    // async Admin re-resolve cannot drop multi-day identity.
    duration_key: raw.duration_key || tierOrDuration || null,
    label: raw.label,
    billing_unit: raw.billing_unit,
    billing_mode: raw.billing_mode || null,
    unit_amount_cents: raw.unit_amount_cents,
    currency: raw.currency || 'EUR',
    price_id: (raw.price_identity && raw.price_identity.price_id) || raw.price_id || null,
    price_source: raw.price_source || 'admin_db',
    offering_item_code: raw.offering_item_code || raw.item_code || raw.offering_id,
    item_code: raw.item_code || raw.offering_item_code || raw.offering_id,
    price_identity: raw.price_identity || null,
    schedule: raw.schedule || null,
    schedule_summary: raw.schedule && raw.schedule.summary,
  };
}

/**
 * Build course-owned equipment quote lines for Group/Private.
 * selection is wire array [{offering_key, mode, quantity}]; server owns cents/labels.
 */
function buildCourseEquipmentQuoteLines({
  selection,
  course,
  surfers,
  locationId,
  catalog,
}) {
  if (selection == null) return { ok: true, lines: [], total_cents: 0, course_equipment: null };
  const offerings = (catalog && catalog._adminCfg && catalog._adminCfg.rental_offerings)
    || (catalog && catalog.rental_offerings)
    || null;
  let equipmentQuote;
  try {
    equipmentQuote = quoteCourseEquipment({
      course,
      selection,
      surfers,
      offerings,
      clientSlug: SUNSET_CLIENT_SLUG,
      locationId,
    });
  } catch (err) {
    return {
      ok: false,
      status: 422,
      body: {
        success: false,
        reason: 'invalid_course_equipment',
        error: String(err.message || err),
      },
    };
  }
  const lines = equipmentQuote.lines.map((line) => ({
    offering_key: line.offering_key,
    label: line.label,
    quantity: line.quantity,
    unit_amount_cents: line.unit_amount_cents,
    base_unit_cents: line.base_unit_cents,
    all_day_surcharge_unit_cents: line.all_day_surcharge_unit_cents,
    total_cents: line.total_cents,
    currency: 'EUR',
    price_source: 'course_owned_equipment',
    billing_unit: 'person_per_course',
    course_equipment: true,
    course_equipment_mode: line.course_equipment_mode,
    metadata: {
      ...line.metadata,
      location_id: locationId,
      price_source: 'course_owned_equipment',
    },
  }));
  return {
    ok: true,
    lines,
    total_cents: equipmentQuote.total_cents,
    course_equipment: equipmentQuote.course_equipment,
  };
}

function mapQuoteFailure(reason, extra = {}) {
  const faced = staffFacingSunsetPriceError(reason);
  return {
    ok: false,
    status: extra.status || 422,
    body: {
      success: false,
      reason: reason || faced.reason_code,
      reason_code: extra.reason_code || faced.reason_code || reason,
      error: extra.error || faced.error,
      ...extra,
    },
  };
}

function normalizeQuoteLineItemsForFingerprint(lineItems) {
  const rows = (Array.isArray(lineItems) ? lineItems : []).map((line) => {
    const priceIdentity = line && line.price_identity && typeof line.price_identity === 'object'
      ? line.price_identity
      : null;
    return {
      component: line && line.component != null ? String(line.component) : null,
      offering_id: line && line.offering_id != null ? String(line.offering_id) : null,
      offering_key: line && line.offering_key != null ? String(line.offering_key) : null,
      offering_item_code: line && (line.offering_item_code || line.item_code) != null
        ? String(line.offering_item_code || line.item_code)
        : null,
      duration_key: line && line.duration_key != null
        ? String(line.duration_key)
        : (line && line.tier_key != null ? String(line.tier_key) : null),
      quantity: line && line.quantity != null ? Number(line.quantity) : null,
      unit_amount_cents: line && line.unit_amount_cents != null ? Number(line.unit_amount_cents) : null,
      total_cents: line && line.total_cents != null ? Number(line.total_cents) : null,
      course_equipment: line && line.course_equipment === true,
      course_equipment_mode: line && line.course_equipment_mode != null
        ? String(line.course_equipment_mode) : null,
      // Staff custom lines: identity + label must fingerprint so edits invalidate stale quotes.
      client_line_id: line && line.client_line_id != null ? String(line.client_line_id) : null,
      label: line && line.label != null ? String(line.label) : null,
      price_id: line && line.price_id != null
        ? String(line.price_id)
        : (priceIdentity && priceIdentity.price_id != null ? String(priceIdentity.price_id) : null),
    };
  });
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return rows;
}

/**
 * Append staff custom commercial adjustments to Admin quote lines.
 * Revalidates amount_cents server-side; fails closed if aggregate total < 0.
 * Staff channel only — Luna cannot inject custom_line_items.
 */
function appendCustomLineItemsToQuote(command, lines, totalCents, currency) {
  const body = command && command.transportBody;
  const raw = body && body.custom_line_items;
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) {
    return { ok: true, lines, totalCents, currency };
  }
  if (command.channel !== QUOTE_CHANNELS.MANUAL_STAFF) {
    return {
      ok: false,
      status: 403,
      body: {
        success: false,
        reason: 'custom_line_items_staff_only',
        reason_code: 'custom_line_items_staff_only',
        error: 'Custom lines are staff-only commercial adjustments.',
      },
    };
  }
  const norm = normalizeCustomLineItems(raw);
  if (!norm.ok) {
    return {
      ok: false,
      status: 400,
      body: { success: false, reason: norm.error, reason_code: 'custom_line_items_invalid', error: norm.error },
    };
  }
  const customLines = buildCustomLineQuoteLines(norm.value, currency || 'EUR');
  let nextTotal = totalCents;
  for (const cl of customLines) {
    nextTotal += cl.total_cents;
    lines.push(cl);
  }
  if (!Number.isFinite(nextTotal) || !Number.isInteger(nextTotal)) {
    return {
      ok: false,
      status: 422,
      body: {
        success: false,
        reason: 'custom_line_total_invalid',
        reason_code: 'custom_line_total_invalid',
        error: 'Custom line total is invalid.',
      },
    };
  }
  if (nextTotal < 0) {
    return {
      ok: false,
      status: 422,
      body: {
        success: false,
        reason: 'booking_total_negative',
        reason_code: 'booking_total_negative',
        error: 'Booking total cannot be negative after custom lines.',
      },
    };
  }
  return { ok: true, lines, totalCents: nextTotal, currency: currency || 'EUR' };
}

function buildQuoteProvenance(quoteBody) {
  const fp = computeQuoteFingerprint(quoteBody);
  return {
    quote_version: QUOTE_PROVENANCE_VERSION,
    quote_fingerprint: fp,
    quoted_at: quoteBody.quoted_at,
    offering_id: quoteBody.offering_id,
    offering_item_code: quoteBody.offering_item_code,
    course_id: quoteBody.course_id,
    tier_key: quoteBody.tier_key,
    service_dates: quoteBody.service_dates,
    quantity: quoteBody.quantity,
    unit_amount_cents: quoteBody.unit_amount_cents,
    total_cents: quoteBody.total_cents,
    currency: quoteBody.currency,
    price_source: quoteBody.price_source,
    capacity_by_date: quoteBody.capacity_by_date || null,
    course_equipment: quoteBody.course_equipment || null,
    line_items: normalizeQuoteLineItemsForFingerprint(quoteBody.line_items),
  };
}

function computeQuoteFingerprint(quoteBody) {
  const payload = {
    v: QUOTE_PROVENANCE_VERSION,
    client_slug: SUNSET_CLIENT_SLUG,
    location_id: quoteBody.location_id,
    offering_id: quoteBody.offering_id,
    offering_item_code: quoteBody.offering_item_code,
    course_id: quoteBody.course_id,
    tier_key: quoteBody.tier_key,
    service_dates: [...(quoteBody.service_dates || [])].sort(),
    quantity: quoteBody.quantity,
    unit_amount_cents: quoteBody.unit_amount_cents,
    total_cents: quoteBody.total_cents,
    currency: quoteBody.currency,
    price_source: quoteBody.price_source,
    billing_unit: quoteBody.billing_unit,
    capacity_by_date: quoteBody.capacity_by_date || null,
    course_equipment: quoteBody.course_equipment || null,
    line_items: normalizeQuoteLineItemsForFingerprint(quoteBody.line_items),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function loadQuoteOfferings(pg, command, adminCfg, requireDb) {
  const catalogCmd = catalogCommandFromQuoteCommand(command);
  catalogCmd.requireDb = requireDb;
  const result = pg
    ? await executeSunsetCatalog(pg, catalogCmd, { adminCfg })
    : executeSunsetCatalogSync(catalogCmd, { adminCfg });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.body.reason || result.body.reason_code,
      offerings: [],
      location_id: command.locationId,
    };
  }
  return {
    ok: true,
    source: result.body.source,
    offerings: result.body.offerings || [],
    location_id: result.body.location_id,
  };
}

function filterQuoteCatalogOfferings(catalog) {
  if (!catalog || !catalog.ok) return catalog;
  return {
    ...catalog,
    offerings: catalog.offerings || [],
  };
}

function extractServiceDates(transportBody) {
  const b = transportBody || {};
  if (Array.isArray(b.service_dates) && b.service_dates.length) {
    return [...new Set(b.service_dates.map((d) => String(d).slice(0, 10)).filter(Boolean))];
  }
  if (b.date_from || b.date_to) {
    const from = String(b.date_from || b.date_to).slice(0, 10);
    const to = String(b.date_to || b.date_from).slice(0, 10);
    if (from && to && from <= to) {
      const out = [];
      let cur = from;
      while (cur <= to && out.length < 31) {
        out.push(cur);
        const d = new Date(`${cur}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        cur = d.toISOString().slice(0, 10);
      }
      return out;
    }
  }
  if (b.date) return [String(b.date).slice(0, 10)];
  return [];
}

/**
 * Group course unit cents from Admin only:
 *   days 1–7  → exact Admin duration row for that day count
 *   days 8–14 → round(Admin 7_days × days / 7); no 8–14 Admin rows
 *   days >14  → fail closed
 * No client arithmetic / no fallback tiers.
 */
async function resolveGroupCourseUnitAmountCents(pg, command, offering, serviceDates, quantity, requireDb) {
  const days = Array.isArray(serviceDates) ? serviceDates.length : 0;
  if (days < 1) {
    return mapQuoteFailure('invalid_service_dates');
  }
  if (days > MAX_GROUP_COURSE_INCLUSIVE_DAYS) {
    return mapQuoteFailure('course_duration_exceeds_max', {
      status: 422,
      detail: { requested_days: days, max_days: MAX_GROUP_COURSE_INCLUSIVE_DAYS },
    });
  }
  const adminTierKey = groupCourseAdminTierKeyForInclusiveDays(days);
  if (!adminTierKey) {
    return mapQuoteFailure('course_duration_exceeds_max', {
      status: 422,
      detail: { requested_days: days },
    });
  }
  const courseId = offering.course_id;
  const offeringId = packPriceItemCode(courseId, adminTierKey);

  if (pg && requireDb) {
    const resolved = await resolveActiveSunsetAdminPrice(pg, {
      clientSlug: SUNSET_CLIENT_SLUG,
      locationId: command.locationId,
      quantity,
      metadata: {
        component: 'course',
        staff_ui_service_type: 'course',
        course_id: courseId,
        tier_key: adminTierKey,
        offering_id: offeringId,
        location_id: command.locationId,
      },
      pgClient: pg,
    });
    if (!resolved || !resolved.ok) {
      return mapQuoteFailure((resolved && resolved.reason) || 'price_not_configured');
    }
    let unitAmount = resolved.unit_amount_cents;
    if (days >= 8) {
      const prorated = groupCourseUnitCentsFromSevenDayAdmin(unitAmount, days);
      if (!prorated.ok) {
        return mapQuoteFailure(prorated.reason || 'price_not_configured');
      }
      unitAmount = prorated.unit_amount_cents;
    }
    return {
      ok: true,
      unit_amount_cents: unitAmount,
      price_source: resolved.price_source || 'admin_db',
      price_id: resolved.price_id || offering.price_id,
      admin_tier_key: adminTierKey,
      requested_days: days,
    };
  }

  // Catalog / offline: require the offering itself to be the Admin owner tier
  // (exact 1–7, or 7_days for 8–14 proration). Never invent amounts.
  const catalogTier = String(offering.tier_key || '').trim();
  // Legacy Admin catalogs may expose the historical 1_week identity while a
  // one-date quote resolves through the canonical 1_day owner. Preserve that
  // real catalog row; do not rewrite its identity or fabricate an amount.
  const legacyOneWeekOneDay = catalogTier === '1_week' && adminTierKey === '1_day';
  if (catalogTier !== adminTierKey && !legacyOneWeekOneDay) {
    return mapQuoteFailure('price_not_configured', {
      detail: { expected_tier: adminTierKey, offering_tier: catalogTier },
    });
  }
  let unitAmount = offering.unit_amount_cents != null
    ? offering.unit_amount_cents
    : (offering.price && offering.price.amount_cents);
  unitAmount = Math.round(Number(unitAmount));
  if (!Number.isFinite(unitAmount) || unitAmount <= 0) {
    return mapQuoteFailure('price_missing');
  }
  if (days >= 8) {
    const prorated = groupCourseUnitCentsFromSevenDayAdmin(unitAmount, days);
    if (!prorated.ok) {
      return mapQuoteFailure(prorated.reason || 'price_not_configured');
    }
    unitAmount = prorated.unit_amount_cents;
  }
  return {
    ok: true,
    unit_amount_cents: unitAmount,
    price_source: requireDb ? 'admin_db' : (offering.price_source || 'admin_db'),
    price_id: offering.price_id || (offering.price && offering.price.price_id),
    admin_tier_key: adminTierKey,
    requested_days: days,
  };
}

async function quoteOfferingLine(pg, command, offering, serviceDates, quantity, requireDb) {
  if (offering.offering_type === 'course' && serviceDates.length) {
    const scheduleCheck = evaluateSunsetOfferingDates(offering, serviceDates);
    if (!scheduleCheck.ok) {
      return mapQuoteFailure(scheduleCheck.reason, {
        status: 422,
        error: (scheduleCheck.staff_error && scheduleCheck.staff_error.error) || undefined,
        schedule_summary: scheduleCheck.schedule_summary,
        detail: scheduleCheck.detail || null,
      });
    }
    if (pg) {
      const cap = await assertCourseAssignable(pg, {
        clientSlug: SUNSET_CLIENT_SLUG,
        locationId: command.locationId,
        courseId: offering.course_id,
        serviceDates,
        quantity,
      });
      if (!cap.ok) {
        return {
          ok: false,
          status: cap.status || 409,
          body: {
            success: false,
            reason: cap.body && cap.body.error,
            reason_code: cap.body && (cap.body.reason_code || cap.body.error),
            error: cap.body && cap.body.error,
            course_id: offering.course_id,
            capacity_by_date: cap.body && cap.body.capacity_by_date,
          },
        };
      }
      offering._capacity_by_date = cap.capacity_by_date;
    }
  }

  // Group courses: date-count owns the Admin tier (1–7 exact / 8–14 from 7_days).
  if (offering.offering_type === 'course') {
    const coursePrice = await resolveGroupCourseUnitAmountCents(
      pg, command, offering, serviceDates, quantity, requireDb,
    );
    if (!coursePrice.ok) return coursePrice;
    return finalizeQuoteLine(
      offering,
      serviceDates,
      quantity,
      coursePrice.unit_amount_cents,
      coursePrice.price_source,
      coursePrice.price_id,
    );
  }

  let unitAmount = offering.unit_amount_cents;
  let priceSource = offering.price_source || 'admin_db';
  let priceId = offering.price_id;

  if (pg && requireDb && offering.price_identity) {
    // Propagate exact rental duration + compound item_code into async Admin
    // re-resolve. Generic offering_type "rental" alone used to lose 6_days and
    // silently price board_and_suit_rental__1_day (2000) while keeping the
    // 6_days catalog label — payment-link reprice then fail-closed correctly.
    const rentalDuration = offering.duration_key || offering.tier_key || null;
    const itemCode = offering.item_code
      || offering.offering_item_code
      || offering.offering_id
      || null;
    const resolved = await resolveActiveSunsetAdminPrice(pg, {
      clientSlug: SUNSET_CLIENT_SLUG,
      locationId: command.locationId,
      quantity,
      metadata: {
        component: offering.offering_type,
        staff_ui_service_type: offering.offering_type,
        course_id: offering.course_id,
        tier_key: offering.tier_key || rentalDuration,
        duration_key: rentalDuration,
        offering_id: offering.offering_id || itemCode,
        offering_item_code: offering.offering_item_code || itemCode,
        item_code: itemCode,
        location_id: command.locationId,
      },
      pgClient: pg,
    });
    if (!resolved || !resolved.ok) {
      return mapQuoteFailure((resolved && resolved.reason) || 'price_not_configured');
    }
    unitAmount = resolved.unit_amount_cents;
    priceSource = resolved.price_source || 'admin_db';
    priceId = resolved.price_id || priceId;
  }

  return finalizeQuoteLine(offering, serviceDates, quantity, unitAmount, priceSource, priceId);
}

function quoteOfferingLineSync(command, offering, serviceDates, quantity, requireDb) {
  if (offering.offering_type === 'course' && serviceDates.length) {
    const scheduleCheck = evaluateSunsetOfferingDates(offering, serviceDates);
    if (!scheduleCheck.ok) {
      return mapQuoteFailure(scheduleCheck.reason, {
        status: 422,
        error: (scheduleCheck.staff_error && scheduleCheck.staff_error.error) || undefined,
        schedule_summary: scheduleCheck.schedule_summary,
        detail: scheduleCheck.detail || null,
      });
    }
  }
  if (offering.offering_type === 'course') {
    // Sync path cannot await; use the pure Admin-tier proration owner.
    const days = Array.isArray(serviceDates) ? serviceDates.length : 0;
    if (days < 1) return mapQuoteFailure('invalid_service_dates');
    if (days > MAX_GROUP_COURSE_INCLUSIVE_DAYS) {
      return mapQuoteFailure('course_duration_exceeds_max', {
        status: 422,
        detail: { requested_days: days, max_days: MAX_GROUP_COURSE_INCLUSIVE_DAYS },
      });
    }
    const adminTierKey = groupCourseAdminTierKeyForInclusiveDays(days);
    const catalogTier = String(offering.tier_key || '').trim();
    const legacyOneWeekOneDay = catalogTier === '1_week' && adminTierKey === '1_day';
    if (!adminTierKey || (catalogTier !== adminTierKey && !legacyOneWeekOneDay)) {
      return mapQuoteFailure('price_not_configured', {
        detail: { expected_tier: adminTierKey, offering_tier: catalogTier },
      });
    }
    let unitAmount = offering.unit_amount_cents != null
      ? offering.unit_amount_cents
      : (offering.price && offering.price.amount_cents);
    unitAmount = Math.round(Number(unitAmount));
    if (!Number.isFinite(unitAmount) || unitAmount <= 0) {
      return mapQuoteFailure('price_missing');
    }
    if (days >= 8) {
      const prorated = groupCourseUnitCentsFromSevenDayAdmin(unitAmount, days);
      if (!prorated.ok) return mapQuoteFailure(prorated.reason || 'price_not_configured');
      unitAmount = prorated.unit_amount_cents;
    }
    const priceSource = requireDb ? 'admin_db' : (offering.price_source || 'admin_db');
    const priceId = offering.price_id || (offering.price && offering.price.price_id);
    return finalizeQuoteLine(offering, serviceDates, quantity, unitAmount, priceSource, priceId);
  }
  const unitAmount = offering.unit_amount_cents != null
    ? offering.unit_amount_cents
    : (offering.price && offering.price.amount_cents);
  const priceSource = requireDb ? 'admin_db' : (offering.price_source || 'admin_db');
  const priceId = offering.price_id || (offering.price && offering.price.price_id);
  return finalizeQuoteLine(offering, serviceDates, quantity, unitAmount, priceSource, priceId);
}

function finalizeQuoteLine(offering, serviceDates, quantity, unitAmount, priceSource, priceId) {
  if (unitAmount == null || unitAmount < 0) {
    return mapQuoteFailure('price_missing');
  }
  const billableUnits = computeBillableUnits(offering, serviceDates, quantity);
  if (billableUnits == null) {
    return { ok: false, status: 422, body: { success: false, reason: 'incompatible_unit' } };
  }
  const total = unitAmount * billableUnits;
  return {
    ok: true,
    line: {
      component: offering.offering_type,
      offering_id: offering.offering_id,
      offering_item_code: offering.offering_item_code || offering.item_code,
      course_id: offering.course_id,
      tier_key: offering.tier_key,
      label: offering.label,
      quantity,
      service_dates: serviceDates,
      unit_amount_cents: unitAmount,
      billable_units: billableUnits,
      total_cents: total,
      currency: offering.currency || 'EUR',
      billing_unit: offering.billing_unit,
      billing_mode: offering.billing_mode,
      price_id: priceId,
      price_source: priceSource,
      capacity_by_date: offering._capacity_by_date || null,
    },
  };
}

function buildOfferingQuoteResult(command, catalog, offering, lineOut) {
  if (!lineOut.ok) return lineOut;
  const line = lineOut.line;
  const quotedAt = command.now.toISOString();
  const quoteBody = {
    success: true,
    client_slug: SUNSET_CLIENT_SLUG,
    location_id: command.locationId,
    channel: command.channel,
    offering_id: line.offering_id,
    offering_type: offering.offering_type,
    course_id: line.course_id,
    tier_key: line.tier_key,
    label: line.label,
    quantity: line.quantity,
    service_dates: line.service_dates,
    date_count: line.service_dates.length,
    unit_amount_cents: line.unit_amount_cents,
    billable_units: line.billable_units,
    total_cents: line.total_cents,
    line_total_cents: line.total_cents,
    currency: line.currency,
    price_unit: line.billing_unit,
    billing_unit: line.billing_unit,
    billing_mode: line.billing_mode,
    price_id: line.price_id,
    price_source: line.price_source,
    source: catalog.source,
    offering_item_code: line.offering_item_code,
    price_identity: offering.price_identity,
    schedule_summary: offering.schedule_summary,
    capacity_by_date: line.capacity_by_date,
    quoted_at: quotedAt,
    line_items: [{
      ...line,
      component: offering.offering_type === 'course'
        ? 'course'
        : (offering.offering_type === 'private_lesson' ? 'private_lesson' : line.component),
      duration_key: offering.offering_type === 'rental'
        ? (line.tier_key || offering.tier_key || null)
        : (line.tier_key || offering.tier_key || null),
      price_identity: offering.price_identity || null,
    }],
  };
  quoteBody.quote_provenance = buildQuoteProvenance(quoteBody);
  return { ok: true, status: 200, body: quoteBody };
}

function appendOfferingCourseEquipment(command, offering, result, catalog) {
  const selection = command.transportBody.course_equipment;
  if (selection == null || !result.ok) return result;
  if (offering.offering_type !== 'course' && offering.offering_type !== 'private_lesson') {
    return { ok: false, status: 422, body: { success: false, reason: 'invalid_course_equipment' } };
  }
  const equipmentOut = buildCourseEquipmentQuoteLines({
    selection,
    course: offering,
    surfers: result.body.quantity,
    locationId: command.locationId,
    catalog,
  });
  if (!equipmentOut.ok) return equipmentOut;
  try {
    result.body.total_cents = checkedCourseEquipmentAdd(
      result.body.total_cents,
      equipmentOut.total_cents,
      'quote total',
    );
  } catch (err) {
    return {
      ok: false,
      status: 422,
      body: {
        success: false,
        reason: 'invalid_course_equipment',
        error: String(err.message || err),
      },
    };
  }
  result.body.line_total_cents = result.body.total_cents;
  result.body.course_equipment = equipmentOut.course_equipment;
  result.body.line_items.push(...equipmentOut.lines);
  result.body.quote_provenance = buildQuoteProvenance(result.body);
  return result;
}

function resolveOfferingQuoteInputs(command, catalog) {
  const body = command.transportBody;
  const offeringId = String(body.offering_id || '').trim();
  if (!offeringId) {
    return { ok: false, result: { ok: false, status: 400, body: { success: false, reason: 'unknown_offering' } } };
  }
  const matches = findCatalogOffering({ offerings: catalog.offerings }, offeringId);
  if (!matches.length) {
    return { ok: false, result: quoteUnknownOfferingFallback(catalog, body, offeringId) };
  }
  if (matches.length > 1) {
    return { ok: false, result: { ok: false, status: 422, body: { success: false, reason: 'ambiguous_price' } } };
  }
  const offering = nestOfferingForQuote(matches[0]);
  if (offering.offering_type === 'course' && body.course_id == null) {
    return { ok: false, result: { ok: false, status: 422, body: { success: false, reason: 'course_identity_missing' } } };
  }
  if (body.course_id != null && String(offering.course_id || '') !== String(body.course_id)) {
    return { ok: false, result: { ok: false, status: 422, body: { success: false, reason: 'mismatched_course_offering' } } };
  }
  const quantity = parseQuoteQuantity(body.quantity);
  if (quantity == null) {
    return { ok: false, result: { ok: false, status: 422, body: { success: false, reason: 'incompatible_unit' } } };
  }
  return {
    ok: true,
    offering,
    serviceDates: extractServiceDates(body),
    quantity,
  };
}

async function quoteByOfferingId(pg, command, catalog, requireDb) {
  const resolved = resolveOfferingQuoteInputs(command, catalog);
  if (!resolved.ok) return resolved.result;
  const lineOut = await quoteOfferingLine(
    pg,
    command,
    resolved.offering,
    resolved.serviceDates,
    resolved.quantity,
    requireDb,
  );
  return appendOfferingCourseEquipment(
    command,
    resolved.offering,
    buildOfferingQuoteResult(command, catalog, resolved.offering, lineOut),
    catalog,
  );
}

function quoteByOfferingIdSync(command, catalog, requireDb) {
  const resolved = resolveOfferingQuoteInputs(command, catalog);
  if (!resolved.ok) return resolved.result;
  const lineOut = quoteOfferingLineSync(
    command,
    resolved.offering,
    resolved.serviceDates,
    resolved.quantity,
    requireDb,
  );
  return appendOfferingCourseEquipment(
    command,
    resolved.offering,
    buildOfferingQuoteResult(command, catalog, resolved.offering, lineOut),
    catalog,
  );
}

function quoteUnknownOfferingFallback(catalog, body, offeringId) {
  const adminCfg = catalog._adminCfg;
  if (adminCfg) {
    const rawPrices = (adminCfg.prices || []).filter(
      (p) => p.id === offeringId || p.offering_key === offeringId || p.item_code === offeringId,
    );
    if (rawPrices.length > 1) return { ok: false, status: 422, body: { success: false, reason: 'ambiguous_price' } };
    if (rawPrices.length === 1) {
      const asOf = body.as_of_date || body.date;
      if (rawPrices[0].active === false) {
        return { ok: false, status: 422, body: { success: false, reason: 'inactive_offering' } };
      }
      if (rawPrices[0].effective_from && String(rawPrices[0].effective_from).slice(0, 10) > String(asOf || '').slice(0, 10)) {
        return { ok: false, status: 422, body: { success: false, reason: 'future_price' } };
      }
      if (rawPrices[0].effective_to && String(rawPrices[0].effective_to).slice(0, 10) < String(asOf || '').slice(0, 10)) {
        return { ok: false, status: 422, body: { success: false, reason: 'expired_price' } };
      }
    }
    const knownUnpriced = (adminCfg.lesson_times || []).some((s) => `lesson_slot_${s.slot_id}__session` === offeringId)
      || (adminCfg.surf_packs || []).some((p) => (p.price_tiers || []).some((t) => `surf_pack_${p.pack_id}__${t.key}` === offeringId));
    if (knownUnpriced) {
      return { ok: false, status: 422, body: { success: false, reason: 'price_missing' } };
    }
  }
  if (catalog.source !== 'db' && isSunsetAdminDbReadEnabled()) {
    return { ok: false, status: 422, body: { success: false, reason: 'admin_db_expected_unavailable' } };
  }
  return { ok: false, status: 422, body: { success: false, reason: 'unknown_offering' } };
}

const CANONICAL_RENTAL_OFFERING_KEYS = Object.freeze([
  'board_rental',
  'wetsuit_rental',
  'board_and_suit_rental',
]);

/** No-lesson short rental windows — independent of inclusive date-span duration. */
const SHORT_RENTAL_DURATION_KEYS = Object.freeze(['1_hour', '2_hours', 'half_day', 'full_day']);
const SHORT_RENTAL_DURATION_SET = new Set(SHORT_RENTAL_DURATION_KEYS);

function isShortRentalDurationKey(key) {
  return SHORT_RENTAL_DURATION_SET.has(String(key || '').trim());
}

function quoteHasNonEmptyComponents(body) {
  return !!(body && body.components && typeof body.components === 'object'
    && Object.keys(body.components).length > 0);
}

function quoteHasRentalsArray(body) {
  return !!(body && Array.isArray(body.rentals));
}

function quoteShouldUseComponentsPath(body) {
  return quoteHasNonEmptyComponents(body) || quoteHasRentalsArray(body);
}

function inclusiveIsoDatesFromRange(dateFrom, dateTo) {
  const from = String(dateFrom || '').slice(0, 10);
  const to = String(dateTo || dateFrom || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
    return [];
  }
  const out = [];
  let cur = from;
  while (cur <= to && out.length < 31) {
    out.push(cur);
    const d = new Date(`${cur}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    cur = d.toISOString().slice(0, 10);
  }
  return out;
}

function quoteRentalDurationKeyFromDateRange(dateFrom, dateTo) {
  const dates = inclusiveIsoDatesFromRange(dateFrom, dateTo);
  if (dates.length < 1) return null;
  if (dates.length === 1) return '1_day';
  return `${dates.length}_days`;
}

function assertCanonicalRentalServiceDatesMatchRange(transportBody, expectedDates) {
  const body = transportBody && typeof transportBody === 'object' ? transportBody : {};
  if (!Object.prototype.hasOwnProperty.call(body, 'service_dates')) {
    return { ok: true };
  }
  if (!Array.isArray(body.service_dates)) {
    return { ok: false, reason: 'invalid_service_dates', error: 'service_dates must be an array' };
  }
  const got = body.service_dates.map((d) => String(d || '').slice(0, 10)).filter(Boolean);
  if (got.length !== body.service_dates.length) {
    return { ok: false, reason: 'invalid_service_dates', error: 'service_dates must be YYYY-MM-DD' };
  }
  if (new Set(got).size !== got.length) {
    return { ok: false, reason: 'invalid_service_dates', error: 'service_dates must not contain duplicates' };
  }
  const expected = [...(expectedDates || [])].slice().sort();
  const sortedGot = got.slice().sort();
  if (expected.length !== sortedGot.length
    || expected.some((d, i) => d !== sortedGot[i])) {
    return {
      ok: false,
      reason: 'service_dates_mismatch',
      error: 'service_dates must match the inclusive date_from/date_to range exactly',
    };
  }
  return { ok: true };
}

/**
 * Validate canonical rentals[] for quote. Returns null value when field absent
 * (legacy component pricing). Empty array is "present" and owns rental pricing.
 */
function normalizeCanonicalRentalsForQuote(transportBody, expectedDurationKey) {
  const body = transportBody && typeof transportBody === 'object' ? transportBody : {};
  if (!Object.prototype.hasOwnProperty.call(body, 'rentals')) {
    return { ok: true, present: false, value: null };
  }
  if (!Array.isArray(body.rentals)) {
    return { ok: false, reason: 'invalid_rentals', error: 'rentals must be an array' };
  }
  const seen = new Set();
  const out = [];
  for (let i = 0; i < body.rentals.length; i += 1) {
    const row = body.rentals[i];
    if (!row || typeof row !== 'object') {
      return { ok: false, reason: 'invalid_rentals', error: `rentals[${i}] must be an object` };
    }
    const offeringKey = String(row.offering_key || '').trim();
    if (!CANONICAL_RENTAL_OFFERING_KEYS.includes(offeringKey)) {
      return { ok: false, reason: 'invalid_rental_offering', error: `rentals[${i}].offering_key is not allowed` };
    }
    if (seen.has(offeringKey)) {
      return { ok: false, reason: 'duplicate_rental_offering', error: `duplicate rentals offering_key ${offeringKey}` };
    }
    seen.add(offeringKey);
    const durationKey = String(row.duration_key || '').trim();
    if (!durationKey) {
      return { ok: false, reason: 'invalid_rental_duration', error: `rentals[${i}].duration_key is required` };
    }
    // Short No-lesson windows (1_hour / half_day / 1_day) are pebble-selected only
    // on a single-day span (expectedDurationKey === '1_day'). Multi-day spans require
    // exact inclusive date-span identity — never silently accept 1_day for 4 days.
    if (expectedDurationKey && durationKey !== expectedDurationKey) {
      const shortOkOnSingleDay = expectedDurationKey === '1_day'
        && isShortRentalDurationKey(durationKey);
      if (!shortOkOnSingleDay) {
        return {
          ok: false,
          reason: 'rental_duration_mismatch',
          error: `rentals[${i}].duration_key must be ${expectedDurationKey} for the selected dates`,
        };
      }
    }
    const qty = Number(row.quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      return { ok: false, reason: 'invalid_rental_quantity', error: `rentals[${i}].quantity must be a positive integer` };
    }
    out.push({
      offering_key: offeringKey,
      duration_key: durationKey,
      quantity: qty,
    });
  }
  if (seen.has('board_and_suit_rental') && (seen.has('board_rental') || seen.has('wetsuit_rental'))) {
    return {
      ok: false,
      reason: 'rental_bundle_conflict',
      error: 'board_and_suit_rental cannot be combined with board_rental or wetsuit_rental',
    };
  }
  return { ok: true, present: true, value: out };
}

/**
 * Resolve quote input for component and/or canonical rental requests.
 * Rentals-only (components: {}) is allowed; duration always from date_from/date_to.
 */
function resolveQuoteComponentsAndRentalsInput(command) {
  const dateNorm = normalizeSunsetBookingDatesInBody(command.transportBody, command.now);
  if (!dateNorm.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        reason: dateNorm.reason || 'invalid_date',
        reason_code: dateNorm.reason || 'invalid_date',
        needs_clarification: dateNorm.needs_clarification === true,
      },
    };
  }
  const body = dateNorm.body;
  const hasComponents = quoteHasNonEmptyComponents(body);
  const hasRentals = quoteHasRentalsArray(body);
  // Channel is server-owned — Luna bot quote may derive surfer_count from consistent
  // equipment qty (Hermes plugin sends components only). Staff/manual never derives.
  const lunaTrusted = command.channel === QUOTE_CHANNELS.LUNA_WHATSAPP;
  const forceOpts = lunaTrusted
    ? { lunaTrusted: true, actor: { source: 'agent_luna_whatsapp_bot' } }
    : { lunaTrusted: false };

  let input;
  if (hasComponents) {
    // Quote is not gated on guest name/phone — Create remains fail-closed.
    // Use command.now as date ref (same as outer dateNorm) — never wall-clock drift.
    const validated = validateScheduleBookingBody(body, {
      allowBlankGuest: true,
      refDate: command.now,
      ...forceOpts,
    });
    if (!validated.ok) {
      return { ok: false, status: 400, body: { success: false, error: validated.error, reason: validated.error } };
    }
    input = validated.value;
  } else if (hasRentals) {
    // Blank guest name/phone allowed for authoritative rental quote (no placeholders).
    const guestName = String(body.guest_name || '').trim();
    if (guestName.length > 200) {
      return { ok: false, status: 400, body: { success: false, reason: 'guest_name is required (max 200 chars)', error: 'guest_name is required (max 200 chars)' } };
    }
    const dateFrom = String(body.date_from || '').slice(0, 10);
    const dateTo = String(body.date_to || body.date_from || '').slice(0, 10);
    if (!dateFrom || !dateTo) {
      return {
        ok: false,
        status: 400,
        body: { success: false, reason: 'invalid_date', reason_code: 'invalid_date', error: 'date_from and date_to are required for rental quotes' },
      };
    }
    const rangeDates = inclusiveIsoDatesFromRange(dateFrom, dateTo);
    if (!rangeDates.length) {
      return {
        ok: false,
        status: 400,
        body: { success: false, reason: 'invalid_date', reason_code: 'invalid_date', error: 'invalid date_from/date_to range' },
      };
    }
    input = {
      guest_name: guestName,
      guest_phone: body.guest_phone != null ? String(body.guest_phone).trim().slice(0, 40) || null : null,
      components: {},
      service_dates: rangeDates,
      payment_status: String(body.payment_status || 'unpaid').trim().toLowerCase() || 'unpaid',
      notes: body.notes != null ? String(body.notes).trim().slice(0, 2000) : '',
      needs_reply: false,
      idempotency_key: null,
      rental_pricing: null,
      date_from: dateFrom,
      date_to: dateTo,
      surfer_count: body.surfer_count != null ? body.surfer_count : null,
    };
  } else {
    return { ok: false, status: 400, body: { success: false, reason: 'quote_input_required' } };
  }

  let rentalsNorm = { ok: true, present: false, value: null };
  if (hasRentals) {
    const dateFrom = String((input.date_from != null ? input.date_from : body.date_from) || '').slice(0, 10);
    const dateTo = String((input.date_to != null ? input.date_to : body.date_to) || '').slice(0, 10);
    if (!dateFrom || !dateTo) {
      return {
        ok: false,
        status: 400,
        body: {
          success: false,
          reason: 'invalid_date',
          reason_code: 'invalid_date',
          error: 'date_from and date_to are required for canonical rental quotes',
        },
      };
    }
    const rangeDates = inclusiveIsoDatesFromRange(dateFrom, dateTo);
    if (!rangeDates.length) {
      return {
        ok: false,
        status: 400,
        body: { success: false, reason: 'invalid_date', reason_code: 'invalid_date', error: 'invalid date_from/date_to range' },
      };
    }
    const datesMatch = assertCanonicalRentalServiceDatesMatchRange(body, rangeDates);
    if (!datesMatch.ok) {
      return {
        ok: false,
        status: 400,
        body: {
          success: false,
          reason: datesMatch.reason,
          reason_code: datesMatch.reason,
          error: datesMatch.error,
        },
      };
    }
    // Canonical rentals always bill against the authoritative inclusive date range.
    input.service_dates = rangeDates;
    input.date_from = dateFrom;
    input.date_to = dateTo;
    const expectedDuration = quoteRentalDurationKeyFromDateRange(dateFrom, dateTo);
    // Carry surfer_count for no-lesson qty authority before normalizing rows.
    const transportForRentals = {
      ...command.transportBody,
      surfer_count: input.surfer_count != null
        ? input.surfer_count
        : (command.transportBody && command.transportBody.surfer_count),
      components: input.components,
    };
    rentalsNorm = normalizeCanonicalRentalsForQuote(transportForRentals, expectedDuration);
    if (!rentalsNorm.ok) {
      return {
        ok: false,
        status: 400,
        body: {
          success: false,
          reason: rentalsNorm.reason,
          reason_code: rentalsNorm.reason,
          error: rentalsNorm.error,
        },
      };
    }
    if (rentalsNorm.present) {
      // No-lesson: force equipment qty from surfer_count (ignore client override).
      // Staff fail-closed without surfer_count; trusted Luna may derive from consistent qty.
      const forced = applyNoLessonEquipmentQtyFromSurfers(
        {
          ...transportForRentals,
          components: input.components,
        },
        rentalsNorm.value,
        forceOpts,
      );
      if (!forced.ok) {
        return {
          ok: false,
          status: 400,
          body: {
            success: false,
            reason: forced.reason || forced.error,
            reason_code: forced.reason_code || forced.reason || forced.error,
            error: forced.error || forced.reason,
          },
        };
      }
      if (forced.forced) {
        rentalsNorm = { ok: true, present: true, value: forced.rentals };
        input.components = forced.body.components || input.components;
        input.surfer_count = forced.surfer_count;
      }
      const legacyMatch = assertLegacyRentalQuantitiesMatch(rentalsNorm.value, input.components);
      if (!legacyMatch.ok) {
        return {
          ok: false,
          status: 400,
          body: {
            success: false,
            reason: legacyMatch.reason,
            reason_code: legacyMatch.reason,
            error: legacyMatch.error,
          },
        };
      }
    }
  } else if (hasComponents) {
    // Components path already ran validateScheduleBookingBody (which forces no-lesson
    // qty). Re-apply when input.components carry equipment so qty authority is shared.
    const forced = applyNoLessonEquipmentQtyFromSurfers(
      { ...body, components: input.components, surfer_count: input.surfer_count },
      null,
      forceOpts,
    );
    if (!forced.ok) {
      return {
        ok: false,
        status: 400,
        body: {
          success: false,
          reason: forced.reason || forced.error,
          reason_code: forced.reason_code || forced.reason || forced.error,
          error: forced.error || forced.reason,
        },
      };
    }
    if (forced.forced) {
      input.components = forced.body.components || input.components;
      input.surfer_count = forced.surfer_count;
    }
  }

  return { ok: true, input, rentalsNorm };
}

function assertLegacyRentalQuantitiesMatch(rentals, components) {
  const comps = components && typeof components === 'object' ? components : {};
  const expected = { surfboard: null, wetsuit: null };
  for (const row of rentals || []) {
    if (row.offering_key === 'board_rental') expected.surfboard = row.quantity;
    else if (row.offering_key === 'wetsuit_rental') expected.wetsuit = row.quantity;
    else if (row.offering_key === 'board_and_suit_rental') {
      expected.surfboard = row.quantity;
      expected.wetsuit = row.quantity;
    }
  }
  for (const key of ['surfboard', 'wetsuit']) {
    const leg = comps[key];
    if (!leg) continue;
    const legQty = Number(leg.quantity);
    if (expected[key] == null || !Number.isInteger(legQty) || legQty !== expected[key]) {
      return {
        ok: false,
        reason: 'legacy_rental_mismatch',
        error: `components.${key}.quantity does not match canonical rentals`,
      };
    }
  }
  return { ok: true };
}

function findExactRentalCatalogOffering(catalog, offeringKey, durationKey, locationId) {
  const itemCode = `${offeringKey}__${durationKey}`;
  const matches = findCatalogOffering({ offerings: catalog.offerings }, itemCode)
    .filter((o) => o && o.offering_type === 'rental' && String(o.item_code || o.offering_id || '') === itemCode);
  if (!matches.length) return [];
  const adminCfg = catalog && catalog._adminCfg;
  if (adminCfg && Array.isArray(adminCfg.prices)) {
    const loc = String(locationId || '').trim();
    const pricedHere = adminCfg.prices.some((p) => {
      if (!p || p.active === false) return false;
      const key = String(p.offering_key || p.item_code || '').trim();
      // Accept combined item_code (board_and_suit_rental__4_days) or
      // offering_key + unit pair from Admin price rows.
      const unit = String(p.unit || '').trim();
      const matchesCode = key === itemCode
        || (key === offeringKey && unit === durationKey)
        || (key === offeringKey && !unit && String(p.item_code || '') === itemCode);
      if (!matchesCode) return false;
      if (p.location_id != null && String(p.location_id).trim()
        && loc && String(p.location_id).trim() !== loc) {
        return false;
      }
      const cents = p.amount_cents != null
        ? Number(p.amount_cents)
        : (p.amount != null ? Math.round(Number(p.amount) * 100) : null);
      return cents != null && cents > 0;
    });
    if (!pricedHere) return [];
  }
  return matches;
}

const FULL_DAY_EQUIPMENT_ADDON_KEY = 'full_day_equipment_extension';
const FULL_DAY_EQUIPMENT_ADDON_ITEM_CODE = 'full_day_equipment_extension__day';

/**
 * Resolve full-day unit cents from the quote catalog / injected Admin cfg first
 * (same Admin rows the projection already trusted). Fall back to school config
 * baseline only when catalog has no active row.
 */
function resolveFullDayAddonUnitFromCatalog(catalog) {
  const offerings = (catalog && catalog.offerings) || [];
  const hit = offerings.find((o) => {
    if (!o) return false;
    const code = String(o.item_code || o.offering_id || o.offering_item_code || '');
    return code === FULL_DAY_EQUIPMENT_ADDON_ITEM_CODE
      || code === FULL_DAY_EQUIPMENT_ADDON_KEY
      || (o.offering_type === 'addon' && /full_day_equipment/i.test(code));
  });
  if (hit) {
    const cents = Math.round(Number(hit.unit_amount_cents));
    if (Number.isFinite(cents) && cents > 0) {
      return {
        ok: true,
        amount_cents: cents,
        currency: hit.currency || 'EUR',
        price_id: (hit.price_identity && hit.price_identity.price_id) || null,
        source: hit.price_source || 'admin_config',
      };
    }
  }
  const adminCfg = catalog && catalog._adminCfg;
  if (adminCfg && Array.isArray(adminCfg.prices)) {
    const rule = adminCfg.prices.find((p) => {
      if (!p || p.active === false) return false;
      const k = String(p.offering_key || p.item_code || '');
      const unit = String(p.unit || '');
      return (k === FULL_DAY_EQUIPMENT_ADDON_KEY && (!unit || unit === 'day'))
        || k === FULL_DAY_EQUIPMENT_ADDON_ITEM_CODE;
    });
    if (rule) {
      const cents = rule.amount_cents != null
        ? Math.round(Number(rule.amount_cents))
        : (rule.amount != null ? Math.round(Number(rule.amount) * 100) : null);
      if (cents != null && Number.isFinite(cents) && cents > 0) {
        return {
          ok: true,
          amount_cents: cents,
          currency: rule.currency || 'EUR',
          price_id: rule.id || null,
          source: rule.source === 'db' ? 'db' : 'admin_config',
        };
      }
    }
  }
  return { ok: false };
}

function buildFullDayEquipmentAddonLine(addonPart, unitLookup) {
  if (!addonPart || !addonPart.dates || typeof addonPart.dates !== 'object') {
    return { ok: false, status: 400, body: { success: false, reason: 'invalid_full_day_addon' } };
  }
  const dateKeys = Object.keys(addonPart.dates).map((d) => String(d).slice(0, 10)).filter(Boolean).sort();
  if (!dateKeys.length) {
    return { ok: false, status: 400, body: { success: false, reason: 'invalid_full_day_addon' } };
  }
  if (!unitLookup || unitLookup.ok !== true) {
    return mapQuoteFailure((unitLookup && unitLookup.reason) || 'price_missing', {
      reason_code: (unitLookup && unitLookup.reason) || 'full_day_equipment_extension_price_unavailable',
    });
  }
  const unitCents = Math.round(Number(unitLookup.amount_cents));
  if (!Number.isFinite(unitCents) || unitCents <= 0) {
    return mapQuoteFailure('price_missing', {
      reason_code: 'full_day_equipment_extension_price_unavailable',
    });
  }
  let total = 0;
  let peopleSum = 0;
  for (const iso of dateKeys) {
    const qty = Math.max(0, Math.floor(Number(addonPart.dates[iso]) || 0));
    if (qty < 1) {
      return { ok: false, status: 400, body: { success: false, reason: 'invalid_full_day_addon_qty' } };
    }
    total += unitCents * qty;
    peopleSum += qty;
  }
  if (total <= 0) {
    return mapQuoteFailure('price_missing');
  }
  return {
    ok: true,
    line: {
      component: FULL_DAY_EQUIPMENT_ADDON_KEY,
      offering_id: FULL_DAY_EQUIPMENT_ADDON_ITEM_CODE,
      offering_item_code: FULL_DAY_EQUIPMENT_ADDON_ITEM_CODE,
      label: 'Full-day gear',
      quantity: peopleSum,
      service_dates: dateKeys,
      unit_amount_cents: unitCents,
      billable_units: peopleSum,
      total_cents: total,
      currency: unitLookup.currency || 'EUR',
      billing_unit: 'person_per_day',
      billing_mode: 'person_per_day',
      price_id: unitLookup.price_id || null,
      price_source: unitLookup.source || 'admin_config',
      capacity_by_date: null,
      addon_dates: { ...addonPart.dates },
    },
  };
}

/**
 * Sync full-day equipment line from catalog/Admin cfg (no await).
 * Canonical component: components.full_day_equipment_extension.
 * When quote carries an Admin cfg, a missing full-day row is fail-closed
 * (no silent baseline merge).
 */
function quoteFullDayEquipmentAddonLineSync(command, addonPart, catalog) {
  let lookup = resolveFullDayAddonUnitFromCatalog(catalog);
  if (!lookup.ok) {
    const hasAdminCfg = !!(catalog && catalog._adminCfg && Array.isArray(catalog._adminCfg.prices));
    if (hasAdminCfg) {
      return mapQuoteFailure('price_missing', {
        reason_code: 'full_day_equipment_extension_price_unavailable',
      });
    }
    // Offline path with no Admin cfg: school baseline only.
    const { lookupSunsetFullDayEquipmentAddon } = require('./sunset-rental-price-lookup');
    lookup = lookupSunsetFullDayEquipmentAddon({
      client_slug: SUNSET_CLIENT_SLUG,
      location_id: command.locationId,
    });
  }
  return buildFullDayEquipmentAddonLine(addonPart, lookup);
}

/**
 * Server-owned full-day equipment line: Admin unit cents × per-date people.
 * Fail-closed when Admin row missing. Never client arithmetic.
 *
 * Live path prefers DB async lookup; if that misses, the same-request Admin
 * catalog/cfg (already projected for this quote) remains commercial truth.
 * Does not silently merge school baseline when Admin cfg is present.
 */
async function quoteFullDayEquipmentAddonLine(pg, command, addonPart, requireDb, catalog) {
  if (pg && requireDb) {
    const { lookupSunsetFullDayEquipmentAddonAsync } = require('./sunset-rental-price-lookup');
    const lookup = await lookupSunsetFullDayEquipmentAddonAsync({
      client_slug: SUNSET_CLIENT_SLUG,
      location_id: command.locationId,
      pgClient: pg,
    });
    if (lookup && lookup.ok === true) {
      const out = buildFullDayEquipmentAddonLine(addonPart, lookup);
      if (out.ok && out.line) {
        out.line.price_source = lookup.source || 'admin_db';
      }
      return out;
    }
    const fromCatalog = resolveFullDayAddonUnitFromCatalog(catalog);
    if (fromCatalog.ok) {
      const out = buildFullDayEquipmentAddonLine(addonPart, fromCatalog);
      if (out.ok && out.line) {
        out.line.price_source = fromCatalog.source || 'admin_db';
      }
      return out;
    }
    return buildFullDayEquipmentAddonLine(
      addonPart,
      lookup || { ok: false, reason: 'price_not_configured' },
    );
  }
  return quoteFullDayEquipmentAddonLineSync(command, addonPart, catalog);
}

function resolveCourseOfferingIdentity(comp) {
  const courseId = String(comp && comp.course_id || '').trim();
  const tierKey = String(comp && comp.tier_key || '').trim();
  if (!courseId || !tierKey) {
    return {
      ok: false,
      status: 422,
      body: { success: false, reason: 'course_offering_identity_required' },
    };
  }
  const expectedOfferingId = packPriceItemCode(courseId, tierKey);
  const suppliedOfferingId = String(comp && comp.offering_id || '').trim();
  if (suppliedOfferingId && suppliedOfferingId !== expectedOfferingId) {
    return {
      ok: false,
      status: 422,
      body: { success: false, reason: 'course_offering_identity_mismatch' },
    };
  }
  return { ok: true, offering_id: expectedOfferingId };
}

async function quoteByComponents(pg, command, catalog, requireDb) {
  const resolved = resolveQuoteComponentsAndRentalsInput(command);
  if (!resolved.ok) return resolved;
  const { input, rentalsNorm } = resolved;
  const serviceDates = input.service_dates || [];

  const lines = [];
  let totalCents = 0;
  let currency = 'EUR';

  if (input.components.course) {
    const comp = input.components.course;
    const identity = resolveCourseOfferingIdentity(comp);
    if (!identity.ok) return identity;
    const offeringId = identity.offering_id;
    const matches = findCatalogOffering({ offerings: catalog.offerings }, offeringId);
    if (!matches.length) {
      return { ok: false, status: 422, body: { success: false, reason: 'unknown_offering' } };
    }
    const offering = nestOfferingForQuote(matches[0]);
    const qty = Math.max(1, Number(comp.quantity) || 1);
    const lineOut = pg
      ? await quoteOfferingLine(pg, command, offering, serviceDates, qty, requireDb)
      : quoteOfferingLineSync(command, offering, serviceDates, qty, requireDb);
    if (!lineOut.ok) return lineOut;
    lines.push({ ...lineOut.line, component: 'course' });
    totalCents += lineOut.line.total_cents;
    currency = lineOut.line.currency;
  }

  if (input.components.private_lesson) {
    const pl = input.components.private_lesson;
    const matches = (catalog.offerings || []).filter((o) => o.offering_type === 'private_lesson');
    if (!matches.length) {
      return { ok: false, status: 422, body: { success: false, reason: 'price_missing' } };
    }
    const offering = nestOfferingForQuote(matches[0]);
    const sessions = pl.sessions || [];
    const dates = sessions.map((s) => String(s.date).slice(0, 10)).filter(Boolean);
    // Admin private is per-session × surfers. Session count comes from dates;
    // quantity must be surfer_count (never session count — that double-bills).
    const qty = Math.max(1, Number(pl.surfer_count) || 1);
    const lineOut = pg
      ? await quoteOfferingLine(pg, command, offering, dates.length ? dates : serviceDates, qty, requireDb)
      : quoteOfferingLineSync(command, offering, dates.length ? dates : serviceDates, qty, requireDb);
    if (!lineOut.ok) return lineOut;
    lines.push({ ...lineOut.line, component: 'private_lesson' });
    totalCents += lineOut.line.total_cents;
    currency = lineOut.line.currency;
  }

  // Course-owned multi-item equipment: exact selected Group/Private course
  // options + active scoped rental identity. Never shared location pricing,
  // equipment_included, or per-day multiplication.
  let courseEquipmentEcho = input.course_equipment || null;
  if (input.course_equipment != null) {
    let courseForEquipment = null;
    let surfers = null;
    if (input.components.course) {
      const identity = resolveCourseOfferingIdentity(input.components.course);
      if (!identity.ok) return identity;
      const match = findCatalogOffering({ offerings: catalog.offerings }, identity.offering_id)[0];
      if (!match) {
        return { ok: false, status: 422, body: { success: false, reason: 'unknown_offering' } };
      }
      courseForEquipment = nestOfferingForQuote(match);
      surfers = Math.max(1, Number(input.components.course.quantity) || 1);
    } else if (input.components.private_lesson) {
      const match = (catalog.offerings || []).find((o) => o.offering_type === 'private_lesson');
      if (!match) {
        return { ok: false, status: 422, body: { success: false, reason: 'price_missing' } };
      }
      courseForEquipment = nestOfferingForQuote(match);
      surfers = Math.max(1, Number(input.components.private_lesson.surfer_count) || 1);
    } else {
      return { ok: false, status: 422, body: { success: false, reason: 'invalid_course_equipment' } };
    }
    const equipmentOut = buildCourseEquipmentQuoteLines({
      selection: input.course_equipment,
      course: courseForEquipment,
      surfers,
      locationId: command.locationId,
      catalog,
    });
    if (!equipmentOut.ok) return equipmentOut;
    try {
      totalCents = checkedCourseEquipmentAdd(totalCents, equipmentOut.total_cents, 'quote total');
    } catch (err) {
      return {
        ok: false,
        status: 422,
        body: {
          success: false,
          reason: 'invalid_course_equipment',
          error: String(err.message || err),
        },
      };
    }
    lines.push(...equipmentOut.lines);
    courseEquipmentEcho = equipmentOut.course_equipment;
  }

  if (rentalsNorm.present) {
    for (const rental of rentalsNorm.value) {
      const matches = findExactRentalCatalogOffering(
        catalog,
        rental.offering_key,
        rental.duration_key,
        command.locationId,
      );
      if (!matches.length) {
        return { ok: false, status: 422, body: { success: false, reason: 'price_missing' } };
      }
      const offering = nestOfferingForQuote(matches[0]);
      const lineOut = pg
        ? await quoteOfferingLine(pg, command, offering, serviceDates, rental.quantity, requireDb)
        : quoteOfferingLineSync(command, offering, serviceDates, rental.quantity, requireDb);
      if (!lineOut.ok) return lineOut;
      lines.push({
        ...lineOut.line,
        component: rental.offering_key,
        duration_key: rental.duration_key,
      });
      totalCents += lineOut.line.total_cents;
      currency = lineOut.line.currency;
    }
  } else {
    // Legacy components.surfboard / components.wetsuit when rentals[] absent.
    // Duration identity from authoritative inclusive service dates — never hardcode __1_day.
    const legacyDur = quoteRentalDurationKeyFromDateRange(
      serviceDates[0],
      serviceDates[serviceDates.length - 1] || serviceDates[0],
    ) || '1_day';
    for (const rentalKey of ['surfboard', 'wetsuit']) {
      if (!input.components[rentalKey]) continue;
      const comp = input.components[rentalKey];
      const offeringKey = rentalKey === 'surfboard' ? 'board_rental' : 'wetsuit_rental';
      const matches = findExactRentalCatalogOffering(
        catalog, offeringKey, legacyDur, command.locationId,
      );
      if (!matches.length) {
        return { ok: false, status: 422, body: { success: false, reason: 'price_missing' } };
      }
      const offering = nestOfferingForQuote(matches[0]);
      const qty = Math.max(1, Number(comp.quantity) || 1);
      const lineOut = pg
        ? await quoteOfferingLine(pg, command, offering, serviceDates, qty, requireDb)
        : quoteOfferingLineSync(command, offering, serviceDates, qty, requireDb);
      if (!lineOut.ok) return lineOut;
      lines.push({ ...lineOut.line, component: rentalKey, duration_key: legacyDur });
      totalCents += lineOut.line.total_cents;
      currency = lineOut.line.currency;
    }
  }

  // Full-day gear is a commercial Admin quote line (person × day × unit cents).
  // Canonical explicit component — never derived from legacy rental mismatch rules.
  if (input.components[FULL_DAY_EQUIPMENT_ADDON_KEY]) {
    const fdOut = pg
      ? await quoteFullDayEquipmentAddonLine(
        pg, command, input.components[FULL_DAY_EQUIPMENT_ADDON_KEY], requireDb, catalog,
      )
      : quoteFullDayEquipmentAddonLineSync(
        command, input.components[FULL_DAY_EQUIPMENT_ADDON_KEY], catalog,
      );
    if (!fdOut.ok) return fdOut;
    lines.push(fdOut.line);
    totalCents += fdOut.line.total_cents;
    currency = fdOut.line.currency || currency;
  }

  if (!lines.length) {
    return { ok: false, status: 400, body: { success: false, reason: 'quote_input_required' } };
  }

  // Staff custom commercial adjustments (Admin lines + custom; never client-mutated Admin cents).
  const withCustom = appendCustomLineItemsToQuote(command, lines, totalCents, currency);
  if (!withCustom.ok) return withCustom;
  totalCents = withCustom.totalCents;
  currency = withCustom.currency;

  const primary = lines.find((l) => l && l.component !== STAFF_CUSTOM_LINE_COMPONENT) || lines[0];
  const quotedAt = command.now.toISOString();
  const quoteBody = {
    success: true,
    client_slug: SUNSET_CLIENT_SLUG,
    location_id: command.locationId,
    channel: command.channel,
    course_equipment: courseEquipmentEcho,
    line_items: lines,
    offering_id: primary.offering_id,
    course_id: primary.course_id,
    tier_key: primary.tier_key,
    quantity: primary.quantity,
    service_dates: serviceDates,
    unit_amount_cents: primary.unit_amount_cents,
    total_cents: totalCents,
    line_total_cents: totalCents,
    currency,
    price_source: primary.price_source,
    source: catalog.source,
    offering_item_code: primary.offering_item_code,
    billing_unit: primary.billing_unit,
    billing_mode: primary.billing_mode,
    capacity_by_date: primary.capacity_by_date,
    quoted_at: quotedAt,
  };
  quoteBody.quote_provenance = buildQuoteProvenance(quoteBody);
  return { ok: true, status: 200, body: quoteBody };
}

function quoteByComponentsSync(command, catalog, requireDb) {
  // Sync callers must not receive a Promise — price with catalog amounts only.
  const resolved = resolveQuoteComponentsAndRentalsInput(command);
  if (!resolved.ok) return resolved;
  const { input, rentalsNorm } = resolved;
  const serviceDates = input.service_dates || [];

  const lines = [];
  let totalCents = 0;
  let currency = 'EUR';

  if (input.components.course) {
    const comp = input.components.course;
    const identity = resolveCourseOfferingIdentity(comp);
    if (!identity.ok) return identity;
    const offeringId = identity.offering_id;
    const matches = findCatalogOffering({ offerings: catalog.offerings }, offeringId);
    if (!matches.length) {
      return { ok: false, status: 422, body: { success: false, reason: 'unknown_offering' } };
    }
    const offering = nestOfferingForQuote(matches[0]);
    const qty = Math.max(1, Number(comp.quantity) || 1);
    const lineOut = quoteOfferingLineSync(command, offering, serviceDates, qty, requireDb);
    if (!lineOut.ok) return lineOut;
    lines.push({ ...lineOut.line, component: 'course' });
    totalCents += lineOut.line.total_cents;
    currency = lineOut.line.currency;
  }

  if (input.components.private_lesson) {
    const pl = input.components.private_lesson;
    const matches = (catalog.offerings || []).filter((o) => o.offering_type === 'private_lesson');
    if (!matches.length) {
      return { ok: false, status: 422, body: { success: false, reason: 'price_missing' } };
    }
    const offering = nestOfferingForQuote(matches[0]);
    const sessions = pl.sessions || [];
    const dates = sessions.map((s) => String(s.date).slice(0, 10)).filter(Boolean);
    // Admin private is per-session × surfers. Session count comes from dates.
    const qty = Math.max(1, Number(pl.surfer_count) || 1);
    const lineOut = quoteOfferingLineSync(command, offering, dates.length ? dates : serviceDates, qty, requireDb);
    if (!lineOut.ok) return lineOut;
    lines.push({ ...lineOut.line, component: 'private_lesson' });
    totalCents += lineOut.line.total_cents;
    currency = lineOut.line.currency;
  }

  // Course-owned multi-item equipment (sync path — same authority as async).
  let courseEquipmentEcho = input.course_equipment || null;
  if (input.course_equipment != null) {
    let courseForEquipment = null;
    let surfers = null;
    if (input.components.course) {
      const identity = resolveCourseOfferingIdentity(input.components.course);
      if (!identity.ok) return identity;
      const match = findCatalogOffering({ offerings: catalog.offerings }, identity.offering_id)[0];
      if (!match) {
        return { ok: false, status: 422, body: { success: false, reason: 'unknown_offering' } };
      }
      courseForEquipment = nestOfferingForQuote(match);
      surfers = Math.max(1, Number(input.components.course.quantity) || 1);
    } else if (input.components.private_lesson) {
      const match = (catalog.offerings || []).find((o) => o.offering_type === 'private_lesson');
      if (!match) {
        return { ok: false, status: 422, body: { success: false, reason: 'price_missing' } };
      }
      courseForEquipment = nestOfferingForQuote(match);
      surfers = Math.max(1, Number(input.components.private_lesson.surfer_count) || 1);
    } else {
      return { ok: false, status: 422, body: { success: false, reason: 'invalid_course_equipment' } };
    }
    const equipmentOut = buildCourseEquipmentQuoteLines({
      selection: input.course_equipment,
      course: courseForEquipment,
      surfers,
      locationId: command.locationId,
      catalog,
    });
    if (!equipmentOut.ok) return equipmentOut;
    try {
      totalCents = checkedCourseEquipmentAdd(totalCents, equipmentOut.total_cents, 'quote total');
    } catch (err) {
      return {
        ok: false,
        status: 422,
        body: {
          success: false,
          reason: 'invalid_course_equipment',
          error: String(err.message || err),
        },
      };
    }
    lines.push(...equipmentOut.lines);
    courseEquipmentEcho = equipmentOut.course_equipment;
  }

  if (rentalsNorm.present) {
    for (const rental of rentalsNorm.value) {
      const matches = findExactRentalCatalogOffering(
        catalog,
        rental.offering_key,
        rental.duration_key,
        command.locationId,
      );
      if (!matches.length) {
        return { ok: false, status: 422, body: { success: false, reason: 'price_missing' } };
      }
      const offering = nestOfferingForQuote(matches[0]);
      const lineOut = quoteOfferingLineSync(command, offering, serviceDates, rental.quantity, requireDb);
      if (!lineOut.ok) return lineOut;
      lines.push({
        ...lineOut.line,
        component: rental.offering_key,
        duration_key: rental.duration_key,
      });
      totalCents += lineOut.line.total_cents;
      currency = lineOut.line.currency;
    }
  } else {
    // Legacy components path: duration from inclusive service dates (not hardcoded __1_day).
    const legacyDur = quoteRentalDurationKeyFromDateRange(
      serviceDates[0],
      serviceDates[serviceDates.length - 1] || serviceDates[0],
    ) || '1_day';
    for (const rentalKey of ['surfboard', 'wetsuit']) {
      if (!input.components[rentalKey]) continue;
      const comp = input.components[rentalKey];
      const offeringKey = rentalKey === 'surfboard' ? 'board_rental' : 'wetsuit_rental';
      const matches = findExactRentalCatalogOffering(
        catalog, offeringKey, legacyDur, command.locationId,
      );
      if (!matches.length) {
        return { ok: false, status: 422, body: { success: false, reason: 'price_missing' } };
      }
      const offering = nestOfferingForQuote(matches[0]);
      const qty = Math.max(1, Number(comp.quantity) || 1);
      const lineOut = quoteOfferingLineSync(command, offering, serviceDates, qty, requireDb);
      if (!lineOut.ok) return lineOut;
      lines.push({ ...lineOut.line, component: rentalKey, duration_key: legacyDur });
      totalCents += lineOut.line.total_cents;
      currency = lineOut.line.currency;
    }
  }

  // Canonical explicit full-day component (Admin unit × people × days).
  if (input.components[FULL_DAY_EQUIPMENT_ADDON_KEY]) {
    const fdOut = quoteFullDayEquipmentAddonLineSync(
      command, input.components[FULL_DAY_EQUIPMENT_ADDON_KEY], catalog,
    );
    if (!fdOut.ok) return fdOut;
    lines.push(fdOut.line);
    totalCents += fdOut.line.total_cents;
    currency = fdOut.line.currency || currency;
  }

  if (!lines.length) {
    return { ok: false, status: 400, body: { success: false, reason: 'quote_input_required' } };
  }

  const withCustom = appendCustomLineItemsToQuote(command, lines, totalCents, currency);
  if (!withCustom.ok) return withCustom;
  totalCents = withCustom.totalCents;
  currency = withCustom.currency;

  const primary = lines.find((l) => l && l.component !== STAFF_CUSTOM_LINE_COMPONENT) || lines[0];
  const quotedAt = command.now.toISOString();
  const quoteBody = {
    success: true,
    client_slug: SUNSET_CLIENT_SLUG,
    location_id: command.locationId,
    channel: command.channel,
    course_equipment: courseEquipmentEcho,
    line_items: lines,
    offering_id: primary.offering_id,
    course_id: primary.course_id,
    tier_key: primary.tier_key,
    quantity: primary.quantity,
    service_dates: serviceDates,
    unit_amount_cents: primary.unit_amount_cents,
    total_cents: totalCents,
    line_total_cents: totalCents,
    currency,
    price_source: primary.price_source,
    source: catalog.source,
    offering_item_code: primary.offering_item_code,
    billing_unit: primary.billing_unit,
    billing_mode: primary.billing_mode,
    capacity_by_date: primary.capacity_by_date,
    quoted_at: quotedAt,
  };
  quoteBody.quote_provenance = buildQuoteProvenance(quoteBody);
  return { ok: true, status: 200, body: quoteBody };
}

function executeSunsetQuoteSync(command, opts = {}) {
  if (!command || command.clientSlug !== SUNSET_CLIENT_SLUG) {
    return {
      ok: false,
      status: 403,
      body: { success: false, error: 'unsupported_client', reason_code: 'tenant_mismatch' },
    };
  }
  const requireDb = resolveQuoteRequireDb(command.transportBody);
  const adminCfg = opts.adminCfg || null;
  if (!adminCfg || adminCfg.ok === false) {
    return { ok: false, status: 422, body: { success: false, reason: 'admin_db_expected_unavailable' } };
  }
  if (requireDb && adminCfg.source !== 'db') {
    return { ok: false, status: 422, body: { success: false, reason: 'admin_db_expected_unavailable' } };
  }
  const catalogCmd = catalogCommandFromQuoteCommand(command);
  catalogCmd.requireDb = requireDb;
  const catalogResult = executeSunsetCatalogSync(catalogCmd, { adminCfg });
  if (!catalogResult.ok) {
    return {
      ok: false,
      status: catalogResult.status || 422,
      body: { success: false, reason: catalogResult.body.reason || catalogResult.body.reason_code },
    };
  }
  const filtered = filterQuoteCatalogOfferings({
    ok: true,
    offerings: catalogResult.body.offerings || [],
    source: catalogResult.body.source,
  });
  filtered._adminCfg = adminCfg;
  filtered.source = requireDb ? 'admin_db' : (filtered.source || adminCfg.source);
  const body = command.transportBody;
  if (body.offering_id) {
    return quoteByOfferingIdSync(command, filtered, requireDb);
  }
  if (quoteShouldUseComponentsPath(body)) {
    return quoteByComponentsSync(command, filtered, requireDb);
  }
  return { ok: false, status: 400, body: { success: false, reason: 'quote_input_required' } };
}

/**
 * Execute a read-only Sunset quote. pg may be null for config-only unit tests.
 */
async function executeSunsetQuote(pg, command, opts = {}) {
  if (!command || command.clientSlug !== SUNSET_CLIENT_SLUG) {
    return {
      ok: false,
      status: 403,
      body: { success: false, error: 'unsupported_client', reason_code: 'tenant_mismatch' },
    };
  }

  const requireDb = resolveQuoteRequireDb(command.transportBody);
  let adminCfg = opts.adminCfg || null;
  if (!adminCfg) {
    if (!pg) {
      return { ok: false, status: 500, body: { success: false, reason: 'admin_config_unavailable' } };
    }
    const { resolveTenantBusinessConfigAsync } = require('./tenant-business-config');
    adminCfg = await resolveTenantBusinessConfigAsync(SUNSET_CLIENT_SLUG, {
      locationId: command.locationId,
      pgClient: pg,
      skipDb: command.transportBody.dry_run === true,
    });
  }
  if (!adminCfg || adminCfg.ok === false) {
    return { ok: false, status: 422, body: { success: false, reason: 'admin_db_expected_unavailable' } };
  }
  if (requireDb && adminCfg.source !== 'db') {
    return { ok: false, status: 422, body: { success: false, reason: 'admin_db_expected_unavailable' } };
  }

  const catalogRaw = await loadQuoteOfferings(pg, command, adminCfg, requireDb);
  if (!catalogRaw.ok) {
    return { ok: false, status: 422, body: { success: false, reason: catalogRaw.reason } };
  }
  const catalog = filterQuoteCatalogOfferings(catalogRaw);
  catalog._adminCfg = adminCfg;
  catalog.source = requireDb ? 'admin_db' : (catalog.source || adminCfg.source);

  const body = command.transportBody;
  if (body.offering_id) {
    return quoteByOfferingId(pg, command, catalog, requireDb);
  }
  if (quoteShouldUseComponentsPath(body)) {
    return quoteByComponents(pg, command, catalog, requireDb);
  }
  return { ok: false, status: 400, body: { success: false, reason: 'quote_input_required' } };
}

/**
 * Re-quote with the same inputs and compare provenance — used before booking create.
 */
async function validateQuoteProvenanceForCreate(pg, command, provenance, opts = {}) {
  if (!provenance || typeof provenance !== 'object') {
    return { ok: true };
  }
  const quoteTransport = {
    ...command.transportBody,
    service_dates: provenance.service_dates || command.transportBody.service_dates,
    quantity: provenance.quantity != null ? provenance.quantity : command.transportBody.quantity,
    require_db: true,
  };
  if (quoteShouldUseComponentsPath(command.transportBody)) {
    quoteTransport.components = command.transportBody.components;
    if (Array.isArray(command.transportBody.rentals)) {
      quoteTransport.rentals = command.transportBody.rentals;
    }
    delete quoteTransport.offering_id;
  } else {
    quoteTransport.offering_id = provenance.offering_id || command.transportBody.offering_id;
    quoteTransport.course_id = provenance.course_id || command.transportBody.course_id;
    quoteTransport.tier_key = provenance.tier_key || command.transportBody.tier_key;
  }
  const quoteResult = await executeSunsetQuote(pg, {
    ...command,
    transportBody: quoteTransport,
  }, { adminCfg: opts.adminCfg });
  if (!quoteResult.ok) {
    return {
      ok: false,
      status: 409,
      body: {
        success: false,
        error: 'The quoted price is no longer available. Please request a fresh quote.',
        reason_code: 'stale_quote',
        detail: 'quote_refresh_failed',
        quote_error: quoteResult.body,
      },
    };
  }
  const fresh = buildQuoteProvenance(quoteResult.body);
  const expectedFp = provenance.quote_fingerprint || computeQuoteFingerprint(provenance);
  if (fresh.quote_fingerprint !== expectedFp) {
    return {
      ok: false,
      status: 409,
      body: {
        success: false,
        error: 'The quoted price is no longer available. Please request a fresh quote.',
        reason_code: 'stale_quote',
        detail: 'quote_fingerprint_mismatch',
        expected_fingerprint: expectedFp,
        current_fingerprint: fresh.quote_fingerprint,
        prior: provenance,
        current: fresh,
      },
    };
  }
  return { ok: true, current_provenance: fresh };
}

module.exports = {
  QUOTE_CHANNELS,
  QUOTE_PROVENANCE_VERSION,
  CLIENT_MONEY_FIELDS,
  buildSunsetQuoteCommand,
  executeSunsetQuote,
  executeSunsetQuoteSync,
  computeQuoteFingerprint,
  buildQuoteProvenance,
  validateQuoteProvenanceForCreate,
  rejectClientSuppliedMoney,
  computeBillableUnits,
  appendCustomLineItemsToQuote,
  resolveCourseOfferingIdentity,
};
