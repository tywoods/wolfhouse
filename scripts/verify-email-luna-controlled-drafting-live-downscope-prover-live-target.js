'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4G.
 * Source/offline live-target wiring verifier. Does not execute live proof.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createEmailLunaControlledDraftingLiveDownscopeProver,
  readTrustedLiveDownscopeProverFailure,
  parseArgs,
  runCli,
  liveModeAllowed,
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  LIVE_DEPLOY_SHA_ALLOWLIST,
  CONFIRMATION_PHRASE,
  EIGHT_FLAGS,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
} = require('./lib/email-luna-controlled-drafting-live-downscope-prover');
const {
  EXPECTED_LIVE_TARGET,
  CANONICAL_RUNTIME_OWNER_DIGESTS,
  evaluateSunsetStagingLiveAppSnapshot,
  proveCanonicalRuntimeOwnersMatchDeployedContract,
  isIndependentLivePreflight,
  isCanonicalLiveMicrosoftTransport,
  composeSunsetStagingLiveDownscopeProverDependencies,
  OPERATOR_PROVER_COMPATIBILITY_RULE,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER: LIVE_TARGET_EXECUTE_AUTHORIZED,
  LIVE_CUSTODY_DSN_ENV_KEY,
  LIVE_CUSTODY_REFUSES_ADMIN_DSN_ENV_KEY,
  withSunsetStagingLiveTargetConnectedPgClient,
  ERROR_CODE: LIVE_TARGET_ERROR_CODE,
  measureLiveOwners,
} = require('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target');
const {
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER: CONSTANTS_EXECUTE_AUTHORIZED,
  EXPECTED_LIVE_TARGET: CONSTANTS_LIVE_TARGET,
  LIVE_CUSTODY_DSN_ENV_KEY: CONSTANTS_WORKER_DSN_KEY,
} = require('./lib/email-luna-controlled-drafting-live-downscope-prover-live-target-constants');
const {
  createFakeEmailGrantEnvelopeProvider,
  fakeSealRefreshToken,
} = require('./lib/email-grant-envelope-fake-provider');
const {
  SUNSET_STAGING_TRUSTED_HOST,
  SUNSET_STAGING_VERSIONED_KEY_ID,
} = require('./lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const {
  ENV_PRODUCER_DATABASE_URL,
  ENV_WORKER_DATABASE_URL,
} = require('./lib/email-luna-controlled-drafting-principal-connection');

const ROOT = path.join(__dirname, '..');
const DEPLOYED_SHA = EXPECTED_LIVE_TARGET.deployedSha;
const REVISION = EXPECTED_LIVE_TARGET.revision;
const DIGEST = EXPECTED_LIVE_TARGET.digest;
const MEASURED_REVISION = 'luna-sunset-staging-staff-api--0000682';
const MEASURED_SHA = 'a4188eea71a92b7361818e024cde0f810d6ee018';
const MEASURED_DIGEST = 'sha256:820f302e8f59cfe8636eb0267c6f15bc0750f300b76735f511f3dde9c031dc39';
const HISTORICAL_CH4F_REVISION = 'luna-sunset-staging-staff-api--ch4f-f6ee5112';
const HISTORICAL_CH4F_SHA = 'f6ee511273160cb46c72e345137800878d4c6512';
const HISTORICAL_CH4F_DIGEST = 'sha256:20d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a';
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENDPOINT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MAILBOX = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APP_ID = '12345678-1234-4234-8234-123456789abc';
const SECRET = 'app-secret-NEVER_LEAK';
const PLANTED = 'planted-NEVER_LEAK-secret';
const WORKER_DSN = 'postgres://luna_cd_worker:worker-NEVER_LEAK@127.0.0.1/sunset_staging';
const ADMIN_DSN = 'postgres://wolfhouse_admin:admin-NEVER_LEAK@127.0.0.1/sunset_staging';
const PRODUCER_DSN = 'postgres://luna_cd_producer:producer-NEVER_LEAK@127.0.0.1/sunset_staging';
const LIVE_TARGET_SUFFIX = 'email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target.js';
const CHAPTER_DISABLED = 'live_execute_not_authorized_in_this_chapter';

function childEnv(patch = {}) {
  const extra = '/opt/data/calendar-inventory-bridge-bf/node_modules';
  const nodePath = [extra, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  return Object.assign({}, process.env, { NODE_PATH: nodePath }, patch);
}

function disabledEnv(patch = {}) {
  return Object.assign({
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'sunset',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED: 'false',
    LUNA_AUTO_SEND_ENABLED: 'false',
    CUSTOMER_OUTREACH_WHATSAPP_ENABLED: 'false',
    STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT: '1',
  }, patch);
}

function eightFlagEnv(values) {
  const env = {};
  for (let i = 0; i < EIGHT_FLAGS.length; i += 1) {
    env[EIGHT_FLAGS[i]] = values[i];
  }
  return env;
}

function completeSnapshot(patch = {}) {
  return Object.assign({
    resourceGroup: 'luna-sunset-staging-rg',
    appName: 'luna-sunset-staging-staff-api',
    revision: REVISION,
    imageSha: DEPLOYED_SHA,
    digest: DIGEST,
    runningStatus: 'Running',
    latestReadyRevisionName: REVISION,
    trafficWeight: 100,
    latestRevisionTraffic: true,
    replica: 1,
    minReplicas: 1,
    maxReplicas: 1,
    tenant: 'sunset',
    locationKey: 'sunset-somo',
    database: 'sunset_staging',
    flags: eightFlagEnv([
      'false', 'false', 'false', 'false', 'false', 'false', 'false', 'false',
    ]),
    ops097: 0,
    transitions097: 0,
    authorizations098: 0,
    bindingOk: true,
    ownUser: true,
    mailboxReady: true,
    grantStatus: 'active',
    reconcileState: 'clean',
    hasActiveLease: false,
    hasActiveOperation: false,
  }, patch);
}

function completeValidLiveEnv(patch = {}) {
  return Object.assign({
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'sunset',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED: 'false',
    LUNA_AUTO_SEND_ENABLED: 'false',
    CUSTOMER_OUTREACH_WHATSAPP_ENABLED: 'false',
    STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT: '1',
    EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY: 'sunset-somo',
    EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER: 'microsoft_graph',
    LUNA_EMAIL_OAUTH_CLIENT_ID: APP_ID,
    EMAIL_LUNA_CONTROLLED_DRAFTING_CLIENT_ID: CLIENT,
    EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_ID: LOCATION,
    EMAIL_LUNA_CONTROLLED_DRAFTING_ENDPOINT_ID: ENDPOINT,
    EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID: MAILBOX,
    [ENV_PRODUCER_DATABASE_URL]: PRODUCER_DSN,
    [ENV_WORKER_DATABASE_URL]: WORKER_DSN,
    WOLFHOUSE_DATABASE_URL: ADMIN_DSN,
    EMAIL_GRANT_ENVELOPE_AZURE_KV_SUNSET_STAGING_RUNTIME_ACTIVATION_ENABLED: 'true',
    EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED: 'true',
    EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST: SUNSET_STAGING_TRUSTED_HOST,
    EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID: SUNSET_STAGING_VERSIONED_KEY_ID,
  }, patch);
}

function noLeak(value) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch (_) {
    return false;
  }
  return !text.includes('NEVER_LEAK')
    && !text.includes(SECRET)
    && !text.includes(PLANTED)
    && !text.includes('eyJ')
    && !text.includes('postgres://');
}

function frozenMethod(name, fn) { return Object.freeze({ [name]: fn }); }

function fakeLoginClient(hits) {
  return {
    async query() {
      if (hits) hits.login += 1;
      return { rows: [], rowCount: 0 };
    },
  };
}

async function makeOfflineProver(hits) {
  const envelope = createFakeEmailGrantEnvelopeProvider();
  const sealed = await fakeSealRefreshToken(envelope, {
    refreshToken: 'rt-old-NEVER_LEAK',
    clientId: CLIENT,
    endpointId: ENDPOINT,
    grantGeneration: 1,
    operationId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(Boolean(sealed), true);
  let pgHits = 0;
  return createEmailLunaControlledDraftingLiveDownscopeProver({
    deployment: SUNSET_DEPLOYMENT,
    applicationClientId: APP_ID,
    withPgClient: async (work) => {
      pgHits += 1;
      if (hits) hits.pg += 1;
      return work({ async query() { return { rows: [], rowCount: 0 }; } });
    },
    envelopeProvider: envelope,
    createSecretProvider: () => frozenMethod('getClientSecret', async () => SECRET),
    transport: frozenMethod('postTokenForm', async () => {
      if (hits) hits.token += 1;
      throw new Error('token_owner_must_not_be_called');
    }),
    createSignatureVerifier: () => Object.freeze({
      async verify() {
        if (hits) hits.jwks += 1;
        throw new Error('jwks_owner_must_not_be_called');
      },
    }),
    binding: {
      clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT, mailboxId: MAILBOX,
    },
    workerId: 'email-luna-controlled-drafting-live-downscope-prover',
    login: { producerClient: fakeLoginClient(hits), workerClient: fakeLoginClient(hits) },
    preflight: {
      ops097: 0, rows098: 0, replica: 1, sourceSha: 'b'.repeat(40), deploySha: DEPLOYED_SHA,
    },
  });
}

function completeLiveParse(extra = []) {
  return parseArgs([
    'prove', '--target', 'sunset-staging', '--deploy-sha', DEPLOYED_SHA,
    '--revision', REVISION, '--digest', DIGEST,
    '--confirm', CONFIRMATION_PHRASE,
    '--operator-nonce', 'ab'.repeat(32),
    '--confirm-issued-at', new Date().toISOString(),
    ...extra,
  ]);
}

function assertChapterDisabled(error) {
  const note = readTrustedLiveDownscopeProverFailure(error);
  return error
    && error.code === ERROR_CODE
    && note
    && note.code === CHAPTER_DISABLED
    && noLeak(error);
}

function assertComposeChapterDisabled(err) {
  return err
    && err.code === LIVE_TARGET_ERROR_CODE
    && err.detail === CHAPTER_DISABLED
    && noLeak(err);
}

function makeFakeClient({ connectError, workHook } = {}) {
  const calls = {
    constructed: 0,
    connect: 0,
    end: 0,
    connectionString: null,
  };
  function FakeClient(config) {
    calls.constructed += 1;
    calls.connectionString = config && config.connectionString;
    this.connect = async () => {
      calls.connect += 1;
      if (connectError) throw connectError;
    };
    this.end = async () => {
      calls.end += 1;
    };
    this.query = async () => ({ rows: [], rowCount: 0 });
    if (typeof workHook === 'function') workHook(this, calls);
  }
  return { FakeClient, calls };
}

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4G live-target wiring verifier');
  console.log('Live proof is NOT EXECUTED. Local fake/PGlite/stock-PG only.');

  const liveSrc = fs.readFileSync(
    require.resolve('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target'),
    'utf8',
  );
  const proverSrc = fs.readFileSync(
    require.resolve('./lib/email-luna-controlled-drafting-live-downscope-prover'),
    'utf8',
  );
  const constantsSrc = fs.readFileSync(
    require.resolve('./lib/email-luna-controlled-drafting-live-downscope-prover-live-target-constants'),
    'utf8',
  );
  const cliSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/email-luna-controlled-drafting-live-downscope-prover.js'),
    'utf8',
  );

  assert.equal(LIVE_DEPLOY_SHA_ALLOWLIST.length, 1);
  assert.equal(LIVE_DEPLOY_SHA_ALLOWLIST[0], DEPLOYED_SHA);
  assert.equal(Object.isFrozen(LIVE_DEPLOY_SHA_ALLOWLIST), true);
  assert.equal(EXPECTED_LIVE_TARGET.deployedSha, MEASURED_SHA);
  assert.equal(EXPECTED_LIVE_TARGET.revision, MEASURED_REVISION);
  assert.equal(EXPECTED_LIVE_TARGET.digest, MEASURED_DIGEST);
  assert.notEqual(EXPECTED_LIVE_TARGET.deployedSha, HISTORICAL_CH4F_SHA);
  assert.notEqual(EXPECTED_LIVE_TARGET.revision, HISTORICAL_CH4F_REVISION);
  assert.notEqual(EXPECTED_LIVE_TARGET.digest, HISTORICAL_CH4F_DIGEST);
  assert.equal(EXPECTED_LIVE_TARGET.deployedSha, DEPLOYED_SHA);
  assert.equal(EXPECTED_LIVE_TARGET.revision, REVISION);
  assert.equal(EXPECTED_LIVE_TARGET.digest, DIGEST);
  assert.equal(EXPECTED_LIVE_TARGET.resourceGroup, 'luna-sunset-staging-rg');
  assert.equal(EXPECTED_LIVE_TARGET.appName, 'luna-sunset-staging-staff-api');
  assert.equal(CONSTANTS_LIVE_TARGET.deployedSha, EXPECTED_LIVE_TARGET.deployedSha);
  assert.equal(CONSTANTS_LIVE_TARGET.revision, EXPECTED_LIVE_TARGET.revision);
  assert.equal(CONSTANTS_LIVE_TARGET.digest, EXPECTED_LIVE_TARGET.digest);
  assert.equal(OPERATOR_PROVER_COMPATIBILITY_RULE.deployedSha, DEPLOYED_SHA);
  assert.equal(OPERATOR_PROVER_COMPATIBILITY_RULE.allowsOperatorCliSourceShaToDiffer, true);
  assert.equal(OPERATOR_PROVER_COMPATIBILITY_RULE.sourceTreeSelfAttestation, true);
  assert.equal(OPERATOR_PROVER_COMPATIBILITY_RULE.independentImageMeasurement, false);
  assert.equal(OPERATOR_PROVER_COMPATIBILITY_RULE.cannotEstablishDeployedImageTruth, true);
  assert.equal(liveModeAllowed(DEPLOYED_SHA), true);
  assert.equal(liveModeAllowed(MEASURED_SHA), true);
  assert.equal(liveModeAllowed(HISTORICAL_CH4F_SHA), false);
  assert.equal(liveModeAllowed(DEPLOYED_SHA.slice(0, 12)), false);
  console.log('  PASS  immutable singleton deployed-SHA allowlist from one constants owner');

  assert.equal(LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER, false);
  assert.equal(LIVE_TARGET_EXECUTE_AUTHORIZED, false);
  assert.equal(CONSTANTS_EXECUTE_AUTHORIZED, false);
  assert.equal(Object.isFrozen(require('./lib/email-luna-controlled-drafting-live-downscope-prover')), true);
  assert.equal(Object.isFrozen(require('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target')), true);
  assert.equal(Object.isFrozen(require('./lib/email-luna-controlled-drafting-live-downscope-prover-live-target-constants')), true);
  assert.throws(() => {
    const owner = require('./lib/email-luna-controlled-drafting-live-downscope-prover');
    owner.LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER = true;
  });
  assert.equal(require('./lib/email-luna-controlled-drafting-live-downscope-prover')
    .LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER, false);
  assert.equal(LIVE_CUSTODY_DSN_ENV_KEY, ENV_WORKER_DATABASE_URL);
  assert.equal(CONSTANTS_WORKER_DSN_KEY, ENV_WORKER_DATABASE_URL);
  assert.equal(LIVE_CUSTODY_REFUSES_ADMIN_DSN_ENV_KEY, 'WOLFHOUSE_DATABASE_URL');
  console.log('  PASS  frozen chapter live-execute authority is false and unassignable');

  const owners = proveCanonicalRuntimeOwnersMatchDeployedContract();
  assert.equal(owners.ok, true);
  assert.equal(owners.file_count, Object.keys(CANONICAL_RUNTIME_OWNER_DIGESTS).length);
  assert.equal(owners.matched, true);
  assert.equal(owners.independent_image_measurement, false);
  assert.equal(owners.cannot_establish_deployed_image_truth, true);
  assert.equal(owners.attestation_kind, 'source_tree_self_hash');
  assert.match(constantsSrc, /sourceTreeSelfAttestation: true/);
  assert.doesNotMatch(liveSrc, /independent image measurement/i);
  console.log('  PASS  canonical 4C/4E runtime owners are source-tree self-attestation, not image measurement');

  const good = evaluateSunsetStagingLiveAppSnapshot(completeSnapshot());
  assert.equal(good.ok, true);
  assert.equal(isIndependentLivePreflight(good), false);
  assert.equal(good.independent_read, false);
  assert.equal(good.untrusted_caller_snapshot, true);
  assert.equal(good.live_authority, false);
  assert.equal(Object.prototype.hasOwnProperty.call(good, 'ops_097'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(good, 'authorizations_098'), false);
  assert.equal(good.deploy_sha, DEPLOYED_SHA);
  assert.equal(noLeak(good), true);
  assert.equal(isIndependentLivePreflight({
    ok: true, ops_097: 0, transitions_097: 0, authorizations_098: 0, replica: 1, deploy_sha: DEPLOYED_SHA,
  }), false);
  const plantedCounts = evaluateSunsetStagingLiveAppSnapshot(completeSnapshot({
    ops097: 0, transitions097: 0, authorizations098: 0,
  }));
  assert.equal(isIndependentLivePreflight(plantedCounts), false);
  assert.equal(plantedCounts.independent_read, false);
  console.log('  PASS  M1 RED/GREEN: perfect caller snapshot cannot mint live/independent authority');

  const hostileCases = [
    completeSnapshot({ imageSha: DEPLOYED_SHA.slice(0, 8) }),
    completeSnapshot({ imageSha: DEPLOYED_SHA.toUpperCase() }),
    completeSnapshot({ imageSha: '0'.repeat(40) }),
    completeSnapshot({ digest: 'sha256:00d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a' }),
    completeSnapshot({ revision: 'luna-sunset-staging-staff-api--0000679' }),
    completeSnapshot({ revision: HISTORICAL_CH4F_REVISION }),
    completeSnapshot({ imageSha: HISTORICAL_CH4F_SHA }),
    completeSnapshot({ digest: HISTORICAL_CH4F_DIGEST }),
    completeSnapshot({ runningStatus: 'Failed' }),
    completeSnapshot({ latestReadyRevisionName: 'other' }),
    completeSnapshot({ trafficWeight: 99 }),
    completeSnapshot({ replica: 2 }),
    completeSnapshot({ minReplicas: 0 }),
    completeSnapshot({ ops097: 1 }),
    completeSnapshot({ transitions097: 1 }),
    completeSnapshot({ authorizations098: 1 }),
    completeSnapshot({ grantStatus: 'lease_held' }),
    completeSnapshot({ reconcileState: 'ms_response_uncertain' }),
    completeSnapshot({ hasActiveLease: true }),
    completeSnapshot({ hasActiveOperation: true }),
    completeSnapshot({ tenant: 'wolfhouse' }),
    completeSnapshot({ database: 'wolfhouse_staging' }),
    completeSnapshot({ flags: eightFlagEnv(['false', 'false', 'false', 'false', 'false', 'false', 'false']) }),
    completeSnapshot({ flags: eightFlagEnv(['true', 'false', 'false', 'false', 'false', 'false', 'false', 'false']) }),
    completeSnapshot({ flags: eightFlagEnv([undefined, 'false', 'false', 'false', 'false', 'false', 'false', 'false']) }),
  ];
  for (let i = 0; i < hostileCases.length; i += 1) {
    const result = evaluateSunsetStagingLiveAppSnapshot(hostileCases[i]);
    assert.equal(result.ok, false, `hostile snapshot ${i} must fail`);
    assert.equal(isIndependentLivePreflight(result), false);
    assert.equal(result.independent_read !== true, true);
    assert.equal(noLeak(result), true);
  }
  const unsetFlags = completeSnapshot();
  unsetFlags.flags = eightFlagEnv(['false', 'false', 'false', 'false', 'false', 'false', 'false', 'false']);
  delete unsetFlags.flags.EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED;
  const unset = evaluateSunsetStagingLiveAppSnapshot(unsetFlags);
  assert.equal(unset.ok, false);
  console.log('  PASS  hostile/missing snapshot fields fail closed without branding');

  const getterSnap = completeSnapshot();
  Object.defineProperty(getterSnap, 'ops097', { get() { return 0; }, enumerable: true });
  assert.equal(evaluateSunsetStagingLiveAppSnapshot(getterSnap).ok, false);
  const proxySnap = new Proxy(completeSnapshot(), { get(t, k) { return t[k]; } });
  assert.equal(evaluateSunsetStagingLiveAppSnapshot(proxySnap).ok, false);
  const planted = completeSnapshot();
  planted.secret = PLANTED;
  assert.equal(evaluateSunsetStagingLiveAppSnapshot(planted).ok, false);
  console.log('  PASS  getter/proxy/extra-key snapshots fail closed');

  const cyclic = completeSnapshot();
  cyclic.self = cyclic;
  const cyclicResult = evaluateSunsetStagingLiveAppSnapshot(cyclic);
  assert.equal(cyclicResult.ok, false);
  assert.equal(noLeak(cyclicResult), true);

  {
    const hits = { login: 0, pg: 0, token: 0, jwks: 0 };
    const prover = await makeOfflineProver(hits);
    await assert.rejects(() => prover.runProof({
      parsed: completeLiveParse(),
      env: disabledEnv(),
      independentLivePreflight: {
        ok: true, ops_097: 0, transitions_097: 0, authorizations_098: 0,
        replica: 1, deploy_sha: DEPLOYED_SHA, independent_read: true,
      },
    }), (error) => assertChapterDisabled(error) && hits.login === 0 && hits.pg === 0
      && hits.token === 0 && hits.jwks === 0);
  }
  {
    const hits = { login: 0, pg: 0, token: 0, jwks: 0 };
    const prover = await makeOfflineProver(hits);
    await assert.rejects(() => prover.runProof({
      parsed: completeLiveParse(['--execute-once']),
      env: disabledEnv(),
      independentLivePreflight: good,
      liveExecuteAuthorized: true,
      executeOnce: true,
    }), (error) => assertChapterDisabled(error) && hits.login === 0 && hits.pg === 0);
  }
  console.log('  PASS  M1/M2: injected snapshot + executeOnce cannot create live authority; LOGIN never reached');

  {
    const prover = await makeOfflineProver();
    await assert.rejects(() => prover.runProof({
      parsed: parseArgs(['prove', '--target', 'sunset-staging', '--deploy-sha', DEPLOYED_SHA]),
      env: disabledEnv(),
      independentLivePreflight: good,
    }), (error) => {
      const note = readTrustedLiveDownscopeProverFailure(error);
      return error.code === ERROR_CODE && note && (
        note.stage === 'confirmation' || note.code === 'revision_mismatch'
          || note.code === 'digest_mismatch' || note.stage === 'args'
      );
    });
  }

  {
    const prover = await makeOfflineProver();
    const missingFlagEnv = disabledEnv();
    delete missingFlagEnv.EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED;
    await assert.rejects(() => prover.runProof({
      parsed: completeLiveParse(),
      env: missingFlagEnv,
      independentLivePreflight: good,
    }), (error) => {
      const note = readTrustedLiveDownscopeProverFailure(error);
      return note && note.stage === 'flags';
    });
  }
  console.log('  PASS  live flags unset fail; offline unset-as-false is not reused');

  {
    let getterHits = 0;
    const otherwiseValid = completeValidLiveEnv();
    Object.defineProperty(otherwiseValid, 'WOLFHOUSE_DATABASE_URL', {
      get() { getterHits += 1; return ADMIN_DSN; }, enumerable: true,
    });
    Object.defineProperty(otherwiseValid, ENV_WORKER_DATABASE_URL, {
      get() { getterHits += 1; return WORKER_DSN; }, enumerable: true,
    });
    Object.defineProperty(otherwiseValid, 'LUNA_EMAIL_OAUTH_CLIENT_SECRET', {
      get() { getterHits += 1; return SECRET; }, enumerable: true,
    });
    assert.throws(
      () => composeSunsetStagingLiveDownscopeProverDependencies({ env: otherwiseValid }),
      (err) => assertComposeChapterDisabled(err) && getterHits === 0,
    );
    assert.equal(getterHits, 0);
  }
  assert.throws(
    () => composeSunsetStagingLiveDownscopeProverDependencies({}),
    assertComposeChapterDisabled,
  );
  assert.throws(
    () => composeSunsetStagingLiveDownscopeProverDependencies({
      env: completeValidLiveEnv(),
      consumer: async (token) => token,
      liveExecuteAuthorized: true,
      executeOnce: true,
    }),
    assertComposeChapterDisabled,
  );
  assert.throws(
    () => composeSunsetStagingLiveDownscopeProverDependencies({
      env: completeValidLiveEnv({ LUNA_DEPLOYMENT: 'production' }),
    }),
    assertComposeChapterDisabled,
  );
  assert.equal(isCanonicalLiveMicrosoftTransport(frozenMethod('postTokenForm', async () => ({}))), false);
  const measuredFake = measureLiveOwners({
    transport: frozenMethod('postTokenForm', async () => ({})),
    createSignatureVerifier: () => ({}),
  });
  assert.equal(measuredFake.microsoft_live, false);
  assert.equal(measuredFake.jwks_live, false);
  assert.equal(measuredFake.canonical_live_microsoft_transport_composed === true, false);
  assert.equal(measuredFake.provider_invoked, false);
  assert.equal(measuredFake.signature_verified, false);
  console.log('  PASS  M2: public compose refuses chapter-disabled before env/getters; zero getter hits');

  const liveOwnerExports = require('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target');
  assert.equal(typeof liveOwnerExports.readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg, 'function');
  assert.equal(typeof liveOwnerExports.createOwnedSunsetStagingLivePreflightReader, 'undefined');
  assert.equal(typeof liveOwnerExports.createSunsetStagingLivePreflightReaderForTests, 'undefined');
  assert.equal(typeof liveOwnerExports.evaluateSunsetStagingLiveAppSnapshot, 'function');
  assert.equal(typeof liveOwnerExports.composeSunsetStagingLiveDownscopeProverDependencies, 'function');
  console.log('  PASS  independent reader is owned/exported; closed constructor stays off production surface');

  {
    const connectErr = new Error('ECONNREFUSED');
    connectErr.code = 'ECONNREFUSED';
    const { FakeClient, calls } = makeFakeClient({ connectError: connectErr });
    let workHits = 0;
    await assert.rejects(
      () => withSunsetStagingLiveTargetConnectedPgClient({
        Client: FakeClient,
        connectionString: WORKER_DSN,
        work: async () => { workHits += 1; return 'ran'; },
      }),
      (err) => err && err.code === LIVE_TARGET_ERROR_CODE && err.detail === 'pg_connect'
        && workHits === 0 && calls.connect === 1 && noLeak(err),
    );
    assert.equal(calls.connectionString, WORKER_DSN);
    assert.notEqual(calls.connectionString, ADMIN_DSN);
  }
  {
    const prover = await makeOfflineProver();
    let branded;
    try {
      await prover.runProof({
        parsed: completeLiveParse(),
        env: disabledEnv(),
        independentLivePreflight: good,
      });
    } catch (err) {
      branded = err;
    }
    assert.equal(assertChapterDisabled(branded), true);
    const priorNote = readTrustedLiveDownscopeProverFailure(branded);
    const { FakeClient, calls } = makeFakeClient();
    await assert.rejects(
      () => withSunsetStagingLiveTargetConnectedPgClient({
        Client: FakeClient,
        connectionString: WORKER_DSN,
        work: async () => { throw branded; },
      }),
      (err) => err === branded
        && readTrustedLiveDownscopeProverFailure(err).stage === priorNote.stage
        && readTrustedLiveDownscopeProverFailure(err).code === priorNote.code
        && calls.connect === 1,
    );
  }
  {
    const custodyFail = Object.freeze({ ok: false, error: 'lease_fenced' });
    const failMark = Object.freeze({ ok: false, error: 'lease_fenced', details: Object.freeze({ reason: 'failMark' }) });
    const ambiguous = Object.freeze({ ok: false, error: 'ms_response_uncertain' });
    const { FakeClient } = makeFakeClient();
    await assert.rejects(
      () => withSunsetStagingLiveTargetConnectedPgClient({
        Client: FakeClient,
        connectionString: WORKER_DSN,
        work: async () => { throw custodyFail; },
      }),
      (err) => err === custodyFail,
    );
    await assert.rejects(
      () => withSunsetStagingLiveTargetConnectedPgClient({
        Client: FakeClient,
        connectionString: WORKER_DSN,
        work: async () => { throw failMark; },
      }),
      (err) => err === failMark,
    );
    await assert.rejects(
      () => withSunsetStagingLiveTargetConnectedPgClient({
        Client: FakeClient,
        connectionString: WORKER_DSN,
        work: async () => { throw ambiguous; },
      }),
      (err) => err === ambiguous,
    );
  }
  {
    const { FakeClient, calls } = makeFakeClient();
    await assert.rejects(
      () => withSunsetStagingLiveTargetConnectedPgClient({
        Client: FakeClient,
        connectionString: WORKER_DSN,
        work: async () => { throw new Error('post-microsoft unknown'); },
      }),
      (err) => err && err.code === LIVE_TARGET_ERROR_CODE && err.detail === 'pg_work'
        && err.detail !== 'pg_connect' && calls.connect === 1 && noLeak(err),
    );
  }
  {
    const { FakeClient, calls } = makeFakeClient();
    await assert.rejects(
      () => withSunsetStagingLiveTargetConnectedPgClient({
        Client: FakeClient,
        connectionString: ADMIN_DSN,
        work: async () => 'ran',
      }),
      (err) => err && err.code === LIVE_TARGET_ERROR_CODE && err.detail === 'admin_dsn_refused'
        && calls.constructed === 0 && noLeak(err),
    );
  }
  assert.match(liveSrc, /LIVE_CUSTODY_DSN_ENV_KEY/);
  assert.match(liveSrc, /ENV_WORKER_DATABASE_URL/);
  assert.doesNotMatch(liveSrc, /connectionString:\s*envString\(env,\s*'WOLFHOUSE_DATABASE_URL'\)/);
  assert.doesNotMatch(liveSrc, /SET\s+ROLE/i);
  assert.doesNotMatch(liveSrc, /SET\s+SESSION\s+AUTHORIZATION/i);
  console.log('  PASS  M3: connect vs work identity; custody brands survive; worker DSN not admin; no SET ROLE');

  const authorityChild = spawnSync(process.execPath, ['-e', `
    'use strict';
    process.env.LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER = 'true';
    process.env.NODE_ENV = 'production';
    const path = require('node:path');
    const root = ${JSON.stringify(ROOT)};
    const proverPath = path.join(root, 'scripts/lib/email-luna-controlled-drafting-live-downscope-prover.js');
    delete require.cache[require.resolve(proverPath)];
    const prover = require(proverPath);
    const live = require(path.join(root, 'scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target.js'));
    if (prover.LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) process.exit(2);
    if (live.LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) process.exit(3);
    try {
      live.composeSunsetStagingLiveDownscopeProverDependencies({
        liveExecuteAuthorized: true,
        executeOnce: true,
        env: { LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER: 'true' },
      });
      process.exit(4);
    } catch (err) {
      if (!err || err.code !== live.ERROR_CODE) process.exit(5);
      if (err.detail !== 'live_execute_not_authorized_in_this_chapter') process.exit(6);
    }
    process.stdout.write('authority-flip-refused\\n');
  `], { cwd: ROOT, encoding: 'utf8', env: childEnv({
    LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER: 'true',
    NODE_ENV: 'production',
  }) });
  if (authorityChild.stderr) process.stderr.write(authorityChild.stderr);
  assert.equal(authorityChild.status, 0, 'authority-flip child must pass');
  assert.match(authorityChild.stdout, /authority-flip-refused/);
  console.log('  PASS  M2: new process/module reload/NODE_ENV/caller opts cannot flip chapter authority');

  assert.doesNotMatch(cliSrc, /\baz\s+(login|account|rest|keyvault)/i);
  assert.doesNotMatch(cliSrc, /require\(['"][^'"]*(azure|keyvault|jwks)/i);
  assert.doesNotMatch(proverSrc, /createEmailLunaControlledDraftingGraph/);
  assert.doesNotMatch(proverSrc, /sendMail\s*\(|createReply\s*\(/);
  assert.doesNotMatch(liveSrc, /getAccessToken|runClosed|withToken/);
  assert.doesNotMatch(liveSrc, /graph\.microsoft\.com/);
  assert.doesNotMatch(liveSrc, /tenant_email_luna_controlled_draft_staging_test_consume/);
  assert.match(liveSrc, /createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition/);
  assert.match(liveSrc, /createSunsetMicrosoftOAuthClientSecretProvider/);
  assert.match(liveSrc, /createMicrosoftTokenHttpTransport/);
  assert.match(liveSrc, /createMicrosoftOidcJwksSignatureVerifier/);
  assert.match(liveSrc, /createEmailLunaControlledDraftingPrincipalConnectionPair/);
  assert.match(proverSrc, /LIVE_DEPLOY_SHA_ALLOWLIST = objectFreeze\(\['a4188eea71a92b7361818e024cde0f810d6ee018'\]\)/);
  assert.doesNotMatch(proverSrc, /ch4f-f6ee5112/);
  assert.match(proverSrc, /LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER/);
  assert.match(proverSrc, /sha === LIVE_DEPLOY_SHA_ALLOWLIST\[0\]/);
  assert.equal(runCli(['simulate', '--target', 'fake'], disabledEnv()).ok, true);
  assert.equal(runCli(['simulate', '--target', 'fake'], disabledEnv()).live_mode_structurally_absent, false);
  assert.equal(runCli(['simulate', '--target', 'fake'], disabledEnv()).live_execution_gated, true);
  console.log('  PASS  static surface remains closed; CLI stays az-free; SHA uses pinned strict equality');

  const nodeCheck = spawnSync(process.execPath, ['--check',
    path.join(ROOT, 'scripts/lib/email-luna-controlled-drafting-live-downscope-prover.js'),
    path.join(ROOT, 'scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target.js'),
    path.join(ROOT, 'scripts/lib/email-luna-controlled-drafting-live-downscope-prover-live-target-constants.js'),
    path.join(ROOT, 'scripts/email-luna-controlled-drafting-live-downscope-prover.js'),
    path.join(ROOT, 'scripts/verify-email-luna-controlled-drafting-live-downscope-prover-live-target.js'),
    path.join(ROOT, 'scripts/prove-email-luna-controlled-drafting-live-downscope-prover-live-target-cli-near-miss.js'),
  ], { cwd: ROOT, encoding: 'utf8' });
  if (nodeCheck.stdout) process.stdout.write(nodeCheck.stdout);
  if (nodeCheck.stderr) process.stderr.write(nodeCheck.stderr);
  assert.equal(nodeCheck.status, 0, 'node --check must pass');

  const near = spawnSync(process.execPath, [
    path.join(__dirname, 'prove-email-luna-controlled-drafting-live-downscope-prover-live-target-cli-near-miss.js'),
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: childEnv() });
  if (near.stdout) process.stdout.write(near.stdout);
  if (near.stderr) process.stderr.write(near.stderr);
  assert.equal(near.status, 0, 'CLI near-miss child must pass');
  console.log('ALL OK — Stage 2 Chapter 4G live-target wiring (zero live actions)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
