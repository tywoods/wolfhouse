'use strict';

/**
 * Delegated Microsoft Graph Mail.ReadBasic message-envelope health transport.
 * Single-use GET /v1.0/me/messages with fixed $top=5 and fixed $select.
 * Returns only a bounded count — never subjects, addresses, IDs, bodies, or links.
 * Validates native responses with the pinned IncomingMessage / isProxy pattern.
 * May accept a standard @odata.nextLink on the list envelope (never followed).
 * May accept optional per-message @odata.etag (validated then discarded; never used).
 *
 * Not the app-only mailbox adapter. No pagination, delta, send, or persistence.
 *
 * @module email-microsoft-graph-delegated-messages-transport
 */

const http = require('http');
const https = require('https');
const util = require('util');

const HOST = 'graph.microsoft.com';
const TOP_MAX = 5;
const SELECT_FIELDS = Object.freeze([
  'id',
  'subject',
  'from',
  'receivedDateTime',
  'isRead',
  'conversationId',
  'internetMessageId',
]);
const ETAG_KEY = '@odata.etag';
const ROW_FIELDS_WITH_ETAG = Object.freeze([...SELECT_FIELDS, ETAG_KEY]);
const PATH = `/v1.0/me/messages?$top=${TOP_MAX}&$select=${SELECT_FIELDS.join(',')}`;
const DEADLINE_MS = 10_000;
const RESPONSE_CAP_BYTES = 65_536;
const TOKEN_LIMIT = 16_384;
const STRING_LIMIT = 2048;
const DEPENDENCY_KEYS = Object.freeze(['httpsImpl', 'timers']);
const FAILURE_CODE = 'microsoft_graph_delegated_messages_failed';
const FAILURE_MESSAGE = 'Microsoft Graph delegated messages request failed.';
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const TOP_ALLOWED_EXACT = Object.freeze([
  Object.freeze(['value']),
  Object.freeze(['@odata.context', 'value']),
  Object.freeze(['value', '@odata.nextLink']),
  Object.freeze(['@odata.context', 'value', '@odata.nextLink']),
]);
const FROM_KEYS = Object.freeze(['emailAddress']);
const EMAIL_ADDRESS_KEYS = Object.freeze(['address', 'name']);
const NEXT_LINK_KEY = '@odata.nextLink';
const MESSAGES_PATH_ME = /^\/v1\.0\/me\/messages$/;
const MESSAGES_PATH_USER = /^\/v1\.0\/users\/[^/]+\/messages$/;

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
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;

/** Frozen non-secret Graph request constants (never includes Authorization). */
const GRAPH_REQUEST_CONSTANTS = Object.freeze({
  protocol: 'https:',
  hostname: HOST,
  host: HOST,
  port: 443,
  method: 'GET',
  path: PATH,
  agent: false,
});
const ACCEPT_HEADER = 'application/json';

/** Exact allowlisted terminal Graph read-health diagnostic stages. */
const GRAPH_STAGES = Object.freeze([
  'request_error',
  'timeout',
  'response_surface_invalid',
  'http_status_not_200',
  'content_type_invalid',
  'stream_invalid',
  'stream_aborted',
  'response_too_large',
  'utf8_invalid',
  'json_invalid',
  'top_shape_invalid',
  'row_keyset_invalid',
  'row_value_invalid',
  'success',
]);
const GRAPH_STAGE_SET = new Set(GRAPH_STAGES);

/** Module-private brand: only transport-created failure objects may map to a stage. */
const STAGED_FAILURES = new WeakMap();

function failure(stage) {
  let graphStage = 'request_error';
  if (typeof stage === 'string' && GRAPH_STAGE_SET.has(stage) && stage !== 'success') {
    graphStage = stage;
  }
  const error = new Error(FAILURE_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'MicrosoftGraphDelegatedMessagesError' });
  Object.defineProperty(error, 'code', { value: FAILURE_CODE, enumerable: true });
  // Stage lives only in the private brand — never as a readable error property.
  STAGED_FAILURES.set(error, graphStage);
  return Object.freeze(error);
}

/**
 * Safe reader for transport-branded failure stages.
 * Never reads error.graph_stage or any provider-controlled property.
 * Returns null for arbitrary objects, proxies, inherited/accessor surfaces, and primitives.
 */
function readTrustedGraphStage(error) {
  try {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
      return null;
    }
    const stage = STAGED_FAILURES.get(error);
    if (typeof stage !== 'string' || !GRAPH_STAGE_SET.has(stage) || stage === 'success') {
      return null;
    }
    return stage;
  } catch {
    return null;
  }
}

function ownData(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isProxySurface(value) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

function isPlainOwnDataObject(object) {
  try {
    if (object === null || typeof object !== 'object' || Array.isArray(object)) return false;
    if (isProxySurface(object)) return false;
    const proto = Object.getPrototypeOf(object);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

function exactPlainData(object, keys) {
  try {
    if (!isPlainOwnDataObject(object)) return false;
    const actual = Reflect.ownKeys(object);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== 'string'
          || DANGEROUS_KEYS.has(key)
          || !keys.includes(key))) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return Boolean(
        descriptor
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && descriptor.enumerable
        && !descriptor.get
        && !descriptor.set,
      );
    });
  } catch {
    return false;
  }
}

function keysMatchExactSet(actual, allowed) {
  if (actual.length !== allowed.length) return false;
  const remaining = new Set(allowed);
  for (const key of actual) {
    if (typeof key !== 'string' || !remaining.has(key)) return false;
    remaining.delete(key);
  }
  return remaining.size === 0;
}

function isPinnedIncomingMessage(response) {
  try {
    if (isProxySurface(response)) return false;
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

function readResponseHeaders(response) {
  try {
    if (isProxySurface(response)) return undefined;
    if (isPinnedIncomingMessage(response)) {
      const headers = Reflect.apply(PINNED_HEADERS_GET, response, []);
      if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
        return undefined;
      }
      return headers;
    }
    return ownData(response, 'headers');
  } catch {
    return undefined;
  }
}

function readAccessToken(input) {
  if (!exactPlainData(input, ['accessToken'])) return null;
  const token = ownData(input, 'accessToken');
  if (typeof token !== 'string' || token.length < 1 || token.length > TOKEN_LIMIT
      || !/^[\x21-\x7e]+$/.test(token)) {
    return null;
  }
  return token;
}

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

/**
 * Strict JSON parser: rejects duplicate keys at every object depth, dangerous
 * names, unpaired surrogates, and oversized strings. Builds null-prototype objects.
 */
function parseStrictJson(text) {
  let at = 0;
  const fail = () => { throw new Error('strict_json_fail'); };
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
        if (result.length > STRING_LIMIT || hasUnpairedSurrogate(result)) fail();
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
      if (result.length > TOP_MAX) fail();
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

function optionalBoundedString(value) {
  return value === null
    || (typeof value === 'string'
      && value.length <= STRING_LIMIT
      && !hasUnpairedSurrogate(value));
}

function requiredBoundedString(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= STRING_LIMIT
    && !hasUnpairedSurrogate(value);
}

function acceptEmailAddress(value) {
  if (value === null) return true;
  if (!exactPlainData(value, EMAIL_ADDRESS_KEYS)) return false;
  return optionalBoundedString(ownData(value, 'address'))
    && optionalBoundedString(ownData(value, 'name'));
}

function acceptFrom(value) {
  if (value === null) return true;
  if (!exactPlainData(value, FROM_KEYS)) return false;
  return acceptEmailAddress(ownData(value, 'emailAddress'));
}

function rowKeysetValid(row) {
  return exactPlainData(row, SELECT_FIELDS) || exactPlainData(row, ROW_FIELDS_WITH_ETAG);
}

function rowValuesValid(row) {
  if (!requiredBoundedString(ownData(row, 'id'))) return false;
  if (!optionalBoundedString(ownData(row, 'subject'))) return false;
  if (!acceptFrom(ownData(row, 'from'))) return false;
  if (!requiredBoundedString(ownData(row, 'receivedDateTime'))) return false;
  const isRead = ownData(row, 'isRead');
  if (isRead !== true && isRead !== false) return false;
  if (!optionalBoundedString(ownData(row, 'conversationId'))) return false;
  if (!optionalBoundedString(ownData(row, 'internetMessageId'))) return false;
  if (Object.prototype.hasOwnProperty.call(row, ETAG_KEY)) {
    const etag = ownData(row, ETAG_KEY);
    if (!requiredBoundedString(etag)) return false;
    // Discard immediately — never return, persist, compare, log, or use.
  }
  return true;
}

function acceptRow(row) {
  return rowKeysetValid(row) && rowValuesValid(row);
}

function classifyRow(row) {
  if (!isPlainOwnDataObject(row) || !rowKeysetValid(row)) return 'row_keyset_invalid';
  if (!rowValuesValid(row)) return 'row_value_invalid';
  return null;
}

/**
 * Validate Graph @odata.nextLink without following, persisting, returning, or logging it.
 * HTTPS only; host exactly graph.microsoft.com; no credentials/fragment; messages collection path.
 */
function isValidGraphMessagesNextLink(value) {
  try {
    if (typeof value !== 'string'
        || value.length < 1
        || value.length > STRING_LIMIT
        || hasUnpairedSurrogate(value)) {
      return false;
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:') return false;
    if (url.hostname !== HOST) return false;
    if (url.username !== '' || url.password !== '') return false;
    if (url.hash !== '') return false;
    if (url.port !== '' && url.port !== '443') return false;
    if (!MESSAGES_PATH_ME.test(url.pathname) && !MESSAGES_PATH_USER.test(url.pathname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify an already-parsed Graph list object.
 * Returns frozen { stage, count? } — never row contents or nextLink.
 */
function classifyParsedMessageEnvelopeList(parsed) {
  try {
    if (!isPlainOwnDataObject(parsed)) {
      return Object.freeze({ stage: 'top_shape_invalid' });
    }
    const keys = Reflect.ownKeys(parsed);
    if (keys.some((key) => typeof key !== 'string' || DANGEROUS_KEYS.has(key))) {
      return Object.freeze({ stage: 'top_shape_invalid' });
    }
    let allowed = false;
    for (const candidate of TOP_ALLOWED_EXACT) {
      if (keysMatchExactSet(keys, candidate)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return Object.freeze({ stage: 'top_shape_invalid' });
    if (!keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(parsed, key);
      return Boolean(
        descriptor
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && descriptor.enumerable
        && !descriptor.get
        && !descriptor.set,
      );
    })) {
      return Object.freeze({ stage: 'top_shape_invalid' });
    }
    if (Object.prototype.hasOwnProperty.call(parsed, '@odata.context')) {
      const context = ownData(parsed, '@odata.context');
      if (typeof context !== 'string' || context.length < 1 || context.length > STRING_LIMIT
          || hasUnpairedSurrogate(context)) {
        return Object.freeze({ stage: 'top_shape_invalid' });
      }
    }
    if (Object.prototype.hasOwnProperty.call(parsed, NEXT_LINK_KEY)) {
      const nextLink = ownData(parsed, NEXT_LINK_KEY);
      if (!isValidGraphMessagesNextLink(nextLink)) {
        return Object.freeze({ stage: 'top_shape_invalid' });
      }
      // Discard immediately after validation — never retain, return, or follow.
    }
    const rows = ownData(parsed, 'value');
    if (!Array.isArray(rows) || rows.length > TOP_MAX) {
      return Object.freeze({ stage: 'top_shape_invalid' });
    }
    for (const row of rows) {
      const rowStage = classifyRow(row);
      if (rowStage) return Object.freeze({ stage: rowStage });
    }
    return Object.freeze({ stage: 'success', count: rows.length });
  } catch {
    return Object.freeze({ stage: 'top_shape_invalid' });
  }
}

/**
 * Accept an already-parsed Graph list object. Returns bounded count or null.
 * Rejects proxies, accessors, inherited prototypes, unexpected keys, and
 * all body/content/attachment fields (not in SELECT_FIELDS).
 */
function acceptParsedMessageEnvelopeList(parsed) {
  const classified = classifyParsedMessageEnvelopeList(parsed);
  return classified.stage === 'success' ? classified.count : null;
}

/**
 * Classify Graph list JSON body into exactly one allowlisted stage.
 * Never returns row contents.
 */
function classifyMessageEnvelopeBody(bodyText) {
  if (typeof bodyText !== 'string') {
    return Object.freeze({ stage: 'utf8_invalid' });
  }
  if (Buffer.byteLength(bodyText, 'utf8') > RESPONSE_CAP_BYTES) {
    return Object.freeze({ stage: 'response_too_large' });
  }
  if (bodyText.includes('\ufffd')) {
    return Object.freeze({ stage: 'utf8_invalid' });
  }
  let parsed;
  try {
    parsed = parseStrictJson(bodyText);
  } catch {
    return Object.freeze({ stage: 'json_invalid' });
  }
  return classifyParsedMessageEnvelopeList(parsed);
}

/**
 * Validate Graph list JSON and return only a bounded count.
 * Never returns row contents. Rejects pagination/delta links and body fields.
 */
function countBoundedMessageEnvelopes(bodyText) {
  const classified = classifyMessageEnvelopeBody(bodyText);
  return classified.stage === 'success' ? classified.count : null;
}

function createMicrosoftGraphDelegatedMessagesTransport(dependencies = {}) {
  let requestFn;
  let setTimer;
  let clearTimer;
  try {
    if (!dependencies || Object.getPrototypeOf(dependencies) !== Object.prototype) {
      throw failure();
    }
    const keys = Reflect.ownKeys(dependencies);
    if (keys.some((k) => typeof k !== 'string' || !DEPENDENCY_KEYS.includes(k))) {
      throw failure();
    }
    const httpsImpl = ownData(dependencies, 'httpsImpl');
    if (httpsImpl === undefined) {
      requestFn = https.request;
    } else if (typeof httpsImpl === 'function') {
      requestFn = httpsImpl;
    } else if (httpsImpl && typeof ownData(httpsImpl, 'request') === 'function') {
      const owner = httpsImpl;
      const fn = ownData(httpsImpl, 'request');
      requestFn = (...args) => Reflect.apply(fn, owner, args);
    } else {
      throw failure();
    }
    setTimer = setTimeout;
    clearTimer = clearTimeout;
    if (Object.prototype.hasOwnProperty.call(dependencies, 'timers')) {
      const timers = ownData(dependencies, 'timers');
      if (!timers || typeof ownData(timers, 'setTimeout') !== 'function'
          || typeof ownData(timers, 'clearTimeout') !== 'function') {
        throw failure();
      }
      setTimer = ownData(timers, 'setTimeout');
      clearTimer = ownData(timers, 'clearTimeout');
    }
  } catch (_) {
    throw failure();
  }

  let used = false;
  function listMessageEnvelopeCount(input) {
    if (used) return Promise.reject(failure());
    used = true;
    let tokenOwner = readAccessToken(input);
    if (tokenOwner === null) return Promise.reject(failure());

    return new Promise((resolve, reject) => {
      let settled = false;
      let requestObject;
      let activeResponse;
      let timerHandle;
      let timerAcquired = false;
      let timerCleared = false;

      const clearDeadline = () => {
        if (!timerAcquired || timerCleared) return;
        timerCleared = true;
        try { clearTimer(timerHandle); } catch { /* */ }
      };
      const destroyRequest = () => {
        try {
          if (requestObject && typeof requestObject.destroy === 'function') requestObject.destroy();
        } catch { /* */ }
      };
      const destroyResponse = () => {
        try {
          if (activeResponse && typeof activeResponse.destroy === 'function') activeResponse.destroy();
        } catch { /* */ }
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearDeadline();
        if (error) reject(error);
        else resolve(result);
      };
      const terminate = (error) => {
        destroyResponse();
        destroyRequest();
        finish(error);
      };

      // Response path must not close over token / Authorization / token-bearing options.
      const onResponse = (response) => {
        if (isProxySurface(response)) {
          if (settled) return;
          destroyRequest();
          finish(failure('response_surface_invalid'));
          return;
        }
        if (settled) {
          activeResponse = response;
          destroyResponse();
          return;
        }
        activeResponse = response;
        try {
          const status = ownData(response, 'statusCode');
          const headers = readResponseHeaders(response);
          const contentType = headers && typeof headers === 'object'
            ? ownData(headers, 'content-type') : undefined;
          if (status !== 200) { terminate(failure('http_status_not_200')); return; }
          if (typeof contentType !== 'string'
              || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
            terminate(failure('content_type_invalid'));
            return;
          }
          if (typeof response.on !== 'function' || typeof response.once !== 'function') {
            terminate(failure('response_surface_invalid'));
            return;
          }
          const chunks = [];
          let bytes = 0;
          let ended = false;
          response.on('data', (chunk) => {
            if (settled) return;
            if (!Buffer.isBuffer(chunk)) { terminate(failure('stream_invalid')); return; }
            if (chunk.length > RESPONSE_CAP_BYTES - bytes) {
              terminate(failure('response_too_large'));
              return;
            }
            bytes += chunk.length;
            chunks.push(chunk);
          });
          response.once('error', () => terminate(failure('stream_invalid')));
          response.once('aborted', () => terminate(failure('stream_aborted')));
          response.once('close', () => {
            if (!ended) terminate(failure('stream_aborted'));
          });
          response.once('end', () => {
            if (settled) return;
            ended = true;
            try {
              const classified = classifyMessageEnvelopeBody(
                Buffer.concat(chunks, bytes).toString('utf8'),
              );
              if (!classified || classified.stage !== 'success'
                  || typeof classified.count !== 'number') {
                finish(failure(
                  classified && typeof classified.stage === 'string'
                    ? classified.stage
                    : 'json_invalid',
                ));
                return;
              }
              finish(null, Object.freeze({
                message_count_bounded: classified.count,
                graph_stage: 'success',
              }));
            } catch {
              finish(failure('json_invalid'));
            }
          });
        } catch {
          terminate(failure('response_surface_invalid'));
        }
      };

      try {
        timerHandle = setTimer(() => terminate(failure('timeout')), DEADLINE_MS);
        timerAcquired = true;
        if (settled) clearDeadline();
      } catch {
        tokenOwner = null;
        finish(failure('request_error'));
        return;
      }
      if (settled) {
        tokenOwner = null;
        return;
      }

      try {
        // Isolate token/Authorization to this call site; scrub immediately after
        // https.request returns or throws (Node reads options synchronously).
        (function issueRequest(tokenForRequest) {
          let requestHeaders = {
            Accept: ACCEPT_HEADER,
            Authorization: null,
          };
          let authorization = null;
          let requestOptions = null;
          try {
            authorization = ['Bearer', tokenForRequest].join(' ');
            tokenForRequest = null;
            requestHeaders.Authorization = authorization;
            requestOptions = {
              protocol: GRAPH_REQUEST_CONSTANTS.protocol,
              hostname: GRAPH_REQUEST_CONSTANTS.hostname,
              host: GRAPH_REQUEST_CONSTANTS.host,
              port: GRAPH_REQUEST_CONSTANTS.port,
              method: GRAPH_REQUEST_CONSTANTS.method,
              path: GRAPH_REQUEST_CONSTANTS.path,
              agent: GRAPH_REQUEST_CONSTANTS.agent,
              headers: requestHeaders,
            };
            requestObject = requestFn(requestOptions, onResponse);
          } finally {
            try {
              if (requestHeaders) requestHeaders.Authorization = null;
            } catch { /* */ }
            requestHeaders = null;
            authorization = null;
            requestOptions = null;
            tokenForRequest = null;
          }
        }(tokenOwner));
        tokenOwner = null;
      } catch {
        tokenOwner = null;
        terminate(failure('request_error'));
        return;
      }

      if (!requestObject || typeof requestObject.once !== 'function'
          || typeof requestObject.end !== 'function') {
        terminate(failure('request_error'));
        return;
      }
      requestObject.once('error', () => terminate(failure('request_error')));
      requestObject.end();
    });
  }

  return Object.freeze({ listMessageEnvelopeCount });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  FAILURE_MESSAGE,
  HOST,
  PATH,
  TOP_MAX,
  SELECT_FIELDS,
  RESPONSE_CAP_BYTES,
  GRAPH_STAGES,
  countBoundedMessageEnvelopes,
  classifyMessageEnvelopeBody,
  classifyParsedMessageEnvelopeList,
  acceptParsedMessageEnvelopeList,
  readTrustedGraphStage,
  createMicrosoftGraphDelegatedMessagesTransport,
});
