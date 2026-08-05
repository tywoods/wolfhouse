'use strict';

const { timingSafeEqual } = require('crypto');
const { TextDecoder } = require('util');

const ERROR_CODE = 'MICROSOFT_OIDC_ID_TOKEN_INVALID';
const ERROR_MESSAGE = 'Microsoft OIDC ID token validation failed.';
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SKEW_SECONDS = 300;
const MAX_LIFETIME_SECONDS = 86400;
const LIMITS = Object.freeze({ token: 32768, headerSegment: 2048, claimsSegment: 24576, signatureSegment: 2048, kid: 256, text: 2048 });

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'MicrosoftOidcIdTokenError' });
  Object.defineProperty(error, 'code', { value: ERROR_CODE, enumerable: true });
  return Object.freeze(error);
}

function exactPlainData(value, keys) {
  try {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return null;
    const out = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) return null;
      out[key] = descriptor.value;
    }
    return out;
  } catch { return null; }
}

function hasUnpairedSurrogate(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function parseStrictJson(text) {
  let at = 0;
  const bad = () => { throw failure(); };
  const ws = () => { while (/[\x20\x09\x0a\x0d]/.test(text[at] || '')) at += 1; };
  function string() {
    const start = at++;
    let escaped = false;
    while (at < text.length) {
      const code = text.charCodeAt(at);
      if (!escaped && code === 34) {
        at += 1;
        let result; try { result = JSON.parse(text.slice(start, at)); } catch { bad(); }
        if (result.length > LIMITS.text || hasUnpairedSurrogate(result)) bad();
        return result;
      }
      if (!escaped && code < 0x20) bad();
      if (!escaped && code === 92) escaped = true; else escaped = false;
      at += 1;
    }
    bad();
  }
  function value(depth) {
    if (depth > 8) bad();
    ws();
    if (text[at] === '{') return object(depth + 1);
    if (text[at] === '[') return array(depth + 1);
    if (text[at] === '"') return string();
    const rest = text.slice(at);
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (rest.startsWith(literal)) { at += literal.length; return result; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (!match) bad();
    at += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) bad();
    return number;
  }
  function object(depth) {
    at += 1; const out = Object.create(null); const names = new Set(); ws();
    if (text[at] === '}') { at += 1; return out; }
    for (;;) {
      ws(); if (text[at] !== '"') bad(); const key = string();
      if (names.has(key) || DANGEROUS_KEYS.has(key) || names.size >= 64) bad();
      names.add(key); ws(); if (text[at++] !== ':') bad(); out[key] = value(depth); ws();
      if (text[at] === '}') { at += 1; return out; }
      if (text[at++] !== ',') bad();
    }
  }
  function array(depth) {
    at += 1; const out = []; ws(); if (text[at] === ']') { at += 1; return out; }
    for (;;) {
      if (out.length >= 64) bad(); out.push(value(depth)); ws();
      if (text[at] === ']') { at += 1; return out; }
      if (text[at++] !== ',') bad();
    }
  }
  const result = value(0); ws(); if (at !== text.length) bad(); return result;
}

function decodeSegment(segment, limit, allowEmpty = false) {
  if (typeof segment !== 'string' || segment.length > limit || (!allowEmpty && segment.length === 0)
      || !/^[A-Za-z0-9_-]*$/.test(segment) || segment.length % 4 === 1) throw failure();
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw failure();
  return bytes;
}

function decodeJson(segment, limit) {
  const bytes = decodeSegment(segment, limit);
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw failure(); }
  return parseStrictJson(text);
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8'); const b = Buffer.from(right, 'utf8');
  const length = Math.max(a.length, b.length, 1);
  const aa = Buffer.alloc(length); const bb = Buffer.alloc(length); a.copy(aa); b.copy(bb);
  return timingSafeEqual(aa, bb) && a.length === b.length;
}

function bounded(value, max = LIMITS.text) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !hasUnpairedSurrogate(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

function createMicrosoftOidcIdTokenValidator(dependencies) {
  let verifier;
  let verify;
  try {
    const deps = exactPlainData(dependencies, ['signatureVerifier']);
    verifier = deps && deps.signatureVerifier;
    if (!verifier || Object.getPrototypeOf(verifier) !== Object.prototype || !Object.isFrozen(verifier)
        || Reflect.ownKeys(verifier).length !== 1) throw failure();
    const descriptor = Object.getOwnPropertyDescriptor(verifier, 'verify');
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') throw failure();
    verify = descriptor.value;
  } catch { throw failure(); }

  let used = false;
  async function validate(input) {
    if (used) throw failure();
    used = true;
    try {
      const data = exactPlainData(input, ['idToken', 'expectedNonce', 'expectedClientId', 'nowEpochSeconds']);
      if (!data || !bounded(data.idToken, LIMITS.token) || !bounded(data.expectedNonce, 512)
          || !bounded(data.expectedClientId, 256) || !Number.isSafeInteger(data.nowEpochSeconds) || data.nowEpochSeconds < 0) throw failure();
      const segments = data.idToken.split('.');
      if (segments.length !== 3) throw failure();
      const [encodedHeader, encodedClaims, encodedSignature] = segments;
      const header = decodeJson(encodedHeader, LIMITS.headerSegment);
      const claims = decodeJson(encodedClaims, LIMITS.claimsSegment);
      const signature = decodeSegment(encodedSignature, LIMITS.signatureSegment);
      if (!header || Object.getPrototypeOf(header) !== null || header.alg !== 'RS256'
          || !bounded(header.kid, LIMITS.kid) || (header.typ !== undefined && header.typ !== 'JWT')) throw failure();
      const signingInput = `${encodedHeader}.${encodedClaims}`;
      const request = Object.freeze({ signingInput, signature: Buffer.from(signature), alg: 'RS256', kid: header.kid });
      let acknowledgement;
      try { acknowledgement = await Reflect.apply(verify, verifier, [request]); } catch { throw failure(); }
      if (!acknowledgement || typeof acknowledgement !== 'object' || !Object.isSealed(acknowledgement)
          || Object.getPrototypeOf(acknowledgement) !== Object.prototype
          || Reflect.ownKeys(acknowledgement).length !== 1
          || Object.getOwnPropertyDescriptor(acknowledgement, 'verified')?.value !== true) throw failure();

      if (!claims || Object.getPrototypeOf(claims) !== null || !UUID.test(claims.tid)
          || !bounded(claims.oid, 256) || (claims.sub !== undefined && !bounded(claims.sub, 256))
          || typeof claims.aud !== 'string' || !safeEqual(claims.aud, data.expectedClientId)
          || !safeEqual(claims.nonce, data.expectedNonce)
          || claims.iss !== `https://login.microsoftonline.com/${claims.tid}/v2.0`
          || (claims.azp !== undefined && (typeof claims.azp !== 'string' || !safeEqual(claims.azp, data.expectedClientId)))) throw failure();
      const { exp, iat, nbf } = claims; const now = data.nowEpochSeconds;
      if (![exp, iat, nbf].every(Number.isSafeInteger) || exp <= now - SKEW_SECONDS
          || iat > now + SKEW_SECONDS || nbf > now + SKEW_SECONDS || exp <= iat
          || nbf > exp || exp - iat > MAX_LIFETIME_SECONDS) throw failure();
      return Object.freeze({ providerTenantId: claims.tid, providerPrincipalId: claims.oid });
    } catch { throw failure(); }
  }
  return Object.freeze({ validate });
}

module.exports = Object.freeze({ createMicrosoftOidcIdTokenValidator });
