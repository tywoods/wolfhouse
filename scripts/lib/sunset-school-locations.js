'use strict';

/**
 * Sunset tenant school/location config.
 * Tenant remains `sunset`; locations partition ops within the tenant.
 */

const SUNSET_CLIENT_SLUG = 'sunset';
const DEFAULT_SUNSET_LOCATION_ID = 'sunset-somo';

const SUNSET_LOCATIONS = Object.freeze([
  { id: 'sunset-somo', displayName: 'Sunset', labelKey: 'school.sunsetSomo' },
  { id: 'sunset-sardinero', displayName: 'El Sardi', labelKey: 'school.sunsetSardinero' },
]);

const LOCATION_ID_SET = new Set(SUNSET_LOCATIONS.map((l) => l.id));

function normalizeSunsetLocationId(raw) {
  const id = String(raw || '').trim().toLowerCase();
  if (LOCATION_ID_SET.has(id)) return id;
  return DEFAULT_SUNSET_LOCATION_ID;
}

function isSunsetLocationId(id) {
  return LOCATION_ID_SET.has(String(id || '').trim().toLowerCase());
}

function resolveRecordLocationId(serviceMeta, bookingMeta) {
  const srMeta = serviceMeta && typeof serviceMeta === 'object' ? serviceMeta : {};
  const bMeta = bookingMeta && typeof bookingMeta === 'object' ? bookingMeta : {};
  return normalizeSunsetLocationId(srMeta.location_id || bMeta.location_id || null);
}

function sqlLocationMatch(srAlias, bookingAlias, paramIndex) {
  const sr = srAlias || 'sr';
  const b = bookingAlias || 'b';
  return `COALESCE(${sr}.metadata->>'location_id', ${b}.metadata->>'location_id', '${DEFAULT_SUNSET_LOCATION_ID}') = $${paramIndex}`;
}

function attachLocationToMetadata(metadata, locationId) {
  const meta = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  meta.location_id = normalizeSunsetLocationId(locationId);
  return meta;
}

module.exports = {
  SUNSET_CLIENT_SLUG,
  DEFAULT_SUNSET_LOCATION_ID,
  SUNSET_LOCATIONS,
  normalizeSunsetLocationId,
  isSunsetLocationId,
  resolveRecordLocationId,
  sqlLocationMatch,
  attachLocationToMetadata,
};
