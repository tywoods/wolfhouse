'use strict';

/**
 * Authority-bound inbound email operation (UNWIRED composition).
 *
 * Two factories share private authority resolution, grant-session callback
 * custody, one-shot token scrubbing, provider/mailbox matching, and
 * exactly-once batch invocation — **no** duplicated grant/refresh logic:
 *
 * 1) **Single-page (existing):** `createAuthorityBoundInboundOperation` /
 *    `runAuthorityBoundInbound`
 *      resolveDelegatedReadAuthority → runWithAccessTokenOnce →
 *      ImmutableId **page** transport (max-5 envelopes) →
 *      processInboundEmailBatch once (factory-fixed consumer) →
 *      frozen identity-free `{ status, input_count, delivered_count, duplicate_count }`
 *
 * 2) **Bounded catchup (this seam):** `createAuthorityBoundBoundedCatchupOperation` /
 *    `runAuthorityBoundBoundedCatchup`
 *      same authority + grant-session path → factory-fixed ImmutableId
 *      **bounded-catchup** transport (exact own-data frozen DTO; ≤50 frozen
 *      canonical envelopes; never inspect/follow/store nextLink) →
 *      authority-match every envelope → processInboundEmailBatch once →
 *      frozen identity-free durable-subset result **only after** consumer
 *      acknowledgement:
 *        `{ status, durably_processed:true, observed_count,
 *           durable_identity_count, duplicate_in_batch_count,
 *           pages_fetched, truncated }`
 *
 * Semantics (bounded catchup public result):
 * - `durable_identity_count` = batch `delivered_count` after consumer ack —
 *   committed insert-or-no-op **representation**, **not** newly inserted rows.
 * - `duplicate_in_batch_count` = batch processor `duplicate_count` only —
 *   **never** the transport DTO `duplicate_count` (transport dups are validated
 *   internally for count equations and discarded from the public surface).
 * - `truncated:false` is **not** a durable mailbox watermark / cursor claim.
 * - `truncated:true` means a subset committed while more may exist upstream.
 * - Without a durable cursor/delta, replaying a mailbox with >50 identities can
 *   return the newest 50 forever (`truncated:true` indefinitely). This seam
 *   must not be wired to runtime/route/cron/startup until that cursor exists.
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
 * production runtime/routes. No DB migration, OAuth scope change, deploy, live
 * I/O, or persistence from this module.
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
  EMAIL_INBOUND_BATCH_MAX,
} = require('./email-inbound-batch-processor');

const FAILURE_CODE = 'authority_bound_inbound_failed';
const FAILURE_MESSAGE = 'Authority-bound inbound operation failed.';
const BOUNDED_CATCHUP_FAILURE_CODE = 'authority_bound_bounded_catchup_failed';
const BOUNDED_CATCHUP_FAILURE_MESSAGE = 'Authority-bound bounded catchup operation failed.';

const EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_RUNTIME_WIRED = false;
const EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_PERSISTENCE_READY = false;
const EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_LOGGING_FORBIDDEN = true;
const EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_DUPLICATES_REFRESH_CUSTODY = false;

/** Bounded-catchup seam is also default-off / not production-wired. */
const EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_RUNTIME_WIRED = false;
const EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_PERSISTENCE_READY = false;
const EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_LOGGING_FORBIDDEN = true;
const EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_DUPLICATES_REFRESH_CUSTODY = false;
/** Explicit: no durable cursor/delta — >50 replay can repeat newest 50 forever. */
const EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_HAS_DURABLE_CURSOR = false;
const EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_SAFE_FOR_RUNTIME_ROUTE_CRON = false;

/** Exact ordered own-data caller input keys (matches read-authority resolve). */
const INPUT_KEYS = DELEGATED_READ_AUTHORITY_INPUT_KEYS;

/** Exact ordered factory dependency keys (single-page — byte-compatible). */
const DEPENDENCY_KEYS = Object.freeze([
  'db',
  'grantSession',
  'immutableIdPageTransport',
  'consumer',
]);

/** Exact ordered factory dependency keys (bounded catchup). */
const BOUNDED_CATCHUP_DEPENDENCY_KEYS = Object.freeze([
  'db',
  'grantSession',
  'immutableIdBoundedCatchupTransport',
  'consumer',
]);

const GRANT_SESSION_KEYS = Object.freeze(['runWithAccessTokenOnce']);
const TRANSPORT_KEYS = Object.freeze(['listNormalizedInboundEnvelopes']);
const BOUNDED_CATCHUP_TRANSPORT_KEYS = Object.freeze([
  'listBoundedCatchupInboundEnvelopes',
]);
const GRANT_SESSION_CALL_KEYS = Object.freeze(['clientId', 'endpointId']);
const LOAN_KEYS = Object.freeze(['accessToken']);

/** Single-page sanitized identity-free result keys (byte-compatible). */
const RESULT_KEYS = Object.freeze([
  'status',
  'input_count',
  'delivered_count',
  'duplicate_count',
]);

/**
 * Bounded-catchup durable-subset result keys (identity-free).
 * Ordered deliberately: status + durability claim, then observation/durable
 * counts, then transport page/truncation metadata. No IDs/PII/envelopes.
 */
const BOUNDED_CATCHUP_RESULT_KEYS = Object.freeze([
  'status',
  'durably_processed',
  'observed_count',
  'durable_identity_count',
  'duplicate_in_batch_count',
  'pages_fetched',
  'truncated',
]);

/** Exact ordered own-data keys of the catchup transport success DTO. */
const BOUNDED_CATCHUP_DTO_KEYS = Object.freeze([
  'envelopes',
  'pages_fetched',
  'observed_count',
  'unique_count',
  'duplicate_count',
  'truncated',
]);

/** Max envelopes accepted from catchup transport (= batch max). */
const BOUNDED_CATCHUP_MAX_ENVELOPES = EMAIL_INBOUND_BATCH_MAX;
const BOUNDED_CATCHUP_MAX_PAGES = 10;
const SINGLE_PAGE_MAX_ENVELOPES = 5;

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
if (typeof EMAIL_INBOUND_BATCH_MAX !== 'number' || EMAIL_INBOUND_BATCH_MAX !== 50) {
  throw new Error('authority_bound_inbound_batch_max_unexpected');
}

function failure(code, message) {
  const error = new Error(message || FAILURE_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'AuthorityBoundInboundOperationError' });
  Object.defineProperty(error, 'code', {
    value: code || FAILURE_CODE,
    enumerable: true,
  });
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

/**
 * Accept a frozen envelope array with a caller-supplied max length bound.
 * Descriptor/proxy-safe; intrinsic Array.prototype only.
 *
 * @param {unknown} value
 * @param {number} maxLen
 * @returns {object[]|null}
 */
function acceptEnvelopeArray(value, maxLen) {
  try {
    if (value == null || typeof value !== 'object') return null;
    if (isProxySurface(value)) return null;
    if (!Array.isArray(value)) return null;
    if (Object.getPrototypeOf(value) !== PINNED_ARRAY_PROTOTYPE) return null;
    if (!Object.isFrozen(value)) return null;
    const len = value.length;
    if (typeof len !== 'number' || !Number.isInteger(len) || len < 0 || len > maxLen) {
      return null;
    }
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
  if (!Number.isInteger(inputCount) || inputCount < 0 || inputCount > SINGLE_PAGE_MAX_ENVELOPES) {
    return null;
  }
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
 * Accept catchup transport success DTO — exact frozen own-data keys/types/count
 * equations, ≤50 frozen canonical envelopes. Never reads or stores nextLink
 * (extra keys fail closed). Transport `duplicate_count` is validated only for
 * internal equations and is **not** mapped to the public durable result.
 *
 * @param {unknown} value
 * @returns {{envelopes:object[],pages_fetched:number,observed_count:number,unique_count:number,transport_duplicate_count:number,truncated:boolean}|null}
 */
function acceptCatchupTransportDto(value) {
  try {
    if (!exactFrozenData(value, BOUNDED_CATCHUP_DTO_KEYS)) return null;

    // Explicit non-follow: refuse any nextLink-shaped key even if keyset changes.
    // (exactFrozenData already rejects extras; this documents the contract.)
    if (Object.prototype.hasOwnProperty.call(value, 'nextLink')
        || Object.prototype.hasOwnProperty.call(value, '@odata.nextLink')
        || Object.prototype.hasOwnProperty.call(value, 'next_link')) {
      return null;
    }

    const pagesFetched = ownData(value, 'pages_fetched');
    const observedCount = ownData(value, 'observed_count');
    const uniqueCount = ownData(value, 'unique_count');
    const transportDuplicateCount = ownData(value, 'duplicate_count');
    const truncated = ownData(value, 'truncated');
    const envelopesRaw = ownData(value, 'envelopes');

    if (!Number.isInteger(pagesFetched)
        || pagesFetched < 0
        || pagesFetched > BOUNDED_CATCHUP_MAX_PAGES) {
      return null;
    }
    if (!Number.isInteger(observedCount) || observedCount < 0) return null;
    if (!Number.isInteger(uniqueCount) || uniqueCount < 0
        || uniqueCount > BOUNDED_CATCHUP_MAX_ENVELOPES) {
      return null;
    }
    if (!Number.isInteger(transportDuplicateCount) || transportDuplicateCount < 0) {
      return null;
    }
    if (truncated !== true && truncated !== false) return null;

    // Count equation on transport DTO (internal only).
    if (observedCount !== uniqueCount + transportDuplicateCount) return null;

    const envelopes = acceptEnvelopeArray(envelopesRaw, BOUNDED_CATCHUP_MAX_ENVELOPES);
    if (!envelopes) return null;
    if (envelopes.length !== uniqueCount) return null;

    // Empty success still requires a completed fetch (pages_fetched ≥ 1 when
    // transport succeeded with zero messages is allowed as 0 or 1 by transport;
    // accept both non-negative integers already checked above).

    return Object.freeze({
      envelopes,
      pages_fetched: pagesFetched,
      observed_count: observedCount,
      unique_count: uniqueCount,
      transport_duplicate_count: transportDuplicateCount,
      truncated: truncated === true,
    });
  } catch {
    return null;
  }
}

/**
 * Map batch processor success + accepted catchup transport meta → durable-subset
 * public result. `duplicate_in_batch_count` comes **only** from the batch
 * processor; transport duplicate_count is never exported here.
 *
 * @param {object} batchResult
 * @param {{observed_count:number,pages_fetched:number,truncated:boolean,unique_count:number}} meta
 * @returns {object|null}
 */
function acceptCatchupBatchSuccess(batchResult, meta) {
  try {
    if (!batchResult || batchResult.ok !== true
        || !exactFrozenData(batchResult.value, RESULT_KEYS)) {
      return null;
    }
    const v = batchResult.value;
    if (ownData(v, 'status') !== 'processed') return null;
    const inputCount = ownData(v, 'input_count');
    const deliveredCount = ownData(v, 'delivered_count');
    const batchDuplicateCount = ownData(v, 'duplicate_count');
    if (!Number.isInteger(inputCount) || inputCount < 0
        || inputCount > BOUNDED_CATCHUP_MAX_ENVELOPES) {
      return null;
    }
    if (!Number.isInteger(deliveredCount) || deliveredCount < 0
        || deliveredCount > inputCount) {
      return null;
    }
    if (!Number.isInteger(batchDuplicateCount) || batchDuplicateCount < 0
        || batchDuplicateCount !== inputCount - deliveredCount) {
      return null;
    }
    // Batch input must match the accepted unique envelope set from transport.
    if (inputCount !== meta.unique_count) return null;

    const out = {
      status: 'processed',
      durably_processed: true,
      observed_count: meta.observed_count,
      // Committed insert-or-no-op representation (not newly-inserted row count).
      durable_identity_count: deliveredCount,
      // From batch processor only — not transport DTO duplicate_count.
      duplicate_in_batch_count: batchDuplicateCount,
      pages_fetched: meta.pages_fetched,
      truncated: meta.truncated === true,
    };
    const keys = Object.keys(out);
    if (keys.length !== BOUNDED_CATCHUP_RESULT_KEYS.length
        || keys.some((k, i) => k !== BOUNDED_CATCHUP_RESULT_KEYS[i])) {
      return null;
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
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

function resolveCatchupTransport(transport) {
  try {
    if (!exactFrozenData(transport, BOUNDED_CATCHUP_TRANSPORT_KEYS)) return null;
    const fn = ownData(transport, 'listBoundedCatchupInboundEnvelopes');
    if (typeof fn !== 'function' || isProxySurface(fn)) return null;
    return Object.freeze({ listBoundedCatchupInboundEnvelopes: fn });
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
 * Shared: resolve authority for exact caller ids via merged custodian repository.
 * @returns {Promise<object|null>} frozen accepted authority DTO or null
 */
async function resolveAcceptedAuthority(ids, db) {
  let authorityRaw;
  try {
    authorityRaw = await resolveDelegatedReadAuthority(ids, { db });
  } catch {
    return null;
  }
  if (!authorityRaw || authorityRaw.ok !== true) {
    return null;
  }
  const authority = acceptAuthorityDto(authorityRaw.value);
  authorityRaw = null;
  if (!authority) return null;

  // Caller input ids must match resolved authority (no silent rebinding).
  if (authority.clientId !== ids.clientId
      || authority.locationId !== ids.locationId
      || authority.endpointId !== ids.endpointId) {
    return null;
  }
  return authority;
}

/**
 * Shared private session body: loan scrub → transport graphInput (double-scrub)
 * → invoke `onTransportResult` → return its public value. Grant/refresh never
 * reimplemented here.
 *
 * @param {object} loan
 * @param {object} authority
 * @param {Function} invokeTransport async (graphInput) => unknown
 * @param {Function} onTransportResult async (transportResult) => frozen public value
 * @param {string} failCode
 */
async function runTokenScopedTransportAndProcess(
  loan,
  authority,
  invokeTransport,
  onTransportResult,
  failCode,
) {
  // Private callback: transport then batch. No second lease/SQL/refresh owner
  // here. Nullable local owner released in finally (reference nulling only)
  // after graphInput scrub — also on pre-input failures before graphInput is
  // created.
  let accessTokenOwner = null;
  let graphInput = null;
  try {
    accessTokenOwner = acceptLoanAccessToken(loan);
    if (accessTokenOwner === null) {
      throw failure(failCode);
    }

    graphInput = {
      accessToken: accessTokenOwner,
      provider_mailbox_id: authority.providerMailboxId,
    };
    // Double-scrub loan immediately after copying into transport input.
    try { loan.accessToken = null; } catch { /* */ }

    let transportResult;
    try {
      transportResult = await invokeTransport(graphInput);
    } finally {
      if (graphInput) {
        try { graphInput.accessToken = null; } catch { /* */ }
        graphInput = null;
      }
    }

    return await onTransportResult(transportResult);
  } finally {
    // Independent scrubs: graphInput first, then local owner, then loan.
    if (graphInput) {
      try { graphInput.accessToken = null; } catch { /* */ }
      graphInput = null;
    }
    accessTokenOwner = null;
    if (loan) {
      try { loan.accessToken = null; } catch { /* */ }
    }
  }
}

/**
 * Shared: invoke grant-session once with private consumer callback.
 *
 * @param {object} grantSession
 * @param {object} authority
 * @param {Function} sessionConsumer async (loan) => frozen public value
 * @param {string} failCode
 * @param {ReadonlyArray<string>} resultKeys
 * @param {Function} acceptPublicValue (value) => boolean
 */
async function runWithGrantSession(
  grantSession,
  authority,
  sessionConsumer,
  failCode,
  resultKeys,
  acceptPublicValue,
) {
  const sessionInput = Object.freeze({
    clientId: authority.clientId,
    endpointId: authority.endpointId,
  });
  // Defensive key order check (exact GRANT_SESSION_CALL_KEYS).
  if (!exactFrozenData(sessionInput, GRANT_SESSION_CALL_KEYS)) {
    return failResult(failCode);
  }

  let sessionOut;
  try {
    sessionOut = await Reflect.apply(
      grantSession.runWithAccessTokenOnce,
      grantSession,
      [sessionInput, sessionConsumer],
    );
  } catch {
    return failResult(failCode);
  }

  // Pre-CAS / CAS failure from real session → zero transport/batch (callback
  // never ran). Injected mocks may return the same ok:false shape.
  if (!sessionOut || sessionOut.ok !== true) {
    return failResult(failCode);
  }

  const publicValue = sessionOut.value;
  if (!publicValue
      || !exactFrozenData(publicValue, resultKeys)
      || !acceptPublicValue(publicValue)) {
    return failResult(failCode);
  }
  return okResult(publicValue);
}

/**
 * Factory: pin trusted dependencies; consumer fixed at construction.
 * Single-page ImmutableId path (max-5). Existing export/dependency keys preserved.
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

    // 1) Authority resolve — merged custodian repository only (shared helper).
    const authority = await resolveAcceptedAuthority(ids, db);
    if (!authority) return failResult(FAILURE_CODE);

    // 2) Access token only through trusted callback-scoped grant-session.
    // Private callback alone owns ImmutableId transport + double-scrub + batch.
    try {
      return await runWithGrantSession(
        grantSession,
        authority,
        async function authorityBoundSessionConsumer(loan) {
          return runTokenScopedTransportAndProcess(
            loan,
            authority,
            async (graphInput) => Reflect.apply(
              transport.listNormalizedInboundEnvelopes,
              transport,
              [graphInput],
            ),
            async (envelopes) => {
              const accepted = acceptEnvelopeArray(envelopes, SINGLE_PAGE_MAX_ENVELOPES);
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
            },
            FAILURE_CODE,
          );
        },
        FAILURE_CODE,
        RESULT_KEYS,
        (v) => ownData(v, 'status') === 'processed',
      );
    } catch {
      return failResult(FAILURE_CODE);
    }
  }

  return Object.freeze({ runAuthorityBoundInbound });
}

/**
 * Factory: pin trusted dependencies for **bounded catchup** durable-subset seam.
 * Transport dependency is factory-fixed (`listBoundedCatchupInboundEnvelopes`)
 * and must return the exact own-data frozen catchup DTO. Consumer fixed at
 * construction. Shares private authority/grant-session/scrub/match/batch path
 * with the single-page factory — does **not** duplicate grant/refresh logic.
 *
 * Never inspects, follows, or stores nextLink. Does not claim a durable
 * mailbox watermark when truncated:false. Must not be wired to runtime/route/
 * cron/startup while EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_HAS_DURABLE_CURSOR
 * remains false.
 *
 * @param {object} deps exact frozen ordered BOUNDED_CATCHUP_DEPENDENCY_KEYS bag
 * @returns {{ runAuthorityBoundBoundedCatchup: Function }}
 */
function createAuthorityBoundBoundedCatchupOperation(deps) {
  let db;
  let grantSession;
  let transport;
  let consumer;
  try {
    if (!exactFrozenData(deps, BOUNDED_CATCHUP_DEPENDENCY_KEYS)) {
      throw failure(BOUNDED_CATCHUP_FAILURE_CODE, BOUNDED_CATCHUP_FAILURE_MESSAGE);
    }
    db = resolveDb(ownData(deps, 'db'));
    grantSession = resolveGrantSession(ownData(deps, 'grantSession'));
    transport = resolveCatchupTransport(
      ownData(deps, 'immutableIdBoundedCatchupTransport'),
    );
    consumer = resolveConsumer(ownData(deps, 'consumer'));
    if (!db || !grantSession || !transport || !consumer) {
      throw failure(BOUNDED_CATCHUP_FAILURE_CODE, BOUNDED_CATCHUP_FAILURE_MESSAGE);
    }
  } catch (err) {
    if (err && err.code === BOUNDED_CATCHUP_FAILURE_CODE) throw err;
    throw failure(BOUNDED_CATCHUP_FAILURE_CODE, BOUNDED_CATCHUP_FAILURE_MESSAGE);
  }

  let used = false;

  /**
   * @param {object} input exact own-data { clientId, locationId, endpointId }
   * @returns {Promise<{ok:true,value:object}|{ok:false,error:string}>}
   */
  async function runAuthorityBoundBoundedCatchup(input) {
    if (used) return failResult(BOUNDED_CATCHUP_FAILURE_CODE);
    used = true;

    const ids = snapshotInput(input);
    if (!ids) return failResult(BOUNDED_CATCHUP_FAILURE_CODE);

    // 1) Shared authority resolve — merged custodian repository only.
    const authority = await resolveAcceptedAuthority(ids, db);
    if (!authority) return failResult(BOUNDED_CATCHUP_FAILURE_CODE);

    // 2) Shared grant-session + token custody; private catchup callback owns
    //    catchup transport DTO validation (no nextLink), authority match, and
    //    exactly-once batch with factory-fixed consumer.
    try {
      return await runWithGrantSession(
        grantSession,
        authority,
        async function authorityBoundCatchupSessionConsumer(loan) {
          return runTokenScopedTransportAndProcess(
            loan,
            authority,
            async (graphInput) => Reflect.apply(
              transport.listBoundedCatchupInboundEnvelopes,
              transport,
              [graphInput],
            ),
            async (dto) => {
              const accepted = acceptCatchupTransportDto(dto);
              if (!accepted) {
                throw failure(
                  BOUNDED_CATCHUP_FAILURE_CODE,
                  BOUNDED_CATCHUP_FAILURE_MESSAGE,
                );
              }
              if (!envelopesMatchAuthority(accepted.envelopes, authority)) {
                throw failure(
                  BOUNDED_CATCHUP_FAILURE_CODE,
                  BOUNDED_CATCHUP_FAILURE_MESSAGE,
                );
              }

              // Batch processor exactly once — factory-fixed consumer only.
              // Transport duplicate_count is intentionally not passed through.
              let batchResult;
              try {
                batchResult = await processInboundEmailBatch({
                  envelopes: accepted.envelopes,
                  consumer,
                });
              } catch {
                throw failure(
                  BOUNDED_CATCHUP_FAILURE_CODE,
                  BOUNDED_CATCHUP_FAILURE_MESSAGE,
                );
              }

              const publicCounts = acceptCatchupBatchSuccess(batchResult, {
                observed_count: accepted.observed_count,
                pages_fetched: accepted.pages_fetched,
                truncated: accepted.truncated,
                unique_count: accepted.unique_count,
              });
              batchResult = null;
              if (!publicCounts) {
                throw failure(
                  BOUNDED_CATCHUP_FAILURE_CODE,
                  BOUNDED_CATCHUP_FAILURE_MESSAGE,
                );
              }
              return publicCounts;
            },
            BOUNDED_CATCHUP_FAILURE_CODE,
          );
        },
        BOUNDED_CATCHUP_FAILURE_CODE,
        BOUNDED_CATCHUP_RESULT_KEYS,
        (v) => ownData(v, 'status') === 'processed'
          && ownData(v, 'durably_processed') === true,
      );
    } catch {
      return failResult(BOUNDED_CATCHUP_FAILURE_CODE);
    }
  }

  return Object.freeze({ runAuthorityBoundBoundedCatchup });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  FAILURE_MESSAGE,
  BOUNDED_CATCHUP_FAILURE_CODE,
  BOUNDED_CATCHUP_FAILURE_MESSAGE,
  INPUT_KEYS,
  DEPENDENCY_KEYS,
  BOUNDED_CATCHUP_DEPENDENCY_KEYS,
  GRANT_SESSION_KEYS,
  TRANSPORT_KEYS,
  BOUNDED_CATCHUP_TRANSPORT_KEYS,
  GRANT_SESSION_CALL_KEYS,
  LOAN_KEYS,
  RESULT_KEYS,
  BOUNDED_CATCHUP_RESULT_KEYS,
  BOUNDED_CATCHUP_DTO_KEYS,
  BOUNDED_CATCHUP_MAX_ENVELOPES,
  BOUNDED_CATCHUP_MAX_PAGES,
  EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_RUNTIME_WIRED,
  EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_PERSISTENCE_READY,
  EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_LOGGING_FORBIDDEN,
  EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_DUPLICATES_REFRESH_CUSTODY,
  EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_RUNTIME_WIRED,
  EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_PERSISTENCE_READY,
  EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_LOGGING_FORBIDDEN,
  EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_DUPLICATES_REFRESH_CUSTODY,
  EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_HAS_DURABLE_CURSOR,
  EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_SAFE_FOR_RUNTIME_ROUTE_CRON,
  createAuthorityBoundInboundOperation,
  createAuthorityBoundBoundedCatchupOperation,
});
