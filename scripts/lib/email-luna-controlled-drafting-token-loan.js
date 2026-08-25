'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4C — draft-only Graph provider
 * bound to a construction-time Chapter 1 Graph HTTP consumer.
 *
 * Reuses canonical delegated-grant custody (lease → open → MS refresh →
 * omitted-refresh lease release OR reseal → CAS) and Key Vault envelope
 * owners. Does not add a second OAuth architecture. Refresh REQUESTS exact
 * controlled_drafting_v1 scopes (no Mail.Send) as a downscope of an existing
 * Phase A/B grant. Broader returned tokens refuse before Graph.
 *
 * Production surface is `{attest, createReplyDraft, reconcileDraft}` only.
 * Staff API, activation, Chapter 3, and package exports never receive a raw
 * token, header, fetch, request, Graph client, or caller callback. The only
 * code that receives the access token is the privately bound Chapter 1 Graph
 * draft HTTP consumer created inside this assembly.
 *
 * Live downscoping is unproven until a signed token `scp` excludes Mail.Send
 * AND a later unscoped staff-send refresh succeeds. Microsoft does not
 * guarantee tenant downscope behavior.
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
const {
  createEmailLunaControlledDraftingGraphDraftHttpConsumer,
  GRAPH_OPERATION_KEYS,
  GRAPH_OPERATION_KINDS,
} = require('./email-luna-controlled-drafting-graph-draft-transport');

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
const ATTESTATION_KIND = 'configured_contract_only';
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
  'httpsImpl',
  'timers',
]);
const BINDING_KEYS = objectFreeze([
  'clientId',
  'locationId',
  'endpointId',
  'mailboxId',
]);
const SERVICE_KEYS = objectFreeze(['attest', 'createReplyDraft', 'reconcileDraft']);
const ATTEST_KEYS = objectFreeze([
  'ok',
  'attestation_kind',
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
const FORBIDDEN_DEPENDENCY_KEYS = objectFreeze([
  'consumer', 'callback', 'runClosed', 'withToken', 'getAccessToken',
  'accessToken', 'fetch', 'request', 'client',
]);

const CLOSED_GRAPH_PROVIDERS = new WeakSet();
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

function isClosedControlledDraftingGraphProvider(value) {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    if (isProxySurface(value) || arrayIsArray(value)) return false;
    return CLOSED_GRAPH_PROVIDERS.has(value);
  } catch (_) {
    return false;
  }
}

function attestSuccess() {
  return objectFreeze({
    ok: true,
    attestation_kind: ATTESTATION_KIND,
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
  if (!isClosedControlledDraftingGraphProvider(loan)) throw failure();
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

function valueContainsSecret(value, token) {
  if (typeof token !== 'string' || token.length < 1) return false;
  try {
    if (typeof value === 'string') return value.includes(token);
    if (value && (typeof value === 'object' || typeof value === 'function')) {
      return JSON.stringify(value).includes(token);
    }
  } catch (_) {
    return true;
  }
  return false;
}

function createEmailLunaControlledDraftingGraphProvider(deps) {
  let withPgClient;
  let envelopeProvider;
  let applicationClientId;
  let createSecretProvider;
  let transport;
  let workerId;
  let createSignatureVerifier;
  let binding;
  let graphConsumer;
  try {
    if (deps && typeof deps === 'object') {
      const depKeys = reflectOwnKeys(deps);
      for (let i = 0; i < depKeys.length; i += 1) {
        if (FORBIDDEN_DEPENDENCY_KEYS.includes(depKeys[i])) throw failure();
      }
    }
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
    const httpsImpl = ownData(deps, 'httpsImpl');
    const timers = ownData(deps, 'timers');
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
    if (typeof httpsImpl !== 'function' || isProxySurface(httpsImpl)) throw failure();
    if (!timers || typeof ownData(timers, 'setTimeout') !== 'function'
        || typeof ownData(timers, 'clearTimeout') !== 'function') {
      throw failure();
    }
    graphConsumer = createEmailLunaControlledDraftingGraphDraftHttpConsumer({
      httpsImpl,
      timers,
    });
    if (typeof graphConsumer !== 'function' || isProxySurface(graphConsumer)) throw failure();
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

  async function actuallyExecute(operation) {
    if (typeof operation === 'function' || isProxySurface(operation)) throw failAt('release');
    const op = exactOwnData(operation, GRAPH_OPERATION_KEYS);
    if (!op || !GRAPH_OPERATION_KINDS.includes(op.kind)) throw failAt('release');
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
      let refreshTokenOmitted = false;
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
            refreshTokenOmitted = true;
            refreshToSeal = null;
          } else if (selectedOwner.refreshTokenOmitted === false
              && typeof selectedOwner.refreshToken === 'string'
              && selectedOwner.refreshToken) {
            refreshTokenOmitted = false;
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
            || !isCanonUuid(bound.value.providerTenantId)
            || typeof bound.value.providerPrincipalOid !== 'string'
            || !isCanonUuid(bound.value.providerPrincipalOid)
            || bound.value.bindingStatus !== 'verified') {
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
            expectedPrincipalOid: bound.value.providerPrincipalOid,
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

        if (refreshTokenOmitted === true) {
          const released = await abortDelegatedGrantLease({
            clientId: ids.clientId,
            endpointId: ids.endpointId,
            leaseToken: lease.lease_token,
            expectedGeneration: lease.grant_generation,
          }, { client });
          if (!released.ok) {
            accessTokenOwner = null;
            throw failAt('release');
          }
          lease = null;
          refreshToSeal = null;
        } else {
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
          if (!committed.ok) {
            accessTokenOwner = null;
            await markDelegatedGrantReconciliation({
              clientId: ids.clientId,
              endpointId: ids.endpointId,
              leaseToken: lease.lease_token,
              expectedGeneration: lease.grant_generation,
              reconcileState: 'ms_response_uncertain',
              reconcileDetailCode: 'post_ms_cas_conflict',
            }, { client });
            await safeAbort(client, ids, lease);
            lease = null;
            throw failAt('commit');
          }
          lease = null;
        }

        if (killSwitchOn(service)) {
          accessTokenOwner = null;
          throw failAt('kill_switch');
        }

        const tokenForConsumer = accessTokenOwner;
        accessTokenOwner = null;
        let value;
        try {
          value = await Reflect.apply(graphConsumer, undefined, [
            tokenForConsumer,
            objectFreeze({
              kind: op.kind,
              command: op.command,
            }),
          ]);
        } catch (consumerErr) {
          if (valueContainsSecret(consumerErr, tokenForConsumer)) throw failAt('release');
          throw consumerErr;
        } finally {
          accessTokenOwner = null;
        }
        if (valueContainsSecret(value, tokenForConsumer)) throw failAt('release');
        return value;
      } catch (err) {
        await safeAbort(client, ids, lease);
        lease = null;
        if (readTrustedControlledDraftingTokenLoanFailure(err)) throw err;
        throw failAt('release');
      } finally {
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

  async function execute(operation) {
    const previous = chain;
    let release = () => {};
    chain = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      return await actuallyExecute(operation);
    } finally {
      release();
    }
  }

  async function createReplyDraft(command) {
    return execute(objectFreeze({
      kind: 'create_reply_draft',
      command,
    }));
  }

  async function reconcileDraft(command) {
    return execute(objectFreeze({
      kind: 'reconcile_draft',
      command,
    }));
  }

  service = objectFreeze({
    attest,
    createReplyDraft,
    reconcileDraft,
  });
  CLOSED_GRAPH_PROVIDERS.add(service);
  return service;
}

module.exports = objectFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  SCOPE_PROFILE_ID,
  REQUESTED_SCOPE,
  ATTESTATION_KIND,
  WORKER_ID_DEFAULT,
  EMAIL_LUNA_CONTROLLED_DRAFTING_TOKEN_LOAN_RUNTIME_WIRED,
  ACCEPTED_GRANT_SCOPE_VERSIONS,
  DEPENDENCY_KEYS,
  BINDING_KEYS,
  SERVICE_KEYS,
  ATTEST_KEYS,
  TOKEN_LOAN_STAGES,
  createEmailLunaControlledDraftingGraphProvider,
  isClosedControlledDraftingGraphProvider,
  bindControlledDraftingTokenLoanKillSwitch,
  readTrustedControlledDraftingTokenLoanFailure,
  attestEmailLunaControlledDraftingTokenLoan: attestSuccess,
});
