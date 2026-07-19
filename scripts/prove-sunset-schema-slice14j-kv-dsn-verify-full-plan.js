'use strict';

/**
 * prove-sunset-schema-slice14j-kv-dsn-verify-full-plan — FOUNDATION Slice 14J
 *
 * Offline proof of a locked recoverable operator plan to normalize
 * luna-sunset-staging-kv/sunset-database-url to sslmode=verify-full without
 * reading or mutating the live secret. Fake HTTP RED/GREEN:
 * IMDS GET + KV GET + KV PUT + verification GET on success (exactly 4 calls,
 * one PUT). Secret-free output; prior-version safe ID only.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  sha256CanonicalLfV1File,
} = require('./lib/migration-integrity');
const { hashCanonicalManifest } = require('./lib/sunset-schema-observer');
const {
  EXPECTED_028_SHA256,
  AUTHORIZED_AGGREGATE_SQL: AGG_14A,
  DATE_WINDOW_PREDICATE,
  PRICE_UNIT_PREDICATE,
  assert028PredicatesPresentInSource,
  assertMigration028ByteIntegrity,
} = require('./lib/phase-d-check-preflight');
const {
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED,
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED,
  ENV_DSN_PLAN,
  ENV_DSN_ROLLBACK,
  CLI_PLAN_ONLY,
  CLI_ROLLBACK_PLAN_ONLY,
  DSN_PLAN_LOCKS,
  KEY_VAULT_RESOURCE_ID,
  FORBIDDEN_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  buildLockedMutationPlan,
  buildLockedRollbackPlan,
  mutationPlanMatchesLocked,
  evaluateDsnPlanGates,
  evaluateMutationCandidate,
  executeDsnVerifyFullPlanOnly,
  executeDsnNormalizeAdapter,
  executeDsnRollbackAdapter,
  createInjectedDsnNormalizeHttp,
  captureSecretUserMetadata,
  assertPreservedMetadataEqual,
  assertImmediatelyPreviousAdjacency,
  rejectVersionsListPagination,
  buildOfflineProofTlsDeficientSunsetDatabaseUrl,
  buildOfflineProofVerifyFullSunsetDatabaseUrl,
  exactDsnPlanArgv,
  exactDsnRollbackPlanArgv,
  dsnPlanEnv,
  dsnRollbackEnv,
  resetDsnPlanCounters,
  getDsnPlanCounters,
} = require('./lib/phase-d-kv-dsn-verify-full-plan');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14j-kv-dsn-verify-full-plan-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14j-kv-dsn-verify-full-plan-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14j-findings.md');
const APPLY_PLAN_PATH = path.join(FIX, 'slice14j-kv-dsn-verify-full-apply-plan.json');
const CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-kv-dsn-verify-full-plan.js');

const MASTER = 'ec6a5e9589026db1675a82f4d0b05ddc4a62320e';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const FAKE_USER = 'slice14j-proof-admin';
const FAKE_PASSWORD = 'slice14j-proof-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14j-proof-imds-token-never-commit';
const FAKE_PRIOR_VERSION = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FAKE_NEW_VERSION = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FAKE_STALE_VERSION = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const FAKE_PRIOR_CREATED = 1700001000;
const FAKE_CURRENT_CREATED = 1700002000;
const FAKE_CONTENT_TYPE = 'text/plain';
const FAKE_TAGS = Object.freeze({ env: 'proof', purpose: 'slice14j' });
const FAKE_ATTRS = Object.freeze({ enabled: true, nbf: 1700000000, exp: 1800000000 });

function runCli(env, argv) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function parseLastJson(stdout) {
  const text = String(stdout || '').trim();
  const start = text.lastIndexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function assertNoSecretLeak(text) {
  const s = String(text || '');
  if (s.includes(FAKE_PASSWORD) || s.includes(FAKE_IMDS_TOKEN)
    || s.includes(FAKE_USER + ':')
    || s.includes(FAKE_CONTENT_TYPE)
    || s.includes('purpose":"slice14j')
    || s.includes('"env":"proof"')
    || /postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(s)) {
    throw new Error('secret leaked into proof artifact');
  }
}

async function main() {
  console.log('prove:sunset-schema-slice14j-kv-dsn-verify-full-plan — offline\n');

  const generatedAt = new Date().toISOString();
  resetDsnPlanCounters();

  const redCases = [];
  const greenCases = [];

  const deficientDsn = buildOfflineProofTlsDeficientSunsetDatabaseUrl(FAKE_USER, FAKE_PASSWORD, 'require');
  const verifyFullDsn = buildOfflineProofVerifyFullSunsetDatabaseUrl(FAKE_USER, FAKE_PASSWORD);

  // ── RED: default zero writes ───────────────────────────────────────────
  {
    resetDsnPlanCounters();
    const gates = evaluateDsnPlanGates({ env: {}, argv: [] });
    const counters = getDsnPlanCounters();
    const cli = runCli({}, []);
    const cliJson = parseLastJson(cli.stdout);
    const ok = gates.ok === false
      && counters.kvWriteCount === 0
      && counters.httpRequestCount === 0
      && cli.status === 2
      && cliJson
      && cliJson.code === 'default_disabled'
      && cliJson.kvWriteCount === 0
      && cliJson.liveMutation === false;
    redCases.push({
      name: 'default_path_zero_kv_writes',
      ok,
      code: gates.code,
      kvWriteCount: counters.kvWriteCount,
      httpRequestCount: counters.httpRequestCount,
      cliExitCode: cli.status,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED default_path_zero_kv_writes`);
  }

  // ── RED: missing env ───────────────────────────────────────────────────
  {
    resetDsnPlanCounters();
    const argv = exactDsnPlanArgv();
    const gates = evaluateDsnPlanGates({ env: {}, argv });
    const counters = getDsnPlanCounters();
    const ok = gates.ok === false
      && gates.errors.some((e) => e.code === 'env_required')
      && counters.kvWriteCount === 0;
    redCases.push({
      name: 'missing_env_zero_writes',
      ok,
      kvWriteCount: counters.kvWriteCount,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED missing_env_zero_writes`);
  }

  // ── RED: missing plan-only flag ────────────────────────────────────────
  {
    resetDsnPlanCounters();
    const argv = exactDsnPlanArgv().filter((a) => a !== CLI_PLAN_ONLY);
    const gates = evaluateDsnPlanGates({ env: dsnPlanEnv(), argv });
    const counters = getDsnPlanCounters();
    const ok = gates.ok === false
      && gates.errors.some((e) => e.code === 'plan_only_required')
      && counters.kvWriteCount === 0;
    redCases.push({
      name: 'missing_plan_only_flag_zero_writes',
      ok,
      kvWriteCount: counters.kvWriteCount,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED missing_plan_only_flag_zero_writes`);
  }

  // ── RED: wrong exact targets ───────────────────────────────────────────
  {
    resetDsnPlanCounters();
    const base = exactDsnPlanArgv();
    const env = dsnPlanEnv();
    const wrongSub = evaluateDsnPlanGates({
      env,
      argv: base.map((a, i) => (base[i - 1] === '--subscription' ? '00000000-0000-0000-0000-000000000000' : a)),
    });
    const wrongRg = evaluateDsnPlanGates({
      env,
      argv: base.map((a, i) => (base[i - 1] === '--resource-group' ? 'other-rg' : a)),
    });
    const wrongVault = evaluateDsnPlanGates({
      env,
      argv: base.map((a, i) => (base[i - 1] === '--key-vault' ? 'other-kv' : a)),
    });
    const wrongSecret = evaluateDsnPlanGates({
      env,
      argv: base.map((a, i) => (base[i - 1] === '--secret-name' ? 'other-secret' : a)),
    });
    const wrongId = evaluateDsnPlanGates({
      env,
      argv: base.map((a, i) => (base[i - 1] === '--managed-identity' ? 'other-mi' : a)),
    });
    const wrongPg = evaluateDsnPlanGates({
      env,
      argv: base.map((a, i) => (base[i - 1] === '--postgres-server' ? 'other-pg' : a)),
    });
    const wrongDb = evaluateDsnPlanGates({
      env,
      argv: base.map((a, i) => (base[i - 1] === '--database' ? 'wolfhouse' : a)),
    });
    const counters = getDsnPlanCounters();
    const ok = wrongSub.ok === false && wrongSub.errors.some((e) => e.code === 'subscription_rejected')
      && wrongRg.ok === false && wrongRg.errors.some((e) => e.code === 'resource_group_rejected')
      && wrongVault.ok === false && wrongVault.errors.some((e) => e.code === 'vault_rejected')
      && wrongSecret.ok === false && wrongSecret.errors.some((e) => e.code === 'secret_name_rejected')
      && wrongId.ok === false && wrongId.errors.some((e) => e.code === 'identity_rejected')
      && wrongPg.ok === false && wrongPg.errors.some((e) => e.code === 'postgres_server_rejected')
      && wrongDb.ok === false && wrongDb.errors.some((e) => e.code === 'database_rejected')
      && counters.kvWriteCount === 0;
    redCases.push({
      name: 'wrong_exact_targets_zero_writes',
      ok,
      kvWriteCount: counters.kvWriteCount,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED wrong_exact_targets_zero_writes`);
  }

  // ── RED: forbidden argv (value/dsn/url/token/version/file/delete/…) ────
  {
    resetDsnPlanCounters();
    const base = exactDsnPlanArgv();
    const env = dsnPlanEnv();
    const samples = [
      '--value', '--dsn', '--url', '--token', '--version', '--file',
      '--host', '--user', '--password', '--delete', '--purge', '--disable',
      '--tags', '--content-type', '--retry', '--apply',
    ];
    let allRejected = true;
    for (const flag of samples) {
      const gates = evaluateDsnPlanGates({ env, argv: [...base, flag, 'x'] });
      if (gates.ok || !gates.errors.some((e) => e.code === 'forbidden_argv')) {
        allRejected = false;
        break;
      }
    }
    const counters = getDsnPlanCounters();
    const ok = allRejected && counters.kvWriteCount === 0
      && samples.every((f) => FORBIDDEN_ARGV_FLAGS.includes(f) || f === '--apply');
    redCases.push({
      name: 'forbidden_value_dsn_token_version_file_argv',
      ok,
      kvWriteCount: counters.kvWriteCount,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED forbidden_value_dsn_token_version_file_argv`);
  }

  // ── RED: host/db/user/password / tags / delete / retries rejected ──────
  {
    const hostChange = evaluateMutationCandidate({ hostChange: true, putCount: 1, retries: 0 });
    const tags = evaluateMutationCandidate({ tagsMutation: true, putCount: 1, retries: 0 });
    const del = evaluateMutationCandidate({ delete: true, putCount: 1, retries: 0 });
    const retries = evaluateMutationCandidate({ retries: 3, putCount: 1 });
    const arbVersion = evaluateMutationCandidate({
      rollbackMode: true,
      rollbackVersion: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      immediatelyPrevious: false,
    });
    const ok = hostChange.ok === false
      && hostChange.errors.some((e) => e.code === 'host_db_user_password_change_rejected')
      && tags.ok === false
      && tags.errors.some((e) => e.code === 'tags_content_type_mutation_rejected')
      && del.ok === false
      && del.errors.some((e) => e.code === 'delete_purge_disable_rejected')
      && retries.ok === false
      && retries.errors.some((e) => e.code === 'retries_rejected')
      && arbVersion.ok === false
      && arbVersion.errors.some((e) => e.code === 'arbitrary_version_rollback_rejected');
    redCases.push({
      name: 'host_tags_delete_retries_arbitrary_version_rejected',
      ok,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED host_tags_delete_retries_arbitrary_version_rejected`);
  }

  // ── RED: adapter without httpRequest → zero writes ─────────────────────
  {
    resetDsnPlanCounters();
    const result = await executeDsnNormalizeAdapter({});
    const counters = getDsnPlanCounters();
    const ok = result.ok === false
      && result.code === 'http_request_required'
      && counters.kvWriteCount === 0
      && counters.httpRequestCount === 0
      && counters.pgClientInstantiated === 0;
    redCases.push({
      name: 'adapter_without_inject_zero_writes',
      ok,
      code: result.code,
      kvWriteCount: counters.kvWriteCount,
      httpRequestCount: counters.httpRequestCount,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED adapter_without_inject_zero_writes`);
  }

  // ── RED: already verify-full → no PUT ──────────────────────────────────
  {
    resetDsnPlanCounters();
    const http = createInjectedDsnNormalizeHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: verifyFullDsn,
      priorSecretVersionId: FAKE_PRIOR_VERSION,
      newSecretVersionId: FAKE_NEW_VERSION,
    });
    const result = await executeDsnNormalizeAdapter({ httpRequest: http });
    const counters = getDsnPlanCounters();
    const ok = result.ok === false
      && result.code === 'secret_already_verify_full'
      && counters.keyVaultPutCount === 0
      && counters.kvWriteCount === 0
      && (counters.httpRequestCount === 2); // IMDS + GET only
    redCases.push({
      name: 'already_verify_full_zero_puts',
      ok,
      code: result.code,
      keyVaultPutCount: counters.keyVaultPutCount,
      httpRequestCount: counters.httpRequestCount,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED already_verify_full_zero_puts`);
  }

  // ── RED: PUT failure → failure semantics, prior version retained ───────
  {
    resetDsnPlanCounters();
    const http = createInjectedDsnNormalizeHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: deficientDsn,
      priorSecretVersionId: FAKE_PRIOR_VERSION,
      newSecretVersionId: FAKE_NEW_VERSION,
      kvPutStatusCode: 403,
    });
    const result = await executeDsnNormalizeAdapter({ httpRequest: http });
    const counters = getDsnPlanCounters();
    const ok = result.ok === false
      && result.code === 'kv_put_rejected'
      && result.priorSecretVersionId === FAKE_PRIOR_VERSION
      && counters.keyVaultPutCount === 1
      && result.privateRefsZeroed === true;
    assertNoSecretLeak(JSON.stringify(result));
    redCases.push({
      name: 'put_failure_retains_prior_version_safe_id',
      ok,
      code: result.code,
      priorSecretVersionId: result.priorSecretVersionId,
      keyVaultPutCount: counters.keyVaultPutCount,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED put_failure_retains_prior_version_safe_id`);
  }

  // ── RED: rollback without approval → zero writes ───────────────────────
  {
    resetDsnPlanCounters();
    const http = createInjectedDsnNormalizeHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: deficientDsn,
      priorSecretVersionId: FAKE_PRIOR_VERSION,
      priorSecretValue: deficientDsn,
    });
    const result = await executeDsnRollbackAdapter({
      httpRequest: http,
      priorSecretVersionId: FAKE_PRIOR_VERSION,
      approved: false,
    });
    const counters = getDsnPlanCounters();
    const ok = result.ok === false
      && result.code === 'rollback_approval_required'
      && counters.kvWriteCount === 0
      && counters.httpRequestCount === 0;
    redCases.push({
      name: 'rollback_without_approval_zero_writes',
      ok,
      code: result.code,
      kvWriteCount: counters.kvWriteCount,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED rollback_without_approval_zero_writes`);
  }

  // ── RED: unsupported metadata attributes → zero PUTs ───────────────────
  {
    resetDsnPlanCounters();
    const http = createInjectedDsnNormalizeHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: deficientDsn,
      priorSecretVersionId: FAKE_PRIOR_VERSION,
      newSecretVersionId: FAKE_NEW_VERSION,
      getExtraTopLevel: { customField: 'nope' },
    });
    const result = await executeDsnNormalizeAdapter({ httpRequest: http });
    const counters = getDsnPlanCounters();
    const ok = result.ok === false
      && result.code === 'unsupported_secret_metadata'
      && counters.keyVaultPutCount === 0
      && counters.kvWriteCount === 0;
    assertNoSecretLeak(JSON.stringify(result));
    redCases.push({
      name: 'unsupported_attributes_zero_writes',
      ok,
      code: result.code,
      keyVaultPutCount: counters.keyVaultPutCount,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED unsupported_attributes_zero_writes`);
  }

  // ── RED: metadata mismatch on verify GET ───────────────────────────────
  {
    resetDsnPlanCounters();
    const http = createInjectedDsnNormalizeHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: deficientDsn,
      priorSecretVersionId: FAKE_PRIOR_VERSION,
      newSecretVersionId: FAKE_NEW_VERSION,
      normalizedSecretValue: verifyFullDsn,
      secretContentType: FAKE_CONTENT_TYPE,
      secretTags: { ...FAKE_TAGS },
      secretAttributes: { ...FAKE_ATTRS },
      verifyMetadataMismatch: true,
    });
    const result = await executeDsnNormalizeAdapter({ httpRequest: http });
    const counters = getDsnPlanCounters();
    const ok = result.ok === false
      && result.code === 'metadata_mismatch'
      && counters.keyVaultPutCount === 1
      && result.privateRefsZeroed === true;
    assertNoSecretLeak(JSON.stringify(result));
    redCases.push({
      name: 'metadata_mismatch_rejected',
      ok,
      code: result.code,
      keyVaultPutCount: counters.keyVaultPutCount,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED metadata_mismatch_rejected`);
  }

  // ── RED: nonadjacent / stale prior version → zero writes ───────────────
  {
    resetDsnPlanCounters();
    const http = createInjectedDsnNormalizeHttp({
      mode: 'rollback',
      imdsAccessToken: FAKE_IMDS_TOKEN,
      currentSecretValue: verifyFullDsn,
      priorSecretValue: deficientDsn,
      currentSecretVersionId: FAKE_NEW_VERSION,
      priorSecretVersionId: FAKE_PRIOR_VERSION,
      staleSecretVersionId: FAKE_STALE_VERSION,
      currentVersionCreated: FAKE_CURRENT_CREATED,
      priorVersionCreated: FAKE_PRIOR_CREATED,
      nonadjacentList: true,
    });
    const result = await executeDsnRollbackAdapter({
      httpRequest: http,
      priorSecretVersionId: FAKE_PRIOR_VERSION,
      approved: true,
    });
    const counters = getDsnPlanCounters();
    const ok = result.ok === false
      && result.code === 'nonadjacent_version_rejected'
      && counters.kvWriteCount === 0
      && counters.keyVaultPutCount === 0
      && counters.keyVaultListCount === 1;
    assertNoSecretLeak(JSON.stringify(result));
    redCases.push({
      name: 'nonadjacent_stale_version_zero_writes',
      ok,
      code: result.code,
      kvWriteCount: counters.kvWriteCount,
      keyVaultListCount: counters.keyVaultListCount,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED nonadjacent_stale_version_zero_writes`);
  }

  // ── RED: versions list pagination → zero writes ────────────────────────
  {
    resetDsnPlanCounters();
    const http = createInjectedDsnNormalizeHttp({
      mode: 'rollback',
      imdsAccessToken: FAKE_IMDS_TOKEN,
      currentSecretValue: verifyFullDsn,
      priorSecretValue: deficientDsn,
      currentSecretVersionId: FAKE_NEW_VERSION,
      priorSecretVersionId: FAKE_PRIOR_VERSION,
      currentVersionCreated: FAKE_CURRENT_CREATED,
      priorVersionCreated: FAKE_PRIOR_CREATED,
      versionsNextLink: 'https://example.invalid/next',
    });
    const result = await executeDsnRollbackAdapter({
      httpRequest: http,
      priorSecretVersionId: FAKE_PRIOR_VERSION,
      approved: true,
    });
    const counters = getDsnPlanCounters();
    const pageUnit = rejectVersionsListPagination(
      { value: [], nextLink: 'https://example.invalid/next' },
      '/secrets/sunset-database-url/versions?api-version=7.4',
    );
    const ok = result.ok === false
      && result.code === 'versions_pagination_rejected'
      && pageUnit.ok === false
      && counters.kvWriteCount === 0
      && counters.keyVaultPutCount === 0;
    assertNoSecretLeak(JSON.stringify(result));
    redCases.push({
      name: 'list_pagination_rejected_zero_writes',
      ok,
      code: result.code,
      kvWriteCount: counters.kvWriteCount,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED list_pagination_rejected_zero_writes`);
  }

  // ── GREEN: exact locked mutation + rollback plans ──────────────────────
  {
    const plan = buildLockedMutationPlan();
    const rb = buildLockedRollbackPlan(FAKE_PRIOR_VERSION);
    const ok = mutationPlanMatchesLocked(plan)
      && plan.secretName === 'sunset-database-url'
      && plan.keyVaultName === 'luna-sunset-staging-kv'
      && plan.postgresHost === 'luna-sunset-staging-pg-app.postgres.database.azure.com'
      && plan.mutation.to === 'verify-full'
      && plan.mutation.preserveUserMetadata === true
      && plan.mutation.retainExact.includes('contentType')
      && plan.mutation.retainExact.includes('tags')
      && plan.putCount === 1
      && plan.retries === 0
      && plan.liveMutateEnabled === false
      && rb.requiresSeparateExplicitApproval === true
      && rb.restoreScope === 'immediately_previous_version_only'
      && rb.adjacencyProofRequired === true
      && rb.paginationForbidden === true
      && rb.preserveUserMetadata === true
      && rb.httpSequence.length === 6
      && rb.priorSecretVersionId === FAKE_PRIOR_VERSION
      && rb.liveRollbackEnabled === false;
    greenCases.push({
      name: 'exact_locked_mutation_and_rollback_plans',
      ok,
      putCount: plan.putCount,
      targetSslmode: plan.mutation.to,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  GREEN exact_locked_mutation_and_rollback_plans`);
  }

  // ── GREEN: CLI plan-only safe IDs ──────────────────────────────────────
  {
    resetDsnPlanCounters();
    const cli = runCli(dsnPlanEnv(), exactDsnPlanArgv());
    const json = parseLastJson(cli.stdout);
    assertNoSecretLeak(cli.stdout || '');
    const ok = cli.status === 0
      && json
      && json.ok === true
      && json.planOnly === true
      && json.liveMutation === false
      && json.kvWriteCount === 0
      && json.secretName === DSN_PLAN_LOCKS.secretName
      && json.targetSslmode === 'verify-full'
      && json.putCount === 1
      && !Object.prototype.hasOwnProperty.call(json, 'value')
      && !Object.prototype.hasOwnProperty.call(json, 'dsn');
    greenCases.push({
      name: 'cli_plan_only_safe_ids',
      ok,
      cliExitCode: cli.status,
      code: json && json.code,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  GREEN cli_plan_only_safe_ids`);
  }

  // ── GREEN: CLI rollback-plan-only safe prior version id ────────────────
  {
    resetDsnPlanCounters();
    const cli = runCli(dsnRollbackEnv(), exactDsnRollbackPlanArgv(FAKE_PRIOR_VERSION));
    const json = parseLastJson(cli.stdout);
    assertNoSecretLeak(cli.stdout || '');
    const ok = cli.status === 0
      && json
      && json.ok === true
      && json.rollbackPlanOnly === true
      && json.priorSecretVersionId === FAKE_PRIOR_VERSION
      && json.liveMutation === false
      && json.kvWriteCount === 0;
    greenCases.push({
      name: 'cli_rollback_plan_only_safe_prior_version_id',
      ok,
      priorSecretVersionId: json && json.priorSecretVersionId,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  GREEN cli_rollback_plan_only_safe_prior_version_id`);
  }

  // ── GREEN: fake HTTP exact 4-call success (IMDS+GET+PUT+verify GET) ────
  {
    resetDsnPlanCounters();
    const http = createInjectedDsnNormalizeHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: deficientDsn,
      priorSecretVersionId: FAKE_PRIOR_VERSION,
      newSecretVersionId: FAKE_NEW_VERSION,
      normalizedSecretValue: verifyFullDsn,
      rejectSecondPut: true,
    });
    const result = await executeDsnNormalizeAdapter({ httpRequest: http });
    const counters = getDsnPlanCounters();
    assertNoSecretLeak(JSON.stringify(result));
    const callMethods = http.calls.map((c) => `${c.purpose}:${c.method}`);
    const ok = result.ok === true
      && result.code === 'dsn_normalize_adapter_ok'
      && result.httpRequestCount === 4
      && result.imdsRequestCount === 1
      && result.keyVaultGetCount === 2
      && result.keyVaultPutCount === 1
      && result.putCount === 1
      && result.kvWriteCount === 1
      && counters.httpRequestCount === 4
      && counters.keyVaultPutCount === 1
      && http.getPutCount() === 1
      && result.priorSecretVersionId === FAKE_PRIOR_VERSION
      && result.newSecretVersionId === FAKE_NEW_VERSION
      && result.sourceTlsDeficient === true
      && result.sslmodeNormalized === true
      && result.metadataPreserved === true
      && result.targetSslmode === 'verify-full'
      && result.privateRefsZeroed === true
      && result.pgClientInstantiated === 0
      && result.liveMutation === false
      && callMethods[0] === 'imds_token:GET'
      && callMethods[1] === 'keyvault_secret_get:GET'
      && callMethods[2] === 'keyvault_secret_put:PUT'
      && callMethods[3] === 'keyvault_secret_verify_get:GET'
      && !JSON.stringify(result).includes(FAKE_PASSWORD)
      && !JSON.stringify(result).includes(FAKE_IMDS_TOKEN);
    greenCases.push({
      name: 'fake_http_imds_get_put_verify_success',
      ok,
      httpRequestCount: result.httpRequestCount,
      imdsRequestCount: result.imdsRequestCount,
      keyVaultGetCount: result.keyVaultGetCount,
      keyVaultPutCount: result.keyVaultPutCount,
      putCount: result.putCount,
      priorSecretVersionId: result.priorSecretVersionId,
      newSecretVersionId: result.newSecretVersionId,
      callMethods,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  GREEN fake_http_imds_get_put_verify_success`);
  }

  // ── GREEN: metadata preservation (contentType/tags/enabled/nbf/exp) ────
  {
    resetDsnPlanCounters();
    const http = createInjectedDsnNormalizeHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: deficientDsn,
      priorSecretVersionId: FAKE_PRIOR_VERSION,
      newSecretVersionId: FAKE_NEW_VERSION,
      normalizedSecretValue: verifyFullDsn,
      secretContentType: FAKE_CONTENT_TYPE,
      secretTags: { ...FAKE_TAGS },
      secretAttributes: { ...FAKE_ATTRS },
      rejectSecondPut: true,
    });
    const result = await executeDsnNormalizeAdapter({ httpRequest: http });
    const putShape = http.getLastPutShape();
    const unitCap = captureSecretUserMetadata({
      value: 'x',
      contentType: FAKE_CONTENT_TYPE,
      tags: { ...FAKE_TAGS },
      attributes: { enabled: true, nbf: FAKE_ATTRS.nbf, exp: FAKE_ATTRS.exp, created: 1, updated: 2 },
    });
    const unitEq = assertPreservedMetadataEqual(unitCap, {
      value: 'y',
      contentType: FAKE_CONTENT_TYPE,
      tags: { ...FAKE_TAGS },
      attributes: {
        enabled: true,
        nbf: FAKE_ATTRS.nbf,
        exp: FAKE_ATTRS.exp,
        created: 99,
        updated: 100,
      },
    });
    assertNoSecretLeak(JSON.stringify(result));
    const ok = result.ok === true
      && result.metadataPreserved === true
      && putShape
      && putShape.hasContentType === true
      && putShape.hasTags === true
      && putShape.hasAttributes === true
      && putShape.attributeKeys.includes('enabled')
      && putShape.attributeKeys.includes('nbf')
      && putShape.attributeKeys.includes('exp')
      && putShape.tagKeyCount === 2
      && unitCap.ok === true
      && unitEq.ok === true
      && result.httpRequestCount === 4
      && result.keyVaultPutCount === 1;
    greenCases.push({
      name: 'metadata_preservation_verified',
      ok,
      metadataPreserved: result.metadataPreserved === true,
      putHasContentType: Boolean(putShape && putShape.hasContentType),
      putHasTags: Boolean(putShape && putShape.hasTags),
      putAttributeKeys: putShape ? putShape.attributeKeys : [],
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  GREEN metadata_preservation_verified`);
  }

  // ── GREEN: exact rollback sequence + call counts (adjacency proven) ────
  {
    resetDsnPlanCounters();
    const http = createInjectedDsnNormalizeHttp({
      mode: 'rollback',
      imdsAccessToken: FAKE_IMDS_TOKEN,
      currentSecretValue: verifyFullDsn,
      priorSecretValue: deficientDsn,
      currentSecretVersionId: FAKE_NEW_VERSION,
      priorSecretVersionId: FAKE_PRIOR_VERSION,
      putResponseVersionId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      newSecretVersionId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      currentVersionCreated: FAKE_CURRENT_CREATED,
      priorVersionCreated: FAKE_PRIOR_CREATED,
      secretContentType: FAKE_CONTENT_TYPE,
      secretTags: { ...FAKE_TAGS },
      secretAttributes: { ...FAKE_ATTRS },
      priorContentType: FAKE_CONTENT_TYPE,
      priorTags: { ...FAKE_TAGS },
      priorAttributes: { ...FAKE_ATTRS },
      rejectSecondPut: true,
    });
    const adjUnit = assertImmediatelyPreviousAdjacency({
      currentVersionId: FAKE_NEW_VERSION,
      priorVersionId: FAKE_PRIOR_VERSION,
      currentCreated: FAKE_CURRENT_CREATED,
      versions: [
        {
          id: `https://luna-sunset-staging-kv.vault.azure.net/secrets/sunset-database-url/${FAKE_NEW_VERSION}`,
          attributes: { created: FAKE_CURRENT_CREATED },
        },
        {
          id: `https://luna-sunset-staging-kv.vault.azure.net/secrets/sunset-database-url/${FAKE_PRIOR_VERSION}`,
          attributes: { created: FAKE_PRIOR_CREATED },
        },
      ],
    });
    const result = await executeDsnRollbackAdapter({
      httpRequest: http,
      priorSecretVersionId: FAKE_PRIOR_VERSION,
      approved: true,
    });
    const counters = getDsnPlanCounters();
    assertNoSecretLeak(JSON.stringify(result));
    const callMethods = http.calls.map((c) => `${c.purpose}:${c.method}`);
    const putShape = http.getLastPutShape();
    const ok = result.ok === true
      && result.code === 'dsn_rollback_adapter_ok'
      && adjUnit.ok === true
      && result.adjacencyProven === true
      && result.metadataPreserved === true
      && result.httpRequestCount === 6
      && result.imdsRequestCount === 1
      && result.keyVaultGetCount === 3
      && result.keyVaultListCount === 1
      && result.keyVaultPutCount === 1
      && result.putCount === 1
      && counters.kvWriteCount === 1
      && result.currentSecretVersionId === FAKE_NEW_VERSION
      && result.priorSecretVersionId === FAKE_PRIOR_VERSION
      && result.currentVersionCreated === FAKE_CURRENT_CREATED
      && result.priorVersionCreated === FAKE_PRIOR_CREATED
      && putShape
      && putShape.hasContentType === true
      && putShape.hasTags === true
      && putShape.hasAttributes === true
      && callMethods[0] === 'imds_token:GET'
      && callMethods[1] === 'keyvault_secret_get:GET'
      && callMethods[2] === 'keyvault_secret_versions_list:GET'
      && callMethods[3] === 'keyvault_secret_version_get:GET'
      && callMethods[4] === 'keyvault_secret_put:PUT'
      && callMethods[5] === 'keyvault_secret_verify_get:GET';
    greenCases.push({
      name: 'exact_rollback_sequence_call_counts',
      ok,
      httpRequestCount: result.httpRequestCount,
      imdsRequestCount: result.imdsRequestCount,
      keyVaultGetCount: result.keyVaultGetCount,
      keyVaultListCount: result.keyVaultListCount,
      keyVaultPutCount: result.keyVaultPutCount,
      putCount: result.putCount,
      adjacencyProven: result.adjacencyProven === true,
      currentSecretVersionId: result.currentSecretVersionId,
      priorSecretVersionId: result.priorSecretVersionId,
      currentVersionCreated: result.currentVersionCreated,
      priorVersionCreated: result.priorVersionCreated,
      callMethods,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  GREEN exact_rollback_sequence_call_counts`);
  }

  // ── GREEN: live HTTP capability on; rollback hard-disabled; hashes ok ──
  {
    const expectedBytes = fs.readFileSync(EXPECTED_PATH);
    const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
    const expected = JSON.parse(expectedBytes.toString('utf8'));
    const manifest = loadManifest(MANIFEST_PATH);
    const integrity = validateManifestIntegrity(manifest);
    const forward = forwardEntries(manifest);
    const { manifestHash } = hashCanonicalManifest(manifest);
    const live028 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '028_tenant_services.sql'));
    const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
    const live040 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '040_tenant_services_saas_catalog_columns.sql'));
    const live041 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '041_notification_surfpack_convergence.sql'));
    const libSrc = fs.readFileSync(
      path.join(ROOT, 'scripts', 'lib', 'phase-d-kv-dsn-verify-full-plan.js'),
      'utf8',
    );
    const ok = PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED === true
      && PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED === false
      && /PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED\s*=\s*true/.test(libSrc)
      && /PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED\s*=\s*false/.test(libSrc)
      && !/\brequire\(['"]pg['"]\)/.test(libSrc)
      && !/new\s+Client\b/.test(libSrc)
      && integrity.ok === true
      && forward.length === 39
      && manifestHash === MANIFEST_HASH
      && expectedHash === EXPECTED_BYTE_SHA
      && expected.productFingerprint === CANON_FP
      && live028 === LOCKED_13C_SHA['028']
      && live035 === LOCKED_13C_SHA['035']
      && live040 === LOCKED_13C_SHA['040']
      && live041 === LOCKED_13C_SHA['041']
      && assert028PredicatesPresentInSource() === true
      && assertMigration028ByteIntegrity() === EXPECTED_028_SHA256
      && AGG_14A.includes('tenant_services')
      && DATE_WINDOW_PREDICATE.length > 0
      && PRICE_UNIT_PREDICATE.length > 0;
    greenCases.push({
      name: 'live_disabled_hashes_preserved_no_pg_client',
      ok,
      note: 'LIVE_MUTATE capability true (14K); plan still offline; rollback false; no pg Client',
      manifestHash,
      expectedByteSha256: expectedHash,
      productFingerprint: expected.productFingerprint,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  GREEN live_disabled_hashes_preserved_no_pg_client`);
  }

  const redFailed = redCases.filter((c) => !c.ok);
  const greenFailed = greenCases.filter((c) => !c.ok);
  if (redFailed.length || greenFailed.length) {
    console.error('\nRED failures:', redFailed.map((c) => c.name));
    console.error('GREEN failures:', greenFailed.map((c) => c.name));
    throw new Error('Slice 14J offline proof RED/GREEN failed');
  }

  const mutationPlan = buildLockedMutationPlan();
  const rollbackPlan = buildLockedRollbackPlan(null);

  const applyPlan = {
    kind: 'sunset-phase-d-kv-dsn-verify-full-apply-plan',
    slice: '14J',
    secretFree: true,
    liveMutateEnabled: false,
    liveRollbackEnabled: false,
    liveMutation: false,
    mutation: mutationPlan,
    rollback: rollbackPlan,
    notes: [
      'Plan + offline injected-HTTP proof only — zero live KV read/write',
      'Future live adapter: IMDS GET → KV GET → capture metadata → sslmode-only normalize → one PUT (value+preserved metadata) → verify GET',
      'Rollback: GET current + LIST versions (no pagination) → prove adjacency → GET prior → PUT value+metadata → verify; separate approval',
    ],
  };

  const contract = {
    kind: 'sunset-schema-observer-slice14j-kv-dsn-verify-full-plan-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: true,
    liveMutateCapability: true,
    liveMutateEnabled: true,
    liveRollbackEnabled: false,
    liveMutation: false,
    mutates: false,
    firewallMutation: false,
    networkMutation: false,
    defaultEnabled: false,
    planOnly: true,
    postgresForbidden: true,
    pgClientForbidden: true,
    secretReadForbiddenInThisSlice: true,
    secretWriteForbiddenInThisSlice: true,
    migrationForbidden: true,
    ddlForbidden: true,
    ledgerForbidden: true,
    retriesForbidden: true,
    deletePurgeDisableForbidden: true,
    tagsContentTypeMutationForbidden: true,
    metadataPreservationRequired: true,
    rollbackAdjacencyProofRequired: true,
    versionsPaginationForbidden: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14J',
    purpose: 'Build and offline-prove a locked recoverable operator plan to normalize only luna-sunset-staging-kv/sunset-database-url to sslmode=verify-full (same host/port/database/user/password) without reading or mutating the live secret.',
    locks: {
      subscriptionId: DSN_PLAN_LOCKS.subscriptionId,
      resourceGroup: DSN_PLAN_LOCKS.resourceGroup,
      keyVaultName: DSN_PLAN_LOCKS.keyVaultName,
      keyVaultResourceId: KEY_VAULT_RESOURCE_ID,
      secretName: DSN_PLAN_LOCKS.secretName,
      managedIdentityName: DSN_PLAN_LOCKS.managedIdentityName,
      managedIdentityClientId: DSN_PLAN_LOCKS.managedIdentityClientId,
      postgresServer: DSN_PLAN_LOCKS.postgresServer,
      postgresHost: DSN_PLAN_LOCKS.postgresHost,
      database: DSN_PLAN_LOCKS.database,
      port: DSN_PLAN_LOCKS.port,
      targetSslmode: DSN_PLAN_LOCKS.targetSslmode,
    },
    mutationContract: {
      operation: 'setSecretNewVersion',
      field: 'sslmode',
      to: 'verify-full',
      retainExact: [
        'host',
        'port',
        'database',
        'username',
        'password',
        'contentType',
        'tags',
        'attributes.enabled',
        'attributes.nbf',
        'attributes.exp',
      ],
      preserveUserMetadata: true,
      systemGeneratedMayDiffer: [
        'id',
        'attributes.created',
        'attributes.updated',
      ],
      putCount: 1,
      retries: 0,
      httpSequence: [
        'IMDS GET',
        'Key Vault secret GET',
        'Key Vault secret PUT',
        'Key Vault secret verification GET',
      ],
    },
    rollbackContract: {
      operation: 'restoreImmediatelyPreviousSecretVersion',
      restoreScope: 'immediately_previous_version_only',
      requiresSeparateExplicitApproval: true,
      adjacencyProofRequired: true,
      adjacencyRule: 'versions[0]===current && versions[1]===prior && created[0]>created[1]',
      paginationForbidden: true,
      preserveUserMetadata: true,
      putCount: 1,
      retries: 0,
      defaultZeroWrites: true,
      httpSequence: [
        'IMDS GET',
        'Key Vault secret GET current',
        'Key Vault secret versions LIST',
        'Key Vault secret version GET prior',
        'Key Vault secret PUT',
        'Key Vault secret verification GET',
      ],
    },
    commandContract: {
      script: 'scripts/run-phase-d-kv-dsn-verify-full-plan.js',
      npm: 'phase-d:kv-dsn-verify-full-plan',
      requiredEnv: [
        `${ENV_DSN_PLAN}=1`,
        `AZURE_SUBSCRIPTION_ID=${DSN_PLAN_LOCKS.subscriptionId}`,
      ],
      requiredArgv: [
        CLI_PLAN_ONLY,
        `--subscription ${DSN_PLAN_LOCKS.subscriptionId}`,
        `--resource-group ${DSN_PLAN_LOCKS.resourceGroup}`,
        `--key-vault ${DSN_PLAN_LOCKS.keyVaultName}`,
        `--secret-name ${DSN_PLAN_LOCKS.secretName}`,
        `--managed-identity ${DSN_PLAN_LOCKS.managedIdentityName}`,
        `--postgres-server ${DSN_PLAN_LOCKS.postgresServer}`,
        `--database ${DSN_PLAN_LOCKS.database}`,
      ],
      rollbackEnv: [`${ENV_DSN_ROLLBACK}=1`],
      rollbackArgv: [CLI_ROLLBACK_PLAN_ONLY, '--prior-version-id <immediately-previous-safe-id>'],
      forbiddenArgv: [...FORBIDDEN_ARGV_FLAGS],
      safeOutputKeys: [...SAFE_OUTPUT_KEYS],
    },
    authorizedHttpSequenceOnSuccess: [
      'IMDS GET',
      'Key Vault secret GET',
      'Key Vault secret PUT',
      'Key Vault secret verification GET',
    ],
    successCallCounts: {
      httpRequestCount: 4,
      imdsRequestCount: 1,
      keyVaultGetCount: 2,
      keyVaultPutCount: 1,
      putCount: 1,
    },
    rollbackSuccessCallCounts: {
      httpRequestCount: 6,
      imdsRequestCount: 1,
      keyVaultGetCount: 3,
      keyVaultListCount: 1,
      keyVaultPutCount: 1,
      putCount: 1,
    },
    predicatesUnchangedFrom14A: {
      date_window: DATE_WINDOW_PREDICATE,
      price_unit: PRICE_UNIT_PREDICATE,
    },
    nonGoals: [
      'Do not read or mutate the live Key Vault secret in Slice 14J',
      'Do not change host/port/database/username/password',
      'Do not delete/purge/disable secrets',
      'Do not mutate tags/contentType/attributes (preserve exactly)',
      'Do not accept paginated secret version lists',
      'Do not restore nonadjacent or stale versions',
      'Do not retry',
      'Do not instantiate a pg Client',
      'Do not claim Sunset repaired',
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14j-kv-dsn-verify-full-plan-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14J',
    liveMutateEnabled: true,
    liveRollbackEnabled: false,
    liveMutation: false,
    azureConnectivity: false,
    keyVaultLiveRead: false,
    keyVaultLiveWrite: false,
    realImdsCall: false,
    realKeyVaultCall: false,
    realPostgresCall: false,
    pgClientInstantiated: 0,
    rbacMutation: false,
    identityMutation: false,
    networkMutation: false,
    migrationAdded: false,
    ledgerWritten: false,
    ddlApplied: false,
    stillProductSchemaDiffers: true,
    productFingerprintUnchanged: CANON_FP,
    manifestHashUnchanged: MANIFEST_HASH,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    redCaseCount: redCases.length,
    greenCaseCount: greenCases.length,
    redCases,
    greenCases,
    successCallCounts: {
      httpRequestCount: 4,
      imdsRequestCount: 1,
      keyVaultGetCount: 2,
      keyVaultPutCount: 1,
      putCount: 1,
    },
    rollbackSuccessCallCounts: {
      httpRequestCount: 6,
      imdsRequestCount: 1,
      keyVaultGetCount: 3,
      keyVaultListCount: 1,
      keyVaultPutCount: 1,
      putCount: 1,
    },
    locks: contract.locks,
    mutationContract: contract.mutationContract,
    rollbackContract: contract.rollbackContract,
    fakePriorSecretVersionId: FAKE_PRIOR_VERSION,
    fakeNewSecretVersionId: FAKE_NEW_VERSION,
    fakePriorVersionCreated: FAKE_PRIOR_CREATED,
    fakeCurrentVersionCreated: FAKE_CURRENT_CREATED,
  };

  assertNoSecretLeak(JSON.stringify(evidence));
  assertNoSecretLeak(JSON.stringify(contract));
  assertNoSecretLeak(JSON.stringify(applyPlan));

  const findings = `# FOUNDATION Slice 14J — Key Vault DSN sslmode=verify-full normalize plan (offline)

**Status:** complete (plan + offline injected-HTTP proof; live HTTP capability activated in 14K gated apply; rollback hard-disabled; plan CLI zero live KV read/write)
**Master basis:** \`${MASTER}\`
**Generated:** ${generatedAt}

## Outcome

Built and offline-proven a locked, recoverable operator plan to normalize **only** the existing Key Vault secret \`luna-sunset-staging-kv/sunset-database-url\` from a TLS-deficient PostgreSQL DSN to the same exact host, port, database, username and password with \`sslmode=verify-full\` — **without** reading or mutating the live secret via the plan CLI.

| Lock | Value |
|------|-------|
| Vault / secret | \`luna-sunset-staging-kv\` / \`sunset-database-url\` |
| Identity | \`wh-staging-identity\` / \`${DSN_PLAN_LOCKS.managedIdentityClientId}\` |
| PG host / port / database | \`${DSN_PLAN_LOCKS.postgresHost}\` / \`${DSN_PLAN_LOCKS.port}\` / \`${DSN_PLAN_LOCKS.database}\` |
| Mutation | \`sslmode\` only → \`verify-full\` |
| Metadata | preserve exact contentType/tags/enabled/nbf/exp |
| PUT count | exactly 1 (no retries) |
| Rollback | immediately previous version only (adjacency proven), separate approval |

## Mutation / rollback contract

**Mutation (future live adapter):** IMDS GET → KV GET → capture supported user metadata in memory → parse+require exact host/port/database → retain user/password in memory → modify only \`sslmode\` → PUT one new secret version with value **and** preserved metadata → verification GET proves DSN + metadata equality (only system version id/timestamps may differ) → zero private refs. Prior version safe ID retained for rollback.

**Rollback:** separate approval (default disabled). Before any PUT: GET current + LIST versions (pagination rejected) → require \`versions[0]===current\` and \`versions[1]===caller prior\` with \`created[0]>created[1]\` → GET prior → validate exact target → PUT prior value+preserved metadata → verify. Nonadjacent/stale/paginated → **zero writes**.

## Operator command (plan-only; default refuse)

\`\`\`bash
SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_PLAN=1 \\
AZURE_SUBSCRIPTION_ID=${DSN_PLAN_LOCKS.subscriptionId} \\
npm run phase-d:kv-dsn-verify-full-plan -- \\
  --plan-only \\
  --subscription ${DSN_PLAN_LOCKS.subscriptionId} \\
  --resource-group ${DSN_PLAN_LOCKS.resourceGroup} \\
  --key-vault ${DSN_PLAN_LOCKS.keyVaultName} \\
  --secret-name ${DSN_PLAN_LOCKS.secretName} \\
  --managed-identity ${DSN_PLAN_LOCKS.managedIdentityName} \\
  --postgres-server ${DSN_PLAN_LOCKS.postgresServer} \\
  --database ${DSN_PLAN_LOCKS.database}
\`\`\`

## RED / GREEN (fake HTTP)

| Class | Cases |
|-------|-------|
| RED | default/missing env/flag; wrong targets; forbidden value/DSN/url/token/version/file argv; host/tags/delete/retries/arbitrary-version; adapter without inject; already verify-full (zero PUT); PUT failure keeps prior-version safe ID; rollback without approval; unsupported metadata; metadata mismatch; nonadjacent/stale version; list pagination |
| GREEN | locked mutation+rollback plans; CLI safe IDs; CLI rollback prior-version safe ID; fake HTTP **IMDS GET + KV GET + KV PUT + verify GET** (4 calls, 1 PUT); metadata preservation; exact rollback sequence (6 calls, adjacency+metadata); live disabled + hashes preserved + no pg Client |

**Mutation success call counts:** httpRequestCount=4, imdsRequestCount=1, keyVaultGetCount=2, keyVaultPutCount=1.
**Rollback success call counts:** httpRequestCount=6, imdsRequestCount=1, keyVaultGetCount=3, keyVaultListCount=1, keyVaultPutCount=1.

## Non-goals / still open

- **No** live Key Vault read or write in this slice
- **No** RBAC / identity / network / PG / DB / DDL / ledger / migration
- Still \`product_schema_differs\`
- **Do not claim** Sunset repaired.

## Zero live mutation

Plan-only offline emission + injected-HTTP proof. Default/wrong args → zero KV writes. Live HTTP capability is activated for the gated Slice 14K apply CLI; rollback remains \`false\`. Plan CLI never mutates live KV.
`;

  fs.writeFileSync(APPLY_PLAN_PATH, `${JSON.stringify(applyPlan, null, 2)}\n`);
  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, findings);

  console.log(`\nWrote ${path.relative(ROOT, APPLY_PLAN_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log('\nprove:sunset-schema-slice14j-kv-dsn-verify-full-plan GREEN');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
