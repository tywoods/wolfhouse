'use strict';

/**
 * Stage 6 standalone Microsoft verified-identity composition.
 * OIDC ID-token validation first; Graph /me identity second; constant-time
 * principal match. Frozen atomic single-use. No custody/callback/routes/DB/live.
 *
 * Exact frozen contracts: outer dependencies bag, top-level input, and both
 * child result objects must be Object.isFrozen. Snapshotted input is validated
 * synchronously against merged child bounds before the first await.
 *
 * @module email-microsoft-verified-identity
 */

const { timingSafeEqual } = require('crypto');
const {
  resolveOptionalStageTelemetry,
  safeEmitStage,
} = require('./email-microsoft-oauth-stage-telemetry');

const ERROR_CODE = 'MICROSOFT_VERIFIED_IDENTITY_INVALID';
const ERROR_MESSAGE = 'Microsoft verified identity validation failed.';
const PRINCIPAL_LIMIT = 256;
const ID_TOKEN_LIMIT = 32768;
const ACCESS_TOKEN_LIMIT = 16384;
const NONCE_LIMIT = 512;
const CLIENT_ID_LIMIT = 256;
const MAILBOX_MIN = 3;
const MAILBOX_MAX = 254;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Exact Graph mailbox syntax after normalization (lowercase canonical form only).
const CANONICAL_MAILBOX_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const INPUT_KEYS = Object.freeze([
  'idToken',
  'accessToken',
  'expectedNonce',
  'expectedClientId',
  'nowEpochSeconds',
]);
const DEPENDENCY_KEYS = Object.freeze(['oidcValidator', 'graphIdentity']);
const OIDC_RESULT_KEYS = Object.freeze(['providerTenantId', 'providerPrincipalId']);
const GRAPH_RESULT_KEYS = Object.freeze(['providerSubjectId', 'mailboxAddress', 'displayName']);
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'MicrosoftVerifiedIdentityError' });
  Object.defineProperty(error, 'code', { value: ERROR_CODE, enumerable: true });
  return Object.freeze(error);
}

function ownData(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
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

/** Exact own enumerable data keys AND Object.isFrozen. */
function exactFrozenData(object, keys) {
  return Boolean(object && Object.isFrozen(object) && exactPlainData(object, keys));
}

function exactFrozenService(object, methodName) {
  return Boolean(
    exactFrozenData(object, [methodName])
    && typeof ownData(object, methodName) === 'function',
  );
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** OIDC-aligned bounded text: non-empty, max length, no controls, no lone surrogates. */
function boundedOidcText(value, max) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && !hasUnpairedSurrogate(value)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Graph-aligned control-free text bounds (no unpaired-surrogate gate). */
function boundedGraphText(value, min, max) {
  return typeof value === 'string'
    && value.length >= min
    && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Graph mailbox contract for already-emitted result values.
 * Aligned with email-microsoft-graph-me-identity normalizeMailbox output:
 * lowercase canonical syntax only. Composer does NOT trim or case-fold.
 */
function isCanonicalGraphMailbox(value) {
  if (!boundedGraphText(value, MAILBOX_MIN, MAILBOX_MAX)) return false;
  if (value !== value.trim()) return false;
  if (value !== value.toLowerCase()) return false;
  if (!CANONICAL_MAILBOX_RE.test(value)) return false;
  if (value.includes('..')) return false;
  return true;
}

/** Constant-time bounded UTF-8 equality for principal identifiers. */
function safeEqualUtf8(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  const length = Math.max(a.length, b.length, 1);
  const aa = Buffer.alloc(length);
  const bb = Buffer.alloc(length);
  a.copy(aa);
  b.copy(bb);
  return timingSafeEqual(aa, bb) && a.length === b.length;
}

/**
 * Require frozen exact input; read own data descriptors once; validate merged
 * child bounds synchronously; return one frozen snapshot. No await.
 */
function snapshotAndValidateInput(input) {
  if (!exactFrozenData(input, INPUT_KEYS)) return null;

  const idToken = ownData(input, 'idToken');
  const accessToken = ownData(input, 'accessToken');
  const expectedNonce = ownData(input, 'expectedNonce');
  const expectedClientId = ownData(input, 'expectedClientId');
  const nowEpochSeconds = ownData(input, 'nowEpochSeconds');

  // OIDC idToken: bounded as accepted by OIDC (max 32768).
  if (!boundedOidcText(idToken, ID_TOKEN_LIMIT)) return null;
  // Graph accessToken: printable ASCII 0x21-0x7e, max 16384.
  if (typeof accessToken !== 'string'
      || accessToken.length < 1
      || accessToken.length > ACCESS_TOKEN_LIMIT
      || !PRINTABLE_ASCII.test(accessToken)) {
    return null;
  }
  // OIDC expectedNonce / expectedClientId bounds.
  if (!boundedOidcText(expectedNonce, NONCE_LIMIT)) return null;
  if (!boundedOidcText(expectedClientId, CLIENT_ID_LIMIT)) return null;
  // OIDC nowEpochSeconds: safe integer >= 0.
  if (!Number.isSafeInteger(nowEpochSeconds) || nowEpochSeconds < 0) return null;

  return Object.freeze({
    idToken,
    accessToken,
    expectedNonce,
    expectedClientId,
    nowEpochSeconds,
  });
}

function readOidcIdentity(value) {
  if (!exactFrozenData(value, OIDC_RESULT_KEYS)) return null;
  const providerTenantId = ownData(value, 'providerTenantId');
  const providerPrincipalId = ownData(value, 'providerPrincipalId');
  if (!boundedOidcText(providerTenantId, PRINCIPAL_LIMIT) || !UUID.test(providerTenantId)) return null;
  if (!boundedOidcText(providerPrincipalId, PRINCIPAL_LIMIT)) return null;
  return Object.freeze({ providerTenantId, providerPrincipalId });
}

function readGraphIdentity(value) {
  if (!exactFrozenData(value, GRAPH_RESULT_KEYS)) return null;
  const providerSubjectId = ownData(value, 'providerSubjectId');
  const mailboxAddress = ownData(value, 'mailboxAddress');
  const displayName = ownData(value, 'displayName');
  // Graph subject bounds plus the same unpaired-surrogate pair walk as OIDC.
  // Lone surrogates must never reach Buffer.from UTF-8 (which maps them to U+FFFD
  // and can collide with a literal OIDC principal containing U+FFFD).
  if (!boundedGraphText(providerSubjectId, 1, PRINCIPAL_LIMIT)
      || hasUnpairedSurrogate(providerSubjectId)) {
    return null;
  }
  // No trim/case normalization: require already-canonical Graph mailbox form.
  if (!isCanonicalGraphMailbox(mailboxAddress)) return null;
  if (displayName !== null) {
    if (!boundedGraphText(displayName, 1, PRINCIPAL_LIMIT)) return null;
  }
  return Object.freeze({ providerSubjectId, mailboxAddress, displayName });
}

function createMicrosoftVerifiedIdentityComposition(dependencies) {
  let oidcValidator;
  let graphIdentity;
  let validate;
  let fetchIdentity;
  let stageTelemetry;
  try {
    // Outer dependencies bag: core exact frozen, optional stageTelemetry.
    const resolved = resolveOptionalStageTelemetry(dependencies, DEPENDENCY_KEYS);
    if (!resolved.ok || !resolved.stageTelemetry) throw failure();
    stageTelemetry = resolved.stageTelemetry;
    oidcValidator = ownData(dependencies, 'oidcValidator');
    graphIdentity = ownData(dependencies, 'graphIdentity');
    if (!exactFrozenService(oidcValidator, 'validate')
        || !exactFrozenService(graphIdentity, 'fetchIdentity')) {
      throw failure();
    }
    validate = ownData(oidcValidator, 'validate');
    fetchIdentity = ownData(graphIdentity, 'fetchIdentity');
  } catch {
    throw failure();
  }

  let used = false;
  async function verifyIdentity(input) {
    if (used) throw failure();
    used = true; // Atomic burn before inspection, await, or dependency calls.
    try {
      // Snapshot once + synchronous merged-child bounds before first await.
      const snapshotted = snapshotAndValidateInput(input);
      if (!snapshotted) throw failure();

      let oidcRaw;
      try {
        oidcRaw = await Reflect.apply(validate, oidcValidator, [Object.freeze({
          idToken: snapshotted.idToken,
          expectedNonce: snapshotted.expectedNonce,
          expectedClientId: snapshotted.expectedClientId,
          nowEpochSeconds: snapshotted.nowEpochSeconds,
        })]);
      } catch {
        throw failure();
      }
      const oidcIdentity = readOidcIdentity(oidcRaw);
      if (!oidcIdentity) throw failure();
      // Milestone: OIDC id_token validation + principal/tenant extract succeeded.
      safeEmitStage(stageTelemetry, 'oidc_verified');

      let graphRaw;
      try {
        graphRaw = await Reflect.apply(fetchIdentity, graphIdentity, [Object.freeze({
          accessToken: snapshotted.accessToken,
        })]);
      } catch {
        throw failure();
      }
      const graphIdentityResult = readGraphIdentity(graphRaw);
      if (!graphIdentityResult) throw failure();

      if (!safeEqualUtf8(oidcIdentity.providerPrincipalId, graphIdentityResult.providerSubjectId)) {
        throw failure();
      }
      // Milestone: Graph /me identity + principal match succeeded.
      safeEmitStage(stageTelemetry, 'graph_identity_verified');

      // Minimized frozen output in fixed key order only.
      return Object.freeze({
        providerTenantId: oidcIdentity.providerTenantId,
        providerPrincipalId: oidcIdentity.providerPrincipalId,
        mailboxAddress: graphIdentityResult.mailboxAddress,
        displayName: graphIdentityResult.displayName,
      });
    } catch {
      throw failure();
    }
  }

  return Object.freeze({ verifyIdentity });
}

module.exports = Object.freeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  createMicrosoftVerifiedIdentityComposition,
});
