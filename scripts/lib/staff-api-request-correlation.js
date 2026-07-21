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

/** Bounded non-sensitive reason codes for env ingress binding (never echo raw values). */
const INGRESS_ENV_REASONS = Object.freeze({
  ABSENT: 'absent',
  READ_THREW: 'read_threw',
  NULLISH: 'nullish',
  NON_STRING: 'non_string',
  BLANK: 'blank',
  CONTROL_CHAR: 'control_char',
  OVERSIZE: 'oversize',
  INVALID_SLUG: 'invalid_slug',
  CONFLICT: 'conflict',
  DEFAULT_INVALID: 'default_invalid',
  EXPLICIT_INVALID: 'explicit_invalid',
});

/**
 * Own-property presence only — inherited/prototype keys are absent.
 * Does not coerce values.
 * @param {unknown} env
 * @param {string} key
 * @returns {boolean}
 */
function envHasOwnProperty(env, key) {
  return env != null
    && (typeof env === 'object' || typeof env === 'function')
    && Object.prototype.hasOwnProperty.call(env, key);
}

/**
 * Read an own env property without String coercion.
 * Inherited keys → absent. Getter throw → present + read_threw.
 * @param {unknown} env
 * @param {string} key
 * @returns {{ present: boolean, value: unknown, read_error: string|null }}
 */
function readOwnEnvProperty(env, key) {
  if (!envHasOwnProperty(env, key)) {
    return { present: false, value: undefined, read_error: null };
  }
  try {
    return { present: true, value: env[key], read_error: null };
  } catch (_) {
    return { present: true, value: undefined, read_error: INGRESS_ENV_REASONS.READ_THREW };
  }
}

/**
 * Classify a present env slug candidate. Primitive string only — no String().
 * Blank/whitespace, non-string (number/object/array/boxed), NUL/control,
 * oversize, Unicode/pattern-invalid → fail with bounded reason (no raw echo).
 * @param {unknown} raw
 * @param {string|null} readError
 * @returns {{ ok: boolean, slug: string|null, reason: string|null }}
 */
function classifyPresentEnvSlug(raw, readError) {
  if (readError) {
    return { ok: false, slug: null, reason: INGRESS_ENV_REASONS.READ_THREW };
  }
  if (raw === undefined || raw === null) {
    return { ok: false, slug: null, reason: INGRESS_ENV_REASONS.NULLISH };
  }
  // Reject boxed String / Number / Object / Array — typeof alone, never String(raw).
  if (typeof raw !== 'string') {
    return { ok: false, slug: null, reason: INGRESS_ENV_REASONS.NON_STRING };
  }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return { ok: false, slug: null, reason: INGRESS_ENV_REASONS.CONTROL_CHAR };
    }
  }
  const slug = sanitizeTenantSlug(raw);
  if (slug) {
    return { ok: true, slug, reason: null };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, slug: null, reason: INGRESS_ENV_REASONS.BLANK };
  }
  if (trimmed.length > 64) {
    return { ok: false, slug: null, reason: INGRESS_ENV_REASONS.OVERSIZE };
  }
  return { ok: false, slug: null, reason: INGRESS_ENV_REASONS.INVALID_SLUG };
}

/**
 * @param {string} reason
 * @param {boolean} [conflict]
 * @returns {{ tenant_slug: null, present: false, source: null, conflict: boolean, reason: string }}
 */
function absentIngressBinding(reason, conflict) {
  return Object.freeze({
    tenant_slug: null,
    present: false,
    source: null,
    conflict: conflict === true,
    reason,
  });
}

/**
 * Resolve trusted ingress binding from explicit options or process env.
 * Priority (deployment ingress binding only — never request input):
 *   1. Explicit construction binding (options.ingressBinding) — unchanged precedence
 *   2. Own STAFF_API_INGRESS_TENANT_SLUG: must be primitive string + slug-valid;
 *      present-but-malformed → fail closed (never fall through to DEFAULT)
 *   3. Only when dedicated is truly absent: own DEFAULT_CLIENT_SLUG compat
 *      fallback (same strict primitive-string rules; malformed → fail closed)
 *   4. Both own+valid and normalized unequal → conflict fail-closed
 *   5. Neither own → absent
 * @param {unknown} [explicit]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   tenant_slug: string|null,
 *   present: boolean,
 *   source?: string|null,
 *   conflict?: boolean,
 *   reason?: string|null,
 * }}
 */
function resolveTrustedIngressBinding(explicit, env = process.env) {
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) {
    const binding = validateTrustedIngressBinding(explicit);
    return Object.freeze({
      tenant_slug: binding.tenant_slug,
      present: binding.present,
      source: binding.present ? 'explicit' : null,
      conflict: false,
      reason: binding.present ? null : INGRESS_ENV_REASONS.EXPLICIT_INVALID,
    });
  }

  const src = env && (typeof env === 'object' || typeof env === 'function') ? env : {};
  const dedicatedRead = readOwnEnvProperty(src, STAFF_API_INGRESS_TENANT_SLUG_ENV);
  const defaultRead = readOwnEnvProperty(src, DEFAULT_CLIENT_SLUG_ENV);

  if (dedicatedRead.present) {
    const dedicated = classifyPresentEnvSlug(dedicatedRead.value, dedicatedRead.read_error);
    if (!dedicated.ok) {
      // Present dedicated is authoritative: never fall through to DEFAULT_CLIENT_SLUG.
      return absentIngressBinding(dedicated.reason);
    }

    if (defaultRead.present) {
      const fallback = classifyPresentEnvSlug(defaultRead.value, defaultRead.read_error);
      if (!fallback.ok) {
        return absentIngressBinding(INGRESS_ENV_REASONS.DEFAULT_INVALID);
      }
      if (dedicated.slug !== fallback.slug) {
        return absentIngressBinding(INGRESS_ENV_REASONS.CONFLICT, true);
      }
    }

    return Object.freeze({
      tenant_slug: dedicated.slug,
      present: true,
      source: STAFF_API_INGRESS_TENANT_SLUG_ENV,
      conflict: false,
      reason: null,
    });
  }

  // Dedicated truly absent (not own) — strict DEFAULT_CLIENT_SLUG compatibility fallback.
  if (defaultRead.present) {
    const fallback = classifyPresentEnvSlug(defaultRead.value, defaultRead.read_error);
    if (!fallback.ok) {
      return absentIngressBinding(fallback.reason);
    }
    return Object.freeze({
      tenant_slug: fallback.slug,
      present: true,
      source: DEFAULT_CLIENT_SLUG_ENV,
      conflict: false,
      reason: null,
    });
  }

  return absentIngressBinding(INGRESS_ENV_REASONS.ABSENT);
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
  INGRESS_ENV_REASONS,
  generateRequestId,
  acceptOrGenerateRequestId,
  pathnameOnly,
  normalizeRoute,
  sanitizeTenantSlug,
  validateTrustedIngressBinding,
  resolveTrustedIngressBinding,
  envHasOwnProperty,
  readOwnEnvProperty,
  classifyPresentEnvSlug,
  getRequestContext,
  requestId,
  setResponseCorrelationHeader,
  countLifecycleListeners,
  runWithRequestCorrelation,
  // Exposed for verifier concurrent-isolation proofs.
  _als: als,
};
