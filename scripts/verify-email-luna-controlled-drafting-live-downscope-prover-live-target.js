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
  SUNSET_DEPLOYMENT,
  LIVE_DEPLOY_SHA_ALLOWLIST,
  CONFIRMATION_PHRASE,
  EIGHT_FLAGS,
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
} = require('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target');
const {
  createFakeEmailGrantEnvelopeProvider,
  fakeSealRefreshToken,
} = require('./lib/email-grant-envelope-fake-provider');

const ROOT = path.join(__dirname, '..');
const DEPLOYED_SHA = 'f6ee511273160cb46c72e345137800878d4c6512';
const REVISION = 'luna-sunset-staging-staff-api--ch4f-f6ee5112';
const DIGEST = 'sha256:20d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a';
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENDPOINT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MAILBOX = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APP_ID = '12345678-1234-4234-8234-123456789abc';
const SECRET = 'app-secret-NEVER_LEAK';
const PLANTED = 'planted-NEVER_LEAK-secret';

function childEnv() {
  const extra = '/opt/data/calendar-inventory-bridge-bf/node_modules';
  const nodePath = [extra, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  return Object.assign({}, process.env, { NODE_PATH: nodePath });
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

function fakeLoginClient() {
  return { async query() { return { rows: [], rowCount: 0 }; } };
}

async function makeOfflineProver() {
  const envelope = createFakeEmailGrantEnvelopeProvider();
  const sealed = await fakeSealRefreshToken(envelope, {
    refreshToken: 'rt-old-NEVER_LEAK',
    clientId: CLIENT,
    endpointId: ENDPOINT,
    grantGeneration: 1,
    operationId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(Boolean(sealed), true);
  return createEmailLunaControlledDraftingLiveDownscopeProver({
    deployment: SUNSET_DEPLOYMENT,
    applicationClientId: APP_ID,
    withPgClient: async (work) => work({ async query() { return { rows: [], rowCount: 0 }; } }),
    envelopeProvider: envelope,
    createSecretProvider: () => frozenMethod('getClientSecret', async () => SECRET),
    transport: frozenMethod('postTokenForm', async () => {
      throw new Error('token_owner_must_not_be_called');
    }),
    createSignatureVerifier: () => Object.freeze({
      async verify() { throw new Error('jwks_owner_must_not_be_called'); },
    }),
    binding: {
      clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT, mailboxId: MAILBOX,
    },
    workerId: 'email-luna-controlled-drafting-live-downscope-prover',
    login: { producerClient: fakeLoginClient(), workerClient: fakeLoginClient() },
    preflight: {
      ops097: 0, rows098: 0, replica: 1, sourceSha: 'b'.repeat(40), deploySha: DEPLOYED_SHA,
    },
  });
}

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4G live-target wiring verifier');
  console.log('Live proof is NOT EXECUTED. Local fake/PGlite/stock-PG only.');

  assert.equal(LIVE_DEPLOY_SHA_ALLOWLIST.length, 1);
  assert.equal(LIVE_DEPLOY_SHA_ALLOWLIST[0], DEPLOYED_SHA);
  assert.equal(Object.isFrozen(LIVE_DEPLOY_SHA_ALLOWLIST), true);
  assert.equal(EXPECTED_LIVE_TARGET.deployedSha, DEPLOYED_SHA);
  assert.equal(EXPECTED_LIVE_TARGET.revision, REVISION);
  assert.equal(EXPECTED_LIVE_TARGET.digest, DIGEST);
  assert.equal(EXPECTED_LIVE_TARGET.resourceGroup, 'luna-sunset-staging-rg');
  assert.equal(EXPECTED_LIVE_TARGET.appName, 'luna-sunset-staging-staff-api');
  assert.equal(OPERATOR_PROVER_COMPATIBILITY_RULE.deployedSha, DEPLOYED_SHA);
  assert.equal(OPERATOR_PROVER_COMPATIBILITY_RULE.allowsOperatorCliSourceShaToDiffer, true);
  assert.equal(liveModeAllowed(DEPLOYED_SHA), true);
  assert.equal(liveModeAllowed(DEPLOYED_SHA.slice(0, 12)), false);
  console.log('  PASS  immutable singleton deployed-SHA allowlist');

  const owners = proveCanonicalRuntimeOwnersMatchDeployedContract();
  assert.equal(owners.ok, true);
  assert.equal(owners.file_count, Object.keys(CANONICAL_RUNTIME_OWNER_DIGESTS).length);
  assert.equal(owners.matched, true);
  console.log('  PASS  canonical 4C/4E runtime owners match deployed-SHA digest contract');

  const good = evaluateSunsetStagingLiveAppSnapshot(completeSnapshot());
  assert.equal(good.ok, true);
  assert.equal(isIndependentLivePreflight(good), true);
  assert.equal(good.ops_097, 0);
  assert.equal(good.transitions_097, 0);
  assert.equal(good.authorizations_098, 0);
  assert.equal(good.replica, 1);
  assert.equal(good.deploy_sha, DEPLOYED_SHA);
  assert.equal(noLeak(good), true);
  assert.equal(isIndependentLivePreflight({
    ok: true, ops_097: 0, transitions_097: 0, authorizations_098: 0, replica: 1, deploy_sha: DEPLOYED_SHA,
  }), false);
  console.log('  PASS  branded independent preflight; caller-injected counts are not branded');

  const hostileCases = [
    completeSnapshot({ imageSha: DEPLOYED_SHA.slice(0, 8) }),
    completeSnapshot({ imageSha: DEPLOYED_SHA.toUpperCase() }),
    completeSnapshot({ imageSha: '0'.repeat(40) }),
    completeSnapshot({ digest: 'sha256:00d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a' }),
    completeSnapshot({ revision: 'luna-sunset-staging-staff-api--0000679' }),
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
    assert.equal(noLeak(result), true);
  }
  const unsetFlags = completeSnapshot();
  unsetFlags.flags = eightFlagEnv(['false', 'false', 'false', 'false', 'false', 'false', 'false', 'false']);
  delete unsetFlags.flags.EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED;
  const unset = evaluateSunsetStagingLiveAppSnapshot(unsetFlags);
  assert.equal(unset.ok, false);
  console.log('  PASS  hostile/missing snapshot fields fail closed before branding');

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

  {
    const prover = await makeOfflineProver();
    await assert.rejects(() => prover.runProof({
      parsed: completeLiveParse(),
      env: disabledEnv(),
      independentLivePreflight: {
        ok: true, ops_097: 0, transitions_097: 0, authorizations_098: 0,
        replica: 1, deploy_sha: DEPLOYED_SHA,
      },
    }), (error) => {
      const note = readTrustedLiveDownscopeProverFailure(error);
      return error.code === ERROR_CODE && note && note.code === 'live_preflight_unproven';
    });
  }
  console.log('  PASS  caller-injected live evidence refused; token/JWKS owners not called');

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

  assert.throws(() => composeSunsetStagingLiveDownscopeProverDependencies({}));
  assert.throws(() => composeSunsetStagingLiveDownscopeProverDependencies({
    env: disabledEnv(),
    consumer: async (token) => token,
  }));
  assert.throws(() => composeSunsetStagingLiveDownscopeProverDependencies({
    env: disabledEnv({ LUNA_DEPLOYMENT: 'production' }),
  }));
  assert.throws(() => composeSunsetStagingLiveDownscopeProverDependencies({
    env: disabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED: 'true' }),
  }));
  const getterEnv = disabledEnv();
  Object.defineProperty(getterEnv, 'LUNA_EMAIL_OAUTH_CLIENT_SECRET', {
    get() { return SECRET; }, enumerable: true,
  });
  assert.throws(() => composeSunsetStagingLiveDownscopeProverDependencies({ env: getterEnv }));
  assert.equal(isCanonicalLiveMicrosoftTransport(frozenMethod('postTokenForm', async () => ({}))), false);
  console.log('  PASS  live factory refuses generic/hostile envelopes before credential owners');

  const cliSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/email-luna-controlled-drafting-live-downscope-prover.js'),
    'utf8',
  );
  const liveSrc = fs.readFileSync(
    require.resolve('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target'),
    'utf8',
  );
  const proverSrc = fs.readFileSync(
    require.resolve('./lib/email-luna-controlled-drafting-live-downscope-prover'),
    'utf8',
  );
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
  assert.match(proverSrc, /LIVE_DEPLOY_SHA_ALLOWLIST = objectFreeze\(\['f6ee511273160cb46c72e345137800878d4c6512'\]\)/);
  assert.equal(runCli(['simulate', '--target', 'fake'], disabledEnv()).ok, true);
  console.log('  PASS  static surface remains closed; CLI stays az-free; canonical owners wired');

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
