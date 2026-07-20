'use strict';

/**
 * Staff API request completion log (RADAR 16N) — synchronous normal-settlement only.
 *
 * Builds on 16J ALS correlation. Emits exactly one allowlisted JSON record via the
 * existing console/process stdout logger when the HTTP boundary handler settles
 * (try/catch/finally around the awaited ALS-wrapped handler).
 *
 * Route field is fail-closed / low-cardinality: only immutable allowlisted static
 * vocabulary (verified from router) plus exact placeholders `:id` / `:redacted`
 * (and `:truncated` when segment-bounded) or whole-path `/:unmatched`.
 * Never emits arbitrary pathname segment text. Segment-aware length bound never
 * cuts a segment, percent sequence, UTF-8 character, or placeholder.
 *
 * Explicitly does NOT:
 * - attach req/res finish/close/aborted/error listeners
 * - install process signals / change exit codes
 * - queue / buffer / flush / claim delivery
 * - claim capture of abrupt process/socket termination
 */

const {
  getRequestContext,
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

const ROUTE_MAX_LEN = 160;

const ROUTE_ID_PLACEHOLDER = ':id';
const ROUTE_REDACTED_PLACEHOLDER = ':redacted';
const ROUTE_TRUNCATED_PLACEHOLDER = ':truncated';
const ROUTE_UNMATCHED = '/:unmatched';

/** Canonical UUID (v1–v5 variant bits). */
const ROUTE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Pure numeric path ids (router-style). */
const ROUTE_NUMERIC_ID_RE = /^\d{1,18}$/;
/** Long hex tokens (structurally strict; same family as 16J correlation). */
const ROUTE_HEX_ID_RE = /^[0-9a-f]{16,}$/i;
/** Booking-code grammar proven in router docs (e.g. WH-260528-1493). */
const ROUTE_WH_BOOKING_CODE_RE = /^WH-[A-Z0-9-]{4,40}$/i;

/**
 * Immutable allowlist of known static route vocabulary for operational grouping.
 * Derived from Staff API router string equality paths + regex static literals
 * (healthz/readyz/staff/pay + verified canonical segments). Not tenant slugs.
 */
const ROUTE_STATIC_SEGMENT_ALLOWLIST = Object.freeze([
  'add-catalog-service',
  'add-service',
  'addon-request-preview',
  'addon-requests',
  'admin',
  'ai-status',
  'ask-luna',
  'assets',
  'auth',
  'automated-notifications',
  'availability-check',
  'bed-calendar',
  'beds',
  'block',
  'blocks',
  'booking-create',
  'booking-create-from-plan',
  'booking-dry-run',
  'booking-guests',
  'booking-preview',
  'booking-write-eligibility',
  'bookings',
  'bot',
  'bulk-delete',
  'by-phone',
  'calendar',
  'cancel',
  'cancel-payment-link',
  'catalog',
  'catalog-service-lookup',
  'check-guest-automation-gate',
  'checkin-day-preview',
  'clear-messages',
  'config',
  'confirm',
  'confirmation-preview',
  'context',
  'conversation',
  'conversations',
  'create',
  'create-balance-link',
  'create-conversation',
  'create-payment-link',
  'create-stripe-link',
  'customers',
  'date-change-preview',
  'day',
  'detail',
  'draft',
  'edit',
  'edit-preview',
  'effective-pause-state',
  'execute',
  'flight-lookup',
  'full-day-addon',
  'full-day-equipment-addon',
  'generate',
  'generate-guest-payment-link',
  'generate-payment-link',
  'global-pause',
  'global-pause-state',
  'global-resume',
  'group-availability',
  'guest-automation-review-dry-run',
  'guest-inbound-review-dry-run',
  'guest-intake-dry-run',
  'guest-packages',
  'guest-reply-draft',
  'guest-reply-send',
  'guest-simulator-create-hold-draft',
  'guest-simulator-create-stripe-test-link',
  'handoff',
  'handoffs',
  'healthz',
  'house-info',
  'house-notes',
  'images',
  'inbox',
  'intents',
  'joinable-courses',
  'lesson-availability',
  'lesson-capacity',
  'lesson-quote',
  'lesson-times',
  'login',
  'logout',
  'luna-front-desk-logo.png',
  'luna-login-bg.jpg',
  'luna-login-signin-btn.png',
  'manual-bookings',
  'message-events',
  'message-intake-preview',
  'message-templates',
  'messages',
  'meta',
  'move',
  'move-preview',
  'move-targets',
  'needs-human',
  'notification-settings',
  'offering-quote',
  'open-demo-whatsapp-inbound-dry-run',
  'outreach',
  'owner',
  'owner-insights',
  'package-price-preview',
  'pause',
  'pause-state',
  'pay',
  'payment',
  'payment-link',
  'payment-status',
  'payments',
  'plan',
  'plan-and-execute',
  'preview',
  'prices',
  'private-lesson',
  'query',
  'quote',
  'quote-preview',
  'readyz',
  'reassign',
  'record-cash-payment',
  'release',
  'remove-service',
  'rental-price',
  'reset-agent-session',
  'reset-luna-context',
  'reset-luna-phone',
  'resolve',
  'resume',
  'review',
  'rooms',
  'save',
  'schedule',
  'send',
  'send-confirmation',
  'send-reply',
  'service-catalog',
  'services',
  'session',
  'sql',
  'staff',
  'staff-state',
  'status',
  'stripe',
  'stripe-link',
  'success',
  'sunset',
  'surf-forecast',
  'surf-packs',
  'surf-report',
  'tags',
  'test',
  'tour-operator',
  'transfers',
  'ui',
  'update-contact',
  'validate',
  'waiver-link',
  'webhook',
  'whatsapp',
  'whatsapp-numbers',
  'whatsapp-thread-mirror',
]);

const ROUTE_STATIC_SEGMENT_SET = new Set(ROUTE_STATIC_SEGMENT_ALLOWLIST);

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
 * Safe percent-decode — never throws. Malformed encodings left as-is.
 * @param {string} s
 * @returns {string}
 */
function safeDecodeURIComponent(s) {
  if (typeof s !== 'string' || s.indexOf('%') < 0) return s;
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
}

/**
 * Pathname only — never keep query/hash. Decode only safely; never throw.
 * @param {unknown} rawUrl
 * @returns {string}
 */
function completionPathnameOnly(rawUrl) {
  const s = typeof rawUrl === 'string' ? rawUrl : '';
  if (!s) return '/';
  let end = s.length;
  const q = s.indexOf('?');
  const h = s.indexOf('#');
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  let p = s.slice(0, end) || '/';
  p = safeDecodeURIComponent(p);
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '') || '/';
  if (!p.startsWith('/')) p = `/${p}`;
  return p;
}

/**
 * Canonical UUID or pure numeric id → `:id` (before allowlist is fine).
 * @param {string} seg
 * @returns {boolean}
 */
function isUuidOrNumericIdSegment(seg) {
  if (!seg) return false;
  return ROUTE_UUID_RE.test(seg) || ROUTE_NUMERIC_ID_RE.test(seg);
}

/**
 * Strict typed ID grammars proven alongside the router / 16J correlation.
 * Does NOT include broad alphanumeric/underscore/hyphen length classifiers.
 * @param {string} seg
 * @returns {boolean}
 */
function isStrictTypedIdSegment(seg) {
  if (!seg) return false;
  return ROUTE_HEX_ID_RE.test(seg) || ROUTE_WH_BOOKING_CODE_RE.test(seg);
}

/**
 * Recognized identifier segments → `:id` (UUID, digits, strict typed IDs only).
 * Broad 20+ `[A-Za-z0-9_-]` classifiers are intentionally absent.
 * @param {string} seg
 * @returns {boolean}
 */
function isRecognizedIdSegment(seg) {
  return isUuidOrNumericIdSegment(seg) || isStrictTypedIdSegment(seg);
}

/**
 * Segment-aware length bound: output contains ONLY full allowlisted static
 * segments or exact fixed placeholders. Never cuts a segment / percent /
 * UTF-8 / placeholder. If the next full segment would exceed max, append
 * `:truncated` only when that full placeholder fits; otherwise stop at the
 * previous full segment.
 * @param {string[]} segs
 * @returns {string}
 */
function boundNormalizedRouteSegments(segs) {
  if (!Array.isArray(segs) || segs.length === 0) return '/';

  const kept = [];
  for (const seg of segs) {
    const candidate = `/${[...kept, seg].join('/')}`;
    if (candidate.length <= ROUTE_MAX_LEN) {
      kept.push(seg);
      continue;
    }
    const truncCandidate = `/${[...kept, ROUTE_TRUNCATED_PLACEHOLDER].join('/')}`;
    if (truncCandidate.length <= ROUTE_MAX_LEN) {
      kept.push(ROUTE_TRUNCATED_PLACEHOLDER);
    }
    break;
  }
  if (kept.length === 0) return '/';
  return `/${kept.join('/')}`;
}

/**
 * True when every route segment is allowlisted static or an exact placeholder.
 * Whole-path `/` and `/:unmatched` are accepted as special forms.
 * @param {string} route
 * @returns {boolean}
 */
function routeSegmentsAreAllowlistedOrPlaceholders(route) {
  if (typeof route !== 'string' || !route) return false;
  if (route === '/' || route === ROUTE_UNMATCHED) return true;
  if (!route.startsWith('/') || route.includes('?') || route.includes('#')) return false;
  const segs = route.split('/').filter((s) => s.length > 0);
  if (segs.length === 0) return route === '/';
  for (const seg of segs) {
    if (
      seg === ROUTE_ID_PLACEHOLDER
      || seg === ROUTE_REDACTED_PLACEHOLDER
      || seg === ROUTE_TRUNCATED_PLACEHOLDER
    ) {
      continue;
    }
    if (!ROUTE_STATIC_SEGMENT_SET.has(seg)) return false;
  }
  return true;
}

/**
 * Fail-closed low-cardinality route for completion logs.
 * Emits allowlisted static segments only; IDs → `:id`; everything else → `:redacted`.
 * Paths with no allowlisted static segment collapse to `/:unmatched`.
 * Immutable static allowlist is evaluated before non-UUID/non-numeric typed-ID
 * logic so long allowlisted static segments keep their exact value.
 * Query/fragment never retained. Decode failures never throw.
 * Length bound is segment-aware (optional trailing `:truncated`).
 *
 * @param {unknown} rawUrl
 * @returns {string}
 */
function normalizeCompletionRoute(rawUrl) {
  const p = completionPathnameOnly(rawUrl);
  if (p === '/' || p === '') return '/';

  const rawSegs = p.split('/').filter((s) => s.length > 0);
  if (rawSegs.length === 0) return '/';

  const out = [];
  let sawAllowlistedStatic = false;

  for (const rawSeg of rawSegs) {
    const seg = safeDecodeURIComponent(rawSeg);
    if (
      seg === ROUTE_ID_PLACEHOLDER
      || seg === ROUTE_REDACTED_PLACEHOLDER
      || seg === ROUTE_TRUNCATED_PLACEHOLDER
    ) {
      out.push(seg);
      continue;
    }
    // Legacy ALS placeholders → `:id` (never emit raw business placeholder names).
    if (/^:[A-Za-z_][A-Za-z0-9_]*$/.test(seg)) {
      out.push(ROUTE_ID_PLACEHOLDER);
      continue;
    }
    // UUID + numeric before allowlist (structurally unambiguous).
    if (isUuidOrNumericIdSegment(seg)) {
      out.push(ROUTE_ID_PLACEHOLDER);
      continue;
    }
    // Immutable static allowlist BEFORE non-UUID/non-numeric typed-ID logic.
    if (ROUTE_STATIC_SEGMENT_SET.has(seg)) {
      out.push(seg);
      sawAllowlistedStatic = true;
      continue;
    }
    if (isStrictTypedIdSegment(seg)) {
      out.push(ROUTE_ID_PLACEHOLDER);
      continue;
    }
    out.push(ROUTE_REDACTED_PLACEHOLDER);
  }

  if (out.length === 0) return '/';
  if (!sawAllowlistedStatic) return ROUTE_UNMATCHED;

  return boundNormalizedRouteSegments(out);
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
  let route = normalizeCompletionRoute(fields.route);
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
 * Test harness override on THIS module instance. Pass null to restore default.
 * Prefer createStaffQueryApiHttpServer({ completionLogger }) for listener proofs —
 * cache-cleared staff-query-api may hold a different module instance.
 * @param {((record: object) => void) | null} fn
 */
function setCompletionLogger(fn) {
  completionLogger = typeof fn === 'function' ? fn : defaultCompletionLogger;
}

/**
 * Emit exactly one allowlisted completion record for normal handler settlement.
 * Logger failures are swallowed — must not alter response/handler/process semantics.
 * Reads request_id / method / tenant from ALS (16J); route from rawUrl (fail-closed)
 * when provided, else ALS route; status from res.statusCode.
 *
 * @param {{
 *   startedAtMs: number,
 *   res?: { statusCode?: number },
 *   trustedTenantSlug?: unknown,
 *   rawUrl?: unknown,
 *   logger?: ((record: object) => void) | null,
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

    const routeSource = opts && Object.prototype.hasOwnProperty.call(opts, 'rawUrl')
      ? opts.rawUrl
      : (ctx.route || '/');

    const record = buildRequestCompletedRecord({
      request_id: ctx.requestId,
      tenant_slug: trusted,
      method: ctx.method,
      route: routeSource,
      status_code: opts && opts.res ? opts.res.statusCode : 0,
      duration_ms: elapsed,
    });
    if (!record) return;

    const logger = opts && typeof opts.logger === 'function'
      ? opts.logger
      : completionLogger;

    try {
      logger(record);
    } catch (_) {
      // Logger failure must not alter response / handler rejection / process semantics.
      // No console fallback — exactly zero completion JSON when injected logger throws.
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
  // Fail-closed route: only `/`, allowlisted static segments, `:id`, `:redacted`,
  // `:truncated`, or whole-path `/:unmatched`. Never partial segments.
  if (!routeSegmentsAreAllowlistedOrPlaceholders(event.route)) {
    return { ok: false, detail: 'route_non_allowlisted_or_partial_segment' };
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
  ROUTE_MAX_LEN,
  ALLOWED_METHODS,
  EVENT_ALLOWED_KEYS,
  FORBIDDEN_EVENT_KEYS,
  ROUTE_STATIC_SEGMENT_ALLOWLIST,
  ROUTE_ID_PLACEHOLDER,
  ROUTE_REDACTED_PLACEHOLDER,
  ROUTE_TRUNCATED_PLACEHOLDER,
  ROUTE_UNMATCHED,
  allowlistMethod,
  boundStatusCode,
  bucketDurationMs,
  safeDecodeURIComponent,
  completionPathnameOnly,
  isUuidOrNumericIdSegment,
  isStrictTypedIdSegment,
  isRecognizedIdSegment,
  boundNormalizedRouteSegments,
  routeSegmentsAreAllowlistedOrPlaceholders,
  normalizeCompletionRoute,
  buildRequestCompletedRecord,
  emitStaffApiRequestCompleted,
  setCompletionLogger,
  defaultCompletionLogger,
  assertSafeRequestCompletedRecord,
  parseCompletionRecordsFromConsole,
};
