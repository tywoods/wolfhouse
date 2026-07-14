'use strict';

/**
 * Read-only guest-safe Sunset offering projection from Admin-resolved config.
 * Price-row identity is preserved so configured courses cannot fall through to
 * the generic group-lesson (€30) resolver.
 */

const { normalizeSunsetLocationId, isSunsetLocationId } = require('./sunset-school-locations');
const { parseQuoteQuantity } = require('./sunset-group-lesson-quote');

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

function cents(price) {
  if (!price) return null;
  if (Number.isInteger(price.amount_cents)) return price.amount_cents;
  const amount = Number(price.amount);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function isoDate(value) {
  return value == null ? null : String(value).slice(0, 10);
}

function priceState(price, asOfDate) {
  if (!price || price.active === false) return 'inactive_offering';
  const asOf = isoDate(asOfDate) || new Date().toISOString().slice(0, 10);
  if (price.effective_from && isoDate(price.effective_from) > asOf) return 'future_price';
  if (price.effective_to && isoDate(price.effective_to) < asOf) return 'expired_price';
  return cents(price) == null ? 'price_missing' : null;
}

function exactPrice(prices, offeringKey, asOfDate) {
  const matches = (prices || []).filter((p) => String(p.offering_key || p.item_code || '') === offeringKey);
  if (!matches.length) return { ok: false, reason: 'price_missing' };
  // Never attach baseline unverified_seed amounts to Luna catalog offerings.
  const live = matches.filter((p) => {
    const status = String(p.pricing_status || p.effective_state || '').toLowerCase();
    if (status === 'unverified_seed' || status === 'owner_required') return false;
    if (p.seed_source && String(p.source || '').toLowerCase() === 'config') return false;
    return true;
  });
  const usable = live.filter((p) => !priceState(p, asOfDate));
  if (usable.length > 1) return { ok: false, reason: 'ambiguous_price' };
  if (usable.length === 1) return { ok: true, price: usable[0] };
  if (!live.length) return { ok: false, reason: 'unverified_seed' };
  return { ok: false, reason: priceState(matches[0], asOfDate) || 'price_missing' };
}

function weekdaysFromPack(weekly) {
  const w = String(weekly || '').trim();
  if (w === 'mon_fri') return [1, 2, 3, 4, 5];
  if (w === 'sat_sun') return [0, 6];
  if (w === 'daily') return [0, 1, 2, 3, 4, 5, 6];
  return [];
}

function nestOffering(raw) {
  const schedule = raw.schedule || {};
  return {
    offering_id: raw.offering_id,
    offering_type: raw.offering_type,
    label: raw.label,
    guest_description: raw.guest_description || raw.label,
    active: true,
    schedule: {
      start_time: schedule.start_time || null,
      end_time: schedule.end_time || null,
      weekdays: Array.isArray(schedule.weekdays) ? schedule.weekdays : [],
    },
    duration: raw.duration || null,
    capacity: raw.capacity != null ? Number(raw.capacity) : null,
    price: {
      price_id: raw.price_id,
      amount_cents: raw.unit_amount_cents,
      currency: raw.currency || 'EUR',
      unit: raw.billing_unit || 'session',
    },
    course_id: raw.course_id || null,
    included_items: Array.isArray(raw.included_items) ? raw.included_items : [],
    // Internal convenience fields Luna tools may pass through (same identity).
    unit_amount_cents: raw.unit_amount_cents,
    billing_unit: raw.billing_unit,
    price_id: raw.price_id,
    currency: raw.currency || 'EUR',
    schedules: raw.schedules || undefined,
    slot_id: raw.slot_id || undefined,
    slot_time: raw.slot_time || undefined,
    age_band: raw.age_band || undefined,
    tier: raw.tier || undefined,
    tier_key: raw.tier_key || (raw.tier && raw.tier.key) || undefined,
    offering_item_code: raw.offering_item_code || undefined,
    item_code: raw.item_code || undefined,
  };
}

function buildSunsetLunaCatalogFromConfig(adminCfg, { locationId, asOfDate, requireDb = false } = {}) {
  const location_id = normalizeSunsetLocationId(locationId);
  if (!isSunsetLocationId(locationId || location_id)) {
    return { ok: false, reason: 'wrong_location', offerings: [], location_id };
  }
  if (!adminCfg || adminCfg.ok === false) {
    return { ok: false, reason: 'admin_db_expected_unavailable', offerings: [], location_id };
  }
  if (requireDb && (adminCfg.source !== 'db' || adminCfg.db_read_warning)) {
    return { ok: false, reason: 'admin_db_expected_unavailable', offerings: [], location_id };
  }

  const prices = adminCfg.prices || [];
  const rawOfferings = [];

  for (const slot of adminCfg.lesson_times || []) {
    if (slot.active === false || !slot.slot_id) continue;
    const parsed = parseLessonSlotTime(slot.slot_time);
    if (!parsed) continue;
    const key = `lesson_slot_${slot.slot_id}__session`;
    const found = exactPrice(prices, key, asOfDate);
    if (!found.ok) continue;
    const amount = cents(found.price);
    rawOfferings.push({
      offering_type: String(slot.age_band || '').includes('6_to_11') ? 'kids_lesson' : 'group_lesson',
      offering_id: found.price.id || key,
      course_id: null,
      price_id: found.price.id || key,
      label: slot.offering_label || found.price.label || 'Group lesson',
      guest_description: slot.offering_label || found.price.label || 'Group lesson',
      unit_amount_cents: amount,
      currency: found.price.currency || 'EUR',
      billing_unit: found.price.unit || 'session',
      schedule: {
        start_time: parsed.start_time,
        end_time: parsed.end_time,
        weekdays: Array.isArray(slot.weekdays_active) ? slot.weekdays_active : [],
      },
      duration: null,
      capacity: slot.capacity != null ? Number(slot.capacity) : null,
      slot_id: slot.slot_id,
      slot_time: slot.slot_time,
      age_band: slot.age_band || 'all_ages',
      included_items: [],
    });
  }

  for (const pack of adminCfg.surf_packs || []) {
    if (pack.active === false || !pack.pack_id) continue;
    const schedules = (pack.schedules || []).map(parsePackSchedule).filter(Boolean);
    const weekdays = weekdaysFromPack(pack.weekly);
    for (const tier of pack.price_tiers || []) {
      if (!tier || !tier.key) continue;
      const key = `surf_pack_${pack.pack_id}__${tier.key}`;
      const found = exactPrice(prices, key, asOfDate);
      if (!found.ok) continue;
      const primary = schedules[0] || {};
      const amount = cents(found.price);
      rawOfferings.push({
        offering_type: 'course',
        offering_id: found.price.id || key,
        course_id: pack.pack_id,
        price_id: found.price.id || key,
        offering_item_code: key,
        label: `${pack.label || 'Surf course'} — ${tier.label || tier.key}`,
        guest_description: pack.label || 'Surf course',
        unit_amount_cents: amount,
        currency: found.price.currency || 'EUR',
        billing_unit: found.price.unit || (/single_class/.test(tier.key) ? 'session' : 'course'),
        schedule: {
          start_time: primary.start_time || null,
          end_time: primary.end_time || null,
          weekdays,
        },
        duration: tier.hours != null ? `${tier.hours}h` : (tier.key || null),
        capacity: pack.group_size != null ? Number(pack.group_size) : null,
        schedules,
        age_band: pack.age_band || 'all_ages',
        tier: { key: tier.key, label: tier.label || tier.key, hours: tier.hours },
        tier_key: tier.key,
        included_items: [],
      });
    }
  }

  for (const price of prices) {
    const state = priceState(price, asOfDate);
    if (state) continue;
    const category = String(price.category || price.item_type || '').toLowerCase();
    const key = String(price.offering_key || price.item_code || '');
    if (category === 'rental') {
      rawOfferings.push({
        offering_type: 'rental',
        offering_id: price.id || key,
        course_id: null,
        price_id: price.id || key,
        label: price.label || key,
        guest_description: price.label || key,
        unit_amount_cents: cents(price),
        currency: price.currency || 'EUR',
        billing_unit: price.unit || 'session',
        schedule: { start_time: null, end_time: null, weekdays: [] },
        duration: null,
        capacity: null,
        item_code: key,
        included_items: [],
      });
    }
    if (category === 'addon' || price.addon === true || /full.?day|rest.*day/i.test(key)) {
      rawOfferings.push({
        offering_type: 'addon',
        offering_id: price.id || key,
        course_id: null,
        price_id: price.id || key,
        label: price.label || key,
        guest_description: price.label || key,
        unit_amount_cents: cents(price),
        currency: price.currency || 'EUR',
        billing_unit: price.unit || 'person',
        schedule: { start_time: null, end_time: null, weekdays: [] },
        duration: null,
        capacity: null,
        item_code: key,
        included_items: [],
      });
    }
  }

  const privateLesson = adminCfg.private_lesson;
  if (privateLesson && privateLesson.enabled && cents(privateLesson) != null) {
    rawOfferings.push({
      offering_type: 'private_lesson',
      offering_id: privateLesson.rule_id || privateLesson.id || 'private_lesson',
      course_id: null,
      price_id: privateLesson.rule_id || privateLesson.id || 'private_lesson',
      label: privateLesson.label || privateLesson.name || 'Private lesson',
      guest_description: privateLesson.label || privateLesson.name || 'Private lesson',
      unit_amount_cents: cents(privateLesson),
      currency: privateLesson.currency || 'EUR',
      billing_unit: privateLesson.unit || privateLesson.billing_unit || 'session',
      schedule: { start_time: null, end_time: null, weekdays: [] },
      duration: privateLesson.default_duration_minutes
        ? `${privateLesson.default_duration_minutes}m`
        : null,
      capacity: null,
      included_items: [],
    });
  }

  return {
    ok: true,
    success: true,
    client_slug: 'sunset',
    location_id,
    source: adminCfg.source || 'config',
    currency: adminCfg.currency || 'EUR',
    offerings: rawOfferings.map(nestOffering),
  };
}

function findCatalogOffering(catalog, offeringId) {
  const id = String(offeringId || '').trim();
  if (!id) return [];
  return (catalog.offerings || []).filter((o) => o.offering_id === id || o.price_id === id);
}

function quoteSunsetOfferingFromCatalog(adminCfg, body = {}) {
  const locationId = body.location_id || body.location;
  const catalog = buildSunsetLunaCatalogFromConfig(adminCfg, {
    locationId,
    asOfDate: body.as_of_date || body.date,
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
      return { ok: false, success: false, reason: priceState(rawPrices[0], body.as_of_date) || 'unknown_offering' };
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

  const dates = Array.isArray(body.service_dates)
    ? [...new Set(body.service_dates.map(isoDate).filter(Boolean))]
    : [];
  const unit = String(offering.billing_unit || offering.price && offering.price.unit || '').toLowerCase();
  const sessionUnit = /session|single_lesson|person/.test(unit)
    && offering.offering_type !== 'course';
  const courseUnit = offering.offering_type === 'course'
    || /week|course|bundle|^\d+_day|^\d+_days|^\d+_week/.test(unit);

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
    price_id: offering.price_id,
    price_source: catalog.source === 'db' || catalog.source === 'merged' ? 'admin_db' : 'config_or_db',
    source: catalog.source,
    tier_key: (offering.tier && offering.tier.key) || offering.tier_key || null,
    offering_item_code: offering.offering_item_code || null,
  };
}

/**
 * Resolve a booking component's unit cents from Admin catalog by exact offering/course.
 * Returns null when the ordinary group-lesson fallback must not be used for a course.
 */
function resolveOfferingUnitCentsForBooking(adminCfg, meta = {}) {
  const offeringId = String(meta.offering_id || meta.price_id || '').trim();
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
};
