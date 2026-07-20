'use strict';

/**
 * Staff API request completion log (RADAR 16N) — synchronous normal-settlement only.
 *
 * Builds on 16J ALS correlation. Emits exactly one allowlisted JSON record via the
 * existing console/process stdout logger when the HTTP boundary handler settles
 * (try/catch/finally around the awaited ALS-wrapped handler).
 *
 * Explicitly does NOT:
 * - attach req/res finish/close/aborted/error listeners
 * - install process signals / change exit codes
 * - queue / buffer / flush / claim delivery
 * - claim capture of abrupt process/socket termination
 */

const {
  getRequestContext,
  normalizeRoute,
  sanitizeTenantSlug,
  UUID_V4_RE,
} = require('./staff-api-request-correlation');

const EVENT_NAME = 'staff_api_request_completed';

/** Ceil duration to this millisecond bucket to bound cardinality. */
const DURATION_MS_BUCKET = 5;

/** Hard cap for duration_ms (5 minutes). */
const DURATION_MS_CAP = 300000;

const STATUS_CODE_MIN = 100;
const STATUS_CODE_MAX = 599;

const ALLOWED_METHODS = Object.freeze([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

const EVENT_ALLOWED_KEYS = Object.freeze([
  'event',
  'request_id',
  'tenant_slug',
  'method',
  'route',
  'status_code',
  'duration_ms',
]);

const FORBIDDEN_EVENT_KEYS = Object.freeze([
  'url',
  'raw_url',
  'path',
  'pathname',
  'query',
  'body',
  'headers',
  'header',
  'authorization',
  'cookie',
  'token',
  'key',
  'password',
  'secret',
  'stack',
  'message',
  'error',
  'error_message',
  'errorMessage',
  'error_class',
  'guest',
  'customer',
  'phone',
  'email',
  'name',
  'req',
  'res',
  'correlation_id',
]);

/**
 * Allowlist + uppercase HTTP method. Unknown → 'GET' (safe low-cardinality default).
 * @param {unknown} raw
 * @returns {string}
 */
function allowlistMethod(raw) {
  const m = String(raw || 'GET').toUpperCase();
  return ALLOWED_METHODS.includes(m) ? m : 'GET';
}

/**
 * Bound status_code to a finite HTTP-ish integer range.
 * @param {unknown} raw
 * @returns {number}
 */
function boundStatusCode(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  const i = Math.trunc(n);
  if (i < STATUS_CODE_MIN || i > STATUS_CODE_MAX) return 0;
  return i;
}

/**
 * Round duration UP to 5ms bucket and cap at DURATION_MS_CAP.
 * @param {number} ms
 * @returns {number}
 */
function bucketDurationMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  const bucketed = Math.ceil(n / DURATION_MS_BUCKET) * DURATION_MS_BUCKET;
  return Math.min(DURATION_MS_CAP, bucketed);
}

/**
 * Build allowlisted completion record. Never includes query/raw URL/headers/body/PII.
 * @param {{
 *   request_id?: unknown,
 *   tenant_slug?: unknown,
 *   method?: unknown,
 *   route?: unknown,
 *   status_code?: unknown,
 *   duration_ms?: unknown,
 * }} fields
 * @returns {object|null}
 */
function buildRequestCompletedRecord(fields) {
  const requestId = typeof fields.request_id === 'string' ? fields.request_id : '';
  if (!UUID_V4_RE.test(requestId) || requestId !== requestId.toLowerCase()) {
    return null;
  }

  const method = allowlistMethod(fields.method);
  let route = typeof fields.route === 'string' ? fields.route : '/';
  if (!route || route.includes('?') || route.includes('#')) {
    route = normalizeRoute(route);
  }
  if (typeof route !== 'string' || !route.startsWith('/') || route.includes('?') || route.includes('#')) {
    route = '/';
  }

  const record = {
    event: EVENT_NAME,
    request_id: requestId,
    method,
    route,
    status_code: boundStatusCode(fields.status_code),
    duration_ms: bucketDurationMs(fields.duration_ms),
  };

  const tenant = sanitizeTenantSlug(fields.tenant_slug);
  if (tenant) {
    record.tenant_slug = tenant;
  }

  const out = {};
  for (const key of EVENT_ALLOWED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      out[key] = record[key];
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
 * Default synchronous stdout logger (existing console).
 * @param {object} record
 */
function defaultCompletionLogger(record) {
  console.log(JSON.stringify(record));
}

/** @type {(record: object) => void} */
let completionLogger = defaultCompletionLogger;

/**
 * Test harness override. Pass null to restore default console logger.
 * @param {((record: object) => void) | null} fn
 */
function setCompletionLogger(fn) {
  completionLogger = typeof fn === 'function' ? fn : defaultCompletionLogger;
}

/**
 * Emit exactly one allowlisted completion record for normal handler settlement.
 * Logger failures are swallowed — must not alter response/handler/process semantics.
 * Reads request_id / method / route / tenant from ALS (16J); status from res.statusCode.
 *
 * @param {{
 *   startedAtMs: number,
 *   res?: { statusCode?: number },
 *   trustedTenantSlug?: unknown,
 * }} opts
 */
function emitStaffApiRequestCompleted(opts) {
  try {
    const ctx = getRequestContext();
    if (!ctx || !ctx.requestId) return;

    const startedAtMs = Number(opts && opts.startedAtMs);
    // Ensure at least 1ms so ceil-to-5ms bucket is non-zero for settled requests.
    const elapsed = Number.isFinite(startedAtMs)
      ? Math.max(1, Date.now() - startedAtMs)
      : 1;

    // tenant_slug from trusted construction binding only (passed explicitly),
    // never from request headers/query/body. Prefer explicit trusted binding;
    // ALS tenantSlug is also construction-bound by 16J.
    const trusted = opts && Object.prototype.hasOwnProperty.call(opts, 'trustedTenantSlug')
      ? opts.trustedTenantSlug
      : (ctx.tenantSlug || null);

    const record = buildRequestCompletedRecord({
      request_id: ctx.requestId,
      tenant_slug: trusted,
      method: ctx.method,
      route: ctx.route,
      status_code: opts && opts.res ? opts.res.statusCode : 0,
      duration_ms: elapsed,
    });
    if (!record) return;

    try {
      completionLogger(record);
    } catch (_) {
      // Logger failure must not alter response / handler rejection / process semantics.
    }
  } catch (_) {
    // Never let completion logging break the request path.
  }
}

/**
 * Assert a record matches the safe 16N completion contract (for verifiers).
 * @param {object} event
 * @returns {{ ok: boolean, detail?: string }}
 */
function assertSafeRequestCompletedRecord(event) {
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
  if (!ALLOWED_METHODS.includes(String(event.method || ''))) {
    return { ok: false, detail: 'bad_method' };
  }
  if (typeof event.route !== 'string' || !event.route || event.route.includes('?') || event.route.includes('#')) {
    return { ok: false, detail: 'bad_route' };
  }
  if (!Number.isFinite(event.status_code)
    || event.status_code < 0
    || (event.status_code !== 0 && (event.status_code < STATUS_CODE_MIN || event.status_code > STATUS_CODE_MAX))) {
    return { ok: false, detail: 'bad_status_code' };
  }
  if (!Number.isFinite(event.duration_ms) || event.duration_ms < 0) {
    return { ok: false, detail: 'bad_duration' };
  }
  if (event.duration_ms % DURATION_MS_BUCKET !== 0) {
    return { ok: false, detail: 'duration_not_bucketed' };
  }
  if (event.duration_ms > DURATION_MS_CAP) {
    return { ok: false, detail: 'duration_over_cap' };
  }
  if (Object.prototype.hasOwnProperty.call(event, 'tenant_slug')) {
    if (event.tenant_slug != null && !sanitizeTenantSlug(event.tenant_slug)) {
      return { ok: false, detail: 'bad_tenant_slug' };
    }
  }
  return { ok: true };
}

/**
 * Parse completion records from captured console lines.
 * @param {string[]} lines
 * @returns {object[]}
 */
function parseCompletionRecordsFromConsole(lines) {
  const out = [];
  for (const line of lines || []) {
    const s = String(line || '').trim();
    if (!s.includes(EVENT_NAME)) continue;
    // Find JSON object start
    const idx = s.indexOf('{');
    if (idx < 0) continue;
    try {
      const obj = JSON.parse(s.slice(idx));
      if (obj && obj.event === EVENT_NAME) out.push(obj);
    } catch (_) {
      // ignore non-JSON noise
    }
  }
  return out;
}

module.exports = {
  EVENT_NAME,
  DURATION_MS_BUCKET,
  DURATION_MS_CAP,
  STATUS_CODE_MIN,
  STATUS_CODE_MAX,
  ALLOWED_METHODS,
  EVENT_ALLOWED_KEYS,
  FORBIDDEN_EVENT_KEYS,
  allowlistMethod,
  boundStatusCode,
  bucketDurationMs,
  buildRequestCompletedRecord,
  emitStaffApiRequestCompleted,
  setCompletionLogger,
  assertSafeRequestCompletedRecord,
  parseCompletionRecordsFromConsole,
};
