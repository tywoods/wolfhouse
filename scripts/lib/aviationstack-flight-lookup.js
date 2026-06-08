/**
 * Phase 26e — Aviationstack flight lookup provider (foundation only).
 *
 * No transfer DB writes, no Staff Portal lookup button, no raw payload storage.
 *
 * @module aviationstack-flight-lookup
 */

'use strict';

const crypto = require('crypto');

const PROVIDER = 'aviationstack';
const ENV_KEY = 'AVIATIONSTACK_API_KEY';
const FLIGHTS_BASE_URL = 'https://api.aviationstack.com/v1/flights';
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
 * @returns {{ access_key: string, key_source: string|null }}
 */
function resolveAviationstackConfig(env = process.env) {
  const raw = env && env[ENV_KEY];
  const access_key = trimStr(raw);
  return {
    access_key,
    key_source: access_key ? ENV_KEY : null,
  };
}

/**
 * Safe status for operator diagnostics (no raw key, no live API call).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   configured: boolean,
 *   provider: string,
 *   key_present: boolean,
 *   key_source: string,
 *   key_fingerprint: string|null,
 * }}
 */
function getAviationstackStatus(env = process.env) {
  const cfg = resolveAviationstackConfig(env);
  const key_present = !!cfg.access_key;
  return {
    configured: key_present,
    provider: PROVIDER,
    key_present,
    key_source: ENV_KEY,
    key_fingerprint: hashKeyFingerprint(cfg.access_key),
  };
}

/**
 * @param {string|null|undefined} flight_number
 * @returns {string|null}
 */
function normalizeFlightNumberForLookup(flight_number) {
  const s = trimStr(flight_number).replace(/\s+/g, '').toUpperCase();
  return s || null;
}

/**
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function normalizeFlightDate(value) {
  const s = trimStr(value);
  if (!DATE_RE.test(s)) return null;
  return s;
}

/**
 * @param {{ access_key: string, flight_number: string, flight_date: string, limit?: number }} opts
 * @returns {string}
 */
function buildAviationstackFlightsUrl(opts = {}) {
  const access_key = trimStr(opts.access_key);
  const flight_number = normalizeFlightNumberForLookup(opts.flight_number);
  const flight_date = normalizeFlightDate(opts.flight_date);
  const limit = Math.max(1, Math.min(Number(opts.limit) || DEFAULT_LIMIT, 100));
  if (!access_key || !flight_number || !flight_date) {
    throw new Error('access_key, flight_number, and flight_date are required');
  }
  const params = new URLSearchParams({
    access_key,
    flight_iata: flight_number,
    flight_date,
    limit: String(limit),
  });
  return `${FLIGHTS_BASE_URL}?${params.toString()}`;
}

/**
 * @param {object|null|undefined} row
 * @returns {object|null}
 */
function sanitizeFlightCandidate(row) {
  if (!row || typeof row !== 'object') return null;
  const dep = row.departure || {};
  const arr = row.arrival || {};
  const flight = row.flight || {};
  const airline = row.airline || {};
  return {
    flight_iata: trimStr(flight.iata) || null,
    airline_name: trimStr(airline.name) || null,
    flight_status: trimStr(row.flight_status) || null,
    departure_airport: trimStr(dep.airport) || null,
    departure_iata: trimStr(dep.iata).toUpperCase() || null,
    departure_scheduled: trimStr(dep.scheduled) || null,
    departure_estimated: trimStr(dep.estimated) || null,
    arrival_airport: trimStr(arr.airport) || null,
    arrival_iata: trimStr(arr.iata).toUpperCase() || null,
    arrival_scheduled: trimStr(arr.scheduled) || null,
    arrival_estimated: trimStr(arr.estimated) || null,
    arrival_terminal: trimStr(arr.terminal) || null,
    arrival_gate: trimStr(arr.gate) || null,
  };
}

/**
 * @param {object[]} candidates
 * @param {{ direction?: string, airport_code?: string|null }} opts
 * @returns {object|null}
 */
function pickBestFlightMatch(candidates, opts = {}) {
  const list = (candidates || []).filter(Boolean);
  if (list.length === 0) return null;
  const direction = trimStr(opts.direction).toLowerCase();
  const airport = trimStr(opts.airport_code).toUpperCase();
  if (airport) {
    if (direction === 'arrival') {
      const match = list.find((c) => c.arrival_iata === airport);
      if (match) return match;
    }
    if (direction === 'departure') {
      const match = list.find((c) => c.departure_iata === airport);
      if (match) return match;
    }
  }
  return list[0];
}

/**
 * @param {object} body
 * @returns {object[]}
 */
function extractFlightRows(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.results)) return body.results;
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
async function lookupAviationstackFlight(opts = {}) {
  const flight_number = normalizeFlightNumberForLookup(opts.flight_number);
  const flight_date = normalizeFlightDate(opts.flight_date);
  if (!flight_number || !flight_date) {
    return { success: false, error: 'flight_number_and_date_required' };
  }

  const cfg = resolveAviationstackConfig(opts.env || process.env);
  if (!cfg.access_key) {
    return { success: false, error: 'aviationstack_not_configured' };
  }

  const fetchFn = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!fetchFn) {
    return { success: false, error: 'fetch_unavailable' };
  }

  let url;
  try {
    url = buildAviationstackFlightsUrl({
      access_key: cfg.access_key,
      flight_number,
      flight_date,
      limit: DEFAULT_LIMIT,
    });
  } catch (err) {
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
      headers: { Accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    return { success: false, error: 'aviationstack_request_failed' };
  }
  if (timer) clearTimeout(timer);

  let body;
  try {
    body = await response.json();
  } catch {
    return { success: false, error: 'aviationstack_invalid_response' };
  }

  if (!response.ok || (body && body.error)) {
    return { success: false, error: 'aviationstack_api_error' };
  }

  const sanitized = extractFlightRows(body)
    .map(sanitizeFlightCandidate)
    .filter(Boolean);

  if (sanitized.length === 0) {
    return { success: false, error: 'flight_not_found' };
  }

  const best_match = pickBestFlightMatch(sanitized, {
    direction: opts.direction,
    airport_code: opts.airport_code,
  });

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
  FLIGHTS_BASE_URL,
  resolveAviationstackConfig,
  getAviationstackStatus,
  normalizeFlightNumberForLookup,
  buildAviationstackFlightsUrl,
  lookupAviationstackFlight,
  sanitizeFlightCandidate,
  pickBestFlightMatch,
  hashKeyFingerprint,
};
