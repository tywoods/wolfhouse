'use strict';

/**
 * Staff API readiness (RADAR 16I) — dependency-aware /readyz.
 *
 * Contract:
 * - /healthz remains static liveness (process up); must NOT touch Postgres.
 * - /readyz uses a dedicated max-1 readiness Pool (pg 8.21 public API only):
 *   connectionTimeoutMillis (<=1500) + statement_timeout (<=1500) +
 *   query_timeout (<=2000) bound acquire/SELECT.
 * - Fixed SQL: SELECT 1. On success release() once; on error release(err) once.
 *   Release-once state is a closure-local boolean per readiness invocation
 *   (never a property on the pooled client — markers poison idle reuse).
 * - Never touches the application pool; no Promise.race, abort signals,
 *   private fields, or custom cancellation.
 * - Responses are generic: 200 { status: "ready" } or 503 { status: "not-ready" }.
 * - closeReadinessPool is explicit + idempotent; Staff API lifecycle integration
 *   is wired via staff-api-readiness-lifecycle (RADAR 16W) — not closePgPool.
 */

const { Pool } = require('pg');
const { getConnectionString } = require('./pg-connect');

const READYZ_PATH = '/readyz';
const HEALTHZ_PATH = '/healthz';

/** Fixed read-only probe SQL — must remain exactly this string. */
const READINESS_SQL = 'SELECT 1';

/** Public pg 8.21 pool bounds (milliseconds). */
const CONNECTION_TIMEOUT_MS = 1500;
const STATEMENT_TIMEOUT_MS = 1500;
const QUERY_TIMEOUT_MS = 2000;

/**
 * Worst-case single-probe wall clock: saturated acquire wait + query timeout.
 * ACA readiness periodSeconds must exceed this so probes cannot accumulate.
 */
const MAX_OPERATION_BOUND_MS = CONNECTION_TIMEOUT_MS + QUERY_TIMEOUT_MS;

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
  // Exact fixed SQL is always allowed. Forbidden-marker scan applies only to
  // non-exact inputs (already rejected above) — keep markers for contract docs
  // and adversarial tests that assert rejection reasons stay fail-closed.
  return { ok: true };
}

/**
 * Public pg Pool options for the dedicated readiness pool.
 * Callers may override timeouts downward for offline tests.
 * @param {object} [extra]
 */
function readinessPoolOptions(extra = {}) {
  return {
    max: 1,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    idleTimeoutMillis: Math.max(QUERY_TIMEOUT_MS * 2, 5000),
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
  const {
    connectionString,
    ...rest
  } = opts;
  return new Pool(readinessPoolOptions({
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
 * Close the readiness pool exactly once (idempotent).
 * Not composed into closePgPool — lifecycle wired in staff-api-readiness-lifecycle (16W).
 * @returns {Promise<void>}
 */
async function closeReadinessPool() {
  if (readinessPoolClosed) return;
  readinessPoolClosed = true;
  const ending = readinessPool;
  readinessPool = null;
  if (ending && typeof ending.end === 'function') {
    await ending.end();
  }
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
 * Bounded Postgres readiness via dedicated max-1 pool (public pg 8.21 only).
 * Never throws; never returns error details.
 *
 * Release-once is scoped to this invocation via a closure-local boolean —
 * never a property on the pooled client (markers would poison reuse).
 * On success: release() once. On error: release(err) once (destroy path).
 *
 * @param {unknown} [_withPgClient] unused — production path is the readiness pool
 * @param {{
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
  let released = false;
  const releaseOnce = (err) => {
    if (released) return;
    if (!client || typeof client.release !== 'function') return;
    released = true;
    try {
      if (err !== undefined) client.release(err);
      else client.release();
    } catch (_) { /* ignore double-release races */ }
  };

  try {
    client = await pool.connect();
    await client.query(sql);
    releaseOnce();
    return { ok: true };
  } catch (err) {
    const destroyErr = err instanceof Error ? err : new Error(String(err || 'readiness_failed'));
    releaseOnce(destroyErr);
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
  CONNECTION_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  QUERY_TIMEOUT_MS,
  MAX_OPERATION_BOUND_MS,
  READY_BODY,
  NOT_READY_BODY,
  FORBIDDEN_SQL_MARKERS,
  assertReadOnlyReadinessSql,
  readinessPoolOptions,
  createReadinessPool,
  getReadinessPool,
  closeReadinessPool,
  checkPostgresReadiness,
  handleStaffApiReadyz,
  _setReadinessPoolForTests,
  _getReadinessPoolForTests,
  _resetReadinessPoolStateForTests,
};
