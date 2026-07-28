'use strict';

/**
 * Crowsnest Spyglass AI-usage store (Model A: sources push crowsnest.ai_usage.v1
 * per-call receipts IN; the Spyglass panel reads an aggregate over a time window).
 *
 * Mirrors the crowsnest-client-metrics-store discipline:
 *   - Crowsnest owns this store; it NEVER reads tenant DBs or provider payloads.
 *   - Backend selection: memory (dev/tests), fail_closed (production until the
 *     Postgres reader slice lands). Fail-closed reads return null so the panel
 *     renders an honest "not reporting yet" instead of stale/fake numbers.
 *   - Every event is contract-validated (crowsnest.ai_usage.v1) before it is kept.
 *
 * Aggregation output matches the shape renderAiUsagePanel() consumes, with
 * `sample: false` so it can never be confused with the demo telemetry.
 *
 * Postgres backend (public.crowsnest_ai_usage_events, migration 050) is a later
 * slice: the ledger uses an injected db and out-of-band migration apply, so this
 * module intentionally does not open pools yet.
 */

const { validateCrowsnestAiUsageEvent } = require('./crowsnest-ai-usage-contract');

const DEFAULT_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// Crowsnest-owned store DSN (shared with client-metrics; the ai-usage ledger lives
// in public.crowsnest_ai_usage_events from migration 050). Never a tenant DB.
const DSN_ENV = 'CROWSNEST_METRICS_DATABASE_URL';
const AI_USAGE_TABLE = 'crowsnest_ai_usage_events';
const POOL_MAX = 4;
const POOL_IDLE_MS = 30000;
const POOL_CONNECT_MS = 5000;

const { recordCrowsnestAiUsageEvent } = require('./crowsnest-ai-usage-store');

function isProductionEnv(env = process.env) {
  return String(env.NODE_ENV || '').toLowerCase() === 'production';
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Backend selection:
 *  - DSN present               -> 'postgres'    (durable ledger; migration 050)
 *  - no DSN, non-production     -> 'memory'      (ephemeral; dev/tests)
 *  - no DSN, production         -> 'fail_closed' (reads return null => "not reporting yet")
 */
function resolveBackend(env = process.env) {
  if (String((env || process.env)[DSN_ENV] || '').trim()) return 'postgres';
  if (!isProductionEnv(env)) return 'memory';
  return 'fail_closed';
}

function costDollars(cost) {
  if (!cost) return 0;
  if (cost.state !== 'provider_reported' && cost.state !== 'estimated') return 0;
  const micros = Number(cost.amount_micros);
  return Number.isFinite(micros) ? micros / 1e6 : 0;
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Aggregate contract-valid events into the panel shape. Returns null when there
 * is nothing in the window so callers fail closed to "not reporting yet".
 * @param {object[]} events
 * @param {{ windowDays?: number, now?: number, nameFor?: (slug:string)=>string }} [opts]
 */
function aggregateAiUsage(events, opts = {}) {
  const windowDays = Number(opts.windowDays) > 0 ? Math.floor(opts.windowDays) : DEFAULT_WINDOW_DAYS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const nameFor = typeof opts.nameFor === 'function' ? opts.nameFor : (slug) => slug;
  const cutoff = now - windowDays * DAY_MS;

  const inWindow = (Array.isArray(events) ? events : []).filter((e) => {
    const t = Date.parse(e && e.occurred_at);
    return Number.isFinite(t) && t >= cutoff && t <= now;
  });
  if (inWindow.length === 0) return null;

  const totals = {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    avg_latency_ms: 0,
    success_rate: 0,
  };
  const providers = new Map();
  const clients = new Map();
  const dailyCounts = new Map();
  let latencySum = 0;
  let latencyN = 0;
  let succeeded = 0;

  for (const e of inWindow) {
    const tokens = e.tokens || {};
    const measured = tokens.availability === 'measured';
    const inTok = measured ? Number(tokens.input_tokens) || 0 : 0;
    const outTok = measured ? Number(tokens.output_tokens) || 0 : 0;
    const totTok = measured ? Number(tokens.total_tokens) || 0 : 0;
    const dollars = costDollars(e.cost);

    totals.requests += 1;
    totals.input_tokens += inTok;
    totals.output_tokens += outTok;
    totals.total_tokens += totTok;
    totals.cost_usd += dollars;
    if (e.status === 'succeeded') succeeded += 1;
    if (Number.isFinite(Number(e.latency_ms))) {
      latencySum += Number(e.latency_ms);
      latencyN += 1;
    }

    const prov = providers.get(e.provider) || { provider: e.provider, requests: 0, total_tokens: 0, cost_usd: 0 };
    prov.requests += 1;
    prov.total_tokens += totTok;
    prov.cost_usd += dollars;
    providers.set(e.provider, prov);

    const cli = clients.get(e.client_slug) || { id: e.client_slug, name: nameFor(e.client_slug), requests: 0, total_tokens: 0, cost_usd: 0 };
    cli.requests += 1;
    cli.total_tokens += totTok;
    cli.cost_usd += dollars;
    clients.set(e.client_slug, cli);

    const dk = dayKey(Date.parse(e.occurred_at));
    dailyCounts.set(dk, (dailyCounts.get(dk) || 0) + 1);
  }

  totals.avg_latency_ms = latencyN > 0 ? Math.round(latencySum / latencyN) : 0;
  totals.success_rate = totals.requests > 0 ? succeeded / totals.requests : 0;
  totals.cost_usd = Math.round(totals.cost_usd * 100) / 100;

  const by_provider = [...providers.values()]
    .map((p) => ({ ...p, cost_usd: Math.round(p.cost_usd * 100) / 100, share: totals.requests > 0 ? p.requests / totals.requests : 0 }))
    .sort((a, b) => b.requests - a.requests);
  const by_client = [...clients.values()]
    .map((c) => ({ ...c, cost_usd: Math.round(c.cost_usd * 100) / 100 }))
    .sort((a, b) => b.total_tokens - a.total_tokens);

  // Trailing `windowDays` daily request counts, oldest -> newest (for the sparkline).
  const daily_requests = [];
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    daily_requests.push(dailyCounts.get(dayKey(now - i * DAY_MS)) || 0);
  }

  return {
    sample: false,
    live: true,
    window_label: `Last ${windowDays} days`,
    totals,
    by_provider,
    by_client,
    daily_requests,
  };
}

function createMemoryRepository() {
  const events = [];
  return {
    backend: 'memory',
    async record(event) {
      const res = validateCrowsnestAiUsageEvent(event);
      if (!res.ok) return { ok: false, code: 'invalid_ai_usage_event', errors: res.errors };
      events.push(event);
      return { ok: true };
    },
    async aggregate(opts) {
      return aggregateAiUsage(events, opts);
    },
    async _reset() {
      events.length = 0;
    },
  };
}

function createFailClosedRepository() {
  return {
    backend: 'fail_closed',
    async record() {
      return { ok: false, status: 503, code: 'ai_usage_store_unavailable' };
    },
    async aggregate() {
      return null;
    },
  };
}

let aiUsagePool = null;
function getAiUsagePool(options = {}) {
  if (options.pool) return options.pool;
  if (aiUsagePool) return aiUsagePool;
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (err) {
    const wrapped = new Error('pg is required for the Crowsnest AI-usage store but is not installed');
    wrapped.cause = err;
    throw wrapped;
  }
  const databaseUrl = options.databaseUrl || String((options.env || process.env)[DSN_ENV] || '').trim();
  if (!databaseUrl) throw new Error(`${DSN_ENV} is required to open the AI-usage pool`);
  aiUsagePool = new Pool({
    connectionString: databaseUrl,
    max: Number(options.max || POOL_MAX),
    idleTimeoutMillis: Number(options.idleTimeoutMillis || POOL_IDLE_MS),
    connectionTimeoutMillis: Number(options.connectionTimeoutMillis || POOL_CONNECT_MS),
    allowExitOnIdle: true,
  });
  return aiUsagePool;
}

function closeAiUsageStore() {
  if (!aiUsagePool) return Promise.resolve();
  const p = aiUsagePool;
  aiUsagePool = null;
  return p.end();
}

const AGGREGATE_SELECT_SQL = `
  SELECT occurred_at, client_slug, provider, status, latency_ms,
         tokens_availability, input_tokens, output_tokens, total_tokens,
         cost_state, cost_amount_micros, cost_currency
    FROM ${AI_USAGE_TABLE}
   WHERE occurred_at >= $1
`;

// Rebuild the contract-nested shape aggregateAiUsage() expects from flat ledger columns.
function rowToEvent(r) {
  const occurred = r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at);
  const tokens = r.tokens_availability === 'measured'
    ? { availability: 'measured', input_tokens: toInt(r.input_tokens), output_tokens: toInt(r.output_tokens), total_tokens: toInt(r.total_tokens) }
    : { availability: 'unavailable' };
  const cost = (r.cost_state === 'provider_reported' || r.cost_state === 'estimated')
    ? { state: r.cost_state, amount_micros: toInt(r.cost_amount_micros), currency: r.cost_currency }
    : { state: r.cost_state || 'unavailable' };
  return { occurred_at: occurred, client_slug: r.client_slug, provider: r.provider, status: r.status, latency_ms: toInt(r.latency_ms), tokens, cost };
}

function createPostgresRepository(options = {}) {
  return {
    backend: 'postgres',
    async record(event) {
      try {
        const pool = getAiUsagePool(options);
        return await recordCrowsnestAiUsageEvent({ db: pool, event });
      } catch {
        // Missing table / connectivity / privilege: never throw into the ingest
        // handler (would 500). Fail closed with a safe 503.
        return { ok: false, status: 503, code: 'ai_usage_store_unavailable' };
      }
    },
    async aggregate(opts = {}) {
      try {
        const windowDays = Number(opts.windowDays) > 0 ? Math.floor(opts.windowDays) : DEFAULT_WINDOW_DAYS;
        const now = Number.isFinite(opts.now) ? opts.now : Date.now();
        const cutoff = new Date(now - windowDays * DAY_MS).toISOString();
        const pool = getAiUsagePool(options);
        const res = await pool.query(AGGREGATE_SELECT_SQL, [cutoff]);
        const rows = (res && Array.isArray(res.rows)) ? res.rows.map(rowToEvent) : [];
        return aggregateAiUsage(rows, { windowDays, now, nameFor: opts.nameFor });
      } catch {
        return null; // fail-closed => "not reporting yet"
      }
    },
  };
}

function createRepository(env = process.env) {
  const backend = resolveBackend(env);
  if (backend === 'postgres') return createPostgresRepository({ env });
  if (backend === 'memory') return createMemoryRepository();
  return createFailClosedRepository();
}

// Process-wide singleton so the HTTP server reuses one repository.
let singleton = null;
function getRepository(env = process.env) {
  if (!singleton) singleton = createRepository(env);
  return singleton;
}
function _resetRepositoryForTests() {
  singleton = null;
}

/**
 * Reader used by the Spyglass panel. Returns the aggregate object, or null on any
 * failure / empty window so the panel renders "not reporting yet". Never throws.
 */
async function getSpyglassAiUsage(opts = {}) {
  try {
    const env = opts.env || process.env;
    const repo = getRepository(env);
    return await repo.aggregate(opts);
  } catch {
    return null;
  }
}

/** Ingest one pushed receipt into the configured store. */
async function recordAiUsageEvent(event, env = process.env) {
  return getRepository(env).record(event);
}

module.exports = {
  DEFAULT_WINDOW_DAYS,
  DSN_ENV,
  isProductionEnv,
  resolveBackend,
  aggregateAiUsage,
  createMemoryRepository,
  createFailClosedRepository,
  createPostgresRepository,
  getAiUsagePool,
  closeAiUsageStore,
  createRepository,
  getRepository,
  getSpyglassAiUsage,
  recordAiUsageEvent,
  _resetRepositoryForTests,
};
