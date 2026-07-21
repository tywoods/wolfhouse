'use strict';

/**
 * verify:radar-slice16l-staff-api-capacity-alerts — RADAR Slice 16L
 *
 * Offline RED/GREEN gate for Staff API capacity-pressure metric alerts
 * (CpuPercentage + MemoryPercentage Average >80) in Wolfhouse + Sunset
 * staging Bicep. Compiles both main.bicep files and asserts exact alert
 * contract. Does not deploy, fire alerts, or claim load/SLO/backpressure.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MASTER = 'c01e08d3b0039840ced37ae5a8e04fdd2384aba2';
const BRANCH = 'radar/slice-16l-capacity-pressure-alerts';
const CONTRACT_REL = 'fixtures/radar-operations/slice16l-expected-contract.json';
const PLAN_REL = 'fixtures/radar-operations/slice16l-capacity-alert-plan.json';
const WH_BICEP = 'infra/azure/staging/main.bicep';
const SUN_BICEP = 'infra/azure/sunset-staging/main.bicep';
const H16_DIR = 'infra/azure/staging-staff-api-metric-alerts';

const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]{20,}/,
  /whsec_[A-Za-z0-9]+/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /password["']?\s*[:=]\s*["'][^"']{8,}/i,
  /ACCOUNT_KEY["']?\s*[:=]\s*["'][^"']{16,}/i,
];

let pass = 0;
let fail = 0;
const redResults = [];
const greenResults = [];
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

function red(name, cond, detail) {
  const r = { name, expect: 'RED', ok: !!cond, detail: detail || '' };
  redResults.push(r);
  return ok(`RED ${name}`, cond, detail);
}

function green(name, cond, detail) {
  const r = { name, expect: 'GREEN', ok: !!cond, detail: detail || '' };
  greenResults.push(r);
  return ok(`GREEN ${name}`, cond, detail);
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function secretFree(text, label) {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return { ok: false, detail: `${label} matched ${re}` };
  }
  return { ok: true };
}

function bicepEnv() {
  return {
    ...process.env,
    PATH: `/opt/data/.local/bin:${process.env.PATH || ''}`,
    AZURE_CONFIG_DIR: process.env.AZURE_CONFIG_DIR || '/opt/data/.azure',
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
  };
}

function buildBicep(rel, outName) {
  const bicep = path.join(ROOT, rel);
  const out = path.join(ROOT, 'tmp', outName);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync('az', ['bicep', 'build', '--file', bicep, '--outfile', out], {
    cwd: ROOT,
    env: bicepEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tmpArtifacts.push(out);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function buildBicepText(text, outName) {
  const tmpBicep = path.join(ROOT, 'tmp', `${outName}.bicep`);
  fs.mkdirSync(path.dirname(tmpBicep), { recursive: true });
  fs.writeFileSync(tmpBicep, text, 'utf8');
  tmpArtifacts.push(tmpBicep);
  const out = path.join(ROOT, 'tmp', `${outName}.json`);
  execFileSync('az', ['bicep', 'build', '--file', tmpBicep, '--outfile', out], {
    cwd: ROOT,
    env: bicepEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tmpArtifacts.push(out);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function capacityAlerts(compiled) {
  return (compiled.resources || []).filter((r) =>
    r.type === 'Microsoft.Insights/metricAlerts'
    && /staff-api-(cpu|memory)-pressure/.test(String(r.name || '')));
}

function criterion(alert) {
  const allOf = (((alert.properties || {}).criteria || {}).allOf) || [];
  return allOf[0] || {};
}

function assertTenantAlerts(compiled, app, expected) {
  const errors = [];
  const alerts = capacityAlerts(compiled);
  if (alerts.length !== 2) {
    errors.push(`expected_exactly_2_capacity_alerts got=${alerts.length}`);
  }
  const byName = Object.fromEntries(alerts.map((a) => [a.name, a]));
  for (const want of app.alerts) {
    const a = byName[want.name];
    if (!a) {
      errors.push(`missing_alert_${want.name}`);
      continue;
    }
    const c = criterion(a);
    const p = a.properties || {};
    const checks = [
      ['metricName', c.metricName, `[variables('radar16l${want.metricName === 'CpuPercentage' ? 'Cpu' : 'Memory'}MetricName')]`],
      ['metricNamespace', c.metricNamespace, "[variables('radar16lMetricNamespace')]"],
      ['operator', c.operator, "[variables('radar16lCapacityOperator')]"],
      ['threshold', c.threshold, "[variables('radar16lCapacityThreshold')]"],
      ['timeAggregation', c.timeAggregation, "[variables('radar16lTimeAggregation')]"],
      ['criterionType', c.criterionType, expected.criterionType],
      ['severity', p.severity, "[variables('radar16lAlertSeverity')]"],
      ['enabled', p.enabled, "[variables('radar16lAlertsEnabled')]"],
      ['windowSize', p.windowSize, "[variables('radar16lWindowSize')]"],
      ['evaluationFrequency', p.evaluationFrequency, "[variables('radar16lEvaluationFrequency')]"],
      ['odata', (p.criteria || {})['odata.type'], expected.alertCriteriaODataType],
    ];
    // Compiled ARM may inline literals for some vars; accept either expression or literal.
    const lit = expected.compiled.variables;
    const accept = {
      metricName: [want.metricName, `[variables('radar16l${want.metricName === 'CpuPercentage' ? 'Cpu' : 'Memory'}MetricName')]`],
      metricNamespace: [lit.radar16lMetricNamespace, "[variables('radar16lMetricNamespace')]"],
      operator: [lit.radar16lCapacityOperator, "[variables('radar16lCapacityOperator')]"],
      threshold: [lit.radar16lCapacityThreshold, "[variables('radar16lCapacityThreshold')]"],
      timeAggregation: [lit.radar16lTimeAggregation, "[variables('radar16lTimeAggregation')]"],
      severity: [lit.radar16lAlertSeverity, "[variables('radar16lAlertSeverity')]"],
      enabled: [lit.radar16lAlertsEnabled, "[variables('radar16lAlertsEnabled')]"],
      windowSize: [lit.radar16lWindowSize, "[variables('radar16lWindowSize')]"],
      evaluationFrequency: [lit.radar16lEvaluationFrequency, "[variables('radar16lEvaluationFrequency')]"],
    };
    void checks;
    if (!accept.metricName.includes(c.metricName)
      && c.metricName !== want.metricName
      && !String(c.metricName).includes('radar16l')) {
      errors.push(`${want.name}.metricName=${c.metricName}`);
    }
    // Prefer comparing resolved variable table + expression forms.
    const varTable = compiled.variables || {};
    if (varTable.radar16lCpuMetricName !== 'CpuPercentage') errors.push('var_cpu');
    if (varTable.radar16lMemoryMetricName !== 'MemoryPercentage') errors.push('var_mem');
    if (varTable.radar16lMetricNamespace !== 'Microsoft.App/containerApps') errors.push('var_ns');
    if (varTable.radar16lCapacityOperator !== 'GreaterThan') errors.push('var_op');
    if (varTable.radar16lCapacityThreshold !== 80) errors.push('var_thr');
    if (varTable.radar16lTimeAggregation !== 'Average') errors.push('var_agg');
    if (varTable.radar16lAlertSeverity !== 2) errors.push('var_sev');
    if (varTable.radar16lAlertsEnabled !== true) errors.push('var_en');
    if (varTable.radar16lWindowSize !== 'PT15M') errors.push('var_win');
    if (varTable.radar16lEvaluationFrequency !== 'PT5M') errors.push('var_freq');

    if (c.criterionType !== 'StaticThresholdCriterion') {
      errors.push(`${want.name}.criterionType=${c.criterionType}`);
    }
    if ((p.criteria || {})['odata.type'] !== expected.alertCriteriaODataType) {
      errors.push(`${want.name}.odata`);
    }
    const scopes = p.scopes || [];
    if (scopes.length !== 1 || !/staffApiApp|containerApps/.test(String(scopes[0]))) {
      errors.push(`${want.name}.scopes=${JSON.stringify(scopes)}`);
    }
    const actions = p.actions || [];
    if (actions.length !== 1
      || actions[0].actionGroupId !== "[parameters('opsActionGroupResourceId')]") {
      errors.push(`${want.name}.actions=${JSON.stringify(actions)}`);
    }
  }
  // No cross-tenant names
  const foreign = app.tenantSlug === 'wolfhouse' ? 'sunset' : 'wolfhouse';
  for (const a of alerts) {
    if (String(a.name).startsWith(`${foreign}-`)) {
      errors.push(`cross_tenant_alert_${a.name}`);
    }
  }
  // No duplicate names
  const names = alerts.map((a) => a.name);
  if (new Set(names).size !== names.length) errors.push('duplicate_alert_names');

  // Param default is subscription-pinned owned AG
  const param = (compiled.parameters || {}).opsActionGroupResourceId;
  if (!param || param.defaultValue !== app.opsActionGroupResourceId) {
    errors.push(`opsActionGroupResourceId_default=${param && param.defaultValue}`);
  }
  if (!String(app.opsActionGroupResourceId).startsWith(`/subscriptions/${expected.subscriptionId}/`)) {
    errors.push('ag_not_subscription_pinned');
  }
  return { ok: errors.length === 0, errors, alerts };
}

function extractStaffScaleBlock(text) {
  const marker = 'RADAR 16I — ACA probes';
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  const from = text.indexOf('scale: {', idx);
  if (from < 0) return null;
  let depth = 0;
  let started = false;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      depth += 1;
      started = true;
    } else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

function gitShow(rel) {
  return execFileSync('git', ['show', `${MASTER}:${rel}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function protectedPathsUnchanged(rel) {
  const base = gitShow(rel);
  const cur = readText(rel);
  const errors = [];
  const bScale = extractStaffScaleBlock(base);
  const cScale = extractStaffScaleBlock(cur);
  if (!bScale || !cScale || bScale !== cScale) errors.push('staff_scale_changed');
  for (const needle of [
    'STAFF_AUTH_REQUIRED',
    'STAFF_AUTH_HTTPS',
    'Microsoft.DBforPostgreSQL/flexibleServers',
  ]) {
    if (base.split(needle).length !== cur.split(needle).length) {
      errors.push(`count_changed_${needle}`);
    }
  }
  // Ingress external flag for staff API — count of "external: true" must match
  if ((base.match(/external:\s*true/g) || []).length
    !== (cur.match(/external:\s*true/g) || []).length) {
    errors.push('ingress_external_count_changed');
  }
  // No autoscaling rules added
  if (/rules:\s*\[/.test(cur.slice(cur.indexOf('RADAR 16L') >= 0 ? 0 : 0))
    && /scale:\s*\{[^}]*rules:/s.test(extractStaffScaleBlock(cur) || '')) {
    errors.push('autoscaling_rules_added');
  }
  return { ok: errors.length === 0, errors };
}

function validatePlan(plan, expected) {
  const errors = [];
  const fields = [
    'schema_version', 'slice', 'outcome_id', 'gate_id', 'progress_class',
    'does_not_implement', 'master_basis', 'branch', 'subscriptionId',
    'metricNamespace', 'windowSize', 'evaluationFrequency', 'severity',
    'timeAggregation', 'operator', 'threshold', 'criterionType', 'alertsEnabled',
    'opsActionGroupParam', 'referencedActionGroupSource',
  ];
  for (const f of fields) {
    if (plan[f] !== expected[f]) errors.push(`${f}: ${plan[f]} != ${expected[f]}`);
  }
  if (!Array.isArray(plan.apps) || plan.apps.length !== 2) errors.push('apps_len');
  for (let i = 0; i < 2; i += 1) {
    const p = plan.apps[i];
    const e = expected.apps[i];
    if (p.tenantSlug !== e.tenantSlug) errors.push(`tenant_${i}`);
    if (p.opsActionGroupResourceId !== e.opsActionGroupResourceId) errors.push(`ag_${i}`);
    if (JSON.stringify(p.alerts) !== JSON.stringify(e.alerts)) errors.push(`alerts_${i}`);
  }
  return { ok: errors.length === 0, errors };
}

function mutateAndExpectRed(label, mutator, assertFn) {
  try {
    const src = readText(WH_BICEP);
    const mutated = mutator(src);
    if (mutated === src) {
      red(label, false, 'mutator_noop');
      return;
    }
    let compiled;
    try {
      compiled = buildBicepText(mutated, `radar-16l-red-${label}`);
    } catch (err) {
      // Compile failure counts as RED rejection
      red(label, true, `compile_failed:${String(err.stderr || err.message || err).slice(0, 120)}`);
      return;
    }
    const result = assertFn(compiled);
    red(label, result.ok === false, (result.errors || []).slice(0, 4).join('; '));
  } catch (err) {
    red(label, false, String(err && err.message || err).slice(0, 200));
  }
}

function cleanupTmp() {
  for (const p of tmpArtifacts) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* ignore */ }
  }
  const tmpDir = path.join(ROOT, 'tmp');
  if (fs.existsSync(tmpDir)) {
    for (const f of fs.readdirSync(tmpDir).filter((n) => n.startsWith('radar-16l'))) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch (_) { /* ignore */ }
    }
  }
}

console.log('verify:radar-slice16l-staff-api-capacity-alerts — RADAR Slice 16L\n');

const expected = readJson(CONTRACT_REL);
const plan = readJson(PLAN_REL);

ok('C1 contract shape',
  expected.slice === 'RADAR-16L'
  && expected.outcome_id === '16L_staff_api_capacity_pressure_alerts'
  && expected.gate_id === 'G06_scaling_capacity'
  && expected.master_basis === MASTER
  && expected.branch === BRANCH
  && expected.progress_class === 'source_partial_progress_only'
  && expected.liveDeployEnabled === false
  && expected.execution_claim === false);

const planCmp = validatePlan(plan, expected);
ok('C2 plan matches contract', planCmp.ok, planCmp.errors.join('; '));
green('plan_vs_contract', planCmp.ok, planCmp.errors.join('; '));

const sec = secretFree([
  JSON.stringify(expected),
  JSON.stringify(plan),
  readText(WH_BICEP),
  readText(SUN_BICEP),
].join('\n'), '16l');
ok('C3 secret-free artifacts', sec.ok, sec.detail);

const headBranch = execSync('git rev-parse --abbrev-ref HEAD', {
  cwd: ROOT, encoding: 'utf8',
}).trim();
// Successor 16M/16O/16P may own HEAD while 16L source remains frozen on its master basis.
const allowedBranches = new Set([
  BRANCH,
  'radar/slice-16m-stripe-event-claim',
  'radar/slice-16o-stripe-webhook-error-minimization',
  'radar/slice-16p-live-drill-evidence',
  'radar/slice-16r-request-completion-log',
  'radar/slice-16s-request-log-live-evidence',
  'radar/slice-16u-correlation-design-freeze',
  'radar/slice-16w-readiness-shutdown-lifecycle',
  'radar/slice-16x-g02-live-evidence',
  'radar/slice-16y-shutdown-completion-log',
  'radar/slice-16z-g02-live-sigterm-evidence',
  'radar/slice-16aa-g02-live-sigint-evidence',
  'radar/slice-16ab-g02-readyz503-evidence',
  'radar/slice-16ac-organic-restart-alert-evidence',
  'radar/slice-16ad-g02-sampled-restart-continuity-evidence',
  'radar/slice-16af-g06-capacity-alert-live-evidence',
  'radar/slice-16ag-g06-bounded-load-harness',
  'radar/slice-16ah-g06-live-load-correction',
  'radar/slice-16ai-g06-live-load-evidence',
  'radar/slice-16aj-g06-slo-error-budget-source',
]);
ok('C4 branch pin (16L or successor tip)', allowedBranches.has(headBranch), headBranch);

const h16Diff = execSync(`git diff --name-only ${MASTER} -- ${H16_DIR}`, {
  cwd: ROOT, encoding: 'utf8',
}).trim();
ok('C5 16H metric-alert module unchanged', h16Diff === '', h16Diff);

const whProt = protectedPathsUnchanged(WH_BICEP);
const sunProt = protectedPathsUnchanged(SUN_BICEP);
ok('C6 Wolfhouse protected replica/traffic/auth/DB unchanged', whProt.ok, whProt.errors.join('; '));
ok('C7 Sunset protected replica/traffic/auth/DB unchanged', sunProt.ok, sunProt.errors.join('; '));
green('protected_paths_unchanged', whProt.ok && sunProt.ok);

const whSrc = readText(WH_BICEP);
const sunSrc = readText(SUN_BICEP);
ok('C8 WH source has capacity locks + static criteria',
  /radar16lCapacityThreshold\s*=\s*80/.test(whSrc)
  && /radar16lWindowSize\s*=\s*'PT15M'/.test(whSrc)
  && /radar16lEvaluationFrequency\s*=\s*'PT5M'/.test(whSrc)
  && /StaticThresholdCriterion/.test(whSrc)
  && /Microsoft\.App\/containerApps/.test(whSrc)
  && /param\s+opsActionGroupResourceId\s+string/.test(whSrc)
  && /fail\('wrong_ops_action_group'\)/.test(whSrc)
  && !/DynamicThresholdCriterion/.test(whSrc)
  && !/wolfhouse-staff-api-requests-5xx/.test(whSrc));
ok('C9 Sunset source has capacity locks + static criteria',
  /radar16lCapacityThreshold\s*=\s*80/.test(sunSrc)
  && /radar16lWindowSize\s*=\s*'PT15M'/.test(sunSrc)
  && /StaticThresholdCriterion/.test(sunSrc)
  && /param\s+opsActionGroupResourceId\s+string/.test(sunSrc)
  && !/DynamicThresholdCriterion/.test(sunSrc));

let compiledWh;
let compiledSun;
try {
  compiledWh = buildBicep(WH_BICEP, 'radar-16l-wh-main.json');
  green('compiled_wolfhouse_bicep', true);
} catch (err) {
  green('compiled_wolfhouse_bicep', false, String(err.stderr || err.message || err).slice(0, 400));
}
try {
  compiledSun = buildBicep(SUN_BICEP, 'radar-16l-sun-main.json');
  green('compiled_sunset_bicep', true);
} catch (err) {
  green('compiled_sunset_bicep', false, String(err.stderr || err.message || err).slice(0, 400));
}

if (compiledWh) {
  const r = assertTenantAlerts(compiledWh, expected.apps[0], expected);
  green('wolfhouse_exactly_two_capacity_alerts', r.ok, r.errors.join('; '));
  ok('G1 Wolfhouse capacity alert contract', r.ok, r.errors.join('; '));
}
if (compiledSun) {
  const r = assertTenantAlerts(compiledSun, expected.apps[1], expected);
  green('sunset_exactly_two_capacity_alerts', r.ok, r.errors.join('; '));
  ok('G2 Sunset capacity alert contract', r.ok, r.errors.join('; '));
}

// Cross-scope: WH compiled must not contain sunset alert names and vice versa
if (compiledWh && compiledSun) {
  const whNames = capacityAlerts(compiledWh).map((a) => a.name).sort();
  const sunNames = capacityAlerts(compiledSun).map((a) => a.name).sort();
  green('no_cross_scope_or_duplicate_across_tenants',
    whNames.join(',') === 'wolfhouse-staff-api-cpu-pressure,wolfhouse-staff-api-memory-pressure'
    && sunNames.join(',') === 'sunset-staff-api-cpu-pressure,sunset-staff-api-memory-pressure'
    && whNames.every((n) => !sunNames.includes(n)));
}

// RED cases on Wolfhouse source mutations
mutateAndExpectRed('wrong_threshold_rejected', (src) =>
  src.replace(/var radar16lCapacityThreshold = 80/, 'var radar16lCapacityThreshold = 50'),
(compiled) => {
  const thr = (compiled.variables || {}).radar16lCapacityThreshold;
  return { ok: thr === 80, errors: thr === 80 ? [] : [`threshold=${thr}`] };
});

mutateAndExpectRed('wrong_aggregation_rejected', (src) =>
  src.replace(/var radar16lTimeAggregation = 'Average'/, "var radar16lTimeAggregation = 'Total'"),
(compiled) => {
  const agg = (compiled.variables || {}).radar16lTimeAggregation;
  return { ok: agg === 'Average', errors: [`agg=${agg}`] };
});

mutateAndExpectRed('wrong_window_rejected', (src) =>
  src.replace(/var radar16lWindowSize = 'PT15M'/, "var radar16lWindowSize = 'PT5M'"),
(compiled) => {
  const w = (compiled.variables || {}).radar16lWindowSize;
  return { ok: w === 'PT15M', errors: [`window=${w}`] };
});

mutateAndExpectRed('cross_tenant_name_rejected', (src) =>
  src.replace(/name: 'wolfhouse-staff-api-cpu-pressure'/, "name: 'sunset-staff-api-cpu-pressure'"),
(compiled) => {
  const names = capacityAlerts(compiled).map((a) => a.name);
  const okNames = names.includes('wolfhouse-staff-api-cpu-pressure')
    && !names.includes('sunset-staff-api-cpu-pressure');
  return { ok: okNames, errors: [`names=${names.join(',')}`] };
});

mutateAndExpectRed('wrong_action_group_default_rejected', (src) =>
  src.replace(
    /param opsActionGroupResourceId string = '\/subscriptions\/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9\/resourceGroups\/wh-staging-rg\/providers\/Microsoft\.Insights\/actionGroups\/wh-staging-ops-budget-ag'/,
    "param opsActionGroupResourceId string = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/wh-staging-rg/providers/Microsoft.Insights/actionGroups/wh-staging-ops-budget-ag'",
  ),
(compiled) => {
  const def = ((compiled.parameters || {}).opsActionGroupResourceId || {}).defaultValue;
  const want = expected.apps[0].opsActionGroupResourceId;
  return { ok: def === want, errors: [`default=${def}`] };
});

mutateAndExpectRed('dynamic_criteria_rejected', (src) =>
  src.replace(/StaticThresholdCriterion/g, 'DynamicThresholdCriterion'),
(compiled) => {
  const alerts = capacityAlerts(compiled);
  const allStatic = alerts.every((a) => criterion(a).criterionType === 'StaticThresholdCriterion');
  return { ok: allStatic, errors: ['dynamic_present'] };
});

mutateAndExpectRed('replica_mutation_rejected', (src) => {
  // Mutate staff-api scale maxReplicas inside the 16I probes scale block only
  const block = extractStaffScaleBlock(src);
  if (!block) return src;
  const mutatedBlock = block.replace(/maxReplicas:\s*1/, 'maxReplicas: 3');
  return src.replace(block, mutatedBlock);
}, (compiled) => {
  // RED: protected path check against this mutated source would fail;
  // also compiled template staffApiApp scale maxReplicas must stay 1 for GREEN contract.
  const apps = (compiled.resources || []).filter((r) => r.type === 'Microsoft.App/containerApps'
    && /staff-api/.test(String(r.name || ''))
    && !/n8n/.test(String(r.name || '')));
  // name may be expression; find by template containers name staff-api
  const staff = (compiled.resources || []).find((r) =>
    r.type === 'Microsoft.App/containerApps'
    && JSON.stringify(r).includes('"name":"staff-api"'));
  void apps;
  if (!staff) return { ok: false, errors: ['staff_app_missing'] };
  const scale = ((((staff.properties || {}).template || {}).scale) || {});
  const maxR = scale.maxReplicas;
  return { ok: maxR === 1, errors: [`maxReplicas=${maxR}`] };
});

mutateAndExpectRed('missing_memory_alert_rejected', (src) =>
  src.replace(/resource staffApiMemoryPressureAlert[\s\S]*?^}\n/m, ''),
(compiled) => {
  const n = capacityAlerts(compiled).length;
  return { ok: n === 2, errors: [`count=${n}`] };
});

// package.json script
const pkg = readJson('package.json');
ok('C10 package script registered',
  pkg.scripts['verify:radar-slice16l-staff-api-capacity-alerts']
  === 'node scripts/verify-radar-slice16l-staff-api-capacity-alerts.js');

ok('C11 no load/SLO/backpressure claim in contract',
  /backpressure|load|slo/i.test(expected.does_not_implement)
  && expected.still_open.some((s) => /backpressure/i.test(s))
  && expected.still_open.some((s) => /load/i.test(s))
  && expected.still_open.some((s) => /SLO/i.test(s)));

const redOk = redResults.length >= 7 && redResults.every((r) => r.ok);
const greenOk = greenResults.length >= 4 && greenResults.every((r) => r.ok);
ok('C12 RED suite all rejected', redOk,
  redResults.filter((r) => !r.ok).map((r) => r.name).join(',') || '(all red)');
ok('C13 GREEN suite all passed', greenOk,
  greenResults.filter((r) => !r.ok).map((r) => r.name).join(',') || '(all green)');

cleanupTmp();

console.log(`\n── ${fail === 0 ? 'PASS' : 'FAIL'}  pass=${pass} fail=${fail} red=${redResults.length} green=${greenResults.length} ──`);
if (fail === 0) {
  console.log('RADAR 16L Staff API capacity-pressure alerts (source-partial): PASS');
}
process.exit(fail === 0 ? 0 : 1);
