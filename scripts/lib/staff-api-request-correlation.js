'use strict';

/**
 * Staff API request correlation (RADAR 16J) — HTTP boundary only.
 *
 * Contract (source-partial; supersedes deferred 16D):
 * - Accept x-request-id only when it is a strict lowercase/uppercase UUIDv4
 *   canonical form; normalize to lowercase. Otherwise generate crypto.randomUUID().
 * - Set response x-request-id before route handling.
 * - Propagate via AsyncLocalStorage; expose getRequestContext / requestId.
 * - Emit at most one minimal synchronous structured completion JSON record via
 *   the existing process logger (console) — no async queue, no signal/shutdown
 *   ownership, no exit-code mutation, no process handler install.
 * - Fields: request_id, tenant_slug (trusted ingress binding only), method,
 *   route (normalized template / pathname without query), status,
 *   duration_ms (ceil bucket bound).
 * - Never log URL query, headers, body, phone/email/name, tokens, stack/error text.
 * - On finish/close/error paths emit at most once; preserve original semantics.
 * - No flush/delivery guarantee claimed.
 */

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const CORRELATION_HEADER = 'x-request-id';
const CORRELATION_HEADER_CANON = 'X-Request-Id';

/** Canonical UUIDv4 (version nibble 4, variant 8/9/a/b). Case-insensitive accept. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EVENT_NAME = 'staff_api_http_request_complete';

/** Ceil duration to this millisecond bucket to bound cardinality. */
const DURATION_MS_BUCKET = 5;

const ROUTE_MAX_LEN = 160;

const EVENT_ALLOWED_KEYS = Object.freeze([
  'event',
  'request_id',
  'tenant_slug',
  'method',
  'route',
  'status',
  'duration_ms',
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
  'error_class',
  'guest',
  'phone',
  'email',
  'name',
  'raw_url',
  'req',
  'res',
  'correlation_id',
]);

const als = new AsyncLocalStorage();

/** @type {(event: object) => void} */
let emitSink = defaultEmitSink;

function defaultEmitSink(event) {
  // Stay quiet under NODE_ENV=test unless a verifier installs a sink.
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') return;
  // Synchronous process logger only — no queue, no handlers, no exit mutation.
  console.log(JSON.stringify(event));
}

/**
 * Test/harness override for completion emission. Pass null to restore default.
 * @param {((event: object) => void) | null} fn
 */
function setCompletionEmitSink(fn) {
  emitSink = typeof fn === 'function' ? fn : defaultEmitSink;
}

/**
 * @returns {string}
 */
function generateRequestId() {
  return crypto.randomUUID();
}

/**
 * Accept only strict UUIDv4 canonical form (any hex case); normalize lowercase.
 * Arrays / non-strings / invalid / oversize → generate.
 * @param {unknown} raw
 * @returns {{ request_id: string, accepted_from_header: boolean, reject_reason: string|null }}
 */
function acceptOrGenerateRequestId(raw) {
  if (Array.isArray(raw)) {
    return {
      request_id: generateRequestId(),
      accepted_from_header: false,
      reject_reason: 'ambiguous_array',
    };
  }
  if (raw == null) {
    return {
      request_id: generateRequestId(),
      accepted_from_header: false,
      reject_reason: 'missing',
    };
  }
  if (typeof raw !== 'string') {
    return {
      request_id: generateRequestId(),
      accepted_from_header: false,
      reject_reason: 'non_string',
    };
  }
  // Oversize / undersize cheap reject before regex (UUIDv4 is exactly 36 chars).
  if (raw.length !== 36) {
    return {
      request_id: generateRequestId(),
      accepted_from_header: false,
      reject_reason: raw.length > 36 ? 'oversize' : 'undersize',
    };
  }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      return {
        request_id: generateRequestId(),
        accepted_from_header: false,
        reject_reason: 'non_ascii',
      };
    }
  }
  if (!UUID_V4_RE.test(raw)) {
    return {
      request_id: generateRequestId(),
      accepted_from_header: false,
      reject_reason: 'not_uuid_v4',
    };
  }
  return {
    request_id: raw.toLowerCase(),
    accepted_from_header: true,
    reject_reason: null,
  };
}

/**
 * Pathname only — never keep query/hash.
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
 * Normalize to a low-cardinality route template (no raw IDs/query).
 * @param {unknown} pathname
 * @returns {string}
 */
function normalizeRoute(pathname) {
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
  // Guest pay short links
  p = p.replace(/^\/pay\/[^/]+\/[^/]+/i, '/pay/:booking/:guest');
  p = p.replace(/^\/pay\/[^/]+$/i, '/pay/:booking');
  // Long opaque path tokens
  p = p.replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, '/:token');

  if (p.length > ROUTE_MAX_LEN) {
    p = p.slice(0, ROUTE_MAX_LEN);
  }
  return p;
}

/**
 * Strict tenant slug token for trusted ingress binding only.
 * @param {unknown} raw
 * @returns {string|null}
 */
function sanitizeTenantSlug(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 64) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s)) return null;
  return s;
}

/**
 * Validate optional trusted ingress binding (process/construction-time only).
 * Never reads request headers/query/body. Invalid tokens rejected/omitted.
 * @param {unknown} binding
 * @returns {{ tenant_slug: string|null, present: boolean }}
 */
function validateTrustedIngressBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    return Object.freeze({ tenant_slug: null, present: false });
  }
  const tenant_slug = sanitizeTenantSlug(
    binding.tenant_slug != null ? binding.tenant_slug
      : (binding.tenantSlug != null ? binding.tenantSlug
        : (binding.client_slug != null ? binding.client_slug : binding.clientSlug)),
  );
  return Object.freeze({
    tenant_slug,
    present: !!tenant_slug,
  });
}

/**
 * Resolve trusted ingress binding from explicit options or process env.
 * Uses DEFAULT_CLIENT_SLUG only (deployment ingress binding) — never request input.
 * @param {unknown} [explicit]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ tenant_slug: string|null, present: boolean }}
 */
function resolveTrustedIngressBinding(explicit, env = process.env) {
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) {
    return validateTrustedIngressBinding(explicit);
  }
  return validateTrustedIngressBinding({
    tenant_slug: env && env.DEFAULT_CLIENT_SLUG,
  });
}

/**
 * Ceil duration into a fixed millisecond bucket (cardinality bound).
 * @param {number} ms
 * @returns {number}
 */
function bucketDurationMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  return Math.ceil(n / DURATION_MS_BUCKET) * DURATION_MS_BUCKET;
}

/**
 * Active request context for downstream (ALS).
 * @returns {{ requestId: string, tenantSlug: string|null, method: string, route: string } | null}
 */
function getRequestContext() {
  const store = als.getStore();
  if (!store) return null;
  return {
    requestId: store.request_id,
    tenantSlug: store.tenant_slug || null,
    method: store.method,
    route: store.route,
  };
}

/**
 * Convenience accessor for the active request id (or null outside a request).
 * @returns {string|null}
 */
function requestId() {
  const ctx = getRequestContext();
  return ctx ? ctx.requestId : null;
}

/**
 * Build the frozen completion event. Strips forbidden keys defensively.
 * @param {object} store
 * @returns {object}
 */
function buildCompletionEvent(store) {
  const elapsed = Math.max(0, Date.now() - (store.startedAtMs || Date.now()));
  const status = Number.isFinite(store.status) ? store.status : 0;
  const event = {
    event: EVENT_NAME,
    request_id: store.request_id,
    method: store.method,
    route: store.route,
    status,
    duration_ms: bucketDurationMs(elapsed),
  };
  if (store.ingress_binding_present && store.tenant_slug) {
    event.tenant_slug = store.tenant_slug;
  }

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
 * Emit at most once per request store (synchronous sink).
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
 * Capture status and ensure x-request-id is present; emit once on finish/close.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} store
 */
function attachResponseCorrelation(req, res, store) {
  try {
    res.setHeader(CORRELATION_HEADER_CANON, store.request_id);
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
        if (args.length >= 2 && args[1] && typeof args[1] === 'object' && !Array.isArray(args[1])) {
          args[1][CORRELATION_HEADER_CANON] = store.request_id;
        } else if (args.length >= 3 && args[2] && typeof args[2] === 'object' && !Array.isArray(args[2])) {
          args[2][CORRELATION_HEADER_CANON] = store.request_id;
        } else {
          res.setHeader(CORRELATION_HEADER_CANON, store.request_id);
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

  req.on('error', () => {
    store.requestError = true;
    complete();
  });

  res.on('error', () => {
    store.responseError = true;
    complete();
  });
}

/**
 * Run handler inside ALS request scope. Does not alter handler arity/signature.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => *} handler
 * @param {{ ingressBinding?: { tenant_slug?: unknown, tenantSlug?: unknown, client_slug?: unknown, clientSlug?: unknown } }} [opts]
 * @returns {Promise<*>}
 */
function runWithRequestCorrelation(req, res, handler, opts = {}) {
  const headerRaw = req && req.headers
    ? (req.headers[CORRELATION_HEADER] || req.headers['X-Request-Id'])
    : undefined;
  const headerVal = Array.isArray(headerRaw) ? headerRaw : headerRaw;
  const accepted = acceptOrGenerateRequestId(headerVal);
  const method = String((req && req.method) || 'GET').toUpperCase();
  const route = normalizeRoute(req && req.url);
  const binding = validateTrustedIngressBinding(opts && opts.ingressBinding);

  const store = {
    request_id: accepted.request_id,
    accepted_from_header: accepted.accepted_from_header,
    method,
    route,
    status: 0,
    statusCaptured: false,
    startedAtMs: Date.now(),
    tenant_slug: binding.tenant_slug,
    ingress_binding_present: binding.present,
    aborted: false,
    requestError: false,
    responseError: false,
    completed: false,
  };

  // Set response header before route handling.
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
  if (!UUID_V4_RE.test(String(event.request_id || ''))
    || String(event.request_id) !== String(event.request_id).toLowerCase()) {
    return { ok: false, detail: 'bad_request_id' };
  }
  if (!/^[A-Z]+$/.test(String(event.method || ''))) {
    return { ok: false, detail: 'bad_method' };
  }
  if (typeof event.route !== 'string' || !event.route || event.route.includes('?')) {
    return { ok: false, detail: 'bad_route' };
  }
  if (!Number.isFinite(event.status) || event.status < 0) {
    return { ok: false, detail: 'bad_status' };
  }
  if (!Number.isFinite(event.duration_ms) || event.duration_ms < 0) {
    return { ok: false, detail: 'bad_duration' };
  }
  if (event.duration_ms % DURATION_MS_BUCKET !== 0) {
    return { ok: false, detail: 'duration_not_bucketed' };
  }
  if (Object.prototype.hasOwnProperty.call(event, 'tenant_slug')) {
    if (event.tenant_slug != null && !sanitizeTenantSlug(event.tenant_slug)) {
      return { ok: false, detail: 'bad_tenant_slug' };
    }
  }
  return { ok: true };
}

module.exports = {
  CORRELATION_HEADER,
  CORRELATION_HEADER_CANON,
  UUID_V4_RE,
  EVENT_NAME,
  DURATION_MS_BUCKET,
  EVENT_ALLOWED_KEYS,
  FORBIDDEN_EVENT_KEYS,
  generateRequestId,
  acceptOrGenerateRequestId,
  pathnameOnly,
  normalizeRoute,
  sanitizeTenantSlug,
  validateTrustedIngressBinding,
  resolveTrustedIngressBinding,
  bucketDurationMs,
  getRequestContext,
  requestId,
  buildCompletionEvent,
  emitCompletionOnce,
  attachResponseCorrelation,
  runWithRequestCorrelation,
  setCompletionEmitSink,
  assertSafeCompletionEvent,
  // Exposed for verifier double-completion / abort unit proofs.
  _als: als,
};
