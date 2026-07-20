'use strict';

/**
 * Staff API readiness (RADAR 16C) — dependency-aware /readyz.
 *
 * Contract:
 * - /healthz remains static liveness (process up); must NOT touch Postgres.
 * - /readyz uses a dedicated max-1 readiness Pool (pg 8.21 public API only):
 *   connectionTimeoutMillis + query_timeout + statement_timeout bound acquire/SELECT.
 * - On query timeout/error, destroy via client.release(err) exactly once.
 * - Never touches the application pool; repeated probes cannot exhaust it.
 * - Responses are generic: 200 { status: "ready" } or 503 { status: "not-ready" }.
 * - Never expose credentials, SQL text, stack traces, or upstream error messages.
 * - Readiness SQL is fixed SELECT 1 — no DML/DDL.
 */

const { Pool } = require('pg');
const { getConnectionString } = require('./pg-connect');

const READYZ_PATH = '/readyz';
const HEALTHZ_PATH = '/healthz';

/** Fixed read-only probe SQL — must remain exactly this string. */
const READINESS_SQL = 'SELECT 1';

/** Bound how long /readyz waits on Postgres before failing closed. */
const READINESS_TIMEOUT_MS = 2500;

/** Bound how long readiness pool.end may block during shutdown. */
const READINESS_POOL_CLOSE_TIMEOUT_MS = 2000;

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

/** @type {import('pg').Pool | null} */
let readinessPool = null;
let readinessPoolClosed = false;

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
 * Public pg Pool options for the dedicated readiness pool.
 * @param {number} timeoutMs
 * @param {object} [extra]
 */
function readinessPoolOptions(timeoutMs, extra = {}) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : READINESS_TIMEOUT_MS;
  return {
    max: 1,
    connectionTimeoutMillis: ms,
    query_timeout: ms,
    statement_timeout: ms,
    idleTimeoutMillis: Math.max(ms * 2, 5000),
    allowExitOnIdle: true,
    keepAlive: true,
    ...extra,
  };
}

/**
 * Create a dedicated max-1 readiness pool (pg public constructor options only).
 * @param {object} [opts]
 * @returns {import('pg').Pool}
 */
function createReadinessPool(opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : READINESS_TIMEOUT_MS;
  const {
    timeoutMs: _ignored,
    connectionString,
    ...rest
  } = opts;
  return new Pool(readinessPoolOptions(timeoutMs, {
    connectionString: connectionString || getConnectionString(),
    ...rest,
  }));
}

/**
 * Lazy singleton readiness pool for production Staff API.
 * @returns {import('pg').Pool | null}
 */
function getReadinessPool() {
  if (readinessPoolClosed) return null;
  if (!readinessPool) {
    readinessPool = createReadinessPool();
  }
  return readinessPool;
}

/**
 * Bound pool.end — never wait forever (shutdown path).
 * @param {{ end: Function } | null | undefined} pool
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function endPoolBounded(pool, timeoutMs) {
  if (!pool || typeof pool.end !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const result = pool.end(done);
      if (result && typeof result.then === 'function') {
        result.then(done, done);
      }
    } catch (_) {
      done();
      return;
    }
    const ms = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : READINESS_POOL_CLOSE_TIMEOUT_MS;
    if (ms > 0) {
      const timer = setTimeout(done, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
  });
}

/**
 * Close the readiness pool exactly once (bounded).
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<void>}
 */
async function closeReadinessPool(opts = {}) {
  if (readinessPoolClosed) return;
  readinessPoolClosed = true;
  const ending = readinessPool;
  readinessPool = null;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0
    ? opts.timeoutMs
    : READINESS_POOL_CLOSE_TIMEOUT_MS;
  await endPoolBounded(ending, timeoutMs);
}

/** Test seam: install a fake readiness pool without opening Postgres. */
function _setReadinessPoolForTests(nextPool) {
  readinessPool = nextPool || null;
  readinessPoolClosed = false;
}

function _getReadinessPoolForTests() {
  return readinessPool;
}

function _resetReadinessPoolStateForTests() {
  readinessPool = null;
  readinessPoolClosed = false;
}

/**
 * Release a checked-out client at most once. Passing an Error removes it
 * from the pool (pg-pool public release(err) destroy path).
 * @param {{ release?: Function } | null | undefined} client
 * @param {Error | undefined} err
 */
function releaseClientOnce(client, err) {
  if (!client || typeof client.release !== 'function') return;
  if (client.__staffApiReadinessReleased) return;
  client.__staffApiReadinessReleased = true;
  try {
    client.release(err);
  } catch (_) { /* ignore double-release races */ }
}

/**
 * Bounded Postgres readiness via dedicated max-1 pool (public pg 8.21 only).
 * Never throws; never returns error details.
 *
 * @param {unknown} [_withPgClient] unused — production path is the readiness pool
 * @param {{
 *   timeoutMs?: number,
 *   sql?: string,
 *   pool?: { connect: Function },
 *   getPool?: () => { connect: Function } | null | undefined,
 * }} [opts]
 * @returns {Promise<{ ok: boolean }>}
 */
async function checkPostgresReadiness(_withPgClient, opts = {}) {
  const sql = opts.sql != null ? opts.sql : READINESS_SQL;
  const sqlGate = assertReadOnlyReadinessSql(sql);
  if (!sqlGate.ok) {
    return { ok: false };
  }

  const pool = opts.pool
    || (typeof opts.getPool === 'function' ? opts.getPool() : null)
    || getReadinessPool();

  if (!pool || typeof pool.connect !== 'function') {
    return { ok: false };
  }

  let client = null;
  try {
    client = await pool.connect();
    await client.query(sql);
    releaseClientOnce(client);
    return { ok: true };
  } catch (err) {
    const destroyErr = err instanceof Error ? err : new Error(String(err || 'readiness_failed'));
    releaseClientOnce(client, destroyErr);
    return { ok: false };
  }
}

/**
 * HTTP handler for GET /readyz.
 * @param {import('http').ServerResponse} res
 * @param {(res: import('http').ServerResponse, status: number, body: object) => void} sendJSON
 * @param {unknown} [_withPgClient]
 * @param {{ getPool?: Function, pool?: object }} [opts]
 */
async function handleStaffApiReadyz(res, sendJSON, _withPgClient, opts = {}) {
  const result = await checkPostgresReadiness(null, opts);
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
  READINESS_POOL_CLOSE_TIMEOUT_MS,
  READY_BODY,
  NOT_READY_BODY,
  FORBIDDEN_SQL_MARKERS,
  assertReadOnlyReadinessSql,
  readinessPoolOptions,
  createReadinessPool,
  getReadinessPool,
  closeReadinessPool,
  endPoolBounded,
  releaseClientOnce,
  checkPostgresReadiness,
  handleStaffApiReadyz,
  _setReadinessPoolForTests,
  _getReadinessPoolForTests,
  _resetReadinessPoolStateForTests,
};
