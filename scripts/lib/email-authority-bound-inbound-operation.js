'use strict';

/**
 * Authority-bound inbound email operation (UNWIRED composition).
 *
 * One internal operation, exact call order:
 *   1) resolveDelegatedReadAuthority (merged custodian repository)
 *   2) obtainAccessTokenOnce via trusted injected one-shot grant-session capability
 *   3) ImmutableId page transport with authority.providerMailboxId only
 *   4) processInboundEmailBatch exactly once with factory-fixed consumer
 *
 * Access tokens never come from caller input. Caller input is exact
 * `{ clientId, locationId, endpointId }` only — no token / provider / mailbox /
 * address / status / generation / consumer. Dependencies are trusted executable
 * code and exact frozen/snapshotted services; consumer is fixed at factory
 * construction. Returns only frozen sanitized identity-free status/counts.
 *
 * Does **not** reimplement lease → open → refresh → reseal → CAS (no
 * refresh/custody duplication). Token provenance is the injected grant-session
 * capability alone. No envelope/PII/token/authority DTO escape/log/retention.
 * Default-off / unreferenced by runtime/routes. No DB migration, OAuth scope
 * change, deploy, live I/O, or persistence.
 *
 * @module email-authority-bound-inbound-operation
 */

const util = require('util');

const {
  resolveDelegatedReadAuthority,
  DELEGATED_READ_AUTHORITY_INPUT_KEYS,
  DELEGATED_READ_AUTHORITY_DTO_KEYS,
  EMAIL_DELEGATED_READ_AUTHORITY_RUNTIME_WIRED,
} = require('./email-delegated-grant-custodian');
const {
  processInboundEmailBatch,
  EMAIL_INBOUND_BATCH_PROCESSOR_RUNTIME_WIRED,
} = require('./email-inbound-batch-processor');

const FAILURE_CODE = 'authority_bound_inbound_failed';
const FAILURE_MESSAGE = 'Authority-bound inbound operation failed.';

const EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_RUNTIME_WIRED = false;
const EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_PERSISTENCE_READY = false;
const EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_LOGGING_FORBIDDEN = true;
const EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_DUPLICATES_REFRESH_CUSTODY = false;

/** Exact ordered own-data caller input keys (matches read-authority resolve). */
const INPUT_KEYS = DELEGATED_READ_AUTHORITY_INPUT_KEYS;

/** Exact ordered factory dependency keys. */
const DEPENDENCY_KEYS = Object.freeze([
  'db',
  'grantSession',
  'immutableIdPageTransport',
  'consumer',
]);

const GRANT_SESSION_KEYS = Object.freeze(['obtainAccessTokenOnce']);
const TRANSPORT_KEYS = Object.freeze(['listNormalizedInboundEnvelopes']);
const GRANT_SESSION_CALL_KEYS = Object.freeze(['clientId', 'endpointId']);
const TOKEN_RESULT_KEYS = Object.freeze(['accessToken']);
const RESULT_KEYS = Object.freeze([
  'status',
  'input_count',
  'delivered_count',
  'duplicate_count',
]);

const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_LIMIT = 16_384;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// Module-init pins: ambient isProxy monkeypatches after load must not weaken detection.
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;
const PINNED_ARRAY_PROTOTYPE = Array.prototype;

if (EMAIL_DELEGATED_READ_AUTHORITY_RUNTIME_WIRED !== false) {
  throw new Error('authority_bound_inbound_read_authority_runtime_wired');
}
if (EMAIL_INBOUND_BATCH_PROCESSOR_RUNTIME_WIRED !== false) {
  throw new Error('authority_bound_inbound_batch_runtime_wired');
}

function failure() {
  const error = new Error(FAILURE_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'AuthorityBoundInboundOperationError' });
  Object.defineProperty(error, 'code', { value: FAILURE_CODE, enumerable: true });
  return Object.freeze(error);
}

function failResult(error) {
  return Object.freeze({ ok: false, error: String(error || FAILURE_CODE) });
}

function okResult(value) {
  return Object.freeze({ ok: true, value: Object.freeze({ ...value }) });
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
  if (!exactPlainData(input, INPUT_KEYS)) return null;
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
}

function acceptAuthorityDto(value) {
  if (!exactFrozenData(value, DELEGATED_READ_AUTHORITY_DTO_KEYS)) return null;
  const clientId = ownData(value, 'clientId');
  const locationId = ownData(value, 'locationId');
  const endpointId = ownData(value, 'endpointId');
  const provider = ownData(value, 'provider');
  const providerMailboxId = ownData(value, 'providerMailboxId');
  const bindingStatus = ownData(value, 'bindingStatus');
  if (typeof clientId !== 'string' || !UUID_CANON.test(clientId)) return null;
  if (typeof locationId !== 'string' || !UUID_CANON.test(locationId)) return null;
  if (typeof endpointId !== 'string' || !UUID_CANON.test(endpointId)) return null;
  if (provider !== 'microsoft_graph') return null;
  if (typeof providerMailboxId !== 'string' || !UUID_CANON.test(providerMailboxId)) return null;
  if (bindingStatus !== 'verified') return null;
  // Fresh freeze — never return the repository object further.
  return Object.freeze({
    clientId,
    locationId,
    endpointId,
    provider,
    providerMailboxId,
    bindingStatus,
  });
}

function acceptAccessTokenResult(value) {
  if (!exactPlainData(value, TOKEN_RESULT_KEYS)) return null;
  const token = ownData(value, 'accessToken');
  if (typeof token !== 'string' || token.length < 1 || token.length > TOKEN_LIMIT
      || !/^[\x21-\x7e]+$/.test(token)) {
    return null;
  }
  return token;
}

function acceptEnvelopeArray(value) {
  try {
    if (value == null || typeof value !== 'object') return null;
    if (isProxySurface(value)) return null;
    if (!Array.isArray(value)) return null;
    if (Object.getPrototypeOf(value) !== PINNED_ARRAY_PROTOTYPE) return null;
    if (!Object.isFrozen(value)) return null;
    const len = value.length;
    if (typeof len !== 'number' || !Number.isInteger(len) || len < 0 || len > 5) return null;
    for (let i = 0; i < len; i += 1) {
      const env = value[i];
      if (!env || typeof env !== 'object' || isProxySurface(env) || !Object.isFrozen(env)) {
        return null;
      }
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * Reject transport envelopes that do not match resolved authority mailbox.
 * Prevents mislabeled batches when a hostile transport stamps a foreign id.
 *
 * @param {object[]} envelopes
 * @param {{provider:string,providerMailboxId:string}} authority
 * @returns {boolean}
 */
function envelopesMatchAuthority(envelopes, authority) {
  try {
    for (let i = 0; i < envelopes.length; i += 1) {
      const env = envelopes[i];
      const provider = ownData(env, 'provider');
      const mailbox = ownData(env, 'provider_mailbox_id');
      if (provider !== authority.provider || mailbox !== authority.providerMailboxId) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function acceptBatchSuccess(result) {
  if (!result || result.ok !== true || !exactFrozenData(result.value, RESULT_KEYS)) {
    return null;
  }
  const v = result.value;
  if (ownData(v, 'status') !== 'processed') return null;
  const inputCount = ownData(v, 'input_count');
  const deliveredCount = ownData(v, 'delivered_count');
  const duplicateCount = ownData(v, 'duplicate_count');
  if (!Number.isInteger(inputCount) || inputCount < 0 || inputCount > 5) return null;
  if (!Number.isInteger(deliveredCount) || deliveredCount < 0 || deliveredCount > inputCount) {
    return null;
  }
  if (!Number.isInteger(duplicateCount) || duplicateCount < 0
      || duplicateCount !== inputCount - deliveredCount) {
    return null;
  }
  return Object.freeze({
    status: 'processed',
    input_count: inputCount,
    delivered_count: deliveredCount,
    duplicate_count: duplicateCount,
  });
}

function resolveDb(db) {
  try {
    if (db == null || (typeof db !== 'object' && typeof db !== 'function')) return null;
    if (isProxySurface(db)) return null;
    // Pool-shaped surfaces rejected (read-authority uses single-query executor).
    if (typeof db.connect === 'function'
        && (typeof db.totalCount === 'number' || typeof db.idleCount === 'number')) {
      return null;
    }
    const query = ownData(db, 'query');
    if (typeof query !== 'function') return null;
    if (isProxySurface(query)) return null;
    return db;
  } catch {
    return null;
  }
}

function resolveGrantSession(grantSession) {
  try {
    if (!exactFrozenData(grantSession, GRANT_SESSION_KEYS)) return null;
    const fn = ownData(grantSession, 'obtainAccessTokenOnce');
    if (typeof fn !== 'function' || isProxySurface(fn)) return null;
    return Object.freeze({ obtainAccessTokenOnce: fn });
  } catch {
    return null;
  }
}

function resolveTransport(transport) {
  try {
    if (!exactFrozenData(transport, TRANSPORT_KEYS)) return null;
    const fn = ownData(transport, 'listNormalizedInboundEnvelopes');
    if (typeof fn !== 'function' || isProxySurface(fn)) return null;
    return Object.freeze({ listNormalizedInboundEnvelopes: fn });
  } catch {
    return null;
  }
}

function resolveConsumer(consumer) {
  try {
    if (typeof consumer !== 'function' || isProxySurface(consumer)) return null;
    return consumer;
  } catch {
    return null;
  }
}

/**
 * Factory: pin trusted dependencies; consumer fixed at construction.
 *
 * @param {object} deps exact frozen ordered DEPENDENCY_KEYS bag
 * @returns {{ runAuthorityBoundInbound: Function }}
 */
function createAuthorityBoundInboundOperation(deps) {
  let db;
  let grantSession;
  let transport;
  let consumer;
  try {
    if (!exactFrozenData(deps, DEPENDENCY_KEYS)) throw failure();
    db = resolveDb(ownData(deps, 'db'));
    grantSession = resolveGrantSession(ownData(deps, 'grantSession'));
    transport = resolveTransport(ownData(deps, 'immutableIdPageTransport'));
    consumer = resolveConsumer(ownData(deps, 'consumer'));
    if (!db || !grantSession || !transport || !consumer) throw failure();
  } catch (err) {
    if (err && err.code === FAILURE_CODE) throw err;
    throw failure();
  }

  let used = false;

  /**
   * @param {object} input exact own-data { clientId, locationId, endpointId }
   * @returns {Promise<{ok:true,value:object}|{ok:false,error:string}>}
   */
  async function runAuthorityBoundInbound(input) {
    if (used) return failResult(FAILURE_CODE);
    used = true;

    const ids = snapshotInput(input);
    if (!ids) return failResult(FAILURE_CODE);

    // 1) Authority resolve — merged custodian repository only.
    let authorityRaw;
    try {
      authorityRaw = await resolveDelegatedReadAuthority(ids, { db });
    } catch {
      return failResult(FAILURE_CODE);
    }
    if (!authorityRaw || authorityRaw.ok !== true) {
      return failResult(FAILURE_CODE);
    }
    const authority = acceptAuthorityDto(authorityRaw.value);
    authorityRaw = null;
    if (!authority) return failResult(FAILURE_CODE);

    // Caller input ids must match resolved authority (no silent rebinding).
    if (authority.clientId !== ids.clientId
        || authority.locationId !== ids.locationId
        || authority.endpointId !== ids.endpointId) {
      return failResult(FAILURE_CODE);
    }

    // 2) Access token only through trusted one-shot grant-session capability.
    // Identity for the session comes from authority DTO — never caller token fields.
    let accessTokenOwner = null;
    let graphInput = null;
    try {
      const sessionInput = Object.freeze({
        clientId: authority.clientId,
        endpointId: authority.endpointId,
      });
      // Defensive key order check (exact GRANT_SESSION_CALL_KEYS).
      if (!exactFrozenData(sessionInput, GRANT_SESSION_CALL_KEYS)) {
        return failResult(FAILURE_CODE);
      }

      let tokenResult;
      try {
        tokenResult = await Reflect.apply(
          grantSession.obtainAccessTokenOnce,
          grantSession,
          [sessionInput],
        );
      } catch {
        return failResult(FAILURE_CODE);
      }

      accessTokenOwner = acceptAccessTokenResult(tokenResult);
      tokenResult = null;
      if (accessTokenOwner === null) return failResult(FAILURE_CODE);

      // 3) ImmutableId transport — authority.providerMailboxId only.
      graphInput = {
        accessToken: accessTokenOwner,
        provider_mailbox_id: authority.providerMailboxId,
      };
      accessTokenOwner = null;

      let envelopes;
      try {
        envelopes = await Reflect.apply(
          transport.listNormalizedInboundEnvelopes,
          transport,
          [graphInput],
        );
      } catch {
        return failResult(FAILURE_CODE);
      } finally {
        if (graphInput) {
          try { graphInput.accessToken = null; } catch { /* */ }
          graphInput = null;
        }
        accessTokenOwner = null;
      }

      const accepted = acceptEnvelopeArray(envelopes);
      if (!accepted) return failResult(FAILURE_CODE);
      if (!envelopesMatchAuthority(accepted, authority)) {
        return failResult(FAILURE_CODE);
      }

      // 4) Batch processor exactly once — factory-fixed consumer only.
      let batchResult;
      try {
        batchResult = await processInboundEmailBatch({
          envelopes: accepted,
          consumer,
        });
      } catch {
        return failResult(FAILURE_CODE);
      }

      const publicCounts = acceptBatchSuccess(batchResult);
      batchResult = null;
      if (!publicCounts) return failResult(FAILURE_CODE);
      return okResult(publicCounts);
    } finally {
      if (graphInput) {
        try { graphInput.accessToken = null; } catch { /* */ }
        graphInput = null;
      }
      accessTokenOwner = null;
    }
  }

  return Object.freeze({ runAuthorityBoundInbound });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  FAILURE_MESSAGE,
  INPUT_KEYS,
  DEPENDENCY_KEYS,
  GRANT_SESSION_KEYS,
  TRANSPORT_KEYS,
  GRANT_SESSION_CALL_KEYS,
  TOKEN_RESULT_KEYS,
  RESULT_KEYS,
  EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_RUNTIME_WIRED,
  EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_PERSISTENCE_READY,
  EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_LOGGING_FORBIDDEN,
  EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_DUPLICATES_REFRESH_CUSTODY,
  createAuthorityBoundInboundOperation,
});
