'use strict';

const utilTypes = require('node:util').types;
const {
  createGoogleAuthorizationCodeOperation,
} = require('./email-google-authorization-code-operation');
const {
  createGoogleClientSecretHandoff,
} = require('./email-google-client-secret-handoff');
const { resolveOptionalStageTelemetry } = require('./email-microsoft-oauth-stage-telemetry');

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
const regexpTest = RegExp.prototype.test;
const stringCharCodeAt = String.prototype.charCodeAt;
const stringEndsWith = String.prototype.endsWith;
const stringSlice = String.prototype.slice;
const stringIndexOf = String.prototype.indexOf;
const stringToLowerCase = String.prototype.toLowerCase;
const isProxy = utilTypes.isProxy;
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


const DEPENDENCY_KEYS = freeze(['https', 'crypto', 'timers', 'envelopeProvider', 'clock', 'installer']);
const OWNER_METHODS = freeze([
  freeze(['request']),
  freeze(['createPublicKey', 'verify']),
  freeze(['setTimeout', 'clearTimeout']),
  freeze(['sealGrantPayload', 'openGrantPayload', 'rewrapGrantDek']),
  freeze(['nowEpochSeconds']),
  freeze(['installVerifiedGrant']),
]);
const OPERATION_KEYS = freeze(['clientId', 'endpointId', 'operationId', 'actorStaffUserId',
  'expectedNonce', 'expectedClientId', 'applicationClientId', 'redirectUri']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLIENT_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SECRET_BODY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;
const CLIENT_SUFFIX = '.apps.googleusercontent.com';
const FAILURE_CODE = 'GOOGLE_TRANSACTION_COMPLETION_FACTORY_FAILED';
const failure = new Error(FAILURE_CODE);
defineProperty(failure, 'name', { value: 'GoogleTransactionCompletionFactoryError' });
defineProperty(failure, 'code', { value: FAILURE_CODE, enumerable: true });
freeze(failure);

function proxy(value) { return apply(isProxy, undefined, [value]); }
function test(pattern, value) { return apply(regexpTest, pattern, [value]); }
function fail() { throw failure; }

function snapshot(value, keys) {
  if (value === null || typeof value !== 'object' || proxy(value)
      || apply(getPrototypeOf, Object, [value]) !== objectPrototype
      || !apply(isFrozen, Object, [value])) return null;
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

function owner(value, methods) {
  const record = snapshot(value, methods);
  if (!record) return null;
  for (let index = 0; index < methods.length; index += 1) {
    const method = record[methods[index]];
    if (typeof method !== 'function' || proxy(method)) return null;
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

function validClientId(value) {
  return visible(value, CLIENT_SUFFIX.length + 1, 255)
    && apply(stringEndsWith, value, [CLIENT_SUFFIX])
    && test(CLIENT_PREFIX, apply(stringSlice, value, [0, -CLIENT_SUFFIX.length]));
}

function validRedirect(value) {
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

function createGoogleTransactionCompletionFactory(dependencies) {
  try {
    const telemetryResolution = resolveOptionalStageTelemetry(dependencies, DEPENDENCY_KEYS);
    const dependency = snapshot(dependencies, [...DEPENDENCY_KEYS, 'stageTelemetry'])
      || snapshot(dependencies, DEPENDENCY_KEYS);
    if (!dependency || !telemetryResolution.ok) fail();
    for (let index = 0; index < DEPENDENCY_KEYS.length; index += 1) {
      if (!owner(dependency[DEPENDENCY_KEYS[index]], OWNER_METHODS[index])) fail();
    }

    function createTransactionCompletion(operationConfiguration, handoffConfiguration, secretProvider) {
      try {
        const operationConfig = snapshot(operationConfiguration, OPERATION_KEYS);
        const handoffConfig = snapshot(handoffConfiguration, ['secretRef']);
        const provider = owner(secretProvider, ['resolveClientSecret']);
        if (!operationConfig || !handoffConfig || !provider
            || !test(UUID, operationConfig.clientId) || !test(UUID, operationConfig.endpointId)
            || !test(UUID, operationConfig.operationId) || !test(UUID, operationConfig.actorStaffUserId)
            || !visible(operationConfig.expectedNonce, 1, 1024)
            || operationConfig.expectedClientId !== operationConfig.applicationClientId
            || !validClientId(operationConfig.applicationClientId)
            || !validRedirect(operationConfig.redirectUri) || !validSecretRef(handoffConfig.secretRef)) fail();

        const operation = createGoogleAuthorizationCodeOperation(operationConfiguration, freeze({
          https: dependency.https, crypto: dependency.crypto, timers: dependency.timers,
          envelopeProvider: dependency.envelopeProvider, clock: dependency.clock, installer: dependency.installer,
        }));
        if (!owner(operation, ['exchangeAuthorizationCode'])) fail();
        const handoff = createGoogleClientSecretHandoff(handoffConfiguration,
          freeze({ secretProvider, operation, stageTelemetry: telemetryResolution.stageTelemetry }));
        if (!owner(handoff, ['completeAuthorization'])) fail();
        return handoff;
      } catch (_) { fail(); }
    }

    return freeze({ createTransactionCompletion });
  } catch (_) { fail(); }
}

module.exports = freeze({ createGoogleTransactionCompletionFactory });
