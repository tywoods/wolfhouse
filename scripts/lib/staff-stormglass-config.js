/**
 * Phase 11b.0 — Stormglass API key config detection (no API calls).
 *
 * @module staff-stormglass-config
 */

'use strict';

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

module.exports = {
  hasStormglassConfig,
  getStormglassConfigStatus,
};
