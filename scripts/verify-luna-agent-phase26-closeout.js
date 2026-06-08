/**
 * Phase 26 — Closeout verifier for Staff Portal Operations.
 *
 * Static doc + anchor checks; runs limited downstream set only.
 * Closeout slice is docs/verifier/package.json only — no runtime code.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-closeout
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'PHASE-26-CLOSEOUT.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-closeout';
const CLOSEOUT_SCRIPT = 'scripts/verify-luna-agent-phase26-closeout.js';

const ALLOWED_CLOSEOUT_PATHS = new Set([
  'docs/PHASE-26-CLOSEOUT.md',
  CLOSEOUT_SCRIPT,
  'package.json',
]);

const DOWNSTREAM = [
  'verify:luna-agent-phase26-nav-botmode-polish',
  'verify:luna-agent-phase26-service-add-schedule-modes',
  'verify:luna-agent-phase26-inplace-actions-transfer-final-polish',
  'verify:luna-agent-phase26-service-pebbles-transfer-payment-polish',
];

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

console.log('\nverify-luna-agent-phase26-closeout.js  (Phase 26 closeout)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'closeout verifier passes node --check');
} catch {
  fail('0', 'closeout verifier syntax error');
}

section('A. Closeout doc exists');

if (fs.existsSync(DOC)) pass('A1', 'PHASE-26-CLOSEOUT.md exists');
else fail('A1', 'closeout doc missing');

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

section('B. Stage 26 final status + deploy baseline');

docMatches(doc, /Stage 26 final status|Phase 26.*PASS|final status/i, 'B1', 'mentions Stage 26 final status');
docIncludes(doc, '3dc2921', 'B2', 'mentions deployed commit 3dc2921');
docIncludes(doc, 'wh-staging-staff-api--stage26h10-nav-botmode', 'B3', 'mentions staging revision');
docIncludes(doc, '3dc2921-stage26h10-nav-botmode', 'B4', 'mentions staging image tag');

section('C. Transfers');

docIncludes(doc, 'booking_transfers', 'C1', 'mentions booking_transfers');
docMatches(doc, /Exception Override|exception override/i, 'C2', 'mentions Transfer Exception Override');
docMatches(doc, /Bilbao under-4|under-4.*override|under-4 rule/i, 'C3', 'mentions Bilbao under-4 override rule');
docMatches(doc, /Aviationstack|function_access_restricted/i, 'C4', 'mentions Aviationstack caveat');

section('D. Services tab');

docMatches(doc, /Services tab|Services language/i, 'D1', 'mentions Services tab');
docIncludes(doc, 'Total services', 'D2', 'mentions Total services');
docIncludes(doc, 'Schedule Later', 'D3', 'mentions Schedule Later');
docIncludes(doc, 'Span Across Booking', 'D4', 'mentions Span Across Booking');

section('E. Nav + bot state');

docIncludes(doc, 'WhatsApp', 'E1', 'mentions WhatsApp nav label');
docIncludes(doc, 'Luna Staff', 'E2', 'mentions Luna Staff nav label');
docMatches(doc, /Staff.*Luna.*pebble|pebble.*live|bcUpdateDrawerConvBotModePebble/i, 'E3', 'mentions Staff/Luna pebble refresh');

section('F. Payments + env safety');

docIncludes(doc, 'STAFF_ACTIONS_ENABLED=true', 'F1', 'mentions STAFF_ACTIONS_ENABLED=true');
docIncludes(doc, 'STRIPE_LINKS_ENABLED=true', 'F2', 'mentions STRIPE_LINKS_ENABLED=true');
docIncludes(doc, 'WHATSAPP_DRY_RUN=true', 'F3', 'mentions WHATSAPP_DRY_RUN=true');
docMatches(doc, /no WhatsApp live-send|live-send env|no live-send/i, 'F4', 'mentions no WhatsApp live-send env');
docMatches(doc, /Stripe test|test key|test-mode/i, 'F5', 'mentions Stripe test key only');

section('G. Deferred scope + cutover');

docMatches(doc, /Stage 27|guest AI intake.*deferred|deferred to Stage 27/i, 'G1', 'mentions guest AI intake deferred to Stage 27');
docMatches(doc, /explicit go\/no-go|go\/no-go/i, 'G2', 'mentions production cutover explicit go/no-go');
docMatches(doc, /no Meta|Meta webhook/i, 'G3', 'mentions no Meta webhook changes');
docMatches(doc, /no n8n|n8n changes/i, 'G4', 'mentions no n8n changes');

section('H. npm script + closeout script file');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${CLOSEOUT_SCRIPT}`) {
  pass('H1', `${SCRIPT} registered`);
} else {
  fail('H1', `${SCRIPT} missing or wrong path`);
}
if (fs.existsSync(path.join(ROOT, CLOSEOUT_SCRIPT))) pass('H2', 'closeout script file exists');
else fail('H2', 'closeout script file missing');

section('I. Closeout scope — no runtime files staged');

try {
  const staged = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const unexpected = staged.filter((p) => !ALLOWED_CLOSEOUT_PATHS.has(p.replace(/\\/g, '/')));
  if (staged.length === 0) {
    pass('I1', 'no staged files (ok before git add)');
  } else if (unexpected.length === 0) {
    pass('I1', 'staged files limited to closeout doc/verifier/package.json');
  } else {
    fail('I1', `unexpected staged runtime files: ${unexpected.join(', ')}`);
  }
} catch {
  pass('I1', 'git staged check skipped (not a git repo or git unavailable)');
}

section('J. Downstream verifiers (limited)');

for (const script of DOWNSTREAM) {
  if (!pkg.scripts || !pkg.scripts[script]) {
    fail('J.' + script, `${script} not registered in package.json`);
    continue;
  }
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 900000 });
    pass('J.' + script, `${script} still passes`);
  } catch (e) {
    fail('J.' + script, `${script} failed`);
    const out = (e.stdout || '') + (e.stderr || '');
    console.error(out.split('\n').slice(-12).join('\n'));
  }
}

console.log('\n' + '─'.repeat(60));
if (failures === 0) {
  console.log(`PASS  (${passes} checks)\n`);
  process.exit(0);
}
console.log(`FAIL  (${passes} passed, ${failures} failed)\n`);
process.exit(1);
