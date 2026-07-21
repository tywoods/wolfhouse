'use strict';

/**
 * radar-g06-bounded-load-harness — dependency-free Node load harness for G06.
 *
 * Hard-locked to the two exact staging Staff API /readyz URLs.
 * GET only; no headers/body/auth; no redirects; TLS required; fail-closed on
 * any other target. Emits aggregate counts + latency percentiles + timeout/
 * error/status classes without response bodies.
 *
 * Live drill is NOT executed by RADAR 16AG — FUTURE_DRILL_PROFILE is defined
 * only. Offline verifiers may inject `transport` to exercise accounting against
 * a local fake server after the logical target passes the allowlist.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const WH_READYZ_URL = 'https://staff-staging.lunafrontdesk.com/readyz';
const SUNSET_READYZ_URL = 'https://sunset-staging.lunafrontdesk.com/readyz';

const ALLOWED_TARGETS = Object.freeze([WH_READYZ_URL, SUNSET_READYZ_URL]);
const ALLOWED_TARGET_SET = new Set(ALLOWED_TARGETS);

const HARNESS_BOUNDS = Object.freeze({
  MAX_CONCURRENCY: 4,
  MAX_DURATION_MS: 60_000,
  MAX_REQUESTS: 120,
  MAX_REQUEST_TIMEOUT_MS: 10_000,
  MIN_REQUEST_TIMEOUT_MS: 500,
  MIN_CONCURRENCY: 1,
  MIN_DURATION_MS: 1_000,
  MIN_REQUESTS: 1,
});

/** Conservative future dual-staging /readyz drill — defined, not executed by 16AG. */
const FUTURE_DRILL_PROFILE = Object.freeze({
  id: '16AG_DRILL_dual_staging_readyz_bounded_load',
  status: 'defined_not_executed',
  method: 'GET',
  targets: ALLOWED_TARGETS,
  concurrency: 2,
  max_duration_ms: 30_000,
  max_requests: 60,
  request_timeout_ms: 4_000,
  max_redirects: 0,
  tls_required: true,
  headers: null,
  body: null,
  auth: null,
  follow_redirects: false,
  collect_response_bodies: false,
  note:
    'Conservative future drill profile only. 16AG does not execute network calls, '
    + 'deploy, alter scaling, or claim SLO/backpressure/load-soak proof.',
});

const STATUS_CLASSES = Object.freeze([
  '2xx',
  '3xx',
  '4xx',
  '5xx',
  'timeout',
  'error',
  'other',
]);

function assertAllowedTarget(targetUrl) {
  if (typeof targetUrl !== 'string' || !ALLOWED_TARGET_SET.has(targetUrl)) {
    const err = new Error(
      `fail_closed: target not in hard-locked staging /readyz allowlist: ${String(targetUrl)}`,
    );
    err.code = 'RADAR_LOAD_TARGET_REJECTED';
    throw err;
  }
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    const err = new Error(`fail_closed: invalid target URL: ${String(targetUrl)}`);
    err.code = 'RADAR_LOAD_TARGET_REJECTED';
    throw err;
  }
  if (parsed.protocol !== 'https:') {
    const err = new Error('fail_closed: TLS required (https only)');
    err.code = 'RADAR_LOAD_TLS_REQUIRED';
    throw err;
  }
  if (parsed.pathname !== '/readyz' || parsed.search || parsed.hash) {
    const err = new Error('fail_closed: only exact /readyz path allowed');
    err.code = 'RADAR_LOAD_TARGET_REJECTED';
    throw err;
  }
  return parsed;
}

function clampProfile(profile) {
  const src = profile && typeof profile === 'object' ? profile : {};
  const concurrency = Number(src.concurrency);
  const maxDurationMs = Number(src.max_duration_ms);
  const maxRequests = Number(src.max_requests);
  const requestTimeoutMs = Number(src.request_timeout_ms);

  if (!Number.isInteger(concurrency)
    || concurrency < HARNESS_BOUNDS.MIN_CONCURRENCY
    || concurrency > HARNESS_BOUNDS.MAX_CONCURRENCY) {
    const err = new Error(
      `fail_closed: concurrency out of bounds [${HARNESS_BOUNDS.MIN_CONCURRENCY}..${HARNESS_BOUNDS.MAX_CONCURRENCY}]`,
    );
    err.code = 'RADAR_LOAD_BOUNDS';
    throw err;
  }
  if (!Number.isInteger(maxDurationMs)
    || maxDurationMs < HARNESS_BOUNDS.MIN_DURATION_MS
    || maxDurationMs > HARNESS_BOUNDS.MAX_DURATION_MS) {
    const err = new Error(
      `fail_closed: max_duration_ms out of bounds [${HARNESS_BOUNDS.MIN_DURATION_MS}..${HARNESS_BOUNDS.MAX_DURATION_MS}]`,
    );
    err.code = 'RADAR_LOAD_BOUNDS';
    throw err;
  }
  if (!Number.isInteger(maxRequests)
    || maxRequests < HARNESS_BOUNDS.MIN_REQUESTS
    || maxRequests > HARNESS_BOUNDS.MAX_REQUESTS) {
    const err = new Error(
      `fail_closed: max_requests out of bounds [${HARNESS_BOUNDS.MIN_REQUESTS}..${HARNESS_BOUNDS.MAX_REQUESTS}]`,
    );
    err.code = 'RADAR_LOAD_BOUNDS';
    throw err;
  }
  if (!Number.isInteger(requestTimeoutMs)
    || requestTimeoutMs < HARNESS_BOUNDS.MIN_REQUEST_TIMEOUT_MS
    || requestTimeoutMs > HARNESS_BOUNDS.MAX_REQUEST_TIMEOUT_MS) {
    const err = new Error(
      `fail_closed: request_timeout_ms out of bounds `
      + `[${HARNESS_BOUNDS.MIN_REQUEST_TIMEOUT_MS}..${HARNESS_BOUNDS.MAX_REQUEST_TIMEOUT_MS}]`,
    );
    err.code = 'RADAR_LOAD_BOUNDS';
    throw err;
  }
  if (src.method != null && String(src.method).toUpperCase() !== 'GET') {
    const err = new Error('fail_closed: GET only');
    err.code = 'RADAR_LOAD_METHOD';
    throw err;
  }
  if (src.headers != null && (
    (typeof src.headers === 'object' && Object.keys(src.headers).length > 0)
    || typeof src.headers !== 'object'
  )) {
    const err = new Error('fail_closed: no custom headers allowed');
    err.code = 'RADAR_LOAD_HEADERS';
    throw err;
  }
  if (src.body != null && src.body !== '') {
    const err = new Error('fail_closed: no request body allowed');
    err.code = 'RADAR_LOAD_BODY';
    throw err;
  }
  if (src.auth != null && src.auth !== false) {
    const err = new Error('fail_closed: no auth allowed');
    err.code = 'RADAR_LOAD_AUTH';
    throw err;
  }
  if (src.follow_redirects === true || Number(src.max_redirects) > 0) {
    const err = new Error('fail_closed: redirects forbidden');
    err.code = 'RADAR_LOAD_REDIRECTS';
    throw err;
  }
  if (src.collect_response_bodies === true) {
    const err = new Error('fail_closed: response bodies must not be collected');
    err.code = 'RADAR_LOAD_BODIES';
    throw err;
  }

  return Object.freeze({
    concurrency,
    max_duration_ms: maxDurationMs,
    max_requests: maxRequests,
    request_timeout_ms: requestTimeoutMs,
    method: 'GET',
    headers: null,
    body: null,
    auth: null,
    follow_redirects: false,
    max_redirects: 0,
    tls_required: true,
    collect_response_bodies: false,
  });
}

function statusClassFor(outcome) {
  if (outcome.kind === 'timeout') return 'timeout';
  if (outcome.kind === 'error') return 'error';
  const code = outcome.status_code;
  if (typeof code !== 'number') return 'other';
  if (code >= 200 && code < 300) return '2xx';
  if (code >= 300 && code < 400) return '3xx';
  if (code >= 400 && code < 500) return '4xx';
  if (code >= 500 && code < 600) return '5xx';
  return 'other';
}

function percentileNearestRank(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

function summarizeLatencies(latenciesMs) {
  const sorted = latenciesMs.slice().sort((a, b) => a - b);
  return Object.freeze({
    count: sorted.length,
    p50_ms: percentileNearestRank(sorted, 50),
    p95_ms: percentileNearestRank(sorted, 95),
    p99_ms: percentileNearestRank(sorted, 99),
    max_ms: sorted.length ? sorted[sorted.length - 1] : null,
  });
}

function emptyStatusCounts() {
  const out = {};
  for (const k of STATUS_CLASSES) out[k] = 0;
  return out;
}

function defaultHttpsTransport(targetUrl, timeoutMs) {
  return new Promise((resolve) => {
    const parsed = new URL(targetUrl);
    const started = Date.now();
    const req = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname,
      method: 'GET',
      headers: {},
      timeout: timeoutMs,
      // Do not follow redirects; https.request never auto-follows.
      maxRedirects: 0,
    }, (res) => {
      // Drain without retaining body bytes in aggregate output.
      res.on('data', () => {});
      res.on('end', () => {
        resolve({
          kind: 'status',
          status_code: res.statusCode,
          latency_ms: Date.now() - started,
          redirected: false,
        });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({
        kind: 'timeout',
        status_code: null,
        latency_ms: Date.now() - started,
        redirected: false,
      });
    });
    req.on('error', (err) => {
      resolve({
        kind: 'error',
        status_code: null,
        latency_ms: Date.now() - started,
        redirected: false,
        error_code: err && err.code ? String(err.code) : 'ERROR',
      });
    });
    req.end();
  });
}

/**
 * Run a bounded load against one hard-locked staging /readyz URL.
 *
 * @param {object} options
 * @param {string} options.target Exact allowlisted URL
 * @param {object} [options.profile] Bounds (defaults to FUTURE_DRILL_PROFILE numeric fields)
 * @param {function} [options.transport] Optional injectable transport(url, timeoutMs)→Promise
 *   Used only by offline verifiers; live default is https GET with no redirects/headers/body.
 * @returns {Promise<object>} Aggregate report (no response bodies)
 */
async function runBoundedLoad(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const target = opts.target;
  assertAllowedTarget(target);

  const profile = clampProfile({
    concurrency: FUTURE_DRILL_PROFILE.concurrency,
    max_duration_ms: FUTURE_DRILL_PROFILE.max_duration_ms,
    max_requests: FUTURE_DRILL_PROFILE.max_requests,
    request_timeout_ms: FUTURE_DRILL_PROFILE.request_timeout_ms,
    method: 'GET',
    headers: null,
    body: null,
    auth: null,
    follow_redirects: false,
    max_redirects: 0,
    collect_response_bodies: false,
    ...(opts.profile || {}),
  });

  const transport = typeof opts.transport === 'function'
    ? opts.transport
    : defaultHttpsTransport;

  const status_counts = emptyStatusCounts();
  const latencies = [];
  let started = 0;
  let completed = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let stopReason = null;
  const wallStart = Date.now();
  const deadline = wallStart + profile.max_duration_ms;

  function record(outcome) {
    completed += 1;
    const cls = statusClassFor(outcome);
    status_counts[cls] += 1;
    if (typeof outcome.latency_ms === 'number' && Number.isFinite(outcome.latency_ms)) {
      latencies.push(outcome.latency_ms);
    }
  }

  async function worker() {
    while (true) {
      if (Date.now() >= deadline) {
        stopReason = stopReason || 'max_duration';
        return;
      }
      if (started >= profile.max_requests) {
        stopReason = stopReason || 'max_requests';
        return;
      }
      started += 1;
      inFlight += 1;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      let outcome;
      try {
        outcome = await transport(target, profile.request_timeout_ms);
        if (!outcome || typeof outcome !== 'object') {
          outcome = { kind: 'error', status_code: null, latency_ms: 0, error_code: 'BAD_TRANSPORT' };
        }
        // Hard rule: never follow redirects even if a transport returns Location.
        if (outcome.redirected === true) {
          outcome = {
            kind: 'status',
            status_code: typeof outcome.status_code === 'number' ? outcome.status_code : 302,
            latency_ms: outcome.latency_ms || 0,
            redirected: true,
          };
        }
      } catch (err) {
        outcome = {
          kind: 'error',
          status_code: null,
          latency_ms: 0,
          error_code: err && err.code ? String(err.code) : 'THROW',
        };
      }
      inFlight -= 1;
      record(outcome);
    }
  }

  const workers = [];
  for (let i = 0; i < profile.concurrency; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  if (!stopReason) stopReason = 'drained';

  const latency = summarizeLatencies(latencies);
  return Object.freeze({
    target,
    method: 'GET',
    profile,
    started,
    completed,
    peak_in_flight: peakInFlight,
    wall_ms: Date.now() - wallStart,
    stop_reason: stopReason,
    status_counts: Object.freeze({ ...status_counts }),
    latency,
    response_bodies_collected: false,
    redirects_followed: false,
    headers_sent: false,
    auth_sent: false,
    body_sent: false,
  });
}

/**
 * Validate a candidate profile against harness bounds without executing requests.
 */
function validateProfileOnly(profile) {
  return clampProfile(profile);
}

module.exports = {
  WH_READYZ_URL,
  SUNSET_READYZ_URL,
  ALLOWED_TARGETS,
  HARNESS_BOUNDS,
  FUTURE_DRILL_PROFILE,
  STATUS_CLASSES,
  assertAllowedTarget,
  clampProfile,
  validateProfileOnly,
  statusClassFor,
  percentileNearestRank,
  summarizeLatencies,
  runBoundedLoad,
  // Exported for offline verifier fake-server wiring only; not a live escape hatch.
  _defaultHttpsTransport: defaultHttpsTransport,
  _http: http,
  _https: https,
};
