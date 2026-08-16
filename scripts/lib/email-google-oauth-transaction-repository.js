'use strict';

const { types: utilTypes } = require('node:util');

const reflectApply = Reflect.apply;
const reflectOwnKeys = Reflect.ownKeys;
const objectFreeze = Object.freeze;
const objectIsFrozen = Object.isFrozen;
const objectIsExtensible = Object.isExtensible;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectHasOwn = Object.hasOwn;
const objectCreate = Object.create;
const objectPrototype = Object.prototype;
const arrayIsArray = Array.isArray;
const arrayPrototype = Array.prototype;
const regexpTest = RegExp.prototype.test;
const promisePrototype = Promise.prototype;
const promiseThen = Promise.prototype.then;
const dateConstructor = Date;
const dateParse = Date.parse;
const dateToISOString = Date.prototype.toISOString;
const numberIsFinite = Number.isFinite;
const bufferFrom = Buffer.from;
const utilTypesIsProxy = utilTypes.isProxy;

const FAILURE = 'GOOGLE_OAUTH_TRANSACTION_REPOSITORY_FAILED';
const CREATE_SQL = `INSERT INTO tenant_email_google_oauth_transactions (
  client_id, location_id, endpoint_id, staff_user_id, auth_session_id,
  operation_id, state_hash, code_verifier, nonce, authorization_intent,
  scope_version, issued_at, expires_at
) VALUES (
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
  $6::uuid, $7::bytea, $8::text, $9::text, 'initial_connect',
  'phase_a_v2', $10::timestamptz, $11::timestamptz
)
RETURNING operation_id::text AS operation_id,
  to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at`;
const CONSUME_SQL = "UPDATE tenant_email_google_oauth_transactions t SET consumed_at=$2::timestamptz FROM clients c WHERE t.state_hash=$1::bytea AND t.client_id=c.id AND c.slug='sunset' AND t.consumed_at IS NULL AND t.expires_at>$2::timestamptz AND t.authorization_intent='initial_connect' AND t.scope_version='phase_a_v2' RETURNING t.client_id, t.auth_session_id, t.operation_id, t.location_id, t.endpoint_id, t.staff_user_id, t.code_verifier, t.nonce";
const INPUT_KEYS = objectFreeze([
  'clientId', 'locationId', 'endpointId', 'staffUserId', 'authSessionId',
  'operationId', 'stateHash', 'codeVerifier', 'nonce', 'issuedAt', 'expiresAt',
]);
const CONSUME_INPUT_KEYS = objectFreeze(['stateHash', 'consumedAt']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const NONCE = /^[A-Za-z0-9_-]{43,128}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const failure = new Error(FAILURE);
Object.defineProperty(failure, 'name', { value: 'GoogleOAuthTransactionRepositoryError' });
Object.defineProperty(failure, 'code', { value: FAILURE, enumerable: true });
objectFreeze(failure);

function fail() { throw failure; }
function test(pattern, value) { return reflectApply(regexpTest, pattern, [value]); }
function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !test(TIMESTAMP, value)) return null;
  const parsed = reflectApply(dateParse, dateConstructor, [value]);
  if (!numberIsFinite(parsed)
      || reflectApply(dateToISOString, new dateConstructor(parsed), []) !== value) return null;
  return parsed;
}

function snapshot(value, keys, frozenRequired) {
  if (value === null || typeof value !== 'object' || arrayIsArray(value)
      || objectGetPrototypeOf(value) !== objectPrototype
      || (frozenRequired !== undefined && objectIsFrozen(value) !== frozenRequired)) return null;
  const actual = reflectOwnKeys(value);
  if (actual.length !== keys.length) return null;
  const copy = objectCreate(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (actual[index] !== key) return null;
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
    if (frozenRequired === true && (descriptor.writable || descriptor.configurable)) return null;
    if (frozenRequired === false && (!descriptor.writable || !descriptor.configurable)) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function readInput(value) {
  const input = snapshot(value, INPUT_KEYS, true);
  if (!input) return null;
  for (let index = 0; index < 6; index += 1) {
    if (typeof input[INPUT_KEYS[index]] !== 'string' || !test(UUID, input[INPUT_KEYS[index]])) return null;
  }
  if (typeof input.stateHash !== 'string' || !test(DIGEST, input.stateHash)
      || typeof input.codeVerifier !== 'string' || !test(VERIFIER, input.codeVerifier)
      || typeof input.nonce !== 'string' || !test(NONCE, input.nonce)) return null;
  const issued = canonicalTimestamp(input.issuedAt);
  const expires = canonicalTimestamp(input.expiresAt);
  if (issued === null || expires === null || expires <= issued || expires - issued > 600000) return null;
  return input;
}

function snapshotQueryResultRows(value) {
  if (value === null || typeof value !== 'object'
      || reflectApply(utilTypesIsProxy, utilTypes, [value]) || arrayIsArray(value)) return null;
  const keys = reflectOwnKeys(value);
  let rowsDescriptor = null;
  let frozen = true;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key === 'symbol') return null;
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (!descriptor || !objectHasOwn(descriptor, 'value')
        || objectHasOwn(descriptor, 'get') || objectHasOwn(descriptor, 'set')) return null;
    if (descriptor.writable || descriptor.configurable) frozen = false;
    if (key === 'rows') {
      if (rowsDescriptor) return null;
      rowsDescriptor = descriptor;
    }
  }
  if (!rowsDescriptor || !rowsDescriptor.enumerable) return null;
  if (objectIsExtensible(value)) frozen = false;
  return objectFreeze({ frozen, rows: rowsDescriptor.value });
}

function acknowledgement(value, input) {
  const result = snapshotQueryResultRows(value);
  if (!result) fail();
  const frozen = result.frozen;
  if (!arrayIsArray(result.rows) || objectGetPrototypeOf(result.rows) !== arrayPrototype
      || objectIsFrozen(result.rows) !== frozen || result.rows.length !== 1
      || reflectOwnKeys(result.rows).length !== 2) fail();
  const rowDescriptor = objectGetOwnPropertyDescriptor(result.rows, '0');
  const lengthDescriptor = objectGetOwnPropertyDescriptor(result.rows, 'length');
  if (!rowDescriptor || !objectHasOwn(rowDescriptor, 'value') || !rowDescriptor.enumerable
      || rowDescriptor.writable === frozen || rowDescriptor.configurable === frozen
      || !lengthDescriptor || !objectHasOwn(lengthDescriptor, 'value') || lengthDescriptor.value !== 1
      || lengthDescriptor.enumerable || lengthDescriptor.configurable || lengthDescriptor.writable === frozen) fail();
  const row = snapshot(rowDescriptor.value, ['operation_id', 'expires_at'], frozen);
  if (!row || typeof row.operation_id !== 'string' || row.operation_id !== input.operationId
      || typeof row.expires_at !== 'string' || row.expires_at !== input.expiresAt) fail();
  return objectFreeze({ operationId: row.operation_id, expiresAt: row.expires_at });
}

function readConsumeInput(value) {
  const input = snapshot(value, CONSUME_INPUT_KEYS, true);
  if (!input || typeof input.stateHash !== 'string' || !test(DIGEST, input.stateHash)
      || canonicalTimestamp(input.consumedAt) === null) return null;
  return input;
}

function consumeResult(value) {
  const result = snapshotQueryResultRows(value);
  if (!result) fail();
  const frozen = result.frozen;
  if (!arrayIsArray(result.rows) || objectGetPrototypeOf(result.rows) !== arrayPrototype
      || objectIsFrozen(result.rows) !== frozen || result.rows.length > 1) fail();
  const keys = reflectOwnKeys(result.rows);
  const expectedKeys = result.rows.length === 0 ? ['length'] : ['0', 'length'];
  if (keys.length !== expectedKeys.length) fail();
  for (let index = 0; index < keys.length; index += 1) if (keys[index] !== expectedKeys[index]) fail();
  const lengthDescriptor = objectGetOwnPropertyDescriptor(result.rows, 'length');
  if (!lengthDescriptor || !objectHasOwn(lengthDescriptor, 'value')
      || lengthDescriptor.value !== result.rows.length || lengthDescriptor.enumerable
      || lengthDescriptor.configurable || lengthDescriptor.writable === frozen) fail();
  if (result.rows.length === 0) return null;
  const rowDescriptor = objectGetOwnPropertyDescriptor(result.rows, '0');
  if (!rowDescriptor || !objectHasOwn(rowDescriptor, 'value') || !rowDescriptor.enumerable
      || rowDescriptor.writable === frozen || rowDescriptor.configurable === frozen) fail();
  const row = snapshot(rowDescriptor.value,
    ['client_id', 'auth_session_id', 'operation_id', 'location_id', 'endpoint_id', 'staff_user_id', 'code_verifier', 'nonce'], frozen);
  if (!row || typeof row.client_id !== 'string' || !test(UUID, row.client_id)
      || typeof row.auth_session_id !== 'string' || !test(UUID, row.auth_session_id)
      || typeof row.operation_id !== 'string' || !test(UUID, row.operation_id)
      || typeof row.location_id !== 'string' || !test(UUID, row.location_id)
      || typeof row.endpoint_id !== 'string' || !test(UUID, row.endpoint_id)
      || typeof row.staff_user_id !== 'string' || !test(UUID, row.staff_user_id)
      || typeof row.code_verifier !== 'string' || !test(VERIFIER, row.code_verifier)
      || typeof row.nonce !== 'string' || !test(NONCE, row.nonce)) fail();
  return objectFreeze({ clientId: row.client_id, authSessionId: row.auth_session_id,
    operationId: row.operation_id, locationId: row.location_id,
    endpointId: row.endpoint_id, staffUserId: row.staff_user_id,
    codeVerifier: row.code_verifier, nonce: row.nonce });
}

function createGoogleOAuthTransactionRepository(configuration) {
  try {
    const config = snapshot(configuration, ['queryOwner'], true);
    const queryOwner = config && config.queryOwner;
    const owner = snapshot(queryOwner, ['query'], true);
    const query = owner && owner.query;
    if (typeof query !== 'function') fail();

    function create(value) {
      try {
        const input = readInput(value);
        if (!input) fail();
        const params = [input.clientId, input.locationId, input.endpointId, input.staffUserId,
          input.authSessionId, input.operationId, reflectApply(bufferFrom, Buffer, [input.stateHash, 'hex']),
          input.codeVerifier, input.nonce, input.issuedAt, input.expiresAt];
        const output = reflectApply(query, queryOwner, [CREATE_SQL, params]);
        if (output !== null && typeof output === 'object' && objectGetPrototypeOf(output) === promisePrototype) {
          return reflectApply(promiseThen, output, [
            result => acknowledgement(result, input),
            () => fail(),
          ]);
        }
        return acknowledgement(output, input);
      } catch (_) { fail(); }
    }
    function consume(value) {
      try {
        const input = readConsumeInput(value);
        if (!input) fail();
        const params = [reflectApply(bufferFrom, Buffer, [input.stateHash, 'hex']), input.consumedAt];
        const output = reflectApply(query, queryOwner, [CONSUME_SQL, params]);
        if (output !== null && typeof output === 'object' && objectGetPrototypeOf(output) === promisePrototype) {
          return reflectApply(promiseThen, output, [
            result => consumeResult(result),
            () => fail(),
          ]);
        }
        return consumeResult(output);
      } catch (_) { fail(); }
    }
    return objectFreeze({ create, consume });
  } catch (_) { fail(); }
}

module.exports = objectFreeze({ createGoogleOAuthTransactionRepository });
