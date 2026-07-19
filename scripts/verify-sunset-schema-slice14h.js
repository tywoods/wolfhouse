'use strict';

/**
 * verify:sunset-schema-slice14h — FOUNDATION Slice 14H RED→GREEN
 * Offline Key Vault Secrets User RBAC apply-plan (no Azure mutation).
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
  PHASE_D_KV_SECRETS_USER_RBAC_LIVE_APPLY_ENABLED,
  ENV_RBAC_PLAN,
  CLI_PLAN_ONLY,
  RBAC_PLAN_LOCKS,
  KEY_VAULT_RESOURCE_ID,
  DETERMINISTIC_ROLE_ASSIGNMENT_NAME,
  FORBIDDEN_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  azureArmGuid,
  buildLockedApplyPlan,
  planMatchesLocked,
  evaluateRbacPlanGates,
  executeRbacPlanOnly,
  exactRbacPlanArgv,
  rbacPlanEnv,
  resetAzureMutationCounters,
  getAzureMutationCounters,
  assertBicepModuleSource,
  assertNotWiredIntoMain,
} = require('./lib/phase-d-kv-secrets-user-rbac-plan');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = 'f7d8126b2a980591220b81cd243bcff5ad84abd6';
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
  'default_path_zero_azure_mutation',
  'missing_env_zero_mutation',
  'missing_plan_only_flag_zero_mutation',
  'wrong_exact_targets_zero_mutation',
  'scope_broadening_rejected',
  'owner_contributor_admin_roles_rejected',
  'delete_rejected',
  'duplicate_or_random_guid_rejected',
  'unrelated_changes_rejected',
  'forbidden_apply_deploy_whatif_argv',
];

const REQUIRED_GREEN = [
  'exact_locked_plan_deterministic_guid',
  'bicep_standalone_existing_vault_locks',
  'cli_plan_only_safe_ids',
  'live_apply_hard_disabled',
  'migration_and_product_hashes_preserved',
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
  console.log('verify:sunset-schema-slice14h — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14h-kv-secrets-user-rbac-plan-evidence.json');
  const contractPath = path.join(FIX, 'slice14h-kv-secrets-user-rbac-plan-contract.json');
  const findingsPath = path.join(FIX, 'slice14h-findings.md');
  const applyPlanPath = path.join(FIX, 'slice14h-kv-secrets-user-rbac-apply-plan.json');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14h-kv-secrets-user-rbac-plan.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14h.js');
  const cliPath = path.join(ROOT, 'scripts', 'run-phase-d-kv-secrets-user-rbac-plan.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-kv-secrets-user-rbac-plan.js');
  const bicepPath = path.join(ROOT, RBAC_PLAN_LOCKS.bicepModuleRel);
  const paramsPath = path.join(ROOT, RBAC_PLAN_LOCKS.bicepParametersRel);

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, applyPlanPath, expectedPath, provePath, cliPath, libPath, bicepPath, paramsPath]
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

  pass('live-apply-hard-disabled',
    PHASE_D_KV_SECRETS_USER_RBAC_LIVE_APPLY_ENABLED === false
    && /PHASE_D_KV_SECRETS_USER_RBAC_LIVE_APPLY_ENABLED\s*=\s*false/.test(libSrc)
    && evidence.liveApplyEnabled === false
    && contract.liveApplyEnabled === false
    && contract.liveApplyCapability === false
    && !cliSrc.includes('deployment group create')
    && !cliSrc.includes('role assignment create')
    && !libSrc.includes('deployment group create')
    && !libSrc.includes('role assignment create'));

  pass('assignment-locks-exact',
    DETERMINISTIC_ROLE_ASSIGNMENT_NAME === '4653f1f5-6c4f-54bd-acba-6cad3d56d791'
    && DETERMINISTIC_ROLE_ASSIGNMENT_NAME === azureArmGuid(
      KEY_VAULT_RESOURCE_ID,
      RBAC_PLAN_LOCKS.principalId,
      RBAC_PLAN_LOCKS.roleDefinitionId,
    )
    && RBAC_PLAN_LOCKS.principalId === 'e3136eed-948b-4947-a26e-50a33b45a41a'
    && RBAC_PLAN_LOCKS.roleDefinitionId === '4633458b-17de-408a-b874-0445c86b69e6'
    && RBAC_PLAN_LOCKS.keyVaultName === 'luna-sunset-staging-kv'
    && RBAC_PLAN_LOCKS.resourceGroup === 'luna-sunset-staging-rg'
    && RBAC_PLAN_LOCKS.subscriptionId === '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9'
    && KEY_VAULT_RESOURCE_ID === (
      '/subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9'
      + '/resourceGroups/luna-sunset-staging-rg'
      + '/providers/Microsoft.KeyVault/vaults/luna-sunset-staging-kv'
    )
    && evidence.roleAssignmentName === DETERMINISTIC_ROLE_ASSIGNMENT_NAME
    && evidence.scope === KEY_VAULT_RESOURCE_ID
    && contract.assignment.roleAssignmentName === DETERMINISTIC_ROLE_ASSIGNMENT_NAME
    && applyPlan.roleAssignmentName === DETERMINISTIC_ROLE_ASSIGNMENT_NAME
    && planMatchesLocked(buildLockedApplyPlan()));

  const bicep = assertBicepModuleSource(ROOT);
  const main = assertNotWiredIntoMain(ROOT);
  pass('bicep-standalone-existing-vault',
    bicep.checks.ok === true
    && main.ok === true
    && contract.bicep.wiredIntoMain === false
    && contract.bicep.fullRgDeployment === false
    && findings.includes('not') && findings.includes('main.bicep'));

  pass('command-contract',
    contract.commandContract.script === 'scripts/run-phase-d-kv-secrets-user-rbac-plan.js'
    && contract.commandContract.npm === 'phase-d:kv-secrets-user-rbac-plan'
    && contract.defaultEnabled === false
    && contract.planOnly === true
    && ENV_RBAC_PLAN === 'SUNSET_PHASE_D_KV_SECRETS_USER_RBAC_PLAN'
    && CLI_PLAN_ONLY === '--plan-only'
    && FORBIDDEN_ARGV_FLAGS.every((f) => contract.commandContract.forbiddenArgv.includes(f))
    && SAFE_OUTPUT_KEYS.every((k) => contract.commandContract.safeOutputKeys.includes(k))
    && cliSrc.includes(CLI_PLAN_ONLY)
    && libSrc.includes('executeRbacPlanOnly'));

  pass('npm-scripts',
    pkg.scripts['prove:sunset-schema-slice14h-kv-secrets-user-rbac-plan']
      === 'node scripts/prove-sunset-schema-slice14h-kv-secrets-user-rbac-plan.js'
    && pkg.scripts['verify:sunset-schema-slice14h']
      === 'node scripts/verify-sunset-schema-slice14h.js'
    && pkg.scripts['phase-d:kv-secrets-user-rbac-plan']
      === 'node scripts/run-phase-d-kv-secrets-user-rbac-plan.js');

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
    && evidence.azureWhatIf === false
    && evidence.azureDeploy === false
    && evidence.azureRbacMutation === false
    && evidence.keyVaultRetry === false
    && evidence.secretRead === false
    && evidence.realPostgresCall === false
    && evidence.migrationAdded === false
    && evidence.ledgerWritten === false
    && evidence.stillProductSchemaDiffers === true
    && findings.includes('Zero live mutation'));

  // Live re-check of default + plan-only paths (offline; no Azure).
  resetAzureMutationCounters();
  const defaultGates = evaluateRbacPlanGates({ env: {}, argv: [] });
  const defaultCli = spawnSync(process.execPath, [cliPath], {
    cwd: ROOT,
    env: { ...process.env },
    encoding: 'utf8',
  });
  pass('runtime-default-refuse',
    defaultGates.ok === false
    && defaultCli.status === 2
    && getAzureMutationCounters().azureMutationCount === 0);

  resetAzureMutationCounters();
  const planExec = executeRbacPlanOnly({ env: rbacPlanEnv(), argv: exactRbacPlanArgv() });
  pass('runtime-plan-only-ok',
    planExec.ok === true
    && planExec.roleAssignmentName === DETERMINISTIC_ROLE_ASSIGNMENT_NAME
    && planExec.azureMutationCount === 0
    && getAzureMutationCounters().azureMutationCount === 0);

  const artifactText = [
    findings,
    JSON.stringify(evidence),
    JSON.stringify(contract),
    JSON.stringify(applyPlan),
  ].join('\n');
  pass('secret-free-artifacts',
    !/password\s*[:=]|secretValue|connectionString|BEGIN PRIVATE KEY/i.test(artifactText));

  if (failed) {
    console.log(`\nverify:sunset-schema-slice14h FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14h GREEN');
}

main();
