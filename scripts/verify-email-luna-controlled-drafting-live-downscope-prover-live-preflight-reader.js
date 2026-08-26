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
const PLANTED = 'planted-NEVER_LEAK-secret';
const PRODUCER_FP = 'aa'.repeat(32);
const WORKER_FP = 'bb'.repeat(32);
const IMAGE = `whstagingacr.azurecr.io/luna-sunset-staff-api:${DEPLOYED_SHA}`;
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
  assert.equal(typeof ownedCore.createOwnedSunsetStagingLivePreflightReader, 'function');
  assert.equal(typeof createSunsetStagingLivePreflightReaderForTests, 'function');
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
    (err) => assertReaderFailure(err, 'source_test_cannot_consume_live_azure_pg'),
  );
  console.log('  PASS  RED/GREEN: forged/caller snapshot cannot mint owned brand; production path refused in tests');

  const hits = hitsTemplate();
  const evidence = await readWith(hits);
  assert.equal(isIndependentLivePreflight(evidence), true);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.independent_read, true);
  assert.equal(evidence.digest, DIGEST);
  assert.equal(evidence.deploy_sha, DEPLOYED_SHA);
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
  assert.equal(Object.prototype.hasOwnProperty.call(evidence, 'dsn'), false);
  assert.equal(noLeak(evidence), true);
  assert.ok(hits.app >= 2, 'double-read azure app');
  assert.ok(hits.acr >= 2, 'double-read acr digest');
  assert.ok(hits.countSql >= 2, 'double-read SQL counts');
  assert.ok(hits.producer >= 2 && hits.worker >= 2);
  assert.equal(hits.writes, 0);
  assert.match(COUNT_SQL, /COUNT\(\*\)/);
  assert.match(ownedSrc, /await acr\.readManifestDigest/);
  assert.match(ownedSrc, /COUNT_SQL/);
  assert.match(ownedSrc, /literalFalseEnv/);
  console.log('  PASS  owned reader calls adapters and derives digest/flags/counts');

  await assert.rejects(
    () => readWith(hitsTemplate(), { digest: 'sha256:00d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a' }),
    (err) => assertReaderFailure(err, 'digest_mismatch'),
  );
  await assert.rejects(
    () => readWith(hitsTemplate(), { counts: { ops_097: 1 } }),
    (err) => assertReaderFailure(err, 'counts_nonzero'),
  );
  console.log('  PASS  mutation: ACR/count substitution cannot fall back to hardcoded pins');

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
  console.log('  PASS  LOGIN alias/TLS/ACL/grant/tenant/count-drift fail closed');

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

  assert.doesNotMatch(ownedSrc, /graph\.microsoft\.com/);
  assert.doesNotMatch(ownedSrc, /login\.microsoftonline\.com/);
  assert.doesNotMatch(ownedSrc, /createReplyDraft|sendMail|getAccessToken/);
  assert.doesNotMatch(ownedSrc, /SET\s+ROLE/i);
  assert.doesNotMatch(ownedSrc, /SET\s+SESSION\s+AUTHORIZATION/i);
  assert.doesNotMatch(ownedSrc, /keyvault\/secrets/i);
  assert.match(ownedSrc, /BEGIN READ ONLY/);
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
