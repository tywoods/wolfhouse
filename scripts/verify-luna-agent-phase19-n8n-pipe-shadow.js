/**
 * Phase 19f.2 — Static verifier for Luna n8n pipe shadow workflow JSON.
 *
 * Confirms inactive pipe workflow models: Meta inbound normalize → guest-reply-draft
 * → eligibility IF → guest-reply-send → debug response — without Graph API, Stripe,
 * booking-create, or n8n activation.
 *
 * Non-recursive: runs cutover-plan + guest-reply-send-route + whatsapp-provider only.
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-n8n-pipe-shadow
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WF_PATH = path.join(ROOT, 'n8n', 'Wolfhouse Booking Assistant - Luna Pipe Shadow.json');
const PKG = path.join(ROOT, 'package.json');

const DOWNSTREAM = [
  'verify:luna-agent-phase19-n8n-cutover-plan',
  'verify:luna-agent-phase19-guest-reply-send-route',
  'verify:luna-agent-phase19-whatsapp-provider',
];

const startedMs = Date.now();

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }
function key(label) { return label.replace(/[^a-z0-9]/gi, '_').slice(0, 28); }

console.log('\nverify-luna-agent-phase19-n8n-pipe-shadow.js  (Phase 19f.2 — static, non-recursive)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

section('A. Workflow file');

if (!fs.existsSync(WF_PATH)) {
  fail('A1', 'Luna Pipe Shadow workflow JSON missing');
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

if (wf.name && wf.name.includes('Luna Pipe Shadow')) {
  pass('A4', 'workflow name: ' + wf.name);
} else {
  fail('A4', 'unexpected workflow name: ' + wf.name);
}

if (Array.isArray(wf.nodes) && wf.nodes.length >= 8) {
  pass('A5', 'node count >= 8 (' + wf.nodes.length + ')');
} else {
  fail('A5', 'too few nodes');
}

if (wf.meta && wf.meta.description && /Phase 19f|guest-reply-send|luna-pipe-shadow-19f/i.test(wf.meta.description)) {
  pass('A6', 'meta.description documents Phase 19f pipe shadow');
} else {
  fail('A6', 'Phase 19f not documented in meta.description');
}

section('B. Inactive + webhook path');

const wfStr = raw;
const codeNodes = (wf.nodes || []).filter((n) => n.type === 'n8n-nodes-base.code');
const nodeParamsStr = JSON.stringify((wf.nodes || []).map((n) => n.parameters || {}));
const codeStr = JSON.stringify(codeNodes.map((n) => (n.parameters && n.parameters.jsCode) || ''));
const nodeNames = (wf.nodes || []).map((n) => n.name || '');

if (wf.active === false) pass('B1', 'active: false');
else fail('B1', 'workflow active is not false (got: ' + wf.active + ')');

const webhookNode = (wf.nodes || []).find((n) => n.type === 'n8n-nodes-base.webhook');
if (webhookNode && webhookNode.parameters && webhookNode.parameters.path === 'luna-pipe-shadow-19f') {
  pass('B2', 'webhook path is luna-pipe-shadow-19f');
} else {
  fail('B2', 'webhook path not luna-pipe-shadow-19f');
}

const webhookPath = webhookNode && webhookNode.parameters && webhookNode.parameters.path;
if (webhookPath !== 'booking-assistant') {
  pass('B3', 'webhook path is not booking-assistant');
} else {
  fail('B3', 'webhook path is booking-assistant');
}

section('C. Required node chain');

const requiredNodes = [
  ['C1', 'Webhook trigger', /Webhook.*Luna Pipe Shadow Trigger/i],
  ['C2', 'Shadow flags', /Set - Shadow Mode Flags/i],
  ['C3', 'Normalize inbound', /Code - Normalize WhatsApp Inbound/i],
  ['C4', 'HTTP draft', /HTTP - Guest Reply Draft/i],
  ['C5', 'Build send payload', /Code - Build Send Payload/i],
  ['C6', 'IF send eligible', /IF - Send Eligible/i],
  ['C7', 'HTTP send', /HTTP - Guest Reply Send/i],
  ['C8', 'Respond debug', /Respond - Debug Result/i],
];
for (const [id, label, re] of requiredNodes) {
  if (nodeNames.some((n) => re.test(n))) pass(id, label + ' present');
  else fail(id, label + ' missing');
}

section('D. Staff API endpoints');

const httpNodes = (wf.nodes || []).filter((n) => n.type === 'n8n-nodes-base.httpRequest');
const draftNode = httpNodes.find((n) =>
  JSON.stringify(n.parameters || {}).includes('/staff/bot/guest-reply-draft')
);
const sendNode = httpNodes.find((n) =>
  JSON.stringify(n.parameters || {}).includes('/staff/bot/guest-reply-send')
);

if (draftNode) {
  pass('D1', 'HTTP node calls /staff/bot/guest-reply-draft: "' + draftNode.name + '"');
} else {
  fail('D1', 'no HTTP node for guest-reply-draft');
}

if (sendNode) {
  pass('D2', 'HTTP node calls /staff/bot/guest-reply-send: "' + sendNode.name + '"');
} else {
  fail('D2', 'no HTTP node for guest-reply-send');
}

if (draftNode && (draftNode.parameters.method || '').toUpperCase() === 'POST') {
  pass('D3', 'guest-reply-draft uses POST');
} else {
  fail('D3', 'guest-reply-draft method not POST');
}

if (sendNode && (sendNode.parameters.method || '').toUpperCase() === 'POST') {
  pass('D4', 'guest-reply-send uses POST');
} else {
  fail('D4', 'guest-reply-send method not POST');
}

const staffApiNodes = httpNodes.filter((n) => {
  const u = JSON.stringify(n.parameters || {});
  return u.includes('staff-staging.lunafrontdesk.com') || u.includes('/staff/bot/');
});
if (staffApiNodes.length === 2) pass('D5', 'exactly two Staff API HTTP nodes (draft + send)');
else fail('D5', 'expected 2 Staff API HTTP nodes, got ' + staffApiNodes.length);

section('E. Forbidden paths + safety');

const forbidden = [
  ['graph.facebook.com', 'graph.facebook.com'],
  ['api.stripe.com', 'api.stripe.com'],
  ['/staff/bot/booking-create', 'booking-create route'],
  ['/staff/bot/bookings/create', 'bookings create route'],
  ['/create-stripe-link', 'payment-link route'],
  ['/staff/stripe/webhook', 'Stripe webhook route'],
];

for (const [frag, label] of forbidden) {
  if (!nodeParamsStr.includes(frag) && !codeStr.includes(frag)) {
    pass('E.' + key(label), 'no ' + label);
  } else {
    fail('E.' + key(label), label + ' found in workflow nodes/code');
  }
}

const n8nActivatePatterns = ['/api/v1/workflows/', 'activateWorkflow', 'workflow/activate'];
let n8nActivateHit = false;
for (const p of n8nActivatePatterns) {
  if (wfStr.includes(p)) n8nActivateHit = true;
}
if (!n8nActivateHit) pass('E.n8n_activate', 'no n8n activation route');
else fail('E.n8n_activate', 'n8n activation endpoint pattern found');

const hasWhatsAppSend = (wf.nodes || []).some((n) =>
  (n.type || '').toLowerCase().includes('whatsapp') &&
  (n.name || '').toLowerCase().includes('send')
);
if (!hasWhatsAppSend) pass('E.no_wa_node', 'no native WhatsApp Send node');
else fail('E.no_wa_node', 'WhatsApp Send node present');

section('F. Bot auth credential (no hardcoded secret)');

for (const [label, node] of [['draft', draftNode], ['send', sendNode]]) {
  if (!node) {
    fail('F.' + label, 'skipped — HTTP node missing');
    continue;
  }
  const cred = node.credentials && node.credentials.httpHeaderAuth;
  if (cred && cred.name && cred.name.includes('Luna Bot Internal Token')) {
    pass('F.' + label + '.cred', label + ' uses Luna Bot Internal Token credential');
  } else {
    fail('F.' + label + '.cred', label + ' missing Luna Bot Internal Token credential');
  }
  const pStr = JSON.stringify(node.parameters || {});
  if (!pStr.includes('LUNA_BOT_INTERNAL_TOKEN') && !/Bearer\s+[A-Za-z0-9._-]{20,}/.test(pStr)) {
    pass('F.' + label + '.token', 'no hardcoded bot token in ' + label + ' HTTP node');
  } else {
    fail('F.' + label + '.token', 'hardcoded token in ' + label + ' HTTP node');
  }
}

const secretPatterns = [
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]{20,}/,
  /whsec_[A-Za-z0-9]{20,}/,
  /LUNA_BOT_INTERNAL_TOKEN\s*[:=]\s*['"][^'"${}]+['"]/,
];
if (!secretPatterns.some((re) => re.test(wfStr))) pass('F.secrets', 'no hardcoded secrets in workflow JSON');
else fail('F.secrets', 'hardcoded secret pattern in workflow');

section('G. Idempotency key design');

const idemChecks = [
  ['G1', 'primary key uses wa_message_id', /luna:\$\{normalized\.client_slug\}:\$\{waId\}:\$\{sendKind\}|luna:\{client_slug\}:\{wa_message_id\}:\{send_kind\}/],
  ['G2', 'wa_message_id from Meta messages[0].id', /messages\[0\]|msg\.id|wa_message_id/],
  ['G3', 'fallback manual/test only', /Fallback.*manual.*test only|manual tests only/i],
  ['G4', 'idempotency_key on send payload', /idempotency_key/],
];
for (const [id, label, re] of idemChecks) {
  if (re.test(wfStr)) pass(id, label);
  else fail(id, label);
}

section('H. Send kind mapping');

const kindChecks = [
  ['H1', 'ask_missing_field mapped', /ask_missing_field/],
  ['H2', 'show_quote mapped', /show_quote/],
  ['H3', 'checkin_day blocked/not used', /checkin_day/],
  ['H4', 'handoff blocked', /handoff|requires_staff/],
];
for (const [id, label, re] of kindChecks) {
  if (re.test(wfStr)) pass(id, label);
  else fail(id, label);
}

section('I. Handoff path skips send route');

const sendNodeName = sendNode && sendNode.name;
const ifNode = (wf.nodes || []).find((n) => /IF - Send Eligible/i.test(n.name || ''));
const draftOnlyNode = (wf.nodes || []).find((n) => /Map Draft Only Debug/i.test(n.name || ''));

if (ifNode && sendNode && draftOnlyNode) {
  pass('I1', 'IF node gates send vs draft-only branches');
} else {
  fail('I1', 'missing IF send eligible or draft-only branch nodes');
}

const conns = wf.connections || {};
const ifConns = conns[ifNode && ifNode.name] || conns['IF - Send Eligible / Has Suggested Reply'];
if (ifConns && ifConns.main && ifConns.main.length >= 2) {
  const trueTargets = (ifConns.main[0] || []).map((c) => c.node);
  const falseTargets = (ifConns.main[1] || []).map((c) => c.node);
  if (trueTargets.includes(sendNodeName)) pass('I2', 'true branch connects to HTTP Guest Reply Send');
  else fail('I2', 'true branch does not connect to send HTTP node');
  if (falseTargets.some((n) => /Draft Only/i.test(n))) pass('I3', 'false branch connects to draft-only debug (no send)');
  else fail('I3', 'false branch does not connect to draft-only path');
} else {
  fail('I4', 'IF node connections missing dual branches');
}

if (codeStr.includes('requires_staff') && codeStr.includes('send route skipped')) {
  pass('I5', 'draft-only path documents requires_staff skip');
} else {
  fail('I5', 'requires_staff skip not documented in draft-only mapper');
}

section('J. Send result + debug fields');

const debugFields = [
  'draft_success',
  'suggested_reply',
  'next_action',
  'send_eligibility',
  'send_attempted',
  'send_performed',
  'sends_whatsapp',
  'duplicate',
  'idempotent_replay',
  'blocked_reasons',
  'whatsapp_message_id',
  'live_send_blocked',
];
for (const field of debugFields) {
  if (wfStr.includes(field)) pass('J.' + field, 'maps/preserves ' + field);
  else fail('J.' + field, field + ' not found in workflow');
}

if (wfStr.includes('send_payload') && wfStr.includes('guest_reply_draft')) {
  pass('J.payload', 'send payload includes source guest_reply_draft');
} else {
  fail('J.payload', 'send payload shape incomplete');
}

section('K. Normalize inbound fields');

const normFields = [
  ['K1', 'client_slug wolfhouse-somo default', /wolfhouse-somo/],
  ['K2', 'channel whatsapp', /channel.*whatsapp|'whatsapp'/],
  ['K3', 'messages[0].from', /msg\.from|messages\[0\]/],
  ['K4', 'messages[0].id wa_message_id', /wa_message_id|msg\.id/],
  ['K5', 'text.body message_text', /text\.body|message_text/],
];
for (const [id, label, re] of normFields) {
  if (re.test(wfStr)) pass(id, label);
  else fail(id, label);
}

section('L. No DB writes in code nodes');

const hasDbWrite = codeNodes.some((n) => {
  const code = (n.parameters && n.parameters.jsCode) || '';
  return /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bpg\.query|pool\.query/i.test(code);
});
if (!hasDbWrite) pass('L1', 'no DB writes in code nodes');
else fail('L1', 'DB write in code node');

section('M. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:luna-agent-phase19-n8n-pipe-shadow']) {
  pass('M1', 'verify:luna-agent-phase19-n8n-pipe-shadow registered');
} else {
  fail('M1', 'npm script missing');
}

section('N. Downstream verifiers (limited)');

for (const script of DOWNSTREAM) {
  const t0 = Date.now();
  try {
    execSync(`npm run ${script}`, { stdio: 'pipe', cwd: ROOT, env: process.env });
    pass('N.' + key(script), `${script} still passes (${Date.now() - t0}ms)`);
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).slice(-400);
    fail('N.' + key(script), `${script} failed: ${out}`);
  }
}

const elapsed = Date.now() - startedMs;
console.log(`\n--- ${passes} passed, ${failures} failed (${elapsed}ms) ---\n`);
process.exit(failures > 0 ? 1 : 0);
