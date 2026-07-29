'use strict';

const MAX_EQUIPMENT_OPTIONS = 100;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/;
const MODES = Object.freeze(['during_course', 'all_day']);

const CANONICAL_FIELDS = Object.freeze([
  'offering_key',
  'during_course_price_cents',
  'all_day_price_cents',
]);
const LEGACY_FIELDS = Object.freeze([
  'offering_key',
  'equipment_price_cents',
  'all_day_surcharge_cents',
]);

function normalizeKey(value) { return String(value == null ? '' : value).trim(); }

function validateMoney(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
  return value;
}

function activeScopedOfferingMap(offerings, scope = {}) {
  return new Map((offerings || []).filter((o) => o && o.active !== false
    && (!scope.clientSlug || String(o.client_slug) === String(scope.clientSlug))
    && (!scope.locationId || String(o.location_id) === String(scope.locationId)))
    .map((o) => [normalizeKey(o.offering_key), o]));
}

function hasOwn(row, key) {
  return Object.prototype.hasOwnProperty.call(row, key);
}

/**
 * Resolve one equipment option to independent During/All Day total unit prices.
 *
 * Canonical: during_course_price_cents + all_day_price_cents
 * Legacy pair (historical read only): equipment_price_cents + all_day_surcharge_cents
 *   interpreted as the same independent totals (NOT base + surcharge).
 * Mixed / competing schemas are rejected.
 */
function resolveEquipmentOptionMoney(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('equipment option must be an object');
  }
  const offering_key = normalizeKey(row.offering_key);
  if (!KEY_RE.test(offering_key)) throw new TypeError('invalid offering_key');

  const hasDuring = hasOwn(row, 'during_course_price_cents');
  const hasAllDay = hasOwn(row, 'all_day_price_cents');
  const hasLegacyBase = hasOwn(row, 'equipment_price_cents');
  const hasLegacySurcharge = hasOwn(row, 'all_day_surcharge_cents');
  const hasCanonical = hasDuring || hasAllDay;
  const hasLegacy = hasLegacyBase || hasLegacySurcharge;

  if (hasCanonical && hasLegacy) {
    throw new TypeError('competing course equipment option price schemas');
  }
  if (hasCanonical) {
    if (!hasDuring || !hasAllDay) {
      throw new TypeError('during_course_price_cents and all_day_price_cents are both required');
    }
    return {
      offering_key,
      during_course_price_cents: validateMoney(row.during_course_price_cents, 'during_course_price_cents'),
      all_day_price_cents: validateMoney(row.all_day_price_cents, 'all_day_price_cents'),
    };
  }
  if (hasLegacy) {
    if (!hasLegacyBase || !hasLegacySurcharge) {
      throw new TypeError('legacy equipment_price_cents and all_day_surcharge_cents are both required');
    }
    // Independent totals — never base + surcharge.
    return {
      offering_key,
      during_course_price_cents: validateMoney(row.equipment_price_cents, 'equipment_price_cents'),
      all_day_price_cents: validateMoney(row.all_day_surcharge_cents, 'all_day_surcharge_cents'),
    };
  }
  throw new TypeError('equipment option prices missing');
}

/**
 * Admin/API write validator — canonical fields only.
 * Rejects legacy pair, mixed schema, and unknown fields.
 */
function validateEquipmentOptions(value, scope = {}) {
  if (!Array.isArray(value)) throw new TypeError('equipment_options must be an array');
  if (value.length > (scope.maxRows || MAX_EQUIPMENT_OPTIONS)) throw new TypeError('too many equipment_options');
  const available = scope.offerings ? activeScopedOfferingMap(scope.offerings, scope) : null;
  const seen = new Set();
  return value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('equipment option must be an object');
    for (const key of Object.keys(row)) {
      if (!CANONICAL_FIELDS.includes(key)) {
        throw new TypeError(`unknown equipment option field: ${key}`);
      }
    }
    if (!hasOwn(row, 'during_course_price_cents') || !hasOwn(row, 'all_day_price_cents')) {
      throw new TypeError('during_course_price_cents and all_day_price_cents are both required');
    }
    const offering_key = normalizeKey(row.offering_key);
    if (!KEY_RE.test(offering_key)) throw new TypeError('invalid offering_key');
    if (seen.has(offering_key)) throw new TypeError('duplicate offering_key');
    if (available && !available.has(offering_key)) throw new TypeError('offering_key is not an active scoped rental offering');
    seen.add(offering_key);
    return {
      offering_key,
      during_course_price_cents: validateMoney(row.during_course_price_cents, 'during_course_price_cents'),
      all_day_price_cents: validateMoney(row.all_day_price_cents, 'all_day_price_cents'),
    };
  });
}

/**
 * Historical/read normalizer: accepts legacy pair OR canonical; emits canonical only.
 * Mixed schema / invalid rows → empty list (fail soft for map/load paths).
 */
function normalizeEquipmentOptions(value) {
  const rows = Array.isArray(value) ? value : value && value.equipment_options;
  if (!Array.isArray(rows)) return [];
  try {
    if (rows.length > MAX_EQUIPMENT_OPTIONS) return [];
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('bad row');
      const hasCanonical = hasOwn(row, 'during_course_price_cents') || hasOwn(row, 'all_day_price_cents');
      const hasLegacy = hasOwn(row, 'equipment_price_cents') || hasOwn(row, 'all_day_surcharge_cents');
      if (hasCanonical && hasLegacy) throw new TypeError('competing schemas');
      const money = resolveEquipmentOptionMoney(row);
      if (seen.has(money.offering_key)) throw new TypeError('duplicate');
      seen.add(money.offering_key);
      out.push(money);
    }
    return out;
  } catch (_) {
    return [];
  }
}

/**
 * Single transport→core boundary for course_equipment selection.
 * Browser sends {offering_key, mode, quantity}; core uses all_day boolean.
 * Accepts either mode or all_day at the edge, never both competing fields.
 * Never accepts money/labels from the client.
 */
function validateEquipmentSelection(value, surfers) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('course_equipment must be an array');
  if (!Number.isInteger(surfers) || surfers < 1) throw new TypeError('surfers must be a positive integer');
  const seen = new Set();
  return value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError('course equipment selection must be an object');
    }
    const keys = Object.keys(row);
    for (const key of keys) {
      if (!['offering_key', 'quantity', 'mode', 'all_day'].includes(key)) {
        throw new TypeError(`unknown course equipment selection field: ${key}`);
      }
    }
    const hasMode = Object.prototype.hasOwnProperty.call(row, 'mode');
    const hasAllDay = Object.prototype.hasOwnProperty.call(row, 'all_day');
    if (hasMode && hasAllDay) throw new TypeError('competing course equipment mode schemas');
    let all_day;
    if (hasMode) {
      if (!MODES.includes(row.mode)) throw new TypeError('invalid course equipment mode');
      all_day = row.mode === 'all_day';
    } else if (hasAllDay) {
      if (typeof row.all_day !== 'boolean') throw new TypeError('all_day must be boolean');
      all_day = row.all_day;
    } else {
      throw new TypeError('course equipment mode is required');
    }
    const offering_key = normalizeKey(row.offering_key);
    if (!KEY_RE.test(offering_key) || seen.has(offering_key)) {
      throw new TypeError('invalid or duplicate offering_key');
    }
    if (!Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > surfers) {
      throw new TypeError('quantity must be between 1 and surfers');
    }
    seen.add(offering_key);
    return { offering_key, quantity: row.quantity, all_day };
  });
}

/** Wire-canonical selection for quote/create echo: mode form only. */
function normalizeSelection(selection, surfers) {
  if (selection == null) return null;
  return validateEquipmentSelection(selection, surfers).map((row) => ({
    offering_key: row.offering_key,
    mode: row.all_day ? 'all_day' : 'during_course',
    quantity: row.quantity,
  }));
}

function projectEquipmentOptions(options, offerings, scope = {}) {
  const byKey = activeScopedOfferingMap(offerings, scope);
  return normalizeEquipmentOptions(options)
    .filter((row) => byKey.has(row.offering_key))
    .map((row) => {
      const offering = byKey.get(row.offering_key);
      return {
        ...row,
        label: String(offering.label || offering.display_name || row.offering_key),
        location_id: scope.locationId || offering.location_id || null,
      };
    });
}

/** Unique YYYY-MM-DD course service dates for equipment billing. */
function uniqueCourseServiceDates(value) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [];
  const dates = raw
    .map((d) => String(d || '').slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  return [...new Set(dates)].sort();
}

module.exports = {
  MAX_EQUIPMENT_OPTIONS,
  MODES,
  CANONICAL_FIELDS,
  LEGACY_FIELDS,
  validateEquipmentOptions,
  normalizeEquipmentOptions,
  resolveEquipmentOptionMoney,
  validateEquipmentSelection,
  normalizeSelection,
  projectEquipmentOptions,
  activeScopedOfferingMap,
  uniqueCourseServiceDates,
};
