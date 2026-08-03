'use strict';

/**
 * Deterministic recording fake HTTP transport for Slice 2A tests.
 * Never performs network I/O / DNS. Scripted handlers only.
 *
 * Persistent recorder state (getCalls) is **fail-safe sanitized** only:
 * - Request body is never persisted raw — constant `[REDACTED]` (or omitted
 *   when the transient call had no body). Exact wire body assertions belong
 *   only on the transient scripted-handler call.
 * - Headers: preserve only a tiny safe metadata allowlist (Accept,
 *   Content-Type) after descriptor-safe own-data snapshot; every other header
 *   value is redacted regardless of name (Authorization, X-Access-Token,
 *   X-Secret, API-Key, custom headers, …).
 * - URL / method / timeout_ms metadata retained.
 *
 * Scripted handlers receive the transient raw call for exact wire assertions.
 * Raw sensitive values never enter persistent calls / getCalls / public state.
 *
 * Transient raw-call construction first snapshots the **request object itself**
 * (own enumerable data properties via Object.getOwnPropertyDescriptors), then
 * derives method/url/headers/body/timeout_ms only from that snapshot. Nested
 * headers use the same descriptor-safe snapshot. Accessors, inherited
 * properties, symbols, arrays, and non-plain values are never read/invoked.
 *
 * After the descriptor snapshot, values are accepted only when already the
 * exact expected primitive type — no String()/Number()/template interpolation,
 * valueOf, toString, Symbol.toPrimitive, regex, or any other coercion of
 * rejected/hostile values:
 *   - method / url / body: string data values only (else default / omit)
 *   - headers: own enumerable data-property **string** values only (names from
 *     Object.keys descriptors); omit null/object/function/symbol/bigint/…
 *   - timeout_ms: finite integer number only (else omit)
 * Factory opts (e.g. handler) use the same descriptor-safe snapshot — never
 * `opts.handler` direct property access.
 * Sanitization runs on the built raw call, never mutates it.
 *
 * @module email-fake-http-transport
 */

const REDACTED = '[REDACTED]';

/**
 * Header names whose values may be retained in persistent recorder state.
 * Matched case-insensitively. All other header values are redacted.
 */
const PERSISTED_HEADER_ALLOWLIST = Object.freeze([
  'accept',
  'content-type',
]);
const PERSISTED_HEADER_ALLOWLIST_SET = new Set(PERSISTED_HEADER_ALLOWLIST);

/**
 * @typedef {object} FakeTransportCall
 * @property {string} method
 * @property {string} url
 * @property {Record<string,string>} [headers]
 * @property {string} [body]
 * @property {number} [timeout_ms]
 */

/**
 * Snapshot own enumerable data properties only — never invoke getters/setters.
 * Uses Object.getOwnPropertyDescriptors. Omits accessors, symbols, and
 * non-enumerable props. Arrays / non-objects → empty object. Null-prototype
 * plain objects are fine. Prototype-chain values are never read.
 *
 * @param {unknown} obj
 * @returns {Record<string, unknown>}
 */
function snapshotOwnEnumerableDataProps(obj) {
  const out = Object.create(null);
  if (obj == null || typeof obj !== 'object') return out;
  // Arrays are objects but not a header map — treat as empty (no index reads
  // via spread that could surface odd content as "headers").
  if (Array.isArray(obj)) return out;

  let descs;
  try {
    descs = Object.getOwnPropertyDescriptors(obj);
  } catch {
    return out;
  }

  for (const key of Object.keys(descs)) {
    const desc = descs[key];
    if (!desc || desc.enumerable !== true) continue;
    // Accessor descriptor: omit without invoking get/set.
    if (typeof desc.get === 'function' || typeof desc.set === 'function') {
      continue;
    }
    // Data property only.
    if (!Object.prototype.hasOwnProperty.call(desc, 'value') && desc.get === undefined) {
      // Exotic / incomplete descriptor — omit fail-safe.
      continue;
    }
    out[key] = desc.value;
  }
  // Symbols intentionally omitted from header snapshots.
  return out;
}

/**
 * True iff value is already an exact string primitive (no coercion).
 * @param {unknown} v
 * @returns {v is string}
 */
function isExactStringPrimitive(v) {
  return typeof v === 'string';
}

/**
 * True iff value is already a finite integer number primitive (no coercion).
 * @param {unknown} v
 * @returns {v is number}
 */
function isExactFiniteInteger(v) {
  return typeof v === 'number' && Number.isInteger(v) && Number.isSafeInteger(v);
}

/**
 * Persist only allowlisted safe metadata header values (Accept, Content-Type).
 * Every other header value is redacted regardless of name — never try to infer
 * hostile secret header names. Operates only on an already-snapshotted plain
 * data map (no accessors). Header values must already be string primitives —
 * never coerce via String()/toString/valueOf/Symbol.toPrimitive.
 * Non-string values (null/object/function/symbol/bigint/…) are omitted entirely.
 * @param {object} headers
 * @returns {Record<string,string>}
 */
function sanitizeHeaders(headers) {
  // Null prototype prevents prototype-polluted inherited setters from seeing
  // raw header values while we create the sanitized own properties.
  const out = Object.create(null);
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return out;
  // Prefer descriptor walk so even if a caller passes a hostile object with
  // accessors, we never invoke them here either.
  const snap = snapshotOwnEnumerableDataProps(headers);
  for (const key of Object.keys(snap)) {
    // Object.keys yields string names only (descriptor keys); no key coercion.
    const lower = key.toLowerCase();
    const v = snap[key];
    // Only exact string primitives participate — no String(v) / hooks.
    if (!isExactStringPrimitive(v)) continue;
    if (PERSISTED_HEADER_ALLOWLIST_SET.has(lower)) {
      out[key] = v;
    } else {
      out[key] = REDACTED;
    }
  }
  return out;
}

/**
 * Persistent body policy: never retain raw request body material.
 * When the transient call had a body (including empty string), store the
 * constant redaction marker. When body was absent/undefined, omit it.
 *
 * @param {string|undefined} body
 * @returns {string|undefined}
 */
function sanitizePersistedBody(body) {
  if (body === undefined) return undefined;
  return REDACTED;
}

/**
 * Build a frozen sanitized call record for persistent state.
 * Never mutates `raw`.
 * @param {FakeTransportCall} raw
 * @returns {FakeTransportCall}
 */
function sanitizeCall(raw) {
  const persisted = {
    method: raw.method,
    url: raw.url,
    headers: Object.freeze(sanitizeHeaders(raw.headers)),
    timeout_ms: raw.timeout_ms,
  };
  const body = sanitizePersistedBody(raw.body);
  if (body !== undefined) {
    persisted.body = body;
  }
  return Object.freeze(persisted);
}

/**
 * Build transient raw call from request input without invoking any request
 * field accessors, inherited prototype getters, or value coercion hooks
 * (Symbol.toPrimitive / valueOf / toString).
 *
 * Steps:
 * 1. Snapshot the request object itself (own enumerable data props only).
 * 2. Derive method/url/body/timeout_ms solely from that snapshot, accepting
 *    only values already of the exact expected primitive type:
 *      - method/url: string → use; else default ''
 *      - body: string → use; else omit (undefined)
 *      - timeout_ms: finite safe integer number → use; else omit
 * 3. Nested headers: descriptor-safe snapshot; keep only own enumerable
 *    data-property **string** values (names from Object.keys descriptors).
 *    Omit null/object/function/symbol/bigint/number/… without any coercion
 *    or further property access on the rejected value.
 *
 * Null-prototype plain request objects with data properties are supported.
 * Arrays / non-objects / accessor-only fields yield empty defaults.
 *
 * @param {FakeTransportCall|object|null|undefined} req
 * @returns {FakeTransportCall}
 */
function buildRawCall(req) {
  // Snapshot the request object first — never touch req.method/url/… directly
  // (those reads would invoke own accessors and inherited prototype getters).
  const reqSnap = snapshotOwnEnumerableDataProps(req);

  const headerSnap = reqSnap.headers != null
    && typeof reqSnap.headers === 'object'
    && !Array.isArray(reqSnap.headers)
    ? snapshotOwnEnumerableDataProps(reqSnap.headers)
    : Object.create(null);
  // Null prototype prevents inherited setters on Object.prototype from
  // intercepting raw header values. Values are already data-only strings.
  const headers = Object.create(null);
  for (const key of Object.keys(headerSnap)) {
    const v = headerSnap[key];
    // Exact string primitives only — omit without coercing rejected values.
    if (isExactStringPrimitive(v)) {
      headers[key] = v;
    }
  }

  const method = isExactStringPrimitive(reqSnap.method) ? reqSnap.method : '';
  const url = isExactStringPrimitive(reqSnap.url) ? reqSnap.url : '';
  const body = isExactStringPrimitive(reqSnap.body) ? reqSnap.body : undefined;
  const timeout_ms = isExactFiniteInteger(reqSnap.timeout_ms)
    ? reqSnap.timeout_ms
    : undefined;

  return Object.freeze({
    method,
    url,
    headers,
    body,
    timeout_ms,
  });
}

/**
 * Create a recording fake transport.
 *
 * @param {object} [opts]
 * @param {(call: FakeTransportCall, index: number) =>
 *   | {status:number,headers?:object,body?:string}
 *   | Promise<{status:number,headers?:object,body?:string}>
 *   | never
 * } [opts.handler] Invoked per request with the **raw** call; may throw.
 * @returns {{request: Function, getCalls: Function, reset: Function}}
 */
function createFakeEmailHttpTransport(opts) {
  // Descriptor-safe opts: never `opts.handler` direct access (would invoke
  // own/prototype getters). Snapshot own enumerable data props only.
  let handler = null;
  if (opts != null && typeof opts === 'object' && !Array.isArray(opts)) {
    const optsSnap = snapshotOwnEnumerableDataProps(opts);
    if (typeof optsSnap.handler === 'function') {
      handler = optsSnap.handler;
    }
  }
  /** @type {FakeTransportCall[]} sanitized only */
  const calls = [];

  return {
    /**
     * @param {FakeTransportCall} req
     */
    async request(req) {
      // Transient raw call — data-prop snapshot only; passed to handler for
      // exact wire assertions. Never sanitized in place.
      const rawCall = buildRawCall(req);

      // Persistent state: fail-safe sanitized copy only. Never store raw
      // secrets/tokens/bodies. sanitizeCall does not mutate rawCall.
      calls.push(sanitizeCall(rawCall));

      if (!handler) {
        return { status: 599, body: '{"error":"no_handler"}' };
      }
      return handler(rawCall, calls.length - 1);
    },
    /**
     * Returns a shallow copy of sanitized recorded calls.
     * Never includes raw request bodies or non-allowlisted header values.
     */
    getCalls() {
      return calls.slice();
    },
    /** Clear retained sanitized recorder state. */
    reset() {
      calls.length = 0;
    },
  };
}

module.exports = {
  createFakeEmailHttpTransport,
  // Exported for direct unit probes in the verifier only.
  sanitizeHeaders,
  sanitizePersistedBody,
  sanitizeCall,
  snapshotOwnEnumerableDataProps,
  buildRawCall,
  REDACTED,
  PERSISTED_HEADER_ALLOWLIST,
};
