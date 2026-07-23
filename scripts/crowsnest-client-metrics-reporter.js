'use strict';

/**
 * Crowsnest client-metrics reporter ("the mailer") — Pupil slice 3.
 *
 * Runs on the TENANT side (this is the ONE component allowed to read the tenant
 * conversations/messages tables). It computes a per-client aggregate snapshot,
 * validates it against crowsnest.client_metrics.v1, and PUSHES it to the Crowsnest
 * ingest endpoint. Crowsnest itself never reads the tenant DB (Model A).
 *
 * Meant to run on a schedule (e.g. every few minutes) and to be baked into the
 * client template so every new client self-reports with zero Crowsnest-side wiring.
 *
 * Config (env):
 *   CROWSNEST_REPORTER_DATABASE_URL   read DSN for the tenant conversations/messages
 *   CROWSNEST_METRICS_INGEST_URL      e.g. https://crowsnest.lunafrontdesk.com/api/client-metrics
 *   CROWSNEST_METRICS_INGEST_TOKEN    bearer token (matches the endpoint's)
 *   CROWSNEST_REPORTER_CLIENT_SLUG    trusted client_slug this reporter pushes as
 *   CROWSNEST_REPORTER_TENANT_ID      trusted tenant_id this reporter pushes as
 *   CROWSNEST_REPORTER_CLIENT_ID      (optional) tenant UUID to filter rows by; omit for a per-tenant DB
 *   CROWSNEST_REPORTER_CLIENT_ID_COLUMN (optional) defaults to 'client_id'
 *   CROWSNEST_REPORTER_SOURCE_SERVICE (optional) defaults to 'staff-api'
 */

const crypto = require('crypto');
const { validateCrowsnestClientMetricsEvent } = require('./lib/crowsnest/crowsnest-client-metrics-contract');

const SCHEMA_VERSION = 'crowsnest.client_metrics.v1';
const SAFE_COLUMN_RE = /^[a-z_][a-z0-9_]{0,62}$/;

function toIsoZ(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString(); // 2026-07-23T03:38:00.000Z — valid per the contract
}

function nonNegInt(v) {
  const n = Math.trunc(Number(v) || 0);
  return n < 0 ? 0 : n;
}

/**
 * Build a validated crowsnest.client_metrics.v1 snapshot from a counts row.
 * Pure — no DB, no network. Throws if the produced event fails the contract.
 */
function buildSnapshot(counts, identity, opts = {}) {
  const messages7d = nonNegInt(counts.messages_7d);
  const event = {
    schema_version: SCHEMA_VERSION,
    snapshot_id: opts.snapshotId || `snap_${(identity.clientSlug || 'client')}_${Date.now()}`,
    captured_at: opts.capturedAt || toIsoZ(new Date()),
    client_slug: identity.clientSlug,
    tenant_id: identity.tenantId,
    source_service: identity.sourceService || 'staff-api',
    window: { kind: 'rolling_7d', days: 7 },
    metrics: {
      availability: 'measured',
      conversations_total: nonNegInt(counts.conversations_total),
      conversations_active: nonNegInt(counts.conversations_active),
      conversations_needing_human: nonNegInt(counts.conversations_needing_human),
      messages_last_24h: nonNegInt(counts.messages_last_24h),
      messages_per_day_avg: Math.round((messages7d / 7) * 10) / 10,
      last_activity_at: toIsoZ(counts.last_activity_at),
    },
  };
  const res = validateCrowsnestClientMetricsEvent(event);
  if (!res.ok) {
    const err = new Error(`reporter built an invalid snapshot: ${res.errors.join('; ')}`);
    err.code = 'reporter_invalid_snapshot';
    throw err;
  }
  return event;
}

// Single round-trip aggregate query. `clientId` null => aggregate the whole DB
// (per-tenant DB); otherwise filter by the tenant's id column.
function buildCountsQuery(clientIdColumn) {
  const col = clientIdColumn || 'client_id';
  if (!SAFE_COLUMN_RE.test(col)) throw new Error(`unsafe client id column: ${col}`);
  return `SELECT
      (SELECT COUNT(*) FROM conversations c WHERE ($1::uuid IS NULL OR c.${col} = $1))::int AS conversations_total,
      (SELECT COUNT(*) FROM conversations c WHERE c.status = 'open' AND ($1::uuid IS NULL OR c.${col} = $1))::int AS conversations_active,
      (SELECT COUNT(*) FROM conversations c WHERE c.needs_human = true AND ($1::uuid IS NULL OR c.${col} = $1))::int AS conversations_needing_human,
      (SELECT COUNT(*) FROM messages m WHERE m.created_at >= now() - interval '24 hours' AND ($1::uuid IS NULL OR m.${col} = $1))::int AS messages_last_24h,
      (SELECT COUNT(*) FROM messages m WHERE m.created_at >= now() - interval '7 days' AND ($1::uuid IS NULL OR m.${col} = $1))::int AS messages_7d,
      (SELECT MAX(c.updated_at) FROM conversations c WHERE ($1::uuid IS NULL OR c.${col} = $1)) AS last_activity_at`;
}

async function queryCounts(pool, { clientId = null, clientIdColumn = 'client_id' } = {}) {
  const r = await pool.query(buildCountsQuery(clientIdColumn), [clientId]);
  return r.rows[0] || {};
}

async function postSnapshot({ url, token, event, fetchImpl }) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('no fetch implementation available');
  const resp = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(event),
  });
  let body = null;
  try { body = await resp.json(); } catch { /* ignore */ }
  return { status: resp.status, body };
}

function readConfig(env = process.env) {
  const cfg = {
    databaseUrl: String(env.CROWSNEST_REPORTER_DATABASE_URL || '').trim(),
    ingestUrl: String(env.CROWSNEST_METRICS_INGEST_URL || '').trim(),
    ingestToken: String(env.CROWSNEST_METRICS_INGEST_TOKEN || '').trim(),
    clientSlug: String(env.CROWSNEST_REPORTER_CLIENT_SLUG || '').trim(),
    tenantId: String(env.CROWSNEST_REPORTER_TENANT_ID || '').trim(),
    clientId: String(env.CROWSNEST_REPORTER_CLIENT_ID || '').trim() || null,
    clientIdColumn: String(env.CROWSNEST_REPORTER_CLIENT_ID_COLUMN || 'client_id').trim(),
    sourceService: String(env.CROWSNEST_REPORTER_SOURCE_SERVICE || 'staff-api').trim(),
  };
  const missing = ['databaseUrl', 'ingestUrl', 'ingestToken', 'clientSlug', 'tenantId'].filter((k) => !cfg[k]);
  if (missing.length) {
    const err = new Error(`reporter misconfigured; missing: ${missing.join(', ')}`);
    err.code = 'reporter_misconfigured';
    throw err;
  }
  return cfg;
}

/**
 * Orchestrate one report cycle. `deps.pool` and `deps.fetchImpl` are injectable for tests.
 */
async function run(env = process.env, deps = {}) {
  const cfg = readConfig(env);
  let pool = deps.pool;
  let createdPool = false;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: cfg.databaseUrl, max: 2, allowExitOnIdle: true });
    createdPool = true;
  }
  try {
    const counts = await queryCounts(pool, { clientId: cfg.clientId, clientIdColumn: cfg.clientIdColumn });
    const event = buildSnapshot(counts, {
      clientSlug: cfg.clientSlug, tenantId: cfg.tenantId, sourceService: cfg.sourceService,
    }, { snapshotId: deps.snapshotId, capturedAt: deps.capturedAt });
    const res = await postSnapshot({ url: cfg.ingestUrl, token: cfg.ingestToken, event, fetchImpl: deps.fetchImpl });
    return { ok: res.status === 200, status: res.status, event, body: res.body };
  } finally {
    if (createdPool) await pool.end().catch(() => {});
  }
}

module.exports = {
  SCHEMA_VERSION,
  toIsoZ,
  buildSnapshot,
  buildCountsQuery,
  queryCounts,
  postSnapshot,
  readConfig,
  run,
};

if (require.main === module) {
  run(process.env)
    .then((r) => {
      console.log(`reporter: pushed ${r.event.client_slug} → HTTP ${r.status}`, r.ok ? 'OK' : `(${JSON.stringify(r.body)})`);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error('reporter failed:', err.code || '', err.message);
      process.exit(1);
    });
}
