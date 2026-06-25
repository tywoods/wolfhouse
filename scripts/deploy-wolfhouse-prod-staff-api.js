'use strict';

/**
 * Wolfhouse prod Staff API — gated deploy script (Staff API ONLY).
 *
 * DEFAULT IS DRY-RUN. Nothing is built/pushed/deployed unless ALL of the
 * following are true (apply guards):
 *   1. invoked with  --apply
 *   2. env  WOLFHOUSE_PROD_STAFF_API_DEPLOY_APPLY=1
 *   3. env  AZURE_SUBSCRIPTION_ID  is set (explicit subscription)
 *   4. git working tree is clean
 *   5. current branch is  master
 *   6. local HEAD == origin/master
 *   7. az CLI is installed AND logged in (`az account show` succeeds)
 *
 * Build uses `az acr build` (no local docker required). Deploy is by IMMUTABLE
 * git-SHA tag only (no floating "latest" tag for prod). Secrets come from Key Vault references
 * only — never raw values, never printed. This script does NOT run migrations and
 * does NOT set live Meta/WhatsApp/Stripe env (Staff API scope only).
 *
 * Usage:
 *   node scripts/deploy-wolfhouse-prod-staff-api.js              # dry-run (default)
 *   node scripts/deploy-wolfhouse-prod-staff-api.js --dry-run    # explicit dry-run
 *   WOLFHOUSE_PROD_STAFF_API_DEPLOY_APPLY=1 AZURE_SUBSCRIPTION_ID=... \
 *     node scripts/deploy-wolfhouse-prod-staff-api.js --apply
 */

const { spawnSync } = require('child_process');

const N = {
  region: 'northeurope',
  resourceGroup: 'wh-prod-rg',
  acr: 'whprodacr',
  acrLoginServer: 'whprodacr.azurecr.io',
  keyVault: 'wh-prod-kv',
  containerAppsEnv: 'wh-prod-env',
  staffApiApp: 'wh-prod-staff-api',
  database: 'wolfhouse_prod',
  dockerfile: 'Dockerfile', // root Dockerfile = Staff API (CMD npm run staff:api)
  imageRepo: 'wh-staff-api',
  targetPort: '8080',
  staffHostname: 'staff.lunafrontdesk.com',
};

const ENV_APPLY_FLAG = 'WOLFHOUSE_PROD_STAFF_API_DEPLOY_APPLY';
const ENV_SUBSCRIPTION = 'AZURE_SUBSCRIPTION_ID';

// Staff API secrets ONLY (hyphenated Key Vault names). No Meta/WhatsApp/Stripe here.
const STAFF_SECRET_NAMES = [
  'wolfhouse-prod-database-url',
  'luna-bot-internal-token',
  'wolfhouse-staff-session-secret',
];

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const DRY_RUN = !APPLY;

function log(s) { console.log(s); }
function hr() { log('─'.repeat(72)); }

// ----------------------------------------------------------------------------
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim() };
}

function currentSha() {
  const r = git(['rev-parse', 'HEAD']);
  return r.out || '<git-sha>';
}

function withSub(cmd, sub) { return [...cmd, '--subscription', sub]; }

// Build the command list for a given SHA + subscription placeholder/value.
function buildCommands(sha, sub) {
  const tag = `${N.imageRepo}:${sha}`;
  const fullImage = `${N.acrLoginServer}/${tag}`;
  return {
    build: withSub([
      'az', 'acr', 'build',
      '--registry', N.acr,
      '--image', tag, // immutable SHA tag; no floating latest
      '--file', N.dockerfile,
      '.',
    ], sub),
    // existence check decides create vs update
    show: withSub(['az', 'containerapp', 'show', '--name', N.staffApiApp, '--resource-group', N.resourceGroup], sub),
    create: withSub([
      'az', 'containerapp', 'create',
      '--resource-group', N.resourceGroup,
      '--name', N.staffApiApp,
      '--environment', N.containerAppsEnv,
      '--image', fullImage,
      '--min-replicas', '1', '--max-replicas', '1',
      '--ingress', 'external', '--target-port', N.targetPort,
      '--env-vars', `DEFAULT_CLIENT=wolfhouse-somo`,
      // secret env wired via Key Vault refs (see secretref block); no raw values
    ], sub),
    update: withSub([
      'az', 'containerapp', 'update',
      '--resource-group', N.resourceGroup,
      '--name', N.staffApiApp,
      '--image', fullImage,
    ], sub),
    health: `curl -fsS https://${N.staffHostname}/ >/dev/null && echo "staff api healthy"`,
    fullImage,
  };
}

function printSecretRefs() {
  log('\n  Secret env via Key Vault references (Staff API scope only — names, not values):');
  log(`    # App managed identity must have Key Vault "get secret" permission on ${N.keyVault}.`);
  for (const s of STAFF_SECRET_NAMES) {
    log(`    --secrets ${s}=keyvaultref:https://${N.keyVault}.vault.azure.net/secrets/${s},identityref:<app-managed-identity>`);
  }
  log('    # then map as env, e.g.  DATABASE_URL=secretref:wolfhouse-prod-database-url');
  log('    # (Meta / WhatsApp / Stripe secrets are NOT set by this Staff API deploy.)');
}

// ----------------------------------------------------------------------------
function azAvailableAndLoggedIn() {
  const r = spawnSync('az', ['account', 'show'], { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') return { ok: false, reason: 'az CLI is not installed (command not found)' };
  if (r.status !== 0) return { ok: false, reason: 'az CLI is not logged in (`az account show` failed; run `az login`)' };
  return { ok: true };
}

function applyGuardFailures() {
  const failures = [];
  if (process.env[ENV_APPLY_FLAG] !== '1') failures.push(`env ${ENV_APPLY_FLAG}=1 is not set`);
  if (!process.env[ENV_SUBSCRIPTION]) failures.push(`env ${ENV_SUBSCRIPTION} is not set (explicit subscription required)`);

  const status = git(['status', '--porcelain']);
  if (status.code !== 0) failures.push('could not read git status');
  else if (status.out !== '') failures.push('git working tree is dirty (commit/stash first)');

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.out !== 'master') failures.push(`current branch is "${branch.out}", must be master`);

  git(['fetch', 'origin', 'master', '--quiet']);
  const head = git(['rev-parse', 'HEAD']);
  const om = git(['rev-parse', 'origin/master']);
  if (!head.out || !om.out || head.out !== om.out) failures.push(`local HEAD (${head.out || '?'}) != origin/master (${om.out || '?'})`);

  const az = azAvailableAndLoggedIn();
  if (!az.ok) failures.push(az.reason);

  return failures;
}

function run(cmd) {
  log(`    $ ${cmd.join(' ')}`);
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  return r.status;
}

// ----------------------------------------------------------------------------
function header(mode, sha) {
  hr();
  log(`  Wolfhouse PROD Staff API deploy — mode: ${mode}`);
  hr();
  log(`  app      : ${N.staffApiApp}`);
  log(`  ca-env   : ${N.containerAppsEnv}`);
  log(`  acr      : ${N.acr} (${N.acrLoginServer})`);
  log(`  rg       : ${N.resourceGroup}`);
  log(`  database : ${N.database}`);
  log(`  image    : ${N.imageRepo}:${sha} (immutable SHA; no floating latest)`);
  log(`  dockerfile: ${N.dockerfile}`);
  hr();
}

function describe(cmds) {
  log('\n1) BUILD IMAGE with az acr build (no local docker needed; immutable SHA tag):');
  log(`    $ ${cmds.build.join(' ')}`);
  log('    #   (no floating latest tag for prod; do NOT use --no-cache)');

  printSecretRefs();

  log('\n2) DEPLOY container app (create if missing, else update; min/max replicas 1):');
  log(`    check : $ ${cmds.show.join(' ')}`);
  log(`    create: $ ${cmds.create.join(' ')}`);
  log(`    update: $ ${cmds.update.join(' ')}`);
  log('    #   NO migrations run here. NO live Meta/WhatsApp/Stripe env set here.');

  log('\n3) POST-DEPLOY HEALTH (not executed in dry-run):');
  log(`    $ ${cmds.health}`);

  log(`\n4) CUSTOM DOMAIN: ${N.staffHostname} is a LATER approval-gated DNS/cert step`);
  log('    (bind hostname + managed cert) unless already configured — not done here.');
}

function dryRun() {
  const sha = '<git-sha>';
  const cmds = buildCommands(sha, `<${ENV_SUBSCRIPTION}>`);
  header('DRY-RUN (default — nothing executed, no env vars required)', sha);
  log('\nThis is DRY-RUN. No az command is executed; nothing is built, pushed, or');
  log('deployed. No migrations run. No live Meta/WhatsApp/Stripe env set. Secret');
  log('VALUES are never printed — only Key Vault secret references.');
  describe(cmds);
  hr();
  log('  DRY-RUN COMPLETE — no changes made.');
  log('  To apply later: WOLFHOUSE_PROD_STAFF_API_DEPLOY_APPLY=1 AZURE_SUBSCRIPTION_ID=<id> \\');
  log('    node scripts/deploy-wolfhouse-prod-staff-api.js --apply');
  log('  (also requires: clean tree, branch master, HEAD == origin/master, az logged in)');
  hr();
  process.exit(0);
}

function apply() {
  const sha = currentSha();
  const sub = process.env[ENV_SUBSCRIPTION] || '';
  const cmds = buildCommands(sha, sub);
  header('APPLY (DANGER)', sha);
  log('');
  log('  ███  DANGER: --apply will BUILD and DEPLOY the Wolfhouse PROD Staff API.  ███');
  log('  No migrations, no live Meta/WhatsApp/Stripe env, no floating latest tag. Review below.\n');

  const failures = applyGuardFailures();
  if (failures.length) {
    log('  APPLY REFUSED — guard checks failed:');
    failures.forEach((f) => log(`    ✗ ${f}`));
    log('\n  No command was executed.');
    hr();
    process.exit(1);
  }

  log('  All guard checks passed. Executing sequentially...\n');

  log('1) BUILD IMAGE (az acr build):');
  if (run(cmds.build) !== 0) { log('   build FAILED. Stopping.'); process.exit(1); }

  printSecretRefs();

  log('\n2) DEPLOY container app:');
  const exists = run(cmds.show) === 0;
  const deployCmd = exists ? cmds.update : cmds.create;
  log(exists ? '   app exists -> update' : '   app missing -> create');
  if (run(deployCmd) !== 0) { log('   deploy FAILED. Stopping.'); process.exit(1); }

  log('\n3) POST-DEPLOY HEALTH:');
  log(`    (run manually) ${cmds.health}`);

  hr();
  log('  APPLY COMPLETE — Staff API built + deployed by immutable SHA tag.');
  log('  Migrations, custom domain, Meta/WhatsApp/Stripe remain separate gated steps.');
  hr();
  process.exit(0);
}

if (APPLY) apply();
else dryRun();
