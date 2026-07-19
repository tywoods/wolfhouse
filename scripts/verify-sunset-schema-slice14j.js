'use strict';

/**
 * verify:sunset-schema-slice14j — FOUNDATION Slice 14J RED→GREEN
 * Offline Key Vault DSN sslmode=verify-full normalize plan (no live KV mutation).
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
  mutationPlanMatchesLocked,
  evaluateDsnPlanGates,
  executeDsnVerifyFullPlanOnly,
  exactDsnPlanArgv,
  dsnPlanEnv,
  resetDsnPlanCounters,
  getDsnPlanCounters,
} = require('./lib/phase-d-kv-dsn-verify-full-plan');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
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

const REQUIRED_RED = [
  'default_path_zero_kv_writes',
  'missing_env_zero_writes',
  'missing_plan_only_flag_zero_writes',
  'wrong_exact_targets_zero_writes',
  'forbidden_value_dsn_token_version_file_argv',
  'host_tags_delete_retries_arbitrary_version_rejected',
  'adapter_without_inject_zero_writes',
  'already_verify_full_zero_puts',
  'put_failure_retains_prior_version_safe_id',
  'rollback_without_approval_zero_writes',
  'unsupported_attributes_zero_writes',
  'metadata_mismatch_rejected',
  'nonadjacent_stale_version_zero_writes',
  'list_pagination_rejected_zero_writes',
];

const REQUIRED_GREEN = [
  'exact_locked_mutation_and_rollback_plans',
  'cli_plan_only_safe_ids',
  'cli_rollback_plan_only_safe_prior_version_id',
  'fake_http_imds_get_put_verify_success',
  'metadata_preservation_verified',
  'exact_rollback_sequence_call_counts',
  'live_disabled_hashes_preserved_no_pg_client',
];

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function main() {
  console.log('verify:sunset-schema-slice14j — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14j-kv-dsn-verify-full-plan-evidence.json');
  const contractPath = path.join(FIX, 'slice14j-kv-dsn-verify-full-plan-contract.json');
  const findingsPath = path.join(FIX, 'slice14j-findings.md');
  const applyPlanPath = path.join(FIX, 'slice14j-kv-dsn-verify-full-apply-plan.json');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14j-kv-dsn-verify-full-plan.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14j.js');
  const cliPath = path.join(ROOT, 'scripts', 'run-phase-d-kv-dsn-verify-full-plan.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-kv-dsn-verify-full-plan.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, applyPlanPath, expectedPath, provePath, cliPath, libPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const applyPlan = JSON.parse(fs.readFileSync(applyPlanPath, 'utf8'));
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const cliSrc = fs.readFileSync(cliPath, 'utf8');
  const libSrc = fs.readFileSync(libPath, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const expectedBytes = fs.readFileSync(expectedPath);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);

  const live028 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '028_tenant_services.sql'));
  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
  const live040 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '040_tenant_services_saas_catalog_columns.sql'));
  const live041 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '041_notification_surfpack_convergence.sql'));

  pass('manifest-integrity', integrity.ok === true);
  pass('forward-count-39', forward.length === 39);
  pass('manifest-hash-preserved', manifestHash === MANIFEST_HASH
    && evidence.manifestHashUnchanged === MANIFEST_HASH);
  pass('expected-byte-sha-preserved', expectedHash === EXPECTED_BYTE_SHA
    && evidence.expectedProductSchemaByteSha256 === EXPECTED_BYTE_SHA);
  pass('product-fingerprint-preserved', expected.productFingerprint === CANON_FP
    && evidence.productFingerprintUnchanged === CANON_FP);
  pass(
    '13c-hashes-preserved',
    live028 === LOCKED_13C_SHA['028']
    && live035 === LOCKED_13C_SHA['035']
    && live040 === LOCKED_13C_SHA['040']
    && live041 === LOCKED_13C_SHA['041'],
  );
  pass('028-predicates-unchanged', assert028PredicatesPresentInSource() === true
    && assertMigration028ByteIntegrity() === EXPECTED_028_SHA256
    && contract.predicatesUnchangedFrom14A.date_window === DATE_WINDOW_PREDICATE
    && contract.predicatesUnchangedFrom14A.price_unit === PRICE_UNIT_PREDICATE
    && AGG_14A.includes('tenant_services'));

  pass('live-mutate-hard-disabled',
    PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED === false
    && PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED === false
    && /PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED\s*=\s*false/.test(libSrc)
    && /PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED\s*=\s*false/.test(libSrc)
    && evidence.liveMutateEnabled === false
    && evidence.liveRollbackEnabled === false
    && contract.liveMutateEnabled === false
    && contract.liveRollbackEnabled === false
    && contract.liveMutateCapability === false
    && !/\brequire\(['"]pg['"]\)/.test(libSrc)
    && !/new\s+Client\b/.test(libSrc)
    && !cliSrc.includes('vault.azure.net')
    && proveSrc.includes('createInjectedDsnNormalizeHttp'));

  pass('mutation-locks-exact',
    DSN_PLAN_LOCKS.secretName === 'sunset-database-url'
    && DSN_PLAN_LOCKS.keyVaultName === 'luna-sunset-staging-kv'
    && DSN_PLAN_LOCKS.postgresHost === 'luna-sunset-staging-pg-app.postgres.database.azure.com'
    && DSN_PLAN_LOCKS.port === 5432
    && DSN_PLAN_LOCKS.database === 'sunset_staging'
    && DSN_PLAN_LOCKS.targetSslmode === 'verify-full'
    && DSN_PLAN_LOCKS.subscriptionId === '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9'
    && DSN_PLAN_LOCKS.resourceGroup === 'luna-sunset-staging-rg'
    && DSN_PLAN_LOCKS.managedIdentityName === 'wh-staging-identity'
    && KEY_VAULT_RESOURCE_ID === (
      '/subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9'
      + '/resourceGroups/luna-sunset-staging-rg'
      + '/providers/Microsoft.KeyVault/vaults/luna-sunset-staging-kv'
    )
    && mutationPlanMatchesLocked(buildLockedMutationPlan())
    && contract.mutationContract.to === 'verify-full'
    && contract.mutationContract.putCount === 1
    && contract.mutationContract.retries === 0
    && contract.mutationContract.preserveUserMetadata === true
    && contract.mutationContract.retainExact.includes('contentType')
    && contract.mutationContract.retainExact.includes('tags')
    && contract.mutationContract.retainExact.includes('attributes.enabled')
    && contract.rollbackContract.restoreScope === 'immediately_previous_version_only'
    && contract.rollbackContract.adjacencyProofRequired === true
    && contract.rollbackContract.paginationForbidden === true
    && contract.rollbackContract.preserveUserMetadata === true
    && contract.rollbackContract.httpSequence.length === 6
    && contract.metadataPreservationRequired === true
    && contract.rollbackAdjacencyProofRequired === true
    && contract.versionsPaginationForbidden === true
    && applyPlan.mutation.putCount === 1
    && applyPlan.mutation.mutation.preserveUserMetadata === true
    && applyPlan.rollback.adjacencyProofRequired === true
    && applyPlan.liveMutateEnabled === false);

  pass('success-call-counts',
    evidence.successCallCounts.httpRequestCount === 4
    && evidence.successCallCounts.imdsRequestCount === 1
    && evidence.successCallCounts.keyVaultGetCount === 2
    && evidence.successCallCounts.keyVaultPutCount === 1
    && evidence.successCallCounts.putCount === 1
    && contract.successCallCounts.httpRequestCount === 4
    && contract.authorizedHttpSequenceOnSuccess.length === 4
    && evidence.rollbackSuccessCallCounts.httpRequestCount === 6
    && evidence.rollbackSuccessCallCounts.keyVaultListCount === 1
    && evidence.rollbackSuccessCallCounts.keyVaultGetCount === 3
    && evidence.rollbackSuccessCallCounts.keyVaultPutCount === 1
    && contract.rollbackSuccessCallCounts.httpRequestCount === 6
    && findings.includes('httpRequestCount=4')
    && findings.includes('httpRequestCount=6')
    && findings.includes('keyVaultPutCount=1')
    && findings.includes('keyVaultListCount=1'));

  pass('command-contract',
    contract.commandContract.script === 'scripts/run-phase-d-kv-dsn-verify-full-plan.js'
    && contract.commandContract.npm === 'phase-d:kv-dsn-verify-full-plan'
    && contract.defaultEnabled === false
    && contract.planOnly === true
    && ENV_DSN_PLAN === 'SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_PLAN'
    && ENV_DSN_ROLLBACK === 'SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_ROLLBACK'
    && CLI_PLAN_ONLY === '--plan-only'
    && CLI_ROLLBACK_PLAN_ONLY === '--rollback-plan-only'
    && FORBIDDEN_ARGV_FLAGS.every((f) => contract.commandContract.forbiddenArgv.includes(f))
    && SAFE_OUTPUT_KEYS.every((k) => contract.commandContract.safeOutputKeys.includes(k))
    && cliSrc.includes(CLI_PLAN_ONLY)
    && libSrc.includes('executeDsnNormalizeAdapter')
    && libSrc.includes('executeDsnRollbackAdapter'));

  pass('npm-scripts',
    pkg.scripts['prove:sunset-schema-slice14j-kv-dsn-verify-full-plan']
      === 'node scripts/prove-sunset-schema-slice14j-kv-dsn-verify-full-plan.js'
    && pkg.scripts['verify:sunset-schema-slice14j']
      === 'node scripts/verify-sunset-schema-slice14j.js'
    && pkg.scripts['phase-d:kv-dsn-verify-full-plan']
      === 'node scripts/run-phase-d-kv-dsn-verify-full-plan.js');

  pass('master-basis',
    evidence.masterShaBasis === MASTER
    && contract.masterShaBasis === MASTER
    && findings.includes(MASTER));

  pass('red-green-cases',
    evidence.redCaseCount === REQUIRED_RED.length
    && evidence.greenCaseCount === REQUIRED_GREEN.length
    && REQUIRED_RED.every((n) => evidence.redCases.some((c) => c.name === n && c.ok === true))
    && REQUIRED_GREEN.every((n) => evidence.greenCases.some((c) => c.name === n && c.ok === true)));

  pass('zero-live-mutation-flags',
    evidence.liveMutation === false
    && evidence.azureConnectivity === false
    && evidence.keyVaultLiveRead === false
    && evidence.keyVaultLiveWrite === false
    && evidence.realImdsCall === false
    && evidence.realKeyVaultCall === false
    && evidence.realPostgresCall === false
    && evidence.pgClientInstantiated === 0
    && evidence.rbacMutation === false
    && evidence.identityMutation === false
    && evidence.networkMutation === false
    && evidence.migrationAdded === false
    && evidence.ledgerWritten === false
    && evidence.ddlApplied === false
    && evidence.stillProductSchemaDiffers === true
    && findings.includes('Zero live mutation')
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(JSON.stringify(evidence))
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(JSON.stringify(contract))
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(findings)
    && !JSON.stringify(evidence).includes('text/plain')
    && !JSON.stringify(contract).includes('text/plain')
    && !libSrc.includes('az keyvault'));

  // Live re-check of default + plan-only paths (offline; no Azure).
  resetDsnPlanCounters();
  const defaultGates = evaluateDsnPlanGates({ env: {}, argv: [] });
  pass('default-gates-refuse', defaultGates.ok === false
    && getDsnPlanCounters().kvWriteCount === 0);

  resetDsnPlanCounters();
  const planResult = executeDsnVerifyFullPlanOnly({
    env: dsnPlanEnv(),
    argv: exactDsnPlanArgv(),
  });
  pass('plan-only-execute-safe',
    planResult.ok === true
    && planResult.planOnly === true
    && planResult.liveMutation === false
    && planResult.kvWriteCount === 0
    && getDsnPlanCounters().kvWriteCount === 0
    && getDsnPlanCounters().httpRequestCount === 0);

  const cliDefault = spawnSync(process.execPath, [cliPath], {
    cwd: ROOT,
    env: { ...process.env },
    encoding: 'utf8',
  });
  pass('cli-default-exit-2', cliDefault.status === 2);

  // Source must not claim live mutate in this slice.
  pass('prove-verify-offline-only',
    proveSrc.includes('offline')
    && verifySrc.includes('no live KV mutation')
    && !proveSrc.includes('az keyvault secret set')
    && !libSrc.includes('az keyvault'));

  console.log(`\n── verify:sunset-schema-slice14j: ${failed ? 'FAILED' : 'PASSED'} ──`);
  process.exit(failed ? 1 : 0);
}

main();
