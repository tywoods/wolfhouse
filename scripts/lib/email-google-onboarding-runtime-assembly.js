'use strict';

const utilTypes = require('node:util').types;
const { createGoogleOAuthStart } = require('./email-google-oauth-start');
const { createGoogleOAuthCallbackConsume } = require('./email-google-oauth-callback-consume');
const { createGoogleTransactionCompletionFactory } = require('./email-google-transaction-completion-factory');
const { createGoogleOAuthCallbackCompletion } = require('./email-google-oauth-callback-completion');

const ObjectFreeze = Object.freeze;
const ObjectIsFrozen = Object.isFrozen;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectCreate = Object.create;
const ObjectDefineProperty = Object.defineProperty;
const ObjectSetPrototypeOf = Object.setPrototypeOf;
const ObjectHasOwn = Object.hasOwn
  ? Object.hasOwn.bind(Object)
  : (target, key) => Object.prototype.hasOwnProperty.call(target, key);
const ObjectPrototype = Object.prototype;
const ReflectOwnKeys = Reflect.ownKeys.bind(Reflect);
const ReflectApply = Reflect.apply.bind(Reflect);
const PinnedIsProxy = utilTypes && typeof utilTypes.isProxy === 'function'
  ? utilTypes.isProxy.bind(utilTypes)
  : null;
const PinnedIsPromise = utilTypes && typeof utilTypes.isPromise === 'function'
  ? utilTypes.isPromise.bind(utilTypes)
  : null;
const ErrorConstructor = Error;
const PromisePrototype = Promise.prototype;
const PromiseThen = Promise.prototype.then;
const RegExpTest = RegExp.prototype.test;
const StringConstructor = String;

const CONFIG_KEYS = ObjectFreeze([
  'tenantSlug', 'clientId', 'locationKey', 'locationId', 'endpointId',
  'applicationClientId', 'redirectUri', 'secretRef', 'onboardingEnabled',
]);
const PUBLIC_CONFIG_KEYS = ObjectFreeze([
  'tenantSlug', 'clientId', 'locationKey', 'locationId', 'endpointId',
  'applicationClientId', 'redirectUri', 'onboardingEnabled',
]);
const DEP_KEYS = ObjectFreeze([
  'cryptography', 'clock', 'repository', 'https', 'crypto', 'timers',
  'envelopeProvider', 'installer', 'secretProvider',
]);
const METHODS = ObjectFreeze({
  cryptography: ObjectFreeze(['randomUUID', 'randomBytes', 'sha256Ascii']),
  clock: ObjectFreeze(['now', 'nowEpochSeconds']),
  repository: ObjectFreeze(['create', 'consume']),
  https: ObjectFreeze(['request']),
  crypto: ObjectFreeze(['createPublicKey', 'verify']),
  timers: ObjectFreeze(['setTimeout', 'clearTimeout']),
  envelopeProvider: ObjectFreeze(['sealGrantPayload', 'openGrantPayload', 'rewrapGrantDek']),
  installer: ObjectFreeze(['installVerifiedGrant']),
  secretProvider: ObjectFreeze(['resolveClientSecret']),
});
const START_INPUT = ObjectFreeze([
  'tenantSlug', 'clientId', 'locationKey', 'endpointId', 'staffUserId', 'authSessionId',
]);
const CALLBACK_INPUT = ObjectFreeze([
  'tenantSlug', 'clientId', 'locationKey', 'endpointId', 'authSessionId', 'query',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APP = /^[A-Za-z0-9][A-Za-z0-9._-]*\.apps\.googleusercontent\.com$/;
const REDIRECT_URI = 'https://staff-staging.lunafrontdesk.com/staff/email/google/callback';
const SECRET_REF = 'secret-ref:email/google/sunset-staging-oauth-client';

const FAILURE_PROTOTYPE = ObjectCreate(Error.prototype);
ObjectDefineProperty(FAILURE_PROTOTYPE, 'name', {
  value: 'GoogleOnboardingRuntimeError',
  writable: false,
  enumerable: false,
  configurable: false,
});
ObjectFreeze(FAILURE_PROTOTYPE);

function fail(disabled) {
  const error = new ErrorConstructor(
    disabled ? 'Google onboarding runtime is disabled.' : 'Google onboarding runtime failed.',
  );
  ObjectSetPrototypeOf(error, FAILURE_PROTOTYPE);
  ObjectDefineProperty(error, 'code', {
    value: disabled ? 'GOOGLE_ONBOARDING_RUNTIME_DISABLED' : 'GOOGLE_ONBOARDING_RUNTIME_FAILED',
    enumerable: true,
    writable: false,
    configurable: false,
  });
  ObjectDefineProperty(error, 'stack', {
    value: undefined,
    writable: false,
    configurable: false,
  });
  throw ObjectFreeze(error);
}

function isProxyValue(value) {
  try {
    if (typeof PinnedIsProxy !== 'function') return true;
    return PinnedIsProxy(value) === true;
  } catch (_) {
    return true;
  }
}

function exact(value, keys) {
  try {
    if (!value || isProxyValue(value) || ObjectGetPrototypeOf(value) !== ObjectPrototype
        || !ObjectIsFrozen(value)) return null;
    const actual = ReflectOwnKeys(value);
    if (actual.length !== keys.length) return null;
    const out = ObjectCreate(null);
    for (let i = 0; i < keys.length; i += 1) {
      if (actual[i] !== keys[i]) return null;
      const d = ObjectGetOwnPropertyDescriptor(value, keys[i]);
      if (!d || !ObjectHasOwn(d, 'value') || !d.enumerable || d.writable || d.configurable) return null;
      out[keys[i]] = d.value;
    }
    return out;
  } catch (_) {
    return null;
  }
}

function capability(value, keys) {
  const record = exact(value, keys);
  if (!record) return null;
  for (let i = 0; i < keys.length; i += 1) {
    const method = record[keys[i]];
    if (typeof method !== 'function' || isProxyValue(method)) return null;
  }
  return record;
}

function settle(value, accept) {
  try {
    if (value && ObjectGetPrototypeOf(value) === PromisePrototype
        && typeof PinnedIsPromise === 'function' && PinnedIsPromise(value)) {
      return ReflectApply(PromiseThen, value, [accept, () => fail(false)]);
    }
  } catch (_) {
    fail(false);
  }
  return accept(value);
}

function binding(input, keys, config) {
  const value = exact(input, keys);
  if (!value
      || value.tenantSlug !== config.tenantSlug
      || value.clientId !== config.clientId
      || value.locationKey !== config.locationKey
      || value.endpointId !== config.endpointId) fail(false);
  return value;
}

function createGoogleOnboardingRuntimeAssembly(configuration, dependencies) {
  const config = exact(configuration, CONFIG_KEYS);
  const deps = exact(dependencies, DEP_KEYS);
  if (!config || !deps
      || config.tenantSlug !== 'sunset'
      || config.locationKey !== 'sunset-somo'
      || !ReflectApply(RegExpTest, UUID, [config.clientId])
      || !ReflectApply(RegExpTest, UUID, [config.locationId])
      || !ReflectApply(RegExpTest, UUID, [config.endpointId])
      || !ReflectApply(RegExpTest, APP, [config.applicationClientId])
      || config.redirectUri !== REDIRECT_URI
      || config.secretRef !== SECRET_REF
      || typeof config.onboardingEnabled !== 'boolean') fail(false);
  for (let i = 0; i < DEP_KEYS.length; i += 1) {
    const key = DEP_KEYS[i];
    if (!capability(deps[key], METHODS[key])) fail(false);
  }

  const publicConfiguration = ObjectCreate(null);
  for (let i = 0; i < PUBLIC_CONFIG_KEYS.length; i += 1) {
    const key = PUBLIC_CONFIG_KEYS[i];
    publicConfiguration[key] = config[key];
  }
  const snapshot = ObjectFreeze(publicConfiguration);
  if (!config.onboardingEnabled) {
    return ObjectFreeze({
      configuration: snapshot,
      startOnboarding() { fail(true); },
      completeOnboardingCallback() { fail(true); },
    });
  }

  const now = ObjectGetOwnPropertyDescriptor(deps.clock, 'now').value;
  const nowEpochSeconds = ObjectGetOwnPropertyDescriptor(deps.clock, 'nowEpochSeconds').value;
  const createTx = ObjectGetOwnPropertyDescriptor(deps.repository, 'create').value;
  const consumeTx = ObjectGetOwnPropertyDescriptor(deps.repository, 'consume').value;
  const sha = ObjectGetOwnPropertyDescriptor(deps.cryptography, 'sha256Ascii').value;
  const clock = ObjectFreeze({
    now() { return ReflectApply(now, deps.clock, arguments); },
  });
  const repository = ObjectFreeze({
    create() { return ReflectApply(createTx, deps.repository, arguments); },
  });

  const start = createGoogleOAuthStart(ObjectFreeze({
    enabled: true,
    applicationClientId: config.applicationClientId,
    redirectUri: config.redirectUri,
  }), ObjectFreeze({
    cryptography: deps.cryptography,
    clock,
    repository,
  }));
  const rawConsume = createGoogleOAuthCallbackConsume(ObjectFreeze({
    cryptography: ObjectFreeze({
      sha256Ascii(...args) { return ReflectApply(sha, deps.cryptography, args); },
    }),
    clock,
    repository: ObjectFreeze({
      consume(...args) { return ReflectApply(consumeTx, deps.repository, args); },
    }),
  }));
  const consumeMethod = capability(rawConsume, ['consumeCallback']).consumeCallback;
  const boundConsume = ObjectFreeze({
    consumeCallback(value) {
      return settle(ReflectApply(consumeMethod, rawConsume, [value]), (out) => {
        const record = exact(out, [
          'status', 'authorizationCode', 'clientId', 'operationId', 'locationId',
          'endpointId', 'staffUserId', 'codeVerifier', 'nonce',
        ]);
        if (record && (record.locationId !== config.locationId || record.endpointId !== config.endpointId)) {
          fail(false);
        }
        return out;
      });
    },
  });
  const factory = createGoogleTransactionCompletionFactory(ObjectFreeze({
    https: deps.https,
    crypto: deps.crypto,
    timers: deps.timers,
    envelopeProvider: deps.envelopeProvider,
    clock: ObjectFreeze({
      nowEpochSeconds(...args) { return ReflectApply(nowEpochSeconds, deps.clock, args); },
    }),
    installer: deps.installer,
  }));
  const callback = createGoogleOAuthCallbackCompletion(ObjectFreeze({
    applicationClientId: config.applicationClientId,
    redirectUri: config.redirectUri,
    secretRef: config.secretRef,
  }), ObjectFreeze({
    callbackConsume: boundConsume,
    secretProvider: deps.secretProvider,
    transactionCompletionFactory: factory,
  }));
  const startMethod = capability(start, ['start']).start;
  const callbackMethod = capability(callback, ['completeCallback']).completeCallback;

  function startOnboarding(input) {
    const value = binding(input, START_INPUT, config);
    return ReflectApply(startMethod, start, [ObjectFreeze({
      clientId: value.clientId,
      locationId: config.locationId,
      endpointId: value.endpointId,
      staffUserId: value.staffUserId,
      authSessionId: value.authSessionId,
    })]);
  }

  function completeOnboardingCallback(input) {
    try {
      const value = binding(input, CALLBACK_INPUT, config);
      return settle(ReflectApply(callbackMethod, callback, [ObjectFreeze({
        clientId: value.clientId,
        authSessionId: value.authSessionId,
        query: value.query,
      })]), (x) => x);
    } catch (_) {
      fail(false);
    }
  }

  return ObjectFreeze({
    configuration: snapshot,
    startOnboarding,
    completeOnboardingCallback,
  });
}

module.exports = ObjectFreeze({ createGoogleOnboardingRuntimeAssembly });
