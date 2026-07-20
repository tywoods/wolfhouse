'use strict';

/**
 * Staff API readiness (RADAR 16C) — dependency-aware /readyz.
 *
 * Contract:
 * - /healthz remains static liveness (process up); must NOT touch Postgres.
 * - /readyz performs only a bounded read-only Postgres check via the existing pool.
 * - Responses are generic: 200 { status: "ready" } or 503 { status: "not-ready" }.
 * - Never expose credentials, SQL text, stack traces, or upstream error messages.
 * - Readiness SQL is fixed SELECT 1 — no DML/DDL.
 * - Timeout cancels acquisition + SELECT; leaves no pending waiter, checked-out
 *   client, active query, timer, or accumulating background probe task.
 */

const READYZ_PATH = '/readyz';
const HEALTHZ_PATH = '/healthz';

/** Fixed read-only probe SQL — must remain exactly this string. */
const READINESS_SQL = 'SELECT 1';

/** Bound how long /readyz waits on Postgres before failing closed. */
const READINESS_TIMEOUT_MS = 2500;

const READY_BODY = Object.freeze({ status: 'ready' });
const NOT_READY_BODY = Object.freeze({ status: 'not-ready' });

const FORBIDDEN_SQL_MARKERS = Object.freeze([
  'insert',
  'update',
  'delete',
  'drop',
  'alter',
  'create',
  'truncate',
  'grant',
  'revoke',
  'copy',
  'call',
  'do ',
  'execute',
  'comment',
  'vacuum',
  'reindex',
  'cluster',
  'lock',
  'notify',
  'listen',
  'unlisten',
  'discard',
  'reset',
  'set ',
  'begin',
  'commit',
  'rollback',
]);

/**
 * Fail closed unless SQL is exactly the fixed read-only readiness query.
 * @param {string} sql
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function assertReadOnlyReadinessSql(sql) {
  if (typeof sql !== 'string' || sql !== READINESS_SQL) {
    return { ok: false, reason: 'sql_not_fixed_select_1' };
  }
  const lower = sql.toLowerCase();
  for (const marker of FORBIDDEN_SQL_MARKERS) {
    if (lower.includes(marker.trim())) {
      return { ok: false, reason: 'sql_forbidden_marker' };
    }
  }
  return { ok: true };
}

/**
 * Best-effort cancel of an in-flight node-pg query / connection.
 * @param {{ connection?: { stream?: { destroy?: Function } }, end?: Function, activeQuery?: unknown } | null} client
 */
function destroyClientConnection(client) {
  if (!client) return;
  try {
    const stream = client.connection && client.connection.stream;
    if (stream && typeof stream.destroy === 'function') {
      stream.destroy();
      return;
    }
  } catch (_) { /* ignore */ }
  try {
    if (typeof client.end === 'function') client.end();
  } catch (_) { /* ignore */ }
}

/**
 * Acquire a pool client with a hard timeout that removes the pending waiter
 * (no abandoned queue entry) and releases late arrivals immediately.
 *
 * @param {{ connect: Function, _pendingQueue?: Array<{ callback: Function, timedOut?: boolean }> }} pool
 * @param {number} timeoutMs
 * @param {() => boolean} isAborted
 * @param {{ registerAbort?: (fn: () => void) => void }} [hooks]
 * @returns {Promise<{ client: object, release: (destroy?: boolean) => void }>}
 */
function acquirePoolClientBounded(pool, timeoutMs, isAborted, hooks = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    /** @type {Function | null} */
    let pendingCallback = null;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Drop our waiter from pg-pool's pending queue so saturation cannot accumulate.
      if (pendingCallback && Array.isArray(pool._pendingQueue)) {
        const idx = pool._pendingQueue.findIndex((item) => item && item.callback === pendingCallback);
        if (idx >= 0) {
          const item = pool._pendingQueue[idx];
          item.timedOut = true;
          pool._pendingQueue.splice(idx, 1);
        }
      }
      pendingCallback = null;
      reject(err);
    };

    if (typeof hooks.registerAbort === 'function') {
      hooks.registerAbort(() => fail(new Error('readiness_acquire_aborted')));
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => fail(new Error('readiness_acquire_timeout')), timeoutMs);
      // Keep timer referenced until settle — unref would let the process exit while
      // a pending acquire is still outstanding (pool saturation / offline tests).
    }

    pendingCallback = (err, client, release) => {
      // Late connect after abort/timeout: never hand out; release immediately.
      if (settled || isAborted()) {
        if (client && typeof release === 'function') {
          try { release(); } catch (_) { /* ignore */ }
        } else if (client && typeof client.release === 'function') {
          try { client.release(); } catch (_) { /* ignore */ }
        }
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pendingCallback = null;
      if (err) {
        reject(err);
        return;
      }
      let released = false;
      resolve({
        client,
        release(destroy) {
          if (released) return;
          released = true;
          try {
            if (destroy) destroyClientConnection(client);
          } catch (_) { /* ignore */ }
          try {
            if (typeof release === 'function') release(destroy ? new Error('readiness_cancelled') : undefined);
            else if (typeof client.release === 'function') client.release(destroy ? new Error('readiness_cancelled') : undefined);
          } catch (_) { /* ignore */ }
        },
      });
    };

    try {
      pool.connect(pendingCallback);
    } catch (err) {
      fail(err);
    }
  });
}

/**
 * Bridge withPgClient(fn) into an acquire/release handle held until release().
 * If aborted before the client is handed out, the fn exits immediately so
 * withPgClient's finally releases — no checked-out leak.
 *
 * @param {(fn: (client: object) => Promise<unknown>) => Promise<unknown>} withPgClient
 * @param {() => boolean} isAborted
 * @param {{ registerAbort?: (fn: () => void) => void }} [hooks]
 * @returns {Promise<{ client: object, release: (destroy?: boolean) => void }>}
 */
function acquireViaWithPgClient(withPgClient, isAborted, hooks = {}) {
  return new Promise((resolve, reject) => {
    let handed = false;
    let settled = false;
    let holdResolve = null;
    const hold = new Promise((r) => { holdResolve = r; });

    const fail = (err) => {
      if (settled || handed) return;
      settled = true;
      reject(err);
    };

    if (typeof hooks.registerAbort === 'function') {
      hooks.registerAbort(() => fail(new Error('readiness_acquire_aborted')));
    }

    Promise.resolve()
      .then(() => withPgClient(async (client) => {
        if (isAborted() || handed || settled) {
          // Timed out during acquisition or duplicate — do not query.
          return;
        }
        handed = true;
        settled = true;
        let released = false;
        resolve({
          client,
          release(destroy) {
            if (released) return;
            released = true;
            try {
              if (destroy) destroyClientConnection(client);
            } catch (_) { /* ignore */ }
            if (holdResolve) holdResolve();
          },
        });
        await hold;
      }))
      .then(() => {
        if (!handed && !settled) {
          fail(new Error(isAborted() ? 'readiness_acquire_aborted' : 'readiness_acquire_failed'));
        }
      })
      .catch((err) => {
        if (!handed) fail(err);
      });
  });
}

/**
 * Run SELECT via client.query; cancellable by destroying the connection.
 * @param {object} client
 * @param {string} sql
 * @returns {Promise<unknown>}
 */
function runClientQuery(client, sql) {
  if (!client || typeof client.query !== 'function') {
    return Promise.reject(new Error('missing_client'));
  }
  return Promise.resolve(client.query(sql));
}

/**
 * Single readiness operation: one deadline covers acquisition + SELECT.
 * cancel() clears the timer, drops pending acquire, destroys in-flight query
 * client, and releases — safe to call more than once.
 *
 * @param {{
 *   timeoutMs: number,
 *   sql: string,
 *   acquireClient: (isAborted: () => boolean) => Promise<{ client: object, release: (destroy?: boolean) => void }>,
 *   runQuery?: (client: object, sql: string) => Promise<unknown>,
 * }} deps
 */
function createReadinessOperation(deps) {
  const timeoutMs = deps.timeoutMs;
  const sql = deps.sql;
  const acquireClient = deps.acquireClient;
  const runQuery = deps.runQuery || runClientQuery;

  let state = 'pending'; // pending | acquiring | querying | succeeded | failed | cancelled
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {{ client: object, release: (destroy?: boolean) => void } | null} */
  let handle = null;
  /** @type {(() => void) | null} */
  let abortAcquire = null;
  /** @type {(value: { ok: true }) => void} */
  let resolvePromise;
  /** @type {(err: Error) => void} */
  let rejectPromise;
  let settleGuard = false;

  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  function isAborted() {
    return state === 'cancelled' || state === 'failed' || state === 'succeeded';
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function settleOk() {
    if (settleGuard) return;
    settleGuard = true;
    state = 'succeeded';
    clearTimer();
    abortAcquire = null;
    resolvePromise({ ok: true });
  }

  function settleErr(err) {
    if (settleGuard) return;
    settleGuard = true;
    if (state !== 'cancelled') state = 'failed';
    clearTimer();
    abortAcquire = null;
    rejectPromise(err instanceof Error ? err : new Error(String(err || 'readiness_failed')));
  }

  function releaseHandle(destroy) {
    if (!handle) return;
    const h = handle;
    handle = null;
    try { h.release(destroy); } catch (_) { /* ignore */ }
  }

  function cancel(reason) {
    if (state === 'succeeded' || state === 'cancelled') return;
    state = 'cancelled';
    clearTimer();
    if (typeof abortAcquire === 'function') {
      const abort = abortAcquire;
      abortAcquire = null;
      try { abort(); } catch (_) { /* ignore */ }
    }
    releaseHandle(true);
    settleErr(reason instanceof Error ? reason : new Error(reason || 'readiness_cancelled'));
  }

  function run() {
    if (state !== 'pending') return promise;
    state = 'acquiring';
    timer = setTimeout(() => {
      cancel(new Error('readiness_timeout'));
    }, timeoutMs);
    // Do not unref: deadline must remain live until cancel/settle clears it.

    // Kick work without making this function async — caller must attach to
    // `promise` synchronously via return so cancel cannot unhandled-reject.
    Promise.resolve()
      .then(() => acquireClient(isAborted, {
        registerAbort: (fn) => { abortAcquire = fn; },
      }))
      .then(async (acquired) => {
        if (isAborted()) {
          try { acquired.release(true); } catch (_) { /* ignore */ }
          return;
        }
        abortAcquire = null;
        handle = acquired;
        state = 'querying';
        await runQuery(acquired.client, sql);
        if (isAborted()) {
          releaseHandle(true);
          return;
        }
        releaseHandle(false);
        settleOk();
      })
      .catch((err) => {
        releaseHandle(true);
        if (!isAborted()) settleErr(err);
        // If already cancelled, settleErr was invoked by cancel().
      });

    return promise;
  }

  return {
    promise,
    run,
    cancel,
    getState: () => state,
    isAborted,
  };
}

/**
 * Bounded Postgres readiness via existing pool / withPgClient seam.
 * Never throws; never returns error details. Uses createReadinessOperation (no race-timeout abandon).
 * Timeout cancels acquisition + SELECT and clears timers/handles.
 *
 * @param {((fn: (client: { query: Function }) => Promise<unknown>) => Promise<unknown>) | null | undefined} withPgClient
 * @param {{
 *   timeoutMs?: number,
 *   sql?: string,
 *   pool?: { connect: Function },
 *   getPool?: () => { connect: Function } | null | undefined,
 *   acquireClient?: (isAborted: () => boolean) => Promise<{ client: object, release: (destroy?: boolean) => void }>,
 *   runQuery?: (client: object, sql: string) => Promise<unknown>,
 * }} [opts]
 * @returns {Promise<{ ok: boolean }>}
 */
async function checkPostgresReadiness(withPgClient, opts = {}) {
  const sql = opts.sql != null ? opts.sql : READINESS_SQL;
  const sqlGate = assertReadOnlyReadinessSql(sql);
  if (!sqlGate.ok) {
    return { ok: false };
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : READINESS_TIMEOUT_MS;

  let acquireClient = opts.acquireClient;
  if (typeof acquireClient !== 'function') {
    const pool = opts.pool
      || (typeof opts.getPool === 'function' ? opts.getPool() : null);
    if (pool && typeof pool.connect === 'function') {
      // Op deadline owns cancellation; acquire registers abort hook (no duplicate timer).
      acquireClient = (isAborted, hooks) => acquirePoolClientBounded(pool, 0, isAborted, hooks);
    } else if (typeof withPgClient === 'function') {
      acquireClient = (isAborted, hooks) => acquireViaWithPgClient(withPgClient, isAborted, hooks);
    } else {
      return { ok: false };
    }
  }

  const op = createReadinessOperation({
    timeoutMs,
    sql,
    acquireClient,
    runQuery: opts.runQuery,
  });

  try {
    await op.run();
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
}

/**
 * HTTP handler for GET /readyz.
 * @param {import('http').ServerResponse} res
 * @param {(res: import('http').ServerResponse, status: number, body: object) => void} sendJSON
 * @param {Function} withPgClient
 * @param {{ getPool?: Function, pool?: object }} [opts]
 */
async function handleStaffApiReadyz(res, sendJSON, withPgClient, opts = {}) {
  const result = await checkPostgresReadiness(withPgClient, opts);
  if (result.ok) {
    return sendJSON(res, 200, READY_BODY);
  }
  return sendJSON(res, 503, NOT_READY_BODY);
}

module.exports = {
  READYZ_PATH,
  HEALTHZ_PATH,
  READINESS_SQL,
  READINESS_TIMEOUT_MS,
  READY_BODY,
  NOT_READY_BODY,
  FORBIDDEN_SQL_MARKERS,
  assertReadOnlyReadinessSql,
  destroyClientConnection,
  acquirePoolClientBounded,
  acquireViaWithPgClient,
  createReadinessOperation,
  checkPostgresReadiness,
  handleStaffApiReadyz,
};
