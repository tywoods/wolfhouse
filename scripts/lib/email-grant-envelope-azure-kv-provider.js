'use strict';

/**
 * Slice 2F-B: production Azure Key Vault envelope provider core (offline-composable).
 *
 * AEAD: local Node AES-256-GCM (32B DEK, 12B nonce, 16B tag).
 * KEK wrap: RSA-OAEP-256 only via injected CryptographyClient resolver
 *   getCryptographyClient(fullVersionedKeyId) → { wrapKey, unwrapKey }.
 * Standard Key Vault (wh-staging-kv class): no A256KW, no Premium/HSM, no new vault.
 * Exact version-pinned key IDs only — never latest / unversioned / list-or-resolve-by-name.
 *
 * Credential construction, real Azure SDK wiring, network, and RBAC remain out of scope.
 * Prefer no Azure package dependency in this core (interface-only).
 *
 * rewrapGrantDek is FULL decrypt + reseal (fresh DEK+nonce under next_aad + target KEK).
 * Never pure DEK rewrap while generation advances.
 *
 * @module email-grant-envelope-azure-kv-provider
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
  parseGrantEnvelopeAadV1,
  zeroizeBuffer,
  snapshotOwnDataProps,
  snapshotProviderOpInput,
} = require('./email-grant-envelope-provider-contract');
const {
  parseDeltaCursorEnvelopeAadV1,
} = require('./email-delta-cursor-envelope-aad');

const PROD_WRAP_ALG = 'RSA-OAEP-256';
/** Match 2F-A envelope record schema bounds (contract constants; not re-exported). */
const MIN_WRAPPED_DEK_BYTES = 16;
const MAX_WRAPPED_DEK_BYTES = 2048;
const FORBIDDEN_VERSIONS = new Set(['latest', 'current', '']);
/** Azure key name/version: no path separators, traversal, or encoding tricks. */
const SAFE_KEY_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,199}$/;
const SAFE_HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const CRYPTO_FN_KEYS = Object.freeze(['wrapKey', 'unwrapKey']);

function err(code) {
  return Object.assign(new Error(code), { code: String(code) });
}

function readOwnData(obj, key) {
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

/** Reflection-safe dense own-data string[] (indices 0..n-1; no .length/index traps). */
function snapshotExactOwnDataStringArray(arr, minLen, maxLen) {
  const lo = minLen == null ? 1 : minLen;
  const hi = maxLen == null ? 16 : maxLen;
  try {
    if (arr == null || typeof arr !== 'object' || !Array.isArray(arr)) {
      return { ok: false, reason: 'must_be_array' };
    }
    const proto = Object.getPrototypeOf(arr);
    if (proto !== Array.prototype && proto !== null) {
      return { ok: false, reason: 'array_prototype' };
    }
    const keys = Reflect.ownKeys(arr);
    const lengthDesc = Object.getOwnPropertyDescriptor(arr, 'length');
    if (!lengthDesc || typeof lengthDesc.get === 'function' || typeof lengthDesc.set === 'function'
      || typeof lengthDesc.value !== 'number' || !Number.isInteger(lengthDesc.value)
      || lengthDesc.value < lo || lengthDesc.value > hi) {
      return { ok: false, reason: 'length_invalid' };
    }
    const n = lengthDesc.value;
    const expected = new Set(['length']);
    for (let i = 0; i < n; i += 1) expected.add(String(i));
    if (keys.length !== expected.size) return { ok: false, reason: 'array_keys' };
    for (const key of keys) {
      if (typeof key === 'symbol' || !expected.has(key)) {
        return { ok: false, reason: typeof key === 'symbol' ? 'symbol_key' : 'array_extra_key' };
      }
    }
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const desc = Object.getOwnPropertyDescriptor(arr, String(i));
      if (!desc || typeof desc.get === 'function' || typeof desc.set === 'function') {
        return { ok: false, reason: desc ? 'accessor' : 'sparse_array' };
      }
      if (typeof desc.value !== 'string') return { ok: false, reason: 'non_string_element' };
      out.push(desc.value);
    }
    return { ok: true, value: out };
  } catch {
    return { ok: false, reason: 'reflection_failed' };
  }
}

function asExactString(v, maxLen) {
  if (typeof v !== 'string') return null;
  if (v !== v.trim() || v.length < 1 || v.length > maxLen || /\s/.test(v)) return null;
  return v;
}

function isForbiddenVersion(version) {
  return FORBIDDEN_VERSIONS.has(String(version).toLowerCase());
}

function validateKeyToken(token, field) {
  if (typeof token !== 'string' || token !== token.trim() || token.length < 1 || token.length > 200) {
    return { ok: false, field };
  }
  if (/\s/.test(token) || !SAFE_KEY_TOKEN_RE.test(token) || token.includes('..')) {
    return { ok: false, field };
  }
  if (field === 'kek_key_version' && isForbiddenVersion(token)) {
    return { ok: false, field };
  }
  return { ok: true, value: token };
}

function validateHost(host) {
  const h = asExactString(host, 253);
  if (!h || h !== h.toLowerCase() || !SAFE_HOST_RE.test(h)) return null;
  if (h.includes('..') || h.includes('/') || h.includes('\\') || h.includes(':')) return null;
  return h;
}

/**
 * Build exact versioned key identity URL (no query/fragment).
 * https://{host}/keys/{name}/{version}
 */
function buildVersionedKeyId(host, name, version) {
  const h = validateHost(host);
  const n = validateKeyToken(name, 'kek_key_name');
  const v = validateKeyToken(version, 'kek_key_version');
  if (!h || !n.ok || !v.ok) return null;
  return `https://${h}/keys/${n.value}/${v.value}`;
}

/**
 * Parse and validate full HTTPS key identity; reject query/fragment/traversal.
 * @returns {{host:string,name:string,version:string,keyId:string}|null}
 */
function parseVersionedKeyId(raw, trustedHosts) {
  if (typeof raw !== 'string' || raw !== raw.trim() || raw.length < 20 || raw.length > 512) {
    return null;
  }
  if (raw.includes('?') || raw.includes('#') || raw.includes('\\') || /%|\/\.\.|\\/i.test(raw)) {
    return null;
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.port) return null;
  const host = validateHost(u.hostname);
  if (!host || !trustedHosts.has(host)) return null;
  // pathname must be exactly /keys/{name}/{version}
  const parts = u.pathname.split('/');
  // ['', 'keys', name, version]
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== 'keys') return null;
  const n = validateKeyToken(parts[2], 'kek_key_name');
  const v = validateKeyToken(parts[3], 'kek_key_version');
  if (!n.ok || !v.ok) return null;
  const keyId = buildVersionedKeyId(host, n.value, v.value);
  if (!keyId || keyId !== `https://${host}/keys/${n.value}/${v.value}`) return null;
  // Reject if original differs after reconstruction (case/normalization tricks).
  if (raw !== keyId) return null;
  return { host, name: n.value, version: v.value, keyId };
}

function toBuffer(v) {
  if (Buffer.isBuffer(v)) return Buffer.from(v);
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

/**
 * Validate SDK wrap/unwrap response: own-data `result` required;
 * optional own-data `keyID`/`keyId` must exact-match expected key id when present.
 */
function parseCryptoResult(raw, expectedKeyId) {
  const snap = snapshotOwnDataProps(raw);
  if (!snap.ok) return null;
  const o = snap.value;
  if (!Object.prototype.hasOwnProperty.call(o, 'result')) return null;
  const result = toBuffer(o.result);
  if (!result) return null;
  for (const kidKey of ['keyID', 'keyId']) {
    if (Object.prototype.hasOwnProperty.call(o, kidKey)) {
      const kid = o[kidKey];
      if (typeof kid !== 'string' || kid !== expectedKeyId) return null;
    }
  }
  return result;
}

function wrapCryptoClient(client) {
  const snap = snapshotOwnDataProps(client);
  if (!snap.ok) return null;
  const fns = Object.create(null);
  for (const fn of CRYPTO_FN_KEYS) {
    const r = readOwnData(client, fn);
    if (r.reflection_failed || !r.present || r.accessor || typeof r.value !== 'function') {
      return null;
    }
    fns[fn] = r.value;
  }
  return Object.freeze({
    wrapKey(...args) { return fns.wrapKey.apply(client, args); },
    unwrapKey(...args) { return fns.unwrapKey.apply(client, args); },
  });
}

function mapKvError(e) {
  // Prefer zero provider-level retries; map sanitized transient codes only.
  try {
    const status = e && (e.statusCode ?? e.status ?? e.code);
    const n = typeof status === 'number' ? status : Number(status);
    if (Number.isFinite(n) && TRANSIENT_STATUS.has(n)) {
      return err('envelope_kv_transient');
    }
    if (status === 'ETIMEDOUT' || status === 'ABORT_ERR' || status === 'ENOTFOUND') {
      return err('envelope_kv_transient');
    }
    if (n === 401 || n === 403 || status === 401 || status === 403) {
      return err('envelope_kv_auth_failed');
    }
    if (n === 404 || status === 404) {
      return err('envelope_kv_not_found');
    }
  } catch {
    /* sanitized */
  }
  return err('envelope_kv_failed');
}

/**
 * Validate factory config; fail closed on hostile shapes.
 * @param {unknown} raw
 */
function parseProviderConfig(raw) {
  const snap = snapshotOwnDataProps(raw == null ? null : raw);
  if (!snap.ok) return { ok: false };
  const c = snap.value;

  // trustedVaultHosts: reflection-safe exact own-data dense string array (1..16)
  const hostsSnap = snapshotExactOwnDataStringArray(c.trustedVaultHosts, 1, 16);
  if (!hostsSnap.ok) return { ok: false };
  const hosts = new Set();
  for (const item of hostsSnap.value) {
    if (typeof item !== 'string' || item !== item.trim()) return { ok: false };
    const h = validateHost(item);
    if (!h || h !== item) return { ok: false };
    hosts.add(h);
  }

  // vaultHost optional when allowlist is singleton; else required and must be member
  let vaultHost;
  if (Object.prototype.hasOwnProperty.call(c, 'vaultHost')) {
    vaultHost = validateHost(c.vaultHost);
    if (!vaultHost || vaultHost !== c.vaultHost || !hosts.has(vaultHost)) return { ok: false };
  } else if (hosts.size === 1) {
    vaultHost = [...hosts][0];
  } else {
    return { ok: false };
  }

  const name = validateKeyToken(c.kekKeyName, 'kek_key_name');
  const version = validateKeyToken(c.kekKeyVersion, 'kek_key_version');
  if (!name.ok || !version.ok) return { ok: false };
  if (typeof c.kekKeyName !== 'string' || c.kekKeyName !== name.value) return { ok: false };
  if (typeof c.kekKeyVersion !== 'string' || c.kekKeyVersion !== version.value) return { ok: false };

  // Reject A256KW / non-RSA wrap alg if caller plants wrapAlg
  if (Object.prototype.hasOwnProperty.call(c, 'kekWrapAlg')
    || Object.prototype.hasOwnProperty.call(c, 'wrapAlg')
    || Object.prototype.hasOwnProperty.call(c, 'kek_wrap_alg')) {
    const planted = c.kekWrapAlg ?? c.wrapAlg ?? c.kek_wrap_alg;
    if (planted !== PROD_WRAP_ALG) return { ok: false, reason: 'a256kw_rejected' };
  }

  const gcr = readOwnData(raw, 'getCryptographyClient');
  if (gcr.reflection_failed || !gcr.present || gcr.accessor || typeof gcr.value !== 'function') {
    return { ok: false };
  }

  const keyId = buildVersionedKeyId(vaultHost, name.value, version.value);
  if (!keyId) return { ok: false };

  return {
    ok: true,
    value: Object.freeze({
      trustedVaultHosts: hosts,
      vaultHost,
      kekKeyName: name.value,
      kekKeyVersion: version.value,
      targetKeyId: keyId,
      getCryptographyClient: gcr.value,
      wrapAlg: PROD_WRAP_ALG,
    }),
  };
}

async function resolveClient(cfg, keyId) {
  let rawClient;
  try {
    rawClient = cfg.getCryptographyClient(keyId);
    if (rawClient && typeof rawClient.then === 'function') {
      rawClient = await rawClient;
    }
  } catch (e) {
    throw mapKvError(e);
  }
  const client = wrapCryptoClient(rawClient);
  if (!client) throw err('envelope_kv_client_invalid');
  return client;
}

async function kvWrap(cfg, dek, keyId) {
  if (!Buffer.isBuffer(dek) || dek.length !== DEK_BYTES) throw err('envelope_seal_failed');
  const client = await resolveClient(cfg, keyId);
  let resp;
  try {
    resp = await client.wrapKey(PROD_WRAP_ALG, dek);
  } catch (e) {
    throw mapKvError(e);
  }
  const wrapped = parseCryptoResult(resp, keyId);
  if (!wrapped
    || wrapped.length < MIN_WRAPPED_DEK_BYTES
    || wrapped.length > MAX_WRAPPED_DEK_BYTES) {
    throw err('envelope_kv_response_invalid');
  }
  return wrapped;
}

async function kvUnwrap(cfg, wrapped, keyId) {
  if (!Buffer.isBuffer(wrapped)
    || wrapped.length < MIN_WRAPPED_DEK_BYTES
    || wrapped.length > MAX_WRAPPED_DEK_BYTES) {
    throw err('envelope_open_failed');
  }
  const client = await resolveClient(cfg, keyId);
  let resp;
  try {
    resp = await client.unwrapKey(PROD_WRAP_ALG, wrapped);
  } catch (e) {
    throw mapKvError(e);
  }
  const dek = parseCryptoResult(resp, keyId);
  if (!dek || dek.length !== DEK_BYTES) throw err('envelope_kv_response_invalid');
  return dek;
}

function requireAad(v) {
  return Buffer.isBuffer(v) && v.length > 0 && v.length <= 4096 ? v : null;
}

function requireOperationId(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!s || !UUID_RE.test(s) || s !== String(v).trim().toLowerCase()) return null;
  // Accept already-lowercase or mixed; normalize
  return s;
}

function requireCanonicalAad(aad, expectedOperationId) {
  const parsed = parseGrantEnvelopeAadV1(aad);
  if (!parsed.ok || !parsed.value) return null;
  if (parsed.value.operation_id !== expectedOperationId) return null;
  return parsed.value;
}

function requireCanonicalDeltaCursorAad(aad) {
  const parsed = parseDeltaCursorEnvelopeAadV1(aad);
  return parsed.ok === true && parsed.value ? parsed.value : null;
}

/** @param {object} config trustedVaultHosts, kekKeyName, kekKeyVersion, getCryptographyClient */
function createAzureKvEmailEnvelopeProvider(config, aadPolicy) {
  const parsed = parseProviderConfig(config);
  if (!parsed.ok) {
    if (parsed.reason === 'a256kw_rejected') throw err('envelope_a256kw_rejected');
    throw err('envelope_provider_config_invalid');
  }
  const cfg = parsed.value;

  async function sealGrantPayload(input) {
    const snap = snapshotProviderOpInput(input);
    if (!snap.ok) throw err('envelope_seal_failed');
    const s = snap.value;
    const aad = requireAad(s.aad);
    const operationId = requireOperationId(s.operation_id);
    if (!aad || !operationId) throw err('envelope_seal_failed');
    // Selected AAD policy is fixed by the public factory (grant or delta cursor).
    if (!aadPolicy(aad, operationId)) throw err('envelope_seal_failed');

    let plaintext = null;
    let plaintextOwned = false;
    let dek = null;
    try {
      if (Buffer.isBuffer(s.plaintext)) {
        plaintext = s.plaintext;
      } else if (typeof s.refresh_token === 'string') {
        const enc = encodeDelegatedRefreshPackageV1(s.refresh_token);
        if (!enc.ok) throw err('envelope_seal_failed');
        plaintext = enc.value;
        plaintextOwned = true;
      } else {
        throw err('envelope_seal_failed');
      }

      dek = crypto.randomBytes(DEK_BYTES);
      const nonce = crypto.randomBytes(NONCE_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();
      if (authTag.length !== AUTH_TAG_BYTES) throw err('envelope_seal_failed');

      const wrapped = await kvWrap(cfg, dek, cfg.targetKeyId);
      const envelope = {
        envelope_version: ENVELOPE_VERSION_V1,
        aead_alg: AEAD_ALG_V1,
        kek_wrap_alg: PROD_WRAP_ALG,
        kek_key_name: cfg.kekKeyName,
        kek_key_version: cfg.kekKeyVersion,
        nonce,
        ciphertext,
        auth_tag: authTag,
        wrapped_dek: wrapped,
        operation_id: operationId,
      };
      const v = validateGrantEnvelopeRecordV1(envelope);
      if (!v.ok) throw err('envelope_seal_failed');
      return v.value;
    } finally {
      zeroizeBuffer(dek);
      if (plaintextOwned) zeroizeBuffer(plaintext);
    }
  }

  async function openGrantPayload(input) {
    const snap = snapshotProviderOpInput(input);
    if (!snap.ok) throw err('envelope_open_failed');
    const s = snap.value;
    const aad = requireAad(s.aad);
    const vr = validateGrantEnvelopeRecordV1(s.envelope);
    if (!vr.ok || !aad) throw err('envelope_open_failed');
    const e = vr.value;
    // Selected canonical AAD policy must accept this exact ciphertext context.
    if (!aadPolicy(aad, e.operation_id)) throw err('envelope_open_failed');

    if (e.kek_wrap_alg === 'A256KW') throw err('envelope_a256kw_rejected');
    if (e.kek_wrap_alg !== PROD_WRAP_ALG) throw err('envelope_open_failed');
    // Name must match configured logical KEK; version from envelope (exact pin).
    if (e.kek_key_name !== cfg.kekKeyName) throw err('envelope_open_failed');
    if (isForbiddenVersion(e.kek_key_version)) throw err('envelope_open_failed');

    const keyId = buildVersionedKeyId(cfg.vaultHost, e.kek_key_name, e.kek_key_version);
    if (!keyId) throw err('envelope_open_failed');
    const parsedId = parseVersionedKeyId(keyId, cfg.trustedVaultHosts);
    if (!parsedId || parsedId.keyId !== keyId) throw err('envelope_open_failed');

    let dek = null;
    let plaintext = null;
    try {
      dek = await kvUnwrap(cfg, e.wrapped_dek, keyId);
      const decipher = crypto.createDecipheriv('aes-256-gcm', dek, e.nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(e.auth_tag);
      plaintext = Buffer.concat([decipher.update(e.ciphertext), decipher.final()]);
      const pkg = decodeDelegatedRefreshPackageV1(plaintext);
      if (!pkg.ok) throw err('envelope_open_failed');
      return Object.freeze({ refresh_token: pkg.value.refresh_token });
    } catch (ex) {
      if (ex && typeof ex.code === 'string' && String(ex.code).startsWith('envelope_')) throw ex;
      // GCM auth failure / decode → open failed (no planted text)
      throw err('envelope_open_failed');
    } finally {
      zeroizeBuffer(dek);
      zeroizeBuffer(plaintext);
    }
  }

  /**
   * FULL decrypt + reseal under next_aad and target configured KEK.
   * Input exact: { envelope, aad, next_aad, operation_id }.
   * Rejects missing/same next_aad. Never pure DEK rewrap.
   */
  async function rewrapGrantDek(input) {
    const snap = snapshotProviderOpInput(input);
    if (!snap.ok) throw err('envelope_rewrap_failed');
    const s = snap.value;
    const aad = requireAad(s.aad);
    const nextAad = requireAad(s.next_aad);
    const operationId = requireOperationId(s.operation_id);
    if (!aad || !nextAad || !operationId) throw err('envelope_rewrap_failed');

    // Semantic AAD binding (not Buffer inequality alone).
    const oldCanon = parseGrantEnvelopeAadV1(aad);
    const nextCanon = parseGrantEnvelopeAadV1(nextAad);
    if (!oldCanon.ok || !nextCanon.ok) throw err('envelope_rewrap_failed');
    const oldA = oldCanon.value;
    const nextA = nextCanon.value;
    if (nextA.operation_id !== operationId) throw err('envelope_rewrap_failed');
    if (oldA.client_id !== nextA.client_id || oldA.endpoint_id !== nextA.endpoint_id) {
      throw err('envelope_rewrap_failed');
    }
    // Custodian advances exactly one generation per rewrap.
    if (nextA.grant_generation !== oldA.grant_generation + 1n) {
      throw err('envelope_rewrap_failed');
    }

    const vr = validateGrantEnvelopeRecordV1(s.envelope);
    if (!vr.ok) throw err('envelope_rewrap_failed');
    // Old canonical AAD op must match old envelope.operation_id.
    if (oldA.operation_id !== vr.value.operation_id) throw err('envelope_rewrap_failed');

    let opened;
    try {
      opened = await openGrantPayload({ envelope: s.envelope, aad });
    } catch (ex) {
      if (ex && ex.code === 'envelope_a256kw_rejected') throw ex;
      throw err('envelope_rewrap_failed');
    }
    const token = opened && typeof opened.refresh_token === 'string' ? opened.refresh_token : null;
    if (!token) throw err('envelope_rewrap_failed');

    try {
      return await sealGrantPayload({
        refresh_token: token,
        aad: nextAad,
        operation_id: operationId,
      });
    } catch (ex) {
      if (ex && typeof ex.code === 'string' && String(ex.code).startsWith('envelope_')) throw ex;
      throw err('envelope_rewrap_failed');
    }
  }

  return Object.freeze({
    sealGrantPayload,
    openGrantPayload,
    rewrapGrantDek,
  });
}

function createAzureKvEmailGrantEnvelopeProvider(config) {
  return createAzureKvEmailEnvelopeProvider(config, requireCanonicalAad);
}

function createAzureKvEmailDeltaCursorEnvelopeProvider(config) {
  return createAzureKvEmailEnvelopeProvider(config, requireCanonicalDeltaCursorAad);
}

module.exports = {
  createAzureKvEmailGrantEnvelopeProvider,
  createAzureKvEmailDeltaCursorEnvelopeProvider,
  buildVersionedKeyId,
  parseVersionedKeyId,
  PROD_WRAP_ALG,
  CRYPTO_FN_KEYS,
};
