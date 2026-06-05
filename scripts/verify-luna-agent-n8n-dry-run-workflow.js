/**
 * Phase 12d — Static verifier for Luna guest n8n dry-run workflow JSON.
 *
 * Usage:
 *   npm run verify:luna-agent-n8n-dry-run-workflow
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WF_PATH  = path.join(__dirname, '..', 'n8n', 'Wolfhouse Booking Assistant - Main - Shared Engine Dry Run.json');
const PKG_PATH = path.join(__dirname, '..', 'package.json');

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

// ─────────────────────────────────────────────────────────────────────────────
section('A. Workflow file');

if (!fs.existsSync(WF_PATH)) {
  fail('A1', 'workflow JSON missing: ' + WF_PATH);
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

if (wf.name && wf.name.includes('Shared Engine Dry Run')) {
  pass('A4', 'workflow name: ' + wf.name);
} else {
  fail('A4', 'unexpected workflow name: ' + wf.name);
}

if (Array.isArray(wf.nodes) && wf.nodes.length >= 5) {
  pass('A5', 'node count >= 5 (' + wf.nodes.length + ')');
} else {
  fail('A5', 'too few nodes');
}

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('A6', 'verifier passes node --check');
} catch (e) {
  fail('A6', 'verifier syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Inactive + no live send');

const wfStr = raw;
const codeNodes = (wf.nodes || []).filter((n) => n.type === 'n8n-nodes-base.code');

if (wf.active === false) pass('B1', 'active: false');
else fail('B1', 'workflow active is not false (got: ' + wf.active + ')');
const nodeParamsStr = JSON.stringify((wf.nodes || []).map((n) => n.parameters || {}));
const codeStr = JSON.stringify(codeNodes.map((n) => (n.parameters && n.parameters.jsCode) || ''));

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
section('C. Staff API booking-dry-run endpoint');

const httpNodes = (wf.nodes || []).filter((n) => n.type === 'n8n-nodes-base.httpRequest');
const dryRunNode = httpNodes.find((n) => JSON.stringify(n.parameters || {}).includes('/staff/bot/booking-dry-run'));

if (dryRunNode) pass('C1', 'HTTP node calls /staff/bot/booking-dry-run: "' + dryRunNode.name + '"');
else fail('C1', 'no HTTP node for /staff/bot/booking-dry-run');

if (dryRunNode && (dryRunNode.parameters.method || '').toUpperCase() === 'POST') {
  pass('C2', 'booking-dry-run uses POST');
} else {
  fail('C2', 'booking-dry-run method not POST');
}

const chainedEndpoints = [
  ['/staff/bot/booking-preview', 'booking-preview chain'],
  ['/staff/bot/availability-check', 'availability-check chain'],
  ['/staff/bot/bookings/create', 'booking create'],
  ['/staff/manual-bookings/create', 'manual booking create'],
  ['/staff/bookings/generate-payment-link', 'generate-payment-link'],
  ['/staff/bot/payments/', 'bot create-stripe-link'],
  ['/staff/stripe/webhook', 'stripe webhook'],
];

for (const [pathFrag, label] of chainedEndpoints) {
  if (!nodeParamsStr.includes(pathFrag) && !codeStr.includes(pathFrag)) {
    pass('C3.' + label, 'does not call ' + label);
  } else {
    fail('C3.' + label, 'forbidden path still present: ' + pathFrag);
  }
}

if (!nodeParamsStr.includes('api.stripe.com') && !nodeParamsStr.includes('checkout.sessions.create') && !codeStr.includes('api.stripe.com')) {
  pass('C4', 'no Stripe API / checkout.sessions in nodes');
} else {
  fail('C4', 'Stripe API pattern found in nodes');
}

// Single orchestrator HTTP node (no legacy chain)
const staffApiNodes = httpNodes.filter((n) => {
  const u = JSON.stringify(n.parameters || {});
  return u.includes('staff-staging.lunafrontdesk.com') || u.includes('/staff/bot/');
});
if (staffApiNodes.length === 1) pass('C5', 'exactly one Staff API HTTP node');
else fail('C5', 'expected 1 Staff API HTTP node, got ' + staffApiNodes.length);

// ─────────────────────────────────────────────────────────────────────────────
section('D. Bot auth credential (no hardcoded secret)');

if (dryRunNode) {
  const cred = dryRunNode.credentials && dryRunNode.credentials.httpHeaderAuth;
  if (cred && cred.name && cred.name.includes('Luna Bot Internal Token')) {
    pass('D1', 'uses Luna Bot Internal Token credential placeholder');
  } else {
    fail('D1', 'missing Luna Bot Internal Token credential binding');
  }

  const pStr = JSON.stringify(dryRunNode.parameters || {});
  if (!pStr.includes('LUNA_BOT_INTERNAL_TOKEN') && !/Bearer\s+[A-Za-z0-9._-]{20,}/.test(pStr)) {
    pass('D2', 'no hardcoded bot token in HTTP node');
  } else {
    fail('D2', 'hardcoded token in HTTP node');
  }

  if (dryRunNode.parameters.authentication === 'genericCredentialType') {
    pass('D3', 'HTTP node uses genericCredentialType');
  } else {
    fail('D3', 'HTTP node auth not genericCredentialType');
  }
} else {
  fail('D0', 'skipped auth checks — dry-run HTTP node missing');
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
section('E. Dry-run fields preserved');

const mapNode = (wf.nodes || []).find((n) =>
  (n.name || '').includes('Map Dry Run') || (n.parameters && n.parameters.jsCode && n.parameters.jsCode.includes('planned_actions'))
);
const respondNode = (wf.nodes || []).find((n) =>
  (n.name || '').includes('Respond - DryRun Result') || (n.name || '').includes('DryRun Result')
);

const fieldChecks = [
  'reply_draft',
  'planned_actions',
  'next_action',
  'dry_run',
  'creates_booking',
  'creates_payment',
  'creates_stripe_link',
  'sends_whatsapp',
  'calls_n8n',
  'no_write_performed',
];

for (const field of fieldChecks) {
  if (wfStr.includes(field)) pass('E.' + field, 'maps/preserves ' + field);
  else fail('E.' + field, field + ' not found in workflow');
}

if (mapNode) pass('E.map', 'Map Dry Run Response code node present');
else fail('E.map', 'Map Dry Run Response node missing');

if (respondNode) pass('E.respond', 'Respond - DryRun Result node present');
else fail('E.respond', 'dry-run respond node missing');

if (wfStr.includes('whatsapp_sent') && wfStr.includes('false')) {
  pass('E.wa', 'whatsapp_sent forced false in output');
} else {
  fail('E.wa', 'whatsapp_sent:false not in workflow output');
}

// ─────────────────────────────────────────────────────────────────────────────
section('F. No DB writes in code nodes');
const hasDbWrite = codeNodes.some((n) => {
  const code = (n.parameters && n.parameters.jsCode) || '';
  return /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bpg\.query|pool\.query/i.test(code);
});
if (!hasDbWrite) pass('F1', 'no DB writes in code nodes');
else fail('F1', 'DB write in code node');

// ─────────────────────────────────────────────────────────────────────────────
section('G. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:luna-agent-n8n-dry-run-workflow']) {
  pass('G1', 'verify:luna-agent-n8n-dry-run-workflow registered');
} else {
  fail('G1', 'npm script missing');
}

if (wf.meta && wf.meta.description && wf.meta.description.includes('Phase 12d')) {
  pass('G2', 'meta.description documents Phase 12d');
} else {
  fail('G2', 'Phase 12d not documented in meta.description');
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
