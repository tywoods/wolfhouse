'use strict';

/**
 * Slice 2F-A: envelope record contract v1 + injected seal/open/rewrap provider shape.
 * No Azure SDK. Envelope: AES-256-GCM, 12-byte nonce, 16-byte tag, version-pinned KEK,
 * wrapped DEK. AAD binds client_id+endpoint_id+generation+operation_id.
 * Raw refresh_token only at private seal seam. Reflection traps → reflection_failed.
 * @module email-grant-envelope-provider-contract
 */

const crypto = require('crypto');

const ENVELOPE_VERSION_V1 = 'v1';
const AEAD_ALG_V1 = 'AES-256-GCM';
/** Production-allowed KEK wrap algorithms (RFC 3394 A256KW; RSA-OAEP-256 for 2F-B). */
const KEK_WRAP_ALGS_V1 = Object.freeze(['RSA-OAEP-256', 'A256KW']);
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_CIPHERTEXT_BYTES = 65536;
const MIN_WRAPPED_DEK_BYTES = 16;
const MAX_WRAPPED_DEK_BYTES = 2048;
const MAX_PLAINTEXT_BYTES = 8192;
const PKG_PREFIX = 'EMAIL_GRANT_PKG_V1\n';
const PKG_TOKEN_KEY = 'refresh_token=';
const FORBIDDEN_KEK_VERSIONS = new Set(['latest', 'current', '']);
const ENVELOPE_RECORD_KEYS = Object.freeze([
  'envelope_version', 'aead_alg', 'kek_wrap_alg', 'kek_key_name', 'kek_key_version',
  'nonce', 'ciphertext', 'auth_tag', 'wrapped_dek', 'operation_id',
]);
const ENVELOPE_RECORD_KEY_SET = new Set(ENVELOPE_RECORD_KEYS);
const PROVIDER_FN_KEYS = Object.freeze([
  'sealGrantPayload', 'openGrantPayload', 'rewrapGrantDek',
]);
const PROVIDER_FN_KEY_SET = new Set(PROVIDER_FN_KEYS);
const FORBIDDEN_PROVIDER_KEYS = Object.freeze(['refresh_token', 'access_token', 'raw_token']);

function fail(error, details) {
  const out = { ok: false, error: String(error) };
  if (details !== undefined) out.details = Object.freeze({ ...details });
  return Object.freeze(out);
}
function ok(value) {
  return value === undefined ? Object.freeze({ ok: true }) : Object.freeze({ ok: true, value });
}
function failReflection(error) {
  return fail(error, { reason: 'reflection_failed' });
}

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

function readOwnDataProp(obj, key) {
  try {
    if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) {
      return { present: false };
    }
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return { present: false };
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc) return { present: false };
    if (typeof desc.get === 'function' || typeof desc.set === 'function') {
      return { present: true, accessor: true };
    }
    return { present: true, value: desc.value };
  } catch {
    return { present: true, reflection_failed: true };
  }
}

/** Own-data reader: reject symbols/accessors/prototypes; traps → reflection_failed. */
function snapshotOwnDataProps(obj) {
  try {
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, reason: 'must_be_object' };
    }
    let proto;
    try {
      proto = Object.getPrototypeOf(obj);
    } catch {
      return { ok: false, reason: 'reflection_failed' };
    }
    if (proto !== Object.prototype && proto !== null) {
      return { ok: false, reason: 'must_be_object' };
    }
    const out = Object.create(null);
    let keys;
    try {
      keys = Reflect.ownKeys(obj);
    } catch {
      return { ok: false, reason: 'reflection_failed' };
    }
    for (const key of keys) {
      if (typeof key === 'symbol') return { ok: false, reason: 'symbol_key' };
      const read = readOwnDataProp(obj, key);
      if (read.reflection_failed) return { ok: false, reason: 'reflection_failed' };
      if (!read.present) continue;
      if (read.accessor) return { ok: false, reason: 'accessor' };
      out[key] = read.value;
    }
    return { ok: true, value: out };
  } catch {
    return { ok: false, reason: 'reflection_failed' };
  }
}

function isUuidString(v) {
  return typeof v === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
}

function asBuffer(v, field, exactLen, minLen, maxLen) {
  if (!Buffer.isBuffer(v)) return fail('envelope_record_invalid', { reason: `${field}_not_buffer` });
  if (exactLen != null && v.length !== exactLen) {
    return fail('envelope_record_invalid', { reason: `${field}_length` });
  }
  if (minLen != null && v.length < minLen) {
    return fail('envelope_record_invalid', { reason: `${field}_length` });
  }
  if (maxLen != null && v.length > maxLen) {
    return fail('envelope_record_invalid', { reason: `${field}_length` });
  }
  return ok(v);
}

function validateKekNameVersion(name, version) {
  if (typeof name !== 'string' || name !== name.trim() || name.length < 1 || name.length > 200
    || /\s/.test(name)) {
    return fail('envelope_record_invalid', { reason: 'kek_key_name' });
  }
  if (typeof version !== 'string' || version !== version.trim() || version.length < 1
    || version.length > 200 || /\s/.test(version)
    || FORBIDDEN_KEK_VERSIONS.has(String(version).toLowerCase())) {
    return fail('envelope_record_invalid', { reason: 'kek_key_version' });
  }
  return ok();
}

/** Canonical AAD v1 (UTF-8). Binds ciphertext to trusted row identity. */
function buildGrantEnvelopeAadV1({ clientId, endpointId, grantGeneration, operationId }) {
  if (!isUuidString(clientId) || !isUuidString(endpointId) || !isUuidString(operationId)) {
    throw new Error('aad_identity_invalid');
  }
  const gen = typeof grantGeneration === 'bigint' ? grantGeneration : BigInt(grantGeneration);
  if (gen < 1n) throw new Error('aad_generation_invalid');
  return Buffer.from([
    ENVELOPE_VERSION_V1,
    'aad_v1',
    `client_id=${String(clientId).trim().toLowerCase()}`,
    `endpoint_id=${String(endpointId).trim().toLowerCase()}`,
    `grant_generation=${gen.toString(10)}`,
    `operation_id=${String(operationId).trim().toLowerCase()}`,
  ].join('\n'), 'utf8');
}

/**
 * Strict reflection-independent parse of 2F-A canonical AAD bytes.
 * UTF-8 roundtrip; six lines (ENVELOPE_VERSION_V1, aad_v1, ids, gen, op);
 * rebuild via buildGrantEnvelopeAadV1 must byte-equal. No format change.
 */
function parseGrantEnvelopeAadV1(aad) {
  try {
    if (!Buffer.isBuffer(aad) || aad.length < 1 || aad.length > 4096) {
      return fail('aad_invalid', { reason: 'aad_shape' });
    }
    const text = aad.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(aad) || /[\r\0]/.test(text)) {
      return fail('aad_invalid', { reason: 'aad_utf8' });
    }
    const lines = text.split('\n');
    if (lines.length !== 6 || lines[0] !== ENVELOPE_VERSION_V1 || lines[1] !== 'aad_v1') {
      return fail('aad_invalid', { reason: 'aad_structure' });
    }
    const field = (line, key) => {
      const p = `${key}=`;
      if (typeof line !== 'string' || !line.startsWith(p)) return null;
      const v = line.slice(p.length);
      return v.length > 0 ? v : null;
    };
    const clientId = field(lines[2], 'client_id');
    const endpointId = field(lines[3], 'endpoint_id');
    const genStr = field(lines[4], 'grant_generation');
    const operationId = field(lines[5], 'operation_id');
    const uuidCanon = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!clientId || !endpointId || !genStr || !operationId
      || !uuidCanon.test(clientId) || !uuidCanon.test(endpointId) || !uuidCanon.test(operationId)
      || !/^[1-9][0-9]*$/.test(genStr)) {
      return fail('aad_invalid', { reason: 'aad_fields' });
    }
    const grantGeneration = BigInt(genStr);
    const rebuilt = buildGrantEnvelopeAadV1({
      clientId, endpointId, grantGeneration, operationId,
    });
    if (!rebuilt.equals(aad)) return fail('aad_invalid', { reason: 'aad_canonical' });
    return ok(Object.freeze({
      client_id: clientId,
      endpoint_id: endpointId,
      grant_generation: grantGeneration,
      operation_id: operationId,
    }));
  } catch {
    return fail('aad_invalid', { reason: 'aad_parse_failed' });
  }
}

/** Encode private package; raw refresh token only at this seam. */
function encodeDelegatedRefreshPackageV1(refreshToken) {
  if (typeof refreshToken !== 'string' || refreshToken.length < 1) {
    return fail('grant_package_invalid', { reason: 'refresh_token_required' });
  }
  if (refreshToken.includes('\0') || /[\r\n]/.test(refreshToken)) {
    return fail('grant_package_invalid', { reason: 'refresh_token_charset' });
  }
  const buf = Buffer.from(`${PKG_PREFIX}${PKG_TOKEN_KEY}${refreshToken}\n`, 'utf8');
  if (buf.length > MAX_PLAINTEXT_BYTES) {
    return fail('grant_package_invalid', { reason: 'plaintext_too_large' });
  }
  return ok(buf);
}

/** Parse package → { refresh_token }. Fail-closed; no token in errors. */
function decodeDelegatedRefreshPackageV1(plaintext) {
  if (!Buffer.isBuffer(plaintext) || plaintext.length < 1 || plaintext.length > MAX_PLAINTEXT_BYTES) {
    return fail('grant_package_invalid', { reason: 'plaintext_shape' });
  }
  const text = plaintext.toString('utf8');
  if (!text.startsWith(PKG_PREFIX) || !text.endsWith('\n')) {
    return fail('grant_package_invalid', { reason: 'prefix' });
  }
  const body = text.slice(PKG_PREFIX.length, -1);
  if (!body.startsWith(PKG_TOKEN_KEY)) return fail('grant_package_invalid', { reason: 'key' });
  const token = body.slice(PKG_TOKEN_KEY.length);
  if (!token || token.includes('\n') || token.includes('\0')) {
    return fail('grant_package_invalid', { reason: 'token_shape' });
  }
  if (body.includes('\n')) return fail('grant_package_invalid', { reason: 'extra_fields' });
  return ok(Object.freeze({ refresh_token: token }));
}

function validateGrantEnvelopeRecordV1Impl(raw) {
  const snap = snapshotOwnDataProps(raw);
  if (!snap.ok) {
    return fail('envelope_record_invalid', {
      reason: snap.reason === 'reflection_failed' ? 'reflection_failed' : snap.reason,
    });
  }
  const e = snap.value;
  const keys = Object.keys(e);
  if (keys.length !== ENVELOPE_RECORD_KEYS.length) {
    for (const k of keys) {
      if (!ENVELOPE_RECORD_KEY_SET.has(k)) {
        return fail('envelope_record_invalid', { reason: 'unknown_key' });
      }
    }
    return fail('envelope_record_invalid', { reason: 'missing_key' });
  }
  for (const k of keys) {
    if (!ENVELOPE_RECORD_KEY_SET.has(k)) {
      return fail('envelope_record_invalid', { reason: 'unknown_key' });
    }
  }
  if (e.envelope_version !== ENVELOPE_VERSION_V1) {
    return fail('envelope_record_invalid', { reason: 'envelope_version' });
  }
  if (e.aead_alg !== AEAD_ALG_V1) return fail('envelope_record_invalid', { reason: 'aead_alg' });
  if (!KEK_WRAP_ALGS_V1.includes(e.kek_wrap_alg)) {
    return fail('envelope_record_invalid', { reason: 'kek_wrap_alg' });
  }
  const kv = validateKekNameVersion(e.kek_key_name, e.kek_key_version);
  if (!kv.ok) return kv;
  if (!isUuidString(e.operation_id)) {
    return fail('envelope_record_invalid', { reason: 'operation_id' });
  }
  const nonce = asBuffer(e.nonce, 'nonce', NONCE_BYTES);
  if (!nonce.ok) return nonce;
  const tag = asBuffer(e.auth_tag, 'auth_tag', AUTH_TAG_BYTES);
  if (!tag.ok) return tag;
  const ct = asBuffer(e.ciphertext, 'ciphertext', null, 1, MAX_CIPHERTEXT_BYTES);
  if (!ct.ok) return ct;
  const wd = asBuffer(e.wrapped_dek, 'wrapped_dek', null, MIN_WRAPPED_DEK_BYTES, MAX_WRAPPED_DEK_BYTES);
  if (!wd.ok) return wd;
  return ok(Object.freeze({
    envelope_version: ENVELOPE_VERSION_V1,
    aead_alg: AEAD_ALG_V1,
    kek_wrap_alg: e.kek_wrap_alg,
    kek_key_name: e.kek_key_name,
    kek_key_version: e.kek_key_version,
    nonce: Buffer.from(nonce.value),
    ciphertext: Buffer.from(ct.value),
    auth_tag: Buffer.from(tag.value),
    wrapped_dek: Buffer.from(wd.value),
    operation_id: String(e.operation_id).trim().toLowerCase(),
  }));
}

/** Descriptor-safe envelope validation; no binary material in error details. */
function validateGrantEnvelopeRecordV1(raw) {
  try {
    return validateGrantEnvelopeRecordV1Impl(raw);
  } catch {
    return failReflection('envelope_record_invalid');
  }
}

/** Exact seal/open/rewrap; reject extras/symbols/accessors; fresh frozen wrapper. */
function validateEmailGrantEnvelopeProviderImpl(provider) {
  const snapShape = snapshotOwnDataProps(provider);
  if (!snapShape.ok) {
    return fail('envelope_provider_invalid', {
      reason: snapShape.reason === 'reflection_failed' ? 'reflection_failed' : snapShape.reason,
    });
  }
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(provider);
  } catch {
    return failReflection('envelope_provider_invalid');
  }
  for (const key of ownKeys) {
    if (typeof key === 'symbol') {
      return fail('envelope_provider_invalid', { reason: 'symbol_key' });
    }
    if (!PROVIDER_FN_KEY_SET.has(key)) {
      if (FORBIDDEN_PROVIDER_KEYS.includes(key)) {
        return fail('envelope_provider_invalid', { reason: 'forbidden_key' });
      }
      return fail('envelope_provider_invalid', { reason: 'unknown_key' });
    }
  }
  const fns = Object.create(null);
  for (const fn of PROVIDER_FN_KEYS) {
    const r = readOwnDataProp(provider, fn);
    if (r.reflection_failed) return failReflection('envelope_provider_invalid');
    if (!r.present) return fail('envelope_provider_invalid', { reason: `${fn}_required` });
    if (r.accessor) return fail('envelope_provider_invalid', { reason: `${fn}_accessor` });
    if (typeof r.value !== 'function') {
      return fail('envelope_provider_invalid', { reason: `${fn}_must_be_function` });
    }
    fns[fn] = r.value;
  }
  return ok(Object.freeze({
    sealGrantPayload(...args) { return fns.sealGrantPayload.apply(provider, args); },
    openGrantPayload(...args) { return fns.openGrantPayload.apply(provider, args); },
    rewrapGrantDek(...args) { return fns.rewrapGrantDek.apply(provider, args); },
  }));
}

function validateEmailGrantEnvelopeProvider(provider) {
  try {
    return validateEmailGrantEnvelopeProviderImpl(provider);
  } catch {
    return failReflection('envelope_provider_invalid');
  }
}

function snapshotProviderOpInput(raw) {
  return snapshotOwnDataProps(raw == null ? {} : raw);
}

/** Best-effort zeroize (defense in depth; not guaranteed by JS runtime). */
function zeroizeBuffer(buf) {
  if (Buffer.isBuffer(buf) && buf.length > 0) {
    crypto.randomFillSync(buf);
    buf.fill(0);
  }
}

module.exports = {
  ENVELOPE_VERSION_V1,
  AEAD_ALG_V1,
  KEK_WRAP_ALGS_V1,
  DEK_BYTES,
  NONCE_BYTES,
  AUTH_TAG_BYTES,
  MAX_CIPHERTEXT_BYTES,
  MAX_PLAINTEXT_BYTES,
  ENVELOPE_RECORD_KEYS,
  PROVIDER_FN_KEYS,
  buildGrantEnvelopeAadV1,
  parseGrantEnvelopeAadV1,
  encodeDelegatedRefreshPackageV1,
  decodeDelegatedRefreshPackageV1,
  validateGrantEnvelopeRecordV1,
  validateEmailGrantEnvelopeProvider,
  zeroizeBuffer,
  snapshotOwnDataProps,
  snapshotProviderOpInput,
  isPlainObject,
};
