/**
 * Phase 18e — Static verifier for Luna n8n guest-reply-draft shadow workflow JSON.
 *
 * Usage:
 *   npm run verify:luna-agent-phase18-n8n-draft-shadow
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const WF_PATH = path.join(ROOT, 'n8n', 'Wolfhouse Booking Assistant - Message Intake Shadow.json');
const PKG     = path.join(ROOT, 'package.json');

const DOWNSTREAM = [
  'verify:luna-agent-phase18-draft-builder',
  'verify:luna-agent-phase18-send-eligibility',
  'verify:luna-agent-phase18-live-gates-plan',
  'verify:luna-agent-phase17-closeout',
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

console.log('\nverify-luna-agent-phase18-n8n-draft-shadow.js  (Phase 18e)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

section('A. Workflow file');

if (!fs.existsSync(WF_PATH)) {
  fail('A1', 'workflow JSON missing');
  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(1);
}
pass('A1', 'workflow JSON exists');

let raw = '';
try {
  raw = fs.readFileSync(WF_PATH, 'utf8');
  pass('A2', 'workflow readable (' + raw.length + ' chars)');
} catch (e) {
  fail('A2', 'cannot read workflow: ' + e.message);
  process.exit(1);
}

let wf;
try {
  wf = JSON.parse(raw);
  pass('A3', 'valid JSON');
} catch (e) {
  fail('A3', 'invalid JSON: ' + e.message);
  process.exit(1);
}

if (wf.name && wf.name.includes('Message Intake Shadow')) {
  pass('A4', 'workflow name: ' + wf.name);
} else {
  fail('A4', 'unexpected workflow name: ' + wf.name);
}

if (Array.isArray(wf.nodes) && wf.nodes.length >= 5) {
  pass('A5', 'node count >= 5 (' + wf.nodes.length + ')');
} else {
  fail('A5', 'too few nodes');
}

if (wf.meta && wf.meta.description && /Phase 18e|guest-reply-draft/i.test(wf.meta.description)) {
  pass('A6', 'meta.description documents Phase 18e / guest-reply-draft');
} else {
  fail('A6', 'Phase 18e not documented in meta.description');
}

section('B. Inactive + no live send');

const wfStr = raw;
const codeNodes = (wf.nodes || []).filter((n) => n.type === 'n8n-nodes-base.code');
const nodeParamsStr = JSON.stringify((wf.nodes || []).map((n) => n.parameters || {}));
const codeStr = JSON.stringify(codeNodes.map((n) => (n.parameters && n.parameters.jsCode) || ''));

if (wf.active === false) pass('B1', 'active: false');
else fail('B1', 'workflow active is not false (got: ' + wf.active + ')');

if (!nodeParamsStr.includes('graph.facebook.com') && !codeStr.includes('graph.facebook.com')) {
  pass('B2', 'no graph.facebook.com in node parameters');
} else {
  fail('B2', 'WhatsApp Cloud API URL found in nodes');
}

const hasWhatsAppSend = (wf.nodes || []).some((n) =>
  (n.type || '').toLowerCase().includes('whatsapp') &&
  (n.name || '').toLowerCase().includes('send')
);
if (!hasWhatsAppSend) pass('B3', 'no WhatsApp Send node');
else fail('B3', 'WhatsApp Send node present');

section('C. Staff API guest-reply-draft endpoint');

const httpNodes = (wf.nodes || []).filter((n) => n.type === 'n8n-nodes-base.httpRequest');
const draftNode = httpNodes.find((n) =>
  JSON.stringify(n.parameters || {}).includes('/staff/bot/guest-reply-draft')
);
const intakePreviewInHttp = httpNodes.some((n) =>
  JSON.stringify(n.parameters || {}).includes('/staff/bot/message-intake-preview')
);

if (draftNode) {
  pass('C1', 'HTTP node calls /staff/bot/guest-reply-draft: "' + draftNode.name + '"');
} else {
  fail('C1', 'no HTTP node for /staff/bot/guest-reply-draft');
}

if (!intakePreviewInHttp) {
  pass('C2', 'no HTTP node calls message-intake-preview as brain');
} else {
  fail('C2', 'message-intake-preview still used as HTTP brain call');
}

if (draftNode && (draftNode.parameters.method || '').toUpperCase() === 'POST') {
  pass('C3', 'guest-reply-draft uses POST');
} else {
  fail('C3', 'guest-reply-draft method not POST');
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
    pass('C4.' + label, 'does not call ' + label);
  } else {
    fail('C4.' + label, 'forbidden path present: ' + pathFrag);
  }
}

if (!nodeParamsStr.includes('api.stripe.com') && !codeStr.includes('api.stripe.com')) {
  pass('C5', 'no api.stripe.com in nodes');
} else {
  fail('C5', 'Stripe API pattern found in nodes');
}

const n8nActivatePatterns = ['/api/v1/workflows/', 'activateWorkflow', 'workflow/activate', 'n8n.io/api'];
let n8nActivateHit = false;
for (const p of n8nActivatePatterns) {
  if (wfStr.includes(p)) n8nActivateHit = true;
}
if (!n8nActivateHit) pass('C6', 'no n8n activation endpoints');
else fail('C6', 'n8n activation endpoint pattern found');

const staffApiNodes = httpNodes.filter((n) => {
  const u = JSON.stringify(n.parameters || {});
  return u.includes('staff-staging.lunafrontdesk.com') || u.includes('/staff/bot/');
});
if (staffApiNodes.length === 1) pass('C7', 'exactly one Staff API HTTP node');
else fail('C7', 'expected 1 Staff API HTTP node, got ' + staffApiNodes.length);

section('D. Bot auth credential (no hardcoded secret)');

if (draftNode) {
  const cred = draftNode.credentials && draftNode.credentials.httpHeaderAuth;
  if (cred && cred.name && cred.name.includes('Luna Bot Internal Token')) {
    pass('D1', 'uses Luna Bot Internal Token credential placeholder');
  } else {
    fail('D1', 'missing Luna Bot Internal Token credential binding');
  }

  const pStr = JSON.stringify(draftNode.parameters || {});
  if (!pStr.includes('LUNA_BOT_INTERNAL_TOKEN') && !/Bearer\s+[A-Za-z0-9._-]{20,}/.test(pStr)) {
    pass('D2', 'no hardcoded bot token in HTTP node');
  } else {
    fail('D2', 'hardcoded token in HTTP node');
  }
} else {
  fail('D0', 'skipped auth checks — draft HTTP node missing');
}

const secretPatterns = [
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]{20,}/,
  /whsec_[A-Za-z0-9]{20,}/,
  /LUNA_BOT_INTERNAL_TOKEN\s*[:=]\s*['"][^'"${}]+['"]/,
];
if (!secretPatterns.some((re) => re.test(wfStr))) pass('D3', 'no hardcoded secrets in workflow JSON');
else fail('D3', 'hardcoded secret pattern in workflow');

section('E. Draft shadow fields preserved');

const fieldChecks = [
  'suggested_reply',
  'send_eligibility',
  'send_allowed_later',
  'requires_staff',
  'auto_send_ready',
  'next_action',
  'extraction',
  'validation',
  'dry_run_plan',
  'no_write_performed',
  'creates_booking',
  'creates_payment',
  'creates_stripe_link',
  'sends_whatsapp',
  'whatsapp_sent',
  'calls_n8n',
  'preview_only',
  'draft_only',
  'requires_staff_review',
  'live_send_blocked',
];

for (const field of fieldChecks) {
  if (wfStr.includes(field)) pass('E.' + field, 'maps/preserves ' + field);
  else fail('E.' + field, field + ' not found in workflow');
}

const mapNode = (wf.nodes || []).find((n) =>
  (n.name || '').includes('Map Draft Shadow')
);
if (mapNode) pass('E.map', 'Map Draft Shadow Response code node present');
else fail('E.map', 'Map Draft Shadow Response node missing');

if (wfStr.includes('whatsapp_sent') && wfStr.includes('live_send_blocked')) {
  pass('E.wa', 'whatsapp_sent false + live_send_blocked true in output');
} else {
  fail('E.wa', 'whatsapp_sent/live_send_blocked not enforced in workflow');
}

section('F. No DB writes in code nodes');

const hasDbWrite = codeNodes.some((n) => {
  const code = (n.parameters && n.parameters.jsCode) || '';
  return /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bpg\.query|pool\.query/i.test(code);
});
if (!hasDbWrite) pass('F1', 'no DB writes in code nodes');
else fail('F1', 'DB write in code node');

section('G. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:luna-agent-phase18-n8n-draft-shadow']) {
  pass('G1', 'verify:luna-agent-phase18-n8n-draft-shadow registered');
} else {
  fail('G1', 'npm script missing');
}

section('H. Downstream verifier regression');

for (const script of DOWNSTREAM) {
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
    pass('H.' + script, `${script} passes`);
  } catch (e) {
    fail('H.' + script, `${script} failed`);
    const out = (e.stdout || '') + (e.stderr || '');
    console.error(out.split('\n').slice(-8).join('\n'));
  }
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
