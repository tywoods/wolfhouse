'use strict';

/**
 * Crowsnest Luna Sales durable store (Chapter 1 / Slice 1).
 *
 * Owns config validation, repository adapters (memory / postgres / fail-closed),
 * and a bounded pg pool lifecycle. Never reads WOLFHOUSE_DATABASE_URL.
 *
 * Production without CROWSNEST_SALES_DATABASE_URL fails closed for mutations.
 * Non-production / test may fall back to an explicit in-memory repository.
 */

const crypto = require('crypto');

const SALES_DSN_ENV = 'CROWSNEST_SALES_DATABASE_URL';
const SALES_SCHEMA = 'luna_sales';
const POOL_MAX = 4;
const POOL_IDLE_MS = 30_000;
const POOL_CONNECT_MS = 10_000;

/** @type {import('pg').Pool | null} */
let salesPool = null;

function isProductionEnv(env = process.env) {
  return String(env.NODE_ENV || '').toLowerCase() === 'production';
}

function misconfiguredResult(message) {
  return {
    ok: false,
    status: 503,
    code: 'sales_store_misconfigured',
    error: message || 'Crowsnest Sales durable store is not configured.',
  };
}

const SALES_UNAVAILABLE_MESSAGE = 'Crowsnest Sales store is temporarily unavailable. Please retry.';

function salesUnavailableResult() {
  return {
    ok: false,
    status: 503,
    code: 'sales_unavailable',
    error: SALES_UNAVAILABLE_MESSAGE,
    retryable: true,
  };
}

class SalesStoreUnavailableError extends Error {
  constructor(message = SALES_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = 'SalesStoreUnavailableError';
    this.code = 'sales_unavailable';
    this.status = 503;
    this.retryable = true;
  }
}

function isSalesStoreUnavailableError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err instanceof SalesStoreUnavailableError) return true;
  return err.name === 'SalesStoreUnavailableError'
    || err.code === 'sales_unavailable'
    || (err.status === 503 && err.retryable === true && err.code === 'sales_unavailable');
}

function isSalesUnavailableResult(result) {
  return Boolean(
    result
      && result.ok === false
      && result.status === 503
      && result.code === 'sales_unavailable'
      && result.retryable === true,
  );
}

/**
 * Resolve which Sales persistence backend to use.
 * Never consults WOLFHOUSE_DATABASE_URL or DATABASE_URL.
 */
function resolveSalesStoreConfig(env = process.env) {
  const dsn = String(env[SALES_DSN_ENV] || '').trim();
  if (dsn) {
    return {
      ok: true,
      backend: 'postgres',
      databaseUrl: dsn,
      dsnEnv: SALES_DSN_ENV,
      schema: SALES_SCHEMA,
    };
  }
  if (isProductionEnv(env)) {
    return {
      ok: false,
      backend: 'fail_closed',
      code: 'sales_store_misconfigured',
      error: `${SALES_DSN_ENV} is required in production for Sales mutations.`,
      schema: SALES_SCHEMA,
    };
  }
  return {
    ok: true,
    backend: 'memory',
    reason: 'non_production_memory_fallback',
    schema: SALES_SCHEMA,
  };
}

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function createMemorySalesRepository() {
  const prospects = new Map();
  const researchByProspect = new Map();
  const auditEvents = [];

  return {
    backend: 'memory',
    async createProspectRecord(prospect) {
      const row = cloneJson(prospect);
      prospects.set(String(row.id), row);
      return { ok: true, prospect: cloneJson(row) };
    },
    async saveResearchJob(research) {
      const row = cloneJson(research);
      researchByProspect.set(String(row.prospect_id), row);
      return { ok: true, research: cloneJson(row) };
    },
    async appendAuditEvent(event) {
      const row = cloneJson(event);
      auditEvents.push(row);
      return { ok: true, event: cloneJson(row) };
    },
    async updateProspectDecision(id, patch) {
      const existing = prospects.get(String(id || ''));
      if (!existing) {
        return { ok: false, error: 'Prospect not found.', status: 404 };
      }
      const next = {
        ...existing,
        lifecycle_status: patch.lifecycle_status,
        updated_at: patch.updated_at,
        last_decision: cloneJson(patch.last_decision),
      };
      prospects.set(String(id), next);
      return { ok: true, prospect: cloneJson(next) };
    },
    async getProspect(id) {
      const row = prospects.get(String(id || ''));
      return row ? cloneJson(row) : null;
    },
    async listProspects() {
      return Array.from(prospects.values())
        .map((row) => cloneJson(row))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    },
    async getResearchForProspect(id) {
      const row = researchByProspect.get(String(id || ''));
      return row ? cloneJson(row) : null;
    },
    async listAuditEvents(prospectId) {
      const events = auditEvents.map((row) => cloneJson(row));
      if (!prospectId) return events;
      const pid = String(prospectId);
      return events.filter((event) => {
        if (event.entity_id === pid) return true;
        if (event.detail && event.detail.prospect_id === pid) return true;
        return false;
      });
    },
    async reset() {
      prospects.clear();
      researchByProspect.clear();
      auditEvents.length = 0;
    },
  };
}

function createFailClosedSalesRepository(config = {}) {
  const message = config.error
    || `${SALES_DSN_ENV} is required in production for Sales mutations.`;
  const reject = async () => misconfiguredResult(message);
  return {
    backend: 'fail_closed',
    createProspectRecord: reject,
    saveResearchJob: reject,
    appendAuditEvent: reject,
    updateProspectDecision: reject,
    async getProspect() {
      return null;
    },
    async listProspects() {
      return [];
    },
    async getResearchForProspect() {
      return null;
    },
    async listAuditEvents() {
      return [];
    },
    async reset() {},
  };
}

function mapProspectRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    canonical_name: row.canonical_name || '',
    website_url: row.website_url || '',
    lifecycle_status: row.lifecycle_status,
    owner_id: row.owner_id || 'Admin',
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    last_decision: row.last_decision == null ? null : cloneJson(row.last_decision),
  };
}

function mapResearchRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    prospect_id: String(row.prospect_id),
    source: row.source,
    status: row.status,
    job_label: row.job_label || '',
    summary: row.summary || '',
    facts: cloneJson(row.facts || []),
    limitations: cloneJson(row.limitations || []),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function mapAuditRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
    actor: row.actor,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: String(row.entity_id),
    detail: cloneJson(row.detail || {}),
  };
}

/**
 * Postgres repository. Inject `query(sql, params)` for tests; otherwise uses
 * the bounded Crowsnest Sales pool opened from CROWSNEST_SALES_DATABASE_URL.
 * Inject `runTransaction(fn)` for offline atomic-create tests.
 */
function createPgSalesRepository(options = {}) {
  const queryFn = options.query
    || (async (sql, params) => {
      const pool = getSalesPool(options);
      return pool.query(sql, params);
    });

  const runTransaction = options.runTransaction
    || (async (fn) => {
      const pool = getSalesPool(options);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await fn((sql, params) => client.query(sql, params));
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback failure; original error is authoritative
        }
        throw err;
      } finally {
        client.release();
      }
    });

  async function insertProspect(txQuery, prospect) {
    await txQuery(
      `INSERT INTO luna_sales.prospects (
          id, canonical_name, website_url, lifecycle_status, owner_id,
          last_decision, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz)`,
      [
        prospect.id,
        prospect.canonical_name || '',
        prospect.website_url || '',
        prospect.lifecycle_status,
        prospect.owner_id || 'Admin',
        JSON.stringify(prospect.last_decision),
        prospect.created_at,
        prospect.updated_at,
      ],
    );
  }

  async function insertResearch(txQuery, research) {
    await txQuery(
      `INSERT INTO luna_sales.research_jobs (
          id, prospect_id, source, status, job_label, summary, facts, limitations, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::timestamptz)`,
      [
        research.id,
        research.prospect_id,
        research.source,
        research.status,
        research.job_label || '',
        research.summary || '',
        JSON.stringify(research.facts || []),
        JSON.stringify(research.limitations || []),
        research.created_at,
      ],
    );
  }

  async function insertAudit(txQuery, event) {
    await txQuery(
      `INSERT INTO luna_sales.audit_events (
          id, at, actor, action, entity_type, entity_id, detail
        ) VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7::jsonb)`,
      [
        event.id,
        event.at,
        event.actor,
        event.action,
        event.entity_type,
        event.entity_id,
        JSON.stringify(event.detail || {}),
      ],
    );
  }

  return {
    backend: 'postgres',
    async createProspectBundle({ prospect, research, auditEvents = [] } = {}) {
      try {
        await runTransaction(async (txQuery) => {
          await insertProspect(txQuery, prospect);
          await insertResearch(txQuery, research);
          for (const event of auditEvents) {
            await insertAudit(txQuery, event);
          }
        });
        return { ok: true, prospect: cloneJson(prospect), research: cloneJson(research) };
      } catch {
        return salesUnavailableResult();
      }
    },
    async createProspectRecord(prospect) {
      try {
        await insertProspect(queryFn, prospect);
        return { ok: true, prospect: cloneJson(prospect) };
      } catch {
        return salesUnavailableResult();
      }
    },
    async saveResearchJob(research) {
      try {
        await insertResearch(queryFn, research);
        return { ok: true, research: cloneJson(research) };
      } catch {
        return salesUnavailableResult();
      }
    },
    async appendAuditEvent(event) {
      try {
        await insertAudit(queryFn, event);
        return { ok: true, event: cloneJson(event) };
      } catch {
        return salesUnavailableResult();
      }
    },
    async updateProspectDecision(id, patch) {
      try {
        const result = await queryFn(
          `UPDATE luna_sales.prospects
           SET lifecycle_status = $2,
               last_decision = $3::jsonb,
               updated_at = $4::timestamptz
           WHERE id = $1
           RETURNING id, canonical_name, website_url, lifecycle_status, owner_id,
                     last_decision, created_at, updated_at`,
          [
            id,
            patch.lifecycle_status,
            JSON.stringify(patch.last_decision),
            patch.updated_at,
          ],
        );
        const row = result.rows && result.rows[0];
        if (!row) {
          return { ok: false, error: 'Prospect not found.', status: 404 };
        }
        return { ok: true, prospect: mapProspectRow(row) };
      } catch {
        return salesUnavailableResult();
      }
    },
    async getProspect(id) {
      try {
        const result = await queryFn(
          `SELECT id, canonical_name, website_url, lifecycle_status, owner_id,
                  last_decision, created_at, updated_at
           FROM luna_sales.prospects
           WHERE id = $1`,
          [id],
        );
        return mapProspectRow(result.rows && result.rows[0]);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async listProspects() {
      try {
        const result = await queryFn(
          `SELECT id, canonical_name, website_url, lifecycle_status, owner_id,
                  last_decision, created_at, updated_at
           FROM luna_sales.prospects
           ORDER BY created_at DESC`,
        );
        return (result.rows || []).map(mapProspectRow);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async getResearchForProspect(id) {
      try {
        const result = await queryFn(
          `SELECT id, prospect_id, source, status, job_label, summary, facts, limitations, created_at
           FROM luna_sales.research_jobs
           WHERE prospect_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [id],
        );
        return mapResearchRow(result.rows && result.rows[0]);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async listAuditEvents(prospectId) {
      try {
        if (!prospectId) {
          const result = await queryFn(
            `SELECT id, at, actor, action, entity_type, entity_id, detail
             FROM luna_sales.audit_events
             ORDER BY at ASC`,
          );
          return (result.rows || []).map(mapAuditRow);
        }
        const result = await queryFn(
          `SELECT id, at, actor, action, entity_type, entity_id, detail
           FROM luna_sales.audit_events
           WHERE entity_id = $1 OR detail->>'prospect_id' = $1
           ORDER BY at ASC`,
          [String(prospectId)],
        );
        return (result.rows || []).map(mapAuditRow);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async reset() {
      throw new Error('reset is not supported on postgres Sales repository');
    },
  };
}

function getSalesPool(options = {}) {
  if (options.pool) return options.pool;
  if (salesPool) return salesPool;
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (err) {
    const wrapped = new Error(
      'pg is required for Crowsnest Sales durable store but is not installed',
    );
    wrapped.cause = err;
    throw wrapped;
  }
  const databaseUrl = options.databaseUrl
    || String((options.env || process.env)[SALES_DSN_ENV] || '').trim();
  if (!databaseUrl) {
    throw new Error(`${SALES_DSN_ENV} is required to open the Sales durable pool`);
  }
  salesPool = new Pool({
    connectionString: databaseUrl,
    max: Number(options.max || POOL_MAX),
    idleTimeoutMillis: Number(options.idleTimeoutMillis || POOL_IDLE_MS),
    connectionTimeoutMillis: Number(options.connectionTimeoutMillis || POOL_CONNECT_MS),
    allowExitOnIdle: true,
  });
  return salesPool;
}

async function closeSalesStore() {
  if (!salesPool) return;
  const ending = salesPool;
  salesPool = null;
  await ending.end();
}

/**
 * Create the repository for the current env (or injected env).
 * @param {NodeJS.ProcessEnv|{[k:string]:string}} [env]
 */
async function createSalesRepository(env = process.env) {
  const config = resolveSalesStoreConfig(env);
  if (config.backend === 'fail_closed') {
    return createFailClosedSalesRepository(config);
  }
  if (config.backend === 'memory') {
    return createMemorySalesRepository();
  }
  return createPgSalesRepository({
    env,
    databaseUrl: config.databaseUrl,
  });
}

function newSalesUuid() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

module.exports = {
  SALES_DSN_ENV,
  SALES_SCHEMA,
  POOL_MAX,
  SalesStoreUnavailableError,
  closeSalesStore,
  createFailClosedSalesRepository,
  createMemorySalesRepository,
  createPgSalesRepository,
  createSalesRepository,
  getSalesPool,
  isSalesStoreUnavailableError,
  isSalesUnavailableResult,
  newSalesUuid,
  resolveSalesStoreConfig,
  salesUnavailableResult,
};
