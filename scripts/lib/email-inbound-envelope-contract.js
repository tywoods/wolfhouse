'use strict';

/**
 * Provider-neutral inbound email envelope contract.
 *
 * Immutable normalized DTO for identity, ordering, deduplication, and
 * staff-visible triage. Suitable for later Gmail and IMAP adapters.
 *
 * Exact own-data schemas only. Rejects proxies, accessors, inherited values,
 * symbol keys, dangerous keys, and unknown keys. No Graph/OData field names.
 *
 * PII fields (see EMAIL_INBOUND_ENVELOPE_PII_KEYS): subject, sender display /
 * address, internet message identity (plus sensitive ids listed there).
 * Persistence and logging of envelope field values are FORBIDDEN until a later
 * reviewed custody slice (EMAIL_INBOUND_ENVELOPE_PERSISTENCE_FORBIDDEN /
 * EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN).
 *
 * Explicitly excludes bodies, previews, recipients, headers, attachments,
 * links, tokens, and raw provider objects.
 *
 * @module email-inbound-envelope-contract
 */

const util = require('util');

const EMAIL_INBOUND_ENVELOPE_PROVIDERS = Object.freeze([
  'microsoft_graph',
  'gmail_api',
  'imap_smtp',
]);

const EMAIL_INBOUND_ENVELOPE_KEYS = Object.freeze([
  'provider',
  'provider_mailbox_id',
  'provider_message_id',
  'received_at',
  'subject',
  'sender_display_name',
  'sender_address',
  'is_read',
  'conversation_id',
  'internet_message_id',
]);

/** Fields that are PII or strongly identifying — do not persist/log yet. */
const EMAIL_INBOUND_ENVELOPE_PII_KEYS = Object.freeze([
  'subject',
  'sender_display_name',
  'sender_address',
  'internet_message_id',
  'provider_message_id',
  'conversation_id',
  'provider_mailbox_id',
]);

const EMAIL_INBOUND_ENVELOPE_PERSISTENCE_FORBIDDEN = true;
const EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN = true;

/** Shared bound for canonical string fields (matches Mail.ReadBasic transport). */
const EMAIL_INBOUND_ENVELOPE_STRING_MAX = 2048;

const PROVIDER_SET = new Set(EMAIL_INBOUND_ENVELOPE_PROVIDERS);
const KEY_SET = new Set(EMAIL_INBOUND_ENVELOPE_KEYS);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;

/**
 * Strict UTC/offset ISO-8601 instant. Canonicalized to UTC with millisecond Z.
 * Rejects date-only, space separators, and non-instant forms.
 */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

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

function hasUnpairedSurrogate(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Snapshot own enumerable data properties only.
 * Rejects proxies, accessors, symbols, dangerous keys.
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

function requireExactKeys(snap, exactKeys, exactSet) {
  const keys = Object.keys(snap);
  if (keys.length !== exactKeys.length) return false;
  for (const key of keys) {
    if (!exactSet.has(key)) return false;
  }
  return true;
}

function validateRequiredBoundedString(value, field) {
  if (typeof value !== 'string') {
    return fail('inbound_envelope_field_invalid', { reason: 'not_string', field });
  }
  if (value.length < 1) {
    return fail('inbound_envelope_field_invalid', { reason: 'empty', field });
  }
  if (value.length > EMAIL_INBOUND_ENVELOPE_STRING_MAX) {
    return fail('inbound_envelope_field_invalid', { reason: 'oversize', field });
  }
  if (hasUnpairedSurrogate(value)) {
    return fail('inbound_envelope_field_invalid', { reason: 'surrogate', field });
  }
  return null;
}

function validateOptionalBoundedString(value, field) {
  if (value === null) return null;
  return validateRequiredBoundedString(value, field);
}

/**
 * Validate and canonicalize received_at to UTC ISO-8601 with millisecond Z.
 * @param {unknown} value
 * @returns {{ok:true,value:string}|{ok:false,error:string,details?:object}}
 */
function validateReceivedAt(value) {
  if (typeof value !== 'string') {
    return fail('inbound_envelope_timestamp_invalid', { reason: 'not_string' });
  }
  if (value.length < 1 || value.length > EMAIL_INBOUND_ENVELOPE_STRING_MAX) {
    return fail('inbound_envelope_timestamp_invalid', { reason: 'length' });
  }
  if (!ISO_INSTANT_RE.test(value)) {
    return fail('inbound_envelope_timestamp_invalid', { reason: 'not_iso_instant' });
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return fail('inbound_envelope_timestamp_invalid', { reason: 'unparseable' });
  }
  return ok(new Date(ms).toISOString());
}

/**
 * Validate a provider-neutral inbound email envelope.
 * Returns a fresh immutable DTO — never retains the input object.
 *
 * @param {unknown} input
 * @returns {{ok:true,value:object}|{ok:false,error:string,details?:object}}
 */
function validateInboundEmailEnvelope(input) {
  const snap = snapshotOwnDataProps(input);
  if (!snap.ok) {
    return fail('inbound_envelope_invalid', { reason: snap.reason, key: snap.key });
  }
  const o = snap.value;
  if (!requireExactKeys(o, EMAIL_INBOUND_ENVELOPE_KEYS, KEY_SET)) {
    return fail('inbound_envelope_keyset_invalid');
  }

  if (typeof o.provider !== 'string' || !PROVIDER_SET.has(o.provider)) {
    return fail('inbound_envelope_provider_invalid');
  }

  let err = validateRequiredBoundedString(o.provider_mailbox_id, 'provider_mailbox_id');
  if (err) return err;
  err = validateRequiredBoundedString(o.provider_message_id, 'provider_message_id');
  if (err) return err;

  const received = validateReceivedAt(o.received_at);
  if (!received.ok) return received;

  err = validateOptionalBoundedString(o.subject, 'subject');
  if (err) return err;
  err = validateOptionalBoundedString(o.sender_display_name, 'sender_display_name');
  if (err) return err;
  err = validateOptionalBoundedString(o.sender_address, 'sender_address');
  if (err) return err;
  err = validateOptionalBoundedString(o.conversation_id, 'conversation_id');
  if (err) return err;
  err = validateOptionalBoundedString(o.internet_message_id, 'internet_message_id');
  if (err) return err;

  if (o.is_read !== true && o.is_read !== false) {
    return fail('inbound_envelope_field_invalid', { reason: 'not_boolean', field: 'is_read' });
  }

  // Fresh allowlisted DTO only — no raw retention.
  return ok({
    provider: o.provider,
    provider_mailbox_id: o.provider_mailbox_id,
    provider_message_id: o.provider_message_id,
    received_at: received.value,
    subject: o.subject,
    sender_display_name: o.sender_display_name,
    sender_address: o.sender_address,
    is_read: o.is_read === true,
    conversation_id: o.conversation_id,
    internet_message_id: o.internet_message_id,
  });
}

module.exports = {
  EMAIL_INBOUND_ENVELOPE_PROVIDERS,
  EMAIL_INBOUND_ENVELOPE_KEYS,
  EMAIL_INBOUND_ENVELOPE_PII_KEYS,
  EMAIL_INBOUND_ENVELOPE_PERSISTENCE_FORBIDDEN,
  EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN,
  EMAIL_INBOUND_ENVELOPE_STRING_MAX,
  validateInboundEmailEnvelope,
  validateReceivedAt,
};
