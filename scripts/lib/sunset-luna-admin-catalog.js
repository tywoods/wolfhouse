'use strict';

/**
 * Read-only guest-safe Sunset offering projection — delegates to the canonical
 * catalog application service (luna-front-desk-catalog-service.js).
 */

const {
  CATALOG_CHANNELS,
  buildSunsetCatalogCommand,
  executeSunsetCatalogSync,
  findCatalogOffering,
  nestCatalogOffering,
} = require('./luna-front-desk-catalog-service');

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

function buildSunsetLunaCatalogFromConfig(adminCfg, {
  locationId, asOfDate, requireDb = false, requestedDates = null, bookableOnly = false,
} = {}) {
  const built = buildSunsetCatalogCommand({
    channel: CATALOG_CHANNELS.LUNA_WHATSAPP,
    trustedLocationId: locationId,
    transportBody: {
      service_dates: requestedDates,
      date: asOfDate,
      require_db: requireDb,
      bookable_only: bookableOnly,
    },
  });
  if (!built.ok) {
    return {
      ok: false,
      reason: built.body.reason_code || built.body.reason,
      offerings: [],
      location_id: locationId,
    };
  }
  const command = {
    ...built.command,
    requireDb: requireDb || built.command.requireDb,
  };
  const result = executeSunsetCatalogSync(command, { adminCfg });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.body.reason || result.body.reason_code,
      offerings: [],
      location_id: command.locationId,
    };
  }
  let offerings = result.body.offerings || [];
  if (bookableOnly) {
    offerings = offerings.filter((o) => o.bookable === true);
  }
  return {
    ...result.body,
    offerings,
  };
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
  nestCatalogOffering,
};
