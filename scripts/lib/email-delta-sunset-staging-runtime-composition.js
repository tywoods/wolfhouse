'use strict';

/**
 * Sunset-staging Staff API email-delta runtime composition (default-off / inert).
 *
 * Structurally integrated config + readiness/lifecycle surface only.
 * Provably inert: default-off, activation-impossible for worker/admin, no
 * runnable scheduler or admin route in this PR.
 *
 * Exact independent flags (see email-delta-runtime-config):
 *   LUNA_EMAIL_DELTA_RUNTIME_COMPOSITION_ENABLED
 *   LUNA_EMAIL_DELTA_WORKER_ENABLED  — true rejected
 *   LUNA_EMAIL_DELTA_ADMIN_ENABLED   — true rejected
 *
 * Composition enabled alone (with exact deployment=sunset-staging,
 * tenant=sunset, migration064 contract, canonical worker id, pinned KV env)
 * yields frozen composition_inert readiness. No DB/KV SDK/Graph/timer/lease/
 * migration/DDL work on import, factory, or readiness resolve.
 *
 * Reuses PR #410 durable-operation composition and real owners only through
 * lazy factory closures (never invoked by the public surface of this PR).
 * Never duplicates SQL / network / crypto / refresh / URL parsing.
 *
 * Future exclusive transaction-client adapter is documented on the config
 * module; this PR never passes getPool, never closes the application pool,
 * and never takes a DB loan.
 *
 * Public surface: exact frozen readiness + lifecycle only.
 * run / reconcile / restart hard-fail without touching dependencies.
 *
 * @module email-delta-sunset-staging-runtime-composition
 */

const util = require('util');

const {
  ERROR_CODE: CONFIG_ERROR_CODE,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  WORKER_ID,
  MIGRATION_064_ID,
  QUERY_VERSION,
  ENV_COMPOSITION_ENABLED,
  ENV_WORKER_ENABLED,
  ENV_ADMIN_ENABLED,
  CONFIG_STATUS,
  READINESS_KEYS,
  MIGRATION_064_READINESS_CONTRACT,
  CANONICAL_WORKER_CONFIG,
  FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT,
  parseEmailDeltaRuntimeConfig,
  isEmailDeltaCompositionFlagEnabled,
} = require('./email-delta-runtime-config');

const ERROR_CODE = 'EMAIL_DELTA_SUNSET_STAGING_RUNTIME_COMPOSITION_INVALID';
const ERROR_MESSAGE = 'Email delta sunset-staging runtime composition failed.';

const EMAIL_DELTA_RUNTIME_COMPOSITION_RUNTIME_WIRED = false;
const EMAIL_DELTA_RUNTIME_COMPOSITION_IMPORT_INERT = true;
const EMAIL_DELTA_RUNTIME_COMPOSITION_SAFE_FOR_SCHEDULER = false;
const EMAIL_DELTA_RUNTIME_COMPOSITION_SAFE_FOR_ADMIN_ROUTE = false;
const EMAIL_DELTA_RUNTIME_COMPOSITION_ACTIVATION_POSSIBLE = false;

const DEPENDENCY_KEYS = Object.freeze(['env']);

const LIFECYCLE_KEYS = Object.freeze([
  'state',
  'import_inert',
  'startup_side_effect_free',
  'db_touch',
  'pool_constructed',
  'kv_sdk_touch',
  'crypto_unwrap',
  'graph_touch',
  'timer_touch',
  'lease_touch',
  'migration_applied',
  'scheduler_started',
  'admin_route_mounted',
  'runtime_activation',
]);

const SURFACE_KEYS = Object.freeze([
  'getReadiness',
  'getLifecycle',
  'run',
  'reconcile',
  'restart',
  'createLazyDurableOperationFactory',
]);

const ACTIVATION_HARD_FAIL_CODE = 'email_delta_activation_impossible';
const ACTIVATION_HARD_FAIL_MESSAGE = 'Email delta activation is impossible in this composition.';

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// Module-init pins.
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;

// Static alignment with config pins.
if (SUNSET_DEPLOYMENT !== 'sunset-staging') {
  throw new Error('email_delta_runtime_composition_sunset_deployment_mismatch');
}
if (SUNSET_TENANT !== 'sunset') {
  throw new Error('email_delta_runtime_composition_sunset_tenant_mismatch');
}
if (QUERY_VERSION !== 'ms_messages_delta_v1') {
  throw new Error('email_delta_runtime_composition_query_version_unexpected');
}
if (MIGRATION_064_ID !== '064_tenant_email_inbound_delta_states') {
  throw new Error('email_delta_runtime_composition_migration_pin_unexpected');
}
if (EMAIL_DELTA_RUNTIME_COMPOSITION_ACTIVATION_POSSIBLE !== false) {
  throw new Error('email_delta_runtime_composition_activation_possible_unexpected');
}
if (EMAIL_DELTA_RUNTIME_COMPOSITION_RUNTIME_WIRED !== false) {
  throw new Error('email_delta_runtime_composition_runtime_wired_unexpected');
}

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', {
    value: 'EmailDeltaSunsetStagingRuntimeCompositionError',
  });
  Object.defineProperty(error, 'code', { value: ERROR_CODE, enumerable: true });
  return Object.freeze(error);
}

function activationHardFail() {
  const error = new Error(ACTIVATION_HARD_FAIL_MESSAGE);
  Object.defineProperty(error, 'name', {
    value: 'EmailDeltaActivationImpossibleError',
  });
  Object.defineProperty(error, 'code', {
    value: ACTIVATION_HARD_FAIL_CODE,
    enumerable: true,
  });
  return Object.freeze(error);
}

function isProxySurface(value) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

function ownData(object, key) {
  try {
    if (object == null || isProxySurface(object)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor
      && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      && !descriptor.get
      && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function exactPlainData(object, keys) {
  try {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
    if (isProxySurface(object)) return false;
    if (Object.getPrototypeOf(object) !== Object.prototype) return false;
    const actual = Reflect.ownKeys(object);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== 'string'
          || DANGEROUS_KEYS.has(key)
          || !keys.includes(key))) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return Boolean(
        descriptor
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && descriptor.enumerable
        && !descriptor.get
        && !descriptor.set,
      );
    });
  } catch {
    return false;
  }
}

function exactFrozenData(object, keys) {
  return Boolean(object && Object.isFrozen(object) && exactPlainData(object, keys));
}

function assertReadinessShape(readiness) {
  if (!exactFrozenData(readiness, READINESS_KEYS)) return false;
  if (typeof ownData(readiness, 'ok') !== 'boolean') return false;
  if (typeof ownData(readiness, 'status') !== 'string') return false;
  if (ownData(readiness, 'worker_activation_possible') !== false) return false;
  if (ownData(readiness, 'admin_activation_possible') !== false) return false;
  if (ownData(readiness, 'runtime_activation') !== false) return false;
  if (ownData(readiness, 'scheduler_present') !== false) return false;
  if (ownData(readiness, 'admin_route_present') !== false) return false;
  return true;
}

function lifecycleFromReadiness(readiness) {
  const status = ownData(readiness, 'status');
  let state = 'disabled';
  if (status === CONFIG_STATUS.COMPOSITION_INERT) state = 'inert';
  else if (status === CONFIG_STATUS.ACTIVATION_REJECTED) state = 'rejected';
  else if (status === CONFIG_STATUS.CONFIG_INVALID) state = 'invalid';
  else if (status === CONFIG_STATUS.DISABLED) state = 'disabled';

  return Object.freeze({
    state,
    import_inert: true,
    startup_side_effect_free: true,
    db_touch: false,
    pool_constructed: false,
    kv_sdk_touch: false,
    crypto_unwrap: false,
    graph_touch: false,
    timer_touch: false,
    lease_touch: false,
    migration_applied: false,
    scheduler_started: false,
    admin_route_mounted: false,
    runtime_activation: false,
  });
}

/**
 * Lazy owner registry for PR #410 durable-operation composition.
 * Closures only — never invoked by public readiness/lifecycle/hard-fail paths.
 * First call (future PR only) loads real owners without duplicating SQL/network/
 * crypto/refresh/URL parsing. Import of this composition module does not load them.
 *
 * @returns {function(): Readonly<object>}
 */
function createLazyDurableOwnersAccessor() {
  let owners = null;
  return function getLazyDurableOwners() {
    if (owners) return owners;
    // Lazy requires — keep import of this module free of operation/transport graph
    // until a future activation path deliberately asks for owners.
    const offline = require('./email-authority-bound-messages-delta-offline-composition');
    const pageOp = require('./email-authority-bound-messages-delta-page-operation');
    const transport = require('./email-microsoft-graph-messages-delta-page-transport');
    const deltaStore = require('./email-inbound-delta-state-store');
    const grantSession = require('./email-delegated-grant-access-session');
    const kvComp = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');

    owners = Object.freeze({
      createOfflineAuthorityBoundMessagesDeltaComposition:
        offline.createOfflineAuthorityBoundMessagesDeltaComposition,
      createAuthorityBoundMessagesDeltaPageOperation:
        pageOp.createAuthorityBoundMessagesDeltaPageOperation,
      createMicrosoftGraphMessagesDeltaPageTransport:
        transport.createMicrosoftGraphMessagesDeltaPageTransport,
      createInboundEmailDeltaStateStore:
        deltaStore.createInboundEmailDeltaStateStore,
      resolveWithTransactionClient:
        deltaStore.resolveWithTransactionClient,
      createDelegatedGrantAccessSession:
        grantSession.createDelegatedGrantAccessSession,
      parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig:
        kvComp.parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig,
      createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition:
        kvComp.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition,
      // Documented future exclusive loan — not constructed here.
      futureTransactionClientAdapterContract:
        FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT,
      offline_runtime_wired:
        offline.EMAIL_MESSAGES_DELTA_OFFLINE_COMPOSITION_RUNTIME_WIRED === false,
      page_runtime_wired:
        pageOp.EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_RUNTIME_WIRED === false,
      page_safe_for_route_cron:
        pageOp.EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_SAFE_FOR_RUNTIME_ROUTE_CRON === false,
    });
    return owners;
  };
}

/**
 * Side-effect-free readiness resolve (Staff API safe).
 * Never constructs Pool / Azure SDK / Graph / timers / leases / migrations.
 *
 * @param {object} [env]
 * @returns {Readonly<object>} frozen READINESS_KEYS
 */
function resolveEmailDeltaSunsetStagingRuntimeReadiness(env) {
  try {
    const readiness = parseEmailDeltaRuntimeConfig(
      env === undefined ? process.env : env,
    );
    if (!assertReadinessShape(readiness)) {
      // Fail closed sanitized if shape drifts.
      return parseEmailDeltaRuntimeConfig({});
    }
    return readiness;
  } catch {
    return parseEmailDeltaRuntimeConfig({});
  }
}

/**
 * Side-effect-free lifecycle resolve paired with readiness.
 * @param {object} [env]
 * @returns {Readonly<object>} frozen LIFECYCLE_KEYS
 */
function resolveEmailDeltaSunsetStagingRuntimeLifecycle(env) {
  const readiness = resolveEmailDeltaSunsetStagingRuntimeReadiness(env);
  return lifecycleFromReadiness(readiness);
}

/**
 * Explicit Sunset-staging email-delta runtime composition factory.
 *
 * Accepts exact own-data `{ env }` only. Import-inert; factory does not touch
 * DB / Pool / Azure KV SDK / Graph / timers / leases / migrations.
 * Returns frozen readiness/lifecycle surface; run/reconcile/restart hard-fail.
 *
 * @param {{ env: object }} deps
 * @returns {Readonly<object>}
 */
function createEmailDeltaSunsetStagingRuntimeComposition(deps) {
  try {
    if (deps == null || isProxySurface(deps) || !exactPlainData(deps, DEPENDENCY_KEYS)) {
      throw failure();
    }
    const env = ownData(deps, 'env');
    if (env == null || isProxySurface(env)
        || (typeof env !== 'object' && typeof env !== 'function')
        || Array.isArray(env)) {
      throw failure();
    }

    const readiness = parseEmailDeltaRuntimeConfig(env);
    if (!assertReadinessShape(readiness)) throw failure();

    // Lazy #410 owner closures — public surface never invokes for execution.
    const getLazyDurableOwners = createLazyDurableOwnersAccessor();

    function getReadiness() {
      // Return the frozen factory-time snapshot (no re-read of ambient env).
      return readiness;
    }

    function getLifecycle() {
      return lifecycleFromReadiness(readiness);
    }

    /**
     * Hard-fail activation surface. Must not touch deps / owners / network / DB.
     */
    function run() {
      throw activationHardFail();
    }

    function reconcile() {
      throw activationHardFail();
    }

    function restart() {
      throw activationHardFail();
    }

    /**
     * Lazy durable-operation factory accessor (structural wire only).
     * Returns owner registry; does not run a page, open Graph, unwrap crypto,
     * construct Pool, or start a timer. Future worker PRs may build on this
     * after separate activation review — this PR keeps activation impossible.
     *
     * When composition is not inert-ready, refuse even the lazy owner load so
     * misconfigured worker/admin env cannot reach #410 factories.
     */
    function createLazyDurableOperationFactory() {
      if (ownData(readiness, 'status') !== CONFIG_STATUS.COMPOSITION_INERT
          || ownData(readiness, 'ok') !== true
          || ownData(readiness, 'composition_enabled') !== true) {
        throw activationHardFail();
      }
      // Still activation-impossible for run; only exposes lazy owner handles.
      const owners = getLazyDurableOwners();
      return Object.freeze({
        owners,
        // Explicit non-run surface for future composition — hard fail.
        runAuthorityBoundMessagesDeltaPageDurable() {
          throw activationHardFail();
        },
        futureTransactionClientAdapterContract:
          FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT,
        activation_possible: false,
      });
    }

    const surface = Object.freeze({
      getReadiness,
      getLifecycle,
      run,
      reconcile,
      restart,
      createLazyDurableOperationFactory,
    });

    // Exact public key set (no extras).
    if (!exactFrozenData(surface, SURFACE_KEYS)
        && !(Object.isFrozen(surface)
          && Reflect.ownKeys(surface).length === SURFACE_KEYS.length
          && SURFACE_KEYS.every((k) => typeof surface[k] === 'function'))) {
      throw failure();
    }

    return surface;
  } catch (err) {
    if (err && (err.code === ERROR_CODE || err.code === ACTIVATION_HARD_FAIL_CODE
        || err.code === CONFIG_ERROR_CODE)) {
      throw err;
    }
    throw failure();
  }
}

module.exports = Object.freeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  ACTIVATION_HARD_FAIL_CODE,
  ACTIVATION_HARD_FAIL_MESSAGE,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  WORKER_ID,
  MIGRATION_064_ID,
  QUERY_VERSION,
  ENV_COMPOSITION_ENABLED,
  ENV_WORKER_ENABLED,
  ENV_ADMIN_ENABLED,
  DEPENDENCY_KEYS,
  LIFECYCLE_KEYS,
  SURFACE_KEYS,
  READINESS_KEYS,
  CONFIG_STATUS,
  MIGRATION_064_READINESS_CONTRACT,
  CANONICAL_WORKER_CONFIG,
  FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT,
  EMAIL_DELTA_RUNTIME_COMPOSITION_RUNTIME_WIRED,
  EMAIL_DELTA_RUNTIME_COMPOSITION_IMPORT_INERT,
  EMAIL_DELTA_RUNTIME_COMPOSITION_SAFE_FOR_SCHEDULER,
  EMAIL_DELTA_RUNTIME_COMPOSITION_SAFE_FOR_ADMIN_ROUTE,
  EMAIL_DELTA_RUNTIME_COMPOSITION_ACTIVATION_POSSIBLE,
  parseEmailDeltaRuntimeConfig,
  isEmailDeltaCompositionFlagEnabled,
  resolveEmailDeltaSunsetStagingRuntimeReadiness,
  resolveEmailDeltaSunsetStagingRuntimeLifecycle,
  createEmailDeltaSunsetStagingRuntimeComposition,
});
