'use strict';

/**
 * Luna Front Desk — canonical Sunset catalog / offering-discovery application service.
 *
 * Read-only. Shared by Schedule create selectors, Staff quote preparation, Luna
 * catalog tools, joinable-course discovery, and post-booking add-service reads.
 *
 * See docs/LUNA-FRONT-DESK-DOMAIN-CONTRACT.md §2.1, §2.7.
 */

const {
  projectSunsetBookableOfferingsFromConfig,
  loadSunsetBookableOfferings,
  scheduleCoursesFromBookableProjection,
  SUNSET_CLIENT_SLUG,
} = require('./sunset-bookable-offerings');
const {
  countConfirmedCourseSeatsOnDate,
  weekdaysFromPackWeekly,
  weekdayOfIsoDate,
} = require('./sunset-admin-course-join');
const { isSunsetAdminDbReadEnabled } = require('./tenant-business-config');
const {
  normalizeSunsetLocationId,
  isSunsetLocationId,
} = require('./sunset-school-locations');

const CATALOG_CHANNELS = Object.freeze({
  MANUAL_STAFF: 'manual_staff',
  LUNA_WHATSAPP: 'luna_whatsapp',
  LUNA_EMAIL: 'luna_email',
  SCHEDULE: 'schedule',
  ADMIN_CONSUMER: 'admin_consumer',
});

const CATALOG_EXCLUSION_REASONS = Object.freeze({
  INACTIVE: 'offering_inactive',
  PRICE_MISSING: 'price_missing',
  PRICE_AMBIGUOUS: 'ambiguous_price',
  PRICE_NOT_RESOLVABLE: 'price_not_configured',
  SCHEDULE_NOT_CONFIGURED: 'schedule_not_configured',
  SCHEDULE_INELIGIBLE: 'service_dates_not_on_course_schedule',
  UNPRICED: 'unpriced_offering',
  NO_BOOKABLE_TIERS: 'no_bookable_tiers',
  CAPACITY_FULL: 'course_full',
  WRONG_LOCATION: 'wrong_location',
  TENANT_MISMATCH: 'tenant_mismatch',
  ADMIN_DB_UNAVAILABLE: 'admin_db_expected_unavailable',
  UNKNOWN_LOCATION: 'unknown_location',
});

function nestCatalogOffering(raw) {
  const schedule = raw.schedule || {};
  return {
    offering_id: raw.offering_id,
    offering_type: raw.offering_type,
    label: raw.label,
    guest_description: raw.guest_description || raw.label,
    active: raw.active !== false,
    bookable: raw.bookable === true,
    eligible_on_requested_dates: raw.eligible_on_requested_dates,
    schedule_rejection: raw.schedule_rejection || null,
    exclusion_reason: raw.exclusion_reason || null,
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
    // Course-owned multi-item equipment options (labels + cents). Current quote
    // authority never falls back to scalar equipment_included / equipment_price_cents.
    equipment_options: Array.isArray(raw.equipment_options)
      ? raw.equipment_options.map((row) => ({ ...row }))
      : [],
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

function extractRequestedDates(transportBody) {
  const b = transportBody || {};
  if (Array.isArray(b.service_dates) && b.service_dates.length) {
    return [...new Set(b.service_dates.map((d) => String(d).slice(0, 10)).filter(Boolean))];
  }
  if (Array.isArray(b.requested_dates) && b.requested_dates.length) {
    return [...new Set(b.requested_dates.map((d) => String(d).slice(0, 10)).filter(Boolean))];
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
  if (b.date || b.as_of_date) return [String(b.date || b.as_of_date).slice(0, 10)];
  return null;
}

function resolveCatalogRequireDb(transportBody) {
  const b = transportBody || {};
  if (b.require_db === false || b.requireDb === false) return false;
  if (b.require_db === true || b.requireDb === true) return true;
  return isSunsetAdminDbReadEnabled();
}

function deriveExclusionReason(raw) {
  if (raw.active === false) return CATALOG_EXCLUSION_REASONS.INACTIVE;
  if (raw.offering_type === 'course' && !raw.price_identity) {
    return CATALOG_EXCLUSION_REASONS.PRICE_NOT_RESOLVABLE;
  }
  if (raw.price_resolve_reason === 'ambiguous_price') {
    return CATALOG_EXCLUSION_REASONS.PRICE_AMBIGUOUS;
  }
  if (raw.price_resolve_reason) return CATALOG_EXCLUSION_REASONS.PRICE_NOT_RESOLVABLE;
  if (raw.unit_amount_cents == null || raw.unit_amount_cents <= 0) {
    return CATALOG_EXCLUSION_REASONS.UNPRICED;
  }
  if (raw.eligible_on_requested_dates === false) {
    const code = raw.schedule_rejection && (
      raw.schedule_rejection.reason_code || raw.schedule_rejection.error
    );
    return code || CATALOG_EXCLUSION_REASONS.SCHEDULE_INELIGIBLE;
  }
  if (raw.bookable !== true) return CATALOG_EXCLUSION_REASONS.PRICE_NOT_RESOLVABLE;
  return null;
}

function annotateCatalogOfferings(rawOfferings, { requestedDates, includeExcluded }) {
  const annotated = (rawOfferings || []).map((o) => {
    const exclusion = deriveExclusionReason(o);
    return {
      ...o,
      exclusion_reason: exclusion,
      bookable: o.bookable === true && !exclusion,
    };
  });

  if (includeExcluded) {
    return {
      offerings: annotated.filter((o) => o.bookable === true).map(nestCatalogOffering),
      excluded_offerings: annotated.filter((o) => o.bookable !== true).map(nestCatalogOffering),
    };
  }

  // Booking surfaces: return priced offerings (including schedule-ineligible for Luna explain).
  const priced = annotated.filter((o) => (
    o.unit_amount_cents != null && o.unit_amount_cents > 0
  )).filter((o) => {
    if (o.offering_type === 'course' && !o.price_identity) return false;
    if (o.offering_type === 'course' && o.unit_amount_cents == null) return false;
    return true;
  });

  return {
    offerings: priced.map(nestCatalogOffering),
    excluded_offerings: [],
  };
}

function buildSunsetCatalogCommand(opts) {
  const channel = String((opts && opts.channel) || '').trim();
  if (!Object.values(CATALOG_CHANNELS).includes(channel)) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        reason_code: 'invalid_channel',
        error: 'invalid catalog channel',
      },
    };
  }
  const rawLoc = opts && opts.trustedLocationId;
  const locationId = normalizeSunsetLocationId(rawLoc);
  if (rawLoc != null && String(rawLoc).trim() && !isSunsetLocationId(rawLoc)) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        reason_code: CATALOG_EXCLUSION_REASONS.WRONG_LOCATION,
        reason: CATALOG_EXCLUSION_REASONS.WRONG_LOCATION,
        error: 'wrong location',
        location_id: String(rawLoc).trim(),
      },
    };
  }
  const transportBody = (opts && opts.transportBody) || {};
  return {
    ok: true,
    command: {
      channel,
      clientSlug: SUNSET_CLIENT_SLUG,
      locationId,
      transportBody,
      requestedDates: extractRequestedDates(transportBody),
      requireDb: resolveCatalogRequireDb(transportBody),
      includeExcluded: transportBody.include_excluded === true
        || channel === CATALOG_CHANNELS.ADMIN_CONSUMER,
      includeCapacity: transportBody.include_capacity === true
        || transportBody.joinable === true,
      coursesOnly: transportBody.courses_only === true,
      asOfDate: transportBody.as_of_date || transportBody.date || null,
      now: (opts && opts.now) instanceof Date ? opts.now : new Date(),
    },
  };
}

/**
 * Load tenant/location rental identity rows for catalog label projection.
 * Never throws — empty list on failure so price-only fallback remains.
 */
async function loadRentalOfferingsForCatalog(pg, locationId) {
  if (!pg) return [];
  try {
    const { listRentalOfferings } = require('./tenant-rental-offerings');
    const rows = await listRentalOfferings(pg, {
      clientSlug: SUNSET_CLIENT_SLUG,
      locationId,
      includeInactive: false,
    });
    return Array.isArray(rows) ? rows : [];
  } catch (_) {
    return [];
  }
}

function adminCfgWithRentalOfferings(adminCfg, rentalOfferings) {
  const existing = adminCfg && Array.isArray(adminCfg.rental_offerings)
    ? adminCfg.rental_offerings
    : [];
  const next = (rentalOfferings && rentalOfferings.length) ? rentalOfferings : existing;
  if (!adminCfg) return { ok: true, rental_offerings: next };
  if (next === existing) return adminCfg;
  return { ...adminCfg, rental_offerings: next };
}

async function loadCatalogProjection(pg, command, adminCfg) {
  const projectionOpts = {
    locationId: command.locationId,
    requestedDates: command.requestedDates,
    requireDb: command.requireDb,
    asOfDate: command.asOfDate,
    bookableOnly: false,
    coursesOnly: command.coursesOnly,
  };

  // P0e: ensure rental identity labels are available to the bookable projection
  // (tenant-business-config prices alone do not carry Admin catalog names).
  let rentalOfferings = Array.isArray(adminCfg && adminCfg.rental_offerings)
    ? adminCfg.rental_offerings
    : [];
  if (pg && !rentalOfferings.length) {
    rentalOfferings = await loadRentalOfferingsForCatalog(pg, command.locationId);
  }
  const cfgForProject = adminCfgWithRentalOfferings(adminCfg, rentalOfferings);

  if (pg && command.requireDb) {
    const dbLoaded = await loadSunsetBookableOfferings(pg, {
      clientSlug: SUNSET_CLIENT_SLUG,
      locationId: command.locationId,
      requestedDates: command.requestedDates,
      asOfDate: command.asOfDate,
      bookableOnly: false,
    });
    if (!dbLoaded.ok) return dbLoaded;

    const projected = projectSunsetBookableOfferingsFromConfig(cfgForProject, {
      ...projectionOpts,
      requireDb: true,
      rentalOfferings: rentalOfferings.length
        ? rentalOfferings
        : (cfgForProject.rental_offerings || []),
    });
    if (!projected.ok && projected.reason === CATALOG_EXCLUSION_REASONS.ADMIN_DB_UNAVAILABLE) {
      return dbLoaded;
    }

    const byId = new Map((dbLoaded.offerings || []).map((o) => [o.offering_id, o]));
    if (projected.ok) {
      for (const o of (projected.offerings || [])) {
        if (o.offering_type !== 'course' && !byId.has(o.offering_id)) {
          byId.set(o.offering_id, o);
        }
      }
    }
    return {
      ok: true,
      source: 'admin_db',
      location_id: command.locationId,
      offerings: [...byId.values()],
      courses: dbLoaded.courses || (projected.ok ? projected.courses : []),
      currency: (adminCfg && adminCfg.currency) || 'EUR',
      requested_dates: command.requestedDates,
      rental_offerings: rentalOfferings,
    };
  }

  if (pg) {
    const dbCourses = await loadSunsetBookableOfferings(pg, {
      clientSlug: SUNSET_CLIENT_SLUG,
      locationId: command.locationId,
      requestedDates: command.requestedDates,
      asOfDate: command.asOfDate,
    });
    const projected = projectSunsetBookableOfferingsFromConfig(cfgForProject, {
      ...projectionOpts,
      rentalOfferings: rentalOfferings.length
        ? rentalOfferings
        : (cfgForProject.rental_offerings || []),
    });
    if (!projected.ok) return projected;
    const byId = new Map((projected.offerings || []).map((o) => [o.offering_id, o]));
    for (const o of (dbCourses.offerings || [])) {
      byId.set(o.offering_id, o);
    }
    return {
      ok: true,
      source: command.requireDb ? 'admin_db' : (projected.source || adminCfg.source),
      location_id: command.locationId,
      offerings: [...byId.values()],
      courses: projected.courses,
      currency: projected.currency || adminCfg.currency || 'EUR',
      requested_dates: command.requestedDates,
      rental_offerings: rentalOfferings,
    };
  }

  return projectSunsetBookableOfferingsFromConfig(cfgForProject, {
    ...projectionOpts,
    rentalOfferings: cfgForProject.rental_offerings || [],
  });
}

async function enrichJoinableCourses(pg, command, courses) {
  const asOfDate = command.requestedDates && command.requestedDates.length
    ? command.requestedDates[0]
    : null;
  const out = [];
  for (const course of courses || []) {
    const capacity = course.capacity != null ? Number(course.capacity) : null;
    let seatsBooked = null;
    let seatsRemaining = null;
    let joinable = true;
    if (asOfDate) {
      const weekdays = course.weekdays || weekdaysFromPackWeekly(course.weekly);
      const wd = weekdayOfIsoDate(asOfDate);
      if (weekdays.length && !weekdays.includes(wd)) {
        joinable = false;
      } else if (Number.isFinite(capacity) && capacity > 0) {
        seatsBooked = await countConfirmedCourseSeatsOnDate(pg, {
          clientSlug: SUNSET_CLIENT_SLUG,
          locationId: command.locationId,
          courseId: course.course_id,
          serviceDate: asOfDate,
        });
        seatsRemaining = Math.max(0, capacity - seatsBooked);
        joinable = seatsRemaining > 0;
      }
    }
    const tiers = (course.price_tiers || []).map((t) => ({
      key: t.key,
      label: t.label || t.key,
      offering_item_code: t.offering_item_code || t.offering_id,
      offering_id: t.offering_id,
    }));
    out.push({
      offering_type: 'course',
      course_id: course.course_id,
      pack_id: course.course_id,
      label: course.label,
      group_size: capacity,
      capacity,
      equipment_included: course.equipment_included === true,
      seats_booked: asOfDate ? seatsBooked : null,
      seats_remaining: seatsRemaining,
      joinable: asOfDate ? joinable : true,
      weekly: course.weekly,
      weekdays: course.weekdays || [],
      schedules: course.schedules || [],
      price_tiers: tiers,
      bookable: course.bookable !== false,
      eligible_on_requested_dates: course.eligible_on_requested_dates,
      schedule_rejection: course.schedule_rejection || null,
    });
  }
  const includeFull = command.transportBody && command.transportBody.include_full === true;
  return {
    courses: asOfDate ? out.filter((c) => c.joinable || includeFull) : out,
    group_lessons: [],
  };
}

function buildCatalogSuccessBody(command, projection, adminCfg, joinable) {
  const { offerings, excluded_offerings } = annotateCatalogOfferings(projection.offerings, {
    requestedDates: command.requestedDates,
    includeExcluded: command.includeExcluded,
  });

  let courses = scheduleCoursesFromBookableProjection({
    ok: true,
    courses: projection.courses,
    offerings: projection.offerings,
  });

  if (command.coursesOnly) {
    courses = courses.filter((c) => (c.price_tiers || []).some((t) => t.bookable !== false));
  }

  const body = {
    success: true,
    ok: true,
    client_slug: SUNSET_CLIENT_SLUG,
    location_id: command.locationId,
    source: projection.source || adminCfg.source || 'config',
    currency: projection.currency || adminCfg.currency || 'EUR',
    requested_dates: command.requestedDates,
    offerings,
    courses,
    excluded_offerings,
    group_lessons: [],
  };

  if (joinable) {
    body.courses = joinable.courses;
    body.group_lessons = joinable.group_lessons;
  }

  return body;
}

function validateCatalogCommand(command) {
  if (!command || command.clientSlug !== SUNSET_CLIENT_SLUG) {
    return {
      ok: false,
      status: 403,
      body: {
        success: false,
        reason_code: CATALOG_EXCLUSION_REASONS.TENANT_MISMATCH,
        error: 'tenant mismatch',
      },
    };
  }
  if (!isSunsetLocationId(command.locationId)) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        reason_code: CATALOG_EXCLUSION_REASONS.UNKNOWN_LOCATION,
        error: 'unknown location',
        location_id: command.locationId,
      },
    };
  }
  return { ok: true };
}

function mapCatalogFailure(projection, command) {
  const reason = projection.reason || CATALOG_EXCLUSION_REASONS.ADMIN_DB_UNAVAILABLE;
  return {
    ok: false,
    status: reason === CATALOG_EXCLUSION_REASONS.ADMIN_DB_UNAVAILABLE ? 503 : 400,
    body: {
      success: false,
      ok: false,
      reason,
      reason_code: reason,
      client_slug: SUNSET_CLIENT_SLUG,
      location_id: command.locationId,
      offerings: [],
      courses: [],
      excluded_offerings: [],
    },
  };
}

async function executeSunsetCatalog(pg, command, opts = {}) {
  const validated = validateCatalogCommand(command);
  if (!validated.ok) return validated;

  let adminCfg = opts.adminCfg || null;
  if (!adminCfg) {
    if (!pg) {
      return mapCatalogFailure({ reason: CATALOG_EXCLUSION_REASONS.ADMIN_DB_UNAVAILABLE }, command);
    }
    const { resolveTenantBusinessConfigAsync } = require('./tenant-business-config');
    adminCfg = await resolveTenantBusinessConfigAsync(SUNSET_CLIENT_SLUG, {
      locationId: command.locationId,
      pgClient: pg,
      skipDb: command.transportBody && command.transportBody.dry_run === true,
    });
  }
  if (!adminCfg || adminCfg.ok === false) {
    return mapCatalogFailure({ reason: CATALOG_EXCLUSION_REASONS.ADMIN_DB_UNAVAILABLE }, command);
  }
  if (command.requireDb && adminCfg.source !== 'db') {
    return mapCatalogFailure({ reason: CATALOG_EXCLUSION_REASONS.ADMIN_DB_UNAVAILABLE }, command);
  }

  const projection = await loadCatalogProjection(pg, command, adminCfg);
  if (!projection.ok) return mapCatalogFailure(projection, command);

  let joinable = null;
  if (command.includeCapacity && pg) {
    joinable = await enrichJoinableCourses(pg, command, projection.courses || []);
  }

  return {
    ok: true,
    status: 200,
    body: buildCatalogSuccessBody(command, projection, adminCfg, joinable),
  };
}

function executeSunsetCatalogSync(command, opts = {}) {
  const validated = validateCatalogCommand(command);
  if (!validated.ok) return validated;

  const adminCfg = opts.adminCfg;
  if (!adminCfg || adminCfg.ok === false) {
    return mapCatalogFailure({ reason: CATALOG_EXCLUSION_REASONS.ADMIN_DB_UNAVAILABLE }, command);
  }

  const projectionOpts = {
    locationId: command.locationId,
    requestedDates: command.requestedDates,
    requireDb: command.requireDb,
    asOfDate: command.asOfDate,
    bookableOnly: false,
    coursesOnly: command.coursesOnly,
    rentalOfferings: Array.isArray(adminCfg.rental_offerings) ? adminCfg.rental_offerings : [],
  };
  const projection = projectSunsetBookableOfferingsFromConfig(adminCfg, projectionOpts);
  if (!projection.ok) return mapCatalogFailure(projection, command);

  return {
    ok: true,
    status: 200,
    body: buildCatalogSuccessBody(command, projection, adminCfg, null),
  };
}

function catalogCommandFromQuoteCommand(quoteCommand) {
  const channel = quoteCommand.channel === 'manual_staff'
    ? CATALOG_CHANNELS.MANUAL_STAFF
    : (quoteCommand.channel === 'luna_email'
      ? CATALOG_CHANNELS.LUNA_EMAIL
      : CATALOG_CHANNELS.LUNA_WHATSAPP);
  return {
    channel,
    clientSlug: quoteCommand.clientSlug,
    locationId: quoteCommand.locationId,
    transportBody: quoteCommand.transportBody,
    requestedDates: extractRequestedDates(quoteCommand.transportBody),
    requireDb: resolveCatalogRequireDb(quoteCommand.transportBody),
    includeExcluded: false,
    includeCapacity: false,
    coursesOnly: false,
    asOfDate: quoteCommand.transportBody.as_of_date || quoteCommand.transportBody.date || null,
    now: quoteCommand.now,
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

module.exports = {
  CATALOG_CHANNELS,
  CATALOG_EXCLUSION_REASONS,
  nestCatalogOffering,
  extractRequestedDates,
  buildSunsetCatalogCommand,
  executeSunsetCatalog,
  executeSunsetCatalogSync,
  loadCatalogProjection,
  catalogCommandFromQuoteCommand,
  findCatalogOffering,
  annotateCatalogOfferings,
};
