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
 *   PHASE 1 — bootstrap identity ( --bootstrap-identity --apply ):
 *     - ensure image exists in ACR (build only if missing)
 *     - create wh-prod-staff-api with --system-assigned + minimal NON-secret env
 *       (no secretrefs yet)
 *     - fetch the app identity principalId (az containerapp identity show)
 *     - assign "Key Vault Secrets User" to that principalId on wh-prod-kv
 *
 *   PHASE 2 — secret wiring (full --apply ):
 *     - self-check: app + system identity + role present (auto-runs PHASE 1 if not)
 *     - verify required Key Vault secrets EXIST by name (no values printed)
 *     - set/refresh secrets via keyvaultref, then update image + env secretrefs
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
  targetPort: '8080',
  staffHostname: 'staff.lunafrontdesk.com',
  appIdentityRole: 'Key Vault Secrets User', // READ — app identity. (Operator uses Secrets Officer to WRITE.)
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
    // PHASE 1: minimal create (system identity, NON-secret env only, NO secretrefs)
    bootstrapCreate: withSub([
      'az', 'containerapp', 'create',
      '--resource-group', N.resourceGroup,
      '--name', N.staffApiApp,
      '--environment', N.containerAppsEnv,
      '--image', fullImage,
      '--system-assigned',
      '--min-replicas', '1', '--max-replicas', '1',
      '--ingress', 'external', '--target-port', N.targetPort,
      '--env-vars', NON_SECRET_ENV,
    ], sub),
    identityAssign: withSub(['az', 'containerapp', 'identity', 'assign', '--name', N.staffApiApp, '--resource-group', N.resourceGroup, '--system-assigned'], sub),
    identityShow: withSub(['az', 'containerapp', 'identity', 'show', '--name', N.staffApiApp, '--resource-group', N.resourceGroup, '--query', 'principalId', '-o', 'tsv'], sub),
    roleList: withSub(['az', 'role', 'assignment', 'list', '--assignee', principalId, '--role', N.appIdentityRole, '--scope', kvScope(sub), '-o', 'tsv'], sub),
    roleCreate: withSub(['az', 'role', 'assignment', 'create', '--assignee', principalId, '--role', N.appIdentityRole, '--scope', kvScope(sub)], sub),
    // PHASE 2: verify secrets exist (by name; --query id => no value printed)
    secretShow: STAFF_SECRET_NAMES.map((s) => withSub(['az', 'keyvault', 'secret', 'show', '--vault-name', N.keyVault, '--name', s, '--query', 'id', '-o', 'tsv'], sub)),
    // PHASE 2: set/refresh secretrefs, then update image + env mappings
    secretSet: withSub(['az', 'containerapp', 'secret', 'set', '--name', N.staffApiApp, '--resource-group', N.resourceGroup, '--secrets', ...secretValues], sub),
    update: withSub(['az', 'containerapp', 'update', '--resource-group', N.resourceGroup, '--name', N.staffApiApp, '--image', fullImage, '--set-env-vars', NON_SECRET_ENV, ...envMappings], sub),
    health: `curl -fsS https://${N.staffHostname}/ >/dev/null && echo "staff api healthy"`,
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
  log('\nPHASE 1 — BOOTSTRAP IDENTITY ( --bootstrap-identity --apply ):');
  log(`    ensure image : $ ${cmds.imageShow.join(' ')}`);
  log(`       (build only if missing) $ ${cmds.build.join(' ')}`);
  log(`    bootstrap create: $ ${cmds.bootstrapCreate.join(' ')}`);
  log(`       (if app exists) identity assign: $ ${cmds.identityAssign.join(' ')}`);
  log(`    principalId  : $ ${cmds.identityShow.join(' ')}`);
  log(`    role check   : $ ${cmds.roleList.join(' ')}`);
  log(`    role assign  : $ ${cmds.roleCreate.join(' ')}`);

  rolesNote();

  log('\nPHASE 2 — SECRET WIRING ( --apply, auto-bootstraps if needed ):');
  log('    verify Key Vault secrets exist (by name; no values printed):');
  cmds.secretShow.forEach((c) => log(`      secret check: $ ${c.join(' ')}`));
  log(`    secret set   : $ ${cmds.secretSet.join(' ')}`);
  log(`    update app   : $ ${cmds.update.join(' ')}`);
  log('    #   NO migrations. NO live Meta/WhatsApp/Stripe env. NO custom domain here.');

  log('\nPOST-DEPLOY HEALTH (not executed in dry-run):');
  log(`    $ ${cmds.health}`);

  log(`\nCUSTOM DOMAIN: ${N.staffHostname} is a LATER approval-gated DNS/cert step — not done here.`);
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

// Ensure image, app+identity, and role. Returns principalId. Used by both phases.
function ensureIdentityAndRole(sub) {
  const sha = currentSha();
  let cmds = buildCommands(sha, sub, '<principalId>');

  log('PHASE 1) ensure image exists (build only if missing):');
  if (cap(cmds.imageShow).status !== 0) {
    log('   image missing -> build');
    if (run(cmds.build) !== 0) { log('   build FAILED. Stopping.'); process.exit(1); }
  } else {
    log('   image already in ACR -> skip build');
  }

  log('\nPHASE 1) ensure app + system identity:');
  const exists = cap(cmds.appShow).status === 0;
  if (!exists) {
    log('   app missing -> bootstrap create (system identity, non-secret env, NO secretrefs)');
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
  log('\nPHASE 1) ensure role assignment (Key Vault Secrets User on wh-prod-kv):');
  const roleExists = cap(cmds.roleList).out !== '';
  if (roleExists) {
    log(`   "${N.appIdentityRole}" already assigned -> skip`);
  } else {
    if (run(cmds.roleCreate) !== 0) { log('   role assignment FAILED. Stopping.'); process.exit(1); }
  }
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

  log('\nPHASE 2) verify required Key Vault secrets exist (by name; no values printed):');
  for (const showCmd of cmds.secretShow) {
    if (cap(showCmd).status !== 0) {
      log('   a required Key Vault secret is missing. Operator must set values first. Stopping.');
      process.exit(1);
    }
  }

  log('\nPHASE 2) set/refresh secret refs:');
  if (run(cmds.secretSet) !== 0) { log('   secret set FAILED. Stopping.'); process.exit(1); }

  log('\nPHASE 2) update app (image + env secretref mappings):');
  if (run(cmds.update) !== 0) { log('   update FAILED. Stopping.'); process.exit(1); }

  log('\nPOST-DEPLOY HEALTH:');
  log(`    (run manually) ${cmds.health}`);

  hr();
  log('  APPLY COMPLETE — Staff API built + deployed by immutable SHA tag, identity +');
  log('  Key Vault secret refs + env wired. Custom domain / Meta / WhatsApp / Stripe');
  log('  remain separate gated steps.');
  hr();
  process.exit(0);
}

if (APPLY) apply();
else dryRun();
