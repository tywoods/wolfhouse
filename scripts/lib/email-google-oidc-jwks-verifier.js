'use strict';

const { TextDecoder } = require('util');

const ERROR_CODE = 'GOOGLE_OIDC_JWKS_VERIFICATION_FAILED';
const ERROR_MESSAGE = 'Google OIDC signature verification failed.';
const REQUEST_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 65536;
const MAX_JSON_VALUES = 256;
const MAX_COLLECTION_ENTRIES = 64;
const MAX_JSON_DEPTH = 10;
const MAX_JSON_STRING_LENGTH = 8192;
const MAX_KEYS = 64;
const DANGEROUS_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

const REQUEST_OPTIONS = Object.freeze({
  protocol: 'https:',
  hostname: 'www.googleapis.com',
  port: 443,
  method: 'GET',
  path: '/oauth2/v3/certs',
  headers: Object.freeze({ Accept: 'application/json' }),
  agent: false,
});

function verificationFailure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', {
    value: 'GoogleOidcJwksVerificationError',
  });
  Object.defineProperty(error, 'code', {
    value: ERROR_CODE,
    enumerable: true,
  });
  return Object.freeze(error);
}

function readExactFrozenRecord(value, names) {
  try {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key))) {
      return null;
    }
    const result = Object.create(null);
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable
          || descriptor.writable || descriptor.configurable) {
        return null;
      }
      result[name] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function readDependencies(dependencies) {
  const record = readExactFrozenRecord(dependencies, ['https', 'crypto', 'timers']);
  if (!record) {
    throw verificationFailure();
  }

  const httpsOwner = record.https;
  const cryptoOwner = record.crypto;
  const timersOwner = record.timers;
  const httpsRecord = readExactFrozenRecord(httpsOwner, ['request']);
  const cryptoRecord = readExactFrozenRecord(cryptoOwner, ['createPublicKey', 'verify']);
  const timersRecord = readExactFrozenRecord(timersOwner, ['setTimeout', 'clearTimeout']);
  if (!httpsRecord || !cryptoRecord || !timersRecord
      || typeof httpsRecord.request !== 'function'
      || typeof cryptoRecord.createPublicKey !== 'function'
      || typeof cryptoRecord.verify !== 'function'
      || typeof timersRecord.setTimeout !== 'function'
      || typeof timersRecord.clearTimeout !== 'function') {
    throw verificationFailure();
  }
  return {
    https: Object.freeze({ owner: httpsOwner, request: httpsRecord.request }),
    crypto: Object.freeze({ owner: cryptoOwner, createPublicKey: cryptoRecord.createPublicKey, verify: cryptoRecord.verify }),
    timers: Object.freeze({ owner: timersOwner, setTimeout: timersRecord.setTimeout, clearTimeout: timersRecord.clearTimeout }),
  };
}

function readVerificationInput(input) {
  const record = readExactFrozenRecord(input, ['signingInput', 'signature', 'alg', 'kid']);
  if (!record
      || typeof record.signingInput !== 'string'
      || record.signingInput.length === 0
      || record.signingInput.length > 32768
      || !Buffer.isBuffer(record.signature)
      || record.signature.length === 0
      || record.signature.length > 2048
      || record.alg !== 'RS256'
      || typeof record.kid !== 'string'
      || record.kid.length === 0
      || record.kid.length > 256
      || hasUnpairedSurrogate(record.kid)) {
    throw verificationFailure();
  }
  return record;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function parseStrictJson(text) {
  let position = 0;
  let valueCount = 0;

  function rejectJson() {
    throw verificationFailure();
  }

  function skipWhitespace() {
    while (/^[\x20\x09\x0a\x0d]$/.test(text[position] || '')) {
      position += 1;
    }
  }

  function parseString() {
    const start = position;
    position += 1;
    let escaped = false;
    while (position < text.length) {
      const code = text.charCodeAt(position);
      if (!escaped && code === 0x22) {
        position += 1;
        let result;
        try {
          result = JSON.parse(text.slice(start, position));
        } catch {
          rejectJson();
        }
        if (result.length > MAX_JSON_STRING_LENGTH || hasUnpairedSurrogate(result)) {
          rejectJson();
        }
        return result;
      }
      if (!escaped && code < 0x20) {
        rejectJson();
      }
      escaped = !escaped && code === 0x5c;
      position += 1;
    }
    rejectJson();
  }

  function parseValue(depth) {
    valueCount += 1;
    if (depth > MAX_JSON_DEPTH || valueCount > MAX_JSON_VALUES) {
      rejectJson();
    }
    skipWhitespace();
    if (text[position] === '{') {
      return parseObject(depth + 1);
    }
    if (text[position] === '[') {
      return parseArray(depth + 1);
    }
    if (text[position] === '"') {
      return parseString();
    }
    const remainder = text.slice(position);
    const literals = [['true', true], ['false', false], ['null', null]];
    for (const [literal, value] of literals) {
      if (remainder.startsWith(literal)) {
        position += literal.length;
        return value;
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remainder);
    if (!match) {
      rejectJson();
    }
    position += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) {
      rejectJson();
    }
    return number;
  }

  function parseObject(depth) {
    position += 1;
    const result = Object.create(null);
    const names = new Set();
    skipWhitespace();
    if (text[position] === '}') {
      position += 1;
      return result;
    }
    for (;;) {
      skipWhitespace();
      if (text[position] !== '"' || names.size >= MAX_COLLECTION_ENTRIES) {
        rejectJson();
      }
      const name = parseString();
      if (names.has(name) || DANGEROUS_NAMES.has(name)) {
        rejectJson();
      }
      names.add(name);
      skipWhitespace();
      if (text[position] !== ':') {
        rejectJson();
      }
      position += 1;
      result[name] = parseValue(depth);
      skipWhitespace();
      if (text[position] === '}') {
        position += 1;
        return result;
      }
      if (text[position] !== ',') {
        rejectJson();
      }
      position += 1;
    }
  }

  function parseArray(depth) {
    position += 1;
    const result = [];
    skipWhitespace();
    if (text[position] === ']') {
      position += 1;
      return result;
    }
    for (;;) {
      if (result.length >= MAX_COLLECTION_ENTRIES) {
        rejectJson();
      }
      result.push(parseValue(depth));
      skipWhitespace();
      if (text[position] === ']') {
        position += 1;
        return result;
      }
      if (text[position] !== ',') {
        rejectJson();
      }
      position += 1;
    }
  }

  const result = parseValue(0);
  skipWhitespace();
  if (position !== text.length) {
    rejectJson();
  }
  return result;
}

function decodeCanonicalBase64Url(value, minimumBytes, maximumBytes) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192
      || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw verificationFailure();
  }
  let bytes;
  try {
    bytes = Buffer.from(value, 'base64url');
  } catch {
    throw verificationFailure();
  }
  if (bytes.length < minimumBytes || bytes.length > maximumBytes
      || bytes.toString('base64url') !== value || bytes[0] === 0) {
    throw verificationFailure();
  }
  return bytes;
}

function validateRsaParameters(modulus, exponent) {
  const modulusBytes = decodeCanonicalBase64Url(modulus, 256, 1024);
  const exponentBytes = decodeCanonicalBase64Url(exponent, 1, 4);
  if ((modulusBytes.length === 256 && modulusBytes[0] < 0x80)
      || (modulusBytes[modulusBytes.length - 1] & 1) === 0) {
    throw verificationFailure();
  }
  let exponentValue = 0n;
  for (const byte of exponentBytes) {
    exponentValue = (exponentValue << 8n) | BigInt(byte);
  }
  if (exponentValue < 3n || exponentValue > 0xffffffffn || (exponentValue & 1n) === 0n) {
    throw verificationFailure();
  }
}

function selectJwk(body, expectedKid) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw verificationFailure();
  }
  const document = parseStrictJson(text);
  if (!document || Object.getPrototypeOf(document) !== null
      || !Array.isArray(document.keys)
      || document.keys.length === 0
      || document.keys.length > MAX_KEYS) {
    throw verificationFailure();
  }
  const matches = document.keys.filter((key) => key
    && Object.getPrototypeOf(key) === null
    && key.kid === expectedKid);
  if (matches.length !== 1) {
    throw verificationFailure();
  }
  const selected = matches[0];
  if (selected.kty !== 'RSA'
      || selected.use !== 'sig'
      || selected.alg !== 'RS256') {
    throw verificationFailure();
  }
  validateRsaParameters(selected.n, selected.e);
  return Object.freeze({
    kty: 'RSA',
    n: selected.n,
    e: selected.e,
    alg: 'RS256',
    use: 'sig',
    kid: expectedKid,
  });
}

function safelyDestroy(stream) {
  try {
    if (stream && typeof stream.destroy === 'function') {
      Reflect.apply(stream.destroy, stream, []);
    }
  } catch {
    // Destruction is best-effort after the operation has already failed.
  }
}

function readHeader(response, name) {
  const headers = response.headers;
  if (!headers || (typeof headers !== 'object' && typeof headers !== 'function')) {
    return undefined;
  }
  return headers[name];
}

function fetchJwks(https, timers) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let response;
    let timerHandle;
    let timerAcquired = false;
    let timerCleared = false;
    let responseEnded = false;

    function clearAcquiredTimer() {
      if (!timerAcquired || timerCleared) {
        return;
      }
      timerCleared = true;
      try {
        Reflect.apply(timers.clearTimeout, timers.owner, [timerHandle]);
      } catch {
        // Settlement remains deterministic even when timer cleanup is hostile.
      }
    }

    function settleFailure() {
      if (settled) {
        return;
      }
      settled = true;
      clearAcquiredTimer();
      safelyDestroy(request);
      safelyDestroy(response);
      reject(verificationFailure());
    }

    function settleSuccess(body) {
      if (settled) {
        return;
      }
      settled = true;
      clearAcquiredTimer();
      resolve(body);
    }

    function onDeadline() {
      settleFailure();
    }

    try {
      timerHandle = Reflect.apply(timers.setTimeout, timers.owner, [onDeadline, REQUEST_TIMEOUT_MS]);
      timerAcquired = true;
      if (settled) {
        clearAcquiredTimer();
        return;
      }
    } catch {
      settleFailure();
      return;
    }

    function onResponse(incoming) {
      if (settled) {
        safelyDestroy(incoming);
        return;
      }
      response = incoming;
      const chunks = [];
      let size = 0;
      let declaredLength;

      try {
        if (!incoming || typeof incoming.on !== 'function' || typeof incoming.destroy !== 'function'
            || incoming.statusCode !== 200) {
          settleFailure();
          return;
        }
        const contentType = readHeader(incoming, 'content-type');
        if (typeof contentType !== 'string' || !CONTENT_TYPE.test(contentType)) {
          settleFailure();
          return;
        }
        const contentLength = readHeader(incoming, 'content-length');
        if (contentLength !== undefined) {
          if (typeof contentLength !== 'string' || !/^(?:0|[1-9]\d*)$/.test(contentLength)) {
            settleFailure();
            return;
          }
          declaredLength = Number(contentLength);
          if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_BODY_BYTES) {
            settleFailure();
            return;
          }
        }

        incoming.on('data', function onData(chunk) {
          if (settled) {
            return;
          }
          if (!Buffer.isBuffer(chunk) || chunk.length > MAX_BODY_BYTES - size) {
            settleFailure();
            return;
          }
          size += chunk.length;
          chunks.push(chunk);
        });
        incoming.on('end', function onEnd() {
          if (settled) {
            return;
          }
          responseEnded = true;
          if (declaredLength !== undefined && declaredLength !== size) {
            settleFailure();
            return;
          }
          settleSuccess(Buffer.concat(chunks, size));
        });
        incoming.on('aborted', settleFailure);
        incoming.on('error', settleFailure);
        incoming.on('timeout', settleFailure);
        incoming.on('close', function onResponseClose() {
          if (!responseEnded) {
            settleFailure();
          }
        });
      } catch {
        settleFailure();
      }
    }

    try {
      const acquiredRequest = Reflect.apply(https.request, https.owner, [REQUEST_OPTIONS, onResponse]);
      request = acquiredRequest;
      if (settled) {
        safelyDestroy(acquiredRequest);
        return;
      }
      if (!acquiredRequest
          || typeof acquiredRequest.on !== 'function'
          || typeof acquiredRequest.end !== 'function'
          || typeof acquiredRequest.destroy !== 'function') {
        settleFailure();
        return;
      }
      acquiredRequest.on('error', settleFailure);
      acquiredRequest.on('abort', settleFailure);
      acquiredRequest.on('timeout', settleFailure);
      acquiredRequest.on('close', function onRequestClose() {
        if (!response && !settled) {
          settleFailure();
        }
      });
      if (!settled) {
        Reflect.apply(acquiredRequest.end, acquiredRequest, []);
      }
    } catch {
      settleFailure();
    }
  });
}

function createGoogleOidcJwksVerifier(dependencies) {
  const { https, crypto, timers } = readDependencies(dependencies);
  let used = false;

  async function verifySignature(input) {
    if (used) {
      throw verificationFailure();
    }
    used = true;

    try {
      const record = readVerificationInput(input);
      const signingBytes = Buffer.from(record.signingInput, 'utf8');
      const signature = Buffer.from(record.signature);
      const body = await fetchJwks(https, timers);
      const jwk = selectJwk(body, record.kid);
      const key = Reflect.apply(crypto.createPublicKey, crypto.owner, [{ key: jwk, format: 'jwk' }]);
      const verified = Reflect.apply(crypto.verify, crypto.owner, [
        'RSA-SHA256',
        signingBytes,
        key,
        signature,
      ]);
      if (verified !== true) {
        throw verificationFailure();
      }
      return Object.freeze({ verified: true });
    } catch {
      throw verificationFailure();
    }
  }

  return Object.freeze({ verifySignature });
}

module.exports = Object.freeze({ createGoogleOidcJwksVerifier });
