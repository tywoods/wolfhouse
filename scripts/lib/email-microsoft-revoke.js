'use strict';

/**
 * Microsoft OAuth2 token revoke (Sunset disconnect). Posts refresh_token to
 * /organizations/oauth2/v2.0/revoke via injected token transport. Single-use.
 * Never logs secrets or tokens.
 *
 * @module email-microsoft-revoke
 */

const { REQUEST_LIMIT_BYTES } = require('./email-microsoft-token-http-transport');

const FAILURE_CODE = 'microsoft_token_revoke_failed';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const REVOKE_PATH = '/organizations/oauth2/v2.0/revoke';
const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_LIMIT_CHARS = 8192;
const CLIENT_SECRET_LIMIT_CHARS = 4096;
const REVOKE_INPUT_KEYS = Object.freeze(['refreshToken']);
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

function printable(value, limit) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= limit
    && /^[\x21-\x7e]+$/.test(value);
}

function createMicrosoftTokenRevokeService(deps) {
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
        || !secretProvider || typeof ownData(secretProvider, 'getClientSecret') !== 'function'
        || !transport || typeof ownData(transport, 'postTokenForm') !== 'function') {
      throw failure();
    }
    getClientSecret = ownData(secretProvider, 'getClientSecret');
    postTokenForm = ownData(transport, 'postTokenForm');
  } catch (_) { throw failure(); }

  let used = false;
  async function revokeRefreshToken(input) {
    if (used) throw failure();
    used = true;
    try {
      if (!exactPlainData(input, REVOKE_INPUT_KEYS)) throw failure();
      const refreshToken = ownData(input, 'refreshToken');
      if (!printable(refreshToken, TOKEN_LIMIT_CHARS)) throw failure();
      const clientSecret = await Reflect.apply(getClientSecret, secretProvider, []);
      if (!printable(clientSecret, CLIENT_SECRET_LIMIT_CHARS)) throw failure();
      const body = new URLSearchParams([
        ['client_id', applicationClientId],
        ['client_secret', clientSecret],
        ['token', refreshToken],
      ]).toString();
      const response = await Reflect.apply(postTokenForm, transport, [{
        path: REVOKE_PATH,
        body,
        responseLimitBytes: REQUEST_LIMIT_BYTES,
      }]);
      if (!response || ownData(response, 'statusCode') !== 200) throw failure();
      return Object.freeze({ status: 'revoked' });
    } catch (_) {
      throw failure();
    }
  }

  return Object.freeze({ revokeRefreshToken });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  SUNSET_DEPLOYMENT,
  REVOKE_PATH,
  createMicrosoftTokenRevokeService,
});
