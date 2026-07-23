'use strict';

/**
 * Crowsnest client-metrics store (Model A: clients push crowsnest.client_metrics.v1
 * snapshots IN; Spyglass reads the latest snapshot per client).
 *
 * Crowsnest owns this store — it NEVER reads WOLFHOUSE_DATABASE_URL or the tenant
 * conversations/messages tables directly. Mirrors the crowsnest-sales-store discipline:
 * dedicated DSN env, repository adapters, fail-closed in production without a DSN.
 *
 * SLICE SCOPE (this file): the store scaffolding + reader with `memory` and
 * `fail_closed` backends only. Reads always degrade to "empty" so the Spyglass page
 * shows an honest "not reporting yet" instead of erroring. The persistent Postgres
 * backend (keyed off CROWSNEST_METRICS_DATABASE_URL) and the ingest endpoint that lets
 * clients push snapshots land with the reporter/mailer slice.
 */

const { validateCrowsnestClientMetricsEvent } = require('./crowsnest-client-metrics-contract');

const DSN_ENV = 'CROWSNEST_METRICS_DATABASE_URL'; // reserved: activates the Postgres backend (next slice)
const SCHEMA = 'crowsnest_metrics';

function isProductionEnv(env = process.env) {
  return String(env.NODE_ENV || '').toLowerCase() === 'production';
}

/**
 * Backend selection:
 *  - a DSN is present            -> 'postgres'    (persistent; wired in the reporter slice)
 *  - no DSN, non-production      -> 'memory'      (ephemeral; dev/tests)
 *  - no DSN, production          -> 'fail_closed' (reads return empty => "not reporting yet")
 */
function resolveBackend(env = process.env) {
  if (env[DSN_ENV]) return 'postgres';
  if (!isProductionEnv(env)) return 'memory';
  return 'fail_closed';
}

// Latest-wins by captured_at (ISO-8601 UTC Z strings sort lexicographically by instant).
function isNewer(candidate, current) {
  return !current || String(candidate.captured_at) >= String(current.captured_at);
}

function createMemoryRepository() {
  const latest = new Map(); // client_slug -> validated event
  return {
    backend: 'memory',
    async putSnapshot(event) {
      const res = validateCrowsnestClientMetricsEvent(event);
      if (!res.ok) return { ok: false, code: 'invalid_client_metrics_event', errors: res.errors };
      if (isNewer(event, latest.get(event.client_slug))) latest.set(event.client_slug, event);
      return { ok: true };
    },
    async getLatest(clientSlug) {
      return latest.get(clientSlug) || null;
    },
    async getAllLatest() {
      return [...latest.values()];
    },
    async _reset() {
      latest.clear();
    },
  };
}

function createFailClosedRepository() {
  return {
    backend: 'fail_closed',
    async putSnapshot() {
      return {
        ok: false,
        status: 503,
        code: 'client_metrics_store_misconfigured',
        error: `Client metrics store is not configured. Set ${DSN_ENV} to enable it.`,
      };
    },
    // Reads degrade to empty on purpose: the Spyglass overview should render an honest
    // "not reporting yet", never a 503, when no store is configured.
    async getLatest() {
      return null;
    },
    async getAllLatest() {
      return [];
    },
  };
}

// ── Postgres backend ────────────────────────────────────────────────────────
// One row per client (latest-wins upsert). Crowsnest owns this schema; it holds
// only aggregate crowsnest.client_metrics.v1 snapshots pushed in by clients.

const POOL_MAX = 4;
const POOL_IDLE_MS = 30_000;
const POOL_CONNECT_MS = 10_000;
let metricsPool = null;

function getMetricsPool(options = {}) {
  if (options.pool) return options.pool;
  if (metricsPool) return metricsPool;
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (err) {
    const wrapped = new Error('pg is required for the Crowsnest client-metrics store but is not installed');
    wrapped.cause = err;
    throw wrapped;
  }
  const databaseUrl = options.databaseUrl || String((options.env || process.env)[DSN_ENV] || '').trim();
  if (!databaseUrl) throw new Error(`${DSN_ENV} is required to open the client-metrics pool`);
  metricsPool = new Pool({
    connectionString: databaseUrl,
    max: Number(options.max || POOL_MAX),
    idleTimeoutMillis: Number(options.idleTimeoutMillis || POOL_IDLE_MS),
    connectionTimeoutMillis: Number(options.connectionTimeoutMillis || POOL_CONNECT_MS),
    allowExitOnIdle: true,
  });
  return metricsPool;
}

async function closeMetricsStore() {
  if (!metricsPool) return;
  const ending = metricsPool;
  metricsPool = null;
  await ending.end();
}

function createPostgresRepository(options = {}) {
  // SCHEMA is a hardcoded safe identifier (never user input) — safe to interpolate.
  const TABLE = `${SCHEMA}.client_metrics_snapshots`;
  let ensured = false;
  async function ensure(pool) {
    if (ensured) return;
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      client_slug TEXT PRIMARY KEY,
      captured_at TIMESTAMPTZ NOT NULL,
      event       JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    ensured = true;
  }
  return {
    backend: 'postgres',
    async putSnapshot(event) {
      const res = validateCrowsnestClientMetricsEvent(event);
      if (!res.ok) return { ok: false, code: 'invalid_client_metrics_event', errors: res.errors };
      const pool = getMetricsPool(options);
      await ensure(pool);
      await pool.query(
        `INSERT INTO ${TABLE} (client_slug, captured_at, event)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (client_slug) DO UPDATE
           SET captured_at = EXCLUDED.captured_at, event = EXCLUDED.event, updated_at = now()
           WHERE EXCLUDED.captured_at >= ${TABLE}.captured_at`,
        [event.client_slug, event.captured_at, JSON.stringify(event)],
      );
      return { ok: true };
    },
    async getLatest(clientSlug) {
      const pool = getMetricsPool(options);
      await ensure(pool);
      const r = await pool.query(`SELECT event FROM ${TABLE} WHERE client_slug = $1`, [clientSlug]);
      return r.rows[0] ? r.rows[0].event : null;
    },
    async getAllLatest() {
      const pool = getMetricsPool(options);
      await ensure(pool);
      const r = await pool.query(`SELECT event FROM ${TABLE}`);
      return r.rows.map((row) => row.event);
    },
  };
}

function createRepository(env = process.env) {
  const backend = resolveBackend(env);
  if (backend === 'memory') return createMemoryRepository();
  if (backend === 'postgres') return createPostgresRepository({ env });
  return createFailClosedRepository();
}

// Process-wide singleton so the HTTP server reuses one repository/pool.
let singleton = null;
function getRepository(env = process.env) {
  if (!singleton) singleton = createRepository(env);
  return singleton;
}
function _resetRepositoryForTests() {
  singleton = null;
}

/**
 * Reader used by the Spyglass page. Returns a map of client_slug -> latest snapshot
 * event, and NEVER throws — any failure degrades to an empty map so the overview
 * renders "not reporting yet".
 */
async function getSpyglassClientMetricsMap(env = process.env) {
  try {
    const repo = getRepository(env);
    const list = await repo.getAllLatest();
    const map = {};
    for (const ev of Array.isArray(list) ? list : []) {
      if (ev && ev.client_slug) map[ev.client_slug] = ev;
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * Ingest one pushed snapshot into the configured store. Returns the repository's
 * result: { ok: true } on success, or { ok: false, code, errors?/status } on a
 * contract-invalid event or a fail-closed (misconfigured) store. Used by the
 * authenticated ingest endpoint.
 */
async function putClientMetricsSnapshot(event, env = process.env) {
  const repo = getRepository(env);
  return repo.putSnapshot(event);
}

module.exports = {
  DSN_ENV,
  SCHEMA,
  isProductionEnv,
  resolveBackend,
  createMemoryRepository,
  createFailClosedRepository,
  createPostgresRepository,
  getMetricsPool,
  closeMetricsStore,
  createRepository,
  getRepository,
  getSpyglassClientMetricsMap,
  putClientMetricsSnapshot,
  _resetRepositoryForTests,
};
