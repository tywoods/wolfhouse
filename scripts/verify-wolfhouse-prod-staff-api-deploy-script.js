'use strict';

/**
 * Wolfhouse prod Staff API deploy SCRIPT — static gate.
 *
 * Read-only. Verifies the gated Staff-API deploy script exists, defaults to
 * dry-run, has the full apply guard, builds via az acr build with an immutable
 * git-SHA tag (no floating latest), targets the right app/env/ACR/RG, references
 * ONLY the Staff API secrets (no Meta/WhatsApp/Stripe), runs no migrations, and
 * leaks no secret-looking values.
 *
 * No DB, no network, no az, no runtime imports. Exit 0 on pass, nonzero on fail.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'deploy-wolfhouse-prod-staff-api.js');
const DOC = path.join(ROOT, 'docs', 'clients', 'wolfhouse', 'PROD-APP-DEPLOY-PLAN.md');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); if (detail) console.log(`        ${detail}`); }
}
function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }

console.log('verify:wolfhouse-prod-staff-api-deploy-script (static) — read-only\n');

const script = readSafe(SCRIPT);
const doc = readSafe(DOC);
const s = script || '';
const sLow = s.toLowerCase();

ok('scripts/deploy-wolfhouse-prod-staff-api.js exists', script != null);

ok('script has an --apply guard', s.includes('--apply'));
ok('script defaults to dry-run', sLow.includes('dry-run') || sLow.includes('dry run'));
ok('script requires WOLFHOUSE_PROD_STAFF_API_DEPLOY_APPLY=1',
  s.includes('WOLFHOUSE_PROD_STAFF_API_DEPLOY_APPLY') && s.includes("!== '1'"));
ok('script requires AZURE_SUBSCRIPTION_ID', s.includes('AZURE_SUBSCRIPTION_ID'));

// clean / master / origin guards
ok('script checks clean working tree', s.includes('status') && s.includes('--porcelain'));
ok('script checks current branch is master', s.includes('abbrev-ref') && s.includes('master'));
ok('script checks HEAD == origin/master', s.includes('origin/master') && s.includes('rev-parse'));
ok('script checks az CLI installed and logged in',
  s.includes('account') && s.includes('show')
  && (sLow.includes('not installed') || sLow.includes('enoent'))
  && (sLow.includes('logged in') || sLow.includes('az login')));

// build via az acr build, immutable SHA tag, no floating latest
ok('script builds via "az acr build"', s.includes("'acr', 'build'") || s.includes('acr build'));
ok('script tags image by immutable git SHA',
  s.includes('rev-parse') && s.includes('imageRepo') && s.includes('sha'));
ok('script does not use a floating :latest tag', !s.includes(':latest'));

// targets
const REQUIRED_NAMES = ['wh-prod-staff-api', 'wh-prod-env', 'whprodacr', 'wh-prod-rg', 'wolfhouse_prod'];
const missingNames = REQUIRED_NAMES.filter((n) => !sLow.includes(n.toLowerCase()));
ok('script targets wh-prod-staff-api / wh-prod-env / whprodacr / wh-prod-rg',
  missingNames.length === 0, missingNames.length ? `missing: ${missingNames.join(', ')}` : null);

// references only the required Staff API secrets
const STAFF_SECRETS = ['wolfhouse-prod-database-url', 'luna-bot-internal-token', 'wolfhouse-staff-session-secret'];
const missingStaffSecrets = STAFF_SECRETS.filter((n) => !s.includes(n));
ok('script references required Staff API secrets (database-url, bot token, session secret)',
  missingStaffSecrets.length === 0, missingStaffSecrets.length ? `missing: ${missingStaffSecrets.join(', ')}` : null);

// NO Meta/WhatsApp/Stripe secret refs in the Staff API deploy script
const FORBIDDEN_SECRETS = [
  'wolfhouse-whatsapp-phone-number-id',
  'wolfhouse-whatsapp-access-token',
  'wolfhouse-meta-app-secret',
  'wolfhouse-meta-verify-token',
  'wolfhouse-stripe-secret-key',
  'wolfhouse-stripe-webhook-secret',
];
const forbiddenHits = FORBIDDEN_SECRETS.filter((n) => s.includes(n));
ok('script does NOT reference Meta/WhatsApp/Stripe secrets (Staff API scope only)',
  forbiddenHits.length === 0, forbiddenHits.length ? `found: ${forbiddenHits.join(', ')}` : null);

// no migrations
ok('script runs no migrations',
  (sLow.includes('no migrations') || sLow.includes('not run migrations') || sLow.includes('does not run migrations'))
  && !sLow.includes('migrate'));

// --- rendered dry-run output: verify the ACTUAL emitted commands wire secrets ---
const rendered = (spawnSync('node', [SCRIPT, '--dry-run'], { encoding: 'utf8' }).stdout) || '';
const createLine = rendered.split('\n').find((l) => l.includes('az containerapp create')) || '';
const updateLine = rendered.split('\n').find((l) => l.includes('az containerapp update')) || '';
const secretSetLine = rendered.split('\n').find((l) => l.includes('az containerapp secret set')) || '';

ok('create command includes --secrets with keyvaultref',
  createLine.includes('--secrets') && createLine.includes('keyvaultref'));
ok('create command maps DATABASE_URL to secretref:wolfhouse-prod-database-url',
  createLine.includes('DATABASE_URL=secretref:wolfhouse-prod-database-url'));

const ENV_MAPPINGS = [
  'DATABASE_URL=secretref:wolfhouse-prod-database-url',
  'LUNA_BOT_INTERNAL_TOKEN=secretref:luna-bot-internal-token',
  'WOLFHOUSE_STAFF_SESSION_SECRET=secretref:wolfhouse-staff-session-secret',
];
const missingCreateEnv = ENV_MAPPINGS.filter((m) => !createLine.includes(m));
ok('create command includes all required env mappings',
  missingCreateEnv.length === 0, missingCreateEnv.length ? `missing: ${missingCreateEnv.join(', ')}` : null);

const missingUpdateEnv = ENV_MAPPINGS.filter((m) => !updateLine.includes(m));
ok('update command includes required env mappings (not image-only)',
  updateLine.includes('--set-env-vars') && missingUpdateEnv.length === 0,
  missingUpdateEnv.length ? `missing: ${missingUpdateEnv.join(', ')}` : null);

ok('update path refreshes Key Vault secret refs (containerapp secret set)',
  secretSetLine.includes('--secrets') && secretSetLine.includes('keyvaultref'));

ok('script assigns a managed identity for Key Vault access',
  s.includes('--system-assigned') && (s.includes('identity') && s.includes('assign')));

ok('apply is gated on managed-identity readiness',
  s.includes('WOLFHOUSE_PROD_STAFF_API_IDENTITY_READY'));

// no secret-looking values
const FORBIDDEN = ['sk_live_', 'xoxb-', 'DISCORD_BOT_TOKEN=', 'WHATSAPP_ACCESS_TOKEN=', 'STRIPE_SECRET_KEY=', 'password='];
const hits = FORBIDDEN.filter((p) => s.includes(p));
ok('script contains no obvious secret-looking values', hits.length === 0, hits.length ? hits.join(', ') : null);
// also scan rendered output for leaked secret-looking values
const renderedHits = FORBIDDEN.filter((p) => rendered.includes(p));
ok('rendered dry-run output contains no secret-looking values',
  renderedHits.length === 0, renderedHits.length ? renderedHits.join(', ') : null);

// min replicas + health + custom-domain note
ok('script sets min/max replicas 1', s.includes('--min-replicas') && s.includes('--max-replicas'));
ok('script includes a post-deploy health command', sLow.includes('health') && s.includes('staff.lunafrontdesk.com'));
ok('script notes custom domain is a later approval-gated step',
  sLow.includes('staff.lunafrontdesk.com')
  && (sLow.includes('approval-gated') || sLow.includes('later') || sLow.includes('dns/cert')));

// doc references the deploy script
ok('PROD-APP-DEPLOY-PLAN.md exists', doc != null);
ok('doc references the Staff API deploy script',
  (doc || '').includes('deploy-wolfhouse-prod-staff-api.js'));

console.log(`\n── staff-api-deploy-script(static): ${pass} passed, ${fail} failed ──`);
if (fail === 0) console.log('verify:wolfhouse-prod-staff-api-deploy-script — ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
