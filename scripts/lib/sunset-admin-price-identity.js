'use strict';

/**
 * Canonical Sunset Admin price identity.
 *
 * Every bookable Admin offering maps to exactly one active tenant_price_rules
 * row scoped by:
 *   client_slug + location_id + item_type + item_code + unit
 *
 * Offering-specific duration/tier lives in item_code where the existing Admin
 * write path already puts it (surf_pack_<id>__<tier>, board_rental__1_day, …).
 * tenant_price_rules.unit is billing grain only: person | day | session | item.
 */

const {
  normalizeSunsetLocationId,
  isSunsetLocationId,
  DEFAULT_SUNSET_LOCATION_ID,
} = require('./sunset-school-locations');

const EXPECTED_TENANT = 'sunset';

const PACK_TIER_BILLING_UNIT = {
  single_class: 'session',
};

function packPriceItemCode(packId, tierKey) {
  return `surf_pack_${String(packId).trim()}__${String(tierKey).trim()}`;
}

function billingUnitForSurfPackTier(tierKey) {
  const key = String(tierKey || '').trim();
  return PACK_TIER_BILLING_UNIT[key] || 'day';
}

function billingUnitForSurfPackItemCode(itemCode) {
  const tier = String(itemCode || '').split('__').pop();
  return billingUnitForSurfPackTier(tier);
}

function privateLessonIdentity(locationId) {
  return {
    offering_id: 'private_lesson__session',
    item_type: 'lesson',
    item_code: 'private_lesson__session',
    billing_unit: 'session',
    location_id: normalizeSunsetLocationId(locationId || DEFAULT_SUNSET_LOCATION_ID),
    billing_mode: 'unit_x_qty',
  };
}

function courseTierIdentity(courseId, tierKey, locationId) {
  const id = String(courseId || '').trim();
  const tier = String(tierKey || '').trim();
  if (!id || !tier) return null;
  const itemCode = packPriceItemCode(id, tier);
  const billingUnit = billingUnitForSurfPackTier(tier);
  return {
    offering_id: itemCode,
    item_type: 'package',
    item_code: itemCode,
    billing_unit: billingUnit,
    location_id: normalizeSunsetLocationId(locationId || DEFAULT_SUNSET_LOCATION_ID),
    course_id: id,
    tier_key: tier,
    // Week/day package tiers are whole-course prices stored with unit=day
    // (schema cannot store unit=week). Charge once per surfer, not × dates.
    billing_mode: tier === 'single_class' ? 'unit_x_qty' : 'whole_offering_x_qty',
  };
}

function lessonSlotIdentity(slotId, locationId) {
  const id = String(slotId || '').trim();
  if (!id) return null;
  const itemCode = /^lesson_slot_.+__session$/i.test(id) ? id : `lesson_slot_${id}__session`;
  return {
    offering_id: itemCode,
    item_type: 'lesson',
    item_code: itemCode,
    billing_unit: 'session',
    location_id: normalizeSunsetLocationId(locationId || DEFAULT_SUNSET_LOCATION_ID),
    billing_mode: 'unit_x_qty',
  };
}

/** Billing grain on tenant_price_rules.unit — never a guest duration window. */
const BILLING_UNIT_GRAINS = new Set(['person', 'day', 'session', 'item']);

/**
 * Resolve rental duration for Admin identity.
 *
 * Priority:
 *   1. explicit duration_key / tier_key / duration
 *   2. compound offering suffix (board_and_suit_rental__6_days → 6_days)
 *   3. meta.unit only when it is a duration window (not billing grain)
 *   4. bare keys without any claim → null (fail closed; never invent 1_day for
 *      multi-day compound identities)
 *
 * Exact compound suffix and explicit duration must agree (enforced in rentalIdentity).
 */
function rentalDurationFromMeta(meta, offeringRaw) {
  const m = meta || {};
  const explicit = String(
    m.duration_key || m.tier_key || m.duration || '',
  ).trim();
  const raw = String(offeringRaw || '').trim();
  const compoundIndex = raw.lastIndexOf('__');
  const compoundDuration = compoundIndex > 0 ? raw.slice(compoundIndex + 2) : '';

  if (explicit) return explicit;
  if (compoundDuration) return compoundDuration;

  const unit = String(m.unit || '').trim();
  if (unit && !BILLING_UNIT_GRAINS.has(unit)) return unit;
  return null;
}

function rentalIdentity(offeringKey, durationKey, locationId) {
  const offering = String(offeringKey || '').trim();
  const duration = String(durationKey || '').trim();
  if (!offering || !duration) return null;
  const compoundIndex = offering.lastIndexOf('__');
  const compoundDuration = compoundIndex > 0 ? offering.slice(compoundIndex + 2) : '';
  // A compound catalog identity and explicit duration are independent claims.
  // Never silently price one when they disagree.
  if (compoundDuration && compoundDuration !== duration) return null;
  const itemCode = compoundDuration ? offering : `${offering}__${duration}`;
  const offeringBase = compoundDuration ? offering.slice(0, compoundIndex) : offering;
  // Rental duration key maps to DB billing grain (same as sunset-rental-price-lookup).
  let billingUnit = 'day';
  if (duration === '1_hour' || duration === 'session') billingUnit = 'session';
  else if (duration === 'half_day' || duration === '1_day' || /_days$/.test(duration)) billingUnit = 'day';
  return {
    offering_id: itemCode,
    item_type: 'rental',
    item_code: itemCode,
    billing_unit: billingUnit,
    location_id: normalizeSunsetLocationId(locationId || DEFAULT_SUNSET_LOCATION_ID),
    duration_key: duration,
    billing_mode: offeringBase === 'board_and_suit_rental' ? 'whole_offering_x_qty' : 'unit_x_qty',
  };
}

function fullDayEquipmentIdentity(locationId) {
  return rentalIdentity('full_day_equipment_extension', 'day', locationId);
}

/**
 * Resolve canonical identity from booking/service metadata or catalog refs.
 * Never trusts browser amounts.
 */
function resolveSunsetPriceIdentity(input) {
  const opts = input || {};
  const locationId = opts.location_id != null
    ? opts.location_id
    : (opts.locationId != null ? opts.locationId : DEFAULT_SUNSET_LOCATION_ID);
  if (!isSunsetLocationId(locationId) && opts.location_id !== undefined) {
    return null;
  }

  // Explicit compound already known.
  if (opts.item_type && opts.item_code && opts.billing_unit) {
    return {
      offering_id: opts.offering_id || opts.item_code,
      item_type: String(opts.item_type).trim(),
      item_code: String(opts.item_code).trim(),
      billing_unit: String(opts.billing_unit).trim(),
      location_id: normalizeSunsetLocationId(locationId),
      price_id: opts.price_id || opts.priceId || null,
      billing_mode: opts.billing_mode || 'unit_x_qty',
    };
  }

  const meta = opts.metadata || opts;
  const component = String(meta.component || meta.staff_ui_service_type || opts.component || '').toLowerCase();
  const offeringRaw = String(
    opts.offering_id || meta.offering_id || meta.offering_item_code || meta.item_code || '',
  ).trim();

  if (component === 'private_lesson' || offeringRaw === 'private_lesson__session') {
    return privateLessonIdentity(locationId);
  }

  if (component === 'course' || meta.course_id || /^surf_pack_/i.test(offeringRaw)) {
    let courseId = meta.course_id != null ? String(meta.course_id).trim() : '';
    let tierKey = (meta.tier && meta.tier.key) || meta.tier_key || meta.duration_key || '';
    if ((!courseId || !tierKey) && /^surf_pack_.+__.+$/i.test(offeringRaw)) {
      const body = offeringRaw.replace(/^surf_pack_/i, '');
      const idx = body.lastIndexOf('__');
      if (idx > 0) {
        courseId = courseId || body.slice(0, idx);
        tierKey = tierKey || body.slice(idx + 2);
      }
    }
    return courseTierIdentity(courseId, tierKey, locationId);
  }

  if (/^lesson_slot_/i.test(offeringRaw) || component === 'lesson' || component === 'group_lesson') {
    if (/^lesson_slot_/i.test(offeringRaw)) {
      return lessonSlotIdentity(offeringRaw, locationId);
    }
    const slotId = meta.slot_id || meta.lesson_slot_id || meta.offering_id;
    if (slotId) return lessonSlotIdentity(slotId, locationId);
  }

  if (component === 'full_day_equipment_extension'
    || offeringRaw === 'full_day_equipment_extension'
    || offeringRaw === 'full_day_equipment_extension__day') {
    return fullDayEquipmentIdentity(locationId);
  }

  if (component === 'surfboard' || component === 'board_rental' || offeringRaw.startsWith('board_rental')) {
    const duration = rentalDurationFromMeta(meta, offeringRaw || 'board_rental');
    return rentalIdentity(offeringRaw || 'board_rental', duration, locationId);
  }
  if (component === 'wetsuit' || component === 'wetsuit_rental' || offeringRaw.startsWith('wetsuit_rental')) {
    const duration = rentalDurationFromMeta(meta, offeringRaw || 'wetsuit_rental');
    return rentalIdentity(offeringRaw || 'wetsuit_rental', duration, locationId);
  }
  if (component === 'board_and_suit_rental' || offeringRaw.startsWith('board_and_suit_rental')) {
    const duration = rentalDurationFromMeta(meta, offeringRaw || 'board_and_suit_rental');
    return rentalIdentity(offeringRaw || 'board_and_suit_rental', duration, locationId);
  }
  // Staff Create async path sets component/offering_type to generic "rental".
  // Preserve compound offering_id / item_code duration — never silent 1_day.
  if (component === 'rental' || component === 'surf_rental') {
    const raw = offeringRaw
      || String(meta.offering_item_code || meta.item_code || '').trim();
    if (raw.startsWith('board_rental') || raw.startsWith('wetsuit_rental')
      || raw.startsWith('board_and_suit_rental')) {
      const duration = rentalDurationFromMeta(meta, raw);
      return rentalIdentity(raw, duration, locationId);
    }
  }

  // Generic future Admin offering: require full item_code ending with __unit grain
  // encoded in offering_id / item_code plus billing_unit or inferrable trailing unit.
  if (offeringRaw.includes('__')) {
    const unitGuess = offeringRaw.split('__').pop();
    const itemType = String(opts.item_type || meta.item_type || 'rental').trim();
    const allowed = new Set(['person', 'day', 'session', 'item']);
    if (allowed.has(unitGuess)) {
      return {
        offering_id: offeringRaw,
        item_type: itemType,
        item_code: offeringRaw,
        billing_unit: unitGuess,
        location_id: normalizeSunsetLocationId(locationId),
        billing_mode: 'unit_x_qty',
      };
    }
    // Rental-style offering__duration encoded in item_code; billing unit provided.
    if (opts.billing_unit || meta.billing_unit) {
      return {
        offering_id: offeringRaw,
        item_type: itemType,
        item_code: offeringRaw,
        billing_unit: String(opts.billing_unit || meta.billing_unit).trim(),
        location_id: normalizeSunsetLocationId(locationId),
        billing_mode: 'unit_x_qty',
      };
    }
  }

  return null;
}

function priceIdentityKey(identity) {
  if (!identity) return null;
  return [
    EXPECTED_TENANT,
    identity.location_id,
    identity.item_type,
    identity.item_code,
    identity.billing_unit,
  ].join('|');
}

module.exports = {
  EXPECTED_TENANT,
  packPriceItemCode,
  billingUnitForSurfPackTier,
  billingUnitForSurfPackItemCode,
  privateLessonIdentity,
  courseTierIdentity,
  lessonSlotIdentity,
  rentalDurationFromMeta,
  rentalIdentity,
  fullDayEquipmentIdentity,
  resolveSunsetPriceIdentity,
  priceIdentityKey,
};
