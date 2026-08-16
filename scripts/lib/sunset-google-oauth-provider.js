'use strict';

const { isProxy } = require('node:util').types;

const SECRET_REF = 'secret-ref:email/google/sunset-staging-oauth-client';
const SECRET_ENV = 'LUNA_EMAIL_GOOGLE_OAUTH_CLIENT_SECRET';
const FAILURE = 'GOOGLE_OAUTH_CLIENT_SECRET_PROVIDER_INVALID';
const VISIBLE = /^[\x21-\x7e]{16,512}$/;

function fail() {
  const error = new Error('Google OAuth client secret provider failed.');
  Object.defineProperty(error, 'name', { value: 'GoogleOAuthClientSecretProviderError' });
  Object.defineProperty(error, 'code', { value: FAILURE, enumerable: true });
  Object.defineProperty(error, 'stack', { value: undefined });
  throw Object.freeze(error);
}
function ownString(owner, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable
      && typeof descriptor.value === 'string' ? descriptor.value : null;
  } catch (_) { return null; }
}
function createSunsetGoogleOAuthClientSecretProvider(configuration) {
  try {
    if (!configuration || Reflect.ownKeys(configuration).join(',') !== 'deployment,env'
        || ownString(configuration, 'deployment') !== 'sunset-staging') fail();
    const envDescriptor = Object.getOwnPropertyDescriptor(configuration, 'env');
    const env = envDescriptor && Object.hasOwn(envDescriptor, 'value') ? envDescriptor.value : null;
    const secret = env && ownString(env, SECRET_ENV);
    if (!secret || !VISIBLE.test(secret)) fail();
    let used = false;
    return Object.freeze({
      resolveClientSecret(request) {
        try {
          if (used) fail();
          if (!request || typeof request !== 'object' || isProxy(request)
              || Object.getPrototypeOf(request) !== Object.prototype
              || !Object.isFrozen(request)
              || Reflect.ownKeys(request).join(',') !== 'secretRef') fail();
          const descriptor = Object.getOwnPropertyDescriptor(request, 'secretRef');
          if (!descriptor || descriptor.value !== SECRET_REF || descriptor.writable
              || !descriptor.enumerable || descriptor.configurable
              || Reflect.ownKeys(descriptor).join(',') !== 'value,writable,enumerable,configurable') fail();
          used = true;
          return Object.freeze({ clientSecret: secret });
        } catch (_) { fail(); }
      },
    });
  } catch (_) { fail(); }
}
module.exports = Object.freeze({ SECRET_REF, SECRET_ENV, createSunsetGoogleOAuthClientSecretProvider });
