'use strict';

/**
 * Test-only disposable PostgreSQL wiring. Not importable from production CLI entrypoints.
 */

const { Client } = require('pg');
const { TARGETS } = require('./sunset-schema-observer-role-provision');
const { assertPinnedReconcilePgClient, closePinnedPgClient } = require('./sunset-staging-ledger-reconcile-pg');

const SUNSET_LOCKED_CONNECT = Symbol.for('sunset.reconcile.lockedConnect');

function attachLockedConnect(client, connect) {
  Object.defineProperty(client, SUNSET_LOCKED_CONNECT, {
    value: Object.freeze({ ...connect }),
    enumerable: false,
    configurable: false,
  });
  return client;
}

function getLockedConnect(client) {
  return client && client[SUNSET_LOCKED_CONNECT] ? client[SUNSET_LOCKED_CONNECT] : null;
}

async function createDisposablePinnedPgClient(connect, applicationName) {
  const cfg = {
    host: connect.host,
    port: Number(connect.port),
    database: connect.database || TARGETS.database,
    user: connect.user,
    password: connect.password,
    application_name: applicationName,
    connectionTimeoutMillis: 20000,
    statement_timeout: 30000,
    ssl: false,
  };
  const client = new Client(cfg);
  const pin = assertPinnedReconcilePgClient(client);
  if (!pin.ok) return pin;
  try {
    await client.connect();
  } catch (_) {
    return { ok: false, errors: [{ code: 'connect_failed', message: 'connect failed' }] };
  }
  attachLockedConnect(client, {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    applicationName,
    mode: 'disposable_local_proof',
  });
  return {
    ok: true,
    client,
    mode: 'disposable_local_proof',
    connectConfig: {
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      application_name: applicationName,
    },
  };
}

async function assertDisposableSessionTarget(client, applicationName) {
  const locked = getLockedConnect(client);
  const res = await client.query(`
    SELECT
      current_database() AS database_name,
      current_setting('application_name', true) AS application_name
  `);
  const row = (res.rows && res.rows[0]) || {};
  const errors = [];
  const wantDb = locked ? locked.database : TARGETS.database;
  if (String(row.database_name) !== wantDb) errors.push({ code: 'live_database_mismatch' });
  if (String(row.application_name || '') !== applicationName) errors.push({ code: 'live_application_name_mismatch' });
  return {
    ok: errors.length === 0,
    errors,
    row: {
      database_name: row.database_name,
      application_name: row.application_name,
      locked_host: locked ? locked.host : null,
      locked_port: locked ? locked.port : null,
    },
  };
}

module.exports = {
  createDisposablePinnedPgClient,
  assertDisposableSessionTarget,
  attachLockedConnect,
  getLockedConnect,
  closeDisposablePinnedPgClient: closePinnedPgClient,
};
