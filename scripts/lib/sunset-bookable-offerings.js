'use strict';

/**
 * Canonical Sunset bookable-offering read model.
 *
 * Admin, Schedule selectors, manual preflight, Luna catalog/availability/quote,
 * and booking create all consume this projection so visibility, schedule
 * eligibility, and Admin price identity stay aligned.
 */

const {
  loadSurfPacksFromDb,
  packPriceItemCode: packCodeFromRules,
} = require('./sunset-admin-pack-rules');
const {
  packPriceItemCode,
  billingUnitForSurfPackTier,
  courseTierIdentity,
  privateLessonIdentity,
  rentalIdentity,
  fullDayEquipmentIdentity,
} = require('./sunset-admin-price-identity');
const { resolveActiveSunsetAdminPrice } = require('./sunset-admin-price-resolve');
const {
  evaluateSunsetOfferingDates,
  weekdaysFromWeekly,
  scheduleSummary,
  isoDate,
} = require('./sunset-offering-schedule');
const {
  normalizeSunsetLocationId,
  isSunsetLocationId,
  DEFAULT_SUNSET_LOCATION_ID,
} = require('./sunset-school-locations');
const {
  durationDaysFromTierKey,
} = require('./sunset-admin-duration-keys');
const { projectEquipmentOptions } = require('./sunset-course-equipment-options');
const { listRentalOfferings } = require('./tenant-rental-offerings');
const { loadPrivateLessonFromDb } = require('./sunset-admin-private-lesson-rules');
const {
  buildRentalCatalogLabelMap,
  lookupCatalogLabel,
  isIdentityLikeRentalLabel,
  resolveRentalOfferingFriendlyLabel,
  activeRentalOfferingKeySet,
  isDocumentedActiveFlag,
} = require('./rental-offering-label');

const SUNSET_CLIENT_SLUG = 'sunset';

function parsePackScheduleKey(value) {
  const m = /^([01]\d|2[0-3])([0-5]\d)_([01]\d|2[0-3])([0-5]\d)$/.exec(String(value || '').trim());
  if (!m) return null;
  return {
    key: String(value).trim(),
    start_time: `${m[1]}:${m[2]}`,
    end_time: `${m[3]}:${m[4]}`,
  };
}

function centsFromPrice(price) {
  if (!price) return null;
  if (Number.isInteger(price.amount_cents)) return price.amount_cents;
  const amount = Number(price.amount);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

/**
 * Period window for a rental Admin price row.
 *
 * Real shapes (do not invent aliases):
 *   - DB-mapped: offering_key/item_code = board_and_suit_rental__4_days, unit = billing grain (day)
 *   - Config/Admin UI: offering_key = board_and_suit_rental, unit = period window (4_days)
 *
 * Preserve offering_key + unit relationship; never default bare keys to 1_day.
 */
function rentalPeriodFromAdminPriceRow(key, price) {
  const k = String(key || '').trim();
  if (!k) return null;
  if (k.includes('__')) {
    return k.split('__').slice(1).join('__') || null;
  }
  const unit = String((price && price.unit) || '').trim();
  return unit || null;
}

function findConfigPrice(prices, itemCode, asOfDate, preferredUnit) {
  const matches = (prices || []).filter((p) => {
    const key = String(p.offering_key || p.item_code || '');
    return key === itemCode && p.active !== false;
  });
  if (!matches.length) return { ok: false, reason: 'price_missing' };
  const asOf = isoDate(asOfDate) || new Date().toISOString().slice(0, 10);
  const inWindow = matches.filter((p) => {
    if (p.effective_from && isoDate(p.effective_from) > asOf) return false;
    if (p.effective_to && isoDate(p.effective_to) < asOf) return false;
    const status = String(p.pricing_status || p.effective_state || '').toLowerCase();
    if (status === 'unverified_seed' || status === 'owner_required') return false;
    if (p.seed_source && String(p.source || '').toLowerCase() === 'config') return false;
    return centsFromPrice(p) != null && centsFromPrice(p) > 0;
  });
  if (!inWindow.length) return { ok: false, reason: 'price_missing' };
  if (preferredUnit) {
    const exactUnit = inWindow.filter((p) => String(p.unit || '') === preferredUnit);
    if (exactUnit.length === 1) return { ok: true, price: exactUnit[0], unit_canonical: true };
    if (exactUnit.length > 1) return { ok: false, reason: 'ambiguous_price' };
  }
  if (inWindow.length === 1) {
    return {
      ok: true,
      price: inWindow[0],
      unit_canonical: !preferredUnit || String(inWindow[0].unit || '') === preferredUnit,
    };
  }
  return { ok: false, reason: 'ambiguous_price' };
}

function nestCourseSchedule(pack) {
  const weekly = String((pack && pack.weekly) || '').trim() || 'mon_fri';
  const allowed = weekdaysFromWeekly(weekly);
  const timeSlots = (pack.schedules || []).map(parsePackScheduleKey).filter(Boolean);
  return {
    weekly,
    allowed_weekdays: allowed,
    weekdays: allowed,
    specific_dates: Array.isArray(pack.specific_dates) ? pack.specific_dates.map(isoDate).filter(Boolean) : [],
    excluded_dates: Array.isArray(pack.excluded_dates) ? pack.excluded_dates.map(isoDate).filter(Boolean) : [],
    starts_on: isoDate(pack.starts_on) || null,
    ends_on: isoDate(pack.ends_on) || null,
    time_slots: timeSlots,
  };
}

function projectCourseTierFromPack(pack, prices, opts = {}) {
  const locationId = normalizeSunsetLocationId(opts.locationId || DEFAULT_SUNSET_LOCATION_ID);
  const asOf = opts.asOf || null;
  const requestedDates = opts.requestedDates || null;
  const out = [];
  if (!pack || pack.active === false || !pack.pack_id) return out;
  const schedule = nestCourseSchedule(pack);
  const scheduleEval = requestedDates && requestedDates.length
    ? evaluateSunsetOfferingDates({ schedule }, requestedDates, { timezone: opts.timezone })
    : null;

  for (const tier of pack.price_tiers || []) {
    if (!tier || !tier.key) continue;
    const tierKey = String(tier.key).trim();
    const identity = courseTierIdentity(pack.pack_id, tierKey, locationId);
    if (!identity) continue;
    const itemCode = identity.item_code || packPriceItemCode(pack.pack_id, tierKey);
    const preferredUnit = identity.billing_unit || billingUnitForSurfPackTier(tierKey);
    const found = findConfigPrice(prices, itemCode, asOf, preferredUnit);
    // Commercial truth is Admin price rows only. Never invent from tier JSON
    // amounts even when requireDb is off (preview still surfaces missing price).
    const amount = found.ok ? centsFromPrice(found.price) : null;
    const hasOwnerAmount = Number.isFinite(amount) && amount > 0;
    const resolvable = !!(found.ok && hasOwnerAmount);
    const bookable = resolvable && (!scheduleEval || scheduleEval.ok);
    const primary = (schedule.time_slots && schedule.time_slots[0]) || {};

    out.push({
      offering_id: itemCode,
      offering_type: 'course',
      course_id: String(pack.pack_id),
      service_id: null,
      pack_id: String(pack.pack_id),
      tier_key: tierKey,
      label: `${pack.label || 'Surf course'} — ${tier.label || tierKey}`,
      course_label: pack.label || 'Surf course',
      location_id: locationId,
      active: true,
      bookable,
      eligible_on_requested_dates: scheduleEval ? scheduleEval.ok : null,
      schedule_rejection: scheduleEval && !scheduleEval.ok
        ? (scheduleEval.staff_error || { error: scheduleEval.reason, reason_code: scheduleEval.reason })
        : null,
      schedule: {
        ...schedule,
        start_time: primary.start_time || null,
        end_time: primary.end_time || null,
        summary: scheduleSummary(schedule),
      },
      price_identity: {
        price_id: found.ok ? (found.price.id || null) : null,
        item_type: 'package',
        item_code: itemCode,
        unit: preferredUnit,
      },
      billing_mode: identity.billing_mode,
      billing_unit: preferredUnit,
      unit_amount_cents: hasOwnerAmount ? amount : null,
      currency: (found.ok && found.price.currency) || 'EUR',
      price_source: found.ok ? 'admin_db' : null,
      price_resolve_reason: found.ok ? null : (found.reason || 'price_missing'),
      unit_canonical: found.ok ? found.unit_canonical !== false : false,
      capacity: pack.group_size != null ? Number(pack.group_size) : null,
      equipment_options: projectEquipmentOptions(pack.equipment_options, opts.rentalOfferings, {
        clientSlug: opts.clientSlug || SUNSET_CLIENT_SLUG,
        locationId,
      }),
      age_band: pack.age_band || null,
      beaches: pack.beaches || [],
      tier: { key: tierKey, label: tier.label || tierKey, hours: tier.hours },
      offering_item_code: itemCode,
      item_code: itemCode,
      guest_description: pack.label || 'Surf course',
    });
  }
  return out;
}

/**
 * Sync projection from already-resolved Admin config (no live DB price resolve).
 * Schedule UI + Luna catalog use this so they share identity/schedule rules.
 */
function projectSunsetBookableOfferingsFromConfig(adminCfg, opts = {}) {
  const locationId = normalizeSunsetLocationId(opts.locationId || DEFAULT_SUNSET_LOCATION_ID);
  if (!isSunsetLocationId(locationId)) {
    return { ok: false, reason: 'unknown_location', offerings: [], location_id: locationId };
  }
  if (!adminCfg || adminCfg.ok === false) {
    return { ok: false, reason: 'admin_db_expected_unavailable', offerings: [], location_id: locationId };
  }
  if (opts.requireDb && (adminCfg.source !== 'db' || adminCfg.db_read_warning)) {
    return { ok: false, reason: 'admin_db_expected_unavailable', offerings: [], location_id: locationId };
  }

  const prices = adminCfg.prices || [];
  const rentalOfferingsRaw = (opts && Object.prototype.hasOwnProperty.call(opts, 'rentalOfferings'))
    ? opts.rentalOfferings
    : (adminCfg && adminCfg.rental_offerings);
  const rentalOfferings = Array.isArray(rentalOfferingsRaw) ? rentalOfferingsRaw : [];
  // P0e: exact offering_key → Admin tenant_rental_offerings.label (active catalog).
  // Prefer exact location over client-wide; reject foreign tenant/location.
  const rentalCatalogLabelByKey = buildRentalCatalogLabelMap(rentalOfferings, {
    clientSlug: SUNSET_CLIENT_SLUG,
    locationId,
    includeInactive: false,
  });
  // Live Admin catalog is the offer allowlist. Null = price-only bootstrap
  // (no identity rows yet). Empty array / empty Set = catalog present, nothing live.
  const liveRentalKeys = activeRentalOfferingKeySet(rentalOfferingsRaw, {
    clientSlug: SUNSET_CLIENT_SLUG,
    locationId,
  });
  const asOf = opts.asOf || opts.asOfDate || null;
  const requestedDates = opts.requestedDates || (
    opts.date ? [String(opts.date).slice(0, 10)] : null
  );
  const offerings = [];

  for (const pack of adminCfg.surf_packs || []) {
    offerings.push(...projectCourseTierFromPack(pack, prices, {
      locationId,
      asOf,
      requestedDates,
      timezone: opts.timezone,
      requireDb: opts.requireDb,
      clientSlug: SUNSET_CLIENT_SLUG,
      rentalOfferings,
    }));
  }

  const privateLesson = adminCfg.private_lesson;
  if (privateLesson && privateLesson.enabled !== false && centsFromPrice(privateLesson) != null) {
    const identity = privateLessonIdentity(locationId);
    offerings.push({
      offering_id: identity.offering_id,
      offering_type: 'private_lesson',
      course_id: null,
      service_id: null,
      tier_key: null,
      label: privateLesson.label || privateLesson.name || 'Private lesson',
      location_id: locationId,
      active: true,
      bookable: true,
      eligible_on_requested_dates: requestedDates ? true : null,
      schedule: {
        weekly: 'daily',
        allowed_weekdays: weekdaysFromWeekly('daily'),
        weekdays: weekdaysFromWeekly('daily'),
        specific_dates: [],
        excluded_dates: [],
        starts_on: null,
        ends_on: null,
        time_slots: [],
        summary: 'Daily',
      },
      price_identity: {
        price_id: privateLesson.rule_id || privateLesson.id || null,
        item_type: identity.item_type,
        item_code: identity.item_code,
        unit: identity.billing_unit,
      },
      billing_mode: identity.billing_mode,
      billing_unit: identity.billing_unit,
      unit_amount_cents: centsFromPrice(privateLesson),
      currency: privateLesson.currency || 'EUR',
      price_source: 'admin_db',
      unit_canonical: true,
      capacity: null,
      equipment_options: projectEquipmentOptions(privateLesson.equipment_options, rentalOfferings, {
        clientSlug: SUNSET_CLIENT_SLUG,
        locationId,
      }),
      offering_item_code: identity.item_code,
      item_code: identity.item_code,
      guest_description: privateLesson.label || privateLesson.name || 'Private lesson',
    });
  }

  for (const price of prices) {
    const category = String(price.category || price.item_type || '').toLowerCase();
    const key = String(price.offering_key || price.item_code || '');
    if (price.active === false) continue;
    const amount = centsFromPrice(price);
    if (amount == null || amount <= 0) continue;
    const asOfDate = isoDate(asOf) || new Date().toISOString().slice(0, 10);
    if (price.effective_from && isoDate(price.effective_from) > asOfDate) continue;
    if (price.effective_to && isoDate(price.effective_to) < asOfDate) continue;

    if (category === 'rental' || /rental|full_day_equipment/i.test(key)) {
      const priceLoc = price.location_id != null && String(price.location_id).trim()
        ? String(price.location_id).trim()
        : '';
      if (priceLoc && priceLoc !== locationId) continue;
      let identity = null;
      let baseKey = null;
      if (/full_day_equipment/i.test(key)) {
        identity = fullDayEquipmentIdentity(locationId);
        baseKey = 'full_day_equipment';
      } else {
        // Data-driven: any rental price row with a resolvable period joins via
        // rentalIdentity — no hardcoded board/wetsuit/both allowlist.
        const duration = rentalPeriodFromAdminPriceRow(key, price);
        if (!duration) continue;
        baseKey = key.includes('__') ? key.split('__')[0] : key;
        identity = rentalIdentity(baseKey, duration, locationId);
      }
      if (!identity) continue;
      // SAME-DESK-001: when Admin rental identities exist, never offer leftover
      // disabled keys, foreign-tenant rows, or public-site bundles not in catalog.
      if (liveRentalKeys && baseKey !== 'full_day_equipment' && !liveRentalKeys.has(baseKey)) {
        continue;
      }
      // P0e: tenant_rental_offerings.label wins over price.label/display_name/key
      // for both catalog `label` and `guest_description`. Exact baseKey only.
      const catalogLabel = baseKey
        ? lookupCatalogLabel(rentalCatalogLabelByKey, baseKey)
        : '';
      const priceLabelRaw = String(price.label || price.display_name || '').trim();
      const priceLabel = priceLabelRaw
        && !isIdentityLikeRentalLabel(priceLabelRaw, baseKey, identity.item_code || key)
        ? priceLabelRaw
        : '';
      const displayLabel = catalogLabel
        || priceLabel
        || resolveRentalOfferingFriendlyLabel({
          offering_key: baseKey || key,
          catalog_label: catalogLabel || null,
          label: priceLabelRaw || null,
          item_code: identity.item_code || key,
        })
        || baseKey
        || key;
      offerings.push({
        offering_id: identity.offering_id || key,
        offering_type: /full_day_equipment/i.test(key) ? 'addon' : 'rental',
        course_id: null,
        service_id: null,
        tier_key: identity.duration_key || null,
        offering_key: baseKey || null,
        label: displayLabel,
        location_id: locationId,
        active: true,
        bookable: true,
        eligible_on_requested_dates: requestedDates ? true : null,
        schedule: {
          weekly: 'daily',
          allowed_weekdays: weekdaysFromWeekly('daily'),
          weekdays: weekdaysFromWeekly('daily'),
          specific_dates: [],
          excluded_dates: [],
          starts_on: null,
          ends_on: null,
          time_slots: [],
          summary: null,
        },
        price_identity: {
          price_id: price.id || null,
          item_type: identity.item_type || 'rental',
          item_code: identity.item_code || key,
          unit: identity.billing_unit || price.unit || 'day',
        },
        billing_mode: identity.billing_mode || 'unit_x_qty',
        billing_unit: identity.billing_unit || price.unit || 'day',
        unit_amount_cents: amount,
        currency: price.currency || 'EUR',
        price_source: 'admin_db',
        unit_canonical: true,
        capacity: null,
        offering_item_code: identity.item_code || key,
        item_code: identity.item_code || key,
        guest_description: displayLabel,
      });
    }
  }

  let filtered = offerings;
  if (opts.bookableOnly) {
    filtered = offerings.filter((o) => o.bookable === true);
  }
  if (opts.coursesOnly) {
    filtered = filtered.filter((o) => o.offering_type === 'course');
  }

  // Collapse course tiers into unique courses for Schedule selectors.
  const coursesById = new Map();
  for (const o of offerings.filter((x) => x.offering_type === 'course')) {
    if (!coursesById.has(o.course_id)) {
      coursesById.set(o.course_id, {
        course_id: o.course_id,
        pack_id: o.course_id,
        label: o.course_label || o.guest_description || o.label,
        capacity: o.capacity,
        equipment_options: Array.isArray(o.equipment_options) ? o.equipment_options.map((x) => ({ ...x })) : [],
        weekly: o.schedule && o.schedule.weekly,
        weekdays: (o.schedule && o.schedule.allowed_weekdays) || [],
        schedule_summary: (o.schedule && o.schedule.summary) || null,
        slot_time: o.schedule && o.schedule.time_slots && o.schedule.time_slots[0]
          ? `${String(o.schedule.time_slots[0].start_time || '').replace(':', '')}_${String(o.schedule.time_slots[0].end_time || '').replace(':', '')}`
          : '',
        schedules: (o.schedule && o.schedule.time_slots) || [],
        price_tiers: [],
        bookable: false,
        eligible_on_requested_dates: o.eligible_on_requested_dates,
        schedule_rejection: o.schedule_rejection,
      });
    }
    const course = coursesById.get(o.course_id);
    course.price_tiers.push({
      key: o.tier_key,
      label: (o.tier && o.tier.label) || o.tier_key,
      offering_id: o.offering_id,
      offering_item_code: o.offering_item_code,
      unit_amount_cents: o.unit_amount_cents,
      bookable: o.bookable,
      duration_days: durationDaysFromTierKey(o.tier_key),
    });
    if (o.bookable) course.bookable = true;
    if (o.eligible_on_requested_dates === false) {
      course.eligible_on_requested_dates = false;
      course.schedule_rejection = o.schedule_rejection;
    }
  }

  return {
    ok: true,
    success: true,
    client_slug: SUNSET_CLIENT_SLUG,
    location_id: locationId,
    source: adminCfg.source || 'config',
    currency: adminCfg.currency || 'EUR',
    requested_dates: requestedDates,
    offerings: filtered,
    courses: [...coursesById.values()].sort((a, b) => String(a.label).localeCompare(String(b.label))),
  };
}

/**
 * Authoritative DB-backed loader. Resolves each course tier via Admin price rules.
 */
async function loadSunsetBookableOfferings(pg, opts = {}) {
  const clientSlug = String(opts.clientSlug || opts.client_slug || SUNSET_CLIENT_SLUG).trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, reason: 'tenant_mismatch', offerings: [], courses: [] };
  }
  const locationId = normalizeSunsetLocationId(opts.locationId || opts.location_id || DEFAULT_SUNSET_LOCATION_ID);
  if (!isSunsetLocationId(locationId)) {
    return { ok: false, reason: 'unknown_location', offerings: [], courses: [] };
  }

  const packs = await loadSurfPacksFromDb(pg, clientSlug, locationId);
  // Active scoped rentals: exact location + client-wide (null location). Reject
  // foreign tenant/location. Prefer exact location inside catalog label map.
  // Query failure fail-closes to an empty identity list (never price-only fallback).
  let rentalOfferings = [];
  try {
    rentalOfferings = (await listRentalOfferings(pg, {
      clientSlug,
      locationId,
      includeInactive: false,
    })).filter((row) => {
      if (!row || !isDocumentedActiveFlag(row.active)) return false;
      if (String(row.client_slug || '').trim() !== clientSlug) return false;
      const loc = row.location_id != null && String(row.location_id).trim()
        ? String(row.location_id).trim()
        : '';
      if (loc && loc !== locationId) return false;
      return true;
    });
  } catch (_) {
    rentalOfferings = [];
  }
  const privateLessonResult = await loadPrivateLessonFromDb(pg, clientSlug, locationId);
  const privateLesson = privateLessonResult && privateLessonResult.api
    ? privateLessonResult.api
    : null;
  const requestedDates = opts.requestedDates || (opts.date ? [String(opts.date).slice(0, 10)] : null);
  const asOf = opts.asOf || opts.asOfDate || null;
  const offerings = [];

  for (const pack of packs || []) {
    const schedule = nestCourseSchedule(pack);
    const scheduleEval = requestedDates && requestedDates.length
      ? evaluateSunsetOfferingDates({ schedule }, requestedDates, { timezone: opts.timezone })
      : null;

    for (const tier of pack.price_tiers || []) {
      if (!tier || !tier.key) continue;
      const tierKey = String(tier.key).trim();
      const identity = courseTierIdentity(pack.pack_id, tierKey, locationId);
      if (!identity) continue;
      const resolved = await resolveActiveSunsetAdminPrice(pg, {
        clientSlug,
        locationId,
        quantity: 1,
        metadata: {
          component: 'course',
          course_id: pack.pack_id,
          tier_key: tierKey,
          offering_id: identity.offering_id,
          location_id: locationId,
        },
      });
      const amount = resolved.ok ? resolved.unit_amount_cents : null;
      const bookable = !!(resolved.ok && amount > 0 && (!scheduleEval || scheduleEval.ok));
      const primary = (schedule.time_slots && schedule.time_slots[0]) || {};
      offerings.push({
        offering_id: identity.offering_id,
        offering_type: 'course',
        course_id: String(pack.pack_id),
        service_id: null,
        pack_id: String(pack.pack_id),
        tier_key: tierKey,
        label: `${pack.label || 'Surf course'} — ${tier.label || tierKey}`,
        course_label: pack.label || 'Surf course',
        location_id: locationId,
        active: true,
        bookable,
        eligible_on_requested_dates: scheduleEval ? scheduleEval.ok : null,
        schedule_rejection: scheduleEval && !scheduleEval.ok
          ? (scheduleEval.staff_error || { error: scheduleEval.reason, reason_code: scheduleEval.reason })
          : null,
        price_resolve_reason: resolved.ok ? null : (resolved.reason || 'price_not_configured'),
        schedule: {
          ...schedule,
          start_time: primary.start_time || null,
          end_time: primary.end_time || null,
          summary: scheduleSummary(schedule),
        },
        price_identity: {
          price_id: resolved.ok ? resolved.price_id : null,
          item_type: identity.item_type,
          item_code: identity.item_code,
          unit: identity.billing_unit,
        },
        billing_mode: identity.billing_mode,
        billing_unit: identity.billing_unit,
        unit_amount_cents: amount,
        currency: (resolved.ok && resolved.currency) || 'EUR',
        price_source: resolved.ok ? 'admin_db' : null,
        unit_canonical: true,
        capacity: pack.group_size != null ? Number(pack.group_size) : null,
        equipment_options: projectEquipmentOptions(pack.equipment_options, rentalOfferings, {
          clientSlug,
          locationId,
        }),
        age_band: pack.age_band || null,
        beaches: pack.beaches || [],
        tier: { key: tierKey, label: tier.label || tierKey, hours: tier.hours },
        offering_item_code: identity.item_code,
        item_code: identity.item_code,
        guest_description: pack.label || 'Surf course',
      });
    }
  }

  let filtered = offerings;
  if (opts.bookableOnly) filtered = offerings.filter((o) => o.bookable);
  if (opts.coursesOnly) filtered = filtered.filter((o) => o.offering_type === 'course');

  const projected = projectSunsetBookableOfferingsFromConfig({
    ok: true,
    source: 'db',
    currency: 'EUR',
    surf_packs: packs,
    prices: offerings.filter((o) => o.unit_amount_cents > 0).map((o) => ({
      id: o.price_identity.price_id,
      category: 'package',
      offering_key: o.item_code,
      item_code: o.item_code,
      amount_cents: o.unit_amount_cents,
      unit: o.billing_unit,
      active: true,
      currency: o.currency,
    })),
    private_lesson: privateLesson,
    rental_offerings: rentalOfferings,
  }, {
    locationId,
    asOf,
    requestedDates,
    timezone: opts.timezone,
  });

  return {
    ok: true,
    success: true,
    client_slug: clientSlug,
    location_id: locationId,
    source: 'admin_db',
    requested_dates: requestedDates,
    offerings: filtered.concat(opts.coursesOnly
      ? []
      : projected.offerings.filter((o) => o.offering_type === 'private_lesson')),
    courses: projected.courses,
  };
}

/** Schedule create-menu shape from packs (sync). Never invents phantom price-row courses. */
function scheduleCoursesFromBookableProjection(projection) {
  if (!projection || !projection.ok) return [];
  return (projection.courses || []).filter((c) => {
    const tiers = (c.price_tiers || []).filter((t) => t.key);
    return tiers.length > 0;
  }).map((c) => ({
    course_id: c.course_id,
    label: c.label,
    slot_time: c.slot_time || '',
    capacity: c.capacity,
    equipment_options: Array.isArray(c.equipment_options) ? c.equipment_options.map((x) => ({ ...x })) : [],
    price_tiers: (c.price_tiers || []).map((t) => {
      const key = t.key;
      const durationDays = t.duration_days != null
        ? Number(t.duration_days)
        : durationDaysFromTierKey(key);
      return {
        key,
        label: t.label || t.key,
        offering_id: t.offering_id,
        offering_item_code: t.offering_item_code,
        unit_amount_cents: t.unit_amount_cents,
        bookable: t.bookable !== false,
        duration_days: Number.isFinite(durationDays) && durationDays >= 1 ? durationDays : null,
      };
    }),
    weekly: c.weekly,
    weekdays: c.weekdays || [],
    schedule_summary: c.schedule_summary,
    bookable: c.bookable !== false,
    eligible_on_requested_dates: c.eligible_on_requested_dates,
    schedule_rejection: c.schedule_rejection || null,
  }));
}

module.exports = {
  SUNSET_CLIENT_SLUG,
  packPriceItemCode: packCodeFromRules || packPriceItemCode,
  durationDaysFromTierKey,
  nestCourseSchedule,
  projectCourseTierFromPack,
  projectSunsetBookableOfferingsFromConfig,
  loadSunsetBookableOfferings,
  scheduleCoursesFromBookableProjection,
  evaluateSunsetOfferingDates,
};
