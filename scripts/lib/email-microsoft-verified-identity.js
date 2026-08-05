'use strict';

/**
 * Stage 6 standalone Microsoft verified-identity composition.
 * OIDC ID-token validation first; Graph /me identity second; constant-time
 * principal match. Frozen atomic single-use. No custody/callback/routes/DB/live.
 *
 * @module email-microsoft-verified-identity
 */

const { timingSafeEqual } = require('crypto');

const ERROR_CODE = 'MICROSOFT_VERIFIED_IDENTITY_INVALID';
const ERROR_MESSAGE = 'Microsoft verified identity validation failed.';
const PRINCIPAL_LIMIT = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INPUT_KEYS = Object.freeze([
  'idToken',
  'accessToken',
  'expectedNonce',
  'expectedClientId',
  'nowEpochSeconds',
]);
const OIDC_RESULT_KEYS = Object.freeze(['providerTenantId', 'providerPrincipalId']);
const GRAPH_RESULT_KEYS = Object.freeze(['providerSubjectId', 'mailboxAddress', 'displayName']);
const OUTPUT_KEYS = Object.freeze([
  'providerTenantId',
  'providerPrincipalId',
  'mailboxAddress',
  'displayName',
]);

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
      && !descriptor.get && !descriptor.set
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

function exactFrozenService(object, methodName) {
  return Boolean(
    object
    && Object.getPrototypeOf(object) === Object.prototype
    && Object.isFrozen(object)
    && exactPlainData(object, [methodName])
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

function boundedText(value, max = PRINCIPAL_LIMIT) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && !hasUnpairedSurrogate(value)
    && !/[\u0000-\u001f\u007f]/.test(value);
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

function snapshotInput(input) {
  if (!exactPlainData(input, INPUT_KEYS)) return null;
  return Object.freeze({
    idToken: ownData(input, 'idToken'),
    accessToken: ownData(input, 'accessToken'),
    expectedNonce: ownData(input, 'expectedNonce'),
    expectedClientId: ownData(input, 'expectedClientId'),
    nowEpochSeconds: ownData(input, 'nowEpochSeconds'),
  });
}

function readOidcIdentity(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return null;
  if (!exactPlainData(value, OIDC_RESULT_KEYS)) return null;
  const providerTenantId = ownData(value, 'providerTenantId');
  const providerPrincipalId = ownData(value, 'providerPrincipalId');
  if (!boundedText(providerTenantId) || !UUID.test(providerTenantId)) return null;
  if (!boundedText(providerPrincipalId, PRINCIPAL_LIMIT)) return null;
  return Object.freeze({ providerTenantId, providerPrincipalId });
}

function readGraphIdentity(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return null;
  if (!exactPlainData(value, GRAPH_RESULT_KEYS)) return null;
  const providerSubjectId = ownData(value, 'providerSubjectId');
  const mailboxAddress = ownData(value, 'mailboxAddress');
  const displayName = ownData(value, 'displayName');
  if (!boundedText(providerSubjectId, PRINCIPAL_LIMIT)) return null;
  if (!boundedText(mailboxAddress, 254)) return null;
  if (displayName !== null && !boundedText(displayName, PRINCIPAL_LIMIT)) return null;
  return Object.freeze({ providerSubjectId, mailboxAddress, displayName });
}

function createMicrosoftVerifiedIdentityComposition(dependencies) {
  let oidcValidator;
  let graphIdentity;
  let validate;
  let fetchIdentity;
  try {
    if (!exactPlainData(dependencies, ['oidcValidator', 'graphIdentity'])) throw failure();
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
      // Snapshot exact own-data fields before any await (token/input race defense).
      const snapshotted = snapshotInput(input);
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
