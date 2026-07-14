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
  const {
    executeSunsetQuoteSync,
    buildSunsetQuoteCommand,
    QUOTE_CHANNELS,
  } = require('./luna-front-desk-quote-service');
  const built = buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.LUNA_WHATSAPP,
    transportBody: body,
    trustedLocationId: body.location_id || body.location,
  });
  if (!built.ok) {
    return {
      ok: false,
      success: false,
      reason: built.body.reason_code || built.body.reason,
      error: built.body.error,
    };
  }
  const result = executeSunsetQuoteSync(built.command, { adminCfg });
  if (!result.ok) {
    return { ok: false, success: false, ...result.body };
  }
  return { ok: true, success: true, ...result.body };
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
