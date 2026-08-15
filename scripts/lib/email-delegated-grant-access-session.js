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
 * seal helpers). Scrubs loan.accessToken and releases all local token-owner
 * references (opened/refresh/access/selected/classified/sealed) in finally —
 * reference release only (nullable lets set to null).
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
  readTrustedMicrosoftRefreshTokenRequestStage,
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

/** Closed-enum internal observation stages. Never includes IDs, tokens, or errors. */
const DELEGATED_GRANT_ACCESS_SESSION_INTERNAL_STAGES = Object.freeze([
  'status',
  'lease',
  'open',
  'secret',
  'token',
  'response',
  'dead_grant',
  'reseal',
  'commit',
  'release',
]);
const INTERNAL_STAGE_SET = new Set(DELEGATED_GRANT_ACCESS_SESSION_INTERNAL_STAGES);
const INTERNAL_STAGE_NOTE_KEYS = Object.freeze(['stage', 'code']);
const INTERNAL_STAGE_BRAND = new WeakMap();
const CREATED_SESSIONS = new WeakSet();
const SESSION_OBSERVERS = new WeakMap();

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

function freezeInternalStageNote(stage) {
  try {
    if (typeof stage !== 'string' || !INTERNAL_STAGE_SET.has(stage)) return null;
    const note = { stage, code: stage };
    if (!exactPlainData(note, INTERNAL_STAGE_NOTE_KEYS)) return null;
    return Object.freeze(note);
  } catch {
    return null;
  }
}

function brandTrustedDelegatedGrantAccessSessionInternalStage(target, stage) {
  try {
    if (target == null || (typeof target !== 'object' && typeof target !== 'function')) {
      return target;
    }
    if (typeof stage !== 'string' || !INTERNAL_STAGE_SET.has(stage)) return target;
    INTERNAL_STAGE_BRAND.set(target, stage);
    return target;
  } catch {
    return target;
  }
}

function readTrustedDelegatedGrantAccessSessionInternalStage(target) {
  try {
    if (target == null || (typeof target !== 'object' && typeof target !== 'function')) {
      return null;
    }
    return freezeInternalStageNote(INTERNAL_STAGE_BRAND.get(target));
  } catch {
    return null;
  }
}

function bindTrustedDelegatedGrantAccessSessionInternalStageObserver(session, observer) {
  try {
    if (!session || !CREATED_SESSIONS.has(session)) return false;
    if (typeof observer !== 'function') return false;
    SESSION_OBSERVERS.set(session, observer);
    return true;
  } catch {
    return false;
  }
}

function notifyInternalStageObserver(session, stage) {
  try {
    const observer = SESSION_OBSERVERS.get(session);
    if (typeof observer !== 'function') return;
    const note = freezeInternalStageNote(stage);
    if (!note) return;
    observer(note);
  } catch {
    // Observer failure must never alter session control flow.
  }
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
  let service = null;

  function failAt(stage) {
    const error = failure();
    brandTrustedDelegatedGrantAccessSessionInternalStage(error, stage);
    notifyInternalStageObserver(service, stage);
    return error;
  }

  function sessionFailAt(status, grantGeneration, stage) {
    const result = sessionFail(status, grantGeneration);
    brandTrustedDelegatedGrantAccessSessionInternalStage(result, stage);
    notifyInternalStageObserver(service, stage);
    return result;
  }

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

    // Nullable local token-owner references. Outer finally releases all of them
    // via reference nulling only.
    let lease = null;
    let openedOwner = null;
    let refreshToken = null;
    let accessCandidate = null;
    let accessTokenOwner = null;
    let refreshToSeal = null;
    let classified = null;
    let selectedOwner = null;
    let sealedOwner = null;
    let loan = null;

    try {
      const prior = await getDelegatedGrantPublicStatus({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
      }, { client });
      if (!prior.ok) throw failAt('status');
      const priorDto = prior.value;
      if (!priorDto.grant_present) {
        return sessionFailAt(STATUS_UNAVAILABLE, null, 'status');
      }
      if (priorDto.grant_status === 'reauthorization_required'
          || priorDto.grant_status === 'revoked') {
        return sessionFailAt(STATUS_REAUTH, priorDto.grant_generation, 'dead_grant');
      }

      const acquired = await tryAcquireDelegatedGrantLease({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
        workerId,
      }, { client });
      if (!acquired.ok) {
        return sessionFailAt(STATUS_UNAVAILABLE, priorDto.grant_generation, 'lease');
      }
      lease = acquired.value;

      openedOwner = await openDelegatedGrantUnderLease(lease, {
        client,
        envelopeProvider,
      });
      if (!openedOwner.ok
          || !openedOwner.value
          || typeof openedOwner.value.refresh_token !== 'string') {
        await safeAbort(client, ids, lease);
        lease = null;
        return sessionFailAt(STATUS_UNAVAILABLE, priorDto.grant_generation, 'open');
      }
      // Extract only the needed refresh string, then drop opened result owner.
      refreshToken = openedOwner.value.refresh_token;
      openedOwner = null;

      // Trusted persisted scope_version from private lease snapshot only.
      // Never browser/env/provider response — missing/hostile fails closed.
      const scopeVersion = typeof lease.scope_version === 'string' ? lease.scope_version : '';

      const exchange = createMicrosoftRefreshTokenRequestService(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId,
        secretProvider,
        transport,
      }));
      try {
        classified = await exchange.exchangeRefreshToken(Object.freeze({
          refreshToken,
          scopeVersion,
        }));
      } catch (exchangeErr) {
        const refreshNote = readTrustedMicrosoftRefreshTokenRequestStage(exchangeErr);
        const exchangeStage = refreshNote && refreshNote.stage ? refreshNote.stage : 'token';
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
        return sessionFailAt(STATUS_UNCERTAIN, gen, exchangeStage);
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
          return sessionFailAt(STATUS_UNCERTAIN, priorDto.grant_generation, 'dead_grant');
        }
        return sessionFailAt(STATUS_REAUTH, reauth.value.grant_generation, 'dead_grant');
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
        return sessionFailAt(STATUS_UNCERTAIN, gen, 'response');
      }

      // Narrow token owners: extract minimum locals, then drop classified/selected.
      // accessCandidate is a nullable outer-scope owner (never a const token alias).
      try {
        selectedOwner = classified.selected;
        classified = null;
        if (selectedOwner
            && typeof selectedOwner.accessToken === 'string'
            && selectedOwner.accessToken) {
          accessCandidate = selectedOwner.accessToken;
        }
        if (typeof accessCandidate !== 'string' || !accessCandidate) {
          accessCandidate = null;
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
          return sessionFailAt(STATUS_UNCERTAIN, gen, 'response');
        }
        // Transfer custody to accessTokenOwner; drop candidate alias immediately.
        accessTokenOwner = accessCandidate;
        accessCandidate = null;

        if (selectedOwner.refreshTokenOmitted === true) {
          if (typeof refreshToken !== 'string' || !refreshToken) {
            accessTokenOwner = null;
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
            return sessionFailAt(STATUS_UNCERTAIN, gen, 'response');
          }
          refreshToSeal = refreshToken;
        } else if (selectedOwner.refreshTokenOmitted === false
            && typeof selectedOwner.refreshToken === 'string'
            && selectedOwner.refreshToken) {
          refreshToSeal = selectedOwner.refreshToken;
        } else {
          accessTokenOwner = null;
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
          return sessionFailAt(STATUS_UNCERTAIN, gen, 'response');
        }
      } finally {
        classified = null;
        selectedOwner = null;
        accessCandidate = null;
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
        throw failAt('reseal');
      }

      try {
        sealedOwner = await envelopeProvider.sealGrantPayload({
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
        return sessionFailAt(STATUS_UNCERTAIN, gen, 'reseal');
      } finally {
        refreshToSeal = null;
      }

      const envCheck = validateGrantEnvelopeRecordV1(sealedOwner);
      // Release sealed working owner after envelope validation extracts value.
      sealedOwner = null;
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
        return sessionFailAt(STATUS_UNCERTAIN, gen, 'reseal');
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
        return sessionFailAt(STATUS_UNCERTAIN, priorDto.grant_generation, 'commit');
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
      throw failAt('release');
    } finally {
      // Release every local token-owner reference regardless of path.
      // Reference nulling only.
      if (loan) {
        try { loan.accessToken = null; } catch { /* */ }
        loan = null;
      }
      accessCandidate = null;
      accessTokenOwner = null;
      refreshToken = null;
      refreshToSeal = null;
      classified = null;
      selectedOwner = null;
      sealedOwner = null;
      openedOwner = null;
    }
  }

  service = Object.freeze({ runWithAccessTokenOnce });
  CREATED_SESSIONS.add(service);
  return service;
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
  DELEGATED_GRANT_ACCESS_SESSION_INTERNAL_STAGES,
  createDelegatedGrantAccessSession,
  readTrustedDelegatedGrantAccessSessionInternalStage,
  bindTrustedDelegatedGrantAccessSessionInternalStageObserver,
});
