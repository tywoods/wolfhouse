'use strict';

/**
 * Staff API readiness lifecycle (RADAR 16W) — graceful shutdown for /readyz pool only.
 *
 * Contract:
 * - SIGTERM + SIGINT trigger idempotent shutdown exactly once.
 * - Order: await closeReadinessPool() → await server.close() → optional process.exit.
 * - Listeners install once on CLI main only; factory reuse must not add listeners.
 * - Does NOT touch application pg pool (forbidden composition with pg-connect close).
 */

const { closeReadinessPool } = require('./staff-api-readiness');

/** @type {import('http').Server | null} */
let boundServer = null;
let listenersInstalled = false;
let shutdownStarted = false;
/** @type {Promise<void> | null} */
let shutdownPromise = null;

/**
 * @param {import('http').Server | null | undefined} server
 * @param {{
 *   closeReadinessPool?: () => Promise<void>,
 *   exit?: ((code?: number) => never) | false,
 *   exitCodeForSignal?: (signal: string) => number,
 * }} [deps]
 * @returns {Promise<void>}
 */
async function runStaffApiReadinessShutdown(server, deps = {}) {
  if (shutdownStarted) {
    return shutdownPromise || Promise.resolve();
  }
  shutdownStarted = true;

  const closePool = typeof deps.closeReadinessPool === 'function'
    ? deps.closeReadinessPool
    : closeReadinessPool;
  const exitFn = deps.exit === false
    ? null
    : (typeof deps.exit === 'function' ? deps.exit : process.exit.bind(process));
  const exitCodeForSignal = typeof deps.exitCodeForSignal === 'function'
    ? deps.exitCodeForSignal
    : (signal) => (signal === 'SIGINT' ? 130 : 0);

  shutdownPromise = (async () => {
    await closePool();

    const target = server || boundServer;
    if (target && typeof target.close === 'function') {
      await new Promise((resolve, reject) => {
        target.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    if (exitFn) {
      exitFn(exitCodeForSignal('SIGTERM'));
    }
  })();

  return shutdownPromise;
}

/**
 * Install SIGTERM/SIGINT handlers once for CLI main.
 * @param {import('http').Server | null | undefined} server
 * @param {{
 *   closeReadinessPool?: () => Promise<void>,
 *   exit?: ((code?: number) => never) | false,
 *   exitCodeForSignal?: (signal: string) => number,
 * }} [opts]
 * @returns {{ installed: boolean, alreadyInstalled?: boolean }}
 */
function attachStaffApiReadinessLifecycle(server, opts = {}) {
  if (listenersInstalled) {
    return { installed: false, alreadyInstalled: true };
  }
  listenersInstalled = true;
  boundServer = server || null;

  const onSignal = (signal) => {
    void runStaffApiReadinessShutdown(boundServer, {
      ...opts,
      exitCodeForSignal: opts.exitCodeForSignal
        || ((sig) => (sig === 'SIGINT' ? 130 : 0)),
    }).catch(() => {
      const exitFn = opts.exit === false
        ? null
        : (typeof opts.exit === 'function' ? opts.exit : process.exit.bind(process));
      if (exitFn) exitFn(1);
    });
  };

  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));

  return { installed: true };
}

/** Test seam: trigger shutdown without emitting OS signals. */
function _triggerStaffApiReadinessShutdownForTests(server, signal, opts = {}) {
  return runStaffApiReadinessShutdown(server || boundServer, {
    ...opts,
    exitCodeForSignal: opts.exitCodeForSignal
      || ((sig) => (sig === 'SIGINT' ? 130 : 0)),
  });
}

function _resetStaffApiReadinessLifecycleForTests() {
  boundServer = null;
  listenersInstalled = false;
  shutdownStarted = false;
  shutdownPromise = null;
}

function _getStaffApiReadinessLifecycleStateForTests() {
  return {
    boundServer,
    listenersInstalled,
    shutdownStarted,
    shutdownPromise,
  };
}

module.exports = {
  attachStaffApiReadinessLifecycle,
  runStaffApiReadinessShutdown,
  _triggerStaffApiReadinessShutdownForTests,
  _resetStaffApiReadinessLifecycleForTests,
  _getStaffApiReadinessLifecycleStateForTests,
};
