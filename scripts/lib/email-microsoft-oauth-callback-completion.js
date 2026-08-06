'use strict';

/**
 * Stage 6 Microsoft OAuth callback completion service.
 *
 * Atomically consumes a bound tenant_email_oauth_transactions row (owner +
 * state hash + clock) and, on a provider success code, hands server-confined
 * completion material once to an authorization completion boundary. Public
 * surface stays the existing status-only callback contract.
 *
 * Does NOT wire routes, token exchange, Azure, or DB installer construction.
 * Existing createMicrosoftOAuthCallbackService (disabled-route export) is
 * untouched; this is the completing composition for later route wiring.
 *
 * Factory takes exact frozen dependencies:
 *   repository  — owner-preserving { consume }
 *   completion  — owner-preserving { completeAuthorization }
 *   env         — sunset-staging + callback enabled + canonical app client id
 *   clock       — { now } → one Date (no accept-time clock control)
 *
 * Returns exact frozen single-use { accept }. Atomic burn before input
 * reflection. One fixed sanitized thrown error. No logs / no secret leaks.
 *
 * Flow:
 *   1) burn
 *   2) snapshot owner (strict ordered) + callback input (code: allowlisted
 *      state/code + optional session_state any order; error: exact ordered
 *      state/error; session_state never forwarded)
 *   3) hash state; clock once; consume once with owner/time
 *   4) no row → { status: 'invalid_or_expired' }
 *   5) snapshot/validate RETURNING row (exact own-data keys, SQL order set,
 *      canonical UUIDs, PKCE/nonce bounds); copy once — never reread driver row
 *   6) provider error → { status: 'authorization_declined' } (no completion)
 *   7) code → completeAuthorization once with exact frozen nine-key
 *      COMPLETION_KEYS sourced only from snapshots/env (no authSession/state/
 *      hash/raw row/error/token). Names stay transactionId/staffUserId at this
 *      boundary; downstream operation composer maps them later.
 *   8) require exact frozen completion ack → { status: 'authorization_received' }
 *
 * Hostile row / completion failures after consume stay consumed (no retry).
 *
 * @module email-microsoft-oauth-callback-completion
 */

const crypto = require('crypto');

const {
  OWNER_KEYS,
  CALLBACK_CODE_KEYS,
  CALLBACK_ERROR_KEYS,
  SQL_CONSUME_TRANSACTION,
} = require('./email-microsoft-oauth-transaction-service');

const ERROR_CODE = 'MICROSOFT_OAUTH_CALLBACK_COMPLETION_INVALID';
const ERROR_MESSAGE = 'Microsoft OAuth callback completion failed.';

const ACCEPT_METHOD = 'accept';
const COMPLETION_METHOD = 'completeAuthorization';
const COMPLETION_ACK_STATUS = 'completed';
const COMPLETION_ACK = Object.freeze({ status: COMPLETION_ACK_STATUS });

const PUBLIC_STATUS_INVALID = Object.freeze({ status: 'invalid_or_expired' });
const PUBLIC_STATUS_DECLINED = Object.freeze({ status: 'authorization_declined' });
const PUBLIC_STATUS_RECEIVED = Object.freeze({ status: 'authorization_received' });

const DEPENDENCY_KEYS = Object.freeze([
  'repository',
  'completion',
  'env',
  'clock',
]);

/** Exact consume RETURNING key set — SQL textual order (061-bound row). */
const CONSUME_ROW_KEYS = Object.freeze([
  'id',
  'location_id',
  'staff_user_id',
  'code_verifier',
  'nonce',
  'endpoint_id',
]);
const CONSUME_ROW_KEY_SET = new Set(CONSUME_ROW_KEYS);

/**
 * Exact ordered nine-key completion material (server-confined).
 * Required order: authorizationCode first, then transactionId, clientId,
 * locationId, endpointId, staffUserId, codeVerifier, nonce,
 * applicationClientId last.
 * Sourced only from owner/input/row snapshots + env application client id.
 * Never authSession, state, state hash, raw DB row, provider error, or token.
 * Keep transactionId/staffUserId names here; do not rename to operationId/
 * actorStaffUserId at this callback boundary.
 */
const COMPLETION_KEYS = Object.freeze([
  'authorizationCode',
  'transactionId',
  'clientId',
  'locationId',
  'endpointId',
  'staffUserId',
  'codeVerifier',
  'nonce',
  'applicationClientId',
]);

/**
 * Optional Entra success key: validated if present, never returned/persisted/logged.
 * Required success keys stay CALLBACK_CODE_KEYS; order is not semantic.
 */
const CALLBACK_CODE_OPTIONAL_KEYS = Object.freeze(['session_state']);
const CALLBACK_CODE_ALLOWED = Object.freeze(
  new Set([...CALLBACK_CODE_KEYS, ...CALLBACK_CODE_OPTIONAL_KEYS]),
);

const SUNSET_DEPLOYMENT = 'sunset-staging';
/** Canonical lowercase hyphenated UUID (same grammar as migration shapes). */
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Owner may arrive mixed-case from session material; normalize after grammar. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL_32_RE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
/** Migration 060 nonce_shape: 43–128 of base64url alphabet (no . ~). */
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const PROVIDER_CODE_RE = /^[\x21-\x7e]{1,4096}$/;
const PROVIDER_ERROR_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** session_state: bounded provider opaque (UUID is a subset); never forwarded. */
const PROVIDER_SESSION_STATE_RE = /^[\x21-\x7e]{1,256}$/;

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'MicrosoftOAuthCallbackCompletionError' });
  Object.defineProperty(error, 'code', { value: ERROR_CODE, enumerable: true });
  return Object.freeze(error);
}

function ownData(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor
      && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      && !descriptor.get
      && !descriptor.set
      ? descriptor.value
      : undefined;
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

function exactFrozenData(object, keys) {
  return Boolean(object && Object.isFrozen(object) && exactPlainData(object, keys));
}

function exactFrozenService(object, methodName) {
  return Boolean(
    exactFrozenData(object, [methodName])
    && typeof ownData(object, methodName) === 'function',
  );
}

/**
 * Exact immutable ordered own-data snapshot.
 * Object.prototype or null prototype; exact key order; enumerable data only.
 */
function snapshotExactOrderedOwnData(input, keys) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(input);
    if (actual.length !== keys.length) return null;
    for (let i = 0; i < keys.length; i += 1) {
      if (actual[i] !== keys[i]) return null;
    }
    const out = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable) {
        return null;
      }
      out[key] = descriptor.value;
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
}

function snapshotExactOrderedUuids(input, keys) {
  const raw = snapshotExactOrderedOwnData(input, keys);
  if (!raw) return null;
  const out = Object.create(null);
  for (const key of keys) {
    const value = raw[key];
    if (typeof value !== 'string' || !UUID_RE.test(value)) return null;
    out[key] = value.toLowerCase();
  }
  return Object.freeze(out);
}

/**
 * Read one own enumerable data descriptor value exactly once.
 * Accessors / missing / non-enumerable / traps → null.
 */
function readOwnEnumerableDataOnce(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.get
      || descriptor.set
      || !descriptor.enumerable) {
    return null;
  }
  return { value: descriptor.value };
}

/**
 * Code success: allowlisted own keys state+code plus optional session_state,
 * any order (OAuth query order is not semantic). Validates and copies state
 * and code once; validates session_state if present but never returns it.
 * Rejects symbols, duplicates, extras, accessors, inherited-only, traps.
 */
function snapshotCallbackCodeInput(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(input);
    if (actual.length < CALLBACK_CODE_KEYS.length
        || actual.length > CALLBACK_CODE_ALLOWED.size) {
      return null;
    }
    const seen = new Set();
    for (const key of actual) {
      if (typeof key !== 'string' || !CALLBACK_CODE_ALLOWED.has(key) || seen.has(key)) {
        return null;
      }
      seen.add(key);
    }
    for (const required of CALLBACK_CODE_KEYS) {
      if (!seen.has(required)) return null;
    }

    const stateRead = readOwnEnumerableDataOnce(input, 'state');
    if (!stateRead) return null;
    const codeRead = readOwnEnumerableDataOnce(input, 'code');
    if (!codeRead) return null;
    if (typeof stateRead.value !== 'string' || !B64URL_32_RE.test(stateRead.value)) return null;
    if (typeof codeRead.value !== 'string' || !PROVIDER_CODE_RE.test(codeRead.value)) return null;

    if (seen.has('session_state')) {
      const sessionRead = readOwnEnumerableDataOnce(input, 'session_state');
      if (!sessionRead) return null;
      if (typeof sessionRead.value !== 'string'
          || !PROVIDER_SESSION_STATE_RE.test(sessionRead.value)) {
        return null;
      }
      // Validated and discarded — never pass, persist, or log.
    }

    return Object.freeze({
      kind: 'code',
      state: stateRead.value,
      code: codeRead.value,
    });
  } catch {
    return null;
  }
}

function snapshotCallbackInput(input) {
  const codeSnap = snapshotCallbackCodeInput(input);
  if (codeSnap) return codeSnap;
  // Error path: preserve exact ordered own-data ['state','error'] only.
  const raw = snapshotExactOrderedOwnData(input, CALLBACK_ERROR_KEYS);
  if (!raw) return null;
  if (typeof raw.state !== 'string' || !B64URL_32_RE.test(raw.state)) return null;
  if (typeof raw.error !== 'string' || !PROVIDER_ERROR_RE.test(raw.error)) return null;
  return Object.freeze({ kind: 'error', state: raw.state, error: raw.error });
}

/**
 * Exact own-data DB row surface for node-postgres RETURNING rows.
 * Safe prototypes only (Object.prototype or null). Exact key set matching
 * SQL textual order constants; no symbols/accessors/extras.
 */
function snapshotExactOwnDataRow(row, keys, keySet) {
  try {
    if (!row || typeof row !== 'object') return null;
    const proto = Object.getPrototypeOf(row);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(row);
    if (actual.length !== keys.length) return null;
    for (const key of actual) {
      if (typeof key !== 'string' || !keySet.has(key)) return null;
    }
    const out = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (!descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable) {
        return null;
      }
      out[key] = descriptor.value;
    }
    return out;
  } catch {
    return null;
  }
}

function isCanonicalUuid(value) {
  return typeof value === 'string' && UUID_CANON.test(value);
}

/**
 * Snapshot + validate consume RETURNING once into a fresh frozen record.
 * Canonical UUIDs (already-lowercase) and PKCE/nonce bounds.
 */
function snapshotAndValidateConsumeRow(row) {
  const own = snapshotExactOwnDataRow(row, CONSUME_ROW_KEYS, CONSUME_ROW_KEY_SET);
  if (!own) return null;

  if (!isCanonicalUuid(own.id)
      || !isCanonicalUuid(own.location_id)
      || !isCanonicalUuid(own.staff_user_id)
      || !isCanonicalUuid(own.endpoint_id)) {
    return null;
  }
  if (typeof own.code_verifier !== 'string' || !PKCE_VERIFIER_RE.test(own.code_verifier)) {
    return null;
  }
  if (typeof own.nonce !== 'string' || !NONCE_RE.test(own.nonce)) {
    return null;
  }

  return Object.freeze({
    transactionId: own.id,
    locationId: own.location_id,
    staffUserId: own.staff_user_id,
    codeVerifier: own.code_verifier,
    nonce: own.nonce,
    endpointId: own.endpoint_id,
  });
}

function sealedCompletionAck(value) {
  return Boolean(
    value
    && Object.isFrozen(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === 1
    && ownData(value, 'status') === COMPLETION_ACK_STATUS,
  );
}

/**
 * Snapshot env at factory: sunset-staging + callback enabled + canonical app id.
 * Accepts process.env-like objects (does not require frozen env).
 */
function snapshotEnv(env) {
  try {
    if (!env || typeof env !== 'object') return null;
    const deployment = env.LUNA_DEPLOYMENT;
    const enabled = env.LUNA_EMAIL_OAUTH_CALLBACK_ENABLED;
    const appId = env.LUNA_EMAIL_OAUTH_CLIENT_ID;
    if (deployment !== SUNSET_DEPLOYMENT) return null;
    if (enabled !== 'true') return null;
    if (typeof appId !== 'string' || !UUID_RE.test(appId)) return null;
    return Object.freeze({ applicationClientId: appId.toLowerCase() });
  } catch {
    return null;
  }
}

function pinDependencies(dependencies) {
  if (!exactFrozenData(dependencies, DEPENDENCY_KEYS)) return null;

  const repository = ownData(dependencies, 'repository');
  const completion = ownData(dependencies, 'completion');
  const env = ownData(dependencies, 'env');
  const clock = ownData(dependencies, 'clock');

  if (!exactFrozenService(repository, 'consume')) return null;
  if (!exactFrozenService(completion, COMPLETION_METHOD)) return null;
  if (!exactFrozenService(clock, 'now')) return null;

  const envSnap = snapshotEnv(env);
  if (!envSnap) return null;

  return Object.freeze({
    repository,
    consume: ownData(repository, 'consume'),
    completion,
    completeAuthorization: ownData(completion, COMPLETION_METHOD),
    applicationClientId: envSnap.applicationClientId,
    clock,
    now: ownData(clock, 'now'),
  });
}

/**
 * @param {object} dependencies exact frozen { repository, completion, env, clock }
 * @returns {{ accept: Function }} frozen single-use callback completion surface
 */
function createMicrosoftOAuthCallbackCompletionService(dependencies) {
  let pinned;
  try {
    pinned = pinDependencies(dependencies);
    if (!pinned) throw failure();
  } catch {
    throw failure();
  }

  let used = false;
  async function accept(input, owner) {
    if (used) throw failure();
    used = true; // Atomic burn before input reflection, await, consume, or completion.

    try {
      const ownerSnap = snapshotExactOrderedUuids(owner, OWNER_KEYS);
      if (!ownerSnap) throw failure();
      const inputSnap = snapshotCallbackInput(input);
      if (!inputSnap) throw failure();

      const stateHash = crypto.createHash('sha256').update(inputSnap.state, 'ascii').digest();
      if (!Buffer.isBuffer(stateHash) || stateHash.length !== 32) throw failure();

      let rawNow;
      try {
        rawNow = Reflect.apply(pinned.now, pinned.clock, []);
      } catch {
        throw failure();
      }
      if (!(rawNow instanceof Date) || Number.isNaN(rawNow.getTime())) throw failure();
      // One Date for consume; independent of later clock mutation.
      const now = new Date(rawNow.getTime());

      let rawRow;
      try {
        rawRow = await Reflect.apply(pinned.consume, pinned.repository, [Object.freeze({
          stateHash,
          clientId: ownerSnap.clientId,
          authSessionId: ownerSnap.authSessionId,
          now,
        })]);
      } catch {
        throw failure();
      }

      if (rawRow == null) {
        return PUBLIC_STATUS_INVALID;
      }

      // Snapshot once: never reread mutable driver row for completion material.
      const rowSnap = snapshotAndValidateConsumeRow(rawRow);
      if (!rowSnap) throw failure();

      if (inputSnap.kind === 'error') {
        return PUBLIC_STATUS_DECLINED;
      }

      // Code path: hand exact frozen ordered nine-key completion material once
      // (authorizationCode first … applicationClientId last).
      const completionInput = Object.freeze({
        authorizationCode: inputSnap.code,
        transactionId: rowSnap.transactionId,
        clientId: ownerSnap.clientId,
        locationId: rowSnap.locationId,
        endpointId: rowSnap.endpointId,
        staffUserId: rowSnap.staffUserId,
        codeVerifier: rowSnap.codeVerifier,
        nonce: rowSnap.nonce,
        applicationClientId: pinned.applicationClientId,
      });
      if (!exactPlainData(completionInput, COMPLETION_KEYS)) throw failure();
      // Hard ban: no authSession/state/hash/raw row/error/token on completion surface.
      // Also ban premature operation renames at this boundary.
      if ('authSessionId' in completionInput
          || 'state' in completionInput
          || 'stateHash' in completionInput
          || 'error' in completionInput
          || 'accessToken' in completionInput
          || 'refreshToken' in completionInput
          || 'idToken' in completionInput
          || 'token' in completionInput
          || 'operationId' in completionInput
          || 'actorStaffUserId' in completionInput
          || 'id' in completionInput
          || 'location_id' in completionInput
          || 'staff_user_id' in completionInput
          || 'code_verifier' in completionInput
          || 'endpoint_id' in completionInput) {
        throw failure();
      }

      let ack;
      try {
        ack = await Reflect.apply(
          pinned.completeAuthorization,
          pinned.completion,
          [completionInput],
        );
      } catch {
        // Consumed; no retry. Public route later sanitizes.
        throw failure();
      }
      if (!sealedCompletionAck(ack)) throw failure();

      return PUBLIC_STATUS_RECEIVED;
    } catch (err) {
      if (err && err.code === ERROR_CODE) throw err;
      throw failure();
    }
  }

  return Object.freeze({ accept });
}

module.exports = Object.freeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  ACCEPT_METHOD,
  COMPLETION_METHOD,
  COMPLETION_ACK_STATUS,
  COMPLETION_ACK,
  PUBLIC_STATUS_INVALID,
  PUBLIC_STATUS_DECLINED,
  PUBLIC_STATUS_RECEIVED,
  DEPENDENCY_KEYS,
  CONSUME_ROW_KEYS,
  COMPLETION_KEYS,
  OWNER_KEYS,
  CALLBACK_CODE_KEYS,
  CALLBACK_ERROR_KEYS,
  SQL_CONSUME_TRANSACTION,
  SUNSET_DEPLOYMENT,
  createMicrosoftOAuthCallbackCompletionService,
});
