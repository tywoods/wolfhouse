'use strict';

/**
 * verify:radar-slice16e-staff-api-rollback — RADAR Slice 16E
 *
 * Offline RED/GREEN gate for staging-only ACA Staff API traffic-weight
 * rollback runbook/preflight. Independent of lib RED generators for the
 * primary suite (re-evaluates via evaluateRollbackRequest + CLI spawn).
 * No network, no Azure mutation, no real secrets.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MASTER = 'acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b';

const CONTRACT_REL = 'fixtures/radar-operations/slice16e-expected-contract.json';
const PLAN_REL = 'fixtures/radar-operations/slice16e-rollback-plans.json';
const LIB_REL = 'scripts/lib/radar-slice16e-staff-api-rollback.js';
const PREFLIGHT_REL = 'scripts/preflight-radar-slice16e-staff-api-rollback.js';
const VERIFY_REL = 'scripts/verify-radar-slice16e-staff-api-rollback.js';
const RUNBOOK_REL = 'docs/RADAR-16E-STAFF-API-ROLLBACK-RUNBOOK.md';

const {
  evaluateRollbackRequest,
  expectedConfirmationToken,
  ALLOWED_MUTATION,
  APP_PLANS,
  SUBSCRIPTION_ID,
} = require('./lib/radar-slice16e-staff-api-rollback');

const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]{20,}/,
  /whsec_[A-Za-z0-9]+/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /password["']?\s*[:=]\s*["'][^"']{8,}/i,
  /ACCOUNT_KEY["']?\s*[:=]\s*["'][^"']{16,}/i,
  new RegExp(String.raw`postgres(?:ql)?:` + String.raw`\/\/[^\s"']+`, 'i'),
];

let pass = 0;
let fail = 0;
const redResults = [];
const greenResults = [];

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

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function reqFromPlanApp(app) {
  return {
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: app.resourceGroup,
    containerApp: app.containerApp,
    currentRevisionName: app.currentRevisionName,
    targetRevisionName: app.targetRevisionName,
    targetImage: app.targetImage,
    targetImageSha: app.targetImageSha,
    confirmationToken: app.confirmationToken,
    mutations: [{ kind: ALLOWED_MUTATION }],
    inventory: deepClone(app.inventory),
    mode: 'plan',
  };
}

function pushRed(name, cond, detail) {
  const passed = !!cond;
  redResults.push({ name, expect: 'RED', ok: passed, detail: detail || null });
  ok(`RED ${name}`, passed, detail);
}

function pushGreen(name, cond, detail) {
  const passed = !!cond;
  greenResults.push({ name, expect: 'GREEN', ok: passed, detail: detail || null });
  ok(`GREEN ${name}`, passed, detail);
}

function spawnPreflight(argvExtra) {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, PREFLIGHT_REL), ...argvExtra],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `/opt/data/.local/bin:${process.env.PATH || ''}`,
      },
      encoding: 'utf8',
    },
  );
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  let report = null;
  function tryParseReport(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || !trimmed.includes('azureCalls')) return null;
    // Refusal: one-line JSON. Success: pretty JSON then a PASS trailer line.
    const candidates = [trimmed, ...trimmed.split(/\r?\n/).map((l) => l.trim())];
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      candidates.unshift(trimmed.slice(start, end + 1));
    }
    for (const t of candidates) {
      if (!t.startsWith('{') || !t.includes('azureCalls')) continue;
      try {
        return JSON.parse(t);
      } catch (_) { /* ignore */ }
    }
    return null;
  }
  report = tryParseReport(result.stderr) || tryParseReport(result.stdout);
  let azureCalls = report && typeof report.azureCalls === 'number' ? report.azureCalls : null;
  if (azureCalls == null) {
    const m = combined.match(/"azureCalls"\s*:\s*(\d+)/);
    if (m) azureCalls = Number(m[1]);
  }
  return { status: result.status, combined, report, azureCalls };
}

console.log('verify:radar-slice16e-staff-api-rollback — RADAR Slice 16E\n');

const expected = readJson(CONTRACT_REL);
ok('L1 frozen contract shape',
  expected.schema_version === 1
  && expected.slice === 'RADAR-16E'
  && expected.master_basis === MASTER
  && expected.branch === 'radar/slice-16e-staff-api-rollback-runbook'
  && expected.outcome_id === '16E_staff_api_aca_traffic_rollback_runbook'
  && expected.gate_id === 'G07_rollback_incident_runbooks'
  && expected.progress_class === 'source_partial_progress_only'
  && expected.liveRollbackEnabled === false
  && expected.allowedMutation === 'traffic_weight'
  && Array.isArray(expected.apps)
  && expected.apps.length === 2
  && Array.isArray(expected.required_red_names)
  && expected.required_red_names.length >= 11);

const plan = readJson(PLAN_REL);
ok('L2 plan fixture pins',
  plan.slice === expected.slice
  && plan.master_basis === expected.master_basis
  && plan.subscriptionId === expected.subscriptionId
  && plan.liveRollbackEnabled === false
  && plan.allowedMutation === expected.allowedMutation
  && Array.isArray(plan.apps)
  && plan.apps.length === 2);

const planSec = secretFree(JSON.stringify(plan), 'plan');
ok('L3 plan secret-free', planSec.ok, planSec.detail);

for (let i = 0; i < expected.apps.length; i += 1) {
  const want = expected.apps[i];
  const got = plan.apps[i];
  ok(`L4 app[${i}] scope lock`,
    got
    && got.resourceGroup === want.resourceGroup
    && got.containerApp === want.containerApp
    && got.imageRepository === want.imageRepository);
}

const whApp = plan.apps.find((a) => a.containerApp === 'wh-staging-staff-api');
const sunApp = plan.apps.find((a) => a.containerApp === 'luna-sunset-staging-staff-api');

// --- GREEN plans ---
for (const app of [whApp, sunApp]) {
  const result = evaluateRollbackRequest(reqFromPlanApp(app));
  const good = result.ok
    && result.record
    && result.record.secretFree === true
    && result.record.mutation === 'traffic_weight'
    && result.record.liveExecuted === false
    && result.restorePlan
    && result.restorePlan.mode === 'restore_prior_traffic_weights'
    && Array.isArray(result.plannedTraffic)
    && result.plannedTraffic.some((t) => t.revisionName === app.targetRevisionName && t.weight === 100)
    && result.trafficSnapshotBefore.some((t) => t.revisionName === app.currentRevisionName && t.weight === 100);
  pushGreen(`green_plan_${app.containerApp}`, good,
    good ? null : `errors=${result.errors.join(',')}`);
}

// --- RED suite (independent cases; do not call lib runRedCases) ---
{
  const base = reqFromPlanApp(whApp);

  let r = evaluateRollbackRequest({
    ...base,
    subscriptionId: '00000000-0000-0000-0000-000000000000',
  });
  pushRed('wrong_subscription', !r.ok && r.errors.includes('wrong_subscription'));

  r = evaluateRollbackRequest({ ...base, resourceGroup: 'other-staging-rg' });
  pushRed('wrong_resource_group', !r.ok && r.errors.includes('wrong_resource_group'));

  r = evaluateRollbackRequest({ ...base, containerApp: 'wh-staging-hermes' });
  pushRed('wrong_app', !r.ok && r.errors.includes('wrong_app'));

  r = evaluateRollbackRequest({
    ...base,
    resourceGroup: 'wh-prod-rg',
  });
  pushRed('production_marker',
    !r.ok
    && (r.errors.includes('production_marker_rejected') || r.errors.includes('wrong_resource_group')));

  r = evaluateRollbackRequest({
    ...base,
    targetImage: `${APP_PLANS['wh-staging-staff-api'].imageRepository}:latest`,
  });
  pushRed('mutable_tag', !r.ok && r.errors.includes('mutable_tag_rejected'));

  r = evaluateRollbackRequest({
    ...base,
    inventory: {
      ...base.inventory,
      revisions: base.inventory.revisions.map((rev) => (
        rev.name === base.targetRevisionName
          ? { ...rev, containerApp: 'luna-sunset-staging-staff-api' }
          : rev
      )),
    },
  });
  pushRed('cross_app_revision', !r.ok && r.errors.includes('cross_app_revision'));

  r = evaluateRollbackRequest({
    ...base,
    inventory: {
      ...base.inventory,
      revisions: base.inventory.revisions.map((rev) => (
        rev.name === base.targetRevisionName
          ? { ...rev, healthState: 'Unhealthy' }
          : rev
      )),
    },
  });
  pushRed('unhealthy_target', !r.ok && r.errors.includes('unhealthy_target'));

  r = evaluateRollbackRequest({ ...base, confirmationToken: '' });
  pushRed('missing_confirmation', !r.ok && r.errors.includes('missing_confirmation'));

  r = evaluateRollbackRequest({
    ...base,
    mutations: [{ kind: 'traffic_weight' }, { kind: 'secrets' }],
  });
  pushRed('extra_mutation', !r.ok && r.errors.includes('extra_mutation'));

  r = evaluateRollbackRequest({
    ...base,
    plannedTraffic: [
      { revisionName: base.targetRevisionName, weight: 70 },
      { revisionName: base.currentRevisionName, weight: 30 },
    ],
  });
  pushRed('non_100_target_weights', !r.ok && r.errors.includes('non_100_target_weights'));

  r = evaluateRollbackRequest({ ...base, inventory: null });
  pushRed('failed_verification', !r.ok && r.errors.includes('failed_verification'));
}

for (const name of expected.required_red_names) {
  const c = redResults.find((x) => x.name === name);
  ok(`L5 required RED present ${name}`, c && c.ok, c ? c.detail : 'missing');
}
for (const name of expected.required_green_names) {
  const c = greenResults.find((x) => x.name === name);
  ok(`L6 required GREEN present ${name}`, c && c.ok, c ? c.detail : 'missing');
}

// CLI RED / GREEN
const invWh = expected.sample_inventory_rels[0];
const cliBase = [
  '--resource-group', whApp.resourceGroup,
  '--container-app', whApp.containerApp,
  '--current-revision', whApp.currentRevisionName,
  '--target-revision', whApp.targetRevisionName,
  '--target-image', whApp.targetImage,
  '--target-image-sha', whApp.targetImageSha,
  '--confirm', whApp.confirmationToken,
  '--inventory-json', invWh,
];

{
  const live = spawnPreflight(['--live', ...cliBase]);
  pushRed('cli_live',
    live.status !== 0 && live.azureCalls === 0 && live.report && live.report.refused === true,
    `status=${live.status} azureCalls=${live.azureCalls}`);

  const exec = spawnPreflight(['--execute', ...cliBase]);
  pushRed('cli_execute',
    exec.status !== 0 && exec.azureCalls === 0 && exec.report && exec.report.refused === true);

  const unk = spawnPreflight([...cliBase, '--explode']);
  pushRed('cli_unknown_arg',
    unk.status !== 0 && unk.azureCalls === 0 && unk.report && unk.report.refused === true);

  const pos = spawnPreflight([...cliBase, 'positional-junk']);
  pushRed('cli_positional',
    pos.status !== 0 && pos.azureCalls === 0 && pos.report && pos.report.refused === true);

  const prod = spawnPreflight([
    '--resource-group', 'wh-prod-rg',
    '--container-app', whApp.containerApp,
    '--current-revision', whApp.currentRevisionName,
    '--target-revision', whApp.targetRevisionName,
    '--target-image', whApp.targetImage,
    '--target-image-sha', whApp.targetImageSha,
    '--confirm', whApp.confirmationToken,
    '--inventory-json', invWh,
  ]);
  pushRed('cli_production_marker',
    prod.status !== 0 && prod.azureCalls === 0 && prod.report && prod.report.refused === true);
}

for (const app of [whApp, sunApp]) {
  const invRel = app.containerApp.startsWith('wh-')
    ? expected.sample_inventory_rels[0]
    : expected.sample_inventory_rels[1];
  const r = spawnPreflight([
    '--resource-group', app.resourceGroup,
    '--container-app', app.containerApp,
    '--current-revision', app.currentRevisionName,
    '--target-revision', app.targetRevisionName,
    '--target-image', app.targetImage,
    '--target-image-sha', app.targetImageSha,
    '--confirm', expectedConfirmationToken({
      containerApp: app.containerApp,
      targetRevisionName: app.targetRevisionName,
    }),
    '--inventory-json', invRel,
  ]);
  const good = r.status === 0
    && r.azureCalls === 0
    && /PASS \(no live calls\)/.test(r.combined)
    && r.report
    && r.report.ok === true
    && r.report.liveExecuted === false
    && r.report.mutation === 'traffic_weight'
    && r.report.restorePlan;
  pushGreen(`cli_green_${app.containerApp}`, good,
    good ? null : `status=${r.status} azureCalls=${r.azureCalls} ${(r.combined || '').slice(0, 180)}`);
}

const preflightSrc = readText(PREFLIGHT_REL);
ok('L7 preflight has no Azure dispatch',
  !/management\.azure\.com/.test(preflightSrc)
  && !/\bexecFileSync\b|\bexecSync\b|\bspawnSync\b/.test(preflightSrc)
  && /azureCalls/.test(preflightSrc)
  && /forbidden_flag/.test(preflightSrc)
  && /--live/.test(preflightSrc)
  && /--execute/.test(preflightSrc));

const runbook = readText(RUNBOOK_REL);
ok('L8 runbook traffic-only + confirmation + both apps + open drill',
  /traffic.?weight/i.test(runbook)
  && /I-CONFIRM-TRAFFIC-ROLLBACK/.test(runbook)
  && /wh-staging-staff-api/.test(runbook)
  && /luna-sunset-staging-staff-api/.test(runbook)
  && /16E_DRILL_live_rollback_restore/.test(runbook)
  && /never.*(image|env|secret|scal|database|restart|delete)/i.test(runbook)
  && /do not execute/i.test(runbook));

const runtimeDiff = execFileSync(
  'git',
  ['diff', '--name-only', MASTER, '--',
    'scripts/staff-query-api.js', 'database/',
    'infra/azure/staging/main.bicep', 'infra/azure/sunset-staging/main.bicep',
    'docker/hermes-staging/'],
  { cwd: ROOT, encoding: 'utf8' },
).trim();
ok('L9 zero runtime mutation vs master', runtimeDiff === '', runtimeDiff);

const pkg = readJson('package.json');
ok('L10 npm scripts registered',
  pkg.scripts['verify:radar-slice16e-staff-api-rollback']
    === 'node scripts/verify-radar-slice16e-staff-api-rollback.js'
  && pkg.scripts['preflight:radar-slice16e-staff-api-rollback']
    === 'node scripts/preflight-radar-slice16e-staff-api-rollback.js');

const owned = [
  CONTRACT_REL,
  PLAN_REL,
  LIB_REL,
  PREFLIGHT_REL,
  VERIFY_REL,
  RUNBOOK_REL,
  ...expected.sample_inventory_rels,
];
let ownedSec = true;
for (const rel of owned) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    ok(`L11 owned exists ${rel}`, false);
    ownedSec = false;
    continue;
  }
  const sec = secretFree(readText(rel), rel);
  if (!sec.ok) {
    ok(`L11 secret-free ${rel}`, false, sec.detail);
    ownedSec = false;
  }
}
ok('L11 owned artifacts secret-free', ownedSec);

const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
const g07 = matrix.gates.find((g) => g.id === 'G07_rollback_incident_runbooks');
ok('L12 G07 source-partial via 16E',
  g07
  && g07.verdict === 'partial'
  && g07.progress_class === 'source_partial_progress_only'
  && /16E/.test(g07.rationale)
  && matrix.slice_16e_selection
  && matrix.slice_16e_selection.outcome_id === expected.outcome_id
  && matrix.slice_16e_selection.open_drill === expected.open_drill);

const redPass = redResults.filter((c) => c.ok).length;
const greenPass = greenResults.filter((g) => g.ok).length;

console.log(`\nResult: ${pass} passed, ${fail} failed`);
console.log(`RED ${redPass}/${redResults.length} GREEN ${greenPass}/${greenResults.length}`);
if (fail > 0) process.exit(1);
console.log('RADAR 16E staff API rollback runbook: PASS');
console.log(`RED ${redPass}/${redResults.length} GREEN ${greenPass}/${greenResults.length}`);
