'use strict';

/**
 * Delegated grant disconnect orchestrator: lease → open → MS revoke → local revoke.
 * Fail-closed with lease abort on errors. Public surface is sanitized status only.
 *
 * @module email-grant-revoke
 */

const crypto = require('crypto');
const {
  tryAcquireDelegatedGrantLease,
  openDelegatedGrantUnderLease,
  clearDelegatedGrantAfterRevoke,
  clearPreviouslyRevokedGrant,
  abortDelegatedGrantLease,
  getDelegatedGrantPublicStatus,
} = require('./email-delegated-grant-custodian');
const {
  createMicrosoftTokenRevokeService,
  SUNSET_DEPLOYMENT: REVOKE_SUNSET,
} = require('./email-microsoft-revoke');

const FAILURE_CODE = 'delegated_grant_revoke_failed';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const WORKER_ID = 'sunset-email-disconnect';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPENDENCY_KEYS = Object.freeze([
  'deployment',
  'applicationClientId',
  'client',
  'envelopeProvider',
  'secretProvider',
  'transport',
]);

const STATUS_DISCONNECTED = 'disconnected';
const STATUS_UNAVAILABLE = 'unavailable';

if (REVOKE_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('grant_revoke_sunset_deployment_mismatch');
}

function failure() {
  const error = new Error(FAILURE_CODE);
  error.code = FAILURE_CODE;
  return error;
}

function ownData(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function exactPlainData(object, keys) {
  if (!object || Object.getPrototypeOf(object) !== Object.prototype) return false;
  const actual = Reflect.ownKeys(object);
  if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && !descriptor.get && !descriptor.set;
  });
}

function snapshotIds(input) {
  if (!exactPlainData(input, ['clientId', 'endpointId'])) return null;
  const clientId = ownData(input, 'clientId');
  const endpointId = ownData(input, 'endpointId');
  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) return null;
  if (typeof endpointId !== 'string' || !UUID_RE.test(endpointId)) return null;
  return Object.freeze({
    clientId: clientId.trim().toLowerCase(),
    endpointId: endpointId.trim().toLowerCase(),
  });
}

function publicResult({ status, grantGeneration, grantStatus, reconcileState }) {
  return Object.freeze({
    status: String(status),
    grant_generation: grantGeneration == null ? null : Number(grantGeneration),
    grant_status: grantStatus == null ? null : String(grantStatus),
    reconcile_state: reconcileState == null ? null : String(reconcileState),
  });
}

async function safeAbort(client, ids, lease) {
  if (!lease) return;
  try {
    await abortDelegatedGrantLease({
      clientId: ids.clientId,
      endpointId: ids.endpointId,
      leaseToken: lease.lease_token,
      expectedGeneration: lease.grant_generation,
    }, { client });
  } catch (_) { /* sanitized */ }
}

function createDelegatedGrantRevokeService(deps) {
  let client;
  let applicationClientId;
  let envelopeProvider;
  let secretProvider;
  let transport;
  try {
    if (!exactPlainData(deps, DEPENDENCY_KEYS)
        || ownData(deps, 'deployment') !== SUNSET_DEPLOYMENT) throw failure();
    applicationClientId = ownData(deps, 'applicationClientId');
    client = ownData(deps, 'client');
    envelopeProvider = ownData(deps, 'envelopeProvider');
    secretProvider = ownData(deps, 'secretProvider');
    transport = ownData(deps, 'transport');
    if (typeof applicationClientId !== 'string' || !UUID_RE.test(applicationClientId)
        || !client || typeof client.query !== 'function'
        || !envelopeProvider || !secretProvider || !transport) {
      throw failure();
    }
  } catch (_) { throw failure(); }

  const revokeTransport = createMicrosoftTokenRevokeService(Object.freeze({
    deployment: SUNSET_DEPLOYMENT,
    applicationClientId,
    secretProvider,
    transport,
  }));

  async function runRevoke(input) {
    const ids = snapshotIds(input);
    if (!ids) throw failure();
    let lease = null;
    try {
      const prior = await getDelegatedGrantPublicStatus(ids, { client });
      if (!prior.ok || !prior.value || prior.value.grant_present !== true) {
        return publicResult({ status: STATUS_UNAVAILABLE, grantGeneration: null, grantStatus: null, reconcileState: null });
      }
      if (prior.value.grant_status === 'revoked') {
        const cleared = await clearPreviouslyRevokedGrant({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          expectedGeneration: prior.value.grant_generation,
        }, { client });
        return publicResult({
          status: STATUS_DISCONNECTED,
          grantGeneration: cleared.value.grant_generation,
          grantStatus: cleared.value.grant_status,
          reconcileState: cleared.value.reconcile_state,
        });
      }
      const acquired = await tryAcquireDelegatedGrantLease({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
        leaseOwner: WORKER_ID,
        expectedGeneration: prior.value.grant_generation,
      }, { client });
      if (!acquired.ok || !acquired.value) {
        return publicResult({
          status: STATUS_UNAVAILABLE,
          grantGeneration: prior.value.grant_generation,
          grantStatus: prior.value.grant_status,
          reconcileState: prior.value.reconcile_state,
        });
      }
      lease = acquired.value;
      const opened = await openDelegatedGrantUnderLease({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
        leaseToken: lease.lease_token,
        expectedGeneration: lease.grant_generation,
      }, { client, envelopeProvider });
      if (!opened.ok || !opened.value || typeof opened.value.refresh_token !== 'string') {
        await safeAbort(client, ids, lease);
        lease = null;
        return publicResult({
          status: STATUS_UNAVAILABLE,
          grantGeneration: prior.value.grant_generation,
          grantStatus: prior.value.grant_status,
          reconcileState: prior.value.reconcile_state,
        });
      }
      const refreshToken = opened.value.refresh_token;
      try {
        await revokeTransport.revokeRefreshToken(Object.freeze({ refreshToken }));
      } catch (_) {
        // Best-effort provider revoke; local revoke still proceeds.
      }
      const operationId = crypto.randomUUID();
      const revoked = await clearDelegatedGrantAfterRevoke({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
        leaseToken: lease.lease_token,
        expectedGeneration: lease.grant_generation,
        operationId,
      }, { client });
      lease = null;
      if (!revoked.ok || !revoked.value) {
        return publicResult({
          status: STATUS_UNAVAILABLE,
          grantGeneration: prior.value.grant_generation,
          grantStatus: prior.value.grant_status,
          reconcileState: prior.value.reconcile_state,
        });
      }
      return publicResult({
        status: STATUS_DISCONNECTED,
        grantGeneration: revoked.value.grant_generation,
        grantStatus: revoked.value.grant_status,
        reconcileState: revoked.value.reconcile_state,
      });
    } catch (_) {
      await safeAbort(client, ids, lease);
      throw failure();
    }
  }

  return Object.freeze({ runRevoke });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  SUNSET_DEPLOYMENT,
  WORKER_ID,
  STATUS_DISCONNECTED,
  STATUS_UNAVAILABLE,
  createDelegatedGrantRevokeService,
});
