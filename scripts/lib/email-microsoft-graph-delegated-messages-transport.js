'use strict';

/**
 * Delegated Microsoft Graph Mail.ReadBasic message-envelope health transport.
 * Single-use GET /v1.0/me/messages with fixed $top=5 and fixed $select.
 * Returns only a bounded count — never subjects, addresses, IDs, bodies, or links.
 * Validates native responses with the pinned IncomingMessage / isProxy pattern.
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
  'hasAttachments',
  'internetMessageId',
]);
const PATH = `/v1.0/me/messages?$top=${TOP_MAX}&$select=${SELECT_FIELDS.join(',')}`;
const DEADLINE_MS = 10_000;
const RESPONSE_CAP_BYTES = 65_536;
const TOKEN_LIMIT = 16_384;
const DEPENDENCY_KEYS = Object.freeze(['httpsImpl', 'timers']);
const FAILURE_CODE = 'microsoft_graph_delegated_messages_failed';
const FAILURE_MESSAGE = 'Microsoft Graph delegated messages request failed.';

const FORBIDDEN_BODY_KEYS = new Set([
  'body', 'bodyPreview', 'uniqueBody', 'internetMessageHeaders',
  'toRecipients', 'ccRecipients', 'bccRecipients', 'replyTo',
]);
const FORBIDDEN_ODATA = new Set([
  '@odata.nextLink', '@odata.deltaLink',
]);

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

function failure() {
  const error = new Error(FAILURE_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'MicrosoftGraphDelegatedMessagesError' });
  Object.defineProperty(error, 'code', { value: FAILURE_CODE, enumerable: true });
  return Object.freeze(error);
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

function exactPlainData(object, keys) {
  try {
    if (!object || Object.getPrototypeOf(object) !== Object.prototype) return false;
    const actual = Reflect.ownKeys(object);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
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

function isProxyResponseSurface(value) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

function isPinnedIncomingMessage(response) {
  try {
    if (isProxyResponseSurface(response)) return false;
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
    if (isProxyResponseSurface(response)) return undefined;
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

/**
 * Validate Graph list JSON and return only a bounded count.
 * Never returns row contents. Rejects pagination/delta links and body fields.
 */
function countBoundedMessageEnvelopes(bodyText) {
  if (typeof bodyText !== 'string'
      || Buffer.byteLength(bodyText, 'utf8') > RESPONSE_CAP_BYTES
      || bodyText.includes('\ufffd')) {
    return null;
  }
  if (!assertUniqueTopLevelKeys(bodyText)) return null;
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch (_) { return null; }
  if (!parsed || Object.getPrototypeOf(parsed) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(parsed);
  if (keys.some((k) => typeof k !== 'string')) return null;
  for (const key of keys) {
    if (FORBIDDEN_ODATA.has(key)) return null;
    if (key === 'error') return null;
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, 'value')) return null;
  const valueDesc = Object.getOwnPropertyDescriptor(parsed, 'value');
  if (!valueDesc || valueDesc.get || valueDesc.set || !Array.isArray(valueDesc.value)) {
    return null;
  }
  const rows = valueDesc.value;
  if (rows.length > TOP_MAX) return null;
  for (const row of rows) {
    if (!row || Object.getPrototypeOf(row) !== Object.prototype) return null;
    const rowKeys = Reflect.ownKeys(row);
    if (rowKeys.some((k) => typeof k !== 'string')) return null;
    for (const key of rowKeys) {
      if (FORBIDDEN_BODY_KEYS.has(key)) return null;
      if (key.startsWith('@odata.')) return null;
    }
  }
  return rows.length;
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
    const accessToken = readAccessToken(input);
    if (accessToken === null) return Promise.reject(failure());

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

      try {
        timerHandle = setTimer(() => terminate(failure()), DEADLINE_MS);
        timerAcquired = true;
        if (settled) clearDeadline();
      } catch {
        finish(failure());
        return;
      }
      if (settled) return;

      try {
        requestObject = requestFn(Object.freeze({
          protocol: 'https:',
          hostname: HOST,
          host: HOST,
          port: 443,
          method: 'GET',
          path: PATH,
          agent: false,
          headers: Object.freeze({
            Accept: 'application/json',
            Authorization: ['Bearer', accessToken].join(' '),
          }),
        }), (response) => {
          if (isProxyResponseSurface(response)) {
            if (settled) return;
            destroyRequest();
            finish(failure());
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
            if (status !== 200) { terminate(failure()); return; }
            if (typeof contentType !== 'string'
                || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
              terminate(failure());
              return;
            }
            if (typeof response.on !== 'function' || typeof response.once !== 'function') {
              terminate(failure());
              return;
            }
            const chunks = [];
            let bytes = 0;
            let ended = false;
            response.on('data', (chunk) => {
              if (settled) return;
              if (!Buffer.isBuffer(chunk)) { terminate(failure()); return; }
              if (chunk.length > RESPONSE_CAP_BYTES - bytes) { terminate(failure()); return; }
              bytes += chunk.length;
              chunks.push(chunk);
            });
            response.once('error', () => terminate(failure()));
            response.once('aborted', () => terminate(failure()));
            response.once('close', () => { if (!ended) terminate(failure()); });
            response.once('end', () => {
              if (settled) return;
              ended = true;
              try {
                const count = countBoundedMessageEnvelopes(
                  Buffer.concat(chunks, bytes).toString('utf8'),
                );
                if (count === null) { finish(failure()); return; }
                finish(null, Object.freeze({ message_count_bounded: count }));
              } catch {
                finish(failure());
              }
            });
          } catch {
            terminate(failure());
          }
        });
        if (!requestObject || typeof requestObject.once !== 'function'
            || typeof requestObject.end !== 'function') {
          terminate(failure());
          return;
        }
        requestObject.once('error', () => terminate(failure()));
        requestObject.end();
      } catch {
        terminate(failure());
      }
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
  countBoundedMessageEnvelopes,
  createMicrosoftGraphDelegatedMessagesTransport,
});
