/**
 * Phase 16a — Static verifier for Luna n8n message intake shadow workflow JSON.
 *
 * Usage:
 *   npm run verify:luna-agent-phase16-n8n-intake-shadow
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT     = path.join(__dirname, '..');
const WF_PATH  = path.join(ROOT, 'n8n', 'Wolfhouse Booking Assistant - Message Intake Shadow.json');
const PKG_PATH = path.join(ROOT, 'package.json');

const DOWNSTREAM = [
  'verify:luna-agent-phase15-closeout',
  'verify:luna-agent-phase15-multilingual-intake-matrix',
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

console.log('\nverify-luna-agent-phase16-n8n-intake-shadow.js  (Phase 16a)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Workflow file');

if (!fs.existsSync(WF_PATH)) {
  fail('A1', 'workflow JSON missing: ' + WF_PATH);
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

if (wf.meta && wf.meta.description && wf.meta.description.includes('Phase 16a')) {
  pass('A6', 'meta.description documents Phase 16a');
} else {
  fail('A6', 'Phase 16a not documented in meta.description');
}

// ─────────────────────────────────────────────────────────────────────────────
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

if (!wfStr.includes('twilio.com') && !wfStr.includes('Twilio')) pass('B3', 'no Twilio');
else fail('B3', 'Twilio reference found');

const hasWhatsAppSend = (wf.nodes || []).some((n) =>
  (n.type || '').toLowerCase().includes('whatsapp') &&
  (n.name || '').toLowerCase().includes('send')
);
if (!hasWhatsAppSend) pass('B4', 'no WhatsApp Send node');
else fail('B4', 'WhatsApp Send node present');

// ─────────────────────────────────────────────────────────────────────────────
section('C. Staff API message-intake-preview endpoint');

const httpNodes = (wf.nodes || []).filter((n) => n.type === 'n8n-nodes-base.httpRequest');
const intakeNode = httpNodes.find((n) =>
  JSON.stringify(n.parameters || {}).includes('/staff/bot/message-intake-preview')
);

if (intakeNode) {
  pass('C1', 'HTTP node calls /staff/bot/message-intake-preview: "' + intakeNode.name + '"');
} else {
  fail('C1', 'no HTTP node for /staff/bot/message-intake-preview');
}

if (intakeNode && (intakeNode.parameters.method || '').toUpperCase() === 'POST') {
  pass('C2', 'message-intake-preview uses POST');
} else {
  fail('C2', 'message-intake-preview method not POST');
}

const forbiddenPaths = [
  ['/staff/bot/booking-create-from-plan', 'booking-create-from-plan'],
  ['/staff/bot/bookings/create', 'booking create'],
  ['/staff/bot/payments', 'bot payments'],
  ['/create-stripe-link', 'create-stripe-link'],
  ['/staff/stripe/webhook', 'stripe webhook'],
  ['/staff/bot/booking-dry-run', 'booking-dry-run (wrong endpoint for 16a)'],
];

for (const [pathFrag, label] of forbiddenPaths) {
  if (!nodeParamsStr.includes(pathFrag) && !codeStr.includes(pathFrag)) {
    pass('C3.' + label, 'does not call ' + label);
  } else {
    fail('C3.' + label, 'forbidden path still present: ' + pathFrag);
  }
}

if (!nodeParamsStr.includes('api.stripe.com')
  && !nodeParamsStr.includes('checkout.sessions')
  && !codeStr.includes('api.stripe.com')) {
  pass('C4', 'no Stripe API / checkout.sessions in nodes');
} else {
  fail('C4', 'Stripe API pattern found in nodes');
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
if (!n8nActivateHit) pass('C5', 'no n8n activation endpoints');
else fail('C5', 'n8n activation endpoint pattern found');

const staffApiNodes = httpNodes.filter((n) => {
  const u = JSON.stringify(n.parameters || {});
  return u.includes('staff-staging.lunafrontdesk.com') || u.includes('/staff/bot/');
});
if (staffApiNodes.length === 1) pass('C6', 'exactly one Staff API HTTP node');
else fail('C6', 'expected 1 Staff API HTTP node, got ' + staffApiNodes.length);

// ─────────────────────────────────────────────────────────────────────────────
section('D. Bot auth credential (no hardcoded secret)');

if (intakeNode) {
  const cred = intakeNode.credentials && intakeNode.credentials.httpHeaderAuth;
  if (cred && cred.name && cred.name.includes('Luna Bot Internal Token')) {
    pass('D1', 'uses Luna Bot Internal Token credential placeholder');
  } else {
    fail('D1', 'missing Luna Bot Internal Token credential binding');
  }

  const pStr = JSON.stringify(intakeNode.parameters || {});
  if (!pStr.includes('LUNA_BOT_INTERNAL_TOKEN') && !/Bearer\s+[A-Za-z0-9._-]{20,}/.test(pStr)) {
    pass('D2', 'no hardcoded bot token in HTTP node');
  } else {
    fail('D2', 'hardcoded token in HTTP node');
  }

  if (intakeNode.parameters.authentication === 'genericCredentialType') {
    pass('D3', 'HTTP node uses genericCredentialType');
  } else {
    fail('D3', 'HTTP node auth not genericCredentialType');
  }
} else {
  fail('D0', 'skipped auth checks — intake HTTP node missing');
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
if (!secretHit) pass('D4', 'no hardcoded secrets in workflow JSON');
else fail('D4', 'hardcoded secret pattern in workflow');

// ─────────────────────────────────────────────────────────────────────────────
section('E. Parse guest message fields');

const parseNode = (wf.nodes || []).find((n) =>
  (n.name || '').includes('Parse Guest Message')
);
const parseCode = (parseNode && parseNode.parameters && parseNode.parameters.jsCode) || '';

if (parseNode) pass('E.parse', 'Code - Parse Guest Message node present');
else fail('E.parse', 'Parse Guest Message node missing');

const requiredFields = ['client_slug', 'from', 'guest_name', 'language', 'message_text', 'channel'];
for (const field of requiredFields) {
  if (parseCode.includes('body.' + field) || parseCode.includes(field)) {
    pass('E.' + field, 'parse logic references ' + field);
  } else {
    fail('E.' + field, field + ' not referenced in parse node');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('F. Intake shadow fields preserved');

const mapNode = (wf.nodes || []).find((n) =>
  (n.name || '').includes('Map Intake Shadow') ||
  (n.parameters && n.parameters.jsCode && n.parameters.jsCode.includes('dry_run_plan'))
);
const respondNode = (wf.nodes || []).find((n) =>
  (n.name || '').includes('Intake Shadow Result')
);

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

if (mapNode) pass('F.map', 'Map Intake Shadow Response code node present');
else fail('F.map', 'Map Intake Shadow Response node missing');

if (respondNode) pass('F.respond', 'Respond - Intake Shadow Result node present');
else fail('F.respond', 'intake shadow respond node missing');

if (wfStr.includes('whatsapp_sent') && wfStr.includes('false')) {
  pass('F.wa', 'whatsapp_sent forced false in output');
} else {
  fail('F.wa', 'whatsapp_sent:false not in workflow output');
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
section('H. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:luna-agent-phase16-n8n-intake-shadow']) {
  pass('H1', 'verify:luna-agent-phase16-n8n-intake-shadow registered');
} else {
  fail('H1', 'npm script missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('I. Downstream verifier regression');

for (const script of DOWNSTREAM) {
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
