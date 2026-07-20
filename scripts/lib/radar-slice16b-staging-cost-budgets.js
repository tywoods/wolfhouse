'use strict';

/**
 * radar-slice16b-staging-cost-budgets — RADAR Slice 16B
 *
 * Standalone staging-only ActualCost budget-threshold plan + preflight guards.
 * Offline-first. Live deploy hard-disabled. No secrets / personal emails in git.
 */

const fs = require('fs');
const path = require('path');

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const RESOURCE_GROUPS = Object.freeze(['wh-staging-rg', 'luna-sunset-staging-rg']);

const BUDGET_PLANS = Object.freeze({
  'wh-staging-rg': Object.freeze({
    resourceGroup: 'wh-staging-rg',
    amountUsd: 120,
    budgetName: 'wh-staging-rg-monthly-actualcost',
    actionGroupName: 'wh-staging-ops-budget-ag',
    actionGroupShortName: 'whStgBudAg',
    parametersExampleRel: 'infra/azure/staging-cost-budgets/parameters.wh-staging.example.json',
  }),
  'luna-sunset-staging-rg': Object.freeze({
    resourceGroup: 'luna-sunset-staging-rg',
    amountUsd: 40,
    budgetName: 'luna-sunset-staging-rg-monthly-actualcost',
    actionGroupName: 'luna-sunset-staging-ops-budget-ag',
    actionGroupShortName: 'sunStgBudAg',
    parametersExampleRel: 'infra/azure/staging-cost-budgets/parameters.luna-sunset-staging.example.json',
  }),
});

const THRESHOLDS = Object.freeze([80, 100]);
const BUDGET_START_DATE = '2026-07-01';
const DEPLOYMENT_MODE = 'Incremental';
const CATEGORY = 'Cost';
const TIME_GRAIN = 'Monthly';
const THRESHOLD_TYPE = 'Actual';
const OPERATOR = 'GreaterThan';

const ALLOWED_RESOURCE_TYPES = Object.freeze([
  'Microsoft.Insights/actionGroups',
  'Microsoft.Consumption/budgets',
]);

const FORBIDDEN_TYPE_MARKERS = Object.freeze([
  'Microsoft.App/containerApps',
  'Microsoft.App/managedEnvironments',
  'Microsoft.App/jobs',
  'Microsoft.DBforPostgreSQL/',
  'Microsoft.KeyVault/',
  'Microsoft.ManagedIdentity/',
  'Microsoft.Network/',
  'Microsoft.ContainerRegistry/',
  'Microsoft.OperationalInsights/',
  'Microsoft.Insights/components',
  'Microsoft.Cache/',
  'wh-prod-rg',
  'wh-prod-',
]);

const PERSONAL_EMAIL_DOMAINS = Object.freeze([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'me.com',
  'protonmail.com',
  'aol.com',
  'mail.com',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OPS_EMAIL_ENV = 'WH_RADAR_16B_OPS_NOTIFY_EMAIL';

const LOCKS = Object.freeze({
  slice: 'RADAR-16B',
  outcomeId: '16B_staging_rg_cost_budget_threshold',
  gateId: 'G09_cost_controls',
  progressClass: 'budget_threshold_partial_progress_only',
  doesNotImplement: 'anomaly_detection',
  masterBasis: '5a8b08d395e11c51baf928b918016d5dd5bb4afe',
  branch: 'radar/slice-16b-staging-cost-budgets',
  subscriptionId: SUBSCRIPTION_ID,
  resourceGroups: RESOURCE_GROUPS,
  budgetPlans: BUDGET_PLANS,
  thresholds: THRESHOLDS,
  budgetStartDate: BUDGET_START_DATE,
  deploymentMode: DEPLOYMENT_MODE,
  category: CATEGORY,
  timeGrain: TIME_GRAIN,
  thresholdType: THRESHOLD_TYPE,
  operator: OPERATOR,
  allowedResourceTypes: ALLOWED_RESOURCE_TYPES,
  forbiddenTypeMarkers: FORBIDDEN_TYPE_MARKERS,
  liveDeployEnabled: false,
  anomalyDetectionClaimed: false,
  bicepModuleRel: 'infra/azure/staging-cost-budgets/rg-budget-threshold.bicep',
  readmeRel: 'infra/azure/staging-cost-budgets/README.md',
  planFixtureRel: 'fixtures/radar-operations/slice16b-budget-threshold-plan.json',
  mainBicepForbiddenWiring: Object.freeze([
    'infra/azure/staging/main.bicep',
    'infra/azure/sunset-staging/main.bicep',
  ]),
  opsEmailEnv: OPS_EMAIL_ENV,
  opsEmailParam: 'opsNotifyEmail',
});

function redactEmail(email) {
  if (email == null || email === '') return null;
  const s = String(email);
  const at = s.indexOf('@');
  if (at < 1) return '[redacted-email]';
  return `${s[0]}***@${s.slice(at + 1)}`;
}

function validateOpsEmail(email) {
  const errors = [];
  if (email == null || String(email).trim() === '') {
    errors.push('missing_ops_notify_email');
    return { ok: false, errors };
  }
  const s = String(email).trim();
  if (s.includes('<REQUIRED') || s.includes('****') || /example\.test/i.test(s)) {
    errors.push('invalid_ops_notify_email_placeholder');
  }
  if (!EMAIL_RE.test(s)) {
    errors.push('invalid_ops_notify_email_format');
  }
  const domain = s.includes('@') ? s.split('@').pop().toLowerCase() : '';
  if (PERSONAL_EMAIL_DOMAINS.includes(domain)) {
    errors.push('personal_ops_notify_email_domain_rejected');
  }
  return { ok: errors.length === 0, errors, email: s };
}

/**
 * Exact subscription + RG short-circuit. Call before any Azure dispatch.
 */
function assertExactStagingScope({ subscriptionId, resourceGroup } = {}) {
  const errors = [];
  if (String(subscriptionId || '') !== SUBSCRIPTION_ID) {
    errors.push('wrong_subscription');
  }
  if (!RESOURCE_GROUPS.includes(String(resourceGroup || ''))) {
    errors.push('wrong_resource_group');
  }
  if (/prod/i.test(String(resourceGroup || ''))) {
    errors.push('production_resource_group_rejected');
  }
  return {
    ok: errors.length === 0,
    errors,
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: RESOURCE_GROUPS.includes(String(resourceGroup || ''))
      ? String(resourceGroup)
      : null,
  };
}

function assertDeploymentMode(mode) {
  const m = String(mode || '');
  if (m !== DEPLOYMENT_MODE) {
    return {
      ok: false,
      errors: ['non_incremental_mode_rejected'],
      required: DEPLOYMENT_MODE,
      got: m,
    };
  }
  return { ok: true, errors: [], mode: DEPLOYMENT_MODE };
}

function assertAmountsAndThresholds(planLike) {
  const errors = [];
  const rg = String(planLike.resourceGroup || '');
  const locked = BUDGET_PLANS[rg];
  if (!locked) {
    errors.push('unknown_resource_group_plan');
    return { ok: false, errors };
  }
  if (Number(planLike.amountUsd) !== locked.amountUsd) {
    errors.push('changed_budget_amount');
  }
  const th = Array.isArray(planLike.thresholds)
    ? planLike.thresholds.map((t) => (typeof t === 'number' ? t : t && t.percent))
    : [];
  if (th.length !== THRESHOLDS.length || th.some((v, i) => Number(v) !== THRESHOLDS[i])) {
    errors.push('changed_thresholds');
  }
  const enabled = Array.isArray(planLike.thresholds)
    ? planLike.thresholds.map((t) => (typeof t === 'object' ? t.enabled !== false : true))
    : [];
  if (enabled.some((e) => e !== true)) {
    errors.push('threshold_not_enabled');
  }
  if (planLike.budgetName && planLike.budgetName !== locked.budgetName) {
    errors.push('changed_budget_name');
  }
  if (planLike.actionGroupName && planLike.actionGroupName !== locked.actionGroupName) {
    errors.push('changed_action_group_name');
  }
  return { ok: errors.length === 0, errors, locked };
}

function assertAllowedResourceTypesOnly(resourceTypes) {
  const types = Array.isArray(resourceTypes) ? resourceTypes : [];
  const errors = [];
  const extras = types.filter((t) => !ALLOWED_RESOURCE_TYPES.includes(t));
  if (extras.length) errors.push('extra_resources');
  for (const allowed of ALLOWED_RESOURCE_TYPES) {
    if (!types.includes(allowed)) errors.push(`missing_resource_type:${allowed}`);
  }
  return { ok: errors.length === 0, errors, extras, types };
}

function inspectBicepSource(bicepText) {
  const errors = [];
  const text = String(bicepText || '');
  if (!/targetScope\s*=\s*'resourceGroup'/.test(text)) {
    errors.push('bicep_target_scope_not_resource_group');
  }
  if (!/param\s+opsNotifyEmail\s+string/.test(text)) {
    errors.push('bicep_missing_ops_notify_email_param');
  }
  if (/param\s+opsNotifyEmail\s+string\s*=/.test(text)) {
    errors.push('bicep_ops_notify_email_has_default');
  }
  if (!/Microsoft\.Insights\/actionGroups@/.test(text)) {
    errors.push('bicep_missing_action_group');
  }
  if (!/Microsoft\.Consumption\/budgets@/.test(text)) {
    errors.push('bicep_missing_budget');
  }
  if (!/thresholdType:\s*'Actual'/.test(text)) {
    errors.push('bicep_missing_actual_threshold_type');
  }
  if (!/enabled:\s*true/.test(text)) {
    errors.push('bicep_thresholds_not_enabled');
  }
  if (!/threshold:\s*thresholdPercent80/.test(text) || !/threshold:\s*thresholdPercent100/.test(text)) {
    errors.push('bicep_missing_80_100_thresholds');
  }
  if (!/deploymentModeRequired\s+string\s*=\s*'Incremental'/.test(text)) {
    errors.push('bicep_missing_incremental_mode_output');
  }
  for (const marker of FORBIDDEN_TYPE_MARKERS) {
    if (text.includes(marker)) errors.push(`bicep_forbidden_marker:${marker}`);
  }
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) {
    errors.push('bicep_contains_email_literal');
  }
  return { ok: errors.length === 0, errors };
}

function inspectCompiledTemplate(templateObj) {
  const errors = [];
  const resources = (templateObj && templateObj.resources) || [];
  const types = resources.map((r) => r.type);
  const typeCheck = assertAllowedResourceTypesOnly(types);
  if (!typeCheck.ok) errors.push(...typeCheck.errors);
  const params = (templateObj && templateObj.parameters) || {};
  if (!params.opsNotifyEmail) errors.push('compiled_missing_ops_notify_email_param');
  if (params.opsNotifyEmail && Object.prototype.hasOwnProperty.call(params.opsNotifyEmail, 'defaultValue')) {
    errors.push('compiled_ops_notify_email_has_default');
  }
  const modeOut = templateObj
    && templateObj.outputs
    && templateObj.outputs.deploymentModeRequired
    && templateObj.outputs.deploymentModeRequired.value;
  if (modeOut !== 'Incremental') errors.push('compiled_missing_incremental_output');
  return { ok: errors.length === 0, errors, types };
}

function assertNotWiredIntoMain(rootDir) {
  const errors = [];
  for (const rel of LOCKS.mainBicepForbiddenWiring) {
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs)) {
      errors.push(`missing_main:${rel}`);
      continue;
    }
    const text = fs.readFileSync(abs, 'utf8');
    if (/staging-cost-budgets|rg-budget-threshold|monthly-actualcost|ops-budget-ag/.test(text)) {
      errors.push(`wired_into_main:${rel}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function buildSecretFreePlan() {
  const budgets = RESOURCE_GROUPS.map((rg) => {
    const p = BUDGET_PLANS[rg];
    return {
      resourceGroup: p.resourceGroup,
      budgetName: p.budgetName,
      amountUsd: p.amountUsd,
      category: CATEGORY,
      timeGrain: TIME_GRAIN,
      budgetStartDate: BUDGET_START_DATE,
      thresholds: THRESHOLDS.map((percent) => ({
        percent,
        enabled: true,
        thresholdType: THRESHOLD_TYPE,
        operator: OPERATOR,
      })),
      actionGroupName: p.actionGroupName,
      actionGroupShortName: p.actionGroupShortName,
      opsEmailParam: LOCKS.opsEmailParam,
      opsEmailInGit: false,
      parametersExampleRel: p.parametersExampleRel,
    };
  });
  return {
    schema_version: 1,
    slice: LOCKS.slice,
    outcome_id: LOCKS.outcomeId,
    gate_id: LOCKS.gateId,
    progress_class: LOCKS.progressClass,
    does_not_implement: LOCKS.doesNotImplement,
    master_basis: LOCKS.masterBasis,
    branch: LOCKS.branch,
    subscriptionId: SUBSCRIPTION_ID,
    deploymentMode: DEPLOYMENT_MODE,
    liveDeployEnabled: false,
    anomalyDetectionClaimed: false,
    notification_delivery_proof: 'open',
    resourceTypesAllowed: [...ALLOWED_RESOURCE_TYPES],
    bicepModuleRel: LOCKS.bicepModuleRel,
    budgets,
    zero_live_mutation: true,
  };
}

/**
 * Evaluate a hypothetical deploy request. Never mutates Azure.
 */
function evaluateDeployRequest(req = {}) {
  const errors = [];
  if (req.liveDeploy === true || req.mode === 'deploy') {
    errors.push('live_deploy_hard_disabled');
  }

  const scope = assertExactStagingScope({
    subscriptionId: req.subscriptionId,
    resourceGroup: req.resourceGroup,
  });
  if (!scope.ok) errors.push(...scope.errors);

  const mode = assertDeploymentMode(req.deploymentMode || req.mode);
  if (!mode.ok) errors.push(...mode.errors);

  const email = validateOpsEmail(req.opsNotifyEmail);
  if (!email.ok) errors.push(...email.errors);

  const planCheck = assertAmountsAndThresholds({
    resourceGroup: req.resourceGroup,
    amountUsd: req.amountUsd,
    thresholds: req.thresholds || THRESHOLDS.map((percent) => ({ percent, enabled: true })),
    budgetName: req.budgetName,
    actionGroupName: req.actionGroupName,
  });
  if (!planCheck.ok) errors.push(...planCheck.errors);

  if (Array.isArray(req.resourceTypes)) {
    const types = assertAllowedResourceTypesOnly(req.resourceTypes);
    if (!types.ok) errors.push(...types.errors);
  }

  if (req.claimAnomalyDetection === true) {
    errors.push('anomaly_detection_claim_rejected');
  }

  return {
    ok: errors.length === 0,
    errors,
    scope,
    emailRedacted: email.ok ? redactEmail(email.email) : null,
    deploymentMode: DEPLOYMENT_MODE,
    liveDeployEnabled: false,
  };
}

function runRedCases() {
  const cases = [];

  function red(name, req, expectError) {
    const result = evaluateDeployRequest(req);
    const hit = result.errors.includes(expectError);
    cases.push({
      name,
      expect: 'RED',
      ok: result.ok === false && hit,
      expectError,
      errors: result.errors,
    });
  }

  // Synthetic addresses constructed at runtime (avoid raw email literals in git).
  const syntheticOps = `ops-notify@${'example'}.${'invalid'}`;
  const personalProbe = `ops@${'gmail'}.${'com'}`;

  const baseOk = {
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: 'wh-staging-rg',
    deploymentMode: 'Incremental',
    opsNotifyEmail: syntheticOps,
    amountUsd: 120,
    thresholds: [
      { percent: 80, enabled: true },
      { percent: 100, enabled: true },
    ],
    budgetName: 'wh-staging-rg-monthly-actualcost',
    actionGroupName: 'wh-staging-ops-budget-ag',
    resourceTypes: [...ALLOWED_RESOURCE_TYPES],
  };

  red('wrong_subscription', { ...baseOk, subscriptionId: '00000000-0000-0000-0000-000000000000' }, 'wrong_subscription');
  red('wrong_resource_group', { ...baseOk, resourceGroup: 'wh-prod-rg', amountUsd: 120 }, 'wrong_resource_group');
  red('production_rg_marker', { ...baseOk, resourceGroup: 'something-prod-rg' }, 'wrong_resource_group');
  red('missing_email', { ...baseOk, opsNotifyEmail: '' }, 'missing_ops_notify_email');
  red('invalid_email', { ...baseOk, opsNotifyEmail: 'not-an-email' }, 'invalid_ops_notify_email_format');
  red('personal_email', { ...baseOk, opsNotifyEmail: personalProbe }, 'personal_ops_notify_email_domain_rejected');
  red('changed_amount', { ...baseOk, amountUsd: 999 }, 'changed_budget_amount');
  red('changed_thresholds', {
    ...baseOk,
    thresholds: [
      { percent: 50, enabled: true },
      { percent: 100, enabled: true },
    ],
  }, 'changed_thresholds');
  red('extra_resources', {
    ...baseOk,
    resourceTypes: [...ALLOWED_RESOURCE_TYPES, 'Microsoft.App/containerApps'],
  }, 'extra_resources');
  red('non_incremental_mode', { ...baseOk, deploymentMode: 'Complete' }, 'non_incremental_mode_rejected');
  red('live_deploy_rejected', { ...baseOk, liveDeploy: true }, 'live_deploy_hard_disabled');
  red('anomaly_claim_rejected', { ...baseOk, claimAnomalyDetection: true }, 'anomaly_detection_claim_rejected');

  return cases;
}

function runGreenCases() {
  const cases = [];
  const syntheticOps = `ops-notify@${'example'}.${'invalid'}`;
  for (const rg of RESOURCE_GROUPS) {
    const plan = BUDGET_PLANS[rg];
    const result = evaluateDeployRequest({
      subscriptionId: SUBSCRIPTION_ID,
      resourceGroup: rg,
      deploymentMode: 'Incremental',
      opsNotifyEmail: syntheticOps,
      amountUsd: plan.amountUsd,
      thresholds: THRESHOLDS.map((percent) => ({ percent, enabled: true })),
      budgetName: plan.budgetName,
      actionGroupName: plan.actionGroupName,
      resourceTypes: [...ALLOWED_RESOURCE_TYPES],
    });
    cases.push({
      name: `green_plan_${rg}`,
      expect: 'GREEN',
      ok: result.ok === true && result.errors.length === 0,
      errors: result.errors,
      emailRedacted: result.emailRedacted,
    });
  }
  return cases;
}

module.exports = {
  LOCKS,
  SUBSCRIPTION_ID,
  RESOURCE_GROUPS,
  BUDGET_PLANS,
  THRESHOLDS,
  ALLOWED_RESOURCE_TYPES,
  OPS_EMAIL_ENV,
  redactEmail,
  validateOpsEmail,
  assertExactStagingScope,
  assertDeploymentMode,
  assertAmountsAndThresholds,
  assertAllowedResourceTypesOnly,
  inspectBicepSource,
  inspectCompiledTemplate,
  assertNotWiredIntoMain,
  buildSecretFreePlan,
  evaluateDeployRequest,
  runRedCases,
  runGreenCases,
};
