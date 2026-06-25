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

// --- rendered dry-run output: verify the ACTUAL emitted two-phase commands ---
const rendered = (spawnSync('node', [SCRIPT, '--dry-run'], { encoding: 'utf8' }).stdout) || '';
const updateLine = rendered.split('\n').find((l) => l.includes('az containerapp update')) || '';
const secretSetLine = rendered.split('\n').find((l) => l.includes('az containerapp secret set')) || '';
const bootstrapCreateLine = rendered.split('\n').find((l) => l.includes('az containerapp create')) || '';
const identityShowLine = rendered.split('\n').find((l) => l.includes('az containerapp identity show')) || '';
const roleCreateLine = rendered.split('\n').find((l) => l.includes('az role assignment create')) || '';
const secretShowLines = rendered.split('\n').filter((l) => l.includes('az keyvault secret show'));

// two-phase bootstrap mode
ok('script supports a two-phase identity bootstrap mode (--bootstrap-identity)',
  s.includes('--bootstrap-identity') && s.includes('BOOTSTRAP'));

// bootstrap create is minimal (system identity, no secretrefs)
ok('bootstrap create uses --system-assigned without secretrefs',
  bootstrapCreateLine.includes('--system-assigned') && !bootstrapCreateLine.includes('keyvaultref'));

// fetches principalId
ok('script fetches app identity principalId (containerapp identity show)',
  identityShowLine.includes('identity show') && identityShowLine.includes('principalId'));

// assigns Key Vault Secrets User (not Officer) to the app identity
ok('script assigns "Key Vault Secrets User" to the app identity',
  roleCreateLine.includes('Key Vault Secrets User') && roleCreateLine.includes('--assignee'));
ok('app identity role is Secrets User, not Secrets Officer',
  !roleCreateLine.includes('Key Vault Secrets Officer'));

// verifies required Key Vault secrets exist by name, without printing values
const REQUIRED_SECRET_CHECKS = ['wolfhouse-prod-database-url', 'luna-bot-internal-token', 'wolfhouse-staff-session-secret'];
const checkedSecrets = REQUIRED_SECRET_CHECKS.filter((n) => secretShowLines.some((l) => l.includes(n)));
ok('script verifies required Key Vault secrets exist by name',
  checkedSecrets.length === REQUIRED_SECRET_CHECKS.length
  && secretShowLines.every((l) => !l.includes('--query value')));

// secret refresh + env wiring (phase 2)
ok('phase 2 refreshes Key Vault secret refs (containerapp secret set + keyvaultref)',
  secretSetLine.includes('--secrets') && secretSetLine.includes('keyvaultref'));

const ENV_MAPPINGS = [
  'DATABASE_URL=secretref:wolfhouse-prod-database-url',
  'LUNA_BOT_INTERNAL_TOKEN=secretref:luna-bot-internal-token',
  'WOLFHOUSE_STAFF_SESSION_SECRET=secretref:wolfhouse-staff-session-secret',
];
const missingUpdateEnv = ENV_MAPPINGS.filter((m) => !updateLine.includes(m));
ok('update command includes required env mappings (not image-only)',
  updateLine.includes('--set-env-vars') && updateLine.includes('--image') && missingUpdateEnv.length === 0,
  missingUpdateEnv.length ? `missing: ${missingUpdateEnv.join(', ')}` : null);

ok('script assigns a managed identity for Key Vault access',
  s.includes('--system-assigned') && s.includes('identity') && s.includes('assign'));

// no longer relies on a blind human readiness flag — uses real az self-checks
ok('apply self-checks identity/role/secret state (not a blind ready flag)',
  s.includes('roleList') && s.includes('identityShow') && s.includes('secretShow')
  && !s.includes('WOLFHOUSE_PROD_STAFF_API_IDENTITY_READY'));

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
