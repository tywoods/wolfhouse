'use strict';
/** Gate 3 Phase B PR B2b — dormant sunset-staging Phase B callback runtime (import inert). */
const util = require('util');
const { Client: PgClient } = require('pg');
const {
  createPostgresPhaseBOauthTransactionConsumer, createMicrosoftPhaseBOauthCallbackCompletionService,
  CALLBACK_ENABLED_ENV, isCallbackEnabled, SUNSET_DEPLOYMENT: CB_SUNSET,
} = require('./email-microsoft-phase-b-oauth-callback-completion');
const {
  createMicrosoftPhaseBOauthOperationComposition, SUNSET_DEPLOYMENT: OP_SUNSET,
} = require('./email-microsoft-phase-b-oauth-operation-composition');
const { createMicrosoftPhaseBVerifiedGrantReplacer } = require('./email-microsoft-phase-b-verified-grant-replacer');
const {
  createSunsetMicrosoftOAuthClientSecretProvider, SUNSET_DEPLOYMENT: SECRET_SUNSET,
} = require('./sunset-microsoft-oauth-provider');
const { createMicrosoftOidcJwksSignatureVerifier } = require('./email-microsoft-oidc-jwks-verifier');
const { createMicrosoftOidcIdTokenValidator } = require('./email-microsoft-oidc-id-token');
const { createMicrosoftGraphMeIdentityTransport } = require('./email-microsoft-graph-me-identity');
const { createMicrosoftVerifiedIdentityComposition } = require('./email-microsoft-verified-identity');
const {
  createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition,
  parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig,
  ENV_COMPOSITION_ENABLED, ENV_TRUSTED_HOST, ENV_VERSIONED_KEY_ID,
} = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const { validateEmailGrantEnvelopeProvider } = require('./email-grant-envelope-provider-contract');
const {
  resolveOptionalStageTelemetry, createNoopEmailOAuthStageTelemetry,
} = require('./email-microsoft-oauth-stage-telemetry');
const UT = util.types && typeof util.types === 'object' ? util.types : null;
const ISP = UT && typeof UT.isProxy === 'function' ? UT.isProxy : null;
const PG_CLIENT_PROTO = PgClient && PgClient.prototype;
const PG_QUERY_DESC = PG_CLIENT_PROTO && Object.getOwnPropertyDescriptor(PG_CLIENT_PROTO, 'query');
const PG_QUERY_FN = PG_QUERY_DESC && Object.prototype.hasOwnProperty.call(PG_QUERY_DESC, 'value')
  && !PG_QUERY_DESC.get && !PG_QUERY_DESC.set && typeof PG_QUERY_DESC.value === 'function' ? PG_QUERY_DESC.value : null;
const PG_CTOR_DESC = PG_CLIENT_PROTO && Object.getOwnPropertyDescriptor(PG_CLIENT_PROTO, 'constructor');
const PG_NATIVE_PINNED = typeof PgClient === 'function' && PG_CLIENT_PROTO && PG_QUERY_FN
  && PG_CTOR_DESC && PG_CTOR_DESC.value === PgClient && !PG_CTOR_DESC.get && !PG_CTOR_DESC.set;
const ERROR_CODE = 'MICROSOFT_PHASE_B_OAUTH_RUNTIME_COMPOSITION_INVALID';
const ERROR_MESSAGE = 'Microsoft Phase B OAuth runtime composition failed.';
const SUNSET_DEPLOYMENT = 'sunset-staging';
// B3a2b: route-wired/safe; deferred (flag default-off); import inert without flag.
const EMAIL_MS_PHASE_B_CALLBACK_RUNTIME_WIRED = true;
const EMAIL_MS_PHASE_B_CALLBACK_DEFERRED_ACTIVATION = true;
const EMAIL_MS_PHASE_B_CALLBACK_SAFE_FOR_RUNTIME_ROUTE = true;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPENDENCY_KEYS = Object.freeze(['env', 'pgClient', 'https', 'crypto', 'timers']);
const HTTPS_KEYS = Object.freeze(['request']);
const CRYPTO_KEYS = Object.freeze(['createPublicKey', 'verify']);
const TIMERS_KEYS = Object.freeze(['setTimeout', 'clearTimeout']);
const POOL_HINTS = Object.freeze(['totalCount', 'idleCount', 'waitingCount']);
const SNAP_ENV_KEYS = Object.freeze(['LUNA_DEPLOYMENT', 'LUNA_EMAIL_OAUTH_CLIENT_ID', CALLBACK_ENABLED_ENV,
  ENV_COMPOSITION_ENABLED, ENV_TRUSTED_HOST, ENV_VERSIONED_KEY_ID, 'LUNA_EMAIL_OAUTH_CLIENT_SECRET']);
if (CB_SUNSET !== SUNSET_DEPLOYMENT || OP_SUNSET !== SUNSET_DEPLOYMENT || SECRET_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('phase_b_oauth_runtime_composition_sunset_deployment_mismatch');
}
if (EMAIL_MS_PHASE_B_CALLBACK_RUNTIME_WIRED !== true || EMAIL_MS_PHASE_B_CALLBACK_DEFERRED_ACTIVATION !== true
    || EMAIL_MS_PHASE_B_CALLBACK_SAFE_FOR_RUNTIME_ROUTE !== true) {
  throw new Error('phase_b_oauth_runtime_composition_activation_unexpected');
}
function failure() {
  const e = new Error(ERROR_MESSAGE);
  Object.defineProperty(e, 'name', { value: 'MicrosoftPhaseBOauthRuntimeCompositionError' });
  Object.defineProperty(e, 'code', { value: ERROR_CODE, enumerable: true }); return Object.freeze(e);
}
function isProxy(v) {
  try { if (typeof ISP !== 'function' || !UT) return true; return Reflect.apply(ISP, UT, [v]) === true; }
  catch { return true; }
}
function own(o, k) {
  try {
    if (o == null || isProxy(o)) return undefined;
    const d = Object.getOwnPropertyDescriptor(o, k);
    return d && Object.prototype.hasOwnProperty.call(d, 'value') && !d.get && !d.set ? d.value : undefined;
  } catch { return undefined; }
}
function ownFn(o, k) {
  try {
    if (o == null || isProxy(o) || (typeof o !== 'object' && typeof o !== 'function')) return null;
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || typeof d.value !== 'function') return null;
    return d.value;
  } catch { return null; }
}
function snapNative(raw, keys) {
  try {
    if (!raw || isProxy(raw) || (typeof raw !== 'object' && typeof raw !== 'function') || Array.isArray(raw)) return null;
    const owner = raw; const out = {};
    for (const key of keys) {
      const fn = ownFn(raw, key); if (typeof fn !== 'function') return null;
      out[key] = function pinned(...a) { return Reflect.apply(fn, owner, a); };
    }
    return Object.freeze(out);
  } catch { return null; }
}
function pinNatives(h, c, t) {
  const https = snapNative(h, HTTPS_KEYS); const crypto = snapNative(c, CRYPTO_KEYS); const timers = snapNative(t, TIMERS_KEYS);
  return (https && crypto && timers) ? Object.freeze({ https, crypto, timers }) : null;
}
function pinPgClient(raw) {
  try {
    if (!raw || isProxy(raw) || typeof raw !== 'object' || Array.isArray(raw)) return null;
    let queryFn = ownFn(raw, 'query');
    if (typeof queryFn !== 'function') {
      if (Object.getOwnPropertyDescriptor(raw, 'query')) return null;
      if (!PG_NATIVE_PINNED || Object.getPrototypeOf(raw) !== PG_CLIENT_PROTO) return null;
      const queryDesc = Object.getOwnPropertyDescriptor(PG_CLIENT_PROTO, 'query');
      const ctorDesc = Object.getOwnPropertyDescriptor(PG_CLIENT_PROTO, 'constructor');
      if (!queryDesc || queryDesc.value !== PG_QUERY_FN || queryDesc.get || queryDesc.set
          || !ctorDesc || ctorDesc.value !== PgClient || ctorDesc.get || ctorDesc.set
          || !(raw instanceof PgClient)) return null;
      queryFn = PG_QUERY_FN;
    }
    if (typeof ownFn(raw, 'connect') === 'function') {
      for (const k of POOL_HINTS) {
        const d = Object.getOwnPropertyDescriptor(raw, k);
        if (d && Object.prototype.hasOwnProperty.call(d, 'value') && typeof d.value === 'number') return null;
      }
    }
    return Object.freeze({ query(...a) { return Reflect.apply(queryFn, raw, a); } });
  } catch { return null; }
}
function snapEnv(env) {
  try {
    if (!env || typeof env !== 'object' || isProxy(env)) return null;
    let oks; try { oks = Reflect.ownKeys(env); } catch { return null; }
    if (oks.some((k) => typeof k === 'symbol')) return null;
    const snap = Object.create(null);
    for (const key of SNAP_ENV_KEYS) {
      const d = Object.getOwnPropertyDescriptor(env, key);
      if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set
          || !d.enumerable || typeof d.value !== 'string') return null;
      snap[key] = d.value;
    }
    if (snap.LUNA_DEPLOYMENT !== SUNSET_DEPLOYMENT || snap[CALLBACK_ENABLED_ENV] !== 'true'
        || !UUID_RE.test(snap.LUNA_EMAIL_OAUTH_CLIENT_ID)) return null;
    return Object.freeze({ env: Object.freeze(snap) });
  } catch { return null; }
}
function resolveEnvelope(env) {
  const cfg = parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig(env);
  if (!cfg.ok || !cfg.composition_enabled) return null;
  let composition; try { composition = createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(env); } catch { return null; }
  if (!composition || composition.ok !== true || composition.composition_enabled !== true || !composition.provider) return null;
  const ok = validateEmailGrantEnvelopeProvider(composition.provider);
  return (ok.ok && ok.value) ? ok.value : null;
}
function pinDeps(dependencies) {
  if (!dependencies || isProxy(dependencies)) return null;
  const resolved = resolveOptionalStageTelemetry(dependencies, DEPENDENCY_KEYS);
  if (!resolved.ok || !resolved.stageTelemetry) return null;
  const ordered = Reflect.ownKeys(dependencies);
  const hasStage = ordered.includes('stageTelemetry');
  if (ordered.length !== (hasStage ? DEPENDENCY_KEYS.length + 1 : DEPENDENCY_KEYS.length)) return null;
  let coreIdx = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const key = ordered[i]; if (key === 'stageTelemetry') continue;
    if (coreIdx >= DEPENDENCY_KEYS.length || key !== DEPENDENCY_KEYS[coreIdx]) return null; coreIdx += 1;
  }
  if (coreIdx !== DEPENDENCY_KEYS.length) return null;
  const envSnap = snapEnv(own(dependencies, 'env')); if (!envSnap) return null;
  const pgClient = pinPgClient(own(dependencies, 'pgClient')); if (!pgClient) return null;
  const natives = pinNatives(own(dependencies, 'https'), own(dependencies, 'crypto'), own(dependencies, 'timers'));
  if (!natives) return null;
  const envelopeProvider = resolveEnvelope(envSnap.env); if (!envelopeProvider) return null;
  let secretProvider; try { secretProvider = createSunsetMicrosoftOAuthClientSecretProvider({ deployment: SUNSET_DEPLOYMENT, env: envSnap.env }); } catch { return null; }
  if (!secretProvider || typeof ownFn(secretProvider, 'getClientSecret') !== 'function') return null;
  return Object.freeze({ env: envSnap.env, pgClient, https: natives.https, crypto: natives.crypto, timers: natives.timers, envelopeProvider, secretProvider, stageTelemetry: resolved.stageTelemetry });
}
function bindOwn(owner, key) {
  const fn = ownFn(owner, key); if (typeof fn !== 'function') return null;
  return function bound(...a) { return Reflect.apply(fn, owner, a); };
}
function createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(dependencies) {
  let pinned;
  try { pinned = pinDeps(dependencies); if (!pinned) throw failure(); } catch { throw failure(); }
  try {
    const replacer = createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client: pinned.pgClient }));
    const signatureVerifier = createMicrosoftOidcJwksSignatureVerifier(Object.freeze({
      https: pinned.https, crypto: pinned.crypto, timers: pinned.timers,
    }));
    const oidcValidator = createMicrosoftOidcIdTokenValidator({ signatureVerifier });
    const stageTelemetry = pinned.stageTelemetry || createNoopEmailOAuthStageTelemetry();
    const graphRequest = bindOwn(pinned.https, 'request');
    const setT = bindOwn(pinned.timers, 'setTimeout'); const clearT = bindOwn(pinned.timers, 'clearTimeout');
    if (!graphRequest || !setT || !clearT) throw failure();
    const timers = Object.freeze({ setTimeout: setT, clearTimeout: clearT });
    const graphIdentity = createMicrosoftGraphMeIdentityTransport({ httpsImpl: graphRequest, timers, stageTelemetry });
    const verifiedIdentity = createMicrosoftVerifiedIdentityComposition(Object.freeze({
      oidcValidator, graphIdentity, stageTelemetry,
    }));
    const transportDeps = Object.freeze({ httpsImpl: Object.freeze({ request: graphRequest }), timers });
    const completion = createMicrosoftPhaseBOauthOperationComposition(Object.freeze({
      verifiedIdentity, envelopeProvider: pinned.envelopeProvider,
      clock: Object.freeze({ nowEpochSeconds() { return Math.floor(Date.now() / 1000); } }),
      replacer, transportDeps, secretProvider: pinned.secretProvider, stageTelemetry,
    }));
    const fullRepository = createPostgresPhaseBOauthTransactionConsumer(pinned.pgClient);
    const consumeFn = ownFn(fullRepository, 'consume');
    if (typeof consumeFn !== 'function') throw failure();
    return createMicrosoftPhaseBOauthCallbackCompletionService(Object.freeze({
      repository: Object.freeze({ consume(...a) { return Reflect.apply(consumeFn, fullRepository, a); } }),
      completion, env: pinned.env, clock: Object.freeze({ now() { return new Date(); } }), stageTelemetry,
    }));
  } catch { throw failure(); }
}
module.exports = Object.freeze({
  ERROR_CODE, ERROR_MESSAGE, SUNSET_DEPLOYMENT, CALLBACK_ENABLED_ENV, DEPENDENCY_KEYS,
  HTTPS_KEYS, CRYPTO_KEYS, TIMERS_KEYS, EMAIL_MS_PHASE_B_CALLBACK_RUNTIME_WIRED,
  EMAIL_MS_PHASE_B_CALLBACK_DEFERRED_ACTIVATION, EMAIL_MS_PHASE_B_CALLBACK_SAFE_FOR_RUNTIME_ROUTE,
  isCallbackEnabled, createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime,
});
