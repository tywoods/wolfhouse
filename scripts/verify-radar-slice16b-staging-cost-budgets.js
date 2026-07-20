'use strict';

/**
 * verify:radar-slice16b-staging-cost-budgets — RADAR Slice 16B
 *
 * Offline gate: standalone budget-threshold module + RED/GREEN + secret-free plan.
 * No network, no Azure mutation, no real secrets.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const {
  LOCKS,
  RESOURCE_GROUPS,
  BUDGET_PLANS,
  THRESHOLDS,
  ALLOWED_RESOURCE_TYPES,
  buildSecretFreePlan,
  inspectBicepSource,
  inspectCompiledTemplate,
  assertNotWiredIntoMain,
  runRedCases,
  runGreenCases,
  assertExactStagingScope,
} = require('./lib/radar-slice16b-staging-cost-budgets');

const ROOT = path.join(__dirname, '..');
const MASTER = LOCKS.masterBasis;

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

let pass = 0;
let fail = 0;

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

function secretFree(text, label) {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return { ok: false, detail: `${label} matched ${re}` };
  }
  return { ok: true };
}

function buildBicep() {
  const bicep = path.join(ROOT, LOCKS.bicepModuleRel);
  const out = path.join(ROOT, 'tmp', 'radar-16b-rg-budget-threshold.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const env = {
    ...process.env,
    PATH: `/opt/data/.local/bin:${process.env.PATH || ''}`,
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
  };
  execFileSync('az', ['bicep', 'build', '--file', bicep, '--outfile', out], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function paramsOmitEmail(rel) {
  const raw = readJson(rel);
  const params = raw.parameters || {};
  return !Object.prototype.hasOwnProperty.call(params, 'opsNotifyEmail')
    && !EMAIL_LITERAL.test(JSON.stringify(raw));
}

console.log('verify:radar-slice16b-staging-cost-budgets — RADAR Slice 16B\n');

ok('L1 locks pinned',
  LOCKS.subscriptionId === '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9'
  && LOCKS.liveDeployEnabled === false
  && LOCKS.anomalyDetectionClaimed === false
  && LOCKS.progressClass === 'budget_threshold_partial_progress_only'
  && LOCKS.doesNotImplement === 'anomaly_detection'
  && LOCKS.deploymentMode === 'Incremental'
  && LOCKS.outcomeId === '16B_staging_rg_cost_budget_threshold'
  && LOCKS.gateId === 'G09_cost_controls');

ok('L2 amounts 120/40',
  BUDGET_PLANS['wh-staging-rg'].amountUsd === 120
  && BUDGET_PLANS['luna-sunset-staging-rg'].amountUsd === 40);
ok('L3 thresholds 80/100', THRESHOLDS[0] === 80 && THRESHOLDS[1] === 100);
ok('L4 allowed types exactly two',
  ALLOWED_RESOURCE_TYPES.length === 2
  && ALLOWED_RESOURCE_TYPES.includes('Microsoft.Insights/actionGroups')
  && ALLOWED_RESOURCE_TYPES.includes('Microsoft.Consumption/budgets'));

const bicepText = readText(LOCKS.bicepModuleRel);
const bicepInspect = inspectBicepSource(bicepText);
ok('L5 bicep source structural locks', bicepInspect.ok, bicepInspect.errors.join(','));

let compiled;
try {
  compiled = buildBicep();
  ok('L6 bicep build succeeds', true);
} catch (err) {
  ok('L6 bicep build succeeds', false, String(err && err.stderr || err.message || err).slice(0, 400));
  compiled = null;
}

if (compiled) {
  const c = inspectCompiledTemplate(compiled);
  ok('L7 compiled template only budget+AG', c.ok, c.errors.join(','));
} else {
  ok('L7 compiled template only budget+AG', false, 'no compiled template');
}

const wiring = assertNotWiredIntoMain(ROOT);
ok('L8 not wired into main.bicep', wiring.ok, wiring.errors.join(','));

ok('L9 wh-staging example omits email', paramsOmitEmail(BUDGET_PLANS['wh-staging-rg'].parametersExampleRel));
ok('L10 sunset example omits email', paramsOmitEmail(BUDGET_PLANS['luna-sunset-staging-rg'].parametersExampleRel));

const whParams = readJson(BUDGET_PLANS['wh-staging-rg'].parametersExampleRel);
const sunParams = readJson(BUDGET_PLANS['luna-sunset-staging-rg'].parametersExampleRel);
ok('L11 example amounts locked',
  whParams.parameters.amountUsd.value === 120
  && sunParams.parameters.amountUsd.value === 40
  && whParams.metadata.subscriptionId === LOCKS.subscriptionId
  && sunParams.metadata.resourceGroup === 'luna-sunset-staging-rg');

const plan = buildSecretFreePlan();
const planPath = path.join(ROOT, LOCKS.planFixtureRel);
ok('L12 plan fixture exists', fs.existsSync(planPath));
const planFixture = readJson(LOCKS.planFixtureRel);
ok('L13 plan fixture matches builder',
  JSON.stringify(planFixture) === JSON.stringify(plan)
  || (
    planFixture.outcome_id === plan.outcome_id
    && planFixture.subscriptionId === plan.subscriptionId
    && planFixture.deploymentMode === 'Incremental'
    && planFixture.liveDeployEnabled === false
    && planFixture.anomalyDetectionClaimed === false
    && planFixture.notification_delivery_proof === 'open'
    && planFixture.budgets.length === 2
    && planFixture.budgets[0].amountUsd === 120
    && planFixture.budgets[1].amountUsd === 40
  ));

const planSec = secretFree(JSON.stringify(planFixture), 'plan');
ok('L14 plan secret-free', planSec.ok, planSec.detail);
ok('L15 plan has no email literals', !EMAIL_LITERAL.test(JSON.stringify(planFixture)));

const red = runRedCases();
const redRequired = [
  'wrong_subscription',
  'wrong_resource_group',
  'missing_email',
  'invalid_email',
  'personal_email',
  'changed_amount',
  'changed_thresholds',
  'extra_resources',
  'non_incremental_mode',
];
ok('L16 RED case count >= 9', red.length >= 9);
for (const name of redRequired) {
  const c = red.find((x) => x.name === name);
  ok(`L17 RED ${name}`, c && c.ok, c ? c.errors.join(',') : 'missing');
}

const green = runGreenCases();
ok('L18 GREEN both RGs', green.length === 2 && green.every((g) => g.ok),
  green.map((g) => `${g.name}:${g.errors.join(',')}`).join(';'));

const scopeOk = assertExactStagingScope({
  subscriptionId: LOCKS.subscriptionId,
  resourceGroup: 'wh-staging-rg',
});
const scopeBad = assertExactStagingScope({
  subscriptionId: 'deadbeef-dead-beef-dead-beefdeadbeef',
  resourceGroup: 'wh-staging-rg',
});
ok('L19 scope short-circuit exact sub+RG', scopeOk.ok && scopeBad.ok === false);

const readme = readText(LOCKS.readmeRel);
ok('L20 README states threshold not anomaly',
  /budget-threshold/i.test(readme)
  && /not.*anomaly/i.test(readme)
  && /Incremental/i.test(readme)
  && !/live deploy.*enabled/i.test(readme));

const runtimeDiff = execSync(
  `git diff --name-only ${MASTER} -- scripts/staff-query-api.js database/ infra/azure/staging/main.bicep infra/azure/sunset-staging/main.bicep docker/hermes-staging/`,
  { cwd: ROOT, encoding: 'utf8' },
).trim();
ok('L21 zero runtime mutation vs master', runtimeDiff === '', runtimeDiff);

const pkg = readJson('package.json');
ok('L22 npm script registered',
  pkg.scripts['verify:radar-slice16b-staging-cost-budgets']
  === 'node scripts/verify-radar-slice16b-staging-cost-budgets.js');

const owned = [
  LOCKS.bicepModuleRel,
  LOCKS.readmeRel,
  LOCKS.planFixtureRel,
  'scripts/lib/radar-slice16b-staging-cost-budgets.js',
  'scripts/verify-radar-slice16b-staging-cost-budgets.js',
  'scripts/preflight-radar-slice16b-staging-cost-budgets.js',
  BUDGET_PLANS['wh-staging-rg'].parametersExampleRel,
  BUDGET_PLANS['luna-sunset-staging-rg'].parametersExampleRel,
];
let ownedSec = true;
for (const rel of owned) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    ok(`L23 owned exists ${rel}`, false);
    ownedSec = false;
    continue;
  }
  const text = readText(rel);
  const sec = secretFree(text, rel);
  if (!sec.ok) {
    ok(`L23 secret-free ${rel}`, false, sec.detail);
    ownedSec = false;
  }
}
ok('L23 owned artifacts secret-free', ownedSec);

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('RADAR 16B staging cost budgets: PASS');
console.log(`RED ${red.filter((c) => c.ok).length}/${red.length} GREEN ${green.filter((c) => c.ok).length}/${green.length}`);
