'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4G — fixed internal
 * Sunset-staging live-target contract for the Chapter 4E operator prover.
 *
 * Import-inert. Does not call Azure/KV/live PG/Microsoft/JWKS on load.
 * Composition uses existing canonical owners only. No public generic
 * callback, token consumer, HTTP route, Graph provider, or send method.
 *
 * Live compose/runProof are structurally disabled this chapter. Chapter 4H
 * supplies the private owned Azure ACA / ACR / PG reader. Caller snapshots
 * remain untrusted validation inputs and never mint an independent/live
 * proof brand. Live token proof is still not executed.
 *
 * @module email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target
 */

const nodeCrypto = require('node:crypto');
const nodeHttps = require('node:https');
const nodeTimers = require('node:timers');
const {
  isProxySurface,
  ownData,
  isCanonUuid,
} = require('./email-luna-controlled-drafting-closed-data');
const {
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  SUNSET_LOCATION_KEY,
  EXPECTED_DATABASE,
  EXPECTED_LIVE_TARGET,
  OPERATOR_PROVER_COMPATIBILITY_RULE,
  LIVE_CUSTODY_DSN_ENV_KEY,
  LIVE_CUSTODY_REFUSES_ADMIN_DSN_ENV_KEY,
} = require('./email-luna-controlled-drafting-live-downscope-prover-live-target-constants');
const {
  createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition,
  SUNSET_STAGING_TRUSTED_HOST,
  SUNSET_STAGING_VERSIONED_KEY_ID,
} = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const {
  validateEmailGrantEnvelopeProvider,
} = require('./email-grant-envelope-provider-contract');
const {
  createSunsetMicrosoftOAuthClientSecretProvider,
  SUNSET_DEPLOYMENT: SECRET_SUNSET,
} = require('./sunset-microsoft-oauth-provider');
const {
  createMicrosoftTokenHttpTransport,
} = require('./email-microsoft-token-http-transport');
const {
  createMicrosoftOidcJwksSignatureVerifier,
  isCanonicalMicrosoftOidcJwksSignatureVerifier,
} = require('./email-microsoft-oidc-jwks-verifier');
const {
  createEmailLunaControlledDraftingPrincipalConnectionPair,
  isAuthenticEmailLunaControlledDraftingPrincipalConnectionPair,
  ENV_PRODUCER_DATABASE_URL,
  ENV_WORKER_DATABASE_URL,
} = require('./email-luna-controlled-drafting-principal-connection');
const {
  CANONICAL_RUNTIME_OWNER_DIGESTS,
  proveCanonicalRuntimeOwnersMatchDeployedContract,
} = require('./email-luna-controlled-drafting-live-downscope-prover-canonical-owners');
const {
  readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg,
  isIndependentLivePreflight,
} = require('./email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader');
const chapter4IAuthority = require('./email-luna-controlled-drafting-chapter-4i-one-shot-authority');

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const objectFreeze = Object.freeze;
const objectCreate = Object.create;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const arrayIncludes = uncurryThis(Array.prototype.includes);

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_TARGET_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting live-target wiring failed.';
const PROVER_ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_DOWNSCOPE_PROVER_INVALID';
const WORKER_ID_DEFAULT = 'email-luna-controlled-drafting-live-downscope-prover';
const LIVE_FACTORY_KEYS = objectFreeze(['env']);
const CANONICAL_LIVE_MICROSOFT_TRANSPORTS = new WeakSet();
const CANONICAL_LIVE_JWKS_FACTORIES = new WeakSet();
const CONNECTED_PG_KEYS = objectFreeze(['Client', 'connectionString', 'work']);
const LIVE_EXECUTE_INTERNAL_AUTHORIZATION = objectFreeze({
  authorized: LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
});

const EIGHT_FLAGS = objectFreeze([
  'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED',
  'LUNA_AUTO_SEND_ENABLED',
  'CUSTOMER_OUTREACH_WHATSAPP_ENABLED',
  'STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED',
]);

const AZURE_SNAPSHOT_KEYS = objectFreeze([
  'resourceGroup', 'appName', 'revision', 'imageSha', 'digest', 'runningStatus',
  'latestReadyRevisionName', 'trafficWeight', 'latestRevisionTraffic', 'replica',
  'minReplicas', 'maxReplicas', 'tenant', 'locationKey', 'database', 'flags',
  'ops097', 'transitions097', 'authorizations098', 'bindingOk', 'ownUser',
  'mailboxReady', 'grantStatus', 'reconcileState', 'hasActiveLease', 'hasActiveOperation',
]);

if (SECRET_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('controlled_drafting_live_target_sunset_deployment_mismatch');
}
if (LIVE_CUSTODY_DSN_ENV_KEY !== ENV_WORKER_DATABASE_URL) {
  throw new Error('controlled_drafting_live_target_worker_dsn_key_mismatch');
}
if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) {
  throw new Error('controlled_drafting_live_execute_must_be_disabled_in_this_chapter');
}

function failure(code) {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  if (typeof code === 'string') error.detail = code;
  objectFreeze(error);
  return error;
}

function refuse() {
  return objectFreeze({
    ok: false,
    reason: 'live_target_refused',
    independent_read: false,
    untrusted_caller_snapshot: true,
    live_authority: false,
  });
}

function refuseLiveExecuteIfDisabled() {
  if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER === true
      && LIVE_EXECUTE_INTERNAL_AUTHORIZATION.authorized === true) {
    return;
  }
  throw failure('live_execute_not_authorized_in_this_chapter');
}

function exactPlainData(object, keys) {
  if (!object || objectGetPrototypeOf(object) !== Object.prototype || isProxySurface(object)) {
    return false;
  }
  const actual = reflectOwnKeys(object);
  if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !arrayIncludes(keys, key))) {
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

function freezeBoundBag(owner, keys) {
  if (!owner || (typeof owner !== 'object' && typeof owner !== 'function') || isProxySurface(owner)) {
    return null;
  }
  const bag = {};
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const fn = owner[key];
    if (typeof fn !== 'function' || isProxySurface(fn)) return null;
    Object.defineProperty(bag, key, {
      value: fn.bind(owner),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return objectFreeze(bag);
}

function flagsLiteralFalse(flags) {
  if (!exactPlainData(flags, EIGHT_FLAGS)) return false;
  for (let i = 0; i < EIGHT_FLAGS.length; i += 1) {
    const raw = ownData(flags, EIGHT_FLAGS[i]);
    if (raw !== false && raw !== 'false') return false;
  }
  return true;
}

function evaluateSunsetStagingLiveAppSnapshot(snapshot) {
  try {
    if (!exactPlainData(snapshot, AZURE_SNAPSHOT_KEYS)) return refuse();
    if (ownData(snapshot, 'resourceGroup') !== EXPECTED_LIVE_TARGET.resourceGroup) return refuse();
    if (ownData(snapshot, 'appName') !== EXPECTED_LIVE_TARGET.appName) return refuse();
    if (ownData(snapshot, 'revision') !== EXPECTED_LIVE_TARGET.revision) return refuse();
    if (ownData(snapshot, 'imageSha') !== EXPECTED_LIVE_TARGET.deployedSha) return refuse();
    if (ownData(snapshot, 'digest') !== EXPECTED_LIVE_TARGET.digest) return refuse();
    if (ownData(snapshot, 'runningStatus') !== 'Running') return refuse();
    if (ownData(snapshot, 'latestReadyRevisionName') !== EXPECTED_LIVE_TARGET.revision) return refuse();
    if (ownData(snapshot, 'trafficWeight') !== 100) return refuse();
    if (ownData(snapshot, 'latestRevisionTraffic') !== true) return refuse();
    if (ownData(snapshot, 'replica') !== 1) return refuse();
    if (ownData(snapshot, 'minReplicas') !== 1) return refuse();
    if (ownData(snapshot, 'maxReplicas') !== 1) return refuse();
    if (ownData(snapshot, 'tenant') !== SUNSET_TENANT) return refuse();
    if (ownData(snapshot, 'locationKey') !== SUNSET_LOCATION_KEY) return refuse();
    if (ownData(snapshot, 'database') !== EXPECTED_DATABASE) return refuse();
    if (!flagsLiteralFalse(ownData(snapshot, 'flags'))) return refuse();
    if (ownData(snapshot, 'ops097') !== 0) return refuse();
    if (ownData(snapshot, 'transitions097') !== 0) return refuse();
    if (ownData(snapshot, 'authorizations098') !== 0) return refuse();
    if (ownData(snapshot, 'bindingOk') !== true) return refuse();
    if (ownData(snapshot, 'ownUser') !== true) return refuse();
    if (ownData(snapshot, 'mailboxReady') !== true) return refuse();
    if (ownData(snapshot, 'grantStatus') !== 'active') return refuse();
    if (ownData(snapshot, 'reconcileState') !== 'clean') return refuse();
    if (ownData(snapshot, 'hasActiveLease') !== false) return refuse();
    if (ownData(snapshot, 'hasActiveOperation') !== false) return refuse();
    const owners = proveCanonicalRuntimeOwnersMatchDeployedContract();
    if (!owners.ok) return refuse();
    return objectFreeze({
      ok: true,
      resource_group: EXPECTED_LIVE_TARGET.resourceGroup,
      app_name: EXPECTED_LIVE_TARGET.appName,
      revision: EXPECTED_LIVE_TARGET.revision,
      deploy_sha: EXPECTED_LIVE_TARGET.deployedSha,
      digest: EXPECTED_LIVE_TARGET.digest,
      replica: 1,
      traffic_weight: 100,
      running_status: 'Running',
      latest_ready: true,
      tenant: SUNSET_TENANT,
      location_key: SUNSET_LOCATION_KEY,
      database: EXPECTED_DATABASE,
      flags_all_literal_false: true,
      caller_097_098_are_not_authority: true,
      independent_read: false,
      untrusted_caller_snapshot: true,
      live_authority: false,
      compatibility_rule_id: OPERATOR_PROVER_COMPATIBILITY_RULE.rule_id,
      canonical_owners_matched: true,
      canonical_owners_attestation_kind: 'source_tree_self_hash',
    });
  } catch (_) {
    return refuse();
  }
}

function isCanonicalLiveMicrosoftTransport(value) {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    return CANONICAL_LIVE_MICROSOFT_TRANSPORTS.has(value);
  } catch (_) {
    return false;
  }
}

function isCanonicalLiveJwksFactory(value) {
  try {
    if (typeof value !== 'function') return false;
    return CANONICAL_LIVE_JWKS_FACTORIES.has(value);
  } catch (_) {
    return false;
  }
}

function envString(env, key) {
  const value = ownData(env, key);
  return typeof value === 'string' ? value : undefined;
}

function flagsAllLiteralFalse(env) {
  for (let i = 0; i < EIGHT_FLAGS.length; i += 1) {
    const raw = ownData(env, EIGHT_FLAGS[i]);
    if (raw !== false && raw !== 'false') return false;
  }
  return true;
}

function looksLikeAdminStaffApiDsn(connectionString) {
  if (typeof connectionString !== 'string' || connectionString.length < 1) return false;
  const userinfo = connectionString.split('@')[0] || '';
  return /(?:^|[/:])wolfhouse_admin(?:[:@]|$)/i.test(userinfo) === true;
}

function isTrustedWorkFailure(err) {
  try {
    if (!err || (typeof err !== 'object' && typeof err !== 'function')) return false;
    if (err.code === ERROR_CODE) return true;
    if (err.code === PROVER_ERROR_CODE) return true;
    if (objectGetPrototypeOf(err) !== Object.prototype) return false;
    if (!Object.isFrozen(err)) return false;
    if (ownData(err, 'ok') !== false) return false;
    return typeof ownData(err, 'error') === 'string';
  } catch (_) {
    return false;
  }
}

async function withSunsetStagingLiveTargetConnectedPgClient(input) {
  try {
    if (!exactPlainData(input, CONNECTED_PG_KEYS)) throw failure('with_pg');
    const Client = ownData(input, 'Client');
    const connectionString = ownData(input, 'connectionString');
    const work = ownData(input, 'work');
    if (typeof Client !== 'function' || isProxySurface(Client)) throw failure('pg_module');
    if (typeof connectionString !== 'string' || connectionString.length < 1) {
      throw failure('worker_dsn_missing');
    }
    if (typeof work !== 'function' || isProxySurface(work)) throw failure('with_pg');
    if (looksLikeAdminStaffApiDsn(connectionString)) throw failure('admin_dsn_refused');
    const client = new Client(objectFreeze({ connectionString }));
    try {
      try {
        await client.connect();
      } catch (_) {
        throw failure('pg_connect');
      }
      try {
        return await work(client);
      } catch (err) {
        if (isTrustedWorkFailure(err)) throw err;
        throw failure('pg_work');
      }
    } finally {
      try { await client.end(); } catch (_) { /* sanitized */ }
    }
  } catch (err) {
    if (err && err.code === ERROR_CODE) throw err;
    if (isTrustedWorkFailure(err)) throw err;
    throw failure('with_pg');
  }
}

function composeSunsetStagingLiveDownscopeProverDependenciesBody(input) {
  try {
    if (!exactPlainData(input, LIVE_FACTORY_KEYS)) throw failure('factory_keys');
    const env = ownData(input, 'env');
    if (!env || typeof env !== 'object' || isProxySurface(env) || arrayIsArray(env)) {
      throw failure('env');
    }
    if (envString(env, 'LUNA_DEPLOYMENT') !== SUNSET_DEPLOYMENT) throw failure('deployment');
    if (envString(env, 'DEFAULT_CLIENT_SLUG') !== SUNSET_TENANT) throw failure('tenant');
    if (!flagsAllLiteralFalse(env)) throw failure('flags');
    if (envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT') !== '1') {
      throw failure('replica');
    }
    if (envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY') !== SUNSET_LOCATION_KEY) {
      throw failure('location');
    }
    if (envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER') !== 'microsoft_graph') {
      throw failure('provider');
    }
    const applicationClientId = envString(env, 'LUNA_EMAIL_OAUTH_CLIENT_ID');
    if (!isCanonUuid(applicationClientId)) throw failure('application_client');
    const clientId = envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_CLIENT_ID');
    const locationId = envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_ID');
    const endpointId = envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_ENDPOINT_ID');
    const mailboxId = envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID');
    if (!isCanonUuid(clientId) || !isCanonUuid(locationId) || !isCanonUuid(endpointId) || !isCanonUuid(mailboxId)) {
      throw failure('binding');
    }
    if (typeof envString(env, ENV_PRODUCER_DATABASE_URL) !== 'string') throw failure('producer_dsn_missing');
    const workerDsn = envString(env, LIVE_CUSTODY_DSN_ENV_KEY);
    if (typeof workerDsn !== 'string') throw failure('worker_dsn_missing');
    const adminDsn = envString(env, LIVE_CUSTODY_REFUSES_ADMIN_DSN_ENV_KEY);
    if (typeof adminDsn !== 'string') throw failure('app_dsn_missing');
    if (adminDsn === workerDsn) throw failure('admin_dsn_alias');
    if (envString(env, 'EMAIL_GRANT_ENVELOPE_AZURE_KV_SUNSET_STAGING_RUNTIME_ACTIVATION_ENABLED') !== 'true') {
      throw failure('kv_activation');
    }
    if (envString(env, 'EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED') !== 'true') {
      throw failure('kv_composition');
    }
    if (envString(env, 'EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST') !== SUNSET_STAGING_TRUSTED_HOST) {
      throw failure('kv_host');
    }
    if (envString(env, 'EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID') !== SUNSET_STAGING_VERSIONED_KEY_ID) {
      throw failure('kv_key');
    }
    const owners = proveCanonicalRuntimeOwnersMatchDeployedContract();
    if (!owners.ok) throw failure('canonical_owners');

    const httpsPinned = freezeBoundBag(nodeHttps, ['request']);
    const cryptoPinned = freezeBoundBag(nodeCrypto, ['createPublicKey', 'verify']);
    const timersPinned = freezeBoundBag(nodeTimers, ['setTimeout', 'clearTimeout']);
    if (!httpsPinned || !cryptoPinned || !timersPinned) throw failure('node_owners');

    const kv = createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(env);
    const validated = kv && validateEmailGrantEnvelopeProvider(kv.provider);
    if (!kv || kv.ok !== true || !validated || validated.ok !== true) throw failure('kv');

    const transport = createMicrosoftTokenHttpTransport(objectFreeze({
      httpsImpl: ownData(httpsPinned, 'request'),
      timers: timersPinned,
    }));
    if (!transport || typeof ownData(transport, 'postTokenForm') !== 'function') throw failure('transport');
    CANONICAL_LIVE_MICROSOFT_TRANSPORTS.add(transport);

    function createSignatureVerifier() {
      const verifier = createMicrosoftOidcJwksSignatureVerifier(objectFreeze({
        https: httpsPinned,
        crypto: cryptoPinned,
        timers: timersPinned,
      }));
      if (!isCanonicalMicrosoftOidcJwksSignatureVerifier(verifier)) throw failure('jwks');
      return verifier;
    }
    CANONICAL_LIVE_JWKS_FACTORIES.add(createSignatureVerifier);

    const loginPair = createEmailLunaControlledDraftingPrincipalConnectionPair(objectFreeze({
      env,
      appConnectionString: adminDsn,
    }));
    if (!isAuthenticEmailLunaControlledDraftingPrincipalConnectionPair(loginPair)) {
      throw failure('login_pair');
    }

    const producerHandle = ownData(loginPair, 'producer');
    const workerHandle = ownData(loginPair, 'worker');
    if (!producerHandle || !workerHandle || producerHandle === workerHandle) throw failure('login_clients');
    if (typeof ownData(producerHandle, 'withTransactionClient') !== 'function') throw failure('login_clients');
    if (typeof ownData(workerHandle, 'withTransactionClient') !== 'function') throw failure('login_clients');

    function asQueryClient(handle) {
      async function query(text, params) {
        return ownData(handle, 'withTransactionClient')((client) => client.query(text, params));
      }
      return { query };
    }

    async function withPgClient(work) {
      if (typeof work !== 'function' || isProxySurface(work)) throw failure('with_pg');
      let pg;
      try {
        pg = require('pg');
      } catch (_) {
        throw failure('pg_module');
      }
      const Client = pg && pg.Client;
      if (typeof Client !== 'function') throw failure('pg_module');
      return withSunsetStagingLiveTargetConnectedPgClient(objectFreeze({
        Client,
        connectionString: workerDsn,
        work,
      }));
    }

    return objectFreeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: applicationClientId.toLowerCase(),
      withPgClient,
      envelopeProvider: validated.value,
      createSecretProvider: () => createSunsetMicrosoftOAuthClientSecretProvider(objectFreeze({
        deployment: SUNSET_DEPLOYMENT,
        env,
      })),
      transport,
      createSignatureVerifier,
      binding: objectFreeze({
        clientId: clientId.toLowerCase(),
        locationId: locationId.toLowerCase(),
        endpointId: endpointId.toLowerCase(),
        mailboxId: mailboxId.toLowerCase(),
      }),
      workerId: WORKER_ID_DEFAULT,
      login: objectFreeze({
        producerClient: asQueryClient(producerHandle),
        workerClient: asQueryClient(workerHandle),
      }),
      preflight: objectFreeze({}),
    });
  } catch (err) {
    if (err && err.code === ERROR_CODE) throw err;
    throw failure('compose');
  }
}

function composeSunsetStagingLiveDownscopeProverDependencies(input) {
  refuseLiveExecuteIfDisabled();
  return composeSunsetStagingLiveDownscopeProverDependenciesBody(input);
}

function composeSunsetStagingLiveDownscopeProverDependenciesOnceWithChapter4ICapability(capability, input) {
  if (arguments.length !== 2) throw failure('caller_input_refused');
  const consume = chapter4IAuthority.consumeComposeCapability;
  if (typeof consume !== 'function') throw failure('live_execute_not_authorized_in_this_chapter');
  const bound = consume(capability);
  if (!bound || typeof bound !== 'object') throw failure('live_execute_not_authorized_in_this_chapter');
  const deps = composeSunsetStagingLiveDownscopeProverDependenciesBody(input);
  const composedBinding = ownData(deps, 'binding');
  if (!composedBinding
      || ownData(composedBinding, 'clientId') !== ownData(bound, 'client_id')
      || ownData(composedBinding, 'locationId') !== ownData(bound, 'location_id')
      || ownData(composedBinding, 'endpointId') !== ownData(bound, 'endpoint_id')
      || ownData(composedBinding, 'mailboxId') !== ownData(bound, 'mailbox_id')) {
    throw failure('binding');
  }
  if (ownData(deps, 'deployment') !== SUNSET_DEPLOYMENT) throw failure('deployment');
  return deps;
}

function measureLiveOwners(deps) {
  try {
    if (!deps || typeof deps !== 'object') {
      return objectFreeze({
        microsoft_live: false,
        jwks_live: false,
        canonical_live_microsoft_transport_composed: false,
        canonical_live_jwks_factory_composed: false,
        provider_invoked: false,
        signature_verified: false,
      });
    }
    const transport = ownData(deps, 'transport');
    const createSignatureVerifier = ownData(deps, 'createSignatureVerifier');
    return objectFreeze({
      microsoft_live: false,
      jwks_live: false,
      canonical_live_microsoft_transport_composed: isCanonicalLiveMicrosoftTransport(transport) === true,
      canonical_live_jwks_factory_composed: isCanonicalLiveJwksFactory(createSignatureVerifier) === true,
      provider_invoked: false,
      signature_verified: false,
    });
  } catch (_) {
    return objectFreeze({
      microsoft_live: false,
      jwks_live: false,
      canonical_live_microsoft_transport_composed: false,
      canonical_live_jwks_factory_composed: false,
      provider_invoked: false,
      signature_verified: false,
    });
  }
}

const publicTarget = {
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  SUNSET_LOCATION_KEY,
  EXPECTED_DATABASE,
  EXPECTED_LIVE_TARGET,
  OPERATOR_PROVER_COMPATIBILITY_RULE,
  CANONICAL_RUNTIME_OWNER_DIGESTS,
  EIGHT_FLAGS,
  LIVE_FACTORY_KEYS,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  LIVE_CUSTODY_DSN_ENV_KEY,
  LIVE_CUSTODY_REFUSES_ADMIN_DSN_ENV_KEY,
  evaluateSunsetStagingLiveAppSnapshot,
  proveCanonicalRuntimeOwnersMatchDeployedContract,
  isIndependentLivePreflight,
  readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg,
  isCanonicalLiveMicrosoftTransport,
  isCanonicalLiveJwksFactory,
  composeSunsetStagingLiveDownscopeProverDependencies,
  withSunsetStagingLiveTargetConnectedPgClient,
  measureLiveOwners,
};
Object.defineProperty(
  publicTarget,
  'composeSunsetStagingLiveDownscopeProverDependenciesOnceWithChapter4ICapability',
  {
    value: composeSunsetStagingLiveDownscopeProverDependenciesOnceWithChapter4ICapability,
    enumerable: false,
    writable: false,
    configurable: false,
  },
);
module.exports = objectFreeze(publicTarget);
