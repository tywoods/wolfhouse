'use strict';

/**
 * Inbound email event store — durable atomic idempotent persistence of
 * already-canonical inbound envelopes (offline store + factory-fixed consumer).
 *
 * - Reuses `validateInboundEmailEnvelope` (no second envelope contract).
 * - One transaction per delivered batch: BEGIN → insert-or-no-op per identity
 *   (ON CONFLICT DO NOTHING; no UPDATE) → COMMIT.
 * - Exact frozen `{ acknowledged: true }` only after conclusively successful
 *   COMMIT. Mid-batch failure → ROLLBACK all; no ack.
 * - Commit sent then post-commit rejection → sanitized failure only; no
 *   compensation, internal retry, or rollback claim (later replay converges).
 * - Provider/mailbox mismatch rejected before any SQL.
 * - Authority (clientId/locationId/endpointId) is factory-closed trusted UUIDs
 *   matching delegated-read DTO; never taken from envelope fields.
 * - location_id is tenant_locations.id UUID (not text kebab location_id).
 * - Descriptor/proxy-safe db dependency boundary (module-init isProxy pin).
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
const STORE_DEPENDENCY_KEYS = Object.freeze(['db']);

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
 * Factory-time db snapshot → private frozen minimal query adapter.
 * Captures query once; never re-reads caller mutable db/query at execution.
 *
 * @param {object|function} db
 * @returns {{query: Function}|null}
 */
function resolveDb(db) {
  try {
    if (db == null || (typeof db !== 'object' && typeof db !== 'function')) return null;
    if (isProxySurface(db)) return null;
    const capturedQuery = resolvePgLikeQueryMethod(db);
    if (typeof capturedQuery !== 'function' || isProxySurface(capturedQuery)) return null;
    const trustedReceiver = db;
    return Object.freeze({
      query(...args) {
        return Reflect.apply(capturedQuery, trustedReceiver, args);
      },
    });
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
 * Best-effort ROLLBACK. Never claims success/failure of rollback to callers.
 * @param {{query: Function}} db
 */
async function attemptRollback(db) {
  try {
    await db.query('ROLLBACK');
  } catch {
    // Intentionally swallowed — no rollback claim / no compensation.
  }
}

/**
 * Persist one delivered batch under a single transaction.
 *
 * @param {{query: Function}} db
 * @param {{clientId:string,locationId:string,endpointId:string}} authority
 * @param {unknown} envelopes
 * @returns {Promise<{ok:true}|{ok:false,error:string}>}
 */
async function persistCanonicalBatch(db, authority, envelopes) {
  const prepared = prepareCanonicalBatch(envelopes);
  if (!prepared.ok) {
    return Object.freeze({ ok: false, error: 'inbound_event_store_batch_invalid' });
  }

  let begun = false;
  let commitSent = false;
  try {
    await db.query('BEGIN');
    begun = true;
    for (let i = 0; i < prepared.envelopes.length; i += 1) {
      await db.query(SQL_INSERT_EVENT, buildInsertParams(authority, prepared.envelopes[i]));
    }
    commitSent = true;
    await db.query('COMMIT');
  } catch {
    if (begun && !commitSent) {
      await attemptRollback(db);
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
 * Factory-fixed durable consumer for the inbound batch processor.
 *
 * Closed over trusted authority UUIDs + db adapter. Invoked once per batch
 * with a frozen envelope array. Returns exact `{ acknowledged: true }` only
 * after conclusively successful COMMIT.
 *
 * @param {{ db: object, authority: {clientId:string,locationId:string,endpointId:string} }} deps
 * @returns {Function}
 */
const CONSUMER_DEPENDENCY_KEYS = Object.freeze(['db', 'authority']);

function createDurableInboundEventStoreConsumer(deps) {
  let db;
  let authority;
  try {
    if (!exactPlainData(deps, CONSUMER_DEPENDENCY_KEYS)
        && !exactFrozenData(deps, CONSUMER_DEPENDENCY_KEYS)) {
      throw failure();
    }
    db = resolveDb(ownData(deps, 'db'));
    authority = snapshotAuthority(ownData(deps, 'authority'));
    if (!db || !authority) throw failure();
  } catch (err) {
    if (err && err.code === FAILURE_CODE) throw err;
    throw failure();
  }

  /**
   * @param {unknown} envelopes
   * @returns {Promise<{acknowledged:true}>}
   */
  async function durableInboundEventStoreConsumer(envelopes) {
    const result = await persistCanonicalBatch(db, authority, envelopes);
    if (!result || result.ok !== true) {
      throw failure(result && result.error ? result.error : FAILURE_CODE);
    }
    // Exact frozen ack only after conclusive commit success.
    return Object.freeze({ acknowledged: true });
  }

  return durableInboundEventStoreConsumer;
}

/**
 * Create an event-store handle with a private db adapter.
 *
 * @param {{ db: object }} deps
 * @returns {{ createConsumer: Function, persistBatch: Function }}
 */
function createInboundEmailEventStore(deps) {
  let db;
  try {
    if (!exactPlainData(deps, STORE_DEPENDENCY_KEYS)
        && !exactFrozenData(deps, STORE_DEPENDENCY_KEYS)) {
      throw failure();
    }
    db = resolveDb(ownData(deps, 'db'));
    if (!db) throw failure();
  } catch (err) {
    if (err && err.code === FAILURE_CODE) throw err;
    throw failure();
  }

  function createConsumer(authorityInput) {
    return createDurableInboundEventStoreConsumer(Object.freeze({
      db,
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
    return persistCanonicalBatch(db, authority, envelopes);
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
  SQL_INSERT_EVENT,
  createInboundEmailEventStore,
  createDurableInboundEventStoreConsumer,
  // Test/inspection helpers (pure; no network).
  prepareCanonicalBatch,
  snapshotAuthority,
  resolveDb,
});
