'use strict';

const reflectApply = Reflect.apply;
const reflectOwnKeys = Reflect.ownKeys;
const objectFreeze = Object.freeze;
const objectIsFrozen = Object.isFrozen;
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
const numberIsFinite = Number.isFinite;
const bufferFrom = Buffer.from;

const FAILURE = 'GOOGLE_OAUTH_TRANSACTION_REPOSITORY_FAILED';
const SQL = `INSERT INTO tenant_email_google_oauth_transactions (
  client_id, location_id, endpoint_id, staff_user_id, auth_session_id,
  operation_id, state_hash, code_verifier, nonce, authorization_intent,
  scope_version, issued_at, expires_at
) VALUES (
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
  $6::uuid, $7::bytea, $8::text, $9::text, 'initial_connect',
  'phase_a_v2', $10::timestamptz, $11::timestamptz
)
RETURNING operation_id, expires_at`;
const INPUT_KEYS = objectFreeze([
  'clientId', 'locationId', 'endpointId', 'staffUserId', 'authSessionId',
  'operationId', 'stateHash', 'codeVerifier', 'nonce', 'issuedAt', 'expiresAt',
]);
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
      || typeof input.nonce !== 'string' || !test(NONCE, input.nonce)
      || typeof input.issuedAt !== 'string' || !test(TIMESTAMP, input.issuedAt)
      || typeof input.expiresAt !== 'string' || !test(TIMESTAMP, input.expiresAt)) return null;
  const issued = reflectApply(dateParse, dateConstructor, [input.issuedAt]);
  const expires = reflectApply(dateParse, dateConstructor, [input.expiresAt]);
  if (!numberIsFinite(issued) || !numberIsFinite(expires) || expires <= issued || expires - issued > 600000) return null;
  return input;
}

function acknowledgement(value, input) {
  const frozen = objectIsFrozen(value);
  const result = snapshot(value, ['rows'], frozen);
  if (!result || !arrayIsArray(result.rows) || objectGetPrototypeOf(result.rows) !== arrayPrototype
      || objectIsFrozen(result.rows) !== frozen || result.rows.length !== 1
      || reflectOwnKeys(result.rows).length !== 2) fail();
  const rowDescriptor = objectGetOwnPropertyDescriptor(result.rows, '0');
  const lengthDescriptor = objectGetOwnPropertyDescriptor(result.rows, 'length');
  if (!rowDescriptor || !objectHasOwn(rowDescriptor, 'value') || !rowDescriptor.enumerable
      || rowDescriptor.writable === frozen || rowDescriptor.configurable === frozen
      || !lengthDescriptor || !objectHasOwn(lengthDescriptor, 'value') || lengthDescriptor.value !== 1
      || lengthDescriptor.enumerable || lengthDescriptor.configurable || lengthDescriptor.writable === frozen) fail();
  const row = snapshot(rowDescriptor.value, ['operation_id', 'expires_at'], frozen);
  if (!row || typeof row.operation_id !== 'string' || !test(UUID, row.operation_id)
      || row.operation_id === input.clientId || row.operation_id === input.locationId
      || row.operation_id === input.endpointId || row.operation_id === input.staffUserId
      || row.operation_id === input.authSessionId || typeof row.expires_at !== 'string'
      || !test(TIMESTAMP, row.expires_at)
      || !numberIsFinite(reflectApply(dateParse, dateConstructor, [row.expires_at]))) fail();
  return objectFreeze({ operationId: row.operation_id, expiresAt: row.expires_at });
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
        const output = reflectApply(query, queryOwner, [SQL, params]);
        if (output !== null && typeof output === 'object' && objectGetPrototypeOf(output) === promisePrototype) {
          return reflectApply(promiseThen, output, [
            result => acknowledgement(result, input),
            () => fail(),
          ]);
        }
        return acknowledgement(output, input);
      } catch (_) { fail(); }
    }
    return objectFreeze({ create });
  } catch (_) { fail(); }
}

module.exports = objectFreeze({ createGoogleOAuthTransactionRepository });
