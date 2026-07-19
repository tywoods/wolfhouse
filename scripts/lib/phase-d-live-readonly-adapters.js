'use strict';

/**
 * Injected adapters for FOUNDATION Slice 14B Phase D live read-only boundary.
 *
 * Offline / proof use only. Default factories never open network sockets,
 * never call Azure CLI, never mutate firewall/network, and never execute
 * live PostgreSQL queries.
 */

const {
  TARGETS,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
} = require('./phase-d-live-readonly-boundary');

/**
 * Counting recorder for RED/GREEN proofs.
 */
function createCallRecorder() {
  const calls = [];
  return {
    calls,
    record(name, args) {
      calls.push({ name, args: args || [] });
    },
    count(name) {
      return calls.filter((c) => c.name === name).length;
    },
    total() {
      return calls.length;
    },
  };
}

/**
 * Azure adapters that return the locked Sunset staging identity.
 * Optional overrides inject RED cases (wrong subscription/RG/FQDN).
 */
function createInjectedAzureAdapters(overrides, recorder) {
  const o = overrides || {};
  const rec = recorder || createCallRecorder();
  return {
    recorder: rec,
    async getAccount() {
      rec.record('getAccount');
      if (typeof o.getAccount === 'function') return o.getAccount();
      return {
        id: o.subscriptionId != null ? o.subscriptionId : TARGETS.subscriptionId,
        subscriptionId: o.subscriptionId != null ? o.subscriptionId : TARGETS.subscriptionId,
        name: 'sunset-staging-injected',
      };
    },
    async getResourceGroup(name, subscriptionId) {
      rec.record('getResourceGroup', [name, subscriptionId]);
      if (typeof o.getResourceGroup === 'function') {
        return o.getResourceGroup(name, subscriptionId);
      }
      return {
        name: o.resourceGroup != null ? o.resourceGroup : name,
      };
    },
    async getPostgresServer(rg, name, subscriptionId) {
      rec.record('getPostgresServer', [rg, name, subscriptionId]);
      if (typeof o.getPostgresServer === 'function') {
        return o.getPostgresServer(rg, name, subscriptionId);
      }
      return {
        name: o.postgresServer != null ? o.postgresServer : name,
        fullyQualifiedDomainName:
          o.postgresHost != null ? o.postgresHost : TARGETS.postgresHost,
      };
    },
  };
}

/**
 * DB adapters. connectInfo may describe the locked target; connect/query
 * refuse unless an explicit test override is provided (Slice 14B never
 * connects on the default path).
 */
function createInjectedDbAdapters(overrides, recorder) {
  const o = overrides || {};
  const rec = recorder || createCallRecorder();
  return {
    recorder: rec,
    async connectInfo() {
      rec.record('connectInfo');
      if (typeof o.connectInfo === 'function') return o.connectInfo();
      return {
        host: o.host != null ? o.host : TARGETS.postgresHost,
        database: o.database != null ? o.database : TARGETS.database,
        sslmode: o.sslmode != null ? o.sslmode : 'verify-full',
        application_name:
          o.application_name != null ? o.application_name : TARGETS.applicationName,
      };
    },
    async connect() {
      rec.record('connect');
      if (typeof o.connect === 'function') return o.connect();
      throw Object.assign(
        new Error('live connect hard-disabled in Slice 14B injected adapters'),
        { code: 'live_readonly_connect_disabled' },
      );
    },
    async query(sql) {
      rec.record('query', [sql]);
      if (typeof o.query === 'function') return o.query(sql);
      throw Object.assign(
        new Error('live query hard-disabled in Slice 14B injected adapters'),
        { code: 'live_readonly_query_disabled' },
      );
    },
  };
}

/**
 * Default offline adapters: exact locked target identity, zero real I/O.
 * connect/query always refuse.
 */
function createDefaultOfflineAdapters() {
  const azureRec = createCallRecorder();
  const dbRec = createCallRecorder();
  return {
    azure: createInjectedAzureAdapters({}, azureRec),
    db: createInjectedDbAdapters({}, dbRec),
    azureRecorder: azureRec,
    dbRecorder: dbRec,
    liveReadonlyConnectEnabled: PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  };
}

/**
 * Live adapter factory placeholder — permanently refuses in Slice 14B.
 * A later approved slice may implement real Azure/PG wiring here.
 */
function createLiveReadonlyAdapters() {
  throw Object.assign(
    new Error(
      'live read-only adapters are hard-disabled in Slice 14B (PHASE_D_LIVE_READONLY_CONNECT_ENABLED=false)',
    ),
    { code: 'live_readonly_connect_disabled' },
  );
}

module.exports = {
  createCallRecorder,
  createInjectedAzureAdapters,
  createInjectedDbAdapters,
  createDefaultOfflineAdapters,
  createLiveReadonlyAdapters,
};
