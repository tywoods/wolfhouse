'use strict';

/**
 * Wolfhouse prod infra — gated, hardened provision script.
 *
 * DEFAULT IS DRY-RUN. Nothing is created/updated/deleted unless ALL of the
 * following are true (apply guards):
 *   1. invoked with  --apply
 *   2. env  WOLFHOUSE_PROD_INFRA_APPLY=1
 *   3. git working tree is clean
 *   4. current branch is  master
 *   5. local HEAD == origin/master
 *   6. env  AZURE_SUBSCRIPTION_ID  is set (explicit subscription)
 *   7. env  WOLFHOUSE_PROD_PG_ADMIN_USER  is set
 *   8. env  WOLFHOUSE_PROD_PG_ADMIN_PASSWORD  is set
 *   9. az CLI is installed AND logged in (`az account show` succeeds)
 *
 * Hardening goals: a future approved --apply is NON-INTERACTIVE (no Azure
 * prompts can hang it) and EXPLICIT (subscription + Postgres admin creds come
 * from env, never source). Secrets are NEVER committed and NEVER printed:
 * the Postgres admin user/password are read from env only in apply mode and are
 * redacted in all output (the password is never printed).
 *
 * It does NOT deploy app containers, NOT set Key Vault secret values, NOT change
 * the Meta webhook, NOT touch Stripe live, and NOT run DB migrations.
 *
 * Usage:
 *   node scripts/provision-wolfhouse-prod-infra.js              # dry-run (default)
 *   node scripts/provision-wolfhouse-prod-infra.js --dry-run    # explicit dry-run
 *   WOLFHOUSE_PROD_INFRA_APPLY=1 AZURE_SUBSCRIPTION_ID=... \
 *   WOLFHOUSE_PROD_PG_ADMIN_USER=... WOLFHOUSE_PROD_PG_ADMIN_PASSWORD=... \
 *     node scripts/provision-wolfhouse-prod-infra.js --apply
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

// Required apply-mode env var NAMES (values never committed/printed).
const ENV_APPLY_FLAG = 'WOLFHOUSE_PROD_INFRA_APPLY';
const ENV_SUBSCRIPTION = 'AZURE_SUBSCRIPTION_ID';
const ENV_PG_ADMIN_USER = 'WOLFHOUSE_PROD_PG_ADMIN_USER';
const ENV_PG_ADMIN_PASSWORD = 'WOLFHOUSE_PROD_PG_ADMIN_PASSWORD';

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

const REDACTED = '***REDACTED***';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const DRY_RUN = !APPLY; // dry-run is the default; --dry-run is accepted as explicit

function log(s) { console.log(s); }
function hr() { log('─'.repeat(72)); }

// ----------------------------------------------------------------------------
// Context: in dry-run we use non-secret placeholders and require NO env vars.
// In apply we read real values from env (validated by guards first).
// ----------------------------------------------------------------------------
function buildContext() {
  if (DRY_RUN) {
    return {
      subscription: `<${ENV_SUBSCRIPTION}>`,
      pgAdminUser: `<${ENV_PG_ADMIN_USER}>`,
      pgAdminPassword: `<${ENV_PG_ADMIN_PASSWORD}>`,
      secretsToRedact: [], // placeholders are not secrets
    };
  }
  const pgAdminPassword = process.env[ENV_PG_ADMIN_PASSWORD] || '';
  const pgAdminUser = process.env[ENV_PG_ADMIN_USER] || '';
  return {
    subscription: process.env[ENV_SUBSCRIPTION] || '',
    pgAdminUser,
    pgAdminPassword,
    // Redact real admin user + password from any printed command.
    secretsToRedact: [pgAdminPassword, pgAdminUser].filter(Boolean),
  };
}

// Append explicit subscription to every command so nothing relies on az default.
function withSub(cmd, ctx) {
  return [...cmd, '--subscription', ctx.subscription];
}

// Redact secret values for display. The password is ALWAYS replaced; the value
// following --admin-password is force-redacted regardless.
function printable(cmd, ctx) {
  const out = [];
  for (let i = 0; i < cmd.length; i += 1) {
    const arg = cmd[i];
    if (ctx.secretsToRedact.includes(arg)) { out.push(REDACTED); continue; }
    out.push(arg);
    if (arg === '--admin-password' || arg === '--admin-user') {
      // force-redact the following value no matter what
      if (i + 1 < cmd.length) { out.push(REDACTED); i += 1; }
    }
  }
  return out.join(' ');
}

// ----------------------------------------------------------------------------
// Command-list builder: each step has a read-only existence `check` and an
// idempotent, NON-INTERACTIVE `create`. No step mutates in dry-run.
// ----------------------------------------------------------------------------
function buildSteps(ctx) {
  const n = NAMES;
  return [
    {
      label: `Resource group ${n.resourceGroup}`,
      check: withSub(['az', 'group', 'exists', '--name', n.resourceGroup], ctx),
      create: withSub(['az', 'group', 'create', '--name', n.resourceGroup, '--location', n.region], ctx),
    },
    {
      label: `Container registry ${n.acr}`,
      check: withSub(['az', 'acr', 'show', '--name', n.acr, '--resource-group', n.resourceGroup], ctx),
      create: withSub(['az', 'acr', 'create', '--resource-group', n.resourceGroup, '--name', n.acr, '--sku', 'Basic'], ctx),
    },
    {
      label: `Key Vault ${n.keyVault}`,
      check: withSub(['az', 'keyvault', 'show', '--name', n.keyVault, '--resource-group', n.resourceGroup], ctx),
      create: withSub(['az', 'keyvault', 'create', '--resource-group', n.resourceGroup, '--name', n.keyVault, '--location', n.region], ctx),
    },
    {
      label: `Log Analytics ${n.logAnalytics}`,
      check: withSub(['az', 'monitor', 'log-analytics', 'workspace', 'show', '--resource-group', n.resourceGroup, '--workspace-name', n.logAnalytics], ctx),
      create: withSub(['az', 'monitor', 'log-analytics', 'workspace', 'create', '--resource-group', n.resourceGroup, '--workspace-name', n.logAnalytics, '--location', n.region, '--retention-time', '30'], ctx),
    },
    {
      label: `Container Apps environment ${n.containerAppsEnv}`,
      check: withSub(['az', 'containerapp', 'env', 'show', '--name', n.containerAppsEnv, '--resource-group', n.resourceGroup], ctx),
      create: withSub(['az', 'containerapp', 'env', 'create', '--resource-group', n.resourceGroup, '--name', n.containerAppsEnv, '--location', n.region], ctx),
    },
    {
      label: `Postgres server ${n.postgresServer} (admin creds from env; --yes non-interactive)`,
      check: withSub(['az', 'postgres', 'flexible-server', 'show', '--name', n.postgresServer, '--resource-group', n.resourceGroup], ctx),
      // --yes suppresses the interactive firewall/networking prompt so apply can
      // never hang. Admin user/password come from env (redacted in output).
      create: withSub([
        'az', 'postgres', 'flexible-server', 'create',
        '--resource-group', n.resourceGroup,
        '--name', n.postgresServer,
        '--location', n.region,
        '--tier', 'Burstable',
        '--sku-name', 'Standard_B1ms',
        '--admin-user', ctx.pgAdminUser,
        '--admin-password', ctx.pgAdminPassword,
        '--yes',
      ], ctx),
      note: `Admin creds read from ${ENV_PG_ADMIN_USER} / ${ENV_PG_ADMIN_PASSWORD} (env only, never committed, password never printed). DB migrations are a separate later step.`,
    },
  ];
}

function printSecretGuidance() {
  log('\nKEY VAULT SECRET NAMES (operator must set values manually — none written here):\n');
  for (const s of SECRET_NAMES) {
    log(`  - ${NAMES.keyVault}/${s}`);
    log(`      az keyvault secret set --vault-name ${NAMES.keyVault} --name ${s} --value ${REDACTED}   # operator runs this; value never committed`);
  }
}

// ----------------------------------------------------------------------------
// Apply guards
// ----------------------------------------------------------------------------
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function azAvailableAndLoggedIn() {
  const r = spawnSync('az', ['account', 'show'], { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') return { ok: false, reason: 'az CLI is not installed (command not found)' };
  if (r.status !== 0) return { ok: false, reason: 'az CLI is not logged in (`az account show` failed; run `az login`)' };
  return { ok: true };
}

function applyGuardFailures(ctx) {
  const failures = [];

  if (process.env[ENV_APPLY_FLAG] !== '1') {
    failures.push(`env ${ENV_APPLY_FLAG}=1 is not set`);
  }

  const status = git(['status', '--porcelain']);
  if (status.code !== 0) failures.push('could not read git status');
  else if (status.out !== '') failures.push('git working tree is dirty (commit/stash first)');

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.out !== 'master') failures.push(`current branch is "${branch.out}", must be master`);

  git(['fetch', 'origin', 'master', '--quiet']); // read-only ref fetch
  const head = git(['rev-parse', 'HEAD']);
  const originMaster = git(['rev-parse', 'origin/master']);
  if (!head.out || !originMaster.out || head.out !== originMaster.out) {
    failures.push(`local HEAD (${head.out || '?'}) != origin/master (${originMaster.out || '?'})`);
  }

  if (!process.env[ENV_SUBSCRIPTION]) {
    failures.push(`env ${ENV_SUBSCRIPTION} is not set (explicit subscription required)`);
  }
  if (!process.env[ENV_PG_ADMIN_USER]) {
    failures.push(`env ${ENV_PG_ADMIN_USER} is not set (Postgres admin user required)`);
  }
  if (!process.env[ENV_PG_ADMIN_PASSWORD]) {
    failures.push(`env ${ENV_PG_ADMIN_PASSWORD} is not set (Postgres admin password required)`);
  }

  const az = azAvailableAndLoggedIn();
  if (!az.ok) failures.push(az.reason);

  return failures;
}

function runChecked(cmd, ctx) {
  log(`    $ ${printable(cmd, ctx)}`); // print redacted form before executing
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
  const ctx = buildContext();
  header('DRY-RUN (default — nothing executed, no env vars required)');
  log('\nThis is DRY-RUN. No az command is executed; nothing is created/updated/deleted.');
  log('App containers are NOT deployed, the Meta webhook is NOT changed, Stripe live is');
  log('NOT touched, and NO DB migrations are run. All sensitive values shown as');
  log('placeholders/redacted — the Postgres password is never printed.\n');

  log('PLANNED ENSURE-STEPS (existence check, then idempotent non-interactive create):\n');
  for (const step of buildSteps(ctx)) {
    log(`  • ${step.label}`);
    log(`      check : ${printable(step.check, ctx)}`);
    log(`      create: ${printable(step.create, ctx)}`);
    if (step.note) log(`      note  : ${step.note}`);
  }
  printSecretGuidance();

  log('\nTo apply later (separate, deliberate, approved step) — all required:');
  log(`  ${ENV_APPLY_FLAG}=1 ${ENV_SUBSCRIPTION}=<id> \\`);
  log(`  ${ENV_PG_ADMIN_USER}=<user> ${ENV_PG_ADMIN_PASSWORD}=<password> \\`);
  log('    node scripts/provision-wolfhouse-prod-infra.js --apply');
  log('  (also requires: clean tree, branch master, HEAD == origin/master, az logged in)');
  hr();
  log('  DRY-RUN COMPLETE — no changes made.');
  hr();
  process.exit(0);
}

function apply() {
  const ctx = buildContext();
  header('APPLY (DANGER)');
  log('');
  log('  ███  DANGER: --apply will CREATE real Azure resources for Wolfhouse PROD.  ███');
  log('  Infrastructure shells only (no app deploy, no secret values, no Meta/Stripe/live');
  log('  changes, no DB migrations). All commands run NON-INTERACTIVE; secrets redacted.\n');

  const failures = applyGuardFailures(ctx);
  if (failures.length) {
    log('  APPLY REFUSED — guard checks failed:');
    failures.forEach((f) => log(`    ✗ ${f}`));
    log('\n  No command was executed.');
    hr();
    process.exit(1);
  }

  log('  All guard checks passed. Executing ensure-steps sequentially (non-interactive)...\n');
  for (const step of buildSteps(ctx)) {
    log(`  • ${step.label}`);
    const exists = runChecked(step.check, ctx) === 0;
    if (exists) {
      log('      -> already exists, skipping create (idempotent).');
      continue;
    }
    const code = runChecked(step.create, ctx);
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
