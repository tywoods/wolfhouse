/**
 * Stage 27s.1 — Hosted confirmation live-send proof doc verifier.
 *
 * Docs-only — no runtime, no DB, no API calls.
 *
 * Usage:
 *   npm run verify:stage27s1-hosted-proof-doc
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'STAGE-27S-CONFIRMATION-LIVE-SEND-ALLOWLIST.md');
const STATE = path.join(ROOT, 'docs', 'PROJECT-STATE.md');
const ROADMAP = path.join(ROOT, 'docs', 'ROADMAP.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27s1-hosted-proof-doc';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function docIncludes(text, needle, id, label) {
  if (text.includes(needle)) pass(id, label);
  else fail(id, `${label} — missing: ${String(needle).slice(0, 72)}`);
}

function docMatches(text, pattern, id, label) {
  if (pattern.test(text)) pass(id, label);
  else fail(id, `${label} — pattern not found`);
}

console.log('\nverify-stage27s1-hosted-proof-doc.js  (Stage 27s.1 hosted proof doc)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'doc verifier passes node --check');
} catch {
  fail('0', 'doc verifier syntax error');
}

section('A. Doc files exist');

if (fs.existsSync(DOC)) pass('A1', 'STAGE-27S doc exists');
else fail('A1', 'STAGE-27S doc missing');

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
const state = fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : '';
const roadmap = fs.existsSync(ROADMAP) ? fs.readFileSync(ROADMAP, 'utf8') : '';

section('B. Hosted proof section');

docMatches(doc, /Stage 27s\.1|27s\.1/i, 'B1', 'Stage 27s.1 referenced');
docIncludes(doc, 'b23f446', 'B2', 'commit b23f446');
docIncludes(doc, 'b23f446-stage27s1-live-send-allowlist', 'B3', 'proof image tag');
docIncludes(doc, 'stage27s1-live-send', 'B4', 'proof revision suffix');
docIncludes(doc, 'stage27s1-restore-dryrun', 'B5', 'restore revision suffix');

section('C. Proof booking and steps');

docIncludes(doc, 'MB-WOLFHO-20260924-e90132', 'C1', 'test booking code');
docIncludes(doc, '828538c7-c6cb-4c6f-b45a-57a641af37cc', 'C2', 'test booking id');
docIncludes(doc, 'not_approved', 'C3', 'confirm_send false result');
docIncludes(doc, 'recipient_not_allowlisted', 'C4', 'non-allowlisted result');
docIncludes(doc, '+491726422307', 'C5', 'allowlisted phone');
docIncludes(doc, '+34600000099', 'C6', 'non-allowlisted phone');

section('D. Live send evidence');

docIncludes(doc, 'wamid.HBgMNDkxNzI2NDIyMzA3FQIAERgSNzQ5NzQwRUI2MDRENTE5NDZGAA==', 'D1', 'WhatsApp message id');
docIncludes(doc, 'preview_regenerated: false', 'D2', 'preview not regenerated');
docMatches(doc, /byte-identical|byte identical/i, 'D3', 'message byte-identical to 27q');
docIncludes(doc, 'blocked_dry_run', 'D4', 'post-restore dry-run block');

section('E. Safety');

docMatches(doc, /Payment rows.*unchanged|payment rows \*\*unchanged\*\*/i, 'E1', 'payment unchanged');
docIncludes(doc, 'WHATSAPP_DRY_RUN', 'E2', 'dry-run restore documented');
docMatches(doc, /No Stripe|no Stripe/i, 'E3', 'no Stripe writes');
docMatches(doc, /No n8n|no n8n/i, 'E4', 'no n8n');

section('F. Verifier counts');

docIncludes(doc, '24/24', 'F1', '27s verifier count');
docIncludes(doc, '44/44', 'F2', '27r verifier count');
docIncludes(doc, '52/52', 'F3', '27q verifier count');

section('G. PROJECT-STATE and ROADMAP');

docMatches(state, /27s\.1|hosted proof/i, 'G1', 'PROJECT-STATE mentions 27s.1 hosted proof');
docMatches(roadmap, /27s\.1|hosted proof/i, 'G2', 'ROADMAP mentions 27s.1 hosted proof');

section('H. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('H1', `${SCRIPT} registered`);
else fail('H1', `missing npm script ${SCRIPT}`);

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
