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

  /** @type {Map<string, { done: boolean, resolve: (v: object|null) => void }>} */
  const waiters = new Map();
  let boundaryClosed = false;

  function notifyPromoted(promoted) {
    if (!promoted || !promoted.ok || !promoted.token_id) return;
    const w = waiters.get(promoted.token_id);
    if (!w || w.done) return;
    w.done = true;
    waiters.delete(promoted.token_id);
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
      if (res && typeof res.on === 'function') {
        res.on('finish', onFinish);
        res.on('close', onClose);
        res.on('error', onResError);
      }
      if (req && typeof req.on === 'function') {
        req.on('aborted', onAborted);
        req.on('error', onReqError);
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

  function cancelQueued(tokenId, req, res, reason) {
    const w = waiters.get(tokenId);
    if (w && !w.done) {
      w.done = true;
      waiters.delete(tokenId);
      w.resolve(null);
    }
    const rel = controller.abort(tokenId);
    if (rel && rel.ok) notifyPromoted(rel.promoted);
    // No handler ran — if response still open and not client-abort, optional silent.
    void reason;
    void req;
    void res;
    return rel;
  }

  function waitForPromotion(tokenId, req, res) {
    return new Promise((resolve) => {
      if (boundaryClosed) {
        cancelQueued(tokenId, req, res, 'shutdown');
        writePublic503(res, { retryAfterSeconds: controller.limits.retry_after_seconds, sendJSON });
        resolve(null);
        return;
      }

      const entry = {
        done: false,
        resolve: (v) => resolve(v),
      };
      waiters.set(tokenId, entry);

      function onAbort() {
        if (entry.done) return;
        cancelQueued(tokenId, req, res, 'disconnect');
      }

      try {
        if (req && typeof req.on === 'function') {
          req.on('aborted', onAbort);
          req.on('close', onAbort);
        }
        if (res && typeof res.on === 'function') {
          res.on('close', () => {
            if (entry.done) return;
            if (res.writableEnded) return;
            onAbort();
          });
        }
      } catch (_) { /* ignore */ }

      if (req && (req.aborted === true || req.readableAborted === true)) {
        onAbort();
      }
    });
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
      await runWithToken(req, res, handler, decision.token_id);
      return { decision: decision.decision, ran_handler: true, token_id: decision.token_id };
    }

    if (decision.decision === DECISIONS.QUEUED) {
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
    boundaryClosed = true;
    const pending = Array.from(waiters.keys());
    for (let i = 0; i < pending.length; i += 1) {
      const id = pending[i];
      const w = waiters.get(id);
      if (w && !w.done) {
        w.done = true;
        waiters.delete(id);
        w.resolve(null);
      }
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
};
