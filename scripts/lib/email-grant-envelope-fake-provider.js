'use strict';

/**
 * Slice 2F-A test-only fake envelope provider.
 * AEAD: AES-256-GCM under random per-seal DEK. DEK wrap: real RFC 3394 A256KW
 * (aes-256-wrap) under process-local fake KEK — algorithm metadata truthful.
 * Exposes exact seal/open/rewrap; test meta in WeakMap. Not production.
 * @module email-grant-envelope-fake-provider
 */

const crypto = require('crypto');
const {
  ENVELOPE_VERSION_V1,
  AEAD_ALG_V1,
  DEK_BYTES,
  NONCE_BYTES,
  AUTH_TAG_BYTES,
  encodeDelegatedRefreshPackageV1,
  decodeDelegatedRefreshPackageV1,
  validateGrantEnvelopeRecordV1,
  zeroizeBuffer,
  buildGrantEnvelopeAadV1,
  snapshotProviderOpInput,
} = require('./email-grant-envelope-provider-contract');

const FAKE_WRAP_ALG = 'A256KW';
const FAKE_KEK_NAME_DEFAULT = 'fake-luna-grant-kek';
const FAKE_KEK_VERSION_DEFAULT = 'v1-test-0001';
/** RFC 3394 default IV (A6 repeated 8 times). */
const RFC3394_IV = Buffer.alloc(8, 0xA6);
const metaByProvider = new WeakMap();

function sealFail() {
  return Object.assign(new Error('seal_input'), { code: 'envelope_seal_failed' });
}
function openFail() {
  return Object.assign(new Error('open_input'), { code: 'envelope_open_failed' });
}

/**
 * @param {{ kekKeyName?: string, kekKeyVersion?: string, kekBytes?: Buffer }} [opts]
 */
function createFakeEmailGrantEnvelopeProvider(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const kekKeyName = typeof options.kekKeyName === 'string' && options.kekKeyName
    ? options.kekKeyName : FAKE_KEK_NAME_DEFAULT;
  const kekKeyVersion = typeof options.kekKeyVersion === 'string' && options.kekKeyVersion
    ? options.kekKeyVersion : FAKE_KEK_VERSION_DEFAULT;
  if (String(kekKeyVersion).toLowerCase() === 'latest'
    || String(kekKeyVersion).toLowerCase() === 'current') {
    throw new Error('fake_kek_version_forbidden');
  }
  const kekBytes = Buffer.isBuffer(options.kekBytes) && options.kekBytes.length === 32
    ? Buffer.from(options.kekBytes) : crypto.randomBytes(32);
  const ops = [];

  /** RFC 3394 AES-256 Key Wrap of a 32-byte DEK → 40-byte wrapped key. */
  function wrapDekA256KW(dek) {
    if (!Buffer.isBuffer(dek) || dek.length !== DEK_BYTES) throw new Error('dek_shape');
    const cipher = crypto.createCipheriv('aes-256-wrap', kekBytes, RFC3394_IV);
    return Buffer.concat([cipher.update(dek), cipher.final()]);
  }
  function unwrapDekA256KW(wrapped) {
    // RFC 3394: 32-byte key → 40-byte wrap (n+1 64-bit blocks).
    if (!Buffer.isBuffer(wrapped) || wrapped.length !== 40) throw new Error('wrap_shape');
    const decipher = crypto.createDecipheriv('aes-256-wrap', kekBytes, RFC3394_IV);
    return Buffer.concat([decipher.update(wrapped), decipher.final()]);
  }

  async function sealGrantPayload(input) {
    ops.push({ op: 'seal' });
    const snap = snapshotProviderOpInput(input);
    if (!snap.ok) throw sealFail();
    const s = snap.value;
    const operationId = s.operation_id;
    const aad = Buffer.isBuffer(s.aad) ? s.aad : null;
    if (!aad || typeof operationId !== 'string' || !operationId) throw sealFail();
    let plaintext;
    if (Buffer.isBuffer(s.plaintext)) {
      plaintext = s.plaintext;
    } else if (typeof s.refresh_token === 'string') {
      const enc = encodeDelegatedRefreshPackageV1(s.refresh_token);
      if (!enc.ok) throw Object.assign(new Error('package'), { code: 'envelope_seal_failed' });
      plaintext = enc.value;
    } else {
      throw Object.assign(new Error('plaintext'), { code: 'envelope_seal_failed' });
    }
    let dek;
    try {
      dek = crypto.randomBytes(DEK_BYTES);
      const nonce = crypto.randomBytes(NONCE_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const envelope = {
        envelope_version: ENVELOPE_VERSION_V1,
        aead_alg: AEAD_ALG_V1,
        kek_wrap_alg: FAKE_WRAP_ALG,
        kek_key_name: kekKeyName,
        kek_key_version: kekKeyVersion,
        nonce,
        ciphertext,
        auth_tag: authTag,
        wrapped_dek: wrapDekA256KW(dek),
        operation_id: String(operationId).trim().toLowerCase(),
      };
      const v = validateGrantEnvelopeRecordV1(envelope);
      if (!v.ok) throw Object.assign(new Error('envelope'), { code: 'envelope_seal_failed' });
      return v.value;
    } finally {
      zeroizeBuffer(dek);
      if (Buffer.isBuffer(plaintext) && typeof s.refresh_token === 'string') zeroizeBuffer(plaintext);
    }
  }

  async function openGrantPayload(input) {
    ops.push({ op: 'open' });
    const snap = snapshotProviderOpInput(input);
    if (!snap.ok) throw openFail();
    const s = snap.value;
    const aad = Buffer.isBuffer(s.aad) ? s.aad : null;
    const v = validateGrantEnvelopeRecordV1(s.envelope);
    if (!v.ok || !aad) throw openFail();
    const e = v.value;
    if (e.kek_wrap_alg !== FAKE_WRAP_ALG
      || e.kek_key_name !== kekKeyName || e.kek_key_version !== kekKeyVersion) {
      throw openFail();
    }
    let dek;
    try {
      dek = unwrapDekA256KW(e.wrapped_dek);
      if (dek.length !== DEK_BYTES) throw openFail();
      const decipher = crypto.createDecipheriv('aes-256-gcm', dek, e.nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(e.auth_tag);
      const plaintext = Buffer.concat([decipher.update(e.ciphertext), decipher.final()]);
      const pkg = decodeDelegatedRefreshPackageV1(plaintext);
      zeroizeBuffer(plaintext);
      if (!pkg.ok) throw Object.assign(new Error('pkg'), { code: 'envelope_open_failed' });
      return Object.freeze({ refresh_token: pkg.value.refresh_token });
    } finally {
      zeroizeBuffer(dek);
    }
  }

  async function rewrapGrantDek(input) {
    ops.push({ op: 'rewrap' });
    const snap = snapshotProviderOpInput(input);
    if (!snap.ok) {
      throw Object.assign(new Error('rewrap_input'), { code: 'envelope_rewrap_failed' });
    }
    const s = snap.value;
    const opened = await openGrantPayload({ envelope: s.envelope, aad: s.aad });
    return sealGrantPayload({
      refresh_token: opened.refresh_token, aad: s.aad, operation_id: s.operation_id,
    });
  }

  // Exact own-data allowlist only — no test keys on the provider object.
  const provider = { sealGrantPayload, openGrantPayload, rewrapGrantDek };
  metaByProvider.set(provider, {
    ops, kekKeyName, kekKeyVersion,
    wrapAlg: FAKE_WRAP_ALG,
    wrapImpl: 'rfc3394-aes-256-wrap',
    custody: 'process_local_fake_kek',
  });
  return provider;
}

function getFakeEmailGrantEnvelopeProviderMeta(provider) {
  return metaByProvider.get(provider) || null;
}

/** Helper: seal refresh token for install/rotate using trusted AAD fields. */
async function fakeSealRefreshToken(provider, {
  refreshToken, clientId, endpointId, grantGeneration, operationId,
}) {
  const aad = buildGrantEnvelopeAadV1({ clientId, endpointId, grantGeneration, operationId });
  return provider.sealGrantPayload({
    refresh_token: refreshToken, aad, operation_id: operationId,
  });
}

module.exports = {
  createFakeEmailGrantEnvelopeProvider,
  fakeSealRefreshToken,
  getFakeEmailGrantEnvelopeProviderMeta,
  FAKE_KEK_NAME_DEFAULT,
  FAKE_KEK_VERSION_DEFAULT,
  FAKE_WRAP_ALG,
  RFC3394_IV,
  AUTH_TAG_BYTES,
  NONCE_BYTES,
};
