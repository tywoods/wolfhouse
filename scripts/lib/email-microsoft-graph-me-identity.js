'use strict';

const http = require('http');
const https = require('https');
const {
  pinEmailOAuthStageTelemetry,
  createNoopEmailOAuthStageTelemetry,
  safeEmitStage,
} = require('./email-microsoft-oauth-stage-telemetry');

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
// Optional stageTelemetry is an allowed extra only — core bag keys unchanged.
const DEPENDENCY_KEYS = Object.freeze(['httpsImpl', 'timers', 'stageTelemetry']);

// Module-init pin: real Node http.IncomingMessage defines `headers` as a native
// prototype getter (not own data). readOwnData(response, 'headers') always yields
// undefined on production responses while EventEmitter own-data mocks pass.
// Pin the exact constructor, prototype, and headers getter once; only Reflect.apply
// that pinned getter for genuine IncomingMessage instances. Ambient rebinds of
// http.IncomingMessage / custom prototype getters are never trusted.
const PINNED_INCOMING_MESSAGE = http.IncomingMessage;
const PINNED_INCOMING_MESSAGE_PROTOTYPE = http.IncomingMessage
  && http.IncomingMessage.prototype
  ? http.IncomingMessage.prototype
  : null;
const PINNED_HEADERS_DESCRIPTOR = PINNED_INCOMING_MESSAGE_PROTOTYPE
  ? Object.getOwnPropertyDescriptor(PINNED_INCOMING_MESSAGE_PROTOTYPE, 'headers')
  : null;
const PINNED_HEADERS_GET = PINNED_HEADERS_DESCRIPTOR
  && typeof PINNED_HEADERS_DESCRIPTOR.get === 'function'
  && !Object.prototype.hasOwnProperty.call(PINNED_HEADERS_DESCRIPTOR, 'value')
  ? PINNED_HEADERS_DESCRIPTOR.get
  : null;

function failure(code) {
  const error = new Error(ERROR_MESSAGES[code]);
  Object.defineProperty(error, 'name', { value: 'MicrosoftGraphIdentityError' });
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  return Object.freeze(error);
}

function inspectPlainDataObject(value, allowed, required = allowed) {
  try {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) return null;
    if (required.some((key) => !keys.includes(key))) return null;
    const result = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function readOwnData(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True only for exact native IncomingMessage instances whose live headers getter
 * is still the module-init pin. Subclasses, foreign prototypes, and ambient
 * redefinitions are rejected.
 */
function isPinnedIncomingMessage(response) {
  try {
    if (!PINNED_HEADERS_GET || !PINNED_INCOMING_MESSAGE || !PINNED_INCOMING_MESSAGE_PROTOTYPE) {
      return false;
    }
    if (response === null || typeof response !== 'object') return false;
    if (Object.getPrototypeOf(response) !== PINNED_INCOMING_MESSAGE_PROTOTYPE) return false;
    if (response.constructor !== PINNED_INCOMING_MESSAGE) return false;
    const live = Object.getOwnPropertyDescriptor(PINNED_INCOMING_MESSAGE_PROTOTYPE, 'headers');
    if (!live || live.get !== PINNED_HEADERS_GET) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Secure response headers access:
 * 1) Genuine pinned IncomingMessage → Reflect.apply only the module-init native getter.
 * 2) Own-data plain/mock path (EventEmitter unit tests) → readOwnData only.
 * Never walks attacker/custom prototype getters.
 */
function readResponseHeaders(response) {
  try {
    if (isPinnedIncomingMessage(response)) {
      const headers = Reflect.apply(PINNED_HEADERS_GET, response, []);
      if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
        return undefined;
      }
      return headers;
    }
    return readOwnData(response, 'headers');
  } catch {
    return undefined;
  }
}

function readInput(input) {
  const inspected = inspectPlainDataObject(input, ['accessToken']);
  if (!inspected) return null;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(input, 'accessToken'); } catch { return null; }
  const token = inspected.accessToken;
  if (!descriptor.enumerable || typeof token !== 'string' || token.length < 1 || token.length > 16384
      || !/^[\x21-\x7e]+$/.test(token)) return null;
  return token;
}

// Strict JSON parser: duplicate, escaped-dangerous, nested-dangerous names, and lone surrogates are rejected.
function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

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
        if (result.length > 2048 || hasUnpairedSurrogate(result)) fail();
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

function boundedText(value, min, max) {
  return typeof value === 'string' && value.length >= min && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeMailbox(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!boundedText(value, 3, 254) || value !== value.trim()) return false;
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
  const rawDisplayName = parsed.displayName;
  if (!boundedText(id, 1, 256)) throw failure('IDENTITY_INVALID');
  let displayName = null;
  if (rawDisplayName !== null && rawDisplayName !== undefined && rawDisplayName !== '') {
    if (!boundedText(rawDisplayName, 1, 256)) throw failure('IDENTITY_INVALID');
    displayName = rawDisplayName;
  }
  // Microsoft Graph /me may return distinct valid mail and userPrincipalName
  // (GoDaddy/M365 aliases, primary SMTP vs login UPN). Validate each present
  // nonempty field independently; prefer canonical mail when present, else UPN.
  // Do not require equality. Malformed present fields fail closed (no skip).
  const mail = normalizeMailbox(parsed.mail);
  const upn = normalizeMailbox(parsed.userPrincipalName);
  if (mail === false || upn === false || (!mail && !upn)) throw failure('IDENTITY_INVALID');
  return Object.freeze({ providerSubjectId: id, mailboxAddress: mail || upn, displayName });
}

/**
 * Optional stageTelemetry on the Graph factory dependency bag.
 * Absent → noop (standalone factory remains usable without telemetry).
 * Present but unpinned/hostile → fail closed (INPUT_INVALID). Never ambient.
 * @param {object|null} deps
 * @returns {{ emit: Function }|null}
 */
function resolveGraphStageTelemetry(deps) {
  try {
    if (!deps) return createNoopEmailOAuthStageTelemetry();
    const raw = Object.prototype.hasOwnProperty.call(deps, 'stageTelemetry')
      ? deps.stageTelemetry
      : undefined;
    if (raw === undefined) return createNoopEmailOAuthStageTelemetry();
    const pinned = pinEmailOAuthStageTelemetry(raw);
    return pinned || null;
  } catch {
    return null;
  }
}

function createMicrosoftGraphMeIdentityTransport(dependencies = {}) {
  const deps = inspectPlainDataObject(dependencies, DEPENDENCY_KEYS, []);
  if (!deps) throw failure('INPUT_INVALID');
  const stageTelemetry = resolveGraphStageTelemetry(deps);
  if (!stageTelemetry) throw failure('INPUT_INVALID');
  const request = deps.httpsImpl === undefined ? https.request : deps.httpsImpl;
  if (typeof request !== 'function') throw failure('INPUT_INVALID');
  let setTimer = setTimeout;
  let clearTimer = clearTimeout;
  if (deps.timers !== undefined) {
    const timerDeps = inspectPlainDataObject(deps.timers, ['setTimeout', 'clearTimeout']);
    if (!timerDeps || typeof timerDeps.setTimeout !== 'function' || typeof timerDeps.clearTimeout !== 'function') {
      throw failure('INPUT_INVALID');
    }
    setTimer = timerDeps.setTimeout;
    clearTimer = timerDeps.clearTimeout;
  }

  let used = false;
  function fetchIdentity(input) {
    if (used) return Promise.reject(failure('INPUT_INVALID'));
    used = true; // Burn atomically before input inspection, Promise construction, timers, or I/O.
    const accessToken = readInput(input);
    if (accessToken === null) return Promise.reject(failure('INPUT_INVALID'));

    return new Promise((resolve, reject) => {
      let settled = false;
      let requestObject;
      let activeResponse;
      let requestDestroyed = false;
      let responseDestroyed = false;
      let timerHandle;
      let timerAcquired = false;
      let timerCleared = false;

      const clearDeadline = () => {
        if (!timerAcquired || timerCleared) return;
        timerCleared = true;
        try { clearTimer(timerHandle); } catch { /* settlement must remain stable */ }
      };
      const destroyRequest = () => {
        if (requestDestroyed || !requestObject) return;
        requestDestroyed = true;
        try { if (typeof requestObject.destroy === 'function') requestObject.destroy(); } catch { /* masked */ }
      };
      const destroyResponse = () => {
        if (responseDestroyed || !activeResponse) return;
        responseDestroyed = true;
        try { if (typeof activeResponse.destroy === 'function') activeResponse.destroy(); } catch { /* masked */ }
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearDeadline();
        if (error) reject(error); else resolve(result);
      };
      const terminate = (error) => {
        destroyResponse();
        destroyRequest();
        finish(error);
      };

      try {
        timerHandle = setTimer(() => terminate(failure('DEADLINE_EXCEEDED')), DEADLINE_MS);
        timerAcquired = true;
        if (settled) clearDeadline();
      } catch {
        finish(failure('REQUEST_FAILED'));
      }
      if (settled) return;

      try {
        // Milestone: immediately before the actual HTTPS /me request.
        safeEmitStage(stageTelemetry, 'graph_request_started');
        requestObject = request(Object.freeze({
          protocol: 'https:', hostname: HOST, host: HOST, port: 443,
          method: 'GET', path: PATH, agent: false,
          headers: Object.freeze({ Accept: 'application/json', Authorization: ['Bearer', accessToken].join(' ') }),
        }), (response) => {
          // Milestone: HTTPS response callback fired (status/body not yet trusted).
          safeEmitStage(stageTelemetry, 'graph_response_received');
          if (settled) {
            activeResponse = response;
            destroyResponse();
            return;
          }
          activeResponse = response;
          try {
            const status = readOwnData(response, 'statusCode');
            // Native IncomingMessage: headers via pinned prototype getter only.
            // Own-data plain mocks: readOwnData. Never custom prototype getters.
            const headers = readResponseHeaders(response);
            const contentType = headers && typeof headers === 'object' ? readOwnData(headers, 'content-type') : undefined;
            const contentLength = headers && typeof headers === 'object' ? readOwnData(headers, 'content-length') : undefined;
            if (status !== 200) { terminate(failure('HTTP_ERROR')); return; }
            // Milestone: exact HTTP 200 only (no status/body logged).
            safeEmitStage(stageTelemetry, 'graph_http_accepted');
            // content-type / content-length must be single own-data strings (reject
            // arrays, comma-joined duplicates, and non-digit lengths).
            if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
              terminate(failure('RESPONSE_INVALID')); return;
            }
            if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > RESPONSE_CAP_BYTES)) {
              terminate(contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > RESPONSE_CAP_BYTES
                ? failure('RESPONSE_TOO_LARGE') : failure('RESPONSE_INVALID'));
              return;
            }
            // Milestone: content-type + content-length checks passed (values not logged).
            safeEmitStage(stageTelemetry, 'graph_headers_accepted');
            if (typeof response.on !== 'function' || typeof response.once !== 'function') {
              terminate(failure('REQUEST_FAILED')); return;
            }
            const chunks = [];
            let bytes = 0;
            let ended = false;
            response.on('data', (chunk) => {
              if (settled) return;
              if (!Buffer.isBuffer(chunk)) { terminate(failure('RESPONSE_INVALID')); return; }
              if (chunk.length > RESPONSE_CAP_BYTES - bytes) { terminate(failure('RESPONSE_TOO_LARGE')); return; }
              bytes += chunk.length;
              chunks.push(chunk);
            });
            response.once('error', () => terminate(failure('REQUEST_FAILED')));
            response.once('aborted', () => terminate(failure('REQUEST_FAILED')));
            response.once('close', () => { if (!ended) terminate(failure('REQUEST_FAILED')); });
            response.once('end', () => {
              if (settled) return;
              ended = true;
              try {
                // Milestone: bounded stream ended; body collected, not yet parsed.
                safeEmitStage(stageTelemetry, 'graph_body_collected');
                const parsed = parseStrictJson(Buffer.concat(chunks, bytes).toString('utf8'));
                // Milestone: strict JSON parse succeeded (payload not logged).
                safeEmitStage(stageTelemetry, 'graph_json_validated');
                const identity = selectIdentity(parsed);
                // Milestone: selectIdentity produced a frozen mailbox identity.
                safeEmitStage(stageTelemetry, 'graph_mailbox_selected');
                // Milestone: full Graph response validation chain complete.
                safeEmitStage(stageTelemetry, 'graph_response_validated');
                finish(null, identity);
              } catch (error) {
                finish(error && ERROR_MESSAGES[error.code] ? error : failure('RESPONSE_INVALID'));
              }
            });
          } catch {
            terminate(failure('REQUEST_FAILED'));
          }
        });
        if (!requestObject || typeof requestObject.once !== 'function' || typeof requestObject.end !== 'function') {
          terminate(failure('REQUEST_FAILED')); return;
        }
        requestObject.once('error', () => terminate(failure('REQUEST_FAILED')));
        requestObject.end();
      } catch {
        terminate(failure('REQUEST_FAILED'));
      }
    });
  }

  return Object.freeze({ fetchIdentity });
}

module.exports = Object.freeze({ createMicrosoftGraphMeIdentityTransport });
