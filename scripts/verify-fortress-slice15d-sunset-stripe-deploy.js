'use strict';

/**
 * verify:fortress-slice15d-sunset-stripe-deploy — FORTRESS Slice 15D
 *
 * Offline RED/GREEN for Sunset-staging Staff API SHA deploy + webhook slug.
 * Never re-runs live Azure / Cost Management / secret resolution / build / deploy.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  LOCKED_SCOPE,
  COMMITTED_COST_BASELINE,
  COST_SPIKE_MULTIPLIER,
  COST_BASELINE_15C,
  MASTER_BASIS,
  PRIOR_REVISION,
  PRIOR_IMAGE,
  ACTIVE_REVISION,
  EXPECTED_IMAGE,
  ACR_RUN_ID,
  IMAGE_DIGEST,
  DEPLOY_SEQUENCE_15D,
  FORBIDDEN_MUTATION_SURFACE,
  sha256Hex,
  evaluatePostDeployInventory,
  evaluateCostDeltaVs15c,
  assertBicepDeclaresWebhookSlug,
  fixturePaths,
} = require('./lib/fortress-slice15d-sunset-stripe-deploy');
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

console.log('verify:fortress-slice15d-sunset-stripe-deploy — FORTRESS Slice 15D\n');

ok('F1 contract exists', fs.existsSync(paths.contract));
ok('F2 live inventory exists', fs.existsSync(paths.inventory));
ok('F3 findings exists', fs.existsSync(paths.findings));
ok('F4 evidence exists', fs.existsSync(paths.evidence));
ok('F5 bicep owner exists', fs.existsSync(BICEP_PATH));

const contract = readJson(paths.contract);
const inventory = readJson(paths.inventory);
const evidence = readJson(paths.evidence);
const findings = fs.readFileSync(paths.findings, 'utf8');
const bicepSrc = fs.readFileSync(BICEP_PATH, 'utf8');
const inventoryRaw = fs.readFileSync(paths.inventory, 'utf8');
const inventoryHash = sha256Hex(inventoryRaw);

ok('F6 contract slice', contract.slice === 'FORTRESS-15D');
ok('F7 outcome id', contract.outcome_id === '15D_sunset_staging_staff_api_sha_rollout');
ok('F8 master_basis exact', contract.master_basis === MASTER_BASIS);
ok('F9 wolfhouse prod untouched',
  contract.wolfhouse_production_queried === false
  && contract.wolfhouse_production_modified === false
  && inventory.wolfhouse_production_queried === false
  && inventory.wolfhouse_production_modified === false);
ok('F10 zero DB/Stripe/secrets/RBAC/network mutation',
  contract.database_mutated === false
  && contract.stripe_account_mutated === false
  && contract.secrets_mutated === false
  && contract.rbac_mutated === false
  && contract.network_mutated === false
  && inventory.database_mutated === false
  && inventory.stripe_account_mutated === false);
ok('F11 scope locks',
  contract.scope.subscriptionId === LOCKED_SCOPE.subscriptionId
  && contract.scope.resourceGroup === LOCKED_SCOPE.resourceGroup
  && contract.scope.containerApp === LOCKED_SCOPE.containerApp
  && contract.scope.portalHost === LOCKED_SCOPE.portalHost
  && contract.scope.tenantSlug === 'sunset');
ok('F12 inventory hash lock',
  inventoryHash === contract.hash_locks.live_inventory_sha256,
  `${inventoryHash} != ${contract.hash_locks.live_inventory_sha256}`);
ok('F13 build_deploy_mutation true (this slice deployed)',
  contract.build_deploy_mutation === true
  && inventory.build_deploy_mutation === true);
ok('F14 bicep still declares webhook slug', assertBicepDeclaresWebhookSlug(bicepSrc).ok);
ok('F15 15D sequence id preserved from 15C',
  contract.deploy_sequence_15d_id === '15D_sunset_staging_staff_api_sha_rollout'
  && DEPLOY_SEQUENCE_15D.length === 8);

// Secret scan fixtures
for (const [label, text] of [
  ['contract', JSON.stringify(contract)],
  ['inventory', inventoryRaw],
  ['evidence', JSON.stringify(evidence)],
  ['findings', findings],
]) {
  const leaks = scanSecretFreeText(text);
  ok(`F16 secret-free ${label}`, leaks.length === 0, leaks.join(','));
}

const evalOk = evaluatePostDeployInventory(inventory, { expectedMasterSha: MASTER_BASIS });
green('post_deploy_inventory_pass', evalOk.ok, JSON.stringify(evalOk.failures));
green('active_revision',
  inventory.active_revision.name === ACTIVE_REVISION
  && inventory.active_revision.healthState === 'Healthy'
  && Number(inventory.active_revision.trafficWeight) === 100);
green('image_equals_master_sha',
  inventory.active_revision.image === EXPECTED_IMAGE
  && contract.live_capture_summary.image === EXPECTED_IMAGE);
green('tenant_slugs_sunset',
  inventory.container_env.DEFAULT_CLIENT_SLUG.value === 'sunset'
  && inventory.container_env.STRIPE_WEBHOOK_CLIENT_SLUG.value === 'sunset');
green('skip_verify_false',
  inventory.container_env.STRIPE_WEBHOOK_SKIP_VERIFY.value === 'false');
green('public_healthz_200',
  inventory.gates.public_health['/healthz'].status === 200
  && inventory.gates.public_health_ok === true);
green('acr_build_provenance',
  inventory.build.run_id === ACR_RUN_ID
  && inventory.build.digest === IMAGE_DIGEST
  && inventory.build.status === 'Succeeded');
green('rollback_not_needed',
  inventory.rollback.required === false
  && inventory.rollback.performed === false
  && inventory.rollback.prior_revision === PRIOR_REVISION
  && inventory.rollback.prior_image === PRIOR_IMAGE);

const costDelta = evaluateCostDeltaVs15c(inventory.cost, COST_BASELINE_15C);
green('cost_no_spike',
  costDelta.ok && costDelta.spike === false
  && Math.abs(costDelta.delta - contract.cost.delta_vs_15c) < 1e-9);
green('cost_delta_documented',
  typeof contract.cost.delta_vs_15c === 'number'
  && contract.cost.after.amount === inventory.cost.amount);

{
  const bad = clone(inventory);
  bad.container_env.DEFAULT_CLIENT_SLUG = { value: 'wolfhouse-somo' };
  const r = evaluatePostDeployInventory(bad, { expectedMasterSha: MASTER_BASIS });
  red('wrong_default_slug', !r.ok && r.failures.some((f) => /default_client_slug/.test(f.code)));
}
{
  const bad = clone(inventory);
  bad.container_env.STRIPE_WEBHOOK_CLIENT_SLUG = { value: 'wolfhouse-somo' };
  const r = evaluatePostDeployInventory(bad, { expectedMasterSha: MASTER_BASIS });
  red('wrong_webhook_slug', !r.ok && r.failures.some((f) => /stripe_webhook_client_slug/.test(f.code)));
}
{
  const bad = clone(inventory);
  delete bad.container_env.DEFAULT_CLIENT_SLUG;
  delete bad.container_env.STRIPE_WEBHOOK_CLIENT_SLUG;
  const r = evaluatePostDeployInventory(bad, { expectedMasterSha: MASTER_BASIS });
  red('missing_both_slugs', !r.ok && r.failures.some((f) => f.code === 'missing_runtime_client_slug'
    || /slug/.test(f.code)));
}
{
  const bad = clone(inventory);
  bad.container_env.STRIPE_WEBHOOK_SKIP_VERIFY = { value: 'true' };
  const r = evaluatePostDeployInventory(bad, { expectedMasterSha: MASTER_BASIS });
  red('skip_verify_true', !r.ok && r.failures.some((f) => /skip_verify/.test(f.code)));
}
{
  const bad = clone(inventory);
  bad.scope.resourceGroup = 'wh-prod-rg';
  const r = evaluatePostDeployInventory(bad, { expectedMasterSha: MASTER_BASIS });
  red('wrong_resource_group', !r.ok && r.failures.some((f) => f.code === 'unexpected_resource_group'));
}
{
  const bad = clone(inventory);
  bad.active_revision.image = 'whstagingacr.azurecr.io/luna-sunset-staff-api:latest';
  const r = evaluatePostDeployInventory(bad, { expectedMasterSha: MASTER_BASIS });
  red('mutable_latest_image', !r.ok && r.failures.some((f) => f.code === 'mutable_latest_image'
    || f.code === 'image_tag_not_master_sha'));
}
{
  const bad = clone(inventory);
  bad.active_revision.image = `whstagingacr.azurecr.io/luna-sunset-staff-api:${'a'.repeat(40)}`;
  const r = evaluatePostDeployInventory(bad, { expectedMasterSha: MASTER_BASIS });
  red('image_tag_not_master_sha', !r.ok && r.failures.some((f) => f.code === 'image_tag_not_master_sha'));
}
{
  const bad = clone(inventory);
  bad.active_revision.healthState = 'Unhealthy';
  const r = evaluatePostDeployInventory(bad, { expectedMasterSha: MASTER_BASIS });
  red('unhealthy_revision', !r.ok && r.failures.some((f) => f.code === 'unhealthy_revision'));
}
{
  const bad = clone(inventory);
  bad.active_revision.trafficWeight = 50;
  bad.traffic = [
    { revisionName: ACTIVE_REVISION, weight: 50 },
    { revisionName: PRIOR_REVISION, weight: 50 },
  ];
  const r = evaluatePostDeployInventory(bad, { expectedMasterSha: MASTER_BASIS });
  red('ambiguous_traffic', !r.ok && r.failures.some((f) => f.code === 'ambiguous_traffic'));
}
{
  const spike = evaluateCostDeltaVs15c(
    { amount: COMMITTED_COST_BASELINE.amount * COST_SPIKE_MULTIPLIER + 1, currency: 'USD' },
    COST_BASELINE_15C,
  );
  red('cost_spike', !spike.ok && spike.spike === true);
}
{
  // Assemble synthetic marker at runtime so git push protection does not treat the source as a live key.
  const synthetic = ['sk', 'live', '51HxYzExampleSecretValueLeakTest999'].join('_');
  const leaks = scanSecretFreeText(`${inventoryRaw}\n${synthetic}\n`);
  red('secret_leakage_in_inventory', leaks.includes('sk_live'));
}

ok('C1 findings cite master SHA', findings.includes(MASTER_BASIS));
ok('C2 findings cite active revision', findings.includes(ACTIVE_REVISION));
ok('C3 findings cite rollback unused', /rollback.*not (required|performed)/i.test(findings));
ok('C4 evidence matches ACR run', evidence.build.run_id === ACR_RUN_ID);
ok('C5 verifier offline (no https/child_process)',
  !/\brequire\(['"]https?['"]\)/.test(fs.readFileSync(__filename, 'utf8'))
  && !/\brequire\(['"]child_process['"]\)/.test(fs.readFileSync(__filename, 'utf8'))
  && !/\bfetch\s*\(/.test(fs.readFileSync(__filename, 'utf8'))
  && !/execSync\s*\(/.test(fs.readFileSync(__filename, 'utf8'))
  && !/spawnSync\s*\(/.test(fs.readFileSync(__filename, 'utf8')));
ok('C6 forbidden surfaces listed',
  FORBIDDEN_MUTATION_SURFACE.every((s) => contract.forbidden_surfaces.includes(s)));

console.log(`\n${pass} passed, ${fail} failed (RED ${redResults.length}, GREEN ${greenResults.length})`);
if (fail) process.exit(1);
console.log('OK — Slice 15D Sunset SHA deploy evidence gates green (offline, no live re-run).');
