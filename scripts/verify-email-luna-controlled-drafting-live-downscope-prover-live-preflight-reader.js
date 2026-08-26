'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4H.
 * Source/offline owned preflight-reader verifier. Does not execute live proof.
 * Local deterministic fake Azure/ACR/PG adapters only.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createEmailLunaControlledDraftingLiveDownscopeProver,
  inspectIndependentLivePreflight,
  readTrustedLiveDownscopeProverFailure,
  parseArgs,
  ERROR_CODE: PROVER_ERROR,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  EIGHT_FLAGS,
  CONFIRMATION_PHRASE,
} = require('./lib/email-luna-controlled-drafting-live-downscope-prover');
const {
  EXPECTED_LIVE_TARGET,
  evaluateSunsetStagingLiveAppSnapshot,
  isIndependentLivePreflight,
  composeSunsetStagingLiveDownscopeProverDependencies,
  readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER: LIVE_TARGET_EXECUTE,
} = require('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target');
const readerOwner = require('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader');
const {
  ERROR_CODE,
  ERROR_MESSAGE,
  AZURE_OWNER,
  COUNT_SQL,
  IDENTITY_SQL,
  GRANT_SQL,
  BINDING_SQL,
  FENCE_MAX_AGE_MS,
} = require('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader');
const {
  createSunsetStagingLivePreflightReaderForTests,
} = require('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader.test-support');
const ownedCore = require('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader-owned');
const {
  withReadOnlyPreflightClient,
  closedAcrDigestFromManifestResponse,
} = ownedCore;
const {
  createFakeEmailGrantEnvelopeProvider,
  fakeSealRefreshToken,
} = require('./lib/email-grant-envelope-fake-provider');

const ROOT = path.join(__dirname, '..');
const DEPLOYED_SHA = EXPECTED_LIVE_TARGET.deployedSha;
const REVISION = EXPECTED_LIVE_TARGET.revision;
const DIGEST = EXPECTED_LIVE_TARGET.digest;
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENDPOINT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MAILBOX = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CLIENT2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
const LOCATION2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc';
const ENDPOINT2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccd';
const MAILBOX2 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddde';
const PLANTED = 'planted-NEVER_LEAK-secret';
const PRODUCER_FP = 'aa'.repeat(32);
const WORKER_FP = 'bb'.repeat(32);
const IMAGE = `whstagingacr.azurecr.io/luna-sunset-staff-api:${DEPLOYED_SHA}`;
const FOREIGN_LOGIN_IMAGE = `evil.azurecr.io/luna-sunset-staff-api:${DEPLOYED_SHA}`;
const FOREIGN_REPO_IMAGE = `whstagingacr.azurecr.io/not-luna-sunset-staff-api:${DEPLOYED_SHA}`;
const DRIFT_TAG_IMAGE = `whstagingacr.azurecr.io/luna-sunset-staff-api:${'0'.repeat(40)}`;
const OTHER_DIGEST = 'sha256:00d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a';
const CHAPTER_DISABLED = 'live_execute_not_authorized_in_this_chapter';

function childEnv(patch = {}) {
  const extra = '/opt/data/calendar-inventory-bridge-bf/node_modules';
  const nodePath = [extra, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  return Object.assign({}, process.env, { NODE_PATH: nodePath }, patch);
}

function noLeak(value) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch (_) {
    try { text = String(value); } catch (__) { return false; }
  }
  return !String(text).includes('NEVER_LEAK')
    && !String(text).includes(PLANTED)
    && !String(text).includes('eyJ')
    && !String(text).includes('postgres://');
}

function eightEnv() {
  const env = [
    { name: 'LUNA_DEPLOYMENT', value: 'sunset-staging' },
    { name: 'DEFAULT_CLIENT_SLUG', value: 'sunset' },
    { name: 'EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY', value: 'sunset-somo' },
    { name: 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT', value: '1' },
    { name: 'EMAIL_LUNA_CONTROLLED_DRAFTING_CLIENT_ID', value: CLIENT },
    { name: 'EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_ID', value: LOCATION },
    { name: 'EMAIL_LUNA_CONTROLLED_DRAFTING_ENDPOINT_ID', value: ENDPOINT },
    { name: 'EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID', value: MAILBOX },
  ];
  for (let i = 0; i < EIGHT_FLAGS.length; i += 1) {
    env.push({ name: EIGHT_FLAGS[i], value: 'false' });
  }
  return env;
}

function appFacts(patch = {}) {
  return Object.assign({
    subscriptionId: AZURE_OWNER.subscriptionId,
    resourceGroup: AZURE_OWNER.resourceGroup,
    name: AZURE_OWNER.appName,
    location: AZURE_OWNER.location,
    tenantTag: 'sunset',
    latestRevisionName: REVISION,
    latestReadyRevisionName: REVISION,
    runningStatus: 'Running',
    provisioningState: 'Succeeded',
    minReplicas: 1,
    maxReplicas: 1,
    traffic: [{ revisionName: REVISION, weight: 100 }],
    env: eightEnv(),
    image: IMAGE,
  }, patch);
}

function revisionFacts(patch = {}) {
  return Object.assign({
    name: REVISION,
    runningState: 'Running',
    healthState: 'Healthy',
    provisioningState: 'Provisioned',
    replicas: 1,
    image: IMAGE,
    imageDigest: DIGEST,
  }, patch);
}

function identityRow(kind) {
  const fp = kind === 'producer' ? PRODUCER_FP : WORKER_FP;
  return {
    session_matches_current: true,
    current_database: 'sunset_staging',
    ssl: 'on',
    session_fingerprint: fp,
    current_fingerprint: fp,
  };
}

function attestRow(kind) {
  const user = kind === 'producer' ? 'luna_cd_producer' : 'luna_cd_worker';
  return {
    session_user: user,
    current_user: user,
    table_owner: 'wolfhouse_admin',
    session_distinct_from_owner: true,
    session_matches_current: true,
    mapping_ok: true,
    login_contract_ok: true,
    execute_ok: true,
  };
}

function countsRow(patch = {}) {
  return Object.assign({
    ops_097: 0,
    transitions_097: 0,
    authorizations_098: 0,
  }, patch);
}

function grantRow(patch = {}) {
  return Object.assign({
    grant_generation: 4,
    grant_status: 'active',
    reconcile_state: 'clean',
    has_active_lease: false,
  }, patch);
}

function bindingRow(patch = {}) {
  return Object.assign({
    binding_ok: true,
    own_user: true,
    mailbox_ready: true,
    has_active_operation: false,
  }, patch);
}

function makePg(hits, overrides = {}) {
  function clientFor(kind) {
    return {
      async query(sql, params) {
        if (hits) {
          hits.queries.push(sql);
          if (/ops_097/.test(sql)) hits.countSql += 1;
          if (/INSERT|UPDATE|DELETE|SET\s+ROLE/i.test(sql)) hits.writes += 1;
        }
        if (overrides.query) return overrides.query(sql, params, kind);
        if (/ops_097/.test(sql)) return { rows: [countsRow(overrides.counts)] };
        if (/session_fingerprint/.test(sql)) return { rows: [identityRow(kind)] };
        if (/grant_status/.test(sql)) return { rows: [grantRow(overrides.grant)] };
        if (/binding_ok/.test(sql)) return { rows: [bindingRow(overrides.binding)] };
        if (/'producer'/.test(sql)) return { rows: [attestRow('producer')] };
        if (/'worker'/.test(sql)) return { rows: [attestRow('worker')] };
        throw new Error(`unexpected sql ${PLANTED}`);
      },
    };
  }
  return {
    async withProducerClient(work) {
      if (hits) hits.producer += 1;
      return work(clientFor('producer'));
    },
    async withWorkerClient(work) {
      if (hits) hits.worker += 1;
      return work(clientFor('worker'));
    },
  };
}

function makeAdapters(hits, patch = {}) {
  const azureState = { app: appFacts(patch.app), revision: revisionFacts(patch.revision) };
  const acrState = { digest: patch.digest || DIGEST };
  return {
    azure: {
      async readApp() {
        if (hits) hits.app += 1;
        if (typeof patch.readApp === 'function') return patch.readApp(hits.app);
        return azureState.app;
      },
      async listRevisions() {
        if (hits) hits.list += 1;
        if (typeof patch.listRevisions === 'function') return patch.listRevisions();
        return [azureState.revision];
      },
      async readRevision(name) {
        if (hits) hits.rev += 1;
        if (typeof patch.readRevision === 'function') return patch.readRevision(name);
        return Object.assign({}, azureState.revision, { name });
      },
    },
    acr: {
      async readManifestDigest(ref) {
        if (hits) hits.acr += 1;
        if (typeof patch.readManifestDigest === 'function') return patch.readManifestDigest(ref);
        return acrState.digest;
      },
    },
    pg: patch.pg || makePg(hits, patch),
    clock: patch.clock || { nowMs() { return Date.parse('2026-08-26T00:00:00.000Z'); } },
  };
}

async function readWith(hits, patch) {
  const reader = createSunsetStagingLivePreflightReaderForTests(makeAdapters(hits, patch));
  return reader.read();
}

function hitsTemplate() {
  return {
    app: 0, list: 0, rev: 0, acr: 0, producer: 0, worker: 0, countSql: 0, writes: 0, queries: [],
  };
}

function assertReaderFailure(err, detail) {
  return err
    && err.code === ERROR_CODE
    && err.message === ERROR_MESSAGE
    && err.detail === detail
    && noLeak(err);
}

function imageUnprovenOrDrift(err) {
  return assertReaderFailure(err, 'image_unproven') || assertReaderFailure(err, 'revision_drift');
}

function digestClosed(err) {
  return assertReaderFailure(err, 'digest_mismatch')
    || assertReaderFailure(err, 'azure_unproven')
    || assertReaderFailure(err, 'acr_unproven');
}

function listDirectRevision(listPatch, directPatch) {
  return {
    listRevisions() { return [revisionFacts(listPatch)]; },
    readRevision() { return revisionFacts(directPatch); },
  };
}

function secondFenceRevision(secondPatch) {
  let lists = 0;
  let revs = 0;
  return {
    listRevisions() {
      lists += 1;
      return [lists >= 2 ? revisionFacts(secondPatch) : revisionFacts()];
    },
    readRevision() {
      revs += 1;
      return revs >= 2 ? revisionFacts(secondPatch) : revisionFacts();
    },
  };
}

function completeSnapshot() {
  return {
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
    flags: EIGHT_FLAGS.reduce((acc, key) => {
      acc[key] = 'false';
      return acc;
    }, {}),
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
  };
}

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4H live preflight reader verifier');
  console.log('Live proof is NOT EXECUTED. Local fake adapters only.');

  const readerSrc = fs.readFileSync(
    require.resolve('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader'),
    'utf8',
  );
  const ownedSrc = fs.readFileSync(
    require.resolve('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader-owned'),
    'utf8',
  );
  const testSupportSrc = fs.readFileSync(
    require.resolve('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader.test-support'),
    'utf8',
  );
  const proverSrc = fs.readFileSync(
    require.resolve('./lib/email-luna-controlled-drafting-live-downscope-prover'),
    'utf8',
  );
  const staffSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

  assert.equal(LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER, false);
  assert.equal(LIVE_TARGET_EXECUTE, false);
  assert.equal(readerOwner.LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER, false);
  assert.equal(typeof readerOwner.createOwnedSunsetStagingLivePreflightReader, 'undefined');
  assert.equal(typeof readerOwner.createSunsetStagingLivePreflightReaderForTests, 'undefined');
  assert.equal(typeof readerOwner.withReadOnlyPreflightClient, 'undefined');
  assert.equal(typeof readerOwner.closedAcrDigestFromManifestResponse, 'undefined');
  assert.equal(typeof ownedCore.createOwnedSunsetStagingLivePreflightReader, 'function');
  assert.equal(typeof createSunsetStagingLivePreflightReaderForTests, 'function');
  assert.equal(typeof inspectIndependentLivePreflight, 'function');
  assert.equal(typeof withReadOnlyPreflightClient, 'function');
  assert.equal(typeof closedAcrDigestFromManifestResponse, 'function');
  assert.match(readerSrc, /does not export the closed adapter constructor/);
  assert.doesNotMatch(readerSrc, /createOwnedSunsetStagingLivePreflightReader,/);
  assert.doesNotMatch(staffSrc, /live-preflight-reader/);
  console.log('  PASS  RED/GREEN: production owner exports reader, not closed constructor');

  const snapshot = evaluateSunsetStagingLiveAppSnapshot(completeSnapshot());
  assert.equal(snapshot.ok, true);
  assert.equal(isIndependentLivePreflight(snapshot), false);
  assert.equal(isIndependentLivePreflight({
    ok: true, independent_read: true, ops_097: 0, digest: DIGEST, replica: 1,
  }), false);
  await assert.rejects(
    () => readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg(completeSnapshot()),
    (err) => assertReaderFailure(err, 'caller_input_refused'),
  );
  await assert.rejects(
    () => readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg(),
    (err) => assertReaderFailure(err, 'live_execute_not_authorized_in_this_chapter'),
  );
  assert.match(ownedSrc, /source_test_cannot_consume_live_azure_pg/);
  console.log('  PASS  RED/GREEN: forged/caller snapshot cannot mint owned brand; production path refused in tests');

  {
    const ungated = spawnSync(process.execPath, ['-e', `
      'use strict';
      const http = require('node:http');
      const https = require('node:https');
      const path = require('node:path');
      let network = 0;
      function wrap(obj, name) {
        const orig = obj[name];
        if (typeof orig !== 'function') return;
        obj[name] = function wrapped() {
          network += 1;
          const err = new Error('imds_must_not_run');
          try {
            const req = orig.apply(this, arguments);
            try { req.destroy(err); } catch (_) { /* intercepted */ }
            return req;
          } catch (_) {
            throw err;
          }
        };
      }
      wrap(http, 'request'); wrap(http, 'get');
      wrap(https, 'request'); wrap(https, 'get');
      const root = ${JSON.stringify(ROOT)};
      const owned = require(path.join(root, 'scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader-owned.js'));
      const pub = require(path.join(root, 'scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader.js'));
      Promise.all([
        owned.readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg().then(() => 'resolved', (e) => e),
        pub.readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg().then(() => 'resolved', (e) => e),
      ]).then(([a, b]) => {
        const ok = a && b
          && a !== 'resolved' && b !== 'resolved'
          && a.code === owned.ERROR_CODE
          && b.code === pub.ERROR_CODE
          && a.message === owned.ERROR_MESSAGE
          && a.detail === 'live_execute_not_authorized_in_this_chapter'
          && b.detail === 'live_execute_not_authorized_in_this_chapter'
          && network === 0
          && owned.LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER === false
          && !String(a && a.message || '').includes('postgres://')
          && !String(a && a.stack || '').includes('169.254.169.254');
        process.stdout.write(ok ? 'zero-imds-refused\\n' : ('ungated-fail network=' + network + ' a=' + (a && a.detail) + '\\n'));
        process.exit(ok ? 0 : 2);
      }).catch(() => process.exit(3));
    `], { cwd: ROOT, encoding: 'utf8', env: childEnv(), timeout: 10000 });
    if (ungated.stderr) process.stderr.write(ungated.stderr);
    assert.equal(ungated.status, 0, 'direct production reader must refuse before IMDS');
    assert.match(ungated.stdout, /zero-imds-refused/);
  }
  console.log('  PASS  direct node -e production reader refuses chapter-disabled with zero IMDS/ARM/ACR');

  {
    const after4i = spawnSync(process.execPath, ['-e', `
      'use strict';
      const http = require('node:http');
      const https = require('node:https');
      const path = require('node:path');
      let network = 0;
      function wrap(obj, name) {
        const orig = obj[name];
        if (typeof orig !== 'function') return;
        obj[name] = function wrapped() {
          network += 1;
          const err = new Error('imds_must_not_run');
          try {
            const req = orig.apply(this, arguments);
            try { req.destroy(err); } catch (_) {}
            return req;
          } catch (_) { throw err; }
        };
      }
      wrap(http, 'request'); wrap(http, 'get');
      wrap(https, 'request'); wrap(https, 'get');
      const root = ${JSON.stringify(ROOT)};
      require(path.join(root, 'scripts/lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner.js'));
      require(path.join(root, 'scripts/lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner-owned.js'));
      require(path.join(root, 'scripts/lib/email-luna-controlled-drafting-chapter-4i-one-shot-authority.js'));
      require(path.join(root, 'scripts/lib/email-luna-controlled-drafting-chapter-4i-durable-receipt.js'));
      const owned = require(path.join(root, 'scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader-owned.js'));
      const pub = require(path.join(root, 'scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader.js'));
      Promise.all([
        owned.readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg().then(() => 'resolved', (e) => e),
        pub.readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg().then(() => 'resolved', (e) => e),
      ]).then(([a, b]) => {
        const ok = a && b
          && a.detail === 'live_execute_not_authorized_in_this_chapter'
          && b.detail === 'live_execute_not_authorized_in_this_chapter'
          && network === 0;
        process.stdout.write(ok ? '4i-import-still-disabled\\n' : ('fail net=' + network + ' a=' + (a && a.detail) + '\\n'));
        process.exit(ok ? 0 : 2);
      });
    `], { cwd: ROOT, encoding: 'utf8', env: childEnv(), timeout: 10000 });
    if (after4i.stderr) process.stderr.write(after4i.stderr);
    assert.equal(after4i.status, 0, '4H reader must stay chapter-disabled after 4I import');
    assert.match(after4i.stdout, /4i-import-still-disabled/);
  }
  console.log('  PASS  4H production reader stays chapter-disabled after importing all public 4I exports');

  const hits = hitsTemplate();
  const evidence = await readWith(hits);
  assert.equal(isIndependentLivePreflight(evidence), true);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.independent_read, true);
  assert.equal(evidence.digest, DIGEST);
  assert.equal(evidence.deploy_sha, DEPLOYED_SHA);
  assert.equal(evidence.image_login_server, AZURE_OWNER.acrLoginServer);
  assert.equal(evidence.image_repository, `${AZURE_OWNER.acrLoginServer}/${AZURE_OWNER.acrRepository}`);
  assert.equal(evidence.image_tag, DEPLOYED_SHA);
  assert.equal(evidence.revision, REVISION);
  assert.equal(evidence.replica, 1);
  assert.equal(evidence.ops_097, 0);
  assert.equal(evidence.transitions_097, 0);
  assert.equal(evidence.authorizations_098, 0);
  assert.equal(evidence.flags_all_literal_false, true);
  assert.equal(evidence.oauth_called, false);
  assert.equal(evidence.kv_secret_called, false);
  assert.equal(evidence.token_called, false);
  assert.equal(evidence.jwks_called, false);
  assert.equal(evidence.graph_called, false);
  assert.equal(evidence.send_called, false);
  assert.equal(evidence.writes, false);
  assert.equal(evidence.fence_stable, true);
  assert.equal(evidence.grant_generation, 4);
  assert.equal(evidence.producer_login_fingerprint, PRODUCER_FP);
  assert.equal(evidence.worker_login_fingerprint, WORKER_FP);
  assert.equal(evidence.client_id, CLIENT);
  assert.equal(evidence.location_id, LOCATION);
  assert.equal(evidence.endpoint_id, ENDPOINT);
  assert.equal(evidence.mailbox_id, MAILBOX);
  assert.equal(evidence.subscription_id, AZURE_OWNER.subscriptionId);
  assert.equal(evidence.resource_group, AZURE_OWNER.resourceGroup);
  assert.equal(evidence.app_name, AZURE_OWNER.appName);
  assert.equal(Object.prototype.hasOwnProperty.call(evidence, 'dsn'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(evidence, 'mailbox'), false);
  assert.equal(noLeak(evidence), true);
  assert.equal(isIndependentLivePreflight({
    ok: true,
    independent_read: true,
    grant_generation: 4,
    producer_login_fingerprint: PRODUCER_FP,
    worker_login_fingerprint: WORKER_FP,
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    mailbox_id: MAILBOX,
  }), false);
  assert.ok(hits.app >= 2, 'double-read azure app');
  assert.ok(hits.acr >= 2, 'double-read acr digest');
  assert.ok(hits.countSql >= 2, 'double-read SQL counts');
  assert.ok(hits.producer >= 2 && hits.worker >= 2);
  assert.equal(hits.writes, 0);
  assert.match(COUNT_SQL, /COUNT\(\*\)/);
  assert.match(ownedSrc, /await acr\.readManifestDigest/);
  assert.match(ownedSrc, /COUNT_SQL/);
  assert.match(ownedSrc, /literalFalseEnv/);
  assert.ok(hits.queries.every((sql) => !/\bCOMMIT\b/i.test(sql) && !/\bSET\s+ROLE\b/i.test(sql)));
  console.log('  PASS  owned reader calls adapters and derives digest/flags/counts');

  {
    const liveTargetOwner = require('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target');
    const brandedOk = inspectIndependentLivePreflight(liveTargetOwner, evidence);
    assert.equal(brandedOk.ok, true);
    assert.equal(inspectIndependentLivePreflight(readerOwner, evidence).ok, true);
    const plain = {
      ok: true, independent_read: true, live_authority: true, digest: DIGEST, replica: 1, ops_097: 0,
    };
    assert.equal(inspectIndependentLivePreflight(liveTargetOwner, plain).ok, false);
    assert.equal(inspectIndependentLivePreflight(liveTargetOwner, snapshot).ok, false);
    assert.equal(inspectIndependentLivePreflight(liveTargetOwner, Object.create(evidence)).ok, false);
    assert.equal(inspectIndependentLivePreflight(liveTargetOwner, new Proxy(evidence, {
      get(t0, k) { return t0[k]; },
    })).ok, false);
    const accessor = {};
    Object.defineProperty(accessor, 'ok', { get() { return true; }, enumerable: true });
    Object.defineProperty(accessor, 'independent_read', { get() { return true; }, enumerable: true });
    assert.equal(inspectIndependentLivePreflight(liveTargetOwner, accessor).ok, false);
    assert.equal(inspectIndependentLivePreflight({}, evidence).reason, 'independent_preflight_predicate_absent');
    assert.equal(inspectIndependentLivePreflight({
      isIndependentLivePreflight: undefined,
    }, evidence).reason, 'independent_preflight_predicate_absent');
    const throwing = inspectIndependentLivePreflight({
      isIndependentLivePreflight() { throw new Error(`pred ${PLANTED}`); },
    }, evidence);
    assert.equal(throwing.ok, false);
    assert.equal(throwing.reason, 'independent_preflight_predicate_unproven');
    assert.equal(noLeak(throwing), true);
    assert.equal(inspectIndependentLivePreflight({
      isIndependentLivePreflight() { return 'true'; },
    }, evidence).ok, false);
    assert.equal(inspectIndependentLivePreflight({
      isIndependentLivePreflight() { return 1; },
    }, evidence).ok, false);
    assert.equal(inspectIndependentLivePreflight(null, evidence).reason, 'independent_reader_absent');
    const stubOwner = {
      isIndependentLivePreflight() { return true; },
      readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg: async () => plain,
    };
    assert.equal(inspectIndependentLivePreflight(liveTargetOwner, await stubOwner.readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg()).ok, false);
    console.log('  PASS  brand consumer requires liveOwner predicate exactly true; stub/plain/proxy/throw fail closed');
  }

  await assert.rejects(
    () => readWith(hitsTemplate(), { digest: OTHER_DIGEST }),
    (err) => assertReaderFailure(err, 'digest_mismatch'),
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), { counts: { ops_097: 1 } }),
    (err) => assertReaderFailure(err, 'counts_nonzero'),
  );
  console.log('  PASS  mutation: ACR/count substitution cannot fall back to hardcoded pins');

  await assert.rejects(
    () => readWith(hitsTemplate(), { revision: { image: FOREIGN_LOGIN_IMAGE } }),
    (err) => assertReaderFailure(err, 'image_unproven'),
    'revision loginServer foreign on both reads',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), { revision: { image: FOREIGN_REPO_IMAGE } }),
    (err) => assertReaderFailure(err, 'image_unproven'),
    'revision repository foreign on both reads',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), { revision: { image: DRIFT_TAG_IMAGE } }),
    (err) => assertReaderFailure(err, 'image_unproven'),
    'revision tag drift on both reads',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), {
      app: { image: IMAGE },
      revision: { image: FOREIGN_LOGIN_IMAGE },
    }),
    (err) => assertReaderFailure(err, 'image_unproven'),
    'app template pinned but revision loginServer foreign',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), {
      app: { image: IMAGE },
      revision: { image: FOREIGN_REPO_IMAGE },
    }),
    (err) => assertReaderFailure(err, 'image_unproven'),
    'app template pinned but revision repository foreign',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), {
      app: { image: IMAGE },
      revision: { image: DRIFT_TAG_IMAGE },
    }),
    (err) => assertReaderFailure(err, 'image_unproven'),
    'app template pinned but revision tag foreign',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), listDirectRevision({}, { image: FOREIGN_LOGIN_IMAGE })),
    imageUnprovenOrDrift,
    'list pinned / direct foreign loginServer',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), listDirectRevision({}, { image: FOREIGN_REPO_IMAGE })),
    imageUnprovenOrDrift,
    'list pinned / direct foreign repository',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), listDirectRevision({}, { image: DRIFT_TAG_IMAGE })),
    imageUnprovenOrDrift,
    'list pinned / direct foreign tag',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), listDirectRevision({ image: FOREIGN_LOGIN_IMAGE }, {})),
    imageUnprovenOrDrift,
    'list foreign loginServer / direct pinned',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), listDirectRevision({ image: FOREIGN_REPO_IMAGE }, {})),
    imageUnprovenOrDrift,
    'list foreign repository / direct pinned',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), listDirectRevision({ image: DRIFT_TAG_IMAGE }, {})),
    imageUnprovenOrDrift,
    'list foreign tag / direct pinned',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), secondFenceRevision({ image: FOREIGN_LOGIN_IMAGE })),
    imageUnprovenOrDrift,
    'first fence pinned / second foreign loginServer',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), secondFenceRevision({ image: FOREIGN_REPO_IMAGE })),
    imageUnprovenOrDrift,
    'first fence pinned / second foreign repository',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), secondFenceRevision({ image: DRIFT_TAG_IMAGE })),
    imageUnprovenOrDrift,
    'first fence pinned / second foreign tag',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), { revision: { imageDigest: null } }),
    digestClosed,
    'runtime digest null',
  );
  {
    const missingDigest = revisionFacts();
    delete missingDigest.imageDigest;
    await assert.rejects(
      () => readWith(hitsTemplate(), {
        listRevisions() { return [missingDigest]; },
        readRevision() { return Object.assign({}, missingDigest); },
      }),
      digestClosed,
      'runtime digest missing',
    );
  }
  await assert.rejects(
    () => readWith(hitsTemplate(), { revision: { imageDigest: '' } }),
    digestClosed,
    'runtime digest empty',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), { revision: { imageDigest: 'sha256:deadbeef' } }),
    digestClosed,
    'runtime digest malformed',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), { revision: { imageDigest: OTHER_DIGEST } }),
    (err) => assertReaderFailure(err, 'digest_mismatch'),
    'runtime digest differs from ACR digest',
  );
  assert.match(ownedSrc, /function sameImageIdentity/);
  assert.match(ownedSrc, /a\.revision\.image\.loginServer === b\.revision\.image\.loginServer/);
  assert.match(ownedSrc, /a\.revision\.image\.repository === b\.revision\.image\.repository/);
  assert.match(ownedSrc, /listedRevision\.image/);
  assert.match(ownedSrc, /azureB\.revision\.image\.loginServer/);
  assert.match(ownedSrc, /azureB\.revision\.image\.repository/);
  assert.match(ownedSrc, /azureB\.revision\.image\.tag/);
  assert.doesNotMatch(ownedSrc, /if \(runtimeDigest && runtimeDigest !== digest\)/);
  assert.doesNotMatch(
    ownedSrc,
    /\['image_repository', `\$\{AZURE_OWNER\.acrLoginServer\}\/\$\{AZURE_OWNER\.acrRepository\}`\]/,
  );
  assert.doesNotMatch(ownedSrc, /constructor that is not on[\s\S]{0,80}this module's exports/);
  assert.match(ownedSrc, /readAcrFence\(acr, azureA\.revision\.image/);
  assert.match(ownedSrc, /readAcrFence\(acr, azureB\.revision\.image/);
  console.log('  PASS  revision image identity is fully pinned; runtime digest required and equal to ACR');

  {
    const proverHits = { login: 0, pg: 0, token: 0, jwks: 0 };
    const envelope = createFakeEmailGrantEnvelopeProvider();
    await fakeSealRefreshToken(envelope, {
      refreshToken: 'rt-old-NEVER_LEAK',
      clientId: CLIENT,
      endpointId: ENDPOINT,
      grantGeneration: 1,
      operationId: '11111111-1111-4111-8111-111111111111',
    });
    const prover = createEmailLunaControlledDraftingLiveDownscopeProver({
      deployment: 'sunset-staging',
      applicationClientId: '12345678-1234-4234-8234-123456789abc',
      withPgClient: async (work) => {
        proverHits.pg += 1;
        return work({ async query() { return { rows: [], rowCount: 0 }; } });
      },
      envelopeProvider: envelope,
      createSecretProvider: () => Object.freeze({ getClientSecret: async () => PLANTED }),
      transport: Object.freeze({
        postTokenForm: async () => { proverHits.token += 1; throw new Error('token'); },
      }),
      createSignatureVerifier: () => Object.freeze({
        async verify() { proverHits.jwks += 1; throw new Error('jwks'); },
      }),
      binding: {
        clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT, mailboxId: MAILBOX,
      },
      workerId: 'email-luna-controlled-drafting-live-downscope-prover',
      login: {
        producerClient: { async query() { proverHits.login += 1; return { rows: [] }; } },
        workerClient: { async query() { proverHits.login += 1; return { rows: [] }; } },
      },
      preflight: { ops097: 0, rows098: 0, replica: 1 },
    });
    await assert.rejects(() => prover.runProof({
      parsed: parseArgs([
        'prove', '--target', 'sunset-staging', '--deploy-sha', DEPLOYED_SHA,
        '--revision', REVISION, '--digest', DIGEST,
        '--confirm', CONFIRMATION_PHRASE,
        '--operator-nonce', 'ab'.repeat(32),
        '--confirm-issued-at', new Date().toISOString(),
        '--execute-once',
      ]),
      env: EIGHT_FLAGS.reduce((acc, key) => {
        acc[key] = 'false';
        return acc;
      }, {}),
      independentLivePreflight: evidence,
    }), (error) => {
      const note = readTrustedLiveDownscopeProverFailure(error);
      return error.code === PROVER_ERROR && note && note.code === CHAPTER_DISABLED
        && proverHits.login === 0 && proverHits.pg === 0 && proverHits.token === 0
        && proverHits.jwks === 0 && noLeak(error);
    });
    const executeIdx = proverSrc.indexOf('LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== true');
    const readerIdx = proverSrc.indexOf('readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg');
    assert.ok(executeIdx > 0 && readerIdx > executeIdx);
    const readOwnedIdx = proverSrc.indexOf('independent = await readOwned()');
    assert.ok(readOwnedIdx > 0, 'runProof must await owned reader');
    const afterReadOwned = proverSrc.slice(readOwnedIdx, readOwnedIdx + 900);
    assert.match(afterReadOwned, /inspectIndependentLivePreflight\(liveOwner, independent\)/);
    assert.match(proverSrc, /ownData\(liveOwner, 'isIndependentLivePreflight'\)/);
    const fieldIdx = afterReadOwned.search(/ownData\(independent,\s*'deploy_sha'\)/);
    const brandIdx = afterReadOwned.indexOf('inspectIndependentLivePreflight');
    assert.ok(brandIdx >= 0 && fieldIdx > brandIdx, 'brand must be consumed before field compare');
  }
  assert.throws(
    () => composeSunsetStagingLiveDownscopeProverDependencies({ env: {} }),
    (err) => err && err.detail === CHAPTER_DISABLED,
  );
  console.log('  PASS  live runProof/compose remain refused BEFORE owned reader executes');

  await assert.rejects(
    () => readWith(hitsTemplate(), { revision: { replicas: 0 } }),
    (err) => assertReaderFailure(err, 'replica_not_one'),
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), { revision: { replicas: 2 } }),
    (err) => assertReaderFailure(err, 'replica_not_one'),
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), {
      app: { traffic: [{ revisionName: REVISION, weight: 50 }, { revisionName: 'other', weight: 50 }] },
    }),
    (err) => assertReaderFailure(err, 'traffic_ambiguous'),
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), {
      readApp(n) { return n >= 2 ? appFacts({ latestRevisionName: 'other' }) : appFacts(); },
    }),
    (err) => err && err.code === ERROR_CODE && (err.detail === 'revision_mismatch' || err.detail === 'revision_drift') && noLeak(err),
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), {
      readManifestDigest() { return nDigest(); },
    }),
    (err) => assertReaderFailure(err, 'digest_mismatch'),
  );
  function nDigest() {
    return 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  }

  const flagCases = [];
  for (let i = 0; i < EIGHT_FLAGS.length; i += 1) {
    const missing = eightEnv().filter((row) => row.name !== EIGHT_FLAGS[i]);
    flagCases.push({ env: missing, detail: 'flag_missing' });
    const asTrue = eightEnv().map((row) => (row.name === EIGHT_FLAGS[i] ? { name: row.name, value: 'true' } : row));
    flagCases.push({ env: asTrue, detail: 'flag_not_literal_false' });
    const asBool = eightEnv().map((row) => (row.name === EIGHT_FLAGS[i] ? { name: row.name, value: false } : row));
    flagCases.push({ env: asBool, detail: 'flags_unproven' });
    const dup = eightEnv().concat([{ name: EIGHT_FLAGS[i], value: 'false' }]);
    flagCases.push({ env: dup, detail: 'flag_duplicate' });
    const secretRef = eightEnv().map((row) => (
      row.name === EIGHT_FLAGS[i] ? { name: row.name, secretRef: PLANTED } : row
    ));
    flagCases.push({ env: secretRef, detail: 'flag_secret_ref' });
  }
  for (let i = 0; i < flagCases.length; i += 1) {
    await assert.rejects(
      () => readWith(hitsTemplate(), { app: { env: flagCases[i].env } }),
      (err) => assertReaderFailure(err, flagCases[i].detail),
      `flag case ${i} ${flagCases[i].detail}`,
    );
  }
  console.log('  PASS  adversarial replica/traffic/revision/digest/flag matrix fail closed');

  await assert.rejects(
    () => readWith(hitsTemplate(), {
      query(sql, _params, kind) {
        if (/session_fingerprint/.test(sql)) {
          return {
            rows: [{
              session_matches_current: true,
              current_database: 'sunset_staging',
              ssl: 'on',
              session_fingerprint: PRODUCER_FP,
              current_fingerprint: PRODUCER_FP,
            }],
          };
        }
        if (/ops_097/.test(sql)) return { rows: [countsRow()] };
        if (/grant_status/.test(sql)) return { rows: [grantRow()] };
        if (/binding_ok/.test(sql)) return { rows: [bindingRow()] };
        if (/'producer'/.test(sql) || /'worker'/.test(sql)) return { rows: [attestRow(kind)] };
        throw new Error(PLANTED);
      },
    }),
    (err) => assertReaderFailure(err, 'login_alias'),
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), {
      query(sql, _params, kind) {
        if (/session_fingerprint/.test(sql)) {
          return {
            rows: [{
              session_matches_current: false,
              current_database: 'sunset_staging',
              ssl: 'on',
              session_fingerprint: kind === 'producer' ? PRODUCER_FP : WORKER_FP,
              current_fingerprint: kind === 'producer' ? PRODUCER_FP : WORKER_FP,
            }],
          };
        }
        if (/ops_097/.test(sql)) return { rows: [countsRow()] };
        if (/grant_status/.test(sql)) return { rows: [grantRow()] };
        if (/binding_ok/.test(sql)) return { rows: [bindingRow()] };
        if (/'producer'/.test(sql) || /'worker'/.test(sql)) return { rows: [attestRow(kind)] };
        throw new Error(PLANTED);
      },
    }),
    (err) => assertReaderFailure(err, 'login_alias'),
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), {
      query(sql, _params, kind) {
        if (/session_fingerprint/.test(sql)) {
          return {
            rows: [Object.assign(identityRow(kind), { ssl: 'off' })],
          };
        }
        if (/ops_097/.test(sql)) return { rows: [countsRow()] };
        if (/grant_status/.test(sql)) return { rows: [grantRow()] };
        if (/binding_ok/.test(sql)) return { rows: [bindingRow()] };
        if (/'producer'/.test(sql) || /'worker'/.test(sql)) return { rows: [attestRow(kind)] };
        throw new Error(PLANTED);
      },
    }),
    (err) => assertReaderFailure(err, 'tls_unproven'),
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), { grant: { grant_status: 'reauthorization_required' } }),
    (err) => assertReaderFailure(err, 'dead_grant'),
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), { grant: { has_active_lease: true, grant_status: 'lease_held' } }),
    (err) => assertReaderFailure(err, 'lease_held'),
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), { grant: { reconcile_state: 'ms_response_uncertain' } }),
    (err) => assertReaderFailure(err, 'reconciliation_needed'),
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), { app: { tenantTag: 'wolfhouse' } }),
    (err) => assertReaderFailure(err, 'tenant_mismatch'),
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), {
      counts: { ops_097: 0, transitions_097: 0, authorizations_098: 0 },
      query(sql, params, kind) {
        if (/ops_097/.test(sql)) {
          this._n = (this._n || 0) + 1;
          return { rows: [countsRow(this._n > 1 ? { ops_097: 1 } : {})] };
        }
        if (/session_fingerprint/.test(sql)) return { rows: [identityRow(kind)] };
        if (/grant_status/.test(sql)) return { rows: [grantRow()] };
        if (/binding_ok/.test(sql)) return { rows: [bindingRow()] };
        if (/'producer'/.test(sql) || /'worker'/.test(sql)) return { rows: [attestRow(kind)] };
        throw new Error(PLANTED);
      },
    }),
    (err) => assertReaderFailure(err, 'counts_nonzero') || assertReaderFailure(err, 'revision_drift'),
  );

  function appEnvValue(name, value) {
    const env = eightEnv().map((row) => (row.name === name ? { name, value } : row));
    return appFacts({ env });
  }
  const fenceMutations = [
    { name: 'EMAIL_LUNA_CONTROLLED_DRAFTING_CLIENT_ID', value: CLIENT2, label: 'clientId' },
    { name: 'EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_ID', value: LOCATION2, label: 'locationId' },
    { name: 'EMAIL_LUNA_CONTROLLED_DRAFTING_ENDPOINT_ID', value: ENDPOINT2, label: 'endpointId' },
    { name: 'EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID', value: MAILBOX2, label: 'mailboxId' },
  ];
  for (let i = 0; i < fenceMutations.length; i += 1) {
    const mutation = fenceMutations[i];
    await assert.rejects(
      () => readWith(hitsTemplate(), {
        readApp(n) {
          return n >= 2 ? appEnvValue(mutation.name, mutation.value) : appFacts();
        },
      }),
      (err) => assertReaderFailure(err, 'revision_drift') || assertReaderFailure(err, 'binding_unproven'),
      `fence mutation ${mutation.label}`,
    );
  }
  await assert.rejects(
    () => readWith(hitsTemplate(), {
      readApp(n) {
        return n >= 2
          ? appFacts({ traffic: [{ revisionName: REVISION, weight: 99 }] })
          : appFacts();
      },
    }),
    (err) => assertReaderFailure(err, 'traffic_ambiguous') || assertReaderFailure(err, 'revision_drift'),
    'fence mutation trafficWeight',
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), {
      query(sql, _params, kind) {
        if (/grant_status/.test(sql)) {
          this._g = (this._g || 0) + 1;
          return { rows: [grantRow(this._g > 1 ? { reconcile_state: '' } : {})] };
        }
        if (/ops_097/.test(sql)) return { rows: [countsRow()] };
        if (/session_fingerprint/.test(sql)) return { rows: [identityRow(kind)] };
        if (/binding_ok/.test(sql)) return { rows: [bindingRow()] };
        if (/'producer'/.test(sql) || /'worker'/.test(sql)) return { rows: [attestRow(kind)] };
        throw new Error(PLANTED);
      },
    }),
    (err) => assertReaderFailure(err, 'reconciliation_needed') || assertReaderFailure(err, 'revision_drift'),
    'fence mutation reconcile_state',
  );
  console.log('  PASS  LOGIN alias/TLS/ACL/grant/tenant/count-drift and fence identity mutations fail closed');

  let t = Date.parse('2026-08-26T00:00:00.000Z');
  await assert.rejects(
    () => readWith(hitsTemplate(), {
      clock: {
        nowMs() {
          const cur = t;
          t += FENCE_MAX_AGE_MS + 1;
          return cur;
        },
      },
    }),
    (err) => assertReaderFailure(err, 'freshness'),
  );
  console.log('  PASS  freshness fence refuses caller-aged reads');

  await assert.rejects(
    () => readWith(hitsTemplate(), {
      readApp() { throw new Error(`boom ${PLANTED} postgres://x:y@h/db eyJhbG`); },
    }),
    (err) => assertReaderFailure(err, 'reader_invalid') || (err.code === ERROR_CODE && noLeak(err)),
  );
  {
    const plantedPkg = new Error(`boom ${PLANTED} postgres://x:y@h/db eyJhbG`);
    plantedPkg.code = ERROR_CODE;
    plantedPkg.detail = 'azure_unproven';
    await assert.rejects(
      () => readWith(hitsTemplate(), { readApp() { throw plantedPkg; } }),
      (err) => err
        && err.code === ERROR_CODE
        && err.message === ERROR_MESSAGE
        && err !== plantedPkg
        && noLeak(err),
    );
  }
  const getterApp = appFacts();
  Object.defineProperty(getterApp, 'image', { get() { return IMAGE; }, enumerable: true });
  await assert.rejects(
    () => readWith(hitsTemplate(), { readApp() { return getterApp; } }),
    (err) => err && err.code === ERROR_CODE && noLeak(err),
  );
  const proxyApp = new Proxy(appFacts(), { get(t0, k) { return t0[k]; } });
  await assert.rejects(
    () => readWith(hitsTemplate(), { readApp() { return proxyApp; } }),
    (err) => err && err.code === ERROR_CODE && noLeak(err),
  );
  const plantedApp = appFacts();
  plantedApp.secret = PLANTED;
  await assert.rejects(
    () => readWith(hitsTemplate(), { readApp() { return plantedApp; } }),
    (err) => err && err.code === ERROR_CODE && noLeak(err),
  );
  console.log('  PASS  planted-secret/accessor/proxy provider failures stay sanitized');

  assert.equal(closedAcrDigestFromManifestResponse({
    status: 200,
    body: '{}',
    digestHeader: DIGEST,
  }), DIGEST);
  await assert.rejects(
    () => Promise.resolve().then(() => closedAcrDigestFromManifestResponse({
      status: 401,
      body: PLANTED,
      digestHeader: DIGEST,
    })),
    (err) => assertReaderFailure(err, 'acr_unproven'),
  );
  await assert.rejects(
    () => Promise.resolve().then(() => closedAcrDigestFromManifestResponse({
      status: 401,
      body: '',
      digestHeader: DIGEST,
    })),
    (err) => assertReaderFailure(err, 'acr_unproven'),
  );
  console.log('  PASS  ACR manifest digest requires HTTP 200; 401-with-header is unproven');

  {
    function makeRecordedHandle(opts = {}) {
      const sql = [];
      let released = 0;
      const handle = {
        async withTransactionClient() {
          throw new Error(`rw_must_not_run ${PLANTED}`);
        },
        async withReadOnlyTransactionClient(work) {
          sql.push('BEGIN READ ONLY');
          if (opts.failBegin) throw new Error(`begin ${PLANTED}`);
          const client = {
            async query(text) {
              sql.push(String(text));
              if (/\bCOMMIT\b/i.test(String(text))) throw new Error('commit_must_not_run');
              return { rows: [], rowCount: 0 };
            },
          };
          let workError = null;
          let workResult;
          try {
            if (opts.failWork) throw new Error(`work ${PLANTED} postgres://x:y@h/db`);
            workResult = await work(client);
          } catch (error) {
            workError = error;
          }
          try {
            sql.push('ROLLBACK');
            if (opts.failRollback) throw new Error(`rollback ${PLANTED}`);
          } catch (error) {
            released += 1;
            throw error;
          }
          released += 1;
          if (workError) throw workError;
          return workResult;
        },
      };
      return { handle, sql, getReleased: () => released };
    }

    const success = makeRecordedHandle();
    const result = await withReadOnlyPreflightClient(success.handle, async (client) => {
      await client.query(COUNT_SQL);
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.deepEqual(success.sql, ['BEGIN READ ONLY', COUNT_SQL, 'ROLLBACK']);
    assert.equal(success.getReleased(), 1);

    const failed = makeRecordedHandle({ failWork: true });
    await assert.rejects(
      () => withReadOnlyPreflightClient(failed.handle, async () => 'nope'),
      (err) => err && err.code === ERROR_CODE && err.detail === 'pg_unproven' && noLeak(err),
    );
    assert.deepEqual(failed.sql, ['BEGIN READ ONLY', 'ROLLBACK']);
    assert.ok(!failed.sql.includes('COMMIT'));

    const rollbackFail = makeRecordedHandle({ failRollback: true });
    await assert.rejects(
      () => withReadOnlyPreflightClient(rollbackFail.handle, async () => 'ok'),
      (err) => err && err.code === ERROR_CODE && err.message === ERROR_MESSAGE && noLeak(err),
    );

    await assert.rejects(
      () => withReadOnlyPreflightClient({
        async withTransactionClient(work) { return work({ async query() { return { rows: [] }; } }); },
      }, async () => 'nope'),
      (err) => assertReaderFailure(err, 'login_unproven'),
    );
    console.log('  PASS  read-only loan SQL is BEGIN READ ONLY / work / ROLLBACK; no nested BEGIN or COMMIT');
  }

  assert.doesNotMatch(ownedSrc, /graph\.microsoft\.com/);
  assert.doesNotMatch(ownedSrc, /login\.microsoftonline\.com/);
  assert.doesNotMatch(ownedSrc, /createReplyDraft|sendMail|getAccessToken/);
  assert.doesNotMatch(ownedSrc, /SET\s+ROLE/i);
  assert.doesNotMatch(ownedSrc, /SET\s+SESSION\s+AUTHORIZATION/i);
  assert.doesNotMatch(ownedSrc, /keyvault\/secrets/i);
  assert.match(ownedSrc, /withReadOnlyTransactionClient/);
  assert.doesNotMatch(ownedSrc, /await queryFn\.call\(client, 'BEGIN READ ONLY'\)/);
  assert.doesNotMatch(ownedSrc, /res\.status !== 401/);
  assert.match(ownedSrc, /LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== true/);
  const pairSrc = fs.readFileSync(
    require.resolve('./lib/email-luna-automation-shadow-worker-connection'),
    'utf8',
  );
  assert.match(pairSrc, /async function withReadOnlyTransactionClient/);
  assert.match(pairSrc, /BEGIN READ ONLY/);
  const roStart = pairSrc.indexOf('async function withReadOnlyTransactionClient');
  const roEnd = pairSrc.indexOf('async function close()', roStart);
  assert.ok(roStart > 0 && roEnd > roStart);
  assert.doesNotMatch(pairSrc.slice(roStart, roEnd), /COMMIT/);
  assert.match(pairSrc.slice(roStart, roEnd), /BEGIN READ ONLY/);
  assert.match(pairSrc.slice(roStart, roEnd), /ROLLBACK/);
  assert.match(IDENTITY_SQL, /session_user/);
  assert.match(GRANT_SQL, /tenant_email_delegated_grants/);
  assert.match(BINDING_SQL, /tenant_channel_endpoints/);
  assert.match(testSupportSrc, /TEST-ONLY/);
  assert.doesNotMatch(testSupportSrc, /process\.env\.[A-Z_]*ADAPTER/);

  const nodeCheck = spawnSync(process.execPath, ['--check',
    path.join(ROOT, 'scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader.js'),
    path.join(ROOT, 'scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader-owned.js'),
    path.join(ROOT, 'scripts/lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader.test-support.js'),
    path.join(ROOT, 'scripts/lib/email-luna-controlled-drafting-live-downscope-prover-canonical-owners.js'),
    path.join(ROOT, 'scripts/lib/email-luna-controlled-drafting-live-downscope-prover.js'),
    path.join(ROOT, 'scripts/lib/email-luna-automation-shadow-worker-connection.js'),
    path.join(ROOT, 'scripts/verify-email-luna-controlled-drafting-live-downscope-prover-live-preflight-reader.js'),
  ], { cwd: ROOT, encoding: 'utf8', env: childEnv() });
  if (nodeCheck.stdout) process.stdout.write(nodeCheck.stdout);
  if (nodeCheck.stderr) process.stderr.write(nodeCheck.stderr);
  assert.equal(nodeCheck.status, 0, 'node --check must pass');
  console.log('ALL OK — Stage 2 Chapter 4H owned preflight reader (zero live actions)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
