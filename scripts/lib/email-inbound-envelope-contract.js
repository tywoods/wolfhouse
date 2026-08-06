'use strict';

/**
 * Provider-neutral inbound email envelope contract.
 *
 * Canonical normalized domain envelope (immutable DTO) for identity, ordering,
 * deduplication, and staff-visible triage. Suitable for later Gmail and IMAP
 * adapters. This is the single public domain meaning of an inbound envelope.
 *
 * Competing Graph adapter DTO (`id` / `from_address` / `has_attachments` …) is a
 * legacy provider/transport-row compatibility surface only — convert through
 * convertLegacyGraphTransportEnvelopeToInbound; do not treat it as a second
 * domain envelope.
 *
 * Exact own enumerable data schemas only. Rejects proxies, accessors, inherited
 * values, symbol keys, non-enumerable keys, dangerous keys, and unknown keys.
 * No Graph/OData field names on the domain DTO.
 *
 * Identity tuple (dedup key): (provider, provider_mailbox_id, provider_message_id).
 * Ordering: received_at descending (newest first); deterministic tie-break on the
 * identity tuple ascending. internet_message_id is metadata only — never part of
 * identity/dedup; null and duplicate values across distinct identities are allowed.
 *
 * Microsoft durable identity: future persistence of provider_message_id requires
 * Graph ImmutableId semantics (Prefer: IdType="ImmutableId"). This offline contract
 * and mapper do not claim ImmutableId provenance and are not runtime-wired.
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

/** Canonical normalized domain envelope keys (exact own enumerable data). */
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

/**
 * Legacy Graph adapter transport-row DTO keys (email-microsoft-graph-adapter.js
 * ENVELOPE_DTO_KEYS). Compatibility surface only — not the domain envelope.
 */
const EMAIL_INBOUND_LEGACY_GRAPH_TRANSPORT_ENVELOPE_KEYS = Object.freeze([
  'id',
  'subject',
  'from_address',
  'from_name',
  'received_at',
  'is_read',
  'conversation_id',
  'has_attachments',
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

/**
 * Normative identity tuple for identity and deduplication.
 * internet_message_id is intentionally excluded (metadata only).
 */
const EMAIL_INBOUND_ENVELOPE_IDENTITY_KEYS = Object.freeze([
  'provider',
  'provider_mailbox_id',
  'provider_message_id',
]);

/** Ordering direction for staff/inbox lists: newest received_at first. */
const EMAIL_INBOUND_ENVELOPE_ORDER_DIRECTION = 'received_at_desc';

/**
 * Deterministic tie-break when received_at is equal: identity tuple ascending
 * (provider, provider_mailbox_id, provider_message_id).
 */
const EMAIL_INBOUND_ENVELOPE_TIE_BREAK_KEYS = Object.freeze([
  'provider',
  'provider_mailbox_id',
  'provider_message_id',
]);

/**
 * Before any future persistence of Microsoft provider_message_id, the Graph
 * request must use ImmutableId semantics (Prefer: IdType="ImmutableId").
 * Rest IDs are not durable across moves/mailbox changes.
 */
const EMAIL_INBOUND_MICROSOFT_DURABLE_IDENTITY_REQUIRES_IMMUTABLE_ID = true;

/**
 * Offline mapper / contract never claim that provider_message_id is an
 * ImmutableId — provenance is unknown until a later persistence-ready slice
 * enforces Prefer: IdType="ImmutableId".
 */
const EMAIL_INBOUND_MICROSOFT_MAPPER_CLAIMS_IMMUTABLE_ID_PROVENANCE = false;

/** This contract slice is not runtime-wired (no polling/routes/DB/activation). */
const EMAIL_INBOUND_ENVELOPE_RUNTIME_WIRED = false;

const EMAIL_INBOUND_ENVELOPE_PERSISTENCE_FORBIDDEN = true;
const EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN = true;

/** Shared bound for canonical string fields (matches Mail.ReadBasic transport). */
const EMAIL_INBOUND_ENVELOPE_STRING_MAX = 2048;

const PROVIDER_SET = new Set(EMAIL_INBOUND_ENVELOPE_PROVIDERS);
const KEY_SET = new Set(EMAIL_INBOUND_ENVELOPE_KEYS);
const LEGACY_KEY_SET = new Set(EMAIL_INBOUND_LEGACY_GRAPH_TRANSPORT_ENVELOPE_KEYS);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;

/**
 * Strict UTC/offset ISO-8601 instant grammar. Canonicalized to UTC with millisecond Z.
 * Rejects date-only, space separators, and non-instant forms.
 * Calendar component validity is enforced separately (no Date.parse rollover).
 */
const ISO_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

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

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

function daysInMonth(year, month) {
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12:
      return 31;
    case 4: case 6: case 9: case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/**
 * Proleptic Gregorian day count since Unix epoch (1970-01-01).
 * Howard Hinnant civil algorithms with trunc (C++ toward-zero) division.
 * Avoids Date.UTC, which maps years 0-99 → 1900-1999.
 */
function daysFromCivil(year, month, day) {
  let y = year - (month <= 2 ? 1 : 0);
  const era = Math.trunc((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.trunc((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(dayIndex) {
  let z = dayIndex + 719468;
  const era = Math.trunc((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.trunc(
    (doe - Math.trunc(doe / 1460) + Math.trunc(doe / 36524) - Math.trunc(doe / 146096)) / 365,
  );
  let year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.trunc(yoe / 4) - Math.trunc(yoe / 100));
  const mp = Math.trunc((5 * doy + 2) / 153);
  const day = doy - Math.trunc((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  year += month <= 2 ? 1 : 0;
  return { year, month, day };
}

function utcMillisFromCivil(year, month, day, hour, minute, second, millis) {
  return daysFromCivil(year, month, day) * 86400000
    + hour * 3600000
    + minute * 60000
    + second * 1000
    + millis;
}

function civilFromUtcMillis(utcMs) {
  const dayLength = 86400000;
  let days = Math.trunc(utcMs / dayLength);
  let msOfDay = utcMs - days * dayLength;
  if (msOfDay < 0) {
    msOfDay += dayLength;
    days -= 1;
  }
  const { year, month, day } = civilFromDays(days);
  const hour = Math.trunc(msOfDay / 3600000);
  msOfDay -= hour * 3600000;
  const minute = Math.trunc(msOfDay / 60000);
  msOfDay -= minute * 60000;
  const second = Math.trunc(msOfDay / 1000);
  const millis = msOfDay - second * 1000;
  return { year, month, day, hour, minute, second, millis };
}

function formatCanonicalUtcInstant(parts) {
  const pad = (n, width) => String(n).padStart(width, '0');
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`
    + `T${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}`
    + `.${pad(parts.millis, 3)}Z`;
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
 * Rejects impossible calendar dates (no Date.parse rollover of Feb 30 etc.).
 * Accepts Z and numeric offsets; equivalent instants canonicalize identically.
 *
 * Does not use Date.UTC (which maps years 0-99 → 1900-1999). Low four-digit
 * years 0000-0099 are preserved. Any accepted offset instant whose canonical
 * UTC year leaves 0000-9999 is rejected so validate(canonical) is a fixed point.
 *
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
  const match = ISO_INSTANT_RE.exec(value);
  if (!match) {
    return fail('inbound_envelope_timestamp_invalid', { reason: 'not_iso_instant' });
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const frac = match[7] || '';
  const offset = match[8];

  // Input wall-clock year is always four digits by grammar (0000-9999).
  if (month < 1 || month > 12) {
    return fail('inbound_envelope_timestamp_invalid', { reason: 'impossible_calendar' });
  }
  const dim = daysInMonth(year, month);
  if (day < 1 || day > dim) {
    return fail('inbound_envelope_timestamp_invalid', { reason: 'impossible_calendar' });
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return fail('inbound_envelope_timestamp_invalid', { reason: 'impossible_calendar' });
  }

  // Build UTC ms from calendar components + offset (no Date.UTC / no rollover).
  let offsetMinutes = 0;
  if (offset !== 'Z') {
    const sign = offset.charAt(0) === '-' ? -1 : 1;
    const oh = Number(offset.slice(1, 3));
    const om = Number(offset.slice(4, 6));
    if (oh > 23 || om > 59) {
      return fail('inbound_envelope_timestamp_invalid', { reason: 'impossible_calendar' });
    }
    offsetMinutes = sign * (oh * 60 + om);
  }

  // Millisecond field: first 3 fractional digits (pad); extra sub-ms precision truncated.
  const millis = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;

  const utcMs = utcMillisFromCivil(year, month, day, hour, minute, second, millis)
    - (offsetMinutes * 60 * 1000);
  if (!Number.isFinite(utcMs)) {
    return fail('inbound_envelope_timestamp_invalid', { reason: 'unparseable' });
  }

  const parts = civilFromUtcMillis(utcMs);
  // Canonical UTC year must remain four-digit 0000-9999 so the same validator
  // accepts the output unchanged (no expanded ±YYYYY forms).
  if (parts.year < 0 || parts.year > 9999) {
    return fail('inbound_envelope_timestamp_invalid', { reason: 'canonical_year_out_of_range' });
  }
  if (parts.millis < 0 || parts.millis > 999
      || parts.second < 0 || parts.second > 59
      || parts.minute < 0 || parts.minute > 59
      || parts.hour < 0 || parts.hour > 23) {
    return fail('inbound_envelope_timestamp_invalid', { reason: 'canonical_mismatch' });
  }

  const canonical = formatCanonicalUtcInstant(parts);
  // Fixed-point proof: re-parse canonical through the same pure path.
  const re = ISO_INSTANT_RE.exec(canonical);
  if (!re) {
    return fail('inbound_envelope_timestamp_invalid', { reason: 'canonical_mismatch' });
  }
  const reMs = utcMillisFromCivil(
    Number(re[1]),
    Number(re[2]),
    Number(re[3]),
    Number(re[4]),
    Number(re[5]),
    Number(re[6]),
    Number((re[7] || '0').padEnd(3, '0').slice(0, 3)),
  );
  if (reMs !== utcMs || formatCanonicalUtcInstant(civilFromUtcMillis(reMs)) !== canonical) {
    return fail('inbound_envelope_timestamp_invalid', { reason: 'canonical_mismatch' });
  }

  return ok(canonical);
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

/**
 * Extract the normative identity tuple used for identity and dedup.
 * internet_message_id is metadata only and is never included.
 *
 * @param {unknown} envelope validated or raw own-data envelope
 * @returns {{ok:true,value:object}|{ok:false,error:string,details?:object}}
 */
function inboundEmailEnvelopeIdentityTuple(envelope) {
  const validated = validateInboundEmailEnvelope(envelope);
  if (!validated.ok) return validated;
  const v = validated.value;
  return ok({
    provider: v.provider,
    provider_mailbox_id: v.provider_mailbox_id,
    provider_message_id: v.provider_message_id,
  });
}

/**
 * True iff both envelopes share the same identity tuple.
 * internet_message_id (including null / differing values) does not affect dedup.
 * Two null internet_message_id values do not create a cross-identity collision.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function areInboundEmailEnvelopesDuplicate(a, b) {
  const idA = inboundEmailEnvelopeIdentityTuple(a);
  const idB = inboundEmailEnvelopeIdentityTuple(b);
  if (!idA.ok || !idB.ok) return false;
  return idA.value.provider === idB.value.provider
    && idA.value.provider_mailbox_id === idB.value.provider_mailbox_id
    && idA.value.provider_message_id === idB.value.provider_message_id;
}

/**
 * Compare for ordering: received_at DESC (newest first), then identity tuple ASC.
 * Returns negative if a should appear before b.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
function compareInboundEmailEnvelopesForOrder(a, b) {
  const va = validateInboundEmailEnvelope(a);
  const vb = validateInboundEmailEnvelope(b);
  if (!va.ok && !vb.ok) return 0;
  if (!va.ok) return 1;
  if (!vb.ok) return -1;

  const msA = Date.parse(va.value.received_at);
  const msB = Date.parse(vb.value.received_at);
  if (msA !== msB) {
    // Newest first.
    return msB - msA;
  }

  for (const key of EMAIL_INBOUND_ENVELOPE_TIE_BREAK_KEYS) {
    const sa = String(va.value[key]);
    const sb = String(vb.value[key]);
    if (sa < sb) return -1;
    if (sa > sb) return 1;
  }
  return 0;
}

/**
 * One conversion point: legacy Graph adapter transport-row DTO → canonical
 * domain inbound envelope. Requires explicit provider + mailbox identity.
 * Transport-only `has_attachments` is validated then discarded (not domain).
 *
 * @param {unknown} input `{ provider, provider_mailbox_id, legacy }`
 * @returns {{ok:true,value:object}|{ok:false,error:string,details?:object}}
 */
function convertLegacyGraphTransportEnvelopeToInbound(input) {
  const snap = snapshotOwnDataProps(input);
  if (!snap.ok) {
    return fail('legacy_transport_conversion_invalid', { reason: snap.reason, key: snap.key });
  }
  const o = snap.value;
  const inputKeys = Object.keys(o);
  if (inputKeys.length !== 3
      || !Object.prototype.hasOwnProperty.call(o, 'provider')
      || !Object.prototype.hasOwnProperty.call(o, 'provider_mailbox_id')
      || !Object.prototype.hasOwnProperty.call(o, 'legacy')) {
    return fail('legacy_transport_conversion_invalid', { reason: 'input_keyset' });
  }

  if (typeof o.provider !== 'string' || !PROVIDER_SET.has(o.provider)) {
    return fail('legacy_transport_conversion_invalid', { reason: 'provider_invalid' });
  }
  const mailboxErr = validateRequiredBoundedString(o.provider_mailbox_id, 'provider_mailbox_id');
  if (mailboxErr) {
    return fail('legacy_transport_conversion_invalid', { reason: 'mailbox_invalid' });
  }

  const legacySnap = snapshotOwnDataProps(o.legacy);
  if (!legacySnap.ok) {
    return fail('legacy_transport_conversion_invalid', {
      reason: legacySnap.reason,
      key: legacySnap.key,
    });
  }
  const legacy = legacySnap.value;
  if (!requireExactKeys(
    legacy,
    EMAIL_INBOUND_LEGACY_GRAPH_TRANSPORT_ENVELOPE_KEYS,
    LEGACY_KEY_SET,
  )) {
    return fail('legacy_transport_conversion_invalid', { reason: 'legacy_keyset' });
  }

  if (legacy.has_attachments !== true && legacy.has_attachments !== false) {
    return fail('legacy_transport_conversion_invalid', { reason: 'has_attachments_invalid' });
  }
  // has_attachments is transport-only — validated above, never mapped to domain.

  const candidate = {
    provider: o.provider,
    provider_mailbox_id: o.provider_mailbox_id,
    provider_message_id: legacy.id,
    received_at: legacy.received_at,
    subject: legacy.subject,
    sender_display_name: legacy.from_name,
    sender_address: legacy.from_address,
    is_read: legacy.is_read === true,
    conversation_id: legacy.conversation_id,
    internet_message_id: legacy.internet_message_id,
  };

  return validateInboundEmailEnvelope(candidate);
}

module.exports = {
  EMAIL_INBOUND_ENVELOPE_PROVIDERS,
  EMAIL_INBOUND_ENVELOPE_KEYS,
  EMAIL_INBOUND_LEGACY_GRAPH_TRANSPORT_ENVELOPE_KEYS,
  EMAIL_INBOUND_ENVELOPE_PII_KEYS,
  EMAIL_INBOUND_ENVELOPE_IDENTITY_KEYS,
  EMAIL_INBOUND_ENVELOPE_ORDER_DIRECTION,
  EMAIL_INBOUND_ENVELOPE_TIE_BREAK_KEYS,
  EMAIL_INBOUND_MICROSOFT_DURABLE_IDENTITY_REQUIRES_IMMUTABLE_ID,
  EMAIL_INBOUND_MICROSOFT_MAPPER_CLAIMS_IMMUTABLE_ID_PROVENANCE,
  EMAIL_INBOUND_ENVELOPE_RUNTIME_WIRED,
  EMAIL_INBOUND_ENVELOPE_PERSISTENCE_FORBIDDEN,
  EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN,
  EMAIL_INBOUND_ENVELOPE_STRING_MAX,
  validateInboundEmailEnvelope,
  validateReceivedAt,
  inboundEmailEnvelopeIdentityTuple,
  areInboundEmailEnvelopesDuplicate,
  compareInboundEmailEnvelopesForOrder,
  convertLegacyGraphTransportEnvelopeToInbound,
};
