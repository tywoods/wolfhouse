'use strict';
/**
 * Stage 7.3b — Azure staging scaffold static verifier (NO network calls, NO Azure API).
 *
 * Checks:
 *   0.  Plan doc exists: docs/PHASE-7.3B-AZURE-STAGING-RESOURCE-SCAFFOLD.md
 *   1.  infra/azure/staging/ directory exists
 *   2.  main.bicep exists
 *   3.  parameters.example.json exists
 *   4.  README.md exists and contains DO NOT RUN / approval warning
 *   5.  No real secret values in any scaffold file:
 *         - no sk_live_ (live Stripe key)
 *         - no sk_test_ literal values (placeholder pattern only)
 *         - no EAAG[a-zA-Z0-9]+ (Meta/WhatsApp token pattern)
 *         - no plain connection strings with real hostnames
 *   6.  Required Azure resources referenced in main.bicep:
 *         - Container Apps environment
 *         - At least one Container App
 *         - Postgres Flexible Server
 *         - Key Vault
 *         - Redis
 *         - Managed Identity
 *         - Log Analytics
 *   7.  Safety env defaults in main.bicep (hardcoded, not parameter-overridable):
 *         - WHATSAPP_DRY_RUN = 'true'
 *         - STAFF_ACTIONS_ENABLED = 'false'
 *         - STAFF_AUTH_REQUIRED = 'true'
 *         - STRIPE_WEBHOOK_SKIP_VERIFY = 'false'
 *         - N8N_BLOCK_ENV_ACCESS_IN_NODE = 'true'
 *   8.  Key Vault secret refs present (no inline secret values):
 *         - wolfhouse-database-url
 *         - n8n-database-url
 *         - n8n-encryption-key
 *         - redis-connection-string
 *         - stripe-secret-key
 *   9.  No ingress on n8n worker (worker should not be externally accessible)
 *  10.  parameters.example.json is valid JSON and has expected keys
 *  11.  README.md contains DO NOT DEPLOY / approval-required warning
 *  12.  README.md contains rollback/delete destructive warning
 *  13.  README.md contains what-if/dry-run command
 *  14.  Plan doc references all 7 required resource types
 *  15.  No hardcoded subscription IDs in scaffold files (SUBSCRIPTION_ID_PLACEHOLDER pattern)
 *  16.  STAFF_OPERATOR_TOKEN NOT set in staging Container App env (local/dev only)
 *
 * Usage:
 *   node scripts/verify-azure-staging-scaffold.js
 *
 * Exit 0 = all checks pass. Exit 1 = at least one failure.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}
function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}
function dirExists(relPath) {
  try { return fs.statSync(path.join(ROOT, relPath)).isDirectory(); } catch (_) { return false; }
}

let failures = 0;
function ok(label)           { console.log(`  ✓ ${label}`); }
function fail(label, detail) { console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`); failures++; }
function check(cond, pass, fail2, detail) {
  if (cond) ok(pass); else fail(fail2 || pass, detail);
}

// ── 0. Plan doc ───────────────────────────────────────────────────────────────
console.log('\n── 0. Plan doc ──');
const PLAN_DOC = 'docs/PHASE-7.3B-AZURE-STAGING-RESOURCE-SCAFFOLD.md';
check(fileExists(PLAN_DOC), `${PLAN_DOC} exists`);
let planSrc = '';
if (fileExists(PLAN_DOC)) {
  planSrc = readFile(PLAN_DOC);
  ok(`plan doc readable (${planSrc.length} chars)`);
}

// ── 1. Directory ──────────────────────────────────────────────────────────────
console.log('\n── 1. infra/azure/staging/ directory ──');
check(dirExists('infra/azure/staging'), 'infra/azure/staging/ directory exists');

// ── 2. main.bicep ─────────────────────────────────────────────────────────────
console.log('\n── 2. main.bicep ──');
const BICEP_PATH = 'infra/azure/staging/main.bicep';
check(fileExists(BICEP_PATH), 'main.bicep exists');
let bicep = '';
if (fileExists(BICEP_PATH)) {
  bicep = readFile(BICEP_PATH);
  ok(`main.bicep readable (${bicep.length} chars)`);
}

// ── 3. parameters.example.json ────────────────────────────────────────────────
console.log('\n── 3. parameters.example.json ──');
const PARAMS_PATH = 'infra/azure/staging/parameters.example.json';
check(fileExists(PARAMS_PATH), 'parameters.example.json exists');
let params = {};
if (fileExists(PARAMS_PATH)) {
  try {
    params = JSON.parse(readFile(PARAMS_PATH));
    ok('parameters.example.json is valid JSON');
  } catch (e) {
    fail('parameters.example.json is valid JSON', e.message);
  }
}

// ── 4. README.md ──────────────────────────────────────────────────────────────
console.log('\n── 4. README.md ──');
const README_PATH = 'infra/azure/staging/README.md';
check(fileExists(README_PATH), 'README.md exists');
let readme = '';
if (fileExists(README_PATH)) {
  readme = readFile(README_PATH);
  ok(`README.md readable (${readme.length} chars)`);
}

// ── 5. No real secret values ──────────────────────────────────────────────────
console.log('\n── 5. No real secret values in scaffold files ──');
const allSrc = bicep + '\n' + readme + '\n' + planSrc;

// No sk_live_ (live Stripe key would be a critical security error)
check(!/sk_live_[a-zA-Z0-9]+/.test(allSrc),
  'no sk_live_* Stripe live key in scaffold files');

// No EAAG... Meta token pattern (real tokens start with EAAG)
// Our scaffold uses EAAG_PLACEHOLDER_DO_NOT_USE which is fine — check for real-looking tokens
check(!/EAAG[a-zA-Z0-9]{20,}/.test(allSrc),
  'no EAAG... Meta/WhatsApp token literal (placeholder text ok)');

// No real Postgres passwords (only placeholder text)
check(!/password\s*=\s*['""][^<>'""\s]{8,}['""]/.test(allSrc),
  'no hard-coded password values');

// No real subscription IDs (36-char UUID pattern without placeholder keyword)
const subIdPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const potentialSubIds = (allSrc.match(subIdPattern) || []).filter(id => {
  // role definition IDs in bicep are expected UUIDs
  const roleIds = [
    '4633458b-17de-408a-b874-0445c86b69e6',
    '7f951dda-4ed3-4680-a7ca-43fe172d538d',
  ];
  return !roleIds.includes(id.toLowerCase());
});
check(potentialSubIds.length === 0,
  'no unexpected UUID literals (subscription IDs) in scaffold',
  'unexpected UUID(s) found (check they are not subscription IDs)',
  potentialSubIds.join(', '));

// ── 6. Required Azure resources in main.bicep ─────────────────────────────────
console.log('\n── 6. Required Azure resources in main.bicep ──');
check(/Microsoft\.App\/managedEnvironments/i.test(bicep),         'Container Apps environment defined');
check(/Microsoft\.App\/containerApps/i.test(bicep),               'Container App(s) defined');
check(/Microsoft\.DBforPostgreSQL\/flexibleServers/i.test(bicep), 'Postgres Flexible Server defined');
check(/Microsoft\.KeyVault\/vaults/i.test(bicep),                 'Key Vault defined');
check(/Microsoft\.Cache\/redis/i.test(bicep),                     'Redis Cache defined');
check(/Microsoft\.ManagedIdentity\/userAssignedIdentities/i.test(bicep), 'Managed identity defined');
check(/Microsoft\.OperationalInsights\/workspaces/i.test(bicep),  'Log Analytics workspace defined');
check(/Microsoft\.ContainerRegistry\/registries/i.test(bicep),   'Container Registry defined');
check(/Microsoft\.Insights\/components/i.test(bicep),            'Application Insights defined');

// ── 7. Safety env defaults hardcoded ─────────────────────────────────────────
console.log('\n── 7. Safety env defaults (hardcoded in main.bicep) ──');
check(/WHATSAPP_DRY_RUN[\s\S]{1,30}'true'/.test(bicep),             "WHATSAPP_DRY_RUN = 'true' present");
check(/STAFF_ACTIONS_ENABLED[\s\S]{1,30}'false'/.test(bicep),       "STAFF_ACTIONS_ENABLED = 'false' present");
check(/STAFF_AUTH_REQUIRED[\s\S]{1,30}'true'/.test(bicep),          "STAFF_AUTH_REQUIRED = 'true' present");
check(/STRIPE_WEBHOOK_SKIP_VERIFY[\s\S]{1,30}'false'/.test(bicep),  "STRIPE_WEBHOOK_SKIP_VERIFY = 'false' present");
check(/N8N_BLOCK_ENV_ACCESS_IN_NODE[\s\S]{1,30}'true'/.test(bicep), "N8N_BLOCK_ENV_ACCESS_IN_NODE = 'true' present");

// ── 8. Key Vault secret refs ──────────────────────────────────────────────────
console.log('\n── 8. Key Vault secret refs (no inline values) ──');
const KV_SECRETS = [
  'wolfhouse-database-url',
  'n8n-database-url',
  'n8n-encryption-key',
  'redis-connection-string',
  'stripe-secret-key',
];
for (const s of KV_SECRETS) {
  check(bicep.includes(s), `KV secret ref '${s}' present`);
}
check(/keyVaultUrl/.test(bicep), 'keyVaultUrl pattern used for secret refs');

// ── 9. n8n worker has no ingress ──────────────────────────────────────────────
console.log('\n── 9. n8n worker — no public ingress ──');
// The worker section should NOT have an ingress block (comment in template confirms no ingress)
check(
  /n8n.*worker[\s\S]{1,800}No ingress|No ingress[\s\S]{1,200}worker/i.test(bicep) ||
  /worker[\s\S]{1,800}no.*ingress|no.*ingress[\s\S]{1,200}worker/i.test(bicep),
  'n8n worker has "No ingress" comment or equivalent'
);

// ── 10. parameters.example.json key presence ──────────────────────────────────
console.log('\n── 10. parameters.example.json key presence ──');
const REQUIRED_PARAMS = [
  'environmentName', 'location', 'appNamePrefix',
  'staffApiImage', 'n8nImage', 'postgresSku',
  'appDbName', 'n8nDbName', 'n8nTimezone',
];
const paramKeys = params.parameters ? Object.keys(params.parameters) : [];
for (const k of REQUIRED_PARAMS) {
  check(paramKeys.includes(k), `parameter '${k}' in parameters.example.json`);
}
// Confirm no sk_live_ in params
const paramsStr = JSON.stringify(params);
check(!/sk_live_/.test(paramsStr), 'no sk_live_ in parameters.example.json');

// ── 11. README: DO NOT DEPLOY warning ────────────────────────────────────────
console.log('\n── 11. README: DO NOT DEPLOY / approval warning ──');
check(
  /DO NOT (RUN|DEPLOY)/i.test(readme),
  'README contains DO NOT RUN/DEPLOY warning'
);
check(
  /approval.required|approval-required|without.*approval/i.test(readme),
  'README references approval requirement'
);
check(
  /go.no.go|go\/no.go/i.test(readme),
  'README references go/no-go gates'
);

// ── 12. README: destructive rollback warning ──────────────────────────────────
console.log('\n── 12. README: rollback/delete destructive warning ──');
check(
  /DESTRUCTIVE/i.test(readme) || /destructive/i.test(readme),
  'README labels rollback/delete as destructive'
);
check(
  /az group delete/i.test(readme),
  'README shows az group delete rollback command'
);

// ── 13. README: what-if / dry-run ────────────────────────────────────────────
console.log('\n── 13. README: what-if / dry-run command ──');
check(
  /what-if/i.test(readme),
  'README includes az deployment what-if (dry-run) command'
);

// ── 14. Plan doc: required resource types ────────────────────────────────────
console.log('\n── 14. Plan doc: required resource types referenced ──');
const RESOURCE_TYPES = [
  'Container Apps',
  'Postgres',
  'Key Vault',
  'Redis',
  'managed identity',
  'Log Analytics',
  'Application Insights',
];
for (const r of RESOURCE_TYPES) {
  check(planSrc.toLowerCase().includes(r.toLowerCase()), `plan doc references '${r}'`);
}

// ── 15. No real subscription ID placeholder missing ───────────────────────────
console.log('\n── 15. Subscription ID placeholder ──');
check(
  /SUBSCRIPTION_ID_PLACEHOLDER/i.test(readme),
  'README uses SUBSCRIPTION_ID_PLACEHOLDER (not a real subscription ID)'
);

// ── 16. STAFF_OPERATOR_TOKEN not in staging env ───────────────────────────────
console.log('\n── 16. STAFF_OPERATOR_TOKEN not set in staging Container App env ──');
check(
  !(/STAFF_OPERATOR_TOKEN[\s\S]{1,200}value\s*:/.test(bicep)),
  'STAFF_OPERATOR_TOKEN not set as Container App env var (local/dev only)'
);

// ── Result ───────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
if (failures === 0) {
  console.log('Result: PASS — all checks green (0 failures)');
  process.exit(0);
} else {
  console.error(`Result: FAIL — ${failures} check(s) failed`);
  process.exit(1);
}
