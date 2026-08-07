'use strict';

/**
 * Delegated grant access-session (callback-scoped one-shot).
 *
 * Single internal owner of the reviewed custody lifecycle:
 *   lease → open → MS refresh_token exchange → refresh-token selection →
 *   AAD → reseal → envelope validate → confirmed CAS
 *
 * After **conclusively successful CAS only**, invokes the caller callback
 * exactly once with a mutable one-shot loan `{ accessToken }`. Never returns
 * or exports tokens, never exposes a generic token source. Pre-CAS failures,
 * CAS conflict / zero-row / commit_outcome_unknown → **zero** callback.
 *
 * Backed only by existing custodian functions (+ existing MS refresh + envelope
 * seal helpers). Scrubs loan.accessToken and all local token owners in finally.
 * Default-off / not runtime-wired. No routes, flags, migration, OAuth scope,
 * deploy, live I/O, or second lease/SQL/refresh owner.
 *
 * @module email-delegated-grant-access-session
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

const FAILURE_CODE = 'delegated_grant_access_session_failed';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EMAIL_DELEGATED_GRANT_ACCESS_SESSION_RUNTIME_WIRED = false;

const DEPENDENCY_KEYS = Object.freeze([
  'deployment',
  'applicationClientId',
  'client',
  'envelopeProvider',
  'secretProvider',
  'transport',
  'workerId',
]);

const SERVICE_KEYS = Object.freeze(['runWithAccessTokenOnce']);
const INPUT_KEYS = Object.freeze(['clientId', 'endpointId']);
const LOAN_KEYS = Object.freeze(['accessToken']);

const STATUS_REAUTH = 'reauthorization_required';
const STATUS_UNCERTAIN = 'uncertain';
const STATUS_UNAVAILABLE = 'unavailable';

if (REQUEST_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('access_session_sunset_deployment_mismatch');
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
  if (!exactPlainData(input, INPUT_KEYS)) return null;
  const clientId = ownData(input, 'clientId');
  const endpointId = ownData(input, 'endpointId');
  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) return null;
  if (typeof endpointId !== 'string' || !UUID_RE.test(endpointId)) return null;
  return Object.freeze({
    clientId: clientId.trim().toLowerCase(),
    endpointId: endpointId.trim().toLowerCase(),
  });
}

function parseWorkerId(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v.length < 1 || v.length > 128 || /\s/.test(v) || v !== raw) return null;
  return v;
}

function sessionFail(status, grantGeneration) {
  return Object.freeze({
    ok: false,
    status: String(status),
    grant_generation: grantGeneration == null ? null : Number(grantGeneration),
  });
}

function sessionOk(grantGeneration, value) {
  return Object.freeze({
    ok: true,
    grant_generation: Number(grantGeneration),
    value,
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

/**
 * Factory: pin trusted deps; one-shot runWithAccessTokenOnce.
 *
 * @param {object} deps exact ordered DEPENDENCY_KEYS bag
 * @returns {{ runWithAccessTokenOnce: Function }}
 */
function createDelegatedGrantAccessSession(deps) {
  let client;
  let envelopeProvider;
  let applicationClientId;
  let secretProvider;
  let transport;
  let workerId;
  try {
    if (!exactPlainData(deps, DEPENDENCY_KEYS)
        || ownData(deps, 'deployment') !== SUNSET_DEPLOYMENT) throw failure();
    applicationClientId = ownData(deps, 'applicationClientId');
    client = ownData(deps, 'client');
    envelopeProvider = ownData(deps, 'envelopeProvider');
    secretProvider = ownData(deps, 'secretProvider');
    transport = ownData(deps, 'transport');
    workerId = parseWorkerId(ownData(deps, 'workerId'));
    if (typeof applicationClientId !== 'string' || !UUID_RE.test(applicationClientId)) {
      throw failure();
    }
    if (!workerId) throw failure();
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

  /**
   * Callback-scoped one-shot access session.
   *
   * @param {object} input exact own-data { clientId, endpointId }
   * @param {Function} consumer async (loan) => any — loan is mutable { accessToken }
   * @returns {Promise<{ok:true,grant_generation:number,value:*}|{ok:false,status:string,grant_generation:number|null}>}
   */
  async function runWithAccessTokenOnce(input, consumer) {
    if (used) throw failure();
    used = true;
    if (typeof consumer !== 'function') throw failure();

    const ids = snapshotIds(input);
    if (!ids) throw failure();

    let lease = null;
    let refreshToken = null;
    let accessTokenOwner = null;
    let refreshToSeal = null;
    let classified = null;
    let loan = null;

    try {
      const prior = await getDelegatedGrantPublicStatus({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
      }, { client });
      if (!prior.ok) throw failure();
      const priorDto = prior.value;
      if (!priorDto.grant_present) {
        return sessionFail(STATUS_UNAVAILABLE, null);
      }
      if (priorDto.grant_status === 'reauthorization_required'
          || priorDto.grant_status === 'revoked') {
        return sessionFail(STATUS_REAUTH, priorDto.grant_generation);
      }

      const acquired = await tryAcquireDelegatedGrantLease({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
        workerId,
      }, { client });
      if (!acquired.ok) {
        return sessionFail(STATUS_UNAVAILABLE, priorDto.grant_generation);
      }
      lease = acquired.value;

      const opened = await openDelegatedGrantUnderLease(lease, {
        client,
        envelopeProvider,
      });
      if (!opened.ok || typeof opened.value.refresh_token !== 'string') {
        await safeAbort(client, ids, lease);
        lease = null;
        return sessionFail(STATUS_UNAVAILABLE, priorDto.grant_generation);
      }
      refreshToken = opened.value.refresh_token;

      const exchange = createMicrosoftRefreshTokenRequestService(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId,
        secretProvider,
        transport,
      }));
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
        return sessionFail(STATUS_UNCERTAIN, gen);
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
          return sessionFail(STATUS_UNCERTAIN, priorDto.grant_generation);
        }
        return sessionFail(STATUS_REAUTH, reauth.value.grant_generation);
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
        return sessionFail(STATUS_UNCERTAIN, gen);
      }

      // Narrow token owners: extract minimum locals, then drop classified/selected.
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
          return sessionFail(STATUS_UNCERTAIN, gen);
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
            return sessionFail(STATUS_UNCERTAIN, gen);
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
          return sessionFail(STATUS_UNCERTAIN, gen);
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
        return sessionFail(STATUS_UNCERTAIN, gen);
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
        return sessionFail(STATUS_UNCERTAIN, gen);
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
        // CAS conflict / zero row / commit_outcome_unknown → zero callback.
        return sessionFail(STATUS_UNCERTAIN, priorDto.grant_generation);
      }

      const grantGeneration = committed.value.grant_generation;

      // Callback only after conclusively successful CAS. Await exactly once.
      loan = { accessToken: accessTokenOwner };
      accessTokenOwner = null;
      let value;
      try {
        value = await Reflect.apply(consumer, undefined, [loan]);
      } finally {
        if (loan) {
          try { loan.accessToken = null; } catch { /* */ }
        }
        loan = null;
        accessTokenOwner = null;
      }
      return sessionOk(grantGeneration, value);
    } catch (err) {
      await safeAbort(client, ids, lease);
      lease = null;
      if (err && err.code === FAILURE_CODE) throw err;
      throw failure();
    } finally {
      // Scrub every local token owner regardless of path.
      if (loan) {
        try { loan.accessToken = null; } catch { /* */ }
        loan = null;
      }
      accessTokenOwner = null;
      refreshToken = null;
      refreshToSeal = null;
      classified = null;
    }
  }

  return Object.freeze({ runWithAccessTokenOnce });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  SUNSET_DEPLOYMENT,
  DEPENDENCY_KEYS,
  SERVICE_KEYS,
  INPUT_KEYS,
  LOAN_KEYS,
  STATUS_REAUTH,
  STATUS_UNCERTAIN,
  STATUS_UNAVAILABLE,
  EMAIL_DELEGATED_GRANT_ACCESS_SESSION_RUNTIME_WIRED,
  createDelegatedGrantAccessSession,
});
