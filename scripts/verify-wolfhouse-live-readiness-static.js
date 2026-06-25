'use strict';

/**
 * Wolfhouse live-readiness static gate.
 *
 * Read-only. Verifies the Wolfhouse live launch packet is present, the client
 * registry is sane for Wolfhouse, the live docs carry the required safety
 * language, and that no obvious secret-looking values have leaked into the docs.
 *
 * No DB, no network, no runtime imports. Exit 0 on pass, nonzero on failure.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLIENTS_FILE = path.join(ROOT, 'config', 'clients', 'clients.json');
const DOC_DIR = path.join(ROOT, 'docs', 'clients', 'wolfhouse');
const ENV_INVENTORY = path.join(DOC_DIR, 'LIVE-ENV-INVENTORY.md');
const CUTOVER = path.join(DOC_DIR, 'LIVE-CUTOVER-RUNBOOK.md');
const ROLLBACK = path.join(DOC_DIR, 'LIVE-ROLLBACK-RUNBOOK.md');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); if (detail) console.log(`        ${detail}`); }
}

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

console.log('verify:wolfhouse-live-readiness (static) — read-only\n');

// --- clients.json registry checks ---
const clientsRaw = readSafe(CLIENTS_FILE);
let clientsParsed = null;
let clientsParseErr = null;
if (clientsRaw != null) {
  try { clientsParsed = JSON.parse(clientsRaw); } catch (err) { clientsParseErr = err.message; }
}
ok('config/clients/clients.json exists and parses',
  clientsParsed != null, clientsParseErr || (clientsRaw == null ? 'file missing' : null));

const clients = clientsParsed && Array.isArray(clientsParsed.clients) ? clientsParsed.clients : [];
const wolfhouse = clients.find((c) => c && c.client_slug === 'wolfhouse') || null;
ok('wolfhouse client exists', wolfhouse != null);

const somo = wolfhouse && Array.isArray(wolfhouse.locations)
  ? wolfhouse.locations.find((l) => l && l.location_id === 'wolfhouse-somo')
  : null;
ok('wolfhouse-somo location exists', somo != null);

ok('wolfhouse live_enabled is false',
  wolfhouse != null && wolfhouse.live_enabled === false,
  wolfhouse ? `live_enabled=${JSON.stringify(wolfhouse.live_enabled)}` : 'no wolfhouse client');

// --- live docs exist ---
const envText = readSafe(ENV_INVENTORY);
const cutoverText = readSafe(CUTOVER);
const rollbackText = readSafe(ROLLBACK);

ok('docs/clients/wolfhouse/LIVE-ENV-INVENTORY.md exists', envText != null);
ok('docs/clients/wolfhouse/LIVE-CUTOVER-RUNBOOK.md exists', cutoverText != null);
ok('docs/clients/wolfhouse/LIVE-ROLLBACK-RUNBOOK.md exists', rollbackText != null);

// Combined live-docs corpus for language checks.
const liveDocs = [
  ['LIVE-ENV-INVENTORY.md', envText],
  ['LIVE-CUTOVER-RUNBOOK.md', cutoverText],
  ['LIVE-ROLLBACK-RUNBOOK.md', rollbackText],
].filter(([, t]) => t != null);
const corpus = liveDocs.map(([, t]) => t).join('\n').toLowerCase();

// --- required safety language ---
ok('live docs contain rollback language', corpus.includes('rollback'));

ok('live docs contain "no dirty-tree deploys" (or equivalent)',
  corpus.includes('dirty-tree') || corpus.includes('dirty tree'));

const hasMetaApproval = liveDocs.some(([, t]) => {
  const low = t.toLowerCase();
  return low.includes('meta webhook')
    && low.includes('explicit')
    && (low.includes('approval') || low.includes('approver'));
});
ok('live docs require explicit approval for live Meta webhook changes', hasMetaApproval);

// --- inventory is concrete enough (not just generic placeholders) ---
const envLow = (envText || '').toLowerCase();

const STATUS_VOCAB = ['existing', 'proposed', 'required-before-live', 'operator-provided'];
const missingStatus = STATUS_VOCAB.filter((s) => !envLow.includes(s));
ok('inventory defines a status column (existing/proposed/required-before-live/operator-provided)',
  missingStatus.length === 0, missingStatus.length ? `missing: ${missingStatus.join(', ')}` : null);

const CONCRETE_NAMES = [
  'northeurope',
  'wh-prod-rg',
  'wh-prod-staff-api',
  'wh-prod-hermes',
  'wh-prod-kv',
  'wolfhouse_prod',
];
const missingNames = CONCRETE_NAMES.filter((n) => !envLow.includes(n.toLowerCase()));
ok('inventory uses concrete planned names (region, RG, apps, KV, DB)',
  missingNames.length === 0, missingNames.length ? `missing: ${missingNames.join(', ')}` : null);

// --- secret-looking value scan (must NOT appear) ---
const FORBIDDEN = [
  'sk_live_',
  'xoxb-',
  'DISCORD_BOT_TOKEN=',
  'WHATSAPP_ACCESS_TOKEN=',
  'STRIPE_SECRET_KEY=',
  'password=',
];
const hits = [];
for (const [name, text] of liveDocs) {
  for (const pat of FORBIDDEN) {
    if (text.includes(pat)) hits.push(`${name}: "${pat}"`);
  }
}
ok('live docs contain no obvious secret-looking values', hits.length === 0,
  hits.length ? hits.join('; ') : null);

console.log(`\n── wolfhouse-live-readiness(static): ${pass} passed, ${fail} failed ──`);
if (fail === 0) {
  console.log('verify:wolfhouse-live-readiness-static — ALL CHECKS PASSED');
}
process.exit(fail ? 1 : 0);
