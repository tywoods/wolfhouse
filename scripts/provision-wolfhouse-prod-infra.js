'use strict';

/**
 * Wolfhouse prod infra — gated provision script.
 *
 * DEFAULT IS DRY-RUN. Nothing is created/updated/deleted unless ALL of the
 * following are true:
 *   1. invoked with  --apply
 *   2. env  WOLFHOUSE_PROD_INFRA_APPLY=1  is set
 *   3. git working tree is clean
 *   4. current branch is  master
 *   5. local HEAD == origin/master
 *
 * In dry-run it only prints the az commands it WOULD run. In apply it prints each
 * command before executing it, runs them sequentially, and is idempotent (each
 * resource is checked for existence first; create is skipped if it already exists).
 *
 * It NEVER writes secret values. For Key Vault it only prints the required secret
 * NAMES and instructs the operator to set values manually. It does NOT change the
 * Meta webhook, does NOT touch Stripe live, does NOT deploy app containers, and
 * does NOT run DB migrations.
 *
 * Usage:
 *   node scripts/provision-wolfhouse-prod-infra.js              # dry-run (default)
 *   node scripts/provision-wolfhouse-prod-infra.js --dry-run    # explicit dry-run
 *   WOLFHOUSE_PROD_INFRA_APPLY=1 node scripts/provision-wolfhouse-prod-infra.js --apply
 */

const { spawnSync } = require('child_process');

// --- planned names (mirror docs/clients/wolfhouse/LIVE-ENV-INVENTORY.md) ---
const NAMES = {
  region: 'northeurope',
  resourceGroup: 'wh-prod-rg',
  acr: 'whprodacr',
  keyVault: 'wh-prod-kv',
  logAnalytics: 'wh-prod-logs',
  containerAppsEnv: 'wh-prod-env',
  staffApiApp: 'wh-prod-staff-api',
  hermesApp: 'wh-prod-hermes',
  postgresServer: 'wh-prod-pg',
  database: 'wolfhouse_prod',
};

// Key Vault secret NAMES only — values are operator-provided, never written here.
const SECRET_NAMES = [
  'WOLFHOUSE_PROD_DB_USER',
  'WOLFHOUSE_PROD_DB_PASSWORD',
  'WOLFHOUSE_PROD_DATABASE_URL',
  'LUNA_BOT_INTERNAL_TOKEN',
  'WOLFHOUSE_STAFF_SESSION_SECRET',
  'WOLFHOUSE_WHATSAPP_PHONE_NUMBER_ID',
  'WOLFHOUSE_WHATSAPP_ACCESS_TOKEN',
  'WOLFHOUSE_META_APP_SECRET',
  'WOLFHOUSE_META_VERIFY_TOKEN',
  'WOLFHOUSE_STRIPE_SECRET_KEY',
  'WOLFHOUSE_STRIPE_WEBHOOK_SECRET',
];

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const DRY_RUN = !APPLY; // dry-run is the default; --dry-run is accepted as explicit

function log(s) { console.log(s); }
function hr() { log('─'.repeat(72)); }

// ----------------------------------------------------------------------------
// Command-list builder: returns structured ensure-steps. Each step has a
// read-only existence `check` and an idempotent `create`. No step mutates in
// dry-run; in apply, create runs only if check reports the resource missing.
// ----------------------------------------------------------------------------
function buildSteps() {
  const n = NAMES;
  return [
    {
      label: `Resource group ${n.resourceGroup}`,
      check: ['az', 'group', 'exists', '--name', n.resourceGroup],
      create: ['az', 'group', 'create', '--name', n.resourceGroup, '--location', n.region],
    },
    {
      label: `Container registry ${n.acr}`,
      check: ['az', 'acr', 'show', '--name', n.acr, '--resource-group', n.resourceGroup],
      create: ['az', 'acr', 'create', '--resource-group', n.resourceGroup, '--name', n.acr, '--sku', 'Basic'],
    },
    {
      label: `Key Vault ${n.keyVault}`,
      check: ['az', 'keyvault', 'show', '--name', n.keyVault, '--resource-group', n.resourceGroup],
      create: ['az', 'keyvault', 'create', '--resource-group', n.resourceGroup, '--name', n.keyVault, '--location', n.region],
    },
    {
      label: `Log Analytics ${n.logAnalytics}`,
      check: ['az', 'monitor', 'log-analytics', 'workspace', 'show', '--resource-group', n.resourceGroup, '--workspace-name', n.logAnalytics],
      create: ['az', 'monitor', 'log-analytics', 'workspace', 'create', '--resource-group', n.resourceGroup, '--workspace-name', n.logAnalytics, '--location', n.region, '--retention-time', '30'],
    },
    {
      label: `Container Apps environment ${n.containerAppsEnv}`,
      check: ['az', 'containerapp', 'env', 'show', '--name', n.containerAppsEnv, '--resource-group', n.resourceGroup],
      create: ['az', 'containerapp', 'env', 'create', '--resource-group', n.resourceGroup, '--name', n.containerAppsEnv, '--location', n.region],
    },
    {
      label: `Postgres server ${n.postgresServer} (shell only; admin creds operator-provided at apply)`,
      check: ['az', 'postgres', 'flexible-server', 'show', '--name', n.postgresServer, '--resource-group', n.resourceGroup],
      // NOTE: --admin-user/--admin-password are intentionally omitted here; the
      // operator supplies them interactively at apply time. No secret in source.
      create: ['az', 'postgres', 'flexible-server', 'create', '--resource-group', n.resourceGroup, '--name', n.postgresServer, '--location', n.region, '--tier', 'Burstable', '--sku-name', 'Standard_B1ms'],
      note: 'Operator must pass --admin-user / --admin-password at apply (never committed). DB migrations are a separate, later step.',
    },
  ];
}

// In apply mode, missing secrets are reported, not created with values.
function printSecretGuidance() {
  log('\nKEY VAULT SECRET NAMES (operator must set values manually — none written here):\n');
  for (const s of SECRET_NAMES) {
    log(`  - ${NAMES.keyVault}/${s}`);
    log(`      az keyvault secret set --vault-name ${NAMES.keyVault} --name ${s} --value <operator-provided>   # operator runs this, value never committed`);
  }
}

// ----------------------------------------------------------------------------
// Apply guards
// ----------------------------------------------------------------------------
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function applyGuardFailures() {
  const failures = [];

  if (process.env.WOLFHOUSE_PROD_INFRA_APPLY !== '1') {
    failures.push('env WOLFHOUSE_PROD_INFRA_APPLY=1 is not set');
  }

  const status = git(['status', '--porcelain']);
  if (status.code !== 0) failures.push('could not read git status');
  else if (status.out !== '') failures.push('git working tree is dirty (commit/stash first)');

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.out !== 'master') failures.push(`current branch is "${branch.out}", must be master`);

  // local HEAD must equal origin/master
  git(['fetch', 'origin', 'master', '--quiet']); // read-only fetch of refs
  const head = git(['rev-parse', 'HEAD']);
  const originMaster = git(['rev-parse', 'origin/master']);
  if (!head.out || !originMaster.out || head.out !== originMaster.out) {
    failures.push(`local HEAD (${head.out || '?'}) != origin/master (${originMaster.out || '?'})`);
  }

  return failures;
}

function runChecked(cmd) {
  log(`    $ ${cmd.join(' ')}`);
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', stdio: 'inherit' });
  return r.status;
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
function header(mode) {
  hr();
  log(`  Wolfhouse PROD infra provision — mode: ${mode}`);
  hr();
  log(`  region   : ${NAMES.region}`);
  log(`  rg       : ${NAMES.resourceGroup}`);
  log(`  acr      : ${NAMES.acr}`);
  log(`  kv       : ${NAMES.keyVault}`);
  log(`  logs     : ${NAMES.logAnalytics}`);
  log(`  ca-env   : ${NAMES.containerAppsEnv}`);
  log(`  staff-api: ${NAMES.staffApiApp}`);
  log(`  hermes   : ${NAMES.hermesApp}`);
  log(`  postgres : ${NAMES.postgresServer}`);
  log(`  database : ${NAMES.database}`);
  hr();
}

function dryRun() {
  header('DRY-RUN (default — nothing executed)');
  log('\nThis is DRY-RUN. No az command is executed; nothing is created/updated/deleted.');
  log('App containers are NOT deployed, the Meta webhook is NOT changed, Stripe live is');
  log('NOT touched, and NO DB migrations are run. Suggested commands below are text only.\n');

  log('PLANNED ENSURE-STEPS (existence check, then idempotent create):\n');
  for (const step of buildSteps()) {
    log(`  • ${step.label}`);
    log(`      check : ${step.check.join(' ')}`);
    log(`      create: ${step.create.join(' ')}`);
    if (step.note) log(`      note  : ${step.note}`);
  }
  printSecretGuidance();

  log('\nTo apply later (separate, deliberate, approved step):');
  log('  WOLFHOUSE_PROD_INFRA_APPLY=1 node scripts/provision-wolfhouse-prod-infra.js --apply');
  log('  (requires: clean tree, branch master, HEAD == origin/master)');
  hr();
  log('  DRY-RUN COMPLETE — no changes made.');
  hr();
  process.exit(0);
}

function apply() {
  header('APPLY (DANGER)');
  log('');
  log('  ███  DANGER: --apply will CREATE real Azure resources for Wolfhouse PROD.  ███');
  log('  This creates infrastructure shells only (no app deploy, no secret values, no');
  log('  Meta/Stripe/live changes, no DB migrations). Review every command below.\n');

  const failures = applyGuardFailures();
  if (failures.length) {
    log('  APPLY REFUSED — guard checks failed:');
    failures.forEach((f) => log(`    ✗ ${f}`));
    log('\n  No command was executed.');
    hr();
    process.exit(1);
  }

  log('  All guard checks passed. Executing ensure-steps sequentially...\n');
  for (const step of buildSteps()) {
    log(`  • ${step.label}`);
    const exists = runChecked(step.check) === 0;
    if (exists) {
      log('      -> already exists, skipping create (idempotent).');
      continue;
    }
    const code = runChecked(step.create);
    if (code !== 0) {
      log(`      -> create FAILED (exit ${code}). Stopping.`);
      process.exit(code || 1);
    }
    if (step.note) log(`      note: ${step.note}`);
  }
  printSecretGuidance();
  hr();
  log('  APPLY COMPLETE — infrastructure shells ensured. Secret values + app deploy');
  log('  + webhook + Stripe remain separate, operator-driven, approval-gated steps.');
  hr();
  process.exit(0);
}

if (APPLY) apply();
else dryRun();
