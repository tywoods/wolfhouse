'use strict';

/**
 * radar-g06-admission-control — dependency-free G06 tenant-safe admission
 * controller state machine (RADAR 16AK source contract).
 *
 * Pure library only — no network, filesystem, Azure, Staff API wiring, or clock
 * I/O (callers may inject nowMs). Not wired into runtime by this slice.
 *
 * Contract highlights:
 * - Exact bounded global + per-tenant in-flight / queue limits
 * - Fail-fast 503 + Retry-After ONLY for pre-side-effect overload
 * - Post-side-effect rejection is internal continue/fail-closed (no HTTP/retry metadata)
 * - Per-tenant isolation + round-robin fairness across waiting tenants
 * - Trusted tenant identity only via resolveTrustedIngressBinding(...).tenant_slug
 * - Cancellation / timeout / close cleanup; release idempotent via tombstone ring
 * - Idle empty tenant buckets + rr keys evicted (historical tenants do not count)
 * - Bounded diagnostics: aggregate counts + opaque event types only (no tenant ids)
 * - Explicit reviewed eligible-route allowlist; unknown routes default-exclude fail-closed
 * - Health/readiness paths excluded (readiness independence)
 */

/** Locked smallest staging-shaped bounds (source contract; not live-proven). */
const LIMITS = Object.freeze({
  max_in_flight_global: 8,
  max_queued_global: 16,
  max_in_flight_per_tenant: 4,
  max_queued_per_tenant: 8,
  retry_after_seconds: 1,
  max_diag_events: 32,
  max_tenant_keys_tracked: 64,
  max_tombstones: 128,
});

const DECISIONS = Object.freeze({
  EXCLUDED: 'excluded',
  ADMITTED: 'admitted',
  QUEUED: 'queued',
  REJECTED_MISSING_TENANT: 'rejected_missing_tenant',
  REJECTED_UNTRUSTED_TENANT: 'rejected_untrusted_tenant',
  REJECTED_IN_FLIGHT: 'rejected_in_flight_limit',
  REJECTED_QUEUE_OVERFLOW: 'rejected_queue_overflow',
  REJECTED_POST_SIDE_EFFECT: 'rejected_post_side_effect',
  REJECTED_UNKNOWN_TOKEN: 'rejected_unknown_token',
  REJECTED_ALREADY_RELEASED: 'rejected_already_released',
  REJECTED_COUNTER_UNDERFLOW: 'rejected_counter_underflow',
  REJECTED_COUNTER_OVERFLOW: 'rejected_counter_overflow',
  REJECTED_REENTRANT: 'rejected_reentrant',
  REJECTED_BAD_INPUT: 'rejected_bad_input',
  REJECTED_UNKNOWN_ROUTE: 'rejected_unknown_route',
  REJECTED_CLOSED: 'rejected_closed',
  REJECTED_SHUTDOWN: 'rejected_shutdown',
});

const ROUTE_CLASSES = Object.freeze({
  HEALTH_PROBE: 'health_probe',
  READ_IDEMPOTENT: 'read_idempotent',
  READ_LIKE_NON_DURABLE: 'read_like_non_durable',
  WRITE_SIDE_EFFECT: 'write_side_effect',
  WEBHOOK_SIDE_EFFECT: 'webhook_side_effect',
});

const TOKEN_STATES = Object.freeze({
  QUEUED: 'queued',
  IN_FLIGHT: 'in_flight',
  SIDE_EFFECT: 'side_effect_started',
  RELEASED: 'released',
});

const HTTP_REJECT = Object.freeze({
  status: 503,
  retry_after_header: 'Retry-After',
});

/** Paths excluded from admission (readiness independence). */
const EXCLUDED_PATHS = Object.freeze(['/healthz', '/readyz', '/']);

/**
 * Reviewed eligible-route allowlist for future Staff API integration.
 * Unknown method+path pairs default-exclude fail-closed — no suffix heuristic,
 * no all-router-literal coverage claim.
 *
 * Key: `${METHOD} ${pathname}` (pathname normalized, no trailing slash except `/`).
 */
const ELIGIBLE_ROUTES = Object.freeze({
  // Health already handled via EXCLUDED_PATHS; listed for documentation only — not required.
  'GET /staff/query': ROUTE_CLASSES.READ_IDEMPOTENT,
  'GET /staff/intents': ROUTE_CLASSES.READ_IDEMPOTENT,
  'GET /staff/conversations': ROUTE_CLASSES.READ_IDEMPOTENT,
  'GET /staff/auth/session': ROUTE_CLASSES.READ_IDEMPOTENT,
  'GET /staff/bookings/service-catalog': ROUTE_CLASSES.READ_IDEMPOTENT,
  'GET /staff/bot/payments/status': ROUTE_CLASSES.READ_IDEMPOTENT,
  'GET /staff/schedule/day': ROUTE_CLASSES.READ_IDEMPOTENT,
  'GET /staff/meta/whatsapp/webhook': ROUTE_CLASSES.READ_IDEMPOTENT,
  'HEAD /staff/query': ROUTE_CLASSES.READ_IDEMPOTENT,

  // Read-like non-durable POSTs (inspected: preview_only / would_mutate:false / SELECT).
  'POST /staff/manual-bookings/preview': ROUTE_CLASSES.READ_LIKE_NON_DURABLE,
  'POST /staff/bookings/move-preview': ROUTE_CLASSES.READ_LIKE_NON_DURABLE,
  'POST /staff/bookings/move-targets': ROUTE_CLASSES.READ_LIKE_NON_DURABLE,
  'POST /staff/bookings/edit-preview': ROUTE_CLASSES.READ_LIKE_NON_DURABLE,
  'POST /staff/bookings/date-change-preview': ROUTE_CLASSES.READ_LIKE_NON_DURABLE,
  'POST /staff/bot/booking-dry-run': ROUTE_CLASSES.READ_LIKE_NON_DURABLE,
  'POST /staff/bot/availability-check': ROUTE_CLASSES.READ_LIKE_NON_DURABLE,
  'POST /staff/bot/booking-preview': ROUTE_CLASSES.READ_LIKE_NON_DURABLE,
  'POST /staff/bot/catalog-service-lookup': ROUTE_CLASSES.READ_LIKE_NON_DURABLE,
  'POST /staff/schedule/bookings/quote': ROUTE_CLASSES.READ_LIKE_NON_DURABLE,
  'POST /staff/tour-operator/blocks/preview': ROUTE_CLASSES.READ_LIKE_NON_DURABLE,
  'POST /staff/tour-operator/release/preview': ROUTE_CLASSES.READ_LIKE_NON_DURABLE,

  // Durable writes (inspected BEGIN/COMMIT or mutate).
  'POST /staff/bookings/cancel': ROUTE_CLASSES.WRITE_SIDE_EFFECT,
  'POST /staff/bookings/edit': ROUTE_CLASSES.WRITE_SIDE_EFFECT,
  'POST /staff/bookings/move': ROUTE_CLASSES.WRITE_SIDE_EFFECT,
  'POST /staff/bookings/record-cash-payment': ROUTE_CLASSES.WRITE_SIDE_EFFECT,
  'POST /staff/bookings/generate-payment-link': ROUTE_CLASSES.WRITE_SIDE_EFFECT,
  'POST /staff/manual-bookings/create': ROUTE_CLASSES.WRITE_SIDE_EFFECT,
  'POST /staff/bot/bookings/create': ROUTE_CLASSES.WRITE_SIDE_EFFECT,
  'POST /staff/bot/bookings/cancel': ROUTE_CLASSES.WRITE_SIDE_EFFECT,
  'POST /staff/bot/sunset/booking-create': ROUTE_CLASSES.WRITE_SIDE_EFFECT,
  'POST /staff/inbox/send-reply': ROUTE_CLASSES.WRITE_SIDE_EFFECT,
  'POST /staff/auth/login': ROUTE_CLASSES.WRITE_SIDE_EFFECT,
  'POST /staff/customers/bulk-delete': ROUTE_CLASSES.WRITE_SIDE_EFFECT,
  // Staging test reset — durable DELETE of guest message rows (not read-only).
  'POST /staff/test/reset-luna-phone': ROUTE_CLASSES.WRITE_SIDE_EFFECT,

  // Webhooks.
  'POST /staff/stripe/webhook': ROUTE_CLASSES.WEBHOOK_SIDE_EFFECT,
  'POST /staff/meta/whatsapp/webhook': ROUTE_CLASSES.WEBHOOK_SIDE_EFFECT,
});

/** @deprecated retained empty — suffix heuristic removed; do not use. */
const READ_LIKE_NON_DURABLE_SUFFIXES = Object.freeze([]);

const WEBHOOK_PATHS = Object.freeze([
  '/staff/stripe/webhook',
  '/staff/meta/whatsapp/webhook',
]);

const FAIL_CODES = Object.freeze({
  MISSING_TENANT: 'missing_tenant',
  UNTRUSTED_TENANT: 'untrusted_tenant',
  IN_FLIGHT_LIMIT: 'in_flight_limit',
  QUEUE_OVERFLOW: 'queue_overflow',
  POST_SIDE_EFFECT: 'post_side_effect',
  COUNTER_UNDERFLOW: 'counter_underflow',
  COUNTER_OVERFLOW: 'counter_overflow',
  REENTRANT: 'reentrant',
  BAD_INPUT: 'bad_input',
  UNKNOWN_TOKEN: 'unknown_token',
  ALREADY_RELEASED: 'already_released',
  UNKNOWN_ROUTE: 'unknown_route',
  CLOSED: 'closed',
  SHUTDOWN: 'shutdown',
});

/** Opaque diagnostics event kinds only — never include tenant ids/keys. */
const DIAG_KINDS = Object.freeze({
  EXCLUDE: 'exclude',
  ADMIT: 'admit',
  QUEUE: 'queue',
  PROMOTE: 'promote',
  REJECT_OVERLOAD: 'reject_overload',
  REJECT_INTERNAL: 'reject_internal',
  SIDE_EFFECT: 'side_effect',
  RELEASE: 'release',
  DOUBLE_RELEASE_IGNORED: 'double_release_ignored',
  UNDERFLOW_GUARD: 'underflow_guard',
  SHUTDOWN_REJECT: 'shutdown_reject',
  CLOSE: 'close',
  TENANT_EVICT: 'tenant_evict',
});

function isSafeNonNegInt(n) {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

function normalizePathname(pathname) {
  if (typeof pathname !== 'string' || !pathname) return null;
  const p = pathname.replace(/\/+$/, '') || '/';
  return p;
}

function normalizeMethod(method) {
  if (typeof method !== 'string' || !method) return null;
  return method.toUpperCase();
}

/**
 * Sanitize trusted tenant slug — reject empty / oversized / control chars.
 * @param {unknown} slug
 * @returns {string|null}
 */
function sanitizeTrustedTenantSlug(slug) {
  if (slug == null) return null;
  if (typeof slug !== 'string') return null;
  const s = slug.trim();
  if (!s || s.length > 64) return null;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(s)) return null;
  return s.toLowerCase();
}

function sideEffectRiskForClass(routeClass) {
  if (routeClass === ROUTE_CLASSES.HEALTH_PROBE) return 'none';
  if (routeClass === ROUTE_CLASSES.READ_IDEMPOTENT) return 'none';
  if (routeClass === ROUTE_CLASSES.READ_LIKE_NON_DURABLE) return 'non_durable';
  if (routeClass === ROUTE_CLASSES.WEBHOOK_SIDE_EFFECT) return 'webhook';
  if (routeClass === ROUTE_CLASSES.WRITE_SIDE_EFFECT) return 'durable';
  return 'durable';
}

/**
 * Classify a Staff API route from the reviewed eligible-route allowlist.
 * Unknown routes default-exclude fail-closed (no suffix heuristic).
 * @param {{ method?: unknown, pathname?: unknown }} input
 */
function classifyRoute(input) {
  const method = normalizeMethod(input && input.method);
  const pathname = normalizePathname(input && input.pathname);
  if (!method || !pathname) {
    return {
      ok: false,
      admission: 'exclude',
      side_effect_risk: 'durable',
      detail: FAIL_CODES.BAD_INPUT,
    };
  }

  if (EXCLUDED_PATHS.indexOf(pathname) !== -1) {
    return {
      ok: true,
      class: ROUTE_CLASSES.HEALTH_PROBE,
      admission: 'exclude',
      side_effect_risk: 'none',
    };
  }

  const key = `${method} ${pathname}`;
  const routeClass = ELIGIBLE_ROUTES[key];
  if (!routeClass) {
    return {
      ok: false,
      admission: 'exclude',
      side_effect_risk: 'durable',
      detail: FAIL_CODES.UNKNOWN_ROUTE,
      default_exclude: true,
    };
  }

  return {
    ok: true,
    class: routeClass,
    admission: 'admit',
    side_effect_risk: sideEffectRiskForClass(routeClass),
    eligible: true,
  };
}

/**
 * Resolve the only identity the controller accepts for admission keying.
 * Trusted source for future integration: resolveTrustedIngressBinding(...).tenant_slug.
 * Spoofed request fields are rejected; missing trusted slug fails closed.
 * @param {{
 *   trustedTenantSlug?: unknown,
 *   claimFromRequest?: unknown,
 * }} input
 */
function resolveAdmissionTenant(input) {
  const claim = input && input.claimFromRequest;
  if (claim != null && claim !== '') {
    return {
      ok: false,
      decision: DECISIONS.REJECTED_UNTRUSTED_TENANT,
      fail_code: FAIL_CODES.UNTRUSTED_TENANT,
    };
  }
  const tenant = sanitizeTrustedTenantSlug(input && input.trustedTenantSlug);
  if (!tenant) {
    return {
      ok: false,
      decision: DECISIONS.REJECTED_MISSING_TENANT,
      fail_code: FAIL_CODES.MISSING_TENANT,
    };
  }
  return { ok: true, tenant };
}

/** Pre-side-effect overload only — the sole producer of 503 + Retry-After. */
function freezeOverloadReject(decision, failCode, retryAfterSeconds) {
  return Object.freeze({
    ok: false,
    decision,
    fail_code: failCode,
    http_status: HTTP_REJECT.status,
    retry_after_seconds: retryAfterSeconds,
    retryable: true,
    headers: Object.freeze({
      [HTTP_REJECT.retry_after_header]: String(retryAfterSeconds),
    }),
  });
}

/**
 * Internal continue / fail-closed decision — NO http_status, Retry-After,
 * or retryable metadata (post-side-effect, identity, reentrancy, shutdown, etc.).
 */
function freezeInternalDecision(decision, failCode, extra) {
  const out = {
    ok: false,
    decision,
    fail_code: failCode,
    continue: true,
  };
  if (extra && typeof extra === 'object') {
    const keys = Object.keys(extra);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      if (
        k === 'http_status'
        || k === 'retry_after_seconds'
        || k === 'retryable'
        || k === 'headers'
      ) {
        continue;
      }
      out[k] = extra[k];
    }
  }
  return Object.freeze(out);
}

/**
 * @param {{
 *   limits?: Partial<typeof LIMITS>,
 *   nowMs?: () => number,
 * }} [options]
 */
function createAdmissionController(options) {
  const opt = options || {};
  const limits = Object.freeze({
    max_in_flight_global: isSafeNonNegInt(opt.limits && opt.limits.max_in_flight_global)
      ? opt.limits.max_in_flight_global
      : LIMITS.max_in_flight_global,
    max_queued_global: isSafeNonNegInt(opt.limits && opt.limits.max_queued_global)
      ? opt.limits.max_queued_global
      : LIMITS.max_queued_global,
    max_in_flight_per_tenant: isSafeNonNegInt(opt.limits && opt.limits.max_in_flight_per_tenant)
      ? opt.limits.max_in_flight_per_tenant
      : LIMITS.max_in_flight_per_tenant,
    max_queued_per_tenant: isSafeNonNegInt(opt.limits && opt.limits.max_queued_per_tenant)
      ? opt.limits.max_queued_per_tenant
      : LIMITS.max_queued_per_tenant,
    retry_after_seconds: isSafeNonNegInt(opt.limits && opt.limits.retry_after_seconds)
      ? opt.limits.retry_after_seconds
      : LIMITS.retry_after_seconds,
    max_diag_events: isSafeNonNegInt(opt.limits && opt.limits.max_diag_events)
      ? opt.limits.max_diag_events
      : LIMITS.max_diag_events,
    max_tenant_keys_tracked: isSafeNonNegInt(opt.limits && opt.limits.max_tenant_keys_tracked)
      ? opt.limits.max_tenant_keys_tracked
      : LIMITS.max_tenant_keys_tracked,
    max_tombstones: isSafeNonNegInt(opt.limits && opt.limits.max_tombstones)
      ? opt.limits.max_tombstones
      : LIMITS.max_tombstones,
  });

  if (
    limits.max_in_flight_global > LIMITS.max_in_flight_global
    || limits.max_queued_global > LIMITS.max_queued_global
    || limits.max_in_flight_per_tenant > LIMITS.max_in_flight_per_tenant
    || limits.max_queued_per_tenant > LIMITS.max_queued_per_tenant
  ) {
    throw new Error('admission_limits_exceed_locked_ceilings');
  }

  const nowMs = typeof opt.nowMs === 'function' ? opt.nowMs : () => 0;

  let seq = 0;
  let inFlightGlobal = 0;
  let queuedGlobal = 0;
  let promoting = false;
  let closed = false;
  const tokens = new Map();
  /** @type {Map<string, { in_flight: number, queued: number, queue: string[] }>} */
  const tenants = new Map();
  /** Round-robin cursor over tenant keys with non-empty queues. */
  let rrKeys = [];
  let rrIndex = 0;
  /** @type {object[]} */
  const diag = [];
  /** Fixed-size tombstone ring + set for idempotent duplicate-terminal handling. */
  const tombstoneRing = [];
  const tombstoneSet = new Set();

  function pushDiag(kind) {
    diag.push(Object.freeze({ t_ms: nowMs(), kind: String(kind) }));
    while (diag.length > limits.max_diag_events) diag.shift();
  }

  function addTombstone(tokenId) {
    if (tombstoneSet.has(tokenId)) return;
    tombstoneSet.add(tokenId);
    tombstoneRing.push(tokenId);
    while (tombstoneRing.length > limits.max_tombstones) {
      const old = tombstoneRing.shift();
      tombstoneSet.delete(old);
    }
  }

  function isTombstoned(tokenId) {
    return tombstoneSet.has(tokenId);
  }

  function evictTenantIfIdle(tenant) {
    const b = tenants.get(tenant);
    if (!b) return false;
    if (b.in_flight !== 0 || b.queued !== 0 || b.queue.length !== 0) return false;
    tenants.delete(tenant);
    const idx = rrKeys.indexOf(tenant);
    if (idx !== -1) {
      rrKeys.splice(idx, 1);
      if (rrKeys.length === 0) rrIndex = 0;
      else if (rrIndex > idx) rrIndex -= 1;
      else if (rrIndex >= rrKeys.length) rrIndex = 0;
    }
    pushDiag(DIAG_KINDS.TENANT_EVICT);
    return true;
  }

  function tenantBucket(tenant) {
    let b = tenants.get(tenant);
    if (!b) {
      if (tenants.size >= limits.max_tenant_keys_tracked) {
        return null;
      }
      b = { in_flight: 0, queued: 0, queue: [] };
      tenants.set(tenant, b);
      rrKeys.push(tenant);
    }
    return b;
  }

  function rejectOverload(decision, failCode) {
    pushDiag(DIAG_KINDS.REJECT_OVERLOAD);
    return freezeOverloadReject(decision, failCode, limits.retry_after_seconds);
  }

  function rejectInternal(decision, failCode, extra) {
    pushDiag(DIAG_KINDS.REJECT_INTERNAL);
    return freezeInternalDecision(decision, failCode, extra);
  }

  function canAdmitNow(bucket) {
    return (
      inFlightGlobal < limits.max_in_flight_global
      && bucket.in_flight < limits.max_in_flight_per_tenant
    );
  }

  function canQueue(bucket) {
    return (
      queuedGlobal < limits.max_queued_global
      && bucket.queued < limits.max_queued_per_tenant
    );
  }

  function incInFlight(bucket) {
    if (inFlightGlobal >= limits.max_in_flight_global) {
      return rejectInternal(DECISIONS.REJECTED_COUNTER_OVERFLOW, FAIL_CODES.COUNTER_OVERFLOW);
    }
    if (bucket.in_flight >= limits.max_in_flight_per_tenant) {
      return rejectInternal(DECISIONS.REJECTED_COUNTER_OVERFLOW, FAIL_CODES.COUNTER_OVERFLOW);
    }
    inFlightGlobal += 1;
    bucket.in_flight += 1;
    return null;
  }

  function decInFlight(bucket) {
    if (inFlightGlobal <= 0 || bucket.in_flight <= 0) {
      return rejectInternal(DECISIONS.REJECTED_COUNTER_UNDERFLOW, FAIL_CODES.COUNTER_UNDERFLOW);
    }
    inFlightGlobal -= 1;
    bucket.in_flight -= 1;
    return null;
  }

  function promoteOne() {
    if (promoting) {
      return rejectInternal(DECISIONS.REJECTED_REENTRANT, FAIL_CODES.REENTRANT);
    }
    if (rrKeys.length === 0) return null;
    promoting = true;
    try {
      const start = rrIndex % rrKeys.length;
      for (let n = 0; n < rrKeys.length; n += 1) {
        const idx = (start + n) % rrKeys.length;
        const tenant = rrKeys[idx];
        const bucket = tenants.get(tenant);
        if (!bucket || bucket.queue.length === 0) continue;
        if (!canAdmitNow(bucket)) continue;

        const tokenId = bucket.queue.shift();
        bucket.queued -= 1;
        queuedGlobal -= 1;
        if (bucket.queued < 0 || queuedGlobal < 0) {
          bucket.queued = Math.max(0, bucket.queued);
          queuedGlobal = Math.max(0, queuedGlobal);
          pushDiag(DIAG_KINDS.UNDERFLOW_GUARD);
          continue;
        }

        const token = tokens.get(tokenId);
        if (!token || token.state !== TOKEN_STATES.QUEUED) continue;

        const overflow = incInFlight(bucket);
        if (overflow) {
          bucket.queue.unshift(tokenId);
          bucket.queued += 1;
          queuedGlobal += 1;
          return overflow;
        }

        token.state = TOKEN_STATES.IN_FLIGHT;
        rrIndex = (idx + 1) % rrKeys.length;
        pushDiag(DIAG_KINDS.PROMOTE);
        return Object.freeze({
          ok: true,
          decision: DECISIONS.ADMITTED,
          token_id: tokenId,
          tenant,
        });
      }
      return null;
    } finally {
      promoting = false;
    }
  }

  /**
   * Attempt admission for a classified route.
   * @param {{
   *   method?: unknown,
   *   pathname?: unknown,
   *   trustedTenantSlug?: unknown,
   *   claimFromRequest?: unknown,
   *   routeClass?: unknown,
   * }} input
   */
  function tryAdmit(input) {
    if (closed) {
      return rejectInternal(DECISIONS.REJECTED_CLOSED, FAIL_CODES.CLOSED);
    }

    const classified = input && input.routeClass
      ? {
        ok: true,
        class: String(input.routeClass),
        admission: input.routeClass === ROUTE_CLASSES.HEALTH_PROBE ? 'exclude' : 'admit',
        side_effect_risk: 'durable',
      }
      : classifyRoute(input || {});

    if (!classified.ok) {
      if (classified.detail === FAIL_CODES.UNKNOWN_ROUTE) {
        return rejectInternal(DECISIONS.REJECTED_UNKNOWN_ROUTE, FAIL_CODES.UNKNOWN_ROUTE);
      }
      return rejectInternal(DECISIONS.REJECTED_BAD_INPUT, FAIL_CODES.BAD_INPUT);
    }

    if (classified.admission === 'exclude') {
      pushDiag(DIAG_KINDS.EXCLUDE);
      return Object.freeze({
        ok: true,
        decision: DECISIONS.EXCLUDED,
        class: classified.class,
        token_id: null,
        counts_toward_limits: false,
      });
    }

    const tenantRes = resolveAdmissionTenant(input || {});
    if (!tenantRes.ok) {
      return rejectInternal(tenantRes.decision, tenantRes.fail_code);
    }
    const tenant = tenantRes.tenant;
    const bucket = tenantBucket(tenant);
    if (!bucket) {
      // Concurrent tracked-tenant cardinality exhausted — overload-shaped shed.
      return rejectOverload(DECISIONS.REJECTED_QUEUE_OVERFLOW, FAIL_CODES.QUEUE_OVERFLOW);
    }

    if (canAdmitNow(bucket)) {
      const overflow = incInFlight(bucket);
      if (overflow) return overflow;
      seq += 1;
      const tokenId = `t${seq}`;
      const token = {
        id: tokenId,
        tenant,
        class: classified.class,
        state: TOKEN_STATES.IN_FLIGHT,
        side_effect_started: false,
        released: false,
      };
      tokens.set(tokenId, token);
      pushDiag(DIAG_KINDS.ADMIT);
      return Object.freeze({
        ok: true,
        decision: DECISIONS.ADMITTED,
        class: classified.class,
        token_id: tokenId,
        tenant,
        counts_toward_limits: true,
      });
    }

    if (!canQueue(bucket)) {
      const noQueueConfigured =
        limits.max_queued_global === 0 || limits.max_queued_per_tenant === 0;
      if (noQueueConfigured) {
        return rejectOverload(DECISIONS.REJECTED_IN_FLIGHT, FAIL_CODES.IN_FLIGHT_LIMIT);
      }
      return rejectOverload(DECISIONS.REJECTED_QUEUE_OVERFLOW, FAIL_CODES.QUEUE_OVERFLOW);
    }

    queuedGlobal += 1;
    bucket.queued += 1;
    seq += 1;
    const tokenId = `t${seq}`;
    const token = {
      id: tokenId,
      tenant,
      class: classified.class,
      state: TOKEN_STATES.QUEUED,
      side_effect_started: false,
      released: false,
    };
    tokens.set(tokenId, token);
    bucket.queue.push(tokenId);
    pushDiag(DIAG_KINDS.QUEUE);
    return Object.freeze({
      ok: true,
      decision: DECISIONS.QUEUED,
      class: classified.class,
      token_id: tokenId,
      tenant,
      counts_toward_limits: true,
    });
  }

  /**
   * Mark durable / webhook side effects started — after this, HTTP 503 shedding
   * is forbidden; tryRejectWith503 returns internal continue/fail-closed.
   * @param {string} tokenId
   */
  function markSideEffectStarted(tokenId) {
    if (isTombstoned(tokenId) && !tokens.has(tokenId)) {
      return rejectInternal(DECISIONS.REJECTED_ALREADY_RELEASED, FAIL_CODES.ALREADY_RELEASED, {
        counters_unchanged: true,
      });
    }
    const token = tokens.get(tokenId);
    if (!token) {
      return rejectInternal(DECISIONS.REJECTED_UNKNOWN_TOKEN, FAIL_CODES.UNKNOWN_TOKEN);
    }
    if (token.released || token.state === TOKEN_STATES.RELEASED) {
      return rejectInternal(DECISIONS.REJECTED_ALREADY_RELEASED, FAIL_CODES.ALREADY_RELEASED, {
        counters_unchanged: true,
      });
    }
    if (token.state === TOKEN_STATES.QUEUED) {
      return rejectInternal(DECISIONS.REJECTED_BAD_INPUT, FAIL_CODES.BAD_INPUT);
    }
    token.side_effect_started = true;
    token.state = TOKEN_STATES.SIDE_EFFECT;
    pushDiag(DIAG_KINDS.SIDE_EFFECT);
    return Object.freeze({
      ok: true,
      token_id: tokenId,
      state: token.state,
      rejectable_with_503: false,
    });
  }

  /**
   * Attempt to shed a request with 503. Only legal before side effects.
   * Post-side-effect: internal continue/fail-closed — no http_status / Retry-After.
   * @param {string} tokenId
   */
  function tryRejectWith503(tokenId) {
    if (isTombstoned(tokenId) && !tokens.has(tokenId)) {
      return rejectInternal(DECISIONS.REJECTED_ALREADY_RELEASED, FAIL_CODES.ALREADY_RELEASED, {
        counters_unchanged: true,
      });
    }
    const token = tokens.get(tokenId);
    if (!token) {
      return rejectInternal(DECISIONS.REJECTED_UNKNOWN_TOKEN, FAIL_CODES.UNKNOWN_TOKEN);
    }
    if (token.released || token.state === TOKEN_STATES.RELEASED) {
      return rejectInternal(DECISIONS.REJECTED_ALREADY_RELEASED, FAIL_CODES.ALREADY_RELEASED, {
        counters_unchanged: true,
      });
    }
    if (token.side_effect_started || token.state === TOKEN_STATES.SIDE_EFFECT) {
      // Continue / fail-closed: do not shed; no HTTP or retryable metadata.
      return freezeInternalDecision(
        DECISIONS.REJECTED_POST_SIDE_EFFECT,
        FAIL_CODES.POST_SIDE_EFFECT,
        { rejectable_with_503: false, counters_unchanged: true },
      );
    }
    const wasQueued = token.state === TOKEN_STATES.QUEUED;
    const rel = release(tokenId, 'shed_503');
    if (!rel.ok) return rel;
    return freezeOverloadReject(
      wasQueued ? DECISIONS.REJECTED_QUEUE_OVERFLOW : DECISIONS.REJECTED_IN_FLIGHT,
      wasQueued ? FAIL_CODES.QUEUE_OVERFLOW : FAIL_CODES.IN_FLIGHT_LIMIT,
      limits.retry_after_seconds,
    );
  }

  /**
   * Release a token (completion, abort, timeout). Idempotent — terminal records
   * are deleted; duplicate terminal ops hit the tombstone ring without underflow.
   * @param {string} tokenId
   * @param {string} [reason]
   */
  function release(tokenId, reason) {
    if (!tokens.has(tokenId)) {
      if (isTombstoned(tokenId)) {
        pushDiag(DIAG_KINDS.DOUBLE_RELEASE_IGNORED);
        return freezeInternalDecision(
          DECISIONS.REJECTED_ALREADY_RELEASED,
          FAIL_CODES.ALREADY_RELEASED,
          { counters_unchanged: true },
        );
      }
      return rejectInternal(DECISIONS.REJECTED_UNKNOWN_TOKEN, FAIL_CODES.UNKNOWN_TOKEN);
    }
    const token = tokens.get(tokenId);
    if (token.released || token.state === TOKEN_STATES.RELEASED) {
      tokens.delete(tokenId);
      addTombstone(tokenId);
      pushDiag(DIAG_KINDS.DOUBLE_RELEASE_IGNORED);
      return freezeInternalDecision(
        DECISIONS.REJECTED_ALREADY_RELEASED,
        FAIL_CODES.ALREADY_RELEASED,
        { counters_unchanged: true },
      );
    }

    const bucket = tenants.get(token.tenant);
    if (!bucket) {
      return rejectInternal(DECISIONS.REJECTED_BAD_INPUT, FAIL_CODES.BAD_INPUT);
    }

    if (token.state === TOKEN_STATES.QUEUED) {
      const idx = bucket.queue.indexOf(tokenId);
      if (idx !== -1) bucket.queue.splice(idx, 1);
      if (bucket.queued > 0) bucket.queued -= 1;
      else {
        pushDiag(DIAG_KINDS.UNDERFLOW_GUARD);
        return rejectInternal(DECISIONS.REJECTED_COUNTER_UNDERFLOW, FAIL_CODES.COUNTER_UNDERFLOW);
      }
      if (queuedGlobal > 0) queuedGlobal -= 1;
      else {
        pushDiag(DIAG_KINDS.UNDERFLOW_GUARD);
        return rejectInternal(DECISIONS.REJECTED_COUNTER_UNDERFLOW, FAIL_CODES.COUNTER_UNDERFLOW);
      }
    } else if (
      token.state === TOKEN_STATES.IN_FLIGHT
      || token.state === TOKEN_STATES.SIDE_EFFECT
    ) {
      const under = decInFlight(bucket);
      if (under) return under;
    } else {
      return rejectInternal(DECISIONS.REJECTED_BAD_INPUT, FAIL_CODES.BAD_INPUT);
    }

    const tenant = token.tenant;
    tokens.delete(tokenId);
    addTombstone(tokenId);
    pushDiag(DIAG_KINDS.RELEASE);

    const promoted = closed ? null : promoteOne();
    evictTenantIfIdle(tenant);
    if (promoted && promoted.ok && promoted.tenant) {
      // Promoted tenant is active — no eviction.
    }

    return Object.freeze({
      ok: true,
      token_id: tokenId,
      reason: reason || 'complete',
      promoted: promoted && promoted.ok ? promoted : null,
    });
  }

  function abort(tokenId) {
    return release(tokenId, 'abort');
  }

  function timeout(tokenId) {
    return release(tokenId, 'timeout');
  }

  /**
   * Close / shutdown: reject queued pre-side-effect work safely, release
   * settleable in-flight (including post-side-effect settle without HTTP 503),
   * stop new admits, and settle counters / buckets.
   */
  function close() {
    if (closed) {
      return Object.freeze({
        ok: true,
        already_closed: true,
        rejected_queued: 0,
        released_in_flight: 0,
      });
    }
    closed = true;
    pushDiag(DIAG_KINDS.CLOSE);

    let rejectedQueued = 0;
    let releasedInFlight = 0;

    const queuedIds = [];
    const inFlightIds = [];
    tokens.forEach((t, id) => {
      if (t.state === TOKEN_STATES.QUEUED) queuedIds.push(id);
      else if (
        t.state === TOKEN_STATES.IN_FLIGHT
        || t.state === TOKEN_STATES.SIDE_EFFECT
      ) {
        inFlightIds.push(id);
      }
    });

    for (let i = 0; i < queuedIds.length; i += 1) {
      const id = queuedIds[i];
      const rel = release(id, 'shutdown');
      if (rel.ok) {
        rejectedQueued += 1;
        pushDiag(DIAG_KINDS.SHUTDOWN_REJECT);
      }
    }

    for (let i = 0; i < inFlightIds.length; i += 1) {
      const id = inFlightIds[i];
      const rel = release(id, 'shutdown');
      if (rel.ok) releasedInFlight += 1;
    }

    // Settle any leftover empty buckets.
    const tenantKeys = Array.from(tenants.keys());
    for (let i = 0; i < tenantKeys.length; i += 1) {
      evictTenantIfIdle(tenantKeys[i]);
    }

    return Object.freeze({
      ok: true,
      already_closed: false,
      rejected_queued: rejectedQueued,
      released_in_flight: releasedInFlight,
      in_flight_global: inFlightGlobal,
      queued_global: queuedGlobal,
      tracked_tenant_count: tenants.size,
      token_record_count: tokens.size,
    });
  }

  /**
   * Bounded diagnostics — aggregate counts + opaque event kinds only.
   * Never exposes raw tenant identifiers/keys.
   */
  function diagnostics() {
    let maxTenantInFlight = 0;
    let maxTenantQueued = 0;
    let nonEmptyTenants = 0;
    tenants.forEach((b) => {
      if (b.in_flight > maxTenantInFlight) maxTenantInFlight = b.in_flight;
      if (b.queued > maxTenantQueued) maxTenantQueued = b.queued;
      if (b.in_flight > 0 || b.queued > 0) nonEmptyTenants += 1;
    });
    return Object.freeze({
      limits,
      closed,
      in_flight_global: inFlightGlobal,
      queued_global: queuedGlobal,
      active_tokens: tokens.size,
      token_record_count: tokens.size,
      tombstone_count: tombstoneSet.size,
      tracked_tenant_count: tenants.size,
      non_empty_tenant_count: nonEmptyTenants,
      max_tenant_in_flight: maxTenantInFlight,
      max_tenant_queued: maxTenantQueued,
      rr_key_count: rrKeys.length,
      events: Object.freeze(diag.slice()),
      event_count: diag.length,
      max_diag_events: limits.max_diag_events,
    });
  }

  function assertConsistent() {
    let sumIn = 0;
    let sumQ = 0;
    tenants.forEach((b) => {
      sumIn += b.in_flight;
      sumQ += b.queued;
      if (b.in_flight < 0 || b.queued < 0 || b.queue.length !== b.queued) {
        throw new Error('tenant_bucket_inconsistent');
      }
    });
    if (sumIn !== inFlightGlobal || sumQ !== queuedGlobal) {
      throw new Error('global_tenant_counter_mismatch');
    }
    if (inFlightGlobal < 0 || queuedGlobal < 0) {
      throw new Error('negative_global_counter');
    }
    if (rrKeys.length !== tenants.size) {
      // rrKeys may briefly include only tracked tenants; enforce same membership.
      for (let i = 0; i < rrKeys.length; i += 1) {
        if (!tenants.has(rrKeys[i])) throw new Error('rr_key_orphan');
      }
      if (rrKeys.length !== tenants.size) throw new Error('rr_keys_size_mismatch');
    }
    return true;
  }

  return {
    limits,
    tryAdmit,
    markSideEffectStarted,
    tryRejectWith503,
    release,
    abort,
    timeout,
    close,
    diagnostics,
    assertConsistent,
    promoteOne,
  };
}

module.exports = {
  LIMITS,
  DECISIONS,
  ROUTE_CLASSES,
  TOKEN_STATES,
  HTTP_REJECT,
  EXCLUDED_PATHS,
  ELIGIBLE_ROUTES,
  WEBHOOK_PATHS,
  READ_LIKE_NON_DURABLE_SUFFIXES,
  FAIL_CODES,
  DIAG_KINDS,
  classifyRoute,
  resolveAdmissionTenant,
  sanitizeTrustedTenantSlug,
  createAdmissionController,
  freezeOverloadReject,
  freezeInternalDecision,
};
