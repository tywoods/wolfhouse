'use strict';

/**
 * Wolfhouse prod infra — DRY-RUN planner.
 *
 * Prints the Azure resources that WOULD be created/configured for Wolfhouse live,
 * plus the suggested `az` commands. It is DRY-RUN ONLY:
 *   - It never executes any `az` (or any other) command.
 *   - It creates/updates/deletes NOTHING.
 *   - It prints suggested commands as text for a human to review and run later.
 *
 * Source of truth for names: docs/clients/wolfhouse/LIVE-ENV-INVENTORY.md
 * (a small constants block below mirrors that doc; the doc remains canonical).
 *
 * Usage:
 *   node scripts/plan-wolfhouse-prod-infra.js              # dry-run plan (default)
 *   node scripts/plan-wolfhouse-prod-infra.js --acr <name> # override ACR name
 *
 * There is intentionally NO flag that executes anything.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INVENTORY = path.join(ROOT, 'docs', 'clients', 'wolfhouse', 'LIVE-ENV-INVENTORY.md');

// --- planned names (mirror of LIVE-ENV-INVENTORY.md; that doc is canonical) ---
function parseAcrOverride(argv) {
  const i = argv.indexOf('--acr');
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return null;
}

const PLAN = {
  client_slug: 'wolfhouse',
  location_id: 'wolfhouse-somo',
  region: 'northeurope',
  resourceGroup: 'wh-prod-rg',
  acr: parseAcrOverride(process.argv) || 'whprodacr', // default: separate prod ACR
  keyVault: 'wh-prod-kv',
  logAnalytics: 'wh-prod-logs',
  containerAppsEnv: 'wh-prod-env',
  staffApiApp: 'wh-prod-staff-api',
  hermesApp: 'wh-prod-hermes',
  postgresServer: 'wh-prod-pg',
  database: 'wolfhouse_prod',
  staffHostname: 'staff.lunafrontdesk.com',
  hermesHostname: 'hermes.lunafrontdesk.com',
};

// Secret NAMES only — never values.
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

function line(s) { console.log(s); }
function hr() { line('─'.repeat(72)); }

function banner() {
  hr();
  line('  Wolfhouse PROD infra — DRY-RUN plan (NOTHING is created or executed)');
  hr();
  line(`  client_slug      : ${PLAN.client_slug}`);
  line(`  location_id      : ${PLAN.location_id}`);
  line(`  region           : ${PLAN.region}`);
  line(`  inventory source : docs/clients/wolfhouse/LIVE-ENV-INVENTORY.md ${fs.existsSync(INVENTORY) ? '(found)' : '(MISSING)'}`);
  line('');
  line('  This script is DRY-RUN ONLY. It executes no az/CLI commands and');
  line('  creates/updates/deletes no Azure resources. Suggested commands below');
  line('  are TEXT for a human to review and run after approval.');
  hr();
}

function resourceTable() {
  line('\nPLANNED RESOURCES (proposed — not executed):\n');
  const rows = [
    ['Resource group', PLAN.resourceGroup],
    ['Location', PLAN.region],
    ['Container registry (ACR)', PLAN.acr],
    ['Key Vault', PLAN.keyVault],
    ['Log Analytics workspace', PLAN.logAnalytics],
    ['Container Apps environment', PLAN.containerAppsEnv],
    ['Staff API app', PLAN.staffApiApp],
    ['Hermes/Luna app', PLAN.hermesApp],
    ['Postgres server', PLAN.postgresServer],
    ['Database', PLAN.database],
    ['Staff portal DNS', PLAN.staffHostname],
    ['Hermes webhook DNS', PLAN.hermesHostname],
  ];
  for (const [k, v] of rows) line(`  - ${k.padEnd(28)} ${v}`);
}

function secretsBlock() {
  line('\nKEY VAULT SECRET NAMES (names only — NO values, NO secrets in this output):\n');
  for (const s of SECRET_NAMES) line(`  - ${PLAN.keyVault}/${s}`);
  line('\n  Values are operator-provided at provisioning time and never committed.');
}

function suggestedCommands() {
  line('\nSUGGESTED az COMMANDS (printed only — DO NOT executed by this script):\n');
  const cmds = [
    `# Resource group`,
    `az group create --name ${PLAN.resourceGroup} --location ${PLAN.region}`,
    ``,
    `# Container registry (prod) — default separate prod ACR`,
    `az acr create --resource-group ${PLAN.resourceGroup} --name ${PLAN.acr} --sku Basic`,
    ``,
    `# Key Vault`,
    `az keyvault create --resource-group ${PLAN.resourceGroup} --name ${PLAN.keyVault} --location ${PLAN.region}`,
    `#   then: az keyvault secret set --vault-name ${PLAN.keyVault} --name <SECRET_NAME> --value <operator-provided>`,
    ``,
    `# Log Analytics workspace (cost control: 30-day retention)`,
    `az monitor log-analytics workspace create --resource-group ${PLAN.resourceGroup} --workspace-name ${PLAN.logAnalytics} --location ${PLAN.region} --retention-time 30`,
    ``,
    `# Container Apps environment`,
    `az containerapp env create --resource-group ${PLAN.resourceGroup} --name ${PLAN.containerAppsEnv} --location ${PLAN.region} --logs-workspace-id <${PLAN.logAnalytics}-id>`,
    ``,
    `# Postgres (small SKU first; isolated prod server)`,
    `az postgres flexible-server create --resource-group ${PLAN.resourceGroup} --name ${PLAN.postgresServer} --location ${PLAN.region} --tier Burstable --sku-name Standard_B1ms`,
    `#   then create database ${PLAN.database} (forward-only migrations applied separately)`,
    ``,
    `# Staff API app (min replicas 1; build from clean master SHA)`,
    `az containerapp create --resource-group ${PLAN.resourceGroup} --name ${PLAN.staffApiApp} --environment ${PLAN.containerAppsEnv} --image ${PLAN.acr}.azurecr.io/wh-staff-api:<git-sha> --min-replicas 1 --max-replicas 1`,
    ``,
    `# Hermes/Luna app (min replicas 1)`,
    `az containerapp create --resource-group ${PLAN.resourceGroup} --name ${PLAN.hermesApp} --environment ${PLAN.containerAppsEnv} --image ${PLAN.acr}.azurecr.io/wh-hermes:<git-sha> --min-replicas 1 --max-replicas 1`,
  ];
  for (const c of cmds) line(c ? `    ${c}` : '');
}

function approvalGates() {
  line('\nEXPLICIT APPROVAL GATES (must NOT proceed without operator sign-off):\n');
  line('  [ ] Meta webhook change — pointing the Wolfhouse phone_number_id webhook to');
  line(`      https://${PLAN.hermesHostname}/whatsapp/webhook requires explicit approval.`);
  line('  [ ] Stripe live — wiring the live Stripe context + any live charge/refund');
  line('      requires explicit approval. No live Stripe action from this plan.');
  line('  [ ] Flip live_enabled=true for wolfhouse only after the go-live checklist passes.');
}

function footer() {
  line('');
  hr();
  line('  DRY-RUN COMPLETE — no Azure resources were created, updated, or deleted.');
  line('  No az command was executed. This is a plan only.');
  hr();
}

function main() {
  banner();
  resourceTable();
  secretsBlock();
  suggestedCommands();
  approvalGates();
  footer();
  process.exit(0);
}

main();
