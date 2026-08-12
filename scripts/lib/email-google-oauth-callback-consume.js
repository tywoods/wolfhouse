'use strict';

const { isProxy, isPromise } = require('node:util').types;

const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const freeze = Object.freeze;
const isFrozen = Object.isFrozen;
const getPrototypeOf = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const createObject = Object.create;
const defineProperty = Object.defineProperty;
const objectPrototype = Object.prototype;
const arrayIsArray = Array.isArray;
const regexpTest = RegExp.prototype.test;
const stringCharCodeAt = String.prototype.charCodeAt;
const stringSlice = String.prototype.slice;
const stringReplace = String.prototype.replace;
const decode = decodeURIComponent;
const promisePrototype = Promise.prototype;
const DateConstructor = Date;
const dateParse = Date.parse;
const dateToISOString = Date.prototype.toISOString;
const finite = Number.isFinite;
const bufferIsBuffer = Buffer.isBuffer;
const bufferToString = Buffer.prototype.toString;

const FAILURE = 'GOOGLE_OAUTH_CALLBACK_CONSUME_FAILED';
const DEPENDENCY_KEYS = freeze(['cryptography', 'clock', 'repository']);
const CRYPTOGRAPHY_KEYS = freeze(['sha256Ascii']);
const CLOCK_KEYS = freeze(['now']);
const REPOSITORY_KEYS = freeze(['consume']);
const INPUT_KEYS = freeze(['clientId', 'authSessionId', 'query']);
const ROW_KEYS = freeze(['operationId', 'locationId', 'endpointId', 'staffUserId', 'codeVerifier', 'nonce']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const NONCE = /^[A-Za-z0-9_-]{43,128}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PERCENT = /%(?![0-9A-Fa-f]{2})/;
const PLUS = /\+/g;

const failure = new Error(FAILURE);
defineProperty(failure, 'name', { value: 'GoogleOAuthCallbackConsumeError' });
defineProperty(failure, 'code', { value: FAILURE, enumerable: true });
freeze(failure);

function fail() { throw failure; }
function test(pattern, value) { return apply(regexpTest, pattern, [value]); }

function snapshot(value, keys) {
  if (value === null || typeof value !== 'object' || isProxy(value) || arrayIsArray(value)
      || getPrototypeOf(value) !== objectPrototype || !isFrozen(value)) return null;
  const actual = ownKeys(value);
  if (actual.length !== keys.length) return null;
  const result = createObject(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (actual[index] !== key) return null;
    const descriptor = getDescriptor(value, key);
    if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable
        || descriptor.writable || descriptor.configurable) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function visible(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = apply(stringCharCodeAt, value, [index]);
    if (unit < 33 || unit > 126) return false;
  }
  return true;
}

function decodeValue(raw) {
  if (test(PERCENT, raw)) fail();
  try { return apply(decode, undefined, [apply(stringReplace, raw, [PLUS, ' '])]); }
  catch (_) { fail(); }
}

function parseQuery(query) {
  if (typeof query !== 'string' || query.length < 1 || query.length > 16384) fail();
  for (let index = 0; index < query.length; index += 1) {
    const unit = apply(stringCharCodeAt, query, [index]);
    if (unit < 33 || unit > 126 || unit === 35) fail();
  }
  const values = createObject(null);
  let start = 0;
  while (start <= query.length) {
    let end = start;
    while (end < query.length && apply(stringCharCodeAt, query, [end]) !== 38) end += 1;
    if (end === start) fail();
    const segment = apply(stringSlice, query, [start, end]);
    let equal = 0;
    while (equal < segment.length && apply(stringCharCodeAt, segment, [equal]) !== 61) equal += 1;
    if (equal === 0 || equal === segment.length) fail();
    const key = apply(stringSlice, segment, [0, equal]);
    if (key !== 'state' && key !== 'code' && key !== 'error') fail();
    if (hasOwn(values, key)) fail();
    values[key] = decodeValue(apply(stringSlice, segment, [equal + 1]));
    if (end === query.length) break;
    start = end + 1;
  }
  if (typeof values.state !== 'string' || !test(STATE, values.state)) fail();
  const success = hasOwn(values, 'code');
  const decline = hasOwn(values, 'error');
  if (success === decline || ownKeys(values).length !== 2) fail();
  if (success) {
    if (!visible(values.code, 1, 8192)) fail();
    return freeze({ state: values.state, code: values.code, declined: false });
  }
  if (values.error !== 'access_denied') fail();
  return freeze({ state: values.state, code: null, declined: true });
}

function timestamp(value) {
  if (typeof value !== 'string' || !test(TIMESTAMP, value)) return false;
  const parsed = apply(dateParse, DateConstructor, [value]);
  return finite(parsed) && apply(dateToISOString, new DateConstructor(parsed), []) === value;
}

function validRow(value) {
  const row = snapshot(value, ROW_KEYS);
  if (!row) return null;
  for (let index = 0; index < 4; index += 1) {
    if (typeof row[ROW_KEYS[index]] !== 'string' || !test(UUID, row[ROW_KEYS[index]])) return null;
  }
  if (typeof row.codeVerifier !== 'string' || !test(VERIFIER, row.codeVerifier)
      || typeof row.nonce !== 'string' || !test(NONCE, row.nonce)) return null;
  return row;
}

function createGoogleOAuthCallbackConsume(dependencies) {
  try {
    const owners = snapshot(dependencies, DEPENDENCY_KEYS);
    const cryptography = owners && snapshot(owners.cryptography, CRYPTOGRAPHY_KEYS);
    const clock = owners && snapshot(owners.clock, CLOCK_KEYS);
    const repository = owners && snapshot(owners.repository, REPOSITORY_KEYS);
    if (!cryptography || !clock || !repository || typeof cryptography.sha256Ascii !== 'function'
        || typeof clock.now !== 'function' || typeof repository.consume !== 'function') fail();
    const sha256Ascii = cryptography.sha256Ascii;
    const now = clock.now;
    const consume = repository.consume;
    const cryptographyOwner = owners.cryptography;
    const clockOwner = owners.clock;
    const repositoryOwner = owners.repository;

    async function consumeCallback(value) {
      try {
        const input = snapshot(value, INPUT_KEYS);
        if (!input || typeof input.clientId !== 'string' || !test(UUID, input.clientId)
            || typeof input.authSessionId !== 'string' || !test(UUID, input.authSessionId)
            || typeof input.query !== 'string') fail();
        const parsed = parseQuery(input.query);
        const digest = apply(sha256Ascii, cryptographyOwner, [parsed.state]);
        if (!apply(bufferIsBuffer, Buffer, [digest]) || digest.length !== 32) fail();
        const stateHash = apply(bufferToString, digest, ['hex']);
        if (!test(DIGEST, stateHash)) fail();
        const consumedAt = apply(now, clockOwner, []);
        if (!timestamp(consumedAt)) fail();
        const dto = freeze({ stateHash, clientId: input.clientId,
          authSessionId: input.authSessionId, consumedAt });
        let output = apply(consume, repositoryOwner, [dto]);
        if (output !== null && typeof output === 'object') {
          if (isProxy(output)) fail();
          if (getPrototypeOf(output) === promisePrototype) {
            if (!isPromise(output)) fail();
            output = await output;
          }
        }
        if (output === null) return freeze({ status: 'invalid' });
        const row = validRow(output);
        if (!row) fail();
        if (parsed.declined) return freeze({ status: 'declined' });
        return freeze({ status: 'consumed', authorizationCode: parsed.code, clientId: input.clientId,
          operationId: row.operationId, locationId: row.locationId, endpointId: row.endpointId,
          staffUserId: row.staffUserId, codeVerifier: row.codeVerifier, nonce: row.nonce });
      } catch (_) { fail(); }
    }
    return freeze({ consumeCallback });
  } catch (_) { fail(); }
}

module.exports = freeze({ createGoogleOAuthCallbackConsume });
