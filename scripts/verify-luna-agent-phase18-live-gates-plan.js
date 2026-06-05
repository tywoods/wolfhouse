/**
 * Phase 18a — Fast static verifier for the Luna live guest automation gate plan.
 *
 * Confirms PHASE-18.1 plan doc documents what can be automated first, what stays
 * blocked, required gates, first operational/live modes, Phase 18b scope, and
 * protective verifiers — without implementing live activation/sending.
 *
 * Non-recursive: does NOT execute downstream closeout trees.
 *
 * Usage:
 *   npm run verify:luna-agent-phase18-live-gates-plan
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC  = path.join(ROOT, 'docs', 'PHASE-18.1-LUNA-LIVE-AUTOMATION-GATES-PLAN.md');
const PKG  = path.join(ROOT, 'package.json');
const WF   = path.join(ROOT, 'n8n', 'Wolfhouse Booking Assistant - Message Intake Shadow.json');

const PRIOR_CLOSEOUTS = [
  ['verify:luna-agent-phase17-closeout', 'scripts/verify-luna-agent-phase17-closeout.js'],
  ['verify:luna-agent-phase16-closeout', 'scripts/verify-luna-agent-phase16-closeout.js'],
  ['verify:luna-agent-phase15-closeout', 'scripts/verify-luna-agent-phase15-closeout.js'],
  ['verify:luna-agent-phase14-closeout', 'scripts/verify-luna-agent-phase14-closeout.js'],
  ['verify:luna-agent-phase13-closeout', 'scripts/verify-luna-agent-phase13-closeout.js'],
  ['verify:luna-agent-phase12-closeout', 'scripts/verify-luna-agent-phase12-closeout.js'],
  ['verify:staff-ask-luna-phase11-closeout', 'scripts/verify-staff-ask-luna-phase11-closeout.js'],
];

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

console.log('\nverify-luna-agent-phase18-live-gates-plan.js  (Phase 18a — static, non-recursive)\n');

const startedMs = Date.now();

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'plan verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Plan document + sections');

if (!fs.existsSync(DOC)) {
  fail('A1', 'PHASE-18.1 plan doc missing');
  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(1);
}
pass('A1', 'plan doc exists');

const doc = fs.readFileSync(DOC, 'utf8');

const sections = [
  ['A2',  'Go/No-Go framing',            /## 0\. Go\/No-Go framing/],
  ['A3',  'What can be automated first', /## 1\. What can be automated first/],
  ['A4',  'What must remain blocked',    /## 2\. What must remain blocked/],
  ['A5',  'Gates required',              /## 3\. Gates required/],
  ['A6',  'First operational mode',      /## 4\. First operational mode/],
  ['A7',  'First limited live mode',     /## 5\. First limited live mode/],
  ['A8',  'Phase 18b first implementation', /## 6\. Phase 18b/],
  ['A9',  'Verifiers that must protect', /## 7\. Verifiers that must protect/],
  ['A10', 'Safety proof',               /## 8\. Safety proof/],
  ['A11', 'Stop conditions',            /## 9\. Stop conditions/],
  ['A12', 'Phase map',                  /## 10\. Phase map/],
];
for (const [id, label, re] of sections) {
  if (re.test(doc)) pass(id, label);
  else fail(id, label + ' missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Automatable-first capabilities');

const automatable = [
  ['intake preview',          /intake preview/i],
  ['dry-run quote/availability', /dry-run quote\/availability/i],
  ['ask_next draft',          /ask_next draft/i],
  ['handoff draft',           /handoff draft/i],
  ['staff-visible suggested reply', /staff-visible suggested reply|suggested_reply/i],
];
for (const [label, re] of automatable) {
  if (re.test(doc)) pass('B.' + label.replace(/[^a-z0-9]/gi, '_'), 'automatable: ' + label);
  else fail('B.' + label.replace(/[^a-z0-9]/gi, '_'), 'missing: ' + label);
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Blocked actions');

const blocked = [
  ['live WhatsApp sends',         /Live WhatsApp sends/i],
  ['booking writes w/o approval', /Booking writes without explicit approval/i],
  ['Stripe link w/o approval',    /Stripe link creation without explicit approval/i],
  ['confirmation sends',          /Confirmation sends/i],
  ['refund/cancel/date automation', /cancellation ?\/ ?refund ?\/ ?date-change/i],
  ['n8n production activation',   /n8n production activation/i],
];
for (const [label, re] of blocked) {
  if (re.test(doc)) pass('C.' + label.replace(/[^a-z0-9]/gi, '_'), 'blocked: ' + label);
  else fail('C.' + label.replace(/[^a-z0-9]/gi, '_'), 'missing blocked: ' + label);
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Required gates');

const gates = [
  ['WHATSAPP_DRY_RUN / live-send', /WHATSAPP_DRY_RUN/],
  ['bot pause gate',               /bot_paused|bot pause gate/i],
  ['Stage 7.8 owner approval',     /Stage 7\.8/],
  ['staff approval / confirm',     /Staff approval|explicit confirm/i],
  ['idempotency keys',             /idempotency_key|Idempotency keys/i],
  ['audit log',                    /Audit log/i],
  ['kill switch',                  /Kill switch/i],
  ['fallback / handoff',           /Fallback ?\/ ?handoff|handoff on ambiguity/i],
];
for (const [label, re] of gates) {
  if (re.test(doc)) pass('D.' + label.replace(/[^a-z0-9]/gi, '_').slice(0, 28), 'gate: ' + label);
  else fail('D.' + label.replace(/[^a-z0-9]/gi, '_').slice(0, 28), 'missing gate: ' + label);
}

if (/All gates must pass simultaneously/i.test(doc)) {
  pass('D.simul', 'plan requires all gates pass simultaneously');
} else {
  fail('D.simul', 'simultaneous-gate rule missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('E. Operational modes');

if (/staff reviews\/copies manually/i.test(doc) && /No live send/i.test(doc)) {
  pass('E1', 'first mode is draft-only shadow (no live send)');
} else {
  fail('E1', 'draft-only shadow mode unclear');
}

if (/Allowlisted test numbers only/i.test(doc) && /No real guests/i.test(doc)) {
  pass('E2', 'limited live mode is allowlist/test-only');
} else {
  fail('E2', 'allowlist/test-only live mode missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('F. Phase 18b draft-builder scope + protective verifiers');

const builderReturns = ['message_text', 'extraction', 'dry_run_plan', 'suggested_reply', 'next_action'];
for (const f of builderReturns) {
  if (doc.includes(f)) pass('F.ret.' + f, '18b returns ' + f);
  else fail('F.ret.' + f, '18b return field missing: ' + f);
}

const protections = [
  ['cannot send WhatsApp',          /cannot send WhatsApp/i],
  ['cannot activate workflow',      /cannot activate workflow/i],
  ['cannot call booking-create',    /cannot call booking-create-from-plan/i],
  ['cannot create Stripe link',     /cannot create Stripe link/i],
  ['cannot call webhook',           /cannot call webhook/i],
  ['cannot update confirmation_sent_at', /cannot update confirmation_sent_at/i],
  ['must preserve no_write_performed', /must preserve.*no_write_performed/i],
  ['must handoff refunds/cancel',   /must handoff refunds\/cancellations/i],
  ['must only draft, not send',     /must only draft, not send/i],
];
for (const [label, re] of protections) {
  if (re.test(doc)) pass('F.guard.' + label.replace(/[^a-z0-9]/gi, '_').slice(0, 28), 'guard: ' + label);
  else fail('F.guard.' + label.replace(/[^a-z0-9]/gi, '_').slice(0, 28), 'missing guard: ' + label);
}

// ─────────────────────────────────────────────────────────────────────────────
section('G. Safety / NO_GO + prior artifact anchors');

if (/NO_GO/.test(doc)) pass('G1', 'plan documents live WhatsApp NO_GO');
else fail('G1', 'NO_GO missing');

if (/Stage 7\.8/.test(doc)) pass('G2', 'plan anchors Stage 7.8 owner gate');
else fail('G2', 'Stage 7.8 missing');

if (fs.existsSync(WF)) {
  const wf = JSON.parse(fs.readFileSync(WF, 'utf8'));
  if (wf.active === false) pass('G3', 'n8n shadow workflow still active:false');
  else fail('G3', 'shadow workflow active is not false');
} else {
  fail('G3', 'shadow workflow JSON missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('H. npm script + prior closeouts exist (not executed)');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts
  && pkg.scripts['verify:luna-agent-phase18-live-gates-plan']
    === 'node scripts/verify-luna-agent-phase18-live-gates-plan.js') {
  pass('H1', 'verify:luna-agent-phase18-live-gates-plan registered');
} else {
  fail('H1', 'npm script missing or wrong path');
}

for (const [scriptName, relPath] of PRIOR_CLOSEOUTS) {
  const full = path.join(ROOT, relPath);
  if (pkg.scripts && pkg.scripts[scriptName]) pass('H.prior.' + scriptName, `${scriptName} registered`);
  else fail('H.prior.' + scriptName, `${scriptName} missing`);
  if (fs.existsSync(full)) pass('H.prior.file.' + scriptName, `${relPath} exists`);
  else fail('H.prior.file.' + scriptName, `${relPath} missing`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('I. Plan verifier is non-recursive (no downstream exec)');

const selfSrc = fs.readFileSync(__filename, 'utf8');
if (!/execSync\s*\(\s*[`'"]npm run verify:/.test(selfSrc)) {
  pass('I1', 'plan verifier does not exec downstream npm scripts');
} else {
  fail('I1', 'plan verifier still execSync npm run downstream');
}

const elapsed = Math.round((Date.now() - startedMs) / 1000);
console.log(`\n--- ${passes} passed, ${failures} failed (${elapsed}s, non-recursive) ---\n`);
process.exit(failures > 0 ? 1 : 0);
