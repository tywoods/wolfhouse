'use strict';

/**
 * Injected HTTP transport contract for Luna email adapters (Slice 2A).
 *
 * Validates an async `request` transport shape only. No default transport and
 * no network implementation ship in this module.
 *
 * Expected transport surface (caller-supplied):
 *   transport.request({ method, url, headers, body?, timeout_ms })
 *     → Promise<{ status: number, headers?: object, body?: string }>
 *
 * Own data properties only: accessor descriptors on the transport object are
 * rejected without invoking getters.
 *
 * @module email-http-transport-contract
 */

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(error, details) {
  const out = { ok: false, error: String(error) };
  if (details !== undefined) out.details = details;
  return out;
}

function ok(value) {
  return value === undefined ? { ok: true } : { ok: true, value };
}

/**
 * Read own data property without invoking getters.
 * @param {object} obj
 * @param {string} key
 */
function readOwnDataProp(obj, key) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    return { present: false };
  }
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc) return { present: false };
  if (typeof desc.get === 'function' || typeof desc.set === 'function') {
    return { present: true, accessor: true };
  }
  return { present: true, value: desc.value };
}

/**
 * Validate injected HTTP transport shape.
 * Required: own data-property `request` that is a function (async or returning Promise).
 * No default transport. No network I/O here.
 *
 * @param {unknown} transport
 * @returns {{ok:true,value:object}|{ok:false,error:string,details?:object}}
 */
function validateEmailHttpTransport(transport) {
  if (!isPlainObject(transport)) {
    return fail('http_transport_invalid', { reason: 'must_be_object' });
  }
  for (const key of Reflect.ownKeys(transport)) {
    if (typeof key === 'symbol') {
      return fail('http_transport_invalid', { reason: 'symbol_key' });
    }
  }
  const requestRead = readOwnDataProp(transport, 'request');
  if (!requestRead.present) {
    return fail('http_transport_invalid', { reason: 'request_required' });
  }
  if (requestRead.accessor) {
    return fail('http_transport_invalid', { reason: 'request_accessor' });
  }
  if (typeof requestRead.value !== 'function') {
    return fail('http_transport_invalid', { reason: 'request_must_be_function' });
  }
  return ok(transport);
}

/**
 * Exact own-data response keys the adapter accepts from a transport response.
 * Extra string/symbol keys and accessors fail closed upstream (no ignored extras).
 * Missing status fails closed; headers/body optional within this set.
 */
const EMAIL_HTTP_TRANSPORT_RESPONSE_KEYS = Object.freeze([
  'status',
  'headers',
  'body',
]);

/**
 * Fixed timeout bounds (ms) adapters pass to transport. Not configurable from
 * untrusted endpoint input.
 */
const EMAIL_HTTP_TRANSPORT_TIMEOUT = Object.freeze({
  TOKEN_MS: 10_000,
  GRAPH_MS: 15_000,
  MIN_MS: 1_000,
  MAX_MS: 30_000,
});

module.exports = {
  validateEmailHttpTransport,
  EMAIL_HTTP_TRANSPORT_RESPONSE_KEYS,
  EMAIL_HTTP_TRANSPORT_TIMEOUT,
};
