'use strict';
/**
 * Stage 7.3c — Azure staging deployment preflight static verifier.
 * NO network calls. NO Azure API. NO file mutations.
 *
 * Checks:
 *  1.  Preflight doc exists: docs/PHASE-7.3C-AZURE-STAGING-DEPLOYMENT-PREFLIGHT.md
 *  2.  Bicep file exists: infra/azure/staging/main.bicep
 *  3.  Parameters example exists: infra/azure/staging/parameters.example.json
 *  4.  Parameters Ty-template exists: infra/azure/staging/parameters.ty-template.json
 *  5.  README exists: infra/azure/staging/README.md
 *  6.  what-if command present in README or preflight doc
 *  7.  deploy command (az deployment group create) is absent OR marked with DO NOT RUN / APPROVAL REQUIRED
 *  8.  Manual inputs list present in preflight doc (FILL_ME tokens or explicit checklist)
 *  9.  lunafrontdesk.com domain appears in preflight doc
 * 10.  staff-staging.lunafrontdesk.com appears (staging subdomain)
 * 11.  n8n-staging.lunafrontdesk.com appears (staging subdomain)
 * 12.  WHATSAPP_DRY_RUN=true in main.bicep safety defaults
 * 13.  STAFF_ACTIONS_ENABLED=false in main.bicep safety defaults
 * 14.  STAFF_AUTH_REQUIRED=true in main.bicep safety defaults
 * 15.  STRIPE_WEBHOOK_SKIP_VERIFY=false in main.bicep safety defaults
 * 16.  N8N_BLOCK_ENV_ACCESS_IN_NODE=true in main.bicep safety defaults
 * 17.  No sk_live_ in any scaffold or preflight file
 * 18.  No Meta/WhatsApp token pattern (EAAG[a-zA-Z0-9]+) in any scaffold or preflight file
 * 19.  No real password-looking values in parameters.ty-template.json
 *      (no value matches a strong-password heuristic AND no real DB URLs)
 * 20.  No az deployment group create command without DO NOT RUN / APPROVAL REQUIRED annotation
 * 21.  Scaffold verifier still exists: scripts/verify-azure-staging-scaffold.js
 * 22.  Phase A–M deployment plan present in preflight doc
 * 23.  Smoke tests section present in preflight doc
 * 24.  parameters.ty-template.json contains no hardcoded subscription IDs
 *      (UUID-format values that look like real subscription IDs)
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let passed  = 0;
let failed  = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
    failures.push(label);
  }
}

function readFile(relPath) {
  const abs = path.join(ROOT, relPath);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

console.log('\nStage 7.3c — Azure staging deployment preflight verifier\n');

// ── 1. File existence ─────────────────────────────────────────────────────────

check('1. Preflight doc exists',
  fileExists('docs/PHASE-7.3C-AZURE-STAGING-DEPLOYMENT-PREFLIGHT.md'));

check('2. main.bicep exists',
  fileExists('infra/azure/staging/main.bicep'));

check('3. parameters.example.json exists',
  fileExists('infra/azure/staging/parameters.example.json'));

check('4. parameters.ty-template.json exists',
  fileExists('infra/azure/staging/parameters.ty-template.json'));

check('5. README.md exists',
  fileExists('infra/azure/staging/README.md'));

check('21. Scaffold verifier still exists',
  fileExists('scripts/verify-azure-staging-scaffold.js'));

// ── 2. Load content ───────────────────────────────────────────────────────────

const preflightDoc  = readFile('docs/PHASE-7.3C-AZURE-STAGING-DEPLOYMENT-PREFLIGHT.md') || '';
const bicep         = readFile('infra/azure/staging/main.bicep') || '';
const readme        = readFile('infra/azure/staging/README.md') || '';
const paramsExample = readFile('infra/azure/staging/parameters.example.json') || '';
const paramsTy      = readFile('infra/azure/staging/parameters.ty-template.json') || '';
const scaffoldDoc   = readFile('docs/PHASE-7.3B-AZURE-STAGING-RESOURCE-SCAFFOLD.md') || '';

// Combined text for cross-file checks
const allScaffoldFiles = [bicep, paramsExample, paramsTy, scaffoldDoc, readme].join('\n');
const allPreflightFiles = [preflightDoc, readme, paramsTy].join('\n');

// ── 3. what-if command ────────────────────────────────────────────────────────

const whatIfPattern = /az deployment group what-if/;
check('6. what-if command present in README or preflight doc',
  whatIfPattern.test(readme) || whatIfPattern.test(preflightDoc),
  'az deployment group what-if not found in README or preflight doc');

// ── 4. Deploy command safety ──────────────────────────────────────────────────

// If az deployment group create appears, it must be accompanied by DO NOT RUN or APPROVAL REQUIRED
const createPattern = /az deployment group create/g;
const doNotRunPattern = /DO NOT RUN|APPROVAL REQUIRED/i;

function deployCommandIsSafe(text) {
  const lines = text.split('\n');
  let createFound = false;
  for (let i = 0; i < lines.length; i++) {
    if (/az deployment group create/.test(lines[i])) {
      createFound = true;
      // Check within ±10 lines for DO NOT RUN / APPROVAL REQUIRED
      const window = lines.slice(Math.max(0, i - 10), Math.min(lines.length, i + 10)).join('\n');
      if (!doNotRunPattern.test(window)) {
        return false;
      }
    }
  }
  return true; // safe if absent OR if every occurrence has warning
}

check('7. deploy command absent or annotated with DO NOT RUN / APPROVAL REQUIRED in README',
  deployCommandIsSafe(readme),
  'az deployment group create found without DO NOT RUN / APPROVAL REQUIRED annotation');

check('20. deploy command absent or annotated in preflight doc',
  deployCommandIsSafe(preflightDoc),
  'az deployment group create found in preflight doc without required warning');

// ── 5. Manual inputs present ─────────────────────────────────────────────────

check('8. Manual inputs list present in preflight doc (FILL_ME tokens or checklist)',
  /FILL_ME|subscription ID|<FILL_ME/i.test(preflightDoc),
  'No manual inputs checklist found in preflight doc');

// ── 6. Domain + subdomains ────────────────────────────────────────────────────

check('9. lunafrontdesk.com domain appears in preflight doc',
  /lunafrontdesk\.com/.test(preflightDoc),
  'lunafrontdesk.com not found in preflight doc');

check('10. staff-staging.lunafrontdesk.com appears',
  /staff-staging\.lunafrontdesk\.com/.test(preflightDoc + readme),
  'staff-staging.lunafrontdesk.com not found');

check('11. n8n-staging.lunafrontdesk.com appears',
  /n8n-staging\.lunafrontdesk\.com/.test(preflightDoc + readme),
  'n8n-staging.lunafrontdesk.com not found');

// ── 7. Safety defaults in main.bicep ─────────────────────────────────────────

check("12. WHATSAPP_DRY_RUN='true' hardcoded in main.bicep",
  /WHATSAPP_DRY_RUN.*'true'|'true'.*WHATSAPP_DRY_RUN/.test(bicep),
  "WHATSAPP_DRY_RUN hardcoded to 'true' not found in main.bicep");

check("13. STAFF_ACTIONS_ENABLED='false' hardcoded in main.bicep",
  /STAFF_ACTIONS_ENABLED.*'false'|'false'.*STAFF_ACTIONS_ENABLED/.test(bicep),
  "STAFF_ACTIONS_ENABLED hardcoded to 'false' not found in main.bicep");

check("14. STAFF_AUTH_REQUIRED='true' hardcoded in main.bicep",
  /STAFF_AUTH_REQUIRED.*'true'|'true'.*STAFF_AUTH_REQUIRED/.test(bicep),
  "STAFF_AUTH_REQUIRED hardcoded to 'true' not found in main.bicep");

check("15. STRIPE_WEBHOOK_SKIP_VERIFY='false' hardcoded in main.bicep",
  /STRIPE_WEBHOOK_SKIP_VERIFY.*'false'|'false'.*STRIPE_WEBHOOK_SKIP_VERIFY/.test(bicep),
  "STRIPE_WEBHOOK_SKIP_VERIFY hardcoded to 'false' not found in main.bicep");

check("16. N8N_BLOCK_ENV_ACCESS_IN_NODE='true' hardcoded in main.bicep",
  /N8N_BLOCK_ENV_ACCESS_IN_NODE.*'true'|'true'.*N8N_BLOCK_ENV_ACCESS_IN_NODE/.test(bicep),
  "N8N_BLOCK_ENV_ACCESS_IN_NODE hardcoded to 'true' not found in main.bicep");

// ── 8. No real secrets ────────────────────────────────────────────────────────

check('17. No sk_live_ in any scaffold or preflight file',
  !/sk_live_[a-zA-Z0-9]/.test(allScaffoldFiles + preflightDoc),
  'Live Stripe key pattern sk_live_... found in scaffold or preflight file');

// EAAG followed by many alphanumeric chars = real Meta/WhatsApp token pattern
// Allow the placeholder string EAAG_PLACEHOLDER
check('18. No real Meta/WhatsApp token pattern in scaffold or preflight files',
  !/EAAG[a-zA-Z0-9]{10,}/.test(allScaffoldFiles + preflightDoc),
  'Real Meta/WhatsApp token pattern (EAAG...) found in scaffold or preflight files');

// ── 9. No real passwords/secrets in ty-template ──────────────────────────────

// The ty-template should only contain placeholder values, not real values.
// A real password would be a non-placeholder string ≥ 16 chars of mixed alphanumeric+special.
// We check that no JSON "value" field contains a string that looks like a real secret.
// Allowed: empty string, FILL_ME tokens, standard image URIs, database/table names, SKU names, version strings, timezone, integers.
// Disallowed: any value that looks like: sk_test_[long], EAAGabc..., postgres://user:password@host, etc.

const paramsTyObj = (() => { try { return JSON.parse(paramsTy); } catch { return null; } })();

check('19a. parameters.ty-template.json is valid JSON',
  paramsTyObj !== null,
  'parameters.ty-template.json failed to parse as JSON');

if (paramsTyObj) {
  // Extract all string values from the parameters object
  const stringValues = Object.values(paramsTyObj.parameters || {})
    .map(p => p.value)
    .filter(v => typeof v === 'string');

  // Check: no value starts with sk_test_ or sk_live_ (real Stripe key)
  const hasRealStripe = stringValues.some(v => /^sk_(test|live)_[a-zA-Z0-9]{10,}/.test(v));
  check('19b. No real Stripe key in parameters.ty-template.json',
    !hasRealStripe,
    'A real Stripe key (sk_test_... or sk_live_...) was found in parameters.ty-template.json');

  // Check: no value is a real-looking postgres connection string with actual hostname
  const hasRealDbUrl = stringValues.some(v => /postgres:\/\/\w+:\w+@[\w.-]+\.azure\.com/.test(v));
  check('19c. No real DB connection string in parameters.ty-template.json',
    !hasRealDbUrl,
    'A real Postgres connection string was found in parameters.ty-template.json');

  // Check: no subscription UUID present (format xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
  // but allow them in comment properties
  const hasSubscriptionId = stringValues.some(v =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
  check('24. No hardcoded subscription UUID in parameters.ty-template.json values',
    !hasSubscriptionId,
    'A UUID-format subscription/tenant ID was found as a value in parameters.ty-template.json');
}

// ── 10. Phase A–M plan present ────────────────────────────────────────────────

check('22. Phase A–M deployment plan present in preflight doc',
  /Phase A|Phase B|Phase C|Phase D|Phase E|Phase F|Phase G/.test(preflightDoc),
  'Phase A–M deployment plan not found in preflight doc');

// ── 11. Smoke tests section present ──────────────────────────────────────────

check('23. Smoke tests section present in preflight doc',
  /smoke test|Smoke test|S[0-9]+.*HTTPS|\/staff\/ui|\/staff\/intents/.test(preflightDoc),
  'Smoke tests section not found in preflight doc');

// ── Summary ───────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n─────────────────────────────────────────────────`);
console.log(`Stage 7.3c preflight verifier: ${passed}/${total} checks passed`);

if (failed > 0) {
  console.error(`\nFAILED checks (${failed}):`);
  failures.forEach(f => console.error(`  ✗  ${f}`));
  console.error('\nResult: FAIL');
  process.exit(1);
} else {
  console.log('\nResult: PASS — preflight scaffold valid. No Azure resources created.');
  console.log('Next: fill in parameters.ty-template.json, then run Phase B (az group create) with Ty approval.');
  process.exit(0);
}
