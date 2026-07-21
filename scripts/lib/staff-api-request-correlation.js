'use strict';

/**
 * Staff API request correlation (RADAR 16J) — HTTP boundary only.
 *
 * Contract (source-partial; supersedes deferred 16D):
 * - Accept x-request-id only when it is a strict lowercase/uppercase UUIDv4
 *   canonical form; normalize to lowercase. Otherwise generate crypto.randomUUID().
 * - Set response x-request-id before route handling.
 * - Propagate via AsyncLocalStorage; expose getRequestContext / requestId.
 * - Trusted tenant slug from construction-time ingress binding only.
 * - No request/response finish/close/aborted/error listeners.
 * - No duration/route/status completion logging, console emission, or one-record claims.
 * - Outcome is header + AsyncLocalStorage context only.
 */

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const CORRELATION_HEADER = 'x-request-id';
const CORRELATION_HEADER_CANON = 'X-Request-Id';

/** Canonical UUIDv4 (version nibble 4, variant 8/9/a/b). Case-insensitive accept. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ROUTE_MAX_LEN = 160;

const als = new AsyncLocalStorage();

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
 * Used only for ALS context — never logged by this module.
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
 * Dedicated immutable Staff API ingress-tenant env (RADAR 16AN).
 * Prefer this over DEFAULT_CLIENT_SLUG so admission identity does not silently
 * alter unrelated portal / payment / bot / Stripe route defaults.
 */
const STAFF_API_INGRESS_TENANT_SLUG_ENV = 'STAFF_API_INGRESS_TENANT_SLUG';
const DEFAULT_CLIENT_SLUG_ENV = 'DEFAULT_CLIENT_SLUG';

/**
 * Resolve trusted ingress binding from explicit options or process env.
 * Priority (deployment ingress binding only — never request input):
 *   1. STAFF_API_INGRESS_TENANT_SLUG (dedicated, preferred)
 *   2. DEFAULT_CLIENT_SLUG nonempty compat fallback
 *   3. Both set and conflicting → fail closed (tenant_slug null)
 *   4. Neither set → absent
 * @param {unknown} [explicit]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   tenant_slug: string|null,
 *   present: boolean,
 *   source?: string|null,
 *   conflict?: boolean,
 * }}
 */
function resolveTrustedIngressBinding(explicit, env = process.env) {
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) {
    return validateTrustedIngressBinding(explicit);
  }
  const src = env || {};
  const dedicatedRaw = src[STAFF_API_INGRESS_TENANT_SLUG_ENV];
  const defaultRaw = src[DEFAULT_CLIENT_SLUG_ENV];
  const dedicated = dedicatedRaw != null ? String(dedicatedRaw).trim() : '';
  const fallback = defaultRaw != null ? String(defaultRaw).trim() : '';

  if (dedicated && fallback && dedicated !== fallback) {
    return Object.freeze({
      tenant_slug: null,
      present: false,
      source: null,
      conflict: true,
    });
  }

  if (dedicated) {
    const binding = validateTrustedIngressBinding({ tenant_slug: dedicated });
    return Object.freeze({
      tenant_slug: binding.tenant_slug,
      present: binding.present,
      source: binding.present ? STAFF_API_INGRESS_TENANT_SLUG_ENV : null,
      conflict: false,
    });
  }

  if (fallback) {
    const binding = validateTrustedIngressBinding({ tenant_slug: fallback });
    return Object.freeze({
      tenant_slug: binding.tenant_slug,
      present: binding.present,
      source: binding.present ? DEFAULT_CLIENT_SLUG_ENV : null,
      conflict: false,
    });
  }

  return Object.freeze({
    tenant_slug: null,
    present: false,
    source: null,
    conflict: false,
  });
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
 * Set response x-request-id before route handling. No lifecycle listeners.
 * @param {import('http').ServerResponse} res
 * @param {string} id
 */
function setResponseCorrelationHeader(res, id) {
  try {
    res.setHeader(CORRELATION_HEADER_CANON, id);
  } catch (_) {
    // Headers may already be sent in exotic paths; do not alter response semantics.
  }
}

/**
 * Snapshot req/res listener counts for verifier proofs (no side effects).
 * @param {import('events').EventEmitter} ee
 * @returns {{ finish: number, close: number, error: number, aborted: number }}
 */
function countLifecycleListeners(ee) {
  if (!ee || typeof ee.listenerCount !== 'function') {
    return { finish: 0, close: 0, error: 0, aborted: 0 };
  }
  return {
    finish: ee.listenerCount('finish'),
    close: ee.listenerCount('close'),
    error: ee.listenerCount('error'),
    aborted: ee.listenerCount('aborted'),
  };
}

/**
 * Run handler inside ALS request scope. Does not alter handler arity/signature.
 * Does not attach finish/close/aborted/error listeners. Does not emit logs.
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
    tenant_slug: binding.tenant_slug,
    ingress_binding_present: binding.present,
  };

  // Set response header before route handling — no lifecycle instrumentation.
  setResponseCorrelationHeader(res, store.request_id);

  return als.run(store, async () => handler(req, res));
}

module.exports = {
  CORRELATION_HEADER,
  CORRELATION_HEADER_CANON,
  UUID_V4_RE,
  STAFF_API_INGRESS_TENANT_SLUG_ENV,
  DEFAULT_CLIENT_SLUG_ENV,
  generateRequestId,
  acceptOrGenerateRequestId,
  pathnameOnly,
  normalizeRoute,
  sanitizeTenantSlug,
  validateTrustedIngressBinding,
  resolveTrustedIngressBinding,
  getRequestContext,
  requestId,
  setResponseCorrelationHeader,
  countLifecycleListeners,
  runWithRequestCorrelation,
  // Exposed for verifier concurrent-isolation proofs.
  _als: als,
};
