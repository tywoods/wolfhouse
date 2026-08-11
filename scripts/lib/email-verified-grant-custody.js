'use strict';

const { timingSafeEqual } = require('crypto');
const {
  buildGrantEnvelopeAadV1,
  validateGrantEnvelopeRecordV1,
  validateEmailGrantEnvelopeProvider,
} = require('./email-grant-envelope-provider-contract');
const { resolveOptionalStageTelemetry, safeEmitStage } = require('./email-microsoft-oauth-stage-telemetry');

const GRANT_GENERATION_INITIAL = 1;
const DEPENDENCY_KEYS = Object.freeze(['verifiedIdentity', 'envelopeProvider', 'clock', 'installer']);
const SEAL_KEYS = Object.freeze(['refresh_token', 'aad', 'operation_id']);
const INSTALL_KEYS = Object.freeze(['clientId','endpointId','operationId','actorStaffUserId','identity','envelope']);
const INSTALLER_METHOD = 'installVerifiedGrant';
const SEALED_ACK = Object.freeze({ status: 'accepted' });

function ownData(object, key) {
  try {
    const d = Object.getOwnPropertyDescriptor(object, key);
    return d && Object.prototype.hasOwnProperty.call(d, 'value') && !d.get && !d.set ? d.value : undefined;
  } catch { return undefined; }
}
function exactPlainData(object, keys) {
  try {
    if (!object || Object.getPrototypeOf(object) !== Object.prototype) return false;
    const actual = Reflect.ownKeys(object);
    if (actual.length !== keys.length || actual.some(k => typeof k !== 'string' || !keys.includes(k))) return false;
    return keys.every((k) => {
      const d = Object.getOwnPropertyDescriptor(object, k);
      return Boolean(d && Object.prototype.hasOwnProperty.call(d, 'value') && d.enumerable && !d.get && !d.set);
    });
  } catch { return false; }
}
function exactFrozenData(value, keys) { return Boolean(value && Object.isFrozen(value) && exactPlainData(value, keys)); }
function exactFrozenService(value, method) {
  return exactFrozenData(value, [method]) && typeof ownData(value, method) === 'function';
}
function independentCopy(source) { const out = Buffer.alloc(source.length); source.copy(out); return out; }
function unchanged(a, b) {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
function installerAck(value) {
  try {
    return exactFrozenData(value, ['status']) && ownData(value, 'status') === 'installed';
  } catch { return false; }
}

function createVerifiedGrantCustodyAdapter(config, dependencies, policy) {
  const fail = policy.failure;
  let frozenConfig, verifiedIdentity, verifyIdentity, envelopeProvider, sealGrantPayload;
  let clock, nowEpochSecondsFn, installer, installVerifiedGrant, stageTelemetry;
  try {
    frozenConfig = policy.snapshotConfig(config);
    if (!frozenConfig) throw fail();
    const resolved = resolveOptionalStageTelemetry(dependencies, DEPENDENCY_KEYS);
    if (!resolved.ok || !resolved.stageTelemetry) throw fail();
    stageTelemetry = resolved.stageTelemetry;
    verifiedIdentity = ownData(dependencies, 'verifiedIdentity');
    const rawEnvelope = ownData(dependencies, 'envelopeProvider');
    clock = ownData(dependencies, 'clock');
    installer = ownData(dependencies, 'installer');
    if (!exactFrozenService(verifiedIdentity, 'verifyIdentity')) throw fail();
    if (!exactFrozenService(clock, 'nowEpochSeconds')) throw fail();
    if (!exactFrozenService(installer, INSTALLER_METHOD)) throw fail();
    const checked = validateEmailGrantEnvelopeProvider(rawEnvelope);
    if (!checked.ok) throw fail();
    envelopeProvider = checked.value;
    sealGrantPayload = ownData(envelopeProvider, 'sealGrantPayload');
    if (typeof sealGrantPayload !== 'function') throw fail();
    verifyIdentity = ownData(verifiedIdentity, 'verifyIdentity');
    nowEpochSecondsFn = ownData(clock, 'nowEpochSeconds');
    installVerifiedGrant = ownData(installer, INSTALLER_METHOD);
  } catch { throw fail(); }

  let used = false;
  async function acceptValidatedTokens(input) {
    if (used) throw fail();
    used = true;
    try {
      const selected = policy.snapshotSelected(input);
      if (!selected) throw fail();
      let now;
      try { now = Reflect.apply(nowEpochSecondsFn, clock, []); } catch { throw fail(); }
      if (!Number.isSafeInteger(now) || now < 0) throw fail();
      let rawIdentity;
      try {
        rawIdentity = await Reflect.apply(verifyIdentity, verifiedIdentity, [Object.freeze({
          idToken: selected.idToken, accessToken: selected.accessToken,
          expectedNonce: frozenConfig.expectedNonce, expectedClientId: frozenConfig.expectedClientId,
          nowEpochSeconds: now,
        })]);
      } catch { throw fail(); }
      const identity = policy.readIdentity(rawIdentity);
      if (!identity) throw fail();
      let canonical;
      try {
        canonical = buildGrantEnvelopeAadV1({ clientId: frozenConfig.clientId,
          endpointId: frozenConfig.endpointId, grantGeneration: GRANT_GENERATION_INITIAL,
          operationId: frozenConfig.operationId });
      } catch { throw fail(); }
      if (!Buffer.isBuffer(canonical) || canonical.length < 1) throw fail();
      const authority = independentCopy(canonical);
      const facing = independentCopy(canonical);
      const sealInput = Object.freeze({ refresh_token: selected.refreshToken, aad: facing,
        operation_id: frozenConfig.operationId });
      if (!exactPlainData(sealInput, SEAL_KEYS)) throw fail();
      let rawEnvelope;
      try { rawEnvelope = await Reflect.apply(sealGrantPayload, envelopeProvider, [sealInput]); }
      catch { throw fail(); }
      if (!unchanged(facing, authority)) throw fail();
      let envelope;
      try {
        const checked = validateGrantEnvelopeRecordV1(rawEnvelope);
        if (!checked.ok || checked.value.operation_id !== frozenConfig.operationId) throw fail();
        envelope = checked.value;
      } catch { throw fail(); }
      safeEmitStage(stageTelemetry, 'envelope_sealed');
      const installInput = Object.freeze({ clientId: frozenConfig.clientId, endpointId: frozenConfig.endpointId,
        operationId: frozenConfig.operationId, actorStaffUserId: frozenConfig.actorStaffUserId,
        identity, envelope });
      if (!exactPlainData(installInput, INSTALL_KEYS)) throw fail();
      safeEmitStage(stageTelemetry, 'installer_started');
      let ack;
      try { ack = await Reflect.apply(installVerifiedGrant, installer, [installInput]); }
      catch { throw fail(); }
      if (!installerAck(ack)) throw fail();
      safeEmitStage(stageTelemetry, 'installer_committed');
      return SEALED_ACK;
    } catch { throw fail(); }
  }
  return Object.freeze({ acceptValidatedTokens });
}

module.exports = Object.freeze({ GRANT_GENERATION_INITIAL, DEPENDENCY_KEYS, INSTALL_KEYS,
  INSTALLER_METHOD, SEALED_ACK, ownData, exactFrozenData, createVerifiedGrantCustodyAdapter });
