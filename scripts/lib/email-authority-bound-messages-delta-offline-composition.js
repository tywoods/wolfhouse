'use strict';

/**
 * Offline import-inert composition: authority-bound Microsoft Graph
 * messages-delta one-page durable operation.
 *
 * Purpose: wire the operation to existing merged owners only —
 *   resolveDelegatedReadAuthorityBinding + factory-fixed binding verifier,
 *   fresh one-shot grant-session factory per run,
 *   PR409 messages-delta page transport,
 *   PR408 createInboundEmailDeltaStateStore / envelopeProvider /
 *   withTransactionClient.
 *
 * Import-inert: zero credential/session/transport/DB construction at require.
 * Explicit factory only. Default-off flags; **not** referenced by production
 * routes, cron, startup, diagnostic, or capture compositions.
 *
 * Transaction loan is exclusively PR408 withTransactionClient.
 * No second SQL/BEGIN/network/crypto/refresh/URL-parser owner.
 * No multipage / auto generation rollover / live Graph / Azure / deploy.
 *
 * @module email-authority-bound-messages-delta-offline-composition
 */

const util = require('util');

const {
  createAuthorityBoundMessagesDeltaPageOperation,
  DEPENDENCY_KEYS: OP_DEPENDENCY_KEYS,
  RESULT_KEYS,
  ATTEMPT_SURFACE_KEYS,
  FAILURE_CODE,
  INPUT_KEYS,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_RUNTIME_WIRED,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_SAFE_FOR_RUNTIME_ROUTE_CRON,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_AUTO_BEGIN_GENERATION,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_MULTIPAGE,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_CALLER_DURABILITY_LIFECYCLE_READY,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_ATTEMPT_API_REQUIRED_FOR_RUNTIME,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_DIRECT_RUN_ACTIVATION_INELIGIBLE,
} = require('./email-authority-bound-messages-delta-page-operation');

const ERROR_CODE = 'AUTHORITY_BOUND_MESSAGES_DELTA_OFFLINE_COMPOSITION_INVALID';
const ERROR_MESSAGE = 'Authority-bound messages-delta offline composition failed.';

const EMAIL_MESSAGES_DELTA_OFFLINE_COMPOSITION_RUNTIME_WIRED = false;
const EMAIL_MESSAGES_DELTA_OFFLINE_COMPOSITION_IMPORT_INERT = true;

const COMPOSITION_DEPENDENCY_KEYS = Object.freeze([
  'db',
  'createGrantSession',
  'messagesDeltaPageTransport',
  'withTransactionClient',
  'envelopeProvider',
]);

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;

if (EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_RUNTIME_WIRED !== false) {
  throw new Error('messages_delta_offline_composition_op_runtime_wired');
}
if (EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_SAFE_FOR_RUNTIME_ROUTE_CRON !== false) {
  throw new Error('messages_delta_offline_composition_unexpected_runtime_safe');
}
if (EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_AUTO_BEGIN_GENERATION !== false) {
  throw new Error('messages_delta_offline_composition_unexpected_auto_generation');
}
if (EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_MULTIPAGE !== false) {
  throw new Error('messages_delta_offline_composition_unexpected_multipage');
}
if (EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_CALLER_DURABILITY_LIFECYCLE_READY !== false) {
  throw new Error('messages_delta_offline_composition_caller_durability_ready');
}
if (EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_ATTEMPT_API_REQUIRED_FOR_RUNTIME !== true) {
  throw new Error('messages_delta_offline_composition_attempt_api_required');
}
if (EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_DIRECT_RUN_ACTIVATION_INELIGIBLE !== true) {
  throw new Error('messages_delta_offline_composition_direct_run_eligible');
}

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', {
    value: 'AuthorityBoundMessagesDeltaOfflineCompositionError',
  });
  Object.defineProperty(error, 'code', { value: ERROR_CODE, enumerable: true });
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
  return Object.isFrozen(object) && exactPlainData(object, keys);
}

function snapshotInput(input) {
  try {
    if (!exactPlainData(input, INPUT_KEYS) && !exactFrozenData(input, INPUT_KEYS)) {
      return null;
    }
    const clientId = ownData(input, 'clientId');
    const locationId = ownData(input, 'locationId');
    const endpointId = ownData(input, 'endpointId');
    if (typeof clientId !== 'string' || !UUID_CANON.test(clientId)) return null;
    if (typeof locationId !== 'string' || !UUID_CANON.test(locationId)) return null;
    if (typeof endpointId !== 'string' || !UUID_CANON.test(endpointId)) return null;
    return Object.freeze({ clientId, locationId, endpointId });
  } catch {
    return null;
  }
}

/**
 * Offline composition factory.
 *
 * Pins trusted db / grant-session factory / messages-delta transport /
 * exclusive-client transaction loaner / envelope provider. Per run: constructs
 * the operation once at factory time; each run creates a fresh one-shot grant
 * session via the injected factory.
 *
 * @param {{
 *   db: object,
 *   createGrantSession: Function,
 *   messagesDeltaPageTransport: object,
 *   withTransactionClient: Function,
 *   envelopeProvider: object,
 * }} deps
 * @returns {Readonly<{
 *   createPageAttempt: Function,
 *   runAuthorityBoundMessagesDeltaPageDurable: Function,
 * }>}
 */
function createOfflineAuthorityBoundMessagesDeltaComposition(deps) {
  let operation;
  try {
    if (deps == null || isProxySurface(deps)
        || (!exactPlainData(deps, COMPOSITION_DEPENDENCY_KEYS)
          && !exactFrozenData(deps, COMPOSITION_DEPENDENCY_KEYS))) {
      throw failure();
    }
    // Dependency key order matches operation factory (byte-compatible bag).
    if (COMPOSITION_DEPENDENCY_KEYS.length !== OP_DEPENDENCY_KEYS.length
        || COMPOSITION_DEPENDENCY_KEYS.some((k, i) => k !== OP_DEPENDENCY_KEYS[i])) {
      throw failure();
    }
    operation = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: ownData(deps, 'db'),
      createGrantSession: ownData(deps, 'createGrantSession'),
      messagesDeltaPageTransport: ownData(deps, 'messagesDeltaPageTransport'),
      withTransactionClient: ownData(deps, 'withTransactionClient'),
      envelopeProvider: ownData(deps, 'envelopeProvider'),
    }));
  } catch (err) {
    if (err && err.code === ERROR_CODE) throw err;
    throw failure();
  }

  /**
   * Opaque retry-stable page attempt (preferred). Activation requires a caller
   * durability lifecycle before worker runtime may use this path.
   *
   * @param {object} input exact { clientId, locationId, endpointId }
   * @returns {Readonly<{run:Function,reconcile:Function,status:Function}>}
   */
  function createPageAttempt(input) {
    const ids = snapshotInput(input);
    if (!ids) throw failure();
    try {
      const attempt = operation.createPageAttempt(ids);
      if (!attempt || typeof attempt !== 'object') throw failure();
      if (!exactFrozenData(attempt, ATTEMPT_SURFACE_KEYS)) throw failure();
      return attempt;
    } catch (err) {
      if (err && err.code === FAILURE_CODE) throw failure();
      throw failure();
    }
  }

  /**
   * Direct single-shot offline path — activation-ineligible (ephemeral attempt).
   * Prefer createPageAttempt for same-ID replay/reconcile.
   *
   * @param {object} input exact { clientId, locationId, endpointId }
   * @returns {Promise<object>} frozen RESULT_KEYS identity-free result
   */
  async function runAuthorityBoundMessagesDeltaPageDurable(input) {
    const ids = snapshotInput(input);
    if (!ids) throw failure();

    let out;
    try {
      out = await operation.runAuthorityBoundMessagesDeltaPage(ids);
    } catch (err) {
      if (err && err.code === FAILURE_CODE) throw failure();
      throw failure();
    }
    if (!out || out.ok !== true || !out.value) throw failure();
    if (!exactFrozenData(out.value, RESULT_KEYS)) throw failure();
    const status = ownData(out.value, 'status');
    if (typeof status !== 'string' || status.length < 1) throw failure();
    return out.value;
  }

  return Object.freeze({
    createPageAttempt,
    runAuthorityBoundMessagesDeltaPageDurable,
  });
}

module.exports = Object.freeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  COMPOSITION_DEPENDENCY_KEYS,
  RESULT_KEYS,
  EMAIL_MESSAGES_DELTA_OFFLINE_COMPOSITION_RUNTIME_WIRED,
  EMAIL_MESSAGES_DELTA_OFFLINE_COMPOSITION_IMPORT_INERT,
  createOfflineAuthorityBoundMessagesDeltaComposition,
});
