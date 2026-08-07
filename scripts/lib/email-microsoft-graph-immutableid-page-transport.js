'use strict';

/**
 * Microsoft Graph delegated ImmutableId page transport (runtime-capable, UNWIRED).
 *
 * One-shot GET /v1.0/me/messages with the same path, $top=5, $select, response
 * caps, terminal cleanup, and failure sanitization as the delegated messages
 * health transport — plus a pinned Prefer: IdType="ImmutableId" header.
 *
 * On success: maps the page through the normalized-page bridge using a
 * module-private authenticated ImmutableId provenance mint (WeakMap brand).
 * Returns only a fresh frozen array of at most TOP_MAX canonical inbound
 * envelopes. Raw page / @odata.context / @odata.nextLink / @odata.etag /
 * provider response body / tokens never escape the result surface and are
 * never logged.
 *
 * Does not accept caller booleans/strings/tokens for provenance. Does not
 * export mint, brand, or capability. Prefer header is transport-owned and
 * cannot be injected or overridden by callers.
 *
 * Not wired into routes, OAuth composition, DB, persistence, dedup, deploy,
 * Azure, or live Graph activation.
 *
 * @module email-microsoft-graph-immutableid-page-transport
 */

const http = require('http');
const https = require('https');
const util = require('util');

const {
  HOST,
  PATH,
  TOP_MAX,
  SELECT_FIELDS,
  RESPONSE_CAP_BYTES,
  GRAPH_STAGES,
  loadClassifiedMessageEnvelopePage,
} = require('./email-microsoft-graph-delegated-messages-transport');

const {
  mapMicrosoftGraphPageToInboundEnvelopes,
  createAuthenticatedGraphImmutableIdProvenanceCapability,
  EMAIL_MS_GRAPH_NORMALIZED_PAGE_MAX,
} = require('./email-microsoft-graph-normalized-page');

const {
  EMAIL_INBOUND_ENVELOPE_STRING_MAX,
} = require('./email-inbound-envelope-contract');

/** Exact Prefer header value for Graph ImmutableId semantics (pinned). */
const PREFER_IMMUTABLE_ID = 'IdType="ImmutableId"';
const ACCEPT_HEADER = 'application/json';

const FAILURE_CODE = 'microsoft_graph_immutableid_page_failed';
const FAILURE_MESSAGE = 'Microsoft Graph ImmutableId page request failed.';
const DEPENDENCY_KEYS = Object.freeze(['httpsImpl', 'timers']);
const INPUT_KEYS = Object.freeze(['accessToken', 'provider_mailbox_id']);
const DEADLINE_MS = 10_000;
const TOKEN_LIMIT = 16_384;
const PROVIDER_ID = 'microsoft_graph';

const EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_RUNTIME_WIRED = false;
const EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_PERSISTENCE_READY = false;
const EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_LOGGING_FORBIDDEN = true;
const EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_PINS_PREFER_IMMUTABLE_ID = true;
const EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_MAX = TOP_MAX;

/** Module-private mint — never exported. Only this transport may mint. */
const provenanceCapability = createAuthenticatedGraphImmutableIdProvenanceCapability();
const mintAuthenticatedGraphImmutableIdProvenance = provenanceCapability
  .mintAuthenticatedGraphImmutableIdProvenance;

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

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

const GRAPH_REQUEST_CONSTANTS = Object.freeze({
  protocol: 'https:',
  hostname: HOST,
  host: HOST,
  port: 443,
  method: 'GET',
  path: PATH,
  agent: false,
});

const GRAPH_STAGE_SET = new Set(GRAPH_STAGES);
/** Module-private brand: only transport-created failure objects may map to a stage. */
const STAGED_FAILURES = new WeakMap();

function failure(stage) {
  let graphStage = 'request_error';
  if (typeof stage === 'string' && GRAPH_STAGE_SET.has(stage) && stage !== 'success') {
    graphStage = stage;
  }
  const error = new Error(FAILURE_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'MicrosoftGraphImmutableIdPageError' });
  Object.defineProperty(error, 'code', { value: FAILURE_CODE, enumerable: true });
  STAGED_FAILURES.set(error, graphStage);
  return Object.freeze(error);
}

/**
 * Safe reader for transport-branded failure stages.
 * Never reads error.graph_stage or any provider-controlled property.
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

function readInput(input) {
  if (!exactPlainData(input, INPUT_KEYS)) return null;
  const token = ownData(input, 'accessToken');
  if (typeof token !== 'string' || token.length < 1 || token.length > TOKEN_LIMIT
      || !/^[\x21-\x7e]+$/.test(token)) {
    return null;
  }
  const mailbox = ownData(input, 'provider_mailbox_id');
  if (typeof mailbox !== 'string'
      || mailbox.length < 1
      || mailbox.length > EMAIL_INBOUND_ENVELOPE_STRING_MAX
      || hasUnpairedSurrogate(mailbox)) {
    return null;
  }
  return { accessToken: token, provider_mailbox_id: mailbox };
}

/**
 * Map a classified page to canonical envelopes with freshly minted authenticated
 * ImmutableId provenance. Mint never escapes this function. Page never returned.
 */
function mapPageToFreshEnvelopes(page, providerMailboxId) {
  const provenance = mintAuthenticatedGraphImmutableIdProvenance();
  const mapped = mapMicrosoftGraphPageToInboundEnvelopes({
    provider: PROVIDER_ID,
    provider_mailbox_id: providerMailboxId,
    page,
    graph_immutable_id_provenance: provenance,
  });
  if (!mapped || mapped.ok !== true || !Array.isArray(mapped.value)) {
    return null;
  }
  if (mapped.value.length > EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_MAX
      || mapped.value.length > EMAIL_MS_GRAPH_NORMALIZED_PAGE_MAX) {
    return null;
  }
  // Fresh frozen array reference only — bridge already deep-freezes envelopes.
  return mapped.value;
}

function createMicrosoftGraphImmutableIdPageTransport(dependencies = {}) {
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

  /**
   * One-shot: GET Graph messages with Prefer ImmutableId; return fresh frozen
   * canonical envelopes only (max TOP_MAX). Rejects if already used.
   *
   * @param {unknown} input exact own-data `{ accessToken, provider_mailbox_id }`
   * @returns {Promise<object[]>} frozen envelope array
   */
  function listNormalizedInboundEnvelopes(input) {
    if (used) return Promise.reject(failure());
    used = true;

    const parsedInput = readInput(input);
    if (parsedInput === null) return Promise.reject(failure());
    let tokenOwner = parsedInput.accessToken;
    const mailboxId = parsedInput.provider_mailbox_id;

    // Reject any attempt to smuggle provenance / headers / Prefer from callers.
    // readInput already enforces exact keyset; mailbox captured above.

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
              const loaded = loadClassifiedMessageEnvelopePage(
                Buffer.concat(chunks, bytes).toString('utf8'),
              );
              if (!loaded || loaded.stage !== 'success'
                  || typeof loaded.count !== 'number'
                  || !loaded.page) {
                finish(failure(
                  loaded && typeof loaded.stage === 'string'
                    ? loaded.stage
                    : 'json_invalid',
                ));
                return;
              }
              const envelopes = mapPageToFreshEnvelopes(loaded.page, mailboxId);
              // Drop page reference immediately after mapping (no retention).
              if (!envelopes) {
                finish(failure('row_value_invalid'));
                return;
              }
              finish(null, envelopes);
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
        // Prefer is transport-owned and pinned — never from caller input.
        (function issueRequest(tokenForRequest) {
          let requestHeaders = {
            Accept: ACCEPT_HEADER,
            Prefer: PREFER_IMMUTABLE_ID,
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

  return Object.freeze({ listNormalizedInboundEnvelopes });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  FAILURE_MESSAGE,
  PREFER_IMMUTABLE_ID,
  HOST,
  PATH,
  TOP_MAX,
  SELECT_FIELDS,
  RESPONSE_CAP_BYTES,
  GRAPH_STAGES,
  EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_RUNTIME_WIRED,
  EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_PERSISTENCE_READY,
  EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_LOGGING_FORBIDDEN,
  EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_PINS_PREFER_IMMUTABLE_ID,
  EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_MAX,
  readTrustedGraphStage,
  createMicrosoftGraphImmutableIdPageTransport,
});
