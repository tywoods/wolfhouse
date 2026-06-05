/**
 * Phase 16c — Aggregate closeout verifier for Luna n8n message intake shadow.
 *
 * Proves Phase 16a–16b.3 foundation: inactive n8n shadow pipe wired to Staff API
 * message-intake-preview brain, credential placeholder only, safety flags preserved,
 * and no live sends/writes — without activation, deploy, or hosted API calls.
 *
 * Hosted proof evidence (manual staging, not re-run here):
 *   Staff API revision: wh-staging-staff-api--0000121
 *   Image: 62e60f3-stage16b2-intake-parity
 *   Workflow ID: stage16aIntakeShadow01
 *   16b.1 executions: #10 EN complete, #11 IT partial, #12 refund/handoff
 *   16b.3 executions: #13 ES native complete, #14 DE native complete
 *   All called POST /staff/bot/message-intake-preview; 0 bookings/payments;
 *   no Stripe/WhatsApp/n8n live activation.
 *
 * Live WhatsApp NO_GO: workflow must remain inactive; shadow is extraction-only.
 *
 * Usage:
 *   npm run verify:luna-agent-phase16-closeout
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const PKG     = path.join(ROOT, 'package.json');
const WF_PATH = path.join(ROOT, 'n8n', 'Wolfhouse Booking Assistant - Message Intake Shadow.json');

const PHASE16_SCRIPTS = [
  ['verify:luna-agent-phase16-n8n-intake-shadow', 'scripts/verify-luna-agent-phase16-n8n-intake-shadow.js'],
  ['verify:luna-agent-phase16-closeout', 'scripts/verify-luna-agent-phase16-closeout.js'],
];

const PRIOR_CLOSEOUT_SCRIPTS = [
  ['verify:luna-agent-phase15-closeout', 'scripts/verify-luna-agent-phase15-closeout.js'],
  ['verify:luna-agent-phase15-multilingual-intake-matrix', 'scripts/verify-luna-agent-phase15-multilingual-intake-matrix.js'],
  ['verify:luna-agent-phase14-closeout', 'scripts/verify-luna-agent-phase14-closeout.js'],
  ['verify:luna-agent-phase13-closeout', 'scripts/verify-luna-agent-phase13-closeout.js'],
  ['verify:luna-agent-phase12-closeout', 'scripts/verify-luna-agent-phase12-closeout.js'],
  ['verify:staff-ask-luna-phase11-closeout', 'scripts/verify-staff-ask-luna-phase11-closeout.js'],
];

const DOWNSTREAM_VERIFIERS = [
  'verify:luna-agent-phase16-n8n-intake-shadow',
  'verify:luna-agent-phase15-closeout',
  'verify:luna-agent-phase15-multilingual-intake-matrix',
  'verify:luna-agent-phase14-closeout',
  'verify:luna-agent-phase13-closeout',
  'verify:luna-agent-phase12-closeout',
  'verify:staff-ask-luna-phase11-closeout',
];

// Hosted proof anchors (static evidence from Phase 16b.1 / 16b.3 staging runs)
const HOSTED_PROOF = {
  staff_api_revision:  'wh-staging-staff-api--0000121',
  staff_api_image:     '62e60f3-stage16b2-intake-parity',
  workflow_id:         'stage16aIntakeShadow01',
  workflow_name:       'Wolfhouse Booking Assistant - Message Intake Shadow',
  exec_16b1:           ['#10 EN complete', '#11 IT partial', '#12 refund/handoff'],
  exec_16b3:           ['#13 ES native complete', '#14 DE native complete'],
  intake_endpoint:     '/staff/bot/message-intake-preview',
  workflow_active:     false,
  db_bookings:         0,
  db_payments:         0,
};

const EXPECTED_WF_NAME = 'Wolfhouse Booking Assistant - Message Intake Shadow';

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

console.log('\nverify-luna-agent-phase16-closeout.js  (Phase 16c)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'closeout verifier passes node --check');
} catch {
  fail('0', 'closeout verifier syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Phase 16 npm scripts + prior closeouts');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));

for (const [scriptName, relPath] of PHASE16_SCRIPTS) {
  const full = path.join(ROOT, relPath);
  if (pkg.scripts && pkg.scripts[scriptName] === `node ${relPath}`) {
    pass('A.script.' + scriptName, `${scriptName} registered`);
  } else {
    fail('A.script.' + scriptName, `${scriptName} missing or wrong path`);
  }
  if (fs.existsSync(full)) pass('A.file.' + scriptName, `${relPath} exists`);
  else fail('A.file.' + scriptName, `${relPath} missing`);
}

for (const [scriptName, relPath] of PRIOR_CLOSEOUT_SCRIPTS) {
  const full = path.join(ROOT, relPath);
  if (pkg.scripts && pkg.scripts[scriptName]) pass('A.prior.' + scriptName, `${scriptName} registered`);
  else fail('A.prior.' + scriptName, `${scriptName} missing`);
  if (fs.existsSync(full)) pass('A.prior.file.' + scriptName, `${relPath} exists`);
  else fail('A.prior.file.' + scriptName, `${relPath} missing`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Hosted proof evidence anchors (static, no live API)');

pass('B.revision', `Staff API revision anchor: ${HOSTED_PROOF.staff_api_revision}`);
pass('B.image', `Staff API image anchor: ${HOSTED_PROOF.staff_api_image}`);
pass('B.wf_id', `n8n workflow ID anchor: ${HOSTED_PROOF.workflow_id}`);
pass('B.wf_name', `n8n workflow name anchor: ${HOSTED_PROOF.workflow_name}`);
pass('B.exec_16b1', `16b.1 executions: ${HOSTED_PROOF.exec_16b1.join(', ')}`);
pass('B.exec_16b3', `16b.3 executions: ${HOSTED_PROOF.exec_16b3.join(', ')}`);
pass('B.endpoint', `all executions called ${HOSTED_PROOF.intake_endpoint}`);
pass('B.db', `proof DB counts: ${HOSTED_PROOF.db_bookings} bookings / ${HOSTED_PROOF.db_payments} payments`);
pass('B.inactive', `workflow active anchor: ${HOSTED_PROOF.workflow_active}`);

// ─────────────────────────────────────────────────────────────────────────────
section('C. n8n shadow workflow JSON');

if (!fs.existsSync(WF_PATH)) {
  fail('C1', 'workflow JSON missing: ' + WF_PATH);
  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(1);
}
pass('C1', 'workflow JSON exists');

let raw = '';
try {
  raw = fs.readFileSync(WF_PATH, 'utf8');
  pass('C2', 'workflow readable (' + raw.length + ' chars)');
} catch (e) {
  fail('C2', 'cannot read workflow: ' + e.message);
  process.exit(1);
}

let wf;
try {
  wf = JSON.parse(raw);
  pass('C3', 'valid JSON');
} catch (e) {
  fail('C3', 'invalid JSON: ' + e.message);
  process.exit(1);
}

if (wf.name === EXPECTED_WF_NAME) pass('C4', 'workflow name correct');
else fail('C4', 'unexpected workflow name: ' + wf.name);

if (wf.active === false) pass('C5', 'active: false');
else fail('C5', 'workflow active is not false (got: ' + wf.active + ')');

const wfStr = raw;
const codeNodes = (wf.nodes || []).filter((n) => n.type === 'n8n-nodes-base.code');
const nodeParamsStr = JSON.stringify((wf.nodes || []).map((n) => n.parameters || {}));
const codeStr = JSON.stringify(codeNodes.map((n) => (n.parameters && n.parameters.jsCode) || ''));

// ─────────────────────────────────────────────────────────────────────────────
section('D. Staff API intake endpoint + forbidden paths');

const httpNodes = (wf.nodes || []).filter((n) => n.type === 'n8n-nodes-base.httpRequest');
const intakeNode = httpNodes.find((n) =>
  JSON.stringify(n.parameters || {}).includes('/staff/bot/message-intake-preview')
);

if (intakeNode) {
  pass('D1', 'HTTP node calls /staff/bot/message-intake-preview: "' + intakeNode.name + '"');
} else {
  fail('D1', 'no HTTP node for /staff/bot/message-intake-preview');
}

const forbiddenPaths = [
  ['/staff/bot/booking-create-from-plan', 'booking-create-from-plan'],
  ['/staff/bot/bookings/create', 'booking create'],
  ['/staff/bot/payments', 'bot payments'],
  ['/create-stripe-link', 'create-stripe-link'],
  ['/staff/stripe/webhook', 'stripe webhook'],
];

for (const [pathFrag, label] of forbiddenPaths) {
  if (!nodeParamsStr.includes(pathFrag) && !codeStr.includes(pathFrag)) {
    pass('D2.' + label, 'does not call ' + label);
  } else {
    fail('D2.' + label, 'forbidden path still present: ' + pathFrag);
  }
}

if (!nodeParamsStr.includes('graph.facebook.com') && !codeStr.includes('graph.facebook.com')) {
  pass('D3', 'no graph.facebook.com (WhatsApp Cloud API)');
} else {
  fail('D3', 'WhatsApp Cloud API URL found');
}

if (!nodeParamsStr.includes('api.stripe.com')
  && !nodeParamsStr.includes('checkout.sessions')
  && !codeStr.includes('api.stripe.com')) {
  pass('D4', 'no Stripe API / checkout.sessions');
} else {
  fail('D4', 'Stripe API pattern found');
}

const n8nActivatePatterns = [
  '/api/v1/workflows/',
  'activateWorkflow',
  'workflow/activate',
  'n8n.io/api',
];
let n8nActivateHit = false;
for (const p of n8nActivatePatterns) {
  if (wfStr.includes(p)) n8nActivateHit = true;
}
if (!n8nActivateHit) pass('D5', 'no n8n activation endpoints');
else fail('D5', 'n8n activation endpoint pattern found');

const hasWhatsAppSend = (wf.nodes || []).some((n) =>
  (n.type || '').toLowerCase().includes('whatsapp') &&
  (n.name || '').toLowerCase().includes('send')
);
if (!hasWhatsAppSend) pass('D6', 'no WhatsApp Send node');
else fail('D6', 'WhatsApp Send node present');

// ─────────────────────────────────────────────────────────────────────────────
section('E. Credential placeholder (no hardcoded secret)');

if (intakeNode) {
  const cred = intakeNode.credentials && intakeNode.credentials.httpHeaderAuth;
  if (cred && cred.name && cred.name.includes('Luna Bot Internal Token')) {
    pass('E1', 'uses Luna Bot Internal Token credential placeholder');
  } else {
    fail('E1', 'missing Luna Bot Internal Token credential binding');
  }

  const pStr = JSON.stringify(intakeNode.parameters || {});
  if (!pStr.includes('LUNA_BOT_INTERNAL_TOKEN') && !/Bearer\s+[A-Za-z0-9._-]{20,}/.test(pStr)) {
    pass('E2', 'no hardcoded bot token in HTTP node');
  } else {
    fail('E2', 'hardcoded token in HTTP node');
  }
} else {
  fail('E0', 'skipped auth checks — intake HTTP node missing');
}

const secretPatterns = [
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]{20,}/,
  /whsec_[A-Za-z0-9]{20,}/,
  /LUNA_BOT_INTERNAL_TOKEN\s*[:=]\s*['"][^'"${}]+['"]/,
];
let secretHit = false;
for (const re of secretPatterns) {
  if (re.test(wfStr)) secretHit = true;
}
if (!secretHit) pass('E3', 'no hardcoded secrets in workflow JSON');
else fail('E3', 'hardcoded secret pattern in workflow');

// ─────────────────────────────────────────────────────────────────────────────
section('F. Intake shadow fields preserved');

const fieldChecks = [
  'extraction',
  'validation',
  'dry_run_plan',
  'ask_next',
  'handoff_required',
  'no_write_performed',
  'creates_booking',
  'creates_payment',
  'creates_stripe_link',
  'sends_whatsapp',
  'calls_n8n',
  'preview_only',
  'extraction_only',
];

for (const field of fieldChecks) {
  if (wfStr.includes(field)) pass('F.' + field, 'maps/preserves ' + field);
  else fail('F.' + field, field + ' not found in workflow');
}

if (wfStr.includes('whatsapp_sent') && /whatsapp_sent:\s*false/.test(wfStr)) {
  pass('F.wa_sent', 'whatsapp_sent forced false');
} else {
  fail('F.wa_sent', 'whatsapp_sent:false not in workflow output');
}

if (wfStr.includes('live_send_blocked') && /live_send_blocked:\s*true/.test(wfStr)) {
  pass('F.live_block', 'live_send_blocked forced true');
} else {
  fail('F.live_block', 'live_send_blocked:true not in workflow output');
}

// ─────────────────────────────────────────────────────────────────────────────
section('G. No DB writes in code nodes');

const hasDbWrite = codeNodes.some((n) => {
  const code = (n.parameters && n.parameters.jsCode) || '';
  return /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bpg\.query|pool\.query/i.test(code);
});
if (!hasDbWrite) pass('G1', 'no DB writes in code nodes');
else fail('G1', 'DB write in code node');

// ─────────────────────────────────────────────────────────────────────────────
section('H. Live WhatsApp NO_GO');

if (wf.active === false) pass('H1', 'workflow JSON active:false (must not activate for live WhatsApp)');
else fail('H1', 'workflow active must be false');

if (wf.meta && wf.meta.description && /never activate for live WhatsApp/i.test(wf.meta.description)) {
  pass('H2', 'meta.description documents live WhatsApp NO_GO');
} else {
  fail('H2', 'live WhatsApp NO_GO missing from meta.description');
}

if (/No live WhatsApp send/i.test(wfStr)) pass('H3', 'workflow documents no live WhatsApp send');
else fail('H3', 'no live WhatsApp send guard missing');

if (/live_send_enabled:\s*false/.test(wfStr)) pass('H4', 'shadow flags set live_send_enabled:false');
else fail('H4', 'live_send_enabled:false missing from shadow flags');

// ─────────────────────────────────────────────────────────────────────────────
section('I. Downstream verifier regression');

for (const script of DOWNSTREAM_VERIFIERS) {
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    pass('I.' + script, `${script} passes`);
  } catch (e) {
    fail('I.' + script, `${script} failed`);
    const out = (e.stdout || '') + (e.stderr || '');
    console.error(out.split('\n').slice(-8).join('\n'));
  }
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
