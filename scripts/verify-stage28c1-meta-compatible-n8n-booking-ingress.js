/**
 * Stage 28c.1 — Static verifier for Meta-compatible n8n booking-write ingress.
 *
 * Usage:
 *   npm run verify:stage28c1-meta-compatible-n8n-booking-ingress
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'STAGE-28C1-META-COMPATIBLE-N8N-BOOKING-INGRESS.md');
const WF = path.join(ROOT, 'n8n', 'Luna Open Demo WhatsApp Booking Write Pipe.json');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28c1-meta-compatible-n8n-booking-ingress';
const WEBHOOK_PATH = 'open-demo-whatsapp-booking-write-27l';
const DEMO_PHONE_ID = '1152900101233109';
const VERIFY_TOKEN = 'wolfhouse_verify_token';
const OPEN_DEMO_ROUTE = '/staff/bot/open-demo-whatsapp-inbound-dry-run';

const REQUIRED_WRITE_FLAGS = [
  'create_demo_hold_draft_confirmed',
  'assign_demo_bed_confirmed',
];

const FORBIDDEN_FLAGS = [
  'send_live_reply_confirmed',
  'create_stripe_test_link_confirmed',
  'send_payment_link_whatsapp_confirmed',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function webhookNodes(wf) {
  return (wf && wf.nodes || []).filter((n) => n.type === 'n8n-nodes-base.webhook');
}

function nodeByName(wf, name) {
  return (wf && wf.nodes || []).find((n) => n.name === name);
}

console.log('\nverify-stage28c1-meta-compatible-n8n-booking-ingress.js  (Stage 28c.1)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
let wf = null;
try {
  wf = fs.existsSync(WF) ? JSON.parse(fs.readFileSync(WF, 'utf8')) : null;
} catch {
  wf = null;
}

section('A. Docs');

if (fs.existsSync(DOC)) pass('A1', 'STAGE-28C1 doc exists');
else fail('A1', 'doc missing');

if (/28c.*fail|POST-only|GET.*verify|hub.challenge/i.test(doc)) {
  pass('A2', 'docs explain 28c Meta GET failure');
} else {
  fail('A2', '28c failure context missing');
}

if (/reject|bandaid|not.*Staff API.*n8n|no.*bridge/i.test(doc)) {
  pass('A3', 'docs reject Staff API→n8n bridge');
} else {
  fail('A3', 'bridge rejection missing');
}

if (/Meta.*n8n.*Staff API|n8n.*pipe.*Staff API.*brain/i.test(doc)) {
  pass('A4', 'docs state Meta→n8n→Staff API target');
} else {
  fail('A4', 'target architecture missing');
}

if (/Nov 10.*17|2026-11-10/i.test(doc)) {
  pass('A5', 'docs include Nov 10–17 rerun dates');
} else {
  fail('A5', '28c rerun dates missing');
}

if (/rollback|deactivate|webhook_entity/i.test(doc)) {
  pass('A6', 'docs include rollback');
} else {
  fail('A6', 'rollback missing');
}

section('B. n8n workflow — Meta GET + POST same path');

if (wf && wf.active === false) pass('B1', 'active:false in repo');
else fail('B1', 'must be inactive in repo');

const hooks = webhookNodes(wf);
const getHook = hooks.find((n) => {
  const method = n.parameters && n.parameters.httpMethod;
  return method !== 'POST';
});
const postHook = hooks.find((n) => n.parameters && n.parameters.httpMethod === 'POST');

if (getHook) pass('B2', 'GET webhook node present');
else fail('B2', 'GET webhook node missing');

if (postHook) pass('B3', 'POST webhook node present');
else fail('B3', 'POST webhook node missing');

if (getHook && getHook.parameters.path === WEBHOOK_PATH
  && postHook && postHook.parameters.path === WEBHOOK_PATH) {
  pass('B4', 'GET and POST share webhook path');
} else {
  fail('B4', 'GET/POST path mismatch');
}

const nodeBlob = wf ? JSON.stringify(wf.nodes) : '';
const connBlob = wf ? JSON.stringify(wf.connections) : '';

if (nodeBlob.includes('hub.challenge') && nodeBlob.includes('hub.verify_token')) {
  pass('B5', 'GET verify reads hub query params');
} else {
  fail('B5', 'hub query handling missing');
}

if (nodeBlob.includes(VERIFY_TOKEN)) pass('B6', 'verify token constant present');
else fail('B6', 'verify token missing');

const respondChallenge = nodeByName(wf, 'Respond - Meta Hub Challenge');
if (respondChallenge
  && respondChallenge.parameters.respondWith === 'text'
  && String(respondChallenge.parameters.responseBody || '').includes('challenge')) {
  pass('B7', 'GET path returns raw hub.challenge text');
} else {
  fail('B7', 'hub.challenge text response missing');
}

if (connBlob.includes('Webhook - Meta GET Hub Verify')
  && connBlob.includes('Code - Meta Hub Verify')
  && connBlob.includes('Respond - Meta Hub Challenge')) {
  pass('B8', 'GET verify branch wired');
} else {
  fail('B8', 'GET verify connections missing');
}

section('C. n8n workflow — POST booking write pipe');

if (wf && wf.nodes.some((n) => String(n.parameters?.url || '').includes(OPEN_DEMO_ROUTE))) {
  pass('C1', 'POST forwards to Staff API open-demo route');
} else {
  fail('C1', 'open-demo endpoint missing');
}

if (nodeBlob.includes(DEMO_PHONE_ID)) pass('C2', 'phone_number_id guard');
else fail('C2', 'phone_number_id guard missing');

for (const flag of REQUIRED_WRITE_FLAGS) {
  if (nodeBlob.includes(flag)) pass(`C3-${flag}`, `workflow includes ${flag}`);
  else fail(`C3-${flag}`, `workflow missing ${flag}`);
}

for (const flag of FORBIDDEN_FLAGS) {
  if (!nodeBlob.includes(flag)) pass(`C4-${flag}`, `workflow omits ${flag}`);
  else fail(`C4-${flag}`, `forbidden flag ${flag}`);
}

if (!/graph\.facebook\.com/i.test(nodeBlob)) pass('C5', 'no graph.facebook.com outbound');
else fail('C5', 'forbidden Graph API send');

if (!/api\.stripe\.com/i.test(nodeBlob)) pass('C6', 'no api.stripe.com');
else fail('C6', 'forbidden Stripe URL');

if (nodeBlob.includes('guest_context') && nodeBlob.includes('slim_guest_context_for_next_turn')) {
  pass('C7', 'multi-turn guest_context preserved');
} else {
  fail('C7', 'guest_context chaining missing');
}

if (!/staff\/meta\/whatsapp\/webhook/i.test(nodeBlob)) {
  pass('C8', 'no Staff API meta webhook bridge in workflow');
} else {
  fail('C8', 'workflow must not call Staff API meta webhook as bridge');
}

section('D. package.json');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('D1', `${SCRIPT} npm script`);
else fail('D1', `${SCRIPT} missing`);

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
