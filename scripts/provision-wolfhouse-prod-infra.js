'use strict';

/**
 * Wolfhouse prod infra — gated, hardened provision script (post-apply fixes).
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
 * Post-apply fixes (lessons from the real shell apply):
 *   - `az group exists` returns exit 0 for both true/false: existence is decided
 *     from stdout being exactly "true", not from the exit code.
 *   - Key Vault secret names use HYPHENS (underscores are rejected by Key Vault).
 *   - Key Vault is RBAC-enabled: operator needs "Key Vault Secrets Officer" on
 *     wh-prod-kv before setting secrets (documented; role command pattern printed).
 *   - Container Apps env must be attached to wh-prod-logs (see note; the already-
 *     deployed env is on an auto-generated workspace — corrected separately).
 *   - Postgres create output can contain connectionString/password: its output is
 *     CAPTURED and SUPPRESSED in apply mode (never echoed raw).
 *   - Postgres DB create uses `--name wolfhouse_prod` (not `--database-name`).
 *
 * Secrets are NEVER committed and NEVER printed. It does NOT deploy app
 * containers, NOT set Key Vault secret values, NOT change the Meta webhook, NOT
 * touch Stripe live, and NOT run DB migrations.
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

// Key Vault secret NAMES only — HYPHENATED (Key Vault rejects underscores).
// Values are operator-provided, never written here.
const SECRET_NAMES = [
  'wolfhouse-prod-db-user',
  'wolfhouse-prod-db-password',
  'wolfhouse-prod-database-url',
  'luna-bot-internal-token',
  'wolfhouse-staff-session-secret',
  'wolfhouse-whatsapp-phone-number-id',
  'wolfhouse-whatsapp-access-token',
  'wolfhouse-meta-app-secret',
  'wolfhouse-meta-verify-token',
  'wolfhouse-stripe-secret-key',
  'wolfhouse-stripe-webhook-secret',
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
    secretsToRedact: [pgAdminPassword, pgAdminUser].filter(Boolean),
  };
}

// Append explicit subscription to every command so nothing relies on az default.
function withSub(cmd, ctx) {
  return [...cmd, '--subscription', ctx.subscription];
}

// Redact secret values for display. The value following --admin-password /
// --admin-user is force-redacted regardless.
function printable(cmd, ctx) {
  const out = [];
  for (let i = 0; i < cmd.length; i += 1) {
    const arg = cmd[i];
    if (ctx.secretsToRedact.includes(arg)) { out.push(REDACTED); continue; }
    out.push(arg);
    if (arg === '--admin-password' || arg === '--admin-user') {
      if (i + 1 < cmd.length) { out.push(REDACTED); i += 1; }
    }
  }
  return out.join(' ');
}

// Redact any captured command output that might leak secrets.
function redactText(text, ctx) {
  let t = String(text || '');
  for (const sec of ctx.secretsToRedact) {
    if (sec) t = t.split(sec).join(REDACTED);
  }
  // Belt-and-suspenders: blank any line that mentions a secret-ish field.
  return t
    .split('\n')
    .map((line) => (/password|connectionstring|secret|token|key/i.test(line) ? `      ${REDACTED} (line withheld)` : line))
    .join('\n');
}

// ----------------------------------------------------------------------------
// Command-list builder. Each step: read-only existence `check` (existsMode), an
// idempotent NON-INTERACTIVE `create`, and flags (captureSecret).
// ----------------------------------------------------------------------------
function buildSteps(ctx) {
  const n = NAMES;
  return [
    {
      label: `Resource group ${n.resourceGroup}`,
      // FIX: `az group exists` exits 0 for both true/false → decide by stdout.
      check: withSub(['az', 'group', 'exists', '--name', n.resourceGroup], ctx),
      existsMode: 'stdout-true',
      create: withSub(['az', 'group', 'create', '--name', n.resourceGroup, '--location', n.region], ctx),
    },
    {
      label: `Container registry ${n.acr}`,
      check: withSub(['az', 'acr', 'show', '--name', n.acr, '--resource-group', n.resourceGroup], ctx),
      existsMode: 'exit-zero',
      create: withSub(['az', 'acr', 'create', '--resource-group', n.resourceGroup, '--name', n.acr, '--sku', 'Basic'], ctx),
    },
    {
      label: `Key Vault ${n.keyVault} (RBAC-enabled)`,
      check: withSub(['az', 'keyvault', 'show', '--name', n.keyVault, '--resource-group', n.resourceGroup], ctx),
      existsMode: 'exit-zero',
      create: withSub(['az', 'keyvault', 'create', '--resource-group', n.resourceGroup, '--name', n.keyVault, '--location', n.region, '--enable-rbac-authorization', 'true'], ctx),
      note: 'RBAC-enabled: operator needs "Key Vault Secrets Officer" on this vault before setting secret values (see secret guidance below).',
    },
    {
      label: `Log Analytics ${n.logAnalytics}`,
      check: withSub(['az', 'monitor', 'log-analytics', 'workspace', 'show', '--resource-group', n.resourceGroup, '--workspace-name', n.logAnalytics], ctx),
      existsMode: 'exit-zero',
      create: withSub(['az', 'monitor', 'log-analytics', 'workspace', 'create', '--resource-group', n.resourceGroup, '--workspace-name', n.logAnalytics, '--location', n.region, '--retention-time', '30'], ctx),
    },
    {
      label: `Container Apps environment ${n.containerAppsEnv} (attach ${n.logAnalytics})`,
      check: withSub(['az', 'containerapp', 'env', 'show', '--name', n.containerAppsEnv, '--resource-group', n.resourceGroup], ctx),
      existsMode: 'exit-zero',
      // FIX: pass the wh-prod-logs workspace so Azure does not auto-create one.
      // (--logs-workspace-id / --logs-workspace-key resolved by operator at apply
      //  from wh-prod-logs; the key is a secret, supplied via env, never committed.)
      create: withSub(['az', 'containerapp', 'env', 'create', '--resource-group', n.resourceGroup, '--name', n.containerAppsEnv, '--location', n.region, '--logs-destination', 'log-analytics', '--logs-workspace-id', `<${n.logAnalytics}-customer-id>`, '--logs-workspace-key', `<${n.logAnalytics}-shared-key>`], ctx),
      note: `KNOWN ISSUE: the already-deployed ${n.containerAppsEnv} is attached to an auto-generated workspace (created before this fix). This create now attaches ${n.logAnalytics}; correcting the existing env is a separate approved infra-correction step — NOT done here.`,
    },
    {
      label: `Postgres server ${n.postgresServer} (admin creds from env; --yes; output suppressed)`,
      check: withSub(['az', 'postgres', 'flexible-server', 'show', '--name', n.postgresServer, '--resource-group', n.resourceGroup], ctx),
      existsMode: 'exit-zero',
      // --yes = non-interactive. Output is CAPTURED + SUPPRESSED (may contain
      // connectionString/password). Admin creds from env, redacted in the printed command.
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
      captureSecret: true,
      note: `Admin creds read from ${ENV_PG_ADMIN_USER} / ${ENV_PG_ADMIN_PASSWORD} (env only, never committed, password never printed).`,
    },
    {
      label: `Database ${n.database}`,
      check: withSub(['az', 'postgres', 'flexible-server', 'db', 'show', '--database-name', n.database, '--server-name', n.postgresServer, '--resource-group', n.resourceGroup], ctx),
      existsMode: 'exit-zero',
      // FIX: db create uses --name (not --database-name).
      create: withSub(['az', 'postgres', 'flexible-server', 'db', 'create', '--name', n.database, '--server-name', n.postgresServer, '--resource-group', n.resourceGroup], ctx),
      captureSecret: true,
      note: 'Creates the database only. Schema/DB migrations are a separate, later step (not run here).',
    },
  ];
}

function printSecretGuidance() {
  log('\nKEY VAULT SECRET NAMES (hyphenated; operator sets values manually — none written here):\n');
  log(`  Prereq (RBAC): operator must hold "Key Vault Secrets Officer" on ${NAMES.keyVault}:`);
  log(`    az role assignment create --role "Key Vault Secrets Officer" \\`);
  log(`      --assignee <operator-object-id> \\`);
  log(`      --scope /subscriptions/<${ENV_SUBSCRIPTION}>/resourceGroups/${NAMES.resourceGroup}/providers/Microsoft.KeyVault/vaults/${NAMES.keyVault}\n`);
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

function applyGuardFailures() {
  const failures = [];

  if (process.env[ENV_APPLY_FLAG] !== '1') failures.push(`env ${ENV_APPLY_FLAG}=1 is not set`);

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

  if (!process.env[ENV_SUBSCRIPTION]) failures.push(`env ${ENV_SUBSCRIPTION} is not set (explicit subscription required)`);
  if (!process.env[ENV_PG_ADMIN_USER]) failures.push(`env ${ENV_PG_ADMIN_USER} is not set (Postgres admin user required)`);
  if (!process.env[ENV_PG_ADMIN_PASSWORD]) failures.push(`env ${ENV_PG_ADMIN_PASSWORD} is not set (Postgres admin password required)`);

  const az = azAvailableAndLoggedIn();
  if (!az.ok) failures.push(az.reason);

  return failures;
}

// Run a CHECK command (captured, never echoes raw output). Returns existence.
function runCheck(step, ctx) {
  log(`    $ ${printable(step.check, ctx)}`);
  const r = spawnSync(step.check[0], step.check.slice(1), { encoding: 'utf8' });
  if (step.existsMode === 'stdout-true') {
    return String(r.stdout || '').trim() === 'true'; // FIX: az group exists
  }
  return r.status === 0;
}

// Run a CREATE command. Secret-risk commands are captured + suppressed.
function runCreate(step, ctx) {
  log(`    $ ${printable(step.create, ctx)}`);
  if (step.captureSecret) {
    const r = spawnSync(step.create[0], step.create.slice(1), { encoding: 'utf8' });
    if (r.status !== 0) {
      log('      -> create FAILED (stderr redacted):');
      log(redactText(r.stderr, ctx));
      return r.status || 1;
    }
    log('      -> done (raw output suppressed — may contain connectionString/password).');
    return 0;
  }
  const r = spawnSync(step.create[0], step.create.slice(1), { encoding: 'utf8' });
  if (r.stdout) log(redactText(r.stdout, ctx));
  if (r.status !== 0 && r.stderr) log(redactText(r.stderr, ctx));
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
    log(`      check : ${printable(step.check, ctx)}${step.existsMode === 'stdout-true' ? '   [exists if stdout == "true"]' : ''}`);
    log(`      create: ${printable(step.create, ctx)}`);
    if (step.captureSecret) log('      output: CAPTURED + SUPPRESSED in apply (may contain connectionString/password)');
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

  const failures = applyGuardFailures();
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
    if (runCheck(step, ctx)) {
      log('      -> already exists, skipping create (idempotent).');
      continue;
    }
    const code = runCreate(step, ctx);
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
