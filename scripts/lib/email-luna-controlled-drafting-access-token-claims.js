'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4C.
 *
 * Graph access-token claims inspector. Signature authority is the existing
 * Microsoft OIDC JWKS RS256 verifier. Compact JWS split is structural only —
 * unsigned decoded claims are never authority. JWE, alg none, opaque tokens,
 * app-only `roles`, Mail.Send, wrong aud/tid/azp/appid/oid all refuse.
 *
 * Trust boundary (documented, not faked):
 * - Token issuance: canonical TLS Microsoft v2 token endpoint.
 * - Token-response `scope`: TLS-authenticated Microsoft statement.
 * - JWT signature: existing `createMicrosoftOidcJwksSignatureVerifier`.
 * - Claims: read only after `verified === true`.
 *
 * @module email-luna-controlled-drafting-access-token-claims
 */

const { timingSafeEqual } = require('node:crypto');
const { TextDecoder } = require('node:util');
const {
  isProxySurface,
  ownData,
  exactOwnData,
} = require('./email-luna-controlled-drafting-closed-data');
const {
  isCanonicalMicrosoftOidcJwksSignatureVerifier,
} = require('./email-microsoft-oidc-jwks-verifier');

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const objectFreeze = Object.freeze;
const objectCreate = Object.create;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const reflectOwnKeys = Reflect.ownKeys;
const regexpTest = uncurryThis(RegExp.prototype.test);

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_ACCESS_TOKEN_CLAIMS_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting access token claims failed.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SKEW_SECONDS = 300;
const MAX_LIFETIME_SECONDS = 86400;
const LIMITS = objectFreeze({
  token: 16384,
  headerSegment: 2048,
  claimsSegment: 24576,
  signatureSegment: 2048,
  kid: 256,
  text: 2048,
});
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const GRAPH_AUDIENCES = objectFreeze([
  'https://graph.microsoft.com',
  'https://graph.microsoft.com/',
  '00000003-0000-0000-c000-000000000000',
]);
const REQUIRED_SCP = objectFreeze(['User.Read', 'Mail.ReadWrite']);
const SCP_ALLOWED = new Set(REQUIRED_SCP);
const FORBIDDEN_SCP = new Set([
  'Mail.Send',
  'Mail.Send.Shared',
  'Mail.ReadWrite.Shared',
  'Mail.Read.Shared',
  'Mail.Read',
  'Mail.ReadBasic',
  'Mail.ReadWrite.All',
  'Mail.Send.All',
  '/.default',
]);
const INPUT_KEYS = objectFreeze([
  'accessToken',
  'expectedTenantId',
  'expectedClientId',
  'expectedPrincipalOid',
  'nowEpochSeconds',
]);
const INSPECTOR_KEYS = objectFreeze(['inspect']);

function failure() {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  objectFreeze(error);
  return error;
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

function bounded(value, max = LIMITS.text) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && !hasUnpairedSurrogate(value)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  const length = Math.max(a.length, b.length, 1);
  const aa = Buffer.alloc(length);
  const bb = Buffer.alloc(length);
  a.copy(aa);
  b.copy(bb);
  return timingSafeEqual(aa, bb) && a.length === b.length;
}

function uuidEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return safeEqual(left.toLowerCase(), right.toLowerCase())
    && regexpTest(UUID, left.toLowerCase())
    && regexpTest(UUID, right.toLowerCase());
}

function decodeSegment(segment, limit, allowEmpty = false) {
  if (typeof segment !== 'string'
      || segment.length > limit
      || (!allowEmpty && segment.length === 0)
      || !/^[A-Za-z0-9_-]*$/.test(segment)
      || segment.length % 4 === 1) {
    throw failure();
  }
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw failure();
  return bytes;
}

function parseStrictJson(text) {
  let at = 0;
  const bad = () => { throw failure(); };
  const ws = () => { while (/[\x20\x09\x0a\x0d]/.test(text[at] || '')) at += 1; };
  function string() {
    const start = at;
    at += 1;
    let escaped = false;
    while (at < text.length) {
      const code = text.charCodeAt(at);
      if (!escaped && code === 34) {
        at += 1;
        let result;
        try { result = JSON.parse(text.slice(start, at)); } catch (_) { bad(); }
        if (result.length > LIMITS.text || hasUnpairedSurrogate(result)) bad();
        return result;
      }
      if (!escaped && code < 0x20) bad();
      if (!escaped && code === 92) escaped = true;
      else escaped = false;
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
      if (rest.startsWith(literal)) {
        at += literal.length;
        return result;
      }
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
    const out = objectCreate(null);
    const names = new Set();
    ws();
    if (text[at] === '}') {
      at += 1;
      return out;
    }
    for (;;) {
      ws();
      if (text[at] !== '"') bad();
      const key = string();
      if (names.has(key) || DANGEROUS_KEYS.has(key) || names.size >= 64) bad();
      names.add(key);
      ws();
      if (text[at] !== ':') bad();
      at += 1;
      out[key] = value(depth);
      ws();
      if (text[at] === '}') {
        at += 1;
        return out;
      }
      if (text[at] !== ',') bad();
      at += 1;
    }
  }
  function array(depth) {
    at += 1;
    const out = [];
    ws();
    if (text[at] === ']') {
      at += 1;
      return out;
    }
    for (;;) {
      if (out.length >= 64) bad();
      out.push(value(depth));
      ws();
      if (text[at] === ']') {
        at += 1;
        return out;
      }
      if (text[at] !== ',') bad();
      at += 1;
    }
  }
  const result = value(0);
  ws();
  if (at !== text.length) bad();
  return result;
}

function decodeJson(segment, limit) {
  const bytes = decodeSegment(segment, limit);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (_) {
    throw failure();
  }
  return parseStrictJson(text);
}

function parseScp(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) return null;
  if (value !== value.trim() || /[^\S ]/.test(value) || /  /.test(value)) return null;
  const parts = value.split(' ');
  const seen = new Set();
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part || seen.has(part) || FORBIDDEN_SCP.has(part) || !SCP_ALLOWED.has(part)) return null;
    seen.add(part);
  }
  for (let i = 0; i < REQUIRED_SCP.length; i += 1) {
    if (!seen.has(REQUIRED_SCP[i])) return null;
  }
  if (seen.size !== REQUIRED_SCP.length) return null;
  return REQUIRED_SCP.join(' ');
}

function issuerForTid(tid) {
  return objectFreeze([
    `https://login.microsoftonline.com/${tid}/v2.0`,
    `https://sts.windows.net/${tid}/`,
  ]);
}

function audienceOk(aud) {
  if (typeof aud !== 'string') return false;
  for (let i = 0; i < GRAPH_AUDIENCES.length; i += 1) {
    if (safeEqual(aud, GRAPH_AUDIENCES[i])) return true;
  }
  return false;
}

function pinVerifier(dependencies) {
  const parsed = exactOwnData(dependencies, objectFreeze(['signatureVerifier']));
  if (!parsed) throw failure();
  const verifier = parsed.signatureVerifier;
  if (!isCanonicalMicrosoftOidcJwksSignatureVerifier(verifier)) throw failure();
  if (!verifier
      || objectGetPrototypeOf(verifier) !== Object.prototype
      || !Object.isFrozen(verifier)
      || isProxySurface(verifier)
      || reflectOwnKeys(verifier).length !== 1) {
    throw failure();
  }
  const verify = ownData(verifier, 'verify');
  if (typeof verify !== 'function' || isProxySurface(verify)) throw failure();
  return { verifier, verify };
}

function createControlledDraftingAccessTokenClaimsInspector(dependencies) {
  const pinned = pinVerifier(dependencies);
  let used = false;

  async function inspect(input) {
    if (used) throw failure();
    used = true;
    try {
      const data = exactOwnData(input, INPUT_KEYS);
      if (!data
          || !bounded(data.accessToken, LIMITS.token)
          || !uuidEqual(data.expectedTenantId, data.expectedTenantId)
          || !uuidEqual(data.expectedClientId, data.expectedClientId)
          || !uuidEqual(data.expectedPrincipalOid, data.expectedPrincipalOid)
          || !Number.isSafeInteger(data.nowEpochSeconds)
          || data.nowEpochSeconds < 0) {
        throw failure();
      }
      const token = data.accessToken;
      if (token.includes('..') || token.split('.').length === 5) throw failure();
      const segments = token.split('.');
      if (segments.length !== 3) throw failure();
      const [encodedHeader, encodedClaims, encodedSignature] = segments;
      const header = decodeJson(encodedHeader, LIMITS.headerSegment);
      if (!header || objectGetPrototypeOf(header) !== null) throw failure();
      if (header.alg !== 'RS256'
          || !bounded(header.kid, LIMITS.kid)
          || header.crit !== undefined
          || (header.typ !== undefined && header.typ !== 'JWT')) {
        throw failure();
      }
      const signature = decodeSegment(encodedSignature, LIMITS.signatureSegment);
      const signingInput = `${encodedHeader}.${encodedClaims}`;
      const request = objectFreeze({
        signingInput,
        signature: Buffer.from(signature),
        alg: 'RS256',
        kid: header.kid,
      });
      let acknowledgement;
      try {
        acknowledgement = await Reflect.apply(pinned.verify, pinned.verifier, [request]);
      } catch (_) {
        throw failure();
      }
      if (!acknowledgement
          || typeof acknowledgement !== 'object'
          || !Object.isSealed(acknowledgement)
          || objectGetPrototypeOf(acknowledgement) !== Object.prototype
          || reflectOwnKeys(acknowledgement).length !== 1
          || ownData(acknowledgement, 'verified') !== true) {
        throw failure();
      }

      const claims = decodeJson(encodedClaims, LIMITS.claimsSegment);
      if (!claims || objectGetPrototypeOf(claims) !== null) throw failure();
      if (objectHasOwn(claims, 'roles')) throw failure();
      if (!audienceOk(claims.aud)) throw failure();
      const tid = typeof claims.tid === 'string' ? claims.tid.toLowerCase() : '';
      if (!uuidEqual(tid, data.expectedTenantId)) throw failure();
      const issuers = issuerForTid(tid);
      let issOk = false;
      for (let i = 0; i < issuers.length; i += 1) {
        if (safeEqual(claims.iss, issuers[i])) issOk = true;
      }
      if (!issOk) throw failure();
      const oid = typeof claims.oid === 'string' ? claims.oid.toLowerCase() : '';
      if (!uuidEqual(oid, data.expectedPrincipalOid)) throw failure();
      const azp = claims.azp;
      const appid = claims.appid;
      const client = data.expectedClientId.toLowerCase();
      const azpOk = typeof azp === 'string' && uuidEqual(azp, client);
      const appidOk = typeof appid === 'string' && uuidEqual(appid, client);
      if (!azpOk && !appidOk) throw failure();
      const scp = parseScp(claims.scp);
      if (!scp) throw failure();
      const { exp, iat, nbf } = claims;
      const now = data.nowEpochSeconds;
      if (![exp, iat].every(Number.isSafeInteger)) throw failure();
      const nbfValue = nbf === undefined ? iat : nbf;
      if (!Number.isSafeInteger(nbfValue)) throw failure();
      if (exp <= now - SKEW_SECONDS
          || iat > now + SKEW_SECONDS
          || nbfValue > now + SKEW_SECONDS
          || exp <= iat
          || nbfValue > exp
          || exp - iat > MAX_LIFETIME_SECONDS) {
        throw failure();
      }
      return objectFreeze({
        ok: true,
        scope_profile_id: 'controlled_drafting_v1',
        scp,
        mail_send: false,
        mail_readwrite: true,
        app_only: false,
      });
    } catch (_) {
      throw failure();
    }
  }

  return objectFreeze({ inspect });
}

module.exports = objectFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  INPUT_KEYS,
  INSPECTOR_KEYS,
  GRAPH_AUDIENCES,
  REQUIRED_SCP,
  createControlledDraftingAccessTokenClaimsInspector,
});
