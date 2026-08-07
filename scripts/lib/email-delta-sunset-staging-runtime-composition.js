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
 * migration/DDL work on import, factory, readiness, or hard-fail lifecycle.
 *
 * Activation capability escape removed: public exports and returned surface
 * never expose or load #410 durable-operation owners, Graph transport, delta
 * store, grant session, KV provider/composition constructors, withPgClient,
 * or dependency bags. No generic owner-loader path. run/reconcile/restart
 * hard-fail without touching dependencies.
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

/** Public surface only — no owner-loader, no #410 factory, no dependency bag. */
const SURFACE_KEYS = Object.freeze([
  'getReadiness',
  'getLifecycle',
  'run',
  'reconcile',
  'restart',
]);

const ACTIVATION_HARD_FAIL_CODE = 'email_delta_activation_impossible';
const ACTIVATION_HARD_FAIL_MESSAGE = 'Email delta activation is impossible in this composition.';

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/* ── Module-init pins (security-critical intrinsics) ─────────────────────── */
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;
const PINNED_OBJECT_PROTOTYPE = Object.prototype;
const PINNED_REFLECT_APPLY = typeof Reflect.apply === 'function' ? Reflect.apply : null;
const PINNED_REFLECT_OWN_KEYS = typeof Reflect.ownKeys === 'function' ? Reflect.ownKeys : null;
const PINNED_GET_OWN_PROPERTY_DESCRIPTOR =
  typeof Object.getOwnPropertyDescriptor === 'function' ? Object.getOwnPropertyDescriptor : null;
const PINNED_GET_PROTOTYPE_OF =
  typeof Object.getPrototypeOf === 'function' ? Object.getPrototypeOf : null;
const PINNED_IS_FROZEN =
  typeof Object.isFrozen === 'function' ? Object.isFrozen : null;
const PINNED_HAS_OWN =
  typeof Object.prototype.hasOwnProperty === 'function'
    ? Object.prototype.hasOwnProperty
    : null;

const PINNED_INTRINSICS_READY = Boolean(
  PINNED_IS_PROXY
  && PINNED_UTIL_TYPES
  && PINNED_REFLECT_APPLY
  && PINNED_REFLECT_OWN_KEYS
  && PINNED_GET_OWN_PROPERTY_DESCRIPTOR
  && PINNED_GET_PROTOTYPE_OF
  && PINNED_IS_FROZEN
  && PINNED_HAS_OWN
  && PINNED_OBJECT_PROTOTYPE,
);

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

/** Pinned Object.prototype.hasOwnProperty.call — never ambient rebinding. */
function safeHasOwn(object, key) {
  try {
    if (!PINNED_HAS_OWN || object == null) return false;
    return PINNED_HAS_OWN.call(object, key) === true;
  } catch {
    return false;
  }
}

function isProxySurface(value) {
  try {
    if (!PINNED_INTRINSICS_READY) return true;
    return PINNED_REFLECT_APPLY.call(Reflect, PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

function ownData(object, key) {
  try {
    if (object == null || !PINNED_INTRINSICS_READY || isProxySurface(object)) return undefined;
    const descriptor = PINNED_GET_OWN_PROPERTY_DESCRIPTOR.call(Object, object, key);
    return descriptor
      && safeHasOwn(descriptor, 'value')
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
    if (!PINNED_INTRINSICS_READY) return false;
    if (isProxySurface(object)) return false;
    if (PINNED_GET_PROTOTYPE_OF.call(Object, object) !== PINNED_OBJECT_PROTOTYPE) return false;
    const actual = PINNED_REFLECT_OWN_KEYS.call(Reflect, object);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== 'string'
          || DANGEROUS_KEYS.has(key)
          || !keys.includes(key))) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = PINNED_GET_OWN_PROPERTY_DESCRIPTOR.call(Object, object, key);
      return Boolean(
        descriptor
        && safeHasOwn(descriptor, 'value')
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
  try {
    if (!object || !PINNED_INTRINSICS_READY) return false;
    if (PINNED_IS_FROZEN.call(Object, object) !== true) return false;
    return exactPlainData(object, keys);
  } catch {
    return false;
  }
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
 * Side-effect-free readiness resolve (Staff API safe).
 * Never constructs Pool / Azure SDK / Graph / timers / leases / migrations.
 * Never loads #410 / KV owner / grant / transport modules.
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
 * No owner-loader, no #410 factory, no nested callable capability escape.
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

    const surface = Object.freeze({
      getReadiness,
      getLifecycle,
      run,
      reconcile,
      restart,
    });

    // Exact public key set (no extras, no owner-loader).
    if (!exactFrozenData(surface, SURFACE_KEYS)) {
      // Fallback check when freeze/plain drift; still reject extras.
      try {
        if (!PINNED_IS_FROZEN.call(Object, surface)) throw failure();
        const keys = PINNED_REFLECT_OWN_KEYS.call(Reflect, surface);
        if (keys.length !== SURFACE_KEYS.length
            || !SURFACE_KEYS.every((k) => typeof surface[k] === 'function')) {
          throw failure();
        }
      } catch (e) {
        if (e && e.code === ERROR_CODE) throw e;
        throw failure();
      }
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
