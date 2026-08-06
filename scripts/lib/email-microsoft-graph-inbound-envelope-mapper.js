'use strict';

/**
 * Offline Microsoft Graph → provider-neutral inbound envelope mapper.
 *
 * Accepts only the already-approved Mail.ReadBasic row shape used by the
 * delegated messages transport (exact $select fields), plus optional
 * validated-then-discarded `@odata.etag`. Provider and mailbox identity are
 * required explicit inputs — never inferred from the row.
 *
 * No network, DB, OAuth, bodies, attachments, drafts, sends, or persistence.
 *
 * @module email-microsoft-graph-inbound-envelope-mapper
 */

const {
  validateInboundEmailEnvelope,
  EMAIL_INBOUND_ENVELOPE_STRING_MAX,
} = require('./email-inbound-envelope-contract');

const util = require('util');

const PROVIDER_ID = 'microsoft_graph';
const ETAG_KEY = '@odata.etag';

/** Exact Mail.ReadBasic $select fields (no body / hasAttachments). */
const MICROSOFT_GRAPH_MAIL_READ_BASIC_SELECT_FIELDS = Object.freeze([
  'id',
  'subject',
  'from',
  'receivedDateTime',
  'isRead',
  'conversationId',
  'internetMessageId',
]);

const ROW_FIELDS_WITH_ETAG = Object.freeze([
  ...MICROSOFT_GRAPH_MAIL_READ_BASIC_SELECT_FIELDS,
  ETAG_KEY,
]);

const INPUT_KEYS = Object.freeze([
  'provider',
  'provider_mailbox_id',
  'row',
]);
const INPUT_KEY_SET = new Set(INPUT_KEYS);

const FROM_KEYS = Object.freeze(['emailAddress']);
const EMAIL_ADDRESS_KEYS = Object.freeze(['address', 'name']);
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

function ownData(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
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

function exactPlainData(object, keys) {
  try {
    if (!isPlainOwnDataObject(object)) return false;
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

function optionalBoundedString(value) {
  return value === null
    || (typeof value === 'string'
      && value.length <= EMAIL_INBOUND_ENVELOPE_STRING_MAX
      && !hasUnpairedSurrogate(value));
}

function requiredBoundedString(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= EMAIL_INBOUND_ENVELOPE_STRING_MAX
    && !hasUnpairedSurrogate(value);
}

function acceptEmailAddress(value) {
  if (value === null) return true;
  if (!exactPlainData(value, EMAIL_ADDRESS_KEYS)) return false;
  return optionalBoundedString(ownData(value, 'address'))
    && optionalBoundedString(ownData(value, 'name'));
}

function acceptFrom(value) {
  if (value === null) return true;
  if (!exactPlainData(value, FROM_KEYS)) return false;
  return acceptEmailAddress(ownData(value, 'emailAddress'));
}

function rowKeysetValid(row) {
  return exactPlainData(row, MICROSOFT_GRAPH_MAIL_READ_BASIC_SELECT_FIELDS)
    || exactPlainData(row, ROW_FIELDS_WITH_ETAG);
}

function rowValuesValid(row) {
  if (!requiredBoundedString(ownData(row, 'id'))) return false;
  if (!optionalBoundedString(ownData(row, 'subject'))) return false;
  if (!acceptFrom(ownData(row, 'from'))) return false;
  if (!requiredBoundedString(ownData(row, 'receivedDateTime'))) return false;
  const isRead = ownData(row, 'isRead');
  if (isRead !== true && isRead !== false) return false;
  if (!optionalBoundedString(ownData(row, 'conversationId'))) return false;
  if (!optionalBoundedString(ownData(row, 'internetMessageId'))) return false;
  if (Object.prototype.hasOwnProperty.call(row, ETAG_KEY)) {
    const etag = ownData(row, ETAG_KEY);
    // Validate then discard — never map, persist, compare, log, or return.
    if (!requiredBoundedString(etag)) return false;
  }
  return true;
}

/**
 * Map one approved Mail.ReadBasic Graph message row to a normalized inbound envelope.
 *
 * @param {unknown} input exact own-data `{ provider, provider_mailbox_id, row }`
 * @returns {{ok:true,value:object}|{ok:false,error:string,details?:object}}
 */
function mapMicrosoftGraphMailReadBasicRowToInboundEnvelope(input) {
  const snap = snapshotOwnDataProps(input);
  if (!snap.ok) {
    return fail('graph_inbound_mapper_input_invalid', { reason: snap.reason, key: snap.key });
  }
  const o = snap.value;
  for (const key of Object.keys(o)) {
    if (!INPUT_KEY_SET.has(key)) {
      return fail('graph_inbound_mapper_input_invalid', { reason: 'unknown_key' });
    }
  }
  for (const required of INPUT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(o, required)) {
      return fail('graph_inbound_mapper_input_invalid', { reason: 'missing_key', key: required });
    }
  }

  if (o.provider !== PROVIDER_ID) {
    return fail('graph_inbound_mapper_provider_invalid');
  }
  if (typeof o.provider_mailbox_id !== 'string'
      || o.provider_mailbox_id.length < 1
      || o.provider_mailbox_id.length > EMAIL_INBOUND_ENVELOPE_STRING_MAX
      || hasUnpairedSurrogate(o.provider_mailbox_id)) {
    return fail('graph_inbound_mapper_mailbox_invalid');
  }

  const row = o.row;
  if (!isPlainOwnDataObject(row) || !rowKeysetValid(row) || !rowValuesValid(row)) {
    return fail('graph_inbound_mapper_row_invalid');
  }

  const from = ownData(row, 'from');
  let senderAddress = null;
  let senderDisplayName = null;
  if (from != null) {
    const emailAddress = ownData(from, 'emailAddress');
    if (emailAddress != null) {
      const address = ownData(emailAddress, 'address');
      const name = ownData(emailAddress, 'name');
      senderAddress = address === undefined ? null : address;
      senderDisplayName = name === undefined ? null : name;
    }
  }

  // Fresh provider-neutral DTO — Graph/OData names and etag never retained.
  const candidate = {
    provider: PROVIDER_ID,
    provider_mailbox_id: o.provider_mailbox_id,
    provider_message_id: ownData(row, 'id'),
    received_at: ownData(row, 'receivedDateTime'),
    subject: ownData(row, 'subject'),
    sender_display_name: senderDisplayName,
    sender_address: senderAddress,
    is_read: ownData(row, 'isRead') === true,
    conversation_id: ownData(row, 'conversationId'),
    internet_message_id: ownData(row, 'internetMessageId'),
  };

  return validateInboundEmailEnvelope(candidate);
}

module.exports = {
  MICROSOFT_GRAPH_MAIL_READ_BASIC_SELECT_FIELDS,
  mapMicrosoftGraphMailReadBasicRowToInboundEnvelope,
};
