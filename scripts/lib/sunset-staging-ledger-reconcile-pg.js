'use strict';

/**
 * Pinned pg.Client wiring for Sunset ledger reconcile.
 * Production: locked Azure host + verify-full TLS + protected admin env.
 * Disposable proof: test-only seam (not available from production CLI argv).
 */

const { Client } = require('pg');
const { TARGETS, ENV_PG_ADMIN_USER, ENV_PG_ADMIN_PASSWORD } = require('./sunset-schema-observer-role-provision');
const { scanSecretValues } = require('./sunset-staging-iac-drift');

const ENV_DISPOSABLE_PROOF = 'SUNSET_STAGING_LEDGER_RECONCILE_DISPOSABLE_PROOF';
const ENV_INTERNAL_CONNECT_HOST = 'SUNSET_STAGING_LEDGER_RECONCILE_INTERNAL_CONNECT_HOST';
const ENV_INTERNAL_CONNECT_PORT = 'SUNSET_STAGING_LEDGER_RECONCILE_INTERNAL_CONNECT_PORT';
const ENV_LOAD_KV_ADMIN = 'SUNSET_STAGING_LEDGER_RECONCILE_LOAD_KV_ADMIN';

const LIVE_TARGET_PROOF_SQL = `
SELECT
  current_database() AS database_name,
  current_setting('application_name', true) AS application_name,
  COALESCE(inet_server_addr()::text, '') AS server_addr,
  COALESCE(inet_server_port(), 0)::int AS server_port,
  version() AS server_version
`;

let clientsInstantiated = 0;

function resetPgCounters() {
  clientsInstantiated = 0;
}

function getPgCounters() {
  return { clientsInstantiated };
}

function assertPinnedReconcilePgClient(client) {
  if (!client || typeof client.query !== 'function') {
    return {
      ok: false,
      errors: [{ code: 'pinned_client_required', message: 'pg.Client or PoolClient with query() is required' }],
    };
  }
  if (typeof client.totalCount === 'number' || typeof client.idleCount === 'number' || typeof client.waitingCount === 'number') {
    return {
      ok: false,
      errors: [{ code: 'pinned_client_rejects_pool', message: 'pg.Pool is forbidden at mutation boundary' }],
    };
  }
  const hasEnd = typeof client.end === 'function';
  const hasRelease = typeof client.release === 'function';
  if (!hasEnd && !hasRelease) {
    return {
      ok: false,
      errors: [{ code: 'pinned_client_rejects_query_facade', message: 'query facade without end/release is forbidden' }],
    };
  }
  return { ok: true, errors: [] };
}

function isDisposableProofEnv(env) {
  return String((env || process.env)[ENV_DISPOSABLE_PROOF] || '') === '1';
}

function resolveProtectedAdminCredentials(env) {
  const e = env || process.env;
  const user = String(e[ENV_PG_ADMIN_USER] || '').trim();
  const password = String(e[ENV_PG_ADMIN_PASSWORD] || '');
  if (!user || !password) {
    return {
      ok: false,
      errors: [{ code: 'protected_admin_credentials_missing', message: 'SUNSET_STAGING_PG_ADMIN_USER/PASSWORD required' }],
    };
  }
  const probe = { user, password };
  if (scanSecretValues(probe).length) {
    return { ok: false, errors: [{ code: 'credential_shape_invalid' }] };
  }
  return { ok: true, user, password, errors: [] };
}

async function maybeLoadKvAdminCredentials(env) {
  const e = env || process.env;
  if (String(e[ENV_LOAD_KV_ADMIN] || '') !== '1') {
    return { ok: false, skipped: true, errors: [{ code: 'kv_loader_not_enabled' }] };
  }
  const { loadAdminEnvFromExistingAppDsn } = require('../load-sunset-staging-pg-admin-env');
  loadAdminEnvFromExistingAppDsn();
  return resolveProtectedAdminCredentials(e);
}

function buildLockedConnectConfig(applicationName, env) {
  const e = env || process.env;
  const creds = resolveProtectedAdminCredentials(e);
  if (!creds.ok) return creds;

  const disposable = isDisposableProofEnv(e);
  const internalHost = String(e[ENV_INTERNAL_CONNECT_HOST] || '').trim();
  const internalPort = Number(e[ENV_INTERNAL_CONNECT_PORT] || 0);

  if (disposable) {
    if (!internalHost || !Number.isFinite(internalPort) || internalPort <= 0) {
      return {
        ok: false,
        errors: [{ code: 'disposable_connect_seam_incomplete', message: 'disposable proof requires internal host/port seam' }],
      };
    }
    return {
      ok: true,
      config: {
        host: internalHost,
        port: internalPort,
        database: TARGETS.database,
        user: creds.user,
        password: creds.password,
        application_name: applicationName,
        connectionTimeoutMillis: 20000,
        statement_timeout: 30000,
        ssl: false,
      },
      mode: 'disposable_local_proof',
    };
  }

  return {
    ok: true,
    config: {
      host: TARGETS.postgresHost,
      port: 5432,
      database: TARGETS.database,
      user: creds.user,
      password: creds.password,
      application_name: applicationName,
      connectionTimeoutMillis: 20000,
      statement_timeout: 30000,
      ssl: {
        rejectUnauthorized: true,
        servername: TARGETS.postgresHost,
      },
    },
    mode: 'sunset_staging_locked',
  };
}

async function createPinnedPgClient(applicationName, env, options) {
  const opts = options || {};
  let credGate = resolveProtectedAdminCredentials(env);
  if (!credGate.ok && !isDisposableProofEnv(env)) {
    const kv = await maybeLoadKvAdminCredentials(env);
    if (kv.ok) credGate = resolveProtectedAdminCredentials(env);
    else if (!kv.skipped) return { ok: false, errors: kv.errors };
  }
  const built = buildLockedConnectConfig(applicationName, env);
  if (!built.ok) return built;

  if (typeof opts.clientFactory === 'function') {
    const client = opts.clientFactory(built.config);
    const pin = assertPinnedReconcilePgClient(client);
    if (!pin.ok) return pin;
    clientsInstantiated += 1;
    return { ok: true, client, mode: built.mode, connectConfig: { host: built.config.host, port: built.config.port, database: built.config.database, application_name: built.config.application_name } };
  }

  const client = new Client(built.config);
  const pin = assertPinnedReconcilePgClient(client);
  if (!pin.ok) return pin;
  clientsInstantiated += 1;
  try {
    await client.connect();
  } catch (_) {
    return { ok: false, errors: [{ code: 'connect_failed', message: 'connect failed' }] };
  }
  return {
    ok: true,
    client,
    mode: built.mode,
    connectConfig: {
      host: built.config.host,
      port: built.config.port,
      database: built.config.database,
      application_name: built.config.application_name,
    },
  };
}

function isLoopbackAddr(addr) {
  const a = String(addr || '').trim();
  if (!a || a === '0.0.0.0' || a === '::' || a === '::1') return true;
  if (a.startsWith('127.')) return true;
  if (a.startsWith('::ffff:127.')) return true;
  return false;
}

async function assertLiveSessionTarget(client, applicationName, targetProofMode) {
  const res = await client.query(LIVE_TARGET_PROOF_SQL);
  const row = (res.rows && res.rows[0]) || {};
  const errors = [];

  if (String(row.database_name) !== TARGETS.database) {
    errors.push({ code: 'live_database_mismatch', message: 'current_database() mismatch' });
  }
  if (String(row.application_name || '') !== applicationName) {
    errors.push({ code: 'live_application_name_mismatch', message: 'application_name mismatch' });
  }

  const loopback = isLoopbackAddr(row.server_addr);
  if (targetProofMode === 'disposable_local_proof') {
    // Disposable proof seam: host/port are pinned via internal connect config; database + app name readback only.
  } else if (loopback) {
    errors.push({ code: 'live_server_loopback_refused', message: 'loopback server_addr refused for production target proof' });
  }

  if (Number(row.server_port) !== 5432 && targetProofMode !== 'disposable_local_proof') {
    errors.push({ code: 'live_server_port_mismatch', message: 'server port mismatch' });
  }

  return {
    ok: errors.length === 0,
    errors,
    row: {
      database_name: row.database_name,
      application_name: row.application_name,
      server_addr: row.server_addr,
      server_port: row.server_port,
    },
  };
}

async function closePinnedPgClient(client) {
  if (!client) return { ok: true };
  try {
    if (typeof client.release === 'function') await client.release();
    else if (typeof client.end === 'function') await client.end();
    return { ok: true };
  } catch (_) {
    return { ok: false, code: 'client_close_failed' };
  }
}

module.exports = {
  ENV_DISPOSABLE_PROOF,
  ENV_INTERNAL_CONNECT_HOST,
  ENV_INTERNAL_CONNECT_PORT,
  ENV_LOAD_KV_ADMIN,
  LIVE_TARGET_PROOF_SQL,
  assertPinnedReconcilePgClient,
  resolveProtectedAdminCredentials,
  maybeLoadKvAdminCredentials,
  buildLockedConnectConfig,
  createPinnedPgClient,
  assertLiveSessionTarget,
  closePinnedPgClient,
  isDisposableProofEnv,
  resetPgCounters,
  getPgCounters,
};
