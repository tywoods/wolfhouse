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
 * - Fail-fast 503 + Retry-After only BEFORE side effects begin
 * - Per-tenant isolation + round-robin fairness across waiting tenants
 * - Trusted tenant identity only (never request header/query/body spoof)
 * - Cancellation / timeout cleanup; release is idempotent (no double release)
 * - Counter underflow / overflow rejected; reentrancy-safe promote
 * - Bounded diagnostics ring
 * - Health/readiness paths excluded (readiness independence)
 * - In-progress transactional work cannot be 503-shed after side effects start
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

/** Exact webhook paths inspected in staff-query-api.js router. */
const WEBHOOK_PATHS = Object.freeze([
  '/staff/stripe/webhook',
  '/staff/meta/whatsapp/webhook',
]);

/**
 * Preview / dry-run style paths that may open BEGIN/ROLLBACK but must not be
 * treated as durable commits for post-side-effect shedding semantics until the
 * handler marks side effects. Capacity still applies before start.
 */
const READ_LIKE_NON_DURABLE_SUFFIXES = Object.freeze([
  '/preview',
  '-preview',
  '/dry-run',
  '-dry-run',
  '/quote',
  '-quote',
  '/availability',
  '/availability-check',
  '/lookup',
  '/catalog',
  '/status',
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

function isReadLikeNonDurablePath(pathname) {
  const p = pathname.toLowerCase();
  for (let i = 0; i < READ_LIKE_NON_DURABLE_SUFFIXES.length; i += 1) {
    if (p.endsWith(READ_LIKE_NON_DURABLE_SUFFIXES[i])) return true;
  }
  if (p.includes('/preview') || p.includes('dry-run')) return true;
  return false;
}

/**
 * Classify a Staff API route from inspected topology rules (source contract).
 * @param {{ method?: unknown, pathname?: unknown }} input
 * @returns {{
 *   ok: boolean,
 *   class?: string,
 *   admission: 'exclude'|'admit',
 *   side_effect_risk: 'none'|'non_durable'|'durable'|'webhook',
 *   detail?: string,
 * }}
 */
function classifyRoute(input) {
  const method = normalizeMethod(input && input.method);
  const pathname = normalizePathname(input && input.pathname);
  if (!method || !pathname) {
    return {
      ok: false,
      admission: 'admit',
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

  if (WEBHOOK_PATHS.indexOf(pathname) !== -1) {
    if (method === 'GET') {
      return {
        ok: true,
        class: ROUTE_CLASSES.READ_IDEMPOTENT,
        admission: 'admit',
        side_effect_risk: 'none',
      };
    }
    return {
      ok: true,
      class: ROUTE_CLASSES.WEBHOOK_SIDE_EFFECT,
      admission: 'admit',
      side_effect_risk: 'webhook',
    };
  }

  if (method === 'GET' || method === 'HEAD') {
    return {
      ok: true,
      class: ROUTE_CLASSES.READ_IDEMPOTENT,
      admission: 'admit',
      side_effect_risk: 'none',
    };
  }

  if (isReadLikeNonDurablePath(pathname)) {
    return {
      ok: true,
      class: ROUTE_CLASSES.READ_LIKE_NON_DURABLE,
      admission: 'admit',
      side_effect_risk: 'non_durable',
    };
  }

  if (
    method === 'POST'
    || method === 'PUT'
    || method === 'PATCH'
    || method === 'DELETE'
  ) {
    return {
      ok: true,
      class: ROUTE_CLASSES.WRITE_SIDE_EFFECT,
      admission: 'admit',
      side_effect_risk: 'durable',
    };
  }

  return {
    ok: false,
    admission: 'admit',
    side_effect_risk: 'durable',
    detail: FAIL_CODES.BAD_INPUT,
  };
}

/**
 * Resolve the only identity the controller accepts for admission keying.
 * Spoofed request fields are ignored; missing trusted slug fails closed.
 * @param {{
 *   trustedTenantSlug?: unknown,
 *   claimFromRequest?: unknown,
 * }} input
 * @returns {{ ok: true, tenant: string } | { ok: false, decision: string, fail_code: string }}
 */
function resolveAdmissionTenant(input) {
  const claim = input && input.claimFromRequest;
  if (claim != null && claim !== '') {
    // Any attempt to key admission from request-supplied identity is rejected.
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

function freezeReject(decision, failCode, retryAfterSeconds) {
  return Object.freeze({
    ok: false,
    decision,
    fail_code: failCode,
    http_status: HTTP_REJECT.status,
    retry_after_seconds: retryAfterSeconds,
    headers: Object.freeze({
      [HTTP_REJECT.retry_after_header]: String(retryAfterSeconds),
    }),
  });
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
  });

  // Normative lock: callers may only tighten within exact locked ceilings for
  // the source contract verifier; create with defaults for production-shaped tests.
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
  const tokens = new Map();
  /** @type {Map<string, { in_flight: number, queued: number, queue: string[] }>} */
  const tenants = new Map();
  /** Round-robin cursor over tenant keys with non-empty queues. */
  let rrKeys = [];
  let rrIndex = 0;
  /** @type {object[]} */
  const diag = [];

  function pushDiag(event) {
    diag.push(Object.freeze(Object.assign({ t_ms: nowMs() }, event)));
    while (diag.length > limits.max_diag_events) diag.shift();
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

  function reject(decision, failCode) {
    pushDiag({ kind: 'reject', decision, fail_code: failCode });
    return freezeReject(decision, failCode, limits.retry_after_seconds);
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
      return reject(DECISIONS.REJECTED_COUNTER_OVERFLOW, FAIL_CODES.COUNTER_OVERFLOW);
    }
    if (bucket.in_flight >= limits.max_in_flight_per_tenant) {
      return reject(DECISIONS.REJECTED_COUNTER_OVERFLOW, FAIL_CODES.COUNTER_OVERFLOW);
    }
    inFlightGlobal += 1;
    bucket.in_flight += 1;
    return null;
  }

  function decInFlight(bucket) {
    if (inFlightGlobal <= 0 || bucket.in_flight <= 0) {
      return reject(DECISIONS.REJECTED_COUNTER_UNDERFLOW, FAIL_CODES.COUNTER_UNDERFLOW);
    }
    inFlightGlobal -= 1;
    bucket.in_flight -= 1;
    return null;
  }

  function promoteOne() {
    if (promoting) {
      return reject(DECISIONS.REJECTED_REENTRANT, FAIL_CODES.REENTRANT);
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
          // Should be unreachable; fail closed without negative counters.
          bucket.queued = Math.max(0, bucket.queued);
          queuedGlobal = Math.max(0, queuedGlobal);
          pushDiag({ kind: 'underflow_guard', tenant });
          continue;
        }

        const token = tokens.get(tokenId);
        if (!token || token.state !== TOKEN_STATES.QUEUED) continue;

        const overflow = incInFlight(bucket);
        if (overflow) {
          // Put back to preserve queue integrity.
          bucket.queue.unshift(tokenId);
          bucket.queued += 1;
          queuedGlobal += 1;
          return overflow;
        }

        token.state = TOKEN_STATES.IN_FLIGHT;
        rrIndex = (idx + 1) % rrKeys.length;
        pushDiag({ kind: 'promote', token_id: tokenId, tenant });
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
    const classified = input && input.routeClass
      ? {
        ok: true,
        class: String(input.routeClass),
        admission: input.routeClass === ROUTE_CLASSES.HEALTH_PROBE ? 'exclude' : 'admit',
        side_effect_risk: 'durable',
      }
      : classifyRoute(input || {});

    if (!classified.ok) {
      return reject(DECISIONS.REJECTED_BAD_INPUT, FAIL_CODES.BAD_INPUT);
    }

    if (classified.admission === 'exclude') {
      pushDiag({ kind: 'exclude', class: classified.class });
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
      return reject(tenantRes.decision, tenantRes.fail_code);
    }
    const tenant = tenantRes.tenant;
    const bucket = tenantBucket(tenant);
    if (!bucket) {
      return reject(DECISIONS.REJECTED_QUEUE_OVERFLOW, FAIL_CODES.QUEUE_OVERFLOW);
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
      pushDiag({ kind: 'admit', token_id: tokenId, tenant });
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
      // In-flight full and no queue slot → fail-fast 503 (pre-side-effect).
      const noQueueConfigured =
        limits.max_queued_global === 0 || limits.max_queued_per_tenant === 0;
      if (noQueueConfigured) {
        return reject(DECISIONS.REJECTED_IN_FLIGHT, FAIL_CODES.IN_FLIGHT_LIMIT);
      }
      return reject(DECISIONS.REJECTED_QUEUE_OVERFLOW, FAIL_CODES.QUEUE_OVERFLOW);
    }

    // Queue wait (still pre-side-effect; may later be shed with 503).
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
    pushDiag({ kind: 'queue', token_id: tokenId, tenant });
    return Object.freeze({
      ok: true,
      decision: DECISIONS.QUEUED,
      class: classified.class,
      token_id: tokenId,
      tenant,
      counts_toward_limits: true,
      http_status_if_shed: HTTP_REJECT.status,
      retry_after_seconds: limits.retry_after_seconds,
    });
  }

  /**
   * Mark durable / webhook side effects started — after this, 503 shedding is forbidden.
   * @param {string} tokenId
   */
  function markSideEffectStarted(tokenId) {
    const token = tokens.get(tokenId);
    if (!token) {
      return reject(DECISIONS.REJECTED_UNKNOWN_TOKEN, FAIL_CODES.UNKNOWN_TOKEN);
    }
    if (token.released || token.state === TOKEN_STATES.RELEASED) {
      return reject(DECISIONS.REJECTED_ALREADY_RELEASED, FAIL_CODES.ALREADY_RELEASED);
    }
    if (token.state === TOKEN_STATES.QUEUED) {
      return reject(DECISIONS.REJECTED_BAD_INPUT, FAIL_CODES.BAD_INPUT);
    }
    token.side_effect_started = true;
    token.state = TOKEN_STATES.SIDE_EFFECT;
    pushDiag({ kind: 'side_effect', token_id: tokenId, tenant: token.tenant });
    return Object.freeze({
      ok: true,
      token_id: tokenId,
      state: token.state,
      rejectable_with_503: false,
    });
  }

  /**
   * Attempt to shed a request with 503. Only legal before side effects.
   * Queued tokens are removed; in-flight pre-side-effect tokens are released.
   * @param {string} tokenId
   */
  function tryRejectWith503(tokenId) {
    const token = tokens.get(tokenId);
    if (!token) {
      return reject(DECISIONS.REJECTED_UNKNOWN_TOKEN, FAIL_CODES.UNKNOWN_TOKEN);
    }
    if (token.released || token.state === TOKEN_STATES.RELEASED) {
      return reject(DECISIONS.REJECTED_ALREADY_RELEASED, FAIL_CODES.ALREADY_RELEASED);
    }
    if (token.side_effect_started || token.state === TOKEN_STATES.SIDE_EFFECT) {
      return reject(DECISIONS.REJECTED_POST_SIDE_EFFECT, FAIL_CODES.POST_SIDE_EFFECT);
    }
    const wasQueued = token.state === TOKEN_STATES.QUEUED;
    const rel = release(tokenId, 'shed_503');
    if (!rel.ok) return rel;
    return freezeReject(
      wasQueued ? DECISIONS.REJECTED_QUEUE_OVERFLOW : DECISIONS.REJECTED_IN_FLIGHT,
      wasQueued ? FAIL_CODES.QUEUE_OVERFLOW : FAIL_CODES.IN_FLIGHT_LIMIT,
      limits.retry_after_seconds,
    );
  }

  /**
   * Release a token (completion, abort, timeout). Idempotent — second call does
   * not decrement counters again.
   * @param {string} tokenId
   * @param {string} [reason]
   */
  function release(tokenId, reason) {
    const token = tokens.get(tokenId);
    if (!token) {
      return reject(DECISIONS.REJECTED_UNKNOWN_TOKEN, FAIL_CODES.UNKNOWN_TOKEN);
    }
    if (token.released || token.state === TOKEN_STATES.RELEASED) {
      pushDiag({ kind: 'double_release_ignored', token_id: tokenId, reason: reason || null });
      return Object.freeze({
        ok: false,
        decision: DECISIONS.REJECTED_ALREADY_RELEASED,
        fail_code: FAIL_CODES.ALREADY_RELEASED,
        counters_unchanged: true,
      });
    }

    const bucket = tenants.get(token.tenant);
    if (!bucket) {
      return reject(DECISIONS.REJECTED_BAD_INPUT, FAIL_CODES.BAD_INPUT);
    }

    if (token.state === TOKEN_STATES.QUEUED) {
      const idx = bucket.queue.indexOf(tokenId);
      if (idx !== -1) bucket.queue.splice(idx, 1);
      if (bucket.queued > 0) bucket.queued -= 1;
      else {
        pushDiag({ kind: 'underflow_guard', token_id: tokenId, where: 'queued_tenant' });
        return reject(DECISIONS.REJECTED_COUNTER_UNDERFLOW, FAIL_CODES.COUNTER_UNDERFLOW);
      }
      if (queuedGlobal > 0) queuedGlobal -= 1;
      else {
        pushDiag({ kind: 'underflow_guard', token_id: tokenId, where: 'queued_global' });
        return reject(DECISIONS.REJECTED_COUNTER_UNDERFLOW, FAIL_CODES.COUNTER_UNDERFLOW);
      }
    } else if (
      token.state === TOKEN_STATES.IN_FLIGHT
      || token.state === TOKEN_STATES.SIDE_EFFECT
    ) {
      const under = decInFlight(bucket);
      if (under) return under;
    } else {
      return reject(DECISIONS.REJECTED_BAD_INPUT, FAIL_CODES.BAD_INPUT);
    }

    token.released = true;
    token.state = TOKEN_STATES.RELEASED;
    // Keep token in map so double-release is detectable without counter underflow.
    pushDiag({
      kind: 'release',
      token_id: tokenId,
      tenant: token.tenant,
      reason: reason || 'complete',
    });

    const promoted = promoteOne();
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
   * Bounded diagnostics snapshot — counters + truncated event ring only.
   */
  function diagnostics() {
    const perTenant = {};
    const keys = Array.from(tenants.keys()).sort();
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      const b = tenants.get(k);
      perTenant[k] = Object.freeze({
        in_flight: b.in_flight,
        queued: b.queued,
        queue_depth: b.queue.length,
      });
    }
    let active = 0;
    tokens.forEach((t) => {
      if (!t.released && t.state !== TOKEN_STATES.RELEASED) active += 1;
    });
    return Object.freeze({
      limits,
      in_flight_global: inFlightGlobal,
      queued_global: queuedGlobal,
      active_tokens: active,
      tenants: Object.freeze(perTenant),
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
  WEBHOOK_PATHS,
  FAIL_CODES,
  classifyRoute,
  resolveAdmissionTenant,
  sanitizeTrustedTenantSlug,
  createAdmissionController,
};
