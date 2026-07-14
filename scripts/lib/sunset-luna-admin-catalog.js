'use strict';

/**
 * Read-only guest-safe Sunset offering projection from Admin-resolved config.
 * Canonical identity + schedule eligibility come from sunset-bookable-offerings
 * so Luna catalog/quote match Schedule and manual create.
 */

const { normalizeSunsetLocationId, isSunsetLocationId } = require('./sunset-school-locations');
const { parseQuoteQuantity } = require('./sunset-group-lesson-quote');
const {
  projectSunsetBookableOfferingsFromConfig,
} = require('./sunset-bookable-offerings');
const {
  evaluateSunsetOfferingDates,
} = require('./sunset-offering-schedule');

function parsePackSchedule(value) {
  const m = /^([01]\d|2[0-3])([0-5]\d)_([01]\d|2[0-3])([0-5]\d)$/.exec(String(value || '').trim());
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (!(end > start)) return null;
  return {
    start_time: `${m[1]}:${m[2]}`,
    end_time: `${m[3]}:${m[4]}`,
    key: String(value).trim(),
  };
}

function parseLessonSlotTime(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim());
  if (!m) return null;
  if (!((Number(m[1]) * 60 + Number(m[2])) < (Number(m[3]) * 60 + Number(m[4])))) return null;
  return { start_time: `${m[1]}:${m[2]}`, end_time: `${m[3]}:${m[4]}` };
}

function nestOffering(raw) {
  const schedule = raw.schedule || {};
  return {
    offering_id: raw.offering_id,
    offering_type: raw.offering_type,
    label: raw.label,
    guest_description: raw.guest_description || raw.label,
    active: true,
    bookable: raw.bookable !== false,
    eligible_on_requested_dates: raw.eligible_on_requested_dates,
    schedule_rejection: raw.schedule_rejection || null,
    schedule: {
      start_time: schedule.start_time || null,
      end_time: schedule.end_time || null,
      weekdays: Array.isArray(schedule.allowed_weekdays)
        ? schedule.allowed_weekdays
        : (Array.isArray(schedule.weekdays) ? schedule.weekdays : []),
      weekly: schedule.weekly || null,
      summary: schedule.summary || null,
      allowed_weekdays: Array.isArray(schedule.allowed_weekdays) ? schedule.allowed_weekdays : [],
      specific_dates: schedule.specific_dates || [],
      excluded_dates: schedule.excluded_dates || [],
      starts_on: schedule.starts_on || null,
      ends_on: schedule.ends_on || null,
      time_slots: schedule.time_slots || [],
    },
    duration: raw.duration || (raw.tier && raw.tier.hours != null ? `${raw.tier.hours}h` : (raw.tier_key || null)),
    capacity: raw.capacity != null ? Number(raw.capacity) : null,
    price: {
      price_id: raw.price_identity && raw.price_identity.price_id
        ? raw.price_identity.price_id
        : raw.price_id,
      amount_cents: raw.unit_amount_cents,
      currency: raw.currency || 'EUR',
      unit: raw.billing_unit || 'session',
    },
    course_id: raw.course_id || null,
    included_items: Array.isArray(raw.included_items) ? raw.included_items : [],
    unit_amount_cents: raw.unit_amount_cents,
    billing_unit: raw.billing_unit,
    billing_mode: raw.billing_mode || null,
    price_id: (raw.price_identity && raw.price_identity.price_id) || raw.price_id,
    currency: raw.currency || 'EUR',
    schedules: raw.schedule && raw.schedule.time_slots ? raw.schedule.time_slots : raw.schedules,
    slot_id: raw.slot_id || undefined,
    slot_time: raw.slot_time || undefined,
    age_band: raw.age_band || undefined,
    tier: raw.tier || undefined,
    tier_key: raw.tier_key || (raw.tier && raw.tier.key) || undefined,
    offering_item_code: raw.offering_item_code || raw.item_code || undefined,
    item_code: raw.item_code || raw.offering_item_code || undefined,
    price_identity: raw.price_identity || undefined,
    price_source: raw.price_source || 'admin_db',
  };
}

function buildSunsetLunaCatalogFromConfig(adminCfg, {
  locationId, asOfDate, requireDb = false, requestedDates = null, bookableOnly = false,
} = {}) {
  const location_id = normalizeSunsetLocationId(locationId);
  if (!isSunsetLocationId(locationId || location_id)) {
    return { ok: false, reason: 'wrong_location', offerings: [], location_id };
  }

  const dates = requestedDates
    || (asOfDate ? null : null); // asOfDate is price-window only unless dates passed
  const projection = projectSunsetBookableOfferingsFromConfig(adminCfg, {
    locationId: location_id,
    asOf: asOfDate,
    asOfDate,
    requestedDates: dates,
    requireDb,
    bookableOnly,
  });
  if (!projection.ok) {
    return {
      ok: false,
      reason: projection.reason,
      offerings: [],
      location_id,
    };
  }

  // Guest catalog: courses with resolvable owner amount + private/rentals.
  // When requestedDates are set, keep ineligible courses but mark them so Luna
  // can explain weekends-only without inventing availability.
  let offerings = (projection.offerings || [])
    .filter((o) => o.unit_amount_cents != null && o.unit_amount_cents > 0)
    .filter((o) => {
      // Never surface unpriced course tiers.
      if (o.offering_type === 'course' && !o.price_identity) return false;
      if (o.offering_type === 'course' && o.unit_amount_cents == null) return false;
      return true;
    });

  if (bookableOnly) {
    offerings = offerings.filter((o) => o.bookable === true);
  }

  return {
    ok: true,
    success: true,
    client_slug: 'sunset',
    location_id,
    source: projection.source || adminCfg.source || 'config',
    currency: adminCfg.currency || 'EUR',
    requested_dates: dates,
    offerings: offerings.map(nestOffering),
  };
}

function findCatalogOffering(catalog, offeringId) {
  const id = String(offeringId || '').trim();
  if (!id) return [];
  return (catalog.offerings || []).filter((o) => (
    o.offering_id === id
    || o.price_id === id
    || o.offering_item_code === id
    || o.item_code === id
    || (o.price && o.price.price_id === id)
  ));
}

function quoteSunsetOfferingFromCatalog(adminCfg, body = {}) {
  const locationId = body.location_id || body.location;
  const serviceDates = Array.isArray(body.service_dates)
    ? [...new Set(body.service_dates.map((d) => String(d).slice(0, 10)).filter(Boolean))]
    : [];
  const catalog = buildSunsetLunaCatalogFromConfig(adminCfg, {
    locationId,
    asOfDate: body.as_of_date || body.date || (serviceDates[0] || null),
    requestedDates: serviceDates.length ? serviceDates : null,
    requireDb: body.require_db === true || body.requireDb === true,
  });
  if (!catalog.ok) return { ok: false, success: false, reason: catalog.reason };

  const offeringId = String(body.offering_id || '').trim();
  if (!offeringId) return { ok: false, success: false, reason: 'unknown_offering' };

  const matches = findCatalogOffering(catalog, offeringId);
  if (!matches.length) {
    const rawPrices = (adminCfg.prices || []).filter(
      (p) => p.id === offeringId || p.offering_key === offeringId || p.item_code === offeringId,
    );
    if (rawPrices.length > 1) return { ok: false, success: false, reason: 'ambiguous_price' };
    if (rawPrices.length === 1) {
      const asOf = body.as_of_date || body.date;
      if (rawPrices[0].active === false) {
        return { ok: false, success: false, reason: 'inactive_offering' };
      }
      if (rawPrices[0].effective_from && String(rawPrices[0].effective_from).slice(0, 10) > String(asOf || '').slice(0, 10)) {
        return { ok: false, success: false, reason: 'future_price' };
      }
      if (rawPrices[0].effective_to && String(rawPrices[0].effective_to).slice(0, 10) < String(asOf || '').slice(0, 10)) {
        return { ok: false, success: false, reason: 'expired_price' };
      }
      return { ok: false, success: false, reason: 'unknown_offering' };
    }
    const knownUnpriced = (adminCfg.lesson_times || []).some((s) => `lesson_slot_${s.slot_id}__session` === offeringId)
      || (adminCfg.surf_packs || []).some((p) => (p.price_tiers || []).some((t) => `surf_pack_${p.pack_id}__${t.key}` === offeringId));
    return { ok: false, success: false, reason: knownUnpriced ? 'price_missing' : 'unknown_offering' };
  }
  if (matches.length > 1) return { ok: false, success: false, reason: 'ambiguous_price' };

  const offering = matches[0];
  if (offering.offering_type === 'course' && body.course_id == null) {
    return { ok: false, success: false, reason: 'course_identity_missing' };
  }
  if (body.course_id != null && String(offering.course_id || '') !== String(body.course_id)) {
    return { ok: false, success: false, reason: 'mismatched_course_offering' };
  }

  const quantity = parseQuoteQuantity(body.quantity);
  if (quantity == null) return { ok: false, success: false, reason: 'incompatible_unit' };

  if (offering.offering_type === 'course' && serviceDates.length) {
    const scheduleCheck = evaluateSunsetOfferingDates(offering, serviceDates);
    if (!scheduleCheck.ok) {
      return {
        ok: false,
        success: false,
        reason: scheduleCheck.reason,
        reason_code: scheduleCheck.reason,
        error: (scheduleCheck.staff_error && scheduleCheck.staff_error.error) || scheduleCheck.reason,
        schedule_summary: scheduleCheck.schedule_summary,
        detail: scheduleCheck.detail || null,
      };
    }
  }

  const dates = serviceDates;
  const unit = String(offering.billing_unit || offering.price && offering.price.unit || '').toLowerCase();
  const sessionUnit = /session|single_lesson|person/.test(unit)
    && offering.offering_type !== 'course';
  const courseUnit = offering.offering_type === 'course'
    || /week|course|bundle|day|^\d+_day|^\d+_days|^\d+_week/.test(unit);

  if (sessionUnit && !dates.length) {
    return { ok: false, success: false, reason: 'incompatible_unit' };
  }

  const unitAmount = offering.unit_amount_cents != null
    ? offering.unit_amount_cents
    : (offering.price && offering.price.amount_cents);
  if (unitAmount == null || unitAmount < 0) {
    return { ok: false, success: false, reason: 'price_missing' };
  }

  let billableUnits;
  if (sessionUnit) billableUnits = quantity * dates.length;
  else if (courseUnit) billableUnits = quantity;
  else billableUnits = quantity * Math.max(1, dates.length || 1);

  const total = unitAmount * billableUnits;
  return {
    ok: true,
    success: true,
    location_id: normalizeSunsetLocationId(locationId),
    offering_id: offering.offering_id,
    course_id: offering.course_id || null,
    offering_type: offering.offering_type,
    label: offering.label,
    quantity,
    service_dates: dates,
    date_count: dates.length,
    unit_amount_cents: unitAmount,
    billable_units: billableUnits,
    total_cents: total,
    line_total_cents: total,
    currency: offering.currency || 'EUR',
    price_unit: offering.billing_unit || (offering.price && offering.price.unit) || unit,
    billing_unit: offering.billing_unit || (offering.price && offering.price.unit) || unit,
    billing_mode: offering.billing_mode || null,
    price_id: offering.price_id,
    price_source: catalog.source === 'db' || catalog.source === 'merged' || catalog.source === 'admin_db'
      ? 'admin_db'
      : 'config_or_db',
    source: catalog.source,
    tier_key: (offering.tier && offering.tier.key) || offering.tier_key || null,
    offering_item_code: offering.offering_item_code || offering.item_code || null,
    price_identity: offering.price_identity || {
      price_id: offering.price_id,
      item_type: offering.offering_type === 'course' ? 'package' : offering.offering_type,
      item_code: offering.offering_item_code || offering.item_code || offering.offering_id,
      unit: offering.billing_unit,
    },
    schedule_summary: offering.schedule && offering.schedule.summary,
  };
}

/**
 * Resolve a booking component's unit cents from Admin catalog by exact offering/course.
 * Returns null when the ordinary group-lesson fallback must not be used for a course.
 */
function resolveOfferingUnitCentsForBooking(adminCfg, meta = {}) {
  const offeringId = String(meta.offering_id || meta.price_id || meta.offering_item_code || '').trim();
  const courseId = meta.course_id != null ? String(meta.course_id).trim() : null;
  if (!offeringId && !courseId) return { ok: false, reason: 'unknown_offering' };

  const catalog = buildSunsetLunaCatalogFromConfig(adminCfg, {
    locationId: meta.location_id || adminCfg.location_id,
    requireDb: false,
  });
  if (!catalog.ok) return { ok: false, reason: catalog.reason };

  let matches = offeringId ? findCatalogOffering(catalog, offeringId) : [];
  if (!matches.length && courseId) {
    matches = (catalog.offerings || []).filter(
      (o) => o.offering_type === 'course' && String(o.course_id) === courseId,
    );
    if (meta.tier_key) {
      const tierMatches = matches.filter((o) => String(o.tier_key || (o.tier && o.tier.key) || '') === String(meta.tier_key));
      if (tierMatches.length) matches = tierMatches;
    }
  }
  if (!matches.length) return { ok: false, reason: 'unknown_offering' };
  if (matches.length > 1 && !offeringId) return { ok: false, reason: 'ambiguous_price' };
  const offering = matches[0];
  if (courseId && offering.course_id && String(offering.course_id) !== courseId) {
    return { ok: false, reason: 'mismatched_course_offering' };
  }
  return {
    ok: true,
    unit_amount_cents: offering.unit_amount_cents,
    offering_id: offering.offering_id,
    course_id: offering.course_id || null,
    price_id: offering.price_id,
    billing_unit: offering.billing_unit,
    label: offering.label,
  };
}

module.exports = {
  buildSunsetLunaCatalogFromConfig,
  quoteSunsetOfferingFromCatalog,
  resolveOfferingUnitCentsForBooking,
  parsePackSchedule,
  parseLessonSlotTime,
  findCatalogOffering,
};
