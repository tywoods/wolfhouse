'use strict';

/**
 * Staff API readiness lifecycle (RADAR 16W) — graceful shutdown for /readyz pool only.
 *
 * Contract:
 * - SIGTERM + SIGINT trigger idempotent shutdown exactly once (concurrent calls share one promise).
 * - Order: bounded closeReadinessPool → bounded server.close → terminate(original signal).
 * - Persistent owned listeners install once on CLI main only; factory reuse must not add listeners.
 * - Handlers guard on shared shutdown promise; repeated/mixed signals join without changing shutdownSignal.
 * - After cleanup: remove owned listeners, re-signal via injectable terminate(signal) — no zero exit hack.
 * - Pool/server phases use explicit unref'd timers; server close always attempted after pool phase.
 * - Always emits one bounded 16Y completion record (event/original_signal/
 *   pool_close_result/server_close_result/failure_classes/completion) after
 *   pool+server results and before detach/native re-signal.
 * - Default logger: one JSON line to stdout; injected log remains supported.
 * - Does NOT touch application pg pool (forbidden composition with pg-connect close).
 */

const { closeReadinessPool } = require('./staff-api-readiness');
const {
  buildShutdownCompletionRecord,
  defaultShutdownCompletionLogger,
} = require('./staff-api-readiness-shutdown-completion-log');

const DEFAULT_POOL_CLOSE_TIMEOUT_MS = 10_000;
const DEFAULT_SERVER_CLOSE_TIMEOUT_MS = 30_000;

/** Bounded, non-sensitive failure taxonomy for shutdown aggregation. */
const FAILURE_CLASSES = Object.freeze([
  'pool_close_rejected',
  'pool_close_throw',
  'pool_close_timeout',
  'server_close_rejected',
  'server_close_throw',
  'server_close_timeout',
  'server_close_already_closed',
]);

/** @type {import('http').Server | null} */
let boundServer = null;
let listenersInstalled = false;
let shutdownStarted = false;
/** @type {Promise<void> | null} */
let shutdownPromise = null;
/** @type {string | null} */
let shutdownSignal = null;
/** @type {((...args: unknown[]) => void) | null} */
let sigtermHandler = null;
/** @type {((...args: unknown[]) => void) | null} */
let sigintHandler = null;

/**
 * Default terminate preserves native signal semantics after owned handlers are removed.
 * @param {string} signal
 */
function defaultTerminate(signal) {
  process.kill(process.pid, signal);
}

/**
 * @param {Promise<unknown>} promise
 * @param {number} timeoutMs
 * @returns {Promise<'ok' | 'rejected' | 'timeout'>}
 */
function boundedAwait(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    timer.unref();

    Promise.resolve(promise).then(
      () => finish('ok'),
      () => finish('rejected'),
    );
  });
}

/**
 * @param {import('http').Server} server
 * @param {number} timeoutMs
 * @returns {Promise<'ok' | 'rejected' | 'throw' | 'timeout' | 'already_closed'>}
 */
function boundedServerClose(server, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    timer.unref();

    try {
      if (!server.listening) {
        finish('already_closed');
        return;
      }

      server.close((err) => {
        if (err) finish('rejected');
        else finish('ok');
      });
    } catch {
      finish('throw');
    }
  });
}

/**
 * @param {'ok' | 'rejected' | 'timeout' | 'throw'} poolResult
 * @param {'ok' | 'rejected' | 'throw' | 'timeout' | 'already_closed'} serverResult
 * @returns {string[]}
 */
function classifyShutdownFailures(poolResult, serverResult) {
  /** @type {string[]} */
  const failures = [];
  if (poolResult === 'rejected') failures.push('pool_close_rejected');
  if (poolResult === 'throw') failures.push('pool_close_throw');
  if (poolResult === 'timeout') failures.push('pool_close_timeout');
  if (serverResult === 'rejected') failures.push('server_close_rejected');
  if (serverResult === 'throw') failures.push('server_close_throw');
  if (serverResult === 'timeout') failures.push('server_close_timeout');
  if (serverResult === 'already_closed') failures.push('server_close_already_closed');
  return failures.filter((f) => FAILURE_CLASSES.includes(f));
}

/**
 * Invoke pool close; synchronous throws are classified without rejecting shutdown.
 * @param {() => Promise<void>} closePool
 * @returns {Promise<void> | null} null when closePool throws synchronously
 */
function invokePoolClose(closePool) {
  try {
    return closePool();
  } catch {
    return null;
  }
}

function detachOwnedSignalListeners() {
  if (sigtermHandler) {
    process.removeListener('SIGTERM', sigtermHandler);
    sigtermHandler = null;
  }
  if (sigintHandler) {
    process.removeListener('SIGINT', sigintHandler);
    sigintHandler = null;
  }
  listenersInstalled = false;
}

/**
 * @param {import('http').Server | null | undefined} server
 * @param {string} signal
 * @param {{
 *   closeReadinessPool?: () => Promise<void>,
 *   terminate?: ((signal: string) => void) | false,
 *   log?: (record: {
 *     event: string,
 *     original_signal: string,
 *     pool_close_result: string,
 *     server_close_result: string,
 *     failure_classes: string[],
 *     completion: true,
 *   }) => void,
 *   poolCloseTimeoutMs?: number,
 *   serverCloseTimeoutMs?: number,
 * }} [deps]
 * @returns {Promise<void>}
 */
function runStaffApiReadinessShutdown(server, signal, deps = {}) {
  if (shutdownPromise) {
    return shutdownPromise;
  }
  shutdownStarted = true;
  shutdownSignal = signal;

  const closePool = typeof deps.closeReadinessPool === 'function'
    ? deps.closeReadinessPool
    : closeReadinessPool;
  const terminateFn = deps.terminate === false
    ? null
    : (typeof deps.terminate === 'function' ? deps.terminate : defaultTerminate);
  const logFn = typeof deps.log === 'function'
    ? deps.log
    : defaultShutdownCompletionLogger;
  const poolTimeout = deps.poolCloseTimeoutMs ?? DEFAULT_POOL_CLOSE_TIMEOUT_MS;
  const serverTimeout = deps.serverCloseTimeoutMs ?? DEFAULT_SERVER_CLOSE_TIMEOUT_MS;

  /** Guards against duplicate completion records if terminate throws / re-enters. */
  let completionRecordEmitted = false;

  shutdownPromise = (async () => {
    let poolResult = 'ok';
    let serverResult = 'ok';
    try {
      const poolPromise = invokePoolClose(closePool);
      if (poolPromise === null) {
        poolResult = 'throw';
      } else {
        poolResult = await boundedAwait(poolPromise, poolTimeout);
      }

      const target = server || boundServer;
      if (target && typeof target.close === 'function') {
        serverResult = await boundedServerClose(target, serverTimeout);
      }

      const failureClasses = classifyShutdownFailures(poolResult, serverResult);
      // RADAR 16Y: always emit one bounded completion record before detach/terminate.
      if (!completionRecordEmitted) {
        completionRecordEmitted = true;
        try {
          const record = buildShutdownCompletionRecord({
            original_signal: shutdownSignal,
            pool_close_result: poolResult,
            server_close_result: serverResult,
            failure_classes: failureClasses,
          });
          if (record) logFn(record);
        } catch {
          // logging is best-effort; must not block detach/terminate
        }
      }
    } finally {
      detachOwnedSignalListeners();
      if (terminateFn && shutdownSignal) {
        try {
          terminateFn(shutdownSignal);
        } catch {
          // termination attempted once; injected failures must not block cleanup
        }
      }
    }
  })();

  return shutdownPromise;
}

/**
 * Install SIGTERM/SIGINT handlers once for CLI main.
 * @param {import('http').Server | null | undefined} server
 * @param {{
 *   closeReadinessPool?: () => Promise<void>,
 *   terminate?: ((signal: string) => void) | false,
 *   log?: (record: {
 *     event: string,
 *     original_signal: string,
 *     pool_close_result: string,
 *     server_close_result: string,
 *     failure_classes: string[],
 *     completion: true,
 *   }) => void,
 *   poolCloseTimeoutMs?: number,
 *   serverCloseTimeoutMs?: number,
 * }} [opts]
 * @returns {{ installed: boolean, alreadyInstalled?: boolean }}
 */
function attachStaffApiReadinessLifecycle(server, opts = {}) {
  if (listenersInstalled) {
    return { installed: false, alreadyInstalled: true };
  }
  listenersInstalled = true;
  boundServer = server || null;

  sigtermHandler = () => {
    void runStaffApiReadinessShutdown(boundServer, 'SIGTERM', opts);
  };
  sigintHandler = () => {
    void runStaffApiReadinessShutdown(boundServer, 'SIGINT', opts);
  };

  process.on('SIGTERM', sigtermHandler);
  process.on('SIGINT', sigintHandler);

  return { installed: true };
}

/** Test seam: trigger shutdown without emitting OS signals. */
function _triggerStaffApiReadinessShutdownForTests(server, signal, opts = {}) {
  return runStaffApiReadinessShutdown(server || boundServer, signal, opts);
}

function _resetStaffApiReadinessLifecycleForTests() {
  detachOwnedSignalListeners();
  boundServer = null;
  shutdownStarted = false;
  shutdownPromise = null;
  shutdownSignal = null;
}

function _getStaffApiReadinessLifecycleStateForTests() {
  return {
    boundServer,
    listenersInstalled,
    shutdownStarted,
    shutdownPromise,
    shutdownSignal,
    sigtermHandler,
    sigintHandler,
  };
}

module.exports = {
  attachStaffApiReadinessLifecycle,
  runStaffApiReadinessShutdown,
  defaultTerminate,
  FAILURE_CLASSES,
  DEFAULT_POOL_CLOSE_TIMEOUT_MS,
  DEFAULT_SERVER_CLOSE_TIMEOUT_MS,
  _triggerStaffApiReadinessShutdownForTests,
  _resetStaffApiReadinessLifecycleForTests,
  _getStaffApiReadinessLifecycleStateForTests,
  _boundedAwaitForTests: boundedAwait,
  _boundedServerCloseForTests: boundedServerClose,
  _invokePoolCloseForTests: invokePoolClose,
  _classifyShutdownFailuresForTests: classifyShutdownFailures,
};
