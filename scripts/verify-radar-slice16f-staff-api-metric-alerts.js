'use strict';

/**
 * verify:radar-slice16f-staff-api-metric-alerts — RADAR Slice 16F
 *
 * Independent offline gate. Does NOT import the plan/preflight implementation,
 * its LOCKS, or its RED generator. Compares compiled Bicep + plan fixture
 * against a separate frozen expected contract (contract owns truth values).
 * Independently compiles adversarial Bicep overrides proving wrong
 * subscription/RG/app/action-group/threshold/severity/window cannot produce a
 * valid deployment template. Proves Complete cannot be built by the argv
 * wrapper via a child-process probe (no require of the lib in this file).
 *
 * No network, no Azure mutation, no real secrets.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MASTER = 'acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b';

const CONTRACT_REL = 'fixtures/radar-operations/slice16f-expected-contract.json';
const PLAN_REL = 'fixtures/radar-operations/slice16f-metric-alert-plan.json';
const BICEP_REL = 'infra/azure/staging-staff-api-metric-alerts/rg-staff-api-metric-alerts.bicep';
const PREFLIGHT_REL = 'scripts/preflight-radar-slice16f-staff-api-metric-alerts.js';
const LIB_REL = 'scripts/lib/radar-slice16f-staff-api-metric-alerts.js';
const VERIFY_REL = 'scripts/verify-radar-slice16f-staff-api-metric-alerts.js';

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
  const out = path.join(ROOT, 'tmp', 'radar-16f-rg-staff-api-metric-alerts.json');
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
    covered.push('resourceTypesAllowed');
    covered.push('allowedResourceTypes');
  }

  const planRgs = (plan.apps || []).map((a) => a.resourceGroup);
  if (!arraysEqual(planRgs, expected.resourceGroups)) {
    errors.push(`resourceGroups: got ${JSON.stringify(planRgs)} want ${JSON.stringify(expected.resourceGroups)}`);
  } else {
    covered.push('resourceGroups');
  }

  if (!Array.isArray(plan.apps) || plan.apps.length !== expected.apps.length) {
    errors.push(`apps length: got ${(plan.apps || []).length} want ${expected.apps.length}`);
  } else {
    for (let i = 0; i < expected.apps.length; i += 1) {
      const want = expected.apps[i];
      const got = plan.apps[i];
      eq(`apps[${i}].resourceGroup`, got.resourceGroup, want.resourceGroup);
      eq(`apps[${i}].containerAppName`, got.containerAppName, want.containerAppName);
      eq(`apps[${i}].tenantSlug`, got.tenantSlug, want.tenantSlug);
      eq(`apps[${i}].actionGroupName`, got.actionGroupName, want.actionGroupName);
      eq(`apps[${i}].parametersExampleRel`, got.parametersExampleRel, want.parametersExampleRel);
      covered.push('containerAppName');
      covered.push('actionGroupName');
      covered.push('tenantSlug');

      if (!Array.isArray(got.alerts) || got.alerts.length !== want.alerts.length) {
        errors.push(`apps[${i}].alerts length`);
        continue;
      }
      for (let j = 0; j < want.alerts.length; j += 1) {
        const wa = want.alerts[j];
        const ga = got.alerts[j];
        eq(`apps[${i}].alerts[${j}].name`, ga.name, wa.name);
        eq(`apps[${i}].alerts[${j}].metricName`, ga.metricName, wa.metricName);
        eq(`apps[${i}].alerts[${j}].operator`, ga.operator, wa.operator);
        eq(`apps[${i}].alerts[${j}].threshold`, ga.threshold, wa.threshold);
        eq(`apps[${i}].alerts[${j}].enabled`, ga.enabled, true);
        eq(`apps[${i}].alerts[${j}].dimensionName`, ga.dimensionName, wa.dimensionName);
        if (!arraysEqual(ga.dimensionValues || [], wa.dimensionValues || [])) {
          errors.push(`apps[${i}].alerts[${j}].dimensionValues`);
        } else {
          covered.push(`apps[${i}].alerts[${j}].dimensionValues`);
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
    if (reqCrit.metricName !== expr.requests5xxThreshold.replace('requests5xxThreshold', 'requestsMetricName')
      && reqCrit.metricName !== "[variables('requestsMetricName')]"
      && reqCrit.metricName !== 'Requests') {
      // accept var ref
      if (reqCrit.metricName !== "[variables('requestsMetricName')]") {
        errors.push('requests_metric');
      } else {
        covered.push('metricName_requests');
      }
    } else {
      covered.push('metricName_requests');
    }
    if (reqCrit.metricName === "[variables('requestsMetricName')]" || reqCrit.metricName === 'Requests') {
      if (!covered.includes('metricName_requests')) covered.push('metricName_requests');
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
      mutate(t) {
        t.variables.requestsMetricName = 'Replicas';
      },
    },
    {
      name: 'compiled_changed_dimension',
      intendedPaths: ['variables.statusCodeCategoryValue'],
      mutate(t) {
        t.variables.statusCodeCategoryValue = '4xx';
      },
    },
    {
      name: 'compiled_changed_operator',
      intendedPaths: ['variables.requests5xxOperator'],
      mutate(t) {
        t.variables.requests5xxOperator = 'GreaterThan';
      },
    },
    {
      name: 'compiled_changed_threshold',
      intendedPaths: ['variables.requests5xxThreshold'],
      mutate(t) {
        t.variables.requests5xxThreshold = 99;
      },
    },
    {
      name: 'compiled_changed_window',
      intendedPaths: ['variables.windowSize'],
      mutate(t) {
        t.variables.windowSize = 'PT15M';
      },
    },
    {
      name: 'compiled_changed_severity',
      intendedPaths: ['variables.alertSeverity'],
      mutate(t) {
        t.variables.alertSeverity = 0;
      },
    },
    {
      name: 'compiled_wrong_action_group',
      intendedPaths: ['variables.actionGroupName'],
      mutate(t) {
        t.variables.actionGroupName = 'evil-ops-ag';
      },
    },
    {
      name: 'compiled_wrong_subscription_lock',
      intendedPaths: ['variables.lockedSubscriptionId'],
      mutate(t) {
        t.variables.lockedSubscriptionId = '00000000-0000-0000-0000-000000000000';
      },
    },
    {
      name: 'compiled_missing_action',
      intendedPaths: ['resources.0.properties.actions.0'],
      mutate(t) {
        const a = t.resources[0];
        a.properties.actions = [];
      },
    },
    {
      name: 'compiled_extra_action',
      intendedPaths: ['resources.0.properties.actions.1'],
      mutate(t) {
        t.resources[0].properties.actions.push({ actionGroupId: 'extra' });
      },
    },
    {
      name: 'compiled_wrong_scope',
      intendedPaths: ['resources.0.properties.scopes.0'],
      mutate(t) {
        t.resources[0].properties.scopes = ['wrong-scope'];
      },
    },
    {
      name: 'compiled_alert_disabled',
      intendedPaths: ['variables.alertsEnabled'],
      mutate(t) {
        t.variables.alertsEnabled = false;
      },
    },
    {
      name: 'compiled_Complete_mode_output',
      intendedPaths: ['outputs.deploymentModeRequired.value'],
      mutate(t) {
        t.outputs.deploymentModeRequired.value = 'Complete';
      },
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

/**
 * Independently compile adversarial Bicep source overrides and prove each
 * fails the frozen contract (cannot produce a valid deployment template).
 */
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
      // keep expected app but change fail message path by swapping expected for wrong literal in assert path via expectedContainerAppName first branch already covered; instead force wrong AG derivation
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
    const bicepPath = path.join(tmpDir, `radar-16f-adv-${c.name}.bicep`);
    const outPath = path.join(tmpDir, `radar-16f-adv-${c.name}.json`);
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
      // compile failure also proves not a valid deployment
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

function probeArgvScript(scriptBody) {
  const script = `
    const m = require(${JSON.stringify(path.join(ROOT, LIB_REL))});
    ${scriptBody}
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    return { probeFailed: true, status: result.status, stderr: result.stderr, stdout: result.stdout };
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    return { probeFailed: true, parseError: String(err), stdout: result.stdout };
  }
}

function probeArgvBuilderFromPreflight(rg, mutateInput) {
  const mutate = typeof mutateInput === 'function'
    ? mutateInput.toString()
    : `function (input) { return Object.assign({}, input, ${JSON.stringify(mutateInput || {})}); }`;
  return probeArgvScript(`
    const pf = m.runPreflight({ resourceGroup: ${JSON.stringify(rg)} });
    let r;
    if (!pf.ok || !pf.capability) {
      r = {
        ok: false,
        errors: pf.errors || ['preflight_failed'],
        argv: null,
        executor: null,
        liveCall: false,
        mode: null,
        preflightOkFlag: pf.ok
      };
    } else {
      const mutate = ${mutate};
      const input = mutate({ capability: pf.capability });
      r = m.buildDeploymentArgv(input);
    }
    process.stdout.write(JSON.stringify({
      ok: r.ok,
      errors: r.errors,
      argv: r.argv,
      executor: r.executor,
      liveCall: r.liveCall,
      mode: r.mode,
      resourceGroup: r.resourceGroup,
      containerAppName: r.containerAppName,
      templateFile: r.templateFile,
      templateHash: r.templateHash
    }));
  `);
}

function probeArgvDirect(inputLiteral) {
  return probeArgvScript(`
    const input = ${inputLiteral};
    const r = m.buildDeploymentArgv(input);
    process.stdout.write(JSON.stringify({
      ok: r.ok,
      errors: r.errors,
      argv: r.argv,
      executor: r.executor,
      liveCall: r.liveCall,
      mode: r.mode
    }));
  `);
}

function runArgvWrapperReds() {
  const cases = [
    {
      name: 'wrapper_Complete_unbuildable',
      run: () => probeArgvBuilderFromPreflight('wh-staging-rg', { mode: 'Complete' }),
      expectError: 'complete_mode_rejected',
    },
    {
      name: 'wrapper_wrong_subscription',
      run: () => probeArgvBuilderFromPreflight('wh-staging-rg', {
        subscriptionId: '00000000-0000-0000-0000-000000000000',
      }),
      expectError: 'capability_binding_mismatch',
    },
    {
      name: 'wrapper_wrong_rg',
      run: () => probeArgvBuilderFromPreflight('wh-staging-rg', {
        resourceGroup: 'luna-sunset-staging-rg',
      }),
      expectError: 'capability_binding_mismatch',
    },
    {
      name: 'wrapper_wrong_app',
      run: () => probeArgvBuilderFromPreflight('wh-staging-rg', {
        containerAppName: 'wrong-app',
      }),
      expectError: 'capability_binding_mismatch',
    },
    {
      name: 'wrapper_extra_args',
      run: () => probeArgvBuilderFromPreflight('wh-staging-rg', { extraArgs: ['--what-if'] }),
      expectError: 'extra_args_rejected',
    },
    {
      name: 'wrapper_preflight_required',
      run: () => probeArgvDirect(`{ resourceGroup: 'wh-staging-rg' }`),
      expectError: 'preflight_required',
    },
    {
      name: 'wrapper_forged_ok_object',
      run: () => probeArgvDirect(`{ capability: { ok: true } }`),
      expectError: 'invalid_capability',
    },
    {
      name: 'wrapper_forged_preflight_result',
      run: () => probeArgvDirect(`{ capability: { ok: true, resourceGroup: 'wh-staging-rg', errors: [] } }`),
      expectError: 'invalid_capability',
    },
    {
      name: 'wrapper_legacy_bool_auth_rejected',
      run: () => probeArgvDirect(`{ resourceGroup: 'wh-staging-rg', ['preflight'+'Ok']: true }`),
      expectError: 'unknown_builder_key',
    },
    {
      name: 'wrapper_unknown_builder_key',
      run: () => probeArgvBuilderFromPreflight('wh-staging-rg', { forgedFlag: true }),
      expectError: 'unknown_builder_key',
    },
    {
      name: 'wrapper_clone_capability',
      run: () => probeArgvScript(`
        const pf = m.runPreflight({ resourceGroup: 'wh-staging-rg' });
        const r = m.buildDeploymentArgv({ capability: { ...pf.capability } });
        process.stdout.write(JSON.stringify({
          ok: r.ok, errors: r.errors, argv: r.argv, executor: r.executor, liveCall: r.liveCall, mode: r.mode
        }));
      `),
      expectError: 'invalid_capability',
    },
    {
      name: 'wrapper_json_roundtrip_capability',
      run: () => probeArgvScript(`
        const pf = m.runPreflight({ resourceGroup: 'wh-staging-rg' });
        const r = m.buildDeploymentArgv({
          capability: JSON.parse(JSON.stringify(pf.capability))
        });
        process.stdout.write(JSON.stringify({
          ok: r.ok, errors: r.errors, argv: r.argv, executor: r.executor, liveCall: r.liveCall, mode: r.mode
        }));
      `),
      expectError: 'invalid_capability',
    },
    {
      name: 'wrapper_replay_consumed',
      run: () => probeArgvScript(`
        const pf = m.runPreflight({ resourceGroup: 'wh-staging-rg' });
        const first = m.buildDeploymentArgv({ capability: pf.capability });
        const r = m.buildDeploymentArgv({ capability: pf.capability });
        process.stdout.write(JSON.stringify({
          ok: r.ok,
          errors: r.errors,
          argv: r.argv,
          executor: r.executor,
          liveCall: r.liveCall,
          mode: r.mode,
          firstOk: first.ok
        }));
      `),
      expectError: 'capability_consumed',
    },
    {
      name: 'wrapper_cross_rg_reuse',
      run: () => probeArgvBuilderFromPreflight('wh-staging-rg', {
        resourceGroup: 'luna-sunset-staging-rg',
      }),
      expectError: 'capability_binding_mismatch',
    },
    {
      name: 'wrapper_cross_app_reuse',
      run: () => probeArgvBuilderFromPreflight('wh-staging-rg', {
        containerAppName: 'luna-sunset-staging-staff-api',
      }),
      expectError: 'capability_binding_mismatch',
    },
    {
      name: 'wrapper_altered_template_hash',
      run: () => probeArgvBuilderFromPreflight('wh-staging-rg', {
        templateHash: '0'.repeat(64),
      }),
      expectError: 'capability_binding_mismatch',
    },
  ];

  const results = [];
  for (const c of cases) {
    const r = c.run();
    const okRed = !r.probeFailed
      && r.ok === false
      && Array.isArray(r.errors)
      && r.errors.includes(c.expectError)
      && r.argv === null
      && r.executor === null
      && r.liveCall === false;
    results.push({
      name: c.name,
      expect: 'RED',
      ok: okRed,
      errors: okRed ? [] : [JSON.stringify(r).slice(0, 400)],
    });
  }
  return results;
}

function runArgvWrapperGreens(expected) {
  const results = [];
  for (const rg of expected.resourceGroups) {
    const r = probeArgvScript(`
      const pf = m.runPreflight({ resourceGroup: ${JSON.stringify(rg)} });
      const r = pf.ok
        ? m.buildDeploymentArgv({ capability: pf.capability })
        : { ok: false, errors: pf.errors || ['preflight_failed'], argv: null, executor: null, liveCall: false, mode: null };
      process.stdout.write(JSON.stringify({
        preflightOk: pf.ok === true,
        ok: r.ok,
        errors: r.errors,
        argv: r.argv,
        executor: r.executor,
        liveCall: r.liveCall,
        mode: r.mode,
        resourceGroup: r.resourceGroup,
        containerAppName: r.containerAppName,
        templateFile: r.templateFile,
        templateHash: r.templateHash
      }));
    `);
    const app = expected.apps.find((a) => a.resourceGroup === rg);
    const okGreen = !r.probeFailed
      && r.preflightOk === true
      && r.ok === true
      && r.executor === null
      && r.liveCall === false
      && r.mode === 'Incremental'
      && r.resourceGroup === rg
      && r.containerAppName === app.containerAppName
      && r.templateFile === expected.bicepModuleRel
      && typeof r.templateHash === 'string'
      && r.templateHash.length === 64
      && Array.isArray(r.argv)
      && r.argv[0] === 'deployment'
      && r.argv.includes('--subscription')
      && r.argv.includes(expected.subscriptionId)
      && r.argv.includes('--resource-group')
      && r.argv.includes(rg)
      && r.argv.includes('--template-file')
      && r.argv.includes(expected.bicepModuleRel)
      && r.argv.includes('--mode')
      && r.argv.includes('Incremental')
      && !r.argv.includes('Complete')
      && r.argv.includes(`containerAppName=${app.containerAppName}`);
    results.push({
      name: `wrapper_green_${rg}`,
      expect: 'GREEN',
      ok: okGreen,
      errors: okGreen ? [] : [JSON.stringify(r).slice(0, 400)],
    });
  }
  return results;
}

function spawnPreflight(argvExtra, envExtra) {
  const env = {
    ...bicepEnv(),
    ...envExtra,
  };
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, PREFLIGHT_REL), ...argvExtra],
    { cwd: ROOT, env, encoding: 'utf8' },
  );
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  let report = null;
  for (const chunk of [result.stderr || '', result.stdout || '']) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const candidates = [trimmed, ...trimmed.split(/\r?\n/).map((l) => l.trim())];
    for (const t of candidates) {
      if (!t.startsWith('{') || !t.includes('azureCalls')) continue;
      try {
        report = JSON.parse(t);
        break;
      } catch (_) { /* ignore */ }
    }
    if (report) break;
  }
  let azureCalls = report && typeof report.azureCalls === 'number' ? report.azureCalls : null;
  if (azureCalls == null) {
    const m = combined.match(/"azureCalls"\s*:\s*(\d+)/);
    if (m) azureCalls = Number(m[1]);
  }
  return {
    status: result.status,
    combined,
    report,
    azureCalls,
  };
}

function runCliRedCases() {
  const cases = [
    { name: 'cli_live', argv: ['--live', '--resource-group', 'wh-staging-rg'], reason: 'forbidden_flag' },
    { name: 'cli_deploy', argv: ['--deploy', '--resource-group', 'wh-staging-rg'], reason: 'forbidden_flag' },
    { name: 'cli_apply', argv: ['--apply', '--resource-group', 'wh-staging-rg'], reason: 'forbidden_flag' },
    { name: 'cli_what_if', argv: ['--what-if', '--resource-group', 'wh-staging-rg'], reason: 'forbidden_flag' },
    { name: 'cli_unknown_arg', argv: ['--resource-group', 'wh-staging-rg', '--explode'], reason: 'unknown_cli_arg' },
    { name: 'cli_positional', argv: ['--resource-group', 'wh-staging-rg', 'positional-junk'], reason: 'unknown_positional_arg' },
    { name: 'cli_production_marker', argv: ['--resource-group', 'wh-prod-rg'], reason: 'scope_short_circuit' },
    { name: 'cli_Complete_mode', argv: ['--resource-group', 'wh-staging-rg', '--mode', 'Complete'], reason: 'deployment_mode' },
    { name: 'cli_wrong_scope', argv: ['--resource-group', 'totally-other-rg'], reason: 'scope_short_circuit' },
  ];

  const results = [];
  for (const c of cases) {
    const r = spawnPreflight(c.argv);
    const refused = r.status !== 0
      && r.azureCalls === 0
      && r.report
      && r.report.refused === true
      && (r.report.reason === c.reason || (r.combined || '').includes(c.reason));
    results.push({
      name: c.name,
      expect: 'RED',
      ok: refused,
      errors: refused ? [] : [
        `status=${r.status}`,
        `azureCalls=${r.azureCalls}`,
        `reason=${r.report && r.report.reason}`,
        (r.combined || '').slice(0, 200),
      ],
      azureCalls: r.azureCalls,
    });
  }
  return results;
}

function runCliGreenCases(expected) {
  const results = [];
  for (const rg of expected.resourceGroups) {
    const r = spawnPreflight(['--resource-group', rg]);
    const good = r.status === 0 && r.azureCalls === 0 && /PASS \(no live calls\)/.test(r.combined);
    results.push({
      name: `cli_green_${rg}`,
      expect: 'GREEN',
      ok: good,
      errors: good ? [] : [`status=${r.status}`, `azureCalls=${r.azureCalls}`, (r.combined || '').slice(0, 200)],
      azureCalls: r.azureCalls,
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
    for (const f of fs.readdirSync(tmpDir).filter((n) => n.startsWith('radar-16f'))) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch (_) { /* ignore */ }
    }
  }
}

console.log('verify:radar-slice16f-staff-api-metric-alerts — RADAR Slice 16F (independent)\n');

const verifySrc = readText(VERIFY_REL);
const requireLines = verifySrc.split('\n').filter((l) => /require\s*\(/.test(l)).join('\n');
ok('I1 verifier does not require plan/preflight lib',
  !/radar-slice16f-staff-api-metric-alerts/.test(requireLines));
ok('I2 verifier does not call lib RED/plan builders',
  !/\brunRedCases\b/.test(verifySrc)
  && !/\brunGreenCases\b/.test(verifySrc)
  && !/\bbuildSecretFreePlan\b/.test(verifySrc)
  && !/\bevaluateDeployRequest\b/.test(verifySrc));

ok('I2b verifier GREEN/RED argv probes call real runPreflight then builder (child process)',
  /m\.runPreflight/.test(verifySrc)
  && /m\.buildDeploymentArgv/.test(verifySrc)
  && /invalid_capability/.test(verifySrc)
  && /capability_consumed/.test(verifySrc)
  && /capability_binding_mismatch/.test(verifySrc)
  && /unknown_builder_key/.test(verifySrc)
  && /wrapper_legacy_bool_auth_rejected/.test(verifySrc)
  && /wrapper_clone_capability/.test(verifySrc)
  && /wrapper_json_roundtrip_capability/.test(verifySrc));

const expected = readJson(CONTRACT_REL);
ok('L1 frozen contract shape + master_basis cross-pin',
  typeof expected.schema_version === 'number'
  && typeof expected.slice === 'string'
  && expected.master_basis === MASTER
  && expected.branch === 'radar/slice-16f-staff-api-metric-alerts'
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
  && expected.deploymentArgvBuilder
  && expected.deploymentArgvBuilder.completeModeBuildable === false
  && expected.deploymentArgvBuilder.executor === null
  && expected.deploymentArgvBuilder.capabilityModel === 'opaque_object_identity'
  && expected.deploymentArgvBuilder.oneShot === true
  && expected.deploymentArgvBuilder.acceptsPreflightOk === false
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
  && !/resource\s+\w+\s+'Microsoft\.Consumption\/budgets@/.test(bicepText)
  && !/resource\s+\w+\s+'Microsoft\.App\/containerApps@[^']+'\s*=\s*\{/.test(bicepText)
  && !/resource\s+\w+\s+'Microsoft\.Insights\/actionGroups@[^']+'\s*=\s*\{/.test(bicepText));

let compiled = null;
let outPath = null;
try {
  const built = buildBicep();
  compiled = built.compiled;
  outPath = built.outPath;
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
  const text = readText(rel);
  ok(`L8 not wired into ${path.basename(path.dirname(rel))}/main.bicep`,
    !/staging-staff-api-metric-alerts|rg-staff-api-metric-alerts|staff-api-requests-5xx|staff-api-restart-count/.test(text));
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
  && sunParams.metadata.liveDeploy === expected.liveDeployEnabled
  && whParams.metadata.notification_delivery_proof === 'open'
  && whParams.metadata.alert_fire_drill === 'open');

const planReds = runPlanRedMutations(plan, expected);
const compiledReds = compiled ? runCompiledRedMutations(compiled, expected) : [];
const adversarialReds = runAdversarialCompileReds(bicepText, expected);
const argvReds = runArgvWrapperReds();
const argvGreens = runArgvWrapperGreens(expected);
const cliReds = runCliRedCases();
const cliGreens = runCliGreenCases(expected);

redResults.push(...planReds, ...compiledReds, ...adversarialReds, ...argvReds, ...cliReds);
greenResults.push(...cliGreens, ...argvGreens);

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
  'adversarial_wrong_subscription',
  'adversarial_wrong_rg_tuple',
  'adversarial_wrong_app_assert',
  'adversarial_wrong_action_group',
  'adversarial_wrong_threshold',
  'adversarial_wrong_severity',
  'adversarial_wrong_window',
  'wrapper_Complete_unbuildable',
  'wrapper_wrong_subscription',
  'wrapper_wrong_rg',
  'wrapper_wrong_app',
  'wrapper_extra_args',
  'wrapper_preflight_required',
  'wrapper_forged_ok_object',
  'wrapper_forged_preflight_result',
  'wrapper_legacy_bool_auth_rejected',
  'wrapper_unknown_builder_key',
  'wrapper_clone_capability',
  'wrapper_json_roundtrip_capability',
  'wrapper_replay_consumed',
  'wrapper_cross_rg_reuse',
  'wrapper_cross_app_reuse',
  'wrapper_altered_template_hash',
  'cli_live',
  'cli_deploy',
  'cli_apply',
  'cli_what_if',
  'cli_unknown_arg',
  'cli_positional',
  'cli_production_marker',
  'cli_Complete_mode',
  'cli_wrong_scope',
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

ok('L14 GREEN plan+compiled+cli+wrapper',
  greenResults.length >= 6 && greenResults.every((g) => g.ok),
  greenResults.map((g) => `${g.name}:${g.ok}`).join(','));

const liveRed = redResults.find((x) => x.name === 'cli_live');
ok('L15 --live refused with azureCalls=0',
  liveRed && liveRed.ok && liveRed.azureCalls === 0,
  liveRed ? `azureCalls=${liveRed.azureCalls}` : 'missing');

for (const flagCase of ['cli_deploy', 'cli_apply', 'cli_what_if', 'cli_unknown_arg', 'cli_positional']) {
  const c = redResults.find((x) => x.name === flagCase);
  ok(`L16 ${flagCase} azureCalls=0`, c && c.azureCalls === 0, c ? `azureCalls=${c.azureCalls}` : 'missing');
}

const preflightSrc = readText(PREFLIGHT_REL);
ok('L17 preflight has no Azure dispatch',
  !/management\.azure\.com/.test(preflightSrc)
  && !/deployment group/.test(preflightSrc)
  && !/account show/.test(preflightSrc)
  && !/\bexecFileSync\b|\bexecSync\b|\bspawnSync\b/.test(preflightSrc));

ok('L18 preflight fail-closed markers',
  /forbidden_flag/.test(preflightSrc)
  && /unknown_cli_arg/.test(preflightSrc)
  && /unknown_positional_arg/.test(preflightSrc)
  && /--live/.test(preflightSrc)
  && /azureCalls/.test(preflightSrc));

const libSrc = readText(LIB_REL);
ok('L18b argv builder capability contract (opaque, shell-free, no executor)',
  /function runPreflight/.test(libSrc)
  && /function buildDeploymentArgv/.test(libSrc)
  && /WeakSet/.test(libSrc)
  && /WeakMap/.test(libSrc)
  && /CAPABILITY_BRAND/.test(libSrc)
  && /invalid_capability/.test(libSrc)
  && /capability_consumed/.test(libSrc)
  && /capability_binding_mismatch/.test(libSrc)
  && /unknown_builder_key/.test(libSrc)
  && /complete_mode_rejected/.test(libSrc)
  && /extra_args_rejected/.test(libSrc)
  && /preflight_required/.test(libSrc)
  && /executor:\s*null/.test(libSrc)
  && /liveCall:\s*false/.test(libSrc)
  && !/'preflightOk'/.test(libSrc)
  && !/'preflightResult'/.test(libSrc)
  && !/execFileSync|execSync|spawnSync|child_process/.test(libSrc));

const readme = readText('infra/azure/staging-staff-api-metric-alerts/README.md');
ok('L19 README hard-lock / Incremental / no live deploy / AG derived / opaque capability argv',
  /fail closed/i.test(readme)
  && /Incremental/i.test(readme)
  && /disabled/i.test(readme)
  && /Derived/i.test(readme)
  && /buildDeploymentArgv/.test(readme)
  && /runPreflight|opaque capability/i.test(readme)
  && /16B/.test(readme));

const runtimeDiff = execFileSync(
  'git',
  ['diff', '--name-only', MASTER, '--',
    'scripts/staff-query-api.js', 'database/',
    'infra/azure/staging/main.bicep', 'infra/azure/sunset-staging/main.bicep',
    'docker/hermes-staging/'],
  { cwd: ROOT, encoding: 'utf8' },
).trim();
ok('L20 zero runtime mutation vs master', runtimeDiff === '', runtimeDiff);

const pkg = readJson('package.json');
ok('L21 npm script registered',
  pkg.scripts['verify:radar-slice16f-staff-api-metric-alerts']
  === 'node scripts/verify-radar-slice16f-staff-api-metric-alerts.js');

const owned = [
  BICEP_REL,
  'infra/azure/staging-staff-api-metric-alerts/README.md',
  PLAN_REL,
  CONTRACT_REL,
  LIB_REL,
  VERIFY_REL,
  PREFLIGHT_REL,
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
  const text = readText(rel);
  const sec = secretFree(text, rel);
  if (!sec.ok) {
    ok(`L22 secret-free ${rel}`, false, sec.detail);
    ownedSec = false;
  }
}
ok('L22 owned artifacts secret-free', ownedSec);

cleanupTmp();
ok('L23 generated tmp removed',
  !fs.existsSync(path.join(ROOT, 'tmp', 'radar-16f-rg-staff-api-metric-alerts.json'))
  && !(fs.existsSync(path.join(ROOT, 'tmp'))
    && fs.readdirSync(path.join(ROOT, 'tmp')).some((f) => f.startsWith('radar-16f'))));

const requiredCoverage = expected.full_field_coverage;
const coverageSet = new Set(fieldCoverage);
const coverageMissing = requiredCoverage.filter((f) => {
  const aliases = {
    schema_version: ['schema_version'],
    slice: ['slice'],
    master_basis: ['master_basis'],
    branch: ['branch'],
    resourceGroups: ['resourceGroups'],
    containerAppName: ['containerAppName', 'apps[0].containerAppName'],
    actionGroupName: ['actionGroupName', 'apps[0].actionGroupName'],
    tenantSlug: ['tenantSlug', 'apps[0].tenantSlug'],
    metricNamespace: ['metricNamespace'],
    metricName_requests: ['metricName_requests'],
    metricName_restart: ['metricName_restart'],
    dimension_statusCodeCategory: ['dimension_statusCodeCategory'],
    operator_requests: ['operator_requests'],
    operator_restart: ['operator_restart'],
    threshold_requests: ['threshold_requests'],
    threshold_restart: ['threshold_restart'],
    windowSize: ['windowSize'],
    evaluationFrequency: ['evaluationFrequency'],
    severity: ['severity'],
    enabled: ['enabled'],
    actions_actionGroupId: ['actions_actionGroupId'],
    scopes: ['scopes'],
    deploymentMode: ['deploymentMode'],
    allowedResourceTypes: ['allowedResourceTypes', 'resourceTypesAllowed'],
    hard_lock_subscription_assert: ['hard_lock_subscription_assert'],
    hard_lock_rg_app_tuple: ['hard_lock_rg_app_tuple'],
    derived_action_group: ['derived_action_group'],
    only_allowed_parameter: ['only_allowed_parameter'],
  };
  const al = aliases[f] || [f];
  return !al.some((a) => coverageSet.has(a) || [...coverageSet].some((c) => c.includes(a) || a.includes(c)));
});
ok('L24 full-field coverage complete',
  coverageMissing.length === 0,
  coverageMissing.join(','));

const redPass = redResults.filter((c) => c.ok).length;
const greenPass = greenResults.filter((g) => g.ok).length;

console.log(`\nResult: ${pass} passed, ${fail} failed`);
console.log(`Independent RED ${redPass}/${redResults.length} GREEN ${greenPass}/${greenResults.length}`);
console.log(`Full-field coverage: ${requiredCoverage.length - coverageMissing.length}/${requiredCoverage.length}`);
if (fail > 0) process.exit(1);
console.log('RADAR 16F staff API metric alerts: PASS');
console.log(`RED ${redPass}/${redResults.length} GREEN ${greenPass}/${greenResults.length}`);
