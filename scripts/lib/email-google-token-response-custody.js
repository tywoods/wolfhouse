'use strict';

const { GOOGLE_PHASE_A_SCOPES } = require('./email-google-verified-grant-custody');

const FAILURE_CODE = 'GOOGLE_TOKEN_RESPONSE_CUSTODY_FAILED';
const INPUT_KEYS = Object.freeze(['statusCode', 'contentType', 'body']);
const RESPONSE_KEYS = Object.freeze([
  'access_token',
  'expires_in',
  'refresh_token',
  'scope',
  'token_type',
  'id_token',
]);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SUCCESS = Object.freeze({ status: 'custodied' });

function failure() {
  const error = new Error(FAILURE_CODE);
  Object.defineProperty(error, 'name', { value: 'GoogleTokenResponseCustodyError' });
  Object.defineProperty(error, 'code', { value: FAILURE_CODE, enumerable: true });
  return Object.freeze(error);
}

function ownData(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && descriptor.enumerable && !descriptor.get && !descriptor.set
    ? descriptor.value
    : undefined;
}

function exactFrozenData(value, keys) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
      || !Object.isFrozen(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key, index) => key !== keys[index])) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && descriptor.enumerable && !descriptor.get && !descriptor.set
      && descriptor.writable === false && descriptor.configurable === false;
  });
}

function hasUnsafeUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0xfffd) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function scanTopLevelKeys(body) {
  const seen = new Set();
  const stack = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let topLevelKey = false;
  let expectingTopLevelKey = false;
  let rootClosed = false;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character !== '"') continue;
      inString = false;
      if (topLevelKey) {
        let key;
        try { key = JSON.parse(body.slice(stringStart, index + 1)); } catch { throw failure(); }
        if (typeof key !== 'string' || seen.has(key) || DANGEROUS_KEYS.has(key)) throw failure();
        seen.add(key);
        expectingTopLevelKey = false;
        topLevelKey = false;
      }
      continue;
    }
    if (rootClosed) {
      if (!/\s/.test(character)) throw failure();
      continue;
    }
    if (character === '"') {
      inString = true;
      stringStart = index;
      topLevelKey = stack.length === 1 && stack[0] === '{' && expectingTopLevelKey;
      continue;
    }
    if (character === '{' || character === '[') {
      if (stack.length === 0 && character !== '{') throw failure();
      stack.push(character);
      if (stack.length === 1) expectingTopLevelKey = true;
      continue;
    }
    if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (stack.pop() !== expected) throw failure();
      if (stack.length === 0) rootClosed = true;
      continue;
    }
    if (stack.length === 1 && character === ',') expectingTopLevelKey = true;
  }
  if (inString || escaped || stack.length !== 0 || !rootClosed) throw failure();
}

function printable(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
    && /^[\x21-\x7e]+$/.test(value);
}

function normalizeScope(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024
      || value !== value.trim() || value.includes('  ') || hasUnsafeUnicode(value)) return null;
  const pieces = value.split(' ');
  if (pieces.length !== GOOGLE_PHASE_A_SCOPES.length || new Set(pieces).size !== pieces.length
      || pieces.some((scope) => !GOOGLE_PHASE_A_SCOPES.includes(scope))) return null;
  return GOOGLE_PHASE_A_SCOPES.join(' ');
}

function validate(input) {
  if (!exactFrozenData(input, INPUT_KEYS)) throw failure();
  const statusCode = ownData(input, 'statusCode');
  const contentType = ownData(input, 'contentType');
  const body = ownData(input, 'body');
  if (statusCode !== 200 || typeof contentType !== 'string'
      || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(contentType)
      || typeof body !== 'string' || body.length === 0 || body !== body.trim()
      || Buffer.byteLength(body, 'utf8') > 65536 || hasUnsafeUnicode(body)) throw failure();
  scanTopLevelKeys(body);
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw failure(); }
  if (!parsed || Object.getPrototypeOf(parsed) !== Object.prototype
      || Reflect.ownKeys(parsed).length !== RESPONSE_KEYS.length
      || RESPONSE_KEYS.some((key) => !Object.hasOwn(parsed, key))) throw failure();
  for (const key of Reflect.ownKeys(parsed)) {
    if (typeof key !== 'string' || !RESPONSE_KEYS.includes(key)) throw failure();
    const descriptor = Object.getOwnPropertyDescriptor(parsed, key);
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) throw failure();
  }
  const accessToken = ownData(parsed, 'access_token');
  const expiresIn = ownData(parsed, 'expires_in');
  const refreshToken = ownData(parsed, 'refresh_token');
  const scope = normalizeScope(ownData(parsed, 'scope'));
  const tokenType = ownData(parsed, 'token_type');
  const idToken = ownData(parsed, 'id_token');
  if (!printable(accessToken, 8192) || !printable(refreshToken, 8192)
      || tokenType !== 'Bearer' || !Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 86400
      || scope === null || !printable(idToken, 32768)) throw failure();
  const idTokenSegments = idToken.split('.');
  if (idTokenSegments.length !== 3 || idTokenSegments.some((segment) => segment.length === 0)) throw failure();
  return Object.freeze({ accessToken, refreshToken, tokenType, expiresIn, scope, idToken });
}

function sealedAcknowledgement(value) {
  return exactFrozenData(value, ['status']) && ownData(value, 'status') === 'accepted';
}

function createGoogleTokenResponseCustody(config) {
  let custody;
  let acceptValidatedTokens;
  try {
    if (!exactFrozenData(config, ['custody'])) throw failure();
    custody = ownData(config, 'custody');
    if (!exactFrozenData(custody, ['acceptValidatedTokens'])) throw failure();
    acceptValidatedTokens = ownData(custody, 'acceptValidatedTokens');
    if (typeof acceptValidatedTokens !== 'function') throw failure();
  } catch { throw failure(); }

  let used = false;
  async function acceptTokenResponse(input) {
    if (used) throw failure();
    used = true;
    try {
      const selected = validate(input);
      const acknowledgement = await Reflect.apply(acceptValidatedTokens, custody, [selected]);
      if (!sealedAcknowledgement(acknowledgement)) throw failure();
      return SUCCESS;
    } catch { throw failure(); }
  }
  return Object.freeze({ acceptTokenResponse });
}

module.exports = Object.freeze({ createGoogleTokenResponseCustody });
