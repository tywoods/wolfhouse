'use strict';

/**
 * radar-slice16g-staff-api-metric-alerts — RADAR Slice 16G
 *
 * Standalone staging-only Staff API metric-alert plan + preflight guards +
 * hard-locked safe deployment entry point (shell-free spawn).
 * Offline-first. Live apply requires explicit live flag + operator confirmation;
 * default/production path refuses spawn. References 16B ops AG by name only.
 * Bicep fail-closes subscription + RG/app tuple; derives tenant/AG; locks metrics.
 * Supersedes deferred 16F (no cherry-pick): same two alerts + AG refs; adds safe deploy EP.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const REPO_ROOT = path.join(__dirname, '..', '..');
const RESOURCE_GROUPS = Object.freeze(['wh-staging-rg', 'luna-sunset-staging-rg']);

/** Pinned git blob SHA-1 of the canonical Bicep module (git hash-object). */
const EXPECTED_BICEP_GIT_BLOB = '406eb67828021dd453ee406d262a9bfbc4bb617c';
/** Content sha256 of the same Bicep bytes (defense in depth). */
const EXPECTED_BICEP_SHA256 = '6dd2d22adcfc4bf1ba3b93ac0515ead6b741c16976e7c667c8ad373cb00693f9';
/** Exact operator confirmation string required for live spawn (no DI). */
const OPERATOR_CONFIRMATION = 'CONFIRM_RADAR_16G_STAFF_API_METRIC_ALERTS_INCREMENTAL';
const AZ_BIN = 'az';
const TEMP_ARM_FILENAME = 'rg-staff-api-metric-alerts.compiled.json';

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
  slice: 'RADAR-16G',
  outcomeId: '16G_staff_api_metric_alerts',
  gateId: 'G03_actionable_tenant_aware_alerts',
  progressClass: 'source_partial_progress_only',
  doesNotImplement: 'live_deploy_notification_delivery_alert_fire',
  masterBasis: 'acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b',
  branch: 'radar/slice-16g-staff-api-metric-alerts-replacement',
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
  expectedBicepGitBlob: EXPECTED_BICEP_GIT_BLOB,
  expectedBicepSha256: EXPECTED_BICEP_SHA256,
  operatorConfirmation: OPERATOR_CONFIRMATION,
  safeDeploymentEntry: 'runSafeDeploymentEntry',
  deployEntryAllowsRootOverride: false,
  deployEntryAllowsCwdOverride: false,
  deployEntryAllowsTemplatePathOverride: false,
  tempDirMode: 0o700,
  tempFileMode: 0o400,
  readmeRel: 'infra/azure/staging-staff-api-metric-alerts/README.md',
  planFixtureRel: 'fixtures/radar-operations/slice16g-metric-alert-plan.json',
  mainBicepForbiddenWiring: Object.freeze([
    'infra/azure/staging/main.bicep',
    'infra/azure/sunset-staging/main.bicep',
  ]),
  referencedActionGroupSource: 'RADAR-16B',
  supersedes: 'RADAR-16F',
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

/**
 * Canonical repo-owned Bicep path — realpath from __dirname only.
 * No root/cwd/template-path override is accepted by the deploy entry point.
 */
function resolveCanonicalBicepPath() {
  const candidate = path.join(__dirname, '..', '..', BICEP_MODULE_REL);
  return fs.realpathSync(candidate);
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function gitBlobSha1(buf) {
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
}

function assertCanonicalBicepCleanTracked(bicepAbs) {
  const errors = [];
  const expectedAbs = fs.realpathSync(path.join(REPO_ROOT, BICEP_MODULE_REL));
  if (bicepAbs !== expectedAbs) {
    errors.push('bicep_path_escape');
  }

  let statusOut = '';
  try {
    const st = spawnSync(
      'git',
      ['-C', REPO_ROOT, 'status', '--porcelain', '--', BICEP_MODULE_REL],
      { encoding: 'utf8', shell: false },
    );
    if (st.status !== 0) {
      errors.push('git_status_failed');
    } else {
      statusOut = String(st.stdout || '');
      // Dirty modifications of a tracked file are rejected. Untracked (??) is
      // allowed only when working-tree blob matches the pinned expected hash.
      const lines = statusOut.split(/\n/).map((l) => l.trimEnd()).filter(Boolean);
      for (const line of lines) {
        if (line.startsWith('??')) continue;
        errors.push('bicep_not_clean');
        break;
      }
    }
  } catch (_) {
    errors.push('git_status_failed');
  }

  try {
    const ls = spawnSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', '-s', '--', BICEP_MODULE_REL],
      { encoding: 'utf8', shell: false },
    );
    const lsOut = String((ls && ls.stdout) || '').trim();
    if (ls.status === 0 && lsOut) {
      // format: <mode> <blob> <stage>\t<path>
      const parts = lsOut.split(/\s+/);
      const blob = parts.length >= 2 ? parts[1] : '';
      if (blob !== EXPECTED_BICEP_GIT_BLOB) {
        errors.push('bicep_git_blob_mismatch');
      }
    }
    // Untracked-but-matching working tree is accepted via content blob check below.
  } catch (_) {
    errors.push('git_status_failed');
  }

  let bytes;
  try {
    bytes = fs.readFileSync(bicepAbs);
  } catch (_) {
    errors.push('bicep_unreadable');
    return { ok: false, errors, bytes: null, contentSha256: null, gitBlob: null };
  }

  const contentSha256 = sha256Buffer(bytes);
  const gitBlob = gitBlobSha1(bytes);
  if (contentSha256 !== EXPECTED_BICEP_SHA256) {
    errors.push('bicep_sha256_mismatch');
  }
  if (gitBlob !== EXPECTED_BICEP_GIT_BLOB) {
    errors.push('bicep_git_blob_mismatch');
  }

  return {
    ok: errors.length === 0,
    errors,
    bytes,
    contentSha256,
    gitBlob,
    absolutePath: bicepAbs,
  };
}

function compileBicepToArmBytes(bicepAbs) {
  const errors = [];
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar16g-bicep-build-'));
  try {
    fs.chmodSync(outDir, 0o700);
  } catch (_) {
    /* best-effort */
  }
  const outFile = path.join(outDir, 'compiled.json');
  try {
    const build = spawnSync(
      AZ_BIN,
      ['bicep', 'build', '--file', bicepAbs, '--outfile', outFile],
      { encoding: 'utf8', shell: false },
    );
    if (build.status !== 0) {
      errors.push('bicep_compile_failed');
      return { ok: false, errors, armBytes: null, armSha256: null, buildDir: outDir };
    }
    const armBytes = fs.readFileSync(outFile);
    return {
      ok: true,
      errors: [],
      armBytes,
      armSha256: sha256Buffer(armBytes),
      buildDir: outDir,
    };
  } catch (_) {
    errors.push('bicep_compile_failed');
    return { ok: false, errors, armBytes: null, armSha256: null, buildDir: outDir };
  }
}

function rmTree(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
}

function buildExactDeploymentArgv({
  absoluteTemplatePath,
  resourceGroup,
  containerAppName,
  mode,
  extraArgs,
} = {}) {
  const errors = [];
  if (Array.isArray(extraArgs) && extraArgs.length > 0) {
    errors.push('extra_args_rejected');
  } else if (extraArgs != null && !Array.isArray(extraArgs)) {
    errors.push('extra_args_rejected');
  }
  if (String(mode || DEPLOYMENT_MODE) === 'Complete') {
    errors.push('complete_mode_rejected');
  } else if (String(mode || DEPLOYMENT_MODE) !== DEPLOYMENT_MODE) {
    errors.push('non_incremental_mode_rejected');
  }
  if (!absoluteTemplatePath || !path.isAbsolute(String(absoluteTemplatePath))) {
    errors.push('template_path_not_absolute');
  }
  const rg = String(resourceGroup || '');
  const plan = APP_PLANS[rg];
  if (!plan) errors.push('wrong_resource_group');
  if (plan && containerAppName != null && String(containerAppName) !== plan.containerAppName) {
    errors.push('wrong_container_app');
  }
  if (errors.length) {
    return { ok: false, errors, argv: null };
  }
  const argv = Object.freeze([
    'deployment',
    'group',
    'create',
    '--subscription',
    SUBSCRIPTION_ID,
    '--resource-group',
    rg,
    '--template-file',
    String(absoluteTemplatePath),
    '--mode',
    DEPLOYMENT_MODE,
    '--parameters',
    `containerAppName=${plan.containerAppName}`,
  ]);
  return {
    ok: true,
    errors: [],
    argv,
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: rg,
    containerAppName: plan.containerAppName,
    mode: DEPLOYMENT_MODE,
  };
}

/**
 * Offline preflight — scope + plan locks only. No root/cwd/template overrides.
 * Does not spawn Azure deploy.
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
  ]);

  for (const key of Object.keys(input || {})) {
    if (!allowedKeys.has(key)) {
      errors.push('unknown_preflight_key');
      break;
    }
  }

  // Explicitly reject override attempts even if somehow present via prototype
  if (input && (input.rootDir != null || input.cwd != null || input.templatePath != null
    || input.templateFile != null || input.root != null)) {
    errors.push('path_override_rejected');
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

  let bicepCheck = null;
  if (!errors.length) {
    try {
      const abs = resolveCanonicalBicepPath();
      bicepCheck = assertCanonicalBicepCleanTracked(abs);
      if (!bicepCheck.ok) errors.push(...bicepCheck.errors);
    } catch (_) {
      errors.push('bicep_resolve_failed');
    }
  }

  if (errors.length) {
    return Object.freeze({
      ok: false,
      errors: Object.freeze([...errors]),
      subscriptionId: SUBSCRIPTION_ID,
      resourceGroup: RESOURCE_GROUPS.includes(rg) ? rg : null,
      templateFile: BICEP_MODULE_REL,
      mode: null,
      liveDeployEnabled: false,
    });
  }

  return Object.freeze({
    ok: true,
    errors: Object.freeze([]),
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: rg,
    containerAppName: plan.containerAppName,
    actionGroupName: plan.actionGroupName,
    templateFile: BICEP_MODULE_REL,
    templateGitBlob: bicepCheck.gitBlob,
    templateSha256: bicepCheck.contentSha256,
    mode: DEPLOYMENT_MODE,
    liveDeployEnabled: false,
  });
}

/**
 * Safe deployment entry point.
 *
 * - No root/cwd/template-path override keys accepted
 * - Resolves canonical Bicep via realpath from __dirname
 * - Requires clean tracked file at EXPECTED_BICEP_GIT_BLOB
 * - Compiles/reads exact ARM JSON bytes
 * - Writes to fresh mode-0700 temp dir / mode-0400 file
 * - Same function spawns shell-free with absolute temp path, exact sub/RG,
 *   Incremental mode, explicit app parameter
 * - Verifies ARM bytes/hash before spawn and after completion; fails if changed
 * - Cleans temp in finally
 * - spawnFn injectable for tests only; production requires live=true + confirmation
 */
function runSafeDeploymentEntry(input = {}) {
  const errors = [];
  const allowedKeys = new Set([
    'resourceGroup',
    'live',
    'confirmation',
    'spawnFn',
    'mode',
    'deploymentMode',
    'extraArgs',
    // containerAppName may be supplied but must match locked tuple
    'containerAppName',
  ]);

  for (const key of Object.keys(input || {})) {
    if (!allowedKeys.has(key)) {
      errors.push('unknown_deploy_key');
      break;
    }
  }

  if (input.rootDir != null || input.root != null || input.cwd != null
    || input.templatePath != null || input.templateFile != null
    || input.bicepPath != null || input.outfile != null) {
    errors.push('path_override_rejected');
  }

  const rg = String(input.resourceGroup || '');
  const plan = APP_PLANS[rg];
  if (!plan) errors.push('wrong_resource_group');
  if (/prod/i.test(rg)) errors.push('production_resource_group_rejected');

  if (input.containerAppName != null && plan
    && String(input.containerAppName) !== plan.containerAppName) {
    errors.push('wrong_container_app');
  }

  const modeRaw = input.deploymentMode != null
    ? input.deploymentMode
    : (input.mode != null ? input.mode : DEPLOYMENT_MODE);
  if (String(modeRaw) === 'Complete') {
    errors.push('complete_mode_rejected');
  } else {
    const mode = assertDeploymentMode(modeRaw);
    if (!mode.ok) errors.push(...mode.errors);
  }

  if (Array.isArray(input.extraArgs) && input.extraArgs.length > 0) {
    errors.push('extra_args_rejected');
  } else if (input.extraArgs != null && !Array.isArray(input.extraArgs)) {
    errors.push('extra_args_rejected');
  }

  const spawnFn = typeof input.spawnFn === 'function' ? input.spawnFn : null;
  const live = input.live === true;
  const confirmation = input.confirmation != null ? String(input.confirmation) : '';

  if (!spawnFn) {
    // Production path: require explicit live + exact confirmation
    if (!live) {
      errors.push('live_flag_required');
    }
    if (confirmation !== OPERATOR_CONFIRMATION) {
      errors.push('operator_confirmation_required');
    }
    // Slice default: live deploy remains hard-disabled unless both are set.
    // Even with both set, LOCKS.liveDeployEnabled is false for this source slice —
    // refuse real az spawn unless an injected spawnFn is provided in tests.
    // Real live apply is out of scope for 16G (deployment/drill open).
    if (live && confirmation === OPERATOR_CONFIRMATION && !LOCKS.liveDeployEnabled) {
      errors.push('live_deploy_hard_disabled');
    }
  }

  let tempDir = null;
  let tempFile = null;
  let armBytes = null;
  let armSha256 = null;
  let argv = null;
  let spawnResult = null;

  const fail = (extraErrors) => ({
    ok: false,
    errors: [...errors, ...(extraErrors || [])],
    argv: null,
    spawned: false,
    liveCall: false,
    tempFile: null,
    armSha256: null,
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: RESOURCE_GROUPS.includes(rg) ? rg : null,
  });

  if (errors.length) {
    return fail();
  }

  try {
    let bicepAbs;
    try {
      bicepAbs = resolveCanonicalBicepPath();
    } catch (_) {
      return fail(['bicep_resolve_failed']);
    }

    // Symlink / alternate-path defense: realpath must equal repo canonical realpath
    const repoCanonical = fs.realpathSync(path.join(REPO_ROOT, BICEP_MODULE_REL));
    if (bicepAbs !== repoCanonical) {
      return fail(['bicep_symlink_escape']);
    }

    const tracked = assertCanonicalBicepCleanTracked(bicepAbs);
    if (!tracked.ok) {
      return fail(tracked.errors);
    }

    const compiled = compileBicepToArmBytes(bicepAbs);
    // Always clean compile scratch dir
    const buildDir = compiled.buildDir;
    try {
      if (!compiled.ok) {
        return fail(compiled.errors);
      }
      armBytes = compiled.armBytes;
      armSha256 = compiled.armSha256;

      // Inspect compiled template semantics
      let templateObj;
      try {
        templateObj = JSON.parse(armBytes.toString('utf8'));
      } catch (_) {
        return fail(['arm_json_parse_failed']);
      }
      const inspected = inspectCompiledTemplate(templateObj);
      if (!inspected.ok) {
        return fail(inspected.errors);
      }

      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar16g-deploy-'));
      fs.chmodSync(tempDir, 0o700);
      tempFile = path.join(tempDir, TEMP_ARM_FILENAME);
      fs.writeFileSync(tempFile, armBytes, { mode: 0o400 });
      fs.chmodSync(tempFile, 0o400);

      // Verify bytes/hash before spawn
      const beforeBytes = fs.readFileSync(tempFile);
      const beforeHash = sha256Buffer(beforeBytes);
      if (beforeHash !== armSha256 || Buffer.compare(beforeBytes, armBytes) !== 0) {
        return fail(['temp_arm_hash_mismatch_before_spawn']);
      }

      const built = buildExactDeploymentArgv({
        absoluteTemplatePath: tempFile,
        resourceGroup: rg,
        containerAppName: plan.containerAppName,
        mode: DEPLOYMENT_MODE,
      });
      if (!built.ok) {
        return fail(built.errors);
      }
      argv = built.argv;

      const doSpawn = spawnFn || ((cmd, args, opts) => spawnSync(cmd, args, opts));
      spawnResult = doSpawn(AZ_BIN, [...argv], {
        shell: false,
        encoding: 'utf8',
        env: process.env,
      });

      // Verify bytes/hash after completion — fail if changed
      const afterBytes = fs.readFileSync(tempFile);
      const afterHash = sha256Buffer(afterBytes);
      if (afterHash !== armSha256 || Buffer.compare(afterBytes, armBytes) !== 0) {
        return {
          ok: false,
          errors: ['temp_arm_mutated_after_spawn'],
          argv,
          spawned: true,
          liveCall: !spawnFn && live,
          tempFile,
          armSha256,
          subscriptionId: SUBSCRIPTION_ID,
          resourceGroup: rg,
          containerAppName: plan.containerAppName,
          spawnStatus: spawnResult && spawnResult.status,
        };
      }

      const spawnOk = spawnResult && (spawnResult.status === 0 || spawnResult.status == null);
      // For injected spawn, status 0 expected; allow custom ok field
      const injectedOk = spawnFn
        ? (spawnResult && spawnResult.status === 0 && spawnResult.error == null)
        : spawnOk;

      if (!injectedOk) {
        return {
          ok: false,
          errors: ['spawn_failed'],
          argv,
          spawned: true,
          liveCall: !spawnFn && live,
          tempFile,
          armSha256,
          subscriptionId: SUBSCRIPTION_ID,
          resourceGroup: rg,
          containerAppName: plan.containerAppName,
          spawnStatus: spawnResult && spawnResult.status,
        };
      }

      return {
        ok: true,
        errors: [],
        argv,
        spawned: true,
        liveCall: !spawnFn && live,
        tempFile,
        armSha256,
        templateGitBlob: tracked.gitBlob,
        subscriptionId: SUBSCRIPTION_ID,
        resourceGroup: rg,
        containerAppName: plan.containerAppName,
        mode: DEPLOYMENT_MODE,
        spawnStatus: 0,
      };
    } finally {
      rmTree(buildDir);
    }
  } finally {
    rmTree(tempDir);
  }
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

  function redDeploy(name, input, expectError) {
    const result = runSafeDeploymentEntry(input);
    const hit = result.errors.includes(expectError);
    cases.push({
      name,
      expect: 'RED',
      ok: result.ok === false && hit && result.liveCall === false,
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

  const noopSpawn = () => ({ status: 0, error: null, stdout: '', stderr: '' });

  redDeploy('deploy_complete_mode', {
    resourceGroup: 'wh-staging-rg',
    mode: 'Complete',
    spawnFn: noopSpawn,
  }, 'complete_mode_rejected');

  redDeploy('deploy_extra_args', {
    resourceGroup: 'wh-staging-rg',
    extraArgs: ['--what-if'],
    spawnFn: noopSpawn,
  }, 'extra_args_rejected');

  redDeploy('deploy_alternate_root', {
    resourceGroup: 'wh-staging-rg',
    rootDir: '/tmp',
    spawnFn: noopSpawn,
  }, 'unknown_deploy_key');

  redDeploy('deploy_alternate_cwd', {
    resourceGroup: 'wh-staging-rg',
    cwd: '/tmp',
    spawnFn: noopSpawn,
  }, 'unknown_deploy_key');

  redDeploy('deploy_template_path_override', {
    resourceGroup: 'wh-staging-rg',
    templatePath: '/tmp/evil.json',
    spawnFn: noopSpawn,
  }, 'unknown_deploy_key');

  redDeploy('deploy_wrong_app', {
    resourceGroup: 'wh-staging-rg',
    containerAppName: 'evil-app',
    spawnFn: noopSpawn,
  }, 'wrong_container_app');

  redDeploy('deploy_live_without_confirmation', {
    resourceGroup: 'wh-staging-rg',
    live: true,
  }, 'operator_confirmation_required');

  redDeploy('deploy_confirmation_without_live', {
    resourceGroup: 'wh-staging-rg',
    confirmation: OPERATOR_CONFIRMATION,
  }, 'live_flag_required');

  // Temp mutation during spawn must fail closed
  {
    const mutSpawn = (cmd, args) => {
      const tfIdx = args.indexOf('--template-file');
      const tf = tfIdx >= 0 ? args[tfIdx + 1] : null;
      if (tf) {
        try {
          fs.chmodSync(tf, 0o600);
          fs.writeFileSync(tf, Buffer.from('{"mutated":true}'));
        } catch (_) {
          /* ignore */
        }
      }
      return { status: 0, error: null, stdout: '', stderr: '' };
    };
    const result = runSafeDeploymentEntry({
      resourceGroup: 'wh-staging-rg',
      spawnFn: mutSpawn,
    });
    cases.push({
      name: 'deploy_temp_mutation',
      expect: 'RED',
      ok: result.ok === false && result.errors.includes('temp_arm_mutated_after_spawn'),
      expectError: 'temp_arm_mutated_after_spawn',
      errors: result.errors,
    });
  }

  // Hash mismatch via wrong expected blob — simulated by unknown key path already;
  // direct hash RED: call assertCanonical with a wrong file via entry refusing overrides.
  redDeploy('deploy_unknown_key', {
    resourceGroup: 'wh-staging-rg',
    forged: true,
    spawnFn: noopSpawn,
  }, 'unknown_deploy_key');

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
    cases.push({
      name: `green_preflight_${rg}`,
      expect: 'GREEN',
      ok: pf.ok === true && pf.errors.length === 0 && pf.templateGitBlob === EXPECTED_BICEP_GIT_BLOB,
      errors: pf.ok ? [] : [...(pf.errors || [])],
    });

    let capturedArgv = null;
    const spySpawn = (cmd, args, opts) => {
      capturedArgv = Array.isArray(args) ? [...args] : args;
      if (cmd !== AZ_BIN) {
        return { status: 1, error: new Error('wrong_cmd'), stdout: '', stderr: 'wrong_cmd' };
      }
      if (!opts || opts.shell !== false) {
        return { status: 1, error: new Error('shell_not_false'), stdout: '', stderr: 'shell' };
      }
      return { status: 0, error: null, stdout: 'ok', stderr: '' };
    };

    const dep = runSafeDeploymentEntry({
      resourceGroup: rg,
      spawnFn: spySpawn,
    });

    const exactArgvOk = dep.ok === true
      && Array.isArray(dep.argv)
      && Array.isArray(capturedArgv)
      && capturedArgv.length === dep.argv.length
      && capturedArgv.every((v, i) => v === dep.argv[i])
      && dep.argv[0] === 'deployment'
      && dep.argv[1] === 'group'
      && dep.argv[2] === 'create'
      && dep.argv.includes('--subscription')
      && dep.argv.includes(SUBSCRIPTION_ID)
      && dep.argv.includes('--resource-group')
      && dep.argv.includes(rg)
      && dep.argv.includes('--template-file')
      && path.isAbsolute(dep.argv[dep.argv.indexOf('--template-file') + 1])
      && dep.argv.includes('--mode')
      && dep.argv.includes('Incremental')
      && !dep.argv.includes('Complete')
      && dep.argv.includes('--parameters')
      && dep.argv.includes(`containerAppName=${plan.containerAppName}`)
      && dep.liveCall === false
      && dep.spawned === true
      && typeof dep.armSha256 === 'string'
      && dep.armSha256.length === 64;

    cases.push({
      name: `green_deploy_exact_argv_${rg}`,
      expect: 'GREEN',
      ok: exactArgvOk,
      errors: exactArgvOk ? [] : [...(dep.errors || []), 'exact_argv_mismatch'],
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
  EXPECTED_BICEP_GIT_BLOB,
  EXPECTED_BICEP_SHA256,
  OPERATOR_CONFIRMATION,
  assertExactStagingScope,
  assertDeploymentMode,
  assertAlertPlan,
  assertAllowedResourceTypesOnly,
  inspectBicepSource,
  inspectCompiledTemplate,
  assertNotWiredIntoMain,
  buildSecretFreePlan,
  resolveCanonicalBicepPath,
  assertCanonicalBicepCleanTracked,
  buildExactDeploymentArgv,
  runPreflight,
  runSafeDeploymentEntry,
  evaluateDeployRequest,
  runRedCases,
  runGreenCases,
};

