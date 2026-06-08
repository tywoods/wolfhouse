/**
 * Phase 25 — Closeout verifier for Owner Command Center.
 *
 * Static doc + anchor checks; runs a limited downstream set only.
 *
 * Usage:
 *   npm run verify:luna-agent-phase25-closeout
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'PHASE-25-OWNER-COMMAND-CENTER-CLOSEOUT.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase25-closeout';

const DOWNSTREAM = [
  'verify:luna-agent-phase25-owner-permissions',
  'verify:luna-agent-phase25-command-center-ui',
  'verify:luna-agent-phase25-owner-command-center-answer',
  'verify:luna-agent-phase25-owner-plan-execute',
  'verify:luna-agent-phase25-owner-whatsapp-router',
  'verify:luna-agent-phase25-owner-readonly-sql',
  'verify:luna-agent-phase25-owner-data-catalog',
  'verify:luna-agent-phase25-staff-phone-access',
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

console.log('\nverify-luna-agent-phase25-closeout.js  (Phase 25 closeout)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'closeout verifier passes node --check');
} catch {
  fail('0', 'closeout verifier syntax error');
}

section('A. Closeout doc exists');

if (fs.existsSync(DOC)) pass('A1', 'PHASE-25-OWNER-COMMAND-CENTER-CLOSEOUT.md exists');
else fail('A1', 'closeout doc missing');

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

section('B. Scope + Stage 26 deferral');

docMatches(doc, /Stage 25.*Owner Command Center|Owner Command Center/i, 'B1', 'mentions Stage 25 Owner Command Center');
docMatches(doc, /Stage 26.*guest.*AI intake|guest-facing AI intake/i, 'B2', 'mentions Stage 26 guest AI intake deferred');

section('C. Architecture');

docIncludes(doc, 'staff_phone_access', 'C1', 'mentions staff_phone_access');
docIncludes(doc, 'luna-owner-whatsapp-inbound', 'C2', 'mentions owner WhatsApp router');
docIncludes(doc, 'owner-readonly-sql', 'C3', 'mentions read-only SQL validator/executor');
docIncludes(doc, 'owner-data-catalog', 'C4', 'mentions owner data catalog');
docIncludes(doc, 'owner-sql-planner', 'C5', 'mentions owner SQL planner');
docIncludes(doc, 'plan-and-execute', 'C6', 'mentions plan-and-execute');
docIncludes(doc, 'owner-command-center-answer', 'C7', 'mentions natural answer formatter');
docMatches(doc, /Command Center|Owner Insights/i, 'C8', 'mentions Command Center UI');

section('D. Wolfhouse owners + guest path');

docIncludes(doc, '+491726422307', 'D1', 'mentions Ty owner phone');
docIncludes(doc, '+34610057658', 'D2', 'mentions Ale owner phone');
docIncludes(doc, '+34650616794', 'D3', 'mentions Cami owner phone');
docMatches(doc, /non-allowlisted.*guest|guest path unchanged|guest flow/i, 'D4', 'mentions non-allowlisted guest flow unchanged');

section('E. Role model');

docMatches(doc, /owner\/admin.*Owner Insights|Owner Insights.*owner\/admin/i, 'E1', 'mentions Owner Insights owner/admin gate');
docMatches(doc, /Operations.*operator|operator\+.*Operations/i, 'E2', 'mentions Operations operator+');

section('F. Safety');

docMatches(doc, /SELECT-only|SELECT only/i, 'F1', 'mentions SELECT-only');
docMatches(doc, /read-only transaction|BEGIN READ ONLY/i, 'F2', 'mentions read-only transaction');
docIncludes(doc, 'client_slug', 'F3', 'mentions client_slug scoping');
docMatches(doc, /LIMIT|timeout/i, 'F4', 'mentions LIMIT + timeout');
docIncludes(doc, 'raw_payload', 'F5', 'mentions raw_payload blocked');
docMatches(doc, /SELECT \*|SELECT\*/i, 'F6', 'mentions SELECT * blocked');
docMatches(doc, /no Stripe|No Stripe/i, 'F7', 'mentions no Stripe');
docMatches(doc, /no n8n|No n8n/i, 'F8', 'mentions no n8n');
docMatches(doc, /Meta webhook|no Meta/i, 'F9', 'mentions no Meta webhook changes');

section('G. Caveats + staging baseline');

docMatches(doc, /audit log.*deferred|Audit log/i, 'G1', 'mentions audit log deferred');
docMatches(doc, /live.*WhatsApp.*go\/no-go|go\/no-go/i, 'G2', 'mentions live WhatsApp go/no-go');
docIncludes(doc, '0b41bff-stage25j-owner-perms3', 'G3', 'mentions staging baseline revision/image');
docMatches(doc, /\/healthz.*200|healthz.*PASS/i, 'G4', 'mentions /healthz PASS');

section('H. Proven owner questions');

docIncludes(doc, "Who hasn't settled up?", 'H1', 'mentions outstanding balances question');
docIncludes(doc, 'How much revenue this month?', 'H2', 'mentions revenue question');
docIncludes(doc, 'Which package is most popular?', 'H3', 'mentions package popularity question');
docMatches(doc, /recent guest messages/i, 'H4', 'mentions recent guest messages question');
docMatches(doc, /raw_payload.*blocked|Show raw_payload/i, 'H5', 'mentions raw_payload blocked proof');

section('I. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
const rel = 'scripts/verify-luna-agent-phase25-closeout.js';
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${rel}`) {
  pass('I1', `${SCRIPT} registered`);
} else {
  fail('I1', `${SCRIPT} missing or wrong path`);
}

if (fs.existsSync(path.join(ROOT, rel))) pass('I2', 'closeout script file exists');
else fail('I2', 'closeout script file missing');

section('J. Downstream verifiers (limited)');

for (const script of DOWNSTREAM) {
  if (!pkg.scripts || !pkg.scripts[script]) {
    fail('J.' + script, `${script} not registered in package.json`);
    continue;
  }
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
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
