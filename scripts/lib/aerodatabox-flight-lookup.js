/**
 * Phase 26i — AeroDataBox flight lookup provider (API.Market).
 *
 * No transfer DB writes, no raw payload storage.
 *
 * @module aerodatabox-flight-lookup
 */

'use strict';

const crypto = require('crypto');
const { pickBestFlightMatch } = require('./aviationstack-flight-lookup');

const PROVIDER = 'aerodatabox';
const ENV_KEY = 'AERODATABOX_API_KEY';
const API_MARKET_BASE_URL = 'https://prod.api.market/api/v1/aedbx/aerodatabox';
const DEFAULT_LIMIT = 5;
const DEFAULT_TIMEOUT_MS = 15000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function hashKeyFingerprint(apiKey) {
  if (!apiKey) return null;
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 8);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ api_key: string, key_source: string|null }}
 */
function resolveAeroDataBoxConfig(env = process.env) {
  const raw = env && env[ENV_KEY];
  const api_key = trimStr(raw);
  return {
    api_key,
    key_source: api_key ? ENV_KEY : null,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function getAeroDataBoxStatus(env = process.env) {
  const cfg = resolveAeroDataBoxConfig(env);
  const key_present = !!cfg.api_key;
  return {
    configured: key_present,
    provider: PROVIDER,
    key_present,
    key_source: ENV_KEY,
    key_fingerprint: hashKeyFingerprint(cfg.api_key),
  };
}

function normalizeFlightNumberForLookup(flight_number) {
  const s = trimStr(flight_number).replace(/\s+/g, '').toUpperCase();
  return s || null;
}

function normalizeFlightDate(value) {
  const s = trimStr(value);
  if (!DATE_RE.test(s)) return null;
  return s;
}

function addDaysDateOnly(dateStr, deltaDays) {
  const s = trimStr(dateStr);
  if (!DATE_RE.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function dateLocalRoleForDirection(direction) {
  const dir = trimStr(direction).toLowerCase();
  if (dir === 'arrival') return 'Arrival';
  if (dir === 'departure') return 'Departure';
  return 'Both';
}

/**
 * Build AeroDataBox flight lookup URL (auth via Ocp-Apim-Subscription-Key header).
 *
 * Uses range endpoint: GET /flights/number/{flight}/{dateFrom}/{dateTo}?dateLocalRole=...
 *
 * @param {{ flight_number: string, flight_date: string, direction?: string, date_to?: string|null }} opts
 * @returns {string}
 */
function buildAeroDataBoxFlightUrl(opts = {}) {
  const flight_number = normalizeFlightNumberForLookup(opts.flight_number);
  const flight_date = normalizeFlightDate(opts.flight_date);
  const date_from = flight_date;
  const date_to = normalizeFlightDate(opts.date_to) || addDaysDateOnly(flight_date, 1) || flight_date;
  if (!flight_number || !date_from) {
    throw new Error('flight_number and flight_date are required');
  }
  const role = dateLocalRoleForDirection(opts.direction);
  const path = `/flights/number/${encodeURIComponent(flight_number)}/${encodeURIComponent(date_from)}/${encodeURIComponent(date_to)}`;
  return `${API_MARKET_BASE_URL}${path}?dateLocalRole=${encodeURIComponent(role)}`;
}

function buildAeroDataBoxAuthHeaders(apiKey) {
  return {
    Accept: 'application/json',
    'Ocp-Apim-Subscription-Key': trimStr(apiKey),
  };
}

function movementTimeValue(dt) {
  if (!dt) return null;
  if (typeof dt === 'string') return dt;
  if (typeof dt === 'object') return trimStr(dt.utc) || trimStr(dt.local) || null;
  return null;
}

function movementScheduled(m) {
  if (!m) return null;
  return movementTimeValue(m.scheduledTime);
}

function movementEstimated(m) {
  if (!m) return null;
  return movementTimeValue(m.revisedTime)
    || movementTimeValue(m.predictedTime)
    || movementTimeValue(m.runwayTime)
    || null;
}

/**
 * @param {object|null|undefined} row AeroDataBox FlightContract
 * @returns {object|null}
 */
function sanitizeFlightCandidate(row) {
  if (!row || typeof row !== 'object') return null;
  const dep = row.departure || {};
  const arr = row.arrival || {};
  const depAirport = dep.airport || {};
  const arrAirport = arr.airport || {};
  const airline = row.airline || {};
  const flightNum = normalizeFlightNumberForLookup(row.number) || trimStr(row.number).toUpperCase() || null;
  return {
    flight_iata: flightNum,
    airline_name: trimStr(airline.name) || null,
    flight_status: trimStr(row.status) || null,
    departure_airport: trimStr(depAirport.name) || trimStr(depAirport.shortName) || null,
    departure_iata: trimStr(depAirport.iata).toUpperCase() || null,
    departure_scheduled: movementScheduled(dep),
    departure_estimated: movementEstimated(dep),
    arrival_airport: trimStr(arrAirport.name) || trimStr(arrAirport.shortName) || null,
    arrival_iata: trimStr(arrAirport.iata).toUpperCase() || null,
    arrival_scheduled: movementScheduled(arr),
    arrival_estimated: movementEstimated(arr),
    arrival_terminal: trimStr(arr.terminal) || null,
    arrival_gate: trimStr(arr.gate) || null,
  };
}

function sanitizeProviderError(body) {
  if (!body) return { provider_error_code: null, provider_error_type: null };
  if (typeof body === 'string') {
    const s = trimStr(body).slice(0, 120);
    return { provider_error_code: s || null, provider_error_type: null };
  }
  if (typeof body === 'object') {
    const msg = trimStr(body.message || body.error || body.title || '').slice(0, 120);
    return {
      provider_error_code: msg || null,
      provider_error_type: trimStr(body.statusCode || body.code || '').slice(0, 64) || null,
    };
  }
  return { provider_error_code: null, provider_error_type: null };
}

function classifyAeroDataBoxFailure(httpStatus, body) {
  const safe = sanitizeProviderError(body);
  const status = httpStatus != null ? Number(httpStatus) : null;
  const blob = JSON.stringify(body || {}).toLowerCase();

  if (status === 401) {
    return { error: 'aerodatabox_auth_error', http_status: status, ...safe };
  }
  if (status === 429) {
    return { error: 'aerodatabox_rate_limited', http_status: status, ...safe };
  }
  if (status === 403) {
    return { error: 'aerodatabox_quota_or_plan_error', http_status: status, ...safe };
  }
  if (status === 400 || (body && (body.message || body.error))) {
    if (/quota|subscription|plan|limit|usage|tier|forbidden|not authorized|payment required/.test(blob)) {
      return { error: 'aerodatabox_quota_or_plan_error', http_status: status || 200, ...safe };
    }
    if (/invalid.*key|authentication|unauthorized|access denied|subscription key/.test(blob)) {
      return { error: 'aerodatabox_auth_error', http_status: status || 200, ...safe };
    }
    return { error: 'aerodatabox_bad_request', http_status: status || 200, ...safe };
  }
  return { error: 'aerodatabox_api_error', http_status: status, ...safe };
}

function extractFlightRows(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    if (Array.isArray(body.data)) return body.data;
    if (Array.isArray(body.results)) return body.results;
  }
  return [];
}

/**
 * @param {{
 *   flight_number: string,
 *   flight_date: string,
 *   direction?: string,
 *   airport_code?: string|null,
 *   env?: NodeJS.ProcessEnv,
 *   fetchImpl?: typeof fetch,
 *   timeout_ms?: number,
 * }} opts
 * @returns {Promise<object>}
 */
async function lookupAeroDataBoxFlight(opts = {}) {
  const flight_number = normalizeFlightNumberForLookup(opts.flight_number);
  const flight_date = normalizeFlightDate(opts.flight_date);
  if (!flight_number || !flight_date) {
    return { success: false, error: 'flight_number_and_date_required' };
  }

  const cfg = resolveAeroDataBoxConfig(opts.env || process.env);
  if (!cfg.api_key) {
    return {
      success: false,
      error: 'aerodatabox_not_configured',
      http_status: null,
      provider_error_code: null,
      provider_error_type: null,
    };
  }

  const fetchFn = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!fetchFn) {
    return { success: false, error: 'fetch_unavailable' };
  }

  let url;
  try {
    url = buildAeroDataBoxFlightUrl({
      flight_number,
      flight_date,
      direction: opts.direction,
    });
  } catch {
    return { success: false, error: 'invalid_lookup_request' };
  }

  const timeoutMs = Number(opts.timeout_ms) || DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  let response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: buildAeroDataBoxAuthHeaders(cfg.api_key),
      signal: controller ? controller.signal : undefined,
    });
  } catch {
    if (timer) clearTimeout(timer);
    return { success: false, error: 'aerodatabox_request_failed' };
  }
  if (timer) clearTimeout(timer);

  if (response.status === 204) {
    return {
      success: false,
      error: 'flight_not_found',
      http_status: 204,
      provider_error_code: null,
      provider_error_type: null,
      raw_payload_stored: false,
    };
  }

  let body;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : [];
  } catch {
    return { success: false, error: 'aerodatabox_invalid_response' };
  }

  if (!response.ok) {
    const classified = classifyAeroDataBoxFailure(response.status, body);
    return { success: false, ...classified, raw_payload_stored: false };
  }

  const sanitized = extractFlightRows(body)
    .map(sanitizeFlightCandidate)
    .filter(Boolean);

  if (sanitized.length === 0) {
    return {
      success: false,
      error: 'flight_not_found',
      http_status: response.status,
      provider_error_code: null,
      provider_error_type: null,
      raw_payload_stored: false,
    };
  }

  const best_match = pickBestFlightMatch(sanitized, {
    direction: opts.direction,
    airport_code: opts.airport_code,
  });

  if (!best_match && trimStr(opts.airport_code)) {
    return {
      success: false,
      error: 'airport_mismatch',
      http_status: response.status,
      provider_error_code: null,
      provider_error_type: null,
      match_count: sanitized.length,
      raw_payload_stored: false,
    };
  }

  return {
    success: true,
    provider: PROVIDER,
    flight_number,
    flight_date,
    match_count: sanitized.length,
    best_match,
    candidates: sanitized.slice(0, DEFAULT_LIMIT),
    raw_payload_stored: false,
  };
}

module.exports = {
  PROVIDER,
  ENV_KEY,
  API_MARKET_BASE_URL,
  resolveAeroDataBoxConfig,
  getAeroDataBoxStatus,
  normalizeFlightNumberForLookup,
  buildAeroDataBoxFlightUrl,
  buildAeroDataBoxAuthHeaders,
  lookupAeroDataBoxFlight,
  sanitizeFlightCandidate,
  hashKeyFingerprint,
  classifyAeroDataBoxFailure,
  sanitizeProviderError,
  addDaysDateOnly,
};
