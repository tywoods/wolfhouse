'use strict';

/**
 * Stage 6 standalone Microsoft verified-grant custody adapter.
 * Composes frozen clock → verified identity → gen-1 AAD → seal refresh only →
 * envelope validate → installer ack. Single-use atomic burn. No DB/callback/
 * routes/Azure/live/activation/sync/send.
 *
 * Implements the merged response-custody handoff interface:
 *   custody = { acceptValidatedTokens(selected) → frozen { status: 'accepted' } }
 * so createMicrosoftTokenResponseCustodyService can inject this adapter as custody.
 *
 * Factory takes exact frozen config + exact frozen owner-preserving dependencies.
 * Selected input matches response-custody camelCase shape. One fixed sanitized error.
 *
 * @module email-microsoft-verified-grant-custody
 */

const { timingSafeEqual } = require('crypto');
const {
  buildGrantEnvelopeAadV1,
  validateGrantEnvelopeRecordV1,
  validateEmailGrantEnvelopeProvider,
} = require('./email-grant-envelope-provider-contract');

const ERROR_CODE = 'MICROSOFT_VERIFIED_GRANT_CUSTODY_INVALID';
const ERROR_MESSAGE = 'Microsoft verified grant custody failed.';
const GRANT_GENERATION_INITIAL = 1;
const TOKEN_LIMIT_CHARS = 8192;
const ID_TOKEN_LIMIT_CHARS = 32768;
const MAX_EXPIRES_IN_SECONDS = 86_400;
const NONCE_LIMIT = 512;
const CLIENT_ID_LIMIT = 256;
const PRINCIPAL_LIMIT = 256;
const MAILBOX_MIN = 3;
const MAILBOX_MAX = 254;
const PHASE_A_SCOPES = Object.freeze([
  'openid', 'profile', 'offline_access', 'User.Read', 'Mail.ReadBasic',
]);
const ALLOWED_SCOPES = new Set(PHASE_A_SCOPES);
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_MAILBOX_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const CONFIG_KEYS = Object.freeze([
  'clientId',
  'endpointId',
  'operationId',
  'actorStaffUserId',
  'expectedNonce',
  'expectedClientId',
]);
const DEPENDENCY_KEYS = Object.freeze([
  'verifiedIdentity',
  'envelopeProvider',
  'clock',
  'installer',
]);
const SELECTED_KEYS = Object.freeze([
  'accessToken',
  'refreshToken',
  'tokenType',
  'expiresIn',
  'scope',
  'idToken',
]);
const IDENTITY_KEYS = Object.freeze([
  'providerTenantId',
  'providerPrincipalId',
  'mailboxAddress',
  'displayName',
]);
const SEAL_KEYS = Object.freeze(['refresh_token', 'aad', 'operation_id']);
/** Installer payload key order: identity before envelope (no tokens/AAD/providers). */
const INSTALL_KEYS = Object.freeze([
  'clientId',
  'endpointId',
  'operationId',
  'actorStaffUserId',
  'identity',
  'envelope',
]);
/** Exact sealedAck shape required by response-custody handoff. */
const SEALED_ACK = Object.freeze({ status: 'accepted' });
/**
 * Exact installer acknowledgement. Distinct from response-custody sealedAck
 * (`accepted`) and public handoff success (`custodied`). Adapter validates
 * this from the installer, then independently returns SEALED_ACK upstream.
 */
const INSTALLER_ACK_STATUS = 'installed';
/**
 * Future atomic installer boundary (owner-preserving receiver).
 * Not install (too generic) and not the existing custodian
 * installInitialDelegatedGrant (envelope-only; does not bind verified
 * identity). Exact single method that atomically receives identity + envelope.
 */
const INSTALLER_METHOD = 'installVerifiedGrant';

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'MicrosoftVerifiedGrantCustodyError' });
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

function boundedOidcText(value, max) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && !hasUnpairedSurrogate(value)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function printable(value, limit) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= limit
    && PRINTABLE_ASCII.test(value);
}

function isCanonicalUuid(value) {
  return typeof value === 'string' && UUID_CANON.test(value);
}

function isCanonicalGraphMailbox(value) {
  if (typeof value !== 'string'
      || value.length < MAILBOX_MIN
      || value.length > MAILBOX_MAX
      || /[\u0000-\u001f\u007f]/.test(value)) {
    return false;
  }
  if (value !== value.trim() || value !== value.toLowerCase()) return false;
  if (!CANONICAL_MAILBOX_RE.test(value) || value.includes('..')) return false;
  return true;
}

function exactPhaseAScope(scope) {
  if (typeof scope !== 'string' || scope.length < 1 || scope.length > 512) return false;
  const scopes = scope.split(' ');
  const scopeSet = new Set(scopes);
  return !scopes.some((item) => !item || !ALLOWED_SCOPES.has(item))
    && scopeSet.size === scopes.length
    && scopeSet.size === PHASE_A_SCOPES.length
    && PHASE_A_SCOPES.every((item) => scopeSet.has(item));
}

/**
 * Snapshot exact frozen selected tokens (response-custody shape) before awaits.
 */
function snapshotAndValidateSelected(input) {
  if (!exactFrozenData(input, SELECTED_KEYS)) return null;

  const accessToken = ownData(input, 'accessToken');
  const refreshToken = ownData(input, 'refreshToken');
  const tokenType = ownData(input, 'tokenType');
  const expiresIn = ownData(input, 'expiresIn');
  const scope = ownData(input, 'scope');
  const idToken = ownData(input, 'idToken');

  if (!printable(accessToken, TOKEN_LIMIT_CHARS)) return null;
  if (!printable(refreshToken, TOKEN_LIMIT_CHARS)) return null;
  if (tokenType !== 'Bearer') return null;
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_EXPIRES_IN_SECONDS) {
    return null;
  }
  if (!exactPhaseAScope(scope)) return null;
  if (!printable(idToken, ID_TOKEN_LIMIT_CHARS)) return null;

  return Object.freeze({
    accessToken,
    refreshToken,
    tokenType,
    expiresIn,
    scope,
    idToken,
  });
}

function snapshotAndValidateConfig(config) {
  if (!exactFrozenData(config, CONFIG_KEYS)) return null;

  const clientId = ownData(config, 'clientId');
  const endpointId = ownData(config, 'endpointId');
  const operationId = ownData(config, 'operationId');
  const actorStaffUserId = ownData(config, 'actorStaffUserId');
  const expectedNonce = ownData(config, 'expectedNonce');
  const expectedClientId = ownData(config, 'expectedClientId');

  if (!isCanonicalUuid(clientId) || !isCanonicalUuid(endpointId) || !isCanonicalUuid(operationId)) {
    return null;
  }
  if (actorStaffUserId !== null && !isCanonicalUuid(actorStaffUserId)) return null;
  if (!boundedOidcText(expectedNonce, NONCE_LIMIT)) return null;
  if (!boundedOidcText(expectedClientId, CLIENT_ID_LIMIT)) return null;

  return Object.freeze({
    clientId,
    endpointId,
    operationId,
    actorStaffUserId,
    expectedNonce,
    expectedClientId,
  });
}

function readVerifiedIdentity(value) {
  if (!exactFrozenData(value, IDENTITY_KEYS)) return null;
  const providerTenantId = ownData(value, 'providerTenantId');
  const providerPrincipalId = ownData(value, 'providerPrincipalId');
  const mailboxAddress = ownData(value, 'mailboxAddress');
  const displayName = ownData(value, 'displayName');

  if (!boundedOidcText(providerTenantId, PRINCIPAL_LIMIT) || !UUID_CANON.test(providerTenantId)) {
    return null;
  }
  if (!boundedOidcText(providerPrincipalId, PRINCIPAL_LIMIT)) return null;
  if (!isCanonicalGraphMailbox(mailboxAddress)) return null;
  if (displayName !== null) {
    if (typeof displayName !== 'string'
        || displayName.length < 1
        || displayName.length > PRINCIPAL_LIMIT
        || /[\u0000-\u001f\u007f]/.test(displayName)) {
      return null;
    }
  }
  return Object.freeze({
    providerTenantId,
    providerPrincipalId,
    mailboxAddress,
    displayName,
  });
}

function sealedInstallerAck(value) {
  return Boolean(
    value
    && Object.isFrozen(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === 1
    && ownData(value, 'status') === INSTALLER_ACK_STATUS,
  );
}

/**
 * Independent Buffer copy (no shared ArrayBuffer backing).
 * @param {Buffer} source
 * @returns {Buffer}
 */
function independentBufferCopy(source) {
  const copy = Buffer.alloc(source.length);
  source.copy(copy);
  return copy;
}

/**
 * Timing-safe byte equality for post-seal AAD integrity.
 * Length mismatch fails closed without throwing from timingSafeEqual.
 * @param {Buffer} left
 * @param {Buffer} right
 * @returns {boolean}
 */
function aadBytesUnchanged(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right)) return false;
  if (left.length !== right.length) return false;
  if (left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * @param {object} config exact frozen custody binding config
 * @param {object} dependencies exact frozen owner-preserving deps
 * @returns {{ acceptValidatedTokens: Function }} frozen single-use custody adapter
 */
function createMicrosoftVerifiedGrantCustodyAdapter(config, dependencies) {
  let frozenConfig;
  let verifiedIdentity;
  let verifyIdentity;
  let envelopeProvider;
  let sealGrantPayload;
  let clock;
  let nowEpochSecondsFn;
  let installer;
  let installVerifiedGrant;

  try {
    frozenConfig = snapshotAndValidateConfig(config);
    if (!frozenConfig) throw failure();

    if (!exactFrozenData(dependencies, DEPENDENCY_KEYS)) throw failure();
    verifiedIdentity = ownData(dependencies, 'verifiedIdentity');
    const rawEnvelopeProvider = ownData(dependencies, 'envelopeProvider');
    clock = ownData(dependencies, 'clock');
    installer = ownData(dependencies, 'installer');

    if (!exactFrozenService(verifiedIdentity, 'verifyIdentity')) throw failure();
    if (!exactFrozenService(clock, 'nowEpochSeconds')) throw failure();
    // Exact future atomic installer surface only — reject install,
    // envelope-only installInitialDelegatedGrant, and any extra methods.
    if (!exactFrozenService(installer, INSTALLER_METHOD)) throw failure();

    const providerOk = validateEmailGrantEnvelopeProvider(rawEnvelopeProvider);
    if (!providerOk.ok) throw failure();
    envelopeProvider = providerOk.value;
    sealGrantPayload = ownData(envelopeProvider, 'sealGrantPayload');
    if (typeof sealGrantPayload !== 'function') throw failure();

    verifyIdentity = ownData(verifiedIdentity, 'verifyIdentity');
    nowEpochSecondsFn = ownData(clock, 'nowEpochSeconds');
    installVerifiedGrant = ownData(installer, INSTALLER_METHOD);
  } catch {
    throw failure();
  }

  let used = false;
  async function acceptValidatedTokens(input) {
    if (used) throw failure();
    used = true; // Atomic burn before input reflection, await, or dependency calls.
    try {
      const selected = snapshotAndValidateSelected(input);
      if (!selected) throw failure();

      // Flow: clock → identity → gen-1 AAD → seal refresh only → validate → install.
      let nowEpochSeconds;
      try {
        nowEpochSeconds = Reflect.apply(nowEpochSecondsFn, clock, []);
      } catch {
        throw failure();
      }
      if (!Number.isSafeInteger(nowEpochSeconds) || nowEpochSeconds < 0) throw failure();

      let identityRaw;
      try {
        identityRaw = await Reflect.apply(verifyIdentity, verifiedIdentity, [Object.freeze({
          idToken: selected.idToken,
          accessToken: selected.accessToken,
          expectedNonce: frozenConfig.expectedNonce,
          expectedClientId: frozenConfig.expectedClientId,
          nowEpochSeconds,
        })]);
      } catch {
        throw failure();
      }
      const identity = readVerifiedIdentity(identityRaw);
      if (!identity) throw failure();

      // Canonical generation-1 AAD. Authoritative snapshot is never provider-facing.
      let aadCanonical;
      try {
        aadCanonical = buildGrantEnvelopeAadV1({
          clientId: frozenConfig.clientId,
          endpointId: frozenConfig.endpointId,
          grantGeneration: GRANT_GENERATION_INITIAL,
          operationId: frozenConfig.operationId,
        });
      } catch {
        throw failure();
      }
      if (!Buffer.isBuffer(aadCanonical) || aadCanonical.length < 1) throw failure();

      // Independent copies: no shared backing memory between authority and provider.
      const aadAuthoritative = independentBufferCopy(aadCanonical);
      const aadProviderFacing = independentBufferCopy(aadCanonical);

      const sealInput = Object.freeze({
        refresh_token: selected.refreshToken,
        aad: aadProviderFacing,
        operation_id: frozenConfig.operationId,
      });
      // Exact seal key allowlist only (refresh sealed; never access/id tokens).
      if (!exactPlainData(sealInput, SEAL_KEYS)) throw failure();

      let envelopeRaw;
      try {
        envelopeRaw = await Reflect.apply(sealGrantPayload, envelopeProvider, [sealInput]);
      } catch {
        throw failure();
      }

      // After seal await, before envelope validation/installer: provider must not
      // have mutated the AAD bytes or length. Fail sanitized; zero installer calls.
      if (!aadBytesUnchanged(aadProviderFacing, aadAuthoritative)) {
        throw failure();
      }

      let envelopeValidated;
      try {
        const env = validateGrantEnvelopeRecordV1(envelopeRaw);
        if (!env.ok) throw failure();
        if (env.value.operation_id !== frozenConfig.operationId) throw failure();
        envelopeValidated = env.value;
      } catch {
        throw failure();
      }

      // Exact key order: identity before envelope (no tokens/AAD/raw providers).
      const installInput = Object.freeze({
        clientId: frozenConfig.clientId,
        endpointId: frozenConfig.endpointId,
        operationId: frozenConfig.operationId,
        actorStaffUserId: frozenConfig.actorStaffUserId,
        identity,
        envelope: envelopeValidated,
      });
      if (!exactPlainData(installInput, INSTALL_KEYS)) throw failure();
      // Hard ban: no tokens / AAD / raw provider objects on installer surface.
      if ('accessToken' in installInput
          || 'refreshToken' in installInput
          || 'idToken' in installInput
          || 'aad' in installInput
          || 'envelopeProvider' in installInput
          || 'refresh_token' in installInput) {
        throw failure();
      }

      let ack;
      try {
        ack = await Reflect.apply(installVerifiedGrant, installer, [installInput]);
      } catch {
        throw failure();
      }
      // Installer must return exact frozen { status: 'installed' } only.
      if (!sealedInstallerAck(ack)) throw failure();

      // Independently return response-custody sealedAck (not installer ack).
      return SEALED_ACK;
    } catch {
      throw failure();
    }
  }

  return Object.freeze({ acceptValidatedTokens });
}

module.exports = Object.freeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  TOKEN_LIMIT_CHARS,
  ID_TOKEN_LIMIT_CHARS,
  MAX_EXPIRES_IN_SECONDS,
  PHASE_A_SCOPES,
  GRANT_GENERATION_INITIAL,
  SELECTED_KEYS,
  CONFIG_KEYS,
  INSTALL_KEYS,
  INSTALLER_METHOD,
  SEALED_ACK,
  createMicrosoftVerifiedGrantCustodyAdapter,
});
