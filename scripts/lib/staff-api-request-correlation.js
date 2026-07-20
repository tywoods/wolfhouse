'use strict';

/**
 * Staff API request correlation (RADAR 16D) — HTTP boundary only.
 *
 * Contract:
 * - Accept only a strict bounded X-Request-Id, else generate crypto-random hex.
 * - Echo correlation ID on every response (including errors / early writes).
 * - Propagate via AsyncLocalStorage without changing handler signatures.
 * - Emit exactly one structured completion event per request.
 * - Event fields: correlation_id, method, route_class, status, duration_ms,
 *   client_slug/location_id only when bound from already-authoritative runtime,
 *   error_class (status/abort class — never message/stack).
 * - Must never emit raw URL/query/body/headers, guest data, credentials,
 *   tokens, stack traces, or error messages.
 * - Preserve existing response/error behavior and streaming (no body buffering).
 */

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const CORRELATION_HEADER = 'x-request-id';
const CORRELATION_HEADER_CANON = 'X-Request-Id';
/** Strict ASCII token: 8–128 chars, starts alphanumeric; no unicode/space/punct injection. */
const CORRELATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const CORRELATION_ID_MAX_LEN = 128;
const GENERATED_ID_BYTES = 16;
const EVENT_NAME = 'staff_api_http_request_complete';
const ROUTE_CLASS_MAX_LEN = 160;

const EVENT_ALLOWED_KEYS = Object.freeze([
  'event',
  'correlation_id',
  'method',
  'route_class',
  'status',
  'duration_ms',
  'client_slug',
  'location_id',
  'error_class',
]);

const FORBIDDEN_EVENT_KEYS = Object.freeze([
  'url',
  'path',
  'pathname',
  'query',
  'body',
  'headers',
  'header',
  'authorization',
  'cookie',
  'token',
  'password',
  'secret',
  'stack',
  'message',
  'error_message',
  'errorMessage',
  'guest',
  'phone',
  'email',
  'raw_url',
  'req',
  'res',
]);

const als = new AsyncLocalStorage();

/** @type {(event: object) => void} */
let emitSink = defaultEmitSink;

function defaultEmitSink(event) {
  // Stay quiet under NODE_ENV=test unless a verifier installs a sink.
  // Staging/prod emit one JSON line for ops correlation.
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') return;
  console.log(JSON.stringify(event));
}

/**
 * Test/harness override for completion emission. Pass null to restore default.
 * @param {((event: object) => void) | null} fn
 */
function setCorrelationEmitSink(fn) {
  emitSink = typeof fn === 'function' ? fn : defaultEmitSink;
}

/**
 * @returns {string}
 */
function generateCorrelationId() {
  return crypto.randomBytes(GENERATED_ID_BYTES).toString('hex');
}

/**
 * Accept only strict bounded header values; otherwise generate.
 * @param {unknown} raw
 * @returns {{ correlation_id: string, accepted_from_header: boolean }}
 */
function acceptOrGenerateCorrelationId(raw) {
  if (typeof raw !== 'string') {
    return { correlation_id: generateCorrelationId(), accepted_from_header: false };
  }
  // Reject oversize before regex (also rejects unicode-heavy payloads cheaply).
  if (raw.length < 8 || raw.length > CORRELATION_ID_MAX_LEN) {
    return { correlation_id: generateCorrelationId(), accepted_from_header: false };
  }
  // Reject any non-ASCII / control / whitespace up front.
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      return { correlation_id: generateCorrelationId(), accepted_from_header: false };
    }
  }
  if (!CORRELATION_ID_RE.test(raw)) {
    return { correlation_id: generateCorrelationId(), accepted_from_header: false };
  }
  return { correlation_id: raw, accepted_from_header: true };
}

/**
 * Pathname only — never keep query/hash (cardinality + secret leakage).
 * @param {unknown} rawUrl
 * @returns {string}
 */
function pathnameOnly(rawUrl) {
  const s = typeof rawUrl === 'string' ? rawUrl : '';
  if (!s) return '/';
  let end = s.length;
  const q = s.indexOf('?');
  const h = s.indexOf('#');
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  let p = s.slice(0, end) || '/';
  try {
    // Decode %XX safely for classification only; never store raw URL.
    p = decodeURIComponent(p);
  } catch (_) {
    // Keep undecoded path for classification if malformed.
  }
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '') || '/';
  if (!p.startsWith('/')) p = `/${p}`;
  return p;
}

/**
 * Normalize to a low-cardinality route class (no raw IDs/query).
 * @param {unknown} pathname
 * @returns {string}
 */
function normalizeRouteClass(pathname) {
  let p = pathnameOnly(pathname);

  // UUID v1–v5
  p = p.replace(
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi,
    '/:id',
  );
  // Long hex tokens
  p = p.replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, '/:id');
  // Pure numeric ids
  p = p.replace(/\/\d{1,18}(?=\/|$)/g, '/:id');
  // Booking-style codes
  p = p.replace(/\/WH-[A-Z0-9-]{4,40}(?=\/|$)/gi, '/:booking_code');
  // Guest pay short links /pay/:booking/:guest
  p = p.replace(/^\/pay\/[^/]+\/[^/]+/i, '/pay/:booking/:guest');
  // Long opaque path tokens (bounded cardinality)
  p = p.replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, '/:token');

  if (p === '/') return 'root';
  if (p === '/healthz') return 'healthz';

  if (p.length > ROUTE_CLASS_MAX_LEN) {
    p = p.slice(0, ROUTE_CLASS_MAX_LEN);
  }
  return p;
}

/**
 * Map status / abort to a coarse error class — never a message.
 * @param {number|null|undefined} status
 * @param {boolean} aborted
 * @returns {string|null}
 */
function classifyErrorClass(status, aborted) {
  if (aborted) return 'aborted';
  const code = Number(status);
  if (!Number.isFinite(code) || code < 400) return null;
  if (code === 401) return 'unauthorized';
  if (code === 403) return 'forbidden';
  if (code === 404) return 'not_found';
  if (code === 405) return 'method_not_allowed';
  if (code >= 500) return 'server_error';
  return 'client_error';
}

/**
 * Strict slug/location token for authoritative bind only.
 * @param {unknown} raw
 * @returns {string|null}
 */
function sanitizeScopeToken(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 64) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s)) return null;
  return s;
}

/**
 * Bind runtime tenant/location only from already-authoritative code paths.
 * Never reads headers/query/body. No-ops outside an active request store.
 * @param {{ clientSlug?: unknown, locationId?: unknown }} [scope]
 */
function bindAuthoritativeRuntimeScope(scope) {
  const store = als.getStore();
  if (!store || store.completed) return;
  const src = scope && typeof scope === 'object' ? scope : {};
  const clientSlug = sanitizeScopeToken(src.clientSlug);
  const locationId = sanitizeScopeToken(src.locationId);
  if (clientSlug) store.client_slug = clientSlug;
  if (locationId) store.location_id = locationId;
}

/**
 * @returns {object|null}
 */
function getRequestCorrelationContext() {
  const store = als.getStore();
  return store || null;
}

/**
 * Build the frozen completion event. Strips any forbidden keys defensively.
 * @param {object} store
 * @returns {object}
 */
function buildCompletionEvent(store) {
  const durationMs = Math.max(0, Date.now() - (store.startedAtMs || Date.now()));
  const status = Number.isFinite(store.status) ? store.status : 0;
  const event = {
    event: EVENT_NAME,
    correlation_id: store.correlation_id,
    method: store.method,
    route_class: store.route_class,
    status,
    duration_ms: durationMs,
    client_slug: store.client_slug || null,
    location_id: store.location_id || null,
    error_class: classifyErrorClass(status, !!store.aborted),
  };

  // Fail-closed: drop anything not on the allowlist.
  const out = {};
  for (const key of EVENT_ALLOWED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(event, key)) {
      out[key] = event[key];
    }
  }
  for (const bad of FORBIDDEN_EVENT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, bad)) {
      delete out[bad];
    }
  }
  return out;
}

/**
 * Emit at most once per request store.
 * @param {object} store
 */
function emitCompletionOnce(store) {
  if (!store || store.completed) return;
  store.completed = true;
  const event = buildCompletionEvent(store);
  try {
    emitSink(event);
  } catch (_) {
    // Never let logging break the response path.
  }
}

/**
 * Capture status from writeHead / statusCode without buffering the body.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} store
 */
function attachResponseCorrelation(req, res, store) {
  // Ensure header is present even when handlers call write()/end() first.
  try {
    res.setHeader(CORRELATION_HEADER_CANON, store.correlation_id);
  } catch (_) {
    // Headers may already be sent in exotic paths; completion still emits.
  }

  const origWriteHead = res.writeHead;
  res.writeHead = function writeHeadCorrelated(...args) {
    if (!store.statusCaptured) {
      const code = typeof args[0] === 'number' ? args[0] : res.statusCode;
      if (Number.isFinite(code)) {
        store.status = code;
        store.statusCaptured = true;
      }
    }
    try {
      if (!res.headersSent) {
        // Merge into object-form headers when present.
        if (args.length >= 2 && args[1] && typeof args[1] === 'object' && !Array.isArray(args[1])) {
          args[1][CORRELATION_HEADER_CANON] = store.correlation_id;
        } else if (args.length >= 3 && args[2] && typeof args[2] === 'object' && !Array.isArray(args[2])) {
          args[2][CORRELATION_HEADER_CANON] = store.correlation_id;
        } else {
          res.setHeader(CORRELATION_HEADER_CANON, store.correlation_id);
        }
      }
    } catch (_) { /* ignore */ }
    return origWriteHead.apply(this, args);
  };

  const complete = () => {
    if (!store.statusCaptured) {
      const code = res.statusCode;
      if (Number.isFinite(code)) store.status = code;
    }
    emitCompletionOnce(store);
  };

  res.on('finish', () => {
    store.aborted = false;
    complete();
  });

  res.on('close', () => {
    // close without finish → client abort / connection drop
    if (!res.writableFinished) {
      store.aborted = true;
      if (!store.statusCaptured && Number.isFinite(res.statusCode)) {
        store.status = res.statusCode;
      }
      complete();
    }
  });

  req.on('aborted', () => {
    store.aborted = true;
  });
}

/**
 * Run handler inside ALS request scope. Does not alter handler arity/signature.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => *} handler
 * @returns {Promise<*>}
 */
function runWithRequestCorrelation(req, res, handler) {
  const headerRaw = req && req.headers
    ? (req.headers[CORRELATION_HEADER] || req.headers['X-Request-Id'])
    : undefined;
  // Node lowercases incoming headers; still guard array form.
  const headerVal = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  const accepted = acceptOrGenerateCorrelationId(headerVal);
  const method = String((req && req.method) || 'GET').toUpperCase();
  const routeClass = normalizeRouteClass(req && req.url);

  const store = {
    correlation_id: accepted.correlation_id,
    accepted_from_header: accepted.accepted_from_header,
    method,
    route_class: routeClass,
    status: 0,
    statusCaptured: false,
    startedAtMs: Date.now(),
    client_slug: null,
    location_id: null,
    aborted: false,
    completed: false,
  };

  attachResponseCorrelation(req, res, store);

  return als.run(store, async () => handler(req, res));
}

/**
 * Assert an event object matches the safe completion contract (for verifiers).
 * @param {object} event
 * @returns {{ ok: boolean, detail?: string }}
 */
function assertSafeCompletionEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, detail: 'event_not_object' };
  }
  if (event.event !== EVENT_NAME) {
    return { ok: false, detail: 'bad_event_name' };
  }
  for (const key of Object.keys(event)) {
    if (!EVENT_ALLOWED_KEYS.includes(key)) {
      return { ok: false, detail: `unexpected_key:${key}` };
    }
    if (FORBIDDEN_EVENT_KEYS.includes(key)) {
      return { ok: false, detail: `forbidden_key:${key}` };
    }
  }
  if (!CORRELATION_ID_RE.test(String(event.correlation_id || ''))) {
    return { ok: false, detail: 'bad_correlation_id' };
  }
  if (!/^[A-Z]+$/.test(String(event.method || ''))) {
    return { ok: false, detail: 'bad_method' };
  }
  if (typeof event.route_class !== 'string' || !event.route_class || event.route_class.includes('?')) {
    return { ok: false, detail: 'bad_route_class' };
  }
  if (!Number.isFinite(event.status) || event.status < 0) {
    return { ok: false, detail: 'bad_status' };
  }
  if (!Number.isFinite(event.duration_ms) || event.duration_ms < 0) {
    return { ok: false, detail: 'bad_duration' };
  }
  if (event.client_slug != null && !sanitizeScopeToken(event.client_slug)) {
    return { ok: false, detail: 'bad_client_slug' };
  }
  if (event.location_id != null && !sanitizeScopeToken(event.location_id)) {
    return { ok: false, detail: 'bad_location_id' };
  }
  if (event.error_class != null) {
    const allowed = new Set([
      'aborted',
      'unauthorized',
      'forbidden',
      'not_found',
      'method_not_allowed',
      'server_error',
      'client_error',
    ]);
    if (!allowed.has(event.error_class)) {
      return { ok: false, detail: 'bad_error_class' };
    }
  }
  const blob = JSON.stringify(event);
  if (/\?/.test(blob) && /route_class":"[^"]*\?/.test(blob)) {
    return { ok: false, detail: 'query_in_route_class' };
  }
  return { ok: true };
}

module.exports = {
  CORRELATION_HEADER,
  CORRELATION_HEADER_CANON,
  CORRELATION_ID_RE,
  CORRELATION_ID_MAX_LEN,
  EVENT_NAME,
  EVENT_ALLOWED_KEYS,
  FORBIDDEN_EVENT_KEYS,
  generateCorrelationId,
  acceptOrGenerateCorrelationId,
  pathnameOnly,
  normalizeRouteClass,
  classifyErrorClass,
  sanitizeScopeToken,
  bindAuthoritativeRuntimeScope,
  getRequestCorrelationContext,
  buildCompletionEvent,
  emitCompletionOnce,
  attachResponseCorrelation,
  runWithRequestCorrelation,
  setCorrelationEmitSink,
  assertSafeCompletionEvent,
  // Exposed for verifier double-completion / abort unit proofs.
  _als: als,
};
