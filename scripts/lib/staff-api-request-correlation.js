'use strict';

/**
 * Staff API request correlation (RADAR 16D) — HTTP boundary only.
 *
 * Contract:
 * - Accept only a strict bounded singleton X-Request-Id, else generate crypto-random hex.
 *   Array / duplicate / ambiguous header values are rejected (generate).
 * - Echo immutable X-Request-Id on every response (setHeader + every writeHead form,
 *   including raw header arrays). Override / remove attempts cannot change it.
 * - Propagate via AsyncLocalStorage without changing handler signatures.
 * - Emit exactly one structured completion event per request on
 *   finish / close / request-abort / request-error / response-error.
 * - Abort classification preserved; when no response completed, emit explicit
 *   bounded synthetic status + error_class.
 * - Route class via finite route-template classifier only; unknown → one class.
 * - Optional immutable process/runtime scope validated once at server construction;
 *   otherwise omit client_slug / location_id. No per-request tenant binder.
 * - Completion logging via one-at-a-time FIFO async delivery queue (never delays
 *   response path). Destination sink is captured per event; promise sinks are
 *   awaited; rejections/throws are caught. Never synchronously drains many events.
 * - Bounded overflow retains the queue bound and emits mandatory structured
 *   overflow accounting with drop count (no silent loss).
 * - Bounded flush hooks for server.close + SIGTERM/SIGINT/beforeExit (idempotent,
 *   no duplicate handlers).
 * - Must never emit raw URL/query/body/headers, guest data, credentials,
 *   tokens, stack traces, or error messages.
 * - Preserve existing response/error behavior and streaming (no body buffering).
 *   Throw-after-headers terminates without changing established response bytes.
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
/** Structured accounting when the bounded delivery queue drops events. */
const OVERFLOW_EVENT_NAME = 'staff_api_correlation_delivery_overflow';

/** Explicit synthetic status when no HTTP response status was established. */
const SYNTHETIC_NO_RESPONSE_STATUS = 0;

/** Default bound for flushCorrelationEmitSink / shutdown flush. */
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

const ROUTE_CLASS_UNKNOWN = 'unknown';
const ROUTE_CLASS_ROOT = 'root';
const ROUTE_CLASS_HEALTHZ = 'healthz';

const ERROR_CLASS_ABORTED = 'aborted';
const ERROR_CLASS_REQUEST_ERROR = 'request_error';
const ERROR_CLASS_RESPONSE_ERROR = 'response_error';
const ERROR_CLASS_NO_RESPONSE = 'no_response';

const SINK_QUEUE_MAX = 256;

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

const STATUS_ERROR_CLASSES = Object.freeze([
  'unauthorized',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'server_error',
  'client_error',
]);

const ALL_ERROR_CLASSES = Object.freeze([
  ERROR_CLASS_ABORTED,
  ERROR_CLASS_REQUEST_ERROR,
  ERROR_CLASS_RESPONSE_ERROR,
  ERROR_CLASS_NO_RESPONSE,
  ...STATUS_ERROR_CLASSES,
]);

const UUID_SEG = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BOOKING_CODE_SEG = '[A-Za-z0-9_-]+';
const CUSTOMER_SEG = '[^/]+';

/**
 * Finite exact route templates (Staff API surface). Unknown paths collapse to ROUTE_CLASS_UNKNOWN.
 * Special-cased: `/` → root, `/healthz` → healthz.
 */
const EXACT_ROUTE_TEMPLATES = Object.freeze([
  '/',
  '/healthz',
  '/images/luna-login-bg.jpg',
  '/staff',
  '/staff/admin/config',
  '/staff/admin/config/full-day-equipment-addon',
  '/staff/admin/config/lesson-capacity',
  '/staff/admin/config/lesson-times',
  '/staff/admin/config/prices',
  '/staff/admin/config/prices/group-availability',
  '/staff/admin/config/private-lesson',
  '/staff/admin/config/surf-packs',
  '/staff/admin/house-notes',
  '/staff/admin/services',
  '/staff/ask-luna',
  '/staff/ask-luna/ai-status',
  '/staff/assets/luna-front-desk-logo.png',
  '/staff/assets/luna-login-signin-btn.png',
  '/staff/auth/login',
  '/staff/auth/logout',
  '/staff/auth/session',
  '/staff/automated-notifications',
  '/staff/bed-calendar',
  '/staff/bed-calendar/reassign/confirm',
  '/staff/bed-calendar/reassign/preview',
  '/staff/bookings/add-service',
  '/staff/bookings/cancel',
  '/staff/bookings/cancel-payment-link',
  '/staff/bookings/create-conversation',
  '/staff/bookings/date-change-preview',
  '/staff/bookings/edit',
  '/staff/bookings/edit-preview',
  '/staff/bookings/generate-guest-payment-link',
  '/staff/bookings/generate-payment-link',
  '/staff/bookings/move',
  '/staff/bookings/move-preview',
  '/staff/bookings/move-targets',
  '/staff/bookings/record-cash-payment',
  '/staff/bookings/remove-service',
  '/staff/bookings/service-catalog',
  '/staff/bot/add-catalog-service',
  '/staff/bot/addon-request-preview',
  '/staff/bot/addon-requests/create',
  '/staff/bot/availability-check',
  '/staff/bot/booking-create-from-plan',
  '/staff/bot/booking-dry-run',
  '/staff/bot/booking-guests/payment-status',
  '/staff/bot/booking-preview',
  '/staff/bot/booking-write-eligibility',
  '/staff/bot/bookings/by-phone',
  '/staff/bot/bookings/cancel',
  '/staff/bot/bookings/confirmation-preview',
  '/staff/bot/bookings/create',
  '/staff/bot/bookings/send-confirmation',
  '/staff/bot/bookings/update-contact',
  '/staff/bot/catalog-service-lookup',
  '/staff/bot/check-guest-automation-gate',
  '/staff/bot/checkin-day-preview',
  '/staff/bot/conversation/needs-human',
  '/staff/bot/effective-pause-state',
  '/staff/bot/global-pause',
  '/staff/bot/global-pause-state',
  '/staff/bot/global-resume',
  '/staff/bot/guest-automation-review-dry-run',
  '/staff/bot/guest-inbound-review-dry-run',
  '/staff/bot/guest-intake-dry-run',
  '/staff/bot/guest-reply-draft',
  '/staff/bot/guest-reply-send',
  '/staff/bot/guest-simulator-create-hold-draft',
  '/staff/bot/guest-simulator-create-stripe-test-link',
  '/staff/bot/house-info',
  '/staff/bot/message-intake-preview',
  '/staff/bot/open-demo-whatsapp-inbound-dry-run',
  '/staff/bot/owner-insights',
  '/staff/bot/package-price-preview',
  '/staff/bot/pause',
  '/staff/bot/pause-state',
  '/staff/bot/payments/create-balance-link',
  '/staff/bot/payments/status',
  '/staff/bot/resume',
  '/staff/bot/sunset/booking-create',
  '/staff/bot/sunset/catalog',
  '/staff/bot/sunset/full-day-addon',
  '/staff/bot/sunset/joinable-courses',
  '/staff/bot/sunset/lesson-availability',
  '/staff/bot/sunset/lesson-quote',
  '/staff/bot/sunset/offering-quote',
  '/staff/bot/sunset/payment-link',
  '/staff/bot/sunset/payment-status',
  '/staff/bot/sunset/private-lesson',
  '/staff/bot/sunset/rental-price',
  '/staff/bot/sunset/waiver-link',
  '/staff/bot/surf-report',
  '/staff/bot/transfers/save',
  '/staff/bot/whatsapp-thread-mirror',
  '/staff/calendar/beds/block',
  '/staff/conversations',
  '/staff/customers',
  '/staff/customers/bulk-delete',
  '/staff/customers/message-templates',
  '/staff/customers/message-templates/generate',
  '/staff/customers/outreach/send',
  '/staff/handoffs',
  '/staff/inbox',
  '/staff/inbox/handoffs',
  '/staff/inbox/message-events',
  '/staff/inbox/send-reply',
  '/staff/intents',
  '/staff/login',
  '/staff/manual-bookings/create',
  '/staff/manual-bookings/preview',
  '/staff/meta/whatsapp/webhook',
  '/staff/notification-settings',
  '/staff/owner/sql/execute',
  '/staff/owner/sql/plan',
  '/staff/owner/sql/plan-and-execute',
  '/staff/owner/sql/validate',
  '/staff/payment/cancel',
  '/staff/payment/success',
  '/staff/query',
  '/staff/quote-preview',
  '/staff/schedule/bookings',
  '/staff/schedule/bookings/catalog',
  '/staff/schedule/bookings/detail',
  '/staff/schedule/bookings/payment-link',
  '/staff/schedule/bookings/quote',
  '/staff/schedule/bookings/stripe-link',
  '/staff/schedule/day',
  '/staff/stripe/cancel',
  '/staff/stripe/success',
  '/staff/stripe/webhook',
  '/staff/surf-forecast',
  '/staff/test/reset-luna-phone',
  '/staff/tour-operator/blocks',
  '/staff/tour-operator/blocks/create',
  '/staff/tour-operator/blocks/preview',
  '/staff/tour-operator/release',
  '/staff/tour-operator/release/preview',
  '/staff/tour-operator/rooms',
  '/staff/transfers/flight-lookup/status',
  '/staff/ui',
  '/staff/whatsapp-numbers',
]);

const EXACT_ROUTE_SET = new Set(EXACT_ROUTE_TEMPLATES);

/**
 * Finite parameterized templates — matched in order; class string never includes raw segments.
 * @type {ReadonlyArray<{ re: RegExp, route_class: string }>}
 */
const PARAM_ROUTE_TEMPLATES = Object.freeze([
  {
    re: new RegExp(`^/staff/conversations/(${UUID_SEG})$`, 'i'),
    route_class: '/staff/conversations/:id',
  },
  {
    re: new RegExp(`^/staff/conversations/(${UUID_SEG})/(messages|context|draft|staff-state)$`, 'i'),
    route_class: '/staff/conversations/:id/:sub',
  },
  {
    re: new RegExp(`^/staff/conversations/(${UUID_SEG})/needs-human$`, 'i'),
    route_class: '/staff/conversations/:id/needs-human',
  },
  {
    re: new RegExp(`^/staff/conversations/(${UUID_SEG})/clear-messages$`, 'i'),
    route_class: '/staff/conversations/:id/clear-messages',
  },
  {
    re: new RegExp(`^/staff/conversations/(${UUID_SEG})/reset-luna-context$`, 'i'),
    route_class: '/staff/conversations/:id/reset-luna-context',
  },
  {
    re: new RegExp(`^/staff/conversations/(${UUID_SEG})/reset-agent-session$`, 'i'),
    route_class: '/staff/conversations/:id/reset-agent-session',
  },
  {
    re: new RegExp(`^/staff/inbox/handoffs/(${UUID_SEG})/review$`, 'i'),
    route_class: '/staff/inbox/handoffs/:id/review',
  },
  {
    re: new RegExp(`^/staff/handoff/(${UUID_SEG})/resolve$`, 'i'),
    route_class: '/staff/handoff/:id/resolve',
  },
  {
    re: new RegExp(`^/staff/payments/(${UUID_SEG})/create-stripe-link$`, 'i'),
    route_class: '/staff/payments/:id/create-stripe-link',
  },
  {
    re: new RegExp(`^/staff/bot/payments/(${UUID_SEG})/create-stripe-link$`, 'i'),
    route_class: '/staff/bot/payments/:id/create-stripe-link',
  },
  {
    re: new RegExp(`^/staff/bot/booking-guests/(${UUID_SEG})/create-payment-link$`, 'i'),
    route_class: '/staff/bot/booking-guests/:id/create-payment-link',
  },
  {
    re: new RegExp(`^/staff/bookings/(${UUID_SEG})/service-records/create-payment-link$`, 'i'),
    route_class: '/staff/bookings/:id/service-records/create-payment-link',
  },
  {
    re: new RegExp(`^/staff/bookings/(${UUID_SEG})/luna-notes$`, 'i'),
    route_class: '/staff/bookings/:id/luna-notes',
  },
  {
    re: new RegExp(`^/staff/bookings/(${BOOKING_CODE_SEG})/context$`, 'i'),
    route_class: '/staff/bookings/:booking_code/context',
  },
  {
    re: new RegExp(`^/staff/bookings/(${BOOKING_CODE_SEG})/guest-packages$`, 'i'),
    route_class: '/staff/bookings/:booking_code/guest-packages',
  },
  {
    re: new RegExp(`^/staff/bot/bookings/(${BOOKING_CODE_SEG})/guest-packages$`, 'i'),
    route_class: '/staff/bot/bookings/:booking_code/guest-packages',
  },
  {
    re: new RegExp(`^/staff/schedule/bookings/(${UUID_SEG})/waiver$`, 'i'),
    route_class: '/staff/schedule/bookings/:id/waiver',
  },
  {
    re: new RegExp(`^/staff/schedule/bookings/(${UUID_SEG})/waiver/submission$`, 'i'),
    route_class: '/staff/schedule/bookings/:id/waiver/submission',
  },
  {
    re: new RegExp(`^/staff/customers/message-templates/(${UUID_SEG})$`, 'i'),
    route_class: '/staff/customers/message-templates/:id',
  },
  {
    re: new RegExp(`^/staff/customers/(${CUSTOMER_SEG})/context$`, 'i'),
    route_class: '/staff/customers/:id/context',
  },
  {
    re: new RegExp(`^/staff/customers/(${CUSTOMER_SEG})/tags$`, 'i'),
    route_class: '/staff/customers/:id/tags',
  },
  {
    re: new RegExp(`^/staff/customers/(${CUSTOMER_SEG})/create-conversation$`, 'i'),
    route_class: '/staff/customers/:id/create-conversation',
  },
  {
    re: new RegExp(`^/staff/customers/(${CUSTOMER_SEG})$`, 'i'),
    route_class: '/staff/customers/:id',
  },
  {
    re: /^\/pay\/[^/]+\/g\d+$/i,
    route_class: '/pay/:booking/:guest',
  },
  {
    re: /^\/pay\/[^/]+$/i,
    route_class: '/pay/:booking',
  },
]);

const als = new AsyncLocalStorage();

/** @type {(event: object) => void | Promise<void>} */
let emitSink = defaultEmitSink;

/**
 * One-at-a-time FIFO delivery queue. Each item captures its destination sink
 * at enqueue time so later sink replacement cannot redirect queued events.
 * @type {{ event: object, sink: Function }[]}
 */
const deliveryQueue = [];
/** @deprecated alias retained for verifier introspection */
const sinkQueue = deliveryQueue;

let deliveryInFlight = false;
let deliveryPumpScheduled = false;
/** Drops since last overflow accounting emission (never silently forgotten). */
let pendingOverflowDrops = 0;

const CORR_SERVER_CLOSE_FLAG = Symbol.for('wh.radar16d.correlationCloseWrapped');

/** @type {{ remove: () => void, handler: Function } | null} */
let processShutdownHooks = null;

function defaultEmitSink(event) {
  // Stay quiet under NODE_ENV=test unless a verifier installs a sink.
  // Staging/prod emit one JSON line for ops correlation.
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') return;
  console.log(JSON.stringify(event));
}

/**
 * Test/harness override for completion emission. Pass null to restore default.
 * Already-queued events keep the sink captured at enqueue time.
 * @param {((event: object) => void | Promise<void>) | null} fn
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
 * Accept only strict bounded singleton header values; otherwise generate.
 * Array / duplicate / ambiguous forms are always rejected.
 * @param {unknown} raw
 * @returns {{ correlation_id: string, accepted_from_header: boolean, reject_reason: string|null }}
 */
function acceptOrGenerateCorrelationId(raw) {
  if (Array.isArray(raw)) {
    return {
      correlation_id: generateCorrelationId(),
      accepted_from_header: false,
      reject_reason: 'ambiguous_array',
    };
  }
  if (raw == null) {
    return {
      correlation_id: generateCorrelationId(),
      accepted_from_header: false,
      reject_reason: 'missing',
    };
  }
  if (typeof raw !== 'string') {
    return {
      correlation_id: generateCorrelationId(),
      accepted_from_header: false,
      reject_reason: 'non_string',
    };
  }
  // Comma-joined duplicate header forms (ambiguous).
  if (raw.includes(',')) {
    return {
      correlation_id: generateCorrelationId(),
      accepted_from_header: false,
      reject_reason: 'ambiguous_duplicate',
    };
  }
  if (raw.length < 8 || raw.length > CORRELATION_ID_MAX_LEN) {
    return {
      correlation_id: generateCorrelationId(),
      accepted_from_header: false,
      reject_reason: 'length',
    };
  }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      return {
        correlation_id: generateCorrelationId(),
        accepted_from_header: false,
        reject_reason: 'non_ascii',
      };
    }
  }
  if (!CORRELATION_ID_RE.test(raw)) {
    return {
      correlation_id: generateCorrelationId(),
      accepted_from_header: false,
      reject_reason: 'pattern',
    };
  }
  return { correlation_id: raw, accepted_from_header: true, reject_reason: null };
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
 * Finite route-template classifier. Never emits unmatched raw path segments.
 * @param {unknown} pathnameOrUrl
 * @returns {string}
 */
function classifyRouteTemplate(pathnameOrUrl) {
  const p = pathnameOnly(pathnameOrUrl);
  if (p === '/') return ROUTE_CLASS_ROOT;
  if (p === '/healthz') return ROUTE_CLASS_HEALTHZ;
  if (EXACT_ROUTE_SET.has(p)) return p;
  for (const tmpl of PARAM_ROUTE_TEMPLATES) {
    if (tmpl.re.test(p)) return tmpl.route_class;
  }
  return ROUTE_CLASS_UNKNOWN;
}

/** @deprecated Use classifyRouteTemplate — kept as alias for call-site clarity in migrations. */
function normalizeRouteClass(pathnameOrUrl) {
  return classifyRouteTemplate(pathnameOrUrl);
}

/**
 * Map status / abort / stream errors to a coarse error class — never a message.
 * @param {object} store
 * @returns {string|null}
 */
function classifyErrorClassFromStore(store) {
  // Response-stream errors win when established (may co-occur with socket reset).
  if (store.responseError) return ERROR_CLASS_RESPONSE_ERROR;
  // Intentional request failure (ALS-marked) wins over close/abort.
  if (store.requestError) return ERROR_CLASS_REQUEST_ERROR;
  if (store.aborted) return ERROR_CLASS_ABORTED;
  if (!store.responseCompleted) return ERROR_CLASS_NO_RESPONSE;
  const code = Number(store.status);
  if (!Number.isFinite(code) || code < 400) return null;
  if (code === 401) return 'unauthorized';
  if (code === 403) return 'forbidden';
  if (code === 404) return 'not_found';
  if (code === 405) return 'method_not_allowed';
  if (code >= 500) return 'server_error';
  return 'client_error';
}

/**
 * @param {number|null|undefined} status
 * @param {boolean} aborted
 * @returns {string|null}
 */
function classifyErrorClass(status, aborted) {
  return classifyErrorClassFromStore({
    aborted: !!aborted,
    requestError: false,
    responseError: false,
    responseCompleted: Number.isFinite(status) && Number(status) > 0,
    status,
  });
}

/**
 * Strict slug/location token for process-scope validation only.
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
 * Validate optional immutable process/runtime scope once (server construction).
 * Never reads request headers/query/body. Invalid tokens are dropped.
 * @param {unknown} scope
 * @returns {{ client_slug: string|null, location_id: string|null, present: boolean }}
 */
function validateProcessRuntimeScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    return Object.freeze({ client_slug: null, location_id: null, present: false });
  }
  const client_slug = sanitizeScopeToken(
    scope.client_slug != null ? scope.client_slug : scope.clientSlug,
  );
  const location_id = sanitizeScopeToken(
    scope.location_id != null ? scope.location_id : scope.locationId,
  );
  return Object.freeze({
    client_slug,
    location_id,
    present: !!(client_slug || location_id),
  });
}

/**
 * @returns {object|null}
 */
function getRequestCorrelationContext() {
  const store = als.getStore();
  return store || null;
}

/**
 * Sole lifecycle completion-event constructor (exactly-once path uses this once).
 * Omits client_slug/location_id when no validated process scope.
 * Strips any forbidden keys defensively.
 * @param {object} store
 * @returns {object}
 */
function buildCompletionEvent(store) {
  return createLifecycleCompletionEvent(store);
}

/**
 * Exact lifecycle event creation — single definition used by emitCompletionOnce.
 * @param {object} store
 * @returns {object}
 */
function createLifecycleCompletionEvent(store) {
  const durationMs = Math.max(0, Date.now() - (store.startedAtMs || Date.now()));
  const responseCompleted = !!store.responseCompleted;
  let status;
  if (responseCompleted && Number.isFinite(store.status) && store.status > 0) {
    status = store.status;
  } else if (responseCompleted && Number.isFinite(store.status)) {
    status = store.status;
  } else {
    status = SYNTHETIC_NO_RESPONSE_STATUS;
  }

  const event = {
    event: EVENT_NAME,
    correlation_id: store.correlation_id,
    method: store.method,
    route_class: store.route_class,
    status,
    duration_ms: durationMs,
    error_class: classifyErrorClassFromStore({
      aborted: !!store.aborted,
      requestError: !!store.requestError,
      responseError: !!store.responseError,
      responseCompleted,
      status,
    }),
  };

  if (store.runtime_scope_present) {
    if (store.client_slug) event.client_slug = store.client_slug;
    if (store.location_id) event.location_id = store.location_id;
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
 * Structured overflow accounting — mandatory when bounded queue drops.
 * @param {number} droppedCount
 * @returns {object}
 */
function buildOverflowAccountingEvent(droppedCount) {
  return {
    event: OVERFLOW_EVENT_NAME,
    dropped_count: Math.max(0, Number(droppedCount) || 0),
    queue_max: SINK_QUEUE_MAX,
  };
}

/**
 * Deliver one queued item to its captured sink. Awaits promises; catches rejects.
 * @param {{ event: object, sink: Function }} item
 * @returns {Promise<void>}
 */
async function deliverCapturedItem(item) {
  try {
    JSON.stringify(item.event);
  } catch (_) {
    return;
  }
  try {
    const result = item.sink(item.event);
    if (result != null && typeof result.then === 'function') {
      await result;
    }
  } catch (_) {
    // Never let logging break anything; queue continues on next pump tick.
  }
}

/**
 * Pump at most one delivery per turn — never synchronously drains many events.
 * @returns {Promise<void>}
 */
async function pumpDeliveryOnce() {
  if (deliveryInFlight) return;
  deliveryInFlight = true;
  try {
    if (deliveryQueue.length > 0) {
      const item = deliveryQueue.shift();
      await deliverCapturedItem(item);
      return;
    }
    if (pendingOverflowDrops > 0) {
      const dropped = pendingOverflowDrops;
      pendingOverflowDrops = 0;
      const overflowEvent = buildOverflowAccountingEvent(dropped);
      // Overflow accounting uses the current sink (ops must see drop counts).
      await deliverCapturedItem({ event: overflowEvent, sink: emitSink });
    }
  } finally {
    deliveryInFlight = false;
    if (deliveryQueue.length > 0 || pendingOverflowDrops > 0) {
      scheduleDeliveryPump();
    }
  }
}

function scheduleDeliveryPump() {
  if (deliveryPumpScheduled) return;
  if (deliveryInFlight) return;
  if (deliveryQueue.length === 0 && pendingOverflowDrops === 0) return;
  deliveryPumpScheduled = true;
  setImmediate(() => {
    deliveryPumpScheduled = false;
    void pumpDeliveryOnce();
  });
}

/**
 * Enqueue completion for async FIFO delivery. Bounded; never blocks the response path.
 * Destination sink is captured per event. Overflow increments mandatory accounting.
 * @param {object} event
 */
function enqueueCompletionEvent(event) {
  const capturedSink = emitSink;
  if (deliveryQueue.length >= SINK_QUEUE_MAX) {
    deliveryQueue.shift();
    pendingOverflowDrops += 1;
  }
  deliveryQueue.push({ event, sink: capturedSink });
  scheduleDeliveryPump();
}

/**
 * Emit at most once per request store (async FIFO — does not delay caller).
 * Lifecycle event is created exactly once here via createLifecycleCompletionEvent.
 * @param {object} store
 */
function emitCompletionOnce(store) {
  if (!store || store.completed) return;
  store.completed = true;
  const event = createLifecycleCompletionEvent(store);
  enqueueCompletionEvent(event);
}

/**
 * Bounded flush of the FIFO delivery queue (and any pending overflow accounting).
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{
 *   flushed: boolean,
 *   timed_out: boolean,
 *   remaining: number,
 *   pending_overflow_drops: number,
 *   elapsed_ms: number,
 * }>}
 */
function flushCorrelationEmitSink(opts) {
  const timeoutMs = opts && Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0
    ? opts.timeoutMs
    : DEFAULT_FLUSH_TIMEOUT_MS;
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const idle = deliveryQueue.length === 0
        && !deliveryInFlight
        && pendingOverflowDrops === 0
        && !deliveryPumpScheduled;
      if (idle) {
        resolve({
          flushed: true,
          timed_out: false,
          remaining: 0,
          pending_overflow_drops: 0,
          elapsed_ms: Date.now() - started,
        });
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve({
          flushed: false,
          timed_out: true,
          remaining: deliveryQueue.length,
          pending_overflow_drops: pendingOverflowDrops,
          elapsed_ms: Date.now() - started,
        });
        return;
      }
      scheduleDeliveryPump();
      setImmediate(tick);
    };
    scheduleDeliveryPump();
    setImmediate(tick);
  });
}

/**
 * Install SIGTERM/SIGINT/beforeExit flush hooks once (idempotent — no duplicates).
 * beforeExit is idle-safe: it must not schedule work when the queue is empty,
 * or Node will never exit (beforeExit ↔ setImmediate loop).
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {{ remove: () => void }}
 */
function installCorrelationProcessShutdownHooks(opts) {
  if (processShutdownHooks) return processShutdownHooks;
  const timeoutMs = opts && Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0
    ? opts.timeoutMs
    : DEFAULT_FLUSH_TIMEOUT_MS;
  let beforeExitArmed = false;
  const signalHandler = () => {
    const force = setTimeout(() => {
      process.exit(process.exitCode || 0);
    }, Math.max(50, timeoutMs + 50));
    if (force && typeof force.unref === 'function') force.unref();
    void flushCorrelationEmitSink({ timeoutMs }).finally(() => {
      process.exit(process.exitCode || 0);
    });
  };
  const beforeExitHandler = () => {
    if (beforeExitArmed) return;
    if (deliveryQueue.length === 0 && !deliveryInFlight && pendingOverflowDrops === 0) {
      return;
    }
    beforeExitArmed = true;
    void flushCorrelationEmitSink({ timeoutMs });
  };
  process.on('SIGTERM', signalHandler);
  process.on('SIGINT', signalHandler);
  process.on('beforeExit', beforeExitHandler);
  processShutdownHooks = {
    handler: signalHandler,
    beforeExitHandler,
    remove() {
      if (!processShutdownHooks) return;
      process.removeListener('SIGTERM', signalHandler);
      process.removeListener('SIGINT', signalHandler);
      process.removeListener('beforeExit', beforeExitHandler);
      processShutdownHooks = null;
    },
  };
  return processShutdownHooks;
}

/**
 * Remove process shutdown hooks if installed (test seam; no-op when absent).
 */
function uninstallCorrelationProcessShutdownHooks() {
  if (processShutdownHooks) processShutdownHooks.remove();
}

/**
 * Wrap server.close to flush the delivery queue first; optionally install process hooks.
 * Close wrap is once-per-server; process hooks are process-global and idempotent.
 * @param {import('http').Server} httpServer
 * @param {{ timeoutMs?: number, installProcessHooks?: boolean }} [opts]
 * @returns {{ uninstallProcessHooks: () => void, flush: () => Promise<object> }}
 */
function attachCorrelationFlushToServer(httpServer, opts) {
  const timeoutMs = opts && Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0
    ? opts.timeoutMs
    : DEFAULT_FLUSH_TIMEOUT_MS;
  const installProcessHooks = !!(opts && opts.installProcessHooks);

  if (httpServer && !httpServer[CORR_SERVER_CLOSE_FLAG]) {
    httpServer[CORR_SERVER_CLOSE_FLAG] = true;
    const origClose = httpServer.close.bind(httpServer);
    httpServer.close = function correlationFlushClose(callback) {
      const cb = typeof callback === 'function' ? callback : null;
      flushCorrelationEmitSink({ timeoutMs }).finally(() => {
        try {
          origClose(cb || (() => {}));
        } catch (err) {
          if (cb) cb(err);
        }
      });
      return httpServer;
    };
  }

  if (installProcessHooks) {
    installCorrelationProcessShutdownHooks({ timeoutMs });
  }

  return {
    uninstallProcessHooks: uninstallCorrelationProcessShutdownHooks,
    flush: () => flushCorrelationEmitSink({ timeoutMs }),
  };
}

/** @deprecated sync drain removed — kept name routes to one-at-a-time pump for tests. */
function drainSinkQueue() {
  scheduleDeliveryPump();
}

function isCorrelationHeaderName(name) {
  return String(name || '').toLowerCase() === CORRELATION_HEADER;
}

/**
 * Force X-Request-Id into object-form headers (case-insensitive replace).
 * @param {object} headers
 * @param {string} correlationId
 * @returns {object}
 */
function forceCorrelationInHeaderObject(headers, correlationId) {
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    if (isCorrelationHeaderName(key)) delete out[key];
  }
  out[CORRELATION_HEADER_CANON] = correlationId;
  return out;
}

/**
 * Force X-Request-Id into raw array-form headers.
 * Supports Node flat form [k, v, k, v, ...] and nested [[k, v], ...].
 * Always returns Node flat form so writeHead+progressive setHeader stays valid.
 * @param {unknown[]} headers
 * @param {string} correlationId
 * @returns {unknown[]}
 */
function forceCorrelationInHeaderArray(headers, correlationId) {
  const flat = [];
  const nested = headers.length > 0 && Array.isArray(headers[0]);
  if (nested) {
    for (const pair of headers) {
      if (!Array.isArray(pair) || pair.length < 1) continue;
      if (isCorrelationHeaderName(pair[0])) continue;
      flat.push(pair[0], pair[1]);
    }
  } else {
    for (let i = 0; i < headers.length; i += 2) {
      const name = headers[i];
      const value = headers[i + 1];
      if (isCorrelationHeaderName(name)) continue;
      flat.push(name, value);
    }
  }
  flat.push(CORRELATION_HEADER_CANON, correlationId);
  return flat;
}

/**
 * Capture status + immutable correlation header without buffering the body.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} store
 */
function attachResponseCorrelation(req, res, store) {
  try {
    res.setHeader(CORRELATION_HEADER_CANON, store.correlation_id);
  } catch (_) {
    // Headers may already be sent in exotic paths; completion still emits.
  }

  const origSetHeader = res.setHeader.bind(res);
  res.setHeader = function setHeaderCorrelated(name, value) {
    if (isCorrelationHeaderName(name)) {
      return origSetHeader(CORRELATION_HEADER_CANON, store.correlation_id);
    }
    return origSetHeader(name, value);
  };

  if (typeof res.appendHeader === 'function') {
    const origAppendHeader = res.appendHeader.bind(res);
    res.appendHeader = function appendHeaderCorrelated(name, value) {
      // Never allow duplicate X-Request-Id via append — replace with immutable id.
      if (isCorrelationHeaderName(name)) {
        return origSetHeader(CORRELATION_HEADER_CANON, store.correlation_id);
      }
      return origAppendHeader(name, value);
    };
  }

  if (typeof res.addTrailers === 'function') {
    const origAddTrailers = res.addTrailers.bind(res);
    res.addTrailers = function addTrailersCorrelated(headers) {
      if (headers == null) return origAddTrailers(headers);
      if (Array.isArray(headers)) {
        return origAddTrailers(forceCorrelationInHeaderArray(headers, store.correlation_id));
      }
      if (typeof headers === 'object') {
        return origAddTrailers(forceCorrelationInHeaderObject(headers, store.correlation_id));
      }
      return origAddTrailers(headers);
    };
  }

  if (typeof res.writeEarlyHints === 'function') {
    const origWriteEarlyHints = res.writeEarlyHints.bind(res);
    res.writeEarlyHints = function writeEarlyHintsCorrelated(hints) {
      if (hints == null || typeof hints !== 'object') {
        return origWriteEarlyHints(hints);
      }
      if (Array.isArray(hints)) {
        return origWriteEarlyHints(forceCorrelationInHeaderArray(hints, store.correlation_id));
      }
      return origWriteEarlyHints(forceCorrelationInHeaderObject(hints, store.correlation_id));
    };
  }

  let inWriteHead = false;
  if (typeof res.removeHeader === 'function') {
    const origRemoveHeader = res.removeHeader.bind(res);
    res.removeHeader = function removeHeaderCorrelated(name) {
      if (isCorrelationHeaderName(name)) {
        // During writeHead, Node removes then appends — allow the remove so
        // appendHeaderCorrelated can install a single immutable value.
        if (inWriteHead) return origRemoveHeader(name);
        // Outside writeHead: refuse to clear — restore immediately.
        try {
          origRemoveHeader(name);
        } catch (_) { /* ignore */ }
        try {
          origSetHeader(CORRELATION_HEADER_CANON, store.correlation_id);
        } catch (_) { /* ignore */ }
        return;
      }
      return origRemoveHeader(name);
    };
  }

  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function writeHeadCorrelated(...args) {
    if (!store.statusCaptured) {
      const code = typeof args[0] === 'number' ? args[0] : res.statusCode;
      if (Number.isFinite(code)) {
        store.status = code;
        store.statusCaptured = true;
      }
    }

    inWriteHead = true;
    try {
      if (!res.headersSent) {
        // writeHead(status), writeHead(status, message), writeHead(status, headers),
        // writeHead(status, message, headers) — headers may be object or raw array.
        if (args.length >= 3 && args[2] != null && typeof args[2] === 'object') {
          if (Array.isArray(args[2])) {
            args[2] = forceCorrelationInHeaderArray(args[2], store.correlation_id);
          } else {
            args[2] = forceCorrelationInHeaderObject(args[2], store.correlation_id);
          }
        } else if (args.length >= 2 && args[1] != null && typeof args[1] === 'object') {
          if (Array.isArray(args[1])) {
            args[1] = forceCorrelationInHeaderArray(args[1], store.correlation_id);
          } else {
            args[1] = forceCorrelationInHeaderObject(args[1], store.correlation_id);
          }
        } else {
          try {
            origSetHeader(CORRELATION_HEADER_CANON, store.correlation_id);
          } catch (_) { /* ignore */ }
        }
      }
      return origWriteHead(...args);
    } finally {
      inWriteHead = false;
    }
  };

  const markResponseCompletedFromRes = () => {
    if (!store.statusCaptured) {
      const code = res.statusCode;
      if (Number.isFinite(code) && code > 0) {
        store.status = code;
        store.statusCaptured = true;
      }
    }
    if (store.statusCaptured) {
      store.responseCompleted = true;
    }
  };

  const complete = () => {
    emitCompletionOnce(store);
  };

  // Capture response destroy(err) before close so response_error wins over aborted.
  if (typeof res.destroy === 'function') {
    const origResDestroy = res.destroy.bind(res);
    res.destroy = function destroyResCorrelated(err) {
      if (err) {
        store.responseError = true;
        markResponseCompletedFromRes();
      }
      return origResDestroy(err);
    };
  }

  res.on('finish', () => {
    store.aborted = false;
    markResponseCompletedFromRes();
    complete();
  });

  res.on('close', () => {
    // close without finish → client abort / connection drop
    if (!res.writableFinished) {
      if (!store.requestError && !store.responseError) {
        store.aborted = true;
      }
      if (store.statusCaptured) {
        store.responseCompleted = true;
      }
      complete();
    }
  });

  res.on('error', () => {
    store.responseError = true;
    if (store.statusCaptured) {
      store.responseCompleted = true;
    } else if (!store.responseCompleted) {
      store.responseCompleted = false;
    }
    complete();
  });

  req.on('aborted', () => {
    if (!store.requestError && !store.responseError) {
      store.aborted = true;
    }
    complete();
  });

  req.on('error', () => {
    // Client disconnect / reset → aborted unless the handler marked requestError
    // on the ALS store (intentional request failure).
    if (!store.requestError && !store.responseError) {
      store.aborted = true;
    }
    complete();
  });
}

/**
 * Run handler inside ALS request scope. Does not alter handler arity/signature.
 * runtimeScope is always re-validated + frozen here (reject/omit invalid tokens).
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => *} handler
 * @param {{ runtimeScope?: { client_slug?: string|null, location_id?: string|null, present?: boolean } }} [opts]
 * @returns {Promise<*>}
 */
function runWithRequestCorrelation(req, res, handler, opts) {
  const headerRaw = req && req.headers
    ? (req.headers[CORRELATION_HEADER] || req.headers['X-Request-Id'])
    : undefined;
  // Array / ambiguous forms rejected inside acceptOrGenerateCorrelationId.
  const accepted = acceptOrGenerateCorrelationId(headerRaw);
  const method = String((req && req.method) || 'GET').toUpperCase();
  const routeClass = classifyRouteTemplate(req && req.url);

  // Every exported entry that accepts scope re-validates — never trust caller flags.
  const scope = validateProcessRuntimeScope(opts && opts.runtimeScope);

  const store = {
    correlation_id: accepted.correlation_id,
    accepted_from_header: accepted.accepted_from_header,
    method,
    route_class: routeClass,
    status: SYNTHETIC_NO_RESPONSE_STATUS,
    statusCaptured: false,
    responseCompleted: false,
    startedAtMs: Date.now(),
    client_slug: scope.present ? scope.client_slug : null,
    location_id: scope.present ? scope.location_id : null,
    runtime_scope_present: !!scope.present,
    aborted: false,
    requestError: false,
    responseError: false,
    completed: false,
  };

  attachResponseCorrelation(req, res, store);

  return als.run(store, async () => {
    try {
      return await handler(req, res);
    } catch (err) {
      // Throw-after-headers: do not alter established response bytes.
      // Completion still arrives via finish/close/error; if nothing will fire,
      // mark and emit once here only when headers already sent and socket idle.
      if (res && res.headersSent) {
        try {
          if (!res.writableEnded && typeof res.end === 'function') {
            res.end();
          }
        } catch (_) { /* ignore */ }
      }
      throw err;
    }
  });
}

/**
 * Assert an event object matches the safe completion contract (for optional tooling).
 * Verifiers must NOT use this as their RED/GREEN oracle.
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
  if (event.route_class !== ROUTE_CLASS_UNKNOWN
    && event.route_class !== ROUTE_CLASS_ROOT
    && event.route_class !== ROUTE_CLASS_HEALTHZ
    && !EXACT_ROUTE_SET.has(event.route_class)
    && !PARAM_ROUTE_TEMPLATES.some((t) => t.route_class === event.route_class)) {
    return { ok: false, detail: 'route_class_not_in_finite_set' };
  }
  if (!Number.isFinite(event.status) || event.status < 0) {
    return { ok: false, detail: 'bad_status' };
  }
  if (!Number.isFinite(event.duration_ms) || event.duration_ms < 0) {
    return { ok: false, detail: 'bad_duration' };
  }
  if (Object.prototype.hasOwnProperty.call(event, 'client_slug')) {
    if (event.client_slug != null && !sanitizeScopeToken(event.client_slug)) {
      return { ok: false, detail: 'bad_client_slug' };
    }
  }
  if (Object.prototype.hasOwnProperty.call(event, 'location_id')) {
    if (event.location_id != null && !sanitizeScopeToken(event.location_id)) {
      return { ok: false, detail: 'bad_location_id' };
    }
  }
  if (event.error_class != null && !ALL_ERROR_CLASSES.includes(event.error_class)) {
    return { ok: false, detail: 'bad_error_class' };
  }
  return { ok: true };
}

module.exports = {
  CORRELATION_HEADER,
  CORRELATION_HEADER_CANON,
  CORRELATION_ID_RE,
  CORRELATION_ID_MAX_LEN,
  EVENT_NAME,
  OVERFLOW_EVENT_NAME,
  EVENT_ALLOWED_KEYS,
  FORBIDDEN_EVENT_KEYS,
  SYNTHETIC_NO_RESPONSE_STATUS,
  DEFAULT_FLUSH_TIMEOUT_MS,
  ROUTE_CLASS_UNKNOWN,
  ROUTE_CLASS_ROOT,
  ROUTE_CLASS_HEALTHZ,
  ERROR_CLASS_ABORTED,
  ERROR_CLASS_REQUEST_ERROR,
  ERROR_CLASS_RESPONSE_ERROR,
  ERROR_CLASS_NO_RESPONSE,
  SINK_QUEUE_MAX,
  EXACT_ROUTE_TEMPLATES,
  PARAM_ROUTE_TEMPLATES,
  ALL_ERROR_CLASSES,
  generateCorrelationId,
  acceptOrGenerateCorrelationId,
  pathnameOnly,
  classifyRouteTemplate,
  normalizeRouteClass,
  classifyErrorClass,
  classifyErrorClassFromStore,
  sanitizeScopeToken,
  validateProcessRuntimeScope,
  getRequestCorrelationContext,
  buildCompletionEvent,
  createLifecycleCompletionEvent,
  buildOverflowAccountingEvent,
  emitCompletionOnce,
  enqueueCompletionEvent,
  attachResponseCorrelation,
  runWithRequestCorrelation,
  setCorrelationEmitSink,
  flushCorrelationEmitSink,
  installCorrelationProcessShutdownHooks,
  uninstallCorrelationProcessShutdownHooks,
  attachCorrelationFlushToServer,
  assertSafeCompletionEvent,
  // Exposed for verifier unit proofs only (not an oracle).
  _als: als,
  _sinkQueue: sinkQueue,
  _deliveryQueue: deliveryQueue,
  _getPendingOverflowDrops: () => pendingOverflowDrops,
  _getDeliveryInFlight: () => deliveryInFlight,
};
