'use strict';

/**
 * Sunset-staging Microsoft delegated read-health runtime composition.
 * Default-off via LUNA_EMAIL_OAUTH_READ_HEALTH_ENABLED.
 * Refresh/CAS + one bounded Graph Mail.ReadBasic envelope count.
 * Does not enable start/callback/refresh-health flags, activation, or automation.
 *
 * @module email-microsoft-delegated-read-sunset-staging-runtime-composition
 */

const {
  createSunsetMicrosoftOAuthClientSecretProvider,
  SUNSET_DEPLOYMENT: SECRET_SUNSET,
} = require('./sunset-microsoft-oauth-provider');
const {
  createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition,
  parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig,
} = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const {
  validateEmailGrantEnvelopeProvider,
} = require('./email-grant-envelope-provider-contract');
const {
  createMicrosoftTokenHttpTransport,
} = require('./email-microsoft-token-http-transport');
const {
  createMicrosoftGraphDelegatedMessagesTransport,
} = require('./email-microsoft-graph-delegated-messages-transport');
const {
  createDelegatedGrantReadHealthService,
  SUNSET_DEPLOYMENT: READ_SUNSET,
} = require('./email-delegated-grant-read-health');

const ERROR_CODE = 'MICROSOFT_DELEGATED_READ_RUNTIME_COMPOSITION_INVALID';
const ERROR_MESSAGE = 'Microsoft delegated read runtime composition failed.';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_READ_HEALTH_ENABLED = 'LUNA_EMAIL_OAUTH_READ_HEALTH_ENABLED';

const DEPENDENCY_KEYS = Object.freeze([
  'env',
  'pgClient',
  'https',
  'timers',
]);

const HTTPS_KEYS = Object.freeze(['request']);
const TIMERS_KEYS = Object.freeze(['setTimeout', 'clearTimeout']);

if (SECRET_SUNSET !== SUNSET_DEPLOYMENT || READ_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('read_runtime_composition_sunset_deployment_mismatch');
}

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'MicrosoftDelegatedReadRuntimeCompositionError' });
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
      try {
        const value = object[key];
        return typeof value === 'function' ? value : null;
      } catch {
        return null;
      }
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

function snapshotNativeMethodBag(raw, keys) {
  try {
    if (!raw || (typeof raw !== 'object' && typeof raw !== 'function')) return null;
    if (Array.isArray(raw)) return null;
    const captured = Object.create(null);
    for (const key of keys) {
      const fn = ownDataFunction(raw, key);
      if (typeof fn !== 'function') return null;
      captured[key] = fn;
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

function pinNativeSurfaces(httpsRaw, timersRaw) {
  let httpsPinned;
  if (exactFrozenData(httpsRaw, HTTPS_KEYS)) {
    const request = ownDataFunction(httpsRaw, 'request');
    if (!request) return null;
    httpsPinned = Object.freeze({
      request(...args) { return Reflect.apply(request, httpsRaw, args); },
    });
  } else {
    httpsPinned = snapshotNativeMethodBag(httpsRaw, HTTPS_KEYS);
  }
  if (!httpsPinned) return null;

  let timersPinned;
  if (exactFrozenData(timersRaw, TIMERS_KEYS)) {
    const setTimeoutFn = ownDataFunction(timersRaw, 'setTimeout');
    const clearTimeoutFn = ownDataFunction(timersRaw, 'clearTimeout');
    if (!setTimeoutFn || !clearTimeoutFn) return null;
    timersPinned = Object.freeze({
      setTimeout(...args) { return Reflect.apply(setTimeoutFn, timersRaw, args); },
      clearTimeout(...args) { return Reflect.apply(clearTimeoutFn, timersRaw, args); },
    });
  } else {
    timersPinned = snapshotNativeMethodBag(timersRaw, TIMERS_KEYS);
  }
  if (!timersPinned) return null;
  return Object.freeze({ https: httpsPinned, timers: timersPinned });
}

function isReadHealthEnabled(env) {
  try {
    return !!env && env.LUNA_DEPLOYMENT === SUNSET_DEPLOYMENT
      && env[ENV_READ_HEALTH_ENABLED] === 'true';
  } catch {
    return false;
  }
}

function snapshotEnvReadiness(env) {
  try {
    if (!isReadHealthEnabled(env)) return null;
    const appId = env.LUNA_EMAIL_OAUTH_CLIENT_ID;
    if (typeof appId !== 'string' || !UUID_RE.test(appId)) return null;
    const kv = parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig(env);
    if (!kv.ok || kv.composition_enabled !== true) return null;
    return Object.freeze({
      env,
      applicationClientId: appId.toLowerCase(),
    });
  } catch {
    return null;
  }
}

function createSunsetStagingMicrosoftDelegatedReadRuntime(deps) {
  try {
    if (!exactPlainData(deps, DEPENDENCY_KEYS)) throw failure();
    const env = ownData(deps, 'env');
    const pgClient = ownData(deps, 'pgClient');
    const httpsRaw = ownData(deps, 'https');
    const timersRaw = ownData(deps, 'timers');
    const ready = snapshotEnvReadiness(env);
    if (!ready) throw failure();
    if (!pgClient || typeof pgClient !== 'object' || typeof pgClient.query !== 'function') {
      throw failure();
    }
    if (typeof pgClient.connect === 'function'
        && (typeof pgClient.totalCount === 'number' || typeof pgClient.idleCount === 'number')) {
      throw failure();
    }
    const natives = pinNativeSurfaces(httpsRaw, timersRaw);
    if (!natives) throw failure();

    const secretProvider = createSunsetMicrosoftOAuthClientSecretProvider(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      env: ready.env,
    }));
    const composition = createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(ready.env);
    if (!composition
        || composition.ok !== true
        || composition.composition_enabled !== true
        || !composition.provider) {
      throw failure();
    }
    const prov = validateEmailGrantEnvelopeProvider(composition.provider);
    if (!prov.ok) throw failure();

    const transport = createMicrosoftTokenHttpTransport(Object.freeze({
      httpsImpl: natives.https,
      timers: natives.timers,
    }));
    const graphMessages = createMicrosoftGraphDelegatedMessagesTransport(Object.freeze({
      httpsImpl: natives.https,
      timers: natives.timers,
    }));

    return createDelegatedGrantReadHealthService(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: ready.applicationClientId,
      client: pgClient,
      envelopeProvider: prov.value,
      secretProvider,
      transport,
      graphMessages,
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
  ENV_READ_HEALTH_ENABLED,
  DEPENDENCY_KEYS,
  isReadHealthEnabled,
  createSunsetStagingMicrosoftDelegatedReadRuntime,
});
