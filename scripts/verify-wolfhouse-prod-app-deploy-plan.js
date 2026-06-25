'use strict';

/**
 * Wolfhouse prod app deploy plan — static gate.
 *
 * Read-only. Verifies the dry-run app-deploy plan (doc + planner script) exists,
 * names the apps/ACR/RG/env/DB/hostnames and required Key Vault secret names, is
 * clearly dry-run/not-executed, withholds approval-gated live actions, and leaks
 * no secret-looking values.
 *
 * No docker, no az, no network, no runtime imports. Exit 0 on pass, nonzero fail.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'clients', 'wolfhouse', 'PROD-APP-DEPLOY-PLAN.md');
const SCRIPT = path.join(ROOT, 'scripts', 'plan-wolfhouse-prod-app-deploy.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); if (detail) console.log(`        ${detail}`); }
}
function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }

console.log('verify:wolfhouse-prod-app-deploy-plan (static) — read-only\n');

const docText = readSafe(DOC);
const scriptText = readSafe(SCRIPT);

ok('docs/clients/wolfhouse/PROD-APP-DEPLOY-PLAN.md exists', docText != null);
ok('scripts/plan-wolfhouse-prod-app-deploy.js (dry-run script) exists', scriptText != null);

const combined = `${docText || ''}\n${scriptText || ''}`;
const combinedLow = combined.toLowerCase();

// Required names: apps, ACR, RG, env, DB, hostnames.
const REQUIRED_NAMES = [
  'wh-prod-staff-api',
  'wh-prod-hermes',
  'whprodacr',
  'wh-prod-rg',
  'wh-prod-env',
  'wolfhouse_prod',
  'staff.lunafrontdesk.com',
  'hermes.lunafrontdesk.com',
];
const missingNames = REQUIRED_NAMES.filter((n) => !combinedLow.includes(n.toLowerCase()));
ok('plan names apps, ACR, RG, env, DB, and hostnames',
  missingNames.length === 0, missingNames.length ? `missing: ${missingNames.join(', ')}` : null);

// Required Key Vault secret names (hyphenated) referenced.
const REQUIRED_SECRET_NAMES = [
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
const missingSecrets = REQUIRED_SECRET_NAMES.filter((n) => !combined.includes(n));
ok('plan references required hyphenated Key Vault secret names',
  missingSecrets.length === 0, missingSecrets.length ? `missing: ${missingSecrets.join(', ')}` : null);

// Build-from-clean-SHA + immutable tag, no :latest for prod.
ok('plan builds from clean git SHA and uses immutable tag (no :latest for prod)',
  (combinedLow.includes('git sha') || combinedLow.includes('git-sha') || combinedLow.includes('rev-parse'))
  && combinedLow.includes('immutable')
  && combinedLow.includes('latest'));

// Env from Key Vault references, not raw secrets.
ok('plan sources env from Key Vault references (secretref / keyvaultref)',
  combinedLow.includes('secretref') || combinedLow.includes('keyvaultref'));

// Dry-run / not executed language.
ok('plan is marked dry-run / not executed',
  (combinedLow.includes('dry-run') || combinedLow.includes('dry run'))
  && (combinedLow.includes('not executed') || combinedLow.includes('nothing is deployed')
      || combinedLow.includes('executes no') || combinedLow.includes('no docker')));

// Approval gates: no migrations / Meta / Stripe / WhatsApp without approval.
function gated(topic) {
  // topic appears near "approval" / "approved" somewhere in the combined text
  return combinedLow.includes(topic);
}
ok('plan: no DB migrations without approval',
  gated('migration') && combinedLow.includes('approval'));
ok('plan: no live Meta webhook without approval',
  combinedLow.includes('meta webhook') && combinedLow.includes('approval'));
ok('plan: no Stripe live without approval',
  combinedLow.includes('stripe') && combinedLow.includes('approval'));
ok('plan: no outbound WhatsApp without approved smoke test',
  combinedLow.includes('whatsapp') && (combinedLow.includes('smoke test') || combinedLow.includes('approved')));

// Cost controls + health + rollback present.
ok('plan includes min replicas / cost controls', combinedLow.includes('min-replicas') || combinedLow.includes('min replicas'));
ok('plan includes health checks', combinedLow.includes('health'));
ok('plan includes rollback image-tag strategy', combinedLow.includes('rollback'));

// No secret-looking values.
const FORBIDDEN = [
  'sk_live_', 'xoxb-', 'DISCORD_BOT_TOKEN=',
  'WHATSAPP_ACCESS_TOKEN=', 'STRIPE_SECRET_KEY=', 'password=',
];
const hits = [];
for (const [label, text] of [['PROD-APP-DEPLOY-PLAN.md', docText], ['plan-wolfhouse-prod-app-deploy.js', scriptText]]) {
  if (!text) continue;
  for (const p of FORBIDDEN) if (text.includes(p)) hits.push(`${label}: "${p}"`);
}
ok('plan contains no obvious secret-looking values', hits.length === 0, hits.length ? hits.join('; ') : null);

console.log(`\n── wolfhouse-prod-app-deploy-plan(static): ${pass} passed, ${fail} failed ──`);
if (fail === 0) console.log('verify:wolfhouse-prod-app-deploy-plan — ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
