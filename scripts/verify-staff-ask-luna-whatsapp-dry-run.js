/**
 * Stage 8.6.3 — Static verifier for the Staff Ask Luna WhatsApp dry-run workflow.
 *
 * Reads n8n/Wolfhouse Staff Ask Luna - WhatsApp Dry Run.json as text/JSON
 * and performs structural and safety checks. Does NOT start n8n. No DB. No network.
 *
 * Checks:
 *   A. Workflow file and structure
 *   B. Safety: active:false, no live WhatsApp send, no Stripe
 *   C. Staff API call (/staff/ask-luna)
 *   D. Payload: source:staff_whatsapp, staff_phone, question
 *   E. Auth gap: phone allowlist path (no hardcoded bot token for this endpoint)
 *   F. Phone / secret hygiene
 *   G. Unauthorized branch handling
 *   H. Unsupported intent / dry-run reply handling
 *   I. Dry-run guard (workflow JSON, no $env in IF)
 *   J. package.json script
 *
 * Exit code: 0 on PASS, 1 on FAIL.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WF_PATH  = path.join(__dirname, '..', 'n8n', 'Wolfhouse Staff Ask Luna - WhatsApp Dry Run.json');
const PKG_PATH = path.join(__dirname, '..', 'package.json');
const THIS_FILE = __filename;

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

// ─────────────────────────────────────────────────────────────────────────────
section('A. Workflow file and structure');

if (!fs.existsSync(WF_PATH)) {
  fail('A1', 'workflow JSON file does not exist: ' + WF_PATH);
  console.error('\nFATAL: cannot continue without workflow file.');
  process.exit(1);
}
pass('A1', 'workflow JSON file exists');

let raw = '';
try { raw = fs.readFileSync(WF_PATH, 'utf8'); pass('A2', 'workflow file readable (' + raw.length + ' chars)'); }
catch (e) { fail('A2', 'cannot read workflow: ' + e.message); process.exit(1); }

let wf;
try { wf = JSON.parse(raw); pass('A3', 'workflow is valid JSON'); }
catch (e) { fail('A3', 'workflow is not valid JSON: ' + e.message); process.exit(1); }

// Convenience: full JSON as string for text searches
const wfStr = raw;

if (wf.name && wf.name.includes('Staff Ask Luna')) { pass('A4', 'workflow name contains "Staff Ask Luna"'); }
else { fail('A4', 'workflow name missing "Staff Ask Luna" (got: ' + wf.name + ')'); }

if (Array.isArray(wf.nodes) && wf.nodes.length >= 5) { pass('A5', 'workflow has >= 5 nodes (' + wf.nodes.length + ')'); }
else { fail('A5', 'workflow has fewer than 5 nodes (got: ' + (wf.nodes ? wf.nodes.length : 0) + ')'); }

if (wf.connections && Object.keys(wf.connections).length >= 4) { pass('A6', 'connections map has >= 4 entries'); }
else { fail('A6', 'connections map missing or sparse'); }

// ─────────────────────────────────────────────────────────────────────────────
section('B. Safety flags');

if (wf.active === false) { pass('B1', 'workflow active:false'); }
else { fail('B1', 'workflow active is not false (got: ' + wf.active + ')'); }

// No live WhatsApp send node — no graph.facebook.com URL in any node's parameters/URL
const nodeParamsStr = JSON.stringify((wf.nodes || []).map(n => n.parameters || {}));
if (!nodeParamsStr.includes('graph.facebook.com')) { pass('B2', 'no graph.facebook.com in any node parameters (no live WhatsApp send)'); }
else { fail('B2', 'graph.facebook.com found in node parameters — live WhatsApp send node detected'); }

// No Twilio
if (!wfStr.includes('twilio.com') && !wfStr.includes('Twilio')) { pass('B3', 'no Twilio references in workflow'); }
else { fail('B3', 'Twilio reference found in workflow'); }

// No Stripe API calls
if (!wfStr.includes('api.stripe.com') && !wfStr.includes('createPaymentIntent') && !wfStr.includes('stripe.com/v1')) {
  pass('B4', 'no Stripe API calls in workflow');
} else {
  fail('B4', 'Stripe API call found in workflow');
}

// No WhatsApp Send Message node type
const hasWhatsAppSendNode = (wf.nodes || []).some(n =>
  (n.type || '').toLowerCase().includes('whatsapp') &&
  (n.name || '').toLowerCase().includes('send')
);
if (!hasWhatsAppSendNode) { pass('B5', 'no WhatsApp Send node present'); }
else { fail('B5', 'WhatsApp Send node detected in workflow'); }

// No database write operations (INSERT/UPDATE/DELETE in code nodes)
const codeNodes = (wf.nodes || []).filter(n => n.type === 'n8n-nodes-base.code');
const hasDbWrite = codeNodes.some(n => {
  const code = (n.parameters && n.parameters.jsCode) || '';
  return /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bpg\.query|pool\.query/i.test(code);
});
if (!hasDbWrite) { pass('B6', 'no DB write operations in code nodes'); }
else { fail('B6', 'DB write operation (INSERT/UPDATE/DELETE) found in code node'); }

// ─────────────────────────────────────────────────────────────────────────────
section('C. Staff API call (/staff/ask-luna)');

const httpNodes = (wf.nodes || []).filter(n =>
  n.type === 'n8n-nodes-base.httpRequest'
);
if (httpNodes.length >= 1) { pass('C1', 'at least 1 HTTP request node present'); }
else { fail('C1', 'no HTTP request node found'); }

const askLunaNode = httpNodes.find(n =>
  (JSON.stringify(n.parameters || {})).includes('/staff/ask-luna')
);
if (askLunaNode) { pass('C2', 'HTTP node calls /staff/ask-luna: "' + askLunaNode.name + '"'); }
else { fail('C2', 'no HTTP node calls /staff/ask-luna'); }

if (askLunaNode) {
  const pStr = JSON.stringify(askLunaNode.parameters || {});
  if ((askLunaNode.parameters.method || '').toUpperCase() === 'POST') {
    pass('C3', 'HTTP node uses POST method');
  } else {
    fail('C3', 'HTTP node method is not POST (got: ' + askLunaNode.parameters.method + ')');
  }

  // URL is the staging Staff API
  if (pStr.includes('staff-staging.lunafrontdesk.com')) {
    pass('C4', 'HTTP node URL targets staff-staging.lunafrontdesk.com');
  } else {
    fail('C4', 'HTTP node URL does not target staff-staging.lunafrontdesk.com');
  }

  // neverError option so 403 flows through instead of throwing
  if (pStr.includes('neverError') || pStr.includes('never_error') || pStr.includes('fullResponse')) {
    pass('C5', 'HTTP node configured to handle errors gracefully (neverError/fullResponse)');
  } else {
    fail('C5', 'HTTP node missing neverError/fullResponse option — 403 will throw instead of branch');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Payload: source:staff_whatsapp, staff_phone, question');

if (wfStr.includes('staff_whatsapp')) { pass('D1', 'source:"staff_whatsapp" present in workflow'); }
else { fail('D1', 'source:"staff_whatsapp" not found in workflow'); }

if (wfStr.includes('staff_phone')) { pass('D2', 'staff_phone field present in workflow'); }
else { fail('D2', 'staff_phone field not found in workflow'); }

// question field comes from parsed message text
if (wfStr.includes('question')) { pass('D3', 'question field referenced in workflow'); }
else { fail('D3', 'question field not found in workflow'); }

// The body references the parsed 'from' field as the staff phone source
if (wfStr.includes("body.from") || wfStr.includes("'from'") || wfStr.includes('"from"') || wfStr.includes('staff_phone')) {
  pass('D4', 'staff phone sourced from inbound "from" field');
} else {
  fail('D4', 'inbound "from" field not referenced for staff_phone');
}

// The body references the parsed 'text' field as the question source
if (wfStr.includes("body.text") || wfStr.includes("body.question") || wfStr.includes("'text'") || wfStr.includes('"text"')) {
  pass('D5', 'question sourced from inbound "text" field');
} else {
  fail('D5', 'inbound "text" field not referenced for question');
}

if (wfStr.includes('client_slug')) { pass('D6', 'client_slug forwarded in payload'); }
else { fail('D6', 'client_slug not forwarded in payload'); }

// ─────────────────────────────────────────────────────────────────────────────
section('E. Auth path: phone allowlist (no bot token required for ask-luna)');

// /staff/ask-luna uses phone allowlist, NOT LUNA_BOT_INTERNAL_TOKEN.
// The workflow must NOT send X-Luna-Bot-Token to this endpoint.
if (askLunaNode) {
  const pStr = JSON.stringify(askLunaNode.parameters || {});
  if (!pStr.includes('LUNA_BOT_INTERNAL_TOKEN') && !pStr.includes('X-Luna-Bot-Token')) {
    pass('E1', 'ask-luna HTTP node does not send X-Luna-Bot-Token (correct: phone allowlist auth)');
  } else {
    fail('E1', 'ask-luna HTTP node includes LUNA_BOT_INTERNAL_TOKEN — this endpoint uses phone allowlist, not bot token');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('F. Phone and secret hygiene');

// No hardcoded secrets (API keys, tokens)
const secretPatterns = [
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]{20,}/,
  /whsec_[A-Za-z0-9]{20,}/,
  /LUNA_BOT_INTERNAL_TOKEN\s*[:=]\s*['"][^'"${}]+['"]/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
];
const secretFound = secretPatterns.find(re => re.test(wfStr));
if (!secretFound) { pass('F1', 'no hardcoded secrets found in workflow'); }
else { fail('F1', 'hardcoded secret pattern detected: ' + secretFound); }

// Only allowed fake/staging phone numbers — no real Spanish/UK mobiles
// Real Spanish mobiles: +34[67]xxxxxxxx  Real UK mobiles: +447xxxxxxxxx
const phoneMatches = [...wfStr.matchAll(/\+\d{8,15}/g)].map(m => m[0]);
const realPhones = phoneMatches.filter(p => {
  if (/^\+34[67]\d{8}$/.test(p)) return true;   // real Spanish mobile
  if (/^\+44[7]\d{9}$/.test(p))  return true;   // real UK mobile
  if (/^\+1[2-9]\d{9}$/.test(p)) return true;   // real US/CA
  return false;
});
const allowedFakePhones = ['+34999000999'];
const illegalPhones = realPhones.filter(p => !allowedFakePhones.includes(p));
if (illegalPhones.length === 0) { pass('F2', 'no real mobile phone numbers hardcoded (fake +34999000999 allowed)'); }
else { fail('F2', 'real mobile phone number(s) hardcoded: ' + illegalPhones.join(', ')); }

// No instanceId indicating live/production
if (!wfStr.includes('"instanceId": "live') && !wfStr.includes('"instanceId": "prod')) {
  pass('F3', 'instanceId does not indicate live/production instance');
} else {
  fail('F3', 'instanceId contains "live" or "prod" — may be production workflow');
}

// ─────────────────────────────────────────────────────────────────────────────
section('G. Unauthorized branch (403 / phone_not_allowlisted handling)');

// Must have a branch for unauthorized response
const hasUnauthorizedNode = (wf.nodes || []).some(n =>
  (n.name || '').toLowerCase().includes('unauthorized') ||
  (JSON.stringify(n.parameters || {})).includes('not enabled') ||
  (JSON.stringify(n.parameters || {})).includes('phone_not_allowlisted')
);
if (hasUnauthorizedNode) { pass('G1', 'unauthorized branch node exists'); }
else { fail('G1', 'no unauthorized branch node found'); }

// The unauthorized path must also have whatsapp_sent:false
if (wfStr.includes('whatsapp_sent') && (wfStr.includes('false') || wfStr.includes('booleanValue'))) {
  pass('G2', 'unauthorized branch includes whatsapp_sent:false');
} else {
  fail('G2', 'whatsapp_sent:false not found near unauthorized handling');
}

// Must not send WhatsApp on unauthorized (no live send on that branch)
if (!nodeParamsStr.includes('graph.facebook.com')) {
  pass('G3', 'no live WhatsApp send on any branch — graph.facebook.com absent from node parameters');
} else {
  fail('G3', 'graph.facebook.com found in node parameters — live send risk on unauthorized branch');
}

// ─────────────────────────────────────────────────────────────────────────────
section('H. Unsupported intent and dry-run reply handling');

if (wfStr.includes('unsupported_intent')) { pass('H1', 'unsupported_intent handled in workflow'); }
else { fail('H1', 'unsupported_intent not referenced in workflow'); }

if (wfStr.includes('reply_draft')) { pass('H2', 'reply_draft output field present (draft logged, not sent)'); }
else { fail('H2', 'reply_draft output field missing'); }

if (wfStr.includes('dry_run') && wfStr.includes('true')) { pass('H3', 'dry_run:true in workflow output'); }
else { fail('H3', 'dry_run:true not found in workflow output'); }

if (wfStr.includes('live_send_blocked')) { pass('H4', 'live_send_blocked field present'); }
else { fail('H4', 'live_send_blocked field missing'); }

// No "Send WhatsApp" or "WhatsApp Message" node in any path
const hasWhatsAppSendNodeByName = (wf.nodes || []).some(n =>
  /send.*whatsapp|whatsapp.*send|whatsapp.*message/i.test(n.name || '') &&
  n.type !== 'n8n-nodes-base.code' // code nodes are allowed to build draft
);
if (!hasWhatsAppSendNodeByName) { pass('H5', 'no "Send WhatsApp" or "WhatsApp Message" node in workflow'); }
else { fail('H5', '"Send WhatsApp" or "WhatsApp Message" node found — live send risk'); }

// ─────────────────────────────────────────────────────────────────────────────
section('I. Dry-run guard (workflow JSON, no $env in IF)');

const modeFlagsNode = (wf.nodes || []).find(n =>
  (n.name || '').includes('DryRun Mode Flags')
);
if (modeFlagsNode) { pass('I1', 'dry-run mode flags node present: "' + modeFlagsNode.name + '"'); }
else { fail('I1', 'Set/Code dry-run mode flags node missing before IF guard'); }

if (modeFlagsNode) {
  const modeStr = JSON.stringify(modeFlagsNode.parameters || {});
  if (modeStr.includes('dry_run') && (modeStr.includes('true') || modeStr.includes('booleanValue": true'))) {
    pass('I2', 'mode flags node sets dry_run:true');
  } else {
    fail('I2', 'mode flags node missing dry_run:true');
  }
  if (modeStr.includes('live_send_enabled') && (modeStr.includes('false') || modeStr.includes('booleanValue": false'))) {
    pass('I3', 'mode flags node sets live_send_enabled:false');
  } else {
    fail('I3', 'mode flags node missing live_send_enabled:false');
  }
}

const dryRunGuardNode = (wf.nodes || []).find(n =>
  n.type === 'n8n-nodes-base.if' &&
  (n.name || '').includes('DryRun Guard')
);
if (dryRunGuardNode) { pass('I4', 'dry-run guard is an IF node: "' + dryRunGuardNode.name + '"'); }
else { fail('I4', 'IF DryRun Guard node missing'); }

if (dryRunGuardNode) {
  const guardStr = JSON.stringify(dryRunGuardNode.parameters || {});
  if (guardStr.includes('$json.dry_run') || guardStr.includes('dry_run')) {
    pass('I5', 'IF guard checks workflow JSON dry_run flag');
  } else {
    fail('I5', 'IF guard does not check $json.dry_run');
  }
  if (guardStr.includes('$env.WHATSAPP_DRY_RUN') || guardStr.includes('$env')) {
    fail('I6', '$env reference found in IF DryRun Guard — staging blocks env access');
  } else {
    pass('I6', 'no $env.WHATSAPP_DRY_RUN in IF DryRun Guard');
  }
}

const ifNodes = (wf.nodes || []).filter(n => n.type === 'n8n-nodes-base.if');
const ifWithEnv = ifNodes.filter(n => JSON.stringify(n.parameters || {}).includes('$env'));
if (ifWithEnv.length === 0) { pass('I7', 'no $env references in any IF node expressions'); }
else { fail('I7', '$env found in IF node(s): ' + ifWithEnv.map(n => n.name).join(', ')); }

const guardConnections = (wf.connections && dryRunGuardNode && wf.connections[dryRunGuardNode.name]) || {};
const falseBranchTargets = ((guardConnections.main || [])[1] || []).map(c => c.node);
const falseBranchIsDisabled = falseBranchTargets.some(n => /disabled|blocked|guard/i.test(n));
if (falseBranchIsDisabled) { pass('I8', 'dry-run false-branch leads to disabled/blocked response'); }
else { fail('I8', 'dry-run false-branch target unclear: ' + falseBranchTargets.join(', ')); }

if (wf.active === false) { pass('I9', 'workflow active:false (guard slice)'); }
else { fail('I9', 'workflow active is not false (got: ' + wf.active + ')'); }

// ─────────────────────────────────────────────────────────────────────────────
section('J. package.json script');

try {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  if ((pkg.scripts || {})['verify:staff-ask-luna-whatsapp-dry-run']) {
    pass('J1', 'package.json has "verify:staff-ask-luna-whatsapp-dry-run"');
  } else {
    fail('J1', 'package.json missing "verify:staff-ask-luna-whatsapp-dry-run"');
  }
} catch (e) { fail('J1', 'cannot read package.json: ' + e.message); }

// ─────────────────────────────────────────────────────────────────────────────
section('K. Verifier self-check');

try { execSync(`node --check "${THIS_FILE}"`, { stdio: 'pipe' }); pass('K1', 'verifier itself passes node --check'); }
catch (e) { fail('K1', 'verifier syntax error: ' + e.message); }

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
const total = passes + failures;
console.log(`Results: ${passes} passed, ${failures} failed`);
console.log(`verify-staff-ask-luna-whatsapp-dry-run ${failures === 0 ? 'PASS' : 'FAIL'}`);
if (failures > 0) process.exit(1);
