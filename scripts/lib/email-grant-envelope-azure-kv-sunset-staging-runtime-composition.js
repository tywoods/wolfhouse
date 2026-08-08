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
 * No production DI/test second-arg hook — tests intercept Node module loading only.
 * SDK exports: own data descriptors only (pinned isProxy; zero getter invocation).
 *
 * @module email-grant-envelope-azure-kv-sunset-staging-runtime-composition
 */

const util = require('util');
const {
  createAzureKvEmailGrantEnvelopeProvider,
  buildVersionedKeyId,
  parseVersionedKeyId,
  PROD_WRAP_ALG,
} = require('./email-grant-envelope-azure-kv-provider');

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
const ENV_COMPOSITION_ENABLED = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED';
const ENV_TRUSTED_HOST = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST';
const ENV_VERSIONED_KEY_ID = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID';
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

/**
 * Own data-descriptor export only. Never mod[name] (invokes getters).
 * Rejects module proxies, inherited members, accessors, non-functions, export proxies.
 */
function readOwnDataExport(mod, name) {
  try {
    if (mod == null || (typeof mod !== 'object' && typeof mod !== 'function') || isProxy(mod)) {
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(mod, name)) return null;
    const d = Object.getOwnPropertyDescriptor(mod, name);
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set) return null;
    if (typeof d.value !== 'function' || isProxy(d.value)) return null;
    return d.value;
  } catch { return null; }
}

/** Lazy load Azure SDKs; every require/export failure → fixed sdk_unavailable. */
function loadAzureSdks() {
  let identity; let keys;
  try {
    identity = require('@azure/identity');
    keys = require('@azure/keyvault-keys');
  } catch {
    throw err('envelope_azure_kv_sdk_unavailable');
  }
  try {
    if (isProxy(identity) || isProxy(keys)) {
      throw err('envelope_azure_kv_sdk_unavailable');
    }
    const MIC = readOwnDataExport(identity, 'ManagedIdentityCredential');
    const CC = readOwnDataExport(keys, 'CryptographyClient');
    if (typeof MIC !== 'function' || typeof CC !== 'function') {
      throw err('envelope_azure_kv_sdk_unavailable');
    }
    return Object.freeze({ ManagedIdentityCredential: MIC, CryptographyClient: CC });
  } catch (e) {
    if (e && e.code === 'envelope_azure_kv_sdk_unavailable') throw e;
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

/**
 * Explicit Sunset-staging-canary factory. Accepts env only (one argument).
 * Always lazy-loads @azure/identity + @azure/keyvault-keys and constructs
 * ManagedIdentityCredential(source-pinned client ID) + CryptographyClient(exact
 * versioned key ID, maxRetries=0). No production DI / second-arg test hook.
 */
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

  let provider;
  try {
    provider = createAzureKvEmailGrantEnvelopeProvider({
      trustedVaultHosts: [SUNSET_STAGING_TRUSTED_HOST],
      vaultHost: SUNSET_STAGING_TRUSTED_HOST,
      kekKeyName: SUNSET_STAGING_KEK_KEY_NAME,
      kekKeyVersion: SUNSET_STAGING_KEK_KEY_VERSION,
      getCryptographyClient,
    });
  } catch (e) {
    throwSanitized(e, 'envelope_provider_config_invalid');
  }

  return Object.freeze({
    ok: true, composition_enabled: true, runtime_activation: false,
    deployment_boundary: 'sunset-staging-canary-only',
    provider, public_metadata: publicMetadata(),
  });
}

module.exports = {
  createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition,
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
  ENV_KEYS,
  CRYPTO_CLIENT_OPTIONS,
  PROD_WRAP_ALG,
};
