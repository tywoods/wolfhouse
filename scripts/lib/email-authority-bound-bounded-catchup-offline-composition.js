'use strict';

/**
 * Offline import-inert composition: authority-bound **bounded catchup** +
 * durable inbound event-store consumer.
 *
 * Purpose: wire the bounded-catchup operation to the **existing** event-store
 * consumer so SQL/transaction ownership stays solely with
 * `email-inbound-event-store` — no second DB owner, no duplicated insert path.
 *
 * Import-inert: zero credential/session/transport/DB construction at require.
 * Explicit factory only. Default-off flags; **not** referenced by production
 * Sunset event-store / diagnostic runtime compositions, routes, cron, or
 * startup. Those production paths remain on the single-page max-5 operation.
 *
 * Does **not** claim a durable mailbox cursor/delta. Replaying >50 identities
 * can return the newest 50 forever (`truncated:true`) — must not be promoted to
 * runtime/route/cron until a durable cursor exists.
 *
 * @module email-authority-bound-bounded-catchup-offline-composition
 */

const util = require('util');

const {
  createAuthorityBoundBoundedCatchupOperation,
  BOUNDED_CATCHUP_DEPENDENCY_KEYS,
  BOUNDED_CATCHUP_RESULT_KEYS,
  BOUNDED_CATCHUP_FAILURE_CODE,
  INPUT_KEYS,
  EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_RUNTIME_WIRED,
  EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_HAS_DURABLE_CURSOR,
  EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_SAFE_FOR_RUNTIME_ROUTE_CRON,
} = require('./email-authority-bound-inbound-operation');
const {
  createDurableInboundEventStoreConsumer,
  EMAIL_INBOUND_EVENT_STORE_RUNTIME_WIRED,
  resolveWithTransactionClient,
} = require('./email-inbound-event-store');

const ERROR_CODE = 'AUTHORITY_BOUND_BOUNDED_CATCHUP_OFFLINE_COMPOSITION_INVALID';
const ERROR_MESSAGE = 'Authority-bound bounded catchup offline composition failed.';

const EMAIL_BOUNDED_CATCHUP_OFFLINE_COMPOSITION_RUNTIME_WIRED = false;
const EMAIL_BOUNDED_CATCHUP_OFFLINE_COMPOSITION_IMPORT_INERT = true;

const COMPOSITION_DEPENDENCY_KEYS = Object.freeze([
  'db',
  'grantSession',
  'immutableIdBoundedCatchupTransport',
  'withTransactionClient',
]);

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Module-init pins.
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;

if (EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_RUNTIME_WIRED !== false) {
  throw new Error('bounded_catchup_offline_composition_catchup_runtime_wired');
}
if (EMAIL_INBOUND_EVENT_STORE_RUNTIME_WIRED !== false) {
  throw new Error('bounded_catchup_offline_composition_event_store_runtime_wired');
}
if (EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_HAS_DURABLE_CURSOR !== false) {
  throw new Error('bounded_catchup_offline_composition_unexpected_durable_cursor');
}
if (EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_SAFE_FOR_RUNTIME_ROUTE_CRON !== false) {
  throw new Error('bounded_catchup_offline_composition_unexpected_runtime_safe');
}

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', {
    value: 'AuthorityBoundBoundedCatchupOfflineCompositionError',
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
    return Object.freeze({
      clientId,
      locationId,
      endpointId,
    });
  } catch {
    return null;
  }
}

function resolveGrantSession(grantSession) {
  try {
    if (!grantSession || typeof grantSession !== 'object' || isProxySurface(grantSession)) {
      return null;
    }
    if (!exactFrozenData(grantSession, Object.freeze(['runWithAccessTokenOnce']))) {
      return null;
    }
    const fn = ownData(grantSession, 'runWithAccessTokenOnce');
    if (typeof fn !== 'function' || isProxySurface(fn)) return null;
    return Object.freeze({ runWithAccessTokenOnce: fn });
  } catch {
    return null;
  }
}

function resolveCatchupTransport(transport) {
  try {
    if (!transport || typeof transport !== 'object' || isProxySurface(transport)) {
      return null;
    }
    if (!exactFrozenData(
      transport,
      Object.freeze(['listBoundedCatchupInboundEnvelopes']),
    )) {
      return null;
    }
    const fn = ownData(transport, 'listBoundedCatchupInboundEnvelopes');
    if (typeof fn !== 'function' || isProxySurface(fn)) return null;
    return Object.freeze({ listBoundedCatchupInboundEnvelopes: fn });
  } catch {
    return null;
  }
}

/**
 * Offline composition factory.
 *
 * Pins trusted db / grant-session / catchup transport / exclusive-client
 * transaction loaner. Per run: builds the durable event-store consumer closed
 * over the caller's trusted UUIDs (event store remains sole SQL owner), then
 * constructs a one-shot bounded-catchup operation with that consumer.
 *
 * @param {{
 *   db: object,
 *   grantSession: object,
 *   immutableIdBoundedCatchupTransport: object,
 *   withTransactionClient: Function,
 * }} deps
 * @returns {Readonly<{ runAuthorityBoundBoundedCatchupDurable: Function }>}
 */
function createOfflineAuthorityBoundBoundedCatchupComposition(deps) {
  let db;
  let grantSession;
  let transport;
  let withTransactionClient;
  try {
    if (deps == null || isProxySurface(deps)
        || (!exactPlainData(deps, COMPOSITION_DEPENDENCY_KEYS)
          && !exactFrozenData(deps, COMPOSITION_DEPENDENCY_KEYS))) {
      throw failure();
    }
    db = ownData(deps, 'db');
    grantSession = resolveGrantSession(ownData(deps, 'grantSession'));
    transport = resolveCatchupTransport(
      ownData(deps, 'immutableIdBoundedCatchupTransport'),
    );
    withTransactionClient = resolveWithTransactionClient(
      ownData(deps, 'withTransactionClient'),
    );
    if (!db || (typeof db !== 'object' && typeof db !== 'function')) throw failure();
    if (isProxySurface(db)) throw failure();
    if (!grantSession || !transport || !withTransactionClient) throw failure();
  } catch (err) {
    if (err && err.code === ERROR_CODE) throw err;
    throw failure();
  }

  /**
   * @param {object} input exact { clientId, locationId, endpointId }
   * @returns {Promise<object>} frozen BOUNDED_CATCHUP_RESULT_KEYS durable-subset
   */
  async function runAuthorityBoundBoundedCatchupDurable(input) {
    const ids = snapshotInput(input);
    if (!ids) throw failure();

    // Event store remains sole SQL/transaction owner — composition only closes
    // the factory-fixed durable consumer over trusted authority UUIDs.
    let consumer;
    try {
      consumer = createDurableInboundEventStoreConsumer(Object.freeze({
        withTransactionClient,
        authority: ids,
      }));
    } catch {
      throw failure();
    }

    const operation = createAuthorityBoundBoundedCatchupOperation(Object.freeze({
      db,
      grantSession,
      immutableIdBoundedCatchupTransport: transport,
      consumer,
    }));

    let out;
    try {
      out = await operation.runAuthorityBoundBoundedCatchup(ids);
    } catch (err) {
      if (err && err.code === BOUNDED_CATCHUP_FAILURE_CODE) throw failure();
      throw failure();
    }
    if (!out || out.ok !== true || !out.value) throw failure();
    if (!exactFrozenData(out.value, BOUNDED_CATCHUP_RESULT_KEYS)) throw failure();
    if (ownData(out.value, 'status') !== 'processed') throw failure();
    if (ownData(out.value, 'durably_processed') !== true) throw failure();
    return out.value;
  }

  return Object.freeze({ runAuthorityBoundBoundedCatchupDurable });
}

module.exports = Object.freeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  COMPOSITION_DEPENDENCY_KEYS,
  BOUNDED_CATCHUP_DEPENDENCY_KEYS,
  BOUNDED_CATCHUP_RESULT_KEYS,
  EMAIL_BOUNDED_CATCHUP_OFFLINE_COMPOSITION_RUNTIME_WIRED,
  EMAIL_BOUNDED_CATCHUP_OFFLINE_COMPOSITION_IMPORT_INERT,
  createOfflineAuthorityBoundBoundedCatchupComposition,
});
