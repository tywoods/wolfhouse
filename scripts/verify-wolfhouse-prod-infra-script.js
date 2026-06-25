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
