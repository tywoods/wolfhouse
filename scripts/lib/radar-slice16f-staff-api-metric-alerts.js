'use strict';

/**
 * radar-slice16f-staff-api-metric-alerts — RADAR Slice 16F
 *
 * Standalone staging-only Staff API metric-alert plan + preflight guards.
 * Offline-first. Live deploy hard-disabled. References 16B ops AG by name only.
 */

const fs = require('fs');
const path = require('path');

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const RESOURCE_GROUPS = Object.freeze(['wh-staging-rg', 'luna-sunset-staging-rg']);

const APP_PLANS = Object.freeze({
  'wh-staging-rg': Object.freeze({
    resourceGroup: 'wh-staging-rg',
    containerAppName: 'wh-staging-staff-api',
    tenantSlug: 'wolfhouse',
    actionGroupName: 'wh-staging-ops-budget-ag',
    parametersExampleRel: 'infra/azure/staging-staff-api-metric-alerts/parameters.wh-staging.example.json',
    alerts: Object.freeze([
      Object.freeze({
        name: 'wolfhouse-staff-api-requests-5xx',
        metricName: 'Requests',
        operator: 'GreaterThanOrEqual',
        threshold: 3,
        dimensionName: 'statusCodeCategory',
        dimensionOperator: 'Include',
        dimensionValues: Object.freeze(['5xx']),
        enabled: true,
      }),
      Object.freeze({
        name: 'wolfhouse-staff-api-restart-count',
        metricName: 'RestartCount',
        operator: 'GreaterThan',
        threshold: 0,
        dimensionName: null,
        dimensionValues: Object.freeze([]),
        enabled: true,
      }),
    ]),
  }),
  'luna-sunset-staging-rg': Object.freeze({
    resourceGroup: 'luna-sunset-staging-rg',
    containerAppName: 'luna-sunset-staging-staff-api',
    tenantSlug: 'sunset',
    actionGroupName: 'luna-sunset-staging-ops-budget-ag',
    parametersExampleRel: 'infra/azure/staging-staff-api-metric-alerts/parameters.luna-sunset-staging.example.json',
    alerts: Object.freeze([
      Object.freeze({
        name: 'sunset-staff-api-requests-5xx',
        metricName: 'Requests',
        operator: 'GreaterThanOrEqual',
        threshold: 3,
        dimensionName: 'statusCodeCategory',
        dimensionOperator: 'Include',
        dimensionValues: Object.freeze(['5xx']),
        enabled: true,
      }),
      Object.freeze({
        name: 'sunset-staff-api-restart-count',
        metricName: 'RestartCount',
        operator: 'GreaterThan',
        threshold: 0,
        dimensionName: null,
        dimensionValues: Object.freeze([]),
        enabled: true,
      }),
    ]),
  }),
});

const METRIC_NAMESPACE = 'Microsoft.App/containerApps';
const WINDOW_SIZE = 'PT5M';
const EVALUATION_FREQUENCY = 'PT1M';
const SEVERITY = 2;
const TIME_AGGREGATION = 'Total';
const DEPLOYMENT_MODE = 'Incremental';

const ALLOWED_RESOURCE_TYPES = Object.freeze([
  'Microsoft.Insights/metricAlerts',
]);

const FORBIDDEN_CREATE_MARKERS = Object.freeze([
  "resource opsBudgetActionGroup 'Microsoft.Insights/actionGroups",
  "resource monthlyActualCostBudget 'Microsoft.Consumption/budgets",
  "resource staffApi 'Microsoft.App/containerApps",
  "resource containerApp 'Microsoft.App/containerApps",
  'Microsoft.DBforPostgreSQL/',
  'Microsoft.KeyVault/',
  'Microsoft.ManagedIdentity/',
  'Microsoft.Network/',
  'Microsoft.ContainerRegistry/',
  'Microsoft.Consumption/budgets',
  'wh-prod-rg',
  'wh-prod-',
]);

const LOCKS = Object.freeze({
  slice: 'RADAR-16F',
  outcomeId: '16F_staff_api_metric_alerts',
  gateId: 'G03_actionable_tenant_aware_alerts',
  progressClass: 'source_partial_progress_only',
  doesNotImplement: 'live_deploy_notification_delivery_alert_fire',
  masterBasis: 'acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b',
  branch: 'radar/slice-16f-staff-api-metric-alerts',
  subscriptionId: SUBSCRIPTION_ID,
  resourceGroups: RESOURCE_GROUPS,
  appPlans: APP_PLANS,
  metricNamespace: METRIC_NAMESPACE,
  windowSize: WINDOW_SIZE,
  evaluationFrequency: EVALUATION_FREQUENCY,
  severity: SEVERITY,
  timeAggregation: TIME_AGGREGATION,
  deploymentMode: DEPLOYMENT_MODE,
  allowedResourceTypes: ALLOWED_RESOURCE_TYPES,
  forbiddenCreateMarkers: FORBIDDEN_CREATE_MARKERS,
  liveDeployEnabled: false,
  bicepModuleRel: 'infra/azure/staging-staff-api-metric-alerts/rg-staff-api-metric-alerts.bicep',
  readmeRel: 'infra/azure/staging-staff-api-metric-alerts/README.md',
  planFixtureRel: 'fixtures/radar-operations/slice16f-metric-alert-plan.json',
  mainBicepForbiddenWiring: Object.freeze([
    'infra/azure/staging/main.bicep',
    'infra/azure/sunset-staging/main.bicep',
  ]),
  referencedActionGroupSource: 'RADAR-16B',
});

function arraysEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length
    && a.every((v, i) => v === b[i]);
}

/**
 * Exact subscription + RG + app + action-group short-circuit.
 */
function assertExactStagingScope({
  subscriptionId,
  resourceGroup,
  containerAppName,
  actionGroupName,
} = {}) {
  const errors = [];
  if (String(subscriptionId || '') !== SUBSCRIPTION_ID) {
    errors.push('wrong_subscription');
  }
  const rg = String(resourceGroup || '');
  if (!RESOURCE_GROUPS.includes(rg)) {
    errors.push('wrong_resource_group');
  }
  if (/prod/i.test(rg)) {
    errors.push('production_resource_group_rejected');
  }
  const locked = APP_PLANS[rg];
  if (locked) {
    if (containerAppName != null && String(containerAppName) !== locked.containerAppName) {
      errors.push('wrong_container_app');
    }
    if (actionGroupName != null && String(actionGroupName) !== locked.actionGroupName) {
      errors.push('wrong_action_group');
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: RESOURCE_GROUPS.includes(rg) ? rg : null,
    locked: locked || null,
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

function assertAlertPlan(planLike) {
  const errors = [];
  const rg = String(planLike.resourceGroup || '');
  const locked = APP_PLANS[rg];
  if (!locked) {
    errors.push('unknown_resource_group_plan');
    return { ok: false, errors };
  }
  if (planLike.containerAppName && planLike.containerAppName !== locked.containerAppName) {
    errors.push('changed_container_app_name');
  }
  if (planLike.actionGroupName && planLike.actionGroupName !== locked.actionGroupName) {
    errors.push('changed_action_group_name');
  }
  if (planLike.tenantSlug && planLike.tenantSlug !== locked.tenantSlug) {
    errors.push('changed_tenant_slug');
  }
  if (planLike.metricNamespace && planLike.metricNamespace !== METRIC_NAMESPACE) {
    errors.push('changed_metric_namespace');
  }
  if (planLike.windowSize && planLike.windowSize !== WINDOW_SIZE) {
    errors.push('changed_window');
  }
  if (planLike.evaluationFrequency && planLike.evaluationFrequency !== EVALUATION_FREQUENCY) {
    errors.push('changed_evaluation_frequency');
  }
  if (planLike.severity != null && Number(planLike.severity) !== SEVERITY) {
    errors.push('changed_severity');
  }

  const alerts = Array.isArray(planLike.alerts) ? planLike.alerts : null;
  if (!alerts || alerts.length !== locked.alerts.length) {
    errors.push('changed_alert_count');
    return { ok: false, errors, locked };
  }
  for (let i = 0; i < locked.alerts.length; i += 1) {
    const want = locked.alerts[i];
    const got = alerts[i] || {};
    if (got.name && got.name !== want.name) errors.push('changed_alert_name');
    if (got.metricName && got.metricName !== want.metricName) errors.push('changed_metric');
    if (got.operator && got.operator !== want.operator) errors.push('changed_operator');
    if (got.threshold != null && Number(got.threshold) !== want.threshold) {
      errors.push('changed_threshold');
    }
    if (Object.prototype.hasOwnProperty.call(got, 'enabled') && got.enabled !== true) {
      errors.push('alert_not_enabled');
    }
    if (want.dimensionName) {
      if (got.dimensionName && got.dimensionName !== want.dimensionName) {
        errors.push('changed_dimension');
      }
      if (got.dimensionValues && !arraysEqual(got.dimensionValues, [...want.dimensionValues])) {
        errors.push('changed_dimension');
      }
    }
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
  if (!/Microsoft\.Insights\/metricAlerts@/.test(text)) {
    errors.push('bicep_missing_metric_alerts');
  }
  if (!/existing\s*=/.test(text) || !/Microsoft\.Insights\/actionGroups@/.test(text)) {
    errors.push('bicep_missing_existing_action_group_ref');
  }
  if (!/metricNamespace:\s*'Microsoft\.App\/containerApps'/.test(text)) {
    errors.push('bicep_missing_metric_namespace');
  }
  if (!/metricName:\s*'Requests'/.test(text) || !/metricName:\s*'RestartCount'/.test(text)) {
    errors.push('bicep_missing_metrics');
  }
  if (!/statusCodeCategory/.test(text) || !/'5xx'/.test(text)) {
    errors.push('bicep_missing_5xx_dimension');
  }
  if (!/operator:\s*'GreaterThanOrEqual'/.test(text) || !/operator:\s*'GreaterThan'/.test(text)) {
    errors.push('bicep_missing_operators');
  }
  if (!/enabled:\s*true/.test(text)) {
    errors.push('bicep_alerts_not_enabled');
  }
  if (!/deploymentModeRequired\s+string\s*=\s*'Incremental'/.test(text)) {
    errors.push('bicep_missing_incremental_mode_output');
  }
  // Must not declare a non-existing (create) action group or budget resource.
  if (/resource\s+\w+\s+'Microsoft\.Insights\/actionGroups@[^']+'\s*=\s*\{/.test(text)
    && !/resource\s+\w+\s+'Microsoft\.Insights\/actionGroups@[^']+'\s+existing\s*=/.test(text)) {
    errors.push('bicep_creates_action_group');
  }
  if (/resource\s+\w+\s+'Microsoft\.Consumption\/budgets@/.test(text)) {
    errors.push('bicep_creates_budget');
  }
  if (/resource\s+\w+\s+'Microsoft\.App\/containerApps@[^']+'\s*=\s*\{/.test(text)) {
    errors.push('bicep_creates_container_app');
  }
  for (const marker of FORBIDDEN_CREATE_MARKERS) {
    if (text.includes(marker)) errors.push(`bicep_forbidden_marker:${marker}`);
  }
  return { ok: errors.length === 0, errors };
}

function inspectCompiledTemplate(templateObj) {
  const errors = [];
  const resources = (templateObj && templateObj.resources) || [];
  const types = resources.map((r) => r.type);
  const typeCheck = assertAllowedResourceTypesOnly(types);
  if (!typeCheck.ok) errors.push(...typeCheck.errors);
  if (resources.length !== 2) errors.push('compiled_resource_count');
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
    if (/staging-staff-api-metric-alerts|rg-staff-api-metric-alerts|staff-api-requests-5xx|staff-api-restart-count/.test(text)) {
      errors.push(`wired_into_main:${rel}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function buildSecretFreePlan() {
  const apps = RESOURCE_GROUPS.map((rg) => {
    const p = APP_PLANS[rg];
    return {
      resourceGroup: p.resourceGroup,
      containerAppName: p.containerAppName,
      tenantSlug: p.tenantSlug,
      actionGroupName: p.actionGroupName,
      parametersExampleRel: p.parametersExampleRel,
      alerts: p.alerts.map((a) => ({
        name: a.name,
        metricName: a.metricName,
        operator: a.operator,
        threshold: a.threshold,
        dimensionName: a.dimensionName,
        dimensionOperator: a.dimensionOperator || undefined,
        dimensionValues: [...a.dimensionValues],
        enabled: a.enabled,
      })),
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
    notification_delivery_proof: 'open',
    alert_fire_drill: 'open',
    metricNamespace: METRIC_NAMESPACE,
    windowSize: WINDOW_SIZE,
    evaluationFrequency: EVALUATION_FREQUENCY,
    severity: SEVERITY,
    timeAggregation: TIME_AGGREGATION,
    resourceTypesAllowed: [...ALLOWED_RESOURCE_TYPES],
    bicepModuleRel: LOCKS.bicepModuleRel,
    referencedActionGroupSource: LOCKS.referencedActionGroupSource,
    apps,
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
    containerAppName: req.containerAppName,
    actionGroupName: req.actionGroupName,
  });
  if (!scope.ok) errors.push(...scope.errors);

  const mode = assertDeploymentMode(req.deploymentMode || req.mode);
  if (!mode.ok) errors.push(...mode.errors);

  const planCheck = assertAlertPlan({
    resourceGroup: req.resourceGroup,
    containerAppName: req.containerAppName,
    actionGroupName: req.actionGroupName,
    tenantSlug: req.tenantSlug,
    metricNamespace: req.metricNamespace || METRIC_NAMESPACE,
    windowSize: req.windowSize || WINDOW_SIZE,
    evaluationFrequency: req.evaluationFrequency || EVALUATION_FREQUENCY,
    severity: req.severity != null ? req.severity : SEVERITY,
    alerts: req.alerts,
  });
  if (!planCheck.ok) errors.push(...planCheck.errors);

  if (Array.isArray(req.resourceTypes)) {
    const types = assertAllowedResourceTypesOnly(req.resourceTypes);
    if (!types.ok) errors.push(...types.errors);
  }

  if (req.createActionGroup === true) {
    errors.push('action_group_create_rejected');
  }

  return {
    ok: errors.length === 0,
    errors,
    scope,
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

  const baseOk = {
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: 'wh-staging-rg',
    deploymentMode: 'Incremental',
    containerAppName: 'wh-staging-staff-api',
    actionGroupName: 'wh-staging-ops-budget-ag',
    tenantSlug: 'wolfhouse',
    metricNamespace: METRIC_NAMESPACE,
    windowSize: WINDOW_SIZE,
    evaluationFrequency: EVALUATION_FREQUENCY,
    severity: SEVERITY,
    alerts: APP_PLANS['wh-staging-rg'].alerts.map((a) => ({ ...a, dimensionValues: [...a.dimensionValues] })),
    resourceTypes: [...ALLOWED_RESOURCE_TYPES],
  };

  red('wrong_subscription', { ...baseOk, subscriptionId: '00000000-0000-0000-0000-000000000000' }, 'wrong_subscription');
  red('wrong_resource_group', { ...baseOk, resourceGroup: 'wh-prod-rg' }, 'wrong_resource_group');
  red('production_rg_marker', { ...baseOk, resourceGroup: 'something-prod-rg' }, 'wrong_resource_group');
  red('wrong_container_app', { ...baseOk, containerAppName: 'other-staff-api' }, 'wrong_container_app');
  red('wrong_action_group', { ...baseOk, actionGroupName: 'wrong-ops-ag' }, 'wrong_action_group');
  red('changed_metric', {
    ...baseOk,
    alerts: [
      { ...baseOk.alerts[0], metricName: 'Replicas' },
      baseOk.alerts[1],
    ],
  }, 'changed_metric');
  red('changed_dimension', {
    ...baseOk,
    alerts: [
      { ...baseOk.alerts[0], dimensionValues: ['4xx'] },
      baseOk.alerts[1],
    ],
  }, 'changed_dimension');
  red('changed_operator', {
    ...baseOk,
    alerts: [
      { ...baseOk.alerts[0], operator: 'GreaterThan' },
      baseOk.alerts[1],
    ],
  }, 'changed_operator');
  red('changed_threshold', {
    ...baseOk,
    alerts: [
      { ...baseOk.alerts[0], threshold: 99 },
      baseOk.alerts[1],
    ],
  }, 'changed_threshold');
  red('changed_window', { ...baseOk, windowSize: 'PT15M' }, 'changed_window');
  red('changed_severity', { ...baseOk, severity: 0 }, 'changed_severity');
  red('extra_resources', {
    ...baseOk,
    resourceTypes: [...ALLOWED_RESOURCE_TYPES, 'Microsoft.Insights/actionGroups'],
  }, 'extra_resources');
  red('non_incremental_mode', { ...baseOk, deploymentMode: 'Complete' }, 'non_incremental_mode_rejected');
  red('live_deploy_rejected', { ...baseOk, liveDeploy: true }, 'live_deploy_hard_disabled');
  red('action_group_create_rejected', { ...baseOk, createActionGroup: true }, 'action_group_create_rejected');

  return cases;
}

function runGreenCases() {
  const cases = [];
  for (const rg of RESOURCE_GROUPS) {
    const plan = APP_PLANS[rg];
    const result = evaluateDeployRequest({
      subscriptionId: SUBSCRIPTION_ID,
      resourceGroup: rg,
      deploymentMode: 'Incremental',
      containerAppName: plan.containerAppName,
      actionGroupName: plan.actionGroupName,
      tenantSlug: plan.tenantSlug,
      metricNamespace: METRIC_NAMESPACE,
      windowSize: WINDOW_SIZE,
      evaluationFrequency: EVALUATION_FREQUENCY,
      severity: SEVERITY,
      alerts: plan.alerts.map((a) => ({ ...a, dimensionValues: [...a.dimensionValues] })),
      resourceTypes: [...ALLOWED_RESOURCE_TYPES],
    });
    cases.push({
      name: `green_plan_${rg}`,
      expect: 'GREEN',
      ok: result.ok === true && result.errors.length === 0,
      errors: result.errors,
    });
  }
  return cases;
}

module.exports = {
  LOCKS,
  SUBSCRIPTION_ID,
  RESOURCE_GROUPS,
  APP_PLANS,
  METRIC_NAMESPACE,
  WINDOW_SIZE,
  EVALUATION_FREQUENCY,
  SEVERITY,
  ALLOWED_RESOURCE_TYPES,
  assertExactStagingScope,
  assertDeploymentMode,
  assertAlertPlan,
  assertAllowedResourceTypesOnly,
  inspectBicepSource,
  inspectCompiledTemplate,
  assertNotWiredIntoMain,
  buildSecretFreePlan,
  evaluateDeployRequest,
  runRedCases,
  runGreenCases,
};
