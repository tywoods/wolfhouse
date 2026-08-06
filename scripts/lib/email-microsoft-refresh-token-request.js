'use strict';

/**
 * Microsoft refresh_token grant request (Sunset-staging health / rotation).
 * Builds client_secret_post form body and posts via injected token transport.
 * Single-use. Never logs secrets or tokens.
 *
 * @module email-microsoft-refresh-token-request
 */

const { REQUEST_LIMIT_BYTES } = require('./email-microsoft-token-http-transport');
const {
  classifyMicrosoftRefreshTokenResponse,
} = require('./email-microsoft-refresh-token-response');

const FAILURE_CODE = 'microsoft_refresh_token_exchange_failed';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFRESH_TOKEN_LIMIT_CHARS = 8192;
const CLIENT_SECRET_LIMIT_CHARS = 4096;
const CORE_DEPS_KEYS = Object.freeze([
  'deployment',
  'applicationClientId',
  'secretProvider',
  'transport',
]);

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
  if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && !descriptor.get && !descriptor.set;
  });
}

function exactSealedService(object, methodName) {
  return object && Object.getPrototypeOf(object) === Object.prototype && Object.isFrozen(object)
    && exactPlainData(object, [methodName])
    && typeof ownData(object, methodName) === 'function';
}

function exactProvider(object) {
  return object && Object.getPrototypeOf(object) === Object.prototype
    && exactPlainData(object, ['getClientSecret'])
    && typeof ownData(object, 'getClientSecret') === 'function';
}

function printable(value, limit) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= limit
    && /^[\x21-\x7e]+$/.test(value);
}

function snapshotInput(input) {
  if (!exactPlainData(input, ['refreshToken'])) return null;
  const refreshToken = ownData(input, 'refreshToken');
  if (!printable(refreshToken, REFRESH_TOKEN_LIMIT_CHARS)) return null;
  return Object.freeze({ refreshToken });
}

function createMicrosoftRefreshTokenRequestService(deps) {
  let secretProvider;
  let transport;
  let getClientSecret;
  let postTokenForm;
  let applicationClientId;
  try {
    if (!exactPlainData(deps, CORE_DEPS_KEYS)
        || ownData(deps, 'deployment') !== SUNSET_DEPLOYMENT) throw failure();
    applicationClientId = ownData(deps, 'applicationClientId');
    secretProvider = ownData(deps, 'secretProvider');
    transport = ownData(deps, 'transport');
    if (!CLIENT_ID_RE.test(applicationClientId)
        || !exactProvider(secretProvider)
        || !exactSealedService(transport, 'postTokenForm')) throw failure();
    getClientSecret = ownData(secretProvider, 'getClientSecret');
    postTokenForm = ownData(transport, 'postTokenForm');
  } catch (_) { throw failure(); }

  let used = false;
  async function exchangeRefreshToken(input) {
    if (used) throw failure();
    used = true;
    try {
      const inputSnapshot = snapshotInput(input);
      if (!inputSnapshot) throw failure();
      const clientSecret = await Reflect.apply(getClientSecret, secretProvider, []);
      if (!printable(clientSecret, CLIENT_SECRET_LIMIT_CHARS)) throw failure();
      const body = new URLSearchParams([
        ['client_id', applicationClientId],
        ['client_secret', clientSecret],
        ['grant_type', 'refresh_token'],
        ['refresh_token', inputSnapshot.refreshToken],
      ]).toString();
      if (Buffer.byteLength(body, 'utf8') > REQUEST_LIMIT_BYTES) throw failure();
      const rawResponse = await Reflect.apply(postTokenForm, transport, [
        Object.freeze({ body }),
      ]);
      const classified = classifyMicrosoftRefreshTokenResponse(rawResponse);
      if (!classified || typeof classified !== 'object' || !Object.isFrozen(classified)) {
        throw failure();
      }
      return classified;
    } catch (err) {
      if (err && err.code === FAILURE_CODE) throw err;
      throw failure();
    }
  }

  return Object.freeze({ exchangeRefreshToken });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  SUNSET_DEPLOYMENT,
  REFRESH_TOKEN_LIMIT_CHARS,
  CLIENT_SECRET_LIMIT_CHARS,
  createMicrosoftRefreshTokenRequestService,
});
