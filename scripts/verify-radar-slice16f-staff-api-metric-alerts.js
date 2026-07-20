'use strict';

/**
 * verify:radar-slice16f-staff-api-metric-alerts — RADAR Slice 16F
 *
 * Independent offline gate. Does NOT import the plan/preflight implementation,
 * its LOCKS, or its RED generator. Compares compiled Bicep + plan fixture
 * against a separate frozen expected contract (contract owns truth values).
 * Owns one-field RED mutations and proves each valid control differs only at
 * the intended field. CLI fail-closed proofs include --live → azureCalls=0.
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

function buildBicep() {
  const bicep = path.join(ROOT, BICEP_REL);
  const out = path.join(ROOT, 'tmp', 'radar-16f-rg-staff-api-metric-alerts.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const env = {
    ...process.env,
    PATH: `/opt/data/.local/bin:${process.env.PATH || ''}`,
    AZURE_CONFIG_DIR: process.env.AZURE_CONFIG_DIR || '/opt/data/.azure',
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
  };
  execFileSync('az', ['bicep', 'build', '--file', bicep, '--outfile', out], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { compiled: JSON.parse(fs.readFileSync(out, 'utf8')), outPath: out };
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
    return Array.isArray(allOf) && allOf[0] && allOf[0].metricName === metricName;
  });
}

function compareCompiledToContract(compiled, expected) {
  const errors = [];
  const covered = [];
  const expr = expected.compiled.expressions;
  const vars = expected.compiled.variables;
  const defaults = expected.compiled.paramDefaults;
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
  for (const [k, v] of Object.entries(defaults)) {
    if (!params[k] || params[k].defaultValue !== v) {
      errors.push(`param_default_mismatch:${k}`);
    } else {
      covered.push(`param_default_${k}`);
    }
  }

  const compiledVars = (compiled && compiled.variables) || {};
  for (const [k, v] of Object.entries(vars)) {
    if (compiledVars[k] !== v) errors.push(`variable_mismatch:${k}`);
    else covered.push(`variable_${k}`);
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

  const requests = findAlertByMetric(resources, 'Requests');
  const restarts = findAlertByMetric(resources, 'RestartCount');
  if (!requests) errors.push('missing_requests_alert');
  if (!restarts) errors.push('missing_restart_alert');

  function checkCommon(alert, label) {
    if (!alert) return;
    if (alert.location !== 'global') errors.push(`${label}_location`);
    if (!alert.properties || alert.properties.enabled !== true) errors.push(`${label}_not_enabled`);
    else covered.push('enabled');
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
    if (reqCrit.metricName !== 'Requests') errors.push('requests_metric');
    else covered.push('metricName_requests');
    if (reqCrit.metricNamespace !== expected.metricNamespace) errors.push('requests_namespace');
    else covered.push('metricNamespace');
    if (reqCrit.operator !== 'GreaterThanOrEqual') errors.push('requests_operator');
    else covered.push('operator_requests');
    if (reqCrit.threshold !== expr.requests5xxThreshold) errors.push('requests_threshold_expression');
    else covered.push('threshold_requests');
    if (reqCrit.timeAggregation !== expected.timeAggregation) errors.push('requests_aggregation');
    const dims = reqCrit.dimensions || [];
    if (dims.length !== 1
      || dims[0].name !== 'statusCodeCategory'
      || dims[0].operator !== 'Include'
      || !arraysEqual(dims[0].values, ['5xx'])) {
      errors.push('requests_dimension');
    } else {
      covered.push('dimension_statusCodeCategory');
    }
  }

  const rstCrit = checkCommon(restarts, 'restarts');
  if (rstCrit) {
    if (rstCrit.metricName !== 'RestartCount') errors.push('restarts_metric');
    else covered.push('metricName_restart');
    if (rstCrit.metricNamespace !== expected.metricNamespace) errors.push('restarts_namespace');
    if (rstCrit.operator !== 'GreaterThan') errors.push('restarts_operator');
    else covered.push('operator_restart');
    if (rstCrit.threshold !== expr.restartCountThreshold) errors.push('restarts_threshold_expression');
    else covered.push('threshold_restart');
    if (rstCrit.timeAggregation !== expected.timeAggregation) errors.push('restarts_aggregation');
    if (rstCrit.dimensions && rstCrit.dimensions.length) errors.push('restarts_unexpected_dimensions');
  }

  // Ensure no created AG/budget/app resources slipped in.
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
      intendedPaths: ['resources.0.properties.criteria.allOf.0.metricName'],
      mutate(t) {
        const a = findAlertByMetric(t.resources, 'Requests');
        a.properties.criteria.allOf[0].metricName = 'Replicas';
      },
    },
    {
      name: 'compiled_changed_dimension',
      intendedPaths: ['resources.0.properties.criteria.allOf.0.dimensions.0.values.0'],
      mutate(t) {
        const a = findAlertByMetric(t.resources, 'Requests');
        a.properties.criteria.allOf[0].dimensions[0].values[0] = '4xx';
      },
    },
    {
      name: 'compiled_changed_operator',
      intendedPaths: ['resources.0.properties.criteria.allOf.0.operator'],
      mutate(t) {
        const a = findAlertByMetric(t.resources, 'Requests');
        a.properties.criteria.allOf[0].operator = 'GreaterThan';
      },
    },
    {
      name: 'compiled_changed_threshold',
      intendedPaths: ['parameters.requests5xxThreshold.defaultValue'],
      mutate(t) {
        t.parameters.requests5xxThreshold.defaultValue = 99;
      },
    },
    {
      name: 'compiled_changed_window',
      intendedPaths: ['parameters.windowSize.defaultValue'],
      mutate(t) {
        t.parameters.windowSize.defaultValue = 'PT15M';
      },
    },
    {
      name: 'compiled_changed_severity',
      intendedPaths: ['parameters.alertSeverity.defaultValue'],
      mutate(t) {
        t.parameters.alertSeverity.defaultValue = 0;
      },
    },
    {
      name: 'compiled_missing_action',
      intendedPaths: ['resources.0.properties.actions.0'],
      mutate(t) {
        const a = findAlertByMetric(t.resources, 'Requests');
        a.properties.actions = [];
      },
    },
    {
      name: 'compiled_extra_action',
      intendedPaths: ['resources.0.properties.actions.1'],
      mutate(t) {
        const a = findAlertByMetric(t.resources, 'Requests');
        a.properties.actions.push({ actionGroupId: 'extra' });
      },
    },
    {
      name: 'compiled_wrong_scope',
      intendedPaths: ['resources.0.properties.scopes.0'],
      mutate(t) {
        const a = findAlertByMetric(t.resources, 'Requests');
        a.properties.scopes = ['wrong-scope'];
      },
    },
    {
      name: 'compiled_alert_disabled',
      intendedPaths: ['resources.0.properties.enabled'],
      mutate(t) {
        const a = findAlertByMetric(t.resources, 'Requests');
        a.properties.enabled = false;
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

function spawnPreflight(argvExtra, envExtra) {
  const env = {
    ...process.env,
    PATH: `/opt/data/.local/bin:${process.env.PATH || ''}`,
    AZURE_CONFIG_DIR: process.env.AZURE_CONFIG_DIR || '/opt/data/.azure',
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
ok('L5 bicep source structural',
  /targetScope\s*=\s*'resourceGroup'/.test(bicepText)
  && /Microsoft\.Insights\/metricAlerts@/.test(bicepText)
  && /existing\s*=/.test(bicepText)
  && /Microsoft\.Insights\/actionGroups@/.test(bicepText)
  && /metricNamespace:\s*'Microsoft\.App\/containerApps'/.test(bicepText)
  && /metricName:\s*'Requests'/.test(bicepText)
  && /metricName:\s*'RestartCount'/.test(bicepText)
  && /statusCodeCategory/.test(bicepText)
  && /'5xx'/.test(bicepText)
  && /GreaterThanOrEqual/.test(bicepText)
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
  ok('L7 compiled vs frozen contract (metric/dimension/operator/threshold/window/severity/actions/scope)',
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
ok('L9 example params locked to contract pairs',
  whParams.parameters.containerAppName.value === expected.apps[0].containerAppName
  && sunParams.parameters.containerAppName.value === expected.apps[1].containerAppName
  && whParams.parameters.actionGroupName.value === expected.apps[0].actionGroupName
  && sunParams.parameters.actionGroupName.value === expected.apps[1].actionGroupName
  && whParams.parameters.tenantSlug.value === expected.apps[0].tenantSlug
  && sunParams.parameters.tenantSlug.value === expected.apps[1].tenantSlug
  && whParams.parameters.requests5xxThreshold.value === 3
  && whParams.parameters.restartCountThreshold.value === 0
  && whParams.parameters.alertSeverity.value === expected.severity
  && whParams.parameters.windowSize.value === expected.windowSize
  && whParams.parameters.evaluationFrequency.value === expected.evaluationFrequency
  && whParams.metadata.subscriptionId === expected.subscriptionId
  && sunParams.metadata.resourceGroup === expected.resourceGroups[1]
  && whParams.metadata.deploymentMode === expected.deploymentMode
  && sunParams.metadata.liveDeploy === expected.liveDeployEnabled
  && whParams.metadata.notification_delivery_proof === 'open'
  && whParams.metadata.alert_fire_drill === 'open');

const planReds = runPlanRedMutations(plan, expected);
const compiledReds = compiled ? runCompiledRedMutations(compiled, expected) : [];
const cliReds = runCliRedCases();
const cliGreens = runCliGreenCases(expected);

redResults.push(...planReds, ...compiledReds, ...cliReds);
greenResults.push(...cliGreens);

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
  'compiled_missing_action',
  'compiled_extra_action',
  'compiled_wrong_scope',
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

ok('L14 GREEN plan+compiled+cli',
  greenResults.length >= 4 && greenResults.every((g) => g.ok),
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

const readme = readText('infra/azure/staging-staff-api-metric-alerts/README.md');
ok('L19 README metric alerts / Incremental / no live deploy / AG reference',
  /metric alert/i.test(readme)
  && /Incremental/i.test(readme)
  && /disabled/i.test(readme)
  && /Reference/i.test(readme)
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

if (outPath && fs.existsSync(outPath)) {
  fs.unlinkSync(outPath);
}
const tmpDir = path.join(ROOT, 'tmp');
if (fs.existsSync(tmpDir)) {
  const left = fs.readdirSync(tmpDir).filter((f) => f.startsWith('radar-16f'));
  for (const f of left) fs.unlinkSync(path.join(tmpDir, f));
}
ok('L23 generated tmp removed',
  !fs.existsSync(path.join(ROOT, 'tmp', 'radar-16f-rg-staff-api-metric-alerts.json')));

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
