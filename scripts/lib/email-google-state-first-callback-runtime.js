'use strict';

/**
 * Pure state-first Google OAuth callback runtime (UNWIRED).
 *
 * Order: admit config -> consume opaque state -> resolve consumed endpoint
 * authority -> createTransactionCompletion(operation, handoff, secretProvider)
 * -> completeAuthorization. No routes, SQL, env activation, or provider wiring.
 *
 * Server-owned configuration supplies tenant/location binding and OAuth app
 * identity. Endpoint secretRef comes only from the trusted resolver ack after
 * exact ID matching - never from public config or caller input.
 */
const utilTypes = require('node:util').types;
const {
  createGoogleOAuthCallbackConsume,
} = require('./email-google-oauth-callback-consume');
const { resolveOptionalStageTelemetry, safeEmitStage } = require('./email-microsoft-oauth-stage-telemetry');

const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const freeze = Object.freeze;
const isFrozen = Object.isFrozen;
const getPrototypeOf = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const createObject = Object.create;
const defineProperty = Object.defineProperty;
const objectPrototype = Object.prototype;
const arrayIsArray = Array.isArray;
const regexpTest = RegExp.prototype.test;
const stringCharCodeAt = String.prototype.charCodeAt;
const stringEndsWith = String.prototype.endsWith;
const stringSlice = String.prototype.slice;
const stringIndexOf = String.prototype.indexOf;
const stringToLowerCase = String.prototype.toLowerCase;
const isProxy = utilTypes.isProxy;
const isPromise = utilTypes.isPromise;
const promisePrototype = Promise.prototype;
const promiseThen = Promise.prototype.then;
const ErrorConstructor = Error;
const URLConstructor = URL;
const urlPrototype = URLConstructor.prototype;
const urlProtocol = getDescriptor(urlPrototype, 'protocol').get;
const urlUsername = getDescriptor(urlPrototype, 'username').get;
const urlPassword = getDescriptor(urlPrototype, 'password').get;
const urlHash = getDescriptor(urlPrototype, 'hash').get;
const urlSearch = getDescriptor(urlPrototype, 'search').get;
const urlPort = getDescriptor(urlPrototype, 'port').get;
const urlHostname = getDescriptor(urlPrototype, 'hostname').get;
const urlHref = getDescriptor(urlPrototype, 'href').get;

const CONFIG_KEYS = freeze([
  'tenantSlug', 'locationKey', 'applicationClientId', 'redirectUri', 'callbackEnabled',
]);
const DEPENDENCY_KEYS = freeze([
  'cryptography', 'clock', 'repository', 'endpointAuthorityResolver',
  'transactionCompletionFactory', 'secretProvider',
]);
const INPUT_KEYS = freeze(['query']);
const CONSUMED_KEYS = freeze([
  'status', 'authorizationCode', 'clientId', 'authSessionId', 'operationId', 'locationId',
  'endpointId', 'staffUserId', 'codeVerifier', 'nonce',
]);
const AUTHORITY_KEYS = freeze([
  'tenantSlug', 'clientId', 'locationKey', 'locationId', 'endpointId', 'secretRef',
]);
const RESOLVER_KEYS = freeze(['resolveConsumedEndpointAuthority']);
const FACTORY_KEYS = freeze(['createTransactionCompletion']);
const SECRET_PROVIDER_KEYS = freeze(['resolveClientSecret']);
const COMPLETION_KEYS = freeze(['completeAuthorization']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLIENT_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CLIENT_SUFFIX = '.apps.googleusercontent.com';
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const NONCE = /^[A-Za-z0-9_-]{43,128}$/;
const SECRET_BODY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;
const TENANT = 'sunset';
const LOCATION_KEY = 'sunset-somo';
const REDIRECT = 'https://sunset-staging.lunafrontdesk.com/staff/email/google/callback';
const FAILURE = 'GOOGLE_STATE_FIRST_CALLBACK_FAILED';
const DISABLED = 'GOOGLE_STATE_FIRST_CALLBACK_DISABLED';

function proxy(value) {
  return apply(isProxy, undefined, [value]);
}

function test(pattern, value) {
  return apply(regexpTest, pattern, [value]);
}

function error(code) {
  const value = new ErrorConstructor(code);
  defineProperty(value, 'name', {
    value: code === DISABLED
      ? 'GoogleStateFirstCallbackDisabledError'
      : 'GoogleStateFirstCallbackError',
  });
  defineProperty(value, 'code', { value: code, enumerable: true });
  defineProperty(value, 'stack', { value: undefined });
  return freeze(value);
}

function fail() {
  throw error(FAILURE);
}

function disabled() {
  throw error(DISABLED);
}

function snapshot(value, keys) {
  if (value === null || typeof value !== 'object' || proxy(value) || arrayIsArray(value)
      || apply(getPrototypeOf, Object, [value]) !== objectPrototype
      || !apply(isFrozen, Object, [value])) {
    return null;
  }
  const actual = apply(ownKeys, Reflect, [value]);
  if (actual.length !== keys.length) return null;
  const result = apply(createObject, Object, [null]);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (actual[index] !== key) return null;
    const descriptor = apply(getDescriptor, Object, [value, key]);
    if (!descriptor || !apply(hasOwn, Object, [descriptor, 'value']) || !descriptor.enumerable
        || descriptor.writable || descriptor.configurable) {
      return null;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function owner(value, keys) {
  const record = snapshot(value, keys);
  if (!record) return null;
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof record[keys[index]] !== 'function' || proxy(record[keys[index]])) {
      return null;
    }
  }
  return record;
}

function visible(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = apply(stringCharCodeAt, value, [index]);
    if (unit < 33 || unit > 126) return false;
  }
  return true;
}

function validApplicationClientId(value) {
  return visible(value, CLIENT_SUFFIX.length + 1, 255)
    && apply(stringEndsWith, value, [CLIENT_SUFFIX])
    && test(CLIENT_PREFIX, apply(stringSlice, value, [0, -CLIENT_SUFFIX.length]));
}

function validRedirectUri(value) {
  if (!visible(value, 1, 2048) || value !== REDIRECT) return false;
  try {
    const parsed = new URLConstructor(value);
    return apply(urlProtocol, parsed, []) === 'https:'
      && apply(urlUsername, parsed, []) === ''
      && apply(urlPassword, parsed, []) === ''
      && apply(urlHash, parsed, []) === ''
      && apply(urlSearch, parsed, []) === ''
      && apply(urlPort, parsed, []) === ''
      && apply(urlHostname, parsed, []) !== ''
      && apply(urlHref, parsed, []) === value;
  } catch (_) {
    return false;
  }
}

function validSecretRef(value) {
  if (typeof value !== 'string') return false;
  const colon = apply(stringIndexOf, value, [':']);
  if (colon < 1) return false;
  const rawScheme = apply(stringSlice, value, [0, colon]);
  const scheme = apply(stringToLowerCase, rawScheme, []);
  const body = apply(stringSlice, value, [colon + 1]);
  return rawScheme === scheme
    && (scheme === 'kv' || scheme === 'secret-ref')
    && test(SECRET_BODY, body)
    && !test(/^sk-[A-Za-z0-9]{10,}/, body)
    && !test(/^sk-ant-[A-Za-z0-9_-]{10,}/, body)
    && !test(/^Bearer(?:\s+|[._-])/i, body)
    && !test(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, body)
    && !test(/password\s*=/i, body)
    && !test(/^password[-_]/i, body)
    && !test(/client_secret\s*=/i, body)
    && !test(/api[_-]?key\s*=/i, body)
    && !test(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, body)
    && !test(/^ya29\.[A-Za-z0-9._-]+/, body);
}

function nativePromise(value) {
  return value !== null
    && typeof value === 'object'
    && !proxy(value)
    && apply(getPrototypeOf, Object, [value]) === promisePrototype
    && apply(isPromise, undefined, [value]);
}

function settle(value, accept) {
  if (!nativePromise(value)) return accept(value);
  return apply(promiseThen, value, [
    (result) => {
      try {
        return accept(result);
      } catch (_) {
        fail();
      }
    },
    () => fail(),
  ]);
}

function consumedRecord(value) {
  const record = snapshot(value, CONSUMED_KEYS);
  if (!record || record.status !== 'consumed') return null;
  if (!visible(record.authorizationCode, 1, 8192)) return null;
  for (let index = 2; index <= 7; index += 1) {
    if (typeof record[CONSUMED_KEYS[index]] !== 'string'
        || !test(UUID, record[CONSUMED_KEYS[index]])) {
      return null;
    }
  }
  if (typeof record.codeVerifier !== 'string' || !test(VERIFIER, record.codeVerifier)
      || typeof record.nonce !== 'string' || !test(NONCE, record.nonce)) {
    return null;
  }
  return record;
}

function createGoogleStateFirstCallbackRuntime(configuration, dependencies) {
  try {
    const config = snapshot(configuration, CONFIG_KEYS);
    const telemetryResolution = resolveOptionalStageTelemetry(dependencies, DEPENDENCY_KEYS);
    const owners = snapshot(dependencies, freeze([...DEPENDENCY_KEYS, 'stageTelemetry']))
      || snapshot(dependencies, DEPENDENCY_KEYS);
    const cryptography = owners && owner(owners.cryptography, freeze(['sha256Ascii']));
    const clock = owners && owner(owners.clock, freeze(['now']));
    const repository = owners && owner(owners.repository, freeze(['consume']));
    const resolver = owners && owner(owners.endpointAuthorityResolver, RESOLVER_KEYS);
    const factory = owners && owner(owners.transactionCompletionFactory, FACTORY_KEYS);
    const provider = owners && owner(owners.secretProvider, SECRET_PROVIDER_KEYS);
    if (!config || !owners || !telemetryResolution.ok || !cryptography || !clock || !repository || !resolver
        || !factory || !provider
        || config.tenantSlug !== TENANT
        || config.locationKey !== LOCATION_KEY
        || !validApplicationClientId(config.applicationClientId)
        || !validRedirectUri(config.redirectUri)
        || typeof config.callbackEnabled !== 'boolean') {
      fail();
    }

    const callbackConsume = createGoogleOAuthCallbackConsume(freeze({
      cryptography: owners.cryptography,
      clock: owners.clock,
      repository: owners.repository,
    }));
    const consumeOwner = owner(callbackConsume, freeze(['consumeCallback']));
    if (!consumeOwner) fail();

    const consumeCallback = consumeOwner.consumeCallback;
    const resolveAuthority = resolver.resolveConsumedEndpointAuthority;
    const createCompletion = factory.createTransactionCompletion;
    const resolverOwner = owners.endpointAuthorityResolver;
    const factoryOwner = owners.transactionCompletionFactory;
    const providerOwner = owners.secretProvider;
    const stageTelemetry = telemetryResolution.stageTelemetry;

    const publicConfiguration = freeze({
      tenantSlug: config.tenantSlug,
      locationKey: config.locationKey,
      applicationClientId: config.applicationClientId,
      redirectUri: config.redirectUri,
      callbackEnabled: config.callbackEnabled,
    });

    function acceptConsumed(output) {
      safeEmitStage(stageTelemetry, 'google_consume_returned');
      const status = snapshot(output, freeze(['status']));
      if (status && (status.status === 'invalid' || status.status === 'declined')) {
        return freeze({ status: status.status });
      }
      const record = consumedRecord(output);
      if (!record) fail();
      safeEmitStage(stageTelemetry, 'google_consume_matched');

      const request = freeze({
        tenantSlug: TENANT,
        clientId: record.clientId,
        locationKey: LOCATION_KEY,
        locationId: record.locationId,
        endpointId: record.endpointId,
      });
      safeEmitStage(stageTelemetry, 'google_authority_started');
      const resolved = apply(resolveAuthority, resolverOwner, [request]);
      return settle(resolved, (value) => {
        safeEmitStage(stageTelemetry, 'google_authority_returned');
        const authority = snapshot(value, AUTHORITY_KEYS);
        if (!authority
            || authority.tenantSlug !== TENANT
            || authority.clientId !== record.clientId
            || authority.locationKey !== LOCATION_KEY
            || authority.locationId !== record.locationId
            || authority.endpointId !== record.endpointId
            || !validSecretRef(authority.secretRef)) {
          fail();
        }
        safeEmitStage(stageTelemetry, 'google_authority_matched');

        const operation = freeze({
          clientId: record.clientId,
          endpointId: record.endpointId,
          operationId: record.operationId,
          actorStaffUserId: record.staffUserId,
          expectedNonce: record.nonce,
          expectedClientId: config.applicationClientId,
          applicationClientId: config.applicationClientId,
          redirectUri: config.redirectUri,
        });
        // Exact three-arg completion contract: secretProvider owner is third.
        safeEmitStage(stageTelemetry, 'google_factory_started');
        const service = apply(createCompletion, factoryOwner, [
          operation,
          freeze({ secretRef: authority.secretRef }),
          providerOwner,
        ]);
        const completion = owner(service, COMPLETION_KEYS);
        if (!completion) fail();
        safeEmitStage(stageTelemetry, 'google_factory_returned');
        const result = apply(completion.completeAuthorization, service, [freeze({
          authorizationCode: record.authorizationCode,
          codeVerifier: record.codeVerifier,
        })]);
        return settle(result, (acknowledgement) => {
          const ack = snapshot(acknowledgement, freeze(['status']));
          if (!ack || ack.status !== 'custodied') fail();
          return freeze({ status: 'received' });
        });
      });
    }

    function completeCallback(value) {
      if (!config.callbackEnabled) disabled();
      try {
        if (value !== null && typeof value === 'object' && proxy(value)) fail();
        const input = snapshot(value, INPUT_KEYS);
        if (!input || typeof input.query !== 'string') {
          fail();
        }
        const consumeInput = freeze({ query: input.query });
        safeEmitStage(stageTelemetry, 'google_consume_started');
        return settle(
          apply(consumeCallback, callbackConsume, [consumeInput]),
          acceptConsumed,
        );
      } catch (_) {
        fail();
      }
    }

    return freeze({
      configuration: publicConfiguration,
      completeCallback,
    });
  } catch (_) {
    fail();
  }
}

module.exports = freeze({ createGoogleStateFirstCallbackRuntime });
