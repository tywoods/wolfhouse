'use strict';

/**
 * Sunset-staging email-delta operator recovery runtime composition (default-off).
 *
 * Explicit factory only. Import-inert: zero DB/Pool/KV SDK/Graph/timer/lease
 * construction at require. Enabled only under full operator recovery gate
 * (see email-delta-operator-recovery-config).
 *
 * Factory-fixed exclusive loan:
 *   - Outer route withPgClient owns release
 *   - withTransactionClient invokes work on the same captured exclusive client
 *   - No getPool / second checkout / nested release / close
 *
 * Wires merged owners only:
 *   - createDelegatedReadAuthorityBindingVerifier
 *   - resolveDelegatedReadAuthorityBinding (private provider tenant/mailbox)
 *   - createInboundEmailDeltaStateStore
 *   - createEmailDeltaOperatorRecoveryService → recovery journal store
 *
 * No worker/scheduler. No owner graph side effects when disabled.
 *
 * @module email-delta-operator-recovery-sunset-staging-runtime-composition
 */

const util = require('util');

const {
  isEmailDeltaOperatorRecoveryEnabled,
  parseEmailDeltaOperatorRecoveryConfig,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  QUERY_VERSION,
  MIGRATION_065_ID,
  MIGRATION_064_ID,
  ENV_OPERATOR_RECOVERY_ENABLED,
  READINESS_KEYS,
  CONFIG_STATUS,
} = require('./email-delta-operator-recovery-config');
const {
  createDelegatedReadAuthorityBindingVerifier,
  resolveDelegatedReadAuthorityBinding,
} = require('./email-delegated-grant-custodian');
const {
  createInboundEmailDeltaStateStore,
} = require('./email-inbound-delta-state-store');
const {
  createEmailDeltaOperatorRecoveryService,
  SERVICE_OUTCOME,
} = require('./email-delta-operator-recovery-service');
const {
  snapshotOwnDataProps,
} = require('./email-grant-envelope-provider-contract');

const ERROR_CODE = 'EMAIL_DELTA_OPERATOR_RECOVERY_COMPOSITION_INVALID';
const ERROR_MESSAGE = 'Email delta operator recovery composition failed.';

const EMAIL_DELTA_OPERATOR_RECOVERY_RUNTIME_WIRED = true;
const EMAIL_DELTA_OPERATOR_RECOVERY_IMPORT_INERT = true;
const EMAIL_DELTA_OPERATOR_RECOVERY_SAFE_FOR_SCHEDULER = false;
const EMAIL_DELTA_OPERATOR_RECOVERY_WORKER_PRESENT = false;

const DEPENDENCY_KEYS = Object.freeze([
  'env',
  'pgClient',
  'withTransactionClient',
]);

const SURFACE_KEYS = Object.freeze([
  'getReadiness',
  'getStatus',
  'restartGeneration',
  'reconcilePageCommit',
]);

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
const PINNED_OBJECT_FREEZE =
  typeof Object.freeze === 'function' ? Object.freeze : null;
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
  && PINNED_OBJECT_FREEZE
  && PINNED_IS_FROZEN
  && PINNED_HAS_OWN
  && PINNED_OBJECT_PROTOTYPE,
);

function pinnedFreeze(value) {
  return PINNED_OBJECT_FREEZE.call(Object, value);
}

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', {
    value: 'EmailDeltaOperatorRecoveryCompositionError',
  });
  Object.defineProperty(error, 'code', { value: ERROR_CODE, enumerable: true });
  return pinnedFreeze(error);
}

function isProxySurface(value) {
  try {
    if (!PINNED_INTRINSICS_READY) return true;
    return PINNED_REFLECT_APPLY.call(Reflect, PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

function safeHasOwn(object, key) {
  try {
    if (!PINNED_HAS_OWN || object == null) return false;
    return PINNED_HAS_OWN.call(object, key) === true;
  } catch {
    return false;
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
        || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
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

/**
 * Side-effect-free readiness (Staff API safe). No owner construction.
 * @param {object} [env]
 */
function resolveEmailDeltaOperatorRecoveryReadiness(env) {
  try {
    return parseEmailDeltaOperatorRecoveryConfig(
      env === undefined ? process.env : env,
    );
  } catch {
    return parseEmailDeltaOperatorRecoveryConfig({});
  }
}

/**
 * Explicit factory. Enabled env required; disabled → throw (route conceals first).
 *
 * @param {{
 *   env: object,
 *   pgClient: object,
 *   withTransactionClient: Function,
 * }} deps
 */
function createEmailDeltaOperatorRecoverySunsetStagingRuntime(deps) {
  try {
    if (deps == null || isProxySurface(deps) || !exactPlainData(deps, DEPENDENCY_KEYS)) {
      throw failure();
    }
    const env = ownData(deps, 'env');
    const pgClient = ownData(deps, 'pgClient');
    const withTxnRaw = ownData(deps, 'withTransactionClient');

    if (isProxySurface(env) || isProxySurface(pgClient) || isProxySurface(withTxnRaw)) {
      throw failure();
    }
    if (!isEmailDeltaOperatorRecoveryEnabled(env)) {
      throw failure();
    }
    if (!pgClient || typeof pgClient !== 'object' || typeof pgClient.query !== 'function') {
      throw failure();
    }
    // Reject Pool-shaped surfaces (must be exclusive client loan).
    if (typeof pgClient.connect === 'function'
        && (typeof pgClient.totalCount === 'number' || typeof pgClient.idleCount === 'number')) {
      throw failure();
    }
    if (typeof withTxnRaw !== 'function') throw failure();

    // Capture exclusive loan once — never checkout/release/close.
    async function withTransactionClient(work) {
      return withTxnRaw(work);
    }

    const dbSurface = pinnedFreeze({
      query(...args) {
        return Reflect.apply(pgClient.query, pgClient, args);
      },
    });

    const authorityVerifier = createDelegatedReadAuthorityBindingVerifier(
      Object.freeze({ db: dbSurface }),
    );

    const inboundDeltaStateStore = createInboundEmailDeltaStateStore(Object.freeze({
      withTransactionClient,
      authorityVerifier,
    }));

    async function resolveAuthorityBinding(input) {
      return resolveDelegatedReadAuthorityBinding(input, Object.freeze({ db: dbSurface }));
    }

    const service = createEmailDeltaOperatorRecoveryService(Object.freeze({
      withTransactionClient,
      authorityVerifier,
      inboundDeltaStateStore,
      resolveAuthorityBinding,
    }));

    const readiness = parseEmailDeltaOperatorRecoveryConfig(env);

    function getReadiness() {
      return readiness;
    }

    async function getStatus(input) {
      return service.getStatus(input);
    }

    async function restartGeneration(input) {
      return service.restartGeneration(input);
    }

    async function reconcilePageCommit(input) {
      return service.reconcilePageCommit(input);
    }

    const surface = pinnedFreeze({
      getReadiness,
      getStatus,
      restartGeneration,
      reconcilePageCommit,
    });

    // Exact public key set.
    const keys = PINNED_REFLECT_OWN_KEYS.call(Reflect, surface);
    if (keys.length !== SURFACE_KEYS.length
        || SURFACE_KEYS.some((k, i) => keys[i] !== k)) {
      throw failure();
    }
    return surface;
  } catch (err) {
    if (err && err.code === ERROR_CODE) throw err;
    throw failure();
  }
}

module.exports = pinnedFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  QUERY_VERSION,
  MIGRATION_065_ID,
  MIGRATION_064_ID,
  ENV_OPERATOR_RECOVERY_ENABLED,
  DEPENDENCY_KEYS,
  SURFACE_KEYS,
  READINESS_KEYS,
  CONFIG_STATUS,
  SERVICE_OUTCOME,
  EMAIL_DELTA_OPERATOR_RECOVERY_RUNTIME_WIRED,
  EMAIL_DELTA_OPERATOR_RECOVERY_IMPORT_INERT,
  EMAIL_DELTA_OPERATOR_RECOVERY_SAFE_FOR_SCHEDULER,
  EMAIL_DELTA_OPERATOR_RECOVERY_WORKER_PRESENT,
  isEmailDeltaOperatorRecoveryEnabled,
  resolveEmailDeltaOperatorRecoveryReadiness,
  parseEmailDeltaOperatorRecoveryConfig,
  createEmailDeltaOperatorRecoverySunsetStagingRuntime,
});
