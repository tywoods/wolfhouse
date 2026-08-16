'use strict';
const utilTypes = require('node:util').types;
const { Client: PgClient } = require('pg');
const { createGoogleOAuthStart } = require('./email-google-oauth-start');
const { createGoogleOAuthTransactionRepository } = require('./email-google-oauth-transaction-repository');
const { createGoogleStateFirstRuntimeComposition } = require('./email-google-state-first-runtime-composition');
const { createVerifiedGrantInstaller } = require('./email-verified-grant-installer');
const { createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition,
  parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig } = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const { validateEmailGrantEnvelopeProvider } = require('./email-grant-envelope-provider-contract');
const { createSunsetGoogleOAuthClientSecretProvider } = require('./sunset-google-oauth-provider');

const SUNSET_DEPLOYMENT = 'sunset-staging';
const START_ENABLED_ENV = 'LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED';
const CALLBACK_ENABLED_ENV = 'LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED';
const GRANT_CUSTODY_ENABLED_ENV = 'LUNA_EMAIL_GOOGLE_OAUTH_GRANT_CUSTODY_ENABLED';
const CLIENT_ID_ENV = 'LUNA_EMAIL_GOOGLE_OAUTH_CLIENT_ID';
const REDIRECT = 'https://sunset-staging.lunafrontdesk.com/staff/email/google/callback';
const FAILURE = 'GOOGLE_OAUTH_SUNSET_STAGING_RUNTIME_COMPOSITION_INVALID';
const APP = /^[A-Za-z0-9][A-Za-z0-9._-]*\.apps\.googleusercontent\.com$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isProxy = utilTypes.isProxy;
const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const getDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const isFrozen = Object.isFrozen;
const objectPrototype = Object.prototype;
const dateParse = Date.parse;
const DateConstructor = Date;
const dateToISOString = Date.prototype.toISOString;
const numberSafe = Number.isSafeInteger;
const pgClientPrototype = PgClient && PgClient.prototype;
const pgQueryDescriptor = pgClientPrototype && getDescriptor(pgClientPrototype, 'query');
const pgConstructorDescriptor = pgClientPrototype && getDescriptor(pgClientPrototype, 'constructor');
function sameDataDescriptor(actual, pinned) {
  return !!actual && !!pinned
    && hasOwn(actual, 'value') && hasOwn(pinned, 'value')
    && actual.value === pinned.value
    && actual.writable === pinned.writable
    && actual.enumerable === pinned.enumerable
    && actual.configurable === pinned.configurable
    && !actual.get && !actual.set && !pinned.get && !pinned.set;
}
const pgQuery = pgQueryDescriptor && hasOwn(pgQueryDescriptor, 'value')
  && !pgQueryDescriptor.get && !pgQueryDescriptor.set && typeof pgQueryDescriptor.value === 'function'
  ? pgQueryDescriptor.value : null;
const pgNativePinned = typeof PgClient === 'function' && pgClientPrototype && pgQuery
  && pgConstructorDescriptor && pgConstructorDescriptor.value === PgClient
  && !pgConstructorDescriptor.get && !pgConstructorDescriptor.set;

function fail() {
  const error = new Error('Google OAuth Sunset staging runtime composition failed.');
  Object.defineProperty(error, 'name', { value: 'GoogleOAuthSunsetStagingRuntimeCompositionError' });
  Object.defineProperty(error, 'code', { value: FAILURE, enumerable: true });
  Object.defineProperty(error, 'stack', { value: undefined });
  throw freeze(error);
}
function proxy(value) { try { return apply(isProxy, undefined, [value]); } catch (_) { return true; } }
function own(owner, key) {
  try { const d = apply(getDescriptor, Object, [owner, key]); return d && apply(hasOwn, Object, [d, 'value']) ? d.value : undefined; }
  catch (_) { return undefined; }
}
function exactFrozen(owner, keys) {
  try {
    if (!owner || typeof owner !== 'object' || proxy(owner) || Array.isArray(owner)
        || apply(getPrototypeOf, Object, [owner]) !== objectPrototype || !apply(isFrozen, Object, [owner])) return false;
    const actual = apply(ownKeys, Reflect, [owner]);
    if (actual.length !== keys.length) return false;
    for (let i = 0; i < keys.length; i += 1) {
      if (actual[i] !== keys[i]) return false;
      const d = apply(getDescriptor, Object, [owner, keys[i]]);
      if (!d || !apply(hasOwn, Object, [d, 'value']) || !d.enumerable || d.writable || d.configurable) return false;
    }
    return true;
  } catch (_) { return false; }
}
function envString(env, key) { const value = own(env, key); return typeof value === 'string' ? value : null; }
function validEnv(env) {
  try {
    if (!env || typeof env !== 'object' || proxy(env) || Array.isArray(env)
        || apply(getPrototypeOf, Object, [env]) !== objectPrototype || !apply(isFrozen, Object, [env])) return false;
    for (const key of apply(ownKeys, Reflect, [env])) {
      if (typeof key !== 'string') return false;
      const d = apply(getDescriptor, Object, [env, key]);
      if (!d || !apply(hasOwn, Object, [d, 'value']) || !d.enumerable || d.writable || d.configurable
          || typeof d.value !== 'string') return false;
    }
    return true;
  } catch (_) { return false; }
}
function pinMethods(owner, keys) {
  if (!exactFrozen(owner, keys)) fail();
  const out = {};
  for (const key of keys) {
    const fn = own(owner, key);
    if (typeof fn !== 'function' || proxy(fn)) fail();
    Object.defineProperty(out, key, { enumerable: true, value(...args) { return apply(fn, owner, args); } });
  }
  return freeze(out);
}
function pinPg(raw) {
  try {
    if (!raw || (typeof raw !== 'object' && typeof raw !== 'function') || proxy(raw) || Array.isArray(raw)) fail();
    let query;
    if (apply(getPrototypeOf, Object, [raw]) === pgClientPrototype) {
      if (!pgNativePinned || apply(getDescriptor, Object, [raw, 'query'])) fail();
      const queryDescriptor = apply(getDescriptor, Object, [pgClientPrototype, 'query']);
      const constructorDescriptor = apply(getDescriptor, Object, [pgClientPrototype, 'constructor']);
      if (!sameDataDescriptor(queryDescriptor, pgQueryDescriptor)
          || !sameDataDescriptor(constructorDescriptor, pgConstructorDescriptor)
          || !(raw instanceof PgClient)) fail();
      query = pgQuery;
    } else {
      if (!exactFrozen(raw, ['query'])) fail();
      query = own(raw, 'query');
    }
    if (typeof query !== 'function' || proxy(query)) fail();
    if (typeof own(raw, 'connect') === 'function'
        || ['totalCount', 'idleCount', 'waitingCount'].some(key => own(raw, key) !== undefined)) fail();
    return freeze({ query(...args) { return apply(query, raw, args); } });
  } catch (_) { fail(); }
}
function pinClock(raw) {
  const pinned = pinMethods(raw, ['now', 'nowEpochSeconds']);
  return freeze({
    now() {
      const value = pinned.now();
      const parsed = typeof value === 'string' && TIMESTAMP.test(value) ? apply(dateParse, DateConstructor, [value]) : NaN;
      if (!Number.isFinite(parsed) || apply(dateToISOString, new DateConstructor(parsed), []) !== value) fail();
      return value;
    },
    nowEpochSeconds() {
      const value = pinned.nowEpochSeconds();
      if (!apply(numberSafe, Number, [value]) || value < 0) fail();
      return value;
    },
  });
}
function createSunsetStagingGoogleOAuthComposition(dependencies) {
  try {
    if (!exactFrozen(dependencies, ['env', 'https', 'crypto', 'timers', 'clock'])) fail();
    const env = own(dependencies, 'env');
    if (!validEnv(env) || envString(env, 'LUNA_DEPLOYMENT') !== SUNSET_DEPLOYMENT) fail();
    const applicationClientId = envString(env, CLIENT_ID_ENV);
    if (!applicationClientId || !APP.test(applicationClientId)) fail();
    const startEnabled = envString(env, START_ENABLED_ENV) === 'true';
    const callbackEnabled = envString(env, CALLBACK_ENABLED_ENV) === 'true';
    const custodyEnabled = envString(env, GRANT_CUSTODY_ENABLED_ENV) === 'true';
    const envelopeConfig = parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig(env);
    const envelopeEnabled = envelopeConfig.ok === true && envelopeConfig.composition_enabled === true;
    const https = pinMethods(own(dependencies, 'https'), ['request']);
    const cryptoVerify = pinMethods(own(dependencies, 'crypto'), ['createPublicKey', 'verify', 'randomUUID', 'randomBytes', 'createHash']);
    const timers = pinMethods(own(dependencies, 'timers'), ['setTimeout', 'clearTimeout']);
    const clock = pinClock(own(dependencies, 'clock'));
    const cryptography = freeze({
      randomUUID: cryptoVerify.randomUUID,
      randomBytes: cryptoVerify.randomBytes,
      sha256Ascii(value) { const h = cryptoVerify.createHash('sha256'); h.update(value, 'ascii'); return h.digest(); },
    });
    function owners(pgClient) {
      const queryOwner = pinPg(pgClient);
      return freeze({ queryOwner, repository: createGoogleOAuthTransactionRepository(freeze({ queryOwner })) });
    }
    function createStart(pgClient) {
      if (!startEnabled) fail();
      const pinned = owners(pgClient);
      return createGoogleOAuthStart(freeze({ enabled: true, applicationClientId, redirectUri: REDIRECT }), freeze({
        cryptography, clock: freeze({ now: clock.now }),
        repository: freeze({ create: pinned.repository.create }),
      }));
    }
    function createCallbackRuntime(pgClient) {
      if (!callbackEnabled || !custodyEnabled || !envelopeEnabled) fail();
      const pinned = owners(pgClient);
      let envelope;
      try { envelope = createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(env); }
      catch (_) { fail(); }
      if (!envelope || envelope.ok !== true || envelope.composition_enabled !== true
          || envelope.runtime_activation !== true || !envelope.provider) fail();
      const validated = validateEmailGrantEnvelopeProvider(envelope.provider);
      if (!validated.ok || !validated.value) fail();
      const installer = createVerifiedGrantInstaller(freeze({ client: pinned.queryOwner }));
      const secretProvider = createSunsetGoogleOAuthClientSecretProvider({ deployment: SUNSET_DEPLOYMENT, env });
      return createGoogleStateFirstRuntimeComposition(freeze({ tenantSlug: 'sunset',
        locationKey: 'sunset-somo', applicationClientId, redirectUri: REDIRECT, callbackEnabled: true }), freeze({
        db: pinned.queryOwner, cryptography: freeze({ sha256Ascii: cryptography.sha256Ascii }), clock,
        repository: freeze({ consume: pinned.repository.consume }),
        https: freeze({ request: https.request }),
        crypto: freeze({ createPublicKey: cryptoVerify.createPublicKey, verify: cryptoVerify.verify }), timers,
        envelopeProvider: validated.value, installer, secretProvider,
      }));
    }
    return freeze({ createStart, createCallbackRuntime });
  } catch (_) { fail(); }
}
freeze(createSunsetStagingGoogleOAuthComposition);
module.exports = freeze({ SUNSET_DEPLOYMENT, START_ENABLED_ENV, CALLBACK_ENABLED_ENV,
  GRANT_CUSTODY_ENABLED_ENV, createSunsetStagingGoogleOAuthComposition });
