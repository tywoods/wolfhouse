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

function createRepository(env = process.env) {
  const backend = resolveBackend(env);
  if (backend === 'memory') return createMemoryRepository();
  // 'postgres' is reserved for the reporter slice; until then any DSN-configured
  // environment still fails closed for reads (empty) rather than touching an
  // unimplemented backend. Persistent storage arrives with the ingest endpoint.
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

module.exports = {
  DSN_ENV,
  SCHEMA,
  isProductionEnv,
  resolveBackend,
  createMemoryRepository,
  createFailClosedRepository,
  createRepository,
  getRepository,
  getSpyglassClientMetricsMap,
  _resetRepositoryForTests,
};
