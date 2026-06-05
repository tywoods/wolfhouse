/**
 * Phase 17a — Static verifier for the Luna shadow vs main bot comparison plan.
 *
 * Confirms PHASE-17.1 plan doc exists, documents what/how to compare, the fixture
 * set, pass/mismatch criteria, mismatch handling, the canonical-first strategy
 * (legacy parser output is hard to access), safety, and stop conditions —
 * without implementing comparison logic, activating n8n, or sending/writing.
 *
 * Usage:
 *   npm run verify:luna-agent-phase17-shadow-comparison-plan
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const DOC     = path.join(ROOT, 'docs', 'PHASE-17.1-LUNA-SHADOW-COMPARISON-PLAN.md');
const PKG     = path.join(ROOT, 'package.json');
const WF_PATH = path.join(ROOT, 'n8n', 'Wolfhouse Booking Assistant - Message Intake Shadow.json');
const MAIN_WF = path.join(ROOT, 'n8n', 'Wolfhouse Booking Assistant  - Main.json');
const API     = path.join(__dirname, 'staff-query-api.js');

const DOWNSTREAM = [
  'verify:luna-agent-phase16-closeout',
  'verify:luna-agent-phase15-closeout',
  'verify:luna-agent-phase14-closeout',
  'verify:luna-agent-phase13-closeout',
  'verify:luna-agent-phase12-closeout',
  'verify:staff-ask-luna-phase11-closeout',
];

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

console.log('\nverify-luna-agent-phase17-shadow-comparison-plan.js  (Phase 17a)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'plan verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Plan document + sections');

if (!fs.existsSync(DOC)) {
  fail('A1', 'PHASE-17.1 plan doc missing');
  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(1);
}
pass('A1', 'plan doc exists');

const doc = fs.readFileSync(DOC, 'utf8');

const sections = [
  ['A2',  'Legacy parser access problem',     /## 0\. Legacy parser access problem/],
  ['A3',  'What is being compared',           /## 1\. What exactly is being compared/],
  ['A4',  'Input fixture set',                /## 2\. Input fixture set/],
  ['A5',  'Fields to compare',                /## 3\. Fields to compare/],
  ['A6',  'PASS criteria',                    /## 4\. PASS criteria/],
  ['A7',  'Mismatch criteria',                /## 5\. Mismatch criteria/],
  ['A8',  'Mismatch handling',                /## 6\. Mismatch handling/],
  ['A9',  'Phase 17b recommended',            /## 7\. Phase 17b/],
  ['A10', 'Phase 17c / 17d eventual',         /## 8\. Phase 17c \/ 17d/],
  ['A11', 'Safety proof',                     /## 9\. Safety proof/],
  ['A12', 'Stop conditions',                  /## 10\. Explicit stop conditions/],
  ['A13', 'Phase map',                        /## 11\. Phase map/],
];
for (const [id, label, re] of sections) {
  if (re.test(doc)) pass(id, label);
  else fail(id, label + ' missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Canonical-first strategy (legacy parser hard to access)');

const canonicalAnchors = [
  ['B1', 'documents legacy parser hard to access', /hard to access/i],
  ['B2', 'canonical expected-output first',        /canonical expected-output comparison FIRST|canonical vs Staff API|canonical expected output/i],
  ['B3', 'legacy parser is LLM chain / non-deterministic', /LLM (prompt|call|chain)|non-deterministic/i],
  ['B4', 'old parser captured manually / optional', /captured manually|manual paste|hand-authored|optional/i],
  ['B5', 'harness does not execute legacy parser live', /does not (call live n8n|execute the legacy parser)|never (by )?live execution|never live/i],
];
for (const [id, label, re] of canonicalAnchors) {
  if (re.test(doc)) pass(id, label);
  else fail(id, label + ' missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Comparison subjects + endpoint');

const subjectKeywords = [
  'message-intake-preview',
  'dry_run_plan',
  'ask_next',
  'handoff_required',
  'Staff API is the brain',
  'Wolfhouse booking parser',
];
for (const kw of subjectKeywords) {
  const id = 'C.' + kw.replace(/[^a-z0-9]/gi, '_').slice(0, 32);
  if (doc.includes(kw)) pass(id, 'plan mentions ' + kw);
  else fail(id, 'plan missing: ' + kw);
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Fixture set coverage (>=10 cases)');

const fixtures = [
  ['EN complete',            /EN complete booking/i],
  ['IT partial',             /IT partial availability/i],
  ['ES native complete',     /ES native complete/i],
  ['DE native complete',     /DE native complete/i],
  ['add-on request',         /add-on request/i],
  ['refund/handoff',         /refund ?\/ ?handoff/i],
  ['invalid/unknown package',/invalid ?\/ ?unknown package/i],
  ['missing dates',          /missing dates/i],
  ['payment deposit/full',   /deposit ?\/ ?full/i],
  ['multilingual guest count',/multilingual guest count/i],
];
let fixtureCount = 0;
for (const [label, re] of fixtures) {
  if (re.test(doc)) { pass('D.' + label.replace(/[^a-z0-9]/gi, '_'), 'fixture: ' + label); fixtureCount++; }
  else fail('D.' + label.replace(/[^a-z0-9]/gi, '_'), 'fixture missing: ' + label);
}
if (fixtureCount >= 10) pass('D.count', `>=10 fixtures documented (${fixtureCount})`);
else fail('D.count', `expected >=10 fixtures, got ${fixtureCount}`);

// ─────────────────────────────────────────────────────────────────────────────
section('E. Compared fields documented');

const fieldKeywords = [
  'intent', 'language', 'guest_name', 'guests',
  'check_in', 'check_out', 'package_code', 'payment_choice',
  'add_ons', 'missing_fields', 'ask_next', 'handoff_reason',
  'can_chain_dry_run',
];
for (const kw of fieldKeywords) {
  if (doc.includes(kw)) pass('E.' + kw, 'compares ' + kw);
  else fail('E.' + kw, 'compared field missing: ' + kw);
}

// ─────────────────────────────────────────────────────────────────────────────
section('F. PASS / mismatch criteria + blocking-vs-cosmetic');

if (/matches or improves/i.test(doc)) pass('F1', 'PASS = matches-or-improves legacy');
else fail('F1', 'matches-or-improves criterion missing');

if (/blocking/i.test(doc) && /cosmetic/i.test(doc)) pass('F2', 'mismatch categorized blocking vs cosmetic');
else fail('F2', 'blocking-vs-cosmetic categorization missing');

if (/one at a time/i.test(doc)) pass('F3', 'fix parser gaps one at a time');
else fail('F3', 'incremental fix rule missing');

if (/do not activate/i.test(doc)) pass('F4', 'no activation while blocking mismatch exists');
else fail('F4', 'no-activation-while-blocking rule missing');

// ─────────────────────────────────────────────────────────────────────────────
section('G. Safety: live send / write / activation NO_GO');

const safety = [
  ['G1', 'live WhatsApp NO_GO', /NO_GO/],
  ['G2', 'Stage 7.8 gate', /Stage 7\.8/],
  ['G3', 'no n8n activation', /No n8n activation|not activate|stays `?active: ?false`?|active: false/i],
  ['G4', 'no WhatsApp send', /No WhatsApp send|no.*send/i],
  ['G5', 'no DB write', /No DB write/i],
  ['G6', 'no Stripe', /No Stripe/i],
];
for (const [id, label, re] of safety) {
  if (re.test(doc)) pass(id, label);
  else fail(id, label + ' missing');
}

const safetyFlags = ['no_write_performed', 'sends_whatsapp', 'creates_booking', 'creates_payment', 'creates_stripe_link', 'whatsapp_sent', 'live_send_blocked'];
for (const f of safetyFlags) {
  if (doc.includes(f)) pass('G.flag.' + f, 'safety flag referenced: ' + f);
  else fail('G.flag.' + f, 'safety flag missing: ' + f);
}

// ─────────────────────────────────────────────────────────────────────────────
section('H. Existing artifact anchors (map-first)');

if (fs.existsSync(WF_PATH)) {
  const wf = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
  if (wf.active === false) pass('H1', 'shadow workflow still active:false');
  else fail('H1', 'shadow workflow active is not false');
} else {
  fail('H1', 'shadow workflow JSON missing');
}

if (fs.existsSync(MAIN_WF)) {
  const main = fs.readFileSync(MAIN_WF, 'utf8');
  if (/Wolfhouse booking parser/.test(main)) pass('H2', 'legacy n8n booking parser present in repo');
  else fail('H2', 'legacy booking parser not found in Main workflow');
} else {
  fail('H2', 'n8n Main workflow missing');
}

if (fs.existsSync(API) && fs.readFileSync(API, 'utf8').includes("'/staff/bot/message-intake-preview'")) {
  pass('H3', 'Staff API message-intake-preview route exists');
} else {
  fail('H3', 'message-intake-preview route missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('I. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts
  && pkg.scripts['verify:luna-agent-phase17-shadow-comparison-plan']
    === 'node scripts/verify-luna-agent-phase17-shadow-comparison-plan.js') {
  pass('I1', 'verify:luna-agent-phase17-shadow-comparison-plan registered');
} else {
  fail('I1', 'npm script missing or wrong path');
}

// ─────────────────────────────────────────────────────────────────────────────
section('J. Downstream closeout regression');

for (const script of DOWNSTREAM) {
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    pass('J.' + script, `${script} passes`);
  } catch (e) {
    fail('J.' + script, `${script} failed`);
    const out = (e.stdout || '') + (e.stderr || '');
    console.error(out.split('\n').slice(-6).join('\n'));
  }
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
