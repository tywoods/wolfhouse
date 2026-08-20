'use strict';

/**
 * Bounded Sunset-staging IMAP poller. Import-inert; start() arms a timer only
 * when a caller explicitly starts it. Single-flight; overlap skipped.
 *
 * @module email-imap-sunset-staging-worker
 */

function createEmailImapSunsetStagingWorker(deps) {
  if (!deps || typeof deps.pollOnce !== 'function' || !deps.timers
      || typeof deps.timers.setTimeout !== 'function'
      || typeof deps.timers.clearTimeout !== 'function'
      || !Number.isInteger(deps.intervalMs) || deps.intervalMs < 60000 || deps.intervalMs > 120000) {
    throw new Error('email_imap_worker_invalid');
  }
  const query = typeof deps.query === 'function' ? deps.query : async () => ({ rows: [] });
  let running = false;
  let timer = null;
  let stopped = true;

  async function tick() {
    if (running) return Object.freeze({ status: 'overlap_skipped' });
    running = true;
    try {
      if (typeof query === 'function') await query('SELECT 1', []);
      const out = await deps.pollOnce();
      return Object.freeze({ status: 'completed', result: out || null });
    } finally {
      running = false;
    }
  }

  function arm() {
    if (stopped) return;
    timer = deps.timers.setTimeout(async () => {
      try { await tick(); } catch (_err) { /* sanitized */ } finally { arm(); }
    }, deps.intervalMs);
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    arm();
  }

  function stop() {
    stopped = true;
    if (timer !== null) {
      deps.timers.clearTimeout(timer);
      timer = null;
    }
  }

  return Object.freeze({ tick, start, stop });
}

module.exports = Object.freeze({ createEmailImapSunsetStagingWorker });
