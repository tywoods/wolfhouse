'use strict';

/**
 * Slice 2F-C2: Sunset-staging-only Azure KV email-grant envelope runtime composition
 * (default-off canary). Hard-pinned host/key/version/MI — never deploy elsewhere.
 * Production/other tenants/DR/key rotation need a separately reviewed profile.
 * Future tenants must create an analogous explicit module; never reuse Sunset silently.
 *
 * Credential: ManagedIdentityCredential(clientId=0e05fbe3-e8c5-48aa-a914-30aed284e6f7)
 * only — never DefaultAzureCredential; never AZURE_CLIENT_ID/TENANT_ID/CLIENT_SECRET
 * or request/env selected identity. Prior live Azure evidence linked that client ID to
 * principal 5338388f-1685-40cb-ae69-dc2e00f32ad6. Current Azure readback of the MI
 * client ID is mandatory before any deploy. Lazy SDK require; import-inert; factory only.
 * No production DI. App trust root realpath(__dirname/../..)/node_modules only (never
 * cwd/env/NODE_PATH). require.resolve must realpath under exact @azure/{identity,keyvault-keys};
 * no symlink escape. Pins 4.13.1/4.10.2 + SHA-256 package.json/entry/deep; MIC own-data.
 * KV esbuild deep getter only after app-root/path/version/hash trust (trusted package code only).
 * Trust claim: protects untrusted NODE_PATH/symlink/layout/tampering at load boundaries under
 * immutable app dependency tree (image node_modules = execution trust boundary for deep relative
 * requires). Does not claim defense after arbitrary local filesystem write/code execution.
 *
 * @module email-grant-envelope-azure-kv-sunset-staging-runtime-composition
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { createAzureKvEmailGrantEnvelopeProvider, createAzureKvEmailDeltaCursorEnvelopeProvider,
  buildVersionedKeyId, parseVersionedKeyId, PROD_WRAP_ALG } = require('./email-grant-envelope-azure-kv-provider');

// Module-init pin: ambient util.types.isProxy monkeypatches after load must not weaken.
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy : null;

const SUNSET_STAGING_MI_CLIENT_ID = '0e05fbe3-e8c5-48aa-a914-30aed284e6f7';
const SUNSET_STAGING_MI_PRINCIPAL_ID = '5338388f-1685-40cb-ae69-dc2e00f32ad6';
const SUNSET_STAGING_TRUSTED_HOST = 'luna-sunset-staging-kv.vault.azure.net';
const SUNSET_STAGING_KEK_KEY_NAME = 'luna-email-grant-kek';
const SUNSET_STAGING_KEK_KEY_VERSION = 'fde9704bd37b45fabe1f12a6a615b032';
const SUNSET_STAGING_VERSIONED_KEY_ID = (
  `https://${SUNSET_STAGING_TRUSTED_HOST}`
  + `/keys/${SUNSET_STAGING_KEK_KEY_NAME}/${SUNSET_STAGING_KEK_KEY_VERSION}`
);
const ENV_COMPOSITION_ENABLED = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED',
  ENV_TRUSTED_HOST = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST',
  ENV_VERSIONED_KEY_ID = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID',
  ENV_RUNTIME_ACTIVATION_ENABLED = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_SUNSET_STAGING_RUNTIME_ACTIVATION_ENABLED';
const ENV_KEYS = Object.freeze([
  ENV_COMPOSITION_ENABLED, ENV_TRUSTED_HOST, ENV_VERSIONED_KEY_ID,
]);
const CRYPTO_CLIENT_OPTIONS = Object.freeze({
  retryOptions: Object.freeze({ maxRetries: 0 }),
});
const SUNSET_STAGING_EMAIL_GRANT_KEK = Object.freeze({
  deployment_boundary: 'sunset-staging-canary-only',
  trusted_host: SUNSET_STAGING_TRUSTED_HOST,
  kek_key_name: SUNSET_STAGING_KEK_KEY_NAME,
  kek_key_version: SUNSET_STAGING_KEK_KEY_VERSION,
  versioned_key_id: SUNSET_STAGING_VERSIONED_KEY_ID,
  managed_identity_client_id: SUNSET_STAGING_MI_CLIENT_ID,
  managed_identity_principal_id_evidence: SUNSET_STAGING_MI_PRINCIPAL_ID,
  wrap_alg: PROD_WRAP_ALG,
});

function err(code) {
  const c = String(code);
  return Object.assign(new Error(c), { code: c });
}

/**
 * Never read dependency exception properties (code getters, proxy ownKeys /
 * getOwnPropertyDescriptor / getPrototypeOf can throw or plant text).
 * Always throw a newly-created fixed-code error.
 */
function throwSanitized(_maybe, fallback) {
  throw err(fallback);
}

function readEnvString(env, key) {
  try {
    if (env == null || (typeof env !== 'object' && typeof env !== 'function')) {
      return { ok: false };
    }
    if (!Object.prototype.hasOwnProperty.call(env, key)) return { ok: true, present: false };
    const desc = Object.getOwnPropertyDescriptor(env, key);
    if (!desc) return { ok: false };
    if (typeof desc.get === 'function' || typeof desc.set === 'function') return { ok: false };
    if (typeof desc.value !== 'string') return { ok: false };
    return { ok: true, present: true, value: desc.value };
  } catch {
    return { ok: false };
  }
}

function invalidCfg() {
  return Object.freeze({ ok: false, code: 'envelope_azure_kv_composition_config_invalid' });
}

function parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig(env) {
  try {
    if (env == null || typeof env !== 'object' || Array.isArray(env)) return invalidCfg();
    const en = readEnvString(env, ENV_COMPOSITION_ENABLED);
    if (!en.ok) return invalidCfg();
    if (!en.present || en.value.trim().toLowerCase() !== 'true') {
      return Object.freeze({
        ok: true, composition_enabled: false,
        code: 'envelope_azure_kv_composition_disabled',
      });
    }
    const hostR = readEnvString(env, ENV_TRUSTED_HOST);
    const kidR = readEnvString(env, ENV_VERSIONED_KEY_ID);
    if (!hostR.ok || !kidR.ok || !hostR.present || !kidR.present) return invalidCfg();
    if (hostR.value !== SUNSET_STAGING_TRUSTED_HOST) return invalidCfg();
    if (kidR.value !== SUNSET_STAGING_VERSIONED_KEY_ID) return invalidCfg();
    const parsed = parseVersionedKeyId(kidR.value, new Set([SUNSET_STAGING_TRUSTED_HOST]));
    if (!parsed || parsed.keyId !== SUNSET_STAGING_VERSIONED_KEY_ID
      || parsed.host !== SUNSET_STAGING_TRUSTED_HOST
      || parsed.name !== SUNSET_STAGING_KEK_KEY_NAME
      || parsed.version !== SUNSET_STAGING_KEK_KEY_VERSION) return invalidCfg();
    if (buildVersionedKeyId(
      SUNSET_STAGING_TRUSTED_HOST, SUNSET_STAGING_KEK_KEY_NAME, SUNSET_STAGING_KEK_KEY_VERSION,
    ) !== SUNSET_STAGING_VERSIONED_KEY_ID) return invalidCfg();
    return Object.freeze({
      ok: true, composition_enabled: true,
      deployment_boundary: 'sunset-staging-canary-only',
      trusted_host: SUNSET_STAGING_TRUSTED_HOST,
      kek_key_name: SUNSET_STAGING_KEK_KEY_NAME,
      kek_key_version: SUNSET_STAGING_KEK_KEY_VERSION,
      versioned_key_id: SUNSET_STAGING_VERSIONED_KEY_ID,
      managed_identity_client_id: SUNSET_STAGING_MI_CLIENT_ID,
      wrap_alg: PROD_WRAP_ALG,
    });
  } catch {
    return invalidCfg();
  }
}

/** Pinned native isProxy; missing pin / throw → treat as proxy (fail closed). */
function isProxy(v) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [v]) === true;
  } catch { return true; }
}

/** Own enumerable data export only. Never mod[name] (invokes getters). */
function readOwnDataExport(mod, name) {
  try {
    if (mod == null || (typeof mod !== 'object' && typeof mod !== 'function') || isProxy(mod)) return null;
    if (!Object.prototype.hasOwnProperty.call(mod, name)) return null;
    const d = Object.getOwnPropertyDescriptor(mod, name);
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || d.enumerable !== true) return null;
    if (typeof d.value !== 'function' || isProxy(d.value)) return null;
    return d.value;
  } catch { return null; }
}

const AZ_ID = Object.freeze({
  name: '@azure/identity', ver: '4.13.1',
  entry: Object.freeze(['@azure', 'identity', 'dist', 'commonjs', 'index.js']),
  deep: Object.freeze(['credentials', 'managedIdentityCredential', 'index.js']),
  deepTail: Object.freeze(['@azure', 'identity', 'dist', 'commonjs', 'credentials', 'managedIdentityCredential', 'index.js']),
});
const AZ_KV = Object.freeze({
  name: '@azure/keyvault-keys', ver: '4.10.2',
  entry: Object.freeze(['@azure', 'keyvault-keys', 'dist', 'commonjs', 'index.js']),
  deep: Object.freeze(['cryptographyClient.js']),
  deepTail: Object.freeze(['@azure', 'keyvault-keys', 'dist', 'commonjs', 'cryptographyClient.js']),
});
// sha256sum identity@4.13.1 / keyvault-keys@4.10.2 pkg+entry+deep (immutable image nm boundary)
const AZ_ID_SHA256 = Object.freeze({
  pkg: '70f61fd65648da7d70750d17de2b726d3892d3cfd9637643d4e1c82c649620b9',
  entry: 'e5a4a6896ba1b8897f3dabde0026d655de3a8fa91bcafe7ecac3950811ae2ce5',
  deep: '93d90cef99db00060c2eeb491b670d6c9873a38827884eb2a284b43e92735049',
});
const AZ_KV_SHA256 = Object.freeze({
  pkg: 'fba35e5ad7170acbb9ddfee80295cab110a4bed12fabb49c41bee68bced11219',
  entry: '6446bacc816ef74c11e05d18ee884f953d6e18afbb3e0f9ca44ff3ff1b9e5c3b',
  deep: 'a63ec9cca669e97f3f2f4c908a1896c27a627a4f7d673be0419ae72259f1d900',
});
function segsEnd(abs, tail) {
  try {
    if (typeof abs !== 'string' || !path.isAbsolute(abs) || !Array.isArray(tail)) return false;
    const s = path.resolve(abs).split(path.sep).filter(Boolean);
    if (s.length < tail.length) return false;
    for (let i = 0; i < tail.length; i += 1) if (s[s.length - tail.length + i] !== tail[i]) return false;
    return true;
  } catch { return false; }
}
function realFile(p) {
  try {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
    const r = fs.realpathSync.native(p);
    return (typeof r === 'string' && path.isAbsolute(r) && fs.statSync(r).isFile()) ? r : null;
  } catch { return null; }
}
function under(file, root) {
  try { const f = path.resolve(file); const r = path.resolve(root); return f === r || f.startsWith(r + path.sep); }
  catch { return false; }
}
function fileSha256(abs) {
  try {
    if (typeof abs !== 'string' || !path.isAbsolute(abs)) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch { return null; }
}
/** Immutable app root from this source file — never process.cwd / env / NODE_PATH. */
const APP_ROOT = (() => {
  try { const r = fs.realpathSync.native(path.resolve(__dirname, '..', '..'));
    return (typeof r === 'string' && path.isAbsolute(r)) ? r : null; } catch { return null; }
})();
const APP_NM_ROOT = (() => {
  try {
    if (!APP_ROOT) return null;
    const r = fs.realpathSync.native(path.join(APP_ROOT, 'node_modules'));
    return (typeof r === 'string' && path.isAbsolute(r) && under(r, APP_ROOT)
      && path.basename(r) === 'node_modules') ? r : null;
  } catch { return null; }
})();
function pinnedMeta(root, name, ver) {
  try {
    const pf = realFile(path.join(root, 'package.json'));
    if (!pf || !under(pf, root)) return false;
    const m = JSON.parse(fs.readFileSync(pf, 'utf8'));
    if (m == null || typeof m !== 'object' || Array.isArray(m) || isProxy(m)) return false;
    const n = Object.getOwnPropertyDescriptor(m, 'name');
    const v = Object.getOwnPropertyDescriptor(m, 'version');
    if (!n || !v || n.get || n.set || v.get || v.set || n.enumerable !== true || v.enumerable !== true) return false;
    return n.value === name && v.value === ver;
  } catch { return false; }
}
/**
 * require.resolve for discovery only. Authority is exact app node_modules/@azure/{pkg}
 * realpath (no NODE_PATH spoof / symlink escape). Outside-root resolve → reject.
 */
function resolveEntry(pin) {
  if (!APP_NM_ROOT || !pin || !Array.isArray(pin.entry) || pin.entry.length < 2) return null;
  let trustedRoot;
  try { trustedRoot = fs.realpathSync.native(path.join(APP_NM_ROOT, pin.entry[0], pin.entry[1])); }
  catch { return null; }
  if (typeof trustedRoot !== 'string' || !path.isAbsolute(trustedRoot) || !under(trustedRoot, APP_NM_ROOT)) return null;
  if (path.relative(APP_NM_ROOT, trustedRoot) !== path.join(pin.entry[0], pin.entry[1])) return null;
  if (!segsEnd(trustedRoot, pin.entry.slice(0, 2)) || !pinnedMeta(trustedRoot, pin.name, pin.ver)) return null;
  let resolved; try { resolved = require.resolve(pin.name); } catch { return null; }
  if (typeof resolved !== 'string' || !path.isAbsolute(resolved)) return null;
  const entry = realFile(resolved);
  if (!entry || !segsEnd(entry, pin.entry) || !under(entry, trustedRoot)) return null;
  return Object.freeze({ entry, root: trustedRoot });
}
function resolveDeep(info, pin) {
  try {
    const deep = realFile(path.resolve(path.dirname(info.entry), ...pin.deep));
    return (deep && under(deep, info.root) && segsEnd(deep, pin.deepTail)) ? deep : null;
  } catch { return null; }
}
/** Before require: realpath pkg/entry/deep + SHA-256 vs pins (identity@4.13.1 / keyvault@4.10.2). */
function pinIdentityBeforeRequire(info, pin, digests) {
  try {
    const pkg = realFile(path.join(info.root, 'package.json'));
    const entry = realFile(info.entry); const deep = resolveDeep(info, pin);
    if (!pkg || !entry || !deep || entry !== info.entry) return null;
    if (!under(pkg, info.root) || !under(entry, info.root) || !under(deep, info.root)) return null;
    const hPkg = fileSha256(pkg); const hEntry = fileSha256(entry); const hDeep = fileSha256(deep);
    if (!hPkg || !hEntry || !hDeep || hPkg !== digests.pkg || hEntry !== digests.entry || hDeep !== digests.deep) return null;
    return Object.freeze({ pkg, entry, deep, root: info.root, hPkg, hEntry, hDeep });
  } catch { return null; }
}
/** After require: re-realpath/re-hash + require.cache filename; exact before/pin/app-root match. */
function pinIdentityAfterRequire(before, digests) {
  try {
    if (!before || !APP_NM_ROOT) return false;
    const pkg = realFile(before.pkg); const entry = realFile(before.entry); const deep = realFile(before.deep);
    if (!pkg || !entry || !deep || pkg !== before.pkg || entry !== before.entry || deep !== before.deep) return false;
    if (!under(pkg, before.root) || !under(entry, before.root) || !under(deep, before.root)) return false;
    if (!under(pkg, APP_NM_ROOT) || !under(entry, APP_NM_ROOT) || !under(deep, APP_NM_ROOT)) return false;
    const hPkg = fileSha256(pkg); const hEntry = fileSha256(entry); const hDeep = fileSha256(deep);
    if (hPkg !== digests.pkg || hEntry !== digests.entry || hDeep !== digests.deep) return false;
    if (hPkg !== before.hPkg || hEntry !== before.hEntry || hDeep !== before.hDeep) return false;
    const cached = require.cache[before.deep] || require.cache[deep];
    if (!cached || typeof cached.filename !== 'string') return false;
    const cf = realFile(cached.filename);
    return !!(cf && cf === before.deep && cf === deep && under(cf, before.root) && under(cf, APP_NM_ROOT)
      && fileSha256(cf) === digests.deep);
  } catch { return false; }
}
/** Pinned KV esbuild getter — only after app-root/path/version/hash trust; trusted package code only. */
function readPinnedDeepEsbuild(mod, name) {
  try {
    if (mod == null || (typeof mod !== 'object' && typeof mod !== 'function') || isProxy(mod)) return null;
    if (!Object.prototype.hasOwnProperty.call(mod, name)) return null;
    const d = Object.getOwnPropertyDescriptor(mod, name);
    if (!d || typeof d.get !== 'function' || d.set || Object.prototype.hasOwnProperty.call(d, 'value') || d.enumerable !== true) return null;
    let v; try { v = Reflect.apply(d.get, mod, []); } catch { return null; }
    return (typeof v === 'function' && !isProxy(v)) ? v : null;
  } catch { return null; }
}

function loadAzureSdks() {
  try {
    if (!APP_ROOT || !APP_NM_ROOT) throw err('envelope_azure_kv_sdk_unavailable');
    const id = resolveEntry(AZ_ID); const kv = resolveEntry(AZ_KV);
    if (!id || !kv) throw err('envelope_azure_kv_sdk_unavailable');
    const idPin = pinIdentityBeforeRequire(id, AZ_ID, AZ_ID_SHA256);
    const kvPin = pinIdentityBeforeRequire(kv, AZ_KV, AZ_KV_SHA256);
    if (!idPin || !kvPin) throw err('envelope_azure_kv_sdk_unavailable');
    // Deep relative deps load from immutable app image node_modules (execution trust boundary).
    let micMod; let ccMod;
    try { micMod = require(idPin.deep); ccMod = require(kvPin.deep); }
    catch { throw err('envelope_azure_kv_sdk_unavailable'); }
    if (!pinIdentityAfterRequire(idPin, AZ_ID_SHA256) || !pinIdentityAfterRequire(kvPin, AZ_KV_SHA256)) {
      throw err('envelope_azure_kv_sdk_unavailable');
    }
    if (isProxy(micMod) || isProxy(ccMod)) throw err('envelope_azure_kv_sdk_unavailable');
    const MIC = readOwnDataExport(micMod, 'ManagedIdentityCredential');
    let CC = readOwnDataExport(ccMod, 'CryptographyClient');
    if (!CC && segsEnd(kvPin.deep, AZ_KV.deepTail) && under(kvPin.deep, kv.root)) {
      CC = readPinnedDeepEsbuild(ccMod, 'CryptographyClient');
    }
    if (typeof MIC !== 'function' || typeof CC !== 'function') throw err('envelope_azure_kv_sdk_unavailable');
    return Object.freeze({ ManagedIdentityCredential: MIC, CryptographyClient: CC });
  } catch { /* Never read e.code/e.message — always fresh fixed error. */
    throw err('envelope_azure_kv_sdk_unavailable');
  }
}

function publicMetadata() {
  return Object.freeze({
    composition_enabled: true, runtime_activation: false,
    deployment_boundary: 'sunset-staging-canary-only',
    trusted_host: SUNSET_STAGING_TRUSTED_HOST,
    kek_key_name: SUNSET_STAGING_KEK_KEY_NAME,
    kek_key_version: SUNSET_STAGING_KEK_KEY_VERSION,
    wrap_alg: PROD_WRAP_ALG,
  });
}

/** Adapt Azure's prototype methods to the provider's narrow own-data contract. */
function bindCryptographyClient(client) {
  let wrapKey; let unwrapKey;
  try {
    wrapKey = client && client.wrapKey;
    unwrapKey = client && client.unwrapKey;
  } catch {
    throw err('envelope_kv_client_invalid');
  }
  if (typeof wrapKey !== 'function' || typeof unwrapKey !== 'function') {
    throw err('envelope_kv_client_invalid');
  }
  return Object.freeze({
    async wrapKey(...args) { return wrapKey.apply(client, args); },
    async unwrapKey(...args) { return unwrapKey.apply(client, args); },
  });
}

/** Explicit Sunset canary factory (env only); deep Azure constructors; no package-root getters/DI. */
function createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(env) {
  const cfg = parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig(
    env === undefined ? process.env : env,
  );
  if (!cfg.ok) throw err(cfg.code || 'envelope_azure_kv_composition_config_invalid');
  if (!cfg.composition_enabled) {
    return Object.freeze({
      ok: false, composition_enabled: false,
      code: 'envelope_azure_kv_composition_disabled',
      runtime_activation: false,
      deployment_boundary: 'sunset-staging-canary-only',
    });
  }

  const sdks = loadAzureSdks();
  let credential; let cryptoClient;
  try {
    // Pin client ID in source — ignore AZURE_CLIENT_ID / secrets / request.
    credential = new sdks.ManagedIdentityCredential(SUNSET_STAGING_MI_CLIENT_ID);
    cryptoClient = new sdks.CryptographyClient(
      SUNSET_STAGING_VERSIONED_KEY_ID, credential, CRYPTO_CLIENT_OPTIONS,
    );
  } catch (e) {
    throwSanitized(e, 'envelope_kv_failed');
  }
  if (cryptoClient == null || typeof cryptoClient !== 'object') {
    throw err('envelope_kv_client_invalid');
  }
  const boundCryptoClient = bindCryptographyClient(cryptoClient);

  function getCryptographyClient(fullVersionedKeyId) {
    if (fullVersionedKeyId !== SUNSET_STAGING_VERSIONED_KEY_ID) {
      throw err('envelope_kv_client_invalid');
    }
    return boundCryptoClient;
  }

  let provider; let cursorProvider;
  try {
    const providerConfig = Object.freeze({
      trustedVaultHosts: [SUNSET_STAGING_TRUSTED_HOST],
      vaultHost: SUNSET_STAGING_TRUSTED_HOST,
      kekKeyName: SUNSET_STAGING_KEK_KEY_NAME,
      kekKeyVersion: SUNSET_STAGING_KEK_KEY_VERSION,
      getCryptographyClient,
    });
    provider = createAzureKvEmailGrantEnvelopeProvider(providerConfig);
    cursorProvider = createAzureKvEmailDeltaCursorEnvelopeProvider(providerConfig);
  } catch (e) {
    throwSanitized(e, 'envelope_provider_config_invalid');
  }

  return Object.freeze({
    ok: true, composition_enabled: true, runtime_activation: false,
    deployment_boundary: 'sunset-staging-canary-only',
    provider, cursorProvider, public_metadata: publicMetadata(),
  });
}

/** Separately reviewed active surface; the legacy factory remains default-off. */
function createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(env) {
  const source = env === undefined ? process.env : env;
  const activation = readEnvString(source, ENV_RUNTIME_ACTIVATION_ENABLED);
  if (!activation.ok || !activation.present || activation.value !== 'true') {
    throw err('envelope_azure_kv_runtime_activation_disabled');
  }
  const composition = createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(source);
  if (!composition || composition.ok !== true || composition.composition_enabled !== true
      || composition.runtime_activation !== false) {
    throw err('envelope_azure_kv_runtime_activation_disabled');
  }
  return Object.freeze({
    ok: true, composition_enabled: true, runtime_activation: true,
    deployment_boundary: composition.deployment_boundary,
    provider: composition.provider, cursorProvider: composition.cursorProvider,
    public_metadata: Object.freeze({ ...composition.public_metadata, runtime_activation: true }),
  });
}

module.exports = {
  createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition, createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition,
  parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig,
  SUNSET_STAGING_EMAIL_GRANT_KEK,
  SUNSET_STAGING_TRUSTED_HOST,
  SUNSET_STAGING_KEK_KEY_NAME,
  SUNSET_STAGING_KEK_KEY_VERSION,
  SUNSET_STAGING_VERSIONED_KEY_ID,
  SUNSET_STAGING_MI_CLIENT_ID,
  SUNSET_STAGING_MI_PRINCIPAL_ID,
  ENV_COMPOSITION_ENABLED,
  ENV_TRUSTED_HOST,
  ENV_VERSIONED_KEY_ID,
  ENV_RUNTIME_ACTIVATION_ENABLED,
  ENV_KEYS,
  CRYPTO_CLIENT_OPTIONS,
  PROD_WRAP_ALG,
};
