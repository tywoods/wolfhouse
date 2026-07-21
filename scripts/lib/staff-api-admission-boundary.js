'use strict';

/**
 * Staff API admission boundary (RADAR 16AL) — HTTP-edge wire for the 16AK
 * tenant-safe admission controller.
 *
 * Placement: after resolveTrustedIngressBinding(...).tenant_slug is known,
 * before route handler body parsing / DB / tool side effects.
 *
 * Behind STAFF_API_ADMISSION_CONTROL (default OFF). OFF path does not construct
 * a controller and must preserve pre-wire request behavior.
 *
 * Does NOT claim live shed, load soak, production, or full G06.
 */

const {
  createAdmissionController,
  DECISIONS,
  HTTP_REJECT,
  LIMITS,
  classifyRoute,
} = require('./radar-g06-admission-control');
const { pathnameOnly } = require('./staff-api-request-correlation');

const FLAG_ENV = 'STAFF_API_ADMISSION_CONTROL';

const FLAG_OFF = Object.freeze(new Set(['0', 'false', 'off', 'no']));
const FLAG_ON = Object.freeze(new Set(['1', 'true', 'on', 'yes']));

const PUBLIC_503_BODY = Object.freeze({
  success: false,
  error: 'service unavailable',
});

const ADMISSION_REQ_KEY = '__staffApiAdmission';

/**
 * Shared with staff-api-readiness-lifecycle: invoked once at shutdown BEGIN
 * (before pool/server.close waits for connections). Symbol.for so factory and
 * lifecycle agree without a hard require cycle.
 */
const ON_SHUTDOWN_BEGIN_HOOK = Symbol.for('wh.staffApi.readiness.onShutdownBegin');

/**
 * Per-server admission shutdown-begin registry (Set of boundary owners) + prior
 * owner capture. Installed once per server; deleted on first dispatcher fire so
 * no stale boundary / prior-owner strong refs remain.
 */
const SHUTDOWN_BEGIN_REGISTRY = Symbol.for('wh.staffApi.admission.shutdownBeginRegistry');

/** Identity of the installed admission dispatcher (no wrapper chains). */
const SHUTDOWN_BEGIN_DISPATCHER = Symbol.for('wh.staffApi.admission.shutdownBeginDispatcher');

/**
 * Fail-closed flag parse. Unset/empty → OFF (behavior-preserving).
 * Exact ON/OFF tokens only; any other value is malformed.
 * @param {unknown} raw
 * @returns {{ ok: true, enabled: boolean } | { ok: false, code: string, detail: string }}
 */
function parseAdmissionControlFlag(raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, enabled: false };
  }
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
    return { ok: false, code: 'malformed_flag', detail: 'unsupported_type' };
  }
  if (typeof raw === 'boolean') {
    return { ok: true, enabled: raw };
  }
  if (typeof raw === 'number') {
    if (raw === 0) return { ok: true, enabled: false };
    if (raw === 1) return { ok: true, enabled: true };
    return { ok: false, code: 'malformed_flag', detail: 'unsupported_number' };
  }
  const s = String(raw).trim();
  if (s === '') return { ok: true, enabled: false };
  const lower = s.toLowerCase();
  if (FLAG_OFF.has(lower)) return { ok: true, enabled: false };
  if (FLAG_ON.has(lower)) return { ok: true, enabled: true };
  return { ok: false, code: 'malformed_flag', detail: 'unrecognized_token' };
}

/**
 * Resolve flag from options override or env. Malformed → throw.
 * @param {{ admissionControl?: unknown, env?: NodeJS.ProcessEnv }} [options]
 */
function resolveAdmissionControlEnabled(options) {
  const opt = options || {};
  let raw;
  if (Object.prototype.hasOwnProperty.call(opt, 'admissionControl')) {
    raw = opt.admissionControl;
  } else {
    const env = opt.env || process.env;
    raw = env && env[FLAG_ENV];
  }
  const parsed = parseAdmissionControlFlag(raw);
  if (!parsed.ok) {
    const err = new Error(`${FLAG_ENV}_malformed`);
    err.code = parsed.code;
    err.detail = parsed.detail;
    throw err;
  }
  return parsed.enabled;
}

function clonePublic503Body() {
  return { success: PUBLIC_503_BODY.success, error: PUBLIC_503_BODY.error };
}

/**
 * Bounded, non-sensitive public 503. Optional Retry-After only for overload shed.
 * @param {import('http').ServerResponse} res
 * @param {{ retryAfterSeconds?: number|null, sendJSON?: Function }} [opts]
 */
function writePublic503(res, opts) {
  const o = opts || {};
  if (!res || res.writableEnded || res.headersSent) return false;
  const bodyObj = clonePublic503Body();
  const retry = o.retryAfterSeconds;
  const hasRetry = typeof retry === 'number' && Number.isSafeInteger(retry) && retry >= 0;

  if (typeof o.sendJSON === 'function') {
    try {
      if (hasRetry && typeof res.setHeader === 'function') {
        res.setHeader(HTTP_REJECT.retry_after_header, String(retry));
      }
      o.sendJSON(res, HTTP_REJECT.status, bodyObj);
      return true;
    } catch (_) {
      // fall through to raw write
    }
  }

  const body = JSON.stringify(bodyObj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  };
  if (hasRetry) {
    headers[HTTP_REJECT.retry_after_header] = String(retry);
  }
  try {
    res.writeHead(HTTP_REJECT.status, headers);
    res.end(body);
    return true;
  } catch (_) {
    return false;
  }
}

function normalizePathnameFromReq(req) {
  const rawUrl = req && req.url;
  if (typeof pathnameOnly === 'function') {
    const p = pathnameOnly(rawUrl);
    if (typeof p === 'string' && p) return p.replace(/\/+$/, '') || '/';
  }
  if (typeof rawUrl !== 'string' || !rawUrl) return '/';
  const noHash = rawUrl.split('#')[0];
  const pathOnly = noHash.split('?')[0] || '/';
  return pathOnly.replace(/\/+$/, '') || '/';
}

function getAdmissionState(req) {
  return req && req[ADMISSION_REQ_KEY] ? req[ADMISSION_REQ_KEY] : null;
}

/**
 * True when the HTTP transport is already dead / unusable for a queued or
 * about-to-run handler. Conservative: any positive dead signal wins.
 * @param {import('http').IncomingMessage|null|undefined} req
 * @param {import('http').ServerResponse|null|undefined} res
 */
function isTransportDead(req, res) {
  try {
    if (req) {
      if (req.aborted === true) return true;
      if (req.readableAborted === true) return true;
      if (req.destroyed === true) return true;
    }
    if (res) {
      if (res.destroyed === true) return true;
      if (res.writableEnded === true) return true;
      if (res.writableFinished === true) return true;
      if (res.finished === true) return true;
      if (res.closed === true) return true;
    }
    const sock = (req && (req.socket || req.connection))
      || (res && (res.socket || res.connection))
      || null;
    if (sock) {
      if (sock.destroyed === true) return true;
      if (sock.readable === false && sock.writable === false) return true;
      // Half-closed peer that can no longer accept writes.
      if (sock.writable === false && sock.readableEnded === true) return true;
    }
  } catch (_) {
    return true;
  }
  return false;
}

/**
 * Bind admissionBoundary.close() to the readiness-lifecycle shutdown BEGIN hook
 * on an http.Server via a per-server registry/dispatcher (Set identity dedupe).
 *
 * - Binding the same boundary twice is a no-op (Set.add).
 * - One shutdown calls each bound close exactly once; prior hook exactly once.
 * - Does not create wrapper chains — dispatcher identity is stable.
 * - First dispatcher invocation: atomically mark fired, snapshot/clear owners,
 *   run prior + closes, then detach/delete registry/dispatcher/hook symbols.
 * - Repeated invocation is harmless (closure fired + symbols absent).
 * - No-op when args missing. OFF callers must not register (factory skips).
 *
 * @param {import('http').Server|null|undefined} server
 * @param {{ close: () => unknown }|null|undefined} admissionBoundary
 */
function bindAdmissionShutdownBegin(server, admissionBoundary) {
  if (!server || !admissionBoundary || typeof admissionBoundary.close !== 'function') {
    return false;
  }

  let registry = server[SHUTDOWN_BEGIN_REGISTRY];
  let dispatcher = server[SHUTDOWN_BEGIN_DISPATCHER];

  if (!registry || typeof dispatcher !== 'function') {
    // Capture any pre-existing readiness shutdown-begin owner exactly once.
    const existing = server[ON_SHUTDOWN_BEGIN_HOOK];
    const prior = (typeof existing === 'function' && existing !== dispatcher)
      ? existing
      : null;

    /** @type {{ owners: Set<object>, prior: Function|null, fired: boolean }} */
    registry = {
      owners: new Set(),
      prior,
      fired: false,
    };
    server[SHUTDOWN_BEGIN_REGISTRY] = registry;

    dispatcher = function staffApiAdmissionShutdownBeginDispatcher() {
      // Closure + registry.fired: repeated invoke cannot rerun closes/prior.
      if (!registry || registry.fired) {
        return;
      }
      registry.fired = true;

      const priorHook = registry.prior;
      const ownersSnap = Array.from(registry.owners);
      registry.owners.clear();
      registry.prior = null;

      // Detach symbol state so no stale boundary / prior-owner strong refs remain.
      try { delete server[SHUTDOWN_BEGIN_REGISTRY]; } catch (_) {
        server[SHUTDOWN_BEGIN_REGISTRY] = undefined;
      }
      try { delete server[SHUTDOWN_BEGIN_DISPATCHER]; } catch (_) {
        server[SHUTDOWN_BEGIN_DISPATCHER] = undefined;
      }
      if (server[ON_SHUTDOWN_BEGIN_HOOK] === dispatcher) {
        try { delete server[ON_SHUTDOWN_BEGIN_HOOK]; } catch (_) {
          server[ON_SHUTDOWN_BEGIN_HOOK] = undefined;
        }
      }

      if (typeof priorHook === 'function') {
        try { priorHook(); } catch (_) { /* prior hook best-effort */ }
      }
      for (let i = 0; i < ownersSnap.length; i += 1) {
        const owner = ownersSnap[i];
        if (owner && typeof owner.close === 'function') {
          try { owner.close(); } catch (_) { /* ignore */ }
        }
      }
    };

    server[SHUTDOWN_BEGIN_DISPATCHER] = dispatcher;
    server[ON_SHUTDOWN_BEGIN_HOOK] = dispatcher;
  }

  // Already fired (held registry after partial teardown) — do not re-add owners.
  if (registry.fired) {
    return false;
  }

  registry.owners.add(admissionBoundary);
  return true;
}

function countLifecycleListeners(ee) {
  if (!ee || typeof ee.listenerCount !== 'function') {
    return { aborted: 0, close: 0, error: 0, finish: 0 };
  }
  return {
    aborted: ee.listenerCount('aborted'),
    close: ee.listenerCount('close'),
    error: ee.listenerCount('error'),
    finish: ee.listenerCount('finish'),
  };
}

/**
 * Mark durable/webhook side effects started for the active admission token.
 * Safe no-op when admission is OFF or request is excluded.
 * @param {import('http').IncomingMessage} req
 */
function markStaffApiAdmissionSideEffectStarted(req) {
  const state = getAdmissionState(req);
  if (!state || !state.token_id || !state.controller) {
    return { ok: true, skipped: true, reason: 'no_admission_token' };
  }
  return state.controller.markSideEffectStarted(state.token_id);
}

/**
 * Attempt post-admit 503 shed. Post-side-effect returns internal continue (no HTTP).
 * @param {import('http').IncomingMessage} req
 */
function tryStaffApiAdmissionRejectWith503(req) {
  const state = getAdmissionState(req);
  if (!state || !state.token_id || !state.controller) {
    return { ok: true, skipped: true, reason: 'no_admission_token' };
  }
  return state.controller.tryRejectWith503(state.token_id);
}

/**
 * Create HTTP-boundary admission wrapper around a route handler.
 * @param {{
 *   trustedTenantSlug?: unknown,
 *   controller?: ReturnType<typeof createAdmissionController>,
 *   limits?: object,
 *   sendJSON?: Function,
 *   nowMs?: () => number,
 * }} [options]
 */
function createAdmissionBoundary(options) {
  const opt = options || {};
  const controller = opt.controller || createAdmissionController({
    limits: opt.limits,
    nowMs: opt.nowMs,
  });
  const trustedTenantSlug = opt.trustedTenantSlug;
  const sendJSON = typeof opt.sendJSON === 'function' ? opt.sendJSON : null;

  /** @type {Map<string, { done: boolean, phase: string, detach: (() => void)|null, resolve: (v: object|null) => void }>} */
  const waiters = new Map();
  let boundaryClosed = false;

  function notifyPromoted(promoted) {
    if (!promoted || !promoted.ok || !promoted.token_id) return;
    const w = waiters.get(promoted.token_id);
    if (!w || w.done || w.phase !== 'queued') return;
    // Promotion settles the queued waiter; detach BEFORE resolve so a late
    // abort/close cannot cancel the now-admitted token.
    w.phase = 'promoted';
    w.done = true;
    waiters.delete(promoted.token_id);
    if (typeof w.detach === 'function') {
      try { w.detach(); } catch (_) { /* ignore */ }
      w.detach = null;
    }
    w.resolve(promoted);
  }

  function releaseOnceState(state, reason) {
    if (!state || state.released) return null;
    state.released = true;
    detachLifecycle(state);
    const rel = controller.release(state.token_id, reason || 'complete');
    if (rel && rel.ok) notifyPromoted(rel.promoted);
    return rel;
  }

  function detachLifecycle(state) {
    if (!state || !state._detach) return;
    try { state._detach(); } catch (_) { /* ignore */ }
    state._detach = null;
  }

  function attachLifecycleRelease(req, res, state) {
    let detached = false;
    function onFinish() { releaseOnceState(state, 'finish'); }
    function onClose() { releaseOnceState(state, 'close'); }
    function onResError() { releaseOnceState(state, 'error'); }
    function onReqError() { releaseOnceState(state, 'error'); }
    function onAborted() { releaseOnceState(state, 'abort'); }

    function detach() {
      if (detached) return;
      detached = true;
      try { if (res && res.removeListener) res.removeListener('finish', onFinish); } catch (_) {}
      try { if (res && res.removeListener) res.removeListener('close', onClose); } catch (_) {}
      try { if (res && res.removeListener) res.removeListener('error', onResError); } catch (_) {}
      try { if (req && req.removeListener) req.removeListener('error', onReqError); } catch (_) {}
      try { if (req && req.removeListener) req.removeListener('aborted', onAborted); } catch (_) {}
    }
    state._detach = detach;

    try {
      if (res && typeof res.once === 'function') {
        res.once('finish', onFinish);
        res.once('close', onClose);
        res.once('error', onResError);
      }
      if (req && typeof req.once === 'function') {
        req.once('aborted', onAborted);
        req.once('error', onReqError);
      }
    } catch (_) {
      // Attachment failure must not alter handler semantics beyond missing release —
      // finally path still releases.
    }
  }

  function bindToken(req, tokenId) {
    const state = {
      token_id: tokenId,
      controller,
      released: false,
      handler_started: false,
      _detach: null,
    };
    req[ADMISSION_REQ_KEY] = state;
    return state;
  }

  /**
   * Cancel a still-queued token. Safe no-op when waiter already left queued phase
   * (promoted / cancelled) so a late event cannot release a promoted token.
   * When no waiter is registered yet (pre-wait cancel), abort only if
   * `allowWithoutWaiter` is true — never blind-abort after promotion.
   */
  function cancelQueued(tokenId, req, res, reason, allowWithoutWaiter) {
    const w = waiters.get(tokenId);
    if (w) {
      if (w.done || w.phase !== 'queued') return null;
      w.phase = 'cancelled';
      w.done = true;
      waiters.delete(tokenId);
      if (typeof w.detach === 'function') {
        try { w.detach(); } catch (_) { /* ignore */ }
        w.detach = null;
      }
      w.resolve(null);
    } else if (!allowWithoutWaiter) {
      // Late event after waiter was removed (promoted/cancelled) — do not abort.
      return null;
    }
    const rel = controller.abort(tokenId);
    if (rel && rel.ok) notifyPromoted(rel.promoted);
    void reason;
    void req;
    void res;
    return rel;
  }

  /**
   * Wait until a queued token is promoted. Named once listeners + one idempotent
   * detach; late events after promotion/cancel must not touch the token.
   */
  function waitForPromotion(tokenId, req, res) {
    return new Promise((resolve) => {
      if (boundaryClosed || isTransportDead(req, res)) {
        cancelQueued(
          tokenId,
          req,
          res,
          boundaryClosed ? 'shutdown' : 'pre_queue_dead',
          true,
        );
        if (boundaryClosed && res && !res.writableEnded && !res.headersSent) {
          writePublic503(res, {
            retryAfterSeconds: controller.limits.retry_after_seconds,
            sendJSON,
          });
        }
        resolve(null);
        return;
      }

      const entry = {
        done: false,
        phase: 'queued',
        detach: null,
        resolve: (v) => resolve(v),
      };
      waiters.set(tokenId, entry);

      let detached = false;
      function detachQueuedLifecycle() {
        if (detached) return;
        detached = true;
        try { if (req && req.removeListener) req.removeListener('aborted', onReqAborted); } catch (_) {}
        try { if (req && req.removeListener) req.removeListener('close', onReqClose); } catch (_) {}
        try { if (res && res.removeListener) res.removeListener('close', onResClose); } catch (_) {}
        try { if (res && res.removeListener) res.removeListener('error', onResError); } catch (_) {}
      }
      entry.detach = detachQueuedLifecycle;

      function cancelFromQueue(reason) {
        // Phase gate: promotion/cancel already settled → ignore late events.
        if (entry.done || entry.phase !== 'queued') return;
        cancelQueued(tokenId, req, res, reason);
      }

      function onReqAborted() { cancelFromQueue('req_aborted'); }
      function onReqClose() { cancelFromQueue('req_close'); }
      function onResClose() {
        // Premature res close while queued (not a clean writableEnded finish).
        if (entry.done || entry.phase !== 'queued') return;
        if (res && res.writableEnded === true) return;
        cancelFromQueue('res_close');
      }
      function onResError() { cancelFromQueue('res_error'); }

      try {
        if (req && typeof req.once === 'function') {
          req.once('aborted', onReqAborted);
          req.once('close', onReqClose);
        }
        if (res && typeof res.once === 'function') {
          res.once('close', onResClose);
          res.once('error', onResError);
        }
      } catch (_) { /* ignore */ }

      // Re-check after attach — race with already-dead transport.
      if (boundaryClosed || isTransportDead(req, res)) {
        cancelFromQueue(boundaryClosed ? 'shutdown' : 'pre_queue_dead_race');
      }
    });
  }

  /**
   * Release a just-promoted token without running the handler (transport died
   * between promote and router execution).
   */
  function dropPromotedWithoutHandler(tokenId, reason) {
    const w = waiters.get(tokenId);
    if (w && !w.done) {
      w.phase = 'cancelled';
      w.done = true;
      waiters.delete(tokenId);
      if (typeof w.detach === 'function') {
        try { w.detach(); } catch (_) { /* ignore */ }
        w.detach = null;
      }
    }
    const rel = controller.release(tokenId, reason || 'pre_run_dead');
    if (rel && rel.ok) notifyPromoted(rel.promoted);
    return rel;
  }

  async function runWithToken(req, res, handler, tokenId) {
    const state = bindToken(req, tokenId);
    attachLifecycleRelease(req, res, state);
    state.handler_started = true;
    let handlerInvocations = 0;
    try {
      handlerInvocations += 1;
      if (handlerInvocations !== 1) {
        throw new Error('admission_handler_resumed_more_than_once');
      }
      await handler(req, res);
    } catch (err) {
      // Ensure release even if outer catch cannot end the response.
      releaseOnceState(state, 'handler_throw');
      throw err;
    } finally {
      // If handler returned without ending and no lifecycle fired yet, keep token
      // until finish/close. If already ended, lifecycle released. If throw path
      // already released, releaseOnce is idempotent via state.released.
      if (res && (res.writableEnded || res.headersSent)) {
        releaseOnceState(state, 'handler_return');
      }
    }
  }

  /**
   * Admit (or exclude) then invoke handler. Never reads spoofed tenant claims
   * from request headers/query/body — only construction-time trustedTenantSlug.
   */
  async function admitAndRun(req, res, handler) {
    if (typeof handler !== 'function') {
      throw new Error('admission_handler_required');
    }

    if (boundaryClosed) {
      writePublic503(res, {
        retryAfterSeconds: controller.limits.retry_after_seconds,
        sendJSON,
      });
      return { decision: DECISIONS.REJECTED_CLOSED, ran_handler: false };
    }

    const method = String((req && req.method) || 'GET').toUpperCase();
    const pathname = normalizePathnameFromReq(req);

    // Identity: trusted construction-time slug ONLY. Never pass claimFromRequest.
    const decision = controller.tryAdmit({
      method,
      pathname,
      trustedTenantSlug,
    });

    if (decision.decision === DECISIONS.EXCLUDED) {
      await handler(req, res);
      return { decision: decision.decision, ran_handler: true, counted: false };
    }

    // Unknown routes: default-exclude fail-closed for admission — handler runs (404).
    if (decision.decision === DECISIONS.REJECTED_UNKNOWN_ROUTE) {
      await handler(req, res);
      return { decision: decision.decision, ran_handler: true, counted: false };
    }

    // Pre-side-effect overload: bounded public 503 + Retry-After.
    if (decision.ok === false && decision.http_status === HTTP_REJECT.status) {
      writePublic503(res, {
        retryAfterSeconds: decision.retry_after_seconds,
        sendJSON,
      });
      return { decision: decision.decision, ran_handler: false, shed: true };
    }

    // Missing/untrusted/closed/internal — fail closed, no handler, no sensitive body.
    if (decision.ok === false) {
      writePublic503(res, { sendJSON }); // no Retry-After (not overload)
      return { decision: decision.decision, ran_handler: false, fail_closed: true };
    }

    if (decision.decision === DECISIONS.ADMITTED) {
      if (isTransportDead(req, res)) {
        dropPromotedWithoutHandler(decision.token_id, 'admit_pre_run_dead');
        return {
          decision: decision.decision,
          ran_handler: false,
          cancelled: true,
          reason: 'transport_dead',
        };
      }
      await runWithToken(req, res, handler, decision.token_id);
      return { decision: decision.decision, ran_handler: true, token_id: decision.token_id };
    }

    if (decision.decision === DECISIONS.QUEUED) {
      // Fail/cancel before entering the wait queue when transport already dead.
      if (isTransportDead(req, res)) {
        cancelQueued(decision.token_id, req, res, 'pre_queue_dead', true);
        return {
          decision: DECISIONS.QUEUED,
          ran_handler: false,
          cancelled: true,
          reason: 'transport_dead',
        };
      }

      const promoted = await waitForPromotion(decision.token_id, req, res);
      if (!promoted) {
        // Disconnect cancel or shutdown — do not run handler.
        if (!res.writableEnded && !res.headersSent && boundaryClosed) {
          writePublic503(res, {
            retryAfterSeconds: controller.limits.retry_after_seconds,
            sendJSON,
          });
        }
        return { decision: DECISIONS.QUEUED, ran_handler: false, cancelled: true };
      }

      // Immediately before promoted router execution — re-check transport.
      if (isTransportDead(req, res)) {
        dropPromotedWithoutHandler(decision.token_id, 'promote_pre_run_dead');
        return {
          decision: DECISIONS.QUEUED,
          ran_handler: false,
          cancelled: true,
          reason: 'transport_dead_after_promote',
          was_queued: true,
        };
      }

      await runWithToken(req, res, handler, decision.token_id);
      return {
        decision: DECISIONS.ADMITTED,
        ran_handler: true,
        token_id: decision.token_id,
        was_queued: true,
      };
    }

    // Unexpected decision — fail closed.
    writePublic503(res, { sendJSON });
    return { decision: decision.decision, ran_handler: false, fail_closed: true };
  }

  function close() {
    if (boundaryClosed) {
      return controller.close();
    }
    boundaryClosed = true;
    const pending = Array.from(waiters.keys());
    for (let i = 0; i < pending.length; i += 1) {
      const id = pending[i];
      const w = waiters.get(id);
      if (!w || w.done || w.phase !== 'queued') continue;
      w.phase = 'cancelled';
      w.done = true;
      waiters.delete(id);
      if (typeof w.detach === 'function') {
        try { w.detach(); } catch (_) { /* ignore */ }
        w.detach = null;
      }
      w.resolve(null);
    }
    waiters.clear();
    return controller.close();
  }

  return {
    controller,
    admitAndRun,
    close,
    writePublic503: (res, o) => writePublic503(res, Object.assign({ sendJSON }, o || {})),
    diagnostics: () => controller.diagnostics(),
    getWaiterCount: () => waiters.size,
    FLAG_ENV,
  };
}

module.exports = {
  FLAG_ENV,
  FLAG_OFF,
  FLAG_ON,
  PUBLIC_503_BODY,
  ADMISSION_REQ_KEY,
  ON_SHUTDOWN_BEGIN_HOOK,
  SHUTDOWN_BEGIN_REGISTRY,
  SHUTDOWN_BEGIN_DISPATCHER,
  LIMITS,
  DECISIONS,
  HTTP_REJECT,
  parseAdmissionControlFlag,
  resolveAdmissionControlEnabled,
  writePublic503,
  clonePublic503Body,
  createAdmissionBoundary,
  createAdmissionController,
  classifyRoute,
  markStaffApiAdmissionSideEffectStarted,
  tryStaffApiAdmissionRejectWith503,
  getAdmissionState,
  isTransportDead,
  bindAdmissionShutdownBegin,
  countLifecycleListeners,
};
