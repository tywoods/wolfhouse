'use strict';

/**
 * radar-g06-bounded-load-harness — dependency-free Node load harness for G06.
 *
 * Hard-locked to the two exact staging Staff API /readyz URLs.
 * GET only; no headers/body/auth; no redirects; TLS required; fail-closed on
 * any other target. Production runBoundedLoad uses an unexported fixed HTTPS
 * transport only (no caller transport escape), pins validated public DNS
 * before requests, owns one absolute run deadline + per-request deadline,
 * aborts/destroys actives on deadline, and settles end/aborted/error/
 * premature-close/trickle paths. Latency is measured with monotonic time;
 * transport-supplied latency values are ignored.
 *
 * Live drill is NOT executed by RADAR 16AG — FUTURE_DRILL_PROFILE is defined
 * only. Offline verifiers must use runBoundedLoadOffline with OFFLINE_SEAL
 * after fail-closing real http/https/net/DNS.
 */

const https = require('https');
const dns = require('dns');
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

/** Opaque seal required for offline verifier request/DNS injection. */
const OFFLINE_SEAL = Symbol('RADAR_G06_OFFLINE_SEAL');

const NS_PER_MS = 1_000_000n;

function monoNowNs() {
  return process.hrtime.bigint();
}

function msBetween(startNs, endNs) {
  const delta = endNs - startNs;
  if (delta <= 0n) return 0;
  return Number(delta / NS_PER_MS);
}

function failClosed(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function assertAllowedTarget(targetUrl) {
  if (typeof targetUrl !== 'string' || !ALLOWED_TARGET_SET.has(targetUrl)) {
    failClosed(
      'RADAR_LOAD_TARGET_REJECTED',
      `fail_closed: target not in hard-locked staging /readyz allowlist: ${String(targetUrl)}`,
    );
  }
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    failClosed('RADAR_LOAD_TARGET_REJECTED', `fail_closed: invalid target URL: ${String(targetUrl)}`);
  }
  if (parsed.protocol !== 'https:') {
    failClosed('RADAR_LOAD_TLS_REQUIRED', 'fail_closed: TLS required (https only)');
  }
  if (parsed.pathname !== '/readyz' || parsed.search || parsed.hash) {
    failClosed('RADAR_LOAD_TARGET_REJECTED', 'fail_closed: only exact /readyz path allowed');
  }
  return parsed;
}

function rejectCallerTransportEscape(opts) {
  if (!opts || typeof opts !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(opts, 'transport') && opts.transport != null) {
    failClosed(
      'RADAR_LOAD_TRANSPORT_ESCAPE',
      'fail_closed: caller transport escape forbidden; production uses fixed HTTPS transport only',
    );
  }
  if (Object.prototype.hasOwnProperty.call(opts, 'agent') && opts.agent != null) {
    failClosed('RADAR_LOAD_TRANSPORT_ESCAPE', 'fail_closed: caller agent escape forbidden');
  }
  if (Object.prototype.hasOwnProperty.call(opts, 'lookup') && opts.lookup != null) {
    failClosed('RADAR_LOAD_TRANSPORT_ESCAPE', 'fail_closed: caller lookup escape forbidden');
  }
  if (Object.prototype.hasOwnProperty.call(opts, 'httpsRequest') && opts.httpsRequest != null) {
    failClosed('RADAR_LOAD_TRANSPORT_ESCAPE', 'fail_closed: caller httpsRequest escape forbidden');
  }
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
    failClosed(
      'RADAR_LOAD_BOUNDS',
      `fail_closed: concurrency out of bounds [${HARNESS_BOUNDS.MIN_CONCURRENCY}..${HARNESS_BOUNDS.MAX_CONCURRENCY}]`,
    );
  }
  if (!Number.isInteger(maxDurationMs)
    || maxDurationMs < HARNESS_BOUNDS.MIN_DURATION_MS
    || maxDurationMs > HARNESS_BOUNDS.MAX_DURATION_MS) {
    failClosed(
      'RADAR_LOAD_BOUNDS',
      `fail_closed: max_duration_ms out of bounds [${HARNESS_BOUNDS.MIN_DURATION_MS}..${HARNESS_BOUNDS.MAX_DURATION_MS}]`,
    );
  }
  if (!Number.isInteger(maxRequests)
    || maxRequests < HARNESS_BOUNDS.MIN_REQUESTS
    || maxRequests > HARNESS_BOUNDS.MAX_REQUESTS) {
    failClosed(
      'RADAR_LOAD_BOUNDS',
      `fail_closed: max_requests out of bounds [${HARNESS_BOUNDS.MIN_REQUESTS}..${HARNESS_BOUNDS.MAX_REQUESTS}]`,
    );
  }
  if (!Number.isInteger(requestTimeoutMs)
    || requestTimeoutMs < HARNESS_BOUNDS.MIN_REQUEST_TIMEOUT_MS
    || requestTimeoutMs > HARNESS_BOUNDS.MAX_REQUEST_TIMEOUT_MS) {
    failClosed(
      'RADAR_LOAD_BOUNDS',
      `fail_closed: request_timeout_ms out of bounds `
      + `[${HARNESS_BOUNDS.MIN_REQUEST_TIMEOUT_MS}..${HARNESS_BOUNDS.MAX_REQUEST_TIMEOUT_MS}]`,
    );
  }
  if (src.method != null && String(src.method).toUpperCase() !== 'GET') {
    failClosed('RADAR_LOAD_METHOD', 'fail_closed: GET only');
  }
  if (src.headers != null && (
    (typeof src.headers === 'object' && Object.keys(src.headers).length > 0)
    || typeof src.headers !== 'object'
  )) {
    failClosed('RADAR_LOAD_HEADERS', 'fail_closed: no custom headers allowed');
  }
  if (src.body != null && src.body !== '') {
    failClosed('RADAR_LOAD_BODY', 'fail_closed: no request body allowed');
  }
  if (src.auth != null && src.auth !== false) {
    failClosed('RADAR_LOAD_AUTH', 'fail_closed: no auth allowed');
  }
  if (src.follow_redirects === true || Number(src.max_redirects) > 0) {
    failClosed('RADAR_LOAD_REDIRECTS', 'fail_closed: redirects forbidden');
  }
  if (src.collect_response_bodies === true) {
    failClosed('RADAR_LOAD_BODIES', 'fail_closed: response bodies must not be collected');
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

function parseIpv4(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  const nums = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

/**
 * True only for globally routable unicast addresses (fail-closed otherwise).
 * Rejects loopback, RFC1918, link-local, CGNAT, unspecified, multicast, and
 * IPv6 ULA/link-local/loopback/mapped-private.
 */
function isPublicIp(address) {
  const raw = String(address || '').trim().toLowerCase();
  if (!raw) return false;

  if (raw.includes(':')) {
    if (raw === '::' || raw === '::1') return false;
    if (raw.startsWith('fe80:') || raw.startsWith('fc') || raw.startsWith('fd')) return false;
    const v4mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4mapped) return isPublicIp(v4mapped[1]);
    // Other IPv6: accept only if it does not look like local/special; keep narrow.
    if (raw.startsWith('ff')) return false; // multicast
    return true;
  }

  const n = parseIpv4(raw);
  if (!n) return false;
  const [a, b] = n;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a >= 224) return false; // multicast / reserved
  return true;
}

function assertPublicDnsAddresses(addresses) {
  const list = Array.isArray(addresses) ? addresses : [];
  if (!list.length) {
    failClosed('RADAR_LOAD_DNS', 'fail_closed: DNS returned no addresses');
  }
  const publicOnes = [];
  for (const entry of list) {
    const address = typeof entry === 'string' ? entry : (entry && entry.address);
    const family = typeof entry === 'object' && entry && entry.family
      ? entry.family
      : (String(address).includes(':') ? 6 : 4);
    if (!isPublicIp(address)) {
      failClosed(
        'RADAR_LOAD_DNS_PRIVATE',
        `fail_closed: DNS resolved to non-public address: ${String(address)}`,
      );
    }
    publicOnes.push(Object.freeze({ address: String(address), family: Number(family) || 4 }));
  }
  return Object.freeze(publicOnes);
}

function dnsLookupPromise(lookupFn, hostname) {
  return new Promise((resolve, reject) => {
    lookupFn(hostname, { all: true }, (err, addresses) => {
      if (err) return reject(err);
      if (Array.isArray(addresses)) return resolve(addresses);
      // Node may return (address, family) when all:false; normalize.
      resolve([{ address: addresses, family: 4 }]);
    });
  });
}

/**
 * Resolve hostname and pin validated public DNS results before any request.
 * Unexported for production; offline may inject lookupFn via sealed path.
 */
async function pinValidatedPublicDns(hostname, lookupFn) {
  const lookup = typeof lookupFn === 'function' ? lookupFn : dns.lookup;
  let addresses;
  try {
    addresses = await dnsLookupPromise(lookup, hostname);
  } catch (err) {
    failClosed(
      'RADAR_LOAD_DNS',
      `fail_closed: DNS lookup failed: ${err && err.code ? err.code : String(err && err.message)}`,
    );
  }
  return assertPublicDnsAddresses(addresses);
}

function pinnedLookup(pinned) {
  const primary = pinned[0];
  return function lookup(_hostname, options, callback) {
    let cb = callback;
    let opts = options;
    if (typeof options === 'function') {
      cb = options;
      opts = {};
    }
    const family = (opts && opts.family) || primary.family;
    const match = pinned.find((p) => p.family === family) || primary;
    process.nextTick(() => cb(null, match.address, match.family));
  };
}

/**
 * Unexported fixed HTTPS GET transport. Owns per-request deadline, destroys on
 * timeout, drains without retaining bodies, and settles all terminal paths.
 * Latency is NOT returned — caller measures with monotonic time.
 */
function fixedHttpsGet(deps) {
  const httpsRequest = deps.httpsRequest;
  const pinned = deps.pinned;
  const requestTimeoutMs = deps.requestTimeoutMs;
  const runDeadlineNs = deps.runDeadlineNs;
  const activeRequests = deps.activeRequests;
  const targetUrl = deps.targetUrl;
  const abortReasonRef = deps.abortReasonRef;

  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    let timer = null;
    let timeoutFired = false;

    function settle(outcome) {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (req) activeRequests.delete(req);
      // Intentionally drop any latency_ms / body fields from settle input.
      resolve({
        kind: outcome.kind,
        status_code: outcome.status_code == null ? null : outcome.status_code,
        redirected: outcome.redirected === true,
        error_code: outcome.error_code || undefined,
      });
    }

    const now = monoNowNs();
    const untilRunMs = Math.max(0, msBetween(now, runDeadlineNs));
    const budgetMs = Math.max(1, Math.min(requestTimeoutMs, untilRunMs || 1));

    if (untilRunMs <= 0 || (abortReasonRef && abortReasonRef.reason)) {
      settle({
        kind: 'timeout',
        status_code: null,
        redirected: false,
        error_code: 'RUN_DEADLINE',
      });
      return;
    }

    timer = setTimeout(() => {
      timeoutFired = true;
      if (req) {
        try {
          req.destroy(Object.assign(new Error('request_deadline'), { code: 'RADAR_REQUEST_DEADLINE' }));
        } catch (_) { /* ignore */ }
      }
      settle({ kind: 'timeout', status_code: null, redirected: false, error_code: 'REQUEST_DEADLINE' });
    }, budgetMs);
    // Do not unref: deadline timers must keep the event loop alive so hanging
    // requests settle even when the socket never connects.

    const parsed = new URL(targetUrl);
    try {
      req = httpsRequest({
        protocol: 'https:',
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname,
        method: 'GET',
        headers: {},
        servername: parsed.hostname,
        lookup: pinnedLookup(pinned),
        // No agent/auth/body; redirects never followed by https.request.
      }, (res) => {
        const code = typeof res.statusCode === 'number' ? res.statusCode : null;
        const redirected = typeof code === 'number' && code >= 300 && code < 400;
        // Drain trickle/hanging body bytes without retaining them.
        res.on('data', () => {});
        res.on('end', () => {
          settle({ kind: 'status', status_code: code, redirected });
        });
        res.on('aborted', () => {
          if (timeoutFired || (abortReasonRef && abortReasonRef.reason)) {
            settle({
              kind: 'timeout',
              status_code: null,
              redirected: false,
              error_code: 'ABORTED_DEADLINE',
            });
            return;
          }
          settle({
            kind: 'error',
            status_code: null,
            redirected: false,
            error_code: 'ABORTED',
          });
        });
        res.on('error', (err) => {
          if (timeoutFired || (abortReasonRef && abortReasonRef.reason)) {
            settle({
              kind: 'timeout',
              status_code: null,
              redirected: false,
              error_code: 'ABORTED_DEADLINE',
            });
            return;
          }
          settle({
            kind: 'error',
            status_code: null,
            redirected: false,
            error_code: err && err.code ? String(err.code) : 'RESPONSE_ERROR',
          });
        });
        res.on('close', () => {
          // Premature close only when message did not complete (no 'end').
          // Normal responses also emit 'close' after 'end' — ignore those.
          if (settled) return;
          if (res.complete) return;
          if (timeoutFired || (abortReasonRef && abortReasonRef.reason)) {
            settle({
              kind: 'timeout',
              status_code: null,
              redirected: false,
              error_code: 'PREMATURE_CLOSE_DEADLINE',
            });
          } else {
            settle({
              kind: 'error',
              status_code: null,
              redirected: false,
              error_code: 'PREMATURE_CLOSE',
            });
          }
        });
      });
    } catch (err) {
      settle({
        kind: 'error',
        status_code: null,
        redirected: false,
        error_code: err && err.code ? String(err.code) : 'REQUEST_CREATE',
      });
      return;
    }

    activeRequests.add(req);

    req.on('error', (err) => {
      if (timeoutFired || (abortReasonRef && abortReasonRef.reason)) {
        settle({
          kind: 'timeout',
          status_code: null,
          redirected: false,
          error_code: 'ABORTED_DEADLINE',
        });
        return;
      }
      settle({
        kind: 'error',
        status_code: null,
        redirected: false,
        error_code: err && err.code ? String(err.code) : 'ERROR',
      });
    });

    // Never send a body; never attach auth headers.
    req.end();
  });
}

async function runBoundedLoadCore(options, runtime) {
  const opts = options && typeof options === 'object' ? options : {};
  rejectCallerTransportEscape(opts);
  const target = opts.target;
  const parsed = assertAllowedTarget(target);

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

  const httpsRequest = runtime.httpsRequest;
  const dnsLookup = runtime.dnsLookup;
  if (typeof httpsRequest !== 'function') {
    failClosed('RADAR_LOAD_TRANSPORT', 'fail_closed: fixed HTTPS transport missing');
  }

  const pinned = await pinValidatedPublicDns(parsed.hostname, dnsLookup);

  const status_counts = emptyStatusCounts();
  const latencies = [];
  let started = 0;
  let completed = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let stopReason = null;
  const activeRequests = new Set();
  const abortReasonRef = { reason: null };
  const wallStartNs = monoNowNs();
  const runDeadlineNs = wallStartNs + BigInt(profile.max_duration_ms) * NS_PER_MS;

  let runTimer = setTimeout(() => {
    abortReasonRef.reason = 'max_duration';
    stopReason = stopReason || 'max_duration';
    for (const req of [...activeRequests]) {
      try {
        req.destroy(Object.assign(new Error('run_deadline'), { code: 'RADAR_RUN_DEADLINE' }));
      } catch (_) { /* ignore */ }
    }
  }, profile.max_duration_ms);

  function record(outcome, reqStartNs) {
    completed += 1;
    const cls = statusClassFor(outcome);
    status_counts[cls] += 1;
    // Always measure latency internally with monotonic time; ignore any
    // transport-supplied latency_ms (including adversarial offline values).
    const ignored = outcome && typeof outcome === 'object' ? outcome.latency_ms : undefined;
    void ignored;
    latencies.push(msBetween(reqStartNs, monoNowNs()));
  }

  async function worker() {
    while (true) {
      if (abortReasonRef.reason || monoNowNs() >= runDeadlineNs) {
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
      const reqStartNs = monoNowNs();
      let outcome;
      try {
        outcome = await fixedHttpsGet({
          httpsRequest,
          pinned,
          requestTimeoutMs: profile.request_timeout_ms,
          runDeadlineNs,
          activeRequests,
          targetUrl: target,
          abortReasonRef,
        });
        if (!outcome || typeof outcome !== 'object') {
          outcome = { kind: 'error', status_code: null, redirected: false, error_code: 'BAD_TRANSPORT' };
        }
      } catch (err) {
        outcome = {
          kind: 'error',
          status_code: null,
          redirected: false,
          error_code: err && err.code ? String(err.code) : 'THROW',
        };
      }
      inFlight -= 1;
      record(outcome, reqStartNs);
    }
  }

  try {
    const workers = [];
    for (let i = 0; i < profile.concurrency; i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
  } finally {
    if (runTimer) {
      clearTimeout(runTimer);
      runTimer = null;
    }
    // Deadline cleanup: destroy any stragglers and wait until set drains.
    if (activeRequests.size > 0) {
      abortReasonRef.reason = abortReasonRef.reason || 'cleanup';
      for (const req of [...activeRequests]) {
        try {
          req.destroy(Object.assign(new Error('cleanup'), { code: 'RADAR_CLEANUP' }));
        } catch (_) { /* ignore */ }
      }
    }
  }

  if (!stopReason) stopReason = 'drained';

  const latency = summarizeLatencies(latencies);
  return Object.freeze({
    target,
    method: 'GET',
    profile,
    started,
    completed,
    peak_in_flight: peakInFlight,
    wall_ms: msBetween(wallStartNs, monoNowNs()),
    stop_reason: stopReason,
    status_counts: Object.freeze({ ...status_counts }),
    latency,
    response_bodies_collected: false,
    redirects_followed: false,
    headers_sent: false,
    auth_sent: false,
    body_sent: false,
    dns_pinned: true,
    active_requests_remaining: activeRequests.size,
  });
}

/**
 * Production entry: fixed unexported HTTPS transport + real DNS. Rejects any
 * caller transport/agent/lookup/httpsRequest escape.
 */
async function runBoundedLoad(options) {
  rejectCallerTransportEscape(options);
  return runBoundedLoadCore(options, {
    httpsRequest: https.request.bind(https),
    dnsLookup: dns.lookup.bind(dns),
  });
}

/**
 * Offline verifier entry. Requires OFFLINE_SEAL and injected httpsRequest +
 * dnsLookup (typically local fake + public-IP fixture). Must not be used for
 * live staging drills.
 */
async function runBoundedLoadOffline(options, offline) {
  if (!offline || offline.seal !== OFFLINE_SEAL) {
    failClosed(
      'RADAR_LOAD_OFFLINE_SEAL',
      'fail_closed: runBoundedLoadOffline requires OFFLINE_SEAL',
    );
  }
  if (typeof offline.httpsRequest !== 'function' || typeof offline.dnsLookup !== 'function') {
    failClosed(
      'RADAR_LOAD_OFFLINE_SEAL',
      'fail_closed: offline httpsRequest and dnsLookup required',
    );
  }
  rejectCallerTransportEscape(options);
  return runBoundedLoadCore(options, {
    httpsRequest: offline.httpsRequest,
    dnsLookup: offline.dnsLookup,
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
  OFFLINE_SEAL,
  assertAllowedTarget,
  clampProfile,
  validateProfileOnly,
  statusClassFor,
  percentileNearestRank,
  summarizeLatencies,
  isPublicIp,
  assertPublicDnsAddresses,
  pinValidatedPublicDns,
  runBoundedLoad,
  runBoundedLoadOffline,
};
