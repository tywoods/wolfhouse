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
      // SELECT 1 contains none of these; belt-and-suspenders for mutations.
      return { ok: false, reason: 'sql_forbidden_marker' };
    }
  }
  return { ok: true };
}

/**
 * Bounded Postgres readiness via existing withPgClient(fn) seam (pool-backed).
 * Never throws; never returns error details.
 *
 * @param {((fn: (client: { query: Function }) => Promise<unknown>) => Promise<unknown>) | null | undefined} withPgClient
 * @param {{ timeoutMs?: number, sql?: string }} [opts]
 * @returns {Promise<{ ok: boolean }>}
 */
async function checkPostgresReadiness(withPgClient, opts = {}) {
  if (typeof withPgClient !== 'function') {
    return { ok: false };
  }

  const sql = opts.sql != null ? opts.sql : READINESS_SQL;
  const sqlGate = assertReadOnlyReadinessSql(sql);
  if (!sqlGate.ok) {
    return { ok: false };
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : READINESS_TIMEOUT_MS;

  let timer = null;
  try {
    const timed = Promise.race([
      withPgClient(async (client) => {
        if (!client || typeof client.query !== 'function') {
          throw new Error('missing_client');
        }
        await client.query(sql);
        return true;
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    await timed;
    return { ok: true };
  } catch (_) {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * HTTP handler for GET /readyz.
 * @param {import('http').ServerResponse} res
 * @param {(res: import('http').ServerResponse, status: number, body: object) => void} sendJSON
 * @param {Function} withPgClient
 */
async function handleStaffApiReadyz(res, sendJSON, withPgClient) {
  const result = await checkPostgresReadiness(withPgClient);
  if (result.ok) {
    return sendJSON(res, 200, READY_BODY);
  }
  return sendJSON(res, 503, NOT_READY_BODY);
}

/**
 * Minimal HTTP listener for offline GREEN tests (does not load staff-query-api).
 * @param {{ withPgClient: Function, sendJSON?: Function }} deps
 * @returns {import('http').Server}
 */
function createReadyzTestListener(deps) {
  const http = require('http');
  const sendJSON = deps.sendJSON || ((res, statusCode, body) => {
    const data = JSON.stringify(body);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === READYZ_PATH) {
        return handleStaffApiReadyz(res, sendJSON, deps.withPgClient);
      }
      if (url.pathname === HEALTHZ_PATH) {
        return sendJSON(res, 200, { status: 'ok' });
      }
      res.writeHead(404);
      res.end();
    } catch (_) {
      return sendJSON(res, 503, NOT_READY_BODY);
    }
  });
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
  checkPostgresReadiness,
  handleStaffApiReadyz,
  createReadyzTestListener,
};
