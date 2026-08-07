'use strict';

/**
 * Provider-neutral offline inbound email batch processor.
 *
 * Consumes a bounded array of **canonical** inbound envelopes only. Imports
 * validation / identity / order from `email-inbound-envelope-contract`. Does
 * **not** define an envelope schema or key list, and does **not** import Graph
 * or any provider adapter/transport.
 *
 * Contract:
 * - Validate the **entire** batch first (all-or-nothing). On any invalid input,
 *   return a sanitized failure and **never** invoke the consumer.
 * - Require an exact single `(provider, provider_mailbox_id)` prefix across the
 *   batch (reject mixed mailboxes/providers).
 * - Reject proxies, accessors, inherited values, symbol keys, non-enumerable
 *   keys, and malformed envelopes (via canonical validation).
 * - Deterministic canonical sort (`compareInboundEmailEnvelopesForOrder`).
 * - Deduplicate **within this batch only** by the canonical identity tuple
 *   `(provider, provider_mailbox_id, provider_message_id)`. After sort
 *   (newest first), the first occurrence is kept. This is **not** durable
 *   cross-batch idempotency (`EMAIL_INBOUND_BATCH_PROCESSOR_DURABLE_IDEMPOTENCY_CLAIM = false`).
 * - After full validation only: invoke **exactly one** explicitly-awaited
 *   injected `consumer` with a fresh frozen array of fresh frozen envelopes.
 * - Consumer loan contract: non-retention / no-log / no-persist of envelope
 *   field values for this call. Processor does not log or persist envelopes.
 * - Consumer result must be an exact sanitized own-data acknowledgement
 *   `{ acknowledged: true }` or the processor fails closed.
 * - Processor success returns only frozen **identity-free** counts/status —
 *   never PII, provider/message/mailbox ids, or envelopes.
 *
 * Offline / unwired: no network, DB, routes, OAuth, logging, runtime flags,
 * persistence, or deploy activation.
 *
 * @module email-inbound-batch-processor
 */

const util = require('util');

const {
  validateInboundEmailEnvelope,
  inboundEmailEnvelopeIdentityTuple,
  compareInboundEmailEnvelopesForOrder,
  EMAIL_INBOUND_ENVELOPE_PERSISTENCE_FORBIDDEN,
  EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN,
} = require('./email-inbound-envelope-contract');

/** Max envelopes accepted in one offline batch (DOS bound; not a page size). */
const EMAIL_INBOUND_BATCH_MAX = 50;

/** This slice is not runtime-wired (no routes/polling/activation). */
const EMAIL_INBOUND_BATCH_PROCESSOR_RUNTIME_WIRED = false;

/** Processor must not persist envelopes; same custody gate as the contract. */
const EMAIL_INBOUND_BATCH_PROCESSOR_PERSISTENCE_FORBIDDEN =
  EMAIL_INBOUND_ENVELOPE_PERSISTENCE_FORBIDDEN === true;

/** Processor must not log envelope field values. */
const EMAIL_INBOUND_BATCH_PROCESSOR_LOGGING_FORBIDDEN =
  EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN === true;

/**
 * Within-batch dedup is **not** a durable idempotency claim across batches,
 * processes, or restarts.
 */
const EMAIL_INBOUND_BATCH_PROCESSOR_DURABLE_IDEMPOTENCY_CLAIM = false;

/**
 * Documented consumer loan: envelopes are provided for this single await only.
 * Consumer must not retain, log, or persist envelope field values.
 */
const EMAIL_INBOUND_BATCH_CONSUMER_NON_RETENTION = true;
const EMAIL_INBOUND_BATCH_CONSUMER_NO_LOG = true;
const EMAIL_INBOUND_BATCH_CONSUMER_NO_PERSIST = true;

const INPUT_KEYS = Object.freeze(['envelopes', 'consumer']);
const INPUT_KEY_SET = new Set(INPUT_KEYS);
const ACK_KEYS = Object.freeze(['acknowledged']);
const ACK_KEY_SET = new Set(ACK_KEYS);
const RESULT_KEYS = Object.freeze([
  'status',
  'input_count',
  'delivered_count',
  'duplicate_count',
]);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;

function deepFreezeFresh(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeFresh));
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = deepFreezeFresh(value[key]);
  }
  return Object.freeze(out);
}

function fail(error, details) {
  const out = { ok: false, error: String(error) };
  if (details !== undefined) out.details = deepFreezeFresh(details);
  return Object.freeze(out);
}

function ok(value) {
  return Object.freeze({ ok: true, value: deepFreezeFresh(value) });
}

function isProxySurface(value) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

function isPlainOwnDataObject(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    if (isProxySurface(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

/**
 * Snapshot own enumerable data properties only.
 * Rejects proxies, accessors, symbols, non-enumerable keys, dangerous keys.
 */
function snapshotOwnDataProps(obj) {
  try {
    if (!isPlainOwnDataObject(obj)) {
      return { ok: false, reason: 'must_be_object' };
    }
    const out = Object.create(null);
    for (const key of Reflect.ownKeys(obj)) {
      if (typeof key === 'symbol') {
        return { ok: false, reason: 'symbol_key' };
      }
      if (DANGEROUS_KEYS.has(key)) {
        return { ok: false, reason: 'dangerous_key', key };
      }
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (!desc) continue;
      if (desc.enumerable !== true) {
        return { ok: false, reason: 'non_enumerable', key };
      }
      if (typeof desc.get === 'function' || typeof desc.set === 'function') {
        return { ok: false, reason: 'accessor', key };
      }
      if (!Object.prototype.hasOwnProperty.call(desc, 'value')) {
        return { ok: false, reason: 'accessor', key };
      }
      out[key] = desc.value;
    }
    return { ok: true, value: out };
  } catch {
    return { ok: false, reason: 'reflection_failed' };
  }
}

function identityKey(tuple) {
  return `${tuple.provider}\0${tuple.provider_mailbox_id}\0${tuple.provider_message_id}`;
}

/**
 * Accept only a plain Array (not proxy, not array-like object). Sparse holes
 * and non-index own props beyond length are rejected.
 *
 * @param {unknown} value
 * @returns {{ok:true,value:unknown[]}|{ok:false,reason:string}}
 */
function acceptEnvelopeArray(value) {
  try {
    if (value === null || typeof value !== 'object') {
      return { ok: false, reason: 'not_array' };
    }
    if (!Array.isArray(value)) {
      return { ok: false, reason: 'not_array' };
    }
    if (isProxySurface(value)) {
      return { ok: false, reason: 'proxy' };
    }
    const len = value.length;
    if (typeof len !== 'number' || !Number.isInteger(len) || len < 0) {
      return { ok: false, reason: 'length_invalid' };
    }
    if (len > EMAIL_INBOUND_BATCH_MAX) {
      return { ok: false, reason: 'over_max' };
    }
    // Reject sparse holes and non-index own keys (symbols / string extras).
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        return { ok: false, reason: 'symbol_key' };
      }
      if (key === 'length') continue;
      if (!/^(0|[1-9]\d*)$/.test(key)) {
        return { ok: false, reason: 'non_index_key' };
      }
      const idx = Number(key);
      if (idx < 0 || idx >= len) {
        return { ok: false, reason: 'index_out_of_range' };
      }
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || desc.enumerable !== true) {
        return { ok: false, reason: 'non_enumerable' };
      }
      if (typeof desc.get === 'function' || typeof desc.set === 'function'
          || !Object.prototype.hasOwnProperty.call(desc, 'value')) {
        return { ok: false, reason: 'accessor' };
      }
    }
    for (let i = 0; i < len; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) {
        return { ok: false, reason: 'sparse' };
      }
      const desc = Object.getOwnPropertyDescriptor(value, i);
      if (!desc || desc.enumerable !== true) {
        return { ok: false, reason: 'non_enumerable' };
      }
      if (typeof desc.get === 'function' || typeof desc.set === 'function'
          || !Object.prototype.hasOwnProperty.call(desc, 'value')) {
        return { ok: false, reason: 'accessor' };
      }
    }
    // Materialize a fresh dense array of the raw element values (not frozen yet).
    const out = new Array(len);
    for (let i = 0; i < len; i += 1) {
      out[i] = value[i];
    }
    return { ok: true, value: out };
  } catch {
    return { ok: false, reason: 'reflection_failed' };
  }
}

/**
 * Consumer acknowledgement: exact own enumerable data `{ acknowledged: true }`.
 * Rejects proxies, accessors, symbols, extras, and non-true values.
 *
 * @param {unknown} result
 * @returns {{ok:true}|{ok:false,reason:string}}
 */
function acceptConsumerAcknowledgement(result) {
  const snap = snapshotOwnDataProps(result);
  if (!snap.ok) {
    return { ok: false, reason: snap.reason || 'ack_invalid' };
  }
  const o = snap.value;
  const keys = Object.keys(o);
  if (keys.length !== ACK_KEYS.length) {
    return { ok: false, reason: 'ack_keyset' };
  }
  for (const key of keys) {
    if (!ACK_KEY_SET.has(key)) {
      return { ok: false, reason: 'ack_keyset' };
    }
  }
  if (o.acknowledged !== true) {
    return { ok: false, reason: 'ack_not_true' };
  }
  return { ok: true };
}

/**
 * Process one offline batch of canonical inbound envelopes.
 *
 * @param {unknown} input exact own-data `{ envelopes, consumer }`
 * @returns {Promise<{ok:true,value:object}|{ok:false,error:string,details?:object}>}
 */
async function processInboundEmailBatch(input) {
  const snap = snapshotOwnDataProps(input);
  if (!snap.ok) {
    return fail('inbound_batch_input_invalid', { reason: snap.reason, key: snap.key });
  }
  const o = snap.value;
  for (const key of Object.keys(o)) {
    if (!INPUT_KEY_SET.has(key)) {
      return fail('inbound_batch_input_invalid', { reason: 'unknown_key' });
    }
  }
  for (const required of INPUT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(o, required)) {
      return fail('inbound_batch_input_invalid', {
        reason: 'missing_key',
        key: required,
      });
    }
  }

  if (typeof o.consumer !== 'function') {
    return fail('inbound_batch_consumer_invalid', { reason: 'not_function' });
  }
  const consumer = o.consumer;

  const arr = acceptEnvelopeArray(o.envelopes);
  if (!arr.ok) {
    return fail('inbound_batch_envelopes_invalid', { reason: arr.reason });
  }

  const raw = arr.value;
  const inputCount = raw.length;

  // ── Validate entire batch first (all-or-nothing; no consumer yet) ────────
  const validated = new Array(inputCount);
  for (let i = 0; i < inputCount; i += 1) {
    const v = validateInboundEmailEnvelope(raw[i]);
    if (!v.ok) {
      // Sanitized only — never surface envelope field values / PII.
      return fail('inbound_batch_envelope_invalid', {
        reason: typeof v.error === 'string' ? v.error : 'envelope_invalid',
      });
    }
    validated[i] = v.value;
  }

  // Exact single provider + mailbox prefix across the whole batch.
  if (inputCount > 0) {
    const prefixProvider = validated[0].provider;
    const prefixMailbox = validated[0].provider_mailbox_id;
    for (let i = 1; i < inputCount; i += 1) {
      if (validated[i].provider !== prefixProvider
          || validated[i].provider_mailbox_id !== prefixMailbox) {
        return fail('inbound_batch_prefix_invalid', { reason: 'mixed' });
      }
    }
  }

  // Deterministic canonical sort (newest received_at first; identity ASC tie-break).
  validated.sort(compareInboundEmailEnvelopesForOrder);

  // Within-batch dedup by canonical identity tuple only (first after sort wins).
  const seen = new Set();
  const unique = [];
  for (let i = 0; i < validated.length; i += 1) {
    const id = inboundEmailEnvelopeIdentityTuple(validated[i]);
    if (!id.ok) {
      return fail('inbound_batch_envelope_invalid', { reason: 'identity_invalid' });
    }
    const key = identityKey(id.value);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(validated[i]);
  }

  const deliveredCount = unique.length;
  const duplicateCount = inputCount - deliveredCount;

  // Fresh frozen array of already-frozen canonical envelopes (no raw retention).
  const loaned = Object.freeze(unique.slice());

  // Exactly one explicitly-awaited consumer invocation — only after full validation.
  let consumerResult;
  try {
    consumerResult = await consumer(loaned);
  } catch {
    return fail('inbound_batch_consumer_failed', { reason: 'threw' });
  }

  const ack = acceptConsumerAcknowledgement(consumerResult);
  if (!ack.ok) {
    return fail('inbound_batch_consumer_result_invalid', { reason: ack.reason });
  }

  // Identity-free counts/status only — never PII / ids / envelopes.
  const result = {
    status: 'processed',
    input_count: inputCount,
    delivered_count: deliveredCount,
    duplicate_count: duplicateCount,
  };
  // Defensive: exact result keyset (no accidental extras at construction time).
  const resultKeys = Object.keys(result);
  if (resultKeys.length !== RESULT_KEYS.length
      || resultKeys.some((k, i) => k !== RESULT_KEYS[i])) {
    return fail('inbound_batch_result_invalid', { reason: 'result_keyset' });
  }

  return ok(result);
}

module.exports = {
  processInboundEmailBatch,
  EMAIL_INBOUND_BATCH_MAX,
  EMAIL_INBOUND_BATCH_PROCESSOR_RUNTIME_WIRED,
  EMAIL_INBOUND_BATCH_PROCESSOR_PERSISTENCE_FORBIDDEN,
  EMAIL_INBOUND_BATCH_PROCESSOR_LOGGING_FORBIDDEN,
  EMAIL_INBOUND_BATCH_PROCESSOR_DURABLE_IDEMPOTENCY_CLAIM,
  EMAIL_INBOUND_BATCH_CONSUMER_NON_RETENTION,
  EMAIL_INBOUND_BATCH_CONSUMER_NO_LOG,
  EMAIL_INBOUND_BATCH_CONSUMER_NO_PERSIST,
};
