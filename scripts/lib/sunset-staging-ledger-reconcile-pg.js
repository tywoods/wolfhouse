'use strict';

/**
 * Production pinned pg.Client wiring for Sunset ledger reconcile.
 * No disposable/test connection seams — those live in sunset-staging-ledger-reconcile-disposable-pg.js.
 */

const dns = require('dns').promises;
const { Client } = require('pg');
const { TARGETS, ENV_PG_ADMIN_USER, ENV_PG_ADMIN_PASSWORD } = require('./sunset-schema-observer-role-provision');
const { scanSecretValues } = require('./sunset-staging-iac-drift');

const ENV_LOAD_KV_ADMIN = 'SUNSET_STAGING_LEDGER_RECONCILE_LOAD_KV_ADMIN';
const FORBIDDEN_PRODUCTION_SEAM_ENVS = Object.freeze([
  'SUNSET_STAGING_LEDGER_RECONCILE_DISPOSABLE_PROOF',
  'SUNSET_STAGING_LEDGER_RECONCILE_INTERNAL_CONNECT_HOST',
  'SUNSET_STAGING_LEDGER_RECONCILE_INTERNAL_CONNECT_PORT',
  'SUNSET_STAGING_LEDGER_RECONCILE_INJECT_FAIL_STEP',
]);

const SUNSET_LOCKED_CONNECT = Symbol.for('sunset.reconcile.lockedConnect');
const SUNSET_LOCKED_HOST_IDENTITY = Symbol.for('sunset.reconcile.lockedHostIdentity');
// Deployment-owned address of the approved delegated-subnet endpoint. This is
// deliberately an exact address lock, not an RFC1918/private-network bypass.
const APPROVED_PRIVATE_SERVER_ADDRESSES = Object.freeze(['10.33.0.4']);

let clientsInstantiated = 0;
let cachedHostIdentity = null;
let connectFailureEndCalls = 0;

function resetPgCounters() {
  clientsInstantiated = 0;
  cachedHostIdentity = null;
  connectFailureEndCalls = 0;
}

function getPgCounters() {
  return { clientsInstantiated, connectFailureEndCalls };
}

async function endClientAfterConnectFailure(client) {
  if (!client || typeof client.end !== 'function') return false;
  try {
    await client.end();
    connectFailureEndCalls += 1;
    return true;
  } catch (_) {
    return false;
  }
}

function assertProductionSeamEnvRejected(env) {
  const e = env || process.env;
  const errors = [];
  for (const name of FORBIDDEN_PRODUCTION_SEAM_ENVS) {
    if (String(e[name] || '').trim()) {
      errors.push({ code: 'disposable_seam_env_forbidden', message: `${name} is forbidden on production entrypoints` });
    }
  }
  return { ok: errors.length === 0, errors };
}

function assertPinnedReconcilePgClient(client) {
  if (!client || typeof client.query !== 'function') {
    return { ok: false, errors: [{ code: 'pinned_client_required' }] };
  }
  if (typeof client.totalCount === 'number' || typeof client.idleCount === 'number' || typeof client.waitingCount === 'number') {
    return { ok: false, errors: [{ code: 'pinned_client_rejects_pool' }] };
  }
  const hasEnd = typeof client.end === 'function';
  const hasRelease = typeof client.release === 'function';
  if (!hasEnd && !hasRelease) {
    return { ok: false, errors: [{ code: 'pinned_client_rejects_query_facade' }] };
  }
  return { ok: true, errors: [] };
}

function resolveProtectedAdminCredentials(env) {
  const e = env || process.env;
  const user = String(e[ENV_PG_ADMIN_USER] || '').trim();
  const password = String(e[ENV_PG_ADMIN_PASSWORD] || '');
  if (!user || !password) {
    return { ok: false, errors: [{ code: 'protected_admin_credentials_missing' }] };
  }
  if (scanSecretValues({ user, password }).length) {
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

async function resolveLockedHostIdentity() {
  if (cachedHostIdentity) return cachedHostIdentity;
  const host = TARGETS.postgresHost;
  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch (_) {
    return { ok: false, errors: [{ code: 'locked_host_resolution_failed', message: 'locked postgres host resolution failed' }] };
  }
  const addresses = (records || []).map((r) => r.address).filter(Boolean).sort();
  if (!addresses.length) {
    return { ok: false, errors: [{ code: 'locked_host_resolution_empty', message: 'locked postgres host resolved to zero addresses' }] };
  }
  cachedHostIdentity = { ok: true, host, addresses, errors: [] };
  return cachedHostIdentity;
}

function buildProductionConnectConfig(applicationName, creds) {
  return {
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
  };
}

function attachLockedConnect(client, connect, hostIdentity) {
  Object.defineProperty(client, SUNSET_LOCKED_CONNECT, {
    value: Object.freeze({ ...connect, mode: 'sunset_staging_locked' }),
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(client, SUNSET_LOCKED_HOST_IDENTITY, {
    value: Object.freeze({
      subscriptionId: TARGETS.subscriptionId,
      resourceGroup: TARGETS.resourceGroup,
      postgresServer: TARGETS.postgresServer,
      host: hostIdentity.host,
      tlsServername: connect.tlsServername,
      publicDnsAddresses: Object.freeze(hostIdentity.addresses.slice()),
      approvedPrivateAddresses: APPROVED_PRIVATE_SERVER_ADDRESSES,
    }),
    enumerable: false,
    configurable: false,
  });
}

function getLockedConnect(client) {
  return client && client[SUNSET_LOCKED_CONNECT] ? client[SUNSET_LOCKED_CONNECT] : null;
}

async function createProductionPinnedPgClient(applicationName, env) {
  const seam = assertProductionSeamEnvRejected(env);
  if (!seam.ok) return seam;

  let credGate = resolveProtectedAdminCredentials(env);
  if (!credGate.ok) {
    const kv = await maybeLoadKvAdminCredentials(env);
    if (kv.ok) credGate = resolveProtectedAdminCredentials(env);
    else if (!kv.skipped) return { ok: false, errors: kv.errors };
    else return credGate;
  }

  const hostIdentity = await resolveLockedHostIdentity();
  if (!hostIdentity.ok) return hostIdentity;

  const config = buildProductionConnectConfig(applicationName, credGate);
  const client = new Client(config);
  const pin = assertPinnedReconcilePgClient(client);
  if (!pin.ok) return pin;
  clientsInstantiated += 1;
  try {
    await client.connect();
  } catch (_) {
    await endClientAfterConnectFailure(client);
    return { ok: false, errors: [{ code: 'connect_failed', message: 'connect failed' }] };
  }
  attachLockedConnect(client, {
    host: config.host,
    port: config.port,
    database: config.database,
    applicationName,
    tlsServername: config.ssl.servername,
  }, hostIdentity);
  return {
    ok: true,
    client,
    mode: 'sunset_staging_locked',
    connectConfig: {
      host: config.host,
      port: config.port,
      database: config.database,
      application_name: applicationName,
    },
    lockedHost: hostIdentity.host,
    lockedHostAddresses: hostIdentity.addresses,
    approvedPrivateServerAddresses: APPROVED_PRIVATE_SERVER_ADDRESSES,
  };
}

async function assertLiveSessionTarget(client, applicationName) {
  const locked = getLockedConnect(client);
  const hostIdentity = client && client[SUNSET_LOCKED_HOST_IDENTITY];
  const errors = [];
  if (!locked || locked.host !== TARGETS.postgresHost || locked.database !== TARGETS.database
      || locked.tlsServername !== TARGETS.postgresHost) {
    errors.push({ code: 'locked_connect_metadata_mismatch' });
  }
  if (!hostIdentity
      || hostIdentity.subscriptionId !== TARGETS.subscriptionId
      || hostIdentity.resourceGroup !== TARGETS.resourceGroup
      || hostIdentity.postgresServer !== TARGETS.postgresServer
      || hostIdentity.host !== TARGETS.postgresHost
      || hostIdentity.tlsServername !== TARGETS.postgresHost) {
    errors.push({ code: 'locked_host_identity_mismatch' });
  }

  const res = await client.query(`
    SELECT
      current_database() AS database_name,
      current_setting('application_name', true) AS application_name,
      COALESCE(inet_server_addr()::text, '') AS server_addr,
      COALESCE(inet_server_port(), 0)::int AS server_port
  `);
  const row = (res.rows && res.rows[0]) || {};
  if (String(row.database_name) !== TARGETS.database) errors.push({ code: 'live_database_mismatch' });
  if (String(row.application_name || '') !== applicationName) errors.push({ code: 'live_application_name_mismatch' });
  if (Number(row.server_port) !== 5432) errors.push({ code: 'live_server_port_mismatch' });

  const addr = String(row.server_addr || '').trim();
  if (!addr) {
    errors.push({ code: 'live_server_addr_empty', message: 'inet_server_addr() is empty or null' });
  } else {
    const publicAddresses = hostIdentity && Array.isArray(hostIdentity.publicDnsAddresses)
      ? hostIdentity.publicDnsAddresses : [];
    const privateAddresses = hostIdentity && Array.isArray(hostIdentity.approvedPrivateAddresses)
      ? hostIdentity.approvedPrivateAddresses : [];
    const privateIdentityIsExact = privateAddresses.length === APPROVED_PRIVATE_SERVER_ADDRESSES.length
      && privateAddresses.every((value, index) => value === APPROVED_PRIVATE_SERVER_ADDRESSES[index]);
    if (!publicAddresses.includes(addr) && !(privateIdentityIsExact && privateAddresses.includes(addr))) {
      errors.push({ code: 'live_server_addr_not_approved_target', message: 'server_addr is neither locked public DNS nor the approved private endpoint' });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    row: {
      database_name: row.database_name,
      application_name: row.application_name,
      server_addr: row.server_addr,
      server_port: row.server_port,
      locked_host: TARGETS.postgresHost,
    },
  };
}

async function closePinnedPgClient(client) {
  if (!client) return { ok: true, closed: false };
  try {
    if (typeof client.release === 'function') await client.release();
    else if (typeof client.end === 'function') await client.end();
    return { ok: true, closed: true };
  } catch (_) {
    return { ok: false, code: 'client_close_failed', closed: false };
  }
}

module.exports = {
  ENV_LOAD_KV_ADMIN,
  FORBIDDEN_PRODUCTION_SEAM_ENVS,
  assertProductionSeamEnvRejected,
  assertPinnedReconcilePgClient,
  resolveProtectedAdminCredentials,
  maybeLoadKvAdminCredentials,
  resolveLockedHostIdentity,
  createProductionPinnedPgClient,
  assertLiveSessionTarget,
  closePinnedPgClient,
  resetPgCounters,
  getPgCounters,
  getLockedConnect,
  endClientAfterConnectFailure,
  APPROVED_PRIVATE_SERVER_ADDRESSES,
};
