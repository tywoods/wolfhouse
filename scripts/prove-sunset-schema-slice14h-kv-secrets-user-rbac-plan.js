'use strict';

/**
 * prove-sunset-schema-slice14h-kv-secrets-user-rbac-plan — FOUNDATION Slice 14H
 *
 * Offline proof of exactly one least-privilege Azure RBAC apply-plan resolving
 * the Slice 14G Key Vault 403 — without deploying it.
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
  ROLE_ASSIGNMENT_RESOURCE_ID,
  EXISTING_SUNSET_IDENTITY_KV_ROLE_ASSIGNMENT_NAME,
  FORBIDDEN_ROLE_DEFINITION_IDS,
  FORBIDDEN_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  azureArmGuid,
  buildLockedApplyPlan,
  planMatchesLocked,
  evaluateAssignmentCandidate,
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
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14h-kv-secrets-user-rbac-plan-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14h-kv-secrets-user-rbac-plan-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14h-findings.md');
const APPLY_PLAN_PATH = path.join(FIX, 'slice14h-kv-secrets-user-rbac-apply-plan.json');
const CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-kv-secrets-user-rbac-plan.js');

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

function main() {
  console.log('prove:sunset-schema-slice14h-kv-secrets-user-rbac-plan — offline\n');

  const generatedAt = new Date().toISOString();
  resetAzureMutationCounters();

  const redCases = [];
  const greenCases = [];

  // ── RED: default zero Azure mutation ───────────────────────────────────
  {
    resetAzureMutationCounters();
    const gates = evaluateRbacPlanGates({ env: {}, argv: [] });
    const counters = getAzureMutationCounters();
    const cli = runCli({}, []);
    const cliJson = parseLastJson(cli.stdout);
    const ok = gates.ok === false
      && counters.azureMutationCount === 0
      && cli.status === 2
      && cliJson
      && cliJson.code === 'default_disabled'
      && cliJson.azureMutationCount === 0
      && cliJson.liveMutation === false;
    redCases.push({
      name: 'default_path_zero_azure_mutation',
      ok,
      code: gates.code,
      azureMutationCount: counters.azureMutationCount,
      cliExitCode: cli.status,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED default_path_zero_azure_mutation`);
  }

  // ── RED: missing env ───────────────────────────────────────────────────
  {
    resetAzureMutationCounters();
    const argv = exactRbacPlanArgv();
    const gates = evaluateRbacPlanGates({ env: {}, argv });
    const counters = getAzureMutationCounters();
    const ok = gates.ok === false
      && gates.errors.some((e) => e.code === 'env_required')
      && counters.azureMutationCount === 0;
    redCases.push({
      name: 'missing_env_zero_mutation',
      ok,
      azureMutationCount: counters.azureMutationCount,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED missing_env_zero_mutation`);
  }

  // ── RED: missing plan-only flag ────────────────────────────────────────
  {
    resetAzureMutationCounters();
    const argv = exactRbacPlanArgv().filter((a) => a !== CLI_PLAN_ONLY);
    const gates = evaluateRbacPlanGates({ env: rbacPlanEnv(), argv });
    const counters = getAzureMutationCounters();
    const ok = gates.ok === false
      && gates.errors.some((e) => e.code === 'plan_only_required')
      && counters.azureMutationCount === 0;
    redCases.push({
      name: 'missing_plan_only_flag_zero_mutation',
      ok,
      azureMutationCount: counters.azureMutationCount,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED missing_plan_only_flag_zero_mutation`);
  }

  // ── RED: wrong exact targets ───────────────────────────────────────────
  {
    resetAzureMutationCounters();
    const base = exactRbacPlanArgv();
    const env = rbacPlanEnv();
    const wrongSub = evaluateRbacPlanGates({
      env,
      argv: base.map((a, i) => (base[i - 1] === '--subscription' ? '00000000-0000-0000-0000-000000000000' : a)),
    });
    const wrongRg = evaluateRbacPlanGates({
      env,
      argv: base.map((a, i) => (base[i - 1] === '--resource-group' ? 'other-rg' : a)),
    });
    const wrongVault = evaluateRbacPlanGates({
      env,
      argv: base.map((a, i) => (base[i - 1] === '--key-vault' ? 'other-kv' : a)),
    });
    const wrongPrincipal = evaluateRbacPlanGates({
      env,
      argv: base.map((a, i) => (base[i - 1] === '--principal-id' ? '11111111-1111-1111-1111-111111111111' : a)),
    });
    const wrongRole = evaluateRbacPlanGates({
      env,
      argv: base.map((a, i) => (base[i - 1] === '--role-definition-id' ? FORBIDDEN_ROLE_DEFINITION_IDS.Contributor : a)),
    });
    const counters = getAzureMutationCounters();
    const ok = wrongSub.ok === false && wrongSub.errors.some((e) => e.code === 'subscription_rejected')
      && wrongRg.ok === false && wrongRg.errors.some((e) => e.code === 'resource_group_rejected')
      && wrongVault.ok === false && wrongVault.errors.some((e) => e.code === 'vault_rejected')
      && wrongPrincipal.ok === false && wrongPrincipal.errors.some((e) => e.code === 'principal_rejected')
      && wrongRole.ok === false && wrongRole.errors.some((e) => e.code === 'role_rejected')
      && counters.azureMutationCount === 0;
    redCases.push({
      name: 'wrong_exact_targets_zero_mutation',
      ok,
      subscriptionRejected: true,
      resourceGroupRejected: true,
      vaultRejected: true,
      principalRejected: true,
      roleRejected: true,
      azureMutationCount: counters.azureMutationCount,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED wrong_exact_targets_zero_mutation`);
  }

  // ── RED: scope broadening ──────────────────────────────────────────────
  {
    const subScope = evaluateAssignmentCandidate({
      scope: `/subscriptions/${RBAC_PLAN_LOCKS.subscriptionId}`,
      principalId: RBAC_PLAN_LOCKS.principalId,
      roleDefinitionId: RBAC_PLAN_LOCKS.roleDefinitionId,
    });
    const rgScope = evaluateAssignmentCandidate({
      scope: `/subscriptions/${RBAC_PLAN_LOCKS.subscriptionId}/resourceGroups/${RBAC_PLAN_LOCKS.resourceGroup}`,
      principalId: RBAC_PLAN_LOCKS.principalId,
      roleDefinitionId: RBAC_PLAN_LOCKS.roleDefinitionId,
    });
    const wild = evaluateAssignmentCandidate({
      scope: '*',
      principalId: RBAC_PLAN_LOCKS.principalId,
      roleDefinitionId: RBAC_PLAN_LOCKS.roleDefinitionId,
    });
    const ok = subScope.ok === false && subScope.errors.some((e) => e.code === 'scope_broadening_rejected')
      && rgScope.ok === false && rgScope.errors.some((e) => e.code === 'scope_broadening_rejected')
      && wild.ok === false && wild.errors.some((e) => e.code === 'scope_broadening_rejected');
    redCases.push({
      name: 'scope_broadening_rejected',
      ok,
      subscriptionScopeRejected: true,
      resourceGroupScopeRejected: true,
      wildcardScopeRejected: true,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED scope_broadening_rejected`);
  }

  // ── RED: Owner / Contributor / Admin ───────────────────────────────────
  {
    const owner = evaluateAssignmentCandidate({
      roleDefinitionId: FORBIDDEN_ROLE_DEFINITION_IDS.Owner,
      roleName: 'Owner',
      scope: KEY_VAULT_RESOURCE_ID,
      principalId: RBAC_PLAN_LOCKS.principalId,
    });
    const contrib = evaluateAssignmentCandidate({
      roleDefinitionId: FORBIDDEN_ROLE_DEFINITION_IDS.Contributor,
      roleName: 'Contributor',
      scope: KEY_VAULT_RESOURCE_ID,
      principalId: RBAC_PLAN_LOCKS.principalId,
    });
    const admin = evaluateAssignmentCandidate({
      roleDefinitionId: FORBIDDEN_ROLE_DEFINITION_IDS['Key Vault Administrator'],
      roleName: 'Key Vault Administrator',
      scope: KEY_VAULT_RESOURCE_ID,
      principalId: RBAC_PLAN_LOCKS.principalId,
    });
    const ok = owner.ok === false && owner.errors.some((e) => e.code === 'privileged_role_rejected' || e.code === 'role_rejected')
      && contrib.ok === false && contrib.errors.some((e) => e.code === 'privileged_role_rejected' || e.code === 'role_rejected')
      && admin.ok === false && admin.errors.some((e) => e.code === 'privileged_role_rejected' || e.code === 'role_rejected');
    redCases.push({
      name: 'owner_contributor_admin_roles_rejected',
      ok,
      ownerRejected: true,
      contributorRejected: true,
      adminRejected: true,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED owner_contributor_admin_roles_rejected`);
  }

  // ── RED: delete ────────────────────────────────────────────────────────
  {
    const del = evaluateAssignmentCandidate({
      operation: 'delete',
      roleAssignmentName: DETERMINISTIC_ROLE_ASSIGNMENT_NAME,
      scope: KEY_VAULT_RESOURCE_ID,
      principalId: RBAC_PLAN_LOCKS.principalId,
      roleDefinitionId: RBAC_PLAN_LOCKS.roleDefinitionId,
    });
    const ok = del.ok === false && del.errors.some((e) => e.code === 'delete_rejected');
    redCases.push({ name: 'delete_rejected', ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED delete_rejected`);
  }

  // ── RED: duplicate / random GUID ───────────────────────────────────────
  {
    const dup = evaluateAssignmentCandidate({
      roleAssignmentName: EXISTING_SUNSET_IDENTITY_KV_ROLE_ASSIGNMENT_NAME,
      scope: KEY_VAULT_RESOURCE_ID,
      principalId: RBAC_PLAN_LOCKS.principalId,
      roleDefinitionId: RBAC_PLAN_LOCKS.roleDefinitionId,
    });
    const random = evaluateAssignmentCandidate({
      roleAssignmentName: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      scope: KEY_VAULT_RESOURCE_ID,
      principalId: RBAC_PLAN_LOCKS.principalId,
      roleDefinitionId: RBAC_PLAN_LOCKS.roleDefinitionId,
    });
    const ok = dup.ok === false && dup.errors.some((e) => e.code === 'duplicate_guid_rejected')
      && random.ok === false && random.errors.some((e) => e.code === 'random_guid_rejected');
    redCases.push({
      name: 'duplicate_or_random_guid_rejected',
      ok,
      duplicateRejected: true,
      randomRejected: true,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED duplicate_or_random_guid_rejected`);
  }

  // ── RED: unrelated changes ─────────────────────────────────────────────
  {
    const extra = evaluateAssignmentCandidate({
      assertExact: true,
      ...buildLockedApplyPlan(),
      extraAssignments: [{ role: 'AcrPull' }],
      unrelated: true,
      networkMutation: true,
    });
    const ok = extra.ok === false && extra.errors.some((e) => e.code === 'unrelated_changes_rejected');
    redCases.push({ name: 'unrelated_changes_rejected', ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED unrelated_changes_rejected`);
  }

  // ── RED: forbidden argv (apply/deploy/what-if) ─────────────────────────
  {
    resetAzureMutationCounters();
    const argv = [...exactRbacPlanArgv(), '--apply', '--what-if'];
    const gates = evaluateRbacPlanGates({ env: rbacPlanEnv(), argv });
    const counters = getAzureMutationCounters();
    const ok = gates.ok === false
      && gates.errors.some((e) => e.code === 'forbidden_argv')
      && counters.azureMutationCount === 0
      && FORBIDDEN_ARGV_FLAGS.includes('--apply')
      && FORBIDDEN_ARGV_FLAGS.includes('--what-if')
      && FORBIDDEN_ARGV_FLAGS.includes('--delete');
    redCases.push({
      name: 'forbidden_apply_deploy_whatif_argv',
      ok,
      azureMutationCount: counters.azureMutationCount,
      forbiddenFlags: ['--apply', '--deploy', '--what-if', '--delete'],
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  RED forbidden_apply_deploy_whatif_argv`);
  }

  // ── GREEN: exact locked plan + determinism ─────────────────────────────
  {
    resetAzureMutationCounters();
    const plan = buildLockedApplyPlan();
    const expectedName = azureArmGuid(
      KEY_VAULT_RESOURCE_ID,
      RBAC_PLAN_LOCKS.principalId,
      RBAC_PLAN_LOCKS.roleDefinitionId,
    );
    const candidate = evaluateAssignmentCandidate({
      assertExact: true,
      ...plan,
    });
    const exec = executeRbacPlanOnly({ env: rbacPlanEnv(), argv: exactRbacPlanArgv() });
    const counters = getAzureMutationCounters();
    const ok = planMatchesLocked(plan)
      && plan.roleAssignmentName === DETERMINISTIC_ROLE_ASSIGNMENT_NAME
      && plan.roleAssignmentName === expectedName
      && plan.roleAssignmentName === '4653f1f5-6c4f-54bd-acba-6cad3d56d791'
      && plan.scope === KEY_VAULT_RESOURCE_ID
      && plan.principalId === 'e3136eed-948b-4947-a26e-50a33b45a41a'
      && plan.roleDefinitionId === '4633458b-17de-408a-b874-0445c86b69e6'
      && plan.principalType === 'ServicePrincipal'
      && plan.assignmentCount === 1
      && candidate.ok === true
      && exec.ok === true
      && exec.roleAssignmentName === DETERMINISTIC_ROLE_ASSIGNMENT_NAME
      && exec.azureMutationCount === 0
      && counters.azureMutationCount === 0
      && PHASE_D_KV_SECRETS_USER_RBAC_LIVE_APPLY_ENABLED === false;
    greenCases.push({
      name: 'exact_locked_plan_deterministic_guid',
      ok,
      roleAssignmentName: DETERMINISTIC_ROLE_ASSIGNMENT_NAME,
      scope: KEY_VAULT_RESOURCE_ID,
      principalId: RBAC_PLAN_LOCKS.principalId,
      roleDefinitionId: RBAC_PLAN_LOCKS.roleDefinitionId,
      principalType: 'ServicePrincipal',
      azureMutationCount: counters.azureMutationCount,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  GREEN exact_locked_plan_deterministic_guid`);
  }

  // ── GREEN: Bicep module source locks + not in main ─────────────────────
  {
    const bicep = assertBicepModuleSource(ROOT);
    const main = assertNotWiredIntoMain(ROOT);
    const paramsPath = path.join(ROOT, RBAC_PLAN_LOCKS.bicepParametersRel);
    const params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
    const ok = bicep.checks.ok === true
      && main.ok === true
      && params.parameters.keyVaultName.value === RBAC_PLAN_LOCKS.keyVaultName
      && params.parameters.principalId.value === RBAC_PLAN_LOCKS.principalId
      && params.metadata.deterministicRoleAssignmentName === DETERMINISTIC_ROLE_ASSIGNMENT_NAME
      && params.metadata.liveApplyEnabled === false;
    greenCases.push({
      name: 'bicep_standalone_existing_vault_locks',
      ok,
      bicepModule: RBAC_PLAN_LOCKS.bicepModuleRel,
      notWiredIntoMain: main.ok,
      existingResourceReference: true,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  GREEN bicep_standalone_existing_vault_locks`);
  }

  // ── GREEN: CLI plan-only emits safe IDs ────────────────────────────────
  {
    resetAzureMutationCounters();
    const cli = runCli(rbacPlanEnv(), exactRbacPlanArgv());
    const json = parseLastJson(cli.stdout);
    const keys = json ? Object.keys(json) : [];
    const unsafe = /password|token|secretValue|connectionString|databaseUrl|privateKey/i;
    const ok = cli.status === 0
      && json
      && json.ok === true
      && json.planOnly === true
      && json.liveMutation === false
      && json.azureMutationCount === 0
      && json.roleAssignmentName === DETERMINISTIC_ROLE_ASSIGNMENT_NAME
      && json.scope === KEY_VAULT_RESOURCE_ID
      && json.principalId === RBAC_PLAN_LOCKS.principalId
      && keys.every((k) => SAFE_OUTPUT_KEYS.includes(k))
      && !unsafe.test(JSON.stringify(json))
      && getAzureMutationCounters().azureMutationCount === 0;
    greenCases.push({
      name: 'cli_plan_only_safe_ids',
      ok,
      exitCode: cli.status,
      safeOutputKeysOnly: true,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  GREEN cli_plan_only_safe_ids`);
  }

  // ── GREEN: live apply hard-disabled ────────────────────────────────────
  {
    const ok = PHASE_D_KV_SECRETS_USER_RBAC_LIVE_APPLY_ENABLED === false
      && /PHASE_D_KV_SECRETS_USER_RBAC_LIVE_APPLY_ENABLED\s*=\s*false/.test(
        fs.readFileSync(path.join(ROOT, 'scripts/lib/phase-d-kv-secrets-user-rbac-plan.js'), 'utf8'),
      )
      && !fs.readFileSync(CLI_PATH, 'utf8').includes('deployment group create')
      && !fs.readFileSync(CLI_PATH, 'utf8').includes('role assignment create');
    greenCases.push({
      name: 'live_apply_hard_disabled',
      ok,
      liveApplyEnabled: false,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  GREEN live_apply_hard_disabled`);
  }

  // ── Migration / product hash locks ─────────────────────────────────────
  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  const expectedBytes = fs.readFileSync(EXPECTED_PATH);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  const expected = JSON.parse(expectedBytes.toString('utf8'));
  const live028 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '028_tenant_services.sql'));
  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
  const live040 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '040_tenant_services_saas_catalog_columns.sql'));
  const live041 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '041_notification_surfpack_convergence.sql'));

  const hashesOk = integrity.ok === true
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
    && typeof DATE_WINDOW_PREDICATE === 'string' && DATE_WINDOW_PREDICATE.length > 0
    && typeof PRICE_UNIT_PREDICATE === 'string' && PRICE_UNIT_PREDICATE.length > 0;

  greenCases.push({
    name: 'migration_and_product_hashes_preserved',
    ok: hashesOk,
    forwardCount: forward.length,
    manifestHash,
    productFingerprint: CANON_FP,
  });
  console.log(`  ${hashesOk ? 'PASS' : 'FAIL'}  GREEN migration_and_product_hashes_preserved`);

  const allRedOk = redCases.every((c) => c.ok);
  const allGreenOk = greenCases.every((c) => c.ok);
  if (!allRedOk || !allGreenOk) {
    throw new Error('Slice 14H offline proof RED/GREEN failed');
  }

  const lockedPlan = buildLockedApplyPlan();
  fs.writeFileSync(APPLY_PLAN_PATH, `${JSON.stringify({
    ...lockedPlan,
    generatedAt,
    masterShaBasis: MASTER,
  }, null, 2)}\n`);

  const contract = {
    kind: 'sunset-schema-observer-slice14h-kv-secrets-user-rbac-plan-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    liveApplyCapability: false,
    liveApplyEnabled: false,
    liveMutation: false,
    mutates: false,
    firewallMutation: false,
    networkMutation: false,
    defaultEnabled: false,
    planOnly: true,
    azureWhatIfForbidden: true,
    azureDeployForbidden: true,
    keyVaultRetryForbidden: true,
    postgresForbidden: true,
    secretReadForbidden: true,
    migrationForbidden: true,
    ddlForbidden: true,
    ledgerForbidden: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14H',
    purpose: 'Define and offline-prove exactly one least-privilege Azure RBAC assignment (wh-staging-identity → Key Vault Secrets User → luna-sunset-staging-kv) resolving the Slice 14G 403, without deploying it.',
    assignment: {
      subscriptionId: RBAC_PLAN_LOCKS.subscriptionId,
      resourceGroup: RBAC_PLAN_LOCKS.resourceGroup,
      keyVaultName: RBAC_PLAN_LOCKS.keyVaultName,
      keyVaultResourceId: KEY_VAULT_RESOURCE_ID,
      managedIdentityName: RBAC_PLAN_LOCKS.managedIdentityName,
      principalId: RBAC_PLAN_LOCKS.principalId,
      principalType: 'ServicePrincipal',
      roleDefinitionId: RBAC_PLAN_LOCKS.roleDefinitionId,
      roleName: RBAC_PLAN_LOCKS.roleName,
      roleAssignmentName: DETERMINISTIC_ROLE_ASSIGNMENT_NAME,
      roleAssignmentResourceId: ROLE_ASSIGNMENT_RESOURCE_ID,
      scope: KEY_VAULT_RESOURCE_ID,
      scopeKind: 'keyVault',
      existingResourceReference: true,
      assignmentCount: 1,
    },
    determinism: {
      algorithm: 'azure-arm-bicep-guid-uuid-v5',
      namespace: '11fb06fb-712d-4ddd-98c7-e71bbd588830',
      inputs: [
        KEY_VAULT_RESOURCE_ID,
        RBAC_PLAN_LOCKS.principalId,
        RBAC_PLAN_LOCKS.roleDefinitionId,
      ],
      roleAssignmentName: DETERMINISTIC_ROLE_ASSIGNMENT_NAME,
    },
    commandContract: {
      script: 'scripts/run-phase-d-kv-secrets-user-rbac-plan.js',
      npm: 'phase-d:kv-secrets-user-rbac-plan',
      requiredEnv: [
        `${ENV_RBAC_PLAN}=1`,
        `AZURE_SUBSCRIPTION_ID=${RBAC_PLAN_LOCKS.subscriptionId}`,
      ],
      requiredArgv: [
        CLI_PLAN_ONLY,
        `--subscription ${RBAC_PLAN_LOCKS.subscriptionId}`,
        `--resource-group ${RBAC_PLAN_LOCKS.resourceGroup}`,
        `--key-vault ${RBAC_PLAN_LOCKS.keyVaultName}`,
        `--principal-id ${RBAC_PLAN_LOCKS.principalId}`,
        `--role-definition-id ${RBAC_PLAN_LOCKS.roleDefinitionId}`,
      ],
      forbiddenArgv: [...FORBIDDEN_ARGV_FLAGS],
      safeOutputKeys: [...SAFE_OUTPUT_KEYS],
    },
    bicep: {
      module: RBAC_PLAN_LOCKS.bicepModuleRel,
      parameters: RBAC_PLAN_LOCKS.bicepParametersRel,
      wiredIntoMain: false,
      fullRgDeployment: false,
    },
    predicatesUnchangedFrom14A: {
      date_window: DATE_WINDOW_PREDICATE,
      price_unit: PRICE_UNIT_PREDICATE,
    },
    forbidden: [
      'Azure what-if/deploy/RBAC mutation',
      'Key Vault retry/secret read',
      'PostgreSQL / DB / network',
      'migration/DDL/ledger',
      'Owner/Contributor/Admin roles',
      'subscription/RG/wildcard scope',
      'delete / duplicate / random GUID',
      'full-RG/main.bicep deployment',
    ],
    nonGoals: [
      'Do not deploy the role assignment in Slice 14H',
      'Do not claim Slice 14G credential-preflight repaired',
      'Do not claim Sunset schema repaired',
      'Still product_schema_differs',
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14h-kv-secrets-user-rbac-plan-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14H',
    outcome: 'phase_d_kv_secrets_user_rbac_plan_offline_proven',
    stillProductSchemaDiffers: true,
    phaseDConstraintsApplied: false,
    liveMutation: false,
    liveApplyEnabled: false,
    azureConnectivity: false,
    azureWhatIf: false,
    azureDeploy: false,
    azureRbacMutation: false,
    firewallAction: false,
    networkMutation: false,
    keyVaultRetry: false,
    secretRead: false,
    realPostgresCall: false,
    migrationAdded: false,
    ledgerWritten: false,
    applyFlagPresent: false,
    appliesConstraints: false,
    writesLedger: false,
    forwardCountUnchanged: 39,
    newForwardMigration: false,
    defaultDisabled: true,
    planOnlyRequired: true,
    exactTargetCliConfirmationRequired: true,
    assignmentCount: 1,
    roleAssignmentName: DETERMINISTIC_ROLE_ASSIGNMENT_NAME,
    scope: KEY_VAULT_RESOURCE_ID,
    principalId: RBAC_PLAN_LOCKS.principalId,
    roleDefinitionId: RBAC_PLAN_LOCKS.roleDefinitionId,
    principalType: 'ServicePrincipal',
    deterministicGuid: DETERMINISTIC_ROLE_ASSIGNMENT_NAME,
    resolvesSlice14gHttp403: true,
    migrationHashes: {
      '028': LOCKED_13C_SHA['028'],
      '035': LOCKED_13C_SHA['035'],
      '040': LOCKED_13C_SHA['040'],
      '041': LOCKED_13C_SHA['041'],
    },
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    migration028Sha256CanonicalLfV1: LOCKED_13C_SHA['028'],
    offlineGates: {
      defaultPathZeroAzureMutation: true,
      missingEnvZeroMutation: true,
      missingPlanOnlyFlagZeroMutation: true,
      wrongExactTargetsZeroMutation: true,
      scopeBroadeningRejected: true,
      ownerContributorAdminRejected: true,
      deleteRejected: true,
      duplicateOrRandomGuidRejected: true,
      unrelatedChangesRejected: true,
      forbiddenApplyDeployWhatIfArgv: true,
    },
    redCases,
    greenCases,
    redCaseCount: redCases.length,
    greenCaseCount: greenCases.length,
    azureMutationCounts: {
      defaultPath: 0,
      planOnlyPath: 0,
      wrongArgsPath: 0,
    },
    safeOutputProof: {
      keys: [...SAFE_OUTPUT_KEYS],
      includesSafeIdsOnly: true,
      excludesSecretsTokensDsns: true,
    },
  };

  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

  const findings = `# FOUNDATION Slice 14H — Key Vault Secrets User RBAC apply-plan (offline)

**Status:** complete (plan-only; live apply hard-disabled; zero Azure mutation)
**Master basis:** \`${MASTER}\`
**Generated:** ${generatedAt}

## Outcome

Defined and offline-proven **exactly one** least-privilege Azure RBAC assignment that resolves the Slice **14G** live credential-preflight **403** — without deploying it.

| Field | Value |
|-------|-------|
| Principal | \`wh-staging-identity\` / \`${RBAC_PLAN_LOCKS.principalId}\` |
| Role | Key Vault Secrets User / \`${RBAC_PLAN_LOCKS.roleDefinitionId}\` |
| Scope | \`${KEY_VAULT_RESOURCE_ID}\` |
| Assignment name (deterministic) | \`${DETERMINISTIC_ROLE_ASSIGNMENT_NAME}\` |
| principalType | ServicePrincipal |
| Module | \`${RBAC_PLAN_LOCKS.bicepModuleRel}\` (standalone; **not** in \`main.bicep\`) |

Determinism: Bicep \`guid(existingKeyVault.id, principalId, roleDefinitionId)\` ≡ ARM UUID v5 namespace \`11fb06fb-712d-4ddd-98c7-e71bbd588830\` over hyphen-joined inputs.

## Operator command (plan-only; default refuse)

\`\`\`bash
SUNSET_PHASE_D_KV_SECRETS_USER_RBAC_PLAN=1 \\
AZURE_SUBSCRIPTION_ID=${RBAC_PLAN_LOCKS.subscriptionId} \\
npm run phase-d:kv-secrets-user-rbac-plan -- \\
  --plan-only \\
  --subscription ${RBAC_PLAN_LOCKS.subscriptionId} \\
  --resource-group ${RBAC_PLAN_LOCKS.resourceGroup} \\
  --key-vault ${RBAC_PLAN_LOCKS.keyVaultName} \\
  --managed-identity ${RBAC_PLAN_LOCKS.managedIdentityName} \\
  --principal-id ${RBAC_PLAN_LOCKS.principalId} \\
  --role-definition-id ${RBAC_PLAN_LOCKS.roleDefinitionId} \\
  --scope ${KEY_VAULT_RESOURCE_ID}
\`\`\`

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default/missing env/flag; wrong subscription/RG/vault/principal/role; scope broadening; Owner/Contributor/Admin; delete; duplicate/random GUID; unrelated changes; apply/deploy/what-if argv |
| GREEN | exact locked plan + deterministic GUID; standalone Bicep existing-vault locks; CLI safe IDs; live apply hard-disabled; migration/product hashes preserved |

## Non-goals / still open

- **No** Azure what-if / deploy / RBAC mutation in this slice
- **No** Key Vault retry or secret read
- **No** PostgreSQL / network / migration / DDL / ledger
- Still \`product_schema_differs\`
- **Do not claim** Slice 14G credential-preflight or Sunset repaired.

## Zero live mutation

Plan-only offline emission. Default/wrong args → zero Azure mutation counters. Live apply flag remains \`false\`.
`;

  fs.writeFileSync(FINDINGS_PATH, findings);

  console.log(`\nWrote ${path.relative(ROOT, APPLY_PLAN_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log('\nprove:sunset-schema-slice14h-kv-secrets-user-rbac-plan GREEN');
}

main();
