/**
 * Phase 19f.1 — Static verifier for hosted n8n Cloud → Staff API cutover plan.
 *
 * Confirms PHASE-19f plan doc documents: current live ownership, target architecture,
 * first-change workflow, idempotency key design, send kind mapping, blocked scope,
 * cutover stages, static workflow requirements, and safety — without activating n8n
 * or changing Meta webhook.
 *
 * Non-recursive: runs only guest-reply-send-route + whatsapp-provider downstream.
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-n8n-cutover-plan
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'PHASE-19f-N8N-STAFF-API-CUTOVER-PLAN.md');
const PKG = path.join(ROOT, 'package.json');
const PIPE_WF = path.join(ROOT, 'n8n', 'Wolfhouse Booking Assistant - Luna Pipe Shadow.json');
const INTAKE_SHADOW = path.join(ROOT, 'n8n', 'Wolfhouse Booking Assistant - Message Intake Shadow.json');

const DOWNSTREAM = [
  'verify:luna-agent-phase19-guest-reply-send-route',
  'verify:luna-agent-phase19-whatsapp-provider',
];

const startedMs = Date.now();

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }
function key(label) { return label.replace(/[^a-z0-9]/gi, '_').slice(0, 32); }

console.log('\nverify-luna-agent-phase19-n8n-cutover-plan.js  (Phase 19f.1 — static, non-recursive)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'plan verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

section('A. Plan document + sections');

if (!fs.existsSync(DOC)) {
  fail('A1', 'PHASE-19f plan doc missing');
  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(1);
}
pass('A1', 'plan doc exists');

const doc = fs.readFileSync(DOC, 'utf8');

const sections = [
  ['A2', 'Go/No-Go framing', /## 0\. Go\/No-Go framing/],
  ['A3', 'Current live ownership', /## 1\. Current live ownership/],
  ['A4', 'Target near-term architecture', /## 2\. Target near-term architecture/],
  ['A5', 'What should change first', /## 3\. What should change first/],
  ['A6', 'Stable idempotency key design', /## 4\. Stable idempotency key design/],
  ['A7', 'Send kind mapping', /## 5\. Send kind mapping/],
  ['A8', 'What remains blocked', /## 6\. What remains blocked/],
  ['A9', 'Safe cutover stages', /## 7\. Safe cutover stages/],
  ['A10', 'What not to do', /## 8\. What not to do/],
  ['A11', 'Static workflow requirements', /## 9\. Static workflow requirements/],
  ['A12', 'Staff API endpoints', /## 10\. Staff API endpoints/],
  ['A13', 'Verifiers that must protect', /## 11\. Verifiers that must protect/],
  ['A14', 'Safety proof', /## 12\. Safety proof/],
  ['A15', 'Stop conditions', /## 13\. Stop conditions/],
  ['A16', 'Phase map', /## 14\. Phase map/],
];
for (const [id, label, re] of sections) {
  if (re.test(doc)) pass(id, label);
  else fail(id, label + ' missing');
}

section('B. Current live ownership');

const ownership = [
  ['Meta inbound n8n Cloud booking-assistant', /tywoods\.app\.n8n\.cloud\/webhook\/booking-assistant/],
  ['old Main brain and sender', /Old n8n Main.*brain.*sender|brain \+ sender/i],
  ['Staff API not inbound owner', /not.*inbound owner|not Meta inbound owner/i],
  ['phone number ID 1152900101233109', /1152900101233109/],
  ['Azure staging n8n inactive', /Azure staging n8n.*Inactive|0 active workflows/i],
];
for (const [label, re] of ownership) {
  if (re.test(doc)) pass('B.' + key(label), 'ownership: ' + label);
  else fail('B.' + key(label), 'missing ownership: ' + label);
}

section('C. Target architecture');

const arch = [
  ['n8n is the pipe', /n8n is the pipe/i],
  ['Staff API brain and send gate', /Staff API is the brain and send gate|Staff API brain/i],
  ['guest-reply-draft', /\/staff\/bot\/guest-reply-draft/],
  ['guest-reply-send', /\/staff\/bot\/guest-reply-send/],
  ['no direct Graph in pipe', /No\*\* direct Graph API|no direct Graph/i],
  ['Meta webhook stays on n8n', /Meta webhook stays on hosted n8n|Meta on n8n/i],
];
for (const [label, re] of arch) {
  if (re.test(doc)) pass('C.' + key(label), 'arch: ' + label);
  else fail('C.' + key(label), 'missing arch: ' + label);
}

section('D. First change — Luna Pipe Shadow');

const first = [
  ['Luna Pipe Shadow JSON path', /Luna Pipe Shadow\.json/],
  ['active false', /"active": false|`active`: `false`|active.*false/i],
  ['separate test webhook path', /not\*\* `booking-assistant`|Distinct.*booking-assistant/i],
  ['normalize inbound envelope', /normalize.*inbound|entry\[0\]\.changes/i],
  ['calls guest-reply-draft', /POST \/staff\/bot\/guest-reply-draft/],
  ['calls guest-reply-send when eligible', /guest-reply-send/],
  ['do not touch production Main', /Do \*\*not\*\* touch production Main|not touch production Main/i],
];
for (const [label, re] of first) {
  if (re.test(doc)) pass('D.' + key(label), 'first: ' + label);
  else fail('D.' + key(label), 'missing first: ' + label);
}

if (fs.existsSync(PIPE_WF)) {
  pass('D.wf.exists', 'Luna Pipe Shadow JSON present (19f.2+)');
} else {
  pass('D.wf.deferred', 'Luna Pipe Shadow JSON deferred to Phase 19f.2 (plan only)');
}

if (fs.existsSync(INTAKE_SHADOW)) {
  pass('D.prior.shadow', 'Phase 18e intake shadow exists as pattern reference');
} else {
  fail('D.prior.shadow', 'Phase 18e intake shadow missing');
}

section('E. Idempotency key design');

const idem = [
  ['primary key shape', /luna:\{client_slug\}:\{wa_message_id\}:\{send_kind\}/],
  ['wa_message_id from Meta', /messages\[0\]\.id|wa_message_id/i],
  ['fallback test only', /Fallback.*manual\/test only|test only/i],
  ['guest_message_sends alignment', /guest_message_sends.*unique|\(client_slug, idempotency_key\)/i],
  ['no random keys', /not\*\* mint random keys|must \*\*not\*\* mint random/i],
];
for (const [label, re] of idem) {
  if (re.test(doc)) pass('E.' + key(label), 'idem: ' + label);
  else fail('E.' + key(label), 'missing idem: ' + label);
}

section('F. Send kind mapping');

const kinds = [
  ['ask_missing_field', /ask_missing_field/],
  ['show_quote', /show_quote/],
  ['checkin_day reserved not inbound', /checkin_day.*Reserved|not.*inbound Main pipe/i],
  ['handoff skip send route', /skip.*guest-reply-send|Do not call send route/i],
  ['requires_staff blocked', /requires_staff/],
];
for (const [label, re] of kinds) {
  if (re.test(doc)) pass('F.' + key(label), 'kind: ' + label);
  else fail('F.' + key(label), 'missing kind: ' + label);
}

section('G. Blocked scope');

const blocked = [
  ['payment link automation', /Payment link automation.*Blocked|payment link automation/i],
  ['confirmation send', /Confirmation send.*Blocked/i],
  ['check-in scheduler', /Check-in day scheduler.*Blocked/i],
  ['cancellations refunds date changes', /cancellations.*refunds.*date changes/i],
  ['direct n8n Graph after cutover', /Direct n8n Graph API sends.*Blocked/i],
  ['Meta webhook cutover blocked', /Meta webhook cutover to Staff API.*Blocked/i],
  ['no booking write', /booking write.*Blocked|Automatic booking write.*Blocked/i],
  ['no Stripe from pipe', /Stripe.*Blocked/i],
];
for (const [label, re] of blocked) {
  if (re.test(doc)) pass('G.' + key(label), 'blocked: ' + label);
  else fail('G.' + key(label), 'missing blocked: ' + label);
}

section('H. Cutover stages A–E');

const stages = [
  ['Stage A inactive manual proof', /Stage A.*Inactive manual proof|\*\*A — Inactive manual proof\*\*/i],
  ['Stage B active pipe gates off', /Stage B.*Active pipe.*gates off|\*\*B — Active pipe/i],
  ['Stage C internal test send', /Stage C.*Internal\/test send|\*\*C — Internal/i],
  ['Stage D retire old send', /Stage D.*Retire old send|\*\*D — Retire old send/i],
  ['Stage E production activation', /Stage E.*Production activation|\*\*E — Production activation/i],
  ['no parallel send paths', /never run.*old Main Graph.*Staff API send|not simultaneously/i],
];
for (const [label, re] of stages) {
  if (re.test(doc)) pass('H.' + key(label), 'stage: ' + label);
  else fail('H.' + key(label), 'missing stage: ' + label);
}

section('I. What not to do');

const notDo = [
  ['do not delete credentials', /Do not.*delete n8n WhatsApp credentials/i],
  ['do not change Meta webhook yet', /Do not.*change Meta webhook URL/i],
  ['do not activate Azure staging on prod phone', /Do not.*activate Azure staging n8n against production/i],
  ['do not parallel send paths', /Do not.*run old Main direct send and Staff API send route in parallel/i],
  ['do not n8n Graph after Staff API send', /Do not.*let n8n call `graph\.facebook\.com`/i],
];
for (const [label, re] of notDo) {
  if (re.test(doc)) pass('I.' + key(label), 'not: ' + label);
  else fail('I.' + key(label), 'missing not: ' + label);
}

section('J. Static workflow requirements');

const wfReq = [
  ['maps send_performed', /send_performed/],
  ['maps sends_whatsapp', /sends_whatsapp/],
  ['maps duplicate', /duplicate/],
  ['maps idempotent_replay', /idempotent_replay/],
  ['maps blocked_reasons', /blocked_reasons/],
  ['maps whatsapp_message_id', /whatsapp_message_id/],
  ['debug respond', /debug.*respond|Debug respond/i],
  ['no graph in workflow spec', /Direct `graph\.facebook\.com`.*None|no direct Graph/i],
  ['no Stripe in workflow spec', /Stripe.*None|no Stripe/i],
];
for (const [label, re] of wfReq) {
  if (re.test(doc)) pass('J.' + key(label), 'wf req: ' + label);
  else fail('J.' + key(label), 'missing wf req: ' + label);
}

section('K. Safety — plan slice only');

const safety = [
  ['no n8n activation in slice', /No n8n Cloud activation|No n8n activation/i],
  ['no Meta webhook change', /No Meta webhook URL change|Meta webhook unchanged/i],
  ['no live send in slice', /No live WhatsApp send/i],
  ['no DB writes in slice', /No DB writes/i],
  ['no booking payment creation', /No booking\/payment creation/i],
];
for (const [label, re] of safety) {
  if (re.test(doc)) pass('K.' + key(label), 'safety: ' + label);
  else fail('K.' + key(label), 'missing safety: ' + label);
}

if (!/git add \./i.test(doc)) {
  pass('K.no_git_add_all', 'plan does not recommend git add .');
} else {
  fail('K.no_git_add_all', 'plan mentions git add .');
}

section('L. npm script registered');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:luna-agent-phase19-n8n-cutover-plan']) {
  pass('L1', 'npm script registered');
} else {
  fail('L1', 'npm script missing');
}

section('M. Downstream verifiers (limited)');

for (const script of DOWNSTREAM) {
  const t0 = Date.now();
  try {
    execSync(`npm run ${script}`, { stdio: 'pipe', cwd: ROOT, env: process.env });
    pass('M.' + key(script), `${script} still passes (${Date.now() - t0}ms)`);
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).slice(-400);
    fail('M.' + key(script), `${script} failed: ${out}`);
  }
}

const elapsed = Date.now() - startedMs;
console.log(`\n--- ${passes} passed, ${failures} failed (${elapsed}ms) ---\n`);
process.exit(failures > 0 ? 1 : 0);
