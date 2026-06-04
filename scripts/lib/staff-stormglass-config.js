/**
 * Phase 11b.0 — Stormglass API key config detection (no API calls).
 * Phase 11b.1 — Wolfhouse/Somo surf spot constants (backend-only).
 *
 * @module staff-stormglass-config
 */

'use strict';

/** Backend-only surf spot coordinates for Stormglass requests. */
const STORMGLASS_SURF_SPOTS = Object.freeze({
  'wolfhouse-somo': Object.freeze({
    client_slug: 'wolfhouse-somo',
    spot: 'Somo',
    // Playa de Somo area — backend-only constant; confirm with ops if needed.
    lat: 43.4630,
    lng: -3.7510,
  }),
});

/**
 * True when STORMGLASS_API_KEY is set to a non-empty string.
 * @returns {boolean}
 */
function hasStormglassConfig() {
  const key = process.env.STORMGLASS_API_KEY;
  return typeof key === 'string' && key.trim().length > 0;
}

/**
 * Safe status for health/debug responses (never includes the key).
 * @returns {{ configured: boolean }}
 */
function getStormglassConfigStatus() {
  return { configured: hasStormglassConfig() };
}

/**
 * @param {string} clientSlug
 * @returns {object|null}
 */
function getStormglassSurfSpot(clientSlug) {
  return STORMGLASS_SURF_SPOTS[clientSlug] || null;
}

module.exports = {
  STORMGLASS_SURF_SPOTS,
  hasStormglassConfig,
  getStormglassConfigStatus,
  getStormglassSurfSpot,
};
