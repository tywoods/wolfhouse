/**
 * Phase 15a — Static verifier for Luna guest message intake/extraction plan.
 *
 * Confirms PHASE-15.1 plan doc exists, maps to existing dry-run + n8n parser
 * anchors, documents validation/pipeline, and that no intake route exists yet.
 *
 * Usage:
 *   npm run verify:luna-agent-phase15-intake-plan
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const DOC    = path.join(ROOT, 'docs', 'PHASE-15.1-LUNA-MESSAGE-INTAKE-EXTRACTION-PLAN.md');
const API    = path.join(__dirname, 'staff-query-api.js');
const DRYRUN = path.join(__dirname, 'lib', 'luna-guest-booking-dry-run.js');
const AIINT  = path.join(__dirname, 'lib', 'staff-ask-luna-ai-intent.js');
const PRICING = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.pricing.json');
const N8NMAIN = path.join(ROOT, 'n8n', 'Wolfhouse Booking Assistant  - Main.json');
const PKG    = path.join(ROOT, 'package.json');

const DOWNSTREAM = [
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

function apiHasRoute(pathLiteral) {
  const apiSrc = fs.existsSync(API) ? fs.readFileSync(API, 'utf8') : '';
  return apiSrc.includes(pathLiteral);
}

console.log('\nverify-luna-agent-phase15-intake-plan.js  (Phase 15a)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'plan verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Plan document');

if (!fs.existsSync(DOC)) {
  fail('A1', 'PHASE-15.1 plan doc missing');
  console.log(`\n--- ${passes} passed, ${failures + 1} failed ---\n`);
  process.exit(1);
}
pass('A1', 'plan doc exists');

const doc = fs.readFileSync(DOC, 'utf8');

const sections = [
  ['A2', 'Existing extraction code map', /## 0\. Existing extraction code/],
  ['A3', 'Extractor output shape', /## 1\. Intake extractor output shape/],
  ['A4', 'Deterministic parsing', /## 2\. Deterministic parsing/],
  ['A5', 'AI extraction', /## 3\. AI extraction/],
  ['A6', 'Must remain impossible', /## 4\. What must remain impossible/],
  ['A7', 'Post-extraction validation', /## 5\. Post-extraction validation/],
  ['A8', 'Pipeline connection', /## 6\. Pipeline connection/],
  ['A9', 'Recommended Phase 15b', /## 7\. Recommended Phase 15b/],
  ['A10', 'Verifiers', /## 8\. Verifiers that must protect/],
  ['A11', 'Stop conditions', /## 9\. Explicit stop conditions/],
  ['A12', 'Phase map', /## 10\. Phase map/],
];
for (const [id, label, re] of sections) {
  if (re.test(doc)) pass(id, label);
  else fail(id, label + ' missing');
}

const keywords = [
  'booking_inquiry', 'message-intake-preview', 'runLunaGuestBookingDryRun',
  'booking-dry-run', 'deterministic', 'handoff_required', 'missing_fields',
  'package_code', 'payment_choice', 'no_write_performed', 'sends_whatsapp',
  'calls_n8n', 'LUNA_GUEST_INTAKE_AI_ENABLED', 'staff-ask-luna-ai-intent',
  'Wolfhouse booking parser', 'NO_GO',
];
for (const kw of keywords) {
  const id = 'A.kw.' + kw.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
  if (doc.includes(kw)) pass(id, 'plan mentions ' + kw);
  else fail(id, 'plan missing keyword: ' + kw);
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Existing code anchors (map-first)');

if (fs.existsSync(DRYRUN)) {
  const drySrc = fs.readFileSync(DRYRUN, 'utf8');
  pass('B1', 'luna-guest-booking-dry-run.js exists');
  if (/function\s+runLunaGuestBookingDryRun/.test(drySrc)) pass('B2', 'runLunaGuestBookingDryRun exported');
  else fail('B2', 'runLunaGuestBookingDryRun missing');
  if (/BOT_BOOKING_REQUIRED_FIELDS/.test(drySrc)) pass('B3', 'dry-run required fields defined');
  else fail('B3', 'BOT_BOOKING_REQUIRED_FIELDS missing');
  if (/resolveDryRunPhone/.test(drySrc)) pass('B4', 'phone/from resolution in dry-run');
  else fail('B4', 'resolveDryRunPhone missing');
} else {
  fail('B1', 'dry-run module missing');
}

if (apiHasRoute("'/staff/bot/booking-dry-run'")) pass('B5', 'POST /staff/bot/booking-dry-run exists');
else fail('B5', 'booking-dry-run route missing');

if (fs.existsSync(AIINT)) {
  const aiSrc = fs.readFileSync(AIINT, 'utf8');
  pass('B6', 'staff-ask-luna-ai-intent.js exists (AI pattern reference)');
  if (/SQL_OR_TOOL_RE/.test(aiSrc)) pass('B7', 'Ask Luna AI rejects SQL/tool output');
  else fail('B7', 'SQL guard missing in Ask Luna AI');
  if (/STAFF_ASK_LUNA_AI_ENABLED/.test(aiSrc)) pass('B8', 'Ask Luna AI env gate pattern');
  else fail('B8', 'AI env gate missing');
} else {
  fail('B6', 'staff-ask-luna-ai-intent.js missing');
}

if (fs.existsSync(N8NMAIN)) {
  const n8n = fs.readFileSync(N8NMAIN, 'utf8');
  if (/Wolfhouse booking parser/.test(n8n)) pass('B9', 'legacy n8n booking parser documented in repo');
  else fail('B9', 'n8n booking parser not found');
} else {
  fail('B9', 'n8n Main workflow missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Phase 15b intake implementation anchors');

const apiSrc = fs.existsSync(API) ? fs.readFileSync(API, 'utf8') : '';
const intakeHelper = path.join(__dirname, 'lib', 'luna-guest-message-intake.js');

if (apiHasRoute("'/staff/bot/message-intake-preview'")) {
  pass('C1', 'POST /staff/bot/message-intake-preview registered');
} else {
  fail('C1', 'message-intake-preview route missing');
}

if (fs.existsSync(intakeHelper)) {
  pass('C2', 'luna-guest-message-intake.js exists');
  const intakeSrc = fs.readFileSync(intakeHelper, 'utf8');
  if (/extractLunaGuestMessageIntake/.test(intakeSrc)) pass('C3', 'extractLunaGuestMessageIntake in helper');
  else fail('C3', 'extractLunaGuestMessageIntake missing');
  if (/validateLunaGuestMessageIntake/.test(intakeSrc)) pass('C4', 'validateLunaGuestMessageIntake in helper');
  else fail('C4', 'validateLunaGuestMessageIntake missing');
  if (/buildDryRunInputFromIntake/.test(intakeSrc)) pass('C5', 'buildDryRunInputFromIntake in helper');
  else fail('C5', 'buildDryRunInputFromIntake missing');
  if (/LUNA_GUEST_INTAKE_AI_ENABLED/.test(intakeSrc)) pass('C6', 'AI env gate documented in helper');
  else fail('C6', 'AI env gate missing');
} else {
  fail('C2', 'luna-guest-message-intake.js missing');
}

const pkg15 = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg15.scripts
  && pkg15.scripts['verify:luna-agent-phase15-message-intake-preview']) {
  pass('C7', 'phase15 message-intake-preview verifier registered');
} else {
  fail('C7', 'verify:luna-agent-phase15-message-intake-preview npm script missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Pricing catalog anchors (package codes)');

if (fs.existsSync(PRICING)) {
  const pricing = JSON.parse(fs.readFileSync(PRICING, 'utf8'));
  const codes = (pricing.packages || []).map((p) => p.code);
  for (const code of ['malibu', 'uluwatu', 'waimea']) {
    if (codes.includes(code)) pass('D.' + code, `pricing catalog includes ${code}`);
    else fail('D.' + code, `${code} missing from pricing`);
  }
} else {
  fail('D1', 'wolfhouse-somo.pricing.json missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('E. Plan ↔ dry-run field alignment');

if (doc.includes('guest_count') && doc.includes('normalizeInput')) {
  pass('E1', 'plan maps extractor fields to dry-run normalizeInput');
} else {
  fail('E1', 'dry-run field mapping missing from plan');
}

if (doc.includes('deposit') && doc.includes('full') && doc.includes('payment_choice')) {
  pass('E2', 'plan restricts payment_choice to deposit/full');
} else {
  fail('E2', 'payment_choice rules missing');
}

if (/draft address first|deterministic wins/i.test(doc) || doc.includes('deterministic wins')) {
  pass('E3', 'plan states deterministic wins over AI on conflict');
} else if (doc.includes('deterministic') && doc.includes('AI fills **only null fields**')) {
  pass('E3', 'plan states AI fills only null fields');
} else {
  fail('E3', 'deterministic-first precedence unclear');
}

// ─────────────────────────────────────────────────────────────────────────────
section('F. Live send / write remains NO_GO');

if (doc.includes('NO_GO') && doc.includes('Stage 7.8')) pass('F1', 'plan documents live send NO_GO');
else fail('F1', 'NO_GO / Stage 7.8 missing');

if (doc.includes('runLunaGuestBookingWriteBridge') || doc.includes('write bridge')) {
  pass('F2', 'plan references Phase 13 write bridge as downstream only');
} else {
  fail('F2', 'write bridge downstream reference missing');
}

if (!doc.includes('skip dry-run') || doc.includes('must not skip') || doc.includes('Skipping dry-run')) {
  pass('F3', 'plan forbids skipping dry-run for writes');
} else {
  fail('F3', 'dry-run skip rule unclear');
}

// ─────────────────────────────────────────────────────────────────────────────
section('G. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts
  && pkg.scripts['verify:luna-agent-phase15-intake-plan']
    === 'node scripts/verify-luna-agent-phase15-intake-plan.js') {
  pass('G1', 'verify:luna-agent-phase15-intake-plan registered');
} else {
  fail('G1', 'npm script missing or wrong path');
}

// ─────────────────────────────────────────────────────────────────────────────
section('H. Downstream closeout regression');

for (const script of DOWNSTREAM) {
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    pass('H.' + script, `${script} passes`);
  } catch (e) {
    fail('H.' + script, `${script} failed`);
    const out = (e.stdout || '') + (e.stderr || '');
    console.error(out.split('\n').slice(-5).join('\n'));
  }
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
