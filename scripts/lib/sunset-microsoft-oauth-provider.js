'use strict';

const FAILURE_CODE = 'sunset_microsoft_oauth_provider_unavailable';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const ENV_KEY = 'LUNA_EMAIL_OAUTH_CLIENT_SECRET';
const VALUE_LIMIT_CHARS = 4096;

function failure() {
  const error = new Error(FAILURE_CODE);
  error.code = FAILURE_CODE;
  return error;
}

function ownData(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
}

function exactPlainData(object, keys) {
  if (!object || Object.getPrototypeOf(object) !== Object.prototype) return false;
  const actual = Reflect.ownKeys(object);
  return actual.length === keys.length
    && actual.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor && !descriptor.get && !descriptor.set;
    });
}

function createSunsetMicrosoftOAuthClientSecretProvider(deps) {
  let clientSecret;
  try {
    if (!exactPlainData(deps, ['deployment', 'env'])
        || ownData(deps, 'deployment') !== SUNSET_DEPLOYMENT) throw failure();
    const env = ownData(deps, 'env');
    if ((typeof env !== 'object' && typeof env !== 'function') || env === null) throw failure();
    clientSecret = ownData(env, ENV_KEY);
    if (typeof clientSecret !== 'string' || clientSecret.length < 1
        || clientSecret.length > VALUE_LIMIT_CHARS || !/^[\x21-\x7e]+$/.test(clientSecret)) throw failure();
  } catch (_) { throw failure(); }

  let used = false;
  async function getClientSecret() {
    if (used) throw failure();
    used = true;
    return clientSecret;
  }

  return Object.freeze({ getClientSecret });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  SUNSET_DEPLOYMENT,
  ENV_KEY,
  VALUE_LIMIT_CHARS,
  createSunsetMicrosoftOAuthClientSecretProvider,
});
