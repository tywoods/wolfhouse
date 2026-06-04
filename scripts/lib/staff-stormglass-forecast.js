/**
 * Phase 11b.1 — Stormglass surf forecast client (backend-only).
 * Phase 11b.1a — Madrid local daytime window sent to Stormglass as UTC Z bounds.
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
const MADRID_TZ = 'Europe/Madrid';
const DAY_MS = 86400000;
const SURF_WINDOW_START_HOUR = 6;
const SURF_WINDOW_END_HOUR = 20;

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
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * @param {Date} instant
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number }}
 */
function readMadridWallClock(instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: MADRID_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(instant)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

/**
 * Convert Madrid local wall-clock time to UTC ISO string ending in Z.
 * @param {string} ymd YYYY-MM-DD in Europe/Madrid calendar
 * @param {number} hour 0-23 local Madrid
 * @param {number} [minute=0]
 * @returns {string}
 */
function madridLocalToUtcZ(ymd, hour, minute = 0) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const startMs = Date.UTC(y, mo - 1, d, 0, 0, 0) - 3 * 3600000;
  for (let ms = startMs; ms < startMs + 36 * 3600000; ms += 60000) {
    const p = readMadridWallClock(new Date(ms));
    if (p.year === y && p.month === mo && p.day === d && p.hour === hour && p.minute === minute) {
      const dt = new Date(ms);
      return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
        + `T${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}:${pad2(dt.getUTCSeconds())}Z`;
    }
  }
  throw new Error(`unable to resolve Madrid local time ${ymd} ${hour}:${pad2(minute)}`);
}

/**
 * @param {string} dayLabel
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
function getMadridCalendarYmd(dayLabel, nowMs = Date.now()) {
  const dayOffset = dayLabel === 'tomorrow' ? 1 : 0;
  const anchor = new Date(nowMs + dayOffset * DAY_MS);
  return anchor.toLocaleDateString('en-CA', { timeZone: MADRID_TZ });
}

/**
 * Madrid local surf daytime window (06:00–20:00) as UTC Z bounds for Stormglass.
 * @param {string} dayLabel today|tomorrow
 * @param {number} [nowMs=Date.now()]
 * @returns {{ start: string, end: string }}
 */
function getMadridDayWindow(dayLabel, nowMs = Date.now()) {
  const ymd = getMadridCalendarYmd(dayLabel, nowMs);
  return {
    start: madridLocalToUtcZ(ymd, SURF_WINDOW_START_HOUR, 0),
    end: madridLocalToUtcZ(ymd, SURF_WINDOW_END_HOUR, 0),
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

// ── Phase 11b.2 — Staff Ask Luna surf forecast (read-only, backend Stormglass) ─

const SURF_FORECAST_TODAY_KEY = 'forecast.surf_today';
const SURF_FORECAST_TOMORROW_KEY = 'forecast.surf_tomorrow';

const ASK_LUNA_SURF_FORECAST_UNAVAILABLE_ANSWER =
  'Surf forecast is unavailable right now because the forecast provider quota/connection failed. Staff should check conditions manually.';

function normalizeSurfForecastQuestionText(question) {
  let q = String(question || '').toLowerCase().trim();
  q = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  q = q.replace(/[''`´]/g, ' ');
  q = q.replace(/[?!.,;:()[\]{}""]/g, ' ');
  q = q.replace(/\s+/g, ' ').trim();
  return q;
}

function surfForecastHasTodayWord(q) {
  return /\b(today|tonight|hoy|oggi|heute|aujourdhui|aujourd hui)\b/.test(q);
}

function surfForecastHasTomorrowWord(q) {
  return /\b(tomorrow|manana|domani|morgen|demain)\b/.test(q);
}

function matchesSurfForecastTopic(q) {
  if (/\b(who has|who needs|how many|booked|scheduled|show)\b/.test(q) && /\blessons?\b/.test(q)) {
    return false;
  }
  return /\b(surf\s*forecast|wave\s*forecast|forecast)\b/.test(q)
    || /\bhow are the waves\b/.test(q)
    || /\bare the waves\b/.test(q)
    || /\bis the surf good\b/.test(q)
    || /\bis it good for lessons\b/.test(q)
    || /\b(como estan las olas|prevision del surf|prevision surf|prevision de olas)\b/.test(q)
    || /\b(com vanno le onde|previsione surf|previsione delle onde)\b/.test(q)
    || (/\b(waves?|surf|olas|onde)\b/.test(q) && /\b(good|bad|conditions?|forecast|prevision)\b/.test(q));
}

function resolveSurfForecastDayLabel(question) {
  const q = normalizeSurfForecastQuestionText(question);
  if (surfForecastHasTomorrowWord(q) && !surfForecastHasTodayWord(q)) return 'tomorrow';
  if (surfForecastHasTomorrowWord(q)) return 'tomorrow';
  return 'today';
}

/**
 * @param {string} question
 * @param {Map<string, object>|null} registryByKey
 * @returns {{ intentKey: string, extraParams: { day: string, dayLabel: string } } | null}
 */
function resolveAskLunaSurfForecastIntentKey(question, registryByKey) {
  const raw = String(question || '').trim().toLowerCase();
  if (registryByKey && registryByKey.has(raw)) {
    if (raw === SURF_FORECAST_TODAY_KEY) {
      return { intentKey: SURF_FORECAST_TODAY_KEY, extraParams: { day: 'today', dayLabel: 'today' } };
    }
    if (raw === SURF_FORECAST_TOMORROW_KEY) {
      return { intentKey: SURF_FORECAST_TOMORROW_KEY, extraParams: { day: 'tomorrow', dayLabel: 'tomorrow' } };
    }
  }
  if (raw === SURF_FORECAST_TODAY_KEY) {
    return { intentKey: SURF_FORECAST_TODAY_KEY, extraParams: { day: 'today', dayLabel: 'today' } };
  }
  if (raw === SURF_FORECAST_TOMORROW_KEY) {
    return { intentKey: SURF_FORECAST_TOMORROW_KEY, extraParams: { day: 'tomorrow', dayLabel: 'tomorrow' } };
  }
  const q = normalizeSurfForecastQuestionText(question);
  if (!matchesSurfForecastTopic(q)) return null;
  const dayLabel = resolveSurfForecastDayLabel(question);
  const intentKey = dayLabel === 'tomorrow' ? SURF_FORECAST_TOMORROW_KEY : SURF_FORECAST_TODAY_KEY;
  return { intentKey, extraParams: { day: dayLabel, dayLabel } };
}

/**
 * @param {number|null|undefined} metres
 * @param {number} [decimals=1]
 * @returns {string|null}
 */
function formatSurfForecastMetres(metres, decimals = 1) {
  if (metres == null || !Number.isFinite(metres)) return null;
  return `${metres.toFixed(decimals)}m`;
}

/**
 * Staff-style surf forecast answer for Ask Luna.
 * @param {object} payload fetchSurfForecastForStaff result
 * @returns {string}
 */
function formatAskLunaSurfForecastAnswer(payload) {
  payload = payload || {};
  const day = payload.day || 'today';
  const spot = payload.spot || 'Somo';
  const fc = payload.forecast || {};

  const wave = formatSurfForecastMetres(fc.wave_height_m);
  const swellH = formatSurfForecastMetres(fc.swell_height_m);
  const swellP = fc.swell_period_s != null && Number.isFinite(fc.swell_period_s)
    ? `${Math.round(fc.swell_period_s)}s`
    : null;
  const swellD = fc.swell_direction_deg != null && Number.isFinite(fc.swell_direction_deg)
    ? `${Math.round(fc.swell_direction_deg)}°`
    : null;
  const windS = fc.wind_speed_mps != null && Number.isFinite(fc.wind_speed_mps)
    ? `${fc.wind_speed_mps.toFixed(1)} m/s`
    : null;
  const windD = fc.wind_direction_deg != null && Number.isFinite(fc.wind_direction_deg)
    ? `${Math.round(fc.wind_direction_deg)}°`
    : null;

  const lines = [`Surf forecast for ${spot} ${day}:`, ''];
  lines.push(wave ? `• Waves: ${wave}` : '• Waves: unavailable');

  if (swellH && swellP && swellD) lines.push(`• Swell: ${swellH} @ ${swellP} from ${swellD}`);
  else if (swellH) lines.push(`• Swell: ${swellH}`);
  else lines.push('• Swell: unavailable');

  if (windS && windD) lines.push(`• Wind: ${windS} from ${windD}`);
  else if (windS) lines.push(`• Wind: ${windS}`);
  else lines.push('• Wind: unavailable');

  if (fc.summary) lines.push(`• Summary: ${fc.summary}`);
  lines.push('• Staff note: Staff should confirm lessons day-by-day. Lessons are not auto-cancelled.');

  return lines.join('\n');
}

/**
 * Ask Luna backend path — uses fetchSurfForecastForStaff; safe fallback on quota/errors.
 * @param {{ clientSlug: string, day: string }} opts
 * @returns {Promise<{ ok: boolean, answer: string, unavailable?: boolean, forecast?: object, source?: string }>}
 */
async function fetchSurfForecastForAskLuna(opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  const day = String(opts.day || 'today').trim().toLowerCase();
  try {
    const payload = await fetchSurfForecastForStaff({ clientSlug, day });
    return {
      ok: true,
      answer: formatAskLunaSurfForecastAnswer(payload),
      forecast: payload.forecast,
      source: payload.source,
      day: payload.day,
      spot: payload.spot,
    };
  } catch (err) {
    const code = err && err.code;
    const status = err && err.status;
    if (code === 'NOT_CONFIGURED' || code === 'UPSTREAM_ERROR' || status === 402) {
      return { ok: false, answer: ASK_LUNA_SURF_FORECAST_UNAVAILABLE_ANSWER, unavailable: true };
    }
    if (code === 'UNSUPPORTED_CLIENT' || code === 'INVALID_DAY') {
      return { ok: false, answer: ASK_LUNA_SURF_FORECAST_UNAVAILABLE_ANSWER, unavailable: true };
    }
    return { ok: false, answer: ASK_LUNA_SURF_FORECAST_UNAVAILABLE_ANSWER, unavailable: true };
  }
}

module.exports = {
  STORMGLASS_POINT_URL,
  STORMGLASS_PARAMS,
  DEFAULT_TIMEOUT_MS,
  MADRID_TZ,
  SURF_WINDOW_START_HOUR,
  SURF_WINDOW_END_HOUR,
  setStormglassFetchForTests,
  madridLocalToUtcZ,
  getMadridCalendarYmd,
  getMadridDayWindow,
  pickStormglassValue,
  aggregateStormglassHours,
  buildStaffSafeForecastSummary,
  fetchSurfForecastForStaff,
  SURF_FORECAST_TODAY_KEY,
  SURF_FORECAST_TOMORROW_KEY,
  ASK_LUNA_SURF_FORECAST_UNAVAILABLE_ANSWER,
  resolveAskLunaSurfForecastIntentKey,
  formatAskLunaSurfForecastAnswer,
  fetchSurfForecastForAskLuna,
};
