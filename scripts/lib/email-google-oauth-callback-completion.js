'use strict';

const utilTypes = require('node:util').types;

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
const promisePrototype = Promise.prototype;
const promiseThen = Promise.prototype.then;
const isProxy = utilTypes.isProxy;
const isPromise = utilTypes.isPromise;
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

const FAILURE_CODE = 'GOOGLE_OAUTH_CALLBACK_COMPLETION_FAILED';
const CONFIG_KEYS = freeze(['applicationClientId', 'redirectUri', 'secretRef']);
const DEPENDENCY_KEYS = freeze(['callbackConsume', 'secretProvider', 'transactionCompletionFactory']);
const CALLBACK_KEYS = freeze(['consumeCallback']);
const SECRET_PROVIDER_KEYS = freeze(['resolveClientSecret']);
const FACTORY_KEYS = freeze(['createTransactionCompletion']);
const COMPLETION_KEYS = freeze(['completeAuthorization']);
const CONSUMED_KEYS = freeze(['status', 'authorizationCode', 'clientId', 'operationId', 'locationId',
  'endpointId', 'staffUserId', 'codeVerifier', 'nonce']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLIENT_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const NONCE = /^[A-Za-z0-9_-]{43,128}$/;
const SECRET_BODY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;
const CLIENT_SUFFIX = '.apps.googleusercontent.com';

const failure = new Error(FAILURE_CODE);
defineProperty(failure, 'name', { value: 'GoogleOAuthCallbackCompletionError' });
defineProperty(failure, 'code', { value: FAILURE_CODE, enumerable: true });
freeze(failure);

function fail() { throw failure; }
function proxy(value) { return apply(isProxy, undefined, [value]); }
function test(pattern, value) { return apply(regexpTest, pattern, [value]); }

function snapshot(value, keys) {
  if (value === null || typeof value !== 'object' || proxy(value) || arrayIsArray(value)
      || apply(getPrototypeOf, Object, [value]) !== objectPrototype || !apply(isFrozen, Object, [value])) return null;
  const actual = apply(ownKeys, Reflect, [value]);
  if (actual.length !== keys.length) return null;
  const result = apply(createObject, Object, [null]);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (actual[index] !== key) return null;
    const descriptor = apply(getDescriptor, Object, [value, key]);
    if (!descriptor || !apply(hasOwn, Object, [descriptor, 'value']) || !descriptor.enumerable
        || descriptor.writable || descriptor.configurable) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function owner(value, keys) {
  const record = snapshot(value, keys);
  if (!record) return null;
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof record[keys[index]] !== 'function' || proxy(record[keys[index]])) return null;
  }
  return record;
}

function visible(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) return false;
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
  if (!visible(value, 1, 2048)) return false;
  try {
    const parsed = new URLConstructor(value);
    return apply(urlProtocol, parsed, []) === 'https:'
      && apply(urlUsername, parsed, []) === '' && apply(urlPassword, parsed, []) === ''
      && apply(urlHash, parsed, []) === '' && apply(urlSearch, parsed, []) === ''
      && apply(urlPort, parsed, []) === '' && apply(urlHostname, parsed, []) !== ''
      && apply(urlHref, parsed, []) === value;
  } catch (_) { return false; }
}

function validSecretRef(value) {
  if (typeof value !== 'string') return false;
  const colon = apply(stringIndexOf, value, [':']);
  if (colon < 1) return false;
  const rawScheme = apply(stringSlice, value, [0, colon]);
  const scheme = apply(stringToLowerCase, rawScheme, []);
  const body = apply(stringSlice, value, [colon + 1]);
  return rawScheme === scheme && (scheme === 'kv' || scheme === 'secret-ref') && test(SECRET_BODY, body)
    && !test(/^sk-[A-Za-z0-9]{10,}/, body) && !test(/^sk-ant-[A-Za-z0-9_-]{10,}/, body)
    && !test(/^Bearer(?:\s+|[._-])/i, body) && !test(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, body)
    && !test(/password\s*=/i, body) && !test(/^password[-_]/i, body)
    && !test(/client_secret\s*=/i, body) && !test(/api[_-]?key\s*=/i, body)
    && !test(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, body)
    && !test(/^ya29\.[A-Za-z0-9._-]+/, body);
}

function nativePromise(value) {
  if (value === null || typeof value !== 'object' || proxy(value)) return false;
  return apply(getPrototypeOf, Object, [value]) === promisePrototype
    && apply(isPromise, undefined, [value]);
}

function settle(value, accept) {
  if (!nativePromise(value)) return accept(value);
  return apply(promiseThen, value, [
    result => { try { return accept(result); } catch (_) { fail(); } },
    () => fail(),
  ]);
}

function consumedRecord(value) {
  const record = snapshot(value, CONSUMED_KEYS);
  if (!record || record.status !== 'consumed' || !visible(record.authorizationCode, 1, 8192)) return null;
  for (let index = 2; index <= 6; index += 1) {
    if (typeof record[CONSUMED_KEYS[index]] !== 'string' || !test(UUID, record[CONSUMED_KEYS[index]])) return null;
  }
  if (typeof record.codeVerifier !== 'string' || !test(VERIFIER, record.codeVerifier)
      || typeof record.nonce !== 'string' || !test(NONCE, record.nonce)) return null;
  return record;
}

function createGoogleOAuthCallbackCompletion(configuration, dependencies) {
  try {
    const config = snapshot(configuration, CONFIG_KEYS);
    const owners = snapshot(dependencies, DEPENDENCY_KEYS);
    const callback = owners && owner(owners.callbackConsume, CALLBACK_KEYS);
    const provider = owners && owner(owners.secretProvider, SECRET_PROVIDER_KEYS);
    const factory = owners && owner(owners.transactionCompletionFactory, FACTORY_KEYS);
    if (!config || !owners || !callback || !provider || !factory
        || !validApplicationClientId(config.applicationClientId)
        || !validRedirectUri(config.redirectUri) || !validSecretRef(config.secretRef)) fail();

    const callbackOwner = owners.callbackConsume;
    const providerOwner = owners.secretProvider;
    const factoryOwner = owners.transactionCompletionFactory;
    const consumeCallback = callback.consumeCallback;
    const createTransactionCompletion = factory.createTransactionCompletion;

    function acceptConsumed(output) {
      const status = snapshot(output, ['status']);
      if (status && (status.status === 'invalid' || status.status === 'declined')) {
        return freeze({ status: status.status });
      }
      const record = consumedRecord(output);
      if (!record) fail();
      const operationConfig = freeze({ clientId: record.clientId, endpointId: record.endpointId,
        operationId: record.operationId, actorStaffUserId: record.staffUserId,
        expectedNonce: record.nonce, expectedClientId: config.applicationClientId,
        applicationClientId: config.applicationClientId, redirectUri: config.redirectUri });
      const handoffConfig = freeze({ secretRef: config.secretRef });
      const service = apply(createTransactionCompletion, factoryOwner,
        [operationConfig, handoffConfig, providerOwner]);
      const completion = owner(service, COMPLETION_KEYS);
      if (!completion) fail();
      const result = apply(completion.completeAuthorization, service, [freeze({
        authorizationCode: record.authorizationCode, codeVerifier: record.codeVerifier,
      })]);
      return settle(result, acknowledgement => {
        const ack = snapshot(acknowledgement, ['status']);
        if (!ack || ack.status !== 'custodied') fail();
        return freeze({ status: 'received' });
      });
    }

    function completeCallback(value) {
      try {
        if (value !== null && typeof value === 'object' && proxy(value)) fail();
        const output = apply(consumeCallback, callbackOwner, [value]);
        return settle(output, acceptConsumed);
      } catch (_) { fail(); }
    }
    return freeze({ completeCallback });
  } catch (_) { fail(); }
}

module.exports = freeze({ createGoogleOAuthCallbackCompletion });
