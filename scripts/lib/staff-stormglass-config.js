/**
 * Backend-only Stormglass location bindings.  Coordinates are server-owned and
 * keyed by the authenticated tenant/location binding; callers never supply a
 * latitude/longitude or inherit a nearby school's location.
 * @module staff-stormglass-config
 */
'use strict';

const STORMGLASS_FORECAST_LOCATIONS = Object.freeze({
  'wolfhouse-somo': Object.freeze({
    client_slug: 'wolfhouse-somo', location_id: 'wolfhouse-somo', label: 'Somo',
    timezone: 'Europe/Madrid', lat: 43.4630, lng: -3.7510,
  }),
  'sunset-somo': Object.freeze({
    client_slug: 'sunset', location_id: 'sunset-somo', label: 'Somo',
    timezone: 'Europe/Madrid', lat: 43.4630, lng: -3.7510,
  }),
  'sunset-sardinero': Object.freeze({
    client_slug: 'sunset', location_id: 'sunset-sardinero', label: 'El Sardinero',
    timezone: 'Europe/Madrid', lat: 43.4769, lng: -3.7879,
  }),
});

// Legacy surf call compatibility.  This is deliberately not a generic fallback.
const STORMGLASS_SURF_SPOTS = STORMGLASS_FORECAST_LOCATIONS;

function hasStormglassConfig() {
  const key = process.env.STORMGLASS_API_KEY;
  return typeof key === 'string' && key.trim().length > 0;
}

function getStormglassConfigStatus() {
  return { configured: hasStormglassConfig() };
}

function getStormglassForecastLocation(locationId) {
  return STORMGLASS_FORECAST_LOCATIONS[String(locationId || '').trim()] || null;
}

function getStormglassSurfSpot(clientSlug) {
  return getStormglassForecastLocation(clientSlug);
}

module.exports = {
  STORMGLASS_FORECAST_LOCATIONS,
  STORMGLASS_SURF_SPOTS,
  hasStormglassConfig,
  getStormglassConfigStatus,
  getStormglassForecastLocation,
  getStormglassSurfSpot,
};
