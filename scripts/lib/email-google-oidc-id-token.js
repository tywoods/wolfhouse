'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const { TextDecoder } = require('node:util');

const CODE = 'GOOGLE_OIDC_VERIFIED_IDENTITY_INVALID';
const MESSAGE = 'Google OIDC verified identity validation failed.';
const ISSUER = 'https://accounts.google.com';
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
const LIMITS = Object.freeze({ token: 32768, header: 2048, claims: 24576, signature: 2048, text: 2048 });
const CLAIMS = new Set(['iss', 'aud', 'azp', 'sub', 'email', 'email_verified', 'nonce', 'name', 'exp', 'iat',
  'at_hash', 'hd', 'given_name', 'family_name', 'picture', 'locale']);

function failure() {
  const error = new Error(MESSAGE);
  Object.defineProperty(error, 'name', { value: 'GoogleOidcVerifiedIdentityError' });
  Object.defineProperty(error, 'code', { value: CODE, enumerable: true });
  return Object.freeze(error);
}

function exactFrozenData(value, keys) {
  try {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const out = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
      out[key] = descriptor.value;
    }
    return out;
  } catch { return null; }
}

function unpaired(value) {
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
  const whitespace = () => { while (/[\x20\x09\x0a\x0d]/.test(text[at] || '')) at += 1; };
  function string() {
    const start = at++;
    let escaped = false;
    while (at < text.length) {
      const code = text.charCodeAt(at);
      if (!escaped && code === 34) {
        at += 1;
        let result;
        try { result = JSON.parse(text.slice(start, at)); } catch { bad(); }
        if (result.length > LIMITS.text || unpaired(result)) bad();
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
    whitespace();
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
    at += 1;
    const out = Object.create(null); const names = new Set(); whitespace();
    if (text[at] === '}') { at += 1; return out; }
    for (;;) {
      whitespace(); if (text[at] !== '"') bad(); const key = string();
      if (names.has(key) || DANGEROUS.has(key) || names.size >= 64) bad();
      names.add(key); whitespace(); if (text[at++] !== ':') bad(); out[key] = value(depth); whitespace();
      if (text[at] === '}') { at += 1; return out; }
      if (text[at++] !== ',') bad();
    }
  }
  function array(depth) {
    at += 1; const out = []; whitespace();
    if (text[at] === ']') { at += 1; return out; }
    for (;;) {
      if (out.length >= 64) bad(); out.push(value(depth)); whitespace();
      if (text[at] === ']') { at += 1; return out; }
      if (text[at++] !== ',') bad();
    }
  }
  const result = value(0); whitespace(); if (at !== text.length) bad(); return result;
}

function decode(segment, limit) {
  if (typeof segment !== 'string' || !segment.length || segment.length > limit
      || !/^[A-Za-z0-9_-]+$/.test(segment) || segment.length % 4 === 1) throw failure();
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw failure();
  return bytes;
}
function json(segment, limit) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(decode(segment, limit)); } catch { throw failure(); }
  return parseStrictJson(text);
}
function bounded(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !unpaired(value)
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8'); const b = Buffer.from(right, 'utf8');
  const length = Math.max(a.length, b.length, 1); const aa = Buffer.alloc(length); const bb = Buffer.alloc(length);
  a.copy(aa); b.copy(bb); return timingSafeEqual(aa, bb) && a.length === b.length;
}
function exactKeys(object, allowed) {
  return object && Object.getPrototypeOf(object) === null && Reflect.ownKeys(object).every(key => typeof key === 'string' && allowed.has(key));
}
function validEmail(value) {
  if (!bounded(value, 254) || value.includes('..')) return false;
  const match = /^([^@]+)@([^@]+)$/.exec(value);
  if (!match || Buffer.byteLength(match[1]) > 64) return false;
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(match[1])
    && /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(match[2]);
}
function validAudience(aud, azp, client) {
  if (typeof aud === 'string') return safeEqual(aud, client) && (azp === undefined || safeEqual(azp, client));
  if (!Array.isArray(aud) || aud.length === 0 || new Set(aud).size !== aud.length
      || aud.some(item => typeof item !== 'string') || typeof azp !== 'string' || !safeEqual(azp, client)) return false;
  return aud.some(item => safeEqual(item, client));
}
function validMetadata(claims) {
  if (claims.hd !== undefined && (!bounded(claims.hd, 253) || !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(claims.hd))) return false;
  for (const key of ['given_name', 'family_name']) if (claims[key] !== undefined && !bounded(claims[key], 256)) return false;
  if (claims.locale !== undefined && (!bounded(claims.locale, 35) || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(claims.locale))) return false;
  if (claims.picture !== undefined) {
    if (!bounded(claims.picture, 2048)) return false;
    try { const url = new URL(claims.picture); if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return false; } catch { return false; }
  }
  return true;
}

function createGoogleOidcVerifiedIdentity(dependencies) {
  let verifier; let verifySignature;
  try {
    const deps = exactFrozenData(dependencies, ['signatureVerifier']); verifier = deps && deps.signatureVerifier;
    if (!verifier || Object.getPrototypeOf(verifier) !== Object.prototype || !Object.isFrozen(verifier)
        || Reflect.ownKeys(verifier).length !== 1) throw failure();
    const descriptor = Object.getOwnPropertyDescriptor(verifier, 'verifySignature');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') throw failure();
    verifySignature = descriptor.value;
  } catch { throw failure(); }
  let used = false;
  async function verifyIdentity(input) {
    if (used) throw failure(); used = true;
    try {
      const data = exactFrozenData(input, ['idToken', 'accessToken', 'expectedNonce', 'expectedClientId', 'nowEpochSeconds']);
      if (!data || !bounded(data.idToken, LIMITS.token) || !bounded(data.accessToken, 8192)
          || !bounded(data.expectedNonce, 512) || !bounded(data.expectedClientId, 256)
          || !Number.isSafeInteger(data.nowEpochSeconds) || data.nowEpochSeconds < 0) throw failure();
      const parts = data.idToken.split('.'); if (parts.length !== 3) throw failure();
      const [encodedHeader, encodedClaims, encodedSignature] = parts;
      const header = json(encodedHeader, LIMITS.header); const claims = json(encodedClaims, LIMITS.claims);
      const signature = decode(encodedSignature, LIMITS.signature);
      const headerKeys = new Set(['alg', 'kid', 'typ']);
      if (!exactKeys(header, headerKeys) || header.alg !== 'RS256' || !bounded(header.kid, 256)
          || (header.typ !== undefined && header.typ !== 'JWT')) throw failure();
      const signatureRequest = Object.freeze({ signingInput: `${encodedHeader}.${encodedClaims}`,
        signature: Buffer.from(signature), alg: 'RS256', kid: header.kid });
      let ack;
      try { ack = await Reflect.apply(verifySignature, verifier, [signatureRequest]); } catch { throw failure(); }
      if (!exactFrozenData(ack, ['verified']) || Object.getOwnPropertyDescriptor(ack, 'verified').value !== true) throw failure();
      if (!exactKeys(claims, CLAIMS)) throw failure();
      const now = data.nowEpochSeconds;
      if (!['accounts.google.com', ISSUER].includes(claims.iss) || !validAudience(claims.aud, claims.azp, data.expectedClientId)
          || !safeEqual(claims.nonce, data.expectedNonce) || !bounded(claims.sub, 255) || /^\s|\s$/.test(claims.sub)
          || claims.email_verified !== true || !validEmail(claims.email) || !validMetadata(claims)
          || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat)
          || claims.exp <= now - 300 || claims.iat > now + 300 || claims.exp === claims.iat || claims.exp - claims.iat > 86400) throw failure();
      if (claims.at_hash !== undefined) {
        const hash = decode(claims.at_hash, 22); if (hash.length !== 16) throw failure();
        const expected = createHash('sha256').update(data.accessToken, 'ascii').digest().subarray(0, 16);
        if (!timingSafeEqual(hash, expected)) throw failure();
      }
      const displayName = bounded(claims.name, 256) ? claims.name : null;
      return Object.freeze({ providerTenantId: ISSUER, providerPrincipalId: claims.sub,
        mailboxAddress: claims.email, displayName });
    } catch { throw failure(); }
  }
  return Object.freeze({ verifyIdentity });
}

module.exports = Object.freeze({ createGoogleOidcVerifiedIdentity });
