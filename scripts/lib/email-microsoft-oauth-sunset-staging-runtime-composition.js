'use strict';

/**
 * Stage 6 Sunset-staging Microsoft OAuth runtime composition.
 *
 * Explicit factory only. Assembles the merged completing callback chain from
 * controlled dependencies and returns exact frozen { accept }. No Staff API
 * startup auto-wiring, no default-on flags, no network/Key Vault wrap during
 * construction — only after a valid consumed code callback (via child factories).
 * Azure SDK require remains lazy inside the envelope composition child.
 *
 * Per-callback operation-scoped chain (one pg client checked out; no BEGIN/lock
 * until installer final step):
 *   Postgres transaction repository + completing callback
 *   verified-grant installer (same pg client; TX only at install)
 *   Sunset client-secret provider
 *   native token transport snapshots
 *   OIDC JWKS verifier + ID-token validator
 *   Graph /me transport/identity
 *   merged verified identity
 *   Azure KV Sunset staging envelope provider (always from validated env)
 *   merged OAuth operation composition → completeAuthorization
 *   createMicrosoftOAuthCallbackCompletionService
 *
 * Exact frozen dependency bag (order required):
 *   env, pgClient, https, crypto, timers
 * No injected envelope surface on the public factory bag; no route substitution.
 * Offline tests intercept Module._load for @azure/* (Azure composition pattern).
 *
 * Readiness (fail closed, never log secrets):
 *   LUNA_DEPLOYMENT=sunset-staging
 *   LUNA_EMAIL_OAUTH_CALLBACK_ENABLED=true
 *   LUNA_EMAIL_OAUTH_CLIENT_ID (canonical UUID)
 *   LUNA_EMAIL_OAUTH_CLIENT_SECRET (via Sunset secret provider)
 *   Azure KV Sunset composition env (exact pinned host + versioned key id)
 *
 * Reuses merged factories exactly; does not duplicate security logic.
 *
 * @module email-microsoft-oauth-sunset-staging-runtime-composition
 */

const {
  createPostgresOAuthTransactionRepository,
} = require('./email-microsoft-oauth-transaction-service');
const {
  createMicrosoftOAuthCallbackCompletionService,
} = require('./email-microsoft-oauth-callback-completion');
const {
  createMicrosoftOAuthOperationComposition,
  SUNSET_DEPLOYMENT: OP_SUNSET_DEPLOYMENT,
} = require('./email-microsoft-oauth-operation-composition');
const {
  createMicrosoftVerifiedGrantInstaller,
} = require('./email-microsoft-verified-grant-installer');
const {
  createSunsetMicrosoftOAuthClientSecretProvider,
  SUNSET_DEPLOYMENT: SECRET_SUNSET_DEPLOYMENT,
} = require('./sunset-microsoft-oauth-provider');
const {
  createMicrosoftOidcJwksSignatureVerifier,
} = require('./email-microsoft-oidc-jwks-verifier');
const {
  createMicrosoftOidcIdTokenValidator,
} = require('./email-microsoft-oidc-id-token');
const {
  createMicrosoftGraphMeIdentityTransport,
} = require('./email-microsoft-graph-me-identity');
const {
  createMicrosoftVerifiedIdentityComposition,
} = require('./email-microsoft-verified-identity');
const {
  createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition,
  parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig,
} = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const {
  validateEmailGrantEnvelopeProvider,
} = require('./email-grant-envelope-provider-contract');
const {
  resolveOptionalStageTelemetry,
  createNoopEmailOAuthStageTelemetry,
} = require('./email-microsoft-oauth-stage-telemetry');

const ERROR_CODE = 'MICROSOFT_OAUTH_RUNTIME_COMPOSITION_INVALID';
const ERROR_MESSAGE = 'Microsoft OAuth runtime composition failed.';

const SUNSET_DEPLOYMENT = 'sunset-staging';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Production dependency order — exact frozen ordered only. */
const DEPENDENCY_KEYS = Object.freeze([
  'env',
  'pgClient',
  'https',
  'crypto',
  'timers',
]);

const HTTPS_KEYS = Object.freeze(['request']);
const CRYPTO_KEYS = Object.freeze(['createPublicKey', 'verify']);
const TIMERS_KEYS = Object.freeze(['setTimeout', 'clearTimeout']);

// Static alignment with merged child Sunset pins.
if (OP_SUNSET_DEPLOYMENT !== SUNSET_DEPLOYMENT
    || SECRET_SUNSET_DEPLOYMENT !== SUNSET_DEPLOYMENT) {
  throw new Error('oauth_runtime_composition_sunset_deployment_mismatch');
}

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'MicrosoftOAuthRuntimeCompositionError' });
  Object.defineProperty(error, 'code', { value: ERROR_CODE, enumerable: true });
  return Object.freeze(error);
}

function ownData(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor
      && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      && !descriptor.get
      && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function ownDataFunction(object, key) {
  try {
    if (object == null || (typeof object !== 'object' && typeof object !== 'function')) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.get
        || descriptor.set
        || typeof descriptor.value !== 'function') {
      return null;
    }
    return descriptor.value;
  } catch {
    return null;
  }
}

function exactPlainData(object, keys) {
  try {
    if (!object || Object.getPrototypeOf(object) !== Object.prototype) return false;
    const actual = Reflect.ownKeys(object);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
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

function exactFrozenData(object, keys) {
  return Boolean(object && Object.isFrozen(object) && exactPlainData(object, keys));
}

function exactOrderedFrozenData(object, keys) {
  if (!exactFrozenData(object, keys)) return false;
  try {
    const ordered = Reflect.ownKeys(object);
    if (ordered.length !== keys.length) return false;
    for (let i = 0; i < keys.length; i += 1) {
      if (ordered[i] !== keys[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Snapshot native method bags once into fresh frozen wrappers that forward via
 * Reflect.apply to original owners (post-factory replacement has no effect).
 */
function snapshotNativeMethodBag(raw, keys) {
  try {
    if (!raw || (typeof raw !== 'object' && typeof raw !== 'function')) return null;
    let proto;
    try {
      proto = Object.getPrototypeOf(raw);
    } catch {
      return null;
    }
    // Accept Object.prototype, null, or module-like function/object hosts for
    // node:https / node:crypto / timers — then require exact own-data methods.
    if (proto !== Object.prototype
        && proto !== null
        && typeof raw !== 'function'
        && !(proto && typeof proto === 'object')) {
      // Still allow plain objects only for strict bags; reject arrays.
      if (Array.isArray(raw)) return null;
    }
    if (Array.isArray(raw)) return null;

    const captured = Object.create(null);
    for (const key of keys) {
      const fn = ownDataFunction(raw, key);
      if (typeof fn !== 'function') {
        // Fallback: non-own methods on module exports (node:crypto verify etc.).
        try {
          const value = raw[key];
          if (typeof value !== 'function') return null;
          captured[key] = value;
        } catch {
          return null;
        }
      } else {
        captured[key] = fn;
      }
    }

    const owner = raw;
    const out = {};
    for (const key of keys) {
      const fn = captured[key];
      out[key] = function pinnedNative(...args) {
        return Reflect.apply(fn, owner, args);
      };
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
}

/**
 * Prefer exact frozen own-data bags; otherwise snapshot natives into frozen bags
 * accepted by JWKS (exact frozen https/crypto/timers) and token/Graph transports.
 */
function pinNativeSurfaces(httpsRaw, cryptoRaw, timersRaw) {
  let httpsPinned;
  let cryptoPinned;
  let timersPinned;

  if (exactOrderedFrozenData(httpsRaw, HTTPS_KEYS)) {
    const request = ownDataFunction(httpsRaw, 'request');
    if (!request) return null;
    httpsPinned = Object.freeze({
      request(...args) {
        return Reflect.apply(request, httpsRaw, args);
      },
    });
  } else {
    httpsPinned = snapshotNativeMethodBag(httpsRaw, HTTPS_KEYS);
  }
  if (!httpsPinned) return null;

  if (exactOrderedFrozenData(cryptoRaw, CRYPTO_KEYS)) {
    const createPublicKey = ownDataFunction(cryptoRaw, 'createPublicKey');
    const verify = ownDataFunction(cryptoRaw, 'verify');
    if (!createPublicKey || !verify) return null;
    cryptoPinned = Object.freeze({
      createPublicKey(...args) {
        return Reflect.apply(createPublicKey, cryptoRaw, args);
      },
      verify(...args) {
        return Reflect.apply(verify, cryptoRaw, args);
      },
    });
  } else {
    cryptoPinned = snapshotNativeMethodBag(cryptoRaw, CRYPTO_KEYS);
  }
  if (!cryptoPinned) return null;

  if (exactOrderedFrozenData(timersRaw, TIMERS_KEYS)) {
    const setTimeoutFn = ownDataFunction(timersRaw, 'setTimeout');
    const clearTimeoutFn = ownDataFunction(timersRaw, 'clearTimeout');
    if (!setTimeoutFn || !clearTimeoutFn) return null;
    timersPinned = Object.freeze({
      setTimeout(...args) {
        return Reflect.apply(setTimeoutFn, timersRaw, args);
      },
      clearTimeout(...args) {
        return Reflect.apply(clearTimeoutFn, timersRaw, args);
      },
    });
  } else {
    timersPinned = snapshotNativeMethodBag(timersRaw, TIMERS_KEYS);
  }
  if (!timersPinned) return null;

  return Object.freeze({
    https: httpsPinned,
    crypto: cryptoPinned,
    timers: timersPinned,
  });
}

function snapshotEnvReadiness(env) {
  try {
    if (!env || typeof env !== 'object') return null;
    if (env.LUNA_DEPLOYMENT !== SUNSET_DEPLOYMENT) return null;
    if (env.LUNA_EMAIL_OAUTH_CALLBACK_ENABLED !== 'true') return null;
    const appId = env.LUNA_EMAIL_OAUTH_CLIENT_ID;
    if (typeof appId !== 'string' || !UUID_RE.test(appId)) return null;
    return Object.freeze({
      env,
      applicationClientId: appId.toLowerCase(),
    });
  } catch {
    return null;
  }
}

/**
 * Always construct Azure KV Sunset staging envelope from validated env.
 * No injected envelopeProvider path.
 */
function resolveEnvelopeProvider(env) {
  const cfg = parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig(env);
  if (!cfg.ok || !cfg.composition_enabled) return null;
  let composition;
  try {
    composition = createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(env);
  } catch {
    return null;
  }
  if (!composition
      || composition.ok !== true
      || composition.composition_enabled !== true
      || !composition.provider) {
    return null;
  }
  const ok = validateEmailGrantEnvelopeProvider(composition.provider);
  if (!ok.ok || !ok.value) return null;
  return ok.value;
}

function pinDependencies(dependencies) {
  // Core keys exact ordered; optional stageTelemetry last (route injects).
  const resolved = resolveOptionalStageTelemetry(dependencies, DEPENDENCY_KEYS);
  if (!resolved.ok || !resolved.stageTelemetry) return null;

  const ordered = Reflect.ownKeys(dependencies);
  const hasStage = ordered.includes('stageTelemetry');
  const expectedLen = hasStage
    ? DEPENDENCY_KEYS.length + 1
    : DEPENDENCY_KEYS.length;
  if (ordered.length !== expectedLen) return null;
  let coreIdx = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const key = ordered[i];
    if (key === 'stageTelemetry') continue;
    if (coreIdx >= DEPENDENCY_KEYS.length || key !== DEPENDENCY_KEYS[coreIdx]) {
      return null;
    }
    coreIdx += 1;
  }
  if (coreIdx !== DEPENDENCY_KEYS.length) return null;

  const env = ownData(dependencies, 'env');
  const pgClient = ownData(dependencies, 'pgClient');
  const httpsRaw = ownData(dependencies, 'https');
  const cryptoRaw = ownData(dependencies, 'crypto');
  const timersRaw = ownData(dependencies, 'timers');

  const envSnap = snapshotEnvReadiness(env);
  if (!envSnap) return null;
  if (!pgClient || typeof pgClient !== 'object' || typeof pgClient.query !== 'function') {
    return null;
  }
  // Reject pool-shaped surfaces (installer contract).
  if (typeof pgClient.connect === 'function'
      && (Object.prototype.hasOwnProperty.call(pgClient, 'totalCount')
        || Object.prototype.hasOwnProperty.call(pgClient, 'idleCount')
        || Object.prototype.hasOwnProperty.call(pgClient, 'waitingCount'))) {
    return null;
  }

  const natives = pinNativeSurfaces(httpsRaw, cryptoRaw, timersRaw);
  if (!natives) return null;

  const envelopeProvider = resolveEnvelopeProvider(envSnap.env);
  if (!envelopeProvider) return null;

  let secretProvider;
  try {
    secretProvider = createSunsetMicrosoftOAuthClientSecretProvider({
      deployment: SUNSET_DEPLOYMENT,
      env: envSnap.env,
    });
  } catch {
    return null;
  }
  if (!secretProvider || typeof ownData(secretProvider, 'getClientSecret') !== 'function') {
    return null;
  }

  return Object.freeze({
    env: envSnap.env,
    pgClient,
    https: natives.https,
    crypto: natives.crypto,
    timers: natives.timers,
    envelopeProvider,
    secretProvider,
    stageTelemetry: resolved.stageTelemetry,
  });
}

/**
 * Build one operation-scoped completing callback service.
 * Construction only — no consume/token/Graph/KV wrap/install network until accept.
 *
 * @param {object} dependencies exact frozen DEPENDENCY_KEYS
 * @returns {{ accept: Function }} frozen single-use callback completion surface
 */
function createSunsetStagingMicrosoftOAuthCallbackRuntime(dependencies) {
  let pinned;
  try {
    pinned = pinDependencies(dependencies);
    if (!pinned) throw failure();
  } catch {
    throw failure();
  }

  try {
    // ── Installer: same checked-out pg client; BEGIN only at final install ──
    const installer = createMicrosoftVerifiedGrantInstaller(Object.freeze({
      client: pinned.pgClient,
    }));

    // ── OIDC JWKS + ID token (factory-time native snapshots) ───────────────
    const signatureVerifier = createMicrosoftOidcJwksSignatureVerifier(Object.freeze({
      https: pinned.https,
      crypto: pinned.crypto,
      timers: pinned.timers,
    }));
    const oidcValidator = createMicrosoftOidcIdTokenValidator({
      signatureVerifier,
    });

    // ── Graph /me: httpsImpl is the request function ───────────────────────
    const graphRequest = ownData(pinned.https, 'request');
    if (typeof graphRequest !== 'function') throw failure();
    const graphIdentity = createMicrosoftGraphMeIdentityTransport({
      httpsImpl: function graphHttpsRequest(...args) {
        return Reflect.apply(graphRequest, pinned.https, args);
      },
      timers: {
        setTimeout: ownData(pinned.timers, 'setTimeout'),
        clearTimeout: ownData(pinned.timers, 'clearTimeout'),
      },
    });

    // ── Verified identity composition (same stage surface as callback) ─────
    const stageTelemetry = pinned.stageTelemetry || createNoopEmailOAuthStageTelemetry();
    const verifiedIdentity = createMicrosoftVerifiedIdentityComposition(Object.freeze({
      oidcValidator,
      graphIdentity,
      stageTelemetry,
    }));

    // ── Token transport bag for operation composition (httpsImpl object) ───
    const transportDeps = Object.freeze({
      httpsImpl: Object.freeze({
        request: ownData(pinned.https, 'request'),
      }),
      timers: Object.freeze({
        setTimeout: ownData(pinned.timers, 'setTimeout'),
        clearTimeout: ownData(pinned.timers, 'clearTimeout'),
      }),
    });

    // Custody/operation epoch clock (construction-time surface; called later).
    const epochClock = Object.freeze({
      nowEpochSeconds() {
        return Math.floor(Date.now() / 1000);
      },
    });

    // ── Operation composition → completeAuthorization ──────────────────────
    const completion = createMicrosoftOAuthOperationComposition(Object.freeze({
      verifiedIdentity,
      envelopeProvider: pinned.envelopeProvider,
      clock: epochClock,
      installer,
      transportDeps,
      secretProvider: pinned.secretProvider,
      stageTelemetry,
    }));

    // ── Transaction repository on same pg client (consume = single UPDATE) ─
    // Callback completion requires exact single-method { consume } surface
    // (merged contract). Postgres repo also exposes create — pin consume only,
    // owner-preserving to the full repository receiver.
    const fullRepository = createPostgresOAuthTransactionRepository(pinned.pgClient);
    const consumeFn = ownData(fullRepository, 'consume');
    if (typeof consumeFn !== 'function') throw failure();
    const repository = Object.freeze({
      consume(...args) {
        return Reflect.apply(consumeFn, fullRepository, args);
      },
    });

    // Callback date clock.
    const dateClock = Object.freeze({
      now() {
        return new Date();
      },
    });

    // ── Completing callback service ────────────────────────────────────────
    return createMicrosoftOAuthCallbackCompletionService(Object.freeze({
      repository,
      completion,
      env: pinned.env,
      clock: dateClock,
      stageTelemetry,
    }));
  } catch (err) {
    if (err && err.code === ERROR_CODE) throw err;
    throw failure();
  }
}

module.exports = Object.freeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  DEPENDENCY_KEYS,
  HTTPS_KEYS,
  CRYPTO_KEYS,
  TIMERS_KEYS,
  createSunsetStagingMicrosoftOAuthCallbackRuntime,
});
