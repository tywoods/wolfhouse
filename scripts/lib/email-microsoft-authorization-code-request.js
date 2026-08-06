'use strict';

const { REDIRECT_URI } = require('./email-microsoft-oauth-transaction-service');
const { REQUEST_LIMIT_BYTES } = require('./email-microsoft-token-http-transport');
const {
  pinEmailOAuthStageTelemetry,
  createNoopEmailOAuthStageTelemetry,
  safeEmitStage,
} = require('./email-microsoft-oauth-stage-telemetry');

const FAILURE_CODE = 'microsoft_authorization_code_exchange_failed';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const AUTHORIZATION_CODE_LIMIT_CHARS = 8192;
const CLIENT_SECRET_LIMIT_CHARS = 4096;
const SUCCESS = Object.freeze({ status: 'custodied' });
const CORE_DEPS_KEYS = Object.freeze([
  'deployment',
  'applicationClientId',
  'secretProvider',
  'responseCustody',
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
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && !descriptor.get && !descriptor.set;
  });
}
function exactSealedService(object, methodName) {
  return object && Object.getPrototypeOf(object) === Object.prototype && Object.isFrozen(object)
    && exactPlainData(object, [methodName]) && typeof ownData(object, methodName) === 'function';
}
function exactProvider(object) {
  return object && Object.getPrototypeOf(object) === Object.prototype
    && exactPlainData(object, ['getClientSecret']) && typeof ownData(object, 'getClientSecret') === 'function';
}
function printable(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && /^[\x21-\x7e]+$/.test(value);
}
function snapshotInput(input, applicationClientId) {
  if (!exactPlainData(input, ['authorizationCode', 'codeVerifier', 'clientId'])) return null;
  const authorizationCode = ownData(input, 'authorizationCode');
  const codeVerifier = ownData(input, 'codeVerifier');
  const clientId = ownData(input, 'clientId');
  if (!printable(authorizationCode, AUTHORIZATION_CODE_LIMIT_CHARS)
      || !PKCE_VERIFIER_RE.test(codeVerifier) || clientId !== applicationClientId) return null;
  return Object.freeze({ authorizationCode, codeVerifier });
}

function resolveStageTelemetry(deps) {
  const withStage = Object.freeze([...CORE_DEPS_KEYS, 'stageTelemetry']);
  if (exactPlainData(deps, withStage)) {
    const pinned = pinEmailOAuthStageTelemetry(ownData(deps, 'stageTelemetry'));
    if (!pinned) return null;
    return pinned;
  }
  if (exactPlainData(deps, CORE_DEPS_KEYS)) {
    return createNoopEmailOAuthStageTelemetry();
  }
  return null;
}

function createMicrosoftAuthorizationCodeRequestService(deps) {
  let secretProvider;
  let responseCustody;
  let getClientSecret;
  let exchangeAndCustody;
  let applicationClientId;
  let stageTelemetry;
  try {
    stageTelemetry = resolveStageTelemetry(deps);
    if (!stageTelemetry || ownData(deps, 'deployment') !== SUNSET_DEPLOYMENT) throw failure();
    applicationClientId = ownData(deps, 'applicationClientId');
    secretProvider = ownData(deps, 'secretProvider');
    responseCustody = ownData(deps, 'responseCustody');
    if (!CLIENT_ID_RE.test(applicationClientId)
        || !exactProvider(secretProvider)
        || !exactSealedService(responseCustody, 'exchangeAndCustody')) throw failure();
    getClientSecret = ownData(secretProvider, 'getClientSecret');
    exchangeAndCustody = ownData(responseCustody, 'exchangeAndCustody');
  } catch (_) { throw failure(); }

  let used = false;
  async function exchangeAuthorizationCode(input) {
    if (used) throw failure();
    used = true;
    try {
      const inputSnapshot = snapshotInput(input, applicationClientId);
      if (!inputSnapshot) throw failure();
      const clientSecret = await Reflect.apply(getClientSecret, secretProvider, []);
      if (!printable(clientSecret, CLIENT_SECRET_LIMIT_CHARS)) throw failure();
      const body = new URLSearchParams([
        ['client_id', applicationClientId],
        ['client_secret', clientSecret],
        ['grant_type', 'authorization_code'],
        ['code', inputSnapshot.authorizationCode],
        ['redirect_uri', REDIRECT_URI],
        ['code_verifier', inputSnapshot.codeVerifier],
      ]).toString();
      if (Buffer.byteLength(body, 'utf8') > REQUEST_LIMIT_BYTES) throw failure();
      // Milestone: token HTTP request about to start (body prepared, no response yet).
      safeEmitStage(stageTelemetry, 'token_request_started');
      const result = await Reflect.apply(exchangeAndCustody, responseCustody, [{ body }]);
      if (result !== SUCCESS && !(result && Object.isFrozen(result) && Object.getPrototypeOf(result) === Object.prototype
          && Reflect.ownKeys(result).length === 1 && ownData(result, 'status') === 'custodied')) throw failure();
      return SUCCESS;
    } catch (_) { throw failure(); }
  }
  return Object.freeze({ exchangeAuthorizationCode });
}

module.exports = Object.freeze({
  FAILURE_CODE, SUNSET_DEPLOYMENT, AUTHORIZATION_CODE_LIMIT_CHARS, CLIENT_SECRET_LIMIT_CHARS,
  createMicrosoftAuthorizationCodeRequestService,
});
