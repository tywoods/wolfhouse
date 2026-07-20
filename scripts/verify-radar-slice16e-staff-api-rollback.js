'use strict';

/**
 * verify:radar-slice16e-staff-api-rollback — RADAR Slice 16E
 *
 * Independent offline gate. Does NOT import LOCKS, APP_PLANS, buildSecretFreePlans,
 * buildPlannedTraffic, buildRestorePlan, or lib RED generators as oracles.
 * Frozen expected contract owns identity/capture/traffic truth values.
 * Exercises evaluateRollbackRequest + capture/argv APIs with adversarial REDs.
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
  captureLiveInventory,
  buildLiveCaptureArgvPlan,
  buildTrafficSetArgv,
  assertArgvReadOnlyCapture,
  assertSafeArgvTokens,
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

function confirmToken(prefix, containerApp, targetRevisionName) {
  return `${prefix}:${containerApp}:${targetRevisionName}`;
}

function reqFromPlanApp(app, expected) {
  return {
    subscriptionId: expected.subscriptionId,
    resourceGroup: app.resourceGroup,
    containerApp: app.containerApp,
    currentRevisionName: app.currentRevisionName,
    targetRevisionName: app.targetRevisionName,
    targetImage: app.targetImage,
    targetImageSha: app.targetImageSha,
    confirmationToken: app.confirmationToken,
    mutations: [{ kind: expected.allowedMutation }],
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

function withTargetRev(base, patch) {
  return {
    ...base,
    inventory: {
      ...base.inventory,
      revisions: base.inventory.revisions.map((rev) => (
        rev.name === base.targetRevisionName ? { ...rev, ...patch } : rev
      )),
    },
  };
}

console.log('verify:radar-slice16e-staff-api-rollback — RADAR Slice 16E (independent)\n');

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
  && expected.liveExecuteEnabled === false
  && expected.liveCaptureExecuteEnabled === false
  && expected.allowedMutation === 'traffic_weight'
  && expected.requiredHealthState === 'Healthy'
  && expected.requiredRunningState === 'Running'
  && expected.requiredProvisioningState === 'Provisioned'
  && Array.isArray(expected.captureStepIds)
  && expected.captureStepIds.length === 4
  && Array.isArray(expected.apps)
  && expected.apps.length === 2
  && Array.isArray(expected.required_red_names)
  && expected.required_red_names.length >= 30);

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
  ok(`L4b app[${i}] provisioningState exact`,
    got
    && got.inventory
    && got.inventory.revisions.every((r) => r.provisioningState === expected.requiredProvisioningState)
    && got.inventory.revisions.every((r) => r.runningState === expected.requiredRunningState)
    && got.inventory.revisions.every((r) => r.healthState === expected.requiredHealthState)
    && got.inventory.revisions.every((r) => r.active === true));
}

const whApp = plan.apps.find((a) => a.containerApp === 'wh-staging-staff-api');
const sunApp = plan.apps.find((a) => a.containerApp === 'luna-sunset-staging-staff-api');
const whRepo = expected.apps[0].imageRepository;

{
  const importMatch = readText(VERIFY_REL).match(
    /const\s*\{([^}]+)\}\s*=\s*require\('\.\/lib\/radar-slice16e-staff-api-rollback'\)/,
  );
  const imported = importMatch ? importMatch[1] : '';
  ok('L4c verifier does not import LOCKS/APP_PLANS builders as oracle',
    importMatch
    && !/\bLOCKS\b/.test(imported)
    && !/\bAPP_PLANS\b/.test(imported)
    && !/\bSUBSCRIPTION_ID\b/.test(imported)
    && !/\bbuildSecretFreePlans\b/.test(imported)
    && !/\bbuildPlannedTraffic\b/.test(imported)
    && !/\bbuildRestorePlan\b/.test(imported)
    && !/\brunRedCases\b/.test(imported)
    && !/\bexpectedConfirmationToken\b/.test(imported),
    imported.slice(0, 200));
}

// --- GREEN plans ---
for (const app of [whApp, sunApp]) {
  const result = evaluateRollbackRequest(reqFromPlanApp(app, expected));
  const good = result.ok
    && result.record
    && result.record.secretFree === true
    && result.record.mutation === 'traffic_weight'
    && result.record.liveExecuted === false
    && result.restorePlan
    && result.restorePlan.mode === 'restore_prior_traffic_weights'
    && Array.isArray(result.plannedTraffic)
    && result.plannedTraffic.some((t) => t.revisionName === app.targetRevisionName && t.weight === 100)
    && result.trafficSnapshotBefore.some((t) => t.revisionName === app.currentRevisionName && t.weight === 100)
    && Array.isArray(result.rollbackTrafficSetArgv)
    && result.rollbackTrafficSetArgv.includes('--revision-weight')
    && Array.isArray(result.restoreTrafficSetArgv)
    && result.restoreTrafficSetArgv[4] === 'set';
  pushGreen(`green_plan_${app.containerApp}`, good,
    good ? null : `errors=${result.errors.join(',')}`);
}

// --- RED suite (adversarial; independent of lib generators) ---
{
  const base = reqFromPlanApp(whApp, expected);

  let r = evaluateRollbackRequest({
    ...base,
    subscriptionId: '00000000-0000-0000-0000-000000000000',
  });
  pushRed('wrong_subscription', !r.ok && r.errors.includes('wrong_subscription'));

  r = evaluateRollbackRequest({ ...base, resourceGroup: 'other-staging-rg' });
  pushRed('wrong_resource_group', !r.ok && r.errors.includes('wrong_resource_group'));

  r = evaluateRollbackRequest({ ...base, containerApp: 'wh-staging-hermes' });
  pushRed('wrong_app', !r.ok && r.errors.includes('wrong_app'));

  r = evaluateRollbackRequest({ ...base, resourceGroup: 'wh-prod-rg' });
  pushRed('production_marker',
    !r.ok
    && (r.errors.includes('production_marker_rejected') || r.errors.includes('wrong_resource_group')));

  r = evaluateRollbackRequest({
    ...base,
    targetImage: `${whRepo}:latest`,
  });
  pushRed('mutable_tag', !r.ok && r.errors.includes('mutable_tag_rejected'));

  r = evaluateRollbackRequest(withTargetRev(base, {
    containerApp: 'luna-sunset-staging-staff-api',
  }));
  pushRed('cross_app_revision', !r.ok && r.errors.includes('cross_app_revision'));

  r = evaluateRollbackRequest(withTargetRev(base, { healthState: 'Unhealthy' }));
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

  r = evaluateRollbackRequest({
    ...base,
    inventory: { ...base.inventory, subscriptionId: '' },
  });
  pushRed('missing_inventory_subscription',
    !r.ok && r.errors.includes('missing_inventory_subscription'));

  r = evaluateRollbackRequest({
    ...base,
    inventory: { ...base.inventory, resourceGroup: '' },
  });
  pushRed('missing_inventory_resource_group',
    !r.ok && r.errors.includes('missing_inventory_resource_group'));

  r = evaluateRollbackRequest({
    ...base,
    inventory: { ...base.inventory, containerApp: '' },
  });
  pushRed('missing_inventory_container_app',
    !r.ok && r.errors.includes('missing_inventory_container_app'));

  r = evaluateRollbackRequest({
    ...base,
    inventory: {
      ...base.inventory,
      subscriptionId: '11111111-1111-1111-1111-111111111111',
    },
  });
  pushRed('inventory_subscription_mismatch',
    !r.ok && r.errors.includes('inventory_subscription_mismatch'));

  r = evaluateRollbackRequest({
    ...base,
    inventory: { ...base.inventory, resourceGroup: 'luna-sunset-staging-rg' },
  });
  pushRed('inventory_resource_group_mismatch',
    !r.ok && r.errors.includes('inventory_resource_group_mismatch'));

  r = evaluateRollbackRequest({
    ...base,
    inventory: { ...base.inventory, containerApp: 'luna-sunset-staging-staff-api' },
  });
  pushRed('inventory_container_app_mismatch',
    !r.ok && r.errors.includes('inventory_container_app_mismatch'));

  r = evaluateRollbackRequest(withTargetRev(base, { containerApp: '' }));
  pushRed('missing_target_ownership', !r.ok && r.errors.includes('missing_target_ownership'));

  r = evaluateRollbackRequest(withTargetRev(base, { image: '' }));
  pushRed('missing_target_image', !r.ok && r.errors.includes('missing_target_image'));

  // Prove OR-fallback is gone: Running/Provisioned/Healthy alone must not satisfy active.
  r = evaluateRollbackRequest(withTargetRev(base, {
    active: false,
    runningState: 'Running',
    provisioningState: 'Provisioned',
    healthState: 'Healthy',
  }));
  pushRed('target_not_active',
    !r.ok && r.errors.includes('target_not_active'));

  r = evaluateRollbackRequest(withTargetRev(base, { runningState: 'RunningAtMaxScale' }));
  pushRed('target_not_running', !r.ok && r.errors.includes('target_not_running'));

  r = evaluateRollbackRequest(withTargetRev(base, { provisioningState: 'Pending' }));
  pushRed('target_not_provisioned', !r.ok && r.errors.includes('target_not_provisioned'));

  r = evaluateRollbackRequest({
    ...base,
    inventory: {
      ...base.inventory,
      traffic: [{ latestRevision: true, weight: 100 }],
    },
  });
  pushRed('unsupported_traffic_snapshot_latest',
    !r.ok && r.errors.includes('unsupported_traffic_snapshot'));

  r = evaluateRollbackRequest({
    ...base,
    inventory: {
      ...base.inventory,
      traffic: [{ label: 'production', weight: 100 }],
    },
  });
  pushRed('unsupported_traffic_snapshot_label',
    !r.ok && r.errors.includes('unsupported_traffic_snapshot'));

  r = evaluateRollbackRequest({
    ...base,
    inventory: { ...base.inventory, traffic: 'not-an-array' },
  });
  pushRed('malformed_traffic', !r.ok && r.errors.includes('malformed_traffic'));

  r = evaluateRollbackRequest({
    ...base,
    inventory: {
      ...base.inventory,
      traffic: [
        { revisionName: base.currentRevisionName, weight: 50 },
        { revisionName: base.currentRevisionName, weight: 50 },
      ],
    },
  });
  pushRed('duplicate_traffic_revision',
    !r.ok && r.errors.includes('duplicate_traffic_revision'));

  r = evaluateRollbackRequest({
    ...base,
    inventory: {
      ...base.inventory,
      traffic: [
        { revisionName: base.currentRevisionName, weight: Number.NaN },
        { revisionName: base.targetRevisionName, weight: 100 },
      ],
    },
  });
  pushRed('non_finite_traffic_weight',
    !r.ok && r.errors.includes('non_finite_traffic_weight'));

  r = evaluateRollbackRequest({
    ...base,
    inventory: {
      ...base.inventory,
      traffic: [
        { revisionName: base.currentRevisionName, weight: 40 },
        { revisionName: base.targetRevisionName, weight: 40 },
      ],
    },
  });
  pushRed('non_100_traffic_weights',
    !r.ok && r.errors.includes('non_100_traffic_weights'));

  r = evaluateRollbackRequest({
    ...base,
    inventory: {
      ...base.inventory,
      traffic: [
        { revisionName: 'evil;rm -rf', weight: 100 },
      ],
    },
  });
  pushRed('shell_metacharacter_revision',
    !r.ok && r.errors.includes('shell_metacharacter_rejected'));

  {
    const evil = buildTrafficSetArgv({
      resourceGroup: whApp.resourceGroup,
      containerApp: whApp.containerApp,
      traffic: [{ revisionName: 'rev$(reboot)', weight: 100 }],
      mode: 'rollback',
    });
    pushRed('argv_expansion_rejected',
      !evil.ok
      && (evil.errors.includes('argv_expansion_rejected')
        || evil.errors.includes('shell_metacharacter_rejected')));
  }

  {
    const noRunner = captureLiveInventory({
      subscriptionId: expected.subscriptionId,
      resourceGroup: whApp.resourceGroup,
      containerApp: whApp.containerApp,
    });
    pushRed('live_capture_runner_required',
      !noRunner.ok
      && noRunner.errors.includes('live_capture_runner_required')
      && noRunner.executed === false
      && noRunner.azureCalls === 0);
  }

  {
    const mut = assertArgvReadOnlyCapture([
      'az', 'containerapp', 'ingress', 'traffic', 'set',
      '-g', whApp.resourceGroup, '-n', whApp.containerApp,
      '--revision-weight', 'x=100',
    ]);
    pushRed('capture_mutation_argv_rejected',
      !mut.ok && mut.errors.includes('capture_mutation_argv_rejected'));
  }
}

// Capture argv contract + injectable runner GREEN
{
  const planCap = buildLiveCaptureArgvPlan({
    resourceGroup: whApp.resourceGroup,
    containerApp: whApp.containerApp,
  });
  const ids = planCap.ok ? planCap.steps.map((s) => s.id) : [];
  const argvOk = planCap.ok
    && ids.join(',') === expected.captureStepIds.join(',')
    && planCap.shell === false
    && planCap.mutationExecution === false
    && planCap.steps.every((s) => {
      const ro = assertArgvReadOnlyCapture(s.argv);
      const safe = assertSafeArgvTokens(s.argv);
      return ro.ok && safe.ok && s.argv[0] === 'az' && !s.argv.includes('set');
    });

  const fakeByStep = {
    account_show: JSON.stringify({ id: expected.subscriptionId }),
    containerapp_show: JSON.stringify({ name: whApp.containerApp }),
    revision_list: JSON.stringify(whApp.inventory.revisions.map((rev) => ({
      name: rev.name,
      properties: {
        active: rev.active,
        runningState: rev.runningState,
        healthState: rev.healthState,
        provisioningState: rev.provisioningState,
        template: { containers: [{ image: rev.image }] },
      },
    }))),
    ingress_traffic_show: JSON.stringify(whApp.inventory.traffic),
  };
  let runnerCalls = 0;
  const captured = captureLiveInventory({
    subscriptionId: expected.subscriptionId,
    resourceGroup: whApp.resourceGroup,
    containerApp: whApp.containerApp,
  }, {
    runner: (argv) => {
      runnerCalls += 1;
      const step = planCap.steps.find((s) => s.argv.join('\0') === argv.join('\0'));
      if (!step) throw new Error(`unexpected argv ${argv.join(' ')}`);
      return { stdout: fakeByStep[step.id] };
    },
  });
  pushGreen('green_capture_injectable_runner',
    argvOk
    && captured.ok
    && captured.executed === false
    && captured.shell === false
    && captured.mutationExecution === false
    && runnerCalls === 4
    && captured.inventory
    && captured.inventory.subscriptionId === expected.subscriptionId
    && captured.inventory.containerApp === whApp.containerApp
    && Array.isArray(captured.inventory.traffic)
    && captured.inventory.traffic.reduce((s, t) => s + t.weight, 0) === 100,
    captured.ok ? null : `errors=${(captured.errors || []).join(',')}`);
}

{
  const rb = buildTrafficSetArgv({
    resourceGroup: whApp.resourceGroup,
    containerApp: whApp.containerApp,
    traffic: [
      { revisionName: whApp.targetRevisionName, weight: 100 },
      { revisionName: whApp.currentRevisionName, weight: 0 },
    ],
    mode: 'rollback',
  });
  const rs = buildTrafficSetArgv({
    resourceGroup: whApp.resourceGroup,
    containerApp: whApp.containerApp,
    traffic: whApp.inventory.traffic,
    mode: 'restore',
  });
  pushGreen('green_traffic_set_argv_rollback_restore',
    rb.ok && rs.ok
    && rb.executed === false && rs.executed === false
    && rb.argv[0] === 'az'
    && rb.argv.includes('set')
    && rb.argv.includes('--revision-weight')
    && rb.argv.includes(`${whApp.targetRevisionName}=100`)
    && rs.argv.includes(`${whApp.currentRevisionName}=100`)
    && !rb.argv.some((t) => /[;&|`$]/.test(t)),
    rb.ok ? null : `rb=${rb.errors.join(',')}`);
}

{
  const base = reqFromPlanApp(whApp, expected);
  const inv = deepClone(base.inventory);
  inv.traffic = [
    {
      revisionName: whApp.currentRevisionName,
      weight: 100,
      latestRevision: true,
      label: 'active',
    },
    { revisionName: whApp.targetRevisionName, weight: 0 },
  ];
  const r = evaluateRollbackRequest({ ...base, inventory: inv });
  const preserved = r.ok
    && r.trafficSnapshotBefore.some((t) => (
      t.revisionName === whApp.currentRevisionName
      && t.latestRevision === true
      && t.label === 'active'
      && t.weight === 100
    ))
    && Array.isArray(r.restoreTrafficSetArgv)
    && r.restoreTrafficSetArgv.includes(`${whApp.currentRevisionName}=100`);
  pushGreen('green_preserve_latest_with_revision_name', preserved,
    preserved ? null : `errors=${r.errors.join(',')}`);
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
    '--confirm', confirmToken(
      expected.confirmationPrefix,
      app.containerApp,
      app.targetRevisionName,
    ),
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

const libSrc = readText(LIB_REL);
ok('L7b lib capture uses no shell and hard-disables live execute',
  /buildLiveCaptureArgvPlan/.test(libSrc)
  && /captureLiveInventory/.test(libSrc)
  && /buildTrafficSetArgv/.test(libSrc)
  && /liveCaptureExecuteEnabled:\s*false/.test(libSrc)
  && !/execSync\(/.test(libSrc)
  && !/spawnSync\(['"]az['"]/.test(libSrc)
  && !/shell:\s*true/.test(libSrc));

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
