'use strict';

/**
 * Wolfhouse prod app deploy — DRY-RUN planner.
 *
 * Prints the proposed docker build/tag/push and `az containerapp` create/update
 * commands to deploy the Wolfhouse prod Staff API and Hermes/Luna apps. It is
 * DRY-RUN ONLY:
 *   - It executes NO docker and NO az command.
 *   - It deploys nothing, creates/updates nothing.
 *   - It prints suggested commands as TEXT for a human to review and run later.
 *   - It never prints or requires secret VALUES — only Key Vault secret NAMES /
 *     secret references.
 *
 * Names mirror docs/clients/wolfhouse/LIVE-ENV-INVENTORY.md and PROD-INFRA-PLAN.md.
 *
 * Usage:
 *   node scripts/plan-wolfhouse-prod-app-deploy.js
 *   node scripts/plan-wolfhouse-prod-app-deploy.js --sha <git-sha>   # label the tag
 *
 * There is intentionally NO flag that deploys anything.
 */

const N = {
  region: 'northeurope',
  resourceGroup: 'wh-prod-rg',
  acr: 'whprodacr',
  acrLoginServer: 'whprodacr.azurecr.io',
  keyVault: 'wh-prod-kv',
  containerAppsEnv: 'wh-prod-env',
  staffApiApp: 'wh-prod-staff-api',
  hermesApp: 'wh-prod-hermes',
  database: 'wolfhouse_prod',
  staffHostname: 'staff.lunafrontdesk.com',
  hermesHostname: 'hermes.lunafrontdesk.com',
};

function shaArg(argv) {
  const i = argv.indexOf('--sha');
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return '<git-sha>';
}
const SHA = shaArg(process.argv.slice(2));

// Key Vault secret NAMES (hyphenated) referenced via secretref — never values.
const SECRET_NAMES = [
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

function line(s) { console.log(s); }
function hr() { line('─'.repeat(72)); }

function banner() {
  hr();
  line('  Wolfhouse PROD app deploy — DRY-RUN plan (NOTHING is deployed or executed)');
  hr();
  line(`  staff api : ${N.staffApiApp}`);
  line(`  hermes    : ${N.hermesApp}`);
  line(`  acr       : ${N.acr} (${N.acrLoginServer})`);
  line(`  ca-env    : ${N.containerAppsEnv}`);
  line(`  rg        : ${N.resourceGroup}`);
  line(`  database  : ${N.database}`);
  line(`  image tag : ${SHA} (immutable; NO :latest for prod)`);
  line('');
  line('  DRY-RUN ONLY. No docker/az command is executed; nothing is built, pushed,');
  line('  or deployed. Secret VALUES are never printed — only Key Vault secret refs.');
  hr();
}

function buildAndPush() {
  line('\n1) BUILD + PUSH IMAGE (from CLEAN git SHA only; immutable tag; no :latest):\n');
  [
    '# Preflight: assert clean, pushed master before any build',
    'node scripts/assert-repo-sync.js',
    'SHA=$(git rev-parse HEAD)   # must equal origin/master',
    '',
    '# Build immutable, SHA-tagged images in ACR (no :latest tag for prod)',
    `az acr build --registry ${N.acr} --image wh-staff-api:${SHA} -f Dockerfile .`,
    `az acr build --registry ${N.acr} --image wh-hermes:${SHA} -f docker/hermes-staging/Dockerfile .`,
    '#   (do NOT use --no-cache; it silently fails the build)',
  ].forEach((c) => line(c ? `    ${c}` : ''));
}

function secretRefs() {
  line('\n2) ENV via KEY VAULT SECRET REFERENCES (names only — no raw secret VALUES):\n');
  line(`    # App managed identity must have GET on ${N.keyVault} secrets; values set by operator.`);
  for (const s of SECRET_NAMES) {
    line(`    --secrets ${s}=keyvaultref:https://${N.keyVault}.vault.azure.net/secrets/${s},identityref:<app-managed-identity>`);
  }
  line('\n    Env var  <-  secret reference (arrow = mapping; never a raw value):');
  line('      DATABASE_URL          <- secretref:wolfhouse-prod-database-url');
  line('      bot internal token    <- secretref:luna-bot-internal-token');
  line('      staff session secret  <- secretref:wolfhouse-staff-session-secret');
  line('      whatsapp phone id     <- secretref:wolfhouse-whatsapp-phone-number-id');
  line('      whatsapp access token <- secretref:wolfhouse-whatsapp-access-token');
  line('      meta app secret       <- secretref:wolfhouse-meta-app-secret');
  line('      meta verify token     <- secretref:wolfhouse-meta-verify-token');
  line('      stripe secret key     <- secretref:wolfhouse-stripe-secret-key');
  line('      stripe webhook secret <- secretref:wolfhouse-stripe-webhook-secret');
  line(`    # non-secret env:  DEFAULT_CLIENT=wolfhouse-somo  (target DB: ${N.database})`);
}

function deployStaffApi() {
  line('\n3) DEPLOY STAFF API (create or update; min replicas 1; health check):\n');
  [
    `az containerapp create --resource-group ${N.resourceGroup} --name ${N.staffApiApp} \\`,
    `  --environment ${N.containerAppsEnv} \\`,
    `  --image ${N.acrLoginServer}/wh-staff-api:${SHA} \\`,
    '  --min-replicas 1 --max-replicas 1 \\',
    '  --ingress external --target-port 8080 \\',
    '  --env-vars DEFAULT_CLIENT=wolfhouse-somo \\',
    '  # plus secret env via secretref mappings from step 2 (database-url, bot token, session secret)',
    `#   custom domain (bind after cert):  ${N.staffHostname}`,
    `#   health: GET https://${N.staffHostname}/  and key /staff/* return 200`,
    '#   update an existing app instead:  az containerapp update --name ' + N.staffApiApp + ' --image ' + N.acrLoginServer + '/wh-staff-api:' + SHA,
  ].forEach((c) => line(`    ${c}`));
}

function deployHermes() {
  line('\n4) DEPLOY HERMES/LUNA (create or update; min replicas 1; bound to Staff API):\n');
  [
    `az containerapp create --resource-group ${N.resourceGroup} --name ${N.hermesApp} \\`,
    `  --environment ${N.containerAppsEnv} \\`,
    `  --image ${N.acrLoginServer}/wh-hermes:${SHA} \\`,
    '  --min-replicas 1 --max-replicas 1 \\',
    '  --ingress external --target-port 8080 \\',
    `  --env-vars STAFF_API_BASE_URL=https://${N.staffHostname} \\`,
    '  # plus secret env via secretref mappings from step 2 (bot token, whatsapp phone id +',
    '  # access token, meta app secret + verify token) — never raw values',
    `#   custom domain (bind after cert):  ${N.hermesHostname}`,
    `#   health: Hermes liveness on https://${N.hermesHostname}/`,
  ].forEach((c) => line(`    ${c}`));
}

function costAndHealth() {
  line('\n5) COST CONTROLS + HEALTH:\n');
  [
    'min replicas 1 / max replicas 1 (no autoscale unless load proven)',
    'small SKUs first; scale up only with evidence',
    'staff: GET / and key /staff/* -> 200; served portal JS parses clean',
    'hermes: liveness OK; bot tools reach prod Staff API',
    'deploy by immutable :<git-sha> tag only (no :latest in prod)',
  ].forEach((c) => line(`    - ${c}`));
}

function rollback() {
  line('\n6) ROLLBACK IMAGE-TAG STRATEGY:\n');
  [
    'record the previous known-good :<git-sha> tag before deploying',
    'rollback = az containerapp update --image ' + N.acrLoginServer + '/wh-staff-api:<previous-sha> (and wh-hermes)',
    'keep the prior healthy revision until the new one is verified',
    'see docs/clients/wolfhouse/LIVE-ROLLBACK-RUNBOOK.md',
  ].forEach((c) => line(`    - ${c}`));
}

function approvalGates() {
  line('\n7) EXPLICIT APPROVAL GATES (do NOT proceed without sign-off):\n');
  [
    'NO DB migrations until explicit approval (deploy does not migrate).',
    'NO live Meta webhook change until explicit approval.',
    'NO Stripe live enablement until explicit approval.',
    'NO outbound WhatsApp to real guests until an approved smoke test (approved number only).',
    'Flip live_enabled=true for wolfhouse only after GO-LIVE-CHECKLIST.md passes.',
  ].forEach((c) => line(`    [ ] ${c}`));
}

function footer() {
  line('');
  hr();
  line('  DRY-RUN COMPLETE — no docker/az command was executed. Nothing was built,');
  line('  pushed, or deployed. No migrations, Meta, Stripe, or WhatsApp changes. Plan only.');
  hr();
}

banner();
buildAndPush();
secretRefs();
deployStaffApi();
deployHermes();
costAndHealth();
rollback();
approvalGates();
footer();
process.exit(0);
