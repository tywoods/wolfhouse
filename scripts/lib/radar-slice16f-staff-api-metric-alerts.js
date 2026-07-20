'use strict';

/**
 * radar-slice16f-staff-api-metric-alerts — RADAR Slice 16F
 *
 * Standalone staging-only Staff API metric-alert plan + preflight guards +
 * shell-free deployment argv builder.
 * Offline-first. Live deploy hard-disabled. References 16B ops AG by name only.
 * Bicep fail-closes subscription + RG/app tuple; derives tenant/AG; locks metrics.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const REPO_ROOT = path.join(__dirname, '..', '..');

/** Private in-process capability registry (object identity only). */
const issuedCapabilities = new WeakSet();
const capabilityBindings = new WeakMap();
const consumedCapabilities = new WeakSet();
const CAPABILITY_BRAND = Symbol('radar16f.preflightCapability');
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
const BICEP_MODULE_REL = 'infra/azure/staging-staff-api-metric-alerts/rg-staff-api-metric-alerts.bicep';

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

const FORBIDDEN_BICEP_PARAMS = Object.freeze([
  'actionGroupName',
  'tenantSlug',
  'requests5xxThreshold',
  'restartCountThreshold',
  'alertSeverity',
  'windowSize',
  'evaluationFrequency',
  'alertsEnabled',
  'requestsMetricName',
  'restartMetricName',
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
  forbiddenBicepParams: FORBIDDEN_BICEP_PARAMS,
  liveDeployEnabled: false,
  bicepModuleRel: BICEP_MODULE_REL,
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
  if (!/subscription\(\)\.subscriptionId/.test(text)) {
    errors.push('bicep_missing_subscription_assert');
  }
  if (!/resourceGroup\(\)\.name/.test(text)) {
    errors.push('bicep_missing_rg_assert');
  }
  if (!/fail\('wrong_subscription'\)/.test(text)) {
    errors.push('bicep_missing_subscription_fail');
  }
  if (!/fail\('wrong_resource_group'\)/.test(text)) {
    errors.push('bicep_missing_rg_fail');
  }
  if (!/fail\('wrong_container_app'\)/.test(text)) {
    errors.push('bicep_missing_app_fail');
  }
  if (!/Microsoft\.Insights\/metricAlerts@/.test(text)) {
    errors.push('bicep_missing_metric_alerts');
  }
  if (!/existing\s*=/.test(text) || !/Microsoft\.Insights\/actionGroups@/.test(text)) {
    errors.push('bicep_missing_existing_action_group_ref');
  }
  if (!/var\s+actionGroupName\s*=/.test(text) || /param\s+actionGroupName\s+/.test(text)) {
    errors.push('bicep_action_group_not_derived');
  }
  if (!/var\s+tenantSlug\s*=/.test(text) || /param\s+tenantSlug\s+/.test(text)) {
    errors.push('bicep_tenant_slug_not_derived');
  }
  if (!/var\s+requests5xxThreshold\s*=\s*3/.test(text) || /param\s+requests5xxThreshold\s+/.test(text)) {
    errors.push('bicep_threshold_overridable');
  }
  if (!/var\s+alertSeverity\s*=\s*2/.test(text) || /param\s+alertSeverity\s+/.test(text)) {
    errors.push('bicep_severity_overridable');
  }
  if (!/var\s+windowSize\s*=\s*'PT5M'/.test(text) || /param\s+windowSize\s+/.test(text)) {
    errors.push('bicep_window_overridable');
  }
  if (!/var\s+evaluationFrequency\s*=\s*'PT1M'/.test(text) || /param\s+evaluationFrequency\s+/.test(text)) {
    errors.push('bicep_eval_overridable');
  }
  if (!/var\s+alertsEnabled\s*=\s*true/.test(text)) {
    errors.push('bicep_enabled_not_locked');
  }
  if (!/metricNamespace:\s*metricNamespace/.test(text) && !/metricNamespace:\s*'Microsoft\.App\/containerApps'/.test(text)) {
    // either var reference or literal — both ok if namespace locked
    if (!/var\s+metricNamespace\s*=\s*'Microsoft\.App\/containerApps'/.test(text)) {
      errors.push('bicep_missing_metric_namespace');
    }
  }
  if (!/var\s+requestsMetricName\s*=\s*'Requests'/.test(text)
    || !/var\s+restartMetricName\s*=\s*'RestartCount'/.test(text)) {
    errors.push('bicep_missing_metrics');
  }
  if (!/statusCodeCategory/.test(text) || !/'5xx'/.test(text)) {
    errors.push('bicep_missing_5xx_dimension');
  }
  if (!/GreaterThanOrEqual/.test(text) || !/GreaterThan'/.test(text)) {
    errors.push('bicep_missing_operators');
  }
  if (!/deploymentModeRequired\s+string\s*=\s*'Incremental'/.test(text)) {
    errors.push('bicep_missing_incremental_mode_output');
  }
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
  for (const p of FORBIDDEN_BICEP_PARAMS) {
    if (new RegExp(`param\\s+${p}\\s+`).test(text)) {
      errors.push(`bicep_forbidden_param:${p}`);
    }
  }
  const paramMatches = text.match(/^param\s+(\w+)\s+/gm) || [];
  const paramNames = paramMatches.map((m) => m.replace(/^param\s+/, '').replace(/\s+$/, ''));
  if (!(paramNames.length === 1 && paramNames[0] === 'containerAppName')) {
    errors.push(`bicep_unexpected_params:${paramNames.join(',')}`);
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
  const params = (templateObj && templateObj.parameters) || {};
  const paramKeys = Object.keys(params);
  if (!(paramKeys.length === 1 && paramKeys[0] === 'containerAppName')) {
    errors.push(`compiled_unexpected_params:${paramKeys.join(',')}`);
  }
  for (const p of FORBIDDEN_BICEP_PARAMS) {
    if (Object.prototype.hasOwnProperty.call(params, p)) {
      errors.push(`compiled_forbidden_param:${p}`);
    }
  }
  const vars = (templateObj && templateObj.variables) || {};
  if (vars.requests5xxThreshold !== 3) errors.push('compiled_threshold_not_literal');
  if (vars.alertSeverity !== 2) errors.push('compiled_severity_not_literal');
  if (vars.windowSize !== 'PT5M') errors.push('compiled_window_not_literal');
  if (vars.evaluationFrequency !== 'PT1M') errors.push('compiled_eval_not_literal');
  if (vars.alertsEnabled !== true) errors.push('compiled_enabled_not_literal');
  if (!String(vars.assertSubscription || '').includes("fail('wrong_subscription')")) {
    errors.push('compiled_missing_subscription_fail');
  }
  if (!String(vars.assertRgAppTuple || '').includes("fail('wrong_container_app')")) {
    errors.push('compiled_missing_app_fail');
  }
  if (!String(vars.actionGroupName || '').includes('wh-staging-ops-budget-ag')) {
    errors.push('compiled_action_group_not_derived');
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

function resolveRepoRoot(rootDir) {
  return rootDir ? path.resolve(String(rootDir)) : REPO_ROOT;
}

function hashTemplateFile(rootDir) {
  const abs = path.join(resolveRepoRoot(rootDir), BICEP_MODULE_REL);
  const buf = fs.readFileSync(abs);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Mint a frozen opaque capability registered by object identity only.
 * Caller-shaped clones / JSON roundtrips are not registered and cannot authorize.
 */
function mintPreflightCapability(binding) {
  const capability = Object.create(null);
  Object.defineProperty(capability, CAPABILITY_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.freeze(capability);
  issuedCapabilities.add(capability);
  capabilityBindings.set(capability, Object.freeze({
    subscriptionId: binding.subscriptionId,
    resourceGroup: binding.resourceGroup,
    containerAppName: binding.containerAppName,
    templateFile: binding.templateFile,
    templateHash: binding.templateHash,
    mode: binding.mode,
  }));
  return capability;
}

function isIssuedCapability(value) {
  return value != null
    && typeof value === 'object'
    && issuedCapabilities.has(value)
    && capabilityBindings.has(value);
}

/**
 * Real in-process preflight. On success issues a one-shot opaque capability
 * bound to exact subscription, RG, app, template path/hash, and Incremental mode.
 * Does not accept or return forgeable authorization booleans.
 */
function runPreflight(input = {}) {
  const errors = [];
  const allowedKeys = new Set([
    'resourceGroup',
    'subscriptionId',
    'containerAppName',
    'actionGroupName',
    'mode',
    'deploymentMode',
    'rootDir',
  ]);

  for (const key of Object.keys(input || {})) {
    if (!allowedKeys.has(key)) {
      errors.push('unknown_preflight_key');
      break;
    }
  }

  const rg = String(input.resourceGroup || '');
  const plan = APP_PLANS[rg];
  if (!plan) {
    errors.push('wrong_resource_group');
  }
  if (/prod/i.test(rg)) {
    errors.push('production_resource_group_rejected');
  }

  const sub = input.subscriptionId != null ? String(input.subscriptionId) : SUBSCRIPTION_ID;
  const appName = input.containerAppName != null
    ? String(input.containerAppName)
    : (plan && plan.containerAppName);
  const agName = input.actionGroupName != null
    ? String(input.actionGroupName)
    : (plan && plan.actionGroupName);

  const scope = assertExactStagingScope({
    subscriptionId: sub,
    resourceGroup: rg,
    containerAppName: appName,
    actionGroupName: agName,
  });
  if (!scope.ok) errors.push(...scope.errors);

  const modeRaw = input.deploymentMode != null
    ? input.deploymentMode
    : (input.mode != null ? input.mode : DEPLOYMENT_MODE);
  const mode = assertDeploymentMode(modeRaw);
  if (!mode.ok) errors.push(...mode.errors);

  if (plan) {
    const evalResult = evaluateDeployRequest({
      subscriptionId: SUBSCRIPTION_ID,
      resourceGroup: rg,
      deploymentMode: DEPLOYMENT_MODE,
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
    if (!evalResult.ok) errors.push(...evalResult.errors);
  }

  let templateHash = null;
  if (!errors.length) {
    try {
      templateHash = hashTemplateFile(input.rootDir);
    } catch (_) {
      errors.push('template_missing');
    }
  }

  if (errors.length) {
    return Object.freeze({
      ok: false,
      errors: Object.freeze([...errors]),
      capability: null,
      subscriptionId: SUBSCRIPTION_ID,
      resourceGroup: RESOURCE_GROUPS.includes(rg) ? rg : null,
      templateFile: BICEP_MODULE_REL,
      mode: null,
      liveDeployEnabled: false,
    });
  }

  const capability = mintPreflightCapability({
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: rg,
    containerAppName: plan.containerAppName,
    templateFile: BICEP_MODULE_REL,
    templateHash,
    mode: DEPLOYMENT_MODE,
  });

  return Object.freeze({
    ok: true,
    errors: Object.freeze([]),
    capability,
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: rg,
    containerAppName: plan.containerAppName,
    actionGroupName: plan.actionGroupName,
    templateFile: BICEP_MODULE_REL,
    templateHash,
    mode: DEPLOYMENT_MODE,
    liveDeployEnabled: false,
  });
}

/**
 * Shell-free structured deployment argv builder.
 * Accepts only a still-valid opaque capability issued in-process by runPreflight.
 * Argv is assembled exclusively from the capability binding (not caller shape).
 * Rejects clones, JSON roundtrips, altered fields, cross-RG/app reuse, replay,
 * unknown keys, and extra args. No executor / no live call.
 */
function buildDeploymentArgv(input = {}) {
  const errors = [];
  const allowedKeys = new Set([
    'capability',
    'subscriptionId',
    'resourceGroup',
    'containerAppName',
    'templateFile',
    'templateHash',
    'mode',
    'deploymentMode',
    'extraArgs',
    'rootDir',
  ]);

  for (const key of Object.keys(input || {})) {
    if (!allowedKeys.has(key)) {
      errors.push('unknown_builder_key');
      break;
    }
  }

  if (Array.isArray(input.extraArgs) && input.extraArgs.length > 0) {
    errors.push('extra_args_rejected');
  } else if (input.extraArgs != null && !Array.isArray(input.extraArgs)) {
    errors.push('extra_args_rejected');
  }

  const cap = input.capability;
  let binding = null;

  if (cap == null) {
    errors.push('preflight_required');
  } else if (!isIssuedCapability(cap)) {
    errors.push('invalid_capability');
  } else if (consumedCapabilities.has(cap)) {
    errors.push('capability_consumed');
  } else {
    binding = capabilityBindings.get(cap);
    if (!binding || binding.mode !== DEPLOYMENT_MODE) {
      errors.push('non_incremental_mode_rejected');
    } else {
      let currentHash = null;
      try {
        currentHash = hashTemplateFile(input.rootDir);
      } catch (_) {
        errors.push('template_missing');
      }
      if (currentHash != null && currentHash !== binding.templateHash) {
        errors.push('template_hash_mismatch');
      }

      const fieldChecks = [
        ['subscriptionId', binding.subscriptionId],
        ['resourceGroup', binding.resourceGroup],
        ['containerAppName', binding.containerAppName],
        ['templateFile', binding.templateFile],
        ['templateHash', binding.templateHash],
      ];
      for (const [field, want] of fieldChecks) {
        if (input[field] != null && String(input[field]) !== String(want)) {
          errors.push('capability_binding_mismatch');
          break;
        }
      }

      const mode = input.deploymentMode != null
        ? input.deploymentMode
        : (input.mode != null ? input.mode : null);
      if (mode != null) {
        if (String(mode) === 'Complete') {
          errors.push('complete_mode_rejected');
        } else if (String(mode) !== binding.mode) {
          errors.push('capability_binding_mismatch');
        }
      }
    }
  }

  if (errors.length) {
    return {
      ok: false,
      errors,
      argv: null,
      executor: null,
      liveCall: false,
      mode: null,
      subscriptionId: SUBSCRIPTION_ID,
      templateFile: BICEP_MODULE_REL,
    };
  }

  consumedCapabilities.add(cap);

  const argv = Object.freeze([
    'deployment',
    'group',
    'create',
    '--subscription',
    binding.subscriptionId,
    '--resource-group',
    binding.resourceGroup,
    '--template-file',
    binding.templateFile,
    '--mode',
    binding.mode,
    '--parameters',
    `containerAppName=${binding.containerAppName}`,
  ]);

  return {
    ok: true,
    errors: [],
    argv,
    executor: null,
    liveCall: false,
    mode: binding.mode,
    subscriptionId: binding.subscriptionId,
    resourceGroup: binding.resourceGroup,
    templateFile: binding.templateFile,
    templateHash: binding.templateHash,
    containerAppName: binding.containerAppName,
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

  function redArgv(name, input, expectError) {
    const result = buildDeploymentArgv(input);
    const hit = result.errors.includes(expectError);
    cases.push({
      name,
      expect: 'RED',
      ok: result.ok === false && hit && result.argv === null && result.executor === null,
      expectError,
      errors: result.errors,
    });
  }

  function freshCapability(rg) {
    const pf = runPreflight({ resourceGroup: rg });
    if (!pf.ok || !pf.capability) {
      throw new Error(`runPreflight failed for ${rg}: ${(pf.errors || []).join(',')}`);
    }
    return pf;
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

  const pfWh = freshCapability('wh-staging-rg');
  redArgv('argv_complete_mode', { capability: pfWh.capability, mode: 'Complete' }, 'complete_mode_rejected');

  const pfSub = freshCapability('wh-staging-rg');
  redArgv('argv_wrong_subscription', {
    capability: pfSub.capability,
    subscriptionId: '00000000-0000-0000-0000-000000000000',
  }, 'capability_binding_mismatch');

  const pfRg = freshCapability('wh-staging-rg');
  redArgv('argv_wrong_rg', {
    capability: pfRg.capability,
    resourceGroup: 'luna-sunset-staging-rg',
  }, 'capability_binding_mismatch');

  const pfApp = freshCapability('wh-staging-rg');
  redArgv('argv_wrong_app', {
    capability: pfApp.capability,
    containerAppName: 'wrong-app',
  }, 'capability_binding_mismatch');

  const pfExtra = freshCapability('wh-staging-rg');
  redArgv('argv_extra_args', {
    capability: pfExtra.capability,
    extraArgs: ['--what-if'],
  }, 'extra_args_rejected');

  redArgv('argv_preflight_required', { resourceGroup: 'wh-staging-rg' }, 'preflight_required');
  redArgv('argv_forged_ok_object', { capability: { ok: true } }, 'invalid_capability');
  redArgv('argv_forged_preflight_result', {
    capability: { ok: true, resourceGroup: 'wh-staging-rg', errors: [] },
  }, 'invalid_capability');
  {
    const legacyBool = { resourceGroup: 'wh-staging-rg' };
    legacyBool[`preflight${'Ok'}`] = true;
    redArgv('argv_legacy_bool_auth_rejected', legacyBool, 'unknown_builder_key');
  }
  redArgv('argv_unknown_builder_key', {
    capability: freshCapability('wh-staging-rg').capability,
    forgedFlag: true,
  }, 'unknown_builder_key');

  const pfClone = freshCapability('wh-staging-rg');
  redArgv('argv_clone_capability', { capability: { ...pfClone.capability } }, 'invalid_capability');

  const pfJson = freshCapability('wh-staging-rg');
  redArgv('argv_json_roundtrip_capability', {
    capability: JSON.parse(JSON.stringify(pfJson.capability)),
  }, 'invalid_capability');

  const pfReplay = freshCapability('wh-staging-rg');
  buildDeploymentArgv({ capability: pfReplay.capability });
  redArgv('argv_replay_consumed', { capability: pfReplay.capability }, 'capability_consumed');

  const pfCross = freshCapability('wh-staging-rg');
  redArgv('argv_cross_rg_reuse', {
    capability: pfCross.capability,
    resourceGroup: 'luna-sunset-staging-rg',
  }, 'capability_binding_mismatch');

  const pfCrossApp = freshCapability('wh-staging-rg');
  redArgv('argv_cross_app_reuse', {
    capability: pfCrossApp.capability,
    containerAppName: 'luna-sunset-staging-staff-api',
  }, 'capability_binding_mismatch');

  const pfHash = freshCapability('wh-staging-rg');
  redArgv('argv_altered_template_hash', {
    capability: pfHash.capability,
    templateHash: '0'.repeat(64),
  }, 'capability_binding_mismatch');

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

    const pf = runPreflight({ resourceGroup: rg });
    const argv = pf.ok
      ? buildDeploymentArgv({ capability: pf.capability })
      : { ok: false, errors: pf.errors || ['preflight_failed'], argv: null, executor: null };
    const argvOk = pf.ok === true
      && argv.ok === true
      && argv.executor === null
      && argv.liveCall === false
      && argv.mode === DEPLOYMENT_MODE
      && argv.resourceGroup === rg
      && argv.containerAppName === plan.containerAppName
      && argv.templateFile === BICEP_MODULE_REL
      && typeof argv.templateHash === 'string'
      && argv.templateHash.length === 64
      && Array.isArray(argv.argv)
      && argv.argv.includes('--subscription')
      && argv.argv.includes(SUBSCRIPTION_ID)
      && argv.argv.includes('--resource-group')
      && argv.argv.includes(rg)
      && argv.argv.includes('--template-file')
      && argv.argv.includes(BICEP_MODULE_REL)
      && argv.argv.includes('--mode')
      && argv.argv.includes('Incremental')
      && !argv.argv.includes('Complete');
    cases.push({
      name: `green_argv_${rg}`,
      expect: 'GREEN',
      ok: argvOk,
      errors: argvOk ? [] : [...(pf.errors || []), ...(argv.errors || [])],
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
  FORBIDDEN_BICEP_PARAMS,
  BICEP_MODULE_REL,
  assertExactStagingScope,
  assertDeploymentMode,
  assertAlertPlan,
  assertAllowedResourceTypesOnly,
  inspectBicepSource,
  inspectCompiledTemplate,
  assertNotWiredIntoMain,
  buildSecretFreePlan,
  hashTemplateFile,
  runPreflight,
  buildDeploymentArgv,
  evaluateDeployRequest,
  runRedCases,
  runGreenCases,
};
