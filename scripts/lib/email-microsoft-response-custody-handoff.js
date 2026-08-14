'use strict';

const {
  createMicrosoftTokenHttpTransport,
  RESPONSE_LIMIT_BYTES,
} = require('./email-microsoft-token-http-transport');
const {
  pinEmailOAuthStageTelemetry,
  createNoopEmailOAuthStageTelemetry,
  safeEmitStage,
} = require('./email-microsoft-oauth-stage-telemetry');
const {
  TOKEN_RESPONSE_REQUIRED_RESOURCE_SCOPES,
  TOKEN_RESPONSE_ALLOWED_OIDC_SCOPES,
  TOKEN_RESPONSE_SCOPE_ORDER,
  validateAndNormalizeTokenResponseScope,
} = require('./email-microsoft-token-response-scope');

const FAILURE_CODE = 'microsoft_token_custody_failed';
// Custody JSON body bound equals transport response cap (do not weaken transport).
const JSON_LIMIT_BYTES = RESPONSE_LIMIT_BYTES;
// Access/refresh stay at the historical 8KiB printable bound.
const TOKEN_LIMIT_CHARS = 8192;
// Own required id_token bound — aligned with merged OIDC LIMITS.token (32768).
const ID_TOKEN_LIMIT_CHARS = 32768;
const MAX_EXPIRES_IN_SECONDS = 86_400;
// Authorize/request Phase A set (offline_access requested; may be omitted in token response).
const PHASE_A_SCOPES = Object.freeze(['openid', 'profile', 'offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send']);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SUCCESS = Object.freeze({ status: 'custodied' });

function failure() { const error = new Error(FAILURE_CODE); error.code = FAILURE_CODE; return error; }
function ownData(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
}
function resolveStageTelemetry(deps) {
  try {
    if (!deps || typeof deps !== 'object') return createNoopEmailOAuthStageTelemetry();
    const raw = ownData(deps, 'stageTelemetry');
    if (raw === undefined) return createNoopEmailOAuthStageTelemetry();
    const pinned = pinEmailOAuthStageTelemetry(raw);
    return pinned || null;
  } catch {
    return null;
  }
}
function printable(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && /^[\x21-\x7e]+$/.test(value);
}
function assertUniqueTopLevelKeys(body) {
  const seen = new Set();
  let depth = 0;
  let expectingKey = false;
  let inString = false;
  let escaped = false;
  let keyStart = -1;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char !== '"') continue;
      inString = false;
      if (keyStart >= 0) {
        let key;
        try { key = JSON.parse(body.slice(keyStart, index + 1)); } catch (_) { throw failure(); }
        if (seen.has(key)) throw failure();
        seen.add(key);
        keyStart = -1;
        expectingKey = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      if (depth === 1 && expectingKey) keyStart = index;
      continue;
    }
    if (char === '{' || char === '[') {
      depth += 1;
      if (depth === 1 && char === '{') expectingKey = true;
      continue;
    }
    if (char === '}' || char === ']') { depth -= 1; continue; }
    if (depth === 1 && char === ',') expectingKey = true;
  }
}
function validate(response) {
  if (!response || Object.getPrototypeOf(response) !== Object.prototype || ownData(response, 'statusCode') !== 200) throw failure();
  const type = ownData(response, 'contentType');
  if (typeof type !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) throw failure();
  const body = ownData(response, 'body');
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > JSON_LIMIT_BYTES || body.includes('\ufffd')) throw failure();
  assertUniqueTopLevelKeys(body);
  let value;
  try { value = JSON.parse(body); } catch (_) { throw failure(); }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || DANGEROUS_KEYS.has(key))) throw failure();
  const tokenType = ownData(value, 'token_type');
  const expiresIn = ownData(value, 'expires_in');
  const accessToken = ownData(value, 'access_token');
  const refreshToken = ownData(value, 'refresh_token');
  const idToken = ownData(value, 'id_token');
  const scope = ownData(value, 'scope');
  if (tokenType !== 'Bearer' || !Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_EXPIRES_IN_SECONDS
      || !printable(accessToken, TOKEN_LIMIT_CHARS) || !printable(refreshToken, TOKEN_LIMIT_CHARS)
      || !printable(idToken, ID_TOKEN_LIMIT_CHARS)) throw failure();
  if (Object.hasOwn(value, 'ext_expires_in')) {
    const ext = ownData(value, 'ext_expires_in');
    if (!Number.isInteger(ext) || ext < 1 || ext > MAX_EXPIRES_IN_SECONDS) throw failure();
  }
  // Microsoft v2: effective access-token scopes; offline_access need not be echoed.
  const normalizedScope = validateAndNormalizeTokenResponseScope(scope);
  if (normalizedScope === null) throw failure();
  // Exact minimized selected shape for custody only (camelCase; fixed key order).
  // Persist actual normalized scope only — never synthesize offline_access/email.
  return Object.freeze({
    accessToken,
    refreshToken,
    tokenType,
    expiresIn,
    scope: normalizedScope,
    idToken,
  });
}
function sealedAck(value) {
  return value && Object.isFrozen(value) && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === 1 && ownData(value, 'status') === 'accepted';
}
function createMicrosoftTokenResponseCustodyService(deps = {}) {
  let custody;
  let accept;
  let transport;
  let stageTelemetry;
  try {
    custody = deps && Object.getPrototypeOf(deps) === Object.prototype ? ownData(deps, 'custody') : null;
    accept = custody && Object.getPrototypeOf(custody) === Object.prototype
      ? ownData(custody, 'acceptValidatedTokens') : null;
    if (typeof accept !== 'function') throw failure();
    transport = createMicrosoftTokenHttpTransport(ownData(deps, 'transportDeps') || {});
    stageTelemetry = resolveStageTelemetry(deps);
    if (!stageTelemetry) throw failure();
  } catch (_) { throw failure(); }
  let used = false;
  async function exchangeAndCustody(input) {
    if (used) throw failure();
    used = true;
    try {
      const rawResponse = await transport.postTokenForm(input);
      // Milestone: transport returned a response object (not yet validated).
      safeEmitStage(stageTelemetry, 'token_response_received');
      const selected = validate(rawResponse);
      // Milestone: selected token shape validated (no tokens logged).
      safeEmitStage(stageTelemetry, 'token_response_validated');
      if (!sealedAck(await Reflect.apply(accept, custody, [selected]))) throw failure();
      return SUCCESS;
    } catch (_) { throw failure(); }
  }
  return Object.freeze({ exchangeAndCustody });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  JSON_LIMIT_BYTES,
  TOKEN_LIMIT_CHARS,
  ID_TOKEN_LIMIT_CHARS,
  MAX_EXPIRES_IN_SECONDS,
  PHASE_A_SCOPES,
  TOKEN_RESPONSE_REQUIRED_RESOURCE_SCOPES,
  TOKEN_RESPONSE_ALLOWED_OIDC_SCOPES,
  TOKEN_RESPONSE_SCOPE_ORDER,
  createMicrosoftTokenResponseCustodyService,
});
