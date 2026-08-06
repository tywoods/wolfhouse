'use strict';

/**
 * Microsoft refresh-token response classification (health / rotation only).
 * Never logs or returns tokens, error_description, correlation ids, or raw bodies.
 *
 * Success: HTTP 200 Bearer + access + refresh + Phase A resource scopes.
 * id_token is ignored when present (refresh path does not rebind identity).
 * Terminal: OAuth error invalid_grant.
 * Everything else (transport gaps, malformed, other OAuth errors, scope fail):
 * uncertain — caller marks ms_response_uncertain reconciliation.
 *
 * @module email-microsoft-refresh-token-response
 */

const { RESPONSE_LIMIT_BYTES } = require('./email-microsoft-token-http-transport');
const {
  validateAndNormalizeTokenResponseScope,
} = require('./email-microsoft-token-response-scope');

const FAILURE_CODE = 'microsoft_refresh_token_response_invalid';
const JSON_LIMIT_BYTES = RESPONSE_LIMIT_BYTES;
const TOKEN_LIMIT_CHARS = 8192;
const MAX_EXPIRES_IN_SECONDS = 86_400;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PRINTABLE = /^[\x21-\x7e]+$/;

function ownData(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function printable(value, limit) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= limit
    && PRINTABLE.test(value);
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
        try { key = JSON.parse(body.slice(keyStart, index + 1)); } catch (_) { return false; }
        if (seen.has(key)) return false;
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
  return true;
}

function parseJsonObject(body) {
  if (typeof body !== 'string'
      || Buffer.byteLength(body, 'utf8') > JSON_LIMIT_BYTES
      || body.includes('\ufffd')) {
    return null;
  }
  if (!assertUniqueTopLevelKeys(body)) return null;
  let value;
  try { value = JSON.parse(body); } catch (_) { return null; }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return null;
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || DANGEROUS_KEYS.has(key))) {
    return null;
  }
  return value;
}

function uncertain() {
  return Object.freeze({ kind: 'uncertain' });
}

function invalidGrant() {
  return Object.freeze({ kind: 'invalid_grant' });
}

/**
 * @param {unknown} response frozen transport shape { statusCode, contentType, body }
 * @returns {{ kind: 'success'|'invalid_grant'|'uncertain', selected?: object }}
 */
function classifyMicrosoftRefreshTokenResponse(response) {
  try {
    if (!response || Object.getPrototypeOf(response) !== Object.prototype) return uncertain();
    const statusCode = ownData(response, 'statusCode');
    const contentType = ownData(response, 'contentType');
    const body = ownData(response, 'body');

    if (statusCode === 400) {
      if (typeof contentType === 'string'
          && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
          && contentType !== '') {
        return uncertain();
      }
      const value = parseJsonObject(typeof body === 'string' ? body : '');
      if (!value) return uncertain();
      if (ownData(value, 'error') === 'invalid_grant') return invalidGrant();
      return uncertain();
    }

    if (statusCode !== 200) return uncertain();
    if (typeof contentType !== 'string'
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
      return uncertain();
    }
    const value = parseJsonObject(body);
    if (!value) return uncertain();
    if (Object.prototype.hasOwnProperty.call(value, 'error')) return uncertain();

    const tokenType = ownData(value, 'token_type');
    const expiresIn = ownData(value, 'expires_in');
    const accessToken = ownData(value, 'access_token');
    const refreshToken = ownData(value, 'refresh_token');
    const scope = ownData(value, 'scope');
    if (tokenType !== 'Bearer'
        || !Number.isInteger(expiresIn)
        || expiresIn < 1
        || expiresIn > MAX_EXPIRES_IN_SECONDS
        || !printable(accessToken, TOKEN_LIMIT_CHARS)
        || !printable(refreshToken, TOKEN_LIMIT_CHARS)) {
      return uncertain();
    }
    if (Object.hasOwn(value, 'ext_expires_in')) {
      const ext = ownData(value, 'ext_expires_in');
      if (!Number.isInteger(ext) || ext < 1 || ext > MAX_EXPIRES_IN_SECONDS) return uncertain();
    }
    const normalizedScope = validateAndNormalizeTokenResponseScope(scope);
    if (normalizedScope === null) return uncertain();

    return Object.freeze({
      kind: 'success',
      selected: Object.freeze({
        accessToken,
        refreshToken,
        tokenType,
        expiresIn,
        scope: normalizedScope,
      }),
    });
  } catch (_) {
    return uncertain();
  }
}

module.exports = Object.freeze({
  FAILURE_CODE,
  JSON_LIMIT_BYTES,
  TOKEN_LIMIT_CHARS,
  MAX_EXPIRES_IN_SECONDS,
  classifyMicrosoftRefreshTokenResponse,
});
