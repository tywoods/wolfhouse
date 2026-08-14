'use strict';

/**
 * Delegated Microsoft Graph Mail.ReadBasic messages transport — single network owner.
 *
 * Health path: single-use GET /v1.0/me/messages with fixed $top=5 and fixed $select.
 * Returns only a bounded count — never subjects, addresses, IDs, bodies, or links.
 *
 * ImmutableId page path (UNWIRED factory): same one-shot HTTP lifecycle with pinned
 * Prefer: IdType="ImmutableId", private success→canonical-envelope mapping, and an
 * exact authority-bound path `/v1.0/users/{canonicalUuid}/messages` (not `/me`) so
 * token/mailbox mismatch fails at Graph instead of mislabeling canonical envelopes.
 * Count-health path remains `/v1.0/me/messages`. Raw page never escapes; no public
 * provenance mint/capability. Callers cannot inject Prefer or provenance.
 *
 * ImmutableId bounded-catchup path (UNWIRED factory): multi-page sequential follow of
 * provider-returned `@odata.nextLink` only, after strict descriptor-safe nextLink
 * validation (exact host/path/mailbox + query allowlist). Factory-fixed maxPages=10
 * and maxMessages=50. Returns one frozen sanitized DTO of canonical envelopes +
 * identity-free counts; no persistence and no consumer invocation. Atomic: any
 * page/request/parser/normalization failure yields only the sanitized ImmutableId
 * transport failure and no partial envelopes.
 *
 * Messages-delta single-page path (UNWIRED factory): one-shot GET of
 * `/v1.0/users/{canonicalUuid}/mailFolders/inbox/messages/delta` with Prefer ImmutableId and the same
 * $top/$select/caps. Continuation reuses PR408 `validateMessagesDeltaCursorUrl`
 * (nextLink→$skiptoken only, deltaLink→$deltatoken only; validated provider URL
 * used verbatim as request target — append nothing). Success is one frozen DTO
 * `{ envelopes, tombstones, successor_cursor, observed_count }`. Exact one
 * `@odata.nextLink` XOR `@odata.deltaLink` is mandatory. Deleted rows map to
 * identity tombstones only. Continuation HTTP 410 brands unforgeable
 * `cursor_gone` via `readTrustedMessagesDeltaOutcome` (public error remains
 * generic). No DB/store/lease/grant/runtime/composition wiring.
 *
 * Validates native responses with the pinned IncomingMessage / isProxy pattern.
 * Lifecycle methods (on/once/end/destroy) use own-data descriptors or pinned native
 * prototype functions only — never `typeof obj.method` / [[Get]] that run hostile
 * accessors or proxy traps.
 * May accept a standard @odata.nextLink on the list envelope (single-page never
 * follows; bounded-catchup follows only after strict re-validation).
 * May accept optional per-message @odata.etag (validated then discarded; never used).
 *
 * Not the app-only mailbox adapter. No send or persistence.
 * ImmutableId / messages-delta factories are not route/runtime/DB/OAuth wired.
 *
 * @module email-microsoft-graph-delegated-messages-transport
 */

const http = require('http');
const https = require('https');
const util = require('util');
const { URL: NODE_URL } = require('node:url');
const { EventEmitter } = require('events');
const stream = require('stream');

const {
  mapMicrosoftGraphMailReadBasicRowToInboundEnvelope,
} = require('./email-microsoft-graph-inbound-envelope-mapper');
const {
  compareInboundEmailEnvelopesForOrder,
  inboundEmailEnvelopeIdentityTuple,
  EMAIL_INBOUND_ENVELOPE_STRING_MAX,
} = require('./email-inbound-envelope-contract');
// Reuse PR408 strict messages-delta cursor URL validation (do not weaken/duplicate).
const {
  validateMessagesDeltaCursorUrl,
  CURSOR_KINDS: MESSAGES_DELTA_CURSOR_KINDS,
} = require('./email-inbound-delta-state-store');

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
const SELECT_QUERY = `$top=${TOP_MAX}&$select=${SELECT_FIELDS.join(',')}`;
/** Count-health path only — always `/me` (token subject). Do not use for ImmutableId. */
const PATH = `/v1.0/me/messages?${SELECT_QUERY}`;
/** Canonical lowercase hyphenated UUID (matches authority providerMailboxId / resource id). */
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEADLINE_MS = 10_000;
const RESPONSE_CAP_BYTES = 65_536;
const TOKEN_LIMIT = 16_384;
const STRING_LIMIT = 2048;
const DEPENDENCY_KEYS = Object.freeze(['httpsImpl', 'timers']);
const FAILURE_CODE = 'microsoft_graph_delegated_messages_failed';
const FAILURE_MESSAGE = 'Microsoft Graph delegated messages request failed.';
/** Exact Prefer header value for Graph ImmutableId semantics (pinned; transport-owned). */
const PREFER_IMMUTABLE_ID = 'IdType="ImmutableId"';
const IMMUTABLEID_PAGE_FAILURE_CODE = 'microsoft_graph_immutableid_page_failed';
const IMMUTABLEID_PAGE_FAILURE_MESSAGE = 'Microsoft Graph ImmutableId page request failed.';
const IMMUTABLEID_PAGE_ERROR_NAME = 'MicrosoftGraphImmutableIdPageError';
const COUNT_ERROR_NAME = 'MicrosoftGraphDelegatedMessagesError';
/** Messages-delta single-page transport failure surface (distinct from count/ImmutableId). */
const MESSAGES_DELTA_PAGE_FAILURE_CODE = 'microsoft_graph_messages_delta_page_failed';
const MESSAGES_DELTA_PAGE_FAILURE_MESSAGE =
  'Microsoft Graph messages delta page request failed.';
const MESSAGES_DELTA_PAGE_ERROR_NAME = 'MicrosoftGraphMessagesDeltaPageError';
/**
 * Non-enumerable options probe key for messages-delta continuation path owner.
 * Attached only for the duration of issueRequest so retained options holders can
 * prove owner.value is nulled after scrub; never enumerable / JSON-visible.
 */
const CONTINUATION_PATH_OWNER_PROBE = '_msDeltaContinuationPathOwner';

/** Unforgeable private continuation-410 outcome (WeakMap brand only). */
const MESSAGES_DELTA_OUTCOME_CURSOR_GONE = 'cursor_gone';
const MESSAGES_DELTA_OUTCOMES_ALLOWED = Object.freeze([MESSAGES_DELTA_OUTCOME_CURSOR_GONE]);
const PROVIDER_ID = 'microsoft_graph';
/** Factory-fixed bounded-catchup caps — never caller-supplied. */
const BOUNDED_CATCHUP_MAX_PAGES = 10;
const BOUNDED_CATCHUP_MAX_MESSAGES = 50;
const BOUNDED_CATCHUP_RESULT_KEYS = Object.freeze([
  'envelopes',
  'pages_fetched',
  'observed_count',
  'unique_count',
  'duplicate_count',
  'truncated',
]);
/** Exact ordered success DTO keys for messages-delta single page. */
const MESSAGES_DELTA_PAGE_RESULT_KEYS = Object.freeze([
  'envelopes',
  'tombstones',
  'successor_cursor',
  'observed_count',
]);
const MESSAGES_DELTA_SUCCESSOR_KEYS = Object.freeze(['cursor_kind', 'cursor_url']);
const MESSAGES_DELTA_TOMBSTONE_KEYS = Object.freeze([
  'provider',
  'provider_mailbox_id',
  'provider_message_id',
]);
const MESSAGES_DELTA_REMOVED_KEY = '@removed';
const MESSAGES_DELTA_REMOVED_REASON = 'deleted';
const MESSAGES_DELTA_DELETED_ROW_KEYS = Object.freeze(['id', MESSAGES_DELTA_REMOVED_KEY]);
const MESSAGES_DELTA_REMOVED_OBJECT_KEYS = Object.freeze(['reason']);
/** Original list query keys from SELECT_QUERY ($top + $select). */
const CATCHUP_BASE_QUERY_KEYS = Object.freeze(['$top', '$select']);
const CATCHUP_ORIGINAL_TOP = String(TOP_MAX);
const CATCHUP_ORIGINAL_SELECT = SELECT_FIELDS.join(',');
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const TOP_ALLOWED_EXACT = Object.freeze([
  Object.freeze(['value']),
  Object.freeze(['@odata.context', 'value']),
  Object.freeze(['value', '@odata.nextLink']),
  Object.freeze(['@odata.context', 'value', '@odata.nextLink']),
]);
/** Messages-delta page: exact one nextLink XOR deltaLink is mandatory (zero rows ok). */
const DELTA_TOP_ALLOWED_EXACT = Object.freeze([
  Object.freeze(['value', '@odata.nextLink']),
  Object.freeze(['value', '@odata.deltaLink']),
  Object.freeze(['@odata.context', 'value', '@odata.nextLink']),
  Object.freeze(['@odata.context', 'value', '@odata.deltaLink']),
]);
const FROM_KEYS = Object.freeze(['emailAddress']);
const EMAIL_ADDRESS_KEYS = Object.freeze(['address', 'name']);
const NEXT_LINK_KEY = '@odata.nextLink';
const DELTA_LINK_KEY = '@odata.deltaLink';
const MESSAGES_PATH_ME = /^\/v1\.0\/me\/messages$/;
const MESSAGES_PATH_USER = /^\/v1\.0\/users\/[^/]+\/messages$/;

/** Module-init pins: ambient monkeypatches after load must not weaken detection. */
// Pin the core node:url constructor, never the ambient global URL.
const PINNED_URL = typeof NODE_URL === 'function' ? NODE_URL : null;
const PINNED_URL_PROTOTYPE = PINNED_URL && PINNED_URL.prototype
  ? PINNED_URL.prototype
  : null;

/**
 * Pin a native URL.prototype getter at module init. Fail closed (null) if the
 * descriptor is missing, is a data property, or is not a function getter.
 * @param {string} name
 * @returns {function|null}
 */
function pinUrlGetter(name) {
  try {
    if (!PINNED_URL_PROTOTYPE) return null;
    const descriptor = Object.getOwnPropertyDescriptor(PINNED_URL_PROTOTYPE, name);
    if (!descriptor
        || typeof descriptor.get !== 'function'
        || Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return null;
    }
    return descriptor.get;
  } catch {
    return null;
  }
}

// Exact native getters used by nextLink validators — never live property reads.
const PINNED_URL_GET_PROTOCOL = pinUrlGetter('protocol');
const PINNED_URL_GET_USERNAME = pinUrlGetter('username');
const PINNED_URL_GET_PASSWORD = pinUrlGetter('password');
const PINNED_URL_GET_HOSTNAME = pinUrlGetter('hostname');
const PINNED_URL_GET_HOST = pinUrlGetter('host');
const PINNED_URL_GET_PORT = pinUrlGetter('port');
const PINNED_URL_GET_PATHNAME = pinUrlGetter('pathname');
const PINNED_URL_GET_SEARCH = pinUrlGetter('search');
const PINNED_URL_GET_HASH = pinUrlGetter('hash');

/** True only when every URL intrinsic needed for nextLink validation is pinned. */
const PINNED_URL_INTRINSICS_READY = Boolean(
  PINNED_URL
  && PINNED_URL_PROTOTYPE
  && PINNED_URL_GET_PROTOCOL
  && PINNED_URL_GET_USERNAME
  && PINNED_URL_GET_PASSWORD
  && PINNED_URL_GET_HOSTNAME
  && PINNED_URL_GET_HOST
  && PINNED_URL_GET_PORT
  && PINNED_URL_GET_PATHNAME
  && PINNED_URL_GET_SEARCH
  && PINNED_URL_GET_HASH,
);

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

// Pinned native lifecycle functions (descriptor values only). Used via Reflect.apply
// so hostile instance accessors / proxy get traps are never executed.
const PINNED_EE_PROTOTYPE = EventEmitter && EventEmitter.prototype ? EventEmitter.prototype : null;
const PINNED_READABLE_PROTOTYPE = stream.Readable && stream.Readable.prototype
  ? stream.Readable.prototype
  : null;
const PINNED_OUTGOING_MESSAGE = http.OutgoingMessage || null;
const PINNED_OUTGOING_MESSAGE_PROTOTYPE = PINNED_OUTGOING_MESSAGE
  && PINNED_OUTGOING_MESSAGE.prototype
  ? PINNED_OUTGOING_MESSAGE.prototype
  : null;
const PINNED_CLIENT_REQUEST = http.ClientRequest || null;
const PINNED_CLIENT_REQUEST_PROTOTYPE = PINNED_CLIENT_REQUEST
  && PINNED_CLIENT_REQUEST.prototype
  ? PINNED_CLIENT_REQUEST.prototype
  : null;

function pinProtoMethod(proto, name) {
  try {
    if (!proto) return null;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    if (typeof descriptor.value !== 'function') return null;
    if (descriptor.get || descriptor.set) return null;
    return descriptor.value;
  } catch {
    return null;
  }
}

const PINNED_EE_ON = pinProtoMethod(PINNED_EE_PROTOTYPE, 'on');
const PINNED_EE_ONCE = pinProtoMethod(PINNED_EE_PROTOTYPE, 'once');
const PINNED_EE_EMIT = pinProtoMethod(PINNED_EE_PROTOTYPE, 'emit');
const PINNED_READABLE_ON = pinProtoMethod(PINNED_READABLE_PROTOTYPE, 'on');
const PINNED_READABLE_DESTROY = pinProtoMethod(PINNED_READABLE_PROTOTYPE, 'destroy');
const PINNED_OUTGOING_END = pinProtoMethod(PINNED_OUTGOING_MESSAGE_PROTOTYPE, 'end');
const PINNED_CLIENT_REQUEST_DESTROY = pinProtoMethod(PINNED_CLIENT_REQUEST_PROTOTYPE, 'destroy');
const PINNED_CLIENT_REQUEST_ONCE = pinProtoMethod(PINNED_CLIENT_REQUEST_PROTOTYPE, 'once')
  || PINNED_EE_ONCE;

/** Allowlist of native functions safe to inherit via prototype descriptor walk. */
const PINNED_SAFE_LIFECYCLE_FNS = new Set(
  [
    PINNED_EE_ON,
    PINNED_EE_ONCE,
    PINNED_EE_EMIT,
    PINNED_READABLE_ON,
    PINNED_READABLE_DESTROY,
    PINNED_OUTGOING_END,
    PINNED_CLIENT_REQUEST_DESTROY,
    PINNED_CLIENT_REQUEST_ONCE,
  ].filter((fn) => typeof fn === 'function'),
);

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
/**
 * Module-private messages-delta outcomes (continuation 410 → cursor_gone).
 * Separate from GRAPH_STAGES so forged public errors cannot classify.
 */
const MESSAGES_DELTA_OUTCOMES = new WeakMap();

/**
 * @param {string} [stage]
 * @param {{ failureMessage: string, failureCode: string, errorName: string }} brand
 * @param {{ deltaOutcome?: string }} [extra]
 */
function failure(stage, brand = {
  failureMessage: FAILURE_MESSAGE,
  failureCode: FAILURE_CODE,
  errorName: COUNT_ERROR_NAME,
}, extra) {
  let graphStage = 'request_error';
  if (typeof stage === 'string' && GRAPH_STAGE_SET.has(stage) && stage !== 'success') {
    graphStage = stage;
  }
  const error = new Error(brand.failureMessage);
  Object.defineProperty(error, 'name', { value: brand.errorName });
  Object.defineProperty(error, 'code', { value: brand.failureCode, enumerable: true });
  // Stage lives only in the private brand — never as a readable error property.
  STAGED_FAILURES.set(error, graphStage);
  if (extra
      && typeof extra.deltaOutcome === 'string'
      && MESSAGES_DELTA_OUTCOMES_ALLOWED.includes(extra.deltaOutcome)) {
    MESSAGES_DELTA_OUTCOMES.set(error, extra.deltaOutcome);
  }
  return Object.freeze(error);
}

const COUNT_FAILURE_BRAND = Object.freeze({
  failureMessage: FAILURE_MESSAGE,
  failureCode: FAILURE_CODE,
  errorName: COUNT_ERROR_NAME,
});
const IMMUTABLEID_FAILURE_BRAND = Object.freeze({
  failureMessage: IMMUTABLEID_PAGE_FAILURE_MESSAGE,
  failureCode: IMMUTABLEID_PAGE_FAILURE_CODE,
  errorName: IMMUTABLEID_PAGE_ERROR_NAME,
});
const MESSAGES_DELTA_FAILURE_BRAND = Object.freeze({
  failureMessage: MESSAGES_DELTA_PAGE_FAILURE_MESSAGE,
  failureCode: MESSAGES_DELTA_PAGE_FAILURE_CODE,
  errorName: MESSAGES_DELTA_PAGE_ERROR_NAME,
});

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

/**
 * Safe reader for messages-delta private outcomes (continuation HTTP 410 only).
 * Returns `'cursor_gone'` only for transport-branded continuation-410 failures.
 * Forged public errors (same code/message/name) cannot classify.
 * Never reads attacker-controlled properties on the error object.
 */
function readTrustedMessagesDeltaOutcome(error) {
  try {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
      return null;
    }
    const outcome = MESSAGES_DELTA_OUTCOMES.get(error);
    if (typeof outcome !== 'string' || !MESSAGES_DELTA_OUTCOMES_ALLOWED.includes(outcome)) {
      return null;
    }
    return outcome;
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

/**
 * Secure response headers access:
 * 1) Proxy response surfaces rejected (undefined → content-type fail upstream).
 * 2) Genuine pinned IncomingMessage → Reflect.apply only the module-init native getter.
 * 3) Own-data plain/mock path → ownData only.
 * 4) Proxy-backed headers values rejected via pinned isProxy BEFORE any
 *    descriptor/key/property operation on the headers object (ownData/gOPD/ownKeys
 *    on a Proxy would execute traps). isProxy throw / missing pin fail closed.
 * Never walks attacker/custom prototype getters for headers.
 */
function readResponseHeaders(response) {
  try {
    if (isProxySurface(response)) return undefined;
    let headers;
    if (isPinnedIncomingMessage(response)) {
      headers = Reflect.apply(PINNED_HEADERS_GET, response, []);
    } else {
      headers = ownData(response, 'headers');
    }
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
      return undefined;
    }
    // Reject proxy-backed headers before any later ownData/gOPD/key op on them.
    if (isProxySurface(headers)) return undefined;
    return headers;
  } catch {
    return undefined;
  }
}

const LIFECYCLE_METHOD_NAMES = Object.freeze(['on', 'once', 'end', 'destroy', 'headers']);

/**
 * True when the surface defines own accessors (or non-value descriptors) on
 * lifecycle names. Native EventEmitter.once/on read `this.on` via [[Get]]; own
 * hostile getters must be rejected before any native method is applied.
 * Uses getOwnPropertyDescriptor only — never invokes getters.
 */
function surfaceHasHostileLifecycleAccessors(surface) {
  try {
    if (surface === null || (typeof surface !== 'object' && typeof surface !== 'function')) {
      return true;
    }
    for (const name of LIFECYCLE_METHOD_NAMES) {
      const descriptor = Object.getOwnPropertyDescriptor(surface, name);
      if (!descriptor) continue;
      if (descriptor.get || descriptor.set
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Resolve a lifecycle method without executing hostile accessors or proxy traps.
 * Order: reject proxy → reject own hostile accessors on lifecycle names →
 * own-data function descriptor → safe pinned native via prototype descriptor
 * walk (never instance [[Get]]).
 */
function resolveLifecycleMethod(surface, name) {
  try {
    if (surface === null || (typeof surface !== 'object' && typeof surface !== 'function')) {
      return null;
    }
    if (isProxySurface(surface)) return null;
    if (surfaceHasHostileLifecycleAccessors(surface)) return null;
    const ownDescriptor = Object.getOwnPropertyDescriptor(surface, name);
    if (ownDescriptor) {
      if (Object.prototype.hasOwnProperty.call(ownDescriptor, 'value')
          && typeof ownDescriptor.value === 'function'
          && !ownDescriptor.get
          && !ownDescriptor.set) {
        return ownDescriptor.value;
      }
      // Own non-function data — do not use.
      return null;
    }
    let proto = Object.getPrototypeOf(surface);
    while (proto && proto !== Object.prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (descriptor) {
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')
            || typeof descriptor.value !== 'function'
            || descriptor.get
            || descriptor.set) {
          return null;
        }
        if (PINNED_SAFE_LIFECYCLE_FNS.has(descriptor.value)) {
          return descriptor.value;
        }
        return null;
      }
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  } catch {
    return null;
  }
}

function applyLifecycleMethod(surface, name, args) {
  const fn = resolveLifecycleMethod(surface, name);
  if (typeof fn !== 'function') return false;
  Reflect.apply(fn, surface, args);
  return true;
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
 * Reflect.apply a module-init-pinned URL.prototype getter. Never uses live
 * property reads (immune to post-load prototype monkeypatches).
 * @param {object} url
 * @param {function|null} getter
 * @returns {unknown}
 */
function applyPinnedUrlGetter(url, getter) {
  if (typeof getter !== 'function') {
    throw new Error('pinned_url_getter_unavailable');
  }
  return Reflect.apply(getter, url, []);
}

/**
 * Construct a URL via the module-init-pinned constructor only.
 * Rejects proxy constructors / proxy inputs via module-init-pinned isProxy
 * before construction. Never touches ambient global URL.
 * Fail closed when pinned intrinsics are unavailable.
 *
 * @param {unknown} value
 * @returns {object|null}
 */
function constructPinnedUrl(value) {
  try {
    if (!PINNED_URL_INTRINSICS_READY) return null;
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return null;
    // Reject a proxied constructor before construction (trap zero-hit).
    try {
      if (Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [PINNED_URL]) === true) {
        return null;
      }
    } catch {
      return null;
    }
    // Reject proxy inputs before construction (primitives are never proxies).
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      try {
        if (Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true) {
          return null;
        }
      } catch {
        return null;
      }
    }
    let url;
    try {
      url = Reflect.construct(PINNED_URL, [value]);
    } catch {
      return null;
    }
    // Constructed instance must not be a Proxy.
    try {
      if (Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [url]) === true) {
        return null;
      }
    } catch {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Read the exact URL components needed for nextLink validation via pinned getters.
 * @param {object} url
 * @returns {{protocol:string,username:string,password:string,hostname:string,host:string,port:string,pathname:string,search:string,hash:string}|null}
 */
function readPinnedUrlComponents(url) {
  try {
    if (!PINNED_URL_INTRINSICS_READY || url === null || typeof url !== 'object') {
      return null;
    }
    if (isProxySurface(url)) return null;
    const protocol = applyPinnedUrlGetter(url, PINNED_URL_GET_PROTOCOL);
    const username = applyPinnedUrlGetter(url, PINNED_URL_GET_USERNAME);
    const password = applyPinnedUrlGetter(url, PINNED_URL_GET_PASSWORD);
    const hostname = applyPinnedUrlGetter(url, PINNED_URL_GET_HOSTNAME);
    const host = applyPinnedUrlGetter(url, PINNED_URL_GET_HOST);
    const port = applyPinnedUrlGetter(url, PINNED_URL_GET_PORT);
    const pathname = applyPinnedUrlGetter(url, PINNED_URL_GET_PATHNAME);
    const search = applyPinnedUrlGetter(url, PINNED_URL_GET_SEARCH);
    const hash = applyPinnedUrlGetter(url, PINNED_URL_GET_HASH);
    if (typeof protocol !== 'string'
        || typeof username !== 'string'
        || typeof password !== 'string'
        || typeof hostname !== 'string'
        || typeof host !== 'string'
        || typeof port !== 'string'
        || typeof pathname !== 'string'
        || typeof search !== 'string'
        || typeof hash !== 'string') {
      return null;
    }
    return {
      protocol,
      username,
      password,
      hostname,
      host,
      port,
      pathname,
      search,
      hash,
    };
  } catch {
    return null;
  }
}

/**
 * Validate Graph @odata.nextLink without following, persisting, returning, or logging it.
 * HTTPS only; host exactly graph.microsoft.com; no credentials/fragment; messages collection path.
 * Single-page path only accepts (never follows). Bounded-catchup re-validates strictly before follow.
 * Uses module-init-pinned URL constructor + prototype getters only (no ambient global URL /
 * live property reads).
 */
function isValidGraphMessagesNextLink(value) {
  try {
    if (typeof value !== 'string'
        || value.length < 1
        || value.length > STRING_LIMIT
        || hasUnpairedSurrogate(value)) {
      return false;
    }
    if (!PINNED_URL_INTRINSICS_READY) return false;
    const url = constructPinnedUrl(value);
    if (!url) return false;
    const parts = readPinnedUrlComponents(url);
    if (!parts) return false;
    if (parts.protocol !== 'https:') return false;
    if (parts.hostname !== HOST) return false;
    if (parts.username !== '' || parts.password !== '') return false;
    if (parts.hash !== '') return false;
    if (parts.port !== '' && parts.port !== '443') return false;
    if (!MESSAGES_PATH_ME.test(parts.pathname) && !MESSAGES_PATH_USER.test(parts.pathname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse catch-up continuation query on both raw and decoded surfaces.
 * Rejects: duplicate decoded keys, malformed escapes, empty segments, and
 * encoded-key confusion for required base keys ($top / $select must appear as
 * exact raw literals — not %24top / mixed case / re-encoded aliases).
 *
 * @param {string} search url.search (may include leading ?)
 * @returns {{ok:true,params:Map<string,string>}|{ok:false}}
 */
function parseCatchupQueryParamsStrict(search) {
  try {
    if (typeof search !== 'string') return { ok: false };
    const raw = search.startsWith('?') ? search.slice(1) : search;
    const params = new Map();
    if (raw.length === 0) return { ok: true, params };
    const parts = raw.split('&');
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part.length < 1) return { ok: false };
      const eq = part.indexOf('=');
      const keyEnc = eq === -1 ? part : part.slice(0, eq);
      const valEnc = eq === -1 ? '' : part.slice(eq + 1);
      if (keyEnc.length < 1) return { ok: false };
      let key;
      let val;
      try {
        key = decodeURIComponent(keyEnc.replace(/\+/g, ' '));
        val = decodeURIComponent(valEnc.replace(/\+/g, ' '));
      } catch {
        return { ok: false };
      }
      if (typeof key !== 'string' || key.length < 1 || hasUnpairedSurrogate(key)) {
        return { ok: false };
      }
      if (typeof val !== 'string' || hasUnpairedSurrogate(val)) {
        return { ok: false };
      }
      // Required base keys must appear as exact raw literals (case-sensitive).
      // Encoded aliases (%24top) or case variants ($Top) are rejected.
      if (key === '$top' || key === '$select') {
        if (keyEnc !== key) return { ok: false };
      } else if (keyEnc !== key) {
        // Opaque continuation key: reject encoded forms that decode to a
        // different surface than the raw key (encoded-key confusion).
        // Allow only when raw keyEnc equals decoded key (no percent in key).
        return { ok: false };
      }
      if (params.has(key)) return { ok: false };
      params.set(key, val);
    }
    return { ok: true, params };
  } catch {
    return { ok: false };
  }
}

/**
 * Strict nextLink validator for bounded-catchup follow (before any request).
 * Rules: primitive string + bounded length; module-init-pinned URL parse + getters;
 * https; no user/pass/hash; exact graph.microsoft.com host/port; exact same
 * /v1.0/users/{encoded uuid}/messages path (no path confusion); exact
 * case-sensitive required continuation query keyset = original immutable inbox
 * keys ($top, $select) with exact required values plus exactly one nonempty
 * bounded opaque continuation param; every canonical key exactly once; reject
 * absence, arbitrary sole opaque keys, case variants, duplicates, changed
 * values, extras; validate raw/decoded surfaces (no encoded-key confusion).
 * Returns requestPath for follow + canonicalIdentity for loop detection
 * (exact bound mailbox path + decoded continuation + invariant query values).
 *
 * @param {unknown} value
 * @param {string} providerMailboxId canonical UUID
 * @returns {{ok:true,requestPath:string,canonicalIdentity:string}|{ok:false}}
 */
function validateCatchupFollowNextLink(value, providerMailboxId) {
  try {
    if (typeof value !== 'string'
        || value.length < 1
        || value.length > STRING_LIMIT
        || hasUnpairedSurrogate(value)) {
      return { ok: false };
    }
    if (!PINNED_URL_INTRINSICS_READY) return { ok: false };
    if (typeof providerMailboxId !== 'string' || !UUID_CANON.test(providerMailboxId)) {
      return { ok: false };
    }
    // Reject path-confusion encodings before URL normalization can collapse them.
    if (/\.\.|%2e|%2f|%5c|\\/i.test(value)) {
      return { ok: false };
    }
    const url = constructPinnedUrl(value);
    if (!url) return { ok: false };
    const parts = readPinnedUrlComponents(url);
    if (!parts) return { ok: false };
    if (parts.protocol !== 'https:') return { ok: false };
    if (parts.hostname !== HOST) return { ok: false };
    if (parts.host !== HOST && parts.host !== `${HOST}:443`) return { ok: false };
    if (parts.username !== '' || parts.password !== '') return { ok: false };
    if (parts.hash !== '') return { ok: false };
    if (parts.port !== '' && parts.port !== '443') return { ok: false };
    const expectedPath = `/v1.0/users/${encodeURIComponent(providerMailboxId)}/messages`;
    if (parts.pathname !== expectedPath) return { ok: false };
    // Exact path must also appear as a contiguous substring of the raw URL
    // (defeats normalization that collapses /users/x/../x/messages).
    if (!value.includes(expectedPath)) return { ok: false };
    const parsed = parseCatchupQueryParamsStrict(parts.search);
    if (!parsed.ok) return { ok: false };
    const params = parsed.params;

    // Exact required keyset: $top + $select + exactly one literal $skiptoken.
    // Every canonical key exactly once; no absence, substitutions, or extras.
    if (params.size !== 3) return { ok: false };
    if (!params.has('$top') || !params.has('$select') || !params.has('$skiptoken')) {
      return { ok: false };
    }
    const topVal = params.get('$top');
    const selectVal = params.get('$select');
    if (topVal !== CATCHUP_ORIGINAL_TOP) return { ok: false };
    if (selectVal !== CATCHUP_ORIGINAL_SELECT) return { ok: false };

    const opaqueKey = '$skiptoken';
    const opaqueVal = params.get(opaqueKey);
    if (typeof opaqueVal !== 'string'
        || opaqueVal.length < 1
        || opaqueVal.length > STRING_LIMIT
        || hasUnpairedSurrogate(opaqueVal)) {
      return { ok: false };
    }

    const requestPath = `${parts.pathname}${parts.search}`;
    if (typeof requestPath !== 'string'
        || requestPath.length < 1
        || requestPath.length > STRING_LIMIT) {
      return { ok: false };
    }

    // Canonical continuation identity: bound mailbox path + decoded invariant
    // query values + decoded opaque continuation. Semantically equivalent
    // percent encodings / query orderings collide on this identity.
    const canonicalIdentity = [
      expectedPath,
      `$top=${topVal}`,
      `$select=${selectVal}`,
      `${opaqueKey}=${opaqueVal}`,
    ].join('\0');

    return { ok: true, requestPath, canonicalIdentity };
  } catch {
    return { ok: false };
  }
}

function envelopeIdentityKey(tuple) {
  return `${tuple.provider}\0${tuple.provider_mailbox_id}\0${tuple.provider_message_id}`;
}

/**
 * Canonical sort + within-batch identity dedupe (same rules as inbound batch processor).
 * Deterministic selection for maxMessages: first N unique after sort (newest-first +
 * identity ASC). observed_count counts only rows whose identity is among the accepted
 * unique set (duplicates of accepted identities count; identities past the bound do not).
 *
 * @param {object[]} rawEnvelopes
 * @param {number} maxMessages
 * @returns {{envelopes:object[],observed_count:number,unique_count:number,duplicate_count:number,truncated_by_messages:boolean}}
 */
function selectBoundedCatchupEnvelopes(rawEnvelopes, maxMessages) {
  const sorted = rawEnvelopes.slice().sort(compareInboundEmailEnvelopesForOrder);
  const seen = new Set();
  const uniqueAll = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const id = inboundEmailEnvelopeIdentityTuple(sorted[i]);
    if (!id.ok) {
      return null;
    }
    const key = envelopeIdentityKey(id.value);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueAll.push(sorted[i]);
  }
  const truncatedByMessages = uniqueAll.length > maxMessages;
  const acceptedUnique = truncatedByMessages
    ? uniqueAll.slice(0, maxMessages)
    : uniqueAll;
  const acceptedKeys = new Set();
  for (let i = 0; i < acceptedUnique.length; i += 1) {
    const id = inboundEmailEnvelopeIdentityTuple(acceptedUnique[i]);
    if (!id.ok) return null;
    acceptedKeys.add(envelopeIdentityKey(id.value));
  }
  let observed = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const id = inboundEmailEnvelopeIdentityTuple(sorted[i]);
    if (!id.ok) return null;
    if (acceptedKeys.has(envelopeIdentityKey(id.value))) {
      observed += 1;
    }
  }
  const uniqueCount = acceptedUnique.length;
  const duplicateCount = observed - uniqueCount;
  return {
    envelopes: acceptedUnique,
    observed_count: observed,
    unique_count: uniqueCount,
    duplicate_count: duplicateCount,
    truncated_by_messages: truncatedByMessages,
  };
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
  const loaded = loadClassifiedMessageEnvelopePage(bodyText);
  if (loaded.stage === 'success') {
    return Object.freeze({ stage: 'success', count: loaded.count });
  }
  return Object.freeze({ stage: loaded.stage });
}

/**
 * Module-private parse + classify for the single network owner.
 * On success includes the strict-parsed page object for immediate internal map.
 * Never exported — raw validated pages must not escape this module.
 *
 * @returns {{stage:string, count?:number, page?:object}}
 */
function loadClassifiedMessageEnvelopePage(bodyText) {
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
  const classified = classifyParsedMessageEnvelopeList(parsed);
  if (!classified || classified.stage !== 'success' || typeof classified.count !== 'number') {
    return Object.freeze({
      stage: classified && typeof classified.stage === 'string'
        ? classified.stage
        : 'json_invalid',
    });
  }
  return Object.freeze({
    stage: 'success',
    count: classified.count,
    page: parsed,
  });
}

/**
 * Private Prefer-ImmutableId success path: map a validated page body to fresh
 * frozen canonical envelopes. Authenticated provenance is implied only by this
 * pinned HTTP path — no public mint/capability. Page is not returned.
 *
 * When `includeNextLink` is true (bounded-catchup internal only), also returns the
 * descriptor-safe own-data `@odata.nextLink` string or null — never followed here.
 *
 * @returns {{ok:true, envelopes:object[], nextLink?:string|null}|{ok:false, stage:string}}
 */
function mapSuccessBodyToImmutableIdEnvelopes(bodyText, providerMailboxId, includeNextLink) {
  const loaded = loadClassifiedMessageEnvelopePage(bodyText);
  if (!loaded || loaded.stage !== 'success' || typeof loaded.count !== 'number' || !loaded.page) {
    return Object.freeze({
      ok: false,
      stage: loaded && typeof loaded.stage === 'string' ? loaded.stage : 'json_invalid',
    });
  }
  if (loaded.count > TOP_MAX) {
    return Object.freeze({ ok: false, stage: 'top_shape_invalid' });
  }
  const rows = ownData(loaded.page, 'value');
  if (!Array.isArray(rows) || rows.length !== loaded.count) {
    return Object.freeze({ ok: false, stage: 'top_shape_invalid' });
  }
  const envelopes = [];
  for (let i = 0; i < rows.length; i += 1) {
    const mapped = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: PROVIDER_ID,
      provider_mailbox_id: providerMailboxId,
      row: rows[i],
    });
    if (!mapped || mapped.ok !== true) {
      return Object.freeze({ ok: false, stage: 'row_value_invalid' });
    }
    // Provider/mailbox identity must match the authority-bound request input.
    if (mapped.value.provider !== PROVIDER_ID
        || mapped.value.provider_mailbox_id !== providerMailboxId) {
      return Object.freeze({ ok: false, stage: 'row_value_invalid' });
    }
    envelopes.push(mapped.value);
  }
  envelopes.sort(compareInboundEmailEnvelopesForOrder);
  if (includeNextLink === true) {
    let nextLink = null;
    if (Object.prototype.hasOwnProperty.call(loaded.page, NEXT_LINK_KEY)) {
      const raw = ownData(loaded.page, NEXT_LINK_KEY);
      // Classifier already validated loosely; surface only a primitive string.
      if (typeof raw !== 'string') {
        return Object.freeze({ ok: false, stage: 'top_shape_invalid' });
      }
      nextLink = raw;
    }
    return Object.freeze({
      ok: true,
      envelopes: Object.freeze(envelopes),
      nextLink,
    });
  }
  return Object.freeze({ ok: true, envelopes: Object.freeze(envelopes) });
}

/**
 * Build exact ImmutableId list path for a canonical provider mailbox UUID.
 * Path-encodes the UUID segment; rejects non-canonical ids (no email/UPN/me).
 *
 * @param {string} providerMailboxId
 * @returns {string|null}
 */
function buildImmutableIdUserMessagesPath(providerMailboxId) {
  if (typeof providerMailboxId !== 'string' || !UUID_CANON.test(providerMailboxId)) {
    return null;
  }
  // encodeURIComponent is identity for canonical UUID charset; still required so
  // any future charset expansion cannot inject path separators.
  return `/v1.0/users/${encodeURIComponent(providerMailboxId)}/messages?${SELECT_QUERY}`;
}

/**
 * Exact initial messages-delta path for a canonical provider mailbox UUID.
 * `$top=5` + fixed `$select` only — no filter/order/expand/body/me.
 *
 * @param {string} providerMailboxId
 * @returns {string|null}
 */
function buildMessagesDeltaInitialPath(providerMailboxId) {
  if (typeof providerMailboxId !== 'string' || !UUID_CANON.test(providerMailboxId)) {
    return null;
  }
  return `/v1.0/users/${encodeURIComponent(providerMailboxId)}/mailFolders/inbox/messages/delta?${SELECT_QUERY}`;
}

/** v2 activation-only bootstrap. Watermark is factory-owned and query-fixed. */
function buildMessagesDeltaFromNowInitialPath(providerMailboxId, activationWatermark) {
  if (typeof providerMailboxId !== 'string' || !UUID_CANON.test(providerMailboxId)
      || typeof activationWatermark !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(activationWatermark)) return null;
  try {
    if (new Date(activationWatermark).toISOString() !== activationWatermark) return null;
  } catch { return null; }
  const filter = encodeURIComponent(`receivedDateTime ge ${activationWatermark}`);
  return `/v1.0/users/${encodeURIComponent(providerMailboxId)}/mailFolders/inbox/messages/delta?${SELECT_QUERY}&$filter=${filter}`;
}

/**
 * Convert a PR408-validated absolute messages-delta cursor URL into the exact
 * request path+query target. Appends nothing.
 *
 * @param {string} cursorUrl
 * @returns {string|null}
 */
function messagesDeltaCursorUrlToRequestPath(cursorUrl) {
  try {
    if (typeof cursorUrl !== 'string' || cursorUrl.length < 1) return null;
    const url = constructPinnedUrl(cursorUrl);
    if (!url) return null;
    const parts = readPinnedUrlComponents(url);
    if (!parts) return null;
    if (parts.pathname.length < 1) return null;
    const requestPath = `${parts.pathname}${parts.search}`;
    if (typeof requestPath !== 'string' || requestPath.length < 1) return null;
    return requestPath;
  } catch {
    return null;
  }
}

function readImmutableIdPageInput(input) {
  if (!exactPlainData(input, ['accessToken', 'provider_mailbox_id'])) return null;
  const token = ownData(input, 'accessToken');
  if (typeof token !== 'string' || token.length < 1 || token.length > TOKEN_LIMIT
      || !/^[\x21-\x7e]+$/.test(token)) {
    return null;
  }
  const mailbox = ownData(input, 'provider_mailbox_id');
  // Exact canonical UUID only — matches authority.providerMailboxId (resource id).
  // Email/UPN/`me` are rejected so transport cannot stamp non-authority labels.
  if (typeof mailbox !== 'string' || !UUID_CANON.test(mailbox)) {
    return null;
  }
  if (buildImmutableIdUserMessagesPath(mailbox) === null) {
    return null;
  }
  return { accessToken: token, provider_mailbox_id: mailbox };
}

/**
 * Exact own-data input for messages-delta initial page.
 * Same token/mailbox contract as ImmutableId page.
 */
function readMessagesDeltaInitialInput(input) {
  if (!exactPlainData(input, ['accessToken', 'provider_mailbox_id'])) return null;
  const token = ownData(input, 'accessToken');
  if (typeof token !== 'string' || token.length < 1 || token.length > TOKEN_LIMIT
      || !/^[\x21-\x7e]+$/.test(token)) {
    return null;
  }
  const mailbox = ownData(input, 'provider_mailbox_id');
  if (typeof mailbox !== 'string' || !UUID_CANON.test(mailbox)) {
    return null;
  }
  if (buildMessagesDeltaInitialPath(mailbox) === null) {
    return null;
  }
  return { accessToken: token, provider_mailbox_id: mailbox };
}

/**
 * Exact own-data input for messages-delta continuation page.
 * Validates cursor via PR408 `validateMessagesDeltaCursorUrl` before any network.
 * Immediately after strict validation, returns one mutable path owner
 * `{ value: path+query }` (validated provider URL path+query; append nothing).
 * No immutable requestPath/cursor_url string fields on the result — caller input
 * may still own its primitive cursor_url; transport holds only the owner object.
 */
function readMessagesDeltaContinuationInput(input) {
  if (!exactPlainData(input, [
    'accessToken',
    'provider_mailbox_id',
    'cursor_kind',
    'cursor_url',
  ])) {
    return null;
  }
  const token = ownData(input, 'accessToken');
  if (typeof token !== 'string' || token.length < 1 || token.length > TOKEN_LIMIT
      || !/^[\x21-\x7e]+$/.test(token)) {
    return null;
  }
  const mailbox = ownData(input, 'provider_mailbox_id');
  if (typeof mailbox !== 'string' || !UUID_CANON.test(mailbox)) {
    return null;
  }
  const cursorKind = ownData(input, 'cursor_kind');
  if (typeof cursorKind !== 'string' || !MESSAGES_DELTA_CURSOR_KINDS.includes(cursorKind)) {
    return null;
  }
  const cursorUrl = ownData(input, 'cursor_url');
  if (typeof cursorUrl !== 'string') {
    return null;
  }
  // Strict PR408 semantics — wrong host/path/mailbox/token-kind → zero network.
  const validated = validateMessagesDeltaCursorUrl(cursorUrl, {
    providerMailboxId: mailbox,
    cursorKind,
  });
  if (!validated || validated.ok !== true || typeof validated.value !== 'string') {
    return null;
  }
  const requestPath = messagesDeltaCursorUrlToRequestPath(validated.value);
  if (requestPath === null) {
    return null;
  }
  // Single mutable continuation-path owner created immediately after validation.
  // No parallel immutable string aliases (requestPath/cursor_url) on this object.
  return {
    accessToken: token,
    provider_mailbox_id: mailbox,
    continuationPathOwner: { value: requestPath },
  };
}

/**
 * Classify a messages-delta deleted row: exact `{ id, '@removed': { reason: 'deleted' } }`.
 * Rejects mixed normal fields, malformed removed, wrong reason.
 *
 * @returns {'ok'|'row_keyset_invalid'|'row_value_invalid'}
 */
function classifyMessagesDeltaDeletedRow(row) {
  try {
    if (!isPlainOwnDataObject(row)) return 'row_keyset_invalid';
    // Mixed normal+deleted fields (e.g. subject + @removed) → keyset invalid.
    if (!exactPlainData(row, MESSAGES_DELTA_DELETED_ROW_KEYS)) {
      // If @removed is present with other keys, still keyset invalid (not normal row).
      return 'row_keyset_invalid';
    }
    if (!requiredBoundedString(ownData(row, 'id'))) return 'row_value_invalid';
    const removed = ownData(row, MESSAGES_DELTA_REMOVED_KEY);
    if (!isPlainOwnDataObject(removed)
        || !exactPlainData(removed, MESSAGES_DELTA_REMOVED_OBJECT_KEYS)) {
      return 'row_value_invalid';
    }
    if (ownData(removed, 'reason') !== MESSAGES_DELTA_REMOVED_REASON) {
      return 'row_value_invalid';
    }
    return 'ok';
  } catch {
    return 'row_keyset_invalid';
  }
}

/**
 * Map validated messages-delta page body → frozen DTO.
 * Exact one nextLink XOR deltaLink mandatory; total rows ≤5; zero rows valid.
 * Normal rows → Mail.ReadBasic mapper (ImmutableId-owned path). Deleted → tombstone.
 * Any invalid row / identity collision → no partial output.
 *
 * @returns {{ok:true, dto:object}|{ok:false, stage:string}}
 */
function mapSuccessBodyToMessagesDeltaPage(bodyText, providerMailboxId) {
  if (typeof bodyText !== 'string') {
    return Object.freeze({ ok: false, stage: 'utf8_invalid' });
  }
  if (Buffer.byteLength(bodyText, 'utf8') > RESPONSE_CAP_BYTES) {
    return Object.freeze({ ok: false, stage: 'response_too_large' });
  }
  if (bodyText.includes('\ufffd')) {
    return Object.freeze({ ok: false, stage: 'utf8_invalid' });
  }
  let parsed;
  try {
    parsed = parseStrictJson(bodyText);
  } catch {
    return Object.freeze({ ok: false, stage: 'json_invalid' });
  }
  try {
    if (!isPlainOwnDataObject(parsed)) {
      return Object.freeze({ ok: false, stage: 'top_shape_invalid' });
    }
    const keys = Reflect.ownKeys(parsed);
    if (keys.some((key) => typeof key !== 'string' || DANGEROUS_KEYS.has(key))) {
      return Object.freeze({ ok: false, stage: 'top_shape_invalid' });
    }
    let allowed = false;
    for (const candidate of DELTA_TOP_ALLOWED_EXACT) {
      if (keysMatchExactSet(keys, candidate)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return Object.freeze({ ok: false, stage: 'top_shape_invalid' });
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
      return Object.freeze({ ok: false, stage: 'top_shape_invalid' });
    }
    // Discard @odata.context after validation (never retain/return).
    if (Object.prototype.hasOwnProperty.call(parsed, '@odata.context')) {
      const context = ownData(parsed, '@odata.context');
      if (typeof context !== 'string' || context.length < 1 || context.length > STRING_LIMIT
          || hasUnpairedSurrogate(context)) {
        return Object.freeze({ ok: false, stage: 'top_shape_invalid' });
      }
    }

    const hasNext = Object.prototype.hasOwnProperty.call(parsed, NEXT_LINK_KEY);
    const hasDelta = Object.prototype.hasOwnProperty.call(parsed, DELTA_LINK_KEY);
    // Exact one XOR mandatory.
    if (hasNext === hasDelta) {
      return Object.freeze({ ok: false, stage: 'top_shape_invalid' });
    }
    const successorKind = hasNext ? 'nextLink' : 'deltaLink';
    const linkKey = hasNext ? NEXT_LINK_KEY : DELTA_LINK_KEY;
    const rawLink = ownData(parsed, linkKey);
    if (typeof rawLink !== 'string') {
      return Object.freeze({ ok: false, stage: 'top_shape_invalid' });
    }
    // Strict PR408 successor validation — never weaken.
    const linkCheck = validateMessagesDeltaCursorUrl(rawLink, {
      providerMailboxId,
      cursorKind: successorKind,
    });
    if (!linkCheck || linkCheck.ok !== true || typeof linkCheck.value !== 'string') {
      return Object.freeze({ ok: false, stage: 'top_shape_invalid' });
    }
    const successorCursor = Object.freeze({
      cursor_kind: successorKind,
      cursor_url: linkCheck.value,
    });
    // Key order exact for successor.
    if (Object.keys(successorCursor).length !== MESSAGES_DELTA_SUCCESSOR_KEYS.length
        || Object.keys(successorCursor).some((k, i) => k !== MESSAGES_DELTA_SUCCESSOR_KEYS[i])) {
      return Object.freeze({ ok: false, stage: 'top_shape_invalid' });
    }

    const rows = ownData(parsed, 'value');
    if (!Array.isArray(rows) || rows.length > TOP_MAX) {
      return Object.freeze({ ok: false, stage: 'top_shape_invalid' });
    }

    const envelopes = [];
    const tombstones = [];
    const seenIds = new Set();

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!isPlainOwnDataObject(row)) {
        return Object.freeze({ ok: false, stage: 'row_keyset_invalid' });
      }
      const rowKeys = Reflect.ownKeys(row);
      if (rowKeys.some((k) => typeof k !== 'string' || DANGEROUS_KEYS.has(k))) {
        return Object.freeze({ ok: false, stage: 'row_keyset_invalid' });
      }
      const hasRemoved = Object.prototype.hasOwnProperty.call(row, MESSAGES_DELTA_REMOVED_KEY);

      if (hasRemoved) {
        const delStage = classifyMessagesDeltaDeletedRow(row);
        if (delStage !== 'ok') {
          return Object.freeze({ ok: false, stage: delStage });
        }
        const messageId = ownData(row, 'id');
        if (seenIds.has(messageId)) {
          return Object.freeze({ ok: false, stage: 'row_value_invalid' });
        }
        seenIds.add(messageId);
        const tombstone = Object.freeze({
          provider: PROVIDER_ID,
          provider_mailbox_id: providerMailboxId,
          provider_message_id: messageId,
        });
        if (Object.keys(tombstone).length !== MESSAGES_DELTA_TOMBSTONE_KEYS.length
            || Object.keys(tombstone).some((k, j) => k !== MESSAGES_DELTA_TOMBSTONE_KEYS[j])) {
          return Object.freeze({ ok: false, stage: 'row_value_invalid' });
        }
        tombstones.push(tombstone);
        continue;
      }

      // Normal Mail.ReadBasic row (optional validated/discarded etag).
      const rowStage = classifyRow(row);
      if (rowStage) {
        return Object.freeze({ ok: false, stage: rowStage });
      }
      const messageId = ownData(row, 'id');
      if (typeof messageId !== 'string' || seenIds.has(messageId)) {
        return Object.freeze({ ok: false, stage: 'row_value_invalid' });
      }
      seenIds.add(messageId);
      const mapped = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
        provider: PROVIDER_ID,
        provider_mailbox_id: providerMailboxId,
        row,
      });
      if (!mapped || mapped.ok !== true) {
        return Object.freeze({ ok: false, stage: 'row_value_invalid' });
      }
      if (mapped.value.provider !== PROVIDER_ID
          || mapped.value.provider_mailbox_id !== providerMailboxId
          || mapped.value.provider_message_id !== messageId) {
        return Object.freeze({ ok: false, stage: 'row_value_invalid' });
      }
      envelopes.push(mapped.value);
    }

    envelopes.sort(compareInboundEmailEnvelopesForOrder);
    const observedCount = rows.length;
    if (envelopes.length + tombstones.length !== observedCount) {
      return Object.freeze({ ok: false, stage: 'row_value_invalid' });
    }

    const dto = {
      envelopes: Object.freeze(envelopes),
      tombstones: Object.freeze(tombstones),
      successor_cursor: successorCursor,
      observed_count: observedCount,
    };
    const dtoKeys = Object.keys(dto);
    if (dtoKeys.length !== MESSAGES_DELTA_PAGE_RESULT_KEYS.length
        || dtoKeys.some((k, i) => k !== MESSAGES_DELTA_PAGE_RESULT_KEYS[i])) {
      return Object.freeze({ ok: false, stage: 'json_invalid' });
    }
    return Object.freeze({ ok: true, dto: Object.freeze(dto) });
  } catch {
    return Object.freeze({ ok: false, stage: 'top_shape_invalid' });
  }
}

/**
 * Validate Graph list JSON and return only a bounded count.
 * Never returns row contents. Rejects pagination/delta links and body fields.
 */
function countBoundedMessageEnvelopes(bodyText) {
  const classified = classifyMessageEnvelopeBody(bodyText);
  return classified.stage === 'success' ? classified.count : null;
}

/**
 * Resolve https/timers deps. Brand selects failure surface (count vs ImmutableId).
 */
function resolveTransportDependencies(dependencies, brand) {
  let requestFn;
  let setTimer;
  let clearTimer;
  if (!dependencies || Object.getPrototypeOf(dependencies) !== Object.prototype) {
    throw failure('request_error', brand);
  }
  const keys = Reflect.ownKeys(dependencies);
  if (keys.some((k) => typeof k !== 'string' || !DEPENDENCY_KEYS.includes(k))) {
    throw failure('request_error', brand);
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
    throw failure('request_error', brand);
  }
  setTimer = setTimeout;
  clearTimer = clearTimeout;
  if (Object.prototype.hasOwnProperty.call(dependencies, 'timers')) {
    const timers = ownData(dependencies, 'timers');
    if (!timers || typeof ownData(timers, 'setTimeout') !== 'function'
        || typeof ownData(timers, 'clearTimeout') !== 'function') {
      throw failure('request_error', brand);
    }
    setTimer = ownData(timers, 'setTimeout');
    clearTimer = ownData(timers, 'clearTimeout');
  }
  return { requestFn, setTimer, clearTimer };
}

/**
 * Single network owner: one-shot GET messages list.
 * mode 'count' → `/me/messages` bounded count health (no Prefer).
 * mode 'immutableid_envelopes' → exact `/users/{canonicalUuid}/messages` + pinned
 * Prefer + private canonical envelopes (token/mailbox mismatch fails at Graph).
 * mode 'immutableid_envelopes_page' → same as envelopes but returns
 * `{ envelopes, nextLink }` for bounded-catchup internal follow only.
 * mode 'messages_delta_page' → exact `/users/{uuid}/messages/delta` (+ Prefer) or
 * continuation path from PR408-validated cursor URL (append nothing). Success DTO
 * `{ envelopes, tombstones, successor_cursor, observed_count }`. When
 * `session.cursorGoneOn410` is true (continuation only), HTTP 410 brands
 * unforgeable `cursor_gone` via `readTrustedMessagesDeltaOutcome`.
 * Optional session.requestPathOverride: full path+query string for ImmutableId
 * bounded-catchup nextLink follow only (still Prefer-pinned; never caller-supplied
 * without prior strict validation). Messages-delta continuation never uses a
 * string override: pass session.continuationPathOwner = `{ value }` only (single
 * mutable capability owner; no destructured/const string path alias).
 * No generic success callback; modes are closed over module-private paths only.
 */
function runDelegatedMessagesRequest(session, input) {
  // Do not destructure requestPathOverride / continuationPathOwner.value —
  // continuation capability must not become an immutable string const alias.
  const {
    requestFn,
    setTimer,
    clearTimer,
    brand,
    mode,
    preferHeader,
    cursorGoneOn410,
  } = session;

  let tokenOwner = null;
  let mailboxId = null;
  let requestPath = GRAPH_REQUEST_CONSTANTS.path;
  const immutableModes = mode === 'immutableid_envelopes' || mode === 'immutableid_envelopes_page';
  const deltaMode = mode === 'messages_delta_page';
  // Continuation-only: path carries $skiptoken/$deltatoken capability. Initial
  // delta path has no cursor capability; count/ImmutableId/bounded paths must
  // keep observable retained path for sibling verifiers.
  const scrubDeltaContinuationPath = deltaMode === true && cursorGoneOn410 === true;
  // Mutable owner ref only for delta continuation — never copy .value into a
  // long-lived string alias that outlives synchronous issueRequest.
  let continuationPathOwner = scrubDeltaContinuationPath
    ? session.continuationPathOwner
    : null;
  if (immutableModes) {
    const parsed = readImmutableIdPageInput(input);
    if (parsed === null) return Promise.reject(failure('request_error', brand));
    // Single mutable token owner only; scrub the parsed copy immediately.
    tokenOwner = parsed.accessToken;
    mailboxId = parsed.provider_mailbox_id;
    try { parsed.accessToken = null; } catch { /* */ }
    // Catch-up nextLink follow: session.requestPathOverride is a plain string
    // (not delta cursor capability custody; path retention unchanged).
    const catchupPathOverride = session.requestPathOverride;
    if (typeof catchupPathOverride === 'string' && catchupPathOverride.length > 0) {
      requestPath = catchupPathOverride;
    } else {
      requestPath = buildImmutableIdUserMessagesPath(mailboxId);
      if (requestPath === null) {
        tokenOwner = null;
        return Promise.reject(failure('request_error', brand));
      }
    }
  } else if (deltaMode) {
    // Token + mailbox already validated by caller factory; input is pre-scrubbed
    // plain data with accessToken + provider_mailbox_id. Continuation path is
    // held only on session.continuationPathOwner (mutable); initial builds path.
    if (!exactPlainData(input, ['accessToken', 'provider_mailbox_id'])) {
      return Promise.reject(failure('request_error', brand));
    }
    const token = ownData(input, 'accessToken');
    const mailbox = ownData(input, 'provider_mailbox_id');
    if (typeof token !== 'string' || token.length < 1 || token.length > TOKEN_LIMIT
        || !/^[\x21-\x7e]+$/.test(token)
        || typeof mailbox !== 'string'
        || !UUID_CANON.test(mailbox)) {
      return Promise.reject(failure('request_error', brand));
    }
    tokenOwner = token;
    mailboxId = mailbox;
    try { input.accessToken = null; } catch { /* */ }
    if (scrubDeltaContinuationPath) {
      // Validate owner presence only — do not copy owner.value into requestPath.
      // issueRequest consumes owner.value synchronously at request construction.
      if (!continuationPathOwner
          || typeof continuationPathOwner.value !== 'string'
          || continuationPathOwner.value.length < 1) {
        tokenOwner = null;
        continuationPathOwner = null;
        return Promise.reject(failure('request_error', brand));
      }
    } else {
      requestPath = session.activationWatermark === null
        ? buildMessagesDeltaInitialPath(mailboxId)
        : buildMessagesDeltaFromNowInitialPath(mailboxId, session.activationWatermark);
      if (requestPath === null) {
        tokenOwner = null;
        return Promise.reject(failure('request_error', brand));
      }
    }
  } else {
    tokenOwner = readAccessToken(input);
    if (tokenOwner === null) return Promise.reject(failure('request_error', brand));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let requestObject;
    let activeResponse;
    let timerHandle;
    let timerAcquired = false;
    let timerCleared = false;

    const fail = (stage) => failure(stage, brand);

    const clearDeadline = () => {
      if (!timerAcquired || timerCleared) return;
      timerCleared = true;
      try { clearTimer(timerHandle); } catch { /* */ }
    };
    const destroyRequest = () => {
      try {
        if (requestObject) applyLifecycleMethod(requestObject, 'destroy', []);
      } catch { /* */ }
    };
    const destroyResponse = () => {
      try {
        if (activeResponse) applyLifecycleMethod(activeResponse, 'destroy', []);
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
        finish(fail('response_surface_invalid'));
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
        // Continuation-only: HTTP 410 → unforgeable private cursor_gone brand.
        // Initial-page 410 stays generic http_status_not_200 (no cursor_gone).
        if (status === 410 && cursorGoneOn410 === true && deltaMode) {
          terminate(failure(
            'http_status_not_200',
            brand,
            { deltaOutcome: MESSAGES_DELTA_OUTCOME_CURSOR_GONE },
          ));
          return;
        }
        if (status !== 200) { terminate(fail('http_status_not_200')); return; }
        if (typeof contentType !== 'string'
            || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
          terminate(fail('content_type_invalid'));
          return;
        }
        const onFn = resolveLifecycleMethod(response, 'on');
        const onceFn = resolveLifecycleMethod(response, 'once');
        if (typeof onFn !== 'function' || typeof onceFn !== 'function') {
          terminate(fail('response_surface_invalid'));
          return;
        }
        const chunks = [];
        let bytes = 0;
        let ended = false;
        Reflect.apply(onFn, response, ['data', (chunk) => {
          if (settled) return;
          if (!Buffer.isBuffer(chunk)) { terminate(fail('stream_invalid')); return; }
          if (chunk.length > RESPONSE_CAP_BYTES - bytes) {
            terminate(fail('response_too_large'));
            return;
          }
          bytes += chunk.length;
          chunks.push(chunk);
        }]);
        Reflect.apply(onceFn, response, ['error', () => terminate(fail('stream_invalid'))]);
        Reflect.apply(onceFn, response, ['aborted', () => terminate(fail('stream_aborted'))]);
        Reflect.apply(onceFn, response, ['close', () => {
          if (!ended) terminate(fail('stream_aborted'));
        }]);
        Reflect.apply(onceFn, response, ['end', () => {
          if (settled) return;
          ended = true;
          try {
            const bodyText = Buffer.concat(chunks, bytes).toString('utf8');
            if (mode === 'immutableid_envelopes' || mode === 'immutableid_envelopes_page') {
              const mapped = mapSuccessBodyToImmutableIdEnvelopes(
                bodyText,
                mailboxId,
                mode === 'immutableid_envelopes_page',
              );
              if (!mapped || mapped.ok !== true || !Array.isArray(mapped.envelopes)) {
                finish(fail(
                  mapped && typeof mapped.stage === 'string' ? mapped.stage : 'json_invalid',
                ));
                return;
              }
              if (mapped.envelopes.length > TOP_MAX) {
                finish(fail('row_value_invalid'));
                return;
              }
              if (mode === 'immutableid_envelopes_page') {
                finish(null, Object.freeze({
                  envelopes: mapped.envelopes,
                  nextLink: mapped.nextLink === undefined ? null : mapped.nextLink,
                }));
                return;
              }
              finish(null, mapped.envelopes);
              return;
            }
            if (mode === 'messages_delta_page') {
              const mapped = mapSuccessBodyToMessagesDeltaPage(bodyText, mailboxId);
              if (!mapped || mapped.ok !== true || !mapped.dto) {
                finish(fail(
                  mapped && typeof mapped.stage === 'string' ? mapped.stage : 'json_invalid',
                ));
                return;
              }
              finish(null, mapped.dto);
              return;
            }
            const classified = classifyMessageEnvelopeBody(bodyText);
            if (!classified || classified.stage !== 'success'
                || typeof classified.count !== 'number') {
              finish(fail(
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
            finish(fail('json_invalid'));
          }
        }]);
      } catch {
        terminate(fail('response_surface_invalid'));
      }
    };

    try {
      timerHandle = setTimer(() => terminate(fail('timeout')), DEADLINE_MS);
      timerAcquired = true;
      if (settled) clearDeadline();
    } catch {
      tokenOwner = null;
      finish(fail('request_error'));
      return;
    }
    if (settled) {
      tokenOwner = null;
      return;
    }

    try {
      // Isolate token/Authorization to this call site; scrub immediately after
      // https.request returns or throws (Node reads options synchronously).
      // Prefer is transport-owned when mode is immutableid_envelopes — never from input.
      // Delta continuation: consume single mutable owner.value into options.path
      // synchronously, then scrub retained options.path + owner.value + local refs
      // so injected https.request cannot keep $skiptoken/$deltatoken.
      (function issueRequest(tokenForRequest) {
        let requestHeaders = {
          Accept: ACCEPT_HEADER,
          Authorization: null,
        };
        if (typeof preferHeader === 'string') {
          requestHeaders.Prefer = preferHeader;
        }
        let authorization = null;
        let requestOptions = null;
        let pathForRequest = null;
        try {
          authorization = ['Bearer', tokenForRequest].join(' ');
          tokenForRequest = null;
          requestHeaders.Authorization = authorization;
          if (scrubDeltaContinuationPath) {
            // Synchronous consume from the single mutable owner — no prior
            // const/let string alias of the capability outside this scope.
            pathForRequest = continuationPathOwner.value;
          } else {
            pathForRequest = requestPath;
          }
          requestOptions = {
            protocol: GRAPH_REQUEST_CONSTANTS.protocol,
            hostname: GRAPH_REQUEST_CONSTANTS.hostname,
            host: GRAPH_REQUEST_CONSTANTS.host,
            port: GRAPH_REQUEST_CONSTANTS.port,
            method: GRAPH_REQUEST_CONSTANTS.method,
            path: pathForRequest,
            agent: GRAPH_REQUEST_CONSTANTS.agent,
            headers: requestHeaders,
          };
          // Non-enumerable owner probe for retained-options custody proofs only.
          // Not JSON-visible; value nulled in the same finally as options.path.
          if (scrubDeltaContinuationPath && continuationPathOwner) {
            try {
              Object.defineProperty(requestOptions, CONTINUATION_PATH_OWNER_PROBE, {
                value: continuationPathOwner,
                enumerable: false,
                writable: true,
                configurable: true,
              });
            } catch { /* */ }
          }
          requestObject = requestFn(requestOptions, onResponse);
        } finally {
          try {
            if (requestHeaders) requestHeaders.Authorization = null;
          } catch { /* */ }
          if (scrubDeltaContinuationPath) {
            try {
              if (requestOptions) requestOptions.path = null;
            } catch { /* */ }
            try {
              if (continuationPathOwner) continuationPathOwner.value = null;
            } catch { /* */ }
            try {
              if (requestOptions
                  && Object.prototype.hasOwnProperty.call(
                    requestOptions,
                    CONTINUATION_PATH_OWNER_PROBE,
                  )) {
                requestOptions[CONTINUATION_PATH_OWNER_PROBE] = null;
              }
            } catch { /* */ }
          }
          requestHeaders = null;
          authorization = null;
          requestOptions = null;
          tokenForRequest = null;
          pathForRequest = null;
        }
      }(tokenOwner));
      tokenOwner = null;
      if (scrubDeltaContinuationPath) {
        requestPath = null;
        continuationPathOwner = null;
        try { session.continuationPathOwner = null; } catch { /* */ }
      }
    } catch {
      tokenOwner = null;
      if (scrubDeltaContinuationPath) {
        try {
          if (continuationPathOwner) continuationPathOwner.value = null;
        } catch { /* */ }
        requestPath = null;
        continuationPathOwner = null;
        try { session.continuationPathOwner = null; } catch { /* */ }
      }
      terminate(fail('request_error'));
      return;
    }

    const onceReq = resolveLifecycleMethod(requestObject, 'once');
    const endReq = resolveLifecycleMethod(requestObject, 'end');
    if (!requestObject || typeof onceReq !== 'function' || typeof endReq !== 'function') {
      terminate(fail('request_error'));
      return;
    }
    Reflect.apply(onceReq, requestObject, ['error', () => terminate(fail('request_error'))]);
    Reflect.apply(endReq, requestObject, []);
  });
}

function createMicrosoftGraphDelegatedMessagesTransport(dependencies = {}) {
  let resolved;
  try {
    resolved = resolveTransportDependencies(dependencies, COUNT_FAILURE_BRAND);
  } catch (err) {
    if (err && err.code === FAILURE_CODE) throw err;
    throw failure('request_error', COUNT_FAILURE_BRAND);
  }

  let used = false;
  function listMessageEnvelopeCount(input) {
    if (used) return Promise.reject(failure('request_error', COUNT_FAILURE_BRAND));
    used = true;
    return runDelegatedMessagesRequest({
      requestFn: resolved.requestFn,
      setTimer: resolved.setTimer,
      clearTimer: resolved.clearTimer,
      brand: COUNT_FAILURE_BRAND,
      mode: 'count',
      preferHeader: null,
    }, input);
  }

  return Object.freeze({ listMessageEnvelopeCount });
}

/**
 * UNWIRED ImmutableId page factory. Same network owner as count health transport.
 * Pins Prefer: IdType="ImmutableId"; returns only fresh frozen max-5 envelopes.
 */
function createMicrosoftGraphImmutableIdPageTransport(dependencies = {}) {
  let resolved;
  try {
    resolved = resolveTransportDependencies(dependencies, IMMUTABLEID_FAILURE_BRAND);
  } catch (err) {
    if (err && err.code === IMMUTABLEID_PAGE_FAILURE_CODE) throw err;
    throw failure('request_error', IMMUTABLEID_FAILURE_BRAND);
  }

  let used = false;
  function listNormalizedInboundEnvelopes(input) {
    if (used) return Promise.reject(failure('request_error', IMMUTABLEID_FAILURE_BRAND));
    used = true;
    return runDelegatedMessagesRequest({
      requestFn: resolved.requestFn,
      setTimer: resolved.setTimer,
      clearTimer: resolved.clearTimer,
      brand: IMMUTABLEID_FAILURE_BRAND,
      mode: 'immutableid_envelopes',
      preferHeader: PREFER_IMMUTABLE_ID,
    }, input);
  }

  return Object.freeze({ listNormalizedInboundEnvelopes });
}

/**
 * UNWIRED ImmutableId bounded-catchup factory (multi-page).
 *
 * Factory-fixed maxPages=10, maxMessages=50 — never caller-supplied.
 * Sequential GETs: first request is exact users/{uuid}/messages + Prefer ImmutableId;
 * subsequent requests follow only provider @odata.nextLink after strict validation.
 * Canonical sort + identity dedupe use envelope-contract owners (same rules as batch
 * processor) — no consumer invocation, no persistence.
 *
 * Success: one fresh frozen DTO
 * `{ envelopes, pages_fetched, observed_count, unique_count, duplicate_count, truncated }`.
 * Failure: sanitized microsoft_graph_immutableid_page_failed only; no partial envelopes.
 */
function createMicrosoftGraphImmutableIdBoundedCatchupTransport(dependencies = {}) {
  let resolved;
  try {
    resolved = resolveTransportDependencies(dependencies, IMMUTABLEID_FAILURE_BRAND);
  } catch (err) {
    if (err && err.code === IMMUTABLEID_PAGE_FAILURE_CODE) throw err;
    throw failure('request_error', IMMUTABLEID_FAILURE_BRAND);
  }

  // Caps closed over factory init — not readable from caller input.
  const maxPages = BOUNDED_CATCHUP_MAX_PAGES;
  const maxMessages = BOUNDED_CATCHUP_MAX_MESSAGES;

  let used = false;
  async function listBoundedCatchupInboundEnvelopes(input) {
    if (used) return Promise.reject(failure('request_error', IMMUTABLEID_FAILURE_BRAND));
    used = true;

    // Catch-up retains only one mutable token owner. Immediately scrub any
    // parsed/access-input copy after extraction; per-page holders scrub in
    // their own finally after the awaited request settles.
    let tokenOwner = null;
    let mailboxId = null;
    {
      const parsed = readImmutableIdPageInput(input);
      if (parsed === null) {
        return Promise.reject(failure('request_error', IMMUTABLEID_FAILURE_BRAND));
      }
      tokenOwner = parsed.accessToken;
      mailboxId = parsed.provider_mailbox_id;
      try { parsed.accessToken = null; } catch { /* */ }
    }

    const rawEnvelopes = [];
    let pagesFetched = 0;
    let requestPathOverride = null;
    // Canonical continuation identities (not raw provider links) for loop detection.
    const seenCanonicalContinuations = new Set();
    let pendingNextLink = null;
    let truncated = false;

    try {
      while (pagesFetched < maxPages) {
        // Mutable page input/holder for this sequential GET only.
        const pageInput = {
          accessToken: tokenOwner,
          provider_mailbox_id: mailboxId,
        };
        let pageResult;
        try {
          pageResult = await runDelegatedMessagesRequest({
            requestFn: resolved.requestFn,
            setTimer: resolved.setTimer,
            clearTimer: resolved.clearTimer,
            brand: IMMUTABLEID_FAILURE_BRAND,
            mode: 'immutableid_envelopes_page',
            preferHeader: PREFER_IMMUTABLE_ID,
            requestPathOverride,
          }, pageInput);
        } catch (err) {
          // Re-throw transport-branded failures only; never partial DTO.
          if (err && err.code === IMMUTABLEID_PAGE_FAILURE_CODE) throw err;
          throw failure('request_error', IMMUTABLEID_FAILURE_BRAND);
        } finally {
          // Scrub page holder accessToken after request settles (success + every failure).
          try { pageInput.accessToken = null; } catch { /* */ }
        }

        if (!pageResult || !Array.isArray(pageResult.envelopes)) {
          throw failure('json_invalid', IMMUTABLEID_FAILURE_BRAND);
        }
        // Append this page's mapped envelopes (max TOP_MAX already enforced).
        for (let i = 0; i < pageResult.envelopes.length; i += 1) {
          const env = pageResult.envelopes[i];
          if (!env
              || env.provider !== PROVIDER_ID
              || env.provider_mailbox_id !== mailboxId) {
            throw failure('row_value_invalid', IMMUTABLEID_FAILURE_BRAND);
          }
          rawEnvelopes.push(env);
        }
        pagesFetched += 1;

        const nextLink = pageResult.nextLink === undefined ? null : pageResult.nextLink;
        pendingNextLink = typeof nextLink === 'string' ? nextLink : null;

        // Deterministic selection after each page so maxMessages stop is unambiguous.
        const selected = selectBoundedCatchupEnvelopes(rawEnvelopes, maxMessages);
        if (selected === null) {
          throw failure('row_value_invalid', IMMUTABLEID_FAILURE_BRAND);
        }

        if (selected.truncated_by_messages) {
          truncated = true;
          pendingNextLink = null;
          // Drop unaccepted raw rows — DTO uses selected counts only.
          return finalizeCatchupDto(selected, pagesFetched, true);
        }

        if (selected.unique_count >= maxMessages) {
          // Bound reached exactly; if provider still offers nextLink → truncated.
          if (pendingNextLink !== null) {
            truncated = true;
          }
          return finalizeCatchupDto(selected, pagesFetched, truncated);
        }

        if (pendingNextLink === null) {
          return finalizeCatchupDto(selected, pagesFetched, false);
        }

        if (pagesFetched >= maxPages) {
          // Hit page cap with another nextLink still offered.
          truncated = true;
          return finalizeCatchupDto(selected, pagesFetched, true);
        }

        // Strict validation BEFORE any follow request; then canonical loop check.
        const follow = validateCatchupFollowNextLink(pendingNextLink, mailboxId);
        if (!follow.ok) {
          throw failure('top_shape_invalid', IMMUTABLEID_FAILURE_BRAND);
        }
        // Canonical identity (decoded path + invariant query + continuation) —
        // semantically equivalent percent encodings / query order collide here.
        if (seenCanonicalContinuations.has(follow.canonicalIdentity)) {
          throw failure('top_shape_invalid', IMMUTABLEID_FAILURE_BRAND);
        }
        seenCanonicalContinuations.add(follow.canonicalIdentity);
        requestPathOverride = follow.requestPath;
        pendingNextLink = null;
      }

      // Exhausted maxPages without early return — treat remaining nextLink as truncate.
      const selected = selectBoundedCatchupEnvelopes(rawEnvelopes, maxMessages);
      if (selected === null) {
        throw failure('row_value_invalid', IMMUTABLEID_FAILURE_BRAND);
      }
      return finalizeCatchupDto(
        selected,
        pagesFetched,
        selected.truncated_by_messages || pendingNextLink !== null,
      );
    } finally {
      // Outer finally scrubs the sole catch-up token owner.
      tokenOwner = null;
    }
  }

  return Object.freeze({ listBoundedCatchupInboundEnvelopes });
}

/**
 * Build the exact frozen catchup success DTO (no links/tokens/raw rows).
 * @param {{envelopes:object[],observed_count:number,unique_count:number,duplicate_count:number}} selected
 * @param {number} pagesFetched
 * @param {boolean} truncated
 */
function finalizeCatchupDto(selected, pagesFetched, truncated) {
  const dto = {
    envelopes: Object.freeze(selected.envelopes.slice()),
    pages_fetched: pagesFetched,
    observed_count: selected.observed_count,
    unique_count: selected.unique_count,
    duplicate_count: selected.duplicate_count,
    truncated: truncated === true,
  };
  const keys = Object.keys(dto);
  if (keys.length !== BOUNDED_CATCHUP_RESULT_KEYS.length
      || keys.some((k, i) => k !== BOUNDED_CATCHUP_RESULT_KEYS[i])) {
    throw failure('json_invalid', IMMUTABLEID_FAILURE_BRAND);
  }
  return Object.freeze(dto);
}

/**
 * UNWIRED messages-delta single-page factory (same network owner).
 *
 * Exact frozen API: `{ fetchInitialPage, fetchContinuationPage }`.
 * - Initial: GET `/v1.0/users/{uuid}/messages/delta?$top=5&$select=…` + Prefer ImmutableId
 * - Continuation: PR408-validated cursor URL used verbatim (append nothing);
 *   HTTP 410 → private `cursor_gone` (public error still generic)
 * - Success: frozen `{ envelopes, tombstones, successor_cursor, observed_count }`
 * - No DB/store/lease/grant/runtime/composition; not one-shot across methods
 *   (each call is independent; exactly one HTTPS request per call).
 */
function createMicrosoftGraphMessagesDeltaPageTransport(dependencies = {}, activationWatermark = null) {
  let resolved;
  try {
    resolved = resolveTransportDependencies(dependencies, MESSAGES_DELTA_FAILURE_BRAND);
  } catch (err) {
    if (err && err.code === MESSAGES_DELTA_PAGE_FAILURE_CODE) throw err;
    throw failure('request_error', MESSAGES_DELTA_FAILURE_BRAND);
  }

  function fetchInitialPage(input) {
    const parsed = readMessagesDeltaInitialInput(input);
    if (parsed === null) {
      return Promise.reject(failure('request_error', MESSAGES_DELTA_FAILURE_BRAND));
    }
    const pageInput = {
      accessToken: parsed.accessToken,
      provider_mailbox_id: parsed.provider_mailbox_id,
    };
    try { parsed.accessToken = null; } catch { /* */ }
    // Initial delta: no cursor capability owner; path built inside run.
    return runDelegatedMessagesRequest({
      requestFn: resolved.requestFn,
      setTimer: resolved.setTimer,
      clearTimer: resolved.clearTimer,
      brand: MESSAGES_DELTA_FAILURE_BRAND,
      mode: 'messages_delta_page',
      preferHeader: PREFER_IMMUTABLE_ID,
      cursorGoneOn410: false,
      activationWatermark,
    }, pageInput).finally(() => {
      try { pageInput.accessToken = null; } catch { /* */ }
    });
  }

  function fetchContinuationPage(input) {
    let parsed = readMessagesDeltaContinuationInput(input);
    if (parsed === null) {
      return Promise.reject(failure('request_error', MESSAGES_DELTA_FAILURE_BRAND));
    }
    const pageInput = {
      accessToken: parsed.accessToken,
      provider_mailbox_id: parsed.provider_mailbox_id,
    };
    // Take the single mutable path owner created after strict validation.
    // No const string requestPath / requestPathOverride alias across the boundary.
    let continuationPathOwner = parsed.continuationPathOwner;
    try { parsed.accessToken = null; } catch { /* */ }
    try { parsed.continuationPathOwner = null; } catch { /* */ }
    parsed = null;
    const session = {
      requestFn: resolved.requestFn,
      setTimer: resolved.setTimer,
      clearTimer: resolved.clearTimer,
      brand: MESSAGES_DELTA_FAILURE_BRAND,
      mode: 'messages_delta_page',
      preferHeader: PREFER_IMMUTABLE_ID,
      continuationPathOwner,
      cursorGoneOn410: true,
    };
    return runDelegatedMessagesRequest(session, pageInput).finally(() => {
      try { pageInput.accessToken = null; } catch { /* */ }
      try {
        if (continuationPathOwner) continuationPathOwner.value = null;
      } catch { /* */ }
      continuationPathOwner = null;
      try { session.continuationPathOwner = null; } catch { /* */ }
    });
  }

  return Object.freeze({
    fetchInitialPage,
    fetchContinuationPage,
  });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  FAILURE_MESSAGE,
  PREFER_IMMUTABLE_ID,
  IMMUTABLEID_PAGE_FAILURE_CODE,
  IMMUTABLEID_PAGE_FAILURE_MESSAGE,
  MESSAGES_DELTA_PAGE_FAILURE_CODE,
  MESSAGES_DELTA_PAGE_FAILURE_MESSAGE,
  HOST,
  PATH,
  TOP_MAX,
  SELECT_FIELDS,
  RESPONSE_CAP_BYTES,
  GRAPH_STAGES,
  BOUNDED_CATCHUP_MAX_PAGES,
  BOUNDED_CATCHUP_MAX_MESSAGES,
  MESSAGES_DELTA_PAGE_RESULT_KEYS,
  MESSAGES_DELTA_CURSOR_KINDS,
  buildImmutableIdUserMessagesPath,
  buildMessagesDeltaInitialPath,
  buildMessagesDeltaFromNowInitialPath,
  countBoundedMessageEnvelopes,
  classifyMessageEnvelopeBody,
  classifyParsedMessageEnvelopeList,
  acceptParsedMessageEnvelopeList,
  validateMessagesDeltaCursorUrl,
  readTrustedGraphStage,
  readTrustedMessagesDeltaOutcome,
  createMicrosoftGraphDelegatedMessagesTransport,
  createMicrosoftGraphImmutableIdPageTransport,
  createMicrosoftGraphImmutableIdBoundedCatchupTransport,
  createMicrosoftGraphMessagesDeltaPageTransport,
});
