'use strict';

/**
 * Delegated grant refresh-health rotation orchestrator.
 *
 * Acquire lease → open under lease → MS refresh_token exchange → reseal next
 * generation → CAS commit. Fail-closed: abort/reauth/reconcile; never TX across
 * MS/KV I/O. Public result is sanitized status only (no tokens/envelopes/ids).
 *
 * @module email-delegated-grant-refresh-rotation
 */

const crypto = require('crypto');
const {
  tryAcquireDelegatedGrantLease,
  openDelegatedGrantUnderLease,
  commitDelegatedGrantRotation,
  markDelegatedGrantReauthorizationRequired,
  markDelegatedGrantReconciliation,
  abortDelegatedGrantLease,
  getDelegatedGrantPublicStatus,
} = require('./email-delegated-grant-custodian');
const {
  buildGrantEnvelopeAadV1,
  validateEmailGrantEnvelopeProvider,
  validateGrantEnvelopeRecordV1,
} = require('./email-grant-envelope-provider-contract');
const {
  createMicrosoftRefreshTokenRequestService,
  SUNSET_DEPLOYMENT: REQUEST_SUNSET,
} = require('./email-microsoft-refresh-token-request');

const FAILURE_CODE = 'delegated_grant_refresh_rotation_failed';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const WORKER_ID = 'sunset-email-refresh-health';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPENDENCY_KEYS = Object.freeze([
  'deployment',
  'applicationClientId',
  'client',
  'envelopeProvider',
  'secretProvider',
  'transport',
]);

const STATUS_HEALTHY = 'healthy';
const STATUS_REAUTH = 'reauthorization_required';
const STATUS_UNCERTAIN = 'uncertain';
const STATUS_UNAVAILABLE = 'unavailable';

if (REQUEST_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('refresh_rotation_sunset_deployment_mismatch');
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

function exactProvider(object) {
  return object && Object.getPrototypeOf(object) === Object.prototype
    && exactPlainData(object, ['getClientSecret'])
    && typeof ownData(object, 'getClientSecret') === 'function';
}

function exactSealedTransport(object) {
  return object && Object.isFrozen(object)
    && Object.getPrototypeOf(object) === Object.prototype
    && exactPlainData(object, ['postTokenForm'])
    && typeof ownData(object, 'postTokenForm') === 'function';
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

function publicResult({
  status,
  grantGeneration,
  grantStatus,
  reconcileState,
  reauthorizationRequired,
}) {
  return Object.freeze({
    status: String(status),
    grant_generation: grantGeneration == null ? null : Number(grantGeneration),
    grant_status: grantStatus == null ? null : String(grantStatus),
    reconcile_state: reconcileState == null ? null : String(reconcileState),
    reauthorization_required: reauthorizationRequired === true,
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

function createDelegatedGrantRefreshRotationService(deps) {
  let client;
  let envelopeProvider;
  let applicationClientId;
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
    if (typeof applicationClientId !== 'string' || !UUID_RE.test(applicationClientId)) {
      throw failure();
    }
    if (!client || typeof client !== 'object' || typeof client.query !== 'function') {
      throw failure();
    }
    if (typeof client.connect === 'function'
        && (typeof client.totalCount === 'number' || typeof client.idleCount === 'number')) {
      throw failure();
    }
    const prov = validateEmailGrantEnvelopeProvider(envelopeProvider);
    if (!prov.ok) throw failure();
    envelopeProvider = prov.value;
    if (!exactProvider(secretProvider) || !exactSealedTransport(transport)) throw failure();
  } catch (_) { throw failure(); }

  let used = false;

  async function runRefreshHealth(input) {
    if (used) throw failure();
    used = true;
    const ids = snapshotIds(input);
    if (!ids) throw failure();

    let lease = null;
    try {
      const prior = await getDelegatedGrantPublicStatus({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
      }, { client });
      if (!prior.ok) throw failure();
      const priorDto = prior.value;
      if (!priorDto.grant_present) {
        return publicResult({
          status: STATUS_UNAVAILABLE,
          grantGeneration: null,
          grantStatus: null,
          reconcileState: null,
          reauthorizationRequired: false,
        });
      }
      if (priorDto.grant_status === 'reauthorization_required'
          || priorDto.grant_status === 'revoked') {
        return publicResult({
          status: STATUS_REAUTH,
          grantGeneration: priorDto.grant_generation,
          grantStatus: priorDto.grant_status,
          reconcileState: priorDto.reconcile_state,
          reauthorizationRequired: true,
        });
      }

      const acquired = await tryAcquireDelegatedGrantLease({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
        workerId: WORKER_ID,
      }, { client });
      if (!acquired.ok) {
        return publicResult({
          status: STATUS_UNAVAILABLE,
          grantGeneration: priorDto.grant_generation,
          grantStatus: priorDto.grant_status,
          reconcileState: priorDto.reconcile_state,
          reauthorizationRequired: false,
        });
      }
      lease = acquired.value;

      const opened = await openDelegatedGrantUnderLease(lease, {
        client,
        envelopeProvider,
      });
      if (!opened.ok || typeof opened.value.refresh_token !== 'string') {
        await safeAbort(client, ids, lease);
        lease = null;
        return publicResult({
          status: STATUS_UNAVAILABLE,
          grantGeneration: priorDto.grant_generation,
          grantStatus: priorDto.grant_status,
          reconcileState: priorDto.reconcile_state,
          reauthorizationRequired: false,
        });
      }
      const refreshToken = opened.value.refresh_token;

      const exchange = createMicrosoftRefreshTokenRequestService(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId,
        secretProvider,
        transport,
      }));
      let classified;
      try {
        classified = await exchange.exchangeRefreshToken(Object.freeze({ refreshToken }));
      } catch (_) {
        const gen = lease.grant_generation;
        await markDelegatedGrantReconciliation({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: lease.lease_token,
          expectedGeneration: gen,
          reconcileState: 'ms_response_uncertain',
          reconcileDetailCode: 'ms_refresh_transport',
        }, { client });
        await safeAbort(client, ids, lease);
        lease = null;
        return publicResult({
          status: STATUS_UNCERTAIN,
          grantGeneration: gen,
          grantStatus: 'active',
          reconcileState: 'ms_response_uncertain',
          reauthorizationRequired: false,
        });
      }

      if (classified.kind === 'invalid_grant') {
        const reauth = await markDelegatedGrantReauthorizationRequired({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: lease.lease_token,
          expectedGeneration: lease.grant_generation,
          reason: 'invalid_grant',
        }, { client });
        lease = null;
        if (!reauth.ok) {
          return publicResult({
            status: STATUS_UNCERTAIN,
            grantGeneration: priorDto.grant_generation,
            grantStatus: priorDto.grant_status,
            reconcileState: 'ms_response_uncertain',
            reauthorizationRequired: true,
          });
        }
        return publicResult({
          status: STATUS_REAUTH,
          grantGeneration: reauth.value.grant_generation,
          grantStatus: 'reauthorization_required',
          reconcileState: 'needs_operator',
          reauthorizationRequired: true,
        });
      }

      if (classified.kind !== 'success' || !classified.selected) {
        await markDelegatedGrantReconciliation({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: lease.lease_token,
          expectedGeneration: lease.grant_generation,
          reconcileState: 'ms_response_uncertain',
          reconcileDetailCode: 'ms_refresh_uncertain',
        }, { client });
        const gen = lease.grant_generation;
        await safeAbort(client, ids, lease);
        lease = null;
        return publicResult({
          status: STATUS_UNCERTAIN,
          grantGeneration: gen,
          grantStatus: 'active',
          reconcileState: 'ms_response_uncertain',
          reauthorizationRequired: false,
        });
      }

      // Explicit omission → reseal the one-time-opened prior token.
      // Present valid rotation → reseal the new token.
      // Anything else (missing flag, hostile shape) → fail closed; never silent fallback.
      let tokenToSeal = null;
      const selected = classified.selected;
      if (selected.refreshTokenOmitted === true) {
        if (typeof refreshToken !== 'string' || !refreshToken) {
          await markDelegatedGrantReconciliation({
            clientId: ids.clientId,
            endpointId: ids.endpointId,
            leaseToken: lease.lease_token,
            expectedGeneration: lease.grant_generation,
            reconcileState: 'ms_response_uncertain',
            reconcileDetailCode: 'ms_refresh_uncertain',
          }, { client });
          const gen = lease.grant_generation;
          await safeAbort(client, ids, lease);
          lease = null;
          return publicResult({
            status: STATUS_UNCERTAIN,
            grantGeneration: gen,
            grantStatus: 'active',
            reconcileState: 'ms_response_uncertain',
            reauthorizationRequired: false,
          });
        }
        tokenToSeal = refreshToken;
      } else if (selected.refreshTokenOmitted === false
          && typeof selected.refreshToken === 'string'
          && selected.refreshToken) {
        tokenToSeal = selected.refreshToken;
      } else {
        await markDelegatedGrantReconciliation({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: lease.lease_token,
          expectedGeneration: lease.grant_generation,
          reconcileState: 'ms_response_uncertain',
          reconcileDetailCode: 'ms_refresh_uncertain',
        }, { client });
        const gen = lease.grant_generation;
        await safeAbort(client, ids, lease);
        lease = null;
        return publicResult({
          status: STATUS_UNCERTAIN,
          grantGeneration: gen,
          grantStatus: 'active',
          reconcileState: 'ms_response_uncertain',
          reauthorizationRequired: false,
        });
      }

      const nextOperationId = crypto.randomUUID();
      const nextGeneration = lease.grant_generation + 1;
      let aad;
      try {
        aad = buildGrantEnvelopeAadV1({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          grantGeneration: nextGeneration,
          operationId: nextOperationId,
        });
      } catch (_) {
        await safeAbort(client, ids, lease);
        lease = null;
        throw failure();
      }

      let sealed;
      try {
        sealed = await envelopeProvider.sealGrantPayload({
          refresh_token: tokenToSeal,
          aad,
          operation_id: nextOperationId,
        });
      } catch (_) {
        await markDelegatedGrantReconciliation({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: lease.lease_token,
          expectedGeneration: lease.grant_generation,
          reconcileState: 'ms_response_uncertain',
          reconcileDetailCode: 'post_ms_pre_seal',
        }, { client });
        const gen = lease.grant_generation;
        await safeAbort(client, ids, lease);
        lease = null;
        return publicResult({
          status: STATUS_UNCERTAIN,
          grantGeneration: gen,
          grantStatus: 'active',
          reconcileState: 'ms_response_uncertain',
          reauthorizationRequired: false,
        });
      }

      const envCheck = validateGrantEnvelopeRecordV1(sealed);
      if (!envCheck.ok) {
        await markDelegatedGrantReconciliation({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: lease.lease_token,
          expectedGeneration: lease.grant_generation,
          reconcileState: 'ms_response_uncertain',
          reconcileDetailCode: 'post_ms_pre_commit',
        }, { client });
        const gen = lease.grant_generation;
        await safeAbort(client, ids, lease);
        lease = null;
        return publicResult({
          status: STATUS_UNCERTAIN,
          grantGeneration: gen,
          grantStatus: 'active',
          reconcileState: 'ms_response_uncertain',
          reauthorizationRequired: false,
        });
      }

      const committed = await commitDelegatedGrantRotation({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
        leaseToken: lease.lease_token,
        expectedGeneration: lease.grant_generation,
        operationId: nextOperationId,
        envelope: envCheck.value,
      }, { client });
      lease = null;
      if (!committed.ok) {
        return publicResult({
          status: STATUS_UNCERTAIN,
          grantGeneration: priorDto.grant_generation,
          grantStatus: priorDto.grant_status,
          reconcileState: 'ms_response_uncertain',
          reauthorizationRequired: false,
        });
      }
      return publicResult({
        status: STATUS_HEALTHY,
        grantGeneration: committed.value.grant_generation,
        grantStatus: committed.value.grant_status,
        reconcileState: committed.value.reconcile_state,
        reauthorizationRequired: false,
      });
    } catch (err) {
      await safeAbort(client, ids, lease);
      if (err && err.code === FAILURE_CODE) throw err;
      throw failure();
    }
  }

  return Object.freeze({ runRefreshHealth });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  SUNSET_DEPLOYMENT,
  WORKER_ID,
  DEPENDENCY_KEYS,
  STATUS_HEALTHY,
  STATUS_REAUTH,
  STATUS_UNCERTAIN,
  STATUS_UNAVAILABLE,
  createDelegatedGrantRefreshRotationService,
});
