'use strict';

/**
 * radar-g06-bounded-load-harness — dependency-free Node load harness for G06.
 *
 * Hard-locked to the two exact staging Staff API /readyz URLs.
 * GET only; no headers/body/auth; no redirects; TLS required; fail-closed on
 * any other target. Production runBoundedLoad uses an unexported fixed HTTPS
 * transport only (no caller transport escape). Owns one absolute monotonic
 * run deadline started before DNS, races/aborts DNS against the remaining
 * budget (missing/late callbacks settle; no request starts afterward), then
 * pins fail-closed globally-routable DNS results (IANA special-purpose
 * prefix tables with explicit globallyReachable flags; longest-match;
 * ordinary public unicast allowed only when not denied) for exact-address lookup.
 * Per-request deadlines abort/destroy actives and settle end/aborted/error/
 * premature-close/trickle paths. Latency is measured with monotonic time;
 * transport-supplied latency values are ignored.
 *
 * Live drill is NOT executed by RADAR 16AG — FUTURE_DRILL_PROFILE is defined
 * only. Offline verifiers must use runBoundedLoadOffline with OFFLINE_SEAL
 * after fail-closing real http/https/net/DNS.
 */

const https = require('https');
const dns = require('dns');
const net = require('net');
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

function ipv4ToInt(parts) {
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function intToIpv4(n) {
  const x = n >>> 0;
  return `${(x >>> 24) & 0xff}.${(x >>> 16) & 0xff}.${(x >>> 8) & 0xff}.${x & 0xff}`;
}

function ipv4Mask(prefixLen) {
  if (prefixLen <= 0) return 0;
  if (prefixLen >= 32) return 0xffffffff;
  return ((0xffffffff << (32 - prefixLen)) >>> 0);
}

function ipv4InCidr(parts, baseA, baseB, baseC, baseD, prefixLen) {
  const ip = ipv4ToInt(parts);
  const base = ipv4ToInt([baseA, baseB, baseC, baseD]);
  const mask = ipv4Mask(prefixLen);
  return (ip & mask) === (base & mask);
}

/**
 * Expand IPv6 to eight 16-bit hextets (fail-closed on malformed input).
 */
function parseIpv6Hextets(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s || net.isIP(s) !== 6) return null;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);

  // IPv4-mapped / dotted-quad tail → convert last 32 bits to two hextets.
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    if (lastColon < 0) return null;
    const v4 = parseIpv4(s.slice(lastColon + 1));
    if (!v4) return null;
    const hi = (v4[0] << 8) | v4[1];
    const lo = (v4[2] << 8) | v4[3];
    s = `${s.slice(0, lastColon)}:${hi.toString(16)}:${lo.toString(16)}`;
  }

  const sides = s.split('::');
  if (sides.length > 2) return null;
  let parts;
  if (sides.length === 1) {
    parts = sides[0].split(':');
    if (parts.length !== 8) return null;
  } else {
    const left = sides[0] ? sides[0].split(':') : [];
    const right = sides[1] ? sides[1].split(':') : [];
    const fill = 8 - (left.length + right.length);
    if (fill < 0) return null;
    parts = left.concat(new Array(fill).fill('0'), right);
  }
  if (parts.length !== 8) return null;
  const hextets = [];
  for (const h of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    hextets.push(parseInt(h, 16));
  }
  return hextets;
}

function formatIpv6Hextets(hextets) {
  return hextets.map((h) => h.toString(16)).join(':');
}

function ipv6PrefixMatch(hextets, baseHextets, prefixLen) {
  let bitsLeft = prefixLen;
  for (let i = 0; i < 8 && bitsLeft > 0; i += 1) {
    const take = Math.min(16, bitsLeft);
    const shift = 16 - take;
    const mask = take === 16 ? 0xffff : ((0xffff << shift) & 0xffff);
    if ((hextets[i] & mask) !== (baseHextets[i] & mask)) return false;
    bitsLeft -= take;
  }
  return true;
}

/**
 * Parse IANA "Globally Reachable" cell. Empty / N/A / missing → false (fail-closed).
 */
function parseIanaGloballyReachable(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (s === 'true') return true;
  return false;
}

/**
 * IANA IPv4 Special-Purpose Address Registry (RFC 6890 / iana-ipv4-special-registry).
 * globallyReachable mirrors the IANA column; empty/N/A → false (fail-closed).
 * Longest prefix match wins (e.g. 192.0.0.9/32 over 192.0.0.0/24).
 */
const IANA_IPV4_SPECIAL_PURPOSE_RAW = Object.freeze([
  { prefix: '0.0.0.0/8', name: 'This network', globallyReachable: false },
  { prefix: '0.0.0.0/32', name: 'This host on this network', globallyReachable: false },
  { prefix: '10.0.0.0/8', name: 'Private-Use', globallyReachable: false },
  { prefix: '100.64.0.0/10', name: 'Shared Address Space', globallyReachable: false },
  { prefix: '127.0.0.0/8', name: 'Loopback', globallyReachable: false },
  { prefix: '169.254.0.0/16', name: 'Link Local', globallyReachable: false },
  { prefix: '172.16.0.0/12', name: 'Private-Use', globallyReachable: false },
  { prefix: '192.0.0.0/24', name: 'IETF Protocol Assignments', globallyReachable: false },
  { prefix: '192.0.0.0/29', name: 'IPv4 Service Continuity Prefix', globallyReachable: false },
  { prefix: '192.0.0.8/32', name: 'IPv4 dummy address', globallyReachable: false },
  { prefix: '192.0.0.9/32', name: 'Port Control Protocol Anycast', globallyReachable: true },
  { prefix: '192.0.0.10/32', name: 'Traversal Using Relays around NAT Anycast', globallyReachable: true },
  { prefix: '192.0.0.170/32', name: 'NAT64/DNS64 Discovery', globallyReachable: false },
  { prefix: '192.0.0.171/32', name: 'NAT64/DNS64 Discovery', globallyReachable: false },
  { prefix: '192.0.2.0/24', name: 'Documentation (TEST-NET-1)', globallyReachable: false },
  { prefix: '192.31.196.0/24', name: 'AS112-v4', globallyReachable: true },
  { prefix: '192.52.193.0/24', name: 'AMT', globallyReachable: true },
  { prefix: '192.88.99.0/24', name: 'Deprecated (6to4 Relay Anycast)', globallyReachable: false },
  { prefix: '192.88.99.2/32', name: '6a44-relay anycast address', globallyReachable: false },
  { prefix: '192.168.0.0/16', name: 'Private-Use', globallyReachable: false },
  { prefix: '192.175.48.0/24', name: 'Direct Delegation AS112 Service', globallyReachable: true },
  { prefix: '198.18.0.0/15', name: 'Benchmarking', globallyReachable: false },
  { prefix: '198.51.100.0/24', name: 'Documentation (TEST-NET-2)', globallyReachable: false },
  { prefix: '203.0.113.0/24', name: 'Documentation (TEST-NET-3)', globallyReachable: false },
  { prefix: '240.0.0.0/4', name: 'Reserved', globallyReachable: false },
  { prefix: '255.255.255.255/32', name: 'Limited Broadcast', globallyReachable: false },
]);

/**
 * IANA IPv6 Special-Purpose Address Registry (RFC 6890 / iana-ipv6-special-registry).
 * globallyReachable mirrors the IANA column; empty/N/A → false (fail-closed).
 * ::ffff:0:0/96 is listed False but evaluated via embedded IPv4 (specialHandling).
 */
const IANA_IPV6_SPECIAL_PURPOSE_RAW = Object.freeze([
  { prefix: '::1/128', name: 'Loopback Address', globallyReachable: false },
  { prefix: '::/128', name: 'Unspecified Address', globallyReachable: false },
  {
    prefix: '::ffff:0:0/96',
    name: 'IPv4-mapped Address',
    globallyReachable: false,
    specialHandling: 'ipv4_mapped_embedded',
  },
  { prefix: '64:ff9b::/96', name: 'IPv4-IPv6 Translat.', globallyReachable: true },
  { prefix: '64:ff9b:1::/48', name: 'IPv4-IPv6 Translat.', globallyReachable: false },
  { prefix: '100::/64', name: 'Discard-Only Address Block', globallyReachable: false },
  { prefix: '100:0:0:1::/64', name: 'Dummy IPv6 Prefix', globallyReachable: false },
  { prefix: '2001::/23', name: 'IETF Protocol Assignments', globallyReachable: false },
  { prefix: '2001::/32', name: 'TEREDO', globallyReachable: false }, // IANA N/A → fail-closed
  { prefix: '2001:1::1/128', name: 'Port Control Protocol Anycast', globallyReachable: true },
  { prefix: '2001:1::2/128', name: 'Traversal Using Relays around NAT Anycast', globallyReachable: true },
  { prefix: '2001:1::3/128', name: 'DNS-SD Service Registration Protocol Anycast', globallyReachable: true },
  { prefix: '2001:2::/48', name: 'Benchmarking', globallyReachable: false },
  { prefix: '2001:3::/32', name: 'AMT', globallyReachable: true },
  { prefix: '2001:4:112::/48', name: 'AS112-v6', globallyReachable: true },
  { prefix: '2001:10::/28', name: 'Deprecated (previously ORCHID)', globallyReachable: false },
  { prefix: '2001:20::/28', name: 'ORCHIDv2', globallyReachable: true },
  { prefix: '2001:30::/28', name: 'Drone Remote ID Protocol Entity Tags (DETs) Prefix', globallyReachable: true },
  { prefix: '2001:db8::/32', name: 'Documentation', globallyReachable: false },
  { prefix: '2002::/16', name: '6to4', globallyReachable: false }, // IANA N/A → fail-closed
  { prefix: '2620:4f:8000::/48', name: 'Direct Delegation AS112 Service', globallyReachable: true },
  { prefix: '3fff::/20', name: 'Documentation', globallyReachable: false },
  { prefix: '5f00::/16', name: 'Segment Routing (SRv6) SIDs', globallyReachable: false },
  { prefix: 'fc00::/7', name: 'Unique-Local', globallyReachable: false },
  { prefix: 'fe80::/10', name: 'Link-Local Unicast', globallyReachable: false },
]);

function compileIpv4SpecialEntry(raw) {
  const [addr, lenStr] = String(raw.prefix).split('/');
  const parts = parseIpv4(addr);
  const prefixLen = Number(lenStr);
  if (!parts || !Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) {
    throw new Error(`invalid IANA IPv4 special prefix: ${raw.prefix}`);
  }
  return Object.freeze({
    family: 4,
    prefix: raw.prefix,
    name: raw.name,
    globallyReachable: parseIanaGloballyReachable(raw.globallyReachable),
    prefixLen,
    baseInt: ipv4ToInt(parts) & ipv4Mask(prefixLen),
    specialHandling: raw.specialHandling || null,
  });
}

function compileIpv6SpecialEntry(raw) {
  const [addr, lenStr] = String(raw.prefix).split('/');
  const hextets = parseIpv6Hextets(addr);
  const prefixLen = Number(lenStr);
  if (!hextets || !Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 128) {
    throw new Error(`invalid IANA IPv6 special prefix: ${raw.prefix}`);
  }
  // Zero host bits beyond prefixLen for a stable network base.
  const base = hextets.slice();
  let bitsLeft = prefixLen;
  for (let i = 0; i < 8; i += 1) {
    if (bitsLeft >= 16) {
      bitsLeft -= 16;
      continue;
    }
    if (bitsLeft > 0) {
      const mask = (0xffff << (16 - bitsLeft)) & 0xffff;
      base[i] &= mask;
      bitsLeft = 0;
    } else {
      base[i] = 0;
    }
  }
  return Object.freeze({
    family: 6,
    prefix: raw.prefix,
    name: raw.name,
    globallyReachable: parseIanaGloballyReachable(raw.globallyReachable),
    prefixLen,
    baseHextets: Object.freeze(base),
    specialHandling: raw.specialHandling || null,
  });
}

const IANA_IPV4_SPECIAL_PURPOSE = Object.freeze(
  IANA_IPV4_SPECIAL_PURPOSE_RAW.map(compileIpv4SpecialEntry)
    .sort((a, b) => b.prefixLen - a.prefixLen || a.prefix.localeCompare(b.prefix)),
);

const IANA_IPV6_SPECIAL_PURPOSE = Object.freeze(
  IANA_IPV6_SPECIAL_PURPOSE_RAW.map(compileIpv6SpecialEntry)
    .sort((a, b) => b.prefixLen - a.prefixLen || a.prefix.localeCompare(b.prefix)),
);

function matchIpv4SpecialPurpose(parts) {
  const ip = ipv4ToInt(parts);
  for (const entry of IANA_IPV4_SPECIAL_PURPOSE) {
    if ((ip & ipv4Mask(entry.prefixLen)) === entry.baseInt) return entry;
  }
  return null;
}

function matchIpv6SpecialPurpose(hextets) {
  for (const entry of IANA_IPV6_SPECIAL_PURPOSE) {
    if (ipv6PrefixMatch(hextets, entry.baseHextets, entry.prefixLen)) return entry;
  }
  return null;
}

/**
 * Representative address that longest-matches `entry` (avoids more-specific children).
 * Used by table-driven RED/GREEN coverage.
 */
function sampleAddressForIanaEntry(entry) {
  if (entry.family === 4) {
    const hostBits = 32 - entry.prefixLen;
    const span = hostBits >= 32 ? 0xffffffff : ((1 << hostBits) >>> 0);
    const limit = Math.min(span === 0 ? 1 : span, 65536);
    for (let i = 0; i < limit; i += 1) {
      const candidate = (entry.baseInt + i) >>> 0;
      if ((candidate & ipv4Mask(entry.prefixLen)) !== entry.baseInt) break;
      const parts = parseIpv4(intToIpv4(candidate));
      const hit = matchIpv4SpecialPurpose(parts);
      if (hit && hit.prefix === entry.prefix) return intToIpv4(candidate);
    }
    return intToIpv4(entry.baseInt);
  }

  // IPv6: walk low host bits.
  const hostBits = 128 - entry.prefixLen;
  const limit = Math.min(hostBits === 0 ? 1 : (hostBits >= 16 ? 65536 : (1 << hostBits)), 65536);
  for (let i = 0; i < limit; i += 1) {
    const candidate = entry.baseHextets.slice();
    let rem = i;
    for (let h = 7; h >= 0 && rem > 0; h -= 1) {
      const add = rem & 0xffff;
      candidate[h] = (candidate[h] + add) & 0xffff;
      rem = rem >>> 16;
    }
    if (!ipv6PrefixMatch(candidate, entry.baseHextets, entry.prefixLen)) break;
    const hit = matchIpv6SpecialPurpose(candidate);
    if (hit && hit.prefix === entry.prefix) return formatIpv6Hextets(candidate);
  }
  return formatIpv6Hextets(entry.baseHextets);
}

function extractIpv4MappedEmbedded(raw, hextets) {
  const dotted = String(raw).match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
    || String(raw).match(/^0:0:0:0:0:ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted) return dotted[1];
  if (hextets
    && hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0
    && hextets[4] === 0 && hextets[5] === 0xffff) {
    return [
      (hextets[6] >> 8) & 0xff,
      hextets[6] & 0xff,
      (hextets[7] >> 8) & 0xff,
      hextets[7] & 0xff,
    ].join('.');
  }
  return null;
}

/**
 * Fail-closed globally-routable unicast check for IPv4 and IPv6.
 * Uses the complete IANA special-purpose tables with explicit globallyReachable
 * flags (longest prefix match). Multicast (outside IANA special registries) and
 * non-2000::/3 IPv6 are rejected. IPv4-mapped IPv6 evaluates the embedded IPv4.
 * Default deny: unknown/malformed → false.
 */
function isGloballyRoutableIp(address) {
  const raw = String(address || '').trim().toLowerCase();
  if (!raw) return false;
  const kind = net.isIP(raw);
  if (kind === 4) {
    const n = parseIpv4(raw);
    if (!n) return false;
    // Multicast is not in the IANA special-purpose registry — fail closed.
    if (ipv4InCidr(n, 224, 0, 0, 0, 4)) return false;
    const hit = matchIpv4SpecialPurpose(n);
    if (hit) return hit.globallyReachable === true;
    return true; // ordinary public unicast
  }

  if (kind === 6) {
    const h = parseIpv6Hextets(raw);
    if (!h) return false;

    // IPv4-mapped ::ffff:0:0/96 — evaluate embedded IPv4 (registry False alone is insufficient).
    const embedded = extractIpv4MappedEmbedded(raw, h);
    if (embedded) return isGloballyRoutableIp(embedded);

    // Multicast ff00::/8 — not in IANA special-purpose registry — fail closed.
    if ((h[0] & 0xff00) === 0xff00) return false;

    const hit = matchIpv6SpecialPurpose(h);
    if (hit) return hit.globallyReachable === true;

    // Fail-closed: only accept global unicast 2000::/3 when not special-purpose.
    if ((h[0] & 0xe000) !== 0x2000) return false;
    return true;
  }

  return false;
}

/** @deprecated alias — prefer isGloballyRoutableIp (same fail-closed semantics). */
function isPublicIp(address) {
  return isGloballyRoutableIp(address);
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
    if (!isGloballyRoutableIp(address)) {
      failClosed(
        'RADAR_LOAD_DNS_PRIVATE',
        `fail_closed: DNS resolved to non-globally-routable address: ${String(address)}`,
      );
    }
    publicOnes.push(Object.freeze({ address: String(address), family: Number(family) || 4 }));
  }
  return Object.freeze(publicOnes);
}

/**
 * Resolve hostname raced against remaining run budget, then pin validated
 * globally-routable DNS results before any request. A missing or late DNS
 * callback settles via RADAR_LOAD_DNS_DEADLINE and must not start requests.
 */
async function pinValidatedPublicDns(hostname, lookupFn, runDeadlineNs, abortReasonRef) {
  const lookup = typeof lookupFn === 'function' ? lookupFn : dns.lookup;
  const now = monoNowNs();
  const remainingMs = Math.max(0, msBetween(now, runDeadlineNs));
  if (remainingMs <= 0 || (abortReasonRef && abortReasonRef.reason)) {
    failClosed(
      'RADAR_LOAD_DNS_DEADLINE',
      'fail_closed: run deadline exhausted before/during DNS; no request started',
    );
  }

  let addresses;
  try {
    addresses = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (abortReasonRef) abortReasonRef.reason = abortReasonRef.reason || 'max_duration';
        reject(Object.assign(new Error('dns_deadline'), { code: 'RADAR_LOAD_DNS_DEADLINE' }));
      }, remainingMs);
      // Keep the event loop alive so a missing DNS callback still settles.

      try {
        lookup(hostname, { all: true }, (err, addrs) => {
          if (settled) {
            // Late callback after deadline/abort — ignore; do not resolve or start work.
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (err) return reject(err);
          if (Array.isArray(addrs)) return resolve(addrs);
          resolve([{ address: addrs, family: 4 }]);
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  } catch (err) {
    if (err && err.code === 'RADAR_LOAD_DNS_DEADLINE') {
      failClosed(
        'RADAR_LOAD_DNS_DEADLINE',
        'fail_closed: DNS resolution exceeded remaining run budget; no request started',
      );
    }
    failClosed(
      'RADAR_LOAD_DNS',
      `fail_closed: DNS lookup failed: ${err && err.code ? err.code : String(err && err.message)}`,
    );
  }

  if (abortReasonRef && abortReasonRef.reason) {
    failClosed(
      'RADAR_LOAD_DNS_DEADLINE',
      'fail_closed: run deadline hit during DNS; no request started',
    );
  }
  if (monoNowNs() >= runDeadlineNs) {
    failClosed(
      'RADAR_LOAD_DNS_DEADLINE',
      'fail_closed: run deadline exhausted after DNS; no request started',
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

  // Whole-run monotonic deadline starts BEFORE DNS so resolution is raced
  // against the remaining budget; missing/late DNS cannot start requests.
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

  let pinned;
  try {
    pinned = await pinValidatedPublicDns(
      parsed.hostname,
      dnsLookup,
      runDeadlineNs,
      abortReasonRef,
    );
  } catch (err) {
    if (runTimer) {
      clearTimeout(runTimer);
      runTimer = null;
    }
    throw err;
  }

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
  IANA_IPV4_SPECIAL_PURPOSE,
  IANA_IPV6_SPECIAL_PURPOSE,
  assertAllowedTarget,
  clampProfile,
  validateProfileOnly,
  statusClassFor,
  percentileNearestRank,
  summarizeLatencies,
  isGloballyRoutableIp,
  isPublicIp,
  matchIpv4SpecialPurpose,
  matchIpv6SpecialPurpose,
  sampleAddressForIanaEntry,
  assertPublicDnsAddresses,
  pinValidatedPublicDns,
  runBoundedLoad,
  runBoundedLoadOffline,
};
