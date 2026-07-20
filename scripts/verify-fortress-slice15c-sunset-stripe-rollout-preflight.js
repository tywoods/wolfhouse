'use strict';

/**
 * verify:fortress-slice15c-sunset-stripe-rollout-preflight — FORTRESS Slice 15C
 *
 * Offline RED/GREEN for Sunset-staging Stripe webhook slug rollout preflight.
 * Never re-runs live Azure / Cost Management / secret resolution.
 * No build, deploy, or mutation.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  LOCKED_SCOPE,
  COMMITTED_COST_BASELINE,
  COST_SPIKE_MULTIPLIER,
  EXPECTED_IAC_DELTA,
  DEPLOY_SEQUENCE_15D,
  sha256Hex,
  evaluateSunsetRolloutPreflight,
  evaluateExpectedWhatIfSurface,
  assertBicepDeclaresWebhookSlug,
  fixturePaths,
} = require('./lib/fortress-slice15c-sunset-rollout-preflight');
const { scanSecretFreeText } = require('./lib/fortress-tenant-identity-boundary');

const paths = fixturePaths(ROOT);
const BICEP_PATH = path.join(ROOT, 'infra/azure/sunset-staging/main.bicep');

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
  console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  return false;
}

function red(id, cond, detail) {
  const passed = ok(`RED ${id}`, cond, detail);
  redResults.push({ id, ok: passed });
  return passed;
}

function green(id, cond, detail) {
  const passed = ok(`GREEN ${id}`, cond, detail);
  greenResults.push({ id, ok: passed });
  return passed;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

console.log('verify:fortress-slice15c-sunset-stripe-rollout-preflight — FORTRESS Slice 15C\n');

// ── Fixtures ───────────────────────────────────────────────────────────────
ok('F1 contract exists', fs.existsSync(paths.contract));
ok('F2 live inventory exists', fs.existsSync(paths.inventory));
ok('F3 findings exists', fs.existsSync(paths.findings));
ok('F4 bicep owner exists', fs.existsSync(BICEP_PATH));

const contract = readJson(paths.contract);
const inventory = readJson(paths.inventory);
const findings = fs.readFileSync(paths.findings, 'utf8');
const bicepSrc = fs.readFileSync(BICEP_PATH, 'utf8');
const inventoryRaw = fs.readFileSync(paths.inventory, 'utf8');
const inventoryHash = sha256Hex(inventoryRaw);

ok('F5 contract slice', contract.slice === 'FORTRESS-15C');
ok('F6 live_mutation false',
  contract.live_mutation === false
  && inventory.live_mutation === false
  && contract.build_deploy_mutation === false);
ok('F7 wolfhouse prod untouched',
  contract.wolfhouse_production_queried === false
  && contract.wolfhouse_production_modified === false
  && inventory.wolfhouse_production_queried === false);
ok('F8 master_basis',
  contract.master_basis === 'f6507cca9a11572911b4f5707e8728ee9c59d181');
ok('F9 scope locks match',
  contract.scope.subscriptionId === LOCKED_SCOPE.subscriptionId
  && contract.scope.resourceGroup === LOCKED_SCOPE.resourceGroup
  && contract.scope.containerApp === LOCKED_SCOPE.containerApp
  && contract.scope.portalHost === LOCKED_SCOPE.portalHost);
ok('F10 inventory hash matches contract lock',
  inventoryHash === contract.hash_locks.live_inventory_sha256,
  `${inventoryHash} != ${contract.hash_locks.live_inventory_sha256}`);
ok('F11 findings mention zero mutation',
  /no build\/deploy\/mutation/i.test(findings) && /Wolfhouse production/i.test(findings));

const secretHits = [
  ...scanSecretFreeText(inventoryRaw),
  ...scanSecretFreeText(JSON.stringify(contract)),
  ...scanSecretFreeText(findings),
];
ok('F12 fixtures secret-free scan', secretHits.length === 0, secretHits.join(','));

// ── GREEN: live inventory + IaC ────────────────────────────────────────────
const liveEval = evaluateSunsetRolloutPreflight(inventory);
green('live_inventory_hash_lock',
  inventoryHash === contract.hash_locks.live_inventory_sha256
  && contract.hash_locks.live_inventory_path.endsWith('slice15c-live-inventory.json'));
green('live_preflight_pass', liveEval.ok,
  liveEval.failures.map((f) => f.code).join(','));
const bicepDecl = assertBicepDeclaresWebhookSlug(bicepSrc);
green('bicep_declares_webhook_slug', bicepDecl.ok,
  JSON.stringify(bicepDecl));
const expectedWhatIf = evaluateExpectedWhatIfSurface(
  contract.bicep_tooling.expected_what_if_surface,
);
green('expected_what_if_surface', expectedWhatIf.ok,
  expectedWhatIf.failures.map((f) => f.code).join(','));
green('cost_below_spike_threshold',
  liveEval.summary.cost_spike === false
  && contract.cost.spike_flagged === false
  && Number(liveEval.summary.cost_amount) <= COMMITTED_COST_BASELINE.amount * COST_SPIKE_MULTIPLIER);
green('15d_sequence_complete',
  DEPLOY_SEQUENCE_15D.length === 8
  && DEPLOY_SEQUENCE_15D[0].id === 'sync_clean_master'
  && DEPLOY_SEQUENCE_15D[2].id === 'deploy_preflight_assert_master'
  && DEPLOY_SEQUENCE_15D[3].id === 'acr_build_sha_tag'
  && /exact merged master SHA/.test(DEPLOY_SEQUENCE_15D[3].notes)
  && DEPLOY_SEQUENCE_15D[7].id === 'rollback_on_health_fail'
  && contract.deploy_sequence_15d_id === '15D_sunset_staging_staff_api_sha_rollout');
green('zero_mutation_contract',
  contract.live_mutation === false
  && contract.build_deploy_mutation === false
  && contract.iac_delta.generic_wolfhouse_prod_iac_edited === false
  && EXPECTED_IAC_DELTA.env_add[0].name === 'STRIPE_WEBHOOK_CLIENT_SLUG'
  && /STRIPE_WEBHOOK_CLIENT_SLUG.*sunset/.test(bicepSrc)
  && !/wh-staff-api|wolfhouse-prod|wh-prod/.test(
    bicepSrc.split("STRIPE_WEBHOOK_CLIENT_SLUG")[1].slice(0, 200),
  ));

// ── RED cases (offline mutations of inventory / what-if) ───────────────────
{
  const bad = clone(inventory);
  bad.container_env.DEFAULT_CLIENT_SLUG = { value: 'wolfhouse-somo' };
  const r = evaluateSunsetRolloutPreflight(bad);
  red('wrong_default_slug',
    !r.ok && r.failures.some((f) => f.code === 'default_client_slug_not_sunset'));
}
{
  const bad = clone(inventory);
  bad.container_env.STRIPE_WEBHOOK_CLIENT_SLUG = { value: 'wolfhouse-somo' };
  const r = evaluateSunsetRolloutPreflight(bad);
  red('wrong_webhook_slug',
    !r.ok && r.failures.some((f) => f.code === 'stripe_webhook_client_slug_not_sunset'));
}
{
  // Live preflight allows absent dedicated slug when DEFAULT=sunset (15B compat).
  // RED: both empty fails when requireRuntimeTenantSlug (post-15D / runtime-ready).
  const bad = clone(inventory);
  delete bad.container_env.DEFAULT_CLIENT_SLUG;
  delete bad.container_env.STRIPE_WEBHOOK_CLIENT_SLUG;
  const r = evaluateSunsetRolloutPreflight(bad, { requireRuntimeTenantSlug: true });
  const liveAllowsPending = evaluateSunsetRolloutPreflight(inventory);
  red('missing_both_slugs_conflict_pair',
    !r.ok
    && r.failures.some((f) => f.code === 'missing_runtime_client_slug')
    && liveAllowsPending.ok
    && liveAllowsPending.summary.iac_pending_webhook_slug === true);
}
{
  const bad = clone(inventory);
  bad.container_env.DEFAULT_CLIENT_SLUG = { value: 'sunset' };
  bad.container_env.STRIPE_WEBHOOK_CLIENT_SLUG = { value: 'other-tenant' };
  const r = evaluateSunsetRolloutPreflight(bad);
  red('conflicting_slugs',
    !r.ok
    && r.failures.some((f) => f.code === 'conflicting_runtime_client_slugs'
      || f.code === 'stripe_webhook_client_slug_not_sunset'));
}
{
  const bad = clone(inventory);
  bad.container_env.STRIPE_WEBHOOK_SKIP_VERIFY = { value: 'true' };
  const r = evaluateSunsetRolloutPreflight(bad);
  red('skip_verify_true',
    !r.ok && r.failures.some((f) => f.code === 'stripe_webhook_skip_verify_true'));
}
{
  const leaked = `${inventoryRaw}\nsk_live_51HxYzExampleSecretValueLeakTest999\n`;
  const hits = scanSecretFreeText(leaked);
  red('secret_leakage_in_inventory', hits.includes('sk_live'));
}
{
  const bad = clone(inventory);
  bad.scope.subscriptionId = '00000000-0000-0000-0000-000000000000';
  const r = evaluateSunsetRolloutPreflight(bad);
  red('wrong_subscription',
    !r.ok && r.failures.some((f) => f.code === 'unexpected_subscription'));
}
{
  const bad = clone(inventory);
  bad.scope.resourceGroup = 'wh-staging-rg';
  const r = evaluateSunsetRolloutPreflight(bad);
  red('wrong_resource_group',
    !r.ok && r.failures.some((f) => f.code === 'unexpected_resource_group'));
}
{
  const bad = clone(inventory);
  bad.scope.containerApp = 'wh-staging-staff-api';
  const r = evaluateSunsetRolloutPreflight(bad);
  red('wrong_app',
    !r.ok && r.failures.some((f) => f.code === 'unexpected_container_app'));
}
{
  const bad = clone(inventory);
  bad.active_revision.healthState = 'Unhealthy';
  const r = evaluateSunsetRolloutPreflight(bad);
  red('unhealthy_revision',
    !r.ok && r.failures.some((f) => f.code === 'unhealthy_revision'));
}
{
  const bad = clone(inventory);
  bad.traffic = [
    { weight: 50, latestRevision: true },
    { weight: 50, revisionName: 'other' },
  ];
  bad.active_revision.trafficWeight = 50;
  const r = evaluateSunsetRolloutPreflight(bad);
  red('ambiguous_traffic',
    !r.ok && r.failures.some((f) => f.code === 'ambiguous_traffic'));
}
{
  const bad = clone(inventory);
  bad.active_revision.image = `${LOCKED_SCOPE.imageRepository}:latest`;
  bad.app.image = bad.active_revision.image;
  const r = evaluateSunsetRolloutPreflight(bad);
  red('mutable_latest_image',
    !r.ok && r.failures.some((f) => f.code === 'mutable_latest_image'));
}
{
  const bad = clone(inventory);
  bad.active_revision.image = `${LOCKED_SCOPE.imageRepository}:drawer-dev`;
  bad.app.image = bad.active_revision.image;
  const r = evaluateSunsetRolloutPreflight(bad);
  red('unknown_image_tag',
    !r.ok && r.failures.some((f) => f.code === 'image_provenance_unknown'));
}
{
  const excessive = evaluateExpectedWhatIfSurface({
    env_add: [
      { name: 'STRIPE_WEBHOOK_CLIENT_SLUG', value: 'sunset' },
      { name: 'STRIPE_WEBHOOK_SKIP_VERIFY', value: 'true' },
    ],
    touched_surfaces: ['secrets', 'rbac'],
    other_changes: ['stripe_account'],
  });
  red('excessive_what_if',
    !excessive.ok
    && excessive.failures.some((f) => f.code.startsWith('excessive_what_if')));
}
{
  const bad = clone(inventory);
  bad.cost = {
    type: 'ActualCost',
    amount: COMMITTED_COST_BASELINE.amount * COST_SPIKE_MULTIPLIER + 1,
    currency: 'USD',
    period: { from: '2026-07-01', to: '2026-07-20', label: 'month-to-date' },
  };
  const r = evaluateSunsetRolloutPreflight(bad);
  red('cost_spike',
    !r.ok && r.failures.some((f) => f.code === 'cost_spike'));
}

// ── Contract RED/GREEN id coverage ─────────────────────────────────────────
const redIds = contract.red_case_ids.map((id) => id.replace(/^RED_/, ''));
const greenIds = contract.green_case_ids.map((id) => id.replace(/^GREEN_/, ''));
ok('C1 red case coverage',
  redIds.every((id) => redResults.some((r) => r.id === id))
  && redResults.length === redIds.length,
  `got=${redResults.map((r) => r.id).join(',')}`);
ok('C2 green case coverage',
  greenIds.every((id) => greenResults.some((r) => r.id === id))
  && greenResults.length === greenIds.length,
  `got=${greenResults.map((r) => r.id).join(',')}`);
ok('C3 all reds passed', redResults.every((r) => r.ok));
ok('C4 all greens passed', greenResults.every((r) => r.ok));
const verifierSrc = fs.readFileSync(__filename, 'utf8');
ok('C5 verifier does not call az/IMDS',
  !/\brequire\(['"]https?['"]\)/.test(verifierSrc)
  && !/\brequire\(['"]child_process['"]\)/.test(verifierSrc)
  && !/\bfetch\s*\(/.test(verifierSrc)
  && !/execSync\s*\(/.test(verifierSrc)
  && !/spawnSync\s*\(/.test(verifierSrc));

// ── Evidence write ─────────────────────────────────────────────────────────
const evidence = {
  schema_version: 1,
  slice: 'FORTRESS-15C',
  generated_at: new Date().toISOString(),
  master_basis: contract.master_basis,
  live_mutation: false,
  wolfhouse_production_queried: false,
  verifier_reruns_live: false,
  live_inventory_sha256: inventoryHash,
  live_preflight: {
    ok: liveEval.ok,
    summary: liveEval.summary,
    failures: liveEval.failures,
  },
  bicep: bicepDecl,
  bicep_tooling: contract.bicep_tooling,
  cost: {
    captured: inventory.cost,
    baseline: COMMITTED_COST_BASELINE,
    spike_flagged: liveEval.summary.cost_spike,
  },
  iac_delta: contract.iac_delta,
  deploy_sequence_15d: DEPLOY_SEQUENCE_15D,
  red: {
    total: redResults.length,
    passed: redResults.filter((r) => r.ok).length,
    cases: redResults,
  },
  green: {
    total: greenResults.length,
    passed: greenResults.filter((r) => r.ok).length,
    cases: greenResults,
  },
  pass,
  fail,
};

fs.writeFileSync(paths.evidence, `${JSON.stringify(evidence, null, 2)}\n`);
ok('E1 evidence written', fs.existsSync(paths.evidence));

console.log(`\n── fortress-slice15c: ${pass} passed, ${fail} failed ──`);
process.exit(fail === 0 ? 0 : 1);
