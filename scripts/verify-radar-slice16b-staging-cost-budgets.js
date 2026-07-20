'use strict';

/**
 * verify:radar-slice16b-staging-cost-budgets — RADAR Slice 16B
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
const MASTER = '5a8b08d395e11c51baf928b918016d5dd5bb4afe';

const CONTRACT_REL = 'fixtures/radar-operations/slice16b-expected-contract.json';
const PLAN_REL = 'fixtures/radar-operations/slice16b-budget-threshold-plan.json';
const BICEP_REL = 'infra/azure/staging-cost-budgets/rg-budget-threshold.bicep';
const PREFLIGHT_REL = 'scripts/preflight-radar-slice16b-staging-cost-budgets.js';
const LIB_REL = 'scripts/lib/radar-slice16b-staging-cost-budgets.js';
const VERIFY_REL = 'scripts/verify-radar-slice16b-staging-cost-budgets.js';

const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]{20,}/,
  /whsec_[A-Za-z0-9]+/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /password["']?\s*[:=]\s*["'][^"']{8,}/i,
  /ACCOUNT_KEY["']?\s*[:=]\s*["'][^"']{16,}/i,
];

const EMAIL_LITERAL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

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

/** Dotted paths whose leaf values differ between a and b. */
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
  const out = path.join(ROOT, 'tmp', 'radar-16b-rg-budget-threshold.json');
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

/**
 * Compare plan fixture (or mutated clone) against frozen expected contract.
 * Contract owns truth — no duplicated lock literals in the comparator.
 */
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
  eq('anomalyDetectionClaimed', plan.anomalyDetectionClaimed, expected.anomalyDetectionClaimed);
  eq('notification_delivery_proof', plan.notification_delivery_proof, expected.notification_delivery_proof);
  eq('zero_live_mutation', plan.zero_live_mutation, expected.zero_live_mutation);
  eq('bicepModuleRel', plan.bicepModuleRel, expected.bicepModuleRel);

  const allowed = plan.resourceTypesAllowed || [];
  if (!arraysEqual(allowed, expected.allowedResourceTypes)) {
    errors.push(`resourceTypesAllowed mismatch: ${JSON.stringify(allowed)}`);
  } else {
    covered.push('resourceTypesAllowed');
  }

  const planRgs = (plan.budgets || []).map((b) => b.resourceGroup);
  if (!arraysEqual(planRgs, expected.resourceGroups)) {
    errors.push(`resourceGroups: got ${JSON.stringify(planRgs)} want ${JSON.stringify(expected.resourceGroups)}`);
  } else {
    covered.push('resourceGroups');
  }

  if (!Array.isArray(plan.budgets) || plan.budgets.length !== expected.budgets.length) {
    errors.push(`budgets length: got ${(plan.budgets || []).length} want ${expected.budgets.length}`);
  } else {
    for (let i = 0; i < expected.budgets.length; i += 1) {
      const want = expected.budgets[i];
      const got = plan.budgets[i];
      eq(`budgets[${i}].resourceGroup`, got.resourceGroup, want.resourceGroup);
      eq(`budgets[${i}].budgetName`, got.budgetName, want.budgetName);
      eq(`budgets[${i}].amountUsd`, got.amountUsd, want.amountUsd);
      eq(`budgets[${i}].category`, got.category, expected.category);
      eq(`budgets[${i}].timeGrain`, got.timeGrain, expected.timeGrain);
      eq(`budgets[${i}].budgetStartDate`, got.budgetStartDate, expected.budgetStartDate);
      eq(`budgets[${i}].actionGroupName`, got.actionGroupName, want.actionGroupName);
      eq(`budgets[${i}].actionGroupShortName`, got.actionGroupShortName, want.actionGroupShortName);
      eq(`budgets[${i}].opsEmailParam`, got.opsEmailParam, expected.opsEmailParam);
      eq(`budgets[${i}].opsEmailInGit`, got.opsEmailInGit, false);
      eq(`budgets[${i}].parametersExampleRel`, got.parametersExampleRel, want.parametersExampleRel);

      const th = got.thresholds || [];
      if (th.length !== expected.thresholds.length) {
        errors.push(`budgets[${i}].thresholds length`);
      } else {
        for (let j = 0; j < expected.thresholds.length; j += 1) {
          eq(`budgets[${i}].thresholds[${j}].percent`, th[j].percent, expected.thresholds[j]);
          eq(`budgets[${i}].thresholds[${j}].enabled`, th[j].enabled, true);
          eq(`budgets[${i}].thresholds[${j}].thresholdType`, th[j].thresholdType, expected.thresholdType);
          eq(`budgets[${i}].thresholds[${j}].operator`, th[j].operator, expected.operator);
        }
      }
    }
  }

  if (EMAIL_LITERAL.test(JSON.stringify(plan))) {
    errors.push('plan_contains_email_literal');
  } else {
    covered.push('opsEmail_default_absence_plan');
  }

  return { ok: errors.length === 0, errors, covered };
}

/**
 * Compare compiled ARM template against frozen expected contract.
 * Threshold values (param defaults) + expressions, startDate, names,
 * groupShortName, and email-default absence all come from the contract.
 */
function compareCompiledToContract(compiled, expected) {
  const errors = [];
  const covered = [];
  const expr = expected.compiled.expressions;
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
  if (!params.opsNotifyEmail) errors.push('compiled_missing_opsNotifyEmail');
  if (params.opsNotifyEmail && Object.prototype.hasOwnProperty.call(params.opsNotifyEmail, 'defaultValue')) {
    errors.push('opsNotifyEmail_has_default');
  } else if (params.opsNotifyEmail && expected.opsEmailHasDefault === false
    && expected.compiled.opsNotifyEmailDefaultForbidden === true) {
    covered.push('opsNotifyEmail_default_absence');
  }

  const td = expected.compiled.thresholdDefaults;
  if (!params.thresholdPercent80
    || params.thresholdPercent80.defaultValue !== td.thresholdPercent80) {
    errors.push('thresholdPercent80_default_mismatch');
  } else {
    covered.push('thresholdPercent80_value');
  }
  if (!params.thresholdPercent100
    || params.thresholdPercent100.defaultValue !== td.thresholdPercent100) {
    errors.push('thresholdPercent100_default_mismatch');
  } else {
    covered.push('thresholdPercent100_value');
  }

  const modeOut = compiled && compiled.outputs && compiled.outputs.deploymentModeRequired
    && compiled.outputs.deploymentModeRequired.value;
  if (modeOut !== expected.compiled.deploymentModeOutput) {
    errors.push(`deploymentModeOutput: got ${modeOut}`);
  } else {
    covered.push('deploymentMode');
  }

  const ag = resources.find((r) => r.type === 'Microsoft.Insights/actionGroups');
  const budget = resources.find((r) => r.type === 'Microsoft.Consumption/budgets');
  if (!ag) errors.push('missing_action_group_resource');
  if (!budget) errors.push('missing_budget_resource');

  if (ag) {
    if (ag.name !== expr.actionGroupName) errors.push('ag_name_expression');
    else covered.push('actionGroupName');
    if (ag.location !== expected.actionGroup.location) errors.push('ag_location');
    if (!ag.properties || ag.properties.enabled !== expected.actionGroup.enabled) {
      errors.push('ag_enabled');
    } else {
      covered.push('ag_enabled');
    }
    if (!ag.properties || ag.properties.groupShortName !== expr.actionGroupShortName) {
      errors.push('ag_groupShortName_expression');
    } else {
      covered.push('actionGroupShortName');
    }
    const receivers = (ag.properties && ag.properties.emailReceivers) || [];
    if (receivers.length !== 1) errors.push('ag_emailReceivers_count');
    else {
      if (receivers[0].name !== expected.actionGroup.emailReceiverName) errors.push('ag_receiver_name');
      if (receivers[0].useCommonAlertSchema !== expected.actionGroup.useCommonAlertSchema) {
        errors.push('ag_useCommonAlertSchema');
      }
      if (receivers[0].emailAddress !== expr.opsNotifyEmail) {
        errors.push('ag_emailAddress_not_parameterized');
      } else {
        covered.push('opsNotifyEmail_expression');
      }
    }
  }

  if (budget) {
    if (budget.name !== expr.budgetName) errors.push('budget_name_expression');
    else covered.push('budgetName');
    const props = budget.properties || {};
    if (props.category !== expected.category) errors.push('budget_category');
    else covered.push('category');
    if (props.timeGrain !== expected.timeGrain) errors.push('budget_timeGrain');
    else covered.push('timeGrain');
    if (props.amount !== expr.amountUsd) errors.push('budget_amount_not_parameterized');
    const startDate = props.timePeriod && props.timePeriod.startDate;
    if (startDate !== expr.budgetStartDate) errors.push('budget_startDate_expression');
    else covered.push('budgetStartDate');

    const notes = props.notifications || {};
    const key80 = expected.notificationKeys[0];
    const key100 = expected.notificationKeys[1];
    for (const key of expected.notificationKeys) {
      const n = notes[key];
      if (!n) {
        errors.push(`missing_notification:${key}`);
        continue;
      }
      if (n.enabled !== true) errors.push(`${key}_not_enabled`);
      else covered.push(`${key}_enabled`);
      if (n.operator !== expected.operator) errors.push(`${key}_operator`);
      else covered.push(`${key}_operator`);
      if (n.thresholdType !== expected.thresholdType) errors.push(`${key}_thresholdType`);
      else covered.push(`${key}_thresholdType`);
      const groups = n.contactGroups || [];
      if (groups.length !== 1 || groups[0] !== expected.actionGroup.contactGroupsLinkExpression) {
        errors.push(`${key}_contactGroups_link`);
      } else {
        covered.push(`${key}_contactGroups`);
      }
      if ((n.contactEmails || []).length !== 0) errors.push(`${key}_contactEmails_must_be_empty`);
    }
    if (notes[key80] && notes[key80].threshold !== expr.thresholdPercent80) {
      errors.push('thresholdPercent80_expression');
    } else if (notes[key80]) {
      covered.push('thresholdPercent80_expression');
    }
    if (notes[key100] && notes[key100].threshold !== expr.thresholdPercent100) {
      errors.push('thresholdPercent100_expression');
    } else if (notes[key100]) {
      covered.push('thresholdPercent100_expression');
    }
    for (const key of Object.keys(notes)) {
      if (!expected.notificationKeys.includes(key)) errors.push(`extra_notification:${key}`);
    }
  }

  return { ok: errors.length === 0, errors, types, covered };
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

/**
 * Verifier-owned one-field RED mutations of the plan (against frozen contract).
 * Each case declares intendedPaths; runner proves mutation differs only there.
 */
function runPlanRedMutations(basePlan, expected) {
  const cases = [
    { name: 'wrong_scope_subscription', path: 'subscriptionId', value: '00000000-0000-0000-0000-000000000000', intendedPaths: ['subscriptionId'] },
    { name: 'wrong_scope_rg', path: 'budgets.0.resourceGroup', value: 'other-staging-rg', intendedPaths: ['budgets.0.resourceGroup'] },
    { name: 'production_marker_rg', path: 'budgets.0.resourceGroup', value: 'wh-prod-rg', intendedPaths: ['budgets.0.resourceGroup'] },
    { name: 'amount', path: 'budgets.0.amountUsd', value: 999, intendedPaths: ['budgets.0.amountUsd'] },
    { name: 'threshold', path: 'budgets.0.thresholds.0.percent', value: 50, intendedPaths: ['budgets.0.thresholds.0.percent'] },
    { name: 'threshold_disabled', path: 'budgets.0.thresholds.0.enabled', value: false, intendedPaths: ['budgets.0.thresholds.0.enabled'] },
    { name: 'email', path: 'budgets.0.opsEmailInGit', value: true, intendedPaths: ['budgets.0.opsEmailInGit'] },
    { name: 'startDate', path: 'budgets.0.budgetStartDate', value: '2020-01-01', intendedPaths: ['budgets.0.budgetStartDate'] },
    { name: 'budget_name', path: 'budgets.0.budgetName', value: 'wrong-budget-name', intendedPaths: ['budgets.0.budgetName'] },
    { name: 'action_group_name', path: 'budgets.0.actionGroupName', value: 'wrong-ag-name', intendedPaths: ['budgets.0.actionGroupName'] },
    { name: 'groupShortName', path: 'budgets.0.actionGroupShortName', value: 'wrongShort', intendedPaths: ['budgets.0.actionGroupShortName'] },
    { name: 'schema_version', path: 'schema_version', value: 99, intendedPaths: ['schema_version'] },
    { name: 'slice_pin', path: 'slice', value: 'RADAR-99Z', intendedPaths: ['slice'] },
    { name: 'master_basis_pin', path: 'master_basis', value: '0000000000000000000000000000000000000000', intendedPaths: ['master_basis'] },
    { name: 'branch_pin', path: 'branch', value: 'radar/wrong-branch', intendedPaths: ['branch'] },
    {
      name: 'extra_resource',
      path: 'resourceTypesAllowed',
      value: [
        'Microsoft.Insights/actionGroups',
        'Microsoft.Consumption/budgets',
        'Microsoft.App/containerApps',
      ],
      intendedPaths: ['resourceTypesAllowed.2'],
    },
    { name: 'Complete_mode', path: 'deploymentMode', value: 'Complete', intendedPaths: ['deploymentMode'] },
    { name: 'anomaly_claim', path: 'anomalyDetectionClaimed', value: true, intendedPaths: ['anomalyDetectionClaimed'] },
    { name: 'live_deploy_claim', path: 'liveDeployEnabled', value: true, intendedPaths: ['liveDeployEnabled'] },
    { name: 'category', path: 'budgets.0.category', value: 'Usage', intendedPaths: ['budgets.0.category'] },
    { name: 'time_grain', path: 'budgets.0.timeGrain', value: 'Quarterly', intendedPaths: ['budgets.0.timeGrain'] },
    {
      name: 'missing_rg',
      intendedPaths: ['budgets.1'],
      mutate(p) { p.budgets.splice(1, 1); },
    },
    {
      name: 'extra_rg',
      intendedPaths: ['budgets.2'],
      mutate(p) {
        p.budgets.push({
          ...deepClone(p.budgets[0]),
          resourceGroup: 'extra-staging-rg',
          budgetName: 'extra-staging-rg-monthly-actualcost',
          actionGroupName: 'extra-ops-budget-ag',
          actionGroupShortName: 'extraBudAg',
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

/**
 * Verifier-owned one-field RED mutations of compiled template view.
 */
function runCompiledRedMutations(baseCompiled, expected) {
  const key80 = expected.notificationKeys[0];
  const key100 = expected.notificationKeys[1];
  const cases = [
    {
      name: 'compiled_extra_resource',
      intendedPaths: ['resources.2'],
      mutate(t) {
        t.resources.push({ type: 'Microsoft.App/containerApps', name: 'x', properties: {} });
      },
    },
    {
      name: 'compiled_threshold_disabled',
      intendedPaths: [`resources.1.properties.notifications.${key80}.enabled`],
      mutate(t) {
        const b = t.resources.find((r) => r.type === 'Microsoft.Consumption/budgets');
        b.properties.notifications[key80].enabled = false;
      },
    },
    {
      name: 'compiled_threshold80_value',
      intendedPaths: ['parameters.thresholdPercent80.defaultValue'],
      mutate(t) {
        t.parameters.thresholdPercent80.defaultValue = 50;
      },
    },
    {
      name: 'compiled_threshold100_value',
      intendedPaths: ['parameters.thresholdPercent100.defaultValue'],
      mutate(t) {
        t.parameters.thresholdPercent100.defaultValue = 90;
      },
    },
    {
      name: 'compiled_threshold80_expression',
      intendedPaths: [`resources.1.properties.notifications.${key80}.threshold`],
      mutate(t) {
        const b = t.resources.find((r) => r.type === 'Microsoft.Consumption/budgets');
        b.properties.notifications[key80].threshold = 80;
      },
    },
    {
      name: 'compiled_threshold100_expression',
      intendedPaths: [`resources.1.properties.notifications.${key100}.threshold`],
      mutate(t) {
        const b = t.resources.find((r) => r.type === 'Microsoft.Consumption/budgets');
        b.properties.notifications[key100].threshold = 100;
      },
    },
    {
      name: 'compiled_startDate',
      intendedPaths: ['resources.1.properties.timePeriod.startDate'],
      mutate(t) {
        const b = t.resources.find((r) => r.type === 'Microsoft.Consumption/budgets');
        b.properties.timePeriod.startDate = '2020-01-01';
      },
    },
    {
      name: 'compiled_budget_name',
      intendedPaths: ['resources.1.name'],
      mutate(t) {
        const b = t.resources.find((r) => r.type === 'Microsoft.Consumption/budgets');
        b.name = 'literal-budget-name';
      },
    },
    {
      name: 'compiled_action_group_name',
      intendedPaths: ['resources.0.name'],
      mutate(t) {
        const ag = t.resources.find((r) => r.type === 'Microsoft.Insights/actionGroups');
        ag.name = 'literal-ag-name';
      },
    },
    {
      name: 'compiled_groupShortName',
      intendedPaths: ['resources.0.properties.groupShortName'],
      mutate(t) {
        const ag = t.resources.find((r) => r.type === 'Microsoft.Insights/actionGroups');
        ag.properties.groupShortName = 'wrongShort';
      },
    },
    {
      name: 'compiled_wrong_contactGroups',
      intendedPaths: [`resources.1.properties.notifications.${key80}.contactGroups.0`],
      mutate(t) {
        const b = t.resources.find((r) => r.type === 'Microsoft.Consumption/budgets');
        b.properties.notifications[key80].contactGroups = ['not-the-ag'];
      },
    },
    {
      name: 'compiled_email_default',
      intendedPaths: ['parameters.opsNotifyEmail.defaultValue'],
      mutate(t) {
        t.parameters.opsNotifyEmail.defaultValue = 'x';
      },
    },
    {
      name: 'compiled_Complete_mode_output',
      intendedPaths: ['outputs.deploymentModeRequired.value'],
      mutate(t) {
        t.outputs.deploymentModeRequired.value = 'Complete';
      },
    },
    {
      name: 'compiled_wrong_category',
      intendedPaths: ['resources.1.properties.category'],
      mutate(t) {
        const b = t.resources.find((r) => r.type === 'Microsoft.Consumption/budgets');
        b.properties.category = 'Usage';
      },
    },
    {
      name: 'compiled_wrong_timeGrain',
      intendedPaths: ['resources.1.properties.timeGrain'],
      mutate(t) {
        const b = t.resources.find((r) => r.type === 'Microsoft.Consumption/budgets');
        b.properties.timeGrain = 'Annually';
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
 * Spawn preflight; parse refusal JSON for azureCalls.
 */
function spawnPreflight(argvExtra, envExtra) {
  const env = {
    ...process.env,
    PATH: `/opt/data/.local/bin:${process.env.PATH || ''}`,
    AZURE_CONFIG_DIR: process.env.AZURE_CONFIG_DIR || '/opt/data/.azure',
    ...envExtra,
  };
  // Ensure ops email is present when not testing email refusal, unless caller clears it.
  if (!Object.prototype.hasOwnProperty.call(envExtra || {}, 'WH_RADAR_16B_OPS_NOTIFY_EMAIL')
    && !env.WH_RADAR_16B_OPS_NOTIFY_EMAIL) {
    env.WH_RADAR_16B_OPS_NOTIFY_EMAIL = `ops-notify@${'example'}.${'invalid'}`;
  }
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, PREFLIGHT_REL), ...argvExtra],
    { cwd: ROOT, env, encoding: 'utf8' },
  );
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  let report = null;
  // Refusal emits one-line JSON on stderr; success emits pretty JSON on stdout.
  for (const chunk of [result.stderr || '', result.stdout || '']) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    // Try full chunk first (pretty JSON), then per-line (refusal one-liner).
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

console.log('verify:radar-slice16b-staging-cost-budgets — RADAR Slice 16B (independent)\n');

// Independence: this verifier must not import the plan/preflight lib or its RED generator.
const verifySrc = readText(VERIFY_REL);
const requireLines = verifySrc.split('\n').filter((l) => /require\s*\(/.test(l)).join('\n');
ok('I1 verifier does not require plan/preflight lib',
  !/radar-slice16b-staging-cost-budgets/.test(requireLines));
ok('I2 verifier does not call lib RED/plan builders',
  !/\brunRedCases\b/.test(verifySrc)
  && !/\brunGreenCases\b/.test(verifySrc)
  && !/\bbuildSecretFreePlan\b/.test(verifySrc)
  && !/\bevaluateDeployRequest\b/.test(verifySrc));

const expected = readJson(CONTRACT_REL);
// Shape / cross-pin only — lock values live in the frozen contract, not duplicated here.
ok('L1 frozen contract shape + master_basis cross-pin',
  typeof expected.schema_version === 'number'
  && typeof expected.slice === 'string'
  && typeof expected.master_basis === 'string'
  && typeof expected.branch === 'string'
  && expected.master_basis === MASTER
  && Array.isArray(expected.resourceGroups)
  && expected.resourceGroups.length === 2
  && Array.isArray(expected.budgets)
  && expected.budgets.length === expected.resourceGroups.length
  && Array.isArray(expected.thresholds)
  && expected.thresholds.length === 2
  && expected.opsEmailHasDefault === false
  && expected.compiled
  && expected.compiled.expressions
  && typeof expected.compiled.expressions.thresholdPercent80 === 'string'
  && typeof expected.compiled.expressions.thresholdPercent100 === 'string'
  && typeof expected.compiled.expressions.budgetStartDate === 'string'
  && typeof expected.compiled.expressions.budgetName === 'string'
  && typeof expected.compiled.expressions.actionGroupName === 'string'
  && typeof expected.compiled.expressions.actionGroupShortName === 'string'
  && Array.isArray(expected.full_field_coverage)
  && expected.full_field_coverage.length >= 10);

const plan = readJson(PLAN_REL);
const planCmp = comparePlanToContract(plan, expected);
ok('L2 plan fixture matches frozen contract (all fields)', planCmp.ok, planCmp.errors.join('; '));
greenResults.push({ name: 'plan_vs_contract', expect: 'GREEN', ok: planCmp.ok, errors: planCmp.errors });
fieldCoverage.push(...planCmp.covered);

const planSec = secretFree(JSON.stringify(plan), 'plan');
ok('L3 plan secret-free', planSec.ok, planSec.detail);
ok('L4 plan has no email literals', !EMAIL_LITERAL.test(JSON.stringify(plan)));

const bicepText = readText(BICEP_REL);
ok('L5 bicep source structural',
  /targetScope\s*=\s*'resourceGroup'/.test(bicepText)
  && /param\s+opsNotifyEmail\s+string/.test(bicepText)
  && !/param\s+opsNotifyEmail\s+string\s*=/.test(bicepText)
  && /thresholdType:\s*'Actual'/.test(bicepText)
  && /enabled:\s*true/.test(bicepText)
  && /deploymentModeRequired\s+string\s*=\s*'Incremental'/.test(bicepText)
  && /groupShortName:\s*actionGroupShortName/.test(bicepText)
  && /startDate:\s*budgetStartDate/.test(bicepText)
  && FORBIDDEN_TYPE_MARKERS.every((m) => !bicepText.includes(m))
  && !EMAIL_LITERAL.test(bicepText));

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
  ok('L7 compiled vs frozen contract (thresholds/values+expr, startDate, names, groupShortName, email default, RG types)',
    cCmp.ok, cCmp.errors.join('; '));
  greenResults.push({ name: 'compiled_vs_contract', expect: 'GREEN', ok: cCmp.ok, errors: cCmp.errors });
  fieldCoverage.push(...cCmp.covered);
} else {
  ok('L7 compiled vs frozen contract', false, 'no compiled template');
}

for (const rel of MAIN_BICEP) {
  const text = readText(rel);
  ok(`L8 not wired into ${path.basename(path.dirname(rel))}/main.bicep`,
    !/staging-cost-budgets|rg-budget-threshold|monthly-actualcost|ops-budget-ag/.test(text));
}

function paramsOmitEmail(rel) {
  const raw = readJson(rel);
  const params = raw.parameters || {};
  return !Object.prototype.hasOwnProperty.call(params, 'opsNotifyEmail')
    && !EMAIL_LITERAL.test(JSON.stringify(raw));
}

ok('L9 wh-staging example omits email', paramsOmitEmail(expected.budgets[0].parametersExampleRel));
ok('L10 sunset example omits email', paramsOmitEmail(expected.budgets[1].parametersExampleRel));

const whParams = readJson(expected.budgets[0].parametersExampleRel);
const sunParams = readJson(expected.budgets[1].parametersExampleRel);
ok('L11 example amounts/scope/names/startDate locked to contract',
  whParams.parameters.amountUsd.value === expected.budgets[0].amountUsd
  && sunParams.parameters.amountUsd.value === expected.budgets[1].amountUsd
  && whParams.parameters.budgetName.value === expected.budgets[0].budgetName
  && sunParams.parameters.budgetName.value === expected.budgets[1].budgetName
  && whParams.parameters.actionGroupName.value === expected.budgets[0].actionGroupName
  && sunParams.parameters.actionGroupName.value === expected.budgets[1].actionGroupName
  && whParams.parameters.actionGroupShortName.value === expected.budgets[0].actionGroupShortName
  && sunParams.parameters.actionGroupShortName.value === expected.budgets[1].actionGroupShortName
  && whParams.parameters.budgetStartDate.value === expected.budgetStartDate
  && sunParams.parameters.budgetStartDate.value === expected.budgetStartDate
  && whParams.parameters.thresholdPercent80.value === expected.thresholds[0]
  && whParams.parameters.thresholdPercent100.value === expected.thresholds[1]
  && whParams.metadata.subscriptionId === expected.subscriptionId
  && sunParams.metadata.resourceGroup === expected.resourceGroups[1]
  && whParams.metadata.deploymentMode === expected.deploymentMode
  && sunParams.metadata.liveDeploy === expected.liveDeployEnabled);

const planReds = runPlanRedMutations(plan, expected);
const compiledReds = compiled ? runCompiledRedMutations(compiled, expected) : [];
const cliReds = runCliRedCases();
const cliGreens = runCliGreenCases(expected);

redResults.push(...planReds, ...compiledReds, ...cliReds);
greenResults.push(...cliGreens);

const requiredRedNames = [
  'production_marker_rg',
  'cli_live',
  'cli_deploy',
  'cli_apply',
  'cli_what_if',
  'cli_unknown_arg',
  'anomaly_claim',
  'wrong_scope_subscription',
  'wrong_scope_rg',
  'cli_wrong_scope',
  'email',
  'amount',
  'threshold',
  'startDate',
  'budget_name',
  'action_group_name',
  'groupShortName',
  'schema_version',
  'slice_pin',
  'master_basis_pin',
  'branch_pin',
  'missing_rg',
  'extra_rg',
  'extra_resource',
  'Complete_mode',
  'cli_Complete_mode',
  'cli_production_marker',
  'cli_positional',
  'compiled_threshold80_value',
  'compiled_threshold100_value',
  'compiled_threshold80_expression',
  'compiled_threshold100_expression',
  'compiled_startDate',
  'compiled_budget_name',
  'compiled_action_group_name',
  'compiled_groupShortName',
  'compiled_email_default',
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

// Fail-closed --live evidence: azureCalls === 0
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
  !/\baz\b|management\.azure\.com|deployment group|account show|execFileSync|execSync/.test(preflightSrc)
  || (
    !/management\.azure\.com/.test(preflightSrc)
    && !/deployment group/.test(preflightSrc)
    && !/account show/.test(preflightSrc)
    && !/\bexecFileSync\b|\bexecSync\b|\bspawnSync\b/.test(preflightSrc)
  ));

ok('L18 preflight fail-closed markers',
  /forbidden_flag/.test(preflightSrc)
  && /unknown_cli_arg/.test(preflightSrc)
  && /unknown_positional_arg/.test(preflightSrc)
  && /--live/.test(preflightSrc)
  && /azureCalls/.test(preflightSrc));

const readme = readText('infra/azure/staging-cost-budgets/README.md');
ok('L19 README threshold not anomaly / Incremental / no live deploy',
  /budget-threshold/i.test(readme)
  && /not.*anomaly/i.test(readme)
  && /Incremental/i.test(readme)
  && /disabled/i.test(readme));

// 16I owns Staff API /readyz + staging Bicep probes; 16B still forbids DB/Hermes mutation.
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
  pkg.scripts['verify:radar-slice16b-staging-cost-budgets']
  === 'node scripts/verify-radar-slice16b-staging-cost-budgets.js');

const owned = [
  BICEP_REL,
  'infra/azure/staging-cost-budgets/README.md',
  PLAN_REL,
  CONTRACT_REL,
  LIB_REL,
  VERIFY_REL,
  PREFLIGHT_REL,
  expected.budgets[0].parametersExampleRel,
  expected.budgets[1].parametersExampleRel,
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

// Remove generated tmp artifact
if (outPath && fs.existsSync(outPath)) {
  fs.unlinkSync(outPath);
}
const tmpDir = path.join(ROOT, 'tmp');
if (fs.existsSync(tmpDir)) {
  const left = fs.readdirSync(tmpDir).filter((f) => f.startsWith('radar-16b'));
  for (const f of left) fs.unlinkSync(path.join(tmpDir, f));
}
ok('L23 generated tmp removed',
  !fs.existsSync(path.join(ROOT, 'tmp', 'radar-16b-rg-budget-threshold.json')));

const requiredCoverage = expected.full_field_coverage;
const coverageSet = new Set(fieldCoverage);
const coverageMissing = requiredCoverage.filter((f) => {
  // Map contract coverage tokens to observed comparator cover tokens.
  const aliases = {
    schema_version: ['schema_version'],
    slice: ['slice'],
    master_basis: ['master_basis'],
    branch: ['branch'],
    resourceGroups: ['resourceGroups'],
    budgetStartDate: ['budgetStartDate', 'budgets[0].budgetStartDate', 'budgets[1].budgetStartDate'],
    budgetName: ['budgetName', 'budgets[0].budgetName', 'budgets[1].budgetName'],
    actionGroupName: ['actionGroupName', 'budgets[0].actionGroupName', 'budgets[1].actionGroupName'],
    actionGroupShortName: ['actionGroupShortName', 'budgets[0].actionGroupShortName', 'budgets[1].actionGroupShortName'],
    thresholdPercent80_value: ['thresholdPercent80_value', 'budgets[0].thresholds[0].percent'],
    thresholdPercent100_value: ['thresholdPercent100_value', 'budgets[0].thresholds[1].percent'],
    thresholdPercent80_expression: ['thresholdPercent80_expression'],
    thresholdPercent100_expression: ['thresholdPercent100_expression'],
    opsNotifyEmail_default_absence: ['opsNotifyEmail_default_absence', 'opsEmail_default_absence_plan'],
    category: ['category', 'budgets[0].category'],
    timeGrain: ['timeGrain', 'budgets[0].timeGrain'],
    thresholdType: ['budgets[0].thresholds[0].thresholdType', 'Actual_GreaterThan_80_Percent_thresholdType'],
    operator: ['budgets[0].thresholds[0].operator', 'Actual_GreaterThan_80_Percent_operator'],
    enabled: ['budgets[0].thresholds[0].enabled', 'Actual_GreaterThan_80_Percent_enabled'],
    contactGroups: ['Actual_GreaterThan_80_Percent_contactGroups', 'Actual_GreaterThan_100_Percent_contactGroups'],
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
console.log('RADAR 16B staging cost budgets: PASS');
console.log(`RED ${redPass}/${redResults.length} GREEN ${greenPass}/${greenResults.length}`);
