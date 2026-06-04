/**
 * Phase 11b.1 — Stormglass surf forecast client (backend-only).
 *
 * @module staff-stormglass-forecast
 */

'use strict';

const {
  hasStormglassConfig,
  getStormglassSurfSpot,
} = require('./staff-stormglass-config');

const STORMGLASS_POINT_URL = 'https://api.stormglass.io/v2/weather/point';
const STORMGLASS_PARAMS = [
  'waveHeight',
  'swellHeight',
  'swellPeriod',
  'swellDirection',
  'windSpeed',
  'windDirection',
].join(',');
const DEFAULT_TIMEOUT_MS = 12000;

/** @type {((url: string, init: object) => Promise<{ ok: boolean, status: number, json: () => Promise<object>, text?: () => Promise<string> }>) | null} */
let _fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null;

/**
 * Replace fetch for tests/verifier (pass null to restore default).
 * @param {typeof _fetchImpl} fn
 */
function setStormglassFetchForTests(fn) {
  _fetchImpl = fn || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
}

/**
 * @param {string} dayLabel
 * @returns {{ start: string, end: string }}
 */
function getMadridDayWindow(dayLabel) {
  const dayOffset = dayLabel === 'tomorrow' ? 1 : 0;
  const anchor = new Date(Date.now() + dayOffset * 86400000);
  const ymd = anchor.toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
  return {
    start: `${ymd}T06:00:00+01:00`,
    end: `${ymd}T20:00:00+01:00`,
  };
}

/**
 * @param {Record<string, number>|null|undefined} paramObj
 * @returns {number|null}
 */
function pickStormglassValue(paramObj) {
  if (paramObj == null || typeof paramObj !== 'object') return null;
  const preferred = ['sg', 'noaa', 'metno', 'dwd', 'icon', 'fcoo'];
  for (const key of preferred) {
    const v = paramObj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  for (const v of Object.values(paramObj)) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * @param {Array<object>} hours
 * @returns {object}
 */
function aggregateStormglassHours(hours) {
  const metrics = {
    wave_height_m: null,
    swell_height_m: null,
    swell_period_s: null,
    swell_direction_deg: null,
    wind_speed_mps: null,
    wind_direction_deg: null,
  };
  if (!Array.isArray(hours) || hours.length === 0) return metrics;

  const sums = {
    waveHeight: 0, swellHeight: 0, swellPeriod: 0,
    swellDirection: 0, windSpeed: 0, windDirection: 0,
  };
  const counts = { ...sums };

  for (const hour of hours) {
    for (const [srcKey, outKey] of [
      ['waveHeight', 'waveHeight'],
      ['swellHeight', 'swellHeight'],
      ['swellPeriod', 'swellPeriod'],
      ['swellDirection', 'swellDirection'],
      ['windSpeed', 'windSpeed'],
      ['windDirection', 'windDirection'],
    ]) {
      const v = pickStormglassValue(hour[srcKey]);
      if (v != null) {
        sums[srcKey] += v;
        counts[srcKey] += 1;
      }
    }
  }

  const avg = (key) => (counts[key] > 0 ? sums[key] / counts[key] : null);
  metrics.wave_height_m = avg('waveHeight');
  metrics.swell_height_m = avg('swellHeight');
  metrics.swell_period_s = avg('swellPeriod');
  metrics.swell_direction_deg = avg('swellDirection');
  metrics.wind_speed_mps = avg('windSpeed');
  metrics.wind_direction_deg = avg('windDirection');
  return metrics;
}

/**
 * Staff-safe summary — never implies automatic lesson cancellation.
 * @param {object} metrics
 * @returns {{ summary: string, caution: string }}
 */
function buildStaffSafeForecastSummary(metrics) {
  const parts = [];
  const wh = metrics.wave_height_m;

  if (wh == null) {
    parts.push('Conditions unclear');
  } else if (wh < 1.0) {
    parts.push('Looks small');
  } else if (wh < 2.0) {
    parts.push('Looks moderate');
  } else {
    parts.push('Looks big');
  }

  const ws = metrics.wind_speed_mps;
  if (ws != null && ws >= 6) {
    parts.push('Wind may affect conditions');
  }

  parts.push('Staff should confirm lessons day-by-day');

  const summary = parts.join('. ') + '.';
  const caution = 'Forecast is indicative only. Staff decide lesson plans day-by-day; lessons are not auto-cancelled.';

  return { summary, caution };
}

/**
 * @param {string} url
 * @param {object} init
 * @param {number} timeoutMs
 */
async function stormglassFetch(url, init, timeoutMs) {
  if (!_fetchImpl) {
    throw new Error('fetch unavailable in this runtime');
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
    init = { ...init, signal: controller.signal };
  }
  try {
    return await _fetchImpl(url, init);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fetch surf forecast from Stormglass (backend-only; key from env).
 * @param {{ clientSlug: string, day: string, timeoutMs?: number }} opts
 * @returns {Promise<object>}
 */
async function fetchSurfForecastForStaff(opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  const day = String(opts.day || 'today').trim().toLowerCase();
  const spot = getStormglassSurfSpot(clientSlug);
  if (!spot) {
    const err = new Error(`unsupported client: ${clientSlug}`);
    err.code = 'UNSUPPORTED_CLIENT';
    throw err;
  }
  if (day !== 'today' && day !== 'tomorrow') {
    const err = new Error("day must be 'today' or 'tomorrow'");
    err.code = 'INVALID_DAY';
    throw err;
  }
  if (!hasStormglassConfig()) {
    const err = new Error('STORMGLASS_API_KEY not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const apiKey = process.env.STORMGLASS_API_KEY.trim();
  const { start, end } = getMadridDayWindow(day);
  const qs = new URLSearchParams({
    lat: String(spot.lat),
    lng: String(spot.lng),
    params: STORMGLASS_PARAMS,
    start,
    end,
  });
  const url = `${STORMGLASS_POINT_URL}?${qs.toString()}`;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  let response;
  try {
    response = await stormglassFetch(url, {
      method: 'GET',
      headers: { Authorization: apiKey },
    }, timeoutMs);
  } catch (err) {
    const msg = err && err.name === 'AbortError'
      ? 'Stormglass request timed out'
      : (err.message || 'Stormglass request failed');
    const wrapped = new Error(msg);
    wrapped.code = 'UPSTREAM_ERROR';
    throw wrapped;
  }

  if (!response.ok) {
    const wrapped = new Error(`Stormglass returned HTTP ${response.status}`);
    wrapped.code = 'UPSTREAM_ERROR';
    wrapped.status = response.status;
    throw wrapped;
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    const wrapped = new Error('Stormglass returned invalid JSON');
    wrapped.code = 'UPSTREAM_ERROR';
    throw wrapped;
  }

  const metrics = aggregateStormglassHours(payload.hours || []);
  const { summary, caution } = buildStaffSafeForecastSummary(metrics);

  return {
    success: true,
    client_slug: clientSlug,
    spot: spot.spot,
    day,
    forecast: {
      ...metrics,
      tide_summary_if_available: null,
      summary,
      caution,
    },
    source: 'stormglass',
    read_only: true,
  };
}

module.exports = {
  STORMGLASS_POINT_URL,
  STORMGLASS_PARAMS,
  DEFAULT_TIMEOUT_MS,
  setStormglassFetchForTests,
  getMadridDayWindow,
  pickStormglassValue,
  aggregateStormglassHours,
  buildStaffSafeForecastSummary,
  fetchSurfForecastForStaff,
};
