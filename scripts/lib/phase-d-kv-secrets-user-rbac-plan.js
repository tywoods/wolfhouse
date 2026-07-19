'use strict';

/**
 * phase-d-kv-secrets-user-rbac-plan — FOUNDATION Slice 14H
 *
 * Offline locked apply-plan for exactly one least-privilege Azure RBAC assignment:
 * wh-staging-identity → Key Vault Secrets User → luna-sunset-staging-kv only.
 *
 * Resolves the Slice 14G live credential-preflight 403 without deploying.
 * Live apply / what-if / role-assignment mutation are hard-disabled.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** ARM/Bicep guid() namespace (RFC 4122 §4.3 / GuidUtility). */
const ARM_GUID_NAMESPACE = '11fb06fb-712d-4ddd-98c7-e71bbd588830';

const ROLE_DEFINITION_ID_SECRETS_USER = '4633458b-17de-408a-b874-0445c86b69e6';
const ROLE_NAME_SECRETS_USER = 'Key Vault Secrets User';

/** Well-known built-in role definition IDs that must never appear in this plan. */
const FORBIDDEN_ROLE_DEFINITION_IDS = Object.freeze({
  Owner: '8e3af657-a8ff-443c-a75c-2fe8c4bcb635',
  Contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c',
  'User Access Administrator': '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9',
  'Key Vault Administrator': '00482a5a-887f-4fb3-b363-3b7fe8e74483',
  'Key Vault Secrets Officer': 'b86a8fe4-44ce-4948-aee5-eccb2c03dd83',
  'Key Vault Contributor': 'f25e0fa2-a7c8-4377-a976-54943a77a395',
});

const FORBIDDEN_ROLE_NAME_PATTERNS = Object.freeze([
  /^Owner$/i,
  /^Contributor$/i,
  /Administrator/i,
  /Admin$/i,
  /Officer/i,
  /Contributor$/i,
]);

/**
 * Live apply hard-disabled for Slice 14H. Never flip in this slice.
 * Offline plan/prove only — no az what-if / deploy / RBAC mutation.
 */
const PHASE_D_KV_SECRETS_USER_RBAC_LIVE_APPLY_ENABLED = false;

const ENV_RBAC_PLAN = 'SUNSET_PHASE_D_KV_SECRETS_USER_RBAC_PLAN';
const CLI_PLAN_ONLY = '--plan-only';

const RBAC_PLAN_LOCKS = Object.freeze({
  subscriptionId: '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9',
  resourceGroup: 'luna-sunset-staging-rg',
  keyVaultName: 'luna-sunset-staging-kv',
  managedIdentityName: 'wh-staging-identity',
  principalId: 'e3136eed-948b-4947-a26e-50a33b45a41a',
  principalType: 'ServicePrincipal',
  roleDefinitionId: ROLE_DEFINITION_ID_SECRETS_USER,
  roleName: ROLE_NAME_SECRETS_USER,
  bicepModuleRel: 'infra/azure/sunset-staging/wh-staging-identity-kv-secrets-user-role.bicep',
  bicepParametersRel: 'infra/azure/sunset-staging/wh-staging-identity-kv-secrets-user-role.parameters.json',
});

function buildKeyVaultResourceId(locks = RBAC_PLAN_LOCKS) {
  return (
    `/subscriptions/${locks.subscriptionId}`
    + `/resourceGroups/${locks.resourceGroup}`
    + `/providers/Microsoft.KeyVault/vaults/${locks.keyVaultName}`
  );
}

function buildRoleDefinitionResourceId(locks = RBAC_PLAN_LOCKS) {
  return (
    `/subscriptions/${locks.subscriptionId}`
    + `/providers/Microsoft.Authorization/roleDefinitions/${locks.roleDefinitionId}`
  );
}

/**
 * Azure ARM/Bicep guid(): UUID v5 over namespace 11fb06fb-… with names joined by '-'.
 */
function azureArmGuid(...parts) {
  const name = parts.map((p) => String(p)).join('-');
  const ns = Buffer.from(ARM_GUID_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(ns).update(name, 'utf8').digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const KEY_VAULT_RESOURCE_ID = buildKeyVaultResourceId();
const ROLE_DEFINITION_RESOURCE_ID = buildRoleDefinitionResourceId();
const DETERMINISTIC_ROLE_ASSIGNMENT_NAME = azureArmGuid(
  KEY_VAULT_RESOURCE_ID,
  RBAC_PLAN_LOCKS.principalId,
  RBAC_PLAN_LOCKS.roleDefinitionId,
);
const ROLE_ASSIGNMENT_RESOURCE_ID = (
  `${KEY_VAULT_RESOURCE_ID}/providers/Microsoft.Authorization/roleAssignments/`
  + `${DETERMINISTIC_ROLE_ASSIGNMENT_NAME}`
);

/** Existing Sunset CA identity assignment name on the same vault (must not be reused). */
const EXISTING_SUNSET_IDENTITY_KV_ROLE_ASSIGNMENT_NAME = 'e6a5bc9b-2795-58c6-bccb-2dc8479dd970';

const LOCKED_APPLY_PLAN = Object.freeze({
  kind: 'sunset-phase-d-kv-secrets-user-rbac-apply-plan',
  slice: '14H',
  secretFree: true,
  liveApplyEnabled: false,
  liveMutation: false,
  operation: 'createOrUpdateRoleAssignment',
  assignmentCount: 1,
  subscriptionId: RBAC_PLAN_LOCKS.subscriptionId,
  resourceGroup: RBAC_PLAN_LOCKS.resourceGroup,
  keyVaultName: RBAC_PLAN_LOCKS.keyVaultName,
  keyVaultResourceId: KEY_VAULT_RESOURCE_ID,
  managedIdentityName: RBAC_PLAN_LOCKS.managedIdentityName,
  principalId: RBAC_PLAN_LOCKS.principalId,
  principalType: RBAC_PLAN_LOCKS.principalType,
  roleDefinitionId: RBAC_PLAN_LOCKS.roleDefinitionId,
  roleName: RBAC_PLAN_LOCKS.roleName,
  roleDefinitionResourceId: ROLE_DEFINITION_RESOURCE_ID,
  roleAssignmentName: DETERMINISTIC_ROLE_ASSIGNMENT_NAME,
  roleAssignmentResourceId: ROLE_ASSIGNMENT_RESOURCE_ID,
  scope: KEY_VAULT_RESOURCE_ID,
  scopeKind: 'keyVault',
  existingResourceReference: true,
  bicepModule: RBAC_PLAN_LOCKS.bicepModuleRel,
  bicepParameters: RBAC_PLAN_LOCKS.bicepParametersRel,
  resolvesSlice14gHttp403: true,
  notes: [
    'Exactly one assignment: wh-staging-identity → Key Vault Secrets User → luna-sunset-staging-kv',
    'Deterministic name via Bicep guid(existingKeyVault.id, principalId, roleDefinitionId)',
    'Standalone module — not wired into main.bicep; no full-RG deployment',
    'Slice 14H is plan-only — zero Azure mutation',
  ],
});

const SAFE_OUTPUT_KEYS = Object.freeze([
  'ok',
  'code',
  'planOnly',
  'liveApplyEnabled',
  'liveMutation',
  'azureMutationCount',
  'assignmentCount',
  'subscriptionId',
  'resourceGroup',
  'keyVaultName',
  'keyVaultResourceId',
  'managedIdentityName',
  'principalId',
  'principalType',
  'roleDefinitionId',
  'roleName',
  'roleAssignmentName',
  'roleAssignmentResourceId',
  'scope',
  'scopeKind',
  'bicepModule',
  'resolvesSlice14gHttp403',
  'errors',
  'message',
  'note',
]);

const FORBIDDEN_ARGV_FLAGS = Object.freeze([
  '--apply',
  '--deploy',
  '--what-if',
  '--whatif',
  '--create',
  '--delete',
  '--remove',
  '--update',
  '--force',
  '--subscription-scope',
  '--resource-group-scope',
  '--scope-wildcard',
  '--dsn',
  '--connection-string',
  '--database-url',
  '--token',
  '--access-token',
  '--secret-value',
]);

/** Process-local counters — prove default/wrong paths never touch Azure. */
let azureMutationCount = 0;
let azureWhatIfCount = 0;
let azureDeployCount = 0;
let azureRoleAssignmentMutateCount = 0;
let azureKeyVaultReadCount = 0;
let azureNetworkMutationCount = 0;

function getAzureMutationCounters() {
  return {
    azureMutationCount,
    azureWhatIfCount,
    azureDeployCount,
    azureRoleAssignmentMutateCount,
    azureKeyVaultReadCount,
    azureNetworkMutationCount,
  };
}

function resetAzureMutationCounters() {
  azureMutationCount = 0;
  azureWhatIfCount = 0;
  azureDeployCount = 0;
  azureRoleAssignmentMutateCount = 0;
  azureKeyVaultReadCount = 0;
  azureNetworkMutationCount = 0;
}

/** Test-only: would increment if live Azure were ever invoked (never called on plan path). */
function recordForbiddenAzureMutation(kind) {
  azureMutationCount += 1;
  if (kind === 'what-if') azureWhatIfCount += 1;
  if (kind === 'deploy') azureDeployCount += 1;
  if (kind === 'roleAssignment') azureRoleAssignmentMutateCount += 1;
  if (kind === 'keyVaultRead') azureKeyVaultReadCount += 1;
  if (kind === 'network') azureNetworkMutationCount += 1;
}

function argvFlagValue(argv, flag) {
  const arr = Array.isArray(argv) ? argv : [];
  const i = arr.indexOf(flag);
  if (i < 0 || i + 1 >= arr.length) return null;
  return String(arr[i + 1]);
}

function hasForbiddenArgv(argv) {
  const arr = Array.isArray(argv) ? argv : [];
  return FORBIDDEN_ARGV_FLAGS.filter((f) => arr.includes(f));
}

function isForbiddenRoleDefinitionId(roleDefinitionId) {
  const id = String(roleDefinitionId || '').toLowerCase();
  return Object.values(FORBIDDEN_ROLE_DEFINITION_IDS).some((x) => x.toLowerCase() === id);
}

function isForbiddenRoleName(roleName) {
  const name = String(roleName || '');
  return FORBIDDEN_ROLE_NAME_PATTERNS.some((re) => re.test(name));
}

function isVaultOnlyScope(scope, locks = RBAC_PLAN_LOCKS) {
  const expected = buildKeyVaultResourceId(locks);
  return String(scope || '') === expected;
}

function isBroadScope(scope, locks = RBAC_PLAN_LOCKS) {
  const s = String(scope || '');
  if (!s) return true;
  if (s === '*' || s === '/*' || s.endsWith('/*')) return true;
  if (s === `/subscriptions/${locks.subscriptionId}`) return true;
  if (s === `/subscriptions/${locks.subscriptionId}/`) return true;
  if (s === `/subscriptions/${locks.subscriptionId}/resourceGroups/${locks.resourceGroup}`) return true;
  if (/\/providers\/Microsoft\.Authorization\/roleAssignments\//i.test(s) === false
    && /\/providers\/Microsoft\.KeyVault\/vaults\//i.test(s) === false
    && (/\/subscriptions\//i.test(s) || /\/resourceGroups\//i.test(s))) {
    // subscription or RG without vault segment
    if (!/\/providers\/Microsoft\.KeyVault\/vaults\//i.test(s)) return true;
  }
  if (/\/subscriptions\/[^/]+$/i.test(s)) return true;
  if (/\/resourceGroups\/[^/]+$/i.test(s)) return true;
  return false;
}

/**
 * Reject any candidate assignment that is not the exact locked least-privilege plan.
 * Used by offline RED proofs — never contacts Azure.
 */
function evaluateAssignmentCandidate(candidate = {}) {
  const errors = [];
  const c = candidate && typeof candidate === 'object' ? candidate : {};

  if (c.operation === 'delete' || c.delete === true || c.action === 'delete') {
    errors.push({ code: 'delete_rejected', message: 'delete operations are forbidden' });
  }

  if (c.subscriptionId != null && c.subscriptionId !== RBAC_PLAN_LOCKS.subscriptionId) {
    errors.push({ code: 'subscription_rejected', message: 'subscription must match lock' });
  }
  if (c.resourceGroup != null && c.resourceGroup !== RBAC_PLAN_LOCKS.resourceGroup) {
    errors.push({ code: 'resource_group_rejected', message: 'resource group must match lock' });
  }
  if (c.keyVaultName != null && c.keyVaultName !== RBAC_PLAN_LOCKS.keyVaultName) {
    errors.push({ code: 'vault_rejected', message: 'key vault must match lock' });
  }
  if (c.principalId != null && c.principalId !== RBAC_PLAN_LOCKS.principalId) {
    errors.push({ code: 'principal_rejected', message: 'principalId must match wh-staging-identity lock' });
  }
  if (c.managedIdentityName != null && c.managedIdentityName !== RBAC_PLAN_LOCKS.managedIdentityName) {
    errors.push({ code: 'principal_rejected', message: 'managed identity name must match lock' });
  }
  if (c.roleDefinitionId != null && c.roleDefinitionId !== RBAC_PLAN_LOCKS.roleDefinitionId) {
    errors.push({ code: 'role_rejected', message: 'roleDefinitionId must be Key Vault Secrets User' });
  }
  if (c.roleName != null && c.roleName !== RBAC_PLAN_LOCKS.roleName) {
    errors.push({ code: 'role_rejected', message: 'roleName must be Key Vault Secrets User' });
  }
  if (c.principalType != null && c.principalType !== RBAC_PLAN_LOCKS.principalType) {
    errors.push({ code: 'principal_type_rejected', message: 'principalType must be ServicePrincipal' });
  }

  if (c.roleDefinitionId != null && isForbiddenRoleDefinitionId(c.roleDefinitionId)) {
    errors.push({ code: 'privileged_role_rejected', message: 'Owner/Contributor/Admin roles forbidden' });
  }
  if (c.roleName != null && isForbiddenRoleName(c.roleName)) {
    errors.push({ code: 'privileged_role_rejected', message: 'Owner/Contributor/Admin role names forbidden' });
  }

  if (c.scope != null) {
    if (isBroadScope(c.scope)) {
      errors.push({ code: 'scope_broadening_rejected', message: 'subscription/RG/wildcard scope forbidden' });
    } else if (!isVaultOnlyScope(c.scope)) {
      errors.push({ code: 'scope_rejected', message: 'scope must be exact vault resource id' });
    }
  }

  if (c.roleAssignmentName != null) {
    if (c.roleAssignmentName === EXISTING_SUNSET_IDENTITY_KV_ROLE_ASSIGNMENT_NAME) {
      errors.push({
        code: 'duplicate_guid_rejected',
        message: 'must not reuse existing sunset-identity assignment GUID',
      });
    } else if (c.roleAssignmentName !== DETERMINISTIC_ROLE_ASSIGNMENT_NAME) {
      errors.push({
        code: 'random_guid_rejected',
        message: 'roleAssignmentName must equal deterministic Bicep guid()',
      });
    }
  }

  if (c.unrelated === true || (Array.isArray(c.extraAssignments) && c.extraAssignments.length > 0)) {
    errors.push({ code: 'unrelated_changes_rejected', message: 'exactly one assignment; no extras' });
  }
  if (c.assignmentCount != null && Number(c.assignmentCount) !== 1) {
    errors.push({ code: 'unrelated_changes_rejected', message: 'assignmentCount must be 1' });
  }
  if (c.networkMutation === true || c.firewallAction === true || c.postgresMutation === true) {
    errors.push({ code: 'unrelated_changes_rejected', message: 'network/PG/firewall changes forbidden' });
  }
  if (c.secretRead === true || c.migration === true || c.ledgerWrite === true || c.ddl === true) {
    errors.push({ code: 'unrelated_changes_rejected', message: 'secret read / migration / DDL / ledger forbidden' });
  }

  // Full exact match when candidate claims to be the locked plan
  if (c.assertExact === true) {
    const locked = buildLockedApplyPlan();
    for (const key of [
      'subscriptionId',
      'resourceGroup',
      'keyVaultName',
      'principalId',
      'principalType',
      'roleDefinitionId',
      'roleName',
      'roleAssignmentName',
      'scope',
      'keyVaultResourceId',
    ]) {
      if (c[key] !== locked[key]) {
        errors.push({ code: 'plan_mismatch', message: `field ${key} must match locked plan` });
      }
    }
  }

  const ok = errors.length === 0;
  return {
    ok,
    code: ok ? 'assignment_candidate_ok' : 'assignment_candidate_rejected',
    errors,
    liveMutation: false,
    azureMutationCount: getAzureMutationCounters().azureMutationCount,
  };
}

function buildLockedApplyPlan() {
  return { ...LOCKED_APPLY_PLAN };
}

function planMatchesLocked(plan) {
  const locked = buildLockedApplyPlan();
  if (!plan || typeof plan !== 'object') return false;
  return (
    plan.subscriptionId === locked.subscriptionId
    && plan.resourceGroup === locked.resourceGroup
    && plan.keyVaultName === locked.keyVaultName
    && plan.keyVaultResourceId === locked.keyVaultResourceId
    && plan.principalId === locked.principalId
    && plan.principalType === locked.principalType
    && plan.roleDefinitionId === locked.roleDefinitionId
    && plan.roleName === locked.roleName
    && plan.roleAssignmentName === locked.roleAssignmentName
    && plan.roleAssignmentResourceId === locked.roleAssignmentResourceId
    && plan.scope === locked.scope
    && plan.scopeKind === locked.scopeKind
    && plan.assignmentCount === 1
    && plan.liveApplyEnabled === false
    && plan.liveMutation === false
    && plan.existingResourceReference === true
    && plan.operation === 'createOrUpdateRoleAssignment'
  );
}

function evaluateRbacPlanGates({ env = process.env, argv = [] } = {}) {
  const errors = [];
  const forbidden = hasForbiddenArgv(argv);
  if (forbidden.length) {
    errors.push({
      code: 'forbidden_argv',
      message: `forbidden flags: ${forbidden.join(', ')}`,
      flags: forbidden,
    });
  }

  if (String(env[ENV_RBAC_PLAN] || '') !== '1') {
    errors.push({
      code: 'env_required',
      message: `${ENV_RBAC_PLAN}=1 required`,
    });
  }

  if (!argv.includes(CLI_PLAN_ONLY)) {
    errors.push({
      code: 'plan_only_required',
      message: `${CLI_PLAN_ONLY} required`,
    });
  }

  const subscription = argvFlagValue(argv, '--subscription');
  const resourceGroup = argvFlagValue(argv, '--resource-group');
  const keyVault = argvFlagValue(argv, '--key-vault');
  const principalId = argvFlagValue(argv, '--principal-id');
  const roleDefinitionId = argvFlagValue(argv, '--role-definition-id');
  const managedIdentity = argvFlagValue(argv, '--managed-identity');
  const scope = argvFlagValue(argv, '--scope');

  if (subscription !== RBAC_PLAN_LOCKS.subscriptionId) {
    errors.push({ code: 'subscription_rejected', message: 'exact --subscription required' });
  }
  if (resourceGroup !== RBAC_PLAN_LOCKS.resourceGroup) {
    errors.push({ code: 'resource_group_rejected', message: 'exact --resource-group required' });
  }
  if (keyVault !== RBAC_PLAN_LOCKS.keyVaultName) {
    errors.push({ code: 'vault_rejected', message: 'exact --key-vault required' });
  }
  if (principalId !== RBAC_PLAN_LOCKS.principalId) {
    errors.push({ code: 'principal_rejected', message: 'exact --principal-id required' });
  }
  if (roleDefinitionId !== RBAC_PLAN_LOCKS.roleDefinitionId) {
    errors.push({ code: 'role_rejected', message: 'exact --role-definition-id required' });
  }
  if (managedIdentity != null && managedIdentity !== RBAC_PLAN_LOCKS.managedIdentityName) {
    errors.push({ code: 'principal_rejected', message: 'exact --managed-identity required when present' });
  }
  if (scope != null && scope !== KEY_VAULT_RESOURCE_ID) {
    errors.push({ code: 'scope_rejected', message: 'exact vault --scope required when present' });
  }

  if (PHASE_D_KV_SECRETS_USER_RBAC_LIVE_APPLY_ENABLED === true) {
    errors.push({
      code: 'live_apply_must_stay_disabled',
      message: 'Slice 14H live apply must remain false',
    });
  }

  const ok = errors.length === 0;
  return {
    ok,
    code: ok ? 'rbac_plan_gates_ok' : 'rbac_plan_gates_rejected',
    errors,
    liveApplyEnabled: PHASE_D_KV_SECRETS_USER_RBAC_LIVE_APPLY_ENABLED,
    liveMutation: false,
    azureMutationCount: getAzureMutationCounters().azureMutationCount,
    confirmed: ok
      ? {
        subscriptionId: RBAC_PLAN_LOCKS.subscriptionId,
        resourceGroup: RBAC_PLAN_LOCKS.resourceGroup,
        keyVaultName: RBAC_PLAN_LOCKS.keyVaultName,
        managedIdentityName: RBAC_PLAN_LOCKS.managedIdentityName,
        principalId: RBAC_PLAN_LOCKS.principalId,
        roleDefinitionId: RBAC_PLAN_LOCKS.roleDefinitionId,
        roleAssignmentName: DETERMINISTIC_ROLE_ASSIGNMENT_NAME,
        scope: KEY_VAULT_RESOURCE_ID,
      }
      : undefined,
  };
}

function safePlanOutput(plan, extra = {}) {
  const counters = getAzureMutationCounters();
  return {
    ok: true,
    code: 'rbac_plan_only_ok',
    planOnly: true,
    liveApplyEnabled: false,
    liveMutation: false,
    azureMutationCount: counters.azureMutationCount,
    assignmentCount: 1,
    subscriptionId: plan.subscriptionId,
    resourceGroup: plan.resourceGroup,
    keyVaultName: plan.keyVaultName,
    keyVaultResourceId: plan.keyVaultResourceId,
    managedIdentityName: plan.managedIdentityName,
    principalId: plan.principalId,
    principalType: plan.principalType,
    roleDefinitionId: plan.roleDefinitionId,
    roleName: plan.roleName,
    roleAssignmentName: plan.roleAssignmentName,
    roleAssignmentResourceId: plan.roleAssignmentResourceId,
    scope: plan.scope,
    scopeKind: plan.scopeKind,
    bicepModule: plan.bicepModule,
    resolvesSlice14gHttp403: true,
    note: 'Plan-only — zero Azure mutation (no what-if/deploy/RBAC create)',
    ...extra,
  };
}

/**
 * Execute plan-only path. Never calls Azure. Never mutates RBAC.
 */
function executeRbacPlanOnly({ env = process.env, argv = [] } = {}) {
  const gates = evaluateRbacPlanGates({ env, argv });
  if (!gates.ok) {
    return {
      ok: false,
      code: gates.code,
      planOnly: true,
      liveApplyEnabled: false,
      liveMutation: false,
      azureMutationCount: getAzureMutationCounters().azureMutationCount,
      errors: gates.errors,
      message: 'RBAC plan gates rejected — zero Azure mutation',
    };
  }

  const plan = buildLockedApplyPlan();
  if (!planMatchesLocked(plan)) {
    return {
      ok: false,
      code: 'locked_plan_integrity_failed',
      planOnly: true,
      liveApplyEnabled: false,
      liveMutation: false,
      azureMutationCount: getAzureMutationCounters().azureMutationCount,
      errors: [{ code: 'locked_plan_integrity_failed', message: 'internal locked plan mismatch' }],
    };
  }

  // Explicitly refuse any live apply path even if somehow enabled later.
  if (PHASE_D_KV_SECRETS_USER_RBAC_LIVE_APPLY_ENABLED || argv.includes('--apply') || argv.includes('--deploy')) {
    return {
      ok: false,
      code: 'live_apply_disabled',
      planOnly: true,
      liveApplyEnabled: false,
      liveMutation: false,
      azureMutationCount: getAzureMutationCounters().azureMutationCount,
      errors: [{ code: 'live_apply_disabled', message: 'Slice 14H cannot apply/deploy' }],
    };
  }

  return safePlanOutput(plan);
}

function exactRbacPlanArgv() {
  return [
    CLI_PLAN_ONLY,
    '--subscription', RBAC_PLAN_LOCKS.subscriptionId,
    '--resource-group', RBAC_PLAN_LOCKS.resourceGroup,
    '--key-vault', RBAC_PLAN_LOCKS.keyVaultName,
    '--managed-identity', RBAC_PLAN_LOCKS.managedIdentityName,
    '--principal-id', RBAC_PLAN_LOCKS.principalId,
    '--role-definition-id', RBAC_PLAN_LOCKS.roleDefinitionId,
    '--scope', KEY_VAULT_RESOURCE_ID,
  ];
}

function rbacPlanEnv(base = {}) {
  return {
    ...base,
    [ENV_RBAC_PLAN]: '1',
    AZURE_SUBSCRIPTION_ID: RBAC_PLAN_LOCKS.subscriptionId,
  };
}

function renderRbacPlanUsage() {
  return [
    'Phase D Key Vault Secrets User RBAC apply-plan (FOUNDATION Slice 14H)',
    '',
    'DEFAULT: refused (zero Azure mutation). Plan-only offline emission of the locked',
    'least-privilege assignment that resolves the Slice 14G Key Vault 403.',
    '',
    'Required:',
    `  ${ENV_RBAC_PLAN}=1`,
    `  ${CLI_PLAN_ONLY}`,
    `  --subscription ${RBAC_PLAN_LOCKS.subscriptionId}`,
    `  --resource-group ${RBAC_PLAN_LOCKS.resourceGroup}`,
    `  --key-vault ${RBAC_PLAN_LOCKS.keyVaultName}`,
    `  --principal-id ${RBAC_PLAN_LOCKS.principalId}`,
    `  --role-definition-id ${RBAC_PLAN_LOCKS.roleDefinitionId}`,
    '',
    'Optional exact confirms:',
    `  --managed-identity ${RBAC_PLAN_LOCKS.managedIdentityName}`,
    `  --scope ${KEY_VAULT_RESOURCE_ID}`,
    '',
    'Forbidden: --apply --deploy --what-if --delete and privileged/broad scopes.',
    'Live apply is hard-disabled. Output: safe IDs only.',
  ].join('\n');
}

function assertBicepModuleSource(rootDir) {
  const rel = RBAC_PLAN_LOCKS.bicepModuleRel;
  const abs = path.join(rootDir, rel);
  const src = fs.readFileSync(abs, 'utf8');
  const checks = {
    exists: fs.existsSync(abs),
    existingKeyVault: /resource existingKeyVault 'Microsoft\.KeyVault\/vaults@/.test(src),
    existingKeyword: /\bexisting\s*=/.test(src),
    secretsUserRoleId: src.includes(ROLE_DEFINITION_ID_SECRETS_USER),
    principalTypeServicePrincipal: /principalType:\s*'ServicePrincipal'/.test(src),
    guidDeterministic: /guid\(existingKeyVault\.id,\s*principalId,\s*'4633458b-17de-408a-b874-0445c86b69e6'\)/.test(src),
    scopeExistingVault: /scope:\s*existingKeyVault/.test(src),
    notWiredIntoMainHint: /do NOT wire into main\.bicep/i.test(src),
    noOwnerContributor: !/8e3af657-a8ff-443c-a75c-2fe8c4bcb635|b24988ac-6180-42a0-ab88-20f7382dd24c/.test(src),
  };
  checks.ok = Object.values(checks).every(Boolean);
  return { rel, checks, src };
}

function assertNotWiredIntoMain(rootDir) {
  const mainPath = path.join(rootDir, 'infra/azure/sunset-staging/main.bicep');
  const mainSrc = fs.readFileSync(mainPath, 'utf8');
  return {
    ok: !/wh-staging-identity-kv-secrets-user-role\.bicep/.test(mainSrc),
    mainPath,
  };
}

module.exports = {
  ARM_GUID_NAMESPACE,
  ROLE_DEFINITION_ID_SECRETS_USER,
  ROLE_NAME_SECRETS_USER,
  FORBIDDEN_ROLE_DEFINITION_IDS,
  PHASE_D_KV_SECRETS_USER_RBAC_LIVE_APPLY_ENABLED,
  ENV_RBAC_PLAN,
  CLI_PLAN_ONLY,
  RBAC_PLAN_LOCKS,
  KEY_VAULT_RESOURCE_ID,
  ROLE_DEFINITION_RESOURCE_ID,
  DETERMINISTIC_ROLE_ASSIGNMENT_NAME,
  ROLE_ASSIGNMENT_RESOURCE_ID,
  EXISTING_SUNSET_IDENTITY_KV_ROLE_ASSIGNMENT_NAME,
  LOCKED_APPLY_PLAN,
  SAFE_OUTPUT_KEYS,
  FORBIDDEN_ARGV_FLAGS,
  azureArmGuid,
  buildKeyVaultResourceId,
  buildRoleDefinitionResourceId,
  buildLockedApplyPlan,
  planMatchesLocked,
  evaluateAssignmentCandidate,
  evaluateRbacPlanGates,
  executeRbacPlanOnly,
  exactRbacPlanArgv,
  rbacPlanEnv,
  renderRbacPlanUsage,
  safePlanOutput,
  getAzureMutationCounters,
  resetAzureMutationCounters,
  recordForbiddenAzureMutation,
  isForbiddenRoleDefinitionId,
  isForbiddenRoleName,
  isBroadScope,
  isVaultOnlyScope,
  assertBicepModuleSource,
  assertNotWiredIntoMain,
};
