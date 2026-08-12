'use strict';
/** Strict source-only composition of the authentic Google state-first callback owners. */
const utilTypes = require('node:util').types;
const { createGoogleStateFirstCallbackRuntime } = require('./email-google-state-first-callback-runtime');
const { createGoogleConsumedEndpointAuthorityResolver } = require('./email-google-consumed-endpoint-authority-resolver');
const { createGoogleTransactionCompletionFactory } = require('./email-google-transaction-completion-factory');
const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const freeze = Object.freeze;
const isFrozen = Object.isFrozen;
const getPrototypeOf = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const create = Object.create;
const defineProperty = Object.defineProperty;
const objectPrototype = Object.prototype;
const arrayIsArray = Array.isArray;
const isProxy = utilTypes.isProxy;
const regexpTest = RegExp.prototype.test;
const stringEndsWith = String.prototype.endsWith;
const ErrorConstructor = Error;
const CONFIG_KEYS = freeze(['tenantSlug', 'clientId', 'locationKey', 'applicationClientId', 'redirectUri', 'callbackEnabled']);
const DEPENDENCY_KEYS = freeze(['db', 'cryptography', 'clock', 'repository', 'https', 'crypto', 'timers', 'envelopeProvider', 'installer', 'secretProvider']);
const METHOD_KEYS = freeze([
  freeze(['query']), freeze(['sha256Ascii']), freeze(['now', 'nowEpochSeconds']),
  freeze(['consume']), freeze(['request']), freeze(['createPublicKey', 'verify']),
  freeze(['setTimeout', 'clearTimeout']),
  freeze(['sealGrantPayload', 'openGrantPayload', 'rewrapGrantDek']),
  freeze(['installVerifiedGrant']), freeze(['resolveClientSecret']),
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APP = /^[A-Za-z0-9][A-Za-z0-9._-]*\.apps\.googleusercontent\.com$/;
const REDIRECT = 'https://staff-staging.lunafrontdesk.com/staff/email/google/callback';
const FAILURE = 'GOOGLE_STATE_FIRST_RUNTIME_COMPOSITION_FAILED';
function proxy(value) { return apply(isProxy, undefined, [value]); }
function test(pattern, value) { return apply(regexpTest, pattern, [value]); }
function fail() {
  const error = new ErrorConstructor(FAILURE);
  defineProperty(error, 'name', { value: 'GoogleStateFirstRuntimeCompositionError' });
  defineProperty(error, 'code', { value: FAILURE, enumerable: true });
  defineProperty(error, 'stack', { value: undefined });
  throw freeze(error);
}
function snapshot(value, keys) {
  if (value === null || typeof value !== 'object' || proxy(value) || arrayIsArray(value)
      || apply(getPrototypeOf, Object, [value]) !== objectPrototype
      || !apply(isFrozen, Object, [value])) return null;
  const actual = apply(ownKeys, Reflect, [value]);
  if (actual.length !== keys.length) return null;
  const result = apply(create, Object, [null]);
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
function adapter(receiver, record, keys) {
  const value = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]; const method = record[key];
    defineProperty(value, key, { enumerable: true, value: function pinned(...args) {
      return apply(method, receiver, args);
    } });
  }
  return freeze(value);
}
function createGoogleStateFirstRuntimeComposition(configuration, dependencies) {
  try {
    const config = snapshot(configuration, CONFIG_KEYS);
    const dependency = snapshot(dependencies, DEPENDENCY_KEYS);
    if (!config || !dependency || config.tenantSlug !== 'sunset'
        || !test(UUID, config.clientId) || config.locationKey !== 'sunset-somo'
        || typeof config.applicationClientId !== 'string' || !test(APP, config.applicationClientId)
        || config.redirectUri !== REDIRECT || typeof config.callbackEnabled !== 'boolean') fail();
    const records = [];
    for (let index = 0; index < DEPENDENCY_KEYS.length; index += 1) {
      const record = owner(dependency[DEPENDENCY_KEYS[index]], METHOD_KEYS[index]);
      if (!record) fail(); records.push(record);
    }
    const narrow = METHOD_KEYS.map((keys, index) => adapter(
      dependency[DEPENDENCY_KEYS[index]], records[index], keys,
    ));
    const resolver = createGoogleConsumedEndpointAuthorityResolver(freeze({ db: narrow[0] }));
    const factory = createGoogleTransactionCompletionFactory(freeze({
      https: narrow[4], crypto: narrow[5], timers: narrow[6], envelopeProvider: narrow[7],
      clock: freeze({ nowEpochSeconds: narrow[2].nowEpochSeconds }), installer: narrow[8],
    }));
    const runtime = createGoogleStateFirstCallbackRuntime(configuration, freeze({
      cryptography: narrow[1], clock: freeze({ now: narrow[2].now }), repository: narrow[3],
      endpointAuthorityResolver: resolver, transactionCompletionFactory: factory,
      secretProvider: narrow[9],
    }));
    const surface = owner(runtime, freeze(['configuration', 'completeCallback']));
    if (surface || !snapshot(runtime, freeze(['configuration', 'completeCallback']))) {
      // configuration is data, so owner() must reject this exact authentic mixed surface.
      if (surface) fail();
    }
    const complete = getDescriptor(runtime, 'completeCallback');
    const publicConfig = getDescriptor(runtime, 'configuration');
    if (!complete || !publicConfig || typeof complete.value !== 'function') fail();
    return freeze({ configuration: publicConfig.value, completeCallback: function completeCallback(value) {
      return apply(complete.value, runtime, [value]);
    } });
  } catch (_) { fail(); }
}
freeze(createGoogleStateFirstRuntimeComposition);
module.exports = freeze({ createGoogleStateFirstRuntimeComposition });
