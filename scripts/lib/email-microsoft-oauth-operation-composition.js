'use strict';

/**
 * Stage 6 Microsoft OAuth operation composition.
 *
 * Downstream completeAuthorization dependency for merged callback completion.
 * Composes only merged factories in this exact mapping (per call, after input
 * validation — no child before validation):
 *
 *   1) createMicrosoftVerifiedGrantCustodyAdapter(config, custodyDeps)
 *   2) createMicrosoftTokenResponseCustodyService({ custody, transportDeps })
 *   3) createMicrosoftAuthorizationCodeRequestService({
 *        deployment, applicationClientId, secretProvider, responseCustody
 *      })
 *   4) invoke exchangeAuthorizationCode once with exact frozen
 *      { authorizationCode, codeVerifier, clientId: applicationClientId }
 *      preserving the auth-request receiver
 *   5) require exact frozen { status: 'custodied' }
 *   6) return exact frozen { status: 'completed' } for callback
 *
 * Factory pins exact frozen owner-preserving dependencies (ordered bag).
 * transportDeps is snapshotted/frozen at factory time into an offline-compatible
 * bag accepted by merged token transport — no ambient https/timers substitution
 * after factory.
 *
 * Input is the exact frozen nine-key COMPLETION_KEYS order from callback
 * (authorizationCode first … applicationClientId last). Maps at this boundary:
 *   transactionId → operationId
 *   staffUserId   → actorStaffUserId
 * locationId is validated/snapshotted as retained boundary context only —
 * transaction INSERT already atomically bound location+endpoint; no downstream
 * may choose or re-derive endpoint from locationId.
 *
 * Single-use atomic burn before input reflection. One fixed sanitized error.
 * Never expose/log input, tokens, identity/envelope, or child errors.
 * No routes / runtime env composition / deploy / live network.
 *
 * @module email-microsoft-oauth-operation-composition
 */

const {
  createMicrosoftVerifiedGrantCustodyAdapter,
  CONFIG_KEYS: CUSTODY_CONFIG_KEYS,
} = require('./email-microsoft-verified-grant-custody');
const {
  createMicrosoftTokenResponseCustodyService,
} = require('./email-microsoft-response-custody-handoff');
const {
  createMicrosoftAuthorizationCodeRequestService,
  SUNSET_DEPLOYMENT: AUTH_SUNSET_DEPLOYMENT,
} = require('./email-microsoft-authorization-code-request');
const {
  validateEmailGrantEnvelopeProvider,
} = require('./email-grant-envelope-provider-contract');

/** Exact custody dependency order — must match verified-grant custody DEPENDENCY_KEYS. */
const CUSTODY_DEPENDENCY_KEYS = Object.freeze([
  'verifiedIdentity',
  'envelopeProvider',
  'clock',
  'installer',
]);

const ERROR_CODE = 'MICROSOFT_OAUTH_OPERATION_COMPOSITION_INVALID';
const ERROR_MESSAGE = 'Microsoft OAuth operation composition failed.';

const COMPLETION_METHOD = 'completeAuthorization';
const COMPLETION_ACK_STATUS = 'completed';
const COMPLETION_ACK = Object.freeze({ status: COMPLETION_ACK_STATUS });
const CUSTODY_SUCCESS_STATUS = 'custodied';

/**
 * Exact ordered nine-key completion material from callback (server-confined).
 * Must match email-microsoft-oauth-callback-completion COMPLETION_KEYS exactly.
 * Names stay transactionId/staffUserId on the wire; this composer maps them.
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
 * Exact frozen factory dependency order (construction-aligned):
 * custody deps → transportDeps (response custody) → secretProvider (auth request).
 */
const DEPENDENCY_KEYS = Object.freeze([
  'verifiedIdentity',
  'envelopeProvider',
  'clock',
  'installer',
  'transportDeps',
  'secretProvider',
]);

/** Offline transport bag accepted by merged createMicrosoftTokenHttpTransport. */
const TRANSPORT_DEPS_KEYS = Object.freeze(['httpsImpl', 'timers']);
const TIMERS_KEYS = Object.freeze(['setTimeout', 'clearTimeout']);

/**
 * Exact exchangeAuthorizationCode input order for merged auth-code request.
 * clientId is the application (OAuth app) client id, not the tenant client id.
 */
const AUTH_EXCHANGE_KEYS = Object.freeze([
  'authorizationCode',
  'codeVerifier',
  'clientId',
]);

const SUNSET_DEPLOYMENT = 'sunset-staging';
/** Canonical lowercase hyphenated UUID (same grammar as callback / migrations). */
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** PKCE verifier bounds — match transaction / callback consume row. */
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
/** Migration 060 nonce_shape: 43–128 of base64url alphabet (no . ~). */
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/;
/** Provider authorization code bounds — match callback PROVIDER_CODE_RE. */
const PROVIDER_CODE_RE = /^[\x21-\x7e]{1,4096}$/;

// Static alignment: auth-code request sunset constant must match local pin.
if (AUTH_SUNSET_DEPLOYMENT !== SUNSET_DEPLOYMENT) {
  throw new Error('oauth_operation_composition_sunset_deployment_mismatch');
}

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'MicrosoftOAuthOperationCompositionError' });
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

function exactSecretProvider(object) {
  return Boolean(
    object
    && Object.getPrototypeOf(object) === Object.prototype
    && exactPlainData(object, ['getClientSecret'])
    && typeof ownData(object, 'getClientSecret') === 'function',
  );
}

function isCanonicalUuid(value) {
  return typeof value === 'string' && UUID_CANON.test(value);
}

/**
 * Exact immutable ordered own-data snapshot (Object.prototype or null proto).
 * Requires exact key order matching `keys`.
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

/**
 * Snapshot + validate completion material once into a fresh frozen record.
 * locationId is retained boundary context only (not re-derived into endpoint).
 */
function snapshotAndValidateCompletionInput(input) {
  // Prefer exact frozen callback material; also accept exact ordered plain own-data
  // that we re-freeze (hostile plain objects still go through full validation).
  if (!input || typeof input !== 'object') return null;
  if (Object.isFrozen(input)) {
    if (!exactFrozenData(input, COMPLETION_KEYS)) return null;
    // Still enforce exact order (exactFrozenData is set-membership only).
    const ordered = Reflect.ownKeys(input);
    if (ordered.length !== COMPLETION_KEYS.length) return null;
    for (let i = 0; i < COMPLETION_KEYS.length; i += 1) {
      if (ordered[i] !== COMPLETION_KEYS[i]) return null;
    }
  }

  const raw = snapshotExactOrderedOwnData(input, COMPLETION_KEYS);
  if (!raw) return null;

  const authorizationCode = raw.authorizationCode;
  const transactionId = raw.transactionId;
  const clientId = raw.clientId;
  const locationId = raw.locationId;
  const endpointId = raw.endpointId;
  const staffUserId = raw.staffUserId;
  const codeVerifier = raw.codeVerifier;
  const nonce = raw.nonce;
  const applicationClientId = raw.applicationClientId;

  if (typeof authorizationCode !== 'string' || !PROVIDER_CODE_RE.test(authorizationCode)) {
    return null;
  }
  if (!isCanonicalUuid(transactionId)
      || !isCanonicalUuid(clientId)
      || !isCanonicalUuid(locationId)
      || !isCanonicalUuid(endpointId)
      || !isCanonicalUuid(staffUserId)
      || !isCanonicalUuid(applicationClientId)) {
    return null;
  }
  if (typeof codeVerifier !== 'string' || !PKCE_VERIFIER_RE.test(codeVerifier)) {
    return null;
  }
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
    return null;
  }

  // locationId retained as boundary context only — never used to choose endpoint.
  return Object.freeze({
    authorizationCode,
    transactionId,
    clientId,
    locationId,
    endpointId,
    staffUserId,
    codeVerifier,
    nonce,
    applicationClientId,
  });
}

/**
 * Snapshot exact offline transport dependency bag.
 * Pins httpsImpl + timers receivers; rejects ambient defaulting holes.
 */
function snapshotTransportDeps(raw) {
  try {
    if (!exactFrozenData(raw, TRANSPORT_DEPS_KEYS)) return null;
    // Enforce exact key order for maintainable freeze contract.
    const ordered = Reflect.ownKeys(raw);
    if (ordered.length !== TRANSPORT_DEPS_KEYS.length) return null;
    for (let i = 0; i < TRANSPORT_DEPS_KEYS.length; i += 1) {
      if (ordered[i] !== TRANSPORT_DEPS_KEYS[i]) return null;
    }

    const httpsImpl = ownData(raw, 'httpsImpl');
    const timers = ownData(raw, 'timers');
    if (!httpsImpl || (typeof httpsImpl !== 'object' && typeof httpsImpl !== 'function')) {
      return null;
    }
    // Merged transport calls httpsImpl.request(...); require a callable request.
    if (typeof httpsImpl.request !== 'function') return null;

    // Timers: exact own-data setTimeout + clearTimeout (no ambient substitution).
    if (!timers || typeof timers !== 'object' || Array.isArray(timers)) return null;
    const timerProto = Object.getPrototypeOf(timers);
    if (timerProto !== Object.prototype && timerProto !== null) return null;
    const timerKeys = Reflect.ownKeys(timers);
    if (timerKeys.length !== TIMERS_KEYS.length) return null;
    for (let i = 0; i < TIMERS_KEYS.length; i += 1) {
      if (timerKeys[i] !== TIMERS_KEYS[i]) return null;
    }
    const setTimeoutFn = ownData(timers, 'setTimeout');
    const clearTimeoutFn = ownData(timers, 'clearTimeout');
    if (typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
      return null;
    }

    // Freeze a fresh bag pinning the exact receivers (no later ambient merge).
    return Object.freeze({
      httpsImpl,
      timers: Object.freeze({
        setTimeout: setTimeoutFn,
        clearTimeout: clearTimeoutFn,
      }),
    });
  } catch {
    return null;
  }
}

function sealedCustodySuccess(value) {
  return Boolean(
    value
    && Object.isFrozen(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === 1
    && ownData(value, 'status') === CUSTODY_SUCCESS_STATUS,
  );
}

function pinDependencies(dependencies) {
  if (!exactFrozenData(dependencies, DEPENDENCY_KEYS)) return null;

  // Exact order (construction-aligned) — set membership alone is insufficient.
  const ordered = Reflect.ownKeys(dependencies);
  if (ordered.length !== DEPENDENCY_KEYS.length) return null;
  for (let i = 0; i < DEPENDENCY_KEYS.length; i += 1) {
    if (ordered[i] !== DEPENDENCY_KEYS[i]) return null;
  }

  const verifiedIdentity = ownData(dependencies, 'verifiedIdentity');
  const envelopeProvider = ownData(dependencies, 'envelopeProvider');
  const clock = ownData(dependencies, 'clock');
  const installer = ownData(dependencies, 'installer');
  const transportDepsRaw = ownData(dependencies, 'transportDeps');
  const secretProvider = ownData(dependencies, 'secretProvider');

  if (!exactFrozenService(verifiedIdentity, 'verifyIdentity')) return null;
  if (!exactFrozenService(clock, 'nowEpochSeconds')) return null;
  if (!exactFrozenService(installer, 'installVerifiedGrant')) return null;
  if (!exactSecretProvider(secretProvider)) return null;

  const providerOk = validateEmailGrantEnvelopeProvider(envelopeProvider);
  if (!providerOk.ok) return null;

  const transportDeps = snapshotTransportDeps(transportDepsRaw);
  if (!transportDeps) return null;

  return Object.freeze({
    verifiedIdentity,
    envelopeProvider,
    clock,
    installer,
    transportDeps,
    secretProvider,
  });
}

/**
 * Build exact frozen verified-grant custody config from snapshotted completion.
 * locationId is intentionally omitted — endpoint is already transaction-bound.
 */
function buildCustodyConfig(snap) {
  const config = Object.freeze({
    clientId: snap.clientId,
    endpointId: snap.endpointId,
    operationId: snap.transactionId,
    actorStaffUserId: snap.staffUserId,
    expectedNonce: snap.nonce,
    expectedClientId: snap.applicationClientId,
  });
  if (!exactFrozenData(config, CUSTODY_CONFIG_KEYS)) return null;
  // Hard ban: location must not leak into custody config (no location-derived endpoint).
  if ('locationId' in config || 'location_id' in config) return null;
  return config;
}

/**
 * @param {object} dependencies exact frozen ordered DEPENDENCY_KEYS bag
 * @returns {{ completeAuthorization: Function }} frozen single-use surface
 */
function createMicrosoftOAuthOperationComposition(dependencies) {
  let pinned;
  try {
    pinned = pinDependencies(dependencies);
    if (!pinned) throw failure();
  } catch {
    throw failure();
  }

  let used = false;
  async function completeAuthorization(input) {
    if (used) throw failure();
    used = true; // Atomic burn before input reflection, child construction, or awaits.

    try {
      const snap = snapshotAndValidateCompletionInput(input);
      if (!snap) throw failure();

      // ── Child construction only after validation ──────────────────────────
      const custodyConfig = buildCustodyConfig(snap);
      if (!custodyConfig) throw failure();

      const custodyDeps = Object.freeze({
        verifiedIdentity: pinned.verifiedIdentity,
        envelopeProvider: pinned.envelopeProvider,
        clock: pinned.clock,
        installer: pinned.installer,
      });
      if (!exactFrozenData(custodyDeps, CUSTODY_DEPENDENCY_KEYS)) throw failure();

      let grantCustody;
      try {
        grantCustody = createMicrosoftVerifiedGrantCustodyAdapter(
          custodyConfig,
          custodyDeps,
        );
      } catch {
        throw failure();
      }
      if (!exactFrozenService(grantCustody, 'acceptValidatedTokens')) throw failure();

      let responseCustody;
      try {
        // Exact offline transportDeps pin — no ambient substitution.
        responseCustody = createMicrosoftTokenResponseCustodyService({
          transportDeps: pinned.transportDeps,
          custody: grantCustody,
        });
      } catch {
        throw failure();
      }
      if (!exactFrozenService(responseCustody, 'exchangeAndCustody')) throw failure();

      let authRequest;
      try {
        authRequest = createMicrosoftAuthorizationCodeRequestService({
          deployment: SUNSET_DEPLOYMENT,
          applicationClientId: snap.applicationClientId,
          secretProvider: pinned.secretProvider,
          responseCustody,
        });
      } catch {
        throw failure();
      }
      if (!exactFrozenService(authRequest, 'exchangeAuthorizationCode')) throw failure();

      // Exact frozen exchange input: application client id as clientId (not tenant).
      const exchangeInput = Object.freeze({
        authorizationCode: snap.authorizationCode,
        codeVerifier: snap.codeVerifier,
        clientId: snap.applicationClientId,
      });
      if (!exactPlainData(exchangeInput, AUTH_EXCHANGE_KEYS)) throw failure();
      if (exchangeInput.clientId !== snap.applicationClientId) throw failure();
      // Hard ban: location/endpoint/operation/actor/tokens never on exchange surface.
      if ('locationId' in exchangeInput
          || 'endpointId' in exchangeInput
          || 'transactionId' in exchangeInput
          || 'operationId' in exchangeInput
          || 'staffUserId' in exchangeInput
          || 'actorStaffUserId' in exchangeInput
          || 'nonce' in exchangeInput
          || 'accessToken' in exchangeInput
          || 'refreshToken' in exchangeInput
          || 'idToken' in exchangeInput) {
        throw failure();
      }

      const exchangeFn = ownData(authRequest, 'exchangeAuthorizationCode');
      let custodyAck;
      try {
        custodyAck = await Reflect.apply(exchangeFn, authRequest, [exchangeInput]);
      } catch {
        throw failure();
      }
      if (!sealedCustodySuccess(custodyAck)) throw failure();

      return COMPLETION_ACK;
    } catch (err) {
      if (err && err.code === ERROR_CODE) throw err;
      throw failure();
    }
  }

  return Object.freeze({ completeAuthorization });
}

module.exports = Object.freeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  COMPLETION_METHOD,
  COMPLETION_ACK_STATUS,
  COMPLETION_ACK,
  CUSTODY_SUCCESS_STATUS,
  COMPLETION_KEYS,
  DEPENDENCY_KEYS,
  TRANSPORT_DEPS_KEYS,
  TIMERS_KEYS,
  AUTH_EXCHANGE_KEYS,
  SUNSET_DEPLOYMENT,
  createMicrosoftOAuthOperationComposition,
});
