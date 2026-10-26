/**
 * Phase 11b.1 — Stormglass surf forecast client (backend-only).
 * Phase 11b.1a — Madrid local daytime window sent to Stormglass as UTC Z bounds.
 *
 * @module staff-stormglass-forecast
 */

'use strict';

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  hasStormglassConfig,
  getStormglassSurfSpot,
  getStormglassForecastLocation,
} = require('./staff-stormglass-config');

const STORMGLASS_POINT_URL = 'https://api.stormglass.io/v2/weather/point';
const STORMGLASS_TIDE_EXTREMES_URL = 'https://api.stormglass.io/v2/tide/extremes/point';
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

/** @type {((url: string, apiKey: string, timeoutMs: number) => Promise<{ status: number, body: string }>) | null} */
let _requestImpl = null;

/**
 * Replace upstream HTTP for tests/verifier (pass null to restore default).
 * @param {typeof _requestImpl} fn
 */
function setStormglassFetchForTests(fn) {
  _requestImpl = fn || null;
}

function setStormglassRequestForTests(fn) {
  setStormglassFetchForTests(fn);
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

function stormglassErrorBodySnippet(body) {
  const raw = String(body || '').trim();
  if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    const msg = j && (j.errors || j.message || j.error);
    if (typeof msg === 'string') return msg.slice(0, 200);
    if (Array.isArray(msg) && msg.length) return String(msg[0]).slice(0, 200);
  } catch (_) {
    /* plain text */
  }
  return raw.slice(0, 200);
}

/**
 * Node https GET — reliable in Container Apps (global fetch can fail silently there).
 * @param {string} url
 * @param {string} apiKey
 * @param {number} timeoutMs
 * @returns {Promise<{ status: number, body: string }>}
 */
function stormglassHttpsGet(url, apiKey, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      reject(Object.assign(err, { code: 'UPSTREAM_ERROR' }));
      return;
    }
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers: { Authorization: String(apiKey || '').trim() },
      family: 4,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(Object.assign(new Error('Stormglass request timed out'), {
        code: 'UPSTREAM_ERROR',
        name: 'AbortError',
      }));
    });
    req.on('error', (err) => {
      reject(Object.assign(err, { code: 'UPSTREAM_ERROR' }));
    });
    req.end();
  });
}

function waitBudgetLockMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function budgetPath() {
  return `${forecastCachePath()}.budget.json`;
}

function budgetLockPath() {
  return `${forecastCachePath()}.budget.lock`;
}

function withBudgetLock(fn) {
  const lockPath = budgetLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try { return fn(); }
      finally {
        try { fs.closeSync(fd); } catch (_) { /* already closed */ }
        try { fs.unlinkSync(lockPath); } catch (_) { /* lost lock file */ }
      }
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 5000) fs.unlinkSync(lockPath);
      } catch (_) { /* lock raced */ }
      if (Date.now() > deadline) {
        throw typedStormglassError('RATE_LIMITED', 'Stormglass daily allowance exhausted', 429);
      }
      waitBudgetLockMs(10);
    }
  }
}

let _budgetReadForTests = null;
function setStormglassBudgetReadForTests(fn) {
  _budgetReadForTests = typeof fn === 'function' ? fn : null;
}

let _nowMsForTests = null;
function setStormglassNowMsForTests(fn) {
  _nowMsForTests = typeof fn === 'function' ? fn : null;
}

function providerAttemptNowMs() {
  if (_nowMsForTests) return _nowMsForTests();
  return Date.now();
}

function ledgerFileExists() {
  try { return fs.existsSync(budgetPath()); } catch (_) { return true; }
}

function readBudgetState() {
  try {
    const raw = _budgetReadForTests
      ? _budgetReadForTests(budgetPath())
      : fs.readFileSync(budgetPath(), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data.days !== 'object' || !data.days) {
      throw Object.assign(new Error('invalid ledger'), { code: 'EIO' });
    }
    return { days: data.days };
  } catch (err) {
    if (err && err.code === 'RATE_LIMITED') throw err;
    if (err && err.code === 'ENOENT') return { days: {} };
    if (_budgetReadForTests || ledgerFileExists()) {
      throw typedStormglassError('RATE_LIMITED', 'Stormglass daily allowance exhausted', 429);
    }
    return { days: {} };
  }
}

function writeBudgetState(state) {
  const file = budgetPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, days: (state && state.days) || {} }), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function budgetDaySlot(state, dayKey) {
  if (!state.days[dayKey]) state.days[dayKey] = { used: 0, reserved: 0 };
  const slot = state.days[dayKey];
  slot.used = Math.max(0, Number(slot.used) || 0);
  slot.reserved = Math.max(0, Number(slot.reserved) || 0);
  return slot;
}

function providerBudgetDayKey(nowMs) {
  return getMadridCalendarYmd('today', Number.isFinite(nowMs) ? nowMs : Date.now());
}

function reserveStormglassCall(nowMs) {
  const dayKey = providerBudgetDayKey(nowMs);
  withBudgetLock(() => {
    const state = readBudgetState();
    const slot = budgetDaySlot(state, dayKey);
    if (slot.used + slot.reserved >= STORMGLASS_DAILY_LIMIT) {
      throw typedStormglassError('RATE_LIMITED', 'Stormglass daily allowance exhausted', 429);
    }
    slot.reserved += 1;
    writeBudgetState(state);
  });
  let settled = false;
  const settle = (count) => {
    if (settled) return;
    settled = true;
    withBudgetLock(() => {
      const state = readBudgetState();
      const slot = budgetDaySlot(state, dayKey);
      slot.reserved = Math.max(0, slot.reserved - 1);
      if (count) slot.used += 1;
      writeBudgetState(state);
    });
  };
  return {
    commit() { settle(true); },
    release() { settle(false); },
  };
}

async function stormglassGet(url, apiKey, timeoutMs) {
  const reservation = reserveStormglassCall(providerAttemptNowMs());
  try {
    const result = _requestImpl
      ? await _requestImpl(url, apiKey, timeoutMs)
      : await stormglassHttpsGet(url, apiKey, timeoutMs);
    reservation.commit();
    return result;
  } catch (err) {
    reservation.commit();
    throw err;
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

  let httpRes;
  try {
    httpRes = await stormglassGet(url, apiKey, timeoutMs);
  } catch (err) {
    const msg = err && err.name === 'AbortError'
      ? 'Stormglass request timed out'
      : (err.message || 'Stormglass request failed');
    console.error('[stormglass] request failed', { day, clientSlug, message: msg });
    const wrapped = new Error(msg);
    wrapped.code = 'UPSTREAM_ERROR';
    throw wrapped;
  }

  const status = httpRes.status;
  if (status < 200 || status >= 300) {
    const snippet = stormglassErrorBodySnippet(httpRes.body);
    const msg = snippet
      ? `Stormglass returned HTTP ${status}: ${snippet}`
      : `Stormglass returned HTTP ${status}`;
    console.error('[stormglass] upstream error', { day, clientSlug, status, detail: snippet || null });
    const wrapped = new Error(msg);
    wrapped.code = 'UPSTREAM_ERROR';
    wrapped.status = status;
    throw wrapped;
  }

  let payload;
  try {
    payload = JSON.parse(httpRes.body || '{}');
  } catch (_) {
    console.error('[stormglass] invalid JSON', { day, clientSlug, status });
    const wrapped = new Error('Stormglass returned invalid JSON');
    wrapped.code = 'UPSTREAM_ERROR';
    wrapped.status = status;
    throw wrapped;
  }

  if (!Array.isArray(payload.hours) || payload.hours.length === 0) {
    console.error('[stormglass] empty hours', { day, clientSlug, status, window: { start, end } });
    const wrapped = new Error('Stormglass returned no hourly data for requested window');
    wrapped.code = 'UPSTREAM_ERROR';
    wrapped.status = status;
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

// Generic guest weather/marine forecast.  It is deliberately separate from the
// legacy surf-day aggregate so callers retain hour-level facts and provenance.
const FORECAST_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const TIDE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FORECAST_HORIZON_DAYS = 7;
const STORMGLASS_DAILY_LIMIT = 10;
const FORECAST_PARAMS = [
  'waveHeight', 'swellHeight', 'swellPeriod', 'swellDirection',
  'windSpeed', 'windDirection', 'airTemperature', 'precipitation', 'cloudCover',
  'currentSpeed', 'currentDirection', 'waterTemperature',
].join(',');
const FORECAST_FIELDS = Object.freeze([
  ['waveHeight', 'wave_height_m'], ['swellHeight', 'swell_height_m'],
  ['swellPeriod', 'swell_period_s'], ['swellDirection', 'swell_direction_deg'],
  ['windSpeed', 'wind_speed_mps'], ['windDirection', 'wind_direction_deg'],
  ['airTemperature', 'air_temperature_c'], ['precipitation', 'precipitation_mm_per_h'],
  ['cloudCover', 'cloud_cover_pct'], ['currentSpeed', 'current_speed_mps'],
  ['currentDirection', 'current_direction_deg'], ['waterTemperature', 'water_temperature_c'],
  // tideHeight is intentionally not requested from /v2/weather/point because
  // Stormglass rejects it there. Keep the output field so coverage explicitly
  // marks tide unavailable and Intelligence can perform a bounded fallback.
  ['tideHeight', 'tide_height_m'],
]);
const forecastCache = new Map();

function forecastCachePath() {
  const configured = String(process.env.STORMGLASS_FORECAST_CACHE_PATH || '').trim();
  return configured && path.isAbsolute(configured)
    ? configured
    : path.join(os.tmpdir(), 'stormglass-forecast-cache.json');
}

function readPersistentForecastCache() {
  try {
    const file = forecastCachePath();
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 5 * 1024 * 1024) return { entries: {}, tides: {} };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { entries: data && typeof data.entries === 'object' ? data.entries : {}, tides: data && typeof data.tides === 'object' ? data.tides : {} };
  } catch (_) { return { entries: {}, tides: {} }; }
}

function writePersistentForecastCache(cache) {
  try {
    const file = forecastCachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, entries: cache.entries, tides: cache.tides }), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (_) { /* cache persistence must not make forecasts unavailable */ }
}

function clearStormglassForecastCacheForTests() {
  forecastCache.clear();
  _budgetReadForTests = null;
  _nowMsForTests = null;
  try { fs.unlinkSync(budgetPath()); } catch (_) { /* absent */ }
  try { fs.unlinkSync(budgetLockPath()); } catch (_) { /* absent */ }
}

function toYmd(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : text;
}

function getForecastWindow(date, startHour = 0, endHour = 24) {
  const start = Number(startHour);
  const end = Number(endHour);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || end <= start) {
    const err = new Error('invalid local hourly window'); err.code = 'INVALID_WINDOW'; throw err;
  }
  const nextDate = new Date(Date.parse(`${date}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  return { start: madridLocalToUtcZ(date, start), end: end === 24
    ? madridLocalToUtcZ(nextDate, 0)
    : madridLocalToUtcZ(date, end) };
}

function typedStormglassError(code, message, status) {
  const err = new Error(message); err.code = code; if (status) err.status = status; return err;
}

function normalizeHourlyFacts(hours) {
  return hours.map((hour) => {
    const row = { time: typeof hour.time === 'string' ? hour.time : null };
    for (const [source, output] of FORECAST_FIELDS) row[output] = pickStormglassValue(hour[source]);
    return row;
  });
}

function localYmdFromIso(iso) {
  return typeof iso === 'string' ? new Date(iso).toLocaleDateString('en-CA', { timeZone: MADRID_TZ }) : null;
}

function windowCovers(cachedStart, cachedEnd, window) {
  return String(cachedStart) <= window.start && String(cachedEnd) >= window.end;
}

function findCoveringWeather(locationId, window, now, diskCache) {
  const consider = (key, entry) => {
    if (!entry || !entry.value || now - entry.cachedAt >= FORECAST_CACHE_TTL_MS) return null;
    let parsed;
    try { parsed = JSON.parse(key); } catch (_) { return null; }
    if (!Array.isArray(parsed) || parsed[0] !== locationId) return null;
    if (!windowCovers(parsed[1], parsed[2], window)) return null;
    return { key, entry };
  };
  for (const [key, entry] of forecastCache) {
    const hit = consider(key, entry);
    if (hit) return hit;
  }
  for (const [key, entry] of Object.entries((diskCache && diskCache.entries) || {})) {
    const hit = consider(key, entry);
    if (hit) {
      forecastCache.set(key, entry);
      return hit;
    }
  }
  return null;
}

function sliceWeatherToRequest(value, labels, window) {
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const hourly = (value.hourly || []).filter((row) => {
    const t = Date.parse(row && row.time);
    if (!Number.isFinite(t) || t < startMs || t >= endMs) return false;
    return labels.includes(localYmdFromIso(row.time));
  });
  return {
    ...value,
    validity: window,
    hourly,
    days: labels.map((ymd) => ({ date: ymd, hourly: hourly.filter((row) => localYmdFromIso(row.time) === ymd) })),
  };
}

function persistWeatherCache(cacheKey, now, weatherValue, diskCache) {
  const entry = { cachedAt: now, value: weatherValue };
  forecastCache.set(cacheKey, entry);
  diskCache.entries[cacheKey] = entry;
  writePersistentForecastCache(diskCache);
}

async function fetchStormglassForecast(opts) {
  const input = opts || {};
  const locationId = String(input.locationId || input.clientSlug || '').trim();
  const location = getStormglassForecastLocation(locationId);
  if (!location) throw typedStormglassError('UNSUPPORTED_LOCATION', 'forecast location is not bound');
  const date = toYmd(input.date);
  if (!date) throw typedStormglassError('INVALID_DATE', 'date must be YYYY-MM-DD');
  const days = input.days == null ? 1 : Number(input.days);
  if (!Number.isInteger(days) || days < 1 || days > 7) throw typedStormglassError('INVALID_DAYS', 'days must be an integer from 1 to 7');
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const daysAway = Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${getMadridCalendarYmd('today', nowMs)}T00:00:00Z`)) / DAY_MS);
  if (daysAway < -1 || daysAway + days - 1 > FORECAST_HORIZON_DAYS) throw typedStormglassError('OUT_OF_HORIZON', 'requested date range is outside forecast horizon');
  if (!hasStormglassConfig()) throw typedStormglassError('NOT_CONFIGURED', 'Stormglass forecast is not configured');
  const addDays = (ymd, count) => new Date(Date.parse(`${ymd}T12:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
  const labels = Array.from({ length: days }, (_, i) => addDays(date, i));
  const startHour = input.startHour == null ? 0 : Number(input.startHour);
  const endHour = input.endHour == null ? 24 : Number(input.endHour);
  const customWindow = days === 1 && (startHour !== 0 || endHour !== 24);
  const window = days === 1
    ? getForecastWindow(date, startHour, endHour)
    : { start: madridLocalToUtcZ(date, 0), end: madridLocalToUtcZ(addDays(labels[labels.length - 1], 1), 0) };
  let fetchLabels = labels;
  let fetchWindow = window;
  if (!customWindow) {
    const remaining = FORECAST_HORIZON_DAYS - daysAway + 1;
    const fetchDays = Math.max(days, Math.min(7, remaining));
    fetchLabels = Array.from({ length: fetchDays }, (_, i) => addDays(date, i));
    fetchWindow = { start: madridLocalToUtcZ(date, 0), end: madridLocalToUtcZ(addDays(fetchLabels[fetchLabels.length - 1], 1), 0) };
  }
  const cacheKey = JSON.stringify([locationId, fetchWindow.start, fetchWindow.end]);
  const now = Date.now();
  const diskCache = readPersistentForecastCache();
  const covering = findCoveringWeather(locationId, window, now, diskCache);
  let weatherValue;
  let cacheHit = false;
  if (covering && covering.entry && covering.entry.value) {
    weatherValue = covering.entry.value;
    cacheHit = true;
  } else {
    const qs = new URLSearchParams({ lat: String(location.lat), lng: String(location.lng), params: FORECAST_PARAMS, start: fetchWindow.start, end: fetchWindow.end });
    let response;
    try { response = await stormglassGet(`${STORMGLASS_POINT_URL}?${qs}`, process.env.STORMGLASS_API_KEY.trim(), input.timeoutMs || DEFAULT_TIMEOUT_MS); }
    catch (err) {
      if (err && err.code === 'RATE_LIMITED') throw err;
      throw typedStormglassError(err && err.name === 'AbortError' ? 'TIMEOUT' : 'UPSTREAM_ERROR', 'Stormglass forecast request failed');
    }
    if (!response || response.status < 200 || response.status >= 300) {
      const status = response && response.status;
      const code = status === 401 || status === 402 || status === 403 ? 'ENTITLEMENT_DENIED' : status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR';
      throw typedStormglassError(code, 'Stormglass forecast unavailable', status);
    }
    let payload;
    try { payload = JSON.parse(response.body || '{}'); } catch (_) { throw typedStormglassError('MALFORMED_DATA', 'Stormglass returned invalid forecast data'); }
    if (!Array.isArray(payload.hours) || !payload.hours.length) throw typedStormglassError('UNAVAILABLE', 'Stormglass returned no hourly forecast data');
    const hourly = normalizeHourlyFacts(payload.hours);
    const missing = FORECAST_FIELDS.filter(([, key]) => hourly.every((row) => row[key] == null)).map(([, key]) => key);
    const coverage = missing.length === 0 ? 'complete' : (missing.length === FORECAST_FIELDS.length ? 'unavailable' : 'partial');
    weatherValue = {
      success: coverage !== 'unavailable', source: 'stormglass', location, timezone: location.timezone,
      retrieved_at: new Date().toISOString(), validity: fetchWindow, hourly, coverage,
      days: fetchLabels.map((ymd) => ({ date: ymd, hourly: hourly.filter((row) => localYmdFromIso(row.time) === ymd) })),
      missing_fields: missing, fallback_reason: coverage === 'partial' ? 'missing_fields' : (coverage === 'unavailable' ? 'no_supported_fields' : null),
      units: { wave_height_m: 'm', swell_height_m: 'm', swell_period_s: 's', wind_speed_mps: 'm/s', air_temperature_c: '°C', precipitation_mm_per_h: 'mm/h', cloud_cover_pct: '%', current_speed_mps: 'm/s', tide_height_m: 'm' },
      cache_hit: false,
    };
    persistWeatherCache(cacheKey, now, weatherValue, diskCache);
  }
  const sliced = sliceWeatherToRequest(weatherValue, labels, window);
  const tideLabels = cacheHit ? labels : fetchLabels;
  const tideKeys = tideLabels.map((ymd) => JSON.stringify([location.location_id, ymd]));
  const tideEntries = tideKeys.map((key) => diskCache.tides[key]);
  const missingTideIndexes = tideEntries.map((entry, i) => entry && now - entry.cachedAt < TIDE_CACHE_TTL_MS ? -1 : i).filter((i) => i >= 0);
  let extremes = [];
  let tideAvailability = 'available';
  if (!missingTideIndexes.length) extremes = tideEntries.flatMap((entry) => entry.extremes || []);
  else {
    // A day-keyed cache must be populated with the entire Madrid calendar day,
    // never the caller's narrower "tonight" weather window.
    const firstMissingDay = tideLabels[missingTideIndexes[0]];
    const lastMissingDay = tideLabels[missingTideIndexes[missingTideIndexes.length - 1]];
    const tideWindow = { start: getForecastWindow(firstMissingDay, 0, 24).start, end: getForecastWindow(lastMissingDay, 0, 24).end };
    try {
      const tideQs = new URLSearchParams({ lat: String(location.lat), lng: String(location.lng), start: tideWindow.start, end: tideWindow.end });
      const tideResponse = await stormglassGet(`${STORMGLASS_TIDE_EXTREMES_URL}?${tideQs}`, process.env.STORMGLASS_API_KEY.trim(), input.timeoutMs || DEFAULT_TIMEOUT_MS);
      if (!tideResponse || tideResponse.status < 200 || tideResponse.status >= 300) throw new Error('tide upstream unavailable');
      const tidePayload = JSON.parse(tideResponse.body || '{}');
      const fetched = (Array.isArray(tidePayload.data) ? tidePayload.data : []).map((item) => ({ time: typeof item.time === 'string' ? item.time : null, height_m: Number.isFinite(item.height) ? item.height : null, type: typeof item.type === 'string' ? item.type : null }));
      missingTideIndexes.forEach((i) => { diskCache.tides[tideKeys[i]] = { cachedAt: now, extremes: fetched.filter((item) => localYmdFromIso(item.time) === tideLabels[i]) }; });
      writePersistentForecastCache(diskCache);
      extremes = tideKeys.flatMap((key) => (diskCache.tides[key] && diskCache.tides[key].extremes) || []);
    } catch (_) { tideAvailability = 'unavailable'; }
  }
  const requestedTideKeys = labels.map((ymd) => JSON.stringify([location.location_id, ymd]));
  const requestedExtremes = tideAvailability === 'unavailable'
    ? []
    : requestedTideKeys.flatMap((key) => (diskCache.tides[key] && diskCache.tides[key].extremes) || []);
  return {
    ...sliced,
    tides: { source: 'stormglass_tide_extremes', availability: tideAvailability, extremes: requestedExtremes },
    cache_hit: cacheHit,
  };
}

module.exports = {
  FORECAST_PARAMS,
  FORECAST_HORIZON_DAYS,
  fetchStormglassForecast,
  clearStormglassForecastCacheForTests,
  STORMGLASS_POINT_URL,
  STORMGLASS_TIDE_EXTREMES_URL,
  STORMGLASS_PARAMS,
  DEFAULT_TIMEOUT_MS,
  MADRID_TZ,
  SURF_WINDOW_START_HOUR,
  SURF_WINDOW_END_HOUR,
  setStormglassFetchForTests,
  setStormglassRequestForTests,
  setStormglassBudgetReadForTests,
  setStormglassNowMsForTests,
  stormglassHttpsGet,
  stormglassErrorBodySnippet,
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
