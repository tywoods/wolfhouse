'use strict';

const { createMicrosoftTokenHttpTransport } = require('./email-microsoft-token-http-transport');

const FAILURE_CODE = 'microsoft_token_custody_failed';
const JSON_LIMIT_BYTES = 32_768;
const TOKEN_LIMIT_CHARS = 8192;
const MAX_EXPIRES_IN_SECONDS = 86_400;
const PHASE_A_SCOPES = Object.freeze(['openid', 'profile', 'offline_access', 'User.Read', 'Mail.ReadBasic']);
const ALLOWED_SCOPES = new Set(PHASE_A_SCOPES);
const RESPONSE_KEYS = new Set(['token_type', 'expires_in', 'scope', 'access_token', 'refresh_token', 'id_token', 'ext_expires_in']);
const SUCCESS = Object.freeze({ status: 'custodied' });

function failure() { const error = new Error(FAILURE_CODE); error.code = FAILURE_CODE; return error; }
function ownData(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
}
function printable(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= TOKEN_LIMIT_CHARS && /^[\x21-\x7e]+$/.test(value);
}
function validate(response) {
  if (!response || Object.getPrototypeOf(response) !== Object.prototype || ownData(response, 'statusCode') !== 200) throw failure();
  const type = ownData(response, 'contentType');
  if (typeof type !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) throw failure();
  const body = ownData(response, 'body');
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > JSON_LIMIT_BYTES || body.includes('\ufffd')) throw failure();
  let value;
  try { value = JSON.parse(body); } catch (_) { throw failure(); }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !RESPONSE_KEYS.has(key))) throw failure();
  const tokenType = ownData(value, 'token_type');
  const expiresIn = ownData(value, 'expires_in');
  const accessToken = ownData(value, 'access_token');
  const refreshToken = ownData(value, 'refresh_token');
  const scope = ownData(value, 'scope');
  if (tokenType !== 'Bearer' || !Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_EXPIRES_IN_SECONDS
      || !printable(accessToken) || !printable(refreshToken)
      || typeof scope !== 'string' || scope.length < 1 || scope.length > 512) throw failure();
  if (Object.hasOwn(value, 'ext_expires_in')) {
    const ext = ownData(value, 'ext_expires_in');
    if (!Number.isInteger(ext) || ext < 1 || ext > MAX_EXPIRES_IN_SECONDS) throw failure();
  }
  if (Object.hasOwn(value, 'id_token') && !printable(ownData(value, 'id_token'))) throw failure();
  const scopes = scope.split(' ');
  if (scopes.some((item) => !item || !ALLOWED_SCOPES.has(item)) || new Set(scopes).size !== scopes.length) throw failure();
  return Object.freeze({ accessToken, refreshToken, tokenType, expiresIn, scope });
}
function sealedAck(value) {
  return value && Object.isFrozen(value) && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === 1 && ownData(value, 'status') === 'accepted';
}
function createMicrosoftTokenResponseCustodyService(deps = {}) {
  const custody = deps && Object.getPrototypeOf(deps) === Object.prototype ? ownData(deps, 'custody') : null;
  const accept = custody && Object.getPrototypeOf(custody) === Object.prototype
    ? ownData(custody, 'acceptValidatedTokens') : null;
  if (typeof accept !== 'function') throw failure();
  const transport = createMicrosoftTokenHttpTransport(ownData(deps, 'transportDeps') || {});
  let used = false;
  async function exchangeAndCustody(input) {
    if (used) throw failure();
    used = true;
    try {
      const selected = validate(await transport.postTokenForm(input));
      if (!sealedAck(await accept(selected))) throw failure();
      return SUCCESS;
    } catch (_) { throw failure(); }
  }
  return Object.freeze({ exchangeAndCustody });
}

module.exports = Object.freeze({
  FAILURE_CODE, JSON_LIMIT_BYTES, TOKEN_LIMIT_CHARS, MAX_EXPIRES_IN_SECONDS, PHASE_A_SCOPES,
  createMicrosoftTokenResponseCustodyService,
});
