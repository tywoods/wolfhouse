'use strict';

/**
 * Wolfhouse prod Staff API — gated deploy script (Staff API ONLY).
 *
 * DEFAULT IS DRY-RUN. Nothing is built/pushed/deployed unless ALL of the
 * following are true (apply guards):
 *   1. invoked with  --apply
 *   2. env  WOLFHOUSE_PROD_STAFF_API_DEPLOY_APPLY=1
 *   3. env  AZURE_SUBSCRIPTION_ID  is set (explicit subscription)
 *   4. env  WOLFHOUSE_PROD_STAFF_API_IDENTITY_READY=1  (operator confirms the app's
 *      managed identity exists AND has Key Vault get-secret on wh-prod-kv — required
 *      before Key Vault secretrefs can resolve; see "Identity bootstrap" in docs)
 *   5. git working tree is clean
 *   6. current branch is  master
 *   7. local HEAD == origin/master
 *   8. az CLI is installed AND logged in (`az account show` succeeds)
 *
 * Build uses `az acr build` (no local docker required). Deploy is by IMMUTABLE
 * git-SHA tag only (no floating "latest" tag for prod). Secrets come from Key Vault
 * references only — never raw values, never printed. The create AND update paths
 * wire the Key Vault secret references AND the env-var mappings (DATABASE_URL,
 * LUNA_BOT_INTERNAL_TOKEN, WOLFHOUSE_STAFF_SESSION_SECRET) so the Staff API never
 * deploys without its config. This script does NOT run migrations and does NOT set
 * live Meta/WhatsApp/Stripe env (Staff API scope only).
 *
 * Usage:
 *   node scripts/deploy-wolfhouse-prod-staff-api.js              # dry-run (default)
 *   node scripts/deploy-wolfhouse-prod-staff-api.js --dry-run    # explicit dry-run
 *   WOLFHOUSE_PROD_STAFF_API_DEPLOY_APPLY=1 AZURE_SUBSCRIPTION_ID=... \
 *   WOLFHOUSE_PROD_STAFF_API_IDENTITY_READY=1 \
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
const ENV_IDENTITY_READY = 'WOLFHOUSE_PROD_STAFF_API_IDENTITY_READY';
const ENV_IDENTITY = 'WOLFHOUSE_PROD_STAFF_API_IDENTITY'; // optional user-assigned identity resource id; default system

// Staff API secrets ONLY (hyphenated Key Vault names). No Meta/WhatsApp/Stripe here.
const STAFF_SECRET_NAMES = [
  'wolfhouse-prod-database-url',
  'luna-bot-internal-token',
  'wolfhouse-staff-session-secret',
];

// env var name -> secret name mapping (Staff API scope only).
const ENV_TO_SECRET = [
  ['DATABASE_URL', 'wolfhouse-prod-database-url'],
  ['LUNA_BOT_INTERNAL_TOKEN', 'luna-bot-internal-token'],
  ['WOLFHOUSE_STAFF_SESSION_SECRET', 'wolfhouse-staff-session-secret'],
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

// Key Vault secretref values (one per secret): name=keyvaultref:<uri>,identityref:<identity>
function secretRefValues(identity) {
  return STAFF_SECRET_NAMES.map(
    (s) => `${s}=keyvaultref:https://${N.keyVault}.vault.azure.net/secrets/${s},identityref:${identity}`,
  );
}
// env mappings: NAME=secretref:<secret-name>
function envSecretMappings() {
  return ENV_TO_SECRET.map(([envName, secretName]) => `${envName}=secretref:${secretName}`);
}

// Build the command list for a given SHA + subscription + identity.
function buildCommands(sha, sub, identity) {
  const tag = `${N.imageRepo}:${sha}`;
  const fullImage = `${N.acrLoginServer}/${tag}`;
  const secretValues = secretRefValues(identity);
  const envMappings = envSecretMappings();
  const nonSecretEnv = 'DEFAULT_CLIENT=wolfhouse-somo';

  return {
    build: withSub(['az', 'acr', 'build', '--registry', N.acr, '--image', tag, '--file', N.dockerfile, '.'], sub),
    show: withSub(['az', 'containerapp', 'show', '--name', N.staffApiApp, '--resource-group', N.resourceGroup], sub),
    // ensure system-assigned identity on an existing app before refreshing secrets
    identityAssign: withSub(['az', 'containerapp', 'identity', 'assign', '--name', N.staffApiApp, '--resource-group', N.resourceGroup, '--system-assigned'], sub),
    // CREATE: identity + secretrefs + env mappings all wired in one shot
    create: withSub([
      'az', 'containerapp', 'create',
      '--resource-group', N.resourceGroup,
      '--name', N.staffApiApp,
      '--environment', N.containerAppsEnv,
      '--image', fullImage,
      '--system-assigned',
      '--min-replicas', '1', '--max-replicas', '1',
      '--ingress', 'external', '--target-port', N.targetPort,
      '--secrets', ...secretValues,
      '--env-vars', nonSecretEnv, ...envMappings,
    ], sub),
    // UPDATE path step 1: refresh Key Vault secret references
    updateSecrets: withSub(['az', 'containerapp', 'secret', 'set', '--name', N.staffApiApp, '--resource-group', N.resourceGroup, '--secrets', ...secretValues], sub),
    // UPDATE path step 2: update image AND env mappings (not image-only)
    update: withSub(['az', 'containerapp', 'update', '--resource-group', N.resourceGroup, '--name', N.staffApiApp, '--image', fullImage, '--set-env-vars', nonSecretEnv, ...envMappings], sub),
    health: `curl -fsS https://${N.staffHostname}/ >/dev/null && echo "staff api healthy"`,
    fullImage,
  };
}

function identityNote() {
  log('\n  Identity + Key Vault access (required for secretrefs to resolve):');
  log('    # The app uses a system-assigned managed identity (--system-assigned).');
  log(`    # That identity MUST have Key Vault "get secret" (e.g. "Key Vault Secrets User")`);
  log(`    # on ${N.keyVault} BEFORE the secretrefs resolve. Operator bootstrap:`);
  log(`    #   az role assignment create --role "Key Vault Secrets User" \\`);
  log(`    #     --assignee <app-system-identity-principal-id> \\`);
  log(`    #     --scope /subscriptions/<${ENV_SUBSCRIPTION}>/resourceGroups/${N.resourceGroup}/providers/Microsoft.KeyVault/vaults/${N.keyVault}`);
  log(`    # Apply refuses unless ${ENV_IDENTITY_READY}=1 confirms this is done.`);
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
  if (process.env[ENV_IDENTITY_READY] !== '1') {
    failures.push(`env ${ENV_IDENTITY_READY}=1 is not set (managed identity must exist AND have Key Vault get-secret on ${N.keyVault} first — see docs)`);
  }

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

  identityNote();

  log('\n2) DEPLOY container app (create if missing, else update — both wire secrets + env):');
  log(`    check        : $ ${cmds.show.join(' ')}`);
  log(`    create       : $ ${cmds.create.join(' ')}`);
  log('    -- if the app already exists, instead run the update path: --');
  log(`    identity     : $ ${cmds.identityAssign.join(' ')}`);
  log(`    update secrets: $ ${cmds.updateSecrets.join(' ')}`);
  log(`    update app   : $ ${cmds.update.join(' ')}`);
  log('    #   NO migrations run here. NO live Meta/WhatsApp/Stripe env set here.');

  log('\n3) POST-DEPLOY HEALTH (not executed in dry-run):');
  log(`    $ ${cmds.health}`);

  log(`\n4) CUSTOM DOMAIN: ${N.staffHostname} is a LATER approval-gated DNS/cert step`);
  log('    (bind hostname + managed cert) unless already configured — not done here.');
}

function dryRun() {
  const sha = '<git-sha>';
  const cmds = buildCommands(sha, `<${ENV_SUBSCRIPTION}>`, '<identity>');
  header('DRY-RUN (default — nothing executed, no env vars required)', sha);
  log('\nThis is DRY-RUN. No az command is executed; nothing is built, pushed, or');
  log('deployed. No migrations run. No live Meta/WhatsApp/Stripe env set. Secret');
  log('VALUES are never printed — only Key Vault secret references.');
  describe(cmds);
  hr();
  log('  DRY-RUN COMPLETE — no changes made.');
  log(`  To apply later: ${ENV_APPLY_FLAG}=1 ${ENV_SUBSCRIPTION}=<id> ${ENV_IDENTITY_READY}=1 \\`);
  log('    node scripts/deploy-wolfhouse-prod-staff-api.js --apply');
  log('  (also requires: clean tree, branch master, HEAD == origin/master, az logged in)');
  hr();
  process.exit(0);
}

function apply() {
  const sha = currentSha();
  const sub = process.env[ENV_SUBSCRIPTION] || '';
  const identity = process.env[ENV_IDENTITY] || 'system';
  const cmds = buildCommands(sha, sub, identity);
  header('APPLY (DANGER)', sha);
  log('');
  log('  ███  DANGER: --apply will BUILD and DEPLOY the Wolfhouse PROD Staff API.  ███');
  log('  No migrations, no live Meta/WhatsApp/Stripe env, no floating latest. Review below.\n');

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

  identityNote();

  log('\n2) DEPLOY container app:');
  const exists = run(cmds.show) === 0;
  if (!exists) {
    log('   app missing -> create (identity + secrets + env wired in create)');
    if (run(cmds.create) !== 0) { log('   create FAILED. Stopping.'); process.exit(1); }
  } else {
    log('   app exists -> update (identity, then secrets, then image + env)');
    if (run(cmds.identityAssign) !== 0) { log('   identity assign FAILED. Stopping.'); process.exit(1); }
    if (run(cmds.updateSecrets) !== 0) { log('   secret set FAILED. Stopping.'); process.exit(1); }
    if (run(cmds.update) !== 0) { log('   update FAILED. Stopping.'); process.exit(1); }
  }

  log('\n3) POST-DEPLOY HEALTH:');
  log(`    (run manually) ${cmds.health}`);

  hr();
  log('  APPLY COMPLETE — Staff API built + deployed by immutable SHA tag, with');
  log('  Key Vault secret refs + env wired. Custom domain / Meta / WhatsApp / Stripe');
  log('  remain separate gated steps.');
  hr();
  process.exit(0);
}

if (APPLY) apply();
else dryRun();
