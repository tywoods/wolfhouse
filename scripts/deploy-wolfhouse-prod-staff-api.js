'use strict';

/**
 * Wolfhouse prod Staff API — gated deploy script with two-phase identity bootstrap.
 *
 * DEFAULT IS DRY-RUN. Nothing is built/pushed/deployed unless invoked with --apply
 * AND all guards pass:
 *   1. env  WOLFHOUSE_PROD_STAFF_API_DEPLOY_APPLY=1
 *   2. env  AZURE_SUBSCRIPTION_ID  is set (explicit subscription)
 *   3. git working tree clean, branch master, HEAD == origin/master
 *   4. az CLI installed AND logged in (`az account show`)
 *
 * Key Vault secretrefs are a chicken-and-egg for a NEW Container App: the secretref
 * needs the app's system-assigned identity to hold "Key Vault Secrets User" on
 * wh-prod-kv, but that identity's principalId does not exist until the app is
 * created. This script handles it with a two-phase flow and SELF-CHECKS state (it
 * does not rely on a blind human "identity ready" flag):
 *
 *   PHASE 1 — bootstrap identity + ACR access ( --bootstrap-identity --apply ):
 *     - create wh-prod-staff-api from a PUBLIC placeholder image
 *       (mcr.microsoft.com/azuredocs/containerapps-helloworld:latest, port 80) with
 *       --system-assigned + minimal NON-secret env — NOT the private ACR image, so
 *       the first create cannot fail with ACR UNAUTHORIZED; no secretrefs yet
 *     - fetch the app identity principalId (az containerapp identity show)
 *     - assign "AcrPull" on whprodacr to that identity (so it can pull the image)
 *     - assign "Key Vault Secrets User" on wh-prod-kv to that identity
 *     - az containerapp registry set --server whprodacr.azurecr.io --identity system
 *
 *   PHASE 2 — image + secret wiring (full --apply ):
 *     - self-check: app + identity + AcrPull + KV role + registry (auto-runs PHASE 1)
 *     - ensure the private ACR image exists (build only if missing)
 *     - verify required Key Vault secrets EXIST by name (no values printed)
 *     - set/refresh secrets via keyvaultref, update to the whprodacr image + env
 *       secretrefs, then switch ingress target port to 3036 (placeholder was 80)
 *
 * Roles: the APP identity needs only "Key Vault Secrets User" (read). The HUMAN
 * operator who sets the secret VALUES needs "Key Vault Secrets Officer" (write) —
 * that is an operator step, not done by this script. Build uses `az acr build`;
 * deploy is by IMMUTABLE git-SHA tag (no floating "latest"). No raw secrets are
 * printed. This script runs NO migrations and sets NO Meta/WhatsApp/Stripe env.
 *
 * Usage:
 *   node scripts/deploy-wolfhouse-prod-staff-api.js                       # dry-run (default)
 *   node scripts/deploy-wolfhouse-prod-staff-api.js --dry-run             # explicit dry-run
 *   WOLFHOUSE_PROD_STAFF_API_DEPLOY_APPLY=1 AZURE_SUBSCRIPTION_ID=... \
 *     node scripts/deploy-wolfhouse-prod-staff-api.js --bootstrap-identity --apply   # phase 1
 *   WOLFHOUSE_PROD_STAFF_API_DEPLOY_APPLY=1 AZURE_SUBSCRIPTION_ID=... \
 *     node scripts/deploy-wolfhouse-prod-staff-api.js --apply                        # phase 2 (auto-bootstraps)
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
  // The Staff API process listens on 3036 — the final ingress target port (the
  // helloworld placeholder serves on 80; ingress is switched to 3036 after swap).
  targetPort: '3036',
  placeholderPort: '80',
  // Public placeholder image used ONLY to bootstrap the app + its identity before
  // the app can pull from the private ACR (avoids the first-create ACR UNAUTHORIZED).
  placeholderImage: 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest',
  staffHostname: 'staff.lunafrontdesk.com',
  appIdentityRole: 'Key Vault Secrets User', // READ — app identity. (Operator uses Secrets Officer to WRITE.)
  acrPullRole: 'AcrPull', // app identity needs AcrPull on whprodacr to pull the private image
};

const ENV_APPLY_FLAG = 'WOLFHOUSE_PROD_STAFF_API_DEPLOY_APPLY';
const ENV_SUBSCRIPTION = 'AZURE_SUBSCRIPTION_ID';

// Staff API secrets ONLY (hyphenated Key Vault names). No Meta/WhatsApp/Stripe here.
const STAFF_SECRET_NAMES = [
  'wolfhouse-prod-database-url',
  'luna-bot-internal-token',
  'wolfhouse-staff-session-secret',
];
const ENV_TO_SECRET = [
  ['DATABASE_URL', 'wolfhouse-prod-database-url'],
  ['LUNA_BOT_INTERNAL_TOKEN', 'luna-bot-internal-token'],
  ['WOLFHOUSE_STAFF_SESSION_SECRET', 'wolfhouse-staff-session-secret'],
];
const NON_SECRET_ENV = 'DEFAULT_CLIENT=wolfhouse-somo';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const BOOTSTRAP = argv.includes('--bootstrap-identity');
const DRY_RUN = !APPLY;

function log(s) { console.log(s); }
function hr() { log('─'.repeat(72)); }

// ----------------------------------------------------------------------------
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim() };
}
function currentSha() { return git(['rev-parse', 'HEAD']).out || '<git-sha>'; }
function withSub(cmd, sub) { return [...cmd, '--subscription', sub]; }

function kvScope(sub) {
  return `/subscriptions/${sub}/resourceGroups/${N.resourceGroup}/providers/Microsoft.KeyVault/vaults/${N.keyVault}`;
}
function acrScope(sub) {
  return `/subscriptions/${sub}/resourceGroups/${N.resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${N.acr}`;
}
function secretRefValues(identity) {
  return STAFF_SECRET_NAMES.map(
    (s) => `${s}=keyvaultref:https://${N.keyVault}.vault.azure.net/secrets/${s},identityref:${identity}`,
  );
}
function envSecretMappings() {
  return ENV_TO_SECRET.map(([e, s]) => `${e}=secretref:${s}`);
}

// Structured command list (identity 'system' for secretrefs; principalId for role).
function buildCommands(sha, sub, principalId) {
  const tag = `${N.imageRepo}:${sha}`;
  const fullImage = `${N.acrLoginServer}/${tag}`;
  const secretValues = secretRefValues('system');
  const envMappings = envSecretMappings();
  return {
    imageShow: withSub(['az', 'acr', 'repository', 'show', '--name', N.acr, '--image', tag], sub),
    build: withSub(['az', 'acr', 'build', '--registry', N.acr, '--image', tag, '--file', N.dockerfile, '.'], sub),
    appShow: withSub(['az', 'containerapp', 'show', '--name', N.staffApiApp, '--resource-group', N.resourceGroup], sub),
    // PHASE 1: minimal create with a PUBLIC PLACEHOLDER image (NOT the private ACR
    // image) so the first create can't hit ACR UNAUTHORIZED; system identity; NO
    // secretrefs; placeholder serves on port 80 (ingress switched to 3036 later).
    bootstrapCreate: withSub([
      'az', 'containerapp', 'create',
      '--resource-group', N.resourceGroup,
      '--name', N.staffApiApp,
      '--environment', N.containerAppsEnv,
      '--image', N.placeholderImage,
      '--system-assigned',
      '--min-replicas', '1', '--max-replicas', '1',
      '--ingress', 'external', '--target-port', N.placeholderPort,
      '--env-vars', NON_SECRET_ENV,
    ], sub),
    identityAssign: withSub(['az', 'containerapp', 'identity', 'assign', '--name', N.staffApiApp, '--resource-group', N.resourceGroup, '--system-assigned'], sub),
    identityShow: withSub(['az', 'containerapp', 'identity', 'show', '--name', N.staffApiApp, '--resource-group', N.resourceGroup, '--query', 'principalId', '-o', 'tsv'], sub),
    // app identity needs AcrPull on whprodacr to pull the private image
    acrPullList: withSub(['az', 'role', 'assignment', 'list', '--assignee', principalId, '--role', N.acrPullRole, '--scope', acrScope(sub), '-o', 'tsv'], sub),
    acrPullCreate: withSub(['az', 'role', 'assignment', 'create', '--assignee', principalId, '--role', N.acrPullRole, '--scope', acrScope(sub)], sub),
    roleList: withSub(['az', 'role', 'assignment', 'list', '--assignee', principalId, '--role', N.appIdentityRole, '--scope', kvScope(sub), '-o', 'tsv'], sub),
    roleCreate: withSub(['az', 'role', 'assignment', 'create', '--assignee', principalId, '--role', N.appIdentityRole, '--scope', kvScope(sub)], sub),
    // wire the app to pull from whprodacr using its managed identity
    registrySet: withSub(['az', 'containerapp', 'registry', 'set', '--name', N.staffApiApp, '--resource-group', N.resourceGroup, '--server', N.acrLoginServer, '--identity', 'system'], sub),
    // PHASE 2: verify secrets exist (by name; --query id => no value printed)
    secretShow: STAFF_SECRET_NAMES.map((s) => withSub(['az', 'keyvault', 'secret', 'show', '--vault-name', N.keyVault, '--name', s, '--query', 'id', '-o', 'tsv'], sub)),
    // PHASE 2: set/refresh secretrefs, swap to the private ACR image + env mappings
    secretSet: withSub(['az', 'containerapp', 'secret', 'set', '--name', N.staffApiApp, '--resource-group', N.resourceGroup, '--secrets', ...secretValues], sub),
    update: withSub(['az', 'containerapp', 'update', '--resource-group', N.resourceGroup, '--name', N.staffApiApp, '--image', fullImage, '--set-env-vars', NON_SECRET_ENV, ...envMappings], sub),
    // switch ingress to the real Staff API port (placeholder was 80)
    ingressSet: withSub(['az', 'containerapp', 'ingress', 'update', '--name', N.staffApiApp, '--resource-group', N.resourceGroup, '--target-port', N.targetPort], sub),
    // health prefers the generated Container Apps FQDN until staff.lunafrontdesk.com is bound
    fqdnShow: withSub(['az', 'containerapp', 'show', '--name', N.staffApiApp, '--resource-group', N.resourceGroup, '--query', 'properties.configuration.ingress.fqdn', '-o', 'tsv'], sub),
    health: `FQDN=$(az containerapp show --name ${N.staffApiApp} --resource-group ${N.resourceGroup} --query properties.configuration.ingress.fqdn -o tsv); curl -fsS "https://$FQDN/staff/ui" >/dev/null && echo "staff api healthy ($FQDN) — expect HTTP 200, x-powered-by: wolfhouse-staff-api"`,
  };
}

function rolesNote() {
  log('\n  Roles (least privilege):');
  log(`    - APP system-assigned identity needs "${N.appIdentityRole}" (READ) on ${N.keyVault}.`);
  log('    - HUMAN operator needs "Key Vault Secrets Officer" (WRITE) to SET secret VALUES');
  log('      (operator step; this script never sets or prints secret values).');
  log('    - Meta / WhatsApp / Stripe secrets are NOT set by this Staff API deploy.');
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
function cap(cmd) {
  log(`    $ ${cmd.join(' ')}`);
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '').trim() };
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
  log('\nPHASE 1 — BOOTSTRAP IDENTITY + ACR ACCESS ( --bootstrap-identity --apply ):');
  log(`    bootstrap create (PUBLIC placeholder image, port ${N.placeholderPort}, NO ACR, NO secrets):`);
  log(`       $ ${cmds.bootstrapCreate.join(' ')}`);
  log(`       (if app exists) identity assign: $ ${cmds.identityAssign.join(' ')}`);
  log(`    principalId   : $ ${cmds.identityShow.join(' ')}`);
  log(`    AcrPull check : $ ${cmds.acrPullList.join(' ')}`);
  log(`    AcrPull assign: $ ${cmds.acrPullCreate.join(' ')}`);
  log(`    KV role check : $ ${cmds.roleList.join(' ')}`);
  log(`    KV role assign: $ ${cmds.roleCreate.join(' ')}`);
  log(`    registry set  : $ ${cmds.registrySet.join(' ')}`);

  rolesNote();

  log('\nPHASE 2 — IMAGE + SECRET WIRING ( --apply, auto-bootstraps if needed ):');
  log(`    ensure image  : $ ${cmds.imageShow.join(' ')}`);
  log(`       (build only if missing) $ ${cmds.build.join(' ')}`);
  log('    verify Key Vault secrets exist (by name; no values printed):');
  cmds.secretShow.forEach((c) => log(`      secret check: $ ${c.join(' ')}`));
  log(`    secret set    : $ ${cmds.secretSet.join(' ')}`);
  log(`    update app    : $ ${cmds.update.join(' ')}`);
  log(`    ingress port  : $ ${cmds.ingressSet.join(' ')}   # switch placeholder ${N.placeholderPort} -> ${N.targetPort}`);
  log('    #   NO migrations. NO live Meta/WhatsApp/Stripe env. NO custom domain here.');

  log('\nPOST-DEPLOY HEALTH (not executed in dry-run; prefers generated FQDN):');
  log(`    fqdn : $ ${cmds.fqdnShow.join(' ')}`);
  log(`    check: ${cmds.health}`);

  log(`\nCUSTOM DOMAIN: ${N.staffHostname} is a LATER approval-gated DNS/cert step — not`);
  log('    done here; health uses the generated Container Apps FQDN until it is bound.');
}

function dryRun() {
  const sha = '<git-sha>';
  const cmds = buildCommands(sha, `<${ENV_SUBSCRIPTION}>`, '<principalId>');
  header('DRY-RUN (default — nothing executed, no env vars required)', sha);
  log('\nThis is DRY-RUN. No az command is executed; nothing is built, pushed, or');
  log('deployed. No migrations run. No live Meta/WhatsApp/Stripe env set. Secret');
  log('VALUES are never printed — only Key Vault secret references.');
  describe(cmds);
  hr();
  log('  DRY-RUN COMPLETE — no changes made.');
  log(`  Phase 1: ${ENV_APPLY_FLAG}=1 ${ENV_SUBSCRIPTION}=<id> node scripts/deploy-wolfhouse-prod-staff-api.js --bootstrap-identity --apply`);
  log(`  Phase 2: ${ENV_APPLY_FLAG}=1 ${ENV_SUBSCRIPTION}=<id> node scripts/deploy-wolfhouse-prod-staff-api.js --apply`);
  log('  (both also require: clean tree, branch master, HEAD == origin/master, az logged in)');
  hr();
  process.exit(0);
}

// Ensure app+identity, AcrPull, Key Vault role, and registry wiring. Returns
// principalId. Used by both phases. Uses a PUBLIC placeholder for first create.
function ensureIdentityAndRole(sub) {
  const sha = currentSha();
  let cmds = buildCommands(sha, sub, '<principalId>');

  log('PHASE 1) ensure app + system identity:');
  const exists = cap(cmds.appShow).status === 0;
  if (!exists) {
    log(`   app missing -> bootstrap create with PUBLIC placeholder image (${N.placeholderImage})`);
    log('   (avoids first-create ACR UNAUTHORIZED; no ACR image, no secretrefs yet)');
    if (run(cmds.bootstrapCreate) !== 0) { log('   create FAILED. Stopping.'); process.exit(1); }
  } else {
    log('   app exists -> ensure system identity');
    if (run(cmds.identityAssign) !== 0) { log('   identity assign FAILED. Stopping.'); process.exit(1); }
  }

  log('\nPHASE 1) fetch app identity principalId:');
  const pid = cap(cmds.identityShow);
  if (pid.status !== 0 || !pid.out) { log('   could not read principalId. Stopping.'); process.exit(1); }
  const principalId = pid.out;

  // rebuild commands with the real principalId for role steps
  cmds = buildCommands(sha, sub, principalId);

  log('\nPHASE 1) ensure AcrPull on whprodacr for the app identity:');
  if (cap(cmds.acrPullList).out !== '') {
    log(`   "${N.acrPullRole}" already assigned -> skip`);
  } else if (run(cmds.acrPullCreate) !== 0) { log('   AcrPull assignment FAILED. Stopping.'); process.exit(1); }

  log('\nPHASE 1) ensure Key Vault Secrets User on wh-prod-kv for the app identity:');
  if (cap(cmds.roleList).out !== '') {
    log(`   "${N.appIdentityRole}" already assigned -> skip`);
  } else if (run(cmds.roleCreate) !== 0) { log('   role assignment FAILED. Stopping.'); process.exit(1); }

  log('\nPHASE 1) wire app to pull from whprodacr via managed identity:');
  if (run(cmds.registrySet) !== 0) { log('   registry set FAILED. Stopping.'); process.exit(1); }

  return { sha, principalId };
}

function apply() {
  const sub = process.env[ENV_SUBSCRIPTION] || '';
  const sha = currentSha();
  header(BOOTSTRAP ? 'APPLY — bootstrap identity only (DANGER)' : 'APPLY — full deploy (DANGER)', sha);
  log('');
  log('  ███  DANGER: --apply will create/modify Wolfhouse PROD resources.  ███');
  log('  No migrations, no live Meta/WhatsApp/Stripe env, no floating latest.\n');

  const failures = applyGuardFailures();
  if (failures.length) {
    log('  APPLY REFUSED — guard checks failed:');
    failures.forEach((f) => log(`    ✗ ${f}`));
    log('\n  No command was executed.');
    hr();
    process.exit(1);
  }
  log('  All guard checks passed.\n');

  const { principalId } = ensureIdentityAndRole(sub);
  rolesNote();

  if (BOOTSTRAP) {
    hr();
    log('  PHASE 1 COMPLETE — app + identity + role ready.');
    log('  Next: operator (Key Vault Secrets Officer) sets the secret VALUES, then run');
    log(`  full apply: ${ENV_APPLY_FLAG}=1 ${ENV_SUBSCRIPTION}=<id> node scripts/deploy-wolfhouse-prod-staff-api.js --apply`);
    hr();
    process.exit(0);
  }

  const cmds = buildCommands(sha, sub, principalId);

  log('\nPHASE 2) ensure private ACR image exists (build only if missing):');
  if (cap(cmds.imageShow).status !== 0) {
    log('   image missing -> build');
    if (run(cmds.build) !== 0) { log('   build FAILED. Stopping.'); process.exit(1); }
  } else {
    log('   image already in ACR -> skip build');
  }

  log('\nPHASE 2) verify required Key Vault secrets exist (by name; no values printed):');
  for (const showCmd of cmds.secretShow) {
    if (cap(showCmd).status !== 0) {
      log('   a required Key Vault secret is missing. Operator must set values first. Stopping.');
      process.exit(1);
    }
  }

  log('\nPHASE 2) set/refresh secret refs:');
  if (run(cmds.secretSet) !== 0) { log('   secret set FAILED. Stopping.'); process.exit(1); }

  log('\nPHASE 2) update app to the private ACR image (+ env secretref mappings):');
  if (run(cmds.update) !== 0) { log('   update FAILED. Stopping.'); process.exit(1); }

  log(`\nPHASE 2) switch ingress target port to ${N.targetPort} (placeholder was ${N.placeholderPort}):`);
  if (run(cmds.ingressSet) !== 0) { log('   ingress update FAILED. Stopping.'); process.exit(1); }

  log('\nPOST-DEPLOY HEALTH (prefers generated FQDN until staff.lunafrontdesk.com bound):');
  log(`    (run manually) ${cmds.health}`);

  hr();
  log('  APPLY COMPLETE — Staff API deployed by immutable SHA tag from whprodacr, with');
  log(`  managed-identity ACR pull + Key Vault secret refs + env wired, ingress port ${N.targetPort}.`);
  log('  Custom domain / Meta / WhatsApp / Stripe remain separate gated steps.');
  hr();
  process.exit(0);
}

if (APPLY) apply();
else dryRun();
