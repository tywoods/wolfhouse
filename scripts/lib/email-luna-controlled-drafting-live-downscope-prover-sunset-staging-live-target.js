'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4G — fixed internal
 * Sunset-staging live-target contract for the Chapter 4E operator prover.
 *
 * Import-inert. Does not call Azure/KV/live PG/Microsoft/JWKS on load.
 * Composition uses existing canonical owners only. No public generic
 * callback, token consumer, HTTP route, Graph provider, or send method.
 *
 * Live proof remains NOT EXECUTED by this chapter. A later separately
 * authorized execution chapter may invoke compose after --execute-once.
 *
 * @module email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target
 */

const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const nodeHttps = require('node:https');
const nodeTimers = require('node:timers');
const {
  isProxySurface,
  ownData,
  exactOwnData,
  isCanonUuid,
  digestUtf8,
} = require('./email-luna-controlled-drafting-closed-data');
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

const objectFreeze = Object.freeze;
const objectCreate = Object.create;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_TARGET_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting live-target wiring failed.';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const SUNSET_TENANT = 'sunset';
const SUNSET_LOCATION_KEY = 'sunset-somo';
const EXPECTED_DATABASE = 'sunset_staging';
const WORKER_ID_DEFAULT = 'email-luna-controlled-drafting-live-downscope-prover';
const LIVE_FACTORY_KEYS = objectFreeze(['env']);
const INDEPENDENT_LIVE_PREFLIGHTS = new WeakSet();
const CANONICAL_LIVE_MICROSOFT_TRANSPORTS = new WeakSet();
const CANONICAL_LIVE_JWKS_FACTORIES = new WeakSet();

const EXPECTED_LIVE_TARGET = objectFreeze({
  resourceGroup: 'luna-sunset-staging-rg',
  appName: 'luna-sunset-staging-staff-api',
  revision: 'luna-sunset-staging-staff-api--ch4f-f6ee5112',
  deployedSha: 'f6ee511273160cb46c72e345137800878d4c6512',
  digest: 'sha256:20d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a',
  tenant: SUNSET_TENANT,
  locationKey: SUNSET_LOCATION_KEY,
  database: EXPECTED_DATABASE,
  replica: 1,
});

const OPERATOR_PROVER_COMPATIBILITY_RULE = objectFreeze({
  rule_id: 'chapter_4g_operator_cli_may_differ_from_deployed_app_sha',
  deployedSha: EXPECTED_LIVE_TARGET.deployedSha,
  chapter4ePr: 719,
  allowsOperatorCliSourceShaToDiffer: true,
  requiresCanonicalRuntimeOwnerByteMatch: true,
  doesNotTrustCallerText: true,
  liveTargetIsDeployedStaffApiImage: true,
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

const CANONICAL_RUNTIME_OWNER_DIGESTS = objectFreeze({
  'email-delegated-grant-custodian.js':
    '28cbcd5773e8135bf42b22acd4cf11d42365ead02b873b370d93018f2d355f5d',
  'email-delegated-grant-access-session.js':
    '9a40122bdedd085e10bdc24b1fa4dc4c77b34a0b68b76dc346ea35f822155757',
  'email-microsoft-refresh-token-request.js':
    'a5ea40a96d2af0b383e17051a98b594ecf100736be32fa56a216775c403c3006',
  'email-microsoft-refresh-token-response-by-scope-version.js':
    'c3f273658c385810930c93b009d4de67f8de63a1d73f21c48d4fdf387de719f2',
  'email-microsoft-oidc-jwks-verifier.js':
    'a2806088c9101d43892612642a40c739e83282b61b1cb883de88ce740793297e',
  'email-microsoft-token-http-transport.js':
    '8b560823cbb31831d17a5081811cafd90e7a355f09154ec3c93486d03196779b',
  'email-luna-controlled-drafting-access-token-claims.js':
    'a392674851e6fdbbcb040dea3eae7786b8d25f7d8b999ecfed32d25b31a8e74a',
  'email-luna-controlled-drafting-session-proof.js':
    'f570713c80ece2c6eb460a2cf323dae6d08c4c2dfe3daab7980731c41eb14909',
  'email-luna-controlled-drafting-principal-connection.js':
    '68e4ee1c4c64946e95fde043cfd9d133e7562bc4318270354214ec3677467196',
  'email-luna-controlled-drafting-token-loan.js':
    '19189b827be30b8eb89ec02efb505876fb15ca00ede79de4c6aa37cf9405dd8a',
  'email-grant-envelope-azure-kv-sunset-staging-runtime-composition.js':
    'd27363f44252567d8916deb1cab9020c498067111f0be81e41f5f8878951ebc9',
  'sunset-microsoft-oauth-provider.js':
    'e6e96d57e10cc6bdcc7e7725a78eeefc862ed79841a96de7888a882a113b0054',
  'email-microsoft-delegated-oauth-contract.js':
    '3ca32b447033692908b265eebd324040db6ffe54bee80bfc563857679550d986',
  'email-grant-envelope-provider-contract.js':
    '352f7564a37c3a8501063e1ae71f2c31abac4d40e93997ec771322d109481038',
  'email-luna-controlled-drafting-closed-data.js':
    '0e95f5187da38fc1a31e5e3f9eb170ef7d75ea317bb7062a396cbe8431ecaa04',
});

if (SECRET_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('controlled_drafting_live_target_sunset_deployment_mismatch');
}

function failure(code) {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  if (typeof code === 'string') error.detail = code;
  objectFreeze(error);
  return error;
}

function refuse() {
  return objectFreeze({ ok: false, reason: 'live_target_refused' });
}

function sha256File(abs) {
  const hasher = nodeCrypto.createHash('sha256');
  hasher.update(fs.readFileSync(abs));
  return hasher.digest('hex');
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

function proveCanonicalRuntimeOwnersMatchDeployedContract() {
  const files = Object.keys(CANONICAL_RUNTIME_OWNER_DIGESTS);
  const mismatches = [];
  for (let i = 0; i < files.length; i += 1) {
    const rel = files[i];
    const abs = path.join(__dirname, rel);
    let digest;
    try {
      digest = sha256File(abs);
    } catch (_) {
      return objectFreeze({ ok: false, matched: false, file_count: files.length, mismatches: objectFreeze([rel]) });
    }
    if (digest !== CANONICAL_RUNTIME_OWNER_DIGESTS[rel]) mismatches.push(rel);
  }
  return objectFreeze({
    ok: mismatches.length === 0,
    matched: mismatches.length === 0,
    file_count: files.length,
    deployed_sha: EXPECTED_LIVE_TARGET.deployedSha,
    rule_id: OPERATOR_PROVER_COMPATIBILITY_RULE.rule_id,
    mismatches: objectFreeze(mismatches),
  });
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
    const branded = objectFreeze({
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
      ops_097: 0,
      transitions_097: 0,
      authorizations_098: 0,
      binding_ok: true,
      own_user: true,
      mailbox_ready: true,
      grant_status: 'active',
      reconcile_state: 'clean',
      has_active_lease: false,
      has_active_operation: false,
      independent_read: true,
      compatibility_rule_id: OPERATOR_PROVER_COMPATIBILITY_RULE.rule_id,
      canonical_owners_matched: true,
    });
    INDEPENDENT_LIVE_PREFLIGHTS.add(branded);
    return branded;
  } catch (_) {
    return refuse();
  }
}

function isIndependentLivePreflight(value) {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    return INDEPENDENT_LIVE_PREFLIGHTS.has(value) && value.ok === true;
  } catch (_) {
    return false;
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

function composeSunsetStagingLiveDownscopeProverDependencies(input) {
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
    if (typeof envString(env, ENV_WORKER_DATABASE_URL) !== 'string') throw failure('worker_dsn_missing');
    if (typeof envString(env, 'WOLFHOUSE_DATABASE_URL') !== 'string') throw failure('app_dsn_missing');
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
      appConnectionString: envString(env, 'WOLFHOUSE_DATABASE_URL'),
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
      const client = new Client({
        connectionString: envString(env, 'WOLFHOUSE_DATABASE_URL'),
      });
      try {
        await client.connect();
        return await work(client);
      } catch (err) {
        if (err && err.code === ERROR_CODE) throw err;
        throw failure('pg_connect');
      } finally {
        try { await client.end(); } catch (_) { /* sanitized */ }
      }
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

function measureLiveOwners(deps) {
  try {
    if (!deps || typeof deps !== 'object') {
      return objectFreeze({ microsoft_live: false, jwks_live: false });
    }
    const transport = ownData(deps, 'transport');
    const createSignatureVerifier = ownData(deps, 'createSignatureVerifier');
    return objectFreeze({
      microsoft_live: isCanonicalLiveMicrosoftTransport(transport) === true,
      jwks_live: isCanonicalLiveJwksFactory(createSignatureVerifier) === true,
    });
  } catch (_) {
    return objectFreeze({ microsoft_live: false, jwks_live: false });
  }
}

module.exports = objectFreeze({
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
  evaluateSunsetStagingLiveAppSnapshot,
  proveCanonicalRuntimeOwnersMatchDeployedContract,
  isIndependentLivePreflight,
  isCanonicalLiveMicrosoftTransport,
  isCanonicalLiveJwksFactory,
  composeSunsetStagingLiveDownscopeProverDependencies,
  measureLiveOwners,
});
