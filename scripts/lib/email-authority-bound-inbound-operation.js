'use strict';

/**
 * Authority-bound inbound email operation (UNWIRED composition).
 *
 * One internal operation, exact call order:
 *   1) resolveDelegatedReadAuthority (merged custodian repository)
 *   2) runWithAccessTokenOnce via trusted injected one-shot grant-session
 *      capability (callback-scoped; never a returned/exported token source)
 *   3) Private session callback alone invokes ImmutableId page transport with
 *      authority.providerMailboxId only (double-scrub loan + transport input)
 *   4) processInboundEmailBatch exactly once with factory-fixed consumer
 *
 * Access tokens never come from caller input. Caller input is exact
 * `{ clientId, locationId, endpointId }` only — no token / provider / mailbox /
 * address / status / generation / consumer. Dependencies are trusted executable
 * code and exact frozen/snapshotted services; consumer is fixed at factory
 * construction. The `db` dependency is resolved at factory into a private
 * frozen minimal query adapter (captured query + trusted original receiver);
 * execution never re-reads the caller's mutable db/query. Returns only frozen
 * sanitized identity-free status/counts.
 *
 * Does **not** reimplement lease → open → refresh → reseal → CAS (no
 * refresh/custody duplication; no second lease/SQL/refresh owner). Token
 * provenance is the injected grant-session capability alone. No envelope/PII/
 * token/authority DTO escape/log/retention. Default-off / unreferenced by
 * runtime/routes. No DB migration, OAuth scope change, deploy, live I/O, or
 * persistence.
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

const GRANT_SESSION_KEYS = Object.freeze(['runWithAccessTokenOnce']);
const TRANSPORT_KEYS = Object.freeze(['listNormalizedInboundEnvelopes']);
const GRANT_SESSION_CALL_KEYS = Object.freeze(['clientId', 'endpointId']);
const LOAN_KEYS = Object.freeze(['accessToken']);
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

/**
 * Accept mutable one-shot loan from grant-session callback.
 * Exact own-data LOAN_KEYS only; non-empty printable accessToken.
 * Does not require frozen (loan must stay mutable for scrub).
 *
 * @param {object} loan
 * @returns {string|null}
 */
function acceptLoanAccessToken(loan) {
  if (!exactPlainData(loan, LOAN_KEYS)) return null;
  const token = ownData(loan, 'accessToken');
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

/**
 * Resolve a genuine pg-like `query` capability without instance [[Get]].
 * Own data-function descriptor wins; else prototype-chain data function
 * (realistic node-postgres Client/Pool put query on the prototype, often
 * non-enumerable). Own/prototype accessor or non-function → reject.
 * Proxies rejected before any prototype/descriptor walk. Fail-closed on
 * hostile/custom prototype/accessor/symbol-only surfaces.
 *
 * Mirrors the reviewed custodian `resolveReadAuthorityQueryMethod` pattern
 * (not exported from that module — kept local so we do not expand custodian
 * surface). Does **not** probe pool-shape properties (connect/totalCount/
 * idleCount) — those would execute hostile getters for no security gain.
 *
 * @param {object|function} surface
 * @returns {Function|null}
 */
function resolvePgLikeQueryMethod(surface) {
  try {
    if (!surface || (typeof surface !== 'object' && typeof surface !== 'function')) {
      return null;
    }
    if (isProxySurface(surface)) return null;
    const own = Object.getOwnPropertyDescriptor(surface, 'query');
    if (own) {
      if (Object.prototype.hasOwnProperty.call(own, 'value')
          && typeof own.value === 'function'
          && !own.get
          && !own.set) {
        return own.value;
      }
      // Own accessor / non-function data — reject without executing getter.
      return null;
    }
    let proto = Object.getPrototypeOf(surface);
    let depth = 0;
    while (proto && proto !== Object.prototype && depth < 8) {
      if (isProxySurface(proto)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'query');
      if (descriptor) {
        if (Object.prototype.hasOwnProperty.call(descriptor, 'value')
            && typeof descriptor.value === 'function'
            && !descriptor.get
            && !descriptor.set) {
          return descriptor.value;
        }
        // Hostile prototype accessor / non-function — fail closed, no [[Get]].
        return null;
      }
      proto = Object.getPrototypeOf(proto);
      depth += 1;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Factory-time db dependency snapshot.
 *
 * Captures the validated query function once and returns a **private frozen
 * minimal adapter** whose `query` always `Reflect.apply`s that captured
 * function to the **original receiver** (the trusted executable dependency
 * surface). `resolveDelegatedReadAuthority` is given only this adapter —
 * never the caller's mutable db, and never re-reads original db/query at
 * execution. Post-factory mutation/replacement of the caller's `query` must
 * therefore call the old captured function exactly once and the new zero.
 *
 * Trusted receiver note: genuine pg Client/Pool prototype methods require the
 * original client/pool as `this` (connection state lives on the instance).
 * The adapter deliberately re-binds to that original receiver; the injected
 * query implementation remains a trusted executable dependency and is not
 * sandboxed.
 *
 * @param {object|function} db
 * @returns {{query: Function}|null} frozen private adapter, or null
 */
function resolveDb(db) {
  try {
    if (db == null || (typeof db !== 'object' && typeof db !== 'function')) return null;
    if (isProxySurface(db)) return null;

    const capturedQuery = resolvePgLikeQueryMethod(db);
    if (typeof capturedQuery !== 'function') return null;
    if (isProxySurface(capturedQuery)) return null;

    // Pin original receiver once. Never re-resolve query from caller surface.
    const trustedReceiver = db;
    const adapter = Object.freeze({
      query(...args) {
        return Reflect.apply(capturedQuery, trustedReceiver, args);
      },
    });
    return adapter;
  } catch {
    return null;
  }
}

function resolveGrantSession(grantSession) {
  try {
    if (!exactFrozenData(grantSession, GRANT_SESSION_KEYS)) return null;
    const fn = ownData(grantSession, 'runWithAccessTokenOnce');
    if (typeof fn !== 'function' || isProxySurface(fn)) return null;
    return Object.freeze({ runWithAccessTokenOnce: fn });
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

    // 2) Access token only through trusted callback-scoped grant-session.
    // Identity for the session comes from authority DTO — never caller token fields.
    // Private callback alone owns ImmutableId transport + double-scrub + batch.
    try {
      const sessionInput = Object.freeze({
        clientId: authority.clientId,
        endpointId: authority.endpointId,
      });
      // Defensive key order check (exact GRANT_SESSION_CALL_KEYS).
      if (!exactFrozenData(sessionInput, GRANT_SESSION_CALL_KEYS)) {
        return failResult(FAILURE_CODE);
      }

      let sessionOut;
      try {
        sessionOut = await Reflect.apply(
          grantSession.runWithAccessTokenOnce,
          grantSession,
          [
            sessionInput,
            async function authorityBoundSessionConsumer(loan) {
              // Private callback: ImmutableId transport then batch. No second
              // lease/SQL/refresh owner here.
              const accessTokenOwner = acceptLoanAccessToken(loan);
              if (accessTokenOwner === null) {
                throw failure();
              }

              let graphInput = null;
              try {
                graphInput = {
                  accessToken: accessTokenOwner,
                  provider_mailbox_id: authority.providerMailboxId,
                };
                // Double-scrub loan immediately after copying into transport input.
                try { loan.accessToken = null; } catch { /* */ }

                let envelopes;
                try {
                  envelopes = await Reflect.apply(
                    transport.listNormalizedInboundEnvelopes,
                    transport,
                    [graphInput],
                  );
                } finally {
                  if (graphInput) {
                    try { graphInput.accessToken = null; } catch { /* */ }
                    graphInput = null;
                  }
                }

                const accepted = acceptEnvelopeArray(envelopes);
                if (!accepted) throw failure();
                if (!envelopesMatchAuthority(accepted, authority)) {
                  throw failure();
                }

                // Batch processor exactly once — factory-fixed consumer only.
                let batchResult;
                try {
                  batchResult = await processInboundEmailBatch({
                    envelopes: accepted,
                    consumer,
                  });
                } catch {
                  throw failure();
                }

                const publicCounts = acceptBatchSuccess(batchResult);
                batchResult = null;
                if (!publicCounts) throw failure();
                return publicCounts;
              } finally {
                if (graphInput) {
                  try { graphInput.accessToken = null; } catch { /* */ }
                  graphInput = null;
                }
                if (loan) {
                  try { loan.accessToken = null; } catch { /* */ }
                }
              }
            },
          ],
        );
      } catch {
        return failResult(FAILURE_CODE);
      }

      // Pre-CAS / CAS failure from real session → zero transport/batch (callback
      // never ran). Injected mocks may return the same ok:false shape.
      if (!sessionOut || sessionOut.ok !== true) {
        return failResult(FAILURE_CODE);
      }

      const publicCounts = sessionOut.value;
      if (!publicCounts
          || !exactFrozenData(publicCounts, RESULT_KEYS)
          || ownData(publicCounts, 'status') !== 'processed') {
        return failResult(FAILURE_CODE);
      }
      return okResult(publicCounts);
    } catch {
      return failResult(FAILURE_CODE);
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
  LOAN_KEYS,
  RESULT_KEYS,
  EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_RUNTIME_WIRED,
  EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_PERSISTENCE_READY,
  EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_LOGGING_FORBIDDEN,
  EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_DUPLICATES_REFRESH_CUSTODY,
  createAuthorityBoundInboundOperation,
});
