'use strict';

/**
 * verify:radar-slice16h-staff-api-metric-alerts — RADAR Slice 16H
 *
 * Independent offline gate. Does NOT import any plan/preflight/implementation
 * library. Compares compiled Bicep + plan fixture against a separate frozen
 * expected contract (contract owns truth values). Independently compiles
 * adversarial Bicep overrides proving wrong subscription/RG/app/action-group/
 * threshold/severity/window cannot produce a valid deployment template.
 *
 * Source module only — no deployment wrapper / execution claim.
 * No network, no Azure mutation, no real secrets.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MASTER = 'acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b';

const CONTRACT_REL = 'fixtures/radar-operations/slice16h-expected-contract.json';
const PLAN_REL = 'fixtures/radar-operations/slice16h-metric-alert-plan.json';
const BICEP_REL = 'infra/azure/staging-staff-api-metric-alerts/rg-staff-api-metric-alerts.bicep';
const VERIFY_REL = 'scripts/verify-radar-slice16h-staff-api-metric-alerts.js';

const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]{20,}/,
  /whsec_[A-Za-z0-9]+/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /password["']?\s*[:=]\s*["'][^"']{8,}/i,
  /ACCOUNT_KEY["']?\s*[:=]\s*["'][^"']{16,}/i,
];

const MAIN_BICEP = Object.freeze([
  'infra/azure/staging/main.bicep',
  'infra/azure/sunset-staging/main.bicep',
]);

let pass = 0;
let fail = 0;
const redResults = [];
const greenResults = [];
const fieldCoverage = [];
const tmpArtifacts = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function secretFree(text, label) {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return { ok: false, detail: `${label} matched ${re}` };
  }
  return { ok: true };
}

function arraysEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length
    && a.every((v, i) => v === b[i]);
}

function changedPaths(a, b, prefix) {
  const paths = [];
  if (Object.is(a, b)) return paths;
  const here = prefix || '';
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    paths.push(here || '(root)');
    return paths;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      paths.push(here || '(root)');
      return paths;
    }
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
      const p = here ? `${here}.${i}` : String(i);
      if (i >= a.length || i >= b.length) paths.push(p);
      else paths.push(...changedPaths(a[i], b[i], p));
    }
    return paths;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const p = here ? `${here}.${k}` : k;
    const hasA = Object.prototype.hasOwnProperty.call(a, k);
    const hasB = Object.prototype.hasOwnProperty.call(b, k);
    if (!hasA || !hasB) paths.push(p);
    else paths.push(...changedPaths(a[k], b[k], p));
  }
  return paths;
}

function pathsMatchIntended(got, intended) {
  const g = [...got].sort();
  const w = [...intended].sort();
  return g.length === w.length && g.every((p, i) => p === w[i]);
}

function bicepEnv() {
  return {
    ...process.env,
    PATH: `/opt/data/.local/bin:${process.env.PATH || ''}`,
    AZURE_CONFIG_DIR: process.env.AZURE_CONFIG_DIR || '/opt/data/.azure',
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
  };
}

function buildBicepFile(bicepAbs, outAbs) {
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  execFileSync('az', ['bicep', 'build', '--file', bicepAbs, '--outfile', outAbs], {
    cwd: ROOT,
    env: bicepEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(fs.readFileSync(outAbs, 'utf8'));
}

function buildBicep() {
  const bicep = path.join(ROOT, BICEP_REL);
  const out = path.join(ROOT, 'tmp', 'radar-16h-rg-staff-api-metric-alerts.json');
  tmpArtifacts.push(out);
  return { compiled: buildBicepFile(bicep, out), outPath: out };
}

function setByPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    const idx = /^\d+$/.test(p) ? Number(p) : p;
    cur = cur[idx];
  }
  const last = parts[parts.length - 1];
  const lastIdx = /^\d+$/.test(last) ? Number(last) : last;
  cur[lastIdx] = value;
}

function comparePlanToContract(plan, expected) {
  const errors = [];
  const covered = [];

  function eq(pathLabel, got, want) {
    if (got !== want) errors.push(`${pathLabel}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    else covered.push(pathLabel);
  }

  eq('schema_version', plan.schema_version, expected.schema_version);
  eq('slice', plan.slice, expected.slice);
  eq('master_basis', plan.master_basis, expected.master_basis);
  eq('branch', plan.branch, expected.branch);
  eq('outcome_id', plan.outcome_id, expected.outcome_id);
  eq('gate_id', plan.gate_id, expected.gate_id);
  eq('progress_class', plan.progress_class, expected.progress_class);
  eq('does_not_implement', plan.does_not_implement, expected.does_not_implement);
  eq('subscriptionId', plan.subscriptionId, expected.subscriptionId);
  eq('deploymentMode', plan.deploymentMode, expected.deploymentMode);
  eq('template_enforces_arm_mode', plan.template_enforces_arm_mode, expected.template_enforces_arm_mode);
  eq('operator_incremental_deploy', plan.operator_incremental_deploy, expected.operator_incremental_deploy);
  eq('deployment_wrapper', plan.deployment_wrapper, expected.deployment_wrapper);
  eq('execution_claim', plan.execution_claim, expected.execution_claim);
  eq('liveDeployEnabled', plan.liveDeployEnabled, expected.liveDeployEnabled);
  eq('notification_delivery_proof', plan.notification_delivery_proof, expected.notification_delivery_proof);
  eq('alert_fire_drill', plan.alert_fire_drill, expected.alert_fire_drill);
  eq('zero_live_mutation', plan.zero_live_mutation, expected.zero_live_mutation);
  eq('bicepModuleRel', plan.bicepModuleRel, expected.bicepModuleRel);
  eq('metricNamespace', plan.metricNamespace, expected.metricNamespace);
  eq('windowSize', plan.windowSize, expected.windowSize);
  eq('evaluationFrequency', plan.evaluationFrequency, expected.evaluationFrequency);
  eq('severity', plan.severity, expected.severity);
  eq('timeAggregation', plan.timeAggregation, expected.timeAggregation);

  const allowed = plan.resourceTypesAllowed || [];
  if (!arraysEqual(allowed, expected.allowedResourceTypes)) {
    errors.push(`resourceTypesAllowed mismatch: ${JSON.stringify(allowed)}`);
  } else {
    covered.push('allowedResourceTypes');
    covered.push('resourceGroups');
  }

  if (!Array.isArray(plan.apps) || plan.apps.length !== expected.apps.length) {
    errors.push(`apps.length: got ${plan.apps && plan.apps.length}`);
  } else {
    for (let i = 0; i < expected.apps.length; i += 1) {
      const got = plan.apps[i];
      const want = expected.apps[i];
      eq(`apps.${i}.resourceGroup`, got.resourceGroup, want.resourceGroup);
      eq(`apps.${i}.containerAppName`, got.containerAppName, want.containerAppName);
      eq(`apps.${i}.tenantSlug`, got.tenantSlug, want.tenantSlug);
      eq(`apps.${i}.actionGroupName`, got.actionGroupName, want.actionGroupName);
      covered.push('containerAppName', 'actionGroupName', 'tenantSlug');
      if (!Array.isArray(got.alerts) || got.alerts.length !== want.alerts.length) {
        errors.push(`apps.${i}.alerts.length`);
        continue;
      }
      for (let j = 0; j < want.alerts.length; j += 1) {
        const ga = got.alerts[j];
        const wa = want.alerts[j];
        eq(`apps.${i}.alerts.${j}.name`, ga.name, wa.name);
        eq(`apps.${i}.alerts.${j}.metricName`, ga.metricName, wa.metricName);
        eq(`apps.${i}.alerts.${j}.operator`, ga.operator, wa.operator);
        eq(`apps.${i}.alerts.${j}.threshold`, ga.threshold, wa.threshold);
        eq(`apps.${i}.alerts.${j}.enabled`, ga.enabled, wa.enabled);
        if (wa.dimensionName == null) {
          if (ga.dimensionName != null && ga.dimensionName !== null) {
            errors.push(`apps.${i}.alerts.${j}.dimensionName`);
          }
        } else {
          eq(`apps.${i}.alerts.${j}.dimensionName`, ga.dimensionName, wa.dimensionName);
          if (!arraysEqual(ga.dimensionValues || [], wa.dimensionValues || [])) {
            errors.push(`apps.${i}.alerts.${j}.dimensionValues`);
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, covered };
}

function findAlertByMetric(resources, metricName) {
  return resources.find((r) => {
    const allOf = r.properties && r.properties.criteria && r.properties.criteria.allOf;
    return Array.isArray(allOf) && allOf[0] && (
      allOf[0].metricName === metricName
      || allOf[0].metricName === `[variables('${metricName === 'Requests' ? 'requestsMetricName' : 'restartMetricName'}')]`
    );
  });
}

function compareCompiledToContract(compiled, expected) {
  const errors = [];
  const covered = [];
  const expr = expected.compiled.expressions;
  const vars = expected.compiled.variables;
  const hard = expected.hardLockContract;
  const resources = (compiled && compiled.resources) || [];
  const types = resources.map((r) => r.type);

  if (resources.length !== expected.compiled.resourceCount) {
    errors.push(`resourceCount: got ${resources.length} want ${expected.compiled.resourceCount}`);
  } else {
    covered.push('resourceCount');
  }
  for (const t of expected.allowedResourceTypes) {
    if (!types.includes(t)) errors.push(`missing_type:${t}`);
  }
  for (const t of types) {
    if (!expected.allowedResourceTypes.includes(t)) errors.push(`extra_type:${t}`);
  }
  if (errors.every((e) => !e.startsWith('missing_type:') && !e.startsWith('extra_type:'))) {
    covered.push('allowedResourceTypes');
  }

  const params = (compiled && compiled.parameters) || {};
  const paramKeys = Object.keys(params);
  if (!arraysEqual(paramKeys, expected.compiled.allowedParameters)) {
    errors.push(`allowedParameters: got ${JSON.stringify(paramKeys)}`);
  } else {
    covered.push('only_allowed_parameter');
  }
  for (const forbidden of hard.forbiddenParameters) {
    if (Object.prototype.hasOwnProperty.call(params, forbidden)) {
      errors.push(`forbidden_param_present:${forbidden}`);
    }
  }

  const compiledVars = (compiled && compiled.variables) || {};
  for (const [k, v] of Object.entries(vars)) {
    if (compiledVars[k] !== v) errors.push(`variable_mismatch:${k}`);
    else covered.push(`variable_${k}`);
  }

  if (!String(compiledVars.assertSubscription || '').includes("fail('wrong_subscription')")
    || !String(compiledVars.assertSubscription || '').includes('subscription().subscriptionId')) {
    errors.push('hard_lock_subscription_assert_missing');
  } else {
    covered.push('hard_lock_subscription_assert');
  }
  if (!String(compiledVars.assertRgAppTuple || '').includes("fail('wrong_container_app')")
    || compiledVars.rgName !== '[resourceGroup().name]') {
    errors.push('hard_lock_rg_app_tuple_missing');
  } else {
    covered.push('hard_lock_rg_app_tuple');
  }
  if (!String(compiledVars.actionGroupName || '').includes('wh-staging-ops-budget-ag')
    || !String(compiledVars.actionGroupName || '').includes('luna-sunset-staging-ops-budget-ag')
    || !String(compiledVars.actionGroupName || '').includes("fail('wrong_resource_group')")) {
    errors.push('derived_action_group_missing');
  } else {
    covered.push('derived_action_group');
  }

  for (const [k, v] of Object.entries(hard.constantVars)) {
    if (compiledVars[k] !== v) errors.push(`constant_var_mismatch:${k}`);
  }

  const modeOut = compiled && compiled.outputs && compiled.outputs.deploymentModeRequired
    && compiled.outputs.deploymentModeRequired.value;
  if (modeOut !== expected.compiled.deploymentModeOutput) {
    errors.push(`deploymentModeOutput: got ${modeOut}`);
  } else {
    covered.push('deploymentMode');
  }

  const typeOut = compiled && compiled.outputs && compiled.outputs.allowedResourceType
    && compiled.outputs.allowedResourceType.value;
  if (typeOut !== expected.compiled.allowedResourceTypeOutput) {
    errors.push(`allowedResourceTypeOutput: got ${typeOut}`);
  }

  const requests = findAlertByMetric(resources, 'Requests')
    || resources.find((r) => String(r.name).includes('requests5xx'));
  const restarts = findAlertByMetric(resources, 'RestartCount')
    || resources.find((r) => String(r.name).includes('restartCount'));
  if (!requests) errors.push('missing_requests_alert');
  if (!restarts) errors.push('missing_restart_alert');

  function checkCommon(alert, label) {
    if (!alert) return;
    if (alert.location !== 'global') errors.push(`${label}_location`);
    if (!alert.properties || alert.properties.enabled !== expr.alertsEnabled) {
      errors.push(`${label}_not_enabled`);
    } else {
      covered.push('enabled');
    }
    if (alert.properties.severity !== expr.alertSeverity) errors.push(`${label}_severity_expression`);
    else covered.push('severity');
    if (alert.properties.windowSize !== expr.windowSize) errors.push(`${label}_window_expression`);
    else covered.push('windowSize');
    if (alert.properties.evaluationFrequency !== expr.evaluationFrequency) {
      errors.push(`${label}_eval_expression`);
    } else {
      covered.push('evaluationFrequency');
    }
    const scopes = alert.properties.scopes || [];
    if (scopes.length !== 1 || scopes[0] !== expected.containerAppScopeExpression) {
      errors.push(`${label}_scopes`);
    } else {
      covered.push('scopes');
    }
    const actions = alert.properties.actions || [];
    if (actions.length !== 1 || actions[0].actionGroupId !== expected.actionGroupIdExpression) {
      errors.push(`${label}_actions`);
    } else {
      covered.push('actions_actionGroupId');
    }
    const criteria = alert.properties.criteria || {};
    if (criteria['odata.type'] !== expected.alertCriteriaODataType) {
      errors.push(`${label}_odata_type`);
    }
    const allOf = criteria.allOf || [];
    if (allOf.length !== 1) errors.push(`${label}_allOf_count`);
    return allOf[0];
  }

  const reqCrit = checkCommon(requests, 'requests');
  if (reqCrit) {
    if (reqCrit.metricName !== "[variables('requestsMetricName')]"
      && reqCrit.metricName !== 'Requests') {
      errors.push('requests_metric');
    } else {
      covered.push('metricName_requests');
    }
    if (reqCrit.metricNamespace !== "[variables('metricNamespace')]"
      && reqCrit.metricNamespace !== expected.metricNamespace) {
      errors.push('requests_namespace');
    } else {
      covered.push('metricNamespace');
    }
    if (reqCrit.operator !== "[variables('requests5xxOperator')]"
      && reqCrit.operator !== 'GreaterThanOrEqual') {
      errors.push('requests_operator');
    } else {
      covered.push('operator_requests');
    }
    if (reqCrit.threshold !== expr.requests5xxThreshold
      && reqCrit.threshold !== 3) {
      errors.push('requests_threshold_expression');
    } else {
      covered.push('threshold_requests');
    }
    if (reqCrit.timeAggregation !== "[variables('timeAggregation')]"
      && reqCrit.timeAggregation !== expected.timeAggregation) {
      errors.push('requests_aggregation');
    }
    const dims = reqCrit.dimensions || [];
    const dimNameOk = dims.length === 1 && (
      dims[0].name === 'statusCodeCategory'
      || dims[0].name === "[variables('statusCodeCategoryDimension')]"
    );
    const dimValOk = dims.length === 1 && Array.isArray(dims[0].values) && (
      arraysEqual(dims[0].values, ['5xx'])
      || arraysEqual(dims[0].values, ["[variables('statusCodeCategoryValue')]"])
    );
    if (!dimNameOk || !dimValOk || (dims[0] && dims[0].operator !== 'Include')) {
      errors.push('requests_dimension');
    } else {
      covered.push('dimension_statusCodeCategory');
    }
  }

  const rstCrit = checkCommon(restarts, 'restarts');
  if (rstCrit) {
    if (rstCrit.metricName !== "[variables('restartMetricName')]"
      && rstCrit.metricName !== 'RestartCount') {
      errors.push('restarts_metric');
    } else {
      covered.push('metricName_restart');
    }
    if (rstCrit.operator !== "[variables('restartCountOperator')]"
      && rstCrit.operator !== 'GreaterThan') {
      errors.push('restarts_operator');
    } else {
      covered.push('operator_restart');
    }
    if (rstCrit.threshold !== expr.restartCountThreshold
      && rstCrit.threshold !== 0) {
      errors.push('restarts_threshold_expression');
    } else {
      covered.push('threshold_restart');
    }
    if (rstCrit.dimensions && rstCrit.dimensions.length) errors.push('restarts_unexpected_dimensions');
  }

  for (const forbidden of expected.forbiddenCreateTypes) {
    if (types.includes(forbidden)) errors.push(`forbidden_created_type:${forbidden}`);
  }

  return { ok: errors.length === 0, errors, types, covered };
}

function runPlanRedMutations(basePlan, expected) {
  const cases = [
    { name: 'wrong_scope_subscription', path: 'subscriptionId', value: '00000000-0000-0000-0000-000000000000', intendedPaths: ['subscriptionId'] },
    { name: 'wrong_scope_rg', path: 'apps.0.resourceGroup', value: 'other-staging-rg', intendedPaths: ['apps.0.resourceGroup'] },
    { name: 'production_marker_rg', path: 'apps.0.resourceGroup', value: 'wh-prod-rg', intendedPaths: ['apps.0.resourceGroup'] },
    { name: 'wrong_scope_app', path: 'apps.0.containerAppName', value: 'wrong-staff-api', intendedPaths: ['apps.0.containerAppName'] },
    { name: 'wrong_action_group', path: 'apps.0.actionGroupName', value: 'wrong-ops-ag', intendedPaths: ['apps.0.actionGroupName'] },
    { name: 'changed_metric', path: 'apps.0.alerts.0.metricName', value: 'Replicas', intendedPaths: ['apps.0.alerts.0.metricName'] },
    { name: 'changed_dimension', path: 'apps.0.alerts.0.dimensionValues.0', value: '4xx', intendedPaths: ['apps.0.alerts.0.dimensionValues.0'] },
    { name: 'changed_operator', path: 'apps.0.alerts.0.operator', value: 'GreaterThan', intendedPaths: ['apps.0.alerts.0.operator'] },
    { name: 'changed_threshold', path: 'apps.0.alerts.0.threshold', value: 99, intendedPaths: ['apps.0.alerts.0.threshold'] },
    { name: 'changed_window', path: 'windowSize', value: 'PT15M', intendedPaths: ['windowSize'] },
    { name: 'changed_severity', path: 'severity', value: 0, intendedPaths: ['severity'] },
    { name: 'alert_disabled', path: 'apps.0.alerts.0.enabled', value: false, intendedPaths: ['apps.0.alerts.0.enabled'] },
    { name: 'schema_version', path: 'schema_version', value: 99, intendedPaths: ['schema_version'] },
    { name: 'slice_pin', path: 'slice', value: 'RADAR-99Z', intendedPaths: ['slice'] },
    { name: 'master_basis_pin', path: 'master_basis', value: '0000000000000000000000000000000000000000', intendedPaths: ['master_basis'] },
    { name: 'branch_pin', path: 'branch', value: 'radar/wrong-branch', intendedPaths: ['branch'] },
    {
      name: 'extra_resource',
      path: 'resourceTypesAllowed',
      value: ['Microsoft.Insights/metricAlerts', 'Microsoft.Insights/actionGroups'],
      intendedPaths: ['resourceTypesAllowed.1'],
    },
    { name: 'Complete_mode', path: 'deploymentMode', value: 'Complete', intendedPaths: ['deploymentMode'] },
    { name: 'live_deploy_claim', path: 'liveDeployEnabled', value: true, intendedPaths: ['liveDeployEnabled'] },
    { name: 'template_claims_arm_mode', path: 'template_enforces_arm_mode', value: true, intendedPaths: ['template_enforces_arm_mode'] },
    { name: 'execution_claim_true', path: 'execution_claim', value: true, intendedPaths: ['execution_claim'] },
    {
      name: 'missing_rg',
      intendedPaths: ['apps.1'],
      mutate(p) { p.apps.splice(1, 1); },
    },
    {
      name: 'extra_rg',
      intendedPaths: ['apps.2'],
      mutate(p) {
        p.apps.push({
          ...deepClone(p.apps[0]),
          resourceGroup: 'extra-staging-rg',
          containerAppName: 'extra-staff-api',
          tenantSlug: 'extra',
          actionGroupName: 'extra-ops-ag',
        });
      },
    },
  ];

  const results = [];
  for (const c of cases) {
    const mutated = deepClone(basePlan);
    if (typeof c.mutate === 'function') c.mutate(mutated);
    else setByPath(mutated, c.path, c.value);
    const diffs = changedPaths(basePlan, mutated);
    const oneField = pathsMatchIntended(diffs, c.intendedPaths);
    const cmp = comparePlanToContract(mutated, expected);
    const okRed = oneField && cmp.ok === false;
    results.push({
      name: c.name,
      expect: 'RED',
      ok: okRed,
      oneField,
      diffs,
      intendedPaths: c.intendedPaths,
      errors: okRed ? cmp.errors : [
        ...(oneField ? [] : [`one_field_failed diffs=${JSON.stringify(diffs)} intended=${JSON.stringify(c.intendedPaths)}`]),
        ...cmp.errors,
        ...(cmp.ok ? ['mutation_not_rejected'] : []),
      ],
    });
  }
  return results;
}

function runCompiledRedMutations(baseCompiled, expected) {
  const cases = [
    {
      name: 'compiled_extra_resource',
      intendedPaths: ['resources.2'],
      mutate(t) {
        t.resources.push({ type: 'Microsoft.Insights/actionGroups', name: 'x', properties: {} });
      },
    },
    {
      name: 'compiled_changed_metric',
      intendedPaths: ['variables.requestsMetricName'],
      mutate(t) { t.variables.requestsMetricName = 'Replicas'; },
    },
    {
      name: 'compiled_changed_dimension',
      intendedPaths: ['variables.statusCodeCategoryValue'],
      mutate(t) { t.variables.statusCodeCategoryValue = '4xx'; },
    },
    {
      name: 'compiled_changed_operator',
      intendedPaths: ['variables.requests5xxOperator'],
      mutate(t) { t.variables.requests5xxOperator = 'GreaterThan'; },
    },
    {
      name: 'compiled_changed_threshold',
      intendedPaths: ['variables.requests5xxThreshold'],
      mutate(t) { t.variables.requests5xxThreshold = 99; },
    },
    {
      name: 'compiled_changed_window',
      intendedPaths: ['variables.windowSize'],
      mutate(t) { t.variables.windowSize = 'PT15M'; },
    },
    {
      name: 'compiled_changed_severity',
      intendedPaths: ['variables.alertSeverity'],
      mutate(t) { t.variables.alertSeverity = 0; },
    },
    {
      name: 'compiled_wrong_action_group',
      intendedPaths: ['variables.actionGroupName'],
      mutate(t) { t.variables.actionGroupName = 'evil-ops-ag'; },
    },
    {
      name: 'compiled_wrong_subscription_lock',
      intendedPaths: ['variables.lockedSubscriptionId'],
      mutate(t) { t.variables.lockedSubscriptionId = '00000000-0000-0000-0000-000000000000'; },
    },
    {
      name: 'compiled_missing_action',
      intendedPaths: ['resources.0.properties.actions.0'],
      mutate(t) { t.resources[0].properties.actions = []; },
    },
    {
      name: 'compiled_extra_action',
      intendedPaths: ['resources.0.properties.actions.1'],
      mutate(t) { t.resources[0].properties.actions.push({ actionGroupId: 'extra' }); },
    },
    {
      name: 'compiled_wrong_scope',
      intendedPaths: ['resources.0.properties.scopes.0'],
      mutate(t) { t.resources[0].properties.scopes = ['wrong-scope']; },
    },
    {
      name: 'compiled_alert_disabled',
      intendedPaths: ['variables.alertsEnabled'],
      mutate(t) { t.variables.alertsEnabled = false; },
    },
    {
      name: 'compiled_Complete_mode_output',
      intendedPaths: ['outputs.deploymentModeRequired.value'],
      mutate(t) { t.outputs.deploymentModeRequired.value = 'Complete'; },
    },
  ];

  const results = [];
  for (const c of cases) {
    const mutated = deepClone(baseCompiled);
    c.mutate(mutated);
    const diffs = changedPaths(baseCompiled, mutated);
    const oneField = pathsMatchIntended(diffs, c.intendedPaths);
    const cmp = compareCompiledToContract(mutated, expected);
    const okRed = oneField && cmp.ok === false;
    results.push({
      name: c.name,
      expect: 'RED',
      ok: okRed,
      oneField,
      diffs,
      intendedPaths: c.intendedPaths,
      errors: okRed ? cmp.errors : [
        ...(oneField ? [] : [`one_field_failed diffs=${JSON.stringify(diffs)} intended=${JSON.stringify(c.intendedPaths)}`]),
        ...cmp.errors,
        ...(cmp.ok ? ['mutation_not_rejected'] : []),
      ],
    });
  }
  return results;
}

function runAdversarialCompileReds(goodBicepText, expected) {
  const cases = [
    {
      name: 'adversarial_wrong_subscription',
      replace: ["var lockedSubscriptionId = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9'", "var lockedSubscriptionId = '00000000-0000-0000-0000-000000000000'"],
    },
    {
      name: 'adversarial_wrong_rg_tuple',
      replace: ["? 'wh-staging-staff-api'", "? 'evil-staging-staff-api'"],
    },
    {
      name: 'adversarial_wrong_app_assert',
      replace: ["? 'wh-staging-ops-budget-ag'", "? 'evil-ops-budget-ag'"],
    },
    {
      name: 'adversarial_wrong_action_group',
      replace: ["? 'luna-sunset-staging-ops-budget-ag'", "? 'evil-sunset-ops-ag'"],
    },
    {
      name: 'adversarial_wrong_threshold',
      replace: ['var requests5xxThreshold = 3', 'var requests5xxThreshold = 99'],
    },
    {
      name: 'adversarial_wrong_severity',
      replace: ['var alertSeverity = 2', 'var alertSeverity = 0'],
    },
    {
      name: 'adversarial_wrong_window',
      replace: ["var windowSize = 'PT5M'", "var windowSize = 'PT15M'"],
    },
  ];

  const results = [];
  const tmpDir = path.join(ROOT, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  for (const c of cases) {
    const [from, to] = c.replace;
    if (!goodBicepText.includes(from)) {
      results.push({
        name: c.name,
        expect: 'RED',
        ok: false,
        errors: [`source_missing_replace_target:${from}`],
      });
      continue;
    }
    const advText = goodBicepText.replace(from, to);
    const bicepPath = path.join(tmpDir, `radar-16h-adv-${c.name}.bicep`);
    const outPath = path.join(tmpDir, `radar-16h-adv-${c.name}.json`);
    tmpArtifacts.push(bicepPath, outPath);
    fs.writeFileSync(bicepPath, advText, 'utf8');
    let compiled = null;
    let compileErr = null;
    try {
      compiled = buildBicepFile(bicepPath, outPath);
    } catch (err) {
      compileErr = String(err && err.stderr || err.message || err).slice(0, 300);
    }
    let okRed = false;
    let errors = [];
    if (compileErr) {
      okRed = true;
      errors = [`compile_failed:${compileErr}`];
    } else {
      const cmp = compareCompiledToContract(compiled, expected);
      okRed = cmp.ok === false;
      errors = okRed ? cmp.errors.slice(0, 5) : ['adversarial_still_matched_contract'];
    }
    results.push({
      name: c.name,
      expect: 'RED',
      ok: okRed,
      errors,
    });
  }
  return results;
}

function cleanupTmp() {
  for (const p of tmpArtifacts) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) { /* ignore */ }
  }
  const tmpDir = path.join(ROOT, 'tmp');
  if (fs.existsSync(tmpDir)) {
    for (const f of fs.readdirSync(tmpDir).filter((n) => n.startsWith('radar-16h'))) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch (_) { /* ignore */ }
    }
  }
}

console.log('verify:radar-slice16h-staff-api-metric-alerts — RADAR Slice 16H (independent)\n');

const verifySrc = readText(VERIFY_REL);
const requireLines = verifySrc.split('\n').filter((l) => /require\s*\(/.test(l)).join('\n');
ok('I1 verifier does not require plan/preflight/implementation lib',
  !/radar-slice16[fgh]-staff-api-metric-alerts/.test(requireLines)
  && !/radar-slice16b/.test(requireLines));
ok('I2 verifier has no deployment wrapper / executor surface',
  !/function\s+buildDeploymentArgv\b/.test(verifySrc)
  && !/function\s+runSafeDeploymentEntry\b/.test(verifySrc)
  && !/function\s+runPreflight\b/.test(verifySrc)
  && /execFileSync/.test(requireLines)
  && !/\bspawnSync\b/.test(requireLines));

const expected = readJson(CONTRACT_REL);
ok('L1 frozen contract shape + master_basis cross-pin',
  typeof expected.schema_version === 'number'
  && typeof expected.slice === 'string'
  && expected.slice === 'RADAR-16H'
  && expected.master_basis === MASTER
  && expected.branch === 'radar/slice-16h-metric-alert-source-only'
  && expected.outcome_id === '16H_staff_api_metric_alerts'
  && Array.isArray(expected.resourceGroups)
  && expected.resourceGroups.length === 2
  && Array.isArray(expected.apps)
  && expected.apps.length === 2
  && expected.allowedResourceTypes.length === 1
  && expected.allowedResourceTypes[0] === 'Microsoft.Insights/metricAlerts'
  && expected.compiled
  && expected.compiled.resourceCount === 2
  && expected.hardLockContract
  && expected.hardLockContract.onlyAllowedParameter === 'containerAppName'
  && expected.template_enforces_arm_mode === false
  && expected.operator_incremental_deploy === 'open'
  && expected.deployment_wrapper === null
  && expected.execution_claim === false
  && !Object.prototype.hasOwnProperty.call(expected, 'deploymentArgvBuilder')
  && Array.isArray(expected.full_field_coverage)
  && expected.full_field_coverage.length >= 10);

const plan = readJson(PLAN_REL);
const planCmp = comparePlanToContract(plan, expected);
ok('L2 plan fixture matches frozen contract (all fields)', planCmp.ok, planCmp.errors.join('; '));
greenResults.push({ name: 'plan_vs_contract', expect: 'GREEN', ok: planCmp.ok, errors: planCmp.errors });
fieldCoverage.push(...planCmp.covered);

const planSec = secretFree(JSON.stringify(plan), 'plan');
ok('L3 plan secret-free', planSec.ok, planSec.detail);

const bicepText = readText(BICEP_REL);
ok('L5 bicep source hard-lock structural',
  /targetScope\s*=\s*'resourceGroup'/.test(bicepText)
  && /subscription\(\)\.subscriptionId/.test(bicepText)
  && /resourceGroup\(\)\.name/.test(bicepText)
  && /fail\('wrong_subscription'\)/.test(bicepText)
  && /fail\('wrong_resource_group'\)/.test(bicepText)
  && /fail\('wrong_container_app'\)/.test(bicepText)
  && /var\s+actionGroupName\s*=/.test(bicepText)
  && /var\s+tenantSlug\s*=/.test(bicepText)
  && /var\s+requests5xxThreshold\s*=\s*3/.test(bicepText)
  && /var\s+alertSeverity\s*=\s*2/.test(bicepText)
  && /var\s+windowSize\s*=\s*'PT5M'/.test(bicepText)
  && /var\s+alertsEnabled\s*=\s*true/.test(bicepText)
  && !/param\s+actionGroupName\s+/.test(bicepText)
  && !/param\s+tenantSlug\s+/.test(bicepText)
  && !/param\s+requests5xxThreshold\s+/.test(bicepText)
  && !/param\s+alertSeverity\s+/.test(bicepText)
  && !/param\s+windowSize\s+/.test(bicepText)
  && /Microsoft\.Insights\/metricAlerts@/.test(bicepText)
  && /existing\s*=/.test(bicepText)
  && /deploymentModeRequired\s+string\s*=\s*'Incremental'/.test(bicepText)
  && /cannot enforce ARM deployment mode/i.test(bicepText)
  && !/resource\s+\w+\s+'Microsoft\.Consumption\/budgets@/.test(bicepText)
  && !/resource\s+\w+\s+'Microsoft\.App\/containerApps@[^']+'\s*=\s*\{/.test(bicepText)
  && !/resource\s+\w+\s+'Microsoft\.Insights\/actionGroups@[^']+'\s*=\s*\{/.test(bicepText));

let compiled = null;
try {
  const built = buildBicep();
  compiled = built.compiled;
  ok('L6 bicep build succeeds', true);
} catch (err) {
  ok('L6 bicep build succeeds', false, String(err && err.stderr || err.message || err).slice(0, 400));
}

if (compiled) {
  const cCmp = compareCompiledToContract(compiled, expected);
  ok('L7 compiled vs frozen contract (hard-locks + metric/dimension/operator/threshold/window/severity/actions/scope)',
    cCmp.ok, cCmp.errors.join('; '));
  greenResults.push({ name: 'compiled_vs_contract', expect: 'GREEN', ok: cCmp.ok, errors: cCmp.errors });
  fieldCoverage.push(...cCmp.covered);
} else {
  ok('L7 compiled vs frozen contract', false, 'no compiled template');
}

for (const rel of MAIN_BICEP) {
  const textMain = readText(rel);
  ok(`L8 not wired into ${path.basename(path.dirname(rel))}/main.bicep`,
    !/staging-staff-api-metric-alerts|rg-staff-api-metric-alerts|staff-api-requests-5xx|staff-api-restart-count/.test(textMain));
}

const whParams = readJson(expected.apps[0].parametersExampleRel);
const sunParams = readJson(expected.apps[1].parametersExampleRel);
ok('L9 example params only containerAppName (thresholds not overridable)',
  Object.keys(whParams.parameters).length === 1
  && Object.keys(sunParams.parameters).length === 1
  && whParams.parameters.containerAppName.value === expected.apps[0].containerAppName
  && sunParams.parameters.containerAppName.value === expected.apps[1].containerAppName
  && !whParams.parameters.actionGroupName
  && !whParams.parameters.tenantSlug
  && !whParams.parameters.requests5xxThreshold
  && !whParams.parameters.alertSeverity
  && !whParams.parameters.windowSize
  && whParams.metadata.derivedActionGroupName === expected.apps[0].actionGroupName
  && sunParams.metadata.derivedActionGroupName === expected.apps[1].actionGroupName
  && whParams.metadata.derivedTenantSlug === expected.apps[0].tenantSlug
  && sunParams.metadata.derivedTenantSlug === expected.apps[1].tenantSlug
  && whParams.metadata.subscriptionId === expected.subscriptionId
  && sunParams.metadata.resourceGroup === expected.resourceGroups[1]
  && whParams.metadata.deploymentMode === expected.deploymentMode
  && whParams.metadata.deploymentModeEnforceableByTemplate === false
  && whParams.metadata.operatorIncrementalDeploy === 'open'
  && sunParams.metadata.liveDeploy === expected.liveDeployEnabled
  && whParams.metadata.notification_delivery_proof === 'open'
  && whParams.metadata.alert_fire_drill === 'open');

const planReds = runPlanRedMutations(plan, expected);
const compiledReds = compiled ? runCompiledRedMutations(compiled, expected) : [];
const adversarialReds = runAdversarialCompileReds(bicepText, expected);

redResults.push(...planReds, ...compiledReds, ...adversarialReds);

const requiredRedNames = [
  'wrong_scope_subscription',
  'wrong_scope_rg',
  'wrong_scope_app',
  'production_marker_rg',
  'wrong_action_group',
  'changed_metric',
  'changed_dimension',
  'changed_operator',
  'changed_threshold',
  'changed_window',
  'changed_severity',
  'extra_resource',
  'Complete_mode',
  'live_deploy_claim',
  'template_claims_arm_mode',
  'execution_claim_true',
  'missing_rg',
  'extra_rg',
  'compiled_extra_resource',
  'compiled_changed_metric',
  'compiled_changed_dimension',
  'compiled_changed_operator',
  'compiled_changed_threshold',
  'compiled_changed_window',
  'compiled_changed_severity',
  'compiled_wrong_action_group',
  'compiled_wrong_subscription_lock',
  'compiled_missing_action',
  'compiled_extra_action',
  'compiled_wrong_scope',
  'compiled_alert_disabled',
  'compiled_Complete_mode_output',
  'adversarial_wrong_subscription',
  'adversarial_wrong_rg_tuple',
  'adversarial_wrong_app_assert',
  'adversarial_wrong_action_group',
  'adversarial_wrong_threshold',
  'adversarial_wrong_severity',
  'adversarial_wrong_window',
];

ok('L12 RED suite size', redResults.length >= requiredRedNames.length,
  `got ${redResults.length}`);

for (const name of requiredRedNames) {
  const c = redResults.find((x) => x.name === name);
  ok(`L13 RED ${name}`, c && c.ok, c ? c.errors.join(',') : 'missing');
}

for (const c of redResults) {
  if (!requiredRedNames.includes(c.name)) {
    ok(`L13b RED ${c.name}`, c.ok, c.errors.join(','));
  }
}

const oneFieldReds = redResults.filter((c) => Object.prototype.hasOwnProperty.call(c, 'oneField'));
ok('L13c one-field proof on all plan/compiled RED controls',
  oneFieldReds.length > 0 && oneFieldReds.every((c) => c.oneField === true && c.ok === true),
  oneFieldReds.filter((c) => !c.oneField || !c.ok).map((c) => c.name).join(','));

ok('L14 GREEN plan+compiled',
  greenResults.length >= 2 && greenResults.every((g) => g.ok),
  greenResults.map((g) => `${g.name}:${g.ok}`).join(','));

const readme = readText('infra/azure/staging-staff-api-metric-alerts/README.md');
ok('L19 README source-only / Incremental open / cannot enforce ARM mode / AG derived',
  /source (module|partial)/i.test(readme)
  && /Incremental/i.test(readme)
  && /cannot enforce ARM mode/i.test(readme)
  && /operator.*open|remain.*open/i.test(readme)
  && /Derived|derived/i.test(readme)
  && /16B/.test(readme)
  && !/buildDeploymentArgv/.test(readme)
  && !/runSafeDeploymentEntry/.test(readme)
  && !/opaque capability/i.test(readme));

ok('L19b no deployment wrapper artifacts',
  !fs.existsSync(path.join(ROOT, 'scripts/lib/radar-slice16h-staff-api-metric-alerts.js'))
  && !fs.existsSync(path.join(ROOT, 'scripts/preflight-radar-slice16h-staff-api-metric-alerts.js'))
  && !fs.existsSync(path.join(ROOT, 'scripts/lib/radar-slice16f-staff-api-metric-alerts.js'))
  && !fs.existsSync(path.join(ROOT, 'scripts/lib/radar-slice16g-staff-api-metric-alerts.js')));

// 16I owns Staff API /readyz + staging Bicep probes; 16H still forbids DB/Hermes mutation
// and must not gain a deployment wrapper.
const runtimeDiff = execFileSync(
  'git',
  ['diff', '--name-only', MASTER, '--',
    'database/',
    'docker/hermes-staging/'],
  { cwd: ROOT, encoding: 'utf8' },
).trim();
ok('L20 zero DB/Hermes mutation vs master (16I may touch staff-api + staging bicep)', runtimeDiff === '', runtimeDiff);

const pkg = readJson('package.json');
ok('L21 npm script registered',
  pkg.scripts['verify:radar-slice16h-staff-api-metric-alerts']
  === 'node scripts/verify-radar-slice16h-staff-api-metric-alerts.js');

const owned = [
  BICEP_REL,
  'infra/azure/staging-staff-api-metric-alerts/README.md',
  PLAN_REL,
  CONTRACT_REL,
  VERIFY_REL,
  expected.apps[0].parametersExampleRel,
  expected.apps[1].parametersExampleRel,
];
let ownedSec = true;
for (const rel of owned) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    ok(`L22 owned exists ${rel}`, false);
    ownedSec = false;
    continue;
  }
  const sec = secretFree(readText(rel), rel);
  if (!sec.ok) {
    ok(`L22 secret-free ${rel}`, false, sec.detail);
    ownedSec = false;
  }
}
ok('L22 owned artifacts secret-free', ownedSec);

const coveredSet = new Set([...fieldCoverage, ...planCmp.covered]);
const stillMissing = expected.full_field_coverage.filter((f) => !coveredSet.has(f));
ok('L23 full field coverage from plan+compiled GREEN',
  stillMissing.length === 0,
  stillMissing.join(','));

const redPass = redResults.filter((r) => r.ok).length;
const greenPass = greenResults.filter((g) => g.ok).length;
console.log(`\nRED: ${redPass}/${redResults.length}  GREEN: ${greenPass}/${greenResults.length}`);
console.log(`Result: ${pass} passed, ${fail} failed`);

cleanupTmp();

if (fail > 0) process.exit(1);
console.log('RADAR 16H Staff API metric alerts (source-only): PASS');
