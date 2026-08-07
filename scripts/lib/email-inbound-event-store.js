'use strict';

/**
 * Inbound email event store — durable atomic idempotent persistence of
 * already-canonical inbound envelopes (offline store + factory-fixed consumer).
 *
 * - Reuses `validateInboundEmailEnvelope` (no second envelope contract).
 * - Factory-fixed trusted `withTransactionClient` capability (or existing
 *   repository equivalent such as `withPgClient`) loans an exclusively
 *   owned/dedicated client for the full transaction and releases only after
 *   the work callback settles. Descriptor/proxy-safe capture; no caller override.
 * - Every persist acquires its own dedicated connection; concurrent batches
 *   never share or interleave on one client.
 * - One transaction per delivered batch on the loaned client:
 *   BEGIN → insert-or-no-op per identity (ON CONFLICT DO NOTHING; no UPDATE)
 *   → COMMIT.
 * - Exact frozen `{ acknowledged: true }` only after conclusively successful
 *   COMMIT. Mid-batch failure → ROLLBACK all; no ack.
 * - Commit sent then post-commit rejection → sanitized failure only; no
 *   compensation, internal retry, or rollback claim (later replay converges).
 * - Provider/mailbox mismatch rejected before any SQL.
 * - Authority (clientId/locationId/endpointId) is factory-closed trusted UUIDs
 *   matching delegated-read DTO; never taken from envelope fields.
 * - location_id is tenant_locations.id UUID (not text kebab location_id).
 * - No logging of envelope/PII field values.
 *
 * @module email-inbound-event-store
 */

const util = require('util');

const {
  validateInboundEmailEnvelope,
  EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN,
} = require('./email-inbound-envelope-contract');

const FAILURE_CODE = 'inbound_event_store_failed';
const FAILURE_MESSAGE = 'Inbound email event store operation failed.';

/** Store module is not wired into routes/startup/pollers by itself. */
const EMAIL_INBOUND_EVENT_STORE_RUNTIME_WIRED = false;

/** This module is the reviewed authorized durable writer for canonical envelopes. */
const EMAIL_INBOUND_EVENT_STORE_PERSISTENCE_AUTHORIZED = true;

/** Must never log envelope field values (PII). */
const EMAIL_INBOUND_EVENT_STORE_LOGGING_FORBIDDEN =
  EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN === true;

const AUTHORITY_KEYS = Object.freeze(['clientId', 'locationId', 'endpointId']);
const ACK_KEYS = Object.freeze(['acknowledged']);
/** Exact store factory dependency: exclusive transaction-client loaner only. */
const STORE_DEPENDENCY_KEYS = Object.freeze(['withTransactionClient']);
const CONSUMER_DEPENDENCY_KEYS = Object.freeze(['withTransactionClient', 'authority']);

const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_BATCH = 50;

const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;
const PINNED_ARRAY_PROTOTYPE = Array.prototype;

/**
 * Insert-or-no-op by exact canonical identity.
 * internet_message_id is a value column only (not conflict target).
 */
const SQL_INSERT_EVENT = `
INSERT INTO tenant_email_inbound_events (
  client_id,
  location_id,
  endpoint_id,
  provider,
  provider_mailbox_id,
  provider_message_id,
  received_at,
  subject,
  sender_display_name,
  sender_address,
  is_read,
  conversation_id,
  internet_message_id
) VALUES (
  $1::uuid, $2::uuid, $3::uuid,
  $4, $5, $6,
  $7::timestamptz,
  $8, $9, $10,
  $11::boolean,
  $12, $13
)
ON CONFLICT (provider, provider_mailbox_id, provider_message_id) DO NOTHING
`.replace(/\s+/g, ' ').trim();

function failure(code) {
  const error = new Error(FAILURE_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'InboundEmailEventStoreError' });
  Object.defineProperty(error, 'code', {
    value: typeof code === 'string' && code ? code : FAILURE_CODE,
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

/**
 * Resolve a genuine pg-like `query` without instance [[Get]] traps where possible.
 * Mirrors authority-bound / custodian descriptor walk (own data-fn, else prototype).
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
 * Pin a loaned exclusive client to a private frozen query adapter.
 * Captures query once for this loan; never re-reads caller mutable surfaces.
 *
 * @param {object|function} client
 * @returns {{query: Function}|null}
 */
function resolveExclusiveClient(client) {
  try {
    if (client == null || (typeof client !== 'object' && typeof client !== 'function')) {
      return null;
    }
    if (isProxySurface(client)) return null;
    const capturedQuery = resolvePgLikeQueryMethod(client);
    if (typeof capturedQuery !== 'function' || isProxySurface(capturedQuery)) return null;
    const trustedReceiver = client;
    return Object.freeze({
      query(...args) {
        return Reflect.apply(capturedQuery, trustedReceiver, args);
      },
    });
  } catch {
    return null;
  }
}

/**
 * Factory-time capture of trusted `withTransactionClient` (or withPgClient-equivalent).
 * Signature: async (work) => work(exclusiveClient). Releases only after settle.
 * Descriptor/proxy-safe; no re-read of caller dependency at execution.
 *
 * @param {unknown} raw
 * @returns {Function|null}
 */
function resolveWithTransactionClient(raw) {
  try {
    if (typeof raw !== 'function' || isProxySurface(raw)) return null;
    const captured = raw;
    return async function pinnedWithTransactionClient(work) {
      if (typeof work !== 'function' || isProxySurface(work)) {
        throw failure();
      }
      return Reflect.apply(captured, undefined, [
        async function exclusiveLoan(client) {
          const exclusive = resolveExclusiveClient(client);
          if (!exclusive) throw failure();
          return work(exclusive);
        },
      ]);
    };
  } catch {
    return null;
  }
}

function snapshotAuthority(authority) {
  try {
    // Accept plain or frozen own-data exact AUTHORITY_KEYS (Object.prototype).
    if (!exactPlainData(authority, AUTHORITY_KEYS)) return null;
    const clientId = ownData(authority, 'clientId');
    const locationId = ownData(authority, 'locationId');
    const endpointId = ownData(authority, 'endpointId');
    if (typeof clientId !== 'string' || !UUID_CANON.test(clientId)) return null;
    if (typeof locationId !== 'string' || !UUID_CANON.test(locationId)) return null;
    if (typeof endpointId !== 'string' || !UUID_CANON.test(endpointId)) return null;
    return Object.freeze({ clientId, locationId, endpointId });
  } catch {
    return null;
  }
}

function acceptEnvelopeArray(value) {
  try {
    if (value == null || typeof value !== 'object') return null;
    if (isProxySurface(value)) return null;
    if (!Array.isArray(value)) return null;
    if (Object.getPrototypeOf(value) !== PINNED_ARRAY_PROTOTYPE) return null;
    const len = value.length;
    if (typeof len !== 'number' || !Number.isInteger(len) || len < 0 || len > MAX_BATCH) {
      return null;
    }
    for (let i = 0; i < len; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) return null;
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * Validate entire batch + exact single (provider, mailbox) prefix before SQL.
 * @returns {{ok:true,envelopes:object[],provider:string,mailbox:string}|{ok:false}}
 */
function prepareCanonicalBatch(rawEnvelopes) {
  const arr = acceptEnvelopeArray(rawEnvelopes);
  if (!arr) return { ok: false };
  const prepared = new Array(arr.length);
  for (let i = 0; i < arr.length; i += 1) {
    const v = validateInboundEmailEnvelope(arr[i]);
    if (!v.ok) return { ok: false };
    prepared[i] = v.value;
  }
  if (prepared.length === 0) {
    return { ok: true, envelopes: Object.freeze([]), provider: null, mailbox: null };
  }
  const provider = prepared[0].provider;
  const mailbox = prepared[0].provider_mailbox_id;
  for (let i = 1; i < prepared.length; i += 1) {
    if (prepared[i].provider !== provider
        || prepared[i].provider_mailbox_id !== mailbox) {
      // Provider/mailbox mismatch before SQL.
      return { ok: false };
    }
  }
  return {
    ok: true,
    envelopes: Object.freeze(prepared.slice()),
    provider,
    mailbox,
  };
}

function buildInsertParams(authority, envelope) {
  return [
    authority.clientId,
    authority.locationId,
    authority.endpointId,
    envelope.provider,
    envelope.provider_mailbox_id,
    envelope.provider_message_id,
    envelope.received_at,
    envelope.subject,
    envelope.sender_display_name,
    envelope.sender_address,
    envelope.is_read,
    envelope.conversation_id,
    envelope.internet_message_id,
  ];
}

/**
 * Best-effort ROLLBACK on an exclusive loaned client.
 * Never claims success/failure of rollback to callers.
 * @param {{query: Function}} client
 */
async function attemptRollback(client) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Intentionally swallowed — no rollback claim / no compensation.
  }
}

/**
 * Run BEGIN → inserts → COMMIT on one exclusive loaned client.
 *
 * @param {{query: Function}} client
 * @param {{clientId:string,locationId:string,endpointId:string}} authority
 * @param {object[]} envelopes
 * @returns {Promise<{ok:true}|{ok:false,error:string}>}
 */
async function runBatchTransaction(client, authority, envelopes) {
  let begun = false;
  let commitSent = false;
  try {
    await client.query('BEGIN');
    begun = true;
    for (let i = 0; i < envelopes.length; i += 1) {
      await client.query(SQL_INSERT_EVENT, buildInsertParams(authority, envelopes[i]));
    }
    commitSent = true;
    await client.query('COMMIT');
  } catch {
    if (begun && !commitSent) {
      await attemptRollback(client);
    }
    // Commit sent then rejection: sanitized only — no ack, no compensation,
    // no internal retry, no rollback claim. Later replay converges via
    // ON CONFLICT DO NOTHING.
    return Object.freeze({
      ok: false,
      error: commitSent
        ? 'inbound_event_store_commit_outcome_unknown'
        : 'inbound_event_store_write_failed',
    });
  }
  return Object.freeze({ ok: true });
}

/**
 * Persist one delivered batch under a single exclusive-client transaction.
 * Acquires a dedicated connection for this invocation only.
 *
 * @param {Function} withTransactionClient
 * @param {{clientId:string,locationId:string,endpointId:string}} authority
 * @param {unknown} envelopes
 * @returns {Promise<{ok:true}|{ok:false,error:string}>}
 */
async function persistCanonicalBatch(withTransactionClient, authority, envelopes) {
  const prepared = prepareCanonicalBatch(envelopes);
  if (!prepared.ok) {
    return Object.freeze({ ok: false, error: 'inbound_event_store_batch_invalid' });
  }

  try {
    return await withTransactionClient(async (client) => (
      runBatchTransaction(client, authority, prepared.envelopes)
    ));
  } catch (err) {
    // Loaner failure / exclusive client rejection — sanitized write failure.
    // If the inner path already returned a structured result it is not thrown.
    if (err && err.code === FAILURE_CODE) {
      return Object.freeze({ ok: false, error: FAILURE_CODE });
    }
    return Object.freeze({ ok: false, error: 'inbound_event_store_write_failed' });
  }
}

/**
 * Factory-fixed durable consumer for the inbound batch processor.
 *
 * Closed over trusted authority UUIDs + withTransactionClient. Invoked once
 * per batch with a frozen envelope array. Returns exact `{ acknowledged: true }`
 * only after conclusively successful COMMIT on a dedicated loaned client.
 *
 * @param {{ withTransactionClient: Function, authority: {clientId:string,locationId:string,endpointId:string} }} deps
 * @returns {Function}
 */
function createDurableInboundEventStoreConsumer(deps) {
  let withTransactionClient;
  let authority;
  try {
    if (!exactPlainData(deps, CONSUMER_DEPENDENCY_KEYS)
        && !exactFrozenData(deps, CONSUMER_DEPENDENCY_KEYS)) {
      throw failure();
    }
    withTransactionClient = resolveWithTransactionClient(
      ownData(deps, 'withTransactionClient'),
    );
    authority = snapshotAuthority(ownData(deps, 'authority'));
    if (!withTransactionClient || !authority) throw failure();
  } catch (err) {
    if (err && err.code === FAILURE_CODE) throw err;
    throw failure();
  }

  /**
   * @param {unknown} envelopes
   * @returns {Promise<{acknowledged:true}>}
   */
  async function durableInboundEventStoreConsumer(envelopes) {
    const result = await persistCanonicalBatch(withTransactionClient, authority, envelopes);
    if (!result || result.ok !== true) {
      throw failure(result && result.error ? result.error : FAILURE_CODE);
    }
    // Exact frozen ack only after conclusive commit success.
    return Object.freeze({ acknowledged: true });
  }

  return durableInboundEventStoreConsumer;
}

/**
 * Create an event-store handle closed over a factory-fixed transaction loaner.
 *
 * @param {{ withTransactionClient: Function }} deps
 * @returns {{ createConsumer: Function, persistBatch: Function }}
 */
function createInboundEmailEventStore(deps) {
  let withTransactionClient;
  try {
    if (!exactPlainData(deps, STORE_DEPENDENCY_KEYS)
        && !exactFrozenData(deps, STORE_DEPENDENCY_KEYS)) {
      throw failure();
    }
    withTransactionClient = resolveWithTransactionClient(
      ownData(deps, 'withTransactionClient'),
    );
    if (!withTransactionClient) throw failure();
  } catch (err) {
    if (err && err.code === FAILURE_CODE) throw err;
    throw failure();
  }

  function createConsumer(authorityInput) {
    return createDurableInboundEventStoreConsumer(Object.freeze({
      withTransactionClient,
      authority: authorityInput,
    }));
  }

  /**
   * @param {{clientId:string,locationId:string,endpointId:string}} authorityInput
   * @param {unknown} envelopes
   */
  async function persistBatch(authorityInput, envelopes) {
    const authority = snapshotAuthority(authorityInput);
    if (!authority) {
      return Object.freeze({ ok: false, error: 'inbound_event_store_authority_invalid' });
    }
    return persistCanonicalBatch(withTransactionClient, authority, envelopes);
  }

  return Object.freeze({ createConsumer, persistBatch });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  FAILURE_MESSAGE,
  EMAIL_INBOUND_EVENT_STORE_RUNTIME_WIRED,
  EMAIL_INBOUND_EVENT_STORE_PERSISTENCE_AUTHORIZED,
  EMAIL_INBOUND_EVENT_STORE_LOGGING_FORBIDDEN,
  AUTHORITY_KEYS,
  ACK_KEYS,
  STORE_DEPENDENCY_KEYS,
  CONSUMER_DEPENDENCY_KEYS,
  SQL_INSERT_EVENT,
  createInboundEmailEventStore,
  createDurableInboundEventStoreConsumer,
  // Test/inspection helpers (pure; no network).
  prepareCanonicalBatch,
  snapshotAuthority,
  resolveWithTransactionClient,
  resolveExclusiveClient,
});
