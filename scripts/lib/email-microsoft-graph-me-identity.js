'use strict';

const https = require('https');

const HOST = 'graph.microsoft.com';
const PATH = '/v1.0/me?$select=id,displayName,mail,userPrincipalName';
const DEADLINE_MS = 5000;
const RESPONSE_CAP_BYTES = 32768;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ERROR_MESSAGES = Object.freeze({
  INPUT_INVALID: 'Microsoft Graph identity input is invalid.',
  REQUEST_FAILED: 'Microsoft Graph identity request failed.',
  DEADLINE_EXCEEDED: 'Microsoft Graph identity request timed out.',
  RESPONSE_TOO_LARGE: 'Microsoft Graph identity response was too large.',
  HTTP_ERROR: 'Microsoft Graph identity request was rejected.',
  RESPONSE_INVALID: 'Microsoft Graph identity response was invalid.',
  IDENTITY_INVALID: 'Microsoft Graph identity was invalid.',
});

function failure(code) {
  const error = new Error(ERROR_MESSAGES[code]);
  Object.defineProperty(error, 'name', { value: 'MicrosoftGraphIdentityError' });
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  return Object.freeze(error);
}

function ownData(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? descriptor.value : undefined;
}

function validInput(input) {
  if (input === null || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) return false;
  if (Reflect.ownKeys(input).length !== 1 || !Object.prototype.hasOwnProperty.call(input, 'accessToken')) return false;
  const token = ownData(input, 'accessToken');
  return typeof token === 'string' && token.length >= 1 && token.length <= 16384
    && /^[\x21-\x7e]+$/.test(token);
}

// Strict JSON parser: duplicate names are rejected instead of silently overwritten.
function parseStrictJson(text) {
  let at = 0;
  const fail = () => { throw failure('RESPONSE_INVALID'); };
  const ws = () => { while (at < text.length && /[\x20\x09\x0a\x0d]/.test(text[at])) at += 1; };
  function value(depth) {
    if (depth > 8) fail();
    ws();
    if (text[at] === '{') return object(depth + 1);
    if (text[at] === '[') return array(depth + 1);
    if (text[at] === '"') return string();
    const rest = text.slice(at);
    if (rest.startsWith('true')) { at += 4; return true; }
    if (rest.startsWith('false')) { at += 5; return false; }
    if (rest.startsWith('null')) { at += 4; return null; }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (!match) fail();
    at += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) fail();
    return number;
  }
  function string() {
    const start = at;
    at += 1;
    let escaped = false;
    while (at < text.length) {
      const code = text.charCodeAt(at);
      if (!escaped && code === 34) {
        at += 1;
        let result;
        try { result = JSON.parse(text.slice(start, at)); } catch { fail(); }
        if (result.length > 2048) fail();
        return result;
      }
      if (!escaped && code < 0x20) fail();
      if (!escaped && code === 92) escaped = true;
      else escaped = false;
      at += 1;
    }
    fail();
  }
  function object(depth) {
    at += 1;
    const result = Object.create(null);
    const names = new Set();
    ws();
    if (text[at] === '}') { at += 1; return result; }
    for (;;) {
      ws();
      if (text[at] !== '"') fail();
      const key = string();
      if (names.has(key) || DANGEROUS_KEYS.has(key) || names.size >= 64) fail();
      names.add(key);
      ws();
      if (text[at] !== ':') fail();
      at += 1;
      result[key] = value(depth);
      ws();
      if (text[at] === '}') { at += 1; return result; }
      if (text[at] !== ',') fail();
      at += 1;
    }
  }
  function array(depth) {
    at += 1;
    const result = [];
    ws();
    if (text[at] === ']') { at += 1; return result; }
    for (;;) {
      if (result.length >= 64) fail();
      result.push(value(depth));
      ws();
      if (text[at] === ']') { at += 1; return result; }
      if (text[at] !== ',') fail();
      at += 1;
    }
  }
  const result = value(0);
  ws();
  if (at !== text.length) fail();
  return result;
}

function boundedString(value, min, max) {
  return typeof value === 'string' && value.length >= min && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeMailbox(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!boundedString(value, 3, 254) || value !== value.trim()) return false;
  const normalized = value.toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) return false;
  if (normalized.includes('..')) return false;
  return normalized;
}

function selectIdentity(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== null) {
    throw failure('RESPONSE_INVALID');
  }
  const id = parsed.id;
  const displayName = parsed.displayName;
  if (!boundedString(id, 1, 256) || !boundedString(displayName, 1, 256)) throw failure('IDENTITY_INVALID');
  const mail = normalizeMailbox(parsed.mail);
  const upn = normalizeMailbox(parsed.userPrincipalName);
  if (mail === false || upn === false || (!mail && !upn) || (mail && upn && mail !== upn)) {
    throw failure('IDENTITY_INVALID');
  }
  return Object.freeze({ id, displayName, mailbox: mail || upn });
}

function createMicrosoftGraphMeIdentityTransport(testDependencies) {
  const requestImpl = testDependencies && testDependencies.requestImpl;
  if (testDependencies !== undefined && (Object.keys(testDependencies).length !== 1 || typeof requestImpl !== 'function')) {
    throw failure('INPUT_INVALID');
  }
  const request = requestImpl || https.request;

  return function fetchMicrosoftGraphMeIdentity(input) {
    let accepted = false;
    try { accepted = validInput(input); } catch { accepted = false; }
    if (!accepted) return Promise.reject(failure('INPUT_INVALID'));
    const accessToken = ownData(input, 'accessToken');
    return new Promise((resolve, reject) => {
      let settled = false;
      let req;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) reject(error); else resolve(result);
      };
      const deadline = setTimeout(() => {
        if (req && typeof req.destroy === 'function') req.destroy();
        finish(failure('DEADLINE_EXCEEDED'));
      }, DEADLINE_MS);
      try {
        req = request({
          protocol: 'https:', hostname: HOST, host: HOST, port: 443,
          method: 'GET', path: PATH, agent: false,
          headers: Object.freeze({ Accept: 'application/json', Authorization: 'Bearer ' + accessToken }),
        }, (response) => {
          const status = response.statusCode;
          const responseHeaders = response.headers;
          const contentType = responseHeaders && typeof responseHeaders === 'object'
            ? ownData(responseHeaders, 'content-type') : undefined;
          const contentLength = responseHeaders && typeof responseHeaders === 'object'
            ? ownData(responseHeaders, 'content-length') : undefined;
          if (!Number.isInteger(status) || status < 200 || status > 299) {
            if (typeof response.destroy === 'function') response.destroy();
            finish(failure('HTTP_ERROR'));
            return;
          }
          if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)
              || (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > RESPONSE_CAP_BYTES))) {
            if (typeof response.destroy === 'function') response.destroy();
            finish(contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > RESPONSE_CAP_BYTES
              ? failure('RESPONSE_TOO_LARGE') : failure('RESPONSE_INVALID'));
            return;
          }
          const chunks = [];
          let bytes = 0;
          response.on('data', (chunk) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > RESPONSE_CAP_BYTES) {
              if (typeof response.destroy === 'function') response.destroy();
              if (req && typeof req.destroy === 'function') req.destroy();
              finish(failure('RESPONSE_TOO_LARGE'));
            } else chunks.push(buffer);
          });
          response.once('error', () => finish(failure('REQUEST_FAILED')));
          response.once('end', () => {
            if (settled) return;
            try { finish(null, selectIdentity(parseStrictJson(Buffer.concat(chunks).toString('utf8')))); }
            catch (error) { finish(error && ERROR_MESSAGES[error.code] ? error : failure('RESPONSE_INVALID')); }
          });
        });
        req.once('error', () => finish(failure('REQUEST_FAILED')));
        req.end();
      } catch {
        if (req && typeof req.destroy === 'function') req.destroy();
        finish(failure('REQUEST_FAILED'));
      }
    });
  };
}

const fetchMicrosoftGraphMeIdentity = createMicrosoftGraphMeIdentityTransport();

module.exports = Object.freeze({
  createMicrosoftGraphMeIdentityTransport,
  fetchMicrosoftGraphMeIdentity,
});
