'use strict';

/**
 * Wolfhouse prod infra plan — static gate.
 *
 * Read-only. Verifies the dry-run infra plan (doc + planner script) exists, names
 * the expected resources, is clearly marked dry-run/no-actual-Azure-changes, and
 * leaks no secret-looking values.
 *
 * No DB, no network, no az, no runtime imports. Exit 0 on pass, nonzero on fail.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PLAN_DOC = path.join(ROOT, 'docs', 'clients', 'wolfhouse', 'PROD-INFRA-PLAN.md');
const PLAN_SCRIPT = path.join(ROOT, 'scripts', 'plan-wolfhouse-prod-infra.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); if (detail) console.log(`        ${detail}`); }
}
function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }

console.log('verify:wolfhouse-prod-infra-plan (static) — read-only\n');

const docText = readSafe(PLAN_DOC);
const scriptText = readSafe(PLAN_SCRIPT);

ok('docs/clients/wolfhouse/PROD-INFRA-PLAN.md exists', docText != null);
ok('scripts/plan-wolfhouse-prod-infra.js (dry-run script) exists', scriptText != null);

const combined = `${docText || ''}\n${scriptText || ''}`;
const combinedLow = combined.toLowerCase();

// Required resource names mentioned in doc + script.
const REQUIRED_NAMES = [
  'wh-prod-rg',
  'whprodacr',
  'wh-prod-kv',
  'wh-prod-env',
  'wh-prod-staff-api',
  'wh-prod-hermes',
  'wolfhouse_prod',
];
const missingNames = REQUIRED_NAMES.filter((n) => !combinedLow.includes(n.toLowerCase()));
ok('plan names all required resources (rg, acr, kv, env, staff-api, hermes, db)',
  missingNames.length === 0, missingNames.length ? `missing: ${missingNames.join(', ')}` : null);

// Dry-run / no-actual-change language present.
const hasDryRun = combinedLow.includes('dry-run') || combinedLow.includes('dry run');
ok('plan is marked dry-run', hasDryRun);

const hasNoChange = combinedLow.includes('no actual azure')
  || combinedLow.includes('not executed')
  || combinedLow.includes('creates/updates/deletes no')
  || combinedLow.includes('no azure resources were created')
  || combinedLow.includes('executes no');
ok('plan states no actual Azure changes / nothing executed', hasNoChange);

// No secret-looking values.
const FORBIDDEN = [
  'sk_live_',
  'xoxb-',
  'DISCORD_BOT_TOKEN=',
  'WHATSAPP_ACCESS_TOKEN=',
  'STRIPE_SECRET_KEY=',
  'password=',
];
const hits = [];
for (const [label, text] of [['PROD-INFRA-PLAN.md', docText], ['plan-wolfhouse-prod-infra.js', scriptText]]) {
  if (!text) continue;
  for (const pat of FORBIDDEN) if (text.includes(pat)) hits.push(`${label}: "${pat}"`);
}
ok('plan contains no obvious secret-looking values', hits.length === 0,
  hits.length ? hits.join('; ') : null);

console.log(`\n── wolfhouse-prod-infra-plan(static): ${pass} passed, ${fail} failed ──`);
if (fail === 0) console.log('verify:wolfhouse-prod-infra-plan — ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
