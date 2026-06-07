/**
 * Phase 25 — Design-lock verifier for Owner Ask Luna + allowlisted WhatsApp.
 *
 * Static doc checks only — no runtime, no OpenAI calls.
 *
 * Usage:
 *   npm run verify:luna-agent-phase25-owner-design
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'PHASE-25-OWNER-ASK-LUNA-DESIGN.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase25-owner-design';

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

console.log('\nverify-luna-agent-phase25-owner-design.js  (Phase 25 design lock)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'design verifier passes node --check');
} catch {
  fail('0', 'design verifier syntax error');
}

section('A. Doc exists');

if (fs.existsSync(DOC)) pass('A1', 'PHASE-25-OWNER-ASK-LUNA-DESIGN.md exists');
else fail('A1', 'design doc missing');

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

section('B. Product scope');

docMatches(doc, /Owner Ask Luna/i, 'B1', 'Owner Ask Luna');
docMatches(doc, /allowlisted WhatsApp/i, 'B2', 'allowlisted WhatsApp numbers');
docIncludes(doc, 'Ty', 'B3', 'Ty as owner');
docIncludes(doc, 'Ale', 'B4', 'Ale as owner');
docIncludes(doc, 'Cami', 'B5', 'Cami as owner');
docMatches(doc, /Stage 26/i, 'B6', 'Stage 26 guest AI intake deferred');

section('C. staff_phone_access + roles');

docIncludes(doc, 'staff_phone_access', 'C1', 'staff_phone_access table');
docIncludes(doc, 'operator', 'C2', 'operator role');
docIncludes(doc, 'owner', 'C3', 'owner role');

section('D. WhatsApp routing');

docMatches(doc, /owner.*guest|guest.*owner|routing/i, 'D1', 'WhatsApp routing owner vs guest');
docMatches(doc, /no guest (conversation|booking)|must not accidentally create guest/i, 'D2', 'no guest booking side effects from owner messages');
docMatches(doc, /shadow-mode-only|shadow mode|shadow-mode/i, 'D3', 'no shadow-mode-only design (explicitly rejected)');

section('E. Read-only SQL model');

docMatches(doc, /read-only SQL|read-only SQL model/i, 'E1', 'read-only SQL model');
docMatches(doc, /SELECT only|SELECT-only/i, 'E2', 'SELECT only');
docIncludes(doc, 'client_slug', 'E3', 'client_slug enforcement');
docMatches(doc, /LIMIT/i, 'E4', 'LIMIT enforcement');
docMatches(doc, /timeout/i, 'E5', 'timeout enforcement');
docMatches(doc, /INSERT|UPDATE|DELETE|blocked/i, 'E6', 'blocked writes');

section('F. Catalog + UX');

docMatches(doc, /data catalog|owner data catalog/i, 'F1', 'data catalog');
docMatches(doc, /Staff Portal Owner mode|Owner mode/i, 'F2', 'Staff Portal Owner mode');
docMatches(doc, /WhatsApp.*direct|answer directly in WhatsApp/i, 'F3', 'WhatsApp owner direct replies');

section('G. Deferred items');

docMatches(doc, /audit log.*deferred|Deferred.*audit log|skip audit log/i, 'G1', 'audit log deferred');

section('H. Stage 25 roadmap 25b–25j');

for (const slice of ['25b', '25c', '25d', '25e', '25f', '25g', '25h', '25i', '25j']) {
  docIncludes(doc, slice, `H.${slice}`, `roadmap mentions ${slice}`);
}

section('I. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
const rel = 'scripts/verify-luna-agent-phase25-owner-design.js';
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${rel}`) {
  pass('I1', `${SCRIPT} registered`);
} else {
  fail('I1', `${SCRIPT} missing or wrong path`);
}

if (fs.existsSync(path.join(ROOT, rel))) pass('I2', 'design verifier file exists');
else fail('I2', 'design verifier file missing');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
