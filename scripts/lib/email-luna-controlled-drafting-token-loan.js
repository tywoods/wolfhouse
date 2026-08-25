'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4C — closed draft-only token loan.
 *
 * Reuses canonical delegated-grant custody (lease → open → MS refresh → reseal →
 * CAS) and Key Vault envelope owners. Does not add a second OAuth architecture.
 * Refresh REQUESTS exact controlled_drafting_v1 scopes (no Mail.Send) as a
 * downscope of an existing Phase A/B grant. Broader returned tokens refuse
 * before Graph. Caller (Staff API / Chapter 3) never receives a raw token,
 * header, fetch, or Graph client.
 *
 * Architecture: Microsoft identity v2 documents refresh-token downscoping via
 * the `scope` parameter. Staff send continues to refresh the same grant without
 * a scope parameter (full Phase B, Mail.Send present). If live Microsoft
 * ignores downscope and returns Mail.Send, this loan fails closed. That is not
 * a silent weaken of the Chapter 1 scope claim.
 *
 * @module email-luna-controlled-drafting-token-loan
 */

const crypto = require('node:crypto');
const {
  isProxySurface,
  ownData,
  exactOwnData,
  isCanonUuid,
} = require('./email-luna-controlled-drafting-closed-data');
const {
  tryAcquireDelegatedGrantLease,
  openDelegatedGrantUnderLease,
  commitDelegatedGrantRotation,
  markDelegatedGrantReauthorizationRequired,
  markDelegatedGrantReconciliation,
  abortDelegatedGrantLease,
  getDelegatedGrantPublicStatus,
  resolveDelegatedReadAuthorityBinding,
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
const {
  EMAIL_MS_DELEGATED_SCOPE_VERSION,
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
} = require('./email-microsoft-delegated-oauth-contract');
const {
  createControlledDraftingAccessTokenClaimsInspector,
} = require('./email-luna-controlled-drafting-access-token-claims');

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const objectFreeze = Object.freeze;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const stringTrim = uncurryThis(String.prototype.trim);

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_TOKEN_LOAN_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting token loan failed.';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const SCOPE_PROFILE_ID = 'controlled_drafting_v1';
const REQUESTED_SCOPE = 'openid profile offline_access User.Read Mail.ReadWrite';
const WORKER_ID_DEFAULT = 'email-luna-controlled-drafting-token-loan';
const EMAIL_LUNA_CONTROLLED_DRAFTING_TOKEN_LOAN_RUNTIME_WIRED = false;
const ACCEPTED_GRANT_SCOPE_VERSIONS = objectFreeze([
  EMAIL_MS_DELEGATED_SCOPE_VERSION,
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
]);

const DEPENDENCY_KEYS = objectFreeze([
  'deployment',
  'applicationClientId',
  'withPgClient',
  'envelopeProvider',
  'createSecretProvider',
  'transport',
  'workerId',
  'createSignatureVerifier',
  'binding',
]);
const BINDING_KEYS = objectFreeze([
  'clientId',
  'locationId',
  'endpointId',
  'mailboxId',
]);
const SERVICE_KEYS = objectFreeze(['attest', 'runClosed']);
const ATTEST_KEYS = objectFreeze([
  'ok',
  'scope_profile_id',
  'scope_profile_version',
  'requested_scopes',
  'send_capable',
  'mail_send',
  'mail_readwrite',
  'provider',
  'audience',
  'app_only',
]);
const LOAN_CONSUMER_KEYS = objectFreeze(['accessToken']);

const CLOSED_LOANS = new WeakSet();
const KILL_SWITCHES = new WeakMap();
const TOKEN_LOAN_FAILURE_BRAND = new WeakMap();
const TOKEN_LOAN_FAILURE_NOTE_KEYS = objectFreeze(['stage', 'code']);
const TOKEN_LOAN_STAGES = objectFreeze([
  'kill_switch',
  'status',
  'lease',
  'open',
  'grant_scope',
  'secret',
  'token',
  'response',
  'claims',
  'binding',
  'dead_grant',
  'reseal',
  'commit',
  'release',
]);
const STAGE_SET = new Set(TOKEN_LOAN_STAGES);

if (REQUEST_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('controlled_drafting_token_loan_sunset_deployment_mismatch');
}

function failure() {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  objectFreeze(error);
  return error;
}

function exactPlainData(object, keys) {
  if (!object || objectGetPrototypeOf(object) !== Object.prototype || isProxySurface(object)) {
    return false;
  }
  const actual = reflectOwnKeys(object);
  if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    return false;
  }
  return keys.every((key) => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor && !descriptor.get && !descriptor.set && objectHasOwn(descriptor, 'value');
    } catch (_) {
      return false;
    }
  });
}

function exactSealedTransport(object) {
  return object
    && Object.isFrozen(object)
    && objectGetPrototypeOf(object) === Object.prototype
    && exactPlainData(object, ['postTokenForm'])
    && typeof ownData(object, 'postTokenForm') === 'function';
}

function parseWorkerId(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v.length < 1 || v.length > 128 || /\s/.test(v) || v !== raw) return null;
  return v;
}

function snapshotBinding(raw) {
  if (!exactPlainData(raw, BINDING_KEYS)) return null;
  const clientId = ownData(raw, 'clientId');
  const locationId = ownData(raw, 'locationId');
  const endpointId = ownData(raw, 'endpointId');
  const mailboxId = ownData(raw, 'mailboxId');
  if (!isCanonUuid(clientId) || !isCanonUuid(locationId) || !isCanonUuid(endpointId)) return null;
  if (!isCanonUuid(mailboxId)) return null;
  return objectFreeze({
    clientId: stringTrim(clientId),
    locationId: stringTrim(locationId),
    endpointId: stringTrim(endpointId),
    mailboxId: stringTrim(mailboxId),
  });
}

function freezeStageNote(stage) {
  try {
    if (typeof stage !== 'string' || !STAGE_SET.has(stage)) return null;
    const note = { stage, code: stage };
    if (!exactPlainData(note, TOKEN_LOAN_FAILURE_NOTE_KEYS)) return null;
    return objectFreeze(note);
  } catch (_) {
    return null;
  }
}

function brandTokenLoanFailure(target, stage) {
  try {
    if (target == null || (typeof target !== 'object' && typeof target !== 'function')) return target;
    if (typeof stage !== 'string' || !STAGE_SET.has(stage)) return target;
    TOKEN_LOAN_FAILURE_BRAND.set(target, stage);
    return target;
  } catch (_) {
    return target;
  }
}

function readTrustedControlledDraftingTokenLoanFailure(target) {
  try {
    if (target == null || (typeof target !== 'object' && typeof target !== 'function')) return null;
    return freezeStageNote(TOKEN_LOAN_FAILURE_BRAND.get(target));
  } catch (_) {
    return null;
  }
}

function isClosedControlledDraftingTokenLoan(value) {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    if (isProxySurface(value) || arrayIsArray(value)) return false;
    return CLOSED_LOANS.has(value);
  } catch (_) {
    return false;
  }
}

function attestSuccess() {
  return objectFreeze({
    ok: true,
    scope_profile_id: SCOPE_PROFILE_ID,
    scope_profile_version: SCOPE_PROFILE_ID,
    requested_scopes: REQUESTED_SCOPE,
    send_capable: false,
    mail_send: false,
    mail_readwrite: true,
    provider: 'microsoft_graph',
    audience: 'microsoft_graph',
    app_only: false,
  });
}

function attestFailure() {
  return objectFreeze({
    ok: false,
    scope_profile_id: SCOPE_PROFILE_ID,
    scope_profile_version: SCOPE_PROFILE_ID,
    requested_scopes: REQUESTED_SCOPE,
    send_capable: false,
    mail_send: false,
    mail_readwrite: true,
    provider: 'microsoft_graph',
    audience: 'microsoft_graph',
    app_only: false,
  });
}

function killSwitchOn(loan) {
  try {
    const fn = KILL_SWITCHES.get(loan);
    if (typeof fn !== 'function') return false;
    return fn() === true;
  } catch (_) {
    return true;
  }
}

function bindControlledDraftingTokenLoanKillSwitch(loan, fn) {
  if (!isClosedControlledDraftingTokenLoan(loan)) throw failure();
  if (typeof fn !== 'function' || isProxySurface(fn)) throw failure();
  KILL_SWITCHES.set(loan, fn);
  return loan;
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

function acceptedGrantScope(version) {
  return version === EMAIL_MS_DELEGATED_SCOPE_VERSION
    || version === EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION;
}

function createEmailLunaControlledDraftingFakeClosedTokenLoan(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const accessToken = ownData(opts, 'accessToken');
  const attestOk = ownData(opts, 'ok') !== false;
  const failRun = ownData(opts, 'failRun') === true;
  const surface = objectFreeze({
    attest() {
      return attestOk ? attestSuccess() : attestFailure();
    },
    async runClosed(consumer) {
      if (typeof consumer !== 'function' || isProxySurface(consumer)) throw failure();
      if (killSwitchOn(surface)) {
        const error = failure();
        brandTokenLoanFailure(error, 'kill_switch');
        throw error;
      }
      if (failRun || typeof accessToken !== 'string' || accessToken.length < 1) {
        const error = failure();
        brandTokenLoanFailure(error, 'token');
        throw error;
      }
      const loan = { accessToken };
      try {
        return await Reflect.apply(consumer, undefined, [loan]);
      } finally {
        try { loan.accessToken = null; } catch (_) { /* */ }
      }
    },
  });
  CLOSED_LOANS.add(surface);
  return surface;
}

function createEmailLunaControlledDraftingTokenLoan(deps) {
  let withPgClient;
  let envelopeProvider;
  let applicationClientId;
  let createSecretProvider;
  let transport;
  let workerId;
  let createSignatureVerifier;
  let binding;
  try {
    if (!exactPlainData(deps, DEPENDENCY_KEYS)
        || ownData(deps, 'deployment') !== SUNSET_DEPLOYMENT) {
      throw failure();
    }
    applicationClientId = ownData(deps, 'applicationClientId');
    withPgClient = ownData(deps, 'withPgClient');
    envelopeProvider = ownData(deps, 'envelopeProvider');
    createSecretProvider = ownData(deps, 'createSecretProvider');
    transport = ownData(deps, 'transport');
    workerId = parseWorkerId(ownData(deps, 'workerId') || WORKER_ID_DEFAULT);
    createSignatureVerifier = ownData(deps, 'createSignatureVerifier');
    binding = snapshotBinding(ownData(deps, 'binding'));
    if (typeof applicationClientId !== 'string' || !isCanonUuid(applicationClientId)) throw failure();
    if (!workerId) throw failure();
    if (typeof withPgClient !== 'function' || isProxySurface(withPgClient)) throw failure();
    if (typeof createSecretProvider !== 'function' || isProxySurface(createSecretProvider)) throw failure();
    if (typeof createSignatureVerifier !== 'function' || isProxySurface(createSignatureVerifier)) {
      throw failure();
    }
    if (!binding) throw failure();
    const prov = validateEmailGrantEnvelopeProvider(envelopeProvider);
    if (!prov.ok) throw failure();
    envelopeProvider = prov.value;
    if (!exactSealedTransport(transport)) throw failure();
  } catch (_) {
    throw failure();
  }

  let chain = Promise.resolve();
  let service = null;

  function failAt(stage) {
    const error = failure();
    brandTokenLoanFailure(error, stage);
    return error;
  }

  function attest() {
    return attestSuccess();
  }

  async function actuallyRun(consumer) {
    if (typeof consumer !== 'function' || isProxySurface(consumer)) throw failAt('release');
    if (killSwitchOn(service)) throw failAt('kill_switch');

    return withPgClient(async (client) => {
      if (!client || typeof client !== 'object' || typeof client.query !== 'function') {
        throw failAt('status');
      }
      if (typeof client.connect === 'function'
          && (typeof client.totalCount === 'number' || typeof client.idleCount === 'number')) {
        throw failAt('status');
      }

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
      const ids = objectFreeze({
        clientId: binding.clientId,
        endpointId: binding.endpointId,
      });

      try {
        if (killSwitchOn(service)) throw failAt('kill_switch');
        const prior = await getDelegatedGrantPublicStatus({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
        }, { client });
        if (!prior.ok) throw failAt('status');
        const priorDto = prior.value;
        if (!priorDto.grant_present) throw failAt('status');
        if (priorDto.grant_status === 'reauthorization_required'
            || priorDto.grant_status === 'revoked') {
          throw failAt('dead_grant');
        }

        const acquired = await tryAcquireDelegatedGrantLease({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          workerId,
        }, { client });
        if (!acquired.ok) throw failAt('lease');
        lease = acquired.value;
        if (!acceptedGrantScope(lease.scope_version)) {
          await safeAbort(client, ids, lease);
          lease = null;
          throw failAt('grant_scope');
        }

        openedOwner = await openDelegatedGrantUnderLease(lease, {
          client,
          envelopeProvider,
        });
        if (!openedOwner.ok
            || !openedOwner.value
            || typeof openedOwner.value.refresh_token !== 'string') {
          await safeAbort(client, ids, lease);
          lease = null;
          throw failAt('open');
        }
        refreshToken = openedOwner.value.refresh_token;
        openedOwner = null;

        const secretProvider = createSecretProvider();
        if (!secretProvider
            || objectGetPrototypeOf(secretProvider) !== Object.prototype
            || typeof ownData(secretProvider, 'getClientSecret') !== 'function') {
          await safeAbort(client, ids, lease);
          lease = null;
          throw failAt('secret');
        }

        const exchange = createMicrosoftRefreshTokenRequestService(objectFreeze({
          deployment: SUNSET_DEPLOYMENT,
          applicationClientId,
          secretProvider,
          transport,
        }));
        try {
          classified = await exchange.exchangeRefreshToken(objectFreeze({
            refreshToken,
            scopeVersion: SCOPE_PROFILE_ID,
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
          throw failAt(exchangeStage);
        }

        if (classified.kind === 'invalid_grant') {
          await markDelegatedGrantReauthorizationRequired({
            clientId: ids.clientId,
            endpointId: ids.endpointId,
            leaseToken: lease.lease_token,
            expectedGeneration: lease.grant_generation,
            reason: 'invalid_grant',
          }, { client });
          lease = null;
          throw failAt('dead_grant');
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
          throw failAt('response');
        }

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
            throw failAt('response');
          }
          accessTokenOwner = accessCandidate;
          accessCandidate = null;

          if (selectedOwner.refreshTokenOmitted === true) {
            if (typeof refreshToken !== 'string' || !refreshToken) {
              accessTokenOwner = null;
              throw failAt('response');
            }
            refreshToSeal = refreshToken;
          } else if (selectedOwner.refreshTokenOmitted === false
              && typeof selectedOwner.refreshToken === 'string'
              && selectedOwner.refreshToken) {
            refreshToSeal = selectedOwner.refreshToken;
          } else {
            accessTokenOwner = null;
            throw failAt('response');
          }
        } finally {
          classified = null;
          selectedOwner = null;
          accessCandidate = null;
        }
        refreshToken = null;

        const bound = await resolveDelegatedReadAuthorityBinding({
          clientId: binding.clientId,
          locationId: binding.locationId,
          endpointId: binding.endpointId,
        }, { client });
        if (!bound.ok
            || !bound.value
            || bound.value.provider !== 'microsoft_graph'
            || bound.value.providerMailboxId !== binding.mailboxId
            || typeof bound.value.providerTenantId !== 'string'
            || !isCanonUuid(bound.value.providerTenantId)) {
          accessTokenOwner = null;
          await safeAbort(client, ids, lease);
          lease = null;
          throw failAt('binding');
        }

        const verifier = createSignatureVerifier();
        if (!verifier || typeof ownData(verifier, 'verify') !== 'function') {
          accessTokenOwner = null;
          await safeAbort(client, ids, lease);
          lease = null;
          throw failAt('claims');
        }
        const inspector = createControlledDraftingAccessTokenClaimsInspector(objectFreeze({
          signatureVerifier: verifier,
        }));
        try {
          await inspector.inspect(objectFreeze({
            accessToken: accessTokenOwner,
            expectedTenantId: bound.value.providerTenantId,
            expectedClientId: applicationClientId,
            expectedPrincipalOid: binding.mailboxId,
            nowEpochSeconds: Math.floor(Date.now() / 1000),
          }));
        } catch (_) {
          accessTokenOwner = null;
          await safeAbort(client, ids, lease);
          lease = null;
          throw failAt('claims');
        }

        if (killSwitchOn(service)) {
          accessTokenOwner = null;
          await safeAbort(client, ids, lease);
          lease = null;
          throw failAt('kill_switch');
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
          throw failAt('reseal');
        } finally {
          refreshToSeal = null;
        }

        const envCheck = validateGrantEnvelopeRecordV1(sealedOwner);
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
          throw failAt('reseal');
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
          throw failAt('commit');
        }

        if (killSwitchOn(service)) {
          accessTokenOwner = null;
          throw failAt('kill_switch');
        }

        loan = { accessToken: accessTokenOwner };
        accessTokenOwner = null;
        let value;
        try {
          value = await Reflect.apply(consumer, undefined, [loan]);
        } finally {
          if (loan) {
            try { loan.accessToken = null; } catch (_) { /* */ }
          }
          loan = null;
          accessTokenOwner = null;
        }
        return value;
      } catch (err) {
        await safeAbort(client, ids, lease);
        lease = null;
        if (readTrustedControlledDraftingTokenLoanFailure(err)) throw err;
        throw failAt('release');
      } finally {
        if (loan) {
          try { loan.accessToken = null; } catch (_) { /* */ }
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
    });
  }

  async function runClosed(consumer) {
    const previous = chain;
    let release = () => {};
    chain = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      return await actuallyRun(consumer);
    } finally {
      release();
    }
  }

  service = objectFreeze({
    attest,
    runClosed,
  });
  CLOSED_LOANS.add(service);
  return service;
}

module.exports = objectFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  SCOPE_PROFILE_ID,
  REQUESTED_SCOPE,
  WORKER_ID_DEFAULT,
  EMAIL_LUNA_CONTROLLED_DRAFTING_TOKEN_LOAN_RUNTIME_WIRED,
  ACCEPTED_GRANT_SCOPE_VERSIONS,
  DEPENDENCY_KEYS,
  BINDING_KEYS,
  SERVICE_KEYS,
  ATTEST_KEYS,
  LOAN_CONSUMER_KEYS,
  TOKEN_LOAN_STAGES,
  createEmailLunaControlledDraftingTokenLoan,
  createEmailLunaControlledDraftingFakeClosedTokenLoan,
  isClosedControlledDraftingTokenLoan,
  bindControlledDraftingTokenLoanKillSwitch,
  readTrustedControlledDraftingTokenLoanFailure,
  attestEmailLunaControlledDraftingTokenLoan: attestSuccess,
});
