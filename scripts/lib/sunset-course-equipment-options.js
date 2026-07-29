'use strict';

const MAX_EQUIPMENT_OPTIONS = 100;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/;

function normalizeKey(value) { return String(value == null ? '' : value).trim(); }
function validateMoney(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
  return value;
}
function validateEquipmentOptions(value, scope = {}) {
  if (!Array.isArray(value)) throw new TypeError('equipment_options must be an array');
  if (value.length > (scope.maxRows || MAX_EQUIPMENT_OPTIONS)) throw new TypeError('too many equipment_options');
  const available = scope.offerings && new Map(scope.offerings.filter((o) => o && o.active !== false
    && (!scope.clientSlug || String(o.client_slug) === String(scope.clientSlug))
    && (!scope.locationId || String(o.location_id) === String(scope.locationId)))
    .map((o) => [normalizeKey(o.offering_key), o]));
  const seen = new Set();
  return value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('equipment option must be an object');
    for (const key of Object.keys(row)) if (!['offering_key', 'equipment_price_cents', 'all_day_surcharge_cents'].includes(key)) throw new TypeError(`unknown equipment option field: ${key}`);
    const offering_key = normalizeKey(row.offering_key);
    if (!KEY_RE.test(offering_key)) throw new TypeError('invalid offering_key');
    if (seen.has(offering_key)) throw new TypeError('duplicate offering_key');
    if (available && !available.has(offering_key)) throw new TypeError('offering_key is not an active scoped rental offering');
    seen.add(offering_key);
    return { offering_key, equipment_price_cents: validateMoney(row.equipment_price_cents, 'equipment_price_cents'), all_day_surcharge_cents: validateMoney(row.all_day_surcharge_cents, 'all_day_surcharge_cents') };
  });
}
function normalizeEquipmentOptions(value) {
  const rows = Array.isArray(value) ? value : value && value.equipment_options;
  try { return validateEquipmentOptions(rows); } catch (_) { return []; }
}
function validateEquipmentSelection(value, surfers) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('course_equipment must be an array');
  if (!Number.isInteger(surfers) || surfers < 1) throw new TypeError('surfers must be a positive integer');
  const seen = new Set();
  return value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('course equipment selection must be an object');
    for (const key of Object.keys(row)) if (!['offering_key', 'quantity', 'all_day'].includes(key)) throw new TypeError(`unknown course equipment selection field: ${key}`);
    const offering_key = normalizeKey(row.offering_key);
    if (!KEY_RE.test(offering_key) || seen.has(offering_key)) throw new TypeError('invalid or duplicate offering_key');
    if (!Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > surfers) throw new TypeError('quantity must be between 1 and surfers');
    if (typeof row.all_day !== 'boolean') throw new TypeError('all_day must be boolean');
    seen.add(offering_key);
    return { offering_key, quantity: row.quantity, all_day: row.all_day };
  });
}
function projectEquipmentOptions(options, offerings, scope = {}) {
  const byKey = new Map((offerings || []).filter((o) => o && o.active !== false
    && (!scope.clientSlug || String(o.client_slug) === String(scope.clientSlug))
    && (!scope.locationId || String(o.location_id) === String(scope.locationId))).map((o) => [normalizeKey(o.offering_key), o]));
  return normalizeEquipmentOptions(options).filter((row) => byKey.has(row.offering_key)).map((row) => ({ ...row, label: String(byKey.get(row.offering_key).label || byKey.get(row.offering_key).display_name || row.offering_key), location_id: scope.locationId || byKey.get(row.offering_key).location_id || null }));
}
module.exports = { MAX_EQUIPMENT_OPTIONS, validateEquipmentOptions, normalizeEquipmentOptions, validateEquipmentSelection, projectEquipmentOptions };
