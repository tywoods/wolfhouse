const path = require('path');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', 'infra', '.env') });

/**
 * Mark a borrowed PoolClient so withPgClient finally discards it via release(true).
 * Shared cross-module via Symbol.for — session advisory unlock failures set this
 * when unlock is false/unknown so a still-locked connection never returns to the pool.
 * Booking code must not call client.release itself (outer withPgClient owns that).
 */
const PG_CLIENT_DISCARD_REQUIRED = Symbol.for('wolfhouse.pgClient.discardRequired');

function markPgClientDiscardRequired(client) {
  if (client && typeof client === 'object') {
    client[PG_CLIENT_DISCARD_REQUIRED] = true;
  }
}

function isPgClientDiscardRequired(client) {
  return !!(client && typeof client === 'object' && client[PG_CLIENT_DISCARD_REQUIRED] === true);
}

/**
 * Session advisory locks are connection-scoped. Reject pg.Pool (or any
 * connect-capable facade without client.release) so lock/unlock cannot run on
 * different checked-out sessions via pool.query.
 */
function assertPinnedPgClientForSessionAdvisoryLock(pg) {
  if (!pg || typeof pg.query !== 'function') {
    const err = new Error('session_advisory_lock_requires_pinned_client');
    err.reason_code = 'session_advisory_lock_requires_pinned_client';
    throw err;
  }
  // Pool / pool-like: has connect() for checkout, no release() on the pool itself.
  if (typeof pg.connect === 'function' && typeof pg.release !== 'function') {
    const err = new Error('session_advisory_lock_rejects_pool');
    err.reason_code = 'session_advisory_lock_rejects_pool';
    throw err;
  }
}

/** @type {import('pg').Pool | null} */
let pool = null;

function getConnectionString() {
  return (
    process.env.WOLFHOUSE_DATABASE_URL ||
    `postgres://${process.env.WOLFHOUSE_DB_USER || 'wolfhouse'}:${process.env.WOLFHOUSE_DB_PASSWORD}@localhost:${process.env.WOLFHOUSE_DB_PORT || 5433}/${process.env.WOLFHOUSE_DB_NAME || 'wolfhouse'}`
  );
}

let keepAliveTimer = null;

/**
 * Keep at least one connection warm so the first page load after an idle gap
 * doesn't have to open a burst of fresh TLS connections at once (which left the
 * booking calendar's summary cards + grid blank on low-traffic staging — a
 * refresh "fixed" it because the pool was warm by then). A lightweight periodic
 * ping holds a connection open and clears any server-side idle drop.
 */
function startPoolKeepAlive(p) {
  if (keepAliveTimer) return;
  const everyMs = Number(process.env.PG_KEEPALIVE_MS || 60000);
  keepAliveTimer = setInterval(() => {
    p.query('SELECT 1').catch(() => { /* best-effort; pool self-heals broken conns */ });
  }, everyMs);
  // Never let this timer keep the process (scripts, tests) alive on its own.
  if (keepAliveTimer.unref) keepAliveTimer.unref();
  // Warm one connection immediately so the very first real request is fast.
  p.query('SELECT 1').catch(() => {});
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getConnectionString(),
      max: Number(process.env.PG_POOL_MAX || 8),
      connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10000),
      // Hold idle connections far longer than a browsing gap so the pool stays
      // warm between page loads (was 30s — too short for idle staging traffic).
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 600000),
      keepAlive: true,
    });
    startPoolKeepAlive(pool);
  }
  return pool;
}

async function withPgClient(fn) {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    // release(true) destroys the connection — required when session advisory
    // unlock failed or was uncertain so a locked backend is not reused.
    if (isPgClientDiscardRequired(client)) {
      client.release(true);
    } else {
      client.release();
    }
  }
}

/**
 * Close the shared pool and clear keep-alive. Safe when never opened or already closed.
 * Staff API must not call this — long-lived servers keep the pool warm.
 * One-shot CLIs (e.g. hold-expiry) should call this in finally so the process can exit.
 */
async function closePgPool() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  if (!pool) return;
  const ending = pool;
  pool = null;
  await ending.end();
}

/** Test seam: install a fake pool/timer without opening Postgres. */
function _setPoolForTests(nextPool, nextTimer = null) {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  pool = nextPool || null;
  keepAliveTimer = nextTimer || null;
}

function _getPoolForTests() {
  return pool;
}

module.exports = {
  getConnectionString,
  getPool,
  withPgClient,
  closePgPool,
  PG_CLIENT_DISCARD_REQUIRED,
  markPgClientDiscardRequired,
  isPgClientDiscardRequired,
  assertPinnedPgClientForSessionAdvisoryLock,
  _setPoolForTests,
  _getPoolForTests,
};
