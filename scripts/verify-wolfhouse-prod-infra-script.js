'use strict';

/**
 * Wolfhouse prod infra provision SCRIPT — static gate.
 *
 * Read-only. Verifies the gated provision script exists, defaults to dry-run, has
 * the full apply guard (env flag + clean tree + master + origin parity), names all
 * planned resources, and leaks no secret-looking values. Also checks the plan doc
 * documents the dry-run default and the --apply danger gate.
 *
 * No DB, no network, no az, no runtime imports. Exit 0 on pass, nonzero on fail.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'provision-wolfhouse-prod-infra.js');
const DOC = path.join(ROOT, 'docs', 'clients', 'wolfhouse', 'PROD-INFRA-PLAN.md');
const INVENTORY = path.join(ROOT, 'docs', 'clients', 'wolfhouse', 'LIVE-ENV-INVENTORY.md');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); if (detail) console.log(`        ${detail}`); }
}
function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }

console.log('verify:wolfhouse-prod-infra-script (static) — read-only\n');

const script = readSafe(SCRIPT);
const doc = readSafe(DOC);

ok('scripts/provision-wolfhouse-prod-infra.js exists', script != null);

const s = script || '';
const sLow = s.toLowerCase();

ok('script has an --apply guard', s.includes('--apply'));
ok('script defaults to dry-run', sLow.includes('dry-run') || sLow.includes('dry run'));
ok('script requires WOLFHOUSE_PROD_INFRA_APPLY=1',
  s.includes('WOLFHOUSE_PROD_INFRA_APPLY') && s.includes("!== '1'"));

// git guard: clean tree + master + origin/master parity
ok('script checks clean working tree', s.includes('status') && s.includes('--porcelain'));
ok('script checks current branch is master',
  s.includes('abbrev-ref') && s.includes('master'));
ok('script checks HEAD == origin/master',
  s.includes('origin/master') && s.includes('rev-parse'));

// --- apply-hardening guards ---
ok('script requires Postgres admin env vars in apply (user + password)',
  s.includes('WOLFHOUSE_PROD_PG_ADMIN_USER') && s.includes('WOLFHOUSE_PROD_PG_ADMIN_PASSWORD'));

ok('script requires AZURE_SUBSCRIPTION_ID in apply',
  s.includes('AZURE_SUBSCRIPTION_ID'));

ok('script checks az CLI installed and logged in',
  s.includes('account') && s.includes('show')
  && (sLow.includes('not installed') || sLow.includes('enoent'))
  && (sLow.includes('logged in') || sLow.includes('az login')));

ok('script uses non-interactive flag(s) for Azure (e.g. --yes)', s.includes('--yes'));

ok('script redacts secrets / never prints the Postgres password',
  s.includes('REDACTED') && s.includes('--admin-password')
  && sLow.includes('never print'));

// all planned resource names present
const REQUIRED_NAMES = [
  'wh-prod-rg', 'northeurope', 'whprodacr', 'wh-prod-kv', 'wh-prod-logs',
  'wh-prod-env', 'wh-prod-staff-api', 'wh-prod-hermes', 'wh-prod-pg', 'wolfhouse_prod',
];
const missingNames = REQUIRED_NAMES.filter((nm) => !sLow.includes(nm.toLowerCase()));
ok('script includes all planned resource names',
  missingNames.length === 0, missingNames.length ? `missing: ${missingNames.join(', ')}` : null);

// no secret-looking values
const FORBIDDEN = [
  'sk_live_', 'xoxb-', 'DISCORD_BOT_TOKEN=',
  'WHATSAPP_ACCESS_TOKEN=', 'STRIPE_SECRET_KEY=', 'password=',
];
const hits = FORBIDDEN.filter((p) => s.includes(p));
ok('script contains no obvious secret-looking values',
  hits.length === 0, hits.length ? hits.join(', ') : null);

// --- post-apply fix checks ---
const inventory = readSafe(INVENTORY) || '';
const docPlusInv = `${doc || ''}\n${inventory}`;

// (a) Hyphenated Key Vault secret names present (script + docs).
const HYPHEN_SECRET_NAMES = [
  'wolfhouse-prod-db-user',
  'wolfhouse-prod-db-password',
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
const missingHyphen = HYPHEN_SECRET_NAMES.filter((nm) => !s.includes(nm) || !docPlusInv.includes(nm));
ok('hyphenated Key Vault secret names present in script and docs',
  missingHyphen.length === 0, missingHyphen.length ? `missing: ${missingHyphen.join(', ')}` : null);

// (b) No underscore Key Vault secret names left in script/docs secret lists.
const OLD_UNDERSCORE_KV = [
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
const underscoreHits = OLD_UNDERSCORE_KV.filter((nm) => s.includes(nm) || docPlusInv.includes(nm));
ok('no underscore Key Vault secret names remain (Key Vault rejects underscores)',
  underscoreHits.length === 0, underscoreHits.length ? `found: ${underscoreHits.join(', ')}` : null);

// (c) az group exists existence decided from stdout "true", not exit code.
ok('script decides "az group exists" from stdout == "true"',
  s.includes('group') && s.includes('exists') && s.includes('stdout-true')
  && s.includes("=== 'true'"));

// (d) Key Vault Secrets Officer / RBAC documented.
ok('Key Vault Secrets Officer / RBAC documented',
  (s.includes('Key Vault Secrets Officer') || docPlusInv.includes('Key Vault Secrets Officer'))
  && (sLow.includes('rbac') || docPlusInv.toLowerCase().includes('rbac')));

// (e) Postgres DB create uses --name (not --database-name).
const dbCreateIdx = s.indexOf("'db', 'create'");
const dbCreateOk = dbCreateIdx !== -1
  && s.slice(dbCreateIdx, dbCreateIdx + 200).includes("'--name'")
  && (docPlusInv.includes('db create --name') || docPlusInv.includes('flexible-server db create --name'));
ok('Postgres DB create uses --name (script + docs)', dbCreateOk);

// (f) Secret-risk command output captured/redacted (not echoed raw).
ok('script captures + suppresses/redacts secret-risk Azure output',
  s.includes('captureSecret') && s.includes('redactText')
  && (sLow.includes('suppress') || sLow.includes('withheld')));

// doc documents dry-run default + --apply danger gate
const d = doc || '';
const dLow = d.toLowerCase();
ok('PROD-INFRA-PLAN.md exists', doc != null);
ok('doc documents dry-run default and --apply danger gate',
  (dLow.includes('dry-run') || dLow.includes('dry run'))
  && d.includes('--apply')
  && (dLow.includes('danger') || dLow.includes('gate') || dLow.includes('guard')));

console.log(`\n── wolfhouse-prod-infra-script(static): ${pass} passed, ${fail} failed ──`);
if (fail === 0) console.log('verify:wolfhouse-prod-infra-script — ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
