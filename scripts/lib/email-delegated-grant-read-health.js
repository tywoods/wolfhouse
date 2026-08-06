'use strict';

/**
 * Delegated grant read-health orchestrator (Sunset staging).
 *
 * Reuses the reviewed refresh/custody sequence:
 *   lease → open → MS refresh_token exchange → reseal → CAS
 * then one bounded Graph Mail.ReadBasic /me/messages envelope count.
 *
 * No send, subscriptions, polling, activation, automation, bodies,
 * attachments, or persistence. Public result never includes tokens,
 * addresses, subjects, Graph IDs, or raw errors.
 *
 * @module email-delegated-grant-read-health
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
const {
  GRAPH_STAGES,
} = require('./email-microsoft-graph-delegated-messages-transport');

const FAILURE_CODE = 'delegated_grant_read_health_failed';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const WORKER_ID = 'sunset-email-read-health';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPENDENCY_KEYS = Object.freeze([
  'deployment',
  'applicationClientId',
  'client',
  'envelopeProvider',
  'secretProvider',
  'transport',
  'graphMessages',
]);
const GRAPH_STAGE_SET = new Set(GRAPH_STAGES);

const STATUS_HEALTHY = 'healthy';
const STATUS_REAUTH = 'reauthorization_required';
const STATUS_UNCERTAIN = 'uncertain';
const STATUS_UNAVAILABLE = 'unavailable';

if (REQUEST_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('read_health_sunset_deployment_mismatch');
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

function exactGraphMessages(object) {
  return object && Object.isFrozen(object)
    && Object.getPrototypeOf(object) === Object.prototype
    && exactPlainData(object, ['listMessageEnvelopeCount'])
    && typeof ownData(object, 'listMessageEnvelopeCount') === 'function';
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

function sanitizeGraphStage(stage) {
  if (stage == null) return null;
  if (typeof stage === 'string' && GRAPH_STAGE_SET.has(stage)) return stage;
  return null;
}

function publicResult({
  status,
  grantGeneration,
  graphReachable,
  messageCountBounded,
  graphStage,
}) {
  return Object.freeze({
    status: String(status),
    grant_generation: grantGeneration == null ? null : Number(grantGeneration),
    graph_reachable: graphReachable === true,
    message_count_bounded: messageCountBounded == null ? null : Number(messageCountBounded),
    graph_stage: sanitizeGraphStage(graphStage),
  });
}

function early(status, grantGeneration) {
  return publicResult({
    status,
    grantGeneration,
    graphReachable: false,
    messageCountBounded: null,
    graphStage: null,
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

function createDelegatedGrantReadHealthService(deps) {
  let client;
  let envelopeProvider;
  let applicationClientId;
  let secretProvider;
  let transport;
  let graphMessages;
  let listMessageEnvelopeCount;
  try {
    if (!exactPlainData(deps, DEPENDENCY_KEYS)
        || ownData(deps, 'deployment') !== SUNSET_DEPLOYMENT) throw failure();
    applicationClientId = ownData(deps, 'applicationClientId');
    client = ownData(deps, 'client');
    envelopeProvider = ownData(deps, 'envelopeProvider');
    secretProvider = ownData(deps, 'secretProvider');
    transport = ownData(deps, 'transport');
    graphMessages = ownData(deps, 'graphMessages');
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
    if (!exactGraphMessages(graphMessages)) throw failure();
    listMessageEnvelopeCount = ownData(graphMessages, 'listMessageEnvelopeCount');
  } catch (_) { throw failure(); }

  let used = false;

  async function runReadHealth(input) {
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
        return early(STATUS_UNAVAILABLE, null);
      }
      if (priorDto.grant_status === 'reauthorization_required'
          || priorDto.grant_status === 'revoked') {
        return early(STATUS_REAUTH, priorDto.grant_generation);
      }

      const acquired = await tryAcquireDelegatedGrantLease({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
        workerId: WORKER_ID,
      }, { client });
      if (!acquired.ok) {
        return early(STATUS_UNAVAILABLE, priorDto.grant_generation);
      }
      lease = acquired.value;

      const opened = await openDelegatedGrantUnderLease(lease, {
        client,
        envelopeProvider,
      });
      if (!opened.ok || typeof opened.value.refresh_token !== 'string') {
        await safeAbort(client, ids, lease);
        lease = null;
        return early(STATUS_UNAVAILABLE, priorDto.grant_generation);
      }
      let refreshToken = opened.value.refresh_token;

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
        return early(STATUS_UNCERTAIN, gen);
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
          return early(STATUS_UNCERTAIN, priorDto.grant_generation);
        }
        return early(STATUS_REAUTH, reauth.value.grant_generation);
      }

      if (classified.kind !== 'success' || !classified.selected) {
        classified = null;
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
        return early(STATUS_UNCERTAIN, gen);
      }

      // Narrow token owners: extract minimum locals, then drop classified/selected.
      let accessTokenOwner = null;
      let refreshToSeal = null;
      try {
        const selected = classified.selected;
        const accessCandidate = selected && selected.accessToken;
        if (typeof accessCandidate !== 'string' || !accessCandidate) {
          classified = null;
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
          return early(STATUS_UNCERTAIN, gen);
        }
        accessTokenOwner = accessCandidate;

        if (selected.refreshTokenOmitted === true) {
          if (typeof refreshToken !== 'string' || !refreshToken) {
            accessTokenOwner = null;
            classified = null;
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
            return early(STATUS_UNCERTAIN, gen);
          }
          refreshToSeal = refreshToken;
        } else if (selected.refreshTokenOmitted === false
            && typeof selected.refreshToken === 'string'
            && selected.refreshToken) {
          refreshToSeal = selected.refreshToken;
        } else {
          accessTokenOwner = null;
          classified = null;
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
          return early(STATUS_UNCERTAIN, gen);
        }
      } finally {
        classified = null;
      }
      // Drop the one-time-opened refresh local once seal material is chosen.
      refreshToken = null;

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
        accessTokenOwner = null;
        refreshToSeal = null;
        await safeAbort(client, ids, lease);
        lease = null;
        throw failure();
      }

      let sealed;
      try {
        sealed = await envelopeProvider.sealGrantPayload({
          refresh_token: refreshToSeal,
          aad,
          operation_id: nextOperationId,
        });
      } catch (_) {
        accessTokenOwner = null;
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
        return early(STATUS_UNCERTAIN, gen);
      } finally {
        refreshToSeal = null;
      }

      const envCheck = validateGrantEnvelopeRecordV1(sealed);
      if (!envCheck.ok) {
        accessTokenOwner = null;
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
        return early(STATUS_UNCERTAIN, gen);
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
        accessTokenOwner = null;
        return early(STATUS_UNCERTAIN, priorDto.grant_generation);
      }

      const grantGeneration = committed.value.grant_generation;
      // Single Graph consumption: mutable input owns the token until finally clears it.
      let graphInput = null;
      try {
        graphInput = { accessToken: accessTokenOwner };
        accessTokenOwner = null;
        const graphResult = await Reflect.apply(
          listMessageEnvelopeCount,
          graphMessages,
          [graphInput],
        );
        if (!graphResult || !Object.isFrozen(graphResult)
            || Object.getPrototypeOf(graphResult) !== Object.prototype
            || Reflect.ownKeys(graphResult).length !== 2
            || typeof ownData(graphResult, 'message_count_bounded') !== 'number'
            || !Number.isInteger(graphResult.message_count_bounded)
            || graphResult.message_count_bounded < 0
            || graphResult.message_count_bounded > 5
            || ownData(graphResult, 'graph_stage') !== 'success') {
          return publicResult({
            status: STATUS_UNCERTAIN,
            grantGeneration,
            graphReachable: false,
            messageCountBounded: null,
            graphStage: null,
          });
        }
        return publicResult({
          status: STATUS_HEALTHY,
          grantGeneration,
          graphReachable: true,
          messageCountBounded: graphResult.message_count_bounded,
          graphStage: 'success',
        });
      } catch (graphErr) {
        return publicResult({
          status: STATUS_UNCERTAIN,
          grantGeneration,
          graphReachable: false,
          messageCountBounded: null,
          graphStage: sanitizeGraphStage(graphErr && graphErr.graph_stage),
        });
      } finally {
        if (graphInput) {
          try { graphInput.accessToken = null; } catch { /* */ }
          graphInput = null;
        }
        accessTokenOwner = null;
      }
    } catch (err) {
      await safeAbort(client, ids, lease);
      if (err && err.code === FAILURE_CODE) throw err;
      throw failure();
    }
  }

  return Object.freeze({ runReadHealth });
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
  GRAPH_STAGES,
  createDelegatedGrantReadHealthService,
});
